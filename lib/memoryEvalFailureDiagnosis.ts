/**
 * What a failing eval run's failures are *shaped* like, before anybody decides
 * why.
 *
 * ## The question this answers, and the one it refuses to
 *
 * `gpt-5-6-luna::mem-extract-v6` run 1 missed every
 * docs/policy/external-conversation-import-and-memory.md §12.3 floor and
 * adopted 41 candidates in critical cells against a gate of zero
 * (.github/audits/memory-eval-v6-succ5-run1-2026-08-29.md). Four things could
 * produce that, and they need different work: a prompt defect, a scoring
 * taxonomy the prompt and the gold read differently, a defect in the gold, and
 * the model simply being wrong.
 *
 * **This module does not decide which.** It computes the observations that
 * separate them and groups the failures by those observations, so the person
 * making the call reads evidence rather than a verdict. The distinction is not
 * pedantry: the first draft of that audit called one adoption an
 * "assistant→user transfer" from the cell's *name* without opening the
 * conversation, and the conversation showed the user had said it themselves.
 * A tool that guesses causes would have written that mistake 41 times.
 *
 * ## The observations, and why each one separates something
 *
 * * **the role of the cited message.** v6 binds every candidate to a quote
 *   from a real message, so the run can be asked whose words it was. An
 *   adoption quoting an assistant turn is a transfer defect; one quoting the
 *   user's own turn is not, whatever cell it sits in.
 * * **where in the conversation the quote sits.** A quote from an opening turn
 *   is the user stating something; a quote from a later user turn, after an
 *   assistant reply, is usually a correction, a retraction or the resolution
 *   of a hypothetical — and whether those are memories at all is a policy
 *   question, not a model error.
 * * **whether the gold expected anything at all.** A case whose gold is empty
 *   says "store nothing here", so every candidate is unmatched by
 *   construction, and the disagreement is about the boundary rather than about
 *   accuracy.
 * * **whether a missed gold entry was seen but relabelled.** If some candidate
 *   quotes the same message the gold cites, the fact was found and named
 *   differently; that is a taxonomy question. If nothing cites it, the model
 *   did not produce it at all.
 *
 * Nothing here reads a threshold, and nothing here writes: the scoring stays
 * `lib/memoryEvalScoringV3.ts`'s, the verdict stays the harness's, and
 * approval stays a human act recorded in the register.
 */

import { candidateMatchesGoldV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    candidateEvidenceBound,
    unadmittedCriticalBulkSafeCandidatesV3,
    type ScoredCandidateV3,
} from "@/lib/memoryEvalScoringV3";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/** The role of the message a candidate quoted, as the dataset records it. */
export type CitedRole = "user" | "assistant" | "mixed" | "none";

/** One candidate the gold did not recognise, with what can be observed of it. */
export type UnrecognisedCandidate = {
    caseId: string;
    category: string;
    language: string;
    kind: string;
    polarity: string;
    statement: string;
    bulkSafe: boolean;
    /** Whether this one counts against the §12.3 zero-adoption gate. */
    critical: boolean;
    citedRole: CitedRole;
    /**
     * Zero-based position of the earliest quoted message in its conversation.
     *
     * `0` is the opening turn. Anything higher means the quote came after at
     * least one earlier message, which is where corrections and resolved
     * hypotheticals live.
     */
    earliestCitedTurn: number | null;
    /** True when the case's gold is empty: "store nothing from this one". */
    goldExpectsNothing: boolean;
    /**
     * True when this candidate quotes a message some gold entry also cites.
     *
     * It still went unmatched, so the disagreement is over the label rather
     * than over what was read — the same fact, named differently. A candidate
     * with this false quoted a message no gold entry names at all.
     */
    quotesGoldMessage: boolean;
    quotes: readonly string[];
};

/** One gold entry the run did not match, with what can be observed of it. */
export type UnmatchedGold = {
    caseId: string;
    category: string;
    language: string;
    kind: string;
    polarity: string;
    /**
     * How the run failed to match it.
     *
     * `relabelled` — some candidate quotes the same message, so the fact was
     * found and named differently. `silent` — the run produced no candidate at
     * all for this case. `elsewhere` — candidates exist but none quotes this
     * gold entry's message.
     */
    shape: "relabelled" | "silent" | "elsewhere";
    /** On `relabelled`, what the run called it instead. Empty otherwise. */
    relabelledAs: readonly { kind: string; polarity: string }[];
};

export type RunDiagnosis = {
    unrecognisedCandidates: readonly UnrecognisedCandidate[];
    unmatchedGold: readonly UnmatchedGold[];
};

/* --------------------------------------------------------------- inputs -- */

/**
 * The dataset's own case type, not a structural stand-in.
 *
 * A looser local type would let this module be handed something the scorer
 * could not score, and the scorer is what it now calls.
 */
type DiagnosisCase = MemoryEvalCaseV3;

type DiagnosisRecord = {
    caseId: string;
    category: string;
    language: string;
    candidates: readonly {
        kind: string;
        polarity: string;
        statement: string;
        bulkSafe: boolean;
        disposition?: string;
        evidence?: readonly { evidenceMessageId: string; evidenceQuote: string }[];
    }[];
    outcome: { criticalBulkSafeAdoptions: number };
};

/**
 * Where each message sits: its role, and its index within its conversation.
 *
 * Built per case rather than globally because message ids are only unique
 * inside a case, and a global map would silently answer with another case's
 * message.
 */
const messageIndex = (
    kase: DiagnosisCase
): Map<string, { role: string; turn: number }> => {
    const index = new Map<string, { role: string; turn: number }>();
    for (const conversation of kase.conversations) {
        conversation.messages.forEach((message, turn) => {
            index.set(message.externalMessageId, { role: message.role, turn });
        });
    }
    return index;
};

const citedRoleOf = (roles: readonly string[]): CitedRole => {
    if (roles.length === 0) return "none";
    const distinct = new Set(roles);
    if (distinct.size > 1) return "mixed";
    return distinct.has("user") ? "user" : "assistant";
};

/**
 * Group a run's failures by what can be observed about them.
 *
 * `criticalCategories` names the cells whose zero-adoption gate the run is
 * measured against; it is passed in rather than hard-coded so this module does
 * not become a second place where "which cells are critical" is decided.
 */
export function diagnoseRun(input: {
    records: readonly DiagnosisRecord[];
    cases: readonly DiagnosisCase[];
    criticalCategories: readonly string[];
}): RunDiagnosis {
    const caseById = new Map(input.cases.map((kase) => [kase.id, kase]));
    const critical = new Set(input.criticalCategories);
    const unrecognisedCandidates: UnrecognisedCandidate[] = [];
    const unmatchedGold: UnmatchedGold[] = [];

    for (const record of input.records) {
        const kase = caseById.get(record.caseId);
        if (!kase) continue;
        const index = messageIndex(kase);
        const messages = kase.conversations.flatMap(
            (conversation) => conversation.messages
        );
        const gold = kase.expected ?? [];
        const goldMessages = new Set(
            gold.map((entry) => entry.evidence?.evidenceMessageId).filter(Boolean)
        );
        const goldExpectsNothing = gold.length === 0;

        // Which candidates went unrecognised, and which count against the
        // zero gate, are the scorer's questions — asked here by calling the
        // scorer rather than by restating it.
        //
        // Two drafts of this module restated it and got it wrong twice: first
        // by treating "quotes a message gold cites" as recognised, which hid
        // 10 of the run's 41 critical adoptions, then by filtering on
        // `disposition` when the gate counts every bulk-safe candidate no
        // bulk-safe gold admitted, one for one. A diagnosis that under-reports
        // the number it is diagnosing is worse than no diagnosis, and the
        // second place a rule lives is where the two drift apart.
        const scored = record.candidates as readonly ScoredCandidateV3[];
        const bound = scored.map((candidate) =>
            candidateEvidenceBound(candidate, messages)
        );
        const gateCounted = new Set(
            unadmittedCriticalBulkSafeCandidatesV3(kase, scored, bound)
        );
        const claimed = new Set<number>();
        for (const entry of gold) {
            const position = scored.findIndex(
                (candidate, index) =>
                    !claimed.has(index) &&
                    bound[index] === true &&
                    candidateMatchesGoldV3(
                        entry,
                        candidate,
                        kase.language
                    )
            );
            if (position >= 0) claimed.add(position);
        }

        for (const [position, candidate] of scored.entries()) {
            if (claimed.has(position)) continue;
            const cited = [
                ...new Set((candidate.evidence ?? []).map((e) => e.evidenceMessageId)),
            ];
            const turns = cited
                .map((id) => index.get(id)?.turn)
                .filter((turn): turn is number => turn !== undefined);
            unrecognisedCandidates.push({
                caseId: record.caseId,
                category: record.category,
                language: record.language,
                kind: candidate.kind,
                polarity: candidate.polarity,
                statement: candidate.statement,
                bulkSafe: candidate.bulkSafe,
                critical: critical.has(record.category) && gateCounted.has(candidate),
                citedRole: citedRoleOf(
                    cited
                        .map((id) => index.get(id)?.role)
                        .filter((role): role is string => role !== undefined)
                ),
                earliestCitedTurn: turns.length > 0 ? Math.min(...turns) : null,
                goldExpectsNothing,
                quotesGoldMessage: cited.some((id) => goldMessages.has(id)),
                quotes: (candidate.evidence ?? []).map((e) => e.evidenceQuote),
            });
        }

        // A gold entry the run did not produce, and the shape of not producing
        // it. Matched by the scorer's own predicate, for the reason above.
        for (const entry of gold) {
            const message = entry.evidence?.evidenceMessageId;
            const sameMessage = record.candidates.filter((candidate) =>
                (candidate.evidence ?? []).some((e) => e.evidenceMessageId === message)
            );
            const matched = scored.some(
                (candidate, index) =>
                    bound[index] === true &&
                    candidateMatchesGoldV3(
                        entry,
                        candidate,
                        kase.language
                    )
            );
            if (matched) continue;
            unmatchedGold.push({
                caseId: record.caseId,
                category: record.category,
                language: record.language,
                kind: entry.kind,
                polarity: entry.polarity,
                shape:
                    record.candidates.length === 0
                        ? "silent"
                        : sameMessage.length > 0
                          ? "relabelled"
                          : "elsewhere",
                relabelledAs: sameMessage.map((candidate) => ({
                    kind: candidate.kind,
                    polarity: candidate.polarity,
                })),
            });
        }
    }

    return { unrecognisedCandidates, unmatchedGold };
}

/** Counts by an arbitrary key, most frequent first, for a report to print. */
export function tally<T>(
    rows: readonly T[],
    key: (row: T) => string
): readonly { key: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    return [...counts]
        .map(([k, count]) => ({ key: k, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
