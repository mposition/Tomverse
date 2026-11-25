import { z } from "zod";
import { DEEP_RESEARCH_DEPTHS } from "../../../lib/deepResearchModel";
import { parseChatLocation } from "@tomverse/chat-core";
import { CONVERSATION_TITLE_MAX_LENGTH } from "../../../lib/conversationRename";
import { CHAT_MAX_MESSAGE_CHARACTERS } from "../../../lib/chatRequestLimits";
import type { AiModel } from "../../../lib/models";
import type { McpProgressState } from "../../../lib/mcpConnectorProgress";
import { attachmentRead, attachmentUploadIds } from "./attachment-contract";
import { ARTIFACT_LIMITS, isSupportedArtifactFormat, parseChatStreamArtifacts } from "../../../lib/generatedArtifactCore";

export const chatId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const reviewAnalysisRequest = z.object({
  conversationId: chatId, promptMessageId: z.uuid(),
  assistantMessageIds: z.array(z.uuid()).min(2).max(3).refine((ids) => new Set(ids).size === ids.length),
}).strict();
export type ReviewAnalysisRequest = z.infer<typeof reviewAnalysisRequest>;
export const desktopTextProduct = z.enum(["chat", "review"]);
export const chatSearch = z.string().trim().min(2).max(80);
export const chatHistorySearchInput = z.object({ query: chatSearch, product: desktopTextProduct.optional() }).strict();
export const chatPageInput = z.object({ id: chatId, cursor: chatId.optional(), product: desktopTextProduct.optional() }).strict();
export const chatSourceInput = z.object({ id: chatId, offset: z.number().int().nonnegative().optional() }).strict();
export const chatRenameInput = z.object({ id: chatId, title: z.string().trim().min(1).max(CONVERSATION_TITLE_MAX_LENGTH) }).strict();
export const chatEffort = z.enum(["low", "default", "high"]);
export const composerOptions = z.object({
  webSearchMode: z.enum(["off", "always"]).optional(),
  memoryMode: z.enum(["inherit", "on", "off"]).optional(),
  assistantProfileId: chatId.nullable().optional(),
}).strict();
export type ComposerOptions = z.infer<typeof composerOptions>;
export const deepResearchDepth = z.enum(DEEP_RESEARCH_DEPTHS);
export type DeepResearchDepth = z.infer<typeof deepResearchDepth>;
export const chatTurnInput = z.object({
  requestId: z.uuid(),
  conversationId: chatId.optional(),
  prompt: z.string().trim().max(CHAT_MAX_MESSAGE_CHARACTERS),
  modelId: z.string().min(1).max(120),
  selectionMode: z.enum(["auto", "manual"]),
  effort: chatEffort,
  attachmentUploadIds,
  handoffId: z.uuid().optional(),
  currentLocation: z.unknown().transform((value) => parseChatLocation(value)).optional(),
  tools: composerOptions.optional(),
  deepResearchDepth: deepResearchDepth.optional(),
  /** The plugin connection the user chose for this conversation; the server re-checks that it is theirs. */
  mcpConnectionId: chatId.optional(),
}).strict().refine((input) => input.prompt.length > 0 || Boolean(input.attachmentUploadIds?.length || input.handoffId));
export const reviewCapability = z.object({
  easy: z.boolean(), modelLimit: z.number().int().positive(), plan: z.enum(["Free", "Pro", "Max"]),
});
export const reviewTurnInput = z.object({
  requestId: z.uuid(),
  conversationId: chatId.optional(),
  prompt: chatTurnInput.shape.prompt,
  mode: z.enum(["easy", "professional"]),
  choices: z.array(z.string().min(1).max(100)).min(1).max(3).refine((items) => new Set(items).size === items.length),
  effort: chatEffort,
  attachmentUploadIds,
}).strict().refine((input) => input.prompt.length > 0 || Boolean(input.attachmentUploadIds?.length));
export const chatHistoryRow = z.object({
  id: chatId,
  title: z.string(),
  kind: z.string(),
  surface: z.enum(["chat", "continuation", "workspace"]),
  productKey: z.string().nullish(),
  pinned: z.boolean().optional(),
  pinSeq: z.number().optional(),
  updatedAt: z.string().nullish(),
  isLocked: z.boolean().optional(),
  shareEnabled: z.boolean().optional(),
  projectId: chatId.nullish(),
  selectedModels: z.array(z.string()).optional(),
  sourceTitle: z.string().nullish(),
  sourceState: z.string().nullish(),
});
export const chatHistoryHit = z.object({
  id: z.string(),
  conversationId: chatId,
  conversationTitle: z.string(),
  snippet: z.string(),
  surface: chatHistoryRow.shape.surface,
});

export const saveArtifactInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  format: z.string().refine(isSupportedArtifactFormat),
  filename: z.string().min(1).max(ARTIFACT_LIMITS.maxFilenameLength),
  byteSize: z.number().int().min(1).max(ARTIFACT_LIMITS.maxConvertedOutputBytes),
}).strict();
export type SaveArtifactInput = z.infer<typeof saveArtifactInput>;

export const chatMessage = z.object({
  id: chatId, role: z.string(), content: z.string(), status: z.string().optional(), modelId: z.string().nullish(), createdAt: z.string().optional(),
  pendingJobId: z.string().nullish(),
  memoryUsedCount: z.int().positive().nullish().catch(undefined),
  searchMetadata: z.object({
    reasoningEffort: z.object({ requested: chatEffort, applied: chatEffort.optional() }).optional(),
  }).nullish(),
  attachments: z.array(attachmentRead).optional(),
  artifacts: z.unknown().optional().transform((value) => parseChatStreamArtifacts(value) ?? []),
  imageTurn: z.object({ groupId: chatId, modelIds: z.array(z.string()) }).optional(),
});
export const chatConversation = chatHistoryRow.extend({
  desktopReviewWritable: z.boolean().optional(),
  messages: z.array(chatMessage),
  responseAttempts: z.array(z.object({
    assistantMessageId: chatId, actualModelId: z.string().nullish(), provider: z.string().nullish(),
  })).optional(),
  messagePage: z.object({ nextCursor: chatId.nullable() }),
  selectionMode: z.enum(["auto", "manual"]),
  selectedModels: z.array(z.string()),
  storedSelectedModels: z.array(z.string()).optional(),
  autoSelection: z.object({ offered: z.boolean() }),
  webSearchMode: z.enum(["off", "always"]).catch("off"),
  memoryMode: composerOptions.shape.memoryMode.catch(undefined),
  assistantProfile: z.object({ profileId: chatId, name: z.string() }).nullish(),
});

export type ChatHistoryRow = z.infer<typeof chatHistoryRow>;
export type ChatHistoryHit = z.infer<typeof chatHistoryHit>;
export type ChatConversation = z.infer<typeof chatConversation>;
export type ChatPageInput = z.infer<typeof chatPageInput>;
export type DesktopTextProduct = z.infer<typeof desktopTextProduct>;
export const chatImportedSource = z.object({
  provider: z.string(),
  source: z.object({
    status: z.enum(["available", "locked", "deleted"]),
    messages: z.array(z.object({ id: chatId, role: z.string(), content: z.string() })).optional(),
    offset: z.number().optional(),
    messageTotal: z.number().optional(),
  }),
});
export type ChatSourceInput = z.infer<typeof chatSourceInput>;
export type ChatImportedSource = z.infer<typeof chatImportedSource>;
export type ChatRenameInput = z.infer<typeof chatRenameInput>;
export type ChatTurnInput = z.infer<typeof chatTurnInput>;
export type ChatModel = AiModel;
export type ChatStarter = { id: string; label: string; outcome: string; seed: string };
export type ChatTurnProgress = {
  requestId: string;
  conversationId: string;
  savedPrompt?: string;
  text?: string;
  modelId?: string;
  applied?: z.infer<typeof chatEffort>;
  /** Where the selected plugin stands in this turn, as the server reports it in the stream. */
  mcpProgress?: McpProgressState;
};
export type ChatTurnResult = {
  conversation: ChatConversation | null;
  savedQuestion: boolean;
  status: "saved" | "researching" | "partial" | "stopped" | "failed" | "unconfirmed";
  partial: string;
  modelId?: string;
  applied?: z.infer<typeof chatEffort>;
  contextChanged?: boolean;
};
export type ReviewCapability = z.infer<typeof reviewCapability>;
export type ReviewTurnInput = z.infer<typeof reviewTurnInput>;
export type ReviewTurnProgress = ChatTurnProgress;
export type ReviewImageOffer = {
  prompt: string;
  models: string[];
  quality: "low" | "medium" | "high";
  unavailable: string[];
};
export type ReviewTurnResult = {
  conversation: ChatConversation | null;
  savedQuestion: boolean;
  status: Exclude<ChatTurnResult["status"], "researching">;
  partial: Array<{ modelId: string; text: string }>;
  imageOffer?: ReviewImageOffer;
};

export function isDesktopChat(row: ChatHistoryRow) {
  return row.kind === "chat" && (row.surface === "chat" || (row.surface === "continuation" && row.productKey === "chat"));
}

export function isDesktopReview(row: ChatHistoryRow) {
  return row.kind === "chat" && ((row.surface === "workspace" && (row.productKey === "review" || row.productKey == null)) ||
    (row.surface === "continuation" && row.productKey === "review"));
}
