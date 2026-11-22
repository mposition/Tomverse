import { processOneResearchPreviewRun } from "@/lib/researchPreviewRunService";
import { processOneResearchWorkItem } from "@/lib/researchEngineWorker";
import { recoverResearchEngine } from "@/lib/researchEngineRecovery";

/**
 * One worker process for both Research engines. v1 (Preview) claims whole runs
 * with its own three-step cap; v2 claims short work items, `--engine-concurrency`
 * at a time, under the database's per-account/run/provider/global limits.
 * Each engine runs only when its own default-off flag is on.
 */
const once = process.argv.includes("--once");
const argument = (name: string) => process.argv.slice(2).filter((entry) => entry.startsWith(`${name}=`));
const stepLimitArguments = process.argv.slice(2).filter(argument => argument.startsWith("--max-steps-per-claim"));
const stepLimit = stepLimitArguments.length === 0 ? 3 : stepLimitArguments.length === 1 && /^--max-steps-per-claim=[1-3]$/.test(stepLimitArguments[0]!)
  ? Number(stepLimitArguments[0]!.split("=")[1]) : null;
const concurrencyArguments = argument("--engine-concurrency");
const engineConcurrency = concurrencyArguments.length === 0 ? 4 : concurrencyArguments.length === 1 && /^--engine-concurrency=(?:[1-9]|[1-5]\d|6[0-4])$/.test(concurrencyArguments[0]!)
  ? Number(concurrencyArguments[0]!.split("=")[1]) : null;
const workerId = process.env.RESEARCH_PREVIEW_WORKER_ID?.trim() ||
  `research-preview-worker:${process.pid}`;
let stopping = false;

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

async function main() {
  if (stepLimit === null) throw new Error("--max-steps-per-claim must be 1, 2 or 3.");
  if (engineConcurrency === null) throw new Error("--engine-concurrency must be between 1 and 64.");
  const v1 = process.env.RESEARCH_PREVIEW_DURABLE_ENABLED === "true";
  const v2 = process.env.RESEARCH_ENGINE_ENABLED === "true";
  if (!v1 && !v2) {
    throw new Error("RESEARCH_PREVIEW_DURABLE_ENABLED or RESEARCH_ENGINE_ENABLED must be true to start the worker.");
  }
  let lastRecovery = 0;
  do {
    let processed = false;
    if (v1) processed = await processOneResearchPreviewRun(workerId, { maxStepsPerClaim: stepLimit }) || processed;
    if (v2) {
      if (Date.now() - lastRecovery > 60_000) { await recoverResearchEngine().catch(() => undefined); lastRecovery = Date.now(); }
      const lanes = await Promise.all(Array.from({ length: engineConcurrency }, (_, index) =>
        processOneResearchWorkItem(`${workerId}:engine:${index}`).catch(() => false)));
      processed = lanes.some(Boolean) || processed;
    }
    if (once || stopping) break;
    if (!processed) await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (!stopping);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Research worker stopped.");
  process.exitCode = 1;
});
