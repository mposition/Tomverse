import { processOneResearchPreviewRun } from "@/lib/researchPreviewRunService";

const once = process.argv.includes("--once");
const stepLimitArguments = process.argv.slice(2).filter(argument => argument.startsWith("--max-steps-per-claim"));
const stepLimit = stepLimitArguments.length === 0 ? 3 : stepLimitArguments.length === 1 && /^--max-steps-per-claim=[1-3]$/.test(stepLimitArguments[0]!)
  ? Number(stepLimitArguments[0]!.split("=")[1]) : null;
const workerId = process.env.RESEARCH_PREVIEW_WORKER_ID?.trim() ||
  `research-preview-worker:${process.pid}`;
let stopping = false;

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

async function main() {
  if (stepLimit === null) throw new Error("--max-steps-per-claim must be 1, 2 or 3.");
  if (process.env.RESEARCH_PREVIEW_DURABLE_ENABLED !== "true") {
    throw new Error("RESEARCH_PREVIEW_DURABLE_ENABLED must be true to start the worker.");
  }

  do {
    const processed = await processOneResearchPreviewRun(workerId, { maxStepsPerClaim: stepLimit });
    if (once || stopping) break;
    if (!processed) await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (!stopping);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Research worker stopped.");
  process.exitCode = 1;
});
