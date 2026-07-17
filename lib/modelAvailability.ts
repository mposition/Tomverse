import "server-only";

import type { AiModel } from "@/lib/models";
import { getRuntimeModel } from "@/lib/modelRegistry";

export type ModelRuntimeAvailability =
  | "available"
  | "limited"
  | "unavailable";

export function resolveModelRuntimeAvailability(
  model: Pick<AiModel, "enabled" | "status">
): ModelRuntimeAvailability {
  if (!model.enabled || model.status === "disabled" || model.status === "coming-soon") {
    return "unavailable";
  }
  return model.status === "limited" ? "limited" : "available";
}

export async function assertModelRuntimeAvailable(modelId: string) {
  const model = await getRuntimeModel(modelId);
  if (!model) return { allowed: false, reason: "Unknown model." };
  const status = resolveModelRuntimeAvailability(model);
  if (status === "unavailable") {
    return {
      allowed: false,
      reason:
        model.userVisibleNote ||
        "This model is temporarily unavailable.",
    };
  }
  return { allowed: true, reason: model.userVisibleNote || null };
}
