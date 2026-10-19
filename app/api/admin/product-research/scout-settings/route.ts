export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { SCOUT_DAILY_CALL_CAP_MAX } from "@/lib/productResearchScoutCore";
import { scoutModelOptions } from "@/lib/productResearchScoutLlm";
import { readScoutSettings, writeScoutSettings } from "@/lib/productResearchScoutSettings";

// Admin › Engineering agent › Product research: which model the Scout uses
// and how many model calls it may make per UTC day
// (docs/policy/product-research-agent.md §13). Both decide spending, so only
// an owner with a recent sign-in may change them, and the change is audited
// with its before and after. A null model turns the step off.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const updateSchema = z
  .object({
    modelId: z.string().trim().min(1).max(120).nullable(),
    dailyCallCap: z.number().int().min(0).max(SCOUT_DAILY_CALL_CAP_MAX),
  })
  .strict();

export async function PUT(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return json({ error: "Not found." }, 404);
    if (getAdminRole(session) !== "owner") return json({ error: "Forbidden." }, 403);
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
      throw error;
    }
    await consumeApiRateLimit(request, session.user.id, "admin-product-research-scout-settings", { minute: 10, day: 100 });

    const next = await readLimitedJson(request, 1_024, updateSchema);
    if (next.modelId !== null && !(await scoutModelOptions()).some((option) => option.id === next.modelId)) {
      return json({ error: "That model is not an enabled model that reads images." }, 400);
    }
    const before = await readScoutSettings();
    await writeScoutSettings(next, (tx) =>
      writeAdminAuditLog({
        session,
        request,
        action: "product_research.scout.settings_updated",
        targetType: "app_setting",
        targetId: "productResearch.scout",
        summary: "Scout model and daily call cap updated",
        metadata: { before, after: next },
        tx,
      }),
    );
    return json({ settings: next });
  } catch (error) {
    const approval = adminApprovalErrorResponse(error);
    if (approval) return approval;
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error(JSON.stringify({ event: "product_research_scout_settings_failed" }));
    return json({ error: "Failed to save the setting." }, 500);
  }
}
