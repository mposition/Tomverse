/**
 * One publisher run's work (S2 plan, S2d2).
 *
 * For each account in a publishing mode: observe its health, claim its next due
 * post, dispatch it, make the one vendor call, and record what came back. Then
 * confirm a few published posts are live. Every database step is one of the
 * bounded operations in `lib/marketingPublisherRun.ts`; every vendor call is
 * made between them, never inside one.
 *
 * ## The rules this module exists to keep
 *
 * - **One call per dispatch, never a second.** A publish that did not come back
 *   with proof is `outcome_unknown`, and the account pauses if it was
 *   autonomous (amendment 4). There is no retry and no lookup that could turn a
 *   silence into a success: Zernio cannot be asked about our key.
 * - **A dispatch that was recorded is answered.** Once `dispatch_started` has
 *   committed, the post is `publishing` and some outcome must be written for it
 *   -- published, failed or unknown. Anything thrown between the two becomes
 *   `outcome_unknown`, because by then a request may have left.
 * - **A recording that fails stops the run.** If the outcome cannot be written,
 *   the post is left `publishing` with nobody answering for it, and continuing to
 *   publish other posts would add to what a person has to untangle. The error
 *   goes up to the route, which records an incident and fails the run.
 * - **Health is observed fresh for each account,** stamped with the database's
 *   clock before the probe, and handed to the resolver that runs inside the
 *   claim and again inside the dispatch.
 *
 * Nothing here holds a credential or reads the environment. The adapter
 * arrives already built, by the route that has `ZERNIO_API_KEY`.
 */

import type { MarketingChannel } from "@/lib/marketingAutomationSchema";
import type {
  MarketingPublishAdapter,
  MarketingPublishResult,
} from "@/lib/marketingPublishAdapter";
import type { MarketingPublisherOperations } from "@/lib/marketingPublisherRun";
import type {
  MarketingClaimReleaseReason,
  MarketingDispatchRefusal,
  MarketingHealthObservation,
} from "@/lib/marketingStore";

/**
 * Wall-clock budget for one vendor call.
 *
 * The adapter aborts at this point and answers `outcome_unknown`; a call that
 * takes longer has not failed, it has stopped being waited for.
 */
export const MARKETING_PUBLISHER_CALL_BUDGET_MS = 30_000;

/**
 * Room a dispatch needs before the run's deadline: the call, and then the
 * transaction that records what it returned.
 *
 * Passed to the dispatch as its call budget, so the dispatch refuses -- on the
 * database's clock -- to start a call whose outcome could not be written before
 * the run is over. Recording takes at most the derived transaction maximum;
 * thirty seconds is what an ordinary recording leaves to spare many times over,
 * and the transaction timeout still bounds the rare one that does not.
 */
export const MARKETING_PUBLISHER_DISPATCH_ROOM_MS =
  MARKETING_PUBLISHER_CALL_BUDGET_MS + 30_000;

/** How many published posts one run asks the platform about. */
export const MARKETING_PUBLISHER_VERIFY_LIMIT = 5;

/**
 * What a refused dispatch gives back, and why.
 *
 * Only the refusals where this worker still holds the claim release it. A claim
 * that has expired, been taken, or whose row moved is not this worker's to give
 * back -- releasing it would be writing over somebody else's.
 */
const RELEASE_FOR: Partial<Record<MarketingDispatchRefusal, MarketingClaimReleaseReason>> = {
  not_admitted: "no_longer_admitted",
  channel_not_publishing: "no_longer_admitted",
  deadline_too_close: "worker_shutdown",
};

export type MarketingPublisherBatchDeps = {
  readonly operations: Pick<
    MarketingPublisherOperations,
    | "listChannels"
    | "listAwaitingVerification"
    | "claim"
    | "release"
    | "dispatch"
    | "recordPublished"
    | "recordFailed"
    | "recordOutcomeUnknown"
    | "recordVerified"
  >;
  readonly adapter: MarketingPublishAdapter;
  /** The database's clock, read outside any transaction this run holds. */
  readonly databaseNow: () => Promise<Date>;
  /** True while the run row is still this run's and inside its deadline. */
  readonly heartbeat: () => Promise<boolean>;
};

export type MarketingPublisherBatchInput = {
  readonly runId: string;
  readonly deadlineAt: Date;
};

export type MarketingPublisherBatchResult = {
  channels: number;
  claimed: number;
  published: number;
  failed: number;
  outcomeUnknown: number;
  verified: number;
  verificationMismatched: number;
  releaseFailed: number;
  refused: Record<string, number>;
  stopped: null | "deadline" | "heartbeat";
};

const count = (record: Record<string, number>, key: string) => {
  record[key] = (record[key] ?? 0) + 1;
};

/**
 * Ask the platform whether this account can take a post, stamped before asking.
 *
 * Stamped *before* the probe, so the observation is never younger than the
 * question that produced it. A probe that throws is an unhealthy answer, not an
 * error: the resolver refuses on it, which is what an account that cannot be
 * reached should cause.
 */
const observePublishHealth = async (
  adapter: MarketingPublishAdapter,
  channel: { id: string; connectionGeneration: number; externalAccountRef: string },
  observedAt: Date,
): Promise<MarketingHealthObservation> => {
  let healthy = false;
  try {
    const health = await adapter.observeHealth(channel.externalAccountRef, "publish");
    healthy = health.capability === "publish" && health.healthy === true;
  } catch {
    healthy = false;
  }
  return {
    channelId: channel.id,
    connectionGeneration: channel.connectionGeneration,
    healthy,
    observedAt,
  };
};

export async function runMarketingPublisherBatch(
  deps: MarketingPublisherBatchDeps,
  input: MarketingPublisherBatchInput,
): Promise<MarketingPublisherBatchResult> {
  const { operations, adapter } = deps;
  const result: MarketingPublisherBatchResult = {
    channels: 0,
    claimed: 0,
    published: 0,
    failed: 0,
    outcomeUnknown: 0,
    verified: 0,
    verificationMismatched: 0,
    releaseFailed: 0,
    refused: {},
    stopped: null,
  };
  // One token per run: the run is the worker, and a claim is held by it.
  const claimToken = `marketing-publisher:${input.runId}`;
  const deadline = input.deadlineAt.getTime();

  const roomLeft = async () => {
    const now = await deps.databaseNow();
    return { now, enough: now.getTime() + MARKETING_PUBLISHER_DISPATCH_ROOM_MS <= deadline };
  };

  const channels = await operations.listChannels();
  result.channels = channels.length;

  for (const channel of channels) {
    if (!(await deps.heartbeat())) {
      result.stopped = "heartbeat";
      return result;
    }
    const room = await roomLeft();
    if (!room.enough) {
      result.stopped = "deadline";
      return result;
    }

    const health = await observePublishHealth(adapter, channel, room.now);
    const claim = await operations.claim({ channelId: channel.id, claimToken, health });
    if (!claim.claimed) {
      count(result.refused, `claim:${claim.reason}`);
      continue;
    }
    result.claimed += 1;

    const dispatch = await operations.dispatch({
      id: claim.id,
      claimToken,
      expectedLeaseUntil: claim.leaseUntil,
      expectedHistoryVersion: claim.historyVersion,
      runDeadlineAt: input.deadlineAt,
      callBudgetMs: MARKETING_PUBLISHER_DISPATCH_ROOM_MS,
      health,
    });
    if (!dispatch.started) {
      count(result.refused, `dispatch:${dispatch.reason}`);
      const reason = RELEASE_FOR[dispatch.reason];
      if (reason) {
        // A release that fails leaves a lease that expires on its own; it is
        // counted rather than thrown, because nothing left this process and
        // nothing is waiting on an answer.
        try {
          await operations.release({
            id: claim.id,
            claimToken,
            expectedLeaseUntil: claim.leaseUntil,
            expectedHistoryVersion: claim.historyVersion,
            reason,
          });
        } catch {
          result.releaseFailed += 1;
        }
      }
      if (dispatch.reason === "deadline_too_close") {
        result.stopped = "deadline";
        return result;
      }
      continue;
    }

    // From here the post is `publishing`, and the only way out is a recorded
    // outcome.
    let outcome: MarketingPublishResult;
    const accountRef = dispatch.payload.externalAccountRef;
    if (accountRef === null || accountRef.trim() === "") {
      // The account lost its reference between the list and the lock. Nothing
      // is sent, so this is a confirmed non-publication, not an unknown.
      outcome = { outcome: "failed", errorCode: "account_ref_missing" };
    } else {
      try {
        outcome = await adapter.publish({
          requestKey: dispatch.requestKey,
          // Parsed by the envelope schema inside the dispatch.
          channel: dispatch.payload.channel as MarketingChannel,
          externalAccountRef: accountRef,
          locale: dispatch.payload.locale,
          renderedText: dispatch.payload.renderedText,
          assetIds: dispatch.payload.assetIds,
          finalUrl: dispatch.payload.finalUrl,
        });
      } catch {
        // The adapter answers in values; a throw is something it did not
        // expect, after a request may have left.
        outcome = { outcome: "outcome_unknown", errorCode: "publisher_call_threw" };
      }
    }

    const recorded = {
      id: claim.id,
      requestKey: dispatch.requestKey,
      expectedHistoryVersion: claim.historyVersion,
    };
    if (outcome.outcome === "published") {
      await operations.recordPublished({
        ...recorded,
        externalPostId: outcome.externalPostId,
        externalUrl: outcome.externalUrl,
      });
      result.published += 1;
    } else if (outcome.outcome === "failed") {
      await operations.recordFailed({ ...recorded, errorCode: outcome.errorCode });
      result.failed += 1;
    } else {
      await operations.recordOutcomeUnknown({ ...recorded, errorCode: outcome.errorCode });
      result.outcomeUnknown += 1;
    }
  }

  // Confirmation that published posts are live. A read and a conditional write
  // per post; nothing here publishes, retracts or decides an unknown outcome.
  const awaiting = await operations.listAwaitingVerification(MARKETING_PUBLISHER_VERIFY_LIMIT);
  for (const post of awaiting) {
    if (!(await deps.heartbeat())) {
      result.stopped = "heartbeat";
      return result;
    }
    const now = await deps.databaseNow();
    if (now.getTime() + MARKETING_PUBLISHER_DISPATCH_ROOM_MS > deadline) {
      result.stopped = "deadline";
      return result;
    }
    let state: Awaited<ReturnType<MarketingPublishAdapter["lookupStatus"]>>;
    try {
      state = await adapter.lookupStatus(post.externalPostId, post.externalAccountRef);
    } catch {
      continue;
    }
    if (state.state !== "live") continue;
    // The object under that id must be the one that was published. A different
    // URL is a different object, or the same one moved, and either way not the
    // confirmation the plan asks for.
    if (state.externalUrl !== post.externalUrl) {
      result.verificationMismatched += 1;
      continue;
    }
    const verified = await operations.recordVerified({
      id: post.id,
      expectedHistoryVersion: post.historyVersion,
    });
    if (verified.recorded) result.verified += 1;
    else count(result.refused, `verify:${verified.reason}`);
  }

  return result;
}
