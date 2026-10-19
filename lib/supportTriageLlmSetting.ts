/**
 * Which model the support-triage LLM step uses, chosen in the Admin console
 * (owner request 2026-10-19). Stored as one AppSetting row; when there is no
 * row, SUPPORT_TRIAGE_LLM_MODEL_ID is the fallback, and with neither the step
 * is off. Only an enabled runtime model can be saved, and every change is
 * audited in the same transaction.
 */
import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getEnabledRuntimeModel, getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

export const SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY = "supportTriage.llmModelId";

/** The saved model id, or null when the Admin console has not chosen one. */
export const readSupportTriageLlmModelSetting = async (): Promise<string | null> => {
  const row = await prisma.appSetting.findUnique({
    where: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value.trim();
  return value ? value : null;
};

export type SupportTriageModelOption = { id: string; name: string; provider: string };

/** The models the Admin console can offer: enabled and in the catalogue. */
export const listSupportTriageModelOptions = async (): Promise<SupportTriageModelOption[]> =>
  (await getRuntimeModels())
    .filter((model) => model.enabled && !model.catalogDeleted)
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }));

export class SupportTriageModelRefused extends Error {}

/**
 * Saves `modelId`, or clears the choice with null (the environment variable
 * then applies again). Refuses a model that is not enabled.
 */
export const writeSupportTriageLlmModelSetting = async (input: {
  session: Session;
  request: Request;
  modelId: string | null;
}): Promise<{ modelId: string | null }> => {
  if (input.modelId !== null && !(await getEnabledRuntimeModel(input.modelId))) {
    throw new SupportTriageModelRefused("model_not_enabled");
  }
  await prisma.$transaction(async (tx) => {
    if (input.modelId === null) {
      await tx.appSetting.deleteMany({ where: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY } });
    } else {
      await tx.appSetting.upsert({
        where: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY },
        create: { key: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY, value: input.modelId },
        update: { value: input.modelId },
      });
    }
    await writeAdminAuditLog({
      tx,
      session: input.session,
      request: input.request,
      action: "support_triage.llm_model_updated",
      targetType: "AppSettings",
      targetId: SUPPORT_TRIAGE_LLM_MODEL_SETTING_KEY,
      summary: input.modelId === null ? "Support-triage LLM model cleared" : "Support-triage LLM model set",
      metadata: { modelId: input.modelId },
    });
  });
  return { modelId: input.modelId };
};
