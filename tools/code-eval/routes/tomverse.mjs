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

/**
 * The engine features a measurement turns on, by the Runner option each one is. They are the ones that change how the agent works
 * on a code task. Left out on purpose: web_fetch (the tasks use no network, and a page read would also need an approval) and the
 * Code memory (notes kept between tasks would carry one task's lessons into the next, and the runs would no longer be independent).
 */
export const ENGINE_FEATURES = ["backgroundCommands", "images", "nestedInstructions", "subagents"];
export const LIMIT_PROFILES = ["standard", "extended", "unlimited"];
/** The profile measurements use unless --limits says otherwise: tasks run far beyond the 20 requests of an interactive default. */
export const DEFAULT_LIMITS = "extended";

/** @param {string | undefined} value  "none", or a comma list of ENGINE_FEATURES; undefined means all of them. */
export const parseEngineFeatures = (value) => {
    if (value === undefined) return [...ENGINE_FEATURES];
    if (value.trim() === "none") return [];
    const wanted = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
    const unknown = wanted.filter((name) => !ENGINE_FEATURES.includes(name));
    if (unknown.length || !wanted.length) throw new Error(`--engine takes "none" or a list of: ${ENGINE_FEATURES.join(", ")}${unknown.length ? ` (not: ${unknown.join(", ")})` : ""}.`);
    return ENGINE_FEATURES.filter((name) => wanted.includes(name));
};

export const parseLimitProfile = (value) => {
    if (value === undefined) return DEFAULT_LIMITS;
    if (!LIMIT_PROFILES.includes(value)) throw new Error(`--limits must be one of: ${LIMIT_PROFILES.join(", ")}.`);
    return value;
};

/** What a run records about the engine conditions it ran under, so a before and after comparison shows them. */
export const engineConditions = ({ limits, engine, maxRequests } = {}) => ({
    limits: parseLimitProfile(limits),
    features: engine ?? [...ENGINE_FEATURES],
    ...(maxRequests ? { maxRequests } : {}),
});

export const buildWorkerRequest = ({ prompt, workDir, resultFile, timeoutMs, model, maxRequests, limits, engine }) => ({
    prompt,
    workDir,
    resultFile,
    model: model ?? null,
    // A number given here is more specific than the profile and wins over its request count; without one the profile decides.
    maxRequests: maxRequests ?? null,
    limits: parseLimitProfile(limits),
    engine: engine ?? [...ENGINE_FEATURES],
    // The task's own time limit always applies, whatever the profile says: a measurement must end.
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
            const request = buildWorkerRequest({ prompt, workDir, resultFile, timeoutMs, model: options.model, maxRequests: options.maxRequests, limits: options.limits, engine: options.engine });
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
