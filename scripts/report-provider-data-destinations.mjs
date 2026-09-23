// Where each provider takes personal data, and whether we can say so.
//
// A report, not a gate. Every active provider is `unproven` today, so a gate
// would refuse the whole catalogue on its first run and be switched off the
// same afternoon -- the position `report:model-credit-weights` is in, and for
// the same reason: the difference between what is recorded and what is true is
// a thing to look at before it is a thing to enforce.
//
// It becomes a gate when the owner's contract review has supplied destinations
// to hold. Until then the number worth watching is how many providers can
// serve a request that carries a residency constraint, and today it is zero.
//
// Exits non-zero on exactly one condition: a row that calls itself proven
// without the evidence that makes it so. That is not a coverage gap, it is a
// claim the file is not entitled to make, and it would be read by both the
// Privacy page and the routing gate.

import { PROVIDER_DATA_DESTINATIONS, provenDestinationProblems } from "../lib/providerDataDestinations.ts";

const rows = [...PROVIDER_DATA_DESTINATIONS].sort((left, right) =>
    left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0
);

const proven = rows.filter((row) => row.status === "proven");
const unproven = rows.filter((row) => row.status !== "proven");

const invalid = rows.flatMap((row) =>
    provenDestinationProblems(row).map((problem) => `${row.provider}: ${problem}`)
);

console.log("");
console.log("Provider data destinations");
console.log("--------------------------");
console.log(
    `${rows.length} provider(s) enrolled; ${proven.length} proven, ${unproven.length} unproven.`
);
console.log("");

for (const row of rows) {
    if (row.status === "proven") {
        console.log(
            `  proven    ${row.provider.padEnd(12)} ${row.recipientEntity} — ${row.destinationRegions.join(", ")}  [${row.evidenceRef}]`
        );
        continue;
    }
    console.log(`  unproven  ${row.provider}`);
}

console.log("");
console.log(
    `May serve a residency-constrained request: ${proven.length} of ${rows.length}.`
);

if (unproven.length > 0) {
    console.log("");
    console.log(
        "An unproven provider is not a defect. It is a provider whose contract has not\n" +
            "been read and confirmed to name a recipient entity and a processing region.\n" +
            "Until it is, it carries no residency-constrained traffic, and the Privacy\n" +
            "page prints nothing about it -- a table whose every row says \"not\n" +
            "established\" is the same absence as today's sentence, only louder."
    );
}

if (invalid.length > 0) {
    console.error("");
    console.error("A row claims a destination it cannot show:");
    for (const problem of invalid) console.error(`  - ${problem}`);
    console.error("");
    console.error(
        "Both the Privacy page and the routing residency gate read these rows. A\n" +
            "destination somebody was fairly sure about is the failure this file exists\n" +
            "to prevent: data sent overseas on an assumption does not come back."
    );
    process.exit(1);
}

console.log("");
