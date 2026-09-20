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

/** The post states in which an approved template still stands. */
export const MARKETING_TEMPLATE_POST_STATUSES = [
  "approved",
  "scheduled",
  "published",
  "verified",
] as const;

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
  | "edited_since_marking";

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
const isEdit = (entry: MarketingHistoryEntry): boolean =>
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
  // `markedVersion + 1`, because a post starts at version zero with one entry:
  // the entry at index N is the one that existed *at* version N, and "after the
  // marking" begins at the next one. Slicing from `markedVersion` would count
  // the marking's own entry as something that happened since.
  const history = marketingHistorySchema.parse(post.history);
  const editedSinceMarking = history
    .slice(markedVersion + 1)
    .some((entry) => isEdit(entry));
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
