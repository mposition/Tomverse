// What the reading of `succ-4`'s 121 judgement golds settled, and what it did
// not.
//
//   npm run report:memory-eval-succ4-review
//
// Builds each reviewed gold as a schema-3 record and puts it through
// `goldEvidenceFailure()` — user role, message reference, span existence, and
// whether the quote actually contains the fact. That check is independent of
// the drafting tool's negation-marker scan and does not consult it: the scan
// proposes a polarity, the reviewer assigns one, and neither makes an anchor
// resolve.
//
// `agreedWithScan` is reported because a systematic gap between the scan and
// the reading is worth seeing. It is not a review outcome. A gold is reviewed
// because a person read it.

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { canonMatch } from "../lib/memoryEvalCanonicalisation.ts";
import { POLARITY_MARKERS } from "../lib/memoryEvalPolarityCalibration/distance.ts";
import { goldEvidenceFailure } from "../lib/memoryEvalDatasetSchemaV3.ts";
import {
    SUCC4_NEGATED,
    SUCC4_READINGS,
} from "../lib/memoryEvalSucc4Review/readings.ts";

const sentences = (text) =>
    text.split(/(?<=[.!?。？！])\s+/).map((part) => part.trim()).filter(Boolean);
const containsAll = (haystack, tokens, language) => {
    const canonical = canonMatch(haystack, language);
    return tokens.every((token) => canonical.includes(canonMatch(token, language)));
};

const negated = new Set(SUCC4_NEGATED);
const readingByKey = new Map(
    SUCC4_READINGS.map((reading) => [`${reading.caseId}:${reading.goldId}`, reading])
);

const rows = [];
for (const testCase of MEMORY_EVAL_SUCC3_CASES) {
    for (const gold of testCase.expected) {
        const key = `${testCase.id}:${gold.id}`;
        const messages = testCase.conversations.flatMap((c) => c.messages);
        const userMessages = messages.filter((m) => m.role === "user");
        const tokens = [...gold.mustInclude];
        const carriers = userMessages.filter((m) =>
            containsAll(m.content, tokens, testCase.language)
        );

        // The same proposal the drafting tool makes, rebuilt so the two agree
        // by construction rather than by a file passed between them.
        const review = [];
        if (carriers.length === 0) review.push("no_user_message_carries_the_fact");
        if (carriers.length > 1) review.push("several_user_messages_carry_it");
        if (gold.mustIncludeAny) review.push("polarity_was_in_mustIncludeAny");
        let proposedQuote = null;
        const message = carriers[0] ?? null;
        if (message) {
            const covering = sentences(message.content).filter((p) =>
                containsAll(p, tokens, testCase.language)
            );
            if (covering.length >= 1) {
                [proposedQuote] = covering;
                if (covering.length > 1) review.push("several_sentences_cover_it");
            } else {
                proposedQuote = message.content;
                review.push("fact_spans_sentences");
            }
        }
        let scanSays = "affirmed";
        if (proposedQuote) {
            const canonical = canonMatch(proposedQuote, testCase.language);
            const markers = POLARITY_MARKERS[testCase.language].filter((marker) =>
                canonical.includes(canonMatch(marker, testCase.language))
            );
            if (markers.length > 0) {
                review.push("marker_in_quote");
                scanSays = "negated";
            }
        }
        if (review.length === 0) continue;

        const reading = readingByKey.get(key);
        const polarity = reading?.polarity ?? (negated.has(key) ? "negated" : "affirmed");
        const built = {
            id: gold.id,
            kind: gold.kind,
            polarity,
            factValueAll: reading?.factValueAll ?? tokens,
            factValueAny: reading?.factValueAny,
            evidence: {
                evidenceMessageId:
                    reading?.evidenceMessageId ?? message?.externalMessageId ?? "",
                evidenceQuote: reading?.evidenceQuote ?? proposedQuote ?? "",
            },
            expectedDisposition: gold.expectedDisposition,
        };
        rows.push({
            key,
            language: testCase.language,
            category: testCase.category,
            review,
            polarity,
            scanSays,
            agreedWithScan: polarity === scanSays,
            hasReading: Boolean(reading),
            retokenised: Boolean(reading?.factValueAll || reading?.factValueAny),
            reanchored: Boolean(reading?.evidenceMessageId || reading?.evidenceQuote),
            failure: goldEvidenceFailure(
                built,
                testCase.conversations,
                testCase.language
            ),
            note: reading?.note ?? null,
        });
    }
}

const count = (values) =>
    values.reduce((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});
const show = (label, table) => {
    console.log(`## ${label}\n`);
    for (const [key, value] of Object.entries(table).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${String(value).padStart(3)}  ${key}`);
    }
    console.log();
};

console.log(`succ-4 review — ${rows.length} golds needed a reading\n`);
show("Polarity assigned", count(rows.map((r) => r.polarity)));
show(
    "goldEvidenceFailure",
    count(rows.map((r) => r.failure ?? "resolves"))
);
show(
    "Where the reading changed the drafted gold",
    count([
        ...rows.filter((r) => r.retokenised).map(() => "factValueAll or factValueAny rewritten"),
        ...rows.filter((r) => r.reanchored).map(() => "anchor moved"),
        ...rows.filter((r) => !r.hasReading).map(() => "polarity only"),
    ])
);

const disagreed = rows.filter((r) => !r.agreedWithScan);
console.log(
    `## Reading vs the marker scan\n\n   ${disagreed.length} of ${rows.length} disagree ` +
        `(${rows.length - disagreed.length} agree — reporting only, not a review outcome)\n`
);
for (const row of disagreed.slice(0, 12)) {
    console.log(`   ${row.key.padEnd(28)} scan ${row.scanSays.padEnd(8)} read ${row.polarity}`);
}
if (disagreed.length > 12) console.log(`   … and ${disagreed.length - 12} more`);
console.log();

const failing = rows.filter((r) => r.failure);
if (failing.length > 0) {
    console.log("## Golds whose anchor still does not resolve\n");
    for (const row of failing) {
        console.log(`   ${row.key.padEnd(28)} ${row.failure}`);
    }
    console.log();
}

console.log("## Golds the reading rewrote\n");
for (const row of rows.filter((r) => r.retokenised || r.reanchored)) {
    console.log(`   ${row.key}`);
    console.log(`      ${row.note?.replace(/\s+/g, " ").slice(0, 200)}`);
}
