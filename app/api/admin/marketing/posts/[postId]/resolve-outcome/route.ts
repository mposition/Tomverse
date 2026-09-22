export const dynamic = "force-dynamic";

import { z } from "zod";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  resolveMarketingPostOutcomeUnknown,
} from "@/lib/marketingStore";

type RouteContext = { params: Promise<{ postId: string }> };

const schema = z.discriminatedUnion("resolution", [
  z
    .object({
      resolution: z.literal("published"),
      expectedHistoryVersion: z.number().int().nonnegative(),
      externalPostId: z.string().trim().min(1).max(200),
      externalUrl: z.string().url().startsWith("https://").max(2000),
      /** What the person looked at, named so the record can be followed. */
      evidenceRef: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      resolution: z.literal("failed"),
      expectedHistoryVersion: z.number().int().nonnegative(),
      errorCode: z.string().trim().min(1).max(120),
      evidenceRef: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

/**
 * POST: a person settles a publish whose outcome nobody could confirm
 * (docs/policy/marketing-automation.md §2, §4).
 *
 * `outcome_unknown` is never retried and never resolved automatically: the
 * publisher could not tell whether the post went out, and guessing either way
 * is how a platform ends up with two copies or with silence recorded as
 * success. So this exists, a person looks, and what they looked at is named in
 * the record.
 *
 * Not a narrowing: resolving to `published` marks the post live, so the kill
 * switch reaches it.
 */
export async function POST(req: Request, context: RouteContext) {
  const { postId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.postResolveOutcomeUnknown,
    targetType: "MarketingPost",
    targetId: postId,
    summary: (body) =>
      body.resolution === "published"
        ? "Confirmed an unconfirmed marketing post went out."
        : "Confirmed an unconfirmed marketing post did not go out.",
    gate: "account_control",
    bucket: "admin-marketing-post-resolve-outcome",
    schema,
    metadata: (body) => ({
      resolution: body.resolution,
      evidenceRef: body.evidenceRef,
      historyVersion: body.expectedHistoryVersion,
    }),
    run: async (tx, { body, auditLogId }) => {
      await resolveMarketingPostOutcomeUnknown(
        tx,
        body.resolution === "published"
          ? {
              id: postId,
              expectedHistoryVersion: body.expectedHistoryVersion,
              resolution: "published",
              externalPostId: body.externalPostId,
              externalUrl: body.externalUrl,
              evidenceRef: body.evidenceRef,
              auditLogId,
            }
          : {
              id: postId,
              expectedHistoryVersion: body.expectedHistoryVersion,
              resolution: "failed",
              errorCode: body.errorCode,
              evidenceRef: body.evidenceRef,
              auditLogId,
            }
      );
      return { id: postId, resolution: body.resolution };
    },
  });
}
