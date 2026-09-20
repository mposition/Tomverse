import "server-only";

import { randomUUID } from "node:crypto";

import corpusJson from "@/docs/ops/prompt-refiner-shadow/corpus-v1.json";
import {
    releasePromptRefinerReservation,
    reservePromptRefinerExecution,
} from "@/lib/promptRefinerReservationAuthority";
import type {
    PromptRefinerReservationBinding,
    PromptRefinerReservationRefusal,
} from "@/lib/promptRefinerReservationCore";
import { runPromptRefinerShadowLiveAdapter } from "@/lib/promptRefinerShadowLiveAdapter";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
    PROMPT_REFINER_SHADOW_CASE_IDS,
    PROMPT_REFINER_SHADOW_EXECUTION_FLAG,
    PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS,
    PROMPT_REFINER_SHADOW_RUN_ID,
    PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS,
} from "@/lib/promptRefinerShadowRunContract";
import {
    readPromptRefinerShadowExecutionState,
    recordPromptRefinerShadowDispatchIntent,
    recordPromptRefinerShadowTerminal,
    sweepPromptRefinerShadowUnknowns,
    type PromptRefinerShadowExecutionState,
} from "@/lib/promptRefinerShadowRunStore";
import {
    PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
    validatePromptRefinerShadowCorpus,
    type PromptRefinerShadowCorpus,
} from "@/lib/promptRefinerShadowHarness";
import { PROMPT_REFINER_TIMEOUT_MS } from "@/lib/promptRefinerExecutionContract";

const corpus = validatePromptRefinerShadowCorpus(corpusJson);
if (corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
    throw new Error("The bundled Prompt Refiner shadow corpus is not the frozen corpus.");
}

type AdapterOutcome = Awaited<ReturnType<typeof runPromptRefinerShadowLiveAdapter>>;
type DispatchFact = Parameters<
    Parameters<typeof runPromptRefinerShadowLiveAdapter>[0]["onDispatch"]
>[0];

export class PromptRefinerShadowRunnerError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "PromptRefinerShadowRunnerError";
    }
}

const refuse = (status: number, code: string, message: string): never => {
    throw new PromptRefinerShadowRunnerError(status, code, message);
};

type RunnerDependencies = {
    nowMs: () => number;
    executionEnabled: () => boolean;
    sweep: typeof sweepPromptRefinerShadowUnknowns;
    readState: typeof readPromptRefinerShadowExecutionState;
    reserve: typeof reservePromptRefinerExecution;
    release: typeof releasePromptRefinerReservation;
    recordIntent: typeof recordPromptRefinerShadowDispatchIntent;
    adapter: typeof runPromptRefinerShadowLiveAdapter;
    recordTerminal: typeof recordPromptRefinerShadowTerminal;
    reportIncident: typeof reportOperationalIncident;
    corpus: PromptRefinerShadowCorpus;
};

type RunnerIncidentPhase =
    | "pre_dispatch"
    | "post_dispatch"
    | "intent_missing"
    | "reservation_release"
    | "terminal_write";

type FixedRunnerIncidentCause =
    | PromptRefinerReservationRefusal
    | "intent_missing";

const runnerCauseCode = (error: unknown): string =>
    error instanceof PromptRefinerShadowRunnerError
        ? error.code
        : error instanceof Error
          ? "unexpected_error"
          : "non_error_throw";

/**
 * Reports only fixed operational metadata. Provider errors, prompt text and
 * model output are deliberately not forwarded to logs or alert channels.
 * Alert-delivery failure must not replace the runner's original outcome.
 */
const reportRunnerIncident = async (
    dependencies: RunnerDependencies,
    input: Readonly<{
        code: string;
        title: string;
        phase: RunnerIncidentPhase;
        caseId: string;
        caseIndex: number;
        attemptId: string | null;
        cause: unknown;
        causeCode?: FixedRunnerIncidentCause;
    }>
): Promise<void> => {
    const causeCode = input.causeCode ?? runnerCauseCode(input.cause);
    try {
        await dependencies.reportIncident({
            code: input.code,
            title: input.title,
            error: causeCode,
            severity: "error",
            context: {
                component: "prompt_refiner_shadow_runner",
                runId: PROMPT_REFINER_SHADOW_RUN_ID,
                caseId: input.caseId,
                caseIndex: input.caseIndex,
                attemptId: input.attemptId,
                phase: input.phase,
                causeCode,
            },
        });
    } catch {
        console.error(
            JSON.stringify({
                event: "prompt_refiner_shadow_incident_reporting_failed",
                code: input.code,
                phase: input.phase,
                runId: PROMPT_REFINER_SHADOW_RUN_ID,
                caseId: input.caseId,
                caseIndex: input.caseIndex,
                attemptId: input.attemptId,
            })
        );
    }
};

export type PromptRefinerShadowRunnerResult = Readonly<{
    status: "completed" | "stopped_unknown" | "in_flight" | "paused";
    attemptedThisInvocation: number;
    dispatchCount: number;
    terminalCount: number;
    inFlightAttemptId: string | null;
    observedAt: string;
    retryCount: 0;
    redispatched: 0;
}>;

const resultFromState = (
    state: PromptRefinerShadowExecutionState,
    attemptedThisInvocation: number,
    status?: PromptRefinerShadowRunnerResult["status"]
): PromptRefinerShadowRunnerResult =>
    Object.freeze({
        status:
            status ??
            (state.status === "completed"
                ? "completed"
                : state.status === "stopped_unknown"
                  ? "stopped_unknown"
                  : state.inFlightAttemptId
                    ? "in_flight"
                    : "paused"),
        attemptedThisInvocation,
        dispatchCount: state.dispatchCount,
        terminalCount: state.terminalCount,
        inFlightAttemptId: state.inFlightAttemptId,
        observedAt: state.observedAt,
        retryCount: 0,
        redispatched: 0,
    });

const requestIdFor = (caseId: string): string =>
    `prsv3_${caseId.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "")}`;

/**
 * Runs the approved synthetic cases strictly in corpus order. There is no
 * retry/fallback path: a post-intent exception leaves the durable intent for
 * the DB-clock sweeper and stops the invocation.
 */
export const createPromptRefinerShadowRunner = (
    dependencies: RunnerDependencies
) => async (): Promise<PromptRefinerShadowRunnerResult> => {
    const invocationStartedAtMs = dependencies.nowMs();
    const sweep = await dependencies.sweep();
    if (
        sweep.unresolvedStaleAttemptIds.length > 0 ||
        sweep.consumedWithoutAttempt.length > 0
    ) {
        return refuse(
            409,
            "PROMPT_REFINER_SHADOW_SWEEP_INCIDENT",
            "The pre-run sweep found unresolved durable state."
        );
    }
    if (dependencies.corpus.contentDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST) {
        return refuse(
            409,
            "PROMPT_REFINER_SHADOW_CORPUS_DIGEST_INVALID",
            "The execution corpus is not the frozen approved corpus."
        );
    }
    if (!dependencies.executionEnabled()) {
        return refuse(
            403,
            "PROMPT_REFINER_SHADOW_EXECUTION_DISABLED",
            "Prompt Refiner shadow execution is disabled."
        );
    }

    let attemptedThisInvocation = 0;
    let state = await dependencies.readState();
    while (state.nextCaseIndex !== null) {
        if (!dependencies.executionEnabled()) {
            return resultFromState(state, attemptedThisInvocation, "paused");
        }
        const elapsedMs = Math.max(
            0,
            dependencies.nowMs() - invocationStartedAtMs
        );
        const minimumRemainingMs =
            PROMPT_REFINER_TIMEOUT_MS +
            PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS;
        if (
            PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS - elapsedMs <
            minimumRemainingMs
        ) {
            return resultFromState(state, attemptedThisInvocation, "paused");
        }
        const caseIndex = state.nextCaseIndex;
        const caseId = PROMPT_REFINER_SHADOW_CASE_IDS[caseIndex];
        const item = dependencies.corpus.cases[caseIndex];
        if (!caseId || !item || item.id !== caseId) {
            return refuse(
                409,
                "PROMPT_REFINER_SHADOW_CORPUS_SEQUENCE_INVALID",
                "The frozen corpus no longer matches the run order."
            );
        }
        const requestId = requestIdFor(caseId);
        const reservationResult = await dependencies.reserve({ requestId });
        if (!reservationResult.ok) {
            await reportRunnerIncident(dependencies, {
                code: "PROMPT_REFINER_SHADOW_RESERVATION_INCIDENT",
                title: "Prompt Refiner shadow reservation was refused",
                phase: "pre_dispatch",
                caseId,
                caseIndex,
                attemptId: null,
                cause: reservationResult,
                causeCode: reservationResult.reason,
            });
            return refuse(
                409,
                "PROMPT_REFINER_SHADOW_RESERVATION_REFUSED",
                `The next case could not be reserved (${reservationResult.reason}).`
            );
        }
        const reservation: PromptRefinerReservationBinding =
            reservationResult.value.reservation;
        let attemptId: string | null = null;
        let reservationNeedsRelease = true;
        let outcome: AdapterOutcome;
        try {
            outcome = await dependencies.adapter({
                requestId,
                prompt: item.sourceText,
                onDispatch: async (fact: DispatchFact) => {
                    const intent = await dependencies.recordIntent({
                        runId: PROMPT_REFINER_SHADOW_RUN_ID,
                        caseId,
                        caseIndex,
                        reservation,
                        fact,
                    });
                    if (!intent.ok) {
                        if (intent.reason === "reservation_expired") {
                            reservationNeedsRelease = false;
                        }
                        return refuse(
                            409,
                            "PROMPT_REFINER_SHADOW_DISPATCH_REFUSED",
                            `The dispatch intent was refused (${intent.reason}).`
                        );
                    }
                    attemptId = intent.attempt.id;
                },
            });
        } catch (error) {
            if (attemptId === null) {
                await reportRunnerIncident(dependencies, {
                    code: "PROMPT_REFINER_SHADOW_PRE_DISPATCH_INCIDENT",
                    title: "Prompt Refiner shadow dispatch was refused before provider entry",
                    phase: "pre_dispatch",
                    caseId,
                    caseIndex,
                    attemptId,
                    cause: error,
                });
                if (reservationNeedsRelease) {
                    const released = await dependencies.release(reservation);
                    if (!released.ok) {
                        await reportRunnerIncident(dependencies, {
                            code: "PROMPT_REFINER_SHADOW_RESERVATION_RELEASE_INCIDENT",
                            title: "Prompt Refiner shadow reservation could not be released",
                            phase: "reservation_release",
                            caseId,
                            caseIndex,
                            attemptId,
                            cause: released.reason,
                            causeCode: released.reason,
                        });
                        return refuse(
                            409,
                            "PROMPT_REFINER_SHADOW_PRE_DISPATCH_RELEASE_FAILED",
                            "A pre-dispatch failure could not close its reservation."
                        );
                    }
                }
                if (error instanceof PromptRefinerShadowRunnerError) throw error;
                return refuse(
                    409,
                    "PROMPT_REFINER_SHADOW_PRE_DISPATCH_FAILED",
                    "The provider boundary was not entered."
                );
            }
            await reportRunnerIncident(dependencies, {
                code: "PROMPT_REFINER_SHADOW_POST_DISPATCH_INCIDENT",
                title: "Prompt Refiner shadow dispatch outcome is unknown",
                phase: "post_dispatch",
                caseId,
                caseIndex,
                attemptId,
                cause: error,
            });
            return refuse(
                503,
                "PROMPT_REFINER_SHADOW_OUTCOME_UNKNOWN",
                "A dispatched case has no durable terminal receipt; retry is forbidden."
            );
        }
        if (attemptId === null) {
            await reportRunnerIncident(dependencies, {
                code: "PROMPT_REFINER_SHADOW_INTENT_MISSING_INCIDENT",
                title: "Prompt Refiner shadow adapter returned without dispatch intent",
                phase: "intent_missing",
                caseId,
                caseIndex,
                attemptId,
                cause: "intent_missing",
                causeCode: "intent_missing",
            });
            const released = await dependencies.release(reservation);
            if (!released.ok) {
                await reportRunnerIncident(dependencies, {
                    code: "PROMPT_REFINER_SHADOW_RESERVATION_RELEASE_INCIDENT",
                    title: "Prompt Refiner shadow reservation could not be released",
                    phase: "reservation_release",
                    caseId,
                    caseIndex,
                    attemptId,
                    cause: released.reason,
                    causeCode: released.reason,
                });
                return refuse(
                    409,
                    "PROMPT_REFINER_SHADOW_PRE_DISPATCH_RELEASE_FAILED",
                    "A pre-dispatch failure could not close its reservation."
                );
            }
            return refuse(
                503,
                "PROMPT_REFINER_SHADOW_INTENT_MISSING",
                "The adapter returned without a durable dispatch intent."
            );
        }
        try {
            await dependencies.recordTerminal({
                attemptId,
                terminalReason: outcome.terminalReason,
                durationMs: outcome.durationMs,
                usage: outcome.usage,
            });
        } catch (error) {
            await reportRunnerIncident(dependencies, {
                code: "PROMPT_REFINER_SHADOW_TERMINAL_WRITE_INCIDENT",
                title: "Prompt Refiner shadow terminal receipt is unknown",
                phase: "terminal_write",
                caseId,
                caseIndex,
                attemptId,
                cause: error,
            });
            return refuse(
                503,
                "PROMPT_REFINER_SHADOW_TERMINAL_WRITE_UNKNOWN",
                "The terminal receipt could not be confirmed; retry is forbidden."
            );
        }
        attemptedThisInvocation += 1;
        state = await dependencies.readState();
        if (state.status === "stopped_unknown") {
            return resultFromState(state, attemptedThisInvocation);
        }
    }
    return resultFromState(state, attemptedThisInvocation);
};

const liveRunner = createPromptRefinerShadowRunner({
    nowMs: () => performance.now(),
    executionEnabled: () =>
        process.env[PROMPT_REFINER_SHADOW_EXECUTION_FLAG] === "true",
    sweep: sweepPromptRefinerShadowUnknowns,
    readState: readPromptRefinerShadowExecutionState,
    reserve: reservePromptRefinerExecution,
    release: releasePromptRefinerReservation,
    recordIntent: recordPromptRefinerShadowDispatchIntent,
    adapter: runPromptRefinerShadowLiveAdapter,
    recordTerminal: recordPromptRefinerShadowTerminal,
    reportIncident: reportOperationalIncident,
    corpus,
});

export const runPromptRefinerShadowExecution = () => liveRunner();

export const promptRefinerShadowRunnerErrorResponse = (error: unknown) => {
    if (!(error instanceof PromptRefinerShadowRunnerError)) return null;
    return Response.json(
        { error: error.message, code: error.code },
        { status: error.status }
    );
};
