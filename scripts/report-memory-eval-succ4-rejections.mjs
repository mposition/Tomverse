// The replacement drafts the contract checks rejected, and the rate the
// unified adoption record quotes.
//
//   npm run report:memory-eval-succ4-rejections
//
// The record's §5 numbers are computed from `SUCC4_DRAFT_REJECTIONS`, not
// read out of five commit messages, so this is how a reader reproduces them.
// It is not a reviewer's disagreement rate -- no person has judged these
// drafts yet -- and the record says so where it quotes the figure.

import { MEMORY_EVAL_SUCC4_MANIFEST } from "../lib/memoryEvalSucc4Manifest.ts";
import {
    SUCC4_DRAFT_REJECTIONS,
    succ4DraftRejectionTally,
} from "../lib/memoryEvalSucc4DraftRejections.ts";

const { byTranche, total } = succ4DraftRejectionTally(
    MEMORY_EVAL_SUCC4_MANIFEST.composition.replacementTranches
);

console.log(
    `succ-4 replacement drafts rejected by the contract checks — ` +
        `${total.rejected} of ${total.cases} (${total.rate}%)\n`
);

for (const row of byTranche) {
    console.log(
        `## ${row.trancheId} — ${row.rejected}/${row.cases} (${row.rate}%)\n`
    );
    for (const rejection of SUCC4_DRAFT_REJECTIONS.filter(
        (entry) => entry.trancheId === row.trancheId
    )) {
        console.log(
            `   ${rejection.replacementId}  [${rejection.check}, recorded in the ${rejection.source}]`
        );
        console.log(`      ${rejection.detail}`);
    }
    console.log("");
}

const byCheck = new Map();
for (const rejection of SUCC4_DRAFT_REJECTIONS) {
    byCheck.set(rejection.check, (byCheck.get(rejection.check) ?? 0) + 1);
}
console.log("## By check\n");
for (const [check, count] of [...byCheck].sort()) {
    console.log(`   ${String(count).padStart(3)}  ${check}`);
}
