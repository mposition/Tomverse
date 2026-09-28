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
  guestDefaultModelRejection,
  setAssistantKnowledgeEnabled,
  setAssistantProfilesEnabled,
  setExternalContinuationEnabled,
  setExternalImportEnabled,
  isChatStarterEnabled,
  setChatStarterEnabled,
  setImageGenerationEnabled,
  updateGuestDefaultModel,
  updateOperationalFeatureFlags,
  updatePublicAppSettings,
} from "@/lib/appSettings";
import { injectableExtractionPairs } from "@/lib/memoryInjectionGate";
import { readGuestLeadFacts } from "@/lib/guestLeadFacts";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const updateAppSettingsSchema = z
  .object({
    // Optional so a guest-lead save and a feature-flag save are different
    // requests. One request that carries an invalid lead used to refuse the
    // emergency switches in the same body.
    guestDefaultModelId: z.string().trim().min(1).max(120).optional(),
    aiChatEnabled: z.boolean().optional(),
    attachmentsEnabled: z.boolean().optional(),
    publicSharingEnabled: z.boolean().optional(),
    // Opt-in beta flag, NOT one of the default-on kill switches above -- it
    // is stored and resolved separately (lib/imageGenerationAccess.ts).
    imageGenerationEnabled: z.boolean().optional(),
    // Same opt-in shape (lib/externalImportAccess.ts): the Release A import
    // rollout flag, default-off and fail-closed.
    externalConversationImportEnabled: z.boolean().optional(),
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
    externalConversationContinuationEnabled: z.boolean().optional(),
    // The Chat welcome screen's starter catalogue
    // (docs/ui-contracts/chat-starter-catalog.md). Same default-off opt-in
    // shape as the flags above, and it IS here rather than registered
    // read-only: turning it on calls no provider and spends no credit, and
    // the only claim a card can make has already been proved by
    // `npm run check:starter-catalog`. There is no activation procedure for a
    // checkbox to skip past.
    chatStarterEnabled: z.boolean().optional(),
    // Release C rollout flags (lib/assistantProfileAccess.ts). Two switches
    // and not one: policy §15 enables profiles before knowledge, and the
    // knowledge flag reads as off on its own while profiles are off.
    assistantProfilesEnabled: z.boolean().optional(),
    assistantKnowledgeEnabled: z.boolean().optional(),
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

const PLATFORM_FLAG_KEYS = [
  "aiChatEnabled",
  "attachmentsEnabled",
  "publicSharingEnabled",
  "imageGenerationEnabled",
  "externalConversationImportEnabled",
  "externalConversationContinuationEnabled",
  "chatStarterEnabled",
  "assistantProfilesEnabled",
  "assistantKnowledgeEnabled",
] as const;

const appSettingsWriteSchema = updateAppSettingsSchema.superRefine((value, ctx) => {
  const present = PLATFORM_FLAG_KEYS.filter((key) => value[key] !== undefined);
  if (present.length !== 0 && present.length !== PLATFORM_FLAG_KEYS.length) {
    ctx.addIssue({
      code: "custom",
      message: "Feature flags are saved together.",
    });
  }
  if (present.length === 0 && !value.guestDefaultModelId) {
    ctx.addIssue({
      code: "custom",
      message: "Nothing to save.",
    });
  }
});

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

    const [settings, guestLead] = await Promise.all([
      getPublicAppSettings(),
      readGuestLeadFacts(),
    ]);
    return NextResponse.json({
      settings,
      guestLead,
      imageGenerationEnabled: await isImageGenerationEnabled(),
      externalConversationImportEnabled: await isExternalImportEnabled(),
      externalConversationContinuationEnabled:
        await isExternalContinuationEnabled(),
      assistantProfilesEnabled: await isAssistantProfilesEnabled(),
      assistantKnowledgeEnabled: await isAssistantKnowledgeEnabled(),
      chatStarterEnabled: await isChatStarterEnabled(),
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

    const body = await readLimitedJson(req, 4 * 1024, appSettingsWriteSchema);
    const leadId = body.guestDefaultModelId;
    const writesFlags = typeof body.aiChatEnabled === "boolean";
    if (leadId) {
      const rejection = await guestDefaultModelRejection(leadId);
      if (rejection) {
        return NextResponse.json({ error: rejection }, { status: 400 });
      }
    }
    const auditScope = leadId && writesFlags ? "both" : leadId ? "lead" : "flags";
    // A combined write keeps the broad action. That name was widened on
    // purpose: the old guest-only action hid a feature-flag change and
    // invented a guest-default change that had not happened (2026-08-23,
    // assistantKnowledgeEnabled). A lead-only or flags-only write uses its
    // own action, because the broad summary would now be the lie.
    const auditCopy = {
      lead: {
        startedAction: "app_settings.guest_default_model.update_started",
        completedAction: "app_settings.guest_default_model.update_completed",
        started: "Started guest leading-model update.",
        completed: "Updated the guest leading model.",
      },
      flags: {
        startedAction: "app_settings.feature_flags.update_started",
        completedAction: "app_settings.feature_flags.update_completed",
        started: "Started operational feature-flag update.",
        completed: "Updated operational feature flags.",
      },
      both: {
        startedAction: "app_settings.update_started",
        completedAction: "app_settings.update_completed",
        started: "Started platform defaults and feature-flag update.",
        completed: "Updated platform defaults and operational feature flags.",
      },
    }[auditScope];
    await writeAdminAuditLog({
      session,
      request: req,
      action: auditCopy.startedAction,
      targetType: "AppSettings",
      targetId: "public",
      summary: auditCopy.started,
      metadata: body,
    });
    if (leadId && !writesFlags) {
      await updateGuestDefaultModel(leadId);
    }
    if (writesFlags && body.aiChatEnabled !== undefined && body.attachmentsEnabled !== undefined && body.publicSharingEnabled !== undefined) {
      const flags = {
        aiChatEnabled: body.aiChatEnabled,
        attachmentsEnabled: body.attachmentsEnabled,
        publicSharingEnabled: body.publicSharingEnabled,
      };
      if (leadId) {
        await updatePublicAppSettings({ guestDefaultModelId: leadId, ...flags });
      } else {
        await updateOperationalFeatureFlags(flags);
      }
    }
    const {
      chatStarterEnabled,
      imageGenerationEnabled,
      externalConversationImportEnabled,
      externalConversationContinuationEnabled,
      assistantProfilesEnabled,
      assistantKnowledgeEnabled,
    } = body;
    if (
      writesFlags &&
      imageGenerationEnabled !== undefined &&
      externalConversationImportEnabled !== undefined &&
      externalConversationContinuationEnabled !== undefined &&
      assistantProfilesEnabled !== undefined &&
      assistantKnowledgeEnabled !== undefined &&
      chatStarterEnabled !== undefined
    ) {
      await setImageGenerationEnabled(imageGenerationEnabled);
      await setExternalImportEnabled(externalConversationImportEnabled);
      await setExternalContinuationEnabled(
        externalConversationContinuationEnabled
      );
      await setAssistantProfilesEnabled(assistantProfilesEnabled);
      await setAssistantKnowledgeEnabled(assistantKnowledgeEnabled);
      await setChatStarterEnabled(chatStarterEnabled);
    }
    const settings = await getPublicAppSettings();
    await writeAdminAuditLog({
      session,
      request: req,
      action: auditCopy.completedAction,
      targetType: "AppSettings",
      targetId: "public",
      summary: auditCopy.completed,
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
      chatStarterEnabled: await isChatStarterEnabled(),
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
