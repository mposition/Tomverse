/**
 * Fail-closed gate over the memory-extraction eval register (Release B,
 * import/memory policy §12.1, §12.4). Runs in the PR Fast Gate.
 *
 *   * An `approved` pair must carry complete §12.1 evidence, §12.3-passing
 *     metrics, an unexpired approval, and a human-approved eval budget —
 *     anything less fails the build, because an approved pair is what the
 *     extraction runtime will actually call.
 *   * Every registered model must have an explicit pricing profile
 *     (§11: extraction follows the verified-pricing contract).
 *   * Candidate pairs without a budget are the expected §12.5 waiting state
 *     and print as notices, not failures.
 */

import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    findEvalRegisterProblems,
} from "../lib/memoryExtractionEvalRegister.ts";
import { getModelPricingProfile } from "../lib/modelPricing.ts";

const problems = findEvalRegisterProblems(MEMORY_EXTRACTION_EVAL_REGISTER);

for (const entry of MEMORY_EXTRACTION_EVAL_REGISTER) {
    const label = `${entry.extractionModelId}::${entry.promptVersion}`;
    if (!getModelPricingProfile(entry.extractionModelId)) {
        problems.push(
            `${label}: no explicit pricing profile in lib/modelPricing.ts (§11)`
        );
    }
    if (entry.status === "candidate" && !entry.evalBudget) {
        console.log(
            `notice: ${label} is a candidate awaiting a human eval-budget ` +
                `approval (§12.5) — smoke mode only until it is recorded.`
        );
    }
}

const approved = MEMORY_EXTRACTION_EVAL_REGISTER.filter(
    (entry) => entry.status === "approved"
).length;

if (problems.length > 0) {
    for (const problem of problems) {
        console.error(`error: ${problem}`);
    }
    console.error(
        `Memory extraction eval register check failed with ${problems.length} problem(s).`
    );
    process.exit(1);
}

console.log(
    `Memory extraction eval register check passed: ` +
        `${MEMORY_EXTRACTION_EVAL_REGISTER.length} pair(s), ${approved} approved.`
);
