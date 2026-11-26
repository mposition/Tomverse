import { z } from "zod";
import { DEEP_RESEARCH_MODEL_ID } from "../../../../lib/deepResearchModel";
import type { DriveSelection } from "../../../../lib/desktopDrivePickerContract";
import type { ComparisonReview, ReviewSetup } from "../../../../packages/chat-core/src/review";
import { parseChatLocation } from "@tomverse/chat-core";
import { DESKTOP_LIVE_ORIGIN } from "../../../../lib/desktopAuthContract";
import {
  DESKTOP_APP_ORIGIN, DESKTOP_CHAT_CONTEXT, DESKTOP_CHAT_CREATE, DESKTOP_CHAT_HISTORY, DESKTOP_CHAT_SEARCH, DESKTOP_CHAT_TURN,
  DESKTOP_DEEP_RESEARCH_STATUS, DESKTOP_IMAGE_GENERATIONS, DESKTOP_REVIEW_CREATE, DESKTOP_REVIEW_PREFLIGHT, DESKTOP_REVIEW_ROUTING,
} from "../../../../lib/nativeBearerGate";
import { CHAT_INITIAL_SELECTION_MODE_HEADER } from "../../../../lib/chatWorkspaceEntry";
import { getModel, isPubliclySelectableModel, MODEL_USAGE_CLASSES, type AiProvider } from "../../../../lib/models";
import { createChatLivenessWatchdog } from "../../../../lib/chatStreamLiveness";
import { consumeChatStream } from "../../../../lib/chatStreamConsumer";
import { fitChatRequestTranscript } from "../../../../lib/chatRequestLimits";
import { parseChatStreamTrailer } from "../../../../lib/webSearchStreamTrailer";
import { readChatImageTurnRequest } from "../../../../lib/chatImageTurnCore";
import { askReviewRoute } from "../../../../lib/reviewRoutingClient";
import { detectImageMimeType } from "../../../../lib/imageDimensions";
import { IMAGE_ORIGINAL_MAX_READ_BYTES } from "../../../../lib/imageGenerationStateCore";
import { artifactContentDisposition, artifactDownloadPath, requireArtifactFormat } from "../../../../lib/generatedArtifactCore";
import { imageGroup, imageHistory, imageReceipt, type ImageGenerationResult, type ImageRequest } from "../images-contract";
import { formatByMediaType, resolveChatAttachmentFormat } from "../../../../lib/chatAttachmentFormats";
import { attachmentUpload, type AttachmentBytesInput, type AttachmentUpload } from "../attachment-contract";
import {
  chatConversation, chatHistoryHit, chatHistoryRow, chatId, chatImportedSourceWire, isDesktopChat, isDesktopReview,
  type ChatConversation, type ChatModel, type ChatRenameInput, type ChatPageInput, type ChatSourceInput, type ChatTurnInput, type DesktopTextProduct, type ReviewTurnInput, type SaveArtifactInput,
} from "../chat-contract";
import type { ReviewAnalysisRequest } from "../chat-contract";
import { VOICE_TRANSCRIPT_MAX_CHARACTERS } from "../../../../lib/voiceInputFormats";
import type { DictationClip, DictationReply } from "../dictation-contract";
import { desktopMcpReply, type DesktopMcpAction } from "../../../../lib/desktopCodeMcpContract";
import { desktopPluginInventory } from "../plugin-contract";
import type { McpProgressState } from "../../../../lib/mcpConnectorProgress";
import { DesktopSessionRefused } from "./browser-login";

const DESKTOP_PLUGIN_INVENTORY = "/api/mcp/connections";

const catalog = z.object({ models: z.array(z.unknown()) });
const catalogModel = z.object({
    id: z.string(), name: z.string(), provider: z.string(), minimumPlan: z.enum(["Guest", "Free", "Pro"]),
    publiclyListed: z.boolean().optional(), enabled: z.boolean(),
    status: z.enum(["enabled", "limited", "disabled", "coming-soon"]), catalogDeleted: z.boolean().optional(),
    reasoningEfforts: z.array(z.enum(["low", "high"])).optional(),
    icon: z.string().optional(), bestFor: z.string().optional(), userVisibleNote: z.string().optional(),
    usageClass: z.enum(MODEL_USAGE_CLASSES).optional(),
    creditWeight: z.number().nonnegative().optional(), reasoning: z.enum(["none", "low", "medium", "high"]).optional(),
    inputCapabilities: z.object({ image: z.boolean(), nativePdf: z.boolean() }).optional(),
    webSearchOverride: z.enum(["off", "app-managed"]).optional(),
});
const questionReceipt = z.object({ messageMappings: z.array(z.object({ requestId: z.uuid(), messageId: chatId })) });
const reviewAnalysis = z.custom<ComparisonReview>((value) => {
  const review = value as Partial<ComparisonReview> | null;
  const result = review?.result?.primary?.result;
  return typeof review?.id === "string" && Array.isArray(review.responseMap) &&
    Boolean(result && Array.isArray(result.differences) && Array.isArray(result.consensus) && Array.isArray(result.modelAssessments));
});
const reviewSetup = z.object({ available: z.boolean(), reason: z.string().optional(), storedReview: reviewAnalysis.optional(),
  promptMessageId: z.uuid().optional(), assistantMessageIds: z.array(z.uuid()).max(3).optional(),
  source: z.object({ question: z.string(), responses: z.array(z.object({ messageId: z.string(), content: z.string() })).max(3) }).optional(),
}) satisfies z.ZodType<ReviewSetup>;
const reviewAdmission = z.object({ ok: z.literal(true), admissionToken: z.string().min(1), contextBundle: z.string().nullish() });
const chatContext = z.object({ ok: z.literal(true), contextBundle: z.string().min(1).max(8192).nullable() });
const staleChatContext = z.object({ code: z.literal("CHAT_CONTEXT_BUNDLE_STALE"),
  details: z.object({ requiresPreflight: z.literal(true) }) });
const uploadPreparation = z.object({
  key: z.string().min(1).max(512), uploadUrl: z.url(),
  uploadHeaders: z.object({ "Content-Type": z.string() }).strict(),
});
const matchesProduct = (product: DesktopTextProduct) => product === "review" ? isDesktopReview : isDesktopChat;
type StreamSelection = Pick<ChatTurnInput, "modelId" | "selectionMode" | "effort" | "deepResearchDepth" | "mcpConnectionId"> & {
  review?: true;
  currentLocation?: ChatTurnInput["currentLocation"];
  admission?: { admissionToken: string; contextBundle?: string | null };
};
class DesktopApiError extends Error {
  constructor(readonly status: number, readonly code?: "IMAGE_PRICE_CHANGED") { super("Tomverse refused the Desktop request."); }
}
export class DesktopChatContextChanged extends Error {}

async function readBinaryBody(response: Response, limit: number, expectedSize: number | null = limit) {
  const reader = response.body!.getReader();
  const bytes = expectedSize === null ? null : new Uint8Array(expectedSize);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        throw new Error("The downloaded size did not match the response.");
      }
      if (bytes) bytes.set(value, offset);
      else chunks.push(value);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (!offset || (expectedSize !== null && offset !== expectedSize)) throw new Error("Tomverse did not return a complete file.");
  return bytes ?? Buffer.concat(chunks, offset);
}

export function desktopChatApi(token: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN) {
  const turnSignal = (turn?: AbortSignal) => turn ? AbortSignal.any([signal, turn]) : signal;
  const pathFor = (id: string) => DESKTOP_CHAT_HISTORY + "/" + encodeURIComponent(id);
  function send(path: string, method: string, body: object | undefined, opts: {
    signal: AbortSignal; headers?: Record<string, string>; publicRead?: boolean;
  }) {
    return fetch(new URL(path, origin), {
      method, ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { ...(opts.publicRead ? {} : { Authorization: "Bearer " + token, Origin: DESKTOP_APP_ORIGIN }),
        ...(body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      credentials: "omit", redirect: "error", cache: "no-store", signal: opts.signal,
    });
  }

  async function request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: object, options: {
    turn?: AbortSignal; headers?: Record<string, string>; publicRead?: boolean; timeout?: number;
  } = {}): Promise<T> {
    const response = await send(path, method, body, { ...options, signal: AbortSignal.any([turnSignal(options.turn), AbortSignal.timeout(options.timeout ?? 15_000)]) });
    if (response.ok) return schema.parse(await response.json());
    if (response.status === 409 && method === "POST" && path === DESKTOP_IMAGE_GENERATIONS) {
      const detail = z.object({ code: z.literal("IMAGE_PRICE_CHANGED") }).safeParse(await response.json().catch(() => null));
      throw new DesktopApiError(response.status, detail.success ? detail.data.code : undefined);
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new DesktopSessionRefused();
    throw new DesktopApiError(response.status);
  }

  async function transcribeDictation(input: DictationClip, turn: AbortSignal): Promise<DictationReply> {
    const response = await fetch(new URL("/api/chat/voice-transcription", origin), {
      method: "POST", body: new Uint8Array(input.bytes), credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Authorization: "Bearer " + token, Origin: DESKTOP_APP_ORIGIN, "Content-Type": input.mediaType },
      signal: AbortSignal.any([turnSignal(turn), AbortSignal.timeout(60_000)]),
    });
    if (response.ok) {
      const { transcript } = z.object({ transcript: z.string().max(VOICE_TRANSCRIPT_MAX_CHARACTERS) }).parse(await response.json());
      return { status: response.status, transcript };
    }
    const detail = z.object({ code: z.string().regex(/^VOICE_[A-Z_]{1,100}$/) }).safeParse(await response.json().catch(() => null));
    return { status: response.status, code: detail.success ? detail.data.code : "VOICE_TRANSCRIPTION_FAILED" };
  }

  async function conversation({ id, cursor, product = "chat" }: ChatPageInput, tail = false, turn?: AbortSignal) {
    const query = tail ? "?tail=1" : cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
    const result = await request(pathFor(id) + query, chatConversation, "GET", undefined, { turn });
    if (!matchesProduct(product)(result)) throw new Error("This conversation opens in its original workspace.");
    return result;
  }

  return {
    async history(product: DesktopTextProduct = "chat") {
      const rows = await request(DESKTOP_CHAT_HISTORY, z.array(chatHistoryRow));
      return rows.filter(matchesProduct(product));
    },
    async continuation(id: string) {
      const rows = await request(DESKTOP_CHAT_HISTORY, z.array(chatHistoryRow));
      return rows.find((row) => row.id === id && row.surface === "continuation" && (isDesktopChat(row) || isDesktopReview(row)));
    },
    transcribeDictation,
    async codePlugin(connectionId: string, action: DesktopMcpAction, turn: AbortSignal) {
      return request("/api/mcp/desktop-code", desktopMcpReply, "POST", { connectionId, action }, { turn });
    },
    async pluginInventory() {
      return request(DESKTOP_PLUGIN_INVENTORY, desktopPluginInventory);
    },
    async imageConversations() {
      const rows = await request(DESKTOP_CHAT_HISTORY, z.array(chatHistoryRow));
      return rows.filter((row) => row.kind === "image");
    },
    async imageHistory(id: string) {
      return request(pathFor(id) + "/generations", imageHistory);
    },
    async imageGroup(id: string) {
      return request("/api/images/groups/" + encodeURIComponent(id), imageGroup);
    },
    async generateImages(input: ImageRequest): Promise<ImageGenerationResult> {
      try {
        const receipt = await request(DESKTOP_IMAGE_GENERATIONS, imageReceipt, "POST", {
          prompt: input.prompt, size: input.size, quality: input.quality,
          idempotencyKey: input.idempotencyKey, conversationId: input.conversationId,
          modelIds: input.models, expectedPricingVersions: input.pricing,
        });
        return { status: "accepted", receipt };
      } catch (error) {
        const priceChanged = error instanceof DesktopApiError && error.code === "IMAGE_PRICE_CHANGED";
        if (error instanceof DesktopSessionRefused || (error instanceof DesktopApiError && error.status < 500 && !priceChanged)) throw error;
        const receipt = await request(DESKTOP_IMAGE_GENERATIONS + "?requestKey=" + encodeURIComponent(input.idempotencyKey), imageReceipt)
          .catch((recoveryError) => {
            if (priceChanged && recoveryError instanceof DesktopApiError && recoveryError.status === 404) return null;
            throw recoveryError;
          });
        return receipt ? { status: "accepted", receipt } : { status: "price-changed" };
      }
    },
    async imageBytes(id: string, preview: boolean) {
      const operation = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const response = await send(DESKTOP_IMAGE_GENERATIONS + "/" + encodeURIComponent(id) + "/download" + (preview ? "?preview=1" : ""),
        "GET", undefined, { signal: operation });
      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      const size = length !== null && (!encoding || encoding === "identity") ? Number(length) : null;
      if (!response.ok || !response.body || (size !== null && (!Number.isSafeInteger(size) || size < 1 || size > IMAGE_ORIGINAL_MAX_READ_BYTES))) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) throw new DesktopSessionRefused();
        throw new Error("The generated image is unavailable.");
      }
      const bytes = await readBinaryBody(response, size ?? IMAGE_ORIGINAL_MAX_READ_BYTES, size);
      const mimeType = detectImageMimeType(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (!mimeType || mimeType !== response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()) {
        throw new Error("Tomverse did not return a complete image.");
      }
      return { mimeType, bytes };
    },
    async artifactBytes(input: SaveArtifactInput) {
      const operation = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      const response = await send(artifactDownloadPath(input.id), "GET", undefined, { signal: operation });
      const format = requireArtifactFormat(input.format);
      const length = response.headers.get("content-length");
      const encoded = response.headers.get("content-encoding");
      if (!response.ok || !response.body ||
          (length !== null && (!encoded || encoded === "identity") && Number(length) !== input.byteSize) ||
          response.headers.get("content-type") !== format.mediaType ||
          response.headers.get("content-disposition") !== artifactContentDisposition(input.filename, input.format)) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) throw new DesktopSessionRefused();
        throw new Error("Tomverse did not confirm the generated file.");
      }
      return readBinaryBody(response, input.byteSize);
    },
    async search(query: string, product: DesktopTextProduct = "chat") {
      const { results } = await request(DESKTOP_CHAT_SEARCH + "?q=" + encodeURIComponent(query), z.object({
        results: z.array(chatHistoryHit),
      }));
      return results.filter((row) => row.surface !== (product === "review" ? "chat" : "workspace"));
    },
    conversation,
    async uploadAttachment(input: AttachmentBytesInput, turn: AbortSignal) {
      const format = resolveChatAttachmentFormat({ filename: input.name, declaredMediaType: input.mediaType });
      if (!format) throw new Error("Tomverse cannot use this attachment format.");
      const metadata = { name: input.name, size: input.bytes.byteLength, mediaType: format.mediaType };
      const preparation = await request(DESKTOP_CHAT_TURN, uploadPreparation, "PUT", metadata, { turn });
      const url = new URL(preparation.uploadUrl);
      const devLoopback = new URL(origin).hostname === "127.0.0.1" && url.hostname === "127.0.0.1" && url.protocol === "http:";
      const trustedStorage = url.protocol === "https:" && !url.port && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) &&
        url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
        Boolean(url.searchParams.get("X-Amz-Signature"));
      if ((!devLoopback && !trustedStorage) || url.username || url.password ||
          preparation.uploadHeaders["Content-Type"] !== format.mediaType) {
        throw new Error("Tomverse did not confirm the upload destination.");
      }
      const uploaded = await fetch(url, { method: "PUT", body: new Uint8Array(input.bytes), headers: preparation.uploadHeaders,
        credentials: "omit", redirect: "error", signal: AbortSignal.any([turnSignal(turn), AbortSignal.timeout(90_000)]) });
      await uploaded.body?.cancel().catch(() => {});
      if (!uploaded.ok) throw new Error("The attachment could not be uploaded.");
      // Once storage confirms the bytes, finish registration so a cancelled draft can discard its receipt.
      return request(DESKTOP_CHAT_TURN, attachmentUpload, "PATCH", { key: preparation.key, ...metadata });
    },
    async importDriveAttachment(file: DriveSelection["files"][number], accessToken: string, turn: AbortSignal) {
      return request(DESKTOP_CHAT_TURN, attachmentUpload, "PUT", {
        action: "google-drive-import", fileId: file.id, name: file.name, mediaType: file.mimeType, accessToken,
      }, { turn, timeout: 60_000 });
    },
    async checkDeepResearch(assistantMessageId: string) {
      return request(DESKTOP_DEEP_RESEARCH_STATUS, z.object({
        status: z.enum(["submitted", "in_progress", "completed", "failed"]),
        content: z.string().optional(),
      }), "POST", { assistantMessageId });
    },
    async discardAttachment(uploadId: string) {
      const response = await send(DESKTOP_CHAT_TURN, "DELETE", { uploadId },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new DesktopApiError(response.status);
    },
    async importedSource({ id, offset }: ChatSourceInput) {
      return request(pathFor(id) + "/continuation?offset=" + (offset ?? "end") + "&limit=50", chatImportedSourceWire);
    },
    async models(): Promise<ChatModel[]> {
      const { models } = await request("/api/models/catalog", catalog, "GET", undefined, { publicRead: true });
      return models.flatMap((entry) => {
        const parsed = catalogModel.safeParse(entry);
        if (!parsed.success || !isPubliclySelectableModel(parsed.data)) return [];
        const model = parsed.data;
        const seed = getModel(model.id);
        return [{ ...model, provider: model.provider as AiProvider, apiModel: model.id,
          icon: model.icon ?? seed?.icon ?? "", bestFor: model.bestFor ?? seed?.bestFor ?? "",
          usageClass: model.usageClass ?? seed?.usageClass ?? "standard" }];
      });
    },
    async rename({ id, title }: ChatRenameInput) {
      return request(pathFor(id), z.object({ title: z.string() }), "PATCH", { title });
    },
    prepareReviewAnalysis(id: string): Promise<ReviewSetup> {
      return request(pathFor(id) + "/comparison-reviews?reviewMode=balanced&includeSynthesis=false", reviewSetup);
    },
    runReviewAnalysis({ conversationId, ...input }: ReviewAnalysisRequest): Promise<ComparisonReview> {
      return request(pathFor(conversationId) + "/comparison-reviews", reviewAnalysis, "POST", {
        ...input, reviewMode: "balanced", includeSynthesis: false,
      }, { timeout: 180_000 });
    },
    async remove(id: string) {
      await request(pathFor(id), z.object({ success: z.literal(true) }), "DELETE");
    },
    async create(input: ChatTurnInput, turn: AbortSignal) {
      const { id } = await request(DESKTOP_CHAT_CREATE, z.object({ id: chatId }), "POST", { selectedModels: [input.modelId], ...(input.projectId ? { projectId: input.projectId } : {}) },
        { turn, headers: { [CHAT_INITIAL_SELECTION_MODE_HEADER]: input.selectionMode } });
      return id;
    },
    async configure(current: ChatConversation, input: ChatTurnInput, turn: AbortSignal) {
      const savedModels = current.storedSelectedModels ?? current.selectedModels;
      const changed = current.selectionMode !== input.selectionMode ||
          (input.selectionMode === "manual" && savedModels[0] !== input.modelId);
      if (changed || (input.tools && Object.keys(input.tools).length)) {
        await request(pathFor(current.id), z.object({ id: chatId }), "PATCH", {
          ...(changed ? { selectionMode: input.selectionMode, ...(input.selectionMode === "manual" ? { selectedModels: [input.modelId] } : {}) } : {}),
          ...input.tools,
        }, { turn });
      }
    },
    async routeReview(input: ReviewTurnInput, context: string, turn: AbortSignal, attachments: readonly AttachmentUpload[]) {
      return askReviewRoute({ text: input.prompt || "Review the attached files.", providers: input.choices,
        hasImages: attachments.some((attachment) => formatByMediaType(attachment.mediaType)?.category === "image"), context }, (path, init) => {
        if (path !== DESKTOP_REVIEW_ROUTING || init?.method !== "POST" || typeof init.body !== "string") {
          throw new Error("Invalid Review routing request.");
        }
        return send(DESKTOP_REVIEW_ROUTING, "POST", JSON.parse(init.body), {
          signal: AbortSignal.any([turnSignal(turn), ...(init.signal ? [init.signal] : [])]),
        });
      });
    },
    async createReview(models: string[], prompt: string, turn: AbortSignal) {
      const { id } = await request(DESKTOP_REVIEW_CREATE, z.object({ id: chatId }), "POST",
        { title: Array.from(prompt.replace(/\s+/g, " ").trim()).slice(0, 80).join("") || "New review", selectedModels: models }, { turn });
      return id;
    },
    async configureReview(current: ChatConversation, models: string[], turn: AbortSignal) {
      if (current.selectedModels.join("\n") === models.join("\n")) return;
      await request(pathFor(current.id), z.object({ id: chatId }), "PATCH",
        { selectedModels: models, selectionMode: "manual" }, { turn });
    },
    async admitReview(current: ChatConversation, input: ReviewTurnInput, modelIds: string[], turn: AbortSignal, attachments: readonly AttachmentUpload[]) {
      return request(DESKTOP_REVIEW_PREFLIGHT, reviewAdmission, "POST", {
        comparisonId: Date.now().toString(), conversationId: current.id, modelIds,
        prompt: input.prompt, attachments: attachments.map(({ mediaType, size }) => ({ mediaType, size })), webSearchMode: current.webSearchMode,
      }, { turn });
    },
    async saveQuestion(id: string, input: Pick<ChatTurnInput, "requestId" | "prompt" | "attachmentUploadIds"> & { onlyModelId?: string }, turn: AbortSignal) {
      const receipt = await request(pathFor(id) + "/messages", questionReceipt, "POST", {
        messages: [{ clientRequestId: input.requestId, role: "user", content: input.prompt,
          ...(input.onlyModelId ? { modelId: input.onlyModelId } : {}),
          ...(input.attachmentUploadIds?.length ? { attachmentUploadIds: input.attachmentUploadIds } : {}) }],
      }, { turn });
      const sourceId = receipt.messageMappings.find((mapping) => mapping.requestId === input.requestId)?.messageId;
      if (!sourceId) throw new Error("Tomverse did not confirm the saved question.");
      return sourceId;
    },
    async stream(current: ChatConversation, input: StreamSelection, sourceId: string, assistantId: string,
      turn: AbortSignal, progress: (text: string, mcp?: McpProgressState) => void, reportModel?: (id: string) => void) {
      const at = current.messages.findIndex((message) => message.id === sourceId && message.role === "user");
      if (at < 0 || !current.selectedModels[0]) throw new Error("Tomverse could not confirm the source question and model.");
      const modelId = input.review ? input.modelId : current.selectedModels[0];
      if (current.selectionMode !== input.selectionMode || !current.selectedModels.includes(modelId) ||
          (input.selectionMode === "manual" && modelId !== input.modelId)) {
        throw new Error("The model selection changed in Tomverse.");
      }
      // A question put to one other model alone is not part of this model's conversation.
      const messages = fitChatRequestTranscript(current.messages.slice(0, at + 1).filter((message) =>
        (message.role === "user" && (!input.review || !message.modelId || message.modelId === modelId)) || (message.role === "assistant" && (!input.review || message.modelId === modelId) &&
          (!message.status || ["normal", "incomplete"].includes(message.status))))
        .map(({ id, role, content, attachments }) => {
          const references = attachments?.map(({ id, attachmentId, name, mediaType, size, kind }) => ({ id, attachmentId, name, mediaType, size, kind }));
          return { id, role, content, ...(references?.length ? { attachments: references } : {}) };
        }));
      const prepare = async (previousContextBundle?: string) => {
        try {
          const { contextBundle } = await request(DESKTOP_CHAT_CONTEXT, chatContext, "POST", {
            conversationId: current.id, sourceUserMessageId: sourceId, modelId,
            ...(previousContextBundle ? { previousContextBundle } : {}),
          }, { turn });
          return contextBundle;
        } catch (error) {
          turnSignal(turn).throwIfAborted();
          if (previousContextBundle || error instanceof DesktopSessionRefused ||
              error instanceof DesktopApiError && [400, 403, 409, 423].includes(error.status)) throw error;
          return null;
        }
      };
      // A chosen plugin turn is never a signed-context (location fusion) turn, as on the web.
      const mcpConnectionId = input.review ? undefined : input.mcpConnectionId;
      const contextBundle = input.review ? input.admission?.contextBundle : mcpConnectionId ? null : await prepare();
      const timeout = new AbortController();
      const watchdog = createChatLivenessWatchdog({ onExpire: () => timeout.abort() });
      try {
        const stream = (bundle?: string | null) => {
          const currentLocation = input.review ? null : parseChatLocation(input.currentLocation);
          return send(DESKTOP_CHAT_TURN, "POST", {
            ...(currentLocation ? { currentLocation } : {}),
            conversationId: current.id, assistantMessageId: assistantId, sourceUserMessageId: sourceId,
            messages, modelId, webSearchMode: current.webSearchMode,
            ...(input.admission ? { admissionToken: input.admission.admissionToken } : {}),
            ...(bundle ? { contextBundle: bundle } : {}),
            ...(mcpConnectionId ? { mcpConnectionId } : {}),
            ...(input.deepResearchDepth ? { deepResearchDepth: input.deepResearchDepth }
              : input.effort === "default" ? {} : { reasoningEffort: input.effort }),
          }, { signal: AbortSignal.any([turnSignal(turn), timeout.signal]) });
        };
        let response = await stream(contextBundle);
        if (!input.review && contextBundle && response.status === 409) {
          // A signed-context refusal happens before the provider stream and keeps the same saved turn identity.
          const refusal = staleChatContext.safeParse(await response.json().catch(() => null));
          if (refusal.success) {
            response = await stream(await prepare(contextBundle));
            if (response.status === 409 && staleChatContext.safeParse(await response.json().catch(() => null)).success) {
              throw new DesktopChatContextChanged("The signed Chat context changed again.");
            }
          }
        }
        watchdog.noteHeaders();
        if (input.deepResearchDepth && modelId === DEEP_RESEARCH_MODEL_ID && response.ok &&
            response.headers.get("content-type")?.includes("application/json")) {
          const receipt = z.object({ deepResearchJobId: z.literal(assistantId), status: z.literal("submitted") }).parse(await response.json());
          return { deepResearch: receipt.status, appliedReasoningEffort: undefined };
        }
        if (!input.review && response.ok && response.headers.get("x-chat-response-mode") === "image-turn") {
          // The server's Auto judgement found an image request and stopped before charging anything.
          const decision = readChatImageTurnRequest(((await response.json().catch(() => null)) as { imageTurn?: unknown } | null)?.imageTurn);
          if (decision) return { imageTurn: decision, appliedReasoningEffort: undefined };
        }
        if (!response.ok || !response.body || response.headers.get("content-type")?.includes("application/json") || input.deepResearchDepth) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Tomverse could not start this Chat response.");
        }
        const routedModel = response.headers.get("x-chat-routed-model");
        if (routedModel && /^[a-zA-Z0-9._:-]{1,120}$/.test(routedModel)) reportModel?.(routedModel);
        const reader = response.body.getReader();
        try {
          const result = await consumeChatStream({ reader, liveness: watchdog, onProgress: ({ displayText, mcpProgress }) => progress(displayText, mcpProgress) });
          if (result.serverStallCode) throw new Error("Tomverse stopped waiting for the model.");
          return parseChatStreamTrailer(result.searchMetadataJson);
        } finally {
          reader.releaseLock();
        }
      } finally {
        watchdog.stop();
      }
    },
  };
}
