/**
 * Executors for the cross-review loop: scripted mocks for tests and the
 * offline flow, and command-line shells for Claude Code and Codex that never
 * run a process unless a caller passes a spawner and asks for live mode.
 *
 * ## The boundary
 *
 * A command-line executor takes `spawn` as an argument. In `dry-run` mode it
 * returns `not_executed` without touching it, and a test can hand it a
 * spawner that throws to prove the point. There is no default spawner: an
 * executor built without one cannot run anything, whatever mode it is in.
 * That is the same arrangement `lib/aiReviewEvalLiveAdapter.ts` uses for the
 * evaluation harness -- whether an invocation can spend is a question about
 * what was passed in, not about control flow that might be mis-read.
 *
 * ## What the shells assume about the tools
 *
 * Both are asked for one JSON document on stdout, in the shape the control
 * program checks (`authorOutputProblems` / `reviewVerdictProblems`). The
 * prompt says so and the parser tolerates a result printed after streamed
 * lines. The flag sets below were checked on 2026-09-09 against the installed
 * tools -- codex-cli 0.146.0 and Claude Code 2.1.261 -- and, for the event
 * shape, against the `codex` source at tag `rust-v0.146.0`; what each check
 * covered is written next to the invocation. `CLI_INVOCATIONS` exists so that
 * check is a comparison against one place, and it is due again whenever
 * either tool is upgraded.
 *
 * ## Why the reviewer ignores the user's configuration
 *
 * The sandbox bounds shell commands, not the tools a configuration adds. A
 * `~/.codex/config.toml` may register MCP servers and plugins that execute
 * outside the sandbox (an infrastructure CLI, a JavaScript REPL, desktop
 * control), and `-c mcp_servers={}` merges rather than replaces, so nothing
 * short of `--ignore-user-config` takes them away. The reviewer therefore
 * runs with the user layer empty; what a run still needs from configuration
 * -- the model, or the Windows sandbox backend -- is passed explicitly as an
 * override from the allow list below and recorded with the command.
 */

import {
    authorOutputProblems,
    parseJsonWithoutDuplicateKeys,
    parseExecutorJson,
    renderReviewPrompt,
    reviewVerdictProblems,
    type AuthorExecutor,
    type AuthorOutput,
    type AuthorRequest,
    type CrossReviewRole,
    type ExecutorResult,
    type ReviewerExecutor,
    type ReviewRequest,
    type ReviewVerdict,
} from "@/lib/crossReviewCore";

export type ExecutorMode = "mock" | "dry-run" | "live";

/** One scripted answer per round. A function may inspect the request. */
export type MockAuthorScript = readonly (
    | ExecutorResult<AuthorOutput>
    | ((request: AuthorRequest) => ExecutorResult<AuthorOutput>)
)[];

export type MockReviewerScript = readonly (
    | ExecutorResult<ReviewVerdict>
    /** `reviewedDigest: "@current"` in a scripted verdict is replaced with the request's digest. */
    | ((request: ReviewRequest) => ExecutorResult<ReviewVerdict>)
)[];

const missing = <T>(role: string, round: number): ExecutorResult<T> => ({
    ok: false,
    failure: "missing_result",
    detail: `the mock ${role} has no scripted answer for round ${round}`,
});

export const mockAuthor = (id: string, script: MockAuthorScript): AuthorExecutor & { calls: AuthorRequest[] } => {
    const calls: AuthorRequest[] = [];
    return {
        id,
        calls,
        produce: async (request) => {
            calls.push(request);
            const entry = script[request.round];
            if (entry === undefined) return missing<AuthorOutput>("author", request.round);
            return typeof entry === "function" ? entry(request) : entry;
        },
    };
};

export const mockReviewer = (
    id: string,
    script: MockReviewerScript
): ReviewerExecutor & { calls: ReviewRequest[] } => {
    const calls: ReviewRequest[] = [];
    return {
        id,
        calls,
        review: async (request) => {
            calls.push(request);
            const entry = script[request.round];
            if (entry === undefined) return missing<ReviewVerdict>("reviewer", request.round);
            const result = typeof entry === "function" ? entry(request) : entry;
            if (result.ok && result.value.reviewedDigest === "@current") {
                return { ok: true, value: { ...result.value, reviewedDigest: request.changeDigest } };
            }
            return result;
        },
    };
};

/** A scripted reviewer answer that approves whatever it is shown, on the right digest. */
export const approveCurrent = (taskId: string, round: number, nextAction = "merge"): ExecutorResult<ReviewVerdict> => ({
    ok: true,
    value: { taskId, round, reviewedDigest: "@current", conclusion: "approve", findings: [], nextAction },
});

/** What a spawner returns. Mirrors the useful part of `child_process.spawnSync`. */
export type SpawnResult = {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Exact bytes, when the production spawner captured them. */
    stdoutBytes?: Buffer;
    stderrBytes?: Buffer;
    /** True when the spawner itself enforced a timeout. */
    timedOut?: boolean;
    error?: Error;
};

/** Preserve stream bytes across arbitrary chunk boundaries, then decode once. */
export const completeUtf8Capture = (chunks: readonly Uint8Array[]): { bytes: Buffer; text: string } => {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { bytes, text: bytes.toString("utf8") };
};

export type Spawner = (
    command: string,
    args: readonly string[],
    options: { input: string; cwd: string; timeoutMs: number; env?: Record<string, string | undefined> }
) => Promise<SpawnResult>;

export type CliInvocation = {
    command: string;
    /** Fixed arguments. Per-run configuration overrides, if any, come after them. */
    args: readonly string[];
    /**
     * The flag that carries one `key=value` configuration override, for a
     * tool that has one (`codex -c`). A tool without one refuses overrides.
     */
    configFlag?: string;
    /** The final argument that makes the tool read its prompt from stdin, for a tool that needs one (`codex exec -`). */
    promptArg?: string;
    /** What the invocation is for and what was checked, so a reader can compare it with `--help`. */
    note: string;
};

/**
 * The intended invocations, one per tool and role.
 *
 * Checked 2026-09-09. Claude Code 2.1.261 lists every flag used here in
 * `claude --help`; neither Claude Code invocation has been run. codex-cli
 * 0.146.0 lists `--sandbox` on the root command and on `exec`, and `exec`
 * documents `--json` ("Print events to stdout as JSONL"), `-` ("instructions
 * are read from stdin"), `--ignore-user-config` and `-c`; `codex exec` sets
 * the approval policy to `never` in its own source (`exec/src/lib.rs`, "Default
 * to never ask for approvals in headless mode"), so a command the read-only
 * sandbox refuses is rejected rather than escalated.
 */
export const CLI_INVOCATIONS: Readonly<Record<"claude" | "codex", Readonly<Record<CrossReviewRole, CliInvocation>>>> = {
    claude: {
        author: {
            command: "claude",
            args: ["--print", "--output-format", "json", "--permission-mode", "acceptEdits"],
            note: "Claude Code non-interactive; may edit within the task's writable scope; result JSON on stdout.",
        },
        reviewer: {
            command: "claude",
            args: ["--print", "--safe-mode", "--output-format", "json", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config"],
            note:
                "Claude Code non-interactive with the user's, project's and local customisations off (`--safe-mode`: no " +
                "CLAUDE.md, skills, plugins, hooks or MCP servers load, while authentication works as normal -- unlike " +
                "`--bare`, which drops the stored login), only the read tools built in (`--tools`), pre-approved so nothing " +
                "prompts (`--allowedTools`), and no MCP server (`--strict-mcp-config` with no `--mcp-config`). Managed policy " +
                "hooks still apply, as the documentation says. Nothing offered can write.",
        },
    },
    codex: {
        author: {
            command: "codex",
            args: ["--sandbox", "workspace-write", "exec", "--json"],
            configFlag: "-c",
            promptArg: "-",
            note:
                "Codex non-interactive: prompt on stdin (`-`), `--json` prints JSONL events, the final agent_message " +
                "carries the document. Writes are confined to the working directory by the sandbox.",
        },
        reviewer: {
            command: "codex",
            args: ["--sandbox", "read-only", "exec", "--ignore-user-config", "--json"],
            configFlag: "-c",
            promptArg: "-",
            note:
                "Codex non-interactive in the read-only sandbox with the user's config.toml ignored: no MCP server, plugin " +
                "or hook from the user's setup, since those run outside the sandbox; the stored login is still used. " +
                "What a run needs from configuration is passed as `-c` overrides from REVIEWER_CONFIG_OVERRIDE_KEYS.",
        },
    },
};

/**
 * Configuration keys a reviewer run may override. Anything that would widen
 * what the reviewer can do -- the sandbox mode, approvals, MCP servers,
 * plugins, features, the shell environment policy -- is absent, so it cannot
 * be passed. `windows.sandbox` is here because with the user layer ignored
 * the Windows backend is otherwise unset, and unset means commands are
 * rejected (`codex` refuses to run unsandboxed), not that they run free.
 */
export const REVIEWER_CONFIG_OVERRIDE_KEYS: readonly string[] = [
    "model",
    "model_reasoning_effort",
    "windows.sandbox",
    "windows.sandbox_private_desktop",
];

export type CliCommandLine = { ok: true; args: readonly string[] } | { ok: false; detail: string };

/**
 * The full argument list for one run: the fixed arguments, then one
 * `configFlag key=value` per override, then the stdin marker. Overrides are
 * refused for a tool without a config flag, when malformed, and -- when an
 * allow list is given -- for any key outside it.
 */
export const cliCommandLine = (
    invocation: CliInvocation,
    configOverrides: readonly string[] = [],
    allowedKeys: readonly string[] | null = null
): CliCommandLine => {
    if (configOverrides.length > 0 && !invocation.configFlag) {
        return { ok: false, detail: `${invocation.command} takes no configuration override; got ${configOverrides.join(", ")}` };
    }
    const overrideArgs: string[] = [];
    for (const override of configOverrides) {
        const separator = override.indexOf("=");
        const key = separator === -1 ? "" : override.slice(0, separator).trim();
        if (key === "") return { ok: false, detail: `a configuration override must be key=value; got \`${override}\`` };
        if (allowedKeys && !allowedKeys.includes(key)) {
            return {
                ok: false,
                detail: `configuration override \`${key}\` is not allowed for this role; allowed: ${allowedKeys.join(", ")}`,
            };
        }
        overrideArgs.push(invocation.configFlag as string, override);
    }
    return { ok: true, args: [...invocation.args, ...overrideArgs, ...(invocation.promptArg ? [invocation.promptArg] : [])] };
};

export type CliExecutorOptions = {
    id: string;
    invocation: CliInvocation;
    mode: Exclude<ExecutorMode, "mock">;
    cwd: string;
    timeoutMs: number;
    /** Required for `live`; ignored -- never called -- in `dry-run`. */
    spawn?: Spawner;
    env?: Record<string, string | undefined>;
    /** `key=value` configuration overrides, each passed with the invocation's `configFlag`. */
    configOverrides?: readonly string[];
};

const CLAUDE_EXTERNAL_ROUTE_NAMES = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
]);
const CLAUDE_CLOUD_CREDENTIAL_PREFIXES = ["AWS_", "GOOGLE_", "AZURE_"];

/**
 * Build the exact child environment. Claude Code reviews must use the saved
 * first-party subscription login, so API credentials are removed without
 * trusting the casing used by the parent process or an override.
 */
export const sanitizedCliEnvironment = (
    id: string,
    base: Readonly<Record<string, string | undefined>>,
    overrides: Readonly<Record<string, string | undefined>> = {}
): Record<string, string> => {
    const combined = { ...base, ...overrides };
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(combined)) {
        if (value === undefined) continue;
        const upper = name.toUpperCase();
        if (
            id === "claude" &&
            (CLAUDE_EXTERNAL_ROUTE_NAMES.has(upper) || CLAUDE_CLOUD_CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix)))
        ) continue;
        result[name] = value;
    }
    return result;
};

export type ClaudeSubscriptionAuth = {
    loggedIn: true;
    authMethod: "claude.ai";
    apiProvider: "firstParty";
    subscriptionType: "max";
};

/** Fail closed unless Claude reports the exact Max first-party login. */
export const claudeSubscriptionAuthProblems = (value: unknown): readonly string[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return ["Claude auth status must be an object"];
    const record = value as Record<string, unknown>;
    const expected: Record<keyof ClaudeSubscriptionAuth, unknown> = {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
    };
    return Object.entries(expected)
        .filter(([name, wanted]) => record[name] !== wanted)
        .map(([name, wanted]) => `Claude auth ${name} must be ${JSON.stringify(wanted)}`);
};

const notExecuted = <T>(mode: string, command: string, args: readonly string[]): ExecutorResult<T> => ({
    ok: false,
    failure: "not_executed",
    detail: `${mode}: would run \`${[command, ...args].join(" ")}\` with the prompt on stdin`,
});

const runCli = async <T>(
    options: CliExecutorOptions,
    role: CrossReviewRole,
    prompt: string,
    problemsOf: (value: unknown) => readonly string[]
): Promise<ExecutorResult<T>> => {
    const line = cliCommandLine(
        options.invocation,
        options.configOverrides ?? [],
        role === "reviewer" ? REVIEWER_CONFIG_OVERRIDE_KEYS : null
    );
    if (!line.ok) return { ok: false, failure: "execution_failed", detail: line.detail };
    if (options.mode === "dry-run") return notExecuted<T>("dry-run", options.invocation.command, line.args);
    if (!options.spawn) {
        return { ok: false, failure: "execution_failed", detail: "live mode with no spawner; nothing was run" };
    }
    let result: SpawnResult;
    try {
        result = await options.spawn(options.invocation.command, line.args, {
            input: prompt,
            cwd: options.cwd,
            timeoutMs: options.timeoutMs,
            env: sanitizedCliEnvironment(options.id, process.env, options.env),
        });
    } catch (error) {
        return { ok: false, failure: "execution_failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.timedOut) return { ok: false, failure: "timeout", detail: `${options.invocation.command} exceeded ${options.timeoutMs}ms` };
    if (result.error) return { ok: false, failure: "execution_failed", detail: result.error.message };
    if (result.status !== 0) {
        return {
            ok: false,
            failure: "execution_failed",
            detail: `${options.invocation.command} exited ${result.status}: ${result.stderr.trim().slice(0, 400)}`,
        };
    }
    // The executable may be an absolute, hash-bound path. Decoding depends
    // on the logical producer protocol, never on that filesystem spelling.
    return decodeCliResult<T>(options.id, result.stdout, problemsOf);
};

/**
 * Decode exactly one successful model result from the tool's native output.
 * This is shared by live execution and by the package provenance reader, so
 * a wrapper cannot claim a verdict or report that the bound raw events do
 * not actually contain.
 */
export const decodeCliResult = <T>(
    command: string,
    stdout: string,
    problemsOf: (value: unknown) => readonly string[]
): ExecutorResult<T> => {
    if (command === "claude") {
        let envelope: unknown;
        try {
            envelope = parseJsonWithoutDuplicateKeys(stdout);
        } catch (error) {
            return { ok: false, failure: "invalid_json", detail: `Claude output is not one unambiguous JSON envelope: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (
            typeof envelope !== "object" ||
            envelope === null ||
            Array.isArray(envelope) ||
            (envelope as { type?: unknown }).type !== "result" ||
            (envelope as { subtype?: unknown }).subtype !== "success" ||
            (envelope as { is_error?: unknown }).is_error !== false ||
            typeof (envelope as { result?: unknown }).result !== "string"
        ) {
            return { ok: false, failure: "missing_result", detail: "Claude output carries no single successful result envelope" };
        }
        return parseExecutorJson<T>((envelope as { result: string }).result, problemsOf);
    }
    if (command === "codex") {
        const lines = stdout.split("\n").filter((line) => line.replace(/[ \t\r]/gu, "") !== "");
        const results: string[] = [];
        let completedTurns = 0;
        let failedTurns = 0;
        let legacyCompletedTurns = 0;
        let terminalIndex: number | null = null;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (terminalIndex !== null) {
                return {
                    ok: false,
                    failure: "schema_mismatch",
                    detail: `Codex event stream carries an event after its terminal event at index ${terminalIndex}`,
                };
            }
            let event: unknown;
            try {
                event = parseJsonWithoutDuplicateKeys(line);
            } catch (error) {
                return { ok: false, failure: "invalid_json", detail: `Codex output contains an ambiguous or non-JSON event line: ${error instanceof Error ? error.message : String(error)}` };
            }
            if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
            const current = event as { type?: unknown; item?: { type?: unknown; text?: unknown }; msg?: { type?: unknown; message?: unknown } };
            if (current.type === "turn.completed") {
                completedTurns += 1;
                terminalIndex = index;
            }
            if (current.type === "turn.failed") failedTurns += 1;
            const item = current.item;
            if (current.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") results.push(item.text);
            const msg = (event as { msg?: { type?: unknown; message?: unknown } }).msg;
            if (msg?.type === "agent_message" && typeof msg.message === "string") results.push(msg.message);
            if (msg?.type === "task_complete") {
                legacyCompletedTurns += 1;
                terminalIndex = index;
            }
        }
        if (failedTurns > 0) return { ok: false, failure: "execution_failed", detail: "Codex event stream carries a failed turn" };
        if (completedTurns + legacyCompletedTurns !== 1) {
            return {
                ok: false,
                failure: "schema_mismatch",
                detail: `Codex event stream carries ${completedTurns} completed turn(s) and ${legacyCompletedTurns} legacy completion(s); expected exactly one successful completion`,
            };
        }
        if (results.length === 0) return { ok: false, failure: "missing_result", detail: "Codex event stream carries no agent result" };
        if (results.length !== 1) return { ok: false, failure: "schema_mismatch", detail: `Codex event stream carries ${results.length} agent results; expected exactly one` };
        return parseExecutorJson<T>(results[0], problemsOf);
    }
    return { ok: false, failure: "execution_failed", detail: `unsupported CLI result producer ${command}` };
};

/**
 * Codex's `exec --json` prints one event per line; the model's final message
 * arrives as `{"type":"item.completed","item":{"id":…,"type":"agent_message",
 * "text":…}}` (`codex-rs/exec/src/exec_events.rs` at tag `rust-v0.146.0`:
 * `ThreadEvent` tagged by `type`, `ThreadItem` flattening `ThreadItemDetails`
 * tagged by `type`, `AgentMessageItem { text }`). That text is the document
 * asked for; the last such message wins. The older `{"msg":{"type":
 * "agent_message","message":…}}` shape is read too. Output that is not JSONL
 * is returned untouched for the parser to judge.
 */
export const unwrapCodexJsonl = (stdout: string): string => {
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return stdout;
    let last: string | null = null;
    for (const line of lines) {
        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            return stdout;
        }
        if (typeof event !== "object" || event === null) continue;
        const item = (event as { item?: { type?: unknown; text?: unknown } }).item;
        if (item && item.type === "agent_message" && typeof item.text === "string") last = item.text;
        const msg = (event as { msg?: { type?: unknown; message?: unknown } }).msg;
        if (msg && msg.type === "agent_message" && typeof msg.message === "string") last = msg.message;
    }
    return last ?? stdout;
};

/** What a tool reported spending, in its own units, with the tool named. */
export type ExecutorUsage = {
    tool: "codex" | "claude";
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    /** Claude Code's client-side estimate, when the envelope carries one. */
    totalCostUsd: number | null;
    /** The tool's own usage object, verbatim. */
    raw: unknown;
};

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The usage a tool reported, read from the shape that tool prints: Codex's
 * `turn.completed` event in its JSONL stream (the last one wins), or Claude
 * Code's single JSON envelope (`usage`, `total_cost_usd`). Null when the
 * output is neither, so a record never carries a usage the tool did not
 * report.
 */
export const extractUsage = (stdout: string): ExecutorUsage | null => {
    const trimmed = stdout.trim();
    if (trimmed === "") return null;
    try {
        const envelope = JSON.parse(trimmed) as unknown;
        if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
            const record = envelope as Record<string, unknown>;
            const usage = record.usage;
            if (typeof usage === "object" && usage !== null) {
                const fields = usage as Record<string, unknown>;
                return {
                    tool: "claude",
                    inputTokens: numberOrNull(fields.input_tokens),
                    cachedInputTokens: numberOrNull(fields.cache_read_input_tokens),
                    outputTokens: numberOrNull(fields.output_tokens),
                    reasoningOutputTokens: null,
                    totalCostUsd: numberOrNull(record.total_cost_usd),
                    raw: usage,
                };
            }
        }
    } catch {
        // not a single envelope; try the event stream
    }
    let usage: Record<string, unknown> | null = null;
    for (const line of trimmed.split("\n")) {
        try {
            const event = JSON.parse(line) as unknown;
            if (typeof event === "object" && event !== null) {
                const record = event as Record<string, unknown>;
                if (record.type === "turn.completed" && typeof record.usage === "object" && record.usage !== null) {
                    usage = record.usage as Record<string, unknown>;
                }
            }
        } catch {
            // not an event line
        }
    }
    if (!usage) return null;
    return {
        tool: "codex",
        inputTokens: numberOrNull(usage.input_tokens),
        cachedInputTokens: numberOrNull(usage.cached_input_tokens),
        outputTokens: numberOrNull(usage.output_tokens),
        reasoningOutputTokens: numberOrNull(usage.reasoning_output_tokens),
        totalCostUsd: null,
        raw: usage,
    };
};

/**
 * Claude Code's `--output-format json` wraps the answer in an envelope whose
 * `result` field holds the model's text. The text is what carries the
 * document asked for; the envelope is not it. Any other output is returned
 * as-is for the parser to read directly.
 */
export const unwrapClaudeResult = (stdout: string): string => {
    try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const result = (parsed as { result?: unknown }).result;
            if (typeof result === "string") return result;
        }
    } catch {
        // not an envelope
    }
    return stdout;
};

export const renderAuthorPrompt = (request: AuthorRequest): string => {
    const lines: string[] = [];
    lines.push(`# Author — task ${request.task.taskId}, round ${request.round}`);
    lines.push("");
    lines.push("## Requirement");
    lines.push("");
    lines.push(request.task.requirement);
    lines.push("");
    lines.push("## Completion criteria");
    lines.push("");
    for (const criterion of request.task.completionCriteria) lines.push(`- ${criterion}`);
    lines.push("");
    lines.push(`Base commit: ${request.task.baseCommit}. You may change only: ${request.task.writableScope.join(", ") || "(unrestricted)"}.`);
    if (request.feedback) {
        lines.push("");
        lines.push("## Findings to address from the previous review");
        lines.push("");
        for (const finding of request.feedback.findings) {
            lines.push(`- [${finding.severity}/${finding.basis}] ${finding.location}: ${finding.claim}`);
            if (finding.reproduction) lines.push(`  reproduction: ${finding.reproduction}`);
        }
        for (const run of request.feedback.failedTests) lines.push(`- FAILED \`${run.command}\`: ${run.output.trim().slice(0, 300)}`);
        for (const violation of request.feedback.guardViolations) lines.push(`- guard: ${violation}`);
        for (const failure of request.feedback.checkFailures) {
            if (!failure.startsWith("test failed:") && !failure.startsWith("guard:")) lines.push(`- check: ${failure}`);
        }
    }
    lines.push("");
    lines.push("## Answer format");
    lines.push("");
    lines.push("When the change is made, reply with exactly one JSON document and nothing else:");
    lines.push("");
    lines.push("```json");
    lines.push(
        JSON.stringify(
            {
                diff: "unified diff of the change against the base commit",
                summary: "what changed, in a few sentences",
                filesChanged: ["path/one", "path/two"],
                selfAssessment: "optional: your own view of the risks",
                commit: "commit sha, or null for an uncommitted worktree",
            },
            null,
            2
        )
    );
    lines.push("```");
    return `${lines.join("\n")}\n`;
};

export const cliAuthor = (options: CliExecutorOptions): AuthorExecutor => ({
    id: options.id,
    produce: (request) => runCli<AuthorOutput>(options, "author", renderAuthorPrompt(request), authorOutputProblems),
});

export const cliReviewer = (options: CliExecutorOptions): ReviewerExecutor => ({
    id: options.id,
    review: (request) => runCli<ReviewVerdict>(options, "reviewer", renderReviewPrompt(request), reviewVerdictProblems),
});

/**
 * The reviewer's invocation, run on a prompt that is not a review: the
 * environment preflight. Same command line, same override allow list, same
 * sandbox, so what it shows about reads and writes is what a review would
 * get.
 */
export const cliProbe = (options: CliExecutorOptions) => ({
    id: options.id,
    run: <T>(prompt: string, problemsOf: (value: unknown) => readonly string[]) =>
        runCli<T>(options, "reviewer", prompt, problemsOf),
});
