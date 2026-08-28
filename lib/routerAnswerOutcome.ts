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
 * `rawTextLength`, `finishReason` and `usage` are here so an empty answer can
 * be classified afterwards. A provider that did return text this code failed
 * to read is an instrumentation defect rather than a model failure, and the
 * two are indistinguishable from an empty string alone. See
 * `classifyEmptiness`.
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
    /** Length of the text before trimming, as this code received it. */
    rawTextLength: number;
    /**
     * The provider's own id for the response, when it sent one.
     *
     * The handle for asking the provider what it actually returned. An
     * emptiness this run cannot classify is reported with it, because that is
     * the question it leaves open.
     */
    traceId: string | null;
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
 * What is actually known about an empty answer, in a sentence.
 *
 * Worded to the classification rather than to the empty string, so a journal
 * line never says "the provider returned no text" about a case where nobody
 * established that.
 */
export const emptinessDetail = (metadata: AnswerMetadata): string => {
    const generated = generatedTokens(metadata.usage);
    switch (classifyEmptiness(metadata)) {
        case "harness_lost_text":
            return metadata.rawTextLength > 0
                ? `the reply held ${metadata.rawTextLength} character(s) of whitespace and nothing else, ` +
                      "so normalising it left this harness with no text"
                : `the provider reports generating ${generated} output token(s) and this harness holds ` +
                      "none of the text, so it was lost before it was read";
        case "provider_confirmed_empty":
            return `the provider finished with finishReason=${metadata.finishReason} and reports ` +
                "generating 0 output tokens, so it produced nothing";
        default:
            return (
                "no text reached this harness and nothing establishes whether the provider sent any" +
                (metadata.finishReason === null ? "; it reported no finish reason" : "") +
                (generated === null ? "; it reported no output token count" : "")
            );
    }
};

/**
 * Turn a provider reply into an outcome.
 *
 * Called with whatever the SDK returned; the emptiness decision lives here so
 * no caller has to remember to make it.
 */
export const outcomeFromReply = (
    reply: {
        text?: string | null;
        finishReason?: string | null;
        usage?: Record<string, number>;
        traceId?: string | null;
    },
    metadata: Omit<AnswerMetadata, "finishReason" | "usage" | "rawTextLength" | "traceId">
): AnswerOutcome => {
    const raw = typeof reply.text === "string" ? reply.text : "";
    const full: AnswerMetadata = {
        ...metadata,
        finishReason: reply.finishReason ?? null,
        usage: reply.usage ?? {},
        rawTextLength: raw.length,
        traceId: reply.traceId ?? null,
    };
    const text = displayableText(raw);
    if (text === null) return failed("empty_output", emptinessDetail(full), full);
    return ok(text, full);
};

/**
 * Where an empty answer went empty.
 *
 * ## Why `rawTextLength === 0` is not "the model returned nothing"
 *
 * mposition's correction, and it is the reason this is three values rather
 * than a boolean. An empty string at this point in the code says only that
 * *this code* holds no text. It does not say the provider sent none: the text
 * may have been dropped anywhere upstream — in the adapter, in a stream that
 * ended early, in a response shape this code reads the wrong field of. Calling
 * that a model failure would file our own defects under the model's name, and
 * an evaluation that does so measures the harness while reporting on the
 * model.
 *
 * So the classification says how far back the emptiness is actually known to
 * reach, and one of the three is an admission that we do not know:
 *
 *   * `harness_lost_text` — content demonstrably existed and this code holds
 *     none of it. Either the raw text was non-empty and normalisation blanked
 *     it, or the provider billed for output tokens we cannot show. Our defect,
 *     and it voids the run.
 *   * `observed_empty_at_adapter_boundary` — blank from the adapter boundary
 *     onward, with nothing establishing whether the provider sent text. The
 *     honest default. It is a real failure the user would have seen, and its
 *     cause is open.
 *   * `provider_confirmed_empty` — the provider's own response says it
 *     produced nothing: it finished, and it reports generating zero output
 *     tokens. Only this one is the model's behaviour.
 */
export const EMPTINESS_CLASSIFICATIONS = [
    "harness_lost_text",
    "observed_empty_at_adapter_boundary",
    "provider_confirmed_empty",
] as const;
export type EmptinessClassification = (typeof EMPTINESS_CLASSIFICATIONS)[number];

/**
 * Output tokens the provider says it generated, or `null` when it said nothing.
 *
 * The distinction matters more than the number: a provider that reports no
 * usage at all cannot confirm anything, so the absence has to survive as
 * `null` rather than collapse to 0 and be read as "it generated nothing".
 * Spellings differ across SDKs and none of them is canonical here.
 */
export const generatedTokens = (usage: Readonly<Record<string, number>>): number | null => {
    for (const key of ["outputTokens", "completionTokens", "output_tokens", "completion_tokens"]) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
};

/**
 * How far back an empty answer's emptiness is established. Never a guess:
 * where nothing establishes it, it says so.
 */
export const classifyEmptiness = (metadata: AnswerMetadata): EmptinessClassification => {
    // Text arrived and normalisation is why none is left. Ours.
    if (metadata.rawTextLength > 0) return "harness_lost_text";
    const generated = generatedTokens(metadata.usage);
    // The provider generated output and this code holds none of it. Also ours,
    // and the case a raw-length check alone cannot see: the text was lost
    // before it ever reached `rawTextLength`.
    if (generated !== null && generated > 0) return "harness_lost_text";
    // The provider finished and accounts for zero output tokens. Only with
    // both does its response actually confirm it produced nothing.
    if (generated === 0 && metadata.finishReason !== null) return "provider_confirmed_empty";
    return "observed_empty_at_adapter_boundary";
};

/**
 * One line for the failure journal. Everything a root cause would need.
 *
 * `lostByThisCode` is the gate's field: a run with any of them is measuring
 * this harness rather than the models, and
 * .github/workflows/router-eval-pilot.yml refuses to spend on the independent
 * judge when it is non-zero.
 */
export const failureRecord = (outcome: Extract<AnswerOutcome, { status: "failed" }>) => {
    const emptiness =
        outcome.reason === "empty_output" ? classifyEmptiness(outcome.metadata) : null;
    return {
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
        traceId: outcome.metadata.traceId,
        emptiness,
        // Our defect, not the model's. Never inferred from an empty string
        // alone -- see classifyEmptiness.
        lostByThisCode: emptiness === "harness_lost_text",
    };
};
