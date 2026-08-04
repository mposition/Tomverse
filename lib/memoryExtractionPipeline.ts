/**
 * The offline extraction pipeline (Release B, slice 1.5).
 *
 * chunk → prompt → [injected adapter] → parse → normalize → validate →
 * a decision per candidate. Pure apart from the adapter the caller supplies,
 * and **nothing here persists or activates anything**: the result describes
 * what would be stored, so the storage contract and the financial contract
 * can land together in the slice that first calls a real provider.
 *
 * The adapter seam is the whole point. This module never imports an AI SDK,
 * so no code path from here reaches a provider — a reviewer can establish
 * that by reading the imports rather than by tracing calls, and a test can
 * assert it (tests/memoryExtractionOfflineBoundary.test.mjs).
 *
 * Order matters and is fixed here: the model's classification is advisory and
 * is re-decided by the deterministic validator (§8.4), which sees the *stored*
 * evidence roles rather than anything the model asserted about them. A model
 * that labels its own guess as user-supported therefore still loses.
 */

import {
    toExtractionPromptInput,
    type ExtractionPrompt,
    type ExtractionSourceConversationInput,
} from "@/lib/memoryExtractionPrompt";
import {
    decodeExtractionText,
    parseExtractionOutput,
    type ExtractionParseProblem,
    type ParsedExtractionCandidate,
} from "@/lib/memoryExtractionOutput";
import {
    validateMemoryCandidate,
    type MemoryValidationResult,
} from "@/lib/memoryValidatorCore";

/**
 * What a provider call looks like from here. 1.6 supplies a real one; tests
 * supply a fake. Returning `unknown` covers both a structured-output object
 * and a raw text answer.
 */
export type ExtractionModelAdapter = (input: {
    prompt: ExtractionPrompt;
}) => Promise<{ output: unknown } | { text: string }>;

export type ExtractionDecision = {
    candidate: ParsedExtractionCandidate;
    validation: MemoryValidationResult;
    /**
     * What the storage step in a later slice would do. `rejected` candidates
     * are never stored at all — a credential or an injection payload does not
     * become safer by being kept for review (§8.4).
     */
    outcome: "store_candidate" | "store_for_individual_review" | "discard";
};

export type ExtractionChunkAnalysis = {
    promptVersion: string;
    decisions: ExtractionDecision[];
    problems: ExtractionParseProblem[];
    /** Content-free counters for §22 metrics. */
    counts: {
        parsed: number;
        stored: number;
        individualReview: number;
        discarded: number;
    };
};

const outcomeFor = (
    validation: MemoryValidationResult
): ExtractionDecision["outcome"] => {
    if (validation.disposition === "accepted") return "store_candidate";
    if (validation.disposition === "rejected") return "discard";
    // manual_review_required and sensitive_review_required both mean the same
    // thing downstream: it may be stored, but only a human may activate it,
    // and it is never part of a bulk approval.
    return "store_for_individual_review";
};

/**
 * Runs one chunk through the pipeline. Never throws for a bad answer: an
 * adapter that fails is the caller's error to handle, but an adapter that
 * returns nonsense is an ordinary result with zero decisions and a problem
 * list.
 */
export async function analyzeExtractionChunk(input: {
    conversations: readonly ExtractionSourceConversationInput[];
    adapter: ExtractionModelAdapter;
    now?: Date;
}): Promise<ExtractionChunkAnalysis> {
    const { prompt, labels } = toExtractionPromptInput(input.conversations);
    const answer = await input.adapter({ prompt });
    const raw =
        "text" in answer ? decodeExtractionText(answer.text) : answer.output;

    const parsed = parseExtractionOutput(raw, labels);
    const decisions = parsed.candidates.map((candidate): ExtractionDecision => {
        const validation = validateMemoryCandidate(
            {
                kind: candidate.kind,
                statement: candidate.statement,
                confidence: candidate.confidence,
                sensitivity: candidate.sensitivity,
                expiresAt: candidate.expiresAt,
                // Roles come from the label map — the server's own record of
                // which stored message a label stood for — so a model cannot
                // dress an assistant turn up as user evidence.
                evidence: candidate.evidence.map((ref) => ({
                    sourceType: "external_message" as const,
                    role: ref.role,
                })),
            },
            input.now ?? new Date()
        );
        return { candidate, validation, outcome: outcomeFor(validation) };
    });

    return {
        promptVersion: prompt.promptVersion,
        decisions,
        problems: parsed.problems,
        counts: {
            parsed: parsed.candidates.length,
            stored: decisions.filter((d) => d.outcome === "store_candidate")
                .length,
            individualReview: decisions.filter(
                (d) => d.outcome === "store_for_individual_review"
            ).length,
            discarded: decisions.filter((d) => d.outcome === "discard").length,
        },
    };
}
