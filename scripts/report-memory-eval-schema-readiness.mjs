/**
 * Which artifact consumers can read schema 3, and what still blocks the gate.
 *
 * Read-only, no credentials, no provider. It reports; it decides nothing.
 * Moving `MEMORY_EVAL_DATASET_SCHEMA_VERSION` is a separate reviewed change,
 * and even a clean report does not open a paid run — that needs the budget
 * approval of docs/policy/external-conversation-import-and-memory.md §12.5,
 * which names the pair, both digests, the run count and the ceiling.
 */

import {
    MEMORY_EVAL_SCHEMA3_CONSUMERS,
    memoryEvalSchema3Blockers,
    memoryEvalSchema3Readiness,
} from "../lib/memoryEvalSchemaReadiness.ts";
// The run-mode gate, from the module that owns it. `lib/memoryEvalDatasetSchema.ts`
// exports a constant of the same name meaning "the schema this module defines",
// which is 2 forever; reading that one here printed the right number only while
// the gate happened to agree with it.
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "../lib/memoryExtractionEvalCore.ts";
import {
    harnessTarget,
    harnessTargetBindingFailures,
} from "../lib/memoryEvalHarnessTarget.ts";

const target = harnessTarget();
const summary = memoryEvalSchema3Readiness();
const blockers = memoryEvalSchema3Blockers();

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

console.log("\nMemory eval — dataset schema readiness");
line("harness target", target.datasetVersion);
line("target schema", target.datasetSchemaVersion);
line("run-mode gate pinned to schema", MEMORY_EVAL_DATASET_SCHEMA_VERSION);
line("dataset digest", target.datasetDigest);
line("scoring contract", `${target.scoringContractVersion} ${target.scoringContractDigest}`);

const binding = harnessTargetBindingFailures(target);
line("binds to its manifest", binding.length === 0 ? "yes" : `NO (${binding.length})`);
for (const failure of binding) console.log(`      ${failure}`);

console.log("\nConsumers");
for (const row of MEMORY_EVAL_SCHEMA3_CONSUMERS) {
    const mark =
        row.state === "converted"
            ? "OK  "
            : row.state === "pending"
              ? "TODO"
              : "n/a ";
    console.log(`  ${mark} ${row.consumer}`);
    console.log(`         ${row.role}`);
    console.log(`         evidence: ${row.evidence}`);
}

console.log(
    `\n  converted ${summary.converted}   pending ${summary.pending}   ` +
        `historical-only ${summary.historicalOnly}`
);

if (blockers.length > 0) {
    console.log(
        "\nThe gate stays where it is. These consumers would read a schema-3 artifact\n" +
            "under the wrong contract, and a paid run producing one would leave a record\n" +
            "nothing downstream can use:"
    );
    for (const row of blockers) console.log(`  - ${row.consumer}: ${row.evidence}`);
} else if (MEMORY_EVAL_DATASET_SCHEMA_VERSION < target.datasetSchemaVersion) {
    console.log(
        "\nNo consumer is pending, so the gate MAY be moved — as its own reviewed\n" +
            `change, from ${MEMORY_EVAL_DATASET_SCHEMA_VERSION} to ${target.datasetSchemaVersion} in ` +
            "lib/memoryEvalDatasetSchema.ts.\n\n" +
            "Moving it opens nothing on its own. A live run still needs the budget\n" +
            "approval on the pair — docs/policy/external-conversation-import-and-memory.md\n" +
            "§12.5 — and this report is not that approval: it says the instrument is\n" +
            "ready, not that anyone agreed to spend money on it."
    );
} else {
    console.log("\nThe gate already reads the harness target's schema.");
}
