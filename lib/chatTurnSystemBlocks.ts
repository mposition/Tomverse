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
 * The context block (memory, profile, knowledge) of
 * docs/policy/external-conversation-import-and-memory.md §9.1
 * stays where it is. Both
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
import {
  buildWebSearchCapabilitySystemPrompt,
  resolveWebSearchTurnState,
  type WebSearchTurnState,
} from "@/lib/webSearchCapabilityPrompt";
import {
  APP_MANAGED_WEB_SEARCH_PROMPT,
  APP_MANAGED_WEB_SEARCH_TOOL_DEFINITION_TOKENS,
} from "@/lib/appManagedWebSearchPrompt";
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
  /**
   * Whether this turn registers this application's own `web_search` tool.
   *
   * Never true at the same time as `nativeSearchEnabled`: a model's capability
   * is one route or the other. Kept as its own flag rather than folded into the
   * native one because they have opposite consequences for the artifact tools
   * -- a forced native search takes them away, and an application-managed
   * search is itself a function declaration that coexists with them.
   */
  appManagedSearchEnabled: boolean;
  turnAttachments: readonly TurnAttachmentDescriptor[];
  /** The user's own text for this turn -- the classifier's only text input. */
  promptText: string;
  /** `feature.imageGenerationEnabled`, read from the cached snapshot. */
  imageGenerationFlagEnabled: boolean;
  /** `planAllowsImageGeneration(tier)` for this caller. */
  planAllowsImageGeneration: boolean;
  /**
   * The imported-conversation excerpt this turn carries, in the two halves
   * `buildContinuationSeedPrompt` returns
   * (docs/policy/external-conversation-continuation.md §4.3). Absent on every
   * turn that has none, which is all of them outside a bridged conversation.
   *
   * Two fields rather than one string, and the split is the security contract:
   * `rulesText` is Tomverse's own words and goes out at system authority;
   * `transcriptText` is a third-party transcript and must never be sent under
   * `system` or `developer`. The first version of this feature sent one
   * combined block as a system message, which is the promotion §4.3 forbids --
   * a wrapper sentence saying "this is data" does not lower the role the
   * provider sees.
   *
   * It arrives here rather than being built here for the reason the memory
   * block is built elsewhere too: this module is pure and the seed needs a
   * database read. What it gains by passing *through* here is that both halves
   * are counted in `promptTokens`, so the number the preparation step quotes
   * and the number the send is priced at are the same number by construction.
   */
  continuationSeed?: { rulesText: string; transcriptText: string };
};

export type ChatTurnSystemBlocks = {
  /** Null on a deep-research turn, where no block is carried. */
  artifactPlan: ArtifactToolPlan | null;
  /** Empty on a deep-research turn. */
  imageCapabilityPrompt: string;
  imageIntentClass: ImageIntentClass;
  /**
   * Whether this turn can reach the live web, and the paragraph that follows
   * from it (`lib/webSearchCapabilityPrompt.ts`). Empty on a searching turn
   * and on deep research, both of which reach it.
   */
  webSearchTurnState: WebSearchTurnState;
  webSearchCapabilityPrompt: string;
  /**
   * Blocks Tomverse itself authored, in request order. Everything here is our
   * own text, which is what makes `system` the right role for all of it.
   */
  systemMessages: { role: "system"; content: string }[];
  /**
   * Content this application did not write, carried at ordinary conversation
   * authority rather than system authority
   * (docs/policy/external-conversation-continuation.md §4.3).
   *
   * Today that is one thing: the imported excerpt of a continuation. The field
   * is a list and is named for the property that decides membership -- not
   * ours -- so the next such payload has an obvious place to go and cannot be
   * appended to `systemMessages` because that is where the loop already was.
   */
  untrustedDataMessages: { role: "user"; content: string }[];
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
      // Deep research searches by construction, so it is not a turn that has
      // to explain being unable to.
      webSearchTurnState: "searching",
      webSearchCapabilityPrompt: "",
      systemMessages: [],
      untrustedDataMessages: [],
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

  const webSearchTurnState = resolveWebSearchTurnState({
    modelId: input.modelId,
    nativeSearchEnabled: input.nativeSearchEnabled,
    appManagedSearchEnabled: input.appManagedSearchEnabled,
  });
  const webSearchCapabilityPrompt =
    buildWebSearchCapabilitySystemPrompt(webSearchTurnState);

  const systemMessages: { role: "system"; content: string }[] = [
    { role: "system", content: artifactPlan.systemPrompt },
    { role: "system", content: imageCapabilityPrompt },
    // Only on a turn that cannot search; an empty block would be a system
    // message saying nothing, priced and sent.
    ...(webSearchCapabilityPrompt
      ? [{ role: "system" as const, content: webSearchCapabilityPrompt }]
      : []),
    // The other half of the same pair. `webSearchCapabilityPrompt` is the block
    // for a turn that *cannot* search; this is the block for a turn that
    // searches through a tool this application executes, and the two are
    // mutually exclusive by construction -- `resolveWebSearchTurnState` reads
    // the same flag. A native searching turn gets neither: the provider's own
    // tool description is the instruction there.
    ...(input.appManagedSearchEnabled
      ? [{ role: "system" as const, content: APP_MANAGED_WEB_SEARCH_PROMPT }]
      : []),
    // The continuation's *rules* -- ours, and the last system block, so they
    // are stated immediately before the excerpt they govern. The excerpt
    // itself is not here; it is in `untrustedDataMessages` below.
    ...(input.continuationSeed
      ? [{ role: "system" as const, content: input.continuationSeed.rulesText }]
      : []),
  ];

  // The imported transcript. Separated from the list above by role, not by
  // convention: a reviewer reading `systemMessages` can see that nothing
  // third-party is in it, and a change that moved this line would have to say
  // so in the type.
  const untrustedDataMessages: { role: "user"; content: string }[] =
    input.continuationSeed
      ? [{ role: "user", content: input.continuationSeed.transcriptText }]
      : [];

  // Priced like any other input. The tool *definitions* are a separate cost
  // the provider adds when the schema is sent, and they are build-time
  // constants rather than a per-request tokenisation.
  const promptTokens =
    estimateTextTokens(artifactPlan.systemPrompt) +
    estimateTextTokens(imageCapabilityPrompt) +
    estimateTextTokens(webSearchCapabilityPrompt) +
    (input.appManagedSearchEnabled
      ? estimateTextTokens(APP_MANAGED_WEB_SEARCH_PROMPT) +
        APP_MANAGED_WEB_SEARCH_TOOL_DEFINITION_TOKENS
      : 0) +
    (artifactPlan.registerTool ? ARTIFACT_TOOL_DEFINITION_TOKENS : 0) +
    (artifactPlan.registerDocumentBatch
      ? ARTIFACT_BATCH_TOOL_DEFINITION_TOKENS
      : 0) +
    // Both halves. Splitting the seed by role changed where the text is sent,
    // not what it costs, and pricing only the rules would under-quote every
    // continuation turn by the size of its excerpt.
    estimateTextTokens(input.continuationSeed?.rulesText ?? "") +
    estimateTextTokens(input.continuationSeed?.transcriptText ?? "");

  return {
    artifactPlan,
    imageCapabilityPrompt,
    imageIntentClass,
    webSearchTurnState,
    webSearchCapabilityPrompt,
    systemMessages,
    untrustedDataMessages,
    promptTokens,
  };
};

/**
 * The messages a turn opens with, in order, before its conversation history.
 *
 * Exported and pure so the role boundary is a property of a function a test
 * can call, rather than of eight lines inside a six-thousand-line route. The
 * claim it makes testable is the one
 * docs/policy/external-conversation-continuation.md §4.3 turns on: no message
 * this returns carries third-party text at `system` or `developer` authority.
 *
 * Order is the docs/policy/external-conversation-import-and-memory.md §9.1
 * order and is fixed here:
 *
 *   1. the memory/profile/knowledge context block, when a bundle priced one;
 *   2. Tomverse's own capability blocks, including a continuation's rules;
 *   3. content Tomverse did not write, at ordinary authority;
 *   ... then the caller appends the conversation history and this turn.
 *
 * Rules before excerpt is not cosmetic: text placed after a payload is read
 * after the payload.
 */
export type ChatTurnPreludeMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string };

export const buildChatTurnPrelude = (input: {
  contextSystemPrompt: string | null;
  blocks: Pick<ChatTurnSystemBlocks, "systemMessages" | "untrustedDataMessages">;
}): ChatTurnPreludeMessage[] => [
  ...(input.contextSystemPrompt
    ? [{ role: "system" as const, content: input.contextSystemPrompt }]
    : []),
  ...input.blocks.systemMessages,
  ...input.blocks.untrustedDataMessages,
];
