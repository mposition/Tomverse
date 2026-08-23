/**
 * Fills the drafting-provenance cell on every adopted batch record.
 *
 *   npm run record:memory-eval-drafter -- --drafter=ai-draft:<도구>/<모델>/<버전>
 *   npm run record:memory-eval-drafter -- --drafter=… --batches=batch-001,batch-002
 *
 * docs/ops/memory-extraction-eval-dataset.md §7.1 makes the drafting tool,
 * model and version a freeze condition, and the freeze check found all 28
 * records short of it: eight blank, twenty carrying the tool alone.
 *
 * **The operator runs this, not the agent.** The value names the model that
 * produced the drafts, and this agent does not write its own model identifier
 * into repository artefacts — which is why the generated sheet leaves the cell
 * to the operator in the first place. Counting the records, finding them,
 * validating the shape and rewriting the table row is mechanical work and
 * belongs here; supplying and committing the identifier does not.
 *
 * The value is taken verbatim. The only check is the shape
 * docs/ops/memory-extraction-eval-dataset.md §7.1 asks for --
 * three parts after `ai-draft:` -- because a tool that guessed at a missing
 * model or version would be inventing the provenance the freeze condition
 * exists to record.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";

const argValue = (name) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : "";
};

const drafter = argValue("drafter");
if (!/^ai-draft:[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(drafter)) {
    console.error(
        "--drafter must look like ai-draft:<tool>/<model>/<version> — " +
            "docs/ops/memory-extraction-eval-dataset.md §7.1 wants all three.\n" +
            `Got: ${drafter || "(empty)"}`
    );
    process.exit(1);
}

const only = argValue("batches");
const wanted = only ? new Set(only.split(",").map((s) => s.trim())) : null;
const targets = ADOPTED_BATCHES.filter((b) => !wanted || wanted.has(b.id));
if (targets.length === 0) {
    console.error(`--batches matched no adopted batch (${only}).`);
    process.exit(1);
}

const CELL = /(\| 초안 생성자[^|]*\|)([^|]*)\|/;
let written = 0;
const skipped = [];

for (const batch of targets) {
    const original = readFileSync(batch.record, "utf8");
    const match = CELL.exec(original);
    if (!match) {
        skipped.push(`${batch.id}: no 초안 생성자 row`);
        continue;
    }
    const current = match[2]
        .replace(/\*\([^)]*\)\*/g, "")
        .replace(/[`*]/g, "")
        .trim();
    // A row that already names all three parts is left alone: it was filled
    // deliberately, and overwriting it would erase a provenance somebody else
    // recorded.
    if (/^ai-draft:[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(current)) {
        skipped.push(`${batch.id}: already complete (${current})`);
        continue;
    }
    writeFileSync(
        batch.record,
        original.replace(CELL, `$1 \`${drafter}\` |`)
    );
    written += 1;
}

for (const note of skipped) console.log(`skipped ${note}`);
console.log(`wrote the drafting provenance to ${written} record(s).`);
