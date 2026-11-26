import { basename, isAbsolute, relative } from "node:path";
import type { ApprovalView } from "./agent.js";
import { isSecretPath } from "./workspace.js";
import { AutoReviewer, type ReviewCall, type ReviewOutcome } from "./approval-review.js";
import { JournalError } from "./session.js";

/**
 * Permission modes and allow / ask / deny rules for the actions that need an
 * approval (apply_patch, run_command, web_fetch and tools named mcp__...).
 *
 * Everything that decides is in `evaluate`, a pure function, in this order:
 *
 *   1. the deterministic boundaries (`checkBoundaries`), which no mode, rule or
 *      model answer can lift: a file outside the work folder or a credential
 *      file is refused; anything that leaves the app (git push, a pull request,
 *      a network upload, a deployment, an unapproved web host) or touches the
 *      CLI's own data or credentials from a command is a person's decision;
 *   2. deny rules, which beat every allow rule and every mode;
 *   3. read-only mode, which refuses every change;
 *   4. ask rules (a person decides, even in allow-all);
 *   5. allow rules;
 *   6. an MCP tool (or a web host) that no allow rule names: a person, in every mode;
 *   7. the mode: ask → a person, auto review → a separate model request, allow
 *      all → run.
 *
 * Only what asks for an approval passes through here: patches, commands, web pages, clicks and typing in the browser tab, and
 * MCP tools (and, through the same Runner path, a subagent's patches and commands). The git tools (commit_changes,
 * publish_changes) never do: the host opens its own approval card for each call, and no mode, rule or reviewer can answer it.
 * The Runner only refuses them before they reach the host in read-only mode.
 *
 * Model output never reaches this order as an input: the mode comes from the
 * host's own state (a person's action in the app, a CLI flag), the rules from
 * files the file tools cannot touch (`.tomverse` is a protected folder name),
 * and the auto reviewer can only answer allow, deny or ask for one request.
 */

export const PERMISSION_MODES = ["read_only", "ask", "auto_review", "allow_all"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";
export const isPermissionMode = (value: unknown): value is PermissionMode => PERMISSION_MODES.includes(value as PermissionMode);

export type RuleEffect = "allow" | "ask" | "deny";
export type RuleScope = "user" | "project";
/**
 * `tool` is apply_patch, run_command, web_fetch or an MCP tool (`mcp__server__tool`,
 * `mcp__server__*`, or `mcp__server` for the whole server).
 * `pattern` is a path glob (apply_patch, relative to the work folder), a command
 * prefix in whole words (run_command) or a host (web_fetch, `*.example.com`).
 * `exact` makes a command rule match that command only, not commands that continue it.
 */
export type PermissionRule = { effect: RuleEffect; tool: string; pattern?: string; exact?: boolean };
export type ScopedRule = PermissionRule & { scope: RuleScope };

export const RULE_TOOLS = ["apply_patch", "run_command", "web_fetch"] as const;
const MCP_RULE_TOOL = /^mcp__[A-Za-z0-9_-]+(?:__(?:[A-Za-z0-9_-]+|\*))?$/;
const MAX_PATTERN = 500;

export const isRuleTool = (tool: unknown): tool is string => typeof tool === "string" && ((RULE_TOOLS as readonly string[]).includes(tool) || MCP_RULE_TOOL.test(tool));

/** Why a rule is not acceptable, or null. An allow rule must say what it allows. */
export const ruleProblem = (rule: PermissionRule): string | null => {
    if (!["allow", "ask", "deny"].includes(rule.effect)) return "The effect must be allow, ask or deny.";
    if (!isRuleTool(rule.tool)) return "The tool must be apply_patch, run_command, web_fetch or an MCP tool name (mcp__server__tool).";
    const mcp = rule.tool.startsWith("mcp__");
    if (mcp && rule.pattern !== undefined) return "An MCP tool rule names the tool; it has no pattern.";
    if (!mcp && rule.effect === "allow" && !rule.pattern?.trim()) return "An allow rule needs a pattern (a path glob, a command prefix or a host).";
    if (rule.pattern !== undefined) {
        if (typeof rule.pattern !== "string" || !rule.pattern.trim() || rule.pattern.length > MAX_PATTERN || /[\u0000-\u001f\u007f]/.test(rule.pattern)) {
            return "The pattern must be 1 to 500 printable characters.";
        }
        if (rule.tool === "run_command" && !tokenize(rule.pattern)?.length) return "The command pattern could not be read.";
    }
    if (rule.exact !== undefined && (typeof rule.exact !== "boolean" || rule.tool !== "run_command")) return "exact only applies to command rules.";
    return null;
};

export const describeRule = (rule: PermissionRule) =>
    `${rule.effect} ${rule.tool}${rule.pattern !== undefined ? ` ${JSON.stringify(rule.pattern)}` : ""}${rule.exact ? " (exact)" : ""}`;

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

// ── What a request is, for matching ────────────────────────────────────────

type Subject =
    | { kind: "patch"; paths: string[]; deletes: boolean }
    | { kind: "command"; strict: string[] | null; broad: string[][]; text: string; shellParts: string[] }
    | { kind: "web"; host: string }
    /** A tool of an MCP server. `server` and `tool` are null when the request carries no server information. */
    | { kind: "mcp"; name: string; server: string | null; tool: string | null }
    /** A click or typing in the local browser tab. */
    | { kind: "browser"; origin: string }
    | { kind: "other" };

const SHELL_META = /[;&|<>`$(){}\n\r]/;

/** Words of a line, honouring quotes; null for an unbalanced quote. */
export const tokenize = (text: string): string[] | null => {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let quote: string | null = null;
    for (const ch of text) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
        } else if (/\s/.test(ch)) {
            if (started) tokens.push(current);
            current = "";
            started = false;
        } else {
            current += ch;
            started = true;
        }
    }
    if (quote) return null;
    if (started) tokens.push(current);
    return tokens;
};

const programName = (token: string) => basename(token.replaceAll("\\", "/")).replace(/\.(?:exe|cmd|bat|com|ps1)$/i, "").toLowerCase();

/** A shell line with quotes and the escape characters of sh, cmd and PowerShell removed, the way a shell joins a word. */
const joinedWords = (part: string) => part.replace(/["'`^\\]/g, "").replace(/[()]/g, " ");

const subjectOf = (view: ApprovalView): Subject => {
    if (view.patch) return { kind: "patch", paths: view.patch.map((edit) => edit.path), deletes: view.patch.some((edit) => edit.action === "delete") };
    if (view.web) return { kind: "web", host: view.web.host.toLowerCase() };
    if (view.command) {
        const plan = view.command;
        const argv = (view.input as { argv?: unknown } | null)?.argv;
        const given = Array.isArray(argv) && argv.every((a) => typeof a === "string") ? (argv as string[]) : null;
        const text = plan.mode === "argv" ? (given ?? [programName(plan.file), ...plan.args]).join(" ") : plan.display;
        const strict = plan.mode === "argv"
            ? (given ?? [programName(plan.file), ...plan.args])
            : SHELL_META.test(text) ? null : tokenize(text);
        // Words of every part of the line: what a deny or ask rule and the egress check read. A shell line is read twice,
        // once with quotes as spaces and once with quotes and escape characters removed, because a shell joins what they
        // split: empty quotes, a backslash, a caret or a backtick inside `push` all still run `push`.
        // An argument list that starts a shell (`bash -c "..."`, `cmd /c ...`, `env sh -c ...`) hands it a line to run:
        // what follows the shell is read as shell lines, exactly as a line typed for a shell is.
        const list = given ?? [plan.file, ...plan.args];
        const shellAt = plan.mode === "argv" ? list.findIndex((word) => SHELL_PROGRAMS.has(programName(word))) : -1;
        // A line a shell continues over a line break (a backslash, a backtick or a caret before the break) is one line.
        const shellLine = (line: string) => line.replace(/[\\`^]\r?\n/g, "").split(/[;&|\n\r]+/);
        const shellParts = plan.mode === "argv"
            // An argument list is one part as it stands. With a shell in it, the shell's own words are that part (so an
            // encoded command is read with it) and each argument after the shell is a line for it.
            ? (shellAt < 0 ? [list.join(" ")] : [shellLine(list.slice(shellAt).join(" "))[0]!, ...list.slice(shellAt + 1).flatMap(shellLine)])
            : shellLine(text);
        const wordsOf = (line: string) => line.split(/\s+/).filter(Boolean);
        const readTwice = (part: string) => [wordsOf(part.replace(/["'`()]/g, " ")), wordsOf(joinedWords(part))];
        const parts = plan.mode === "argv"
            ? [wordsOf(text.replace(/["'`()]/g, " ")), ...(shellAt < 0 ? [] : shellParts.flatMap(readTwice))]
            : shellParts.flatMap(readTwice);
        const broad = parts.flatMap((words) => {
            const first = words[0];
            return first ? [words, [programName(first), ...words.slice(1)]] : [];
        });
        return { kind: "command", strict, broad, text, shellParts };
    }
    if (view.mcp) return { kind: "mcp", name: view.toolName, server: view.mcp.server, tool: view.mcp.tool };
    if (view.toolName.startsWith("mcp__")) return { kind: "mcp", name: view.toolName, server: null, tool: null };
    if (view.browser) return { kind: "browser", origin: view.browser.origin };
    return { kind: "other" };
};

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

const startsWithWords = (tokens: string[], pattern: string[]) => pattern.length <= tokens.length && pattern.every((word, i) => same(tokens[i]!, word));
const containsWords = (tokens: string[], pattern: string[]) => {
    for (let i = 0; i + pattern.length <= tokens.length; i += 1) if (pattern.every((word, j) => same(tokens[i + j]!, word))) return true;
    return false;
};

/** gitignore-like: no slash → any depth; `**` crosses folders; a folder name covers what is inside it. */
const globToRegExp = (pattern: string) => {
    let glob = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    const anchored = glob.startsWith("/") || glob.slice(0, -1).includes("/");
    glob = glob.replace(/^\//, "").replace(/\/$/, "");
    let source = "";
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i]!;
        if (ch === "*" && glob[i + 1] === "*") {
            i += 1;
            if (glob[i + 1] === "/") {
                i += 1;
                source += "(?:.*/)?";
            } else source += ".*";
        } else if (ch === "*") source += "[^/]*";
        else if (ch === "?") source += "[^/]";
        else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}(?:/.*)?$`, caseInsensitive ? "i" : "");
};

const pathMatches = (pattern: string, path: string) => globToRegExp(pattern).test(path.replaceAll("\\", "/"));

const hostMatches = (pattern: string, host: string) => {
    const wanted = pattern.trim().toLowerCase();
    if (wanted.startsWith("*.")) return host.endsWith(wanted.slice(1)) && host.length > wanted.length - 1;
    return host === wanted;
};

/** The tool part of a function name: what `mcpToolName` (mcp-client.ts) makes of the server's own tool name. */
const nameSafe = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * An MCP rule names a server (`mcp__server`, `mcp__server__*`) or one of its tools (`mcp__server__tool`). It is compared with the
 * server and tool the request is for, not by text prefix: a server id may itself hold `__`, so `mcp__a__*` must not reach the
 * tools of a server called `a__b`. An allow rule names the tool by the function name the model sees (shortened with a hash over
 * 64 characters) or the whole server; a deny or ask rule may also use the tool's own name, and reads broadly.
 */
const toolMatches = (rule: PermissionRule, toolName: string, subject: Subject) => {
    if (!rule.tool.startsWith("mcp__")) return rule.tool === toolName;
    if (subject.kind !== "mcp") return false;
    // Without the server and tool the request carries, only a deny or ask rule can still be read, by name; an allow rule cannot be trusted.
    if (subject.server === null || subject.tool === null) {
        return rule.effect !== "allow" && (rule.tool === toolName || toolName.startsWith(rule.tool.endsWith("__*") ? rule.tool.slice(0, -1) : `${rule.tool}__`));
    }
    if (rule.tool === subject.name) return true;
    const server = `mcp__${subject.server}`;
    // `mcp__a__b` can read as tool b of server a or as the whole server a__b: the bare server form is taken only for a server id
    // without "__", and a server whose id holds one is opened as a whole only by `mcp__<id>__*`.
    if (rule.tool === `${server}__*` || (rule.tool === server && !subject.server.includes("__"))) return true;
    if (rule.effect === "allow") return false;
    // A deny or ask rule errs on the restrictive side: it also covers the tool by its own name, and anything that starts with its server.
    const own = rule.tool === `${server}__${subject.tool}` || rule.tool === `${server}__${nameSafe(subject.tool)}`;
    return own || rule.tool === server || subject.name.startsWith(rule.tool.endsWith("__*") ? rule.tool.slice(0, -1) : `${rule.tool}__`);
};

/**
 * Whether a rule applies. Allow reads a request strictly (every edited path
 * must match; a shell line with a pipe, a redirect or a substitution never
 * matches); deny and ask read it broadly (any edited path; any part of any
 * command line, quotes ignored), so the restrictive side is the one that errs.
 */
const ruleApplies = (rule: PermissionRule, toolName: string, subject: Subject) => {
    if (!toolMatches(rule, toolName, subject)) return false;
    const strict = rule.effect === "allow";
    if (subject.kind === "other" || subject.kind === "browser" || subject.kind === "mcp") return rule.pattern === undefined;
    if (rule.pattern === undefined) return true;
    if (subject.kind === "web") return hostMatches(rule.pattern, subject.host);
    if (subject.kind === "patch") {
        if (strict && subject.deletes) return false;
        return strict ? subject.paths.every((path) => pathMatches(rule.pattern!, path)) : subject.paths.some((path) => pathMatches(rule.pattern!, path));
    }
    const pattern = tokenize(rule.pattern);
    if (!pattern?.length) return false;
    if (strict) {
        if (!subject.strict) return false;
        return rule.exact ? subject.strict.length === pattern.length && startsWithWords(subject.strict, pattern) : startsWithWords(subject.strict, pattern);
    }
    return subject.broad.some((words) => (rule.exact ? words.length === pattern.length && startsWithWords(words, pattern) : containsWords(words, pattern)));
};

// ── The boundaries ─────────────────────────────────────────────────────────

export type BoundaryCode =
    | "outside_workspace"
    | "credential_path"
    | "unverifiable_folder"
    | "egress_command"
    | "credential_in_command"
    | "protected_data_in_command";
export type Boundary = { kind: "deny" | "human"; code: BoundaryCode; reason: string };

/** Programs whose job is to send something out of this computer or to deploy it. */
const EGRESS_PROGRAMS = new Set([
    "curl", "wget", "scp", "sftp", "ftp", "rsync", "ssh", "nc", "ncat", "netcat", "telnet", "socat",
    "gh", "glab", "hub", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "start-bitstransfer", "send-mailmessage",
    "sendmail", "mailx", "aws", "gcloud", "az", "azcopy", "gsutil", "rclone", "kubectl", "helm", "terraform",
    "vercel", "netlify", "railway", "flyctl", "wrangler", "heroku", "firebase", "twine",
]);
/** Commands that send out only with a particular subcommand. */
const EGRESS_COMMANDS: readonly (readonly string[])[] = [
    ["git", "push"], ["git", "send-email"], ["git", "svn", "dcommit"],
    ["npm", "publish"], ["npm", "login"], ["npm", "adduser"], ["npm", "token"], ["npm", "dist-tag"], ["npm", "deprecate"], ["npm", "unpublish"],
    ["pnpm", "publish"], ["yarn", "publish"], ["yarn", "npm", "publish"], ["bun", "publish"], ["cargo", "publish"], ["cargo", "login"],
    ["docker", "push"], ["docker", "login"], ["podman", "push"], ["podman", "login"], ["gem", "push"], ["poetry", "publish"],
    ["docker", "publish"], ["docker", "--push"], ["podman", "--push"], ["docker-compose", "push"], ["docker-compose", "publish"], ["docker-compose", "--push"],
    ["dotnet", "nuget", "push"], ["pub", "publish"], ["flutter", "pub", "publish"],
];
const URL_LITERAL = /(?:\b(?:https?|ftp|sftp|ssh|git|wss?|tcp|udp):\/\/|\bgit@[\w.-]+:)/i;

/**
 * Whether the words of `command` appear in `tokens` in that order, with anything in between: options may sit between a
 * program and its subcommand (`git -C . push`, `npm --registry x publish`), so adjacency proves nothing. It asks a
 * person about more than it must (`git commit -m push`), never about less.
 */
const namesInOrder = (tokens: string[], command: readonly string[]) => {
    let at = 0;
    for (const token of tokens) if (same(token, command[at]!) && ++at === command.length) return true;
    return false;
};

/** Options that give git settings for one command: an alias or a transport program the text does not show. */
const GIT_CONFIG_OPTION = /^(?:-c|--config-env(?:=.*)?|--exec-path(?:=.*)?)$/;

const egressReason = (subject: Extract<Subject, { kind: "command" }>) => {
    for (const words of subject.broad) {
        const lowered = words.map((word) => programName(word));
        for (const word of lowered) if (EGRESS_PROGRAMS.has(word)) return `It runs ${word}, which sends or deploys things outside this computer.`;
        for (const command of EGRESS_COMMANDS) if (namesInOrder(lowered, command)) return `It runs ${command.join(" ")}, which sends something outside this computer.`;
        const git = lowered.indexOf("git");
        if (git >= 0 && words.slice(git + 1).some((word) => GIT_CONFIG_OPTION.test(word))) {
            return "It gives git its own settings for this command (an alias or a transport program), so what it sends cannot be read from the text.";
        }
    }
    if (URL_LITERAL.test(subject.text)) return "It names a network address, so it may send something outside this computer.";
    // A docker client pointed at another daemon sends it the build context and everything else it is asked to do.
    if (/DOCKER_(?:HOST|CONTEXT)/i.test(subject.text)) return "It points docker at another daemon, so what it is given may leave this computer.";
    return unreadableReason(subject);
};

/** Programs that send something out only with a particular subcommand: their arguments decide. */
const SUBCOMMAND_PROGRAMS = new Set(EGRESS_COMMANDS.map((command) => command[0]!));
/** Words that run the text they are given as a command. */
const TEXT_RUNNERS = new Set(["eval", "iex", "invoke-expression", "source", "."]);
/** Words that make a new command name in the shell: after them a plain word may run anything. */
const NAME_DEFINERS = new Set(["alias", "function", "doskey", "set-alias", "new-alias", "sal", "nal"]);
/** Words that start another command from their own arguments: what follows them is a command line again. */
const COMMAND_WRAPPERS = new Set([
    "env", "command", "builtin", "exec", "sudo", "doas", "nohup", "time", "nice", "timeout", "stdbuf", "setsid", "xargs", "call", "busybox",
    "start", "start-process", "saps", "invoke-command", "icm", "sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh",
]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"]);
const ENCODED_COMMAND = /(?:^|\s)[-/](?:e|ec|enc|encodedcommand)(?:\s|$)/i;
/** Subcommands that keep the work on this computer. Once one of them is read, what follows is only its argument. */
const LOCAL_SUBCOMMANDS: Record<string, readonly string[]> = {
    git: ["status", "diff", "log", "show", "add", "commit", "checkout", "switch", "branch", "merge", "rebase", "stash", "restore", "reset", "tag", "mv", "rm",
        "blame", "grep", "clean", "describe", "init", "worktree", "apply", "cherry-pick", "revert", "rev-parse", "ls-files", "version", "help"],
    npm: ["run", "run-script", "test", "t", "install", "i", "ci", "start", "build", "exec", "x", "ls", "list", "outdated", "why", "rebuild", "update"],
    pnpm: ["run", "test", "install", "i", "add", "remove", "start", "build", "exec", "dlx", "ls", "list", "outdated", "why", "rebuild", "update"],
    yarn: ["run", "test", "install", "add", "remove", "start", "build", "exec", "dlx", "list", "outdated", "why", "rebuild", "up"],
    bun: ["run", "test", "install", "i", "add", "remove", "build", "x"],
    cargo: ["build", "test", "check", "run", "fmt", "clippy", "bench", "doc", "clean", "add", "update", "tree"],
    docker: ["run", "ps", "images", "exec", "logs", "stop", "start", "rm", "rmi", "inspect"],
    // `docker compose` has subcommands of its own, some of which publish; it is read as a program in its own right.
    "docker compose": ["up", "down", "ps", "logs", "exec", "run", "start", "stop", "restart", "config", "top", "images", "kill", "rm", "create", "pause", "unpause", "ls", "version"],
    "docker-compose": ["up", "down", "ps", "logs", "exec", "run", "start", "stop", "restart", "config", "top", "images", "kill", "rm", "create", "pause", "unpause", "ls", "version"],
    podman: ["run", "ps", "images", "exec", "logs", "stop", "start", "rm", "rmi", "inspect"],
    gem: ["install", "list", "build"],
    poetry: ["install", "run", "add", "build", "lock", "update", "show"],
    dotnet: ["build", "test", "run", "restore", "clean", "format", "add", "new"],
    pub: ["get", "run", "build", "test"],
    flutter: ["run", "build", "test", "analyze", "format"],
};

/**
 * A word a shell passes on as written: letters, digits and the punctuation of names, paths and options. Anything a
 * shell can turn into other text (a quote of any kind, `$`, a backtick, `%`, `!`, a glob, a brace, a caret) is not in it.
 * A backslash is, for Windows paths; a backslash that hides a word is undone by the joined reading before this is asked.
 */
const PLAIN_WORD = /^[A-Za-z0-9_.,:=@+/\\-]+$/;

/** Options of the program itself that take their value as the next word, so that word is not the subcommand. */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
    git: ["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"],
    npm: ["--prefix", "-w", "--workspace"],
    pnpm: ["-C", "--dir", "-F", "--filter"],
    yarn: ["--cwd"],
    docker: ["--config", "-l", "--log-level"],
    "docker compose": ["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"],
    "docker-compose": ["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"],
    podman: ["--root", "--runroot", "--log-level"],
    cargo: ["--color", "--config"],
};

/** Options of the program itself that take no value. Any other option before the subcommand leaves the line to a person. */
const PLAIN_FLAGS: Record<string, readonly string[]> = {
    git: ["--no-pager", "-p", "--paginate", "--no-replace-objects", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs",
        "--icase-pathspecs", "--no-optional-locks", "--no-advice"],
    npm: ["--silent", "-s", "--quiet", "-q", "--yes", "-y", "--no-color", "--json"],
    pnpm: ["--silent", "-s", "--no-color", "-r", "--recursive"],
    yarn: ["--silent", "-s", "--no-color", "--json"],
    bun: ["--silent"],
    cargo: ["-q", "--quiet", "-v", "--verbose", "--locked", "--offline", "--frozen"],
    docker: ["-D", "--debug"],
    dotnet: [],
};

/**
 * Whether the words after a subcommand-sensitive program say, as written, that the work stays on this computer: the
 * subcommand itself, which is the first word that is not an option or an option's value, is one of the local list, and
 * every word up to it is plain. A later word that happens to be a subcommand's name (a branch called `status`) is only
 * an argument and proves nothing.
 */
const staysLocal = (program: string, args: string[]) => {
    const local = LOCAL_SUBCOMMANDS[program] ?? [];
    const takesValue = VALUE_OPTIONS[program] ?? [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (!PLAIN_WORD.test(arg)) return false;
        if (arg === "--version" || arg === "--help") return true;
        if (arg.startsWith("-")) {
            // Only options this list knows are stepped over: an unknown one may take the next word as its value, and
            // then the word after it, not this one, is the subcommand. `-C dir` skips its value; `--name=value` carries it.
            const name = arg.split("=")[0]!;
            if (takesValue.includes(name)) {
                if (!arg.includes("=")) {
                    index += 1;
                    if (index < args.length && !PLAIN_WORD.test(args[index]!)) return false;
                }
            } else if (!(PLAIN_FLAGS[program] ?? []).includes(arg)) {
                return false;
            }
            continue;
        }
        if (program === "docker" && arg.toLowerCase() === "compose") return staysLocal("docker compose", args.slice(index + 1));
        return local.includes(arg.toLowerCase());
    }
    return false;
};

/**
 * Shell lines whose words do not say what will run, so the checks above cannot clear them. This is a list of what is
 * read, not of what hides: a line runs without a person only when the place a command name or a subcommand stands in
 * holds a plain word. A person decides the rest: a program name that is quoted, built or a variable; a wrapper (env,
 * xargs, a shell ...) given anything but plain words; eval and iex; an encoded command; and git, npm, docker and the
 * like without a local subcommand read as written before anything else.
 * What stays unread, and the README says so: what a script or a repository alias does once it runs.
 */
const unreadableReason = (subject: Extract<Subject, { kind: "command" }>) => {
    for (const part of subject.shellParts) {
        const raw = part.trim();
        if (!raw) continue;
        const tokens = raw.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
        const words = tokens.map((token) => programName(joinedWords(token)));
        // Where the command name stands: after `NAME=value` prefixes, or after the `=` of a PowerShell assignment.
        let head = 0;
        let expression = false;
        if (/^\$[\w:.{}]+\s*[-+*/]?=/.test(raw)) {
            head = tokens.findIndex((token) => token.includes("=")) + 1;
            // `$x = "text"`, `$x = 1`, `$x = @(...)`: a value, not a command.
            expression = head >= tokens.length || /^["'0-9@[$]/.test(tokens[head]!);
        } else {
            while (head < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[head]!)) head += 1;
        }
        if (!expression && head < tokens.length) {
            const name = words[head]!;
            if (!PLAIN_WORD.test(tokens[head]!)) return "The program it starts is not written as a plain name, so what it runs cannot be read from the text.";
            if (TEXT_RUNNERS.has(name)) return `It uses ${name} to run text as a command, so what it sends cannot be read from the text.`;
            if (NAME_DEFINERS.has(name)) return `It uses ${name} to give a command another name, so what later words run cannot be read from the text.`;
            if (SHELL_PROGRAMS.has(name) && ENCODED_COMMAND.test(raw)) return `It starts ${name} on an encoded command, so what it sends cannot be read from the text.`;
            if (COMMAND_WRAPPERS.has(name) && tokens.slice(head + 1).some((token) => !PLAIN_WORD.test(token))) {
                return `It uses ${name} to start a command from text a shell changes when it runs, so what it sends cannot be read from the text.`;
            }
        }
        const at = words.findIndex((word) => SUBCOMMAND_PROGRAMS.has(word));
        if (at >= 0 && !staysLocal(words[at]!, tokens.slice(at + 1))) {
            return `It runs ${words[at]} without a subcommand that is known to stay on this computer and written as a plain word, so what it sends cannot be read from the text.`;
        }
    }
    return null;
};

const pieceIsPath = (piece: string) => /[\\/.~]/.test(piece) || /^id_/i.test(piece);

/**
 * The checks that hold in every mode. A "deny" is refused outright; a "human"
 * is never decided by a mode, a rule or a model, only by a person.
 */
export const checkBoundaries = (view: ApprovalView, options: { protectedDirs?: readonly string[] } = {}): Boundary | null => {
    if (view.patch) {
        for (const edit of view.patch) {
            if (isSecretPath(edit.path)) {
                return { kind: "deny", code: "credential_path", reason: `${edit.path} can hold credentials, so it is never changed through the file tools.` };
            }
        }
        if (!view.root) return { kind: "human", code: "unverifiable_folder", reason: "The work folder is not known, so where the files are cannot be checked." };
        for (const edit of view.patch) {
            const where = edit.absolute ? relative(view.root, edit.absolute) : edit.path;
            if (where === ".." || where.startsWith("../") || where.startsWith("..\\") || isAbsolute(where) || /^[A-Za-z]:/.test(where)) {
                return { kind: "deny", code: "outside_workspace", reason: `${edit.path} is outside the work folder, so it is never changed.` };
            }
        }
        return null;
    }
    const subject = subjectOf(view);
    if (subject.kind !== "command") return null;
    const egress = egressReason(subject);
    if (egress) return { kind: "human", code: "egress_command", reason: egress };
    const pieces = subject.text.split(/[\s"'=,;<>|&()]+/).filter(Boolean);
    if (pieces.some((piece) => pieceIsPath(piece) && isSecretPath(piece))) {
        return { kind: "human", code: "credential_in_command", reason: "It names a file that can hold credentials." };
    }
    const flat = subject.text.replaceAll("\\", "/").toLowerCase();
    if (flat.includes(".tomverse") || (options.protectedDirs ?? []).some((dir) => flat.includes(dir.replaceAll("\\", "/").toLowerCase()))) {
        return { kind: "human", code: "protected_data_in_command", reason: "It names the app's own data folder (sessions, settings, permission rules)." };
    }
    return null;
};

// ── The decision ───────────────────────────────────────────────────────────

export type PolicyNote = {
    source: "boundary" | "deny_rule" | "ask_rule" | "allow_rule" | "mode" | "auto_review";
    mode: PermissionMode;
    detail: string;
};

export type Verdict =
    | { kind: "allow"; policy: PolicyNote }
    | { kind: "deny"; reason: string; policy: PolicyNote }
    | { kind: "human"; reason: string; policy: PolicyNote }
    | { kind: "review"; policy: PolicyNote };

export type EvaluateOptions = {
    mode: PermissionMode;
    /** "unreadable": a rules file could not be read, so no rule can be trusted to be complete. */
    rules: readonly ScopedRule[] | "unreadable";
    protectedDirs?: readonly string[];
};

export const evaluate = (view: ApprovalView, options: EvaluateOptions): Verdict => {
    const { mode } = options;
    const note = (source: PolicyNote["source"], detail: string): PolicyNote => ({ source, mode, detail });
    const boundary = checkBoundaries(view, { protectedDirs: options.protectedDirs });
    if (boundary?.kind === "deny") return { kind: "deny", reason: boundary.reason, policy: note("boundary", boundary.code) };
    const subject = subjectOf(view);
    const rules = options.rules === "unreadable" ? [] : options.rules;
    const deny = rules.find((rule) => rule.effect === "deny" && ruleApplies(rule, view.toolName, subject));
    if (deny) return { kind: "deny", reason: `Denied by your ${deny.scope} permission rule: ${describeRule(deny)}.`, policy: note("deny_rule", describeRule(deny)) };
    if (mode === "read_only" && subject.kind !== "web") {
        return { kind: "deny", reason: "Read-only mode: files are not changed and commands are not run.", policy: note("mode", "read_only") };
    }
    if (boundary) return { kind: "human", reason: boundary.reason, policy: note("boundary", boundary.code) };
    if (options.rules === "unreadable") {
        return { kind: "human", reason: "A permission rules file could not be read, so every action is asked until it is fixed.", policy: note("boundary", "rules_unreadable") };
    }
    const ask = rules.find((rule) => rule.effect === "ask" && ruleApplies(rule, view.toolName, subject));
    if (ask) return { kind: "human", reason: `Your ${ask.scope} permission rule asks: ${describeRule(ask)}.`, policy: note("ask_rule", describeRule(ask)) };
    const allow = rules.find((rule) => rule.effect === "allow" && ruleApplies(rule, view.toolName, subject));
    if (allow) return { kind: "allow", policy: note("allow_rule", `${allow.scope}: ${describeRule(allow)}`) };
    // Reading a web page sends the address to a site: only a host a person or a rule named is read.
    if (subject.kind === "web") return { kind: "human", reason: "A web page is read only from a site you approved.", policy: note("boundary", "web_host") };
    // An MCP tool is another program that may send anything it is given out of this computer: like a web host, only a rule
    // that names the tool (or its server) lets it run without a person, whatever the mode.
    if (subject.kind === "mcp") return { kind: "human", reason: "An MCP tool runs without asking only when a permission rule names it.", policy: note("boundary", "mcp_tool") };
    // A click or typing on a page does whatever the page's own code does with it, a request to another service included,
    // and nothing here can read that. A person answers it in every mode; their "Allow for this run" covers the same site.
    if (subject.kind === "browser") return { kind: "human", reason: "A click or typing in the browser tab is always approved by a person.", policy: note("boundary", "browser_action") };
    if (mode === "allow_all") return { kind: "allow", policy: note("mode", "allow_all") };
    if (mode === "auto_review") return { kind: "review", policy: note("auto_review", "reviewing") };
    return { kind: "human", reason: "Ask mode.", policy: note("mode", mode) };
};

export type GateResult =
    | { kind: "allow"; policy: PolicyNote; info?: string }
    | { kind: "deny"; reason: string; policy: PolicyNote; info?: string }
    | { kind: "human"; policy: PolicyNote; info?: string };

export type GateContext = {
    /** One request to the model of the task through the app's own gateway and journal. */
    review: ReviewCall;
    /** The person's request, for the reviewer. */
    userRequest: string;
};

/** The mode and the rules of one task, applied to each approval before a person is asked. */
export class PermissionGate {
    private reviewer: AutoReviewer | null = null;
    private lastMode: PermissionMode | null = null;

    /**
     * `mode` may be a function the host answers from its own state each time (a person switching the mode in the app
     * takes effect at the next approval). Nothing the model says is ever an input to it.
     */
    constructor(private readonly options: { mode: PermissionMode | (() => PermissionMode); rules: () => readonly ScopedRule[]; protectedDirs?: readonly string[]; maxConsecutiveDenials?: number }) {}

    get mode(): PermissionMode {
        const mode = typeof this.options.mode === "function" ? this.options.mode() : this.options.mode;
        return isPermissionMode(mode) ? mode : DEFAULT_PERMISSION_MODE;
    }

    get autoReviewPaused() {
        return Boolean(this.reviewer?.paused);
    }

    /** Leaving auto review and coming back starts the count of denials again. */
    private reviewerFor(mode: PermissionMode) {
        if (mode !== this.lastMode) {
            this.lastMode = mode;
            this.reviewer = mode === "auto_review" ? new AutoReviewer(this.options.maxConsecutiveDenials) : null;
        }
        return this.reviewer;
    }

    private rulesNow(): readonly ScopedRule[] | "unreadable" {
        try {
            return this.options.rules();
        } catch {
            return "unreadable";
        }
    }

    /**
     * What the mode and the rules say now, without asking a reviewer and without counting anything. For a host with no
     * one to ask (`tomverse exec`): it can tell what is refused or allowed already from what needs a person.
     */
    preview(view: ApprovalView): Verdict {
        return evaluate(view, { mode: this.mode, rules: this.rulesNow(), protectedDirs: this.options.protectedDirs });
    }

    async decide(view: ApprovalView, context: GateContext): Promise<GateResult> {
        const rules = this.rulesNow();
        const mode = this.mode;
        const reviewer = this.reviewerFor(mode);
        const verdict = evaluate(view, { mode, rules, protectedDirs: this.options.protectedDirs });
        if (verdict.kind === "allow") return { kind: "allow", policy: verdict.policy };
        if (verdict.kind === "deny") return { kind: "deny", reason: verdict.reason, policy: verdict.policy };
        if (verdict.kind === "human") return { kind: "human", policy: verdict.policy };
        if (!reviewer) return { kind: "human", policy: verdict.policy };
        if (reviewer.paused) {
            return { kind: "human", policy: { ...verdict.policy, detail: "paused" }, info: `Auto review is paused after ${reviewer.maxConsecutiveDenials} denials in a row: you decide now.` };
        }
        let outcome: ReviewOutcome;
        try {
            outcome = await reviewer.review(view, context);
        } catch (error) {
            // A broken journal must stop the task; any other failure only means a person decides.
            if (error instanceof JournalError) throw error;
            outcome = { kind: "failed" as const, reason: "The review request failed." };
        }
        if (outcome.kind === "allow") return { kind: "allow", policy: { ...verdict.policy, detail: outcome.reason }, info: `Auto review allowed: ${outcome.reason}` };
        if (outcome.kind === "deny") {
            return { kind: "deny", reason: `Auto review declined: ${outcome.reason}`, policy: { ...verdict.policy, detail: outcome.reason },
                info: `Auto review declined: ${outcome.reason}${reviewer.paused ? ` Auto review is now paused after ${reviewer.maxConsecutiveDenials} denials in a row; you decide the next ones.` : ""}` };
        }
        return { kind: "human", policy: { ...verdict.policy, detail: outcome.kind === "ask" ? outcome.reason : "review_failed" },
            info: outcome.kind === "ask" ? `Auto review could not decide: ${outcome.reason}` : `Auto review gave no usable answer (${outcome.reason}): you decide.` };
    }
}

/** The "always allow" answer on an approval card, as a rule. Deleting files and commands that leave the app are never turned into one. */
export const ruleForApproval = (view: ApprovalView): PermissionRule | null => {
    if (view.error || checkBoundaries(view)) return null;
    if (view.web) return { effect: "allow", tool: "web_fetch", pattern: view.web.host };
    if (view.patch) return view.patch.some((edit) => edit.action === "delete") ? null : { effect: "allow", tool: "apply_patch", pattern: "**" };
    const subject = subjectOf(view);
    if (view.command && subject.kind === "command" && subject.strict?.length && !view.command.background) {
        // A word with a space or a quote is written with the quote it does not contain; one with both cannot be written as a rule.
        const words = subject.strict.map((word) => (!/[\s"']/.test(word) ? word : !word.includes('"') ? `"${word}"` : !word.includes("'") ? `'${word}'` : null));
        if (words.some((word) => word === null || word === "")) return null;
        return { effect: "allow", tool: "run_command", pattern: words.join(" "), exact: true };
    }
    return null;
};
