/**
 * The attempt loop: one logical response, up to two dispatched attempts.
 *
 * This is step 1 of `docs/ops/tomverse-chat-auto-router-rollout.md` §9.1 --
 * the swap driven by a test double, before any real provider is involved. The
 * pieces it joins already existed and never met: `classifyStreamFailure` says
 * what failed, `decideFallback` says what §6 and §7 allow, and
 * `buildRoutingRetryChunk` is how the client is told. What was missing is the
 * thing that runs an attempt, hands its failure to those two, and runs another
 * -- and the reason to write it here rather than inside the chat route's
 * stream is that inside the stream it cannot be tested. A retry loop whose
 * only test is "point it at a provider and hope it fails the right way" is a
 * loop nobody can show is correct.
 *
 * ## What it does not do
 *
 * It does not settle, reserve, price, record an attempt row, or build a
 * manifest. Every one of those is the caller's, reached through
 * `startAttempt`, because they are exactly the parts §9.1 says are still open:
 * `ChatUsageReservation` carries a single model, provider and price snapshot,
 * and two attempts cannot be expressed in one of those yet. This module is
 * shaped so that when that contract exists, it plugs in at `startAttempt` and
 * `onAttemptSettled` rather than being threaded back through here.
 *
 * It also does not perform a Planner pass-through. `decideFallback` can return
 * one, and this loop stops with `pass_through_unavailable` when it does --
 * deliberately, and named rather than silent. `ROUTING_PLANNER_FAILURE_MODE`
 * defaults to `fail_closed` and the Planner itself is still `"none"`, so
 * nothing here can produce a pass-through today; when the Planner exists, the
 * stop reason is the thing that will fail loudly instead of quietly doing
 * nothing.
 *
 * ## The invariants, and which of them are enforced here rather than trusted
 *
 * - No attempt after a visible token. Enforced twice: this loop tracks what it
 *   emitted itself, and `decideFallback` refuses on `visibleTokenEmitted`.
 *   Counting is deliberately generous -- a chunk handed to `emit` counts as
 *   seen even if the client never rendered it, because over-counting costs a
 *   fallback that would have been allowed and under-counting replaces text
 *   somebody is reading.
 * - A failed attempt's reader is always cancelled before the next one starts.
 *   The alternative is a provider stream left open and still billing while a
 *   second one runs.
 * - The retry signal is never a visible token. It is out-of-band by
 *   construction (NUL-led) and the client strips it, so counting it would
 *   forbid the very fallback it is announcing.
 * - At most one substitution, through `decideFallback`'s own budget rather
 *   than a counter here.
 */

import type { PlannerMode, RoutingAttemptOutcome, RoutingFailureLayer } from "@/lib/routingAttemptStore";
import {
  decideFallback,
  fallbackStateFor,
  type FallbackDecision,
  type FallbackRefusal,
  type PlannerFailureMode,
  type ProviderRefusal,
  type RunFallbackState,
} from "@/lib/routingFallbackPolicy";
import { buildRoutingRetryChunk } from "@/lib/routingRetrySignal";
import {
  classifyStreamFailure,
  type StreamFailurePhase,
} from "@/lib/routingStreamFailure";

/** The provider's text stream, reduced to what the loop needs of it. */
export type AttemptReader = {
  read(): Promise<{ done: boolean; value?: string }>;
  /** Must be safe to call on an already-failed or already-finished reader. */
  cancel(reason?: unknown): Promise<void>;
};

export type AttemptExecution = {
  modelId: string;
  provider: string;
  plannerMode: PlannerMode;
  reader: AttemptReader;
  /**
   * The completion handling that runs after the last chunk -- usage, finish
   * reason, settlement. A failure here is classified `stream`, never
   * `provider`: the provider finished, and no other model would fix what
   * Tomverse did with the result.
   */
  complete?: () => Promise<void>;
};

export type AttemptRequest = {
  modelId: string;
  /** 0 for the primary. §5 numbers attempts within one run. */
  attemptIndex: number;
  plannerMode: PlannerMode;
};

/**
 * The result of preparing and dispatching one attempt.
 *
 * `started: false` is §5's `not_dispatched`: the candidate's draft, adapter
 * serialization, token check or manifest refused, so no provider was called.
 * It carries its own layer because §6 treats those layers differently -- an
 * adapter failure is model-specific and may fall back, a manifest or billing
 * failure fails closed.
 */
export type AttemptStart =
  | { started: true; execution: AttemptExecution }
  | {
      started: false;
      failureLayer: Exclude<RoutingFailureLayer, "none">;
      error?: unknown;
    };

export type AttemptRecord = {
  attemptIndex: number;
  modelId: string;
  /** Null when preparation refused before a provider was chosen for it. */
  provider: string | null;
  plannerMode: PlannerMode;
  outcome: RoutingAttemptOutcome;
  failureLayer: RoutingFailureLayer;
  /**
   * §7's two provider answers that are not model evidence, or null.
   *
   * On the record and not only in the decision, because the difference between
   * "no fallback was allowed" and "a fallback was allowed and refused for this
   * reason" is the whole diagnosability of the loop.
   */
  providerRefusal: ProviderRefusal | null;
  /** Characters this attempt put in front of the user. */
  visibleCharacters: number;
  /**
   * The stream ended cleanly having produced nothing.
   *
   * Recorded, not acted on. An empty completion is a *successful* provider
   * call whose answer was useless, which the chat route already handles as
   * `AI_EMPTY_RESPONSE` with its own model-scoped health accounting. Treating
   * it as a fallback trigger here would be a second, quieter policy for it.
   */
  emptyResponse: boolean;
  reason: string | null;
  error?: unknown;
};

export type SequenceStop =
  | { kind: "succeeded"; modelId: string }
  | { kind: "refused"; reason: FallbackRefusal }
  /** `decideFallback` allowed a pass-through and this loop does not do them. */
  | { kind: "pass_through_unavailable"; modelId: string };

export type AttemptSequenceResult = {
  attempts: readonly AttemptRecord[];
  stop: SequenceStop;
  /** The model that answered, or null if none did. */
  succeededModelId: string | null;
  /** §8: the model a successful fallback displaced. */
  displacedModelId: string | null;
  rerouteCount: number;
  passThroughUsed: boolean;
  fallbackState: "none" | "fallback_used" | "exhausted";
  visibleTokenEmitted: boolean;
  /** The last decision taken, for the run record. Null if none was needed. */
  lastDecision: FallbackDecision | null;
  /** What to surface to the caller when nothing answered. */
  error?: unknown;
};

export type AttemptSequenceInput = {
  primaryModelId: string;
  startAttempt: (request: AttemptRequest) => Promise<AttemptStart>;
  /**
   * The Router's ranked candidates minus everything already tried.
   *
   * Synchronous and caller-supplied: §6 requires a fallback candidate to pass
   * the same filters as the primary, and the Router has already ranked them by
   * the time the primary is dispatched. A loop that went and computed its own
   * would be choosing a model that had passed nothing.
   */
  nextCandidateModelIds: (attemptedModelIds: readonly string[]) => readonly string[];
  /**
   * Hands a chunk to the client. `false` means the client is no longer
   * accepting -- treated as a disconnect, not as a provider failure.
   */
  emit: (chunk: string) => boolean;
  /** Whether the response the user is connected to is still open. */
  downstreamOpen: () => boolean;
  plannerMode?: PlannerFailureMode;
  /** Called once per attempt, in order, after the attempt has ended. */
  onAttemptSettled?: (record: AttemptRecord) => void | Promise<void>;
};

const cancelQuietly = async (reader: AttemptReader, reason: unknown) => {
  try {
    await reader.cancel(reason);
  } catch {
    // A reader that refuses to be cancelled has nothing more to tell us, and
    // raising here would replace the failure being handled with a worse one.
  }
};

export const runAttemptSequence = async (
  input: AttemptSequenceInput
): Promise<AttemptSequenceResult> => {
  const attempts: AttemptRecord[] = [];
  const attempted: string[] = [];
  const run: RunFallbackState = {
    passThroughUsed: false,
    rerouteCount: 0,
    visibleTokenEmitted: false,
  };

  let modelId = input.primaryModelId;
  let plannerMode: PlannerMode = "planned";
  let attemptIndex = 0;
  let displacedModelId: string | null = null;
  let lastDecision: FallbackDecision | null = null;
  let stop: SequenceStop | null = null;
  let succeededModelId: string | null = null;
  let terminalError: unknown;

  const settle = async (record: AttemptRecord) => {
    attempts.push(record);
    await input.onAttemptSettled?.(record);
  };

  for (;;) {
    attempted.push(modelId);
    const started = await input.startAttempt({ modelId, attemptIndex, plannerMode });

    let record: AttemptRecord;

    if (!started.started) {
      record = {
        attemptIndex,
        modelId,
        provider: null,
        plannerMode,
        outcome: "not_dispatched",
        failureLayer: started.failureLayer,
        providerRefusal: null,
        visibleCharacters: 0,
        emptyResponse: false,
        reason: "The attempt was refused before any provider was called.",
        error: started.error,
      };
    } else {
      record = await runOneAttempt({
        execution: started.execution,
        attemptIndex,
        emit: input.emit,
        downstreamOpen: input.downstreamOpen,
        alreadyVisible: run.visibleTokenEmitted,
      });
    }

    run.visibleTokenEmitted ||= record.visibleCharacters > 0;
    await settle(record);

    if (record.outcome === "succeeded") {
      succeededModelId = record.modelId;
      stop = { kind: "succeeded", modelId: record.modelId };
      break;
    }

    terminalError = record.error;

    const decision = decideFallback({
      attempt: {
        modelId: record.modelId,
        outcome: record.outcome,
        failureLayer: record.failureLayer,
        providerRefusal: record.providerRefusal,
      },
      run,
      nextCandidateModelIds: input.nextCandidateModelIds(attempted),
      plannerMode: input.plannerMode,
    });
    lastDecision = decision;

    if (decision.action === "terminate") {
      stop = { kind: "refused", reason: decision.reason };
      break;
    }

    if (decision.action === "pass_through") {
      // Named, not silent. See the module comment: nothing can reach this
      // today, and when the Planner can, this is the line that says so.
      stop = { kind: "pass_through_unavailable", modelId: decision.modelId };
      break;
    }

    // §7: the client is told before the next model's first token, and told
    // only a model id. The signal is out-of-band, so it does not make the
    // response "visible" and does not close the door it just opened.
    if (!input.emit(buildRoutingRetryChunk(decision.modelId))) {
      stop = { kind: "refused", reason: "cancelled" };
      break;
    }

    displacedModelId = record.modelId;
    run.rerouteCount += 1;
    modelId = decision.modelId;
    plannerMode = "planned";
    attemptIndex += 1;
  }

  const finalStop = stop as SequenceStop;
  return {
    attempts,
    stop: finalStop,
    succeededModelId,
    displacedModelId: succeededModelId ? displacedModelId : null,
    rerouteCount: run.rerouteCount,
    passThroughUsed: run.passThroughUsed,
    // No decision means the primary answered and nothing was ever asked of
    // the policy -- which is the one case `fallbackStateFor` has no input for.
    fallbackState: lastDecision ? fallbackStateFor(lastDecision, run) : "none",
    visibleTokenEmitted: run.visibleTokenEmitted,
    lastDecision,
    error: succeededModelId ? undefined : terminalError,
  };
};

/**
 * One dispatched attempt, read to completion or to its failure.
 *
 * The three ways out are the three §7 cares about: the stream ended, it failed
 * with nothing shown, or it failed with something shown. Which one happened is
 * decided by `classifyStreamFailure` rather than here, so that the phase the
 * error came from -- read, emit, or completion handling -- is part of the
 * verdict instead of being lost at the `catch`.
 */
const runOneAttempt = async (input: {
  execution: AttemptExecution;
  attemptIndex: number;
  emit: (chunk: string) => boolean;
  downstreamOpen: () => boolean;
  alreadyVisible: boolean;
}): Promise<AttemptRecord> => {
  const { execution } = input;
  let visibleCharacters = 0;

  const base = {
    attemptIndex: input.attemptIndex,
    modelId: execution.modelId,
    provider: execution.provider,
    plannerMode: execution.plannerMode,
  };

  const failure = (phase: StreamFailurePhase, error: unknown) => {
    const classified = classifyStreamFailure({
      error,
      phase,
      // The user's view of the whole response, not of this attempt: a fallback
      // that fails after the primary showed nothing is still a response with
      // nothing shown, and one that fails after showing text is not.
      visibleTokenEmitted: input.alreadyVisible || visibleCharacters > 0,
      downstreamOpen: input.downstreamOpen(),
    });
    return {
      ...base,
      outcome: classified.outcome,
      failureLayer: classified.failureLayer,
      providerRefusal: classified.providerRefusal,
      visibleCharacters,
      emptyResponse: false,
      reason: classified.reason,
      error,
    };
  };

  for (;;) {
    let chunk: { done: boolean; value?: string };
    try {
      chunk = await execution.reader.read();
    } catch (error) {
      await cancelQuietly(execution.reader, error);
      return failure("read", error);
    }

    if (!input.downstreamOpen()) {
      await cancelQuietly(execution.reader, "the client is no longer connected");
      return failure("emit", new Error("the client is no longer connected"));
    }

    if (chunk.done) {
      try {
        await execution.complete?.();
      } catch (error) {
        return failure("completion", error);
      }
      return {
        ...base,
        outcome: "succeeded" as const,
        failureLayer: "none" as const,
        providerRefusal: null,
        visibleCharacters,
        // Measured in text, not in chunks. A provider that sends framing
        // chunks carrying no characters has still answered nothing.
        emptyResponse: visibleCharacters === 0,
        reason: null,
      };
    }

    const value = chunk.value ?? "";
    if (value === "") continue;

    let accepted: boolean;
    try {
      accepted = input.emit(value);
    } catch (error) {
      await cancelQuietly(execution.reader, error);
      return failure("emit", error);
    }
    if (!accepted) {
      const error = new Error("the client stopped accepting the response");
      await cancelQuietly(execution.reader, error);
      return failure("emit", error);
    }
    // Counted once it has been handed over, not once it has been rendered.
    // See the module comment on which direction this rounds.
    visibleCharacters += value.length;
  }
};
