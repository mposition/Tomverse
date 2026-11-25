// Route "tomverse": the repository's own coding agent (apps/tomverse-cli),
// driven headless through its runtime API instead of `tomverse exec`, which
// stops with exit code 3 at the first action that needs approval.
// The approval policy is in tomverse-approval.mjs.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envWithout, runProcess } from "../lib/proc.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const buildWorkerRequest = ({ prompt, workDir, resultFile, timeoutMs, model, maxRequests }) => ({
    prompt,
    workDir,
    resultFile,
    model: model ?? null,
    maxRequests: maxRequests ?? 40,
    timeoutMs,
    commandTimeoutMs: 120_000,
});

export const route = {
    name: "tomverse",
    paid: true,
    paidNotice: "route tomverse sends model requests that spend Tomverse credits on the key in TOMVERSE_API_KEY (one request per agent step).",
    preflight(env = process.env) {
        return env.TOMVERSE_API_KEY ? null : "TOMVERSE_API_KEY is not set (the key is read from the environment only).";
    },
    async run({ workDir, prompt, timeoutMs, options = {}, env = process.env }) {
        const scratch = mkdtempSync(join(tmpdir(), "code-eval-tv-"));
        const resultFile = join(scratch, "result.json");
        try {
            const request = buildWorkerRequest({ prompt, workDir, resultFile, timeoutMs, model: options.model, maxRequests: options.maxRequests });
            const child = await runProcess({
                file: process.execPath,
                args: [join(here, "tomverse-worker.mjs")],
                cwd: here,
                env: envWithout(["NODE_TEST_CONTEXT"], env),
                input: JSON.stringify(request),
                // The agent has its own time limit; this one only catches a hang.
                timeoutMs: timeoutMs + 60_000,
            });
            if (child.timedOut) return { status: "timeout", error: "worker did not finish in time" };
            try {
                return JSON.parse(readFileSync(resultFile, "utf8"));
            } catch {
                return { status: "error", error: (child.stderr || child.spawnError || `worker exited with ${child.code}`).slice(-500) };
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    },
};
