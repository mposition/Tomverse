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
  getMemoryExtractionRevokedPairs,
  getPublicAppSettings,
  isAssistantKnowledgeEnabled,
  isAssistantProfilesEnabled,
  isExternalContinuationEnabled,
  isExternalImportEnabled,
  isImageGenerationEnabled,
  isMemoryExtractionEnabled,
  isMemoryInjectionEnabled,
  isValidGuestDefaultModel,
  setAssistantKnowledgeEnabled,
  setAssistantProfilesEnabled,
  setExternalContinuationEnabled,
  setExternalImportEnabled,
  setImageGenerationEnabled,
  updatePublicAppSettings,
} from "@/lib/appSettings";
import { injectableExtractionPairs } from "@/lib/memoryInjectionGate";
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
    // Opt-in beta flag, NOT one of the default-on kill switches above -- it
    // is stored and resolved separately (lib/imageGenerationAccess.ts).
    imageGenerationEnabled: z.boolean(),
    // Same opt-in shape (lib/externalImportAccess.ts): the Release A import
    // rollout flag, default-off and fail-closed.
    externalConversationImportEnabled: z.boolean(),
    // "Tomverse에서 이어가기" (lib/externalContinuationAccess.ts), also
    // default-off and fail-closed. Its own switch rather than a rider on the
    // import flag: import is already on in production, so sharing that flag
    // would turn this on for every importing account at the moment it shipped
    // (docs/policy/external-conversation-continuation.md §7).
    //
    // It IS here, unlike the two memory flags below, because turning it on is
    // an operational decision with a staging checklist behind it -- not the
    // human procedure of
    // docs/policy/external-conversation-import-and-memory.md §12.4 that the
    // memory flags' absence protects.
    externalConversationContinuationEnabled: z.boolean(),
    // Release C rollout flags (lib/assistantProfileAccess.ts). Two switches
    // and not one: policy §15 enables profiles before knowledge, and the
    // knowledge flag reads as off on its own while profiles are off.
    assistantProfilesEnabled: z.boolean(),
    assistantKnowledgeEnabled: z.boolean(),
    // The two Release B memory flags are deliberately NOT here, and `.strict()`
    // is what enforces it: a request naming either one is refused rather than
    // ignored. Enabling account memory is the policy §12.4 human procedure --
    // a decision-grade eval, blind review, an independent re-run, a signed
    // approval, a register merge and a staging verification -- and a checkbox
    // would be that procedure's last step without its first six. Registered as
    // a deliberate absence in tests/appSettingWriters.test.mjs; their *values*
    // are reported by GET below, because refusing to write them is not a reason
    // to leave an operator guessing what they are.
  })
  .strict();

/**
 * The Release B memory flags as facts, for the read-only panel.
 *
 * The stored flag is only half of what decides whether memory does anything.
 * The other half is whether any register pair is approved and un-revoked, and
 * with none both flags are inert whatever they say: extraction answers
 * MEMORY_EXTRACTION_PAIR_UNAVAILABLE to every run, and injection refuses with
 * `no_approved_pair` immediately after reading the flag. Reporting the flags
 * without that count would show two switches whose position explains nothing.
 */
const memoryReleaseStatus = async () => {
  const [extractionEnabled, injectionEnabled, revokedPairs] = await Promise.all([
    isMemoryExtractionEnabled(),
    isMemoryInjectionEnabled(),
    getMemoryExtractionRevokedPairs(),
  ]);
  return {
    memoryExtractionEnabled: extractionEnabled,
    memoryInjectionEnabled: injectionEnabled,
    // Effective, not registered: approved AND not operationally revoked, which
    // is the number both runtime gates actually consult.
    memoryApprovedPairCount: injectableExtractionPairs(revokedPairs).length,
  };
};

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
    return NextResponse.json({
      settings,
      imageGenerationEnabled: await isImageGenerationEnabled(),
      externalConversationImportEnabled: await isExternalImportEnabled(),
      externalConversationContinuationEnabled:
        await isExternalContinuationEnabled(),
      assistantProfilesEnabled: await isAssistantProfilesEnabled(),
      assistantKnowledgeEnabled: await isAssistantKnowledgeEnabled(),
      ...(await memoryReleaseStatus()),
    });
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
    const {
      imageGenerationEnabled,
      externalConversationImportEnabled,
      externalConversationContinuationEnabled,
      assistantProfilesEnabled,
      assistantKnowledgeEnabled,
      ...publicSettings
    } = body;
    const settings = await updatePublicAppSettings(publicSettings);
    await setImageGenerationEnabled(imageGenerationEnabled);
    await setExternalImportEnabled(externalConversationImportEnabled);
    await setExternalContinuationEnabled(
      externalConversationContinuationEnabled
    );
    await setAssistantProfilesEnabled(assistantProfilesEnabled);
    await setAssistantKnowledgeEnabled(assistantKnowledgeEnabled);
    await writeAdminAuditLog({
      session,
      request: req,
      // Renamed from `app_settings.guest_default_model.updated`. That name
      // described one of the eight settings this handler writes, while the
      // summary beside it described all of them, so an auditor filtering by
      // action was misled twice over: past the feature-flag change they were
      // looking for, and into reading a guest-default change that had not
      // happened. Observed on 2026-08-23 while turning
      // `assistantKnowledgeEnabled` on in production. Rows written before this
      // keep the old action, which is what an audit log is for.
      action: "app_settings.update_completed",
      targetType: "AppSettings",
      targetId: "public",
      summary: `Updated platform defaults and operational feature flags.`,
      metadata: body,
    });
    return NextResponse.json({
      settings,
      imageGenerationEnabled: await isImageGenerationEnabled(),
      externalConversationImportEnabled: await isExternalImportEnabled(),
      externalConversationContinuationEnabled:
        await isExternalContinuationEnabled(),
      assistantProfilesEnabled: await isAssistantProfilesEnabled(),
      assistantKnowledgeEnabled: await isAssistantKnowledgeEnabled(),
      // Unchanged by this request -- nothing above writes them -- and returned
      // anyway so the panel's read-only card is not left showing what it read
      // on page open while every field beside it has been refreshed.
      ...(await memoryReleaseStatus()),
    });
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
