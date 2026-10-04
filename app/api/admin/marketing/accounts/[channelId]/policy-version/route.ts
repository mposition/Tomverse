export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_S2B1_ACTIONS,
  changeMarketingChannelPolicyVersion,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({
    expectedPolicyVersion: z.number().int().positive(),
    expectedScopesDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedGraduationEpoch: z.number().int().nonnegative(),
    policyVersion: z.number().int().positive(),
  })
  .strict();

/**
 * POST: the platform policy version this account was graduated under changed.
 *
 * Same shape as a scope change and for the same reason: the graduation was
 * about the old policy, so it does not carry over.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountPolicyVersionChanged,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Recorded a change to a brand account's policy version.",
    gate: "account_control",
    bucket: "admin-marketing-account-policy",
    schema,
    metadata: (body) => ({ policyVersion: body.policyVersion }),
    run: async (tx, { body }) => {
      await changeMarketingChannelPolicyVersion(tx, {
        id: channelId,
        expectedPolicyVersion: body.expectedPolicyVersion,
        expectedScopesDigest: body.expectedScopesDigest,
        expectedGraduationEpoch: body.expectedGraduationEpoch,
        policyVersion: body.policyVersion,
      });
      return { id: channelId };
    },
  });
}
