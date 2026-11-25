import "server-only";

import type { Session } from "next-auth";
import { DEFAULT_VOICE_CONVERSATION_MODEL } from "@tomverse/chat-core";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { prisma } from "@/lib/prisma";

const settingKey = "voiceConversation.model";

export async function getVoiceConversationModel() {
  if (isE2EDatabaseDisabled()) return DEFAULT_VOICE_CONVERSATION_MODEL;
  const setting = await prisma.appSetting.findUnique({ where: { key: settingKey }, select: { value: true } });
  return setting?.value ?? DEFAULT_VOICE_CONVERSATION_MODEL;
}

export async function saveVoiceConversationModel(modelId: string, session: Session, request: Request) {
  await prisma.$transaction(async tx => {
    await tx.appSetting.upsert({
      where: { key: settingKey }, create: { key: settingKey, value: modelId }, update: { value: modelId },
    });
    await writeAdminAuditLog({
      tx, session, request, action: "app_settings.voice_conversation_model.update_completed",
      targetType: "AppSettings", targetId: settingKey, summary: "Updated the model for new Chat voice sessions.",
      metadata: { modelId },
    });
  });
}
