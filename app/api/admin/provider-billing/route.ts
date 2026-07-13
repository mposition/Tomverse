export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { setProviderBillingProfile } from "@/lib/providerBilling";
import type {
  ProviderPricingModel,
  ProviderSettlementModel,
} from "@/lib/providerBillingTypes";
import type { AiProvider } from "@/lib/models";
import {
  getProviderHealthDashboard,
  MONITORED_PROVIDERS,
} from "@/lib/providerMonitoring";

const pricingModels = [
  "usage_based",
  "subscription",
  "committed_capacity",
  "unknown",
] as const;
const settlementModels = [
  "prepaid",
  "postpaid",
  "hybrid",
  "invoice",
  "unknown",
] as const;

const providerBillingSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .refine(
        (value) => MONITORED_PROVIDERS.includes(value as AiProvider),
        "Unsupported provider."
      ),
    pricingModel: z.enum(pricingModels),
    settlementModel: z.enum(settlementModels),
    currency: z.literal("USD"),
    monthlyLimitUsd: z.number().finite().min(0).max(1_000_000).nullable(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "billing:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-provider-billing-write", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 4 * 1024, providerBillingSchema);
    const provider = body.provider as AiProvider;
    const note = body.note?.trim() || null;
    const monthlyLimitMicroUsd =
      body.monthlyLimitUsd === null
        ? null
        : BigInt(Math.round(body.monthlyLimitUsd * 1_000_000));

    await setProviderBillingProfile({
      provider,
      pricingModel: body.pricingModel as ProviderPricingModel,
      settlementModel: body.settlementModel as ProviderSettlementModel,
      currency: body.currency,
      monthlyLimitMicroUsd,
      note,
      updatedById: session.user.id,
      updatedByEmail: session.user.email || null,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "provider_billing.profile_updated",
      targetType: "ProviderBillingConfig",
      targetId: provider,
      summary: `Updated ${provider} provider billing profile.`,
      metadata: {
        provider,
        pricingModel: body.pricingModel,
        settlementModel: body.settlementModel,
        currency: body.currency,
        monthlyLimitUsd: body.monthlyLimitUsd,
        hasNote: Boolean(note),
      },
    });

    const dashboard = await getProviderHealthDashboard({ includeErrorEvents: true });
    return NextResponse.json(dashboard, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update provider billing profile:", error);
    return NextResponse.json(
      { error: "Failed to update provider billing profile." },
      { status: 500 }
    );
  }
}
