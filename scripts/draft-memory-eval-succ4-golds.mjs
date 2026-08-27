// Draft `mem-eval-succ-4`'s schema-3 golds from succ-3, and say what it cannot
// decide.
//
//   npm run draft:memory-eval-succ4-golds
//   npm run draft:memory-eval-succ4-golds -- --json out.json
//
// **This writes no dataset.** Schema 3 is not a migration
// (`lib/memoryEvalDatasetSchemaV3.ts`): nothing here fills a blank or upgrades
// a case, and a succ-4 gold carries every value because a person put it there.
// What this does is the part that is not judgement -- find the user message a
// gold's fact is actually in, propose the span, and hand back everything it
// could not settle, so review time goes to the golds that need it.
//
// The proposal is deliberately weak in one place. Polarity is *proposed* by
// scanning the quote for a negation marker, which is the rule the calibration
// corpus disqualified from scoring (§9.2, §9.4). It is here to route
// attention, not to answer: `MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE` decides,
// and it decides against a reading of the quote. "I always take the aisle
// seat, no exceptions" carries a marker and is affirmed.

import { writeFileSync } from "node:fs";

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { canonMatch } from "../lib/memoryEvalCanonicalisation.ts";
import { POLARITY_MARKERS } from "../lib/memoryEvalPolarityCalibration/distance.ts";

const jsonAt = process.argv.indexOf("--json");
const jsonPath = jsonAt >= 0 ? process.argv[jsonAt + 1] : null;

// Terminal punctuation only. A cleverer splitter would be a grammar nobody
// reviewed, and the cases where it gets the span wrong are reported rather
// than guessed at.
const sentences = (text) =>
    text
        .split(/(?<=[.!?。？！])\s+/)
        .map((part) => part.trim())
        .filter(Boolean);

const containsAll = (haystack, tokens, language) => {
    const canonical = canonMatch(haystack, language);
    return tokens.every((token) => canonical.includes(canonMatch(token, language)));
};

const drafts = [];

for (const testCase of MEMORY_EVAL_SUCC3_CASES) {
    if (testCase.expected.length === 0) continue;
    const messages = testCase.conversations.flatMap((c) => c.messages);
    const userMessages = messages.filter((message) => message.role === "user");

    for (const gold of testCase.expected) {
        const tokens = [...gold.mustInclude];
        const carriers = userMessages.filter((message) =>
            containsAll(message.content, tokens, testCase.language)
        );
        const review = [];

        // The gold's fact is in no user message at all. Either the tokens are
        // spread across turns -- one anchor cannot cover them, so the gold has
        // to be rewritten -- or the token was written in an inflection the
        // canonical form does not reach, which is what §1③ asks golds to avoid
        // by writing the canonical form in the first place.
        if (carriers.length === 0) review.push("no_user_message_carries_the_fact");
        if (carriers.length > 1) review.push("several_user_messages_carry_it");

        // Polarity was hiding in this disjunction under schema 2, invented per
        // case. Every one of these needs re-reading: the alternatives usually
        // become a polarity and disappear.
        if (gold.mustIncludeAny) review.push("polarity_was_in_mustIncludeAny");

        const message = carriers[0] ?? null;
        let quote = null;
        if (message) {
            const covering = sentences(message.content).filter((part) =>
                containsAll(part, tokens, testCase.language)
            );
            if (covering.length === 1) {
                [quote] = covering;
            } else if (covering.length > 1) {
                [quote] = covering;
                review.push("several_sentences_cover_it");
            } else {
                quote = message.content;
                review.push("fact_spans_sentences");
            }
        }

        if (quote) {
            const canonical = canonMatch(quote, testCase.language);
            const markers = POLARITY_MARKERS[testCase.language].filter((marker) =>
                canonical.includes(canonMatch(marker, testCase.language))
            );
            if (markers.length > 0) review.push(`marker_in_quote:${markers.join("|")}`);
        }

        drafts.push({
            caseId: testCase.id,
            category: testCase.category,
            language: testCase.language,
            goldId: gold.id,
            kind: gold.kind,
            factValueAll: tokens,
            mustIncludeAny: gold.mustIncludeAny ? [...gold.mustIncludeAny] : null,
            expectedDisposition: gold.expectedDisposition,
            proposedEvidenceMessageId: message?.externalMessageId ?? null,
            proposedEvidenceQuote: quote,
            review,
        });
    }
}

if (jsonPath) {
    writeFileSync(
        jsonPath,
        JSON.stringify(
            drafts.map((draft) => ({
                ...draft,
                messages: MEMORY_EVAL_SUCC3_CASES.find(
                    (testCase) => testCase.id === draft.caseId
                ).conversations.flatMap((c) => c.messages),
            })),
            null,
            1
        )
    );
}

const needsReview = drafts.filter((draft) => draft.review.length > 0);
const tally = {};
for (const draft of needsReview) {
    for (const reason of draft.review) {
        const key = reason.split(":")[0];
        tally[key] = (tally[key] ?? 0) + 1;
    }
}

console.log(
    `${drafts.length} golds in ${MEMORY_EVAL_SUCC3_CASES.filter((c) => c.expected.length > 0).length} cases\n`
);
console.log(`${needsReview.length} need a reading; ${drafts.length - needsReview.length} have an unambiguous anchor\n`);
for (const [reason, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(3)}  ${reason}`);
}
console.log(
    "\nEvery gold still needs its polarity read off the quote " +
        "(MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE). An unambiguous anchor means the " +
        "span was found, not that the label is settled."
);
if (jsonPath) console.log(`\nWrote ${jsonPath}`);
