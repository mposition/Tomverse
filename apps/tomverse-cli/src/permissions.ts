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
    | { kind: "command"; strict: string[] | null; broad: string[][]; text: string }
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
        // Words of every part of the line, quotes dropped: what a deny or ask rule and the egress check read.
        const parts = (plan.mode === "argv" ? [text] : text.split(/[;&|\n\r]+/)).map((part) => part.replace(/["'`()]/g, " ").split(/\s+/).filter(Boolean));
        const broad = parts.flatMap((words) => {
            const first = words[0];
            return first ? [words, [programName(first), ...words.slice(1)]] : [];
        });
        return { kind: "command", strict, broad, text };
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
 * tools of a server called `a__b`. A tool whose function name was shortened (over 64 characters, a hash is added) matches by its
 * own name, its name with unusable characters replaced, or the function name the model sees.
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
    return rule.tool === server || rule.tool === `${server}__*` || rule.tool === `${server}__${subject.tool}` || rule.tool === `${server}__${nameSafe(subject.tool)}`;
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
    ["dotnet", "nuget", "push"], ["pub", "publish"], ["flutter", "pub", "publish"],
];
const URL_LITERAL = /(?:\b(?:https?|ftp|sftp|ssh|git|wss?):\/\/|\bgit@[\w.-]+:)/i;

const egressReason = (subject: Extract<Subject, { kind: "command" }>) => {
    for (const words of subject.broad) {
        const lowered = words.map((word) => programName(word));
        for (const word of lowered) if (EGRESS_PROGRAMS.has(word)) return `It runs ${word}, which sends or deploys things outside this computer.`;
        for (const command of EGRESS_COMMANDS) if (containsWords(lowered, [...command])) return `It runs ${command.join(" ")}, which sends something outside this computer.`;
    }
    if (URL_LITERAL.test(subject.text)) return "It names a network address, so it may send something outside this computer.";
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
