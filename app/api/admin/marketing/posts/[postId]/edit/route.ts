export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { z } from "zod";
import { marketingEnvelopeSchema } from "@/lib/marketingAutomationSchema";
import { resolveMarketingFacts } from "@/lib/marketingFactResolution";
import { guardDraft } from "@/lib/marketingGuardCore";
import { resolveMarketingGuardContext } from "@/lib/marketingGuardContext";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  editMarketingPost,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z
  .object({
    expectedEnvelopeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedHistoryVersion: z.number().int().nonnegative(),
    envelope: marketingEnvelopeSchema,
  })
  .strict();

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)])
    );
  }
  return value;
};

/**
 * POST: a person edits a draft, and the edit is re-judged before it is stored
 * (docs/policy/marketing-automation.md §6, design F1).
 *
 * The edited words are not approved by this route and are not approved by the
 * edit. They go back through the Guard, against facts resolved now rather than
 * the ones the first draft was judged on, and the post carries the new
 * decision and a new digest -- so approving it afterwards is a decision about
 * what is actually there.
 *
 * That is why the facts are resolved here rather than reused: a claim's
 * registry version, a price row or a feature gate may have moved since the
 * draft was written, and an edit judged against the old answers would be an
 * edit nobody judged.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postEdit,
    targetType: "MarketingPost",
    targetId: postId,
    summary: "Edited a marketing draft and re-ran the Guard on it.",
    gate: "manual_approval",
    bucket: "admin-marketing-post-edit",
    schema,
    metadata: (body) => ({ digest: body.expectedEnvelopeDigest }),
    run: async (tx, { body, auditLogId }) => {
      const post = await tx.marketingPost.findUnique({
        where: { id: postId },
        select: { channelId: true, factSnapshot: true },
      });
      if (!post) {
        // The store would refuse it anyway; failing here keeps the message
        // about the post rather than about the edit.
        throw new Error(`Marketing post ${postId} does not exist`);
      }

      const envelope = body.envelope;
      const facts = await resolveMarketingFacts(tx, {
        claimIds: envelope.claimIds,
        assetIds: envelope.assets.map((asset) => asset.assetId),
        channelId: post.channelId,
        channel: envelope.channel,
        locale: envelope.locale,
        factSnapshotDigest: createHash("sha256")
          .update(JSON.stringify(canonical(post.factSnapshot)), "utf8")
          .digest("hex"),
      });

      const decision = guardDraft({
        draft: {
          renderedText: envelope.renderedText,
          locale: envelope.locale,
          channel: envelope.channel,
          channelId: post.channelId,
          claimIds: envelope.claimIds,
          assetIds: envelope.assets.map((asset) => asset.assetId),
        },
        facts,
        // No template: an edit is new copy by definition, and offering one here
        // would be offering a way to inherit a mark the edited words never had.
        templates: [],
        context: resolveMarketingGuardContext(),
      });

      await editMarketingPost(tx, {
        id: postId,
        expectedEnvelopeDigest: body.expectedEnvelopeDigest,
        expectedHistoryVersion: body.expectedHistoryVersion,
        envelope,
        decision,
        auditLogId,
      });
      return {
        id: postId,
        // The verdict and the rule ids, which every decision carries. The
        // codes belong to the two verdicts that have them, and an
        // autonomous-eligible decision has none to report.
        verdict: decision.verdict,
        ruleIds: decision.ruleIds,
      };
    },
  });
}
