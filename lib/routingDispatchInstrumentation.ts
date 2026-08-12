import "server-only";

// Attempt and manifest recording on the existing manual dispatch path
// (delivery plan §5; routing policy §5).
//
// Auto is not where this should be used first. The manual path already sends
// every chat request this product makes, so pointing the instrumentation at it
// measures the things that have to be true before Auto can dispatch anything:
// what fraction of dispatches get a record, whether finalization is really
// atomic, whether the token and context figures match what was sent, whether
// cancellation and stream failure reach settlement, and what the extra writes
// cost the time to first token. None of that is measurable on a path nobody
// uses yet, and all of it is cheaper to find here, where the user's own model
// choice is unchanged and a mistake costs a record rather than an answer.
//
// ## Why there is a mode, and why it is not "best effort"
//
// §5 makes dispatch conditional on the manifest: "Dispatch is prohibited
// unless manifest finalization and the attempt reference both succeed." The
// finished posture is therefore fail-closed, and `enforce` is that.
//
// `observe` exists because turning fail-closed on before knowing the failure
// rate would be trading an unmeasured recording problem for a measured outage.
// It is a rollout state, not a fallback: it counts every failure, reports each
// one as an operational incident, and the release gate requires `enforce`. The
// thing this deliberately is not is a permanent "the record failed but the
// chat continued" -- that would leave the boundary asserting a guarantee
// nothing provides, which is worse than having no boundary, because the
// records that do exist would look complete.

import { after } from "next/server";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  DispatchBoundaryError,
  abandonDraft,
  closeAttempt,
  createDraftManifest,
  finalizeManifest,
  markDispatched,
  openAttempt,
  type RoutingAttemptOutcome,
  type RoutingFailureLayer,
} from "@/lib/routingAttemptStore";
import {
  buildManifestSourceRefs,
  effectiveRequestHash,
  type EffectiveRequestInput,
  type ManifestMessage,
} from "@/lib/routingManifestContent";

export type DispatchInstrumentationMode = "off" | "observe" | "enforce";

export const dispatchInstrumentationMode = (): DispatchInstrumentationMode => {
  const raw = process.env.ROUTING_DISPATCH_INSTRUMENTATION;
  return raw === "observe" || raw === "enforce" ? raw : "off";
};

const secret = () => {
  const value = process.env.NEXTAUTH_SECRET;
  if (!value) {
    throw new DispatchBoundaryError(
      "NEXTAUTH_SECRET is required to digest a context manifest."
    );
  }
  return value;
};

/**
 * What the caller holds between beginning and completing.
 *
 * `null` when instrumentation is off or could not start in observe mode, so
 * every function below tolerates it and the request path reads the same either
 * way.
 */
export type DispatchInstrumentation = {
  runId: string;
  attemptId: string;
  modelId: string;
  startedAt: number;
  /** Milliseconds the instrumentation itself added before dispatch. */
  overheadMs: number;
} | null;

/**
 * Observe mode's accounting, so "how often does this fail" is a number rather
 * than an impression. Read by the readiness report; reset only by a restart.
 */
const counters = { started: 0, recorded: 0, failed: 0 };

export const dispatchInstrumentationCounters = () => ({ ...counters });

const handleFailure = async (
  stage: string,
  error: unknown,
  mode: DispatchInstrumentationMode
) => {
  counters.failed += 1;
  const report = () =>
    reportOperationalIncident({
      code: "ROUTING_DISPATCH_INSTRUMENTATION_FAILED",
      title: `Routing ${stage} recording failed`,
      error,
      severity: mode === "enforce" ? "error" : "warning",
      context: { component: "routing-instrumentation", stage, mode },
    });
  try {
    // Deferred inside a request so reporting never delays the response.
    after(report);
  } catch {
    // `after` throws outside a request scope -- a maintenance job, a test, a
    // background sweep. The failure path must not fail with a *different*
    // error than the one it exists to report, so it just runs.
    void report().catch(() => {});
  }
  if (mode === "enforce") {
    throw error instanceof DispatchBoundaryError
      ? error
      : new DispatchBoundaryError(
          `Routing ${stage} recording failed; the request must not be dispatched.`,
          error
        );
  }
};

export type BeginDispatchInput = {
  traceId: string;
  userId?: string | null;
  subjectKey: string;
  plan: string;
  modelId: string;
  provider: string;
  /** The messages actually being sent, already formatted for the provider. */
  messages: readonly ManifestMessage[];
  tokenizerVersion: string;
  /** The tokenizer's own count for this request. */
  tokenCount: number;
  contextWindowTokens: number;
  estimatedInputTokens: number;
  reservedInputTokens: number;
  requestOutputCapTokens: number;
  reservationId?: string | null;
  conversationId?: string | null;
};

/**
 * Opens the run, the attempt and the draft manifest.
 *
 * `mode: "manual"` on the run, because the user chose this model. The Router
 * had no say, and a run that did not route must not be counted in the metrics
 * that grade routing.
 */
export const beginInstrumentedDispatch = async (
  input: BeginDispatchInput
): Promise<DispatchInstrumentation> => {
  const mode = dispatchInstrumentationMode();
  if (mode === "off") return null;

  const startedAt = Date.now();
  counters.started += 1;
  try {
    const run = await prisma.routingRun.create({
      data: {
        mode: "manual",
        traceId: input.traceId,
        userId: input.userId ?? null,
        subjectKey: input.subjectKey,
        plan: input.plan,
        // The Router did not run, so its versions would be a claim about a
        // decision nobody made. The manual sentinel says which it was.
        taskProfileVersion: "manual",
        candidateFilterVersion: "manual",
        selectionVersion: "manual",
        estimatorVersion: input.tokenizerVersion,
        profileKind: "manual",
        profileConfidence: "none",
        needsCurrentInformation: false,
        hasImageInput: false,
        hasDocumentInput: false,
        expectedOutputLength: "medium",
        estimatedInputTokens: input.estimatedInputTokens,
        reservedInputTokens: input.reservedInputTokens,
        requestOutputCapTokens: input.requestOutputCapTokens,
        eligibleCount: 1,
        rejectedByReason: {},
        selectedModelId: input.modelId,
        selectionReason: "only_candidate",
        selectionMargin: 0,
        userSelectedModelId: input.modelId,
        decisionMicros: 0,
        initialModelId: input.modelId,
        reservationId: input.reservationId ?? null,
      },
      select: { id: true },
    });

    const attemptId = await openAttempt({
      runId: run.id,
      attemptIndex: 0,
      modelId: input.modelId,
      provider: input.provider,
      userId: input.userId ?? null,
    });

    await createDraftManifest({
      attemptId,
      userId: input.userId ?? null,
      sourceRefs: buildManifestSourceRefs(input.messages, secret()),
      tokenizerVersion: input.tokenizerVersion,
      tokenCount: input.tokenCount,
      contextWindowTokens: input.contextWindowTokens,
    });

    return {
      runId: run.id,
      attemptId,
      modelId: input.modelId,
      startedAt,
      overheadMs: Date.now() - startedAt,
    };
  } catch (error) {
    await handleFailure("draft", error, mode);
    return null;
  }
};

/**
 * §5 steps 4 and 5, immediately before the provider call.
 *
 * The manifest is finalized here and not a line earlier: the effective request
 * is only known once the adapter has assembled it, and a hash taken before
 * that would describe something other than what was sent.
 */
export const authoriseDispatch = async (
  instrumentation: DispatchInstrumentation,
  request: Omit<EffectiveRequestInput, "sourceRefs"> & {
    messages: readonly ManifestMessage[];
    plannerVersion: string;
    adapterVersion: string;
  }
): Promise<DispatchInstrumentation> => {
  if (!instrumentation) return null;
  const mode = dispatchInstrumentationMode();
  const startedAt = Date.now();
  try {
    const key = secret();
    const sourceRefs = buildManifestSourceRefs(request.messages, key);
    await finalizeManifest({
      attemptId: instrumentation.attemptId,
      plannerVersion: request.plannerVersion,
      adapterVersion: request.adapterVersion,
      effectiveRequestHash: effectiveRequestHash(
        {
          modelId: request.modelId,
          provider: request.provider,
          maxOutputTokens: request.maxOutputTokens,
          settings: request.settings,
          toolConfig: request.toolConfig,
          sourceRefs,
        },
        key
      ),
    });
    counters.recorded += 1;
    return {
      ...instrumentation,
      overheadMs: instrumentation.overheadMs + (Date.now() - startedAt),
    };
  } catch (error) {
    // Observe mode returns null and the chat continues, but the draft must not
    // be left in `draft` forever: a manifest stuck mid-lifecycle is
    // indistinguishable from one still in flight, and the coverage metric
    // would count it as neither dispatched nor abandoned.
    try {
      await abandonDraft({
        attemptId: instrumentation.attemptId,
        reason: "manifest_finalization_failed",
        failureLayer: "manifest",
      });
    } catch {
      // Nothing further to do: the finalize already failed, so the database is
      // the problem and the incident below is the report.
    }
    await handleFailure("finalize", error, mode);
    return null;
  }
};

/** Records that the provider call was made. Never before finalization. */
export const recordDispatched = async (
  instrumentation: DispatchInstrumentation,
  providerRequestId?: string | null
) => {
  if (!instrumentation) return;
  try {
    await markDispatched({
      attemptId: instrumentation.attemptId,
      providerRequestId: providerRequestId ?? null,
    });
  } catch (error) {
    // Past the point of refusal: the request is already with the provider, so
    // throwing here would fail a chat that succeeded. Recorded as a failure so
    // the readiness numbers show it.
    await handleFailure("dispatched", error, "observe");
  }
};

/**
 * Preparation failed before anything was sent. §6: the draft is marked, the
 * attempt is `not_dispatched`, and neither may be read later as the request
 * that reached a provider.
 */
export const recordNotDispatched = async (
  instrumentation: DispatchInstrumentation,
  reason: string,
  failureLayer: Exclude<RoutingFailureLayer, "none">
) => {
  if (!instrumentation) return;
  try {
    await abandonDraft({ attemptId: instrumentation.attemptId, reason, failureLayer });
  } catch (error) {
    await handleFailure("not_dispatched", error, "observe");
  }
};

/**
 * Closes the attempt and the run together.
 *
 * `overheadMs` is stored as the run's own decision cost, because "what did the
 * instrumentation add to time-to-first-token" is one of the questions this
 * exercise exists to answer, and an answer nobody recorded is an opinion.
 */
export const completeInstrumentedDispatch = async (
  instrumentation: DispatchInstrumentation,
  close: {
    outcome: RoutingAttemptOutcome;
    failureLayer?: RoutingFailureLayer;
    firstVisibleTokenAt?: Date | null;
    actualInputTokens?: number | null;
    actualOutputTokens?: number | null;
    errorClass?: string | null;
    assistantMessageId?: string | null;
    settlementOutcome?: string | null;
    firstTokenMs?: number | null;
  }
) => {
  if (!instrumentation) return;
  try {
    await closeAttempt({
      attemptId: instrumentation.attemptId,
      outcome: close.outcome,
      failureLayer: close.failureLayer,
      firstVisibleTokenAt: close.firstVisibleTokenAt,
      actualInputTokens: close.actualInputTokens,
      actualOutputTokens: close.actualOutputTokens,
      errorClass: close.errorClass,
    });
    await prisma.routingRun.update({
      where: { id: instrumentation.runId },
      data: {
        // Only a succeeded attempt is the one that answered. A failed run
        // keeps its initialModelId and names no final model, so "which model
        // produced the visible answer" has no answer where there was none.
        finalAttemptId: close.outcome === "succeeded" ? instrumentation.attemptId : null,
        finalModelId: close.outcome === "succeeded" ? instrumentation.modelId : null,
        assistantMessageId: close.assistantMessageId ?? undefined,
        settlementOutcome: close.settlementOutcome ?? undefined,
        firstTokenMs: close.firstTokenMs ?? undefined,
        totalLatencyMs: Date.now() - instrumentation.startedAt,
        decisionMicros: instrumentation.overheadMs * 1_000,
      },
    });
  } catch (error) {
    // The answer has already been delivered. Recording its end is diagnostics.
    await handleFailure("close", error, "observe");
  }
};
