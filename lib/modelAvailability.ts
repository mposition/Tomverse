import "server-only";

import {
  isRetiredModel,
  resolveReplacementModel,
  type AiModel,
} from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import {
  modelNotice,
  modelNoticeFallbackText,
  type ModelNotice,
} from "@/lib/modelRetirementNotice";

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

export type ModelRuntimeVerdict = {
  allowed: boolean;
  /**
   * English, for logs and for clients that predate the copy key. The client
   * renders `notice` instead when it can -- this field is what the sentence
   * used to be, and keeping it means the change is not a breaking one.
   */
  reason: string | null;
  /**
   * The same fact, in the shape the client can say in the reader's language
   * (EM-15). Null when there is nothing to say.
   */
  notice: ModelNotice | null;
};

export async function assertModelRuntimeAvailable(
  modelId: string
): Promise<ModelRuntimeVerdict> {
  // The whole registry, so the replacement chain below is walked against one
  // snapshot. `getRuntimeModel` reads the same cached list per call, so this
  // is the same work done once rather than once per hop.
  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  const model = models.find((entry) => entry.id === modelId);
  if (!model) {
    return { allowed: false, reason: "Unknown model.", notice: null };
  }

  const status = resolveModelRuntimeAvailability(model);
  const unavailable = status === "unavailable";

  // Resolved here rather than stored: nine of the ten notes this replaced said
  // exactly what `replacementModelId` already says, in English, to everybody
  // (EM-15). The tenth said something no field holds, and a stored note still
  // wins -- see lib/modelRetirementNotice.ts.
  //
  // Resolved through the chain rather than by reading one hop. An
  // administrator's `replacementModelId` is only as current as the day it was
  // written: retire A onto B, retire B onto C, and A's link now names a model
  // that is not in anybody's picker. This names the first model in that chain
  // that is actually selectable, and nothing when there is none.
  const modelsById = new Map(models.map((entry) => [entry.id, entry]));
  const replacement = resolveReplacementModel(model, (candidateId) =>
    modelsById.get(candidateId)
  );

  const notice = modelNotice({
    userVisibleNote: model.userVisibleNote ?? null,
    replacementModelName: replacement?.name ?? null,
    unavailable,
    retired: isRetiredModel(model) || model.catalogDeleted === true,
  });

  return {
    allowed: !unavailable,
    reason: modelNoticeFallbackText(notice) || null,
    notice,
  };
}
