// Route "codex": OpenAI Codex CLI, `codex exec --json` with the workspace-write
// sandbox (edits inside the working folder, no network). Flags checked against
// `codex exec --help` of codex-cli 0.171.0 without running a model request;
// the JSONL event shape below is NOT verified against a real run (see README).
import { envWithout, runProcess } from "../lib/proc.mjs";
import { findBinary } from "../lib/bin.mjs";

export const buildCodexArgs = ({ model } = {}) => [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    "approval_policy=never",
    ...(model ? ["--model", model] : []),
    // "-" makes codex read the prompt from stdin, so it never appears in argv.
    "-",
];

/** Reads the JSONL event stream; unknown shapes are ignored rather than guessed. */
export const parseCodexEvents = (text) => {
    const metrics = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, turns: 0 };
    let error = null;
    let sawUsage = false;
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("{")) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (event.type === "turn.completed" && event.usage) {
            sawUsage = true;
            metrics.turns += 1;
            metrics.inputTokens += Number(event.usage.input_tokens) || 0;
            metrics.cachedInputTokens += Number(event.usage.cached_input_tokens) || 0;
            metrics.outputTokens += Number(event.usage.output_tokens) || 0;
        }
        if (event.type === "turn.failed") error = event.error?.message ?? "turn failed";
        else if (event.type === "error" && typeof event.message === "string") error = event.message;
    }
    return { metrics: sawUsage ? metrics : {}, error };
};

export const route = {
    name: "codex",
    paid: true,
    paidNotice: "route codex runs OpenAI model requests billed to the account the Codex CLI is logged in to; there is no spending cap flag, only the per-task time limit.",
    preflight(env = process.env) {
        return findBinary({ names: ["codex"], envVar: "CODE_EVAL_CODEX_BIN", env }) ? null : "the codex CLI was not found on PATH (or set CODE_EVAL_CODEX_BIN).";
    },
    async run({ workDir, prompt, timeoutMs, options = {}, env = process.env }) {
        const binary = findBinary({ names: ["codex"], envVar: "CODE_EVAL_CODEX_BIN", env });
        if (!binary) return { status: "error", error: "codex CLI not found" };
        const result = await runProcess({
            file: binary.file,
            args: buildCodexArgs({ model: options.model }),
            cwd: workDir,
            env: envWithout(["TOMVERSE_API_KEY"], env),
            input: prompt,
            timeoutMs,
            shell: binary.shell,
        });
        if (result.spawnError) return { status: "error", error: result.spawnError };
        const parsed = parseCodexEvents(result.stdout);
        const status = result.timedOut ? "timeout" : result.code === 0 && !parsed.error ? "ok" : "error";
        return {
            status,
            ...(status === "ok" ? {} : { error: parsed.error ?? (result.stderr.trim().slice(-500) || `exit code ${result.code}`) }),
            metrics: parsed.metrics,
        };
    },
};
