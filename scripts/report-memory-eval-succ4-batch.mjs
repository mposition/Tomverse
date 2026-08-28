// One succ-4 review batch, verified against the source fixtures.
//
//   npm run report:memory-eval-succ4-batch -- succ4-b01
//   npm run report:memory-eval-succ4-batch            # every batch
//
// Reports what the review conditions ask for and nothing it cannot show:
// counts split by case and by gold, the polarity tally with unresolved counted
// separately, each gold's quote and fact beside its label, goldEvidenceFailure,
// and where the reading parted from the marker scan.
//
// The two independent checks are the point:
//
//   * `goldEvidenceFailure()` proves the anchor names a user message, that the
//     quote is a real span of it, and that the quote contains the fact. It
//     proves nothing about the polarity, and this report says so rather than
//     letting "all resolve" read as "all correct".
//   * the key-set comparison proves the batch covers the slice of the cell it
//     claims, with nothing missing and nothing twice. Keys are generated from
//     the fixtures on both sides, so a hand-copied identifier cannot agree with
//     itself.

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { canonMatch } from "../lib/memoryEvalCanonicalisation.ts";
import { POLARITY_MARKERS } from "../lib/memoryEvalPolarityCalibration/distance.ts";
import { goldEvidenceFailure } from "../lib/memoryEvalDatasetSchemaV3.ts";
import { SUCC4_BATCHES } from "../lib/memoryEvalSucc4Review/batches.ts";
import {
    SUCC4_AFFIRMED,
    SUCC4_NEGATED,
} from "../lib/memoryEvalSucc4Review/readings.ts";

const wanted = process.argv[2] ?? null;
const alreadyRead = new Set([...SUCC4_AFFIRMED, ...SUCC4_NEGATED]);

const sentences = (text) =>
    text.split(/(?<=[.!?。？！])\s+/).map((part) => part.trim()).filter(Boolean);
const containsAll = (haystack, tokens, language) => {
    const canonical = canonMatch(haystack, language);
    return tokens.every((token) => canonical.includes(canonMatch(token, language)));
};

/** Every unreviewed gold of a cell, keyed from the fixtures, in key order. */
const cellSlice = (cell) => {
    const [category, language] = cell.split(":");
    const rows = [];
    for (const testCase of MEMORY_EVAL_SUCC3_CASES) {
        if (testCase.category !== category || testCase.language !== language) continue;
        const messages = testCase.conversations.flatMap((c) => c.messages);
        for (const gold of testCase.expected) {
            const key = `${testCase.id}:${gold.id}`;
            if (alreadyRead.has(key)) continue;
            const tokens = [...gold.mustInclude];
            const carrier = messages.find(
                (message) =>
                    message.role === "user" &&
                    containsAll(message.content, tokens, language)
            );
            const covering = carrier
                ? sentences(carrier.content).filter((part) =>
                      containsAll(part, tokens, language)
                  )
                : [];
            const quote = covering[0] ?? carrier?.content ?? null;
            const canonical = quote ? canonMatch(quote, language) : "";
            rows.push({
                key,
                testCase,
                gold,
                tokens,
                language,
                messageId: carrier?.externalMessageId ?? null,
                quote,
                scanSays: POLARITY_MARKERS[language].some((marker) =>
                    canonical.includes(canonMatch(marker, language))
                )
                    ? "negated"
                    : "affirmed",
            });
        }
    }
    return rows.sort((a, b) => (a.key < b.key ? -1 : 1));
};

let exitCode = 0;

for (const batch of SUCC4_BATCHES) {
    if (wanted && batch.id !== wanted) continue;
    const slice = cellSlice(batch.cell);
    const expected = slice.slice(batch.from, batch.from + batch.golds.length);
    const byKey = new Map(slice.map((row) => [row.key, row]));

    const sourceKeys = expected.map((row) => row.key);
    const reviewKeys = batch.golds.map((gold) => gold.key);
    const missing = sourceKeys.filter((key) => !reviewKeys.includes(key));
    const extra = reviewKeys.filter((key) => !sourceKeys.includes(key));
    const duplicated = reviewKeys.filter(
        (key, index) => reviewKeys.indexOf(key) !== index
    );

    console.log(`# ${batch.id} — ${batch.cell}, offset ${batch.from}\n`);
    console.log(
        `## Counts\n\n   ${new Set(expected.map((r) => r.testCase.id)).size} cases, ` +
            `${batch.golds.length} golds\n   ${slice.length} unreviewed golds remain ` +
            `in this cell before the batch\n`
    );

    const tally = { affirmed: 0, negated: 0, unresolved: 0 };
    for (const gold of batch.golds) {
        tally[gold.polarity === "affirmed" || gold.polarity === "negated" ? gold.polarity : "unresolved"] += 1;
    }
    tally.unresolved += missing.length;
    console.log(
        `## Polarity\n\n   ${tally.affirmed} affirmed\n   ${tally.negated} negated\n` +
            `   ${tally.unresolved} unresolved\n`
    );

    console.log("## Each gold\n");
    const failures = [];
    const disagreements = [];
    for (const gold of batch.golds) {
        const row = byKey.get(gold.key);
        if (!row) {
            console.log(`   ${gold.key}  NOT IN THIS CELL'S UNREVIEWED SET`);
            exitCode = 1;
            continue;
        }
        const built = {
            id: row.gold.id,
            kind: row.gold.kind,
            polarity: gold.polarity,
            factValueAll: row.tokens,
            evidence: {
                evidenceMessageId: row.messageId ?? "",
                evidenceQuote: row.quote ?? "",
            },
            expectedDisposition: row.gold.expectedDisposition,
        };
        const failure = goldEvidenceFailure(
            built,
            row.testCase.conversations,
            row.language
        );
        if (failure) failures.push({ key: gold.key, failure });
        if (gold.polarity !== row.scanSays) {
            disagreements.push({ key: gold.key, scan: row.scanSays, read: gold.polarity });
        }
        console.log(
            `   ${gold.key.padEnd(24)} ${gold.polarity.padEnd(9)} ${JSON.stringify(row.tokens)}`
        );
        console.log(`      «${row.quote}»`);
    }
    console.log();

    console.log("## goldEvidenceFailure\n");
    console.log(
        failures.length === 0
            ? `   ${batch.golds.length} resolve — anchor names a user message, quote is an\n` +
                  "   exact span of it, quote contains the fact. Not a check on polarity.\n"
            : failures.map((f) => `   ${f.key}  ${f.failure}`).join("\n") + "\n"
    );
    if (failures.length > 0) exitCode = 1;

    console.log(
        `## Reading vs the marker scan\n\n   ${disagreements.length} of ${batch.golds.length} disagree\n`
    );
    for (const row of disagreements) {
        console.log(`   ${row.key.padEnd(24)} scan ${row.scan.padEnd(9)} read ${row.read}`);
    }
    console.log();

    console.log("## Key sets\n");
    console.log(`   source ${sourceKeys.length}, review ${reviewKeys.length}`);
    console.log(`   missing ${missing.length}${missing.length ? `: ${missing.join(", ")}` : ""}`);
    console.log(`   extra ${extra.length}${extra.length ? `: ${extra.join(", ")}` : ""}`);
    console.log(
        `   duplicated ${duplicated.length}${duplicated.length ? `: ${duplicated.join(", ")}` : ""}\n`
    );
    if (missing.length || extra.length || duplicated.length) exitCode = 1;
}

process.exit(exitCode);
