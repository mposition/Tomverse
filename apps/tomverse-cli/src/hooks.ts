import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { killTree, userShell } from "./commands.js";
import { commandEnv } from "./env.js";
import { tomverseHome } from "./config.js";
import { claudeHome, readJsonObject } from "./mcp-config.js";
import { activePlugins, type ActivePlugin } from "./plugin-store.js";
import { canonicalDigest } from "./session.js";

/**
 * Hooks: local commands the person (or the project, once approved) wants run at fixed points of a task. The file shape is
 * Claude Code's (`hooks` -> event -> [{ matcher, hooks: [{ type: "command", command, timeout }] }]); Codex's hooks.json has
 * the same shape and is read from `.codex/hooks.json` of the project.
 *
 * What a hook may do: block (an action, a prompt, a compaction), add text to the model's context, show the person a
 * message. What it may not do: widen anything. A hook that says "allow" is ignored: the person's approval, the
 * permission mode and every path and credential check still decide, exactly as without the hook.
 *
 * Differences from Claude Code, on purpose: only `command` handlers run (http, prompt, agent, mcp_tool are not loaded);
 * `updatedInput` and `continue: false` are ignored; `async` runs synchronously; the default timeout is 60 seconds.
 */

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookScope = "user" | "project";

export type HookDef = {
    event: HookEvent;
    matcher: string;
    command: string;
    timeoutSec: number;
    scope: HookScope;
    source: string;
    /** Identifies this exact hook: what an approval is bound to. */
    hash: string;
    /** The plugin the hook came from. A plugin's hook has scope "project": third-party code that waits for the person's approval. */
    plugin?: string;
    pluginRoot?: string;
};

export type HookLoad = { hooks: HookDef[]; problems: string[] };

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
const MAX_CAPTURE = 64 * 1024;
const MAX_CONTEXT = 10_000;

const isEvent = (value: string): value is HookEvent => (HOOK_EVENTS as readonly string[]).includes(value);

/** Reads the `hooks` table of one file (a settings file, or a hooks.json whose top level is the table itself). */
export const parseHooks = (file: Record<string, unknown>, scope: HookScope, source: string, problems: string[], binding?: unknown): HookDef[] => {
    const table = file.hooks ?? (Object.keys(file).some(isEvent) ? file : undefined);
    if (table === undefined) return [];
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        problems.push(`${source}: hooks must be an object.`);
        return [];
    }
    const out: HookDef[] = [];
    let skipped = 0;
    for (const [event, groups] of Object.entries(table as Record<string, unknown>)) {
        if (!isEvent(event)) continue;
        if (!Array.isArray(groups)) {
            problems.push(`${source}: ${event} must be a list.`);
            continue;
        }
        for (const group of groups) {
            if (!group || typeof group !== "object") continue;
            const g = group as { matcher?: unknown; hooks?: unknown };
            const matcher = typeof g.matcher === "string" ? g.matcher : "";
            for (const handler of Array.isArray(g.hooks) ? g.hooks : []) {
                const h = handler as Record<string, unknown> | null;
                const type = h && typeof h === "object" ? h.type ?? "command" : undefined;
                const winCommand = process.platform === "win32" && typeof h?.commandWindows === "string" ? h.commandWindows : undefined;
                const command = winCommand ?? h?.command;
                if (type !== "command" || typeof command !== "string" || !command.trim()) {
                    skipped += 1;
                    continue;
                }
                const timeout = typeof h?.timeout === "number" && Number.isFinite(h.timeout) && h.timeout > 0 ? Math.min(MAX_TIMEOUT_SEC, h.timeout) : undefined;
                const timeoutSec = timeout ?? (event === "UserPromptSubmit" ? 30 : DEFAULT_TIMEOUT_SEC);
                out.push({ event, matcher, command, timeoutSec, scope, source, hash: canonicalDigest({ event, matcher, command, timeoutSec, scope, ...(binding === undefined ? {} : { binding }) }) });
            }
        }
    }
    if (skipped) problems.push(`${source}: ${skipped} hook(s) were not loaded (only command hooks are supported).`);
    return out;
};

/**
 * User hooks (trusted, written by the person): Claude Code's user settings and the CLI's own `hooks.json`. Project hooks
 * (need approval): `.claude/settings.json`, `.claude/settings.local.json` and `.codex/hooks.json` in the workspace.
 * The same hook defined twice is loaded once.
 */
export const loadHooks = (root: string, homes: { tomverse?: string; claude?: string } = {}): HookLoad => {
    const problems: string[] = [];
    const sources: Array<[string, HookScope]> = [
        [join(homes.tomverse ?? tomverseHome(), "hooks.json"), "user"],
        [join(homes.claude ?? claudeHome(), "settings.json"), "user"],
        [join(root, ".claude", "settings.json"), "project"],
        [join(root, ".claude", "settings.local.json"), "project"],
        [join(root, ".codex", "hooks.json"), "project"],
    ];
    const seen = new Set<string>();
    const hooks: HookDef[] = [];
    for (const [path, scope] of sources) {
        const file = readJsonObject(path, problems);
        if (!file) continue;
        for (const def of parseHooks(file, scope, path, problems)) {
            if (seen.has(def.hash)) continue;
            seen.add(def.hash);
            hooks.push(def);
        }
    }
    for (const plugin of activePlugins(homes.tomverse ?? tomverseHome(), root)) {
        for (const def of pluginHooks(plugin, problems)) {
            if (seen.has(def.hash)) continue;
            seen.add(def.hash);
            hooks.push(def);
        }
    }
    return { hooks, problems };
};

const slashes = (path: string) => (process.platform === "win32" ? path.replaceAll("\\", "/") : path);

/**
 * The hooks one plugin brings. Each is bound to the plugin's name and the digest of its files, so an approval holds for exactly this
 * code: a changed script or definition asks again. `${CLAUDE_PLUGIN_ROOT}` is the plugin's installed folder. A hook that wants a value
 * from the plugin's own settings (`${user_config.*}`) is not loaded.
 */
export const pluginHooks = (plugin: Pick<ActivePlugin, "name" | "dir" | "digest" | "layout">, problems: string[]): HookDef[] => {
    const out: HookDef[] = [];
    const root = slashes(plugin.dir);
    for (const { source, table } of plugin.layout.hookTables) {
        const label = `plugin ${plugin.name}: ${source}`;
        for (const def of parseHooks(table, "project", label, problems, { plugin: plugin.name, digest: plugin.digest })) {
            if (def.command.includes("${user_config.")) {
                problems.push(`${label}: a hook that reads the plugin's own settings (user_config) is not supported; it was not loaded.`);
                continue;
            }
            out.push({ ...def, command: def.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root), plugin: plugin.name, pluginRoot: plugin.dir });
        }
    }
    return out;
};

/** Claude Code's names for the tools that have one, so a hook written there (`matcher: "Bash"`) still matches. */
const CLAUDE_NAMES: Record<string, string> = {
    run_command: "Bash", apply_patch: "Edit|Write", read_file: "Read", list_files: "LS", search_text: "Grep", web_fetch: "WebFetch", web_search: "WebSearch", delegate: "Task",
};

/** Matcher rules of Claude Code: empty or `*` is everything; letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else is an unanchored regular expression. */
export const matches = (matcher: string, ...values: string[]) => {
    const m = matcher.trim();
    if (!m || m === "*") return true;
    if (/^[A-Za-z0-9_\-\s,|]+$/.test(m)) {
        const names = m.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
        return values.some((v) => names.includes(v));
    }
    try {
        const re = new RegExp(m);
        return values.some((v) => re.test(v));
    } catch {
        return false;
    }
};

export type HookOutcome = {
    /** The action, prompt or compaction must not go on; why. */
    blocked?: string;
    /** Text for the model's context (never an instruction that widens anything). */
    context: string[];
    /** Text for the person. */
    messages: string[];
    /** A hook answered "allow" (ignored: only the approval system allows). */
    allowIgnored: boolean;
    /** Hooks that failed or timed out (they do not block, except by exit code 2). */
    failures: string[];
    ran: number;
};

type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string };

/** PowerShell's -Command reports 0 or 1 whatever the last program exited with; a hook's exit code (2 blocks) has to come through. */
const shellArguments = (command: string) =>
    process.platform === "win32"
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$global:LASTEXITCODE = $null; ${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }`]
        : ["-c", command];

const runHookCommand = (command: string, input: string, root: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal, pluginRoot?: string) =>
    new Promise<RunResult>((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn(userShell(env), shellArguments(command), {
                cwd: root,
                env: commandEnv(["CLAUDE_PROJECT_DIR", ...(pluginRoot ? ["CLAUDE_PLUGIN_ROOT"] : [])], { ...env, CLAUDE_PROJECT_DIR: root, ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: slashes(pluginRoot) } : {}) }),
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
                windowsHide: true,
                detached: process.platform !== "win32",
            });
        } catch (error) {
            resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: (error as Error).message });
            return;
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let killing: Promise<unknown> | null = null;
        const stop = (why: "timeout" | "cancel") => {
            if (killing) return;
            timedOut = why === "timeout";
            killing = killTree(child);
        };
        const timer = setTimeout(() => stop("timeout"), timeoutMs);
        const onAbort = () => stop("cancel");
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8"); });
        let spawnError: string | undefined;
        child.on("error", (error) => { spawnError = error.message; });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(input);
        child.on("close", async (code) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (killing) await killing;
            resolve({ exitCode: code, stdout, stderr, timedOut, ...(spawnError ? { spawnError } : {}) });
        });
    });

const cap = (text: string, n: number) => (text.length > n ? text.slice(0, n) : text);

export type HookRunnerOptions = {
    root: string;
    hooks: HookDef[];
    /** Whether this hook may run: a user hook, or a project hook whose exact hash the person approved and has not switched off. */
    canRun: (def: HookDef) => boolean;
    sessionId: () => string;
    permissionMode?: () => string;
    env?: NodeJS.ProcessEnv;
};

export class HookRunner {
    constructor(private readonly options: HookRunnerOptions) {}

    /** Hooks that would run for this event and name, in the order they were loaded. */
    private selected(event: HookEvent, matchValues: string[]) {
        return this.options.hooks.filter((h) => h.event === event && this.options.canRun(h) &&
            (event === "UserPromptSubmit" || event === "Stop" || matches(h.matcher, ...matchValues)));
    }

    has(event: HookEvent) {
        return this.options.hooks.some((h) => h.event === event && this.options.canRun(h));
    }

    /**
     * Runs every matching hook at once and merges what they said. `matchValue` is what the matcher is tested against
     * (the tool name, the SessionStart source, the PreCompact trigger).
     */
    async fire(event: HookEvent, fields: Record<string, unknown>, signal: AbortSignal, matchValue = ""): Promise<HookOutcome> {
        const out: HookOutcome = { context: [], messages: [], allowIgnored: false, failures: [], ran: 0 };
        const values = [matchValue, ...(CLAUDE_NAMES[matchValue] ? CLAUDE_NAMES[matchValue]!.split("|") : [])].filter(Boolean);
        const chosen = this.selected(event, values);
        if (!chosen.length) return out;
        const input = JSON.stringify({
            session_id: this.options.sessionId(),
            cwd: this.options.root,
            permission_mode: this.options.permissionMode?.() ?? "default",
            hook_event_name: event,
            ...fields,
        });
        const results = await Promise.all(chosen.map(async (def) => ({
            def,
            result: await runHookCommand(def.command, input, this.options.root, this.options.env ?? process.env, def.timeoutSec * 1000, signal, def.pluginRoot),
        })));
        for (const { def, result } of results) {
            out.ran += 1;
            this.merge(out, event, def, result);
        }
        return out;
    }

    private merge(out: HookOutcome, event: HookEvent, def: HookDef, result: RunResult) {
        const label = `${event} hook \`${cap(def.command, 80)}\``;
        const block = (reason: string) => { out.blocked ??= cap(reason.trim() || `Blocked by a ${event} hook.`, 2000); };
        if (result.spawnError || result.timedOut || (result.exitCode !== 0 && result.exitCode !== 2)) {
            out.failures.push(result.timedOut ? `${label} timed out after ${def.timeoutSec} seconds.` : result.spawnError ? `${label} could not run: ${cap(result.spawnError, 200)}` : `${label} exited with ${result.exitCode}.`);
            return;
        }
        if (result.exitCode === 2) {
            // Exit 2 blocks where blocking makes sense. A tool that already ran (PostToolUse) and a session that already began cannot be undone: the text is feedback.
            if (event === "PreToolUse" || event === "UserPromptSubmit" || event === "Stop" || event === "PreCompact") block(result.stderr);
            else if (event === "PostToolUse" && result.stderr.trim()) out.context.push(cap(result.stderr.trim(), MAX_CONTEXT));
            return;
        }
        const text = result.stdout.trim();
        if (!text) return;
        let json: unknown;
        if (text.startsWith("{")) {
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
        }
        if (!json || typeof json !== "object") {
            // Plain text is context for these events (and compaction instructions for PreCompact), and nothing elsewhere.
            if (event === "SessionStart" || event === "UserPromptSubmit" || event === "PreCompact") out.context.push(cap(text, MAX_CONTEXT));
            return;
        }
        const j = json as Record<string, unknown>;
        const specific = (j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        if (str(j.systemMessage)) out.messages.push(cap(str(j.systemMessage), 1000));
        const context = str(specific.additionalContext) || str(j.additionalContext);
        if (context) out.context.push(cap(context, MAX_CONTEXT));
        const decision = str(specific.permissionDecision);
        if (event === "PreToolUse") {
            if (decision === "deny" || j.decision === "block") block(str(specific.permissionDecisionReason) || str(j.reason));
            else if (decision === "allow" || j.decision === "approve") out.allowIgnored = true;
        } else if (j.decision === "block" && (event === "UserPromptSubmit" || event === "Stop" || event === "PreCompact")) {
            block(str(j.reason));
        } else if (j.decision === "block" && event === "PostToolUse" && str(j.reason)) {
            out.context.push(cap(str(j.reason), MAX_CONTEXT));
        } else if (j.continue === false && event === "UserPromptSubmit") {
            block(str(j.stopReason));
        }
    }
}
