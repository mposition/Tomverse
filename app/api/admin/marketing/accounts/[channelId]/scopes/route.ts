export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_S2B1_ACTIONS,
  changeMarketingChannelScopes,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const schema = z
  .object({
    expectedScopesDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedPolicyVersion: z.number().int().positive(),
    expectedGraduationEpoch: z.number().int().nonnegative(),
    scopesDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * POST: the account's granted scopes changed.
 *
 * The trigger treats a different scopes digest as a change of identity: the
 * account returns to `approval_mode` and its graduation epoch moves, because
 * what was graduated was an account with the old scopes.
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountScopesChanged,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Recorded a change to a brand account's scopes.",
    gate: "operator_restriction",
    bucket: "admin-marketing-account-scopes",
    schema,
    metadata: (body) => ({
      expectedScopesDigest: body.expectedScopesDigest,
      scopesDigest: body.scopesDigest,
      expectedGraduationEpoch: body.expectedGraduationEpoch,
    }),
    run: async (tx, { body }) => {
      await changeMarketingChannelScopes(tx, {
        id: channelId,
        expectedScopesDigest: body.expectedScopesDigest,
        expectedPolicyVersion: body.expectedPolicyVersion,
        expectedGraduationEpoch: body.expectedGraduationEpoch,
        scopesDigest: body.scopesDigest,
      });
      return { id: channelId };
    },
  });
}
