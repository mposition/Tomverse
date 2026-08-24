/**
 * The capability system blocks a chat turn carries, and what they cost.
 *
 * Report: `.github/audits/image-intent-auto-switch-2026-08-24.md` B-3.
 *
 * ## Why both routes call this
 *
 * Two paths decide what a chat turn is priced at, and they had drifted:
 * `app/api/chat/route.ts` added the artifact block to the request *and* to the
 * input estimate, while `app/api/chat/preflight/route.ts` -- which is what
 * quotes credits and reserves the comparison -- counted neither. The gap was
 * invisible because nothing compared them; adding a second block to only one
 * side would have widened it.
 *
 * So the blocks and their token cost are built once, here, and both routes
 * take the same object. What is displayed, what is reserved, and what is sent
 * then move together by construction rather than by review.
 *
 * ## What is deliberately not here
 *
 * The §9.1 context block (memory, profile, knowledge) stays where it is. Both
 * routes already build it from `buildChatTurnContext` and both already price
 * its text; folding it in would move a settled thing for no gain.
 *
 * Pure. `planGeneratedArtifactTool` and the image builder are pure, and the
 * token estimator is arithmetic, so the whole assembly is testable without a
 * provider or a database.
 */

import {
  estimateTextTokens,
} from "@/lib/chatTokenEstimate";
import {
  buildImageCapabilitySystemPrompt,
  resolveImageHandoffState,
  type ImageArtifactState,
} from "@/lib/imageCapabilityPrompt";
import {
  classifyImageIntent,
  l0ImageIntent,
  type ImageIntentClass,
} from "@/lib/imageIntentSignals";
import { normalizeServerImageIntentInput } from "@/lib/imageIntentInput";
import {
  ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS,
  ARTIFACT_TOOL_DEFINITION_TOKENS,
  planGeneratedArtifactTool,
  type ArtifactToolPlan,
} from "@/lib/generatedArtifactToolPolicy";
import type { TurnAttachmentDescriptor } from "@/lib/messageAttachmentCore";

export type ChatTurnSystemBlocksInput = {
  modelId: string;
  provider: string;
  /**
   * Deep research never reaches the streaming path, so it carries no
   * capability blocks at all -- the same exclusion the artifact policy already
   * made, extended to the image block for the same reason: a block about a
   * workflow this job cannot run is priced input with no use.
   */
  isDeepResearchTurn: boolean;
  isAuthenticated: boolean;
  /**
   * Whether this turn can persist an assistant message, which is what the
   * artifact tool needs to attach a file to.
   *
   * The chat route knows this exactly (it has the assistant message id from
   * the payload); preflight knows the same pair one step earlier -- a
   * signed-in caller with a real conversation row. The client always sends
   * both together, so the two agree in practice; where they could not, the
   * quote is the conservative one.
   */
  canPersist: boolean;
  nativeSearchEnabled: boolean;
  nativeSearchForced: boolean;
  turnAttachments: readonly TurnAttachmentDescriptor[];
  /** The user's own text for this turn -- the classifier's only text input. */
  promptText: string;
  /** `feature.imageGenerationEnabled`, read from the cached snapshot. */
  imageGenerationFlagEnabled: boolean;
  /** `planAllowsImageGeneration(tier)` for this caller. */
  planAllowsImageGeneration: boolean;
};

export type ChatTurnSystemBlocks = {
  /** Null on a deep-research turn, where no block is carried. */
  artifactPlan: ArtifactToolPlan | null;
  /** Empty on a deep-research turn. */
  imageCapabilityPrompt: string;
  imageIntentClass: ImageIntentClass;
  /** In request order, ready to push after the context block. */
  systemMessages: { role: "system"; content: string }[];
  /**
   * Text tokens of every block here, plus the tool schemas the provider adds
   * when a tool is registered. This is the number both routes add to the input
   * estimate -- one number, so neither can add a different one.
   */
  promptTokens: number;
};

/** `ArtifactToolPlan.mode` as the image block's third axis reads it. */
const artifactStateOf = (plan: ArtifactToolPlan | null): ImageArtifactState => {
  if (!plan) return "unavailable";
  if (plan.mode === "generate") return "available";
  if (plan.mode === "sign_in_required") return "sign_in";
  return "unavailable";
};

export const buildChatTurnSystemBlocks = (
  input: ChatTurnSystemBlocksInput
): ChatTurnSystemBlocks => {
  if (input.isDeepResearchTurn) {
    return {
      artifactPlan: null,
      imageCapabilityPrompt: "",
      imageIntentClass: "none",
      systemMessages: [],
      promptTokens: 0,
    };
  }

  const artifactPlan = planGeneratedArtifactTool({
    modelId: input.modelId,
    provider: input.provider,
    isAuthenticated: input.isAuthenticated,
    canPersist: input.canPersist,
    nativeSearchEnabled: input.nativeSearchEnabled,
    nativeSearchForced: input.nativeSearchForced,
    conversationKind: "chat",
    turnAttachments: input.turnAttachments,
  });

  const imageIntentClass = classifyImageIntent(
    normalizeServerImageIntentInput({
      text: input.promptText,
      attachments: input.turnAttachments,
    })
  );

  const imageCapabilityPrompt = buildImageCapabilitySystemPrompt({
    intent: l0ImageIntent(imageIntentClass),
    imageHandoff: resolveImageHandoffState({
      flagEnabled: input.imageGenerationFlagEnabled,
      isAuthenticated: input.isAuthenticated,
      planAllowsImageGeneration: input.planAllowsImageGeneration,
    }),
    artifact: artifactStateOf(artifactPlan),
  });

  const systemMessages: { role: "system"; content: string }[] = [
    { role: "system", content: artifactPlan.systemPrompt },
    { role: "system", content: imageCapabilityPrompt },
  ];

  // Priced like any other input. The tool *definitions* are a separate cost
  // the provider adds when the schema is sent, and they are build-time
  // constants rather than a per-request tokenisation.
  const promptTokens =
    estimateTextTokens(artifactPlan.systemPrompt) +
    estimateTextTokens(imageCapabilityPrompt) +
    (artifactPlan.registerTool ? ARTIFACT_TOOL_DEFINITION_TOKENS : 0) +
    (artifactPlan.registerDocumentBatch
      ? ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS
      : 0);

  return {
    artifactPlan,
    imageCapabilityPrompt,
    imageIntentClass,
    systemMessages,
    promptTokens,
  };
};
