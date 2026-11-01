export const dynamic = "force-dynamic";

import { z } from "zod";
import { MARKETING_LOCALES } from "@/lib/marketingAutomationSchema";
import {
  MARKETING_ACCOUNT_LOCALES_ACTION,
  MarketingChannelLocalesRefusedError,
  changeMarketingChannelLocales,
} from "@/lib/marketingStore";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";

type RouteContext = { params: Promise<{ channelId: string }> };

const locale = z.enum(MARKETING_LOCALES);
const locales = z.array(locale).min(1).max(8);

const schema = z
  .object({
    expectedDefaultLocale: locale,
    expectedAllowedLocales: locales,
    defaultLocale: locale,
    allowedLocales: locales,
  })
  .strict();

/**
 * POST: the languages a brand account drafts and publishes in.
 *
 * Offered only while every post on the account is approved by a person, and
 * refused while a post in a language being removed could still go out
 * (docs/policy/marketing-automation.md §7.6: one account per language).
 */
export async function POST(req: Request, context: RouteContext) {
  const { channelId } = await context.params;
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_ACCOUNT_LOCALES_ACTION,
    targetType: "MarketingChannel",
    targetId: channelId,
    summary: "Changed a brand account's languages.",
    gate: "account_control",
    bucket: "admin-marketing-account-locales",
    schema,
    metadata: (body) => ({
      expectedDefaultLocale: body.expectedDefaultLocale,
      expectedAllowedLocales: body.expectedAllowedLocales,
      defaultLocale: body.defaultLocale,
      allowedLocales: body.allowedLocales,
    }),
    refusal: (error) =>
      error instanceof MarketingChannelLocalesRefusedError
        ? { code: error.code, status: error.status, message: error.message }
        : null,
    run: async (tx, { body }) => {
      const result = await changeMarketingChannelLocales(tx, {
        id: channelId,
        expectedDefaultLocale: body.expectedDefaultLocale,
        expectedAllowedLocales: body.expectedAllowedLocales,
        defaultLocale: body.defaultLocale,
        allowedLocales: body.allowedLocales,
      });
      return { id: channelId, ...result };
    },
  });
}
