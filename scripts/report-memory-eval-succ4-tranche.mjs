// The replacement tranche, checked against the contract that moved its
// originals.
//
//   npm run report:memory-eval-succ4-tranche
//
// Nothing here is wired into a registry: succ-4 is assembled once all 103
// replacements exist. This checks each one the way the assembler will, plus
// the two things a replacement can get wrong that an original could not —
// citing an id that already exists, and being the original with the nouns
// swapped.

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { goldEvidenceFailure } from "../lib/memoryEvalDatasetSchemaV3.ts";
import { canonMatch } from "../lib/memoryEvalCanonicalisation.ts";
import { SUCC4_B_PLUS_MOVES } from "../lib/memoryEvalSucc4Review/bPlusMoves.ts";
import { SUCC4_TRANCHE_1 } from "../lib/memoryEvalSucc4Replacements/tranche1.ts";

const originals = new Map(MEMORY_EVAL_SUCC3_CASES.map((c) => [c.id, c]));
const moving = new Map(SUCC4_B_PLUS_MOVES.map((m) => [m.originalId, m]));
const existingCaseIds = new Set(MEMORY_EVAL_SUCC3_CASES.map((c) => c.id));
const existingConversationIds = new Set(
    MEMORY_EVAL_SUCC3_CASES.flatMap((c) =>
        c.conversations.map((v) => v.externalConversationId)
    )
);

/**
 * Token overlap between two conversations, as a fraction of the smaller.
 *
 * English splits on spaces; Korean has none left after canonMatch, and
 * splitting it into single characters then dropping anything shorter than two
 * left an empty set — the check reported 0.00 for every Korean pair and was
 * measuring nothing. Korean uses character bigrams instead.
 */
const similarity = (a, b, language) => {
    const words = (testCase) => {
        const text = canonMatch(
            testCase.conversations.flatMap((v) => v.messages.map((m) => m.content)).join(" "),
            language
        );
        if (language !== "ko") {
            return new Set(text.split(" ").filter((token) => token.length > 1));
        }
        const bigrams = new Set();
        for (let at = 0; at + 2 <= text.length; at += 1) bigrams.add(text.slice(at, at + 2));
        return bigrams;
    };
    const left = words(a);
    const right = words(b);
    const shared = [...left].filter((token) => right.has(token)).length;
    return shared / Math.max(1, Math.min(left.size, right.size));
};

let failures = 0;
const say = (line) => {
    console.log(line);
};

console.log(`succ-4 replacement tranche 1 — ${SUCC4_TRANCHE_1.length} cases\n`);

for (const entry of SUCC4_TRANCHE_1) {
    const original = originals.get(entry.originalId);
    const move = moving.get(entry.originalId);
    const built = entry.replacement;
    const problems = [];

    if (!original) problems.push("names an original that is not a succ-3 case");
    if (!move) problems.push("names an original that is not in the move list");
    if (existingCaseIds.has(built.id)) problems.push(`case id ${built.id} already exists`);
    for (const conversation of built.conversations) {
        if (existingConversationIds.has(conversation.externalConversationId)) {
            problems.push(`conversation id ${conversation.externalConversationId} already exists`);
        }
    }
    if (original) {
        if (built.category !== original.category || built.language !== original.language) {
            problems.push("changes the cell, so the floor it was replacing is not refilled");
        }
        if (built.expected.length !== original.expected.length) {
            problems.push(
                `${original.expected.length} golds became ${built.expected.length}; the shape is part of what it replaces`
            );
        }
        if (built.goldCompleteness !== original.goldCompleteness) {
            problems.push("changes goldCompleteness");
        }
        if ((built.criticalGoldMode ?? null) !== (original.criticalGoldMode ?? null)) {
            problems.push("changes criticalGoldMode");
        }
    }
    for (const gold of built.expected) {
        const failure = goldEvidenceFailure(gold, built.conversations, built.language);
        if (failure) problems.push(`${gold.id}: ${failure}`);
        const message = built.conversations
            .flatMap((v) => v.messages)
            .find((m) => m.externalMessageId === gold.evidence.evidenceMessageId);
        if (message && message.role !== "user") problems.push(`${gold.id}: anchor is not a user turn`);
        const original2 = originals.get(entry.originalId);
        if (original2) {
            const sameDisposition = original2.expected.some(
                (g) => g.expectedDisposition === gold.expectedDisposition
            );
            if (!sameDisposition) {
                problems.push(
                    `${gold.id}: expectedDisposition ${gold.expectedDisposition} is in neither original gold`
                );
            }
        }
    }
    const overlap = original ? similarity(built, original, built.language) : 0;
    if (overlap > 0.45) {
        problems.push(`reads as the original with the nouns swapped (overlap ${overlap.toFixed(2)})`);
    }
    if (!entry.settledByExistingContract) {
        problems.push("was not settled by the existing contract — stop and raise it");
    }

    say(`## ${entry.originalId} → ${built.id}  [${built.category}:${built.language}]`);
    say(`   moved because: ${entry.movedBecause.replace(/\s+/g, " ")}`);
    say(`   boundary kept: ${entry.boundary.replace(/\s+/g, " ")}`);
    say(`   differs by:    ${entry.differsBy.replace(/\s+/g, " ")}`);
    for (const gold of built.expected) {
        say(
            `   gold ${gold.id}: kind=${gold.kind} polarity=${gold.polarity} disposition=${gold.expectedDisposition}`
        );
        say(
            `      factValueAll=${JSON.stringify(gold.factValueAll)}` +
                (gold.factValueAny ? ` factValueAny=${JSON.stringify(gold.factValueAny)}` : "")
        );
        say(`      anchor ${gold.evidence.evidenceMessageId} «${gold.evidence.evidenceQuote}»`);
    }
    say(`   overlap with the original: ${overlap.toFixed(2)} (cap 0.45)`);
    say(`   settled by the existing contract: ${entry.settledByExistingContract ? "yes" : "NO"}`);
    if (problems.length > 0) {
        failures += problems.length;
        for (const problem of problems) say(`   PROBLEM  ${problem}`);
    }
    say("");
}

const covered = new Set(SUCC4_TRANCHE_1.map((entry) => entry.originalId));
console.log(`## Coverage\n\n   ${covered.size} originals replaced, of 103 moving`);
console.log(`   ${moving.size - covered.size} still to write\n`);

if (failures > 0) {
    console.error(`${failures} problem(s).`);
    process.exit(1);
}
console.log("No problems.");
