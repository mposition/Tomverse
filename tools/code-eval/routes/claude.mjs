// Route "claude": Claude Code CLI in print mode with JSON output. Edits and
// test commands only: file tools plus `node`, `npm test` and read-only git;
// anything else would prompt, and prompts are answered with "deny"
// (--permission-prompts none). Flags checked against `claude --help` of
// Claude Code 2.1.278 without running a model request; the JSON result shape
// below is NOT verified against a real run (see README).
import { envWithout, runProcess } from "../lib/proc.mjs";
import { findBinary, homeBin } from "../lib/bin.mjs";

export const ALLOWED_TOOLS = [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash(node *)",
    "Bash(npm test*)",
    "Bash(npm run test*)",
    "Bash(git diff*)",
    "Bash(git status*)",
    "Bash(git log*)",
];
export const DISALLOWED_TOOLS = ["WebFetch", "WebSearch"];
export const DEFAULT_MAX_BUDGET_USD = 1.5;

export const buildClaudeArgs = ({ model, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD } = {}) => [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--allowedTools",
    ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
    "--no-session-persistence",
    "--safe-mode",
    "--max-budget-usd",
    String(maxBudgetUsd),
    ...(model ? ["--model", model] : []),
];

/** `--output-format json` prints one result object (or an array of messages ending in one). */
export const parseClaudeResult = (text) => {
    let data;
    try {
        data = JSON.parse(text.trim());
    } catch {
        return { metrics: {}, error: "output was not JSON" };
    }
    const result = Array.isArray(data) ? [...data].reverse().find((m) => m?.type === "result") : data;
    if (!result || typeof result !== "object") return { metrics: {}, error: "no result message" };
    const usage = result.usage ?? {};
    return {
        metrics: {
            inputTokens: (Number(usage.input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0),
            cachedInputTokens: Number(usage.cache_read_input_tokens) || 0,
            outputTokens: Number(usage.output_tokens) || 0,
            costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
            turns: typeof result.num_turns === "number" ? result.num_turns : undefined,
        },
        error: result.is_error ? String(result.result ?? result.subtype ?? "error").slice(0, 500) : null,
    };
};

const binary = (env) => findBinary({ names: ["claude"], envVar: "CODE_EVAL_CLAUDE_BIN", extraDirs: homeBin(), env });

export const route = {
    name: "claude",
    paid: true,
    paidNotice: `route claude runs Anthropic model requests billed to the account Claude Code is logged in to (capped at ${DEFAULT_MAX_BUDGET_USD} USD per task by --max-budget-usd).`,
    preflight(env = process.env) {
        return binary(env) ? null : "the claude CLI was not found on PATH or in ~/.local/bin (or set CODE_EVAL_CLAUDE_BIN).";
    },
    async run({ workDir, prompt, timeoutMs, options = {}, env = process.env }) {
        const bin = binary(env);
        if (!bin) return { status: "error", error: "claude CLI not found" };
        const maxBudgetUsd = Number(env.CODE_EVAL_MAX_BUDGET_USD) > 0 ? Number(env.CODE_EVAL_MAX_BUDGET_USD) : DEFAULT_MAX_BUDGET_USD;
        const result = await runProcess({
            file: bin.file,
            args: buildClaudeArgs({ model: options.model, maxBudgetUsd }),
            cwd: workDir,
            // A parent Claude Code session marks its children; a measurement must not look nested.
            env: envWithout(["TOMVERSE_API_KEY", "CLAUDECODE"], env),
            input: prompt,
            timeoutMs,
            shell: bin.shell,
        });
        if (result.spawnError) return { status: "error", error: result.spawnError };
        const parsed = parseClaudeResult(result.stdout);
        const status = result.timedOut ? "timeout" : result.code === 0 && !parsed.error ? "ok" : "error";
        return {
            status,
            ...(status === "ok" ? {} : { error: parsed.error ?? (result.stderr.trim().slice(-500) || `exit code ${result.code}`) }),
            metrics: parsed.metrics,
        };
    },
};
