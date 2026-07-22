export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  getPublicAppSettings,
  isValidGuestDefaultModel,
  updatePublicAppSettings,
} from "@/lib/appSettings";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const updateAppSettingsSchema = z
  .object({
    guestDefaultModelId: z.string().trim().min(1).max(120),
    aiChatEnabled: z.boolean(),
    attachmentsEnabled: z.boolean(),
    publicSharingEnabled: z.boolean(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-app-settings-read", {
      minute: 30,
      day: 500,
    });

    const settings = await getPublicAppSettings();
    return NextResponse.json({ settings });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin app settings:", error);
    return NextResponse.json(
      { error: "Failed to load app settings." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await assertRecentAdminAuthentication(session);

    await consumeApiRateLimit(req, session.user.id, "admin-app-settings-write", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 4 * 1024, updateAppSettingsSchema);
    if (!(await isValidGuestDefaultModel(body.guestDefaultModelId))) {
      return NextResponse.json(
        { error: "Guest default model must be an enabled guest-accessible Standard model." },
        { status: 400 }
      );
    }
    await writeAdminAuditLog({
      session,
      request: req,
      action: "app_settings.update_started",
      targetType: "AppSettings",
      targetId: "public",
      summary: "Started platform defaults and feature-flag update.",
      metadata: body,
    });
    const settings = await updatePublicAppSettings(body);
    await writeAdminAuditLog({
      session,
      request: req,
      action: "app_settings.guest_default_model.updated",
      targetType: "AppSettings",
      targetId: "public",
      summary: `Updated platform defaults and operational feature flags.`,
      metadata: body,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update admin app settings:", error);
    return NextResponse.json(
      { error: "Failed to update app settings." },
      { status: 500 }
    );
  }
}
