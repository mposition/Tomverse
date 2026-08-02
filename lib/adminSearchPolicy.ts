import { createHash } from "node:crypto";

/**
 * SEC-008. What the administrator global search is allowed to match on.
 *
 * The search ran `contains` over `Message.content` and `Conversation.title`.
 * Neither is displayed anywhere in the admin console, so matching on them was
 * not a way to find a record -- it was a substring oracle over every user's
 * private conversations. An administrator could type a fragment and learn,
 * from the presence of a result, that some user had written it, one guess at a
 * time, without ever opening a conversation and without leaving a trace.
 *
 * The fields kept below are either identifiers, or text the user deliberately
 * submitted *to the operator* (feedback bodies, refund reasons) and which the
 * console already renders in full. Searching those is ordinary support work.
 *
 * Declared as data rather than inline in the route so the exclusion is
 * assertable, and so adding a field is a visible edit to a policy rather than
 * one more line in a 150-line query.
 */

export type AdminSearchRecord =
  | "user"
  | "feedback"
  | "refundRequest"
  | "adminAuditLog"
  | "conversation"
  | "message"
  | "chatLimitDecisionEvent";

export const ADMIN_SEARCH_FIELDS: Record<AdminSearchRecord, readonly string[]> =
  {
    user: [
      "id",
      "email",
      "name",
      "stripeCustomerId",
      "stripeSubscriptionId",
    ],
    // `message` here is the feedback body the user sent to support, not a chat
    // message. The console shows it in full on the feedback page.
    feedback: ["id", "email", "traceId", "modelId", "message"],
    refundRequest: [
      "id",
      "email",
      "stripeCustomerId",
      "stripeSubscriptionId",
      "reason",
    ],
    adminAuditLog: [
      "actorEmail",
      "action",
      "targetType",
      "targetId",
      "summary",
    ],
    // Identifiers only. `title` is generated from the user's first message, so
    // matching it is the same oracle at lower resolution.
    conversation: ["id", "shareToken"],
    // Identifiers only. `content` is the private conversation body.
    message: ["id", "modelId"],
    chatLimitDecisionEvent: ["traceId"],
  };

/**
 * Fields that must never appear above, whatever else changes. Listed
 * explicitly so a future edit that re-adds one fails a test instead of quietly
 * restoring the oracle.
 */
export const ADMIN_SEARCH_FORBIDDEN_FIELDS: Partial<
  Record<AdminSearchRecord, readonly string[]>
> = {
  message: ["content"],
  conversation: ["title"],
};

/** Builds the Prisma `OR` clause for one record type from the policy. */
export const adminSearchWhere = (record: AdminSearchRecord, query: string) => ({
  OR: ADMIN_SEARCH_FIELDS[record].map((field) => ({
    [field]: { contains: query, mode: "insensitive" as const },
  })),
});

/**
 * The value written to the audit trail in place of the query itself.
 *
 * A plain-text audit row would turn the audit log into a transcript of every
 * probe -- readable by the next administrator, and exported with the log. The
 * digest still makes repeated probing of the same term visible, still ties a
 * search to an actor and a time, and can be recomputed against a specific
 * suspected term during an investigation. It is keyed so the digests are not
 * reversible with a dictionary of likely search terms.
 */
export const hashAdminSearchQuery = (query: string, secret: string | undefined) =>
  createHash("sha256")
    .update(`admin-search:${secret || "unkeyed"}:${query.toLowerCase()}`)
    .digest("base64url")
    .slice(0, 22);
