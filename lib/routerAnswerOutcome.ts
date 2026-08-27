/**
 * What came back from one arm, and whether a person could have read it.
 *
 * ## Why this is not `result.text ?? ""`
 *
 * The 2026-08-27 pilot generated 210 pairs and excluded none, and 62 of the
 * answer slots in its bundle held no text at all. Nothing stopped them: the
 * only content gate was the self-identification rule, an empty string names no
 * model, and so empty answers went to the judge. A judge shown an empty answer
 * against a real one picks the real one every time, which means part of that
 * run's -54.76pp was "the model returned nothing" wearing the clothes of "the
 * model answered worse". The bundle writer allowed what the bundle reader
 * refuses, and the run was voided for it.
 *
 * So an answer is a typed outcome rather than a string. A caller cannot read
 * `.text` off a failure, and the reason, the arm, the model, the finish reason
 * and the usage travel with it — because the same empty slot means two very
 * different things depending on whether the provider sent nothing or sent
 * something this code failed to read.
 *
 * ## Excluding an empty answer would be worse than counting it
 *
 * mposition's ruling, and it is the point of the whole file: an empty response
 * is a real failure for the person who asked. Dropping those pairs would hand
 * an advantage to whichever arm fails less gracefully — the arm that returns
 * nothing would have its worst turns deleted from the comparison. So a
 * single-arm generation failure is a deterministic loss for that arm in the
 * end-to-end estimate, and only the pairs where both arms answered are graded
 * on quality. lib/routerQualityEvalCore.ts keeps the two apart.
 */

/**
 * Why an arm produced nothing usable.
 *
 * `empty_output` is the provider answering with no text. `provider_error` is
 * the call failing. They are kept apart because only the first is the model's
 * behaviour: a run where one arm errors is a run with an outage in it, and a
 * run where one arm answers emptily is a measurement of that arm.
 */
export const ANSWER_FAILURE_REASONS = ["empty_output", "provider_error"] as const;
export type AnswerFailureReason = (typeof ANSWER_FAILURE_REASONS)[number];

/**
 * What the call did, kept whether it succeeded or not.
 *
 * `rawTextLength` and `finishReason` are here for one specific case: a
 * provider that did return text this code failed to read is an instrumentation
 * defect, not a model failure, and the two are indistinguishable from an empty
 * string alone. A failure whose raw response was non-empty is a bug in the
 * adapter and has to be readable as such afterwards.
 */
export type AnswerMetadata = {
    /**
     * Which call this was. `judge` is not an arm and never scores, but a judge
     * call fails the same ways and its failures belong in the same journal.
     */
    arm: "auto" | "baseline" | "judge";
    modelId: string;
    provider: string;
    apiModel: string;
    /** The provider's own finish reason, verbatim, or null when it sent none. */
    finishReason: string | null;
    usage: Readonly<Record<string, number>>;
    latencyMs: number;
    /** Length of the text before trimming. Non-zero on a failure means this code lost it. */
    rawTextLength: number;
};

export type AnswerOutcome =
    | { status: "ok"; text: string; metadata: AnswerMetadata }
    | {
          status: "failed";
          reason: AnswerFailureReason;
          detail: string;
          metadata: AnswerMetadata;
      };

/**
 * The text a person would have seen, or `null` if there was none.
 *
 * `trim()` and nothing cleverer. A reply of spaces and newlines is not an
 * answer, and treating it as one is how the empty slots got past the first
 * time.
 */
export const displayableText = (raw: string | null | undefined): string | null => {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
};

/**
 * Whether a stored answer can be graded.
 *
 * The one predicate both sides use: the pilot decides with it whether a pair
 * reaches the judge and the bundle, and `answerBundleProblems` decides with it
 * whether a stored bundle can be re-judged. They disagreed once and it cost a
 * 91-minute run.
 */
export const isUsableAnswerText = (raw: string | null | undefined): boolean =>
    displayableText(raw) !== null;

export const ok = (text: string, metadata: AnswerMetadata): AnswerOutcome => ({
    status: "ok",
    text,
    metadata,
});

export const failed = (
    reason: AnswerFailureReason,
    detail: string,
    metadata: AnswerMetadata
): AnswerOutcome => ({ status: "failed", reason, detail, metadata });

/**
 * Turn a provider reply into an outcome.
 *
 * Called with whatever the SDK returned; the emptiness decision lives here so
 * no caller has to remember to make it.
 */
export const outcomeFromReply = (
    reply: { text?: string | null; finishReason?: string | null; usage?: Record<string, number> },
    metadata: Omit<AnswerMetadata, "finishReason" | "usage" | "rawTextLength">
): AnswerOutcome => {
    const raw = typeof reply.text === "string" ? reply.text : "";
    const full: AnswerMetadata = {
        ...metadata,
        finishReason: reply.finishReason ?? null,
        usage: reply.usage ?? {},
        rawTextLength: raw.length,
    };
    const text = displayableText(raw);
    if (text === null) {
        return failed(
            "empty_output",
            raw.length === 0
                ? "the provider returned no text"
                : `the provider returned ${raw.length} character(s) of whitespace and nothing else`,
            full
        );
    }
    return ok(text, full);
};

/** One line for the failure journal. Everything a root cause would need. */
export const failureRecord = (outcome: Extract<AnswerOutcome, { status: "failed" }>) => ({
    kind: "answer-failure" as const,
    arm: outcome.metadata.arm,
    reason: outcome.reason,
    detail: outcome.detail,
    modelId: outcome.metadata.modelId,
    provider: outcome.metadata.provider,
    apiModel: outcome.metadata.apiModel,
    finishReason: outcome.metadata.finishReason,
    usage: outcome.metadata.usage,
    latencyMs: outcome.metadata.latencyMs,
    rawTextLength: outcome.metadata.rawTextLength,
    // The one that separates a model failure from a defect in this code.
    lostByThisCode: outcome.reason === "empty_output" && outcome.metadata.rawTextLength > 0,
});
