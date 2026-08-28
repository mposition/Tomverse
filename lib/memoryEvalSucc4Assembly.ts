/**
 * Turning a reviewed `mem-eval-succ-3` case into a `mem-eval-succ-4` one.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12. Schema 3 is not
 * a migration: nothing here fills a blank, and every value a schema-3 gold
 * carries is one a person decided. What this module does is put those
 * decisions together with the conversation they belong to, and **refuse**
 * rather than guess when one is missing.
 *
 * ## Everything it refuses on
 *
 * A gold with no polarity, a gold whose `mustIncludeAny` has no recorded
 * decision, an anchor that cannot be found, an anchor that does not resolve.
 * Each throws by name. The alternative — a default, a skip, a best guess —
 * would produce a dataset that looks assembled and describes a review that did
 * not happen.
 *
 * ## The anchor proposal lives here
 *
 * `draft-memory-eval-succ4-golds.mjs` and the batch report were each carrying
 * their own copy of "find the user message holding the fact, then the sentence
 * of it that covers the tokens". Three copies of a rule is three chances for
 * the sheet a reviewer read to differ from the record their reading produced.
 * It is one function now and they import it.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import { canonMatch } from "@/lib/memoryEvalCanonicalisation";
import {
    goldEvidenceFailure,
    type EvidenceAnchor,
    type ExpectedMemoryV3,
    type MemoryEvalCaseV3,
    type MemoryEvalPolarity,
} from "@/lib/memoryEvalDatasetSchemaV3";
import {
    SUCC4_AFFIRMED,
    SUCC4_NEGATED,
    SUCC4_READINGS,
} from "@/lib/memoryEvalSucc4Review/readings";
import { SUCC4_BATCHES } from "@/lib/memoryEvalSucc4Review/batches";
import { SUCC4_FACT_VALUE_ANY } from "@/lib/memoryEvalSucc4Review/factValueAny";

export const goldKey = (caseId: string, goldId: string) => `${caseId}:${goldId}`;

/* ---------------------------------------------------------------- lookups -- */

const polarityByKey = new Map<string, MemoryEvalPolarity>();
for (const key of SUCC4_AFFIRMED) polarityByKey.set(key, "affirmed");
for (const key of SUCC4_NEGATED) polarityByKey.set(key, "negated");
for (const batch of SUCC4_BATCHES) {
    for (const gold of batch.golds) polarityByKey.set(gold.key, gold.polarity);
}

const readingByKey = new Map(
    SUCC4_READINGS.map((reading) => [goldKey(reading.caseId, reading.goldId), reading])
);
const factValueAnyByKey = new Map(
    SUCC4_FACT_VALUE_ANY.map((decision) => [decision.key, decision])
);

/* ------------------------------------------------------- anchor proposal -- */

/**
 * Terminal punctuation only.
 *
 * A cleverer splitter would be a grammar nobody reviewed. Where this gets the
 * span wrong, the reading overrides it — and the drafting tool reports the
 * case rather than letting it pass.
 */
export const sentencesOf = (text: string): string[] =>
    text
        .split(/(?<=[.!?。？！])\s+/)
        .map((part) => part.trim())
        .filter(Boolean);

export const containsAll = (
    haystack: string,
    tokens: readonly string[],
    language: "ko" | "en"
): boolean => {
    const canonical = canonMatch(haystack, language);
    return tokens.every((token) => canonical.includes(canonMatch(token, language)));
};

/** The user message and sentence a gold's fact is in, or `null`. */
export function proposeAnchor(
    testCase: MemoryEvalCaseV2,
    tokens: readonly string[]
): EvidenceAnchor | null {
    const language = testCase.language as "ko" | "en";
    const carrier = testCase.conversations
        .flatMap((conversation) => conversation.messages)
        .find(
            (message) =>
                message.role === "user" && containsAll(message.content, tokens, language)
        );
    if (!carrier) return null;
    const covering = sentencesOf(carrier.content).filter((part) =>
        containsAll(part, tokens, language)
    );
    return {
        evidenceMessageId: carrier.externalMessageId,
        evidenceQuote: covering[0] ?? carrier.content,
    };
}

/* -------------------------------------------------------------- assembly -- */

export class Succ4AssemblyError extends Error {}

const refuse = (key: string, what: string): never => {
    throw new Succ4AssemblyError(`${key}: ${what}`);
};

/** One schema-3 gold, or a refusal naming what nobody decided. */
export function assembleGold(
    testCase: MemoryEvalCaseV2,
    gold: MemoryEvalCaseV2["expected"][number]
): ExpectedMemoryV3 {
    const key = goldKey(testCase.id, gold.id);
    const reading = readingByKey.get(key);

    const polarity = reading?.polarity ?? polarityByKey.get(key);
    if (!polarity) refuse(key, "no polarity was recorded; nobody has read this gold");

    const factValueAll = reading?.factValueAll ?? [...gold.mustInclude];

    let factValueAny = reading?.factValueAny;
    if (!factValueAny && gold.mustIncludeAny) {
        const decision = factValueAnyByKey.get(key);
        if (!decision) {
            refuse(
                key,
                "carries mustIncludeAny and has no recorded decision. Under schema 3 " +
                    "that list either carried expression variants forward or hid the " +
                    "negation, and the two are not derivable from the label"
            );
        }
        factValueAny = "carryOver" in decision! ? decision!.carryOver : undefined;
    }

    const evidence =
        reading?.evidenceMessageId && reading?.evidenceQuote
            ? {
                  evidenceMessageId: reading.evidenceMessageId,
                  evidenceQuote: reading.evidenceQuote,
              }
            : proposeAnchor(testCase, factValueAll);
    if (!evidence) {
        refuse(key, "no user message carries every factValueAll token");
    }

    const built: ExpectedMemoryV3 = {
        id: gold.id,
        kind: gold.kind,
        polarity: polarity!,
        factValueAll,
        ...(factValueAny && factValueAny.length > 0 ? { factValueAny } : {}),
        evidence: evidence!,
        expectedDisposition: gold.expectedDisposition,
    };

    const failure = goldEvidenceFailure(
        built,
        testCase.conversations,
        testCase.language
    );
    if (failure) refuse(key, `anchor does not resolve: ${failure}`);
    return built;
}

/** One schema-3 case. Throws on the first gold nobody decided. */
export function assembleCase(testCase: MemoryEvalCaseV2): MemoryEvalCaseV3 {
    return {
        id: testCase.id,
        category: testCase.category,
        language: testCase.language,
        expected: testCase.expected.map((gold) => assembleGold(testCase, gold)),
        goldCompleteness: testCase.goldCompleteness,
        ...(testCase.sourceCaseId ? { sourceCaseId: testCase.sourceCaseId } : {}),
        ...(testCase.criticalGoldMode
            ? { criticalGoldMode: testCase.criticalGoldMode }
            : {}),
        conversations: testCase.conversations,
    };
}

/**
 * Assemble many, collecting refusals instead of stopping at the first.
 *
 * A run that stops on gold one sends the author round the loop once per
 * missing decision. `cases` is empty whenever `refusals` is not: a partial
 * dataset is the thing this module exists to not produce.
 */
export function assembleCases(cases: readonly MemoryEvalCaseV2[]): {
    cases: readonly MemoryEvalCaseV3[];
    refusals: readonly string[];
} {
    const built: MemoryEvalCaseV3[] = [];
    const refusals: string[] = [];
    for (const testCase of cases) {
        try {
            built.push(assembleCase(testCase));
        } catch (error) {
            refusals.push(
                error instanceof Succ4AssemblyError ? error.message : String(error)
            );
        }
    }
    return refusals.length > 0
        ? { cases: [], refusals }
        : { cases: built, refusals: [] };
}
