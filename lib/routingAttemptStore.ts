import "server-only";

// RoutingAttempt and ContextManifest (docs/policy/tomverse-chat-routing.md §5).
//
// The posture here is the opposite of lib/routingShadow.ts, and the difference
// is the point of the module.
//
// Shadow telemetry may fail silently: it describes a decision nobody acted on,
// so losing a row costs a data point. A manifest is not telemetry. It is the
// record of what was actually sent to a provider, and §5 makes dispatch
// conditional on it: "Dispatch is prohibited unless manifest finalization and
// the attempt reference both succeed." A recorder that swallowed its errors
// would turn that into "dispatch proceeds and the evidence is missing", which
// is precisely the state the section forbids -- and the state in which nobody
// can answer what a model was asked.
//
// So every function here throws. The caller's obligation is to treat a failure
// as a reason not to dispatch, not as a warning to log.
//
// The database holds the rules rather than this file asserting them:
//
//   - a dispatched attempt has a finalized manifest, finalized no later than
//     the dispatch it authorised (CHECK on RoutingAttempt);
//   - one manifest belongs to one attempt and is never shared (UNIQUE);
//   - a finalized manifest cannot be modified at all (trigger);
//   - a finalized manifest carries its Planner, Adapter and effective-request
//     hash, so it proves something (CHECK);
//   - a manifest's own token count fits the window it was built for (CHECK);
//   - a not_dispatched attempt carries no dispatch time, provider request id or
//     usage (CHECK).
//
// Writing them here as well would be a second copy that can disagree. What
// this file owns is the *order*: build a draft, finalize it, then dispatch.

import { Prisma } from "@prisma/client";

import { getModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";

export type PlannerMode = "planned" | "pass_through";

export type RoutingAttemptOutcome =
  | "not_dispatched"
  | "failed_pre_token"
  | "failed_post_token"
  | "cancelled"
  | "succeeded";

export type RoutingFailureLayer =
  | "planner"
  | "adapter"
  | "manifest"
  | "billing"
  | "provider"
  | "stream"
  | "none";

/**
 * Raised when the dispatch boundary refuses.
 *
 * A distinct class so a caller can tell "the request must not be sent" apart
 * from an unrelated database error it might reasonably retry.
 */
export class DispatchBoundaryError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DispatchBoundaryError";
  }
}

export const openAttempt = async (input: {
  runId: string;
  attemptIndex: number;
  modelId: string;
  provider: string;
  plannerMode?: PlannerMode;
  userId?: string | null;
}) => {
  const attempt = await prisma.routingAttempt.create({
    data: {
      runId: input.runId,
      userId: input.userId ?? null,
      attemptIndex: input.attemptIndex,
      modelId: input.modelId,
      provider: input.provider,
      plannerMode: input.plannerMode ?? "planned",
      outcome: "pending",
      failureLayer: "none",
    },
    select: { id: true },
  });
  return attempt.id;
};

/**
 * §5 step 1. The draft holds what the Context Builder authorised: source
 * references, versions and hashes, and the tokenizer's own count against the
 * window it was checked against.
 *
 * Never the prompt. §5 and the delivery plan both say so, and the reason is
 * that a manifest exists to prove what was sent -- a copy of the text would
 * make the proof a second copy of the thing being proved, and would put the
 * user's words in a table with a different retention policy from theirs.
 */
export const createDraftManifest = async (input: {
  attemptId: string;
  userId?: string | null;
  sourceRefs: Prisma.InputJsonValue;
  summaryVersion?: string | null;
  inclusionRange?: Prisma.InputJsonValue;
  truncationPoints?: Prisma.InputJsonValue;
  tokenizerVersion: string;
  tokenCount: number;
  contextWindowTokens: number;
}) => {
  const manifest = await prisma.contextManifest.create({
    data: {
      attemptId: input.attemptId,
      userId: input.userId ?? null,
      state: "draft",
      sourceRefs: input.sourceRefs,
      summaryVersion: input.summaryVersion ?? null,
      inclusionRange: input.inclusionRange ?? Prisma.JsonNull,
      truncationPoints: input.truncationPoints ?? Prisma.JsonNull,
      tokenizerVersion: input.tokenizerVersion,
      tokenCount: input.tokenCount,
      contextWindowTokens: input.contextWindowTokens,
    },
    select: { id: true },
  });
  return manifest.id;
};

/**
 * §5 steps 4 and 5, as one transaction: stamp the manifest, mark it finalized,
 * and copy the finalization time onto the attempt.
 *
 * One transaction because the CHECK that makes ROUTE-06 true reads the
 * attempt's copy. Finalizing the manifest without it would leave a row that
 * satisfies neither claim -- a manifest that says it is finalized beside an
 * attempt the database will refuse to mark dispatched.
 *
 * Returns the finalization time, which the caller passes to
 * `markDispatched`: nothing here reads the clock twice, so the ordering the
 * CHECK enforces cannot fail on a millisecond.
 */
export const finalizeManifest = async (input: {
  attemptId: string;
  plannerVersion: string;
  templateVersion?: string | null;
  adapterVersion: string;
  structuredOptionsHash?: string | null;
  effectiveRequestHash: string;
  now?: Date;
}): Promise<Date> => {
  const finalizedAt = input.now ?? new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.contextManifest.updateMany({
        // `state: "draft"` in the predicate is the compare-and-set: a manifest
        // already finalized is not re-finalized, and the trigger would refuse
        // it anyway. Doing both means the race is decided by the database and
        // the intent is legible here.
        where: { attemptId: input.attemptId, state: "draft" },
        data: {
          state: "finalized",
          finalizedAt,
          plannerVersion: input.plannerVersion,
          templateVersion: input.templateVersion ?? null,
          adapterVersion: input.adapterVersion,
          structuredOptionsHash: input.structuredOptionsHash ?? null,
          effectiveRequestHash: input.effectiveRequestHash,
        },
      });
      if (claimed.count !== 1) {
        throw new DispatchBoundaryError(
          `No draft manifest to finalize for attempt ${input.attemptId}.`
        );
      }
      await tx.routingAttempt.update({
        where: { id: input.attemptId },
        data: { manifestFinalizedAt: finalizedAt },
      });
    });
  } catch (error) {
    if (error instanceof DispatchBoundaryError) throw error;
    throw new DispatchBoundaryError(
      `Manifest finalization failed for attempt ${input.attemptId}; the request must not be dispatched.`,
      error
    );
  }
  return finalizedAt;
};

/**
 * §5 step 5. Records the dispatch, and the CHECK behind it is what actually
 * prohibits one without a finalized manifest.
 *
 * `dispatchedAt` defaults to now and must not precede the finalization; the
 * caller normally passes the value `finalizeManifest` returned or a later one.
 */
export const markDispatched = async (input: {
  attemptId: string;
  dispatchedAt?: Date;
  providerRequestId?: string | null;
}) => {
  try {
    await prisma.routingAttempt.update({
      where: { id: input.attemptId },
      data: {
        dispatchedAt: input.dispatchedAt ?? new Date(),
        providerRequestId: input.providerRequestId ?? null,
      },
    });
  } catch (error) {
    throw new DispatchBoundaryError(
      `Attempt ${input.attemptId} could not be marked dispatched; it has no finalized manifest.`,
      error
    );
  }
};

/**
 * §6. A preparation that failed leaves the draft marked, with its reason, and
 * the attempt `not_dispatched`.
 *
 * "It must not be misrepresented as the request that reached a provider" is
 * the sentence this implements, and the CHECK on RoutingAttempt is what makes
 * the misrepresentation impossible rather than merely discouraged.
 */
export const abandonDraft = async (input: {
  attemptId: string;
  reason: string;
  failureLayer: Exclude<RoutingFailureLayer, "none">;
}) => {
  await prisma.$transaction(async (tx) => {
    await tx.contextManifest.updateMany({
      where: { attemptId: input.attemptId, state: "draft" },
      data: { state: "not_dispatched", notDispatchedReason: input.reason },
    });
    await tx.routingAttempt.update({
      where: { id: input.attemptId },
      data: { outcome: "not_dispatched", failureLayer: input.failureLayer },
    });
  });
};

export const closeAttempt = async (input: {
  attemptId: string;
  outcome: RoutingAttemptOutcome;
  failureLayer?: RoutingFailureLayer;
  firstVisibleTokenAt?: Date | null;
  actualInputTokens?: number | null;
  actualOutputTokens?: number | null;
  errorClass?: string | null;
}) => {
  const clean = input.outcome === "succeeded" || input.outcome === "cancelled";
  await prisma.routingAttempt.update({
    where: { id: input.attemptId },
    data: {
      outcome: input.outcome,
      failureLayer: clean ? "none" : (input.failureLayer ?? "provider"),
      firstVisibleTokenAt: input.firstVisibleTokenAt ?? undefined,
      actualInputTokens: input.actualInputTokens ?? undefined,
      actualOutputTokens: input.actualOutputTokens ?? undefined,
      errorClass: clean ? null : (input.errorClass ?? null),
    },
  });
};

/**
 * ROUTE-06's evidence query, as code so the gate reads the same number twice.
 *
 * Counts dispatched attempts and how many of them reference a finalized
 * manifest. The constraint should make these equal by construction; running it
 * anyway is how a constraint that was dropped in a migration gets noticed.
 */
export const dispatchedAttemptManifestCoverage = async (since?: Date) => {
  const where = {
    dispatchedAt: since ? { gte: since, not: null } : { not: null },
  } satisfies Prisma.RoutingAttemptWhereInput;

  const [dispatched, covered] = await Promise.all([
    prisma.routingAttempt.count({ where }),
    prisma.routingAttempt.count({
      where: { ...where, manifest: { is: { state: "finalized" } } },
    }),
  ]);

  return {
    dispatched,
    covered,
    coveragePercent: dispatched === 0 ? 100 : (covered / dispatched) * 100,
  };
};

/**
 * FALLBACK-03's evidence query: did each successful fallback get context
 * rebuilt for the model that actually ran?
 *
 * A fallback is an attempt after the first (`attemptIndex > 0`). The gate's
 * concern is that such an attempt might inherit the context assembled for the
 * model that failed -- built against a different tokenizer, cut to a different
 * window -- which is exactly the case a manifest per attempt exists to prevent.
 *
 * The 1:1 attempt/manifest relation makes "has its own manifest" structural, so
 * that alone would report 100% for a manifest copied verbatim from the first
 * attempt. What distinguishes a rebuilt manifest from a copied one, in data the
 * database already holds, is the window it was checked against:
 * `contextWindowTokens` must be the window of *this* attempt's model.
 *
 * Models with no declared window cannot answer that question either way, and
 * are reported as `unverifiable` rather than folded into either count. Counting
 * them as covered would let the 16 undeclared models in today's catalogue
 * (`npm run check:router-context-window`) carry the gate to 100% without
 * anything being checked; counting them as failures would report a defect that
 * is really a missing declaration, which is ESTIMATE-03's business, not this
 * gate's.
 *
 * Needs a database. Run from the release checklist against the deployed
 * database, like the other integrity queries.
 */
export const successfulFallbackCandidateManifestCoverage = async (
  since?: Date
) => {
  const attempts = await prisma.routingAttempt.findMany({
    where: {
      outcome: "succeeded",
      attemptIndex: { gt: 0 },
      ...(since ? { dispatchedAt: { gte: since } } : {}),
    },
    select: {
      id: true,
      modelId: true,
      manifest: { select: { state: true, contextWindowTokens: true } },
    },
  });

  // Read through `getModel` rather than by filtering the catalogue: the
  // catalogue is a const-asserted union in which only some entries declare a
  // window, so a narrowed `.filter()` does not typecheck and a cast would be
  // asserting exactly the thing in question.
  const declaredWindow = (modelId: string): number | undefined => {
    const model = getModel(modelId) as
      | { contextWindowTokens?: number }
      | undefined;
    return model?.contextWindowTokens;
  };

  let covered = 0;
  let unverifiable = 0;
  const offenders: {
    attemptId: string;
    modelId: string;
    reason: string;
  }[] = [];

  for (const attempt of attempts) {
    if (!attempt.manifest || attempt.manifest.state !== "finalized") {
      offenders.push({
        attemptId: attempt.id,
        modelId: attempt.modelId,
        reason: "no finalized manifest of its own",
      });
      continue;
    }
    const expected = declaredWindow(attempt.modelId);
    if (expected === undefined) {
      unverifiable += 1;
      continue;
    }
    if (attempt.manifest.contextWindowTokens !== expected) {
      offenders.push({
        attemptId: attempt.id,
        modelId: attempt.modelId,
        reason: `manifest window ${attempt.manifest.contextWindowTokens} is not this model's ${expected}`,
      });
      continue;
    }
    covered += 1;
  }

  const decidable = covered + offenders.length;
  return {
    successfulFallbacks: attempts.length,
    covered,
    unverifiable,
    offenders,
    // Over what could be decided, so an undeclared window neither inflates nor
    // deflates the figure the gate reads.
    coveragePercent: decidable === 0 ? 100 : (covered / decidable) * 100,
  };
};

/**
 * §5/§6/§8: what the run has spent, and what it left for the next turn.
 *
 * A compare-and-set on the budgets rather than a blind write. Two attempts
 * cannot both be the one that spent the single pass-through downgrade, and a
 * retry loop that raced with itself would otherwise record two -- which is
 * exactly the accounting the "once per logical response" rule exists to make
 * checkable afterwards.
 */
export const recordFallbackTransition = async (input: {
  runId: string;
  /** True when this transition spent the one pass-through downgrade. */
  spentPassThrough: boolean;
  /** True when this transition moved to a different model. */
  spentModelFallback: boolean;
  /**
   * Omitted leaves the run's own value alone.
   *
   * `fallbackState` is about model fallback and agrees with `rerouteCount` in
   * the database (`RoutingRun_fallback_agreement_check`); a pass-through
   * changes no model and spends no reroute, so writing `fallback_used` for one
   * would violate that. The downgrade is recorded by `passThroughUsed`, which
   * is the field that means it. Two fields because they are two facts.
   */
  fallbackState?: "none" | "fallback_used" | "exhausted";
  switchReason?: string | null;
  recoveryCandidateModelId?: string | null;
  fallbackHealthEvidence?: string | null;
}) => {
  const updated = await prisma.routingRun.updateMany({
    where: {
      id: input.runId,
      // The guard: a downgrade may only be spent by a run that still has it.
      ...(input.spentPassThrough ? { passThroughUsed: false } : {}),
    },
    data: {
      ...(input.fallbackState !== undefined
        ? { fallbackState: input.fallbackState }
        : {}),
      ...(input.spentPassThrough ? { passThroughUsed: true } : {}),
      ...(input.spentModelFallback ? { rerouteCount: { increment: 1 } } : {}),
      ...(input.switchReason !== undefined ? { switchReason: input.switchReason } : {}),
      ...(input.recoveryCandidateModelId !== undefined
        ? { recoveryCandidateModelId: input.recoveryCandidateModelId }
        : {}),
      ...(input.fallbackHealthEvidence !== undefined
        ? { fallbackHealthEvidence: input.fallbackHealthEvidence }
        : {}),
    },
  });

  if (updated.count === 0 && input.spentPassThrough) {
    throw new DispatchBoundaryError(
      `RoutingRun ${input.runId} has already spent its pass-through downgrade.`
    );
  }
  return updated.count;
};

/** The budgets a fallback decision is made against, read back from the run. */
export const readFallbackState = async (runId: string) => {
  const run = await prisma.routingRun.findUnique({
    where: { id: runId },
    select: { passThroughUsed: true, rerouteCount: true, firstTokenMs: true },
  });
  return run
    ? {
        passThroughUsed: run.passThroughUsed,
        rerouteCount: run.rerouteCount,
        // A recorded first-token time is the only durable evidence that
        // something reached the user, so a decision made from a fresh read
        // cannot conclude "nothing was shown" about a run that streamed.
        visibleTokenEmitted: run.firstTokenMs !== null,
      }
    : null;
};
