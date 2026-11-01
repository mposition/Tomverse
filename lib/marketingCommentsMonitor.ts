/**
 * One run of the comment monitor (policy 12.1 and 8.3, S4c).
 *
 * Reads the comments under the account's recent published posts, classifies
 * them in memory, and keeps nothing of them: an alert is a count, the closed
 * risk codes and the host of the post's URL. A risk alert nobody answered within
 * a day stops the account through the S4a path.
 *
 * ## Off means off
 *
 * `MARKETING_COMMENTS_MONITOR_ENABLED` is not set to `true` by default and the
 * legal steps in 12.1 are a person's. When it is not true, `runMarketingCommentsMonitor()`
 * returns before it touches any dependency: no database read, no call to the
 * posting tool, no model.
 *
 * ## The model
 *
 * Classification is the `classifier` the caller passes, and it is given the
 * comment bodies only -- no author, no id, no link -- truncated, and nothing
 * else. What it returns can only open an alert (a closed list of codes, anything
 * else is dropped); it cannot close one, clear the account or approve a post.
 * No classifier means no run: the monitor does not substitute a keyword list for
 * a judgement it was designed to ask a model for.
 *
 * ## Two steps, two services (S4d)
 *
 * The model is asked by the comments service, which holds the marketing LLM key
 * and spends through the ledger and its monthly cap; the app holds the posting
 * tool's key and the database. So a run is two requests to the app:
 * `collectMarketingCommentBodies()` reads what a run at `readAt` would ask about
 * and hands over the bodies alone, and the whole run then happens here with the
 * service's verdicts as the classifier and `readAt` as its start. The second
 * step reads the comments again rather than trust anything the service sends
 * back but verdicts: what was read, whether the run was whole and when it began
 * are all the app's own. A comment written after `readAt` is left to the next
 * run, whose floor is below it.
 *
 * The service loads this file with `--experimental-strip-types` (through
 * lib/marketingCommentsClassifierCore.ts), so its imports stay type-only.
 *
 * ## Health
 *
 * A run is recorded as completed only when every post's comments were read and
 * classified. A comment page that could not be read, or a classification that
 * failed, makes the run incomplete: the alerts found are still recorded, the
 * unanswered-alert check still runs, and the health record is not refreshed.
 */

import type { ParsedZernioComment, ZernioCommentsResult } from "@/lib/zernioCommentsQuery";

/** What a comment can be flagged for. Closed: the classifier may only name these. */
export const MARKETING_COMMENT_RISK_CODES = [
  "legal_threat",
  "abuse_or_harassment",
  "self_harm_or_safety",
  "privacy_or_data_request",
  "refund_or_billing_complaint",
  "misleading_claim_dispute",
] as const;
export type MarketingCommentRiskCode = (typeof MARKETING_COMMENT_RISK_CODES)[number];

/**
 * Comment bodies in, one list of risk codes per body out (same length, same
 * order). Throws when it cannot answer; the run then counts the post unread.
 * `null` for a body it has no verdict on: the post is unread, and the verdicts
 * it did give still raise their alert.
 */
export type MarketingCommentClassifier = (
  bodies: readonly string[],
) => Promise<ReadonlyArray<ReadonlyArray<string> | null>>;

export const MARKETING_COMMENT_BODY_MAX_CHARS = 1_000;
/** Bodies per classifier call. Every new comment is classified, in as many calls as it takes. */
export const MARKETING_COMMENT_CLASSIFIER_BATCH = 50;
/** Posts one run covers. More than this and the run is incomplete rather than a sample. */
export const MARKETING_COMMENT_MONITOR_POST_LIMIT = 200;
/** A run looks back this far before the last complete run's start, for comments written while it ran. */
export const MARKETING_COMMENT_MONITOR_OVERLAP_MS = 600_000;

export type MarketingCommentMonitorPost = {
  readonly id: string;
  readonly channelId: string;
  readonly externalPostId: string;
  readonly externalAccountRef: string;
  /** When the account's approval period began: a reconnect or a resume moves it. */
  readonly channelApprovalStartedAt: Date | null;
};

export type MarketingCommentsMonitorDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly enabled: (env: Readonly<Record<string, string | undefined>>) => boolean;
  readonly classifier: MarketingCommentClassifier | null;
  readonly now: () => Date;
  /**
   * When the comments were read for the classifier, in a two-step run: the run
   * begins then, and leaves anything written later to the next run. Absent, the
   * run reads and classifies in one pass and begins at `now()`.
   */
  readonly readAt?: Date;
  readonly fetchComments: (post: MarketingCommentMonitorPost) => Promise<ZernioCommentsResult>;
  readonly operations: {
    readonly listPosts: (limit: number) => Promise<MarketingCommentMonitorPost[]>;
    /** When the latest run that read and classified everything began, or null if none has. */
    readonly lastCompleteRunAt: () => Promise<Date | null>;
    /** When an operator last answered each post's alert. Comments up to then are handled. */
    readonly alertAnswers: (postIds: readonly string[]) => Promise<Map<string, Date>>;
    readonly recordAlert: (input: {
      postId: string;
      alertCount: number;
      riskCodes: readonly MarketingCommentRiskCode[];
      detectedAt: Date;
      answeredAtSeen: Date | null;
      /** The newest time among the flagged comments; null when none of them has one. */
      flaggedNewestAt: Date | null;
    }) => Promise<{ recorded: boolean; reason?: string }>;
    /** Stops the accounts with an alert unanswered past the limit; returns how many it stopped. */
    readonly sweepUnhandled: (now: Date) => Promise<number>;
    /** Records a whole run; `at` is when it began, so comments written during it are read again. */
    readonly recordRun: (at: Date) => Promise<void>;
  };
};

export type MarketingCommentsMonitorResult =
  | { readonly ran: false; readonly reason: "switch_off" | "classifier_unavailable" }
  | {
      readonly ran: true;
      readonly postsChecked: number;
      readonly postsUnread: number;
      readonly alertsRecorded: number;
      readonly accountsStopped: number;
      readonly complete: boolean;
    };

const knownCodes = (codes: ReadonlyArray<string>): MarketingCommentRiskCode[] =>
  codes.filter((code): code is MarketingCommentRiskCode =>
    (MARKETING_COMMENT_RISK_CODES as readonly string[]).includes(code),
  );

/** The comments a model is asked about: the new ones, none already answered. */
export const marketingNewComments = (
  comments: readonly ParsedZernioComment[],
  floor: Date | null,
  answeredAt: Date | null = null,
  readAt: Date | null = null,
): ParsedZernioComment[] =>
  comments
    // What an operator has answered is handled. A comment with no time cannot be
    // shown to be newer than the answer, so it is not read again after one.
    .filter((comment) =>
      answeredAt === null || (comment.createdAt !== null && comment.createdAt.getTime() > answeredAt.getTime()),
    )
    // A comment with no time cannot be placed, so it is read every run.
    .filter((comment) =>
      floor === null || comment.createdAt === null || comment.createdAt.getTime() > floor.getTime(),
    )
    // Written after the run began: the next run's floor is below it, so it is that run's.
    .filter((comment) =>
      readAt === null || comment.createdAt === null || comment.createdAt.getTime() <= readAt.getTime(),
    );

type MarketingCommentsReadDeps = Pick<MarketingCommentsMonitorDeps, "fetchComments"> & {
  readonly operations: Pick<
    MarketingCommentsMonitorDeps["operations"],
    "listPosts" | "lastCompleteRunAt" | "alertAnswers"
  >;
};

/**
 * What a run covers: its posts, the floor their comments are new above, and
 * when each post's alert was last answered. `sampled` when more posts were
 * listed than one run takes.
 */
const readMonitorScope = async (deps: MarketingCommentsReadDeps) => {
  // New is relative to the last run that saw everything -- not to when an
  // alert was written, which is later than the page it came from. A run that
  // did not see everything does not move it, so what it missed is read again.
  const lastRun = await deps.operations.lastCompleteRunAt();
  const floor = lastRun === null ? null : new Date(lastRun.getTime() - MARKETING_COMMENT_MONITOR_OVERLAP_MS);
  const listed = await deps.operations.listPosts(MARKETING_COMMENT_MONITOR_POST_LIMIT + 1);
  const posts = listed.slice(0, MARKETING_COMMENT_MONITOR_POST_LIMIT);
  const answers = await deps.operations.alertAnswers(posts.map((post) => post.id));
  return { floor, posts, answers, sampled: listed.length > posts.length };
};

/** One post's comments a run asks about, or null when its page could not be read. */
const readPostComments = async (
  deps: MarketingCommentsReadDeps,
  post: MarketingCommentMonitorPost,
  floor: Date | null,
  answeredAt: Date | null,
  readAt: Date | null,
): Promise<{ fresh: ParsedZernioComment[]; truncated: boolean } | null> => {
  const page = await deps.fetchComments(post);
  if (page.kind !== "ok") return null;
  // An account that was reconnected or resumed since the last whole run was not
  // read in between, so the run's time says nothing about its comments: all
  // of them are read once.
  const postFloor =
    floor !== null && post.channelApprovalStartedAt !== null && post.channelApprovalStartedAt.getTime() > floor.getTime()
      ? null
      : floor;
  return { fresh: marketingNewComments(page.comments, postFloor, answeredAt, readAt), truncated: page.truncated };
};

/** Bodies one collect hands over at most. Past it the run cannot be whole, and says so. */
export const MARKETING_COMMENT_COLLECT_MAX_BODIES = 1_000;

export type MarketingCommentsCollectResult =
  | { readonly ran: false; readonly reason: "switch_off" }
  | { readonly ran: true; readonly bodies: string[]; readonly capped: boolean };

/**
 * The first step of a two-step run: the distinct bodies a run beginning at
 * `readAt` would ask the model about, and nothing else -- no post, author, time
 * or link -- with nothing written. A page that cannot be read is left out; the
 * second step reads again and finds that out for itself.
 */
export async function collectMarketingCommentBodies(
  deps: MarketingCommentsReadDeps & Pick<MarketingCommentsMonitorDeps, "env" | "enabled">,
  readAt: Date,
): Promise<MarketingCommentsCollectResult> {
  if (!deps.enabled(deps.env)) return { ran: false, reason: "switch_off" };
  const scope = await readMonitorScope(deps);
  const bodies = new Set<string>();
  let capped = false;
  for (const post of scope.posts) {
    const read = await readPostComments(deps, post, scope.floor, scope.answers.get(post.id) ?? null, readAt).catch(
      () => null,
    );
    for (const comment of read?.fresh ?? []) {
      const body = comment.text.slice(0, MARKETING_COMMENT_BODY_MAX_CHARS);
      if (bodies.size < MARKETING_COMMENT_COLLECT_MAX_BODIES || bodies.has(body)) bodies.add(body);
      else capped = true;
    }
  }
  return { ran: true, bodies: [...bodies], capped };
}

export async function runMarketingCommentsMonitor(
  deps: MarketingCommentsMonitorDeps,
): Promise<MarketingCommentsMonitorResult> {
  if (!deps.enabled(deps.env)) return { ran: false, reason: "switch_off" };
  const classifier = deps.classifier;
  if (classifier === null) return { ran: false, reason: "classifier_unavailable" };

  const { operations } = deps;
  const readAt = deps.readAt ?? null;
  const startedAt = readAt ?? deps.now();
  let postsChecked = 0;
  let postsUnread = 0;
  let alertsRecorded = 0;
  let accountsStopped = 0;

  // The reads and the alerts. Whatever goes wrong in here makes the run
  // incomplete -- and cannot stop the check below that an unanswered alert
  // counts against its account.
  try {
    const { floor, posts, answers, sampled } = await readMonitorScope(deps);
    postsChecked = posts.length;
    // A sample is not a run: with posts left over, the health record is not moved.
    if (sampled) postsUnread += 1;

    for (const post of posts) {
      try {
        const read = await readPostComments(deps, post, floor, answers.get(post.id) ?? null, readAt);
        if (read === null) {
          postsUnread += 1;
          continue;
        }
        // A thread longer than the pages read is not a whole read, so the run is
        // not recorded as one -- but what was read is still classified and still
        // raises its alerts: an unread part is no reason to ignore the read part.
        if (read.truncated) postsUnread += 1;
        const fresh = read.fresh;
        const bodies = fresh.map((comment) => comment.text.slice(0, MARKETING_COMMENT_BODY_MAX_CHARS));
        if (bodies.length === 0) continue;
        const flagged: MarketingCommentRiskCode[][] = [];
        let wellFormed = true;
        let unanswered = false;
        for (let from = 0; from < bodies.length && wellFormed; from += MARKETING_COMMENT_CLASSIFIER_BATCH) {
          const batch = bodies.slice(from, from + MARKETING_COMMENT_CLASSIFIER_BATCH);
          let verdicts: ReadonlyArray<ReadonlyArray<string> | null>;
          try {
            verdicts = await classifier(batch);
          } catch {
            wellFormed = false;
            break;
          }
          // An answer of the wrong shape -- the list, or any entry in it -- is no
          // answer: nothing is concluded from it, and a missing verdict is never
          // read as a safe comment.
          if (
            !Array.isArray(verdicts) ||
            verdicts.length !== batch.length ||
            verdicts.some(
              (codes) => codes !== null && (!Array.isArray(codes) || codes.some((code) => typeof code !== "string")),
            )
          ) {
            wellFormed = false;
            break;
          }
          // A body with no verdict is not a safe one: the post is unread. Its
          // neighbours' verdicts are verdicts all the same.
          if (verdicts.some((codes) => codes === null)) unanswered = true;
          flagged.push(...verdicts.map((codes) => (codes === null ? [] : knownCodes(codes))));
        }
        // A batch that failed leaves the post unread -- the run is not whole -- but
        // what the earlier batches found is real, and is still raised below.
        if (!wellFormed || unanswered) postsUnread += 1;
        const alertCount = flagged.filter((codes) => codes.length > 0).length;
        if (alertCount === 0) continue;
        const riskCodes = MARKETING_COMMENT_RISK_CODES.filter((code) =>
          flagged.some((codes) => codes.includes(code)),
        );
        const outcome = await operations.recordAlert({
          postId: post.id,
          alertCount,
          riskCodes,
          detectedAt: startedAt,
          answeredAtSeen: answers.get(post.id) ?? null,
          flaggedNewestAt: flagged.reduce<Date | null>((newest, codes, index) => {
            const at = codes.length > 0 ? fresh[index]?.createdAt ?? null : null;
            return at !== null && (newest === null || at > newest) ? at : newest;
          }, null),
        });
        if (outcome.recorded) alertsRecorded += 1;
        // The operator answered while the comments were being classified: the
        // verdict was about handled comments, and the next run judges again.
        else if (outcome.reason === "answer_changed") postsUnread += 1;
      } catch {
        // The fetch, the model or the write failed for this post. It is unread;
        // the rest of the run goes on.
        postsUnread += 1;
      }
    }
  } catch {
    postsUnread += 1;
  }

  // Whether or not every post was read: an alert already open does not wait for
  // the monitor to be perfect before it counts against the account.
  try {
    accountsStopped = await operations.sweepUnhandled(deps.now());
  } catch {
    postsUnread += 1;
  }
  let complete = postsUnread === 0;
  if (complete) {
    try {
      await operations.recordRun(startedAt);
    } catch {
      complete = false;
    }
  }
  return {
    ran: true,
    postsChecked,
    postsUnread,
    alertsRecorded,
    accountsStopped,
    complete,
  };
}
