/**
 * Schema 3: what a `mem-eval-succ-4` case is.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md`, approved
 * 2026-08-27. Schema 2 stays exactly where it is — `mem-eval-succ-2` and
 * `mem-eval-succ-3` were authored and scored under it, and this is a third
 * schema for the same reason schema 2 was a second one rather than optional
 * fields on schema 1: a frozen dataset must not *look* loadable by a scorer
 * that would have to guess at values it never carried.
 *
 * ## What changed, and why it is not a widening
 *
 * Two facts become required on every expected memory:
 *
 *   * `polarity` — whether the fact is asserted or denied. Under schema 2 this
 *     hid inside `mustIncludeAny`, invented per case, which is where
 *     `한양대에 다닌 적 없` came from: a string only its author would write.
 *   * `evidence` — which user message the fact came from, and the exact span
 *     of it. Under schema 2 there was nothing to check a candidate's
 *     provenance against, and v5-run1 stored 13 assistant utterances as user
 *     facts with no scoring consequence at all.
 *
 * Reading either as a default would fail in the dangerous direction:
 * `affirmed` by default turns every unlabelled denial into its opposite, and
 * an absent evidence requirement credits exactly the adoptions §10.2 exists to
 * refuse. There is no default anywhere in this module.
 *
 * ## Polarity is compared, not inferred
 *
 * §9.3. The first design read polarity out of the candidate's own sentence
 * with a negation-marker proximity rule. Measured on the corpus built for it,
 * English admitted no threshold and Korean admitted exactly one value with no
 * margin (§9.2), so the rule was dropped from scoring: v6's output carries a
 * `polarity` field and the scorer compares two fields. Nothing in this module
 * reads a polarity out of prose, and no proximity constant exists in the
 * contract.
 */

import type { MemoryEvalCategory, MemoryEvalLanguage } from "@/lib/memoryExtractionEvalCore";
import {
    MEMORY_EVAL_EXPECTED_DISPOSITIONS,
    MEMORY_EVAL_GOLD_COMPLETENESS,
    type MemoryEvalExpectedDisposition,
    type MemoryEvalGoldCompleteness,
} from "@/lib/memoryEvalDatasetSchema";
import { canonMatch } from "@/lib/memoryEvalCanonicalisation";

/** The schema this module defines. */
export const MEMORY_EVAL_DATASET_SCHEMA_V3_VERSION = 3;

/**
 * Whether the memory asserts the fact or denies it.
 *
 * **`affirmed` / `negated`, never `positive` / `negative`.** In memory
 * extraction a *negative fact* (the user dislikes something) and a *negated
 * fact* (the user does not have something) are different things, and a field
 * name that cannot separate them lets the gold author and the prompt author
 * mean different things by the same word.
 */
export const MEMORY_EVAL_POLARITIES = ["affirmed", "negated"] as const;

export type MemoryEvalPolarity = (typeof MEMORY_EVAL_POLARITIES)[number];

/** What each value means, in the digest so the meaning cannot drift silently. */
export const MEMORY_EVAL_POLARITY_MEANINGS: Readonly<
    Record<MemoryEvalPolarity, string>
> = {
    affirmed:
        "The memory asserts the fact of the user: the fact holds. Not a claim " +
        "about the fact being pleasant, positive or desirable.",
    negated:
        "The memory asserts that the fact does NOT hold of the user. Not a " +
        "claim about the fact being unpleasant, negative or undesirable.",
};

/**
 * Where a fact came from, in a form a machine can check.
 *
 * The field names are shared with v6's output schema on purpose (§1④). If the
 * gold side and the output side named these differently, the scorer would
 * transcribe one into the other to compare them, and that transcription would
 * be a second copy of the contract.
 */
export type EvidenceAnchor = {
    /**
     * The message, by the `externalMessageId` the case itself declares.
     *
     * **Not an integer index.** `mem-score-v3` froze this as
     * `evidenceMessageIndex: number` and authoring `succ-4` showed that to be
     * wrong: the extraction pipeline already has a stable message reference
     * and speaks it end to end. `toExtractionPromptInput()` labels each
     * message `m1`, `m2`, … by position, the model cites those labels, and
     * `parseExtractionOutput()` resolves each label back to the row's
     * `externalMessageId` — refusing any label the chunk did not issue, so an
     * invented citation resolves to nothing.
     *
     * A gold naming a position would have made the scorer translate between
     * two spellings of the same fact, and that translation is the second copy
     * of the contract §1④ exists to prevent. Amended in `mem-score-v3.1`.
     */
    evidenceMessageId: string;
    /** An exact substring of that message's content. */
    evidenceQuote: string;
};

/**
 * The checks evidence must pass, named so the digest carries them.
 *
 * Ids are referenced by `MEMORY_EVAL_SCORING_RULES` and by the failure
 * reasons, so a rule and the code that enforces it cannot drift apart under
 * different names.
 */
export const MEMORY_EVAL_EVIDENCE_RULES: readonly {
    id: string;
    statement: string;
}[] = [
    {
        id: "evidence-message-exists",
        statement:
            "evidenceMessageId must name a message the case actually presents, by the " +
            "externalMessageId the case declares. A name the conversation does not carry " +
            "is a refusal, never a miss.",
    },
    {
        id: "evidence-role-user",
        statement:
            "The addressed message's role must be user. An assistant message is never " +
            "evidence for a fact about the user, whichever way the assistant phrased it.",
    },
    {
        id: "evidence-quote-exact",
        statement:
            "evidenceQuote must occur in that message's content as an exact substring, " +
            "compared byte for byte after NFC normalisation and nothing else. It is not " +
            "canonicalised: a quote is a claim about what was written.",
    },
    {
        id: "gold-evidence-covers-fact",
        statement:
            "A gold's own evidenceQuote must contain every factValueAll token, under the " +
            "language's canonical matching form. An anchor naming the right message and " +
            "quoting a span the fact is not in cites a source for something else, and no " +
            "later check would notice. This binds gold authoring only: a candidate's quote " +
            "is the model's claim about where it read the fact, and judging it against the " +
            "gold's tokens would score the citation instead of the extraction.",
    },
    {
        id: "evidence-mismatch-refuses-adoption",
        statement:
            "A candidate failing any of the three above is not credited with the adoption, " +
            "whatever its statement says. An extraction that cannot cite its source and one " +
            "that cites a source it invented score the same.",
    },
];

/**
 * How a gold's polarity is decided, and what that demands of `factValueAll`.
 *
 * Added in `mem-score-v3.2`, from authoring `succ-4`: with the field declared
 * and nothing saying what it is a field *about*, a hundred golds had two
 * defensible answers each.
 *
 * The rule is one question asked of the anchor quote:
 *
 *   > Does the memory assert `factValueAll` **of the user**, or assert that it
 *   > is not so of them?
 *
 * `affirmed` for the first, `negated` for the second. Worked:
 *
 *   | quote                                   | factValueAll          | polarity |
 *   |-----------------------------------------|-----------------------|----------|
 *   | I'm not teetotal.                       | `teetotal`            | negated  |
 *   | There's no printer here.                | `printer`             | negated  |
 *   | 저는 한양대를 다닌 적 없습니다.          | `한양대`               | negated  |
 *   | I'm allergic to penicillin.             | `allerg`, `penicillin`| affirmed |
 *   | I always take the aisle seat, no        | `aisle`               | affirmed |
 *   | exceptions.                             |                       |          |
 *
 * The last row is why a marker in the quote decides nothing: `no exceptions`
 * belongs to the frequency, not to the seat.
 *
 * ## The demand this places on factValueAll
 *
 * A polarity is only well defined against something specific enough to be
 * denied. `["drive"]` fails that where the conversation is about not driving:
 * *the user cannot drive* and *the user drives* contain the same token, so the
 * gold is matched by a candidate asserting its opposite and the field it was
 * given changes nothing.
 *
 * The bar is deliberately narrow, because a bar every gold fails is a bar
 * nobody applies. It is asked **where the opposite reading is live in that
 * conversation** — the quote denies the topic, or the exchange is about
 * whether it holds:
 *
 *   > Could a memory of the opposite polarity, drawn from **this**
 *   > conversation, contain every factValueAll token? If it could, the list
 *   > names a topic where it should name a predicate.
 *
 * `["견과류"]` fails it in a conversation correcting an assumed nut allergy,
 * and becomes `["견과류", "알레르기"]`. It passes untouched in a conversation
 * where the user states the allergy and nothing contests it.
 *
 * This is what §2.1's stem registry is for: `allerg` covers allergic and
 * allergy, and writing one inflection instead is how `succ-3` lost golds.
 */
export const MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE =
    "A gold's polarity answers one question of its anchor quote: does the memory " +
    "assert factValueAll of the user, or assert that it is not so of them? affirmed " +
    "for the first, negated for the second. A negation marker elsewhere in the quote " +
    "decides nothing. Where the opposite reading is live in that conversation -- the " +
    "quote denies the topic, or the exchange is about whether it holds -- factValueAll " +
    "must name the predicate rather than the topic: if a memory of the opposite " +
    "polarity drawn from the same conversation could contain every token, the gold is " +
    "under-specified and the field it was given changes nothing.";

/** One thing a schema-3 case expects. */
export type ExpectedMemoryV3 = {
    id: string;
    /** Matched exactly against the candidate's kind. Unchanged from schema 2. */
    kind: string;
    /** Asserted or denied. Compared field to field against the candidate's own. */
    polarity: MemoryEvalPolarity;
    /** Canonicalised fact values, all of which must be present (AND). */
    factValueAll: readonly string[];
    /** Expression alternatives, one of which suffices (OR). Absent imposes nothing. */
    factValueAny?: readonly string[];
    /** Machine-checkable provenance. Required. */
    evidence: EvidenceAnchor;
    expectedDisposition: MemoryEvalExpectedDisposition;
};

/** The conversation shape, unchanged from schema 2 — this schema relabels. */
export type MemoryEvalConversation = {
    externalConversationId: string;
    title: string;
    messages: readonly {
        externalMessageId: string;
        role: "user" | "assistant";
        content: string;
    }[];
};

export type MemoryEvalCaseV3 = {
    id: string;
    category: MemoryEvalCategory;
    language: MemoryEvalLanguage;
    expected: readonly ExpectedMemoryV3[];
    goldCompleteness: MemoryEvalGoldCompleteness;
    /** The schema-2 case this one relabels, when it is not a new conversation. */
    sourceCaseId?: string;
    criticalGoldMode?: "allow_expected_only";
    conversations: readonly MemoryEvalConversation[];
};

/**
 * The field names a schema-3 expected memory must carry.
 *
 * Written out rather than derived from the type, because the type is erased at
 * runtime and the digest needs the list. `tests/memoryEvalScoringContractDigest.test.mjs`
 * holds it against a sample record so the two cannot drift.
 */
export const MEMORY_EVAL_V3_REQUIRED_EXPECTED_FIELDS: readonly string[] = [
    "id",
    "kind",
    "polarity",
    "factValueAll",
    "evidence",
    "expectedDisposition",
];

/** Optional by design, and named so that "optional" is a recorded decision. */
export const MEMORY_EVAL_V3_OPTIONAL_EXPECTED_FIELDS: readonly string[] = [
    "factValueAny",
];

export type EvidenceFailure = (typeof MEMORY_EVAL_EVIDENCE_RULES)[number]["id"];

/**
 * Whether an evidence anchor resolves against the conversation it claims.
 *
 * Returns the failed rule's id, or `null` when all three pass. Used by gold
 * authoring (a gold whose evidence does not resolve is rejected at review) and
 * by scoring (a candidate whose evidence does not resolve is not credited) —
 * one function, because two would be two contracts.
 */
export function evidenceFailure(
    anchor: EvidenceAnchor,
    messages: readonly {
        externalMessageId: string;
        role: "user" | "assistant";
        content: string;
    }[]
): EvidenceFailure | null {
    const message = messages.find(
        (candidate) => candidate.externalMessageId === anchor.evidenceMessageId
    );
    if (!message) return "evidence-message-exists";
    if (message.role !== "user") return "evidence-role-user";
    // NFC only. Canonicalising here would let a quote that was never written
    // resolve against one that was, which is the opposite of what a quote is.
    const content = message.content.normalize("NFC");
    const quote = anchor.evidenceQuote.normalize("NFC");
    if (quote.length === 0 || !content.includes(quote)) {
        return "evidence-quote-exact";
    }
    return null;
}

/**
 * Whether a gold's own anchor is admissible, at authoring and review time.
 *
 * Everything `evidenceFailure()` asks of a candidate, plus
 * `gold-evidence-covers-fact`: the quote has to contain the fact the gold is
 * about. Applied to golds only — see that rule's statement for why a
 * candidate's quote is not held to the same test.
 */
export function goldEvidenceFailure(
    gold: ExpectedMemoryV3,
    conversations: readonly MemoryEvalConversation[],
    language: MemoryEvalLanguage
): EvidenceFailure | "gold-evidence-covers-fact" | null {
    const messages = conversations.flatMap((conversation) => conversation.messages);
    const failure = evidenceFailure(gold.evidence, messages);
    if (failure) return failure;
    const quote = canonMatch(gold.evidence.evidenceQuote, language);
    const covered = gold.factValueAll.every((token) =>
        quote.includes(canonMatch(token, language))
    );
    return covered ? null : "gold-evidence-covers-fact";
}

/**
 * Whether a candidate matches a gold, under schema 3.
 *
 * Kind exactly, polarity exactly, every `factValueAll` present, and — when the
 * gold states them — at least one `factValueAny`. Evidence is checked
 * separately by `evidenceFailure()`: a candidate can match a gold's content
 * and still fail to cite it, and the two failures are worth telling apart.
 */
export function candidateMatchesGoldV3(
    gold: ExpectedMemoryV3,
    candidate: { kind: string; polarity: string; statement: string },
    language: MemoryEvalLanguage
): boolean {
    if (candidate.kind !== gold.kind) return false;
    if (candidate.polarity !== gold.polarity) return false;
    const statement = canonMatch(candidate.statement, language);
    const has = (token: string) => statement.includes(canonMatch(token, language));
    if (!gold.factValueAll.every(has)) return false;
    if (gold.factValueAny && gold.factValueAny.length > 0) {
        return gold.factValueAny.some(has);
    }
    return true;
}

/** Re-exported so schema 3 does not fork values schema 2 already settled. */
export {
    MEMORY_EVAL_EXPECTED_DISPOSITIONS,
    MEMORY_EVAL_GOLD_COMPLETENESS,
};
