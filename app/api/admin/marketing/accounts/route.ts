export const dynamic = "force-dynamic";

import { z } from "zod";
import {
  MARKETING_LOCALES,
  MARKETING_PROVIDERS,
} from "@/lib/marketingAutomationSchema";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_S2B1_ACTIONS,
  createMarketingChannel,
} from "@/lib/marketingStore";
import { MARKETING_CHANNEL_CAPS } from "@/lib/marketingAutomationSchema";

const schema = z
  .object({
    channel: z.enum(
      Object.keys(MARKETING_CHANNEL_CAPS) as [string, ...string[]]
    ),
    provider: z.enum(MARKETING_PROVIDERS),
    externalAccountRef: z.string().trim().min(1).max(200).nullable(),
    defaultLocale: z.enum(MARKETING_LOCALES),
    allowedLocales: z.array(z.enum(MARKETING_LOCALES)).min(1).max(8),
    scopesDigest: z.string().regex(/^[0-9a-f]{64}$/),
    policyVersion: z.number().int().positive(),
  })
  .strict();

/**
 * POST: an operator registers a brand account
 * (docs/policy/marketing-automation.md §6, §8.2).
 *
 * The account slug is not accepted from the body. The store assigns
 * `{channel}-{n}` from the next free number, because the alternative is an
 * operator typing something and the thing nearest to hand is the account's
 * public handle -- which the CHECK constraint refuses anyway.
 *
 * A new account starts in `connect_pending`. It publishes nothing until the
 * connection is confirmed and, beyond that, until it is graduated in S4.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2B1_ACTIONS.accountCreate,
    targetType: "MarketingChannel",
    summary: "Registered a marketing brand account.",
    gate: "account_control",
    bucket: "admin-marketing-account-create",
    schema,
    metadata: (body) => ({
      channel: body.channel,
      provider: body.provider,
      defaultLocale: body.defaultLocale,
      policyVersion: body.policyVersion,
    }),
    run: async (tx, { body }) => {
      const row = await createMarketingChannel(tx, {
        channel: body.channel as never,
        provider: body.provider,
        externalAccountRef: body.externalAccountRef,
        defaultLocale: body.defaultLocale,
        allowedLocales: body.allowedLocales,
        scopesDigest: body.scopesDigest,
        policyVersion: body.policyVersion,
      });
      return { id: row.id, accountSlug: row.accountSlug, status: row.status };
    },
  });
}
