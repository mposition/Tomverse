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
// Exits non-zero on two conditions, both claims rather than gaps: a row that
// calls itself proven without what a notice would print, and a row of any
// status that says something it cannot mean -- a storage alias that drifted
// from storage, a location mode with no locations, an answer with no
// reference. Both would be read by the Privacy page and the routing gate.

import {
    PROVIDER_DATA_DESTINATIONS,
    RETENTION_COMPONENTS,
    destinationShapeProblems,
    provenDestinationProblems,
} from "../lib/providerDataDestinations.ts";

const rows = [...PROVIDER_DATA_DESTINATIONS].sort((left, right) =>
    left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0
);

const proven = rows.filter((row) => row.status === "proven");
const unproven = rows.filter((row) => row.status !== "proven");

const invalid = rows.flatMap((row) =>
    [...provenDestinationProblems(row), ...destinationShapeProblems(row)].map(
        (problem) => `${row.provider}: ${problem}`
    )
);

// How much of what a notice needs has been reviewed, one question at a time.
// A provider can be half-way, and the total hides which half.
const reviewed = (predicate) => rows.filter(predicate).length;
const coverage = [
    ["recipient entity", reviewed((row) => row.recipientEntity !== null), rows.length],
    ["recipient country", reviewed((row) => row.recipientCountryCodes.length > 0), rows.length],
    ["storage geography", reviewed((row) => row.customerContentStorage.mode !== "UNKNOWN"), rows.length],
    ["processing geography", reviewed((row) => row.processing.mode !== "UNKNOWN"), rows.length],
    ["training", reviewed((row) => row.trainsOnCustomerContent.value !== null), rows.length],
    [
        "retention (all five kinds)",
        reviewed((row) =>
            RETENTION_COMPONENTS.every((component) => row.retention[component].behavior !== "UNKNOWN")
        ),
        rows.length,
    ],
    [
        "independent commercial use",
        reviewed((row) => row.independentCommercialUseProhibited.value !== null),
        rows.length,
    ],
    ["zero data retention (strict only)", reviewed((row) => row.zeroDataRetention.mode !== "UNKNOWN"), rows.length],
];

console.log("");
console.log("Provider data destinations");
console.log("--------------------------");
console.log(
    `${rows.length} provider(s) enrolled; ${proven.length} proven, ${unproven.length} unproven.`
);
console.log("");

for (const row of rows) {
    if (row.status === "proven") {
        const places = (geography) =>
            [geography.mode, ...geography.countryCodes, ...geography.macroRegions].join(" ");
        console.log(
            `  proven    ${row.provider.padEnd(12)} ${row.recipientEntity} — stored: ${places(row.customerContentStorage)}; processed: ${places(row.processing)}  [${row.evidenceRef}]`
        );
        continue;
    }
    console.log(`  unproven  ${row.provider}`);
}

console.log("");
console.log("Reviewed, question by question:");
for (const [label, count, total] of coverage) {
    console.log(`  ${label.padEnd(36)} ${count} of ${total}`);
}

console.log("");
console.log(
    `May serve a residency-constrained request: ${proven.length} of ${rows.length}.`
);

if (unproven.length > 0) {
    console.log("");
    console.log(
        "An unproven provider is not a defect. It is a provider whose terms have not\n" +
            "been read and confirmed to answer what a notice prints: who receives the\n" +
            "data, where it is stored and processed, training, retention and onward use.\n" +
            "Another service's published policy for the same endpoint does not answer it;\n" +
            "that describes the other service's own agreement.\n" +
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
