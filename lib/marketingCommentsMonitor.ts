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
export const MARKETING_COMMENT_MAX_PER_POST = 50;
export const MARKETING_COMMENT_MONITOR_POST_LIMIT = 40;

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
    /** The instant after which a comment is new for this post, or null for all of them. */
    readonly alertFloor: (postId: string) => Promise<Date | null>;
    readonly recordAlert: (input: {
      postId: string;
      alertCount: number;
      riskCodes: readonly MarketingCommentRiskCode[];
      detectedAt: Date;
    }) => Promise<{ recorded: boolean }>;
    /** Stops the accounts with an alert unanswered past the limit; returns how many it stopped. */
    readonly sweepUnhandled: (now: Date) => Promise<number>;
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
): string[] =>
  comments
    // A comment with no time is new only for a post that has never been looked at.
    .filter((comment) =>
      floor === null ? true : comment.createdAt !== null && comment.createdAt.getTime() > floor.getTime(),
    )
    .slice(0, MARKETING_COMMENT_MAX_PER_POST)
    .map((comment) => comment.text.slice(0, MARKETING_COMMENT_BODY_MAX_CHARS));

export async function runMarketingCommentsMonitor(
  deps: MarketingCommentsMonitorDeps,
): Promise<MarketingCommentsMonitorResult> {
  if (!deps.enabled(deps.env)) return { ran: false, reason: "switch_off" };
  if (deps.classifier === null) return { ran: false, reason: "classifier_unavailable" };

  const { operations } = deps;
  const posts = await operations.listPosts(MARKETING_COMMENT_MONITOR_POST_LIMIT);
  let postsUnread = 0;
  let alertsRecorded = 0;

  for (const post of posts) {
    const floor = await operations.alertFloor(post.id);
    const page = await deps.fetchComments(post);
    if (page.kind !== "ok") {
      postsUnread += 1;
      continue;
    }
    const bodies = marketingCommentBodiesForModel(page.comments, floor);
    if (bodies.length === 0) continue;
    let verdicts: ReadonlyArray<ReadonlyArray<string>>;
    try {
      verdicts = await deps.classifier(bodies);
    } catch {
      postsUnread += 1;
      continue;
    }
    // An answer of the wrong shape is no answer: nothing is concluded from it.
    if (!Array.isArray(verdicts) || verdicts.length !== bodies.length) {
      postsUnread += 1;
      continue;
    }
    const flagged = verdicts.map((codes) => knownCodes(Array.isArray(codes) ? codes : []));
    const alertCount = flagged.filter((codes) => codes.length > 0).length;
    if (alertCount === 0) continue;
    const riskCodes = MARKETING_COMMENT_RISK_CODES.filter((code) => flagged.some((codes) => codes.includes(code)));
    const outcome = await operations.recordAlert({
      postId: post.id,
      alertCount,
      riskCodes,
      detectedAt: deps.now(),
    });
    if (outcome.recorded) alertsRecorded += 1;
  }

  // Whether or not every post was read: an alert already open does not wait for
  // the monitor to be perfect before it counts against the account.
  const accountsStopped = await operations.sweepUnhandled(deps.now());
  const complete = postsUnread === 0;
  if (complete) await operations.recordRun(deps.now());
  return {
    ran: true,
    postsChecked: posts.length,
    postsUnread,
    alertsRecorded,
    accountsStopped,
    complete,
  };
}
