import "server-only";

import { prisma } from "@/lib/prisma";
import { getModel, type AiModel } from "@/lib/models";

export type AdminModelOverrideStatus = "available" | "limited" | "disabled" | "coming-soon";

export type AdminModelOverride = {
  modelId: string;
  status: AdminModelOverrideStatus;
  reason: string | null;
  visibleNote: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
};

export const isAdminModelOverrideStatus = (
  value: string
): value is AdminModelOverrideStatus =>
  ["available", "limited", "disabled", "coming-soon"].includes(value);

export async function getModelOverrides() {
  const rows = await prisma.modelOverride.findMany({
    orderBy: { updatedAt: "desc" },
  });
  return rows
    .filter((row) => isAdminModelOverrideStatus(row.status))
    .map((row): AdminModelOverride => ({
      modelId: row.modelId,
      status: row.status as AdminModelOverrideStatus,
      reason: row.reason,
      visibleNote: row.visibleNote,
      updatedByEmail: row.updatedByEmail,
      updatedAt: row.updatedAt.toISOString(),
    }));
}

export async function getModelOverrideMap() {
  return new Map((await getModelOverrides()).map((override) => [override.modelId, override]));
}

export function resolveModelOverrideStatus(
  model: Pick<AiModel, "id" | "enabled" | "status">,
  override: AdminModelOverride | undefined
) {
  if (!model.enabled || model.status !== "enabled") return "unavailable" as const;
  if (!override || override.status === "available") return "available" as const;
  if (override.status === "limited") return "limited" as const;
  return "unavailable" as const;
}

export async function assertModelNotAdminDisabled(modelId: string) {
  const model = getModel(modelId);
  if (!model) return { allowed: false, reason: "Unknown model." };
  const override = (await getModelOverrideMap()).get(modelId);
  const status = resolveModelOverrideStatus(model, override);
  if (status === "unavailable") {
    return {
      allowed: false,
      reason:
        override?.visibleNote ||
        override?.reason ||
        "This model is temporarily unavailable.",
    };
  }
  return { allowed: true, reason: null };
}
