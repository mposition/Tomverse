// Fails the build when the image-generation deadlines disagree with each
// other. See scripts/check-image-executor-budget-core.mjs for what each of the
// three means and what goes wrong when they drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    IMAGE_ATTEMPT_WORST_CASE_MS,
    IMAGE_EXECUTOR_MAX_DURATION_SECONDS,
    STALE_IMAGE_GENERATION_AFTER_MS,
} from "../lib/imageGenerationStateCore.ts";
import {
    auditImageExecutorBudget,
    IMAGE_EXECUTOR_ROUTES,
    readDeclaredMaxDuration,
} from "./check-image-executor-budget-core.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const routes = IMAGE_EXECUTOR_ROUTES.map((file) => {
    const source = readFileSync(join(repoRoot, file), "utf8");
    return {
        file,
        declaredSeconds: readDeclaredMaxDuration(source),
        // Both halves matter: `after(` alone is satisfied by an incident
        // report, and the group call alone could be awaited inline.
        drivesExecutor:
            source.includes("after(") &&
            source.includes("processImageGenerationGroup("),
    };
});

const { failures } = auditImageExecutorBudget({
    attemptWorstCaseMs: IMAGE_ATTEMPT_WORST_CASE_MS,
    staleAfterMs: STALE_IMAGE_GENERATION_AFTER_MS,
    requiredSeconds: IMAGE_EXECUTOR_MAX_DURATION_SECONDS,
    routes,
});

if (failures.length > 0) {
    console.error("Image executor budget check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(
    `Image executor budget check passed: worst attempt ${(
        IMAGE_ATTEMPT_WORST_CASE_MS / 60_000
    ).toFixed(1)}min, stale after ${(
        STALE_IMAGE_GENERATION_AFTER_MS / 60_000
    ).toFixed(0)}min, ${routes.length} route(s) declaring ` +
        `${IMAGE_EXECUTOR_MAX_DURATION_SECONDS}s or more.`
);
