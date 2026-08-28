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
    /** What this call asked for, from the frozen manifest. */
    requestedMaxOutputTokens: number | null;
    /**
     * What the product would have asked for on this model.
     *
     * The condition that decides whether a budget this call ran out of was
     * this harness's choice: a request that already asked for the product's
     * cap did not come up short because the harness was stingy.
     */
    resolvedProductOutputCap: number | null;
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
 * Worded to the evidence rather than to the empty string. The earlier version
 * of this said "the provider returned no text" about cases where nobody had
 * established that, and later "N answers existed and this code holds none of
 * them" about answers that were never written. Both named a cause the data did
 * not carry.
 */
export const emptinessDetail = (metadata: AnswerMetadata): string => {
    const { reason, evidence } = classifyEmptiness(metadata);
    switch (reason) {
        case "text_normalization_loss":
            return (
                `the reply held ${metadata.rawTextLength} character(s) of whitespace and nothing ` +
                "else, so normalising it left this harness with no text"
            );
        case "output_budget_exhausted":
            return (
                `the request asked for ${evidence.requestedMaxOutputTokens} output token(s) against ` +
                `the product's ${evidence.resolvedProductOutputCap}, and the provider stopped at the ` +
                `output limit having billed ${evidence.billedOutputTokens}, so the budget was spent ` +
                "before any answer text was written"
            );
        case "provider_confirmed_empty":
            return (
                `the provider finished with finishReason=${metadata.finishReason} and reports ` +
                "billing 0 output tokens, so it produced nothing"
            );
        default:
            return (
                "no text reached this harness after normalization, and the finish reason and usage " +
                "do not establish why" +
                (evidence.normalizedFinishReason === null ? "; it reported no finish reason" : "") +
                (evidence.billedOutputTokens === null ? "; it reported no output token count" : "")
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
 * An empty answer, taken apart into three questions instead of one label.
 *
 * ## Why three axes rather than a longer list
 *
 * mposition's ruling. The first version of this file had one enum, and the
 * moment reality was inspected it wanted a fourth value, then a fifth. A list
 * that grows every time it meets a new case is a list answering several
 * questions at once. There are three, and they are independent:
 *
 *   * the **symptom** is what was observed. Here it is always the same thing:
 *     after normalisation there was no text.
 *   * the **reason** is the mechanism, where one is established.
 *   * the **attribution** is whose defect it is. It does not follow from the
 *     reason alone and must never be inferred past the evidence.
 *
 * `undetermined` is a first-class value in both of the last two, and it is the
 * default. A run that cannot tell why an answer was empty says so rather than
 * picking the likeliest story.
 *
 * ## What this cost before it existed
 *
 * The 2026-08-28 pilot returned 60 empty answers, every one on the auto arm.
 * The harness had asked every model for 2,048 output tokens while the product
 * asks 128,000-384,000 for the same models, and reasoning tokens are billed
 * out of that same budget -- so a reasoning model could spend the whole
 * allowance thinking and return no answer at all. The old enum called that
 * `harness_lost_text`, which named the right culprit for the wrong reason: no
 * text was lost, none was ever written.
 */
export const EMPTY_TEXT_SYMPTOM = "empty_text" as const;

export const EMPTINESS_REASONS = [
    /** Content arrived, and normalising it left nothing. */
    "text_normalization_loss",
    /** The output budget was spent before any answer text was written. */
    "output_budget_exhausted",
    /** The provider's own response accounts for having produced nothing. */
    "provider_confirmed_empty",
    "undetermined",
] as const;
export type EmptinessReason = (typeof EMPTINESS_REASONS)[number];

export const FAILURE_ATTRIBUTIONS = ["harness", "provider", "model", "undetermined"] as const;
export type FailureAttribution = (typeof FAILURE_ATTRIBUTIONS)[number];

/**
 * Finish reasons, in one spelling.
 *
 * Providers spell the same event `length`, `max_tokens`, `MAX_TOKENS`. The
 * budget rule turns on this value, so it cannot be a substring match against
 * whatever spelling a provider happened to send.
 */
export const normalizeFinishReason = (raw: string | null): string | null => {
    if (raw === null) return null;
    const value = raw.trim().toLowerCase();
    if (value === "") return null;
    if (["length", "max_tokens", "max_output_tokens", "output_limit"].includes(value)) {
        return "output_limit";
    }
    return value;
};

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
 * How close to the cap counts as having reached it.
 *
 * A provider stops on a token boundary rather than on our arithmetic, so the
 * billed count lands a little under the ceiling. Wide enough to allow that,
 * narrow enough that a model which merely wrote a long answer does not
 * qualify.
 */
export const BUDGET_EXHAUSTION_RATIO = 0.95;

export type EmptinessClassification = {
    symptom: typeof EMPTY_TEXT_SYMPTOM;
    reason: EmptinessReason;
    attribution: FailureAttribution;
    /** Every condition the rule tested, so a reader can see which one failed. */
    evidence: {
        visibleTextLength: number;
        normalizedFinishReason: string | null;
        billedOutputTokens: number | null;
        requestedMaxOutputTokens: number | null;
        resolvedProductOutputCap: number | null;
    };
};

/**
 * Why an answer was empty, decided only where the evidence decides it.
 *
 * ## Budget exhaustion needs all four conditions, together
 *
 * mposition set the bar and it is deliberately hard to clear:
 *
 *   visibleTextLength === 0
 *   normalizedFinishReason === "output_limit"
 *   billedOutputTokens ~= requestedMaxOutputTokens
 *   requestedMaxOutputTokens < resolvedProductOutputCap
 *
 * The last one is what makes it *ours*. A request that already asked for
 * everything the product asks for did not come up short because this harness
 * was stingy, whatever the other three say -- that would be the model or the
 * provider, and this rule must not claim it.
 *
 * Tokens merely close to the cap, or a finish reason of `length` on its own,
 * establish nothing and stay `undetermined`. Guessing here is how a harness
 * defect gets filed under a model's name, which is the thing that voided two
 * runs.
 */
export const classifyEmptiness = (metadata: AnswerMetadata): EmptinessClassification => {
    const billedOutputTokens = generatedTokens(metadata.usage);
    const normalizedFinishReason = normalizeFinishReason(metadata.finishReason);
    const requested = metadata.requestedMaxOutputTokens;
    const productCap = metadata.resolvedProductOutputCap;
    const evidence = {
        // Zero by construction: this is only reached for an empty answer.
        visibleTextLength: 0,
        normalizedFinishReason,
        billedOutputTokens,
        requestedMaxOutputTokens: requested,
        resolvedProductOutputCap: productCap,
    };
    const decided = (
        reason: EmptinessReason,
        attribution: FailureAttribution
    ): EmptinessClassification => ({
        symptom: EMPTY_TEXT_SYMPTOM,
        reason,
        attribution,
        evidence,
    });

    // Text arrived and normalising it is why none is left. No budget story can
    // explain content we were handed and dropped.
    if (metadata.rawTextLength > 0) return decided("text_normalization_loss", "harness");

    const askedUnderTheProduct = requested !== null && productCap !== null && requested < productCap;
    const spentTheBudget =
        billedOutputTokens !== null &&
        requested !== null &&
        billedOutputTokens >= requested * BUDGET_EXHAUSTION_RATIO;
    if (normalizedFinishReason === "output_limit" && spentTheBudget && askedUnderTheProduct) {
        return decided("output_budget_exhausted", "harness");
    }

    // The provider finished and accounts for zero output tokens. Only with
    // both does its response actually confirm it produced nothing.
    if (billedOutputTokens === 0 && normalizedFinishReason !== null) {
        return decided("provider_confirmed_empty", "model");
    }

    return decided("undetermined", "undetermined");
};

/**
 * One line for the failure journal. Everything a root cause would need.
 *
 * `attribution` is the gate's field. A run carrying any harness-attributable
 * failure measured this harness rather than the models, and
 * .github/workflows/router-eval-pilot.yml refuses to spend on the independent
 * judge while `harnessAttributableFailureCount` is non-zero.
 */
export const failureRecord = (outcome: Extract<AnswerOutcome, { status: "failed" }>) => {
    const classification =
        outcome.reason === "empty_output" ? classifyEmptiness(outcome.metadata) : null;
    return {
        kind: "answer-failure" as const,
        arm: outcome.metadata.arm,
        callRole: outcome.metadata.arm === "judge" ? ("judge" as const) : ("answer" as const),
        failure: outcome.reason,
        detail: outcome.detail,
        modelId: outcome.metadata.modelId,
        provider: outcome.metadata.provider,
        apiModel: outcome.metadata.apiModel,
        finishReason: outcome.metadata.finishReason,
        normalizedFinishReason: normalizeFinishReason(outcome.metadata.finishReason),
        usage: outcome.metadata.usage,
        billedOutputTokens: generatedTokens(outcome.metadata.usage),
        latencyMs: outcome.metadata.latencyMs,
        rawTextLength: outcome.metadata.rawTextLength,
        requestedMaxOutputTokens: outcome.metadata.requestedMaxOutputTokens,
        resolvedProductOutputCap: outcome.metadata.resolvedProductOutputCap,
        traceId: outcome.metadata.traceId,
        symptom: classification?.symptom ?? null,
        // A provider error has no emptiness to explain, so it carries no
        // reason and is attributed to the provider that failed the call.
        emptinessReason: classification?.reason ?? null,
        attribution: classification?.attribution ?? ("provider" as const),
        evidence: classification?.evidence ?? null,
    };
};

/** Whether this failure is one this harness caused. The gate counts these. */
export const isHarnessAttributable = (record: { attribution: FailureAttribution }): boolean =>
    record.attribution === "harness";
