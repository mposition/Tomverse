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
 * a judgement it was designed to ask a model for. The classifier is wired to the
 * marketing LLM ledger and monthly cap by the service that runs this (the
 * generator holds the key), which is a later step; until then the run answers
 * `classifier_unavailable` and the monitor stays unhealthy.
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
 */
export type MarketingCommentClassifier = (
  bodies: readonly string[],
) => Promise<ReadonlyArray<ReadonlyArray<string>>>;

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
};

export type MarketingCommentsMonitorDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly enabled: (env: Readonly<Record<string, string | undefined>>) => boolean;
  readonly classifier: MarketingCommentClassifier | null;
  readonly now: () => Date;
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

/** The bodies a model may see: new ones, text only, bounded. */
export const marketingCommentBodiesForModel = (
  comments: readonly ParsedZernioComment[],
  floor: Date | null,
  answeredAt: Date | null = null,
): string[] =>
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
    .map((comment) => comment.text.slice(0, MARKETING_COMMENT_BODY_MAX_CHARS));

export async function runMarketingCommentsMonitor(
  deps: MarketingCommentsMonitorDeps,
): Promise<MarketingCommentsMonitorResult> {
  if (!deps.enabled(deps.env)) return { ran: false, reason: "switch_off" };
  const classifier = deps.classifier;
  if (classifier === null) return { ran: false, reason: "classifier_unavailable" };

  const { operations } = deps;
  const startedAt = deps.now();
  let postsChecked = 0;
  let postsUnread = 0;
  let alertsRecorded = 0;
  let accountsStopped = 0;

  // The reads and the alerts. Whatever goes wrong in here makes the run
  // incomplete -- and cannot stop the check below that an unanswered alert
  // counts against its account.
  try {
    // New is relative to the last run that saw everything -- not to when an
    // alert was written, which is later than the page it came from. A run that
    // did not see everything does not move it, so what it missed is read again.
    const lastRun = await operations.lastCompleteRunAt();
    const floor = lastRun === null ? null : new Date(lastRun.getTime() - MARKETING_COMMENT_MONITOR_OVERLAP_MS);
    const listed = await operations.listPosts(MARKETING_COMMENT_MONITOR_POST_LIMIT + 1);
    const posts = listed.slice(0, MARKETING_COMMENT_MONITOR_POST_LIMIT);
    postsChecked = posts.length;
    const answers = await operations.alertAnswers(posts.map((post) => post.id));
    // A sample is not a run: with posts left over, the health record is not moved.
    if (listed.length > posts.length) postsUnread += 1;

    for (const post of posts) {
      try {
        const page = await deps.fetchComments(post);
        if (page.kind !== "ok") {
          postsUnread += 1;
          continue;
        }
        // A thread longer than the pages read is not a whole read, so the run is
        // not recorded as one -- but what was read is still classified and still
        // raises its alerts: an unread part is no reason to ignore the read part.
        if (page.truncated) postsUnread += 1;
        const bodies = marketingCommentBodiesForModel(page.comments, floor, answers.get(post.id) ?? null);
        if (bodies.length === 0) continue;
        const flagged: MarketingCommentRiskCode[][] = [];
        let wellFormed = true;
        for (let from = 0; from < bodies.length && wellFormed; from += MARKETING_COMMENT_CLASSIFIER_BATCH) {
          const batch = bodies.slice(from, from + MARKETING_COMMENT_CLASSIFIER_BATCH);
          const verdicts = await classifier(batch);
          // An answer of the wrong shape -- the list, or any entry in it -- is no
          // answer: nothing is concluded from it, and a missing verdict is never
          // read as a safe comment.
          if (
            !Array.isArray(verdicts) ||
            verdicts.length !== batch.length ||
            verdicts.some((codes) => !Array.isArray(codes) || codes.some((code) => typeof code !== "string"))
          ) {
            wellFormed = false;
            break;
          }
          flagged.push(...verdicts.map((codes) => knownCodes(codes)));
        }
        if (!wellFormed) {
          postsUnread += 1;
          continue;
        }
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
