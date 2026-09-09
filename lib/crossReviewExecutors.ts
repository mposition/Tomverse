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
 * lines. The flag sets below are recorded as the intended invocation and
 * must be checked against the installed tool's `--help` before a live run;
 * `CLI_INVOCATIONS` exists so that check is a comparison against one place.
 */

import {
    authorOutputProblems,
    parseExecutorJson,
    renderReviewPrompt,
    reviewVerdictProblems,
    type AuthorExecutor,
    type AuthorOutput,
    type AuthorRequest,
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
    /** True when the spawner itself enforced a timeout. */
    timedOut?: boolean;
    error?: Error;
};

export type Spawner = (
    command: string,
    args: readonly string[],
    options: { input: string; cwd: string; timeoutMs: number; env?: Record<string, string | undefined> }
) => Promise<SpawnResult>;

export type CliInvocation = {
    command: string;
    /** Arguments before the prompt. The prompt is passed on stdin. */
    args: readonly string[];
    /** What the invocation is for, so a reader can check it against `--help`. */
    note: string;
};

/**
 * The intended invocations, one per tool and role. Recorded, not verified:
 * `codex` is not installed where this was written, and the Claude Code flags
 * were read from `claude --help` of 2.1.266. Check both before a live run.
 */
export const CLI_INVOCATIONS: Readonly<Record<"claude" | "codex", Readonly<Record<"author" | "reviewer", CliInvocation>>>> = {
    claude: {
        author: {
            command: "claude",
            args: ["--print", "--output-format", "json", "--permission-mode", "acceptEdits"],
            note: "Claude Code non-interactive; may edit within the task's writable scope; result JSON on stdout.",
        },
        reviewer: {
            command: "claude",
            args: ["--print", "--output-format", "json", "--allowedTools", "Read,Grep,Glob"],
            note: "Claude Code non-interactive with read-only tools; no write tool is offered.",
        },
    },
    codex: {
        author: {
            command: "codex",
            args: ["--sandbox", "workspace-write", "exec", "--json", "-"],
            note:
                "Codex non-interactive: prompt on stdin (`-`), `--json` prints JSONL events, the final " +
                "agent_message carries the document. `--sandbox` is the root CLI's flag; unverified here.",
        },
        reviewer: {
            command: "codex",
            args: ["--sandbox", "read-only", "exec", "--json", "-"],
            note: "Codex non-interactive in the read-only sandbox; it cannot write to the change.",
        },
    },
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
};

const notExecuted = <T>(mode: string, invocation: CliInvocation): ExecutorResult<T> => ({
    ok: false,
    failure: "not_executed",
    detail: `${mode}: would run \`${[invocation.command, ...invocation.args].join(" ")}\` with the prompt on stdin`,
});

const runCli = async <T>(
    options: CliExecutorOptions,
    prompt: string,
    problemsOf: (value: unknown) => readonly string[]
): Promise<ExecutorResult<T>> => {
    if (options.mode === "dry-run") return notExecuted<T>("dry-run", options.invocation);
    if (!options.spawn) {
        return { ok: false, failure: "execution_failed", detail: "live mode with no spawner; nothing was run" };
    }
    let result: SpawnResult;
    try {
        result = await options.spawn(options.invocation.command, options.invocation.args, {
            input: prompt,
            cwd: options.cwd,
            timeoutMs: options.timeoutMs,
            env: options.env,
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
    return parseExecutorJson<T>(unwrapCodexJsonl(unwrapClaudeResult(result.stdout)), problemsOf);
};

/**
 * Codex's `exec --json` prints one event per line and the model's final
 * message as an `agent_message` item. That text is the document asked for.
 * Read against `codex-rs/exec/src/cli.rs` (`--json`: "Print events to stdout
 * as JSONL"); the event shape is not verified against an installed binary,
 * and output that does not look like it is returned untouched.
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
    produce: (request) => runCli<AuthorOutput>(options, renderAuthorPrompt(request), authorOutputProblems),
});

export const cliReviewer = (options: CliExecutorOptions): ReviewerExecutor => ({
    id: options.id,
    review: (request) => runCli<ReviewVerdict>(options, renderReviewPrompt(request), reviewVerdictProblems),
});
