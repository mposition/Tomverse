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
import type { AiProvider } from "@/lib/models";
import {
  getProviderHealthDashboard,
  MONITORED_PROVIDERS,
} from "@/lib/providerMonitoring";
import { setProviderCreditCheckpoint } from "@/lib/providerCredits";

const providerCreditSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .refine(
        (value) => MONITORED_PROVIDERS.includes(value as AiProvider),
        "Unsupported provider."
      ),
    creditUsd: z.number().finite().min(0).max(1_000_000),
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

    await consumeApiRateLimit(req, session.user.id, "admin-provider-credit-write", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 4 * 1024, providerCreditSchema);
    const provider = body.provider as AiProvider;
    const creditMicroUsd = BigInt(Math.round(body.creditUsd * 1_000_000));
    const note = body.note?.trim() || null;

    await setProviderCreditCheckpoint({
      provider,
      creditMicroUsd,
      note,
      updatedById: session.user.id,
      updatedByEmail: session.user.email || null,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "provider_credit.checkpoint_updated",
      targetType: "ProviderCreditConfig",
      targetId: provider,
      summary: `Updated ${provider} provider credit checkpoint.`,
      metadata: {
        provider,
        creditUsd: Math.round(body.creditUsd * 1_000_000) / 1_000_000,
        hasNote: Boolean(note),
      },
    });

    const dashboard = await getProviderHealthDashboard();
    return NextResponse.json(dashboard, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update provider credit checkpoint:", error);
    return NextResponse.json(
      { error: "Failed to update provider credit checkpoint." },
      { status: 500 }
    );
  }
}
