/**
 * Loading a template, which means proving one.
 *
 * Contract: docs/policy/marketing-automation.md O4 and §8.2, as amended by the
 * S1 plan (NB2 and r4 amendment 5). A template is the only route to
 * `autonomous_eligible`: a post published without a human looking at it is
 * published because a human already approved these exact words and then marked
 * them reusable. So a template is not a row in a code file -- it is a
 * `MarketingPost` whose approval chain can be walked, and this module walks it.
 *
 * Two audit entries, not one, and the second is the whole point. `approve` says
 * a person accepted this content once. `mark_reusable` says the same person
 * accepted it being published again without them. Those are different
 * decisions, and collapsing them would make every approved post a template.
 *
 * What is checked, and why each part is load-bearing:
 *
 * - the post is in a state that means it was approved and is still whole:
 *   approved or further along, not purged, not deleted;
 * - `envelopeDigest = approvedDigest`, so the content now is the content that
 *   was approved. Any edit changes the digest and the template stops resolving
 *   until somebody approves and marks the new words;
 * - both audit rows name this post, carry the approved digest, have a human
 *   actor with `marketing:write` recorded, and verify against the hash chain;
 * - the marking is *after* the approval, in time and in the chain. A marking
 *   that preceded the approval would be a decision about content that did not
 *   exist yet;
 * - the history carries no edit after the version the marking recorded. The
 *   digest check already catches an edit that changed the words; this catches
 *   the record of one, so the two answers cannot disagree.
 *
 * **In S1 no template resolves.** Nothing writes `marketing_post.approve` or
 * `marketing_post.mark_reusable` -- those routes are S2 -- so every call
 * returns a refusal and `autonomous_eligible` is unreachable in production.
 * That is the intended state, and the tests build the chains by hand to prove
 * the verifier would accept a real one and refuse each way of faking it.
 */

import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  marketingHistorySchema,
  type MarketingHistoryEntry,
} from "@/lib/marketingAutomationSchema";
import { verifyMarketingAuditEvidence } from "@/lib/marketingAuditEvidence";

export type MarketingTemplateReader = PrismaClient | Prisma.TransactionClient;

/** The audit actions a template's proof is made of. */
export const MARKETING_POST_APPROVE_ACTION = "marketing_post.approve";
export const MARKETING_POST_MARK_REUSABLE_ACTION = "marketing_post.mark_reusable";
/** The action an edit names, so an edit can be placed in the audit chain. */
export const MARKETING_POST_EDIT_ACTION = "marketing_post.edit";

/** The post states in which an approved template still stands. */
export const MARKETING_TEMPLATE_POST_STATUSES = Object.freeze([
  "approved",
  "scheduled",
  "published",
  "verified",
] as const);

/** Why a template is not usable. Codes, because the Guard records them. */
export type MarketingTemplateRefusal =
  | "post_missing"
  | "not_marked_reusable"
  | "post_state_unusable"
  | "content_purged"
  | "post_deleted"
  | "content_changed_since_approval"
  | "approval_missing"
  | "approval_not_evidence"
  | "marking_missing"
  | "marking_not_evidence"
  | "marking_precedes_approval"
  | "marking_version_missing"
  | "edited_since_marking"
  /** An edit whose audit row does not prove it, so it cannot be placed. */
  | "edit_not_datable"
  /** A history that does not parse, which the store cannot produce. */
  | "history_unreadable";

export type MarketingTemplate = {
  id: string;
  channelId: string;
  locale: string;
  envelopeDigest: string;
  approvedAt: Date;
  markedReusableAt: Date;
};

export type MarketingTemplateResult =
  | { ok: true; template: MarketingTemplate }
  | { ok: false; refusal: MarketingTemplateRefusal };

const metadataNumber = (metadata: unknown, key: string): number | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

/**
 * The history entries that mean the content was changed by a person.
 *
 * `draft` is the first write and `guard_result`, `attempt`, `webhook_event` and
 * the retention entries record things that happened *to* the post rather than
 * changes to what it says.
 */
type MarketingEditEntry = Extract<
  MarketingHistoryEntry,
  { type: "edit_revision" }
>;

const isEdit = (entry: MarketingHistoryEntry): entry is MarketingEditEntry =>
  entry.type === "edit_revision";

/**
 * Load a template by the id of the post that is one, proving it on the way.
 *
 * Returns a refusal rather than throwing: an unusable template is an ordinary
 * answer for the Guard, which then treats the draft as free copy and sends it
 * to a human.
 */
export async function loadApprovedTemplate(
  database: MarketingTemplateReader,
  templateId: string,
): Promise<MarketingTemplateResult> {
  const post = await database.marketingPost.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      channelId: true,
      locale: true,
      status: true,
      reusableAsTemplate: true,
      envelopeDigest: true,
      approvedDigest: true,
      approvalAuditLogId: true,
      contentPurgedAt: true,
      deletedAt: true,
      history: true,
      historyVersion: true,
    },
  });

  if (!post) return { ok: false, refusal: "post_missing" };
  if (!post.reusableAsTemplate) {
    return { ok: false, refusal: "not_marked_reusable" };
  }
  if (
    !(MARKETING_TEMPLATE_POST_STATUSES as readonly string[]).includes(post.status)
  ) {
    return { ok: false, refusal: "post_state_unusable" };
  }
  if (post.contentPurgedAt) return { ok: false, refusal: "content_purged" };
  if (post.deletedAt) return { ok: false, refusal: "post_deleted" };

  if (!post.approvedDigest || post.approvedDigest !== post.envelopeDigest) {
    return { ok: false, refusal: "content_changed_since_approval" };
  }
  if (!post.approvalAuditLogId) {
    return { ok: false, refusal: "approval_missing" };
  }

  const approval = await verifyMarketingAuditEvidence(database, {
    auditLogId: post.approvalAuditLogId,
    action: MARKETING_POST_APPROVE_ACTION,
    targetId: post.id,
    metadata: { digest: post.approvedDigest },
  });
  if (!approval.ok) return { ok: false, refusal: "approval_not_evidence" };

  // The marking is found by what it says rather than by a column, because a
  // column naming it would be a third place the same fact lives.
  const marking = await database.adminAuditLog.findFirst({
    where: {
      action: MARKETING_POST_MARK_REUSABLE_ACTION,
      targetId: post.id,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, metadata: true },
  });
  if (!marking) return { ok: false, refusal: "marking_missing" };

  const markedVersion = metadataNumber(marking.metadata, "historyVersion");
  if (markedVersion === null) {
    return { ok: false, refusal: "marking_version_missing" };
  }

  const markingEvidence = await verifyMarketingAuditEvidence(database, {
    auditLogId: marking.id,
    action: MARKETING_POST_MARK_REUSABLE_ACTION,
    targetId: post.id,
    metadata: { digest: post.approvedDigest },
  });
  if (!markingEvidence.ok) return { ok: false, refusal: "marking_not_evidence" };

  if (marking.createdAt.getTime() <= approval.createdAt.getTime()) {
    return { ok: false, refusal: "marking_precedes_approval" };
  }

  // An edit recorded after the marking. The digest comparison above already
  // refuses content that changed; this refuses a history that says it did, so
  // the row cannot answer the two questions differently.
  //
  // **Ordered by the audit chain, because nothing else here is trustworthy.**
  // Two obvious inputs both fail. `historyVersion` is a compare-and-set
  // revision that the marking's own metadata asserts, so using it as an array
  // index trusts that assertion twice over: a marking taken at version zero can
  // record `1`, and an `edit_revision` appended at index 1 then falls outside
  // `slice(2)` while the post's version reads 1 as well. And `entry.at` is
  // supplied by whoever appended the entry (`lib/marketingStore.ts`), so a past
  // timestamp places an edit before a marking that followed it -- and comparing
  // a Node-written string against a database-written `createdAt` misjudges
  // ordinary clock skew in both directions besides.
  //
  // `AdminAuditLog.createdAt` is the one clock in this comparison that no
  // caller sets: `lib/adminAudit.ts` takes it from the database and forces it
  // strictly past the previous entry, so audit rows are totally ordered. An
  // `edit_revision` names the audit row that authorised it, so an edit can be
  // placed against the marking using only that ordering.
  //
  // **Each edit's row is verified, not merely read.** Taking the `createdAt` of
  // whatever row an id names would let an edit point at any older audit entry
  // in the table -- a login, another post's approval -- and be placed before
  // the marking by borrowing its time. So every edit's row has to verify as
  // evidence of *that* edit: the right action, this post, a human actor with
  // `marketing:write`, chain-valid, and carrying the digests the entry claims
  // to have moved between.
  //
  // Two edits naming one row refuse as well. An audit entry authorises one
  // edit; a second entry reusing it is either a copy or a way to give a later
  // edit an earlier time.
  //
  // The index scan stays beside it -- it is what r4 amendment 5 literally
  // describes, and the two disagree only when something is wrong.
  // A refusal rather than a throw. `byAuditLogId` is required by the schema, so
  // a history holding an entry without one can only have arrived by a write
  // that went around the store -- which is exactly the case where the Guard
  // wants an answer it can record rather than an exception.
  const parsedHistory = marketingHistorySchema.safeParse(post.history);
  if (!parsedHistory.success) {
    return { ok: false, refusal: "history_unreadable" };
  }
  const history = parsedHistory.data;
  const edits = history.filter(isEdit);

  const seenAuditIds = new Set<string>();
  let latestEditAt = 0;
  for (const entry of edits) {
    if (seenAuditIds.has(entry.byAuditLogId)) {
      return { ok: false, refusal: "edit_not_datable" };
    }
    seenAuditIds.add(entry.byAuditLogId);

    const evidence = await verifyMarketingAuditEvidence(database, {
      auditLogId: entry.byAuditLogId,
      action: MARKETING_POST_EDIT_ACTION,
      targetId: post.id,
      metadata: {
        digest: entry.envelopeDigest,
        previousDigest: entry.previousEnvelopeDigest,
      },
    });
    if (!evidence.ok) return { ok: false, refusal: "edit_not_datable" };

    latestEditAt = Math.max(latestEditAt, evidence.createdAt.getTime());
  }

  const markedAt = marking.createdAt.getTime();
  const editedSinceMarking =
    latestEditAt > markedAt ||
    history.slice(markedVersion + 1).some((entry) => isEdit(entry));
  if (editedSinceMarking || post.historyVersion < markedVersion) {
    return { ok: false, refusal: "edited_since_marking" };
  }

  return {
    ok: true,
    template: {
      id: post.id,
      channelId: post.channelId,
      locale: post.locale,
      envelopeDigest: post.envelopeDigest,
      approvedAt: approval.createdAt,
      markedReusableAt: marking.createdAt,
    },
  };
}
