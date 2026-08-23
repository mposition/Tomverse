import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import type { MessageErrorReportContext } from "@/lib/errorReportContract";
import type { ChatStreamArtifact } from "@/lib/generatedArtifactCore";

export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /**
   * A local preview only -- a `data:` or `blob:` URL for an image thumbnail.
   * Never sent to the server and never stored: the serializers in
   * lib/chatMessageSerialization.ts drop it.
   */
  data?: string;
  /**
   * The opaque id the upload finalisation step issued, before this attachment
   * has been bound to a saved message.
   *
   * This replaced the storage key the composer used to hold. A key in browser
   * memory is a key in a request body, and a key in a request body is
   * something a route has to decide whether to believe
   * (docs/policy/user-attachment-persistence.md).
   */
  uploadId?: string;
  /**
   * The `MessageAttachment` id, once the message this file belongs to has been
   * saved. What a reloaded conversation carries, and what a later turn names
   * to have the server read the file again.
   */
  attachmentId?: string;
  /**
   * A guest's ephemeral object key. Guests have no account to hang a durable
   * row on, so their key is derived from their own signed guest identity and
   * is self-authorising; a signed-in composer never sets this.
   */
  objectKey?: string;
  kind: "file" | "text";
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * "incomplete" is a *completed* answer that the provider cut short at its
   * output-token ceiling: the body is real and kept verbatim, and only the
   * "this finished" claim is withheld (@tomverse/chat-core). It is
   * not "cancelled" (the user stopped it) and not "error" (nothing failed),
   * and it persists through storage and a re-fetch like any other status.
   */
  status?: "normal" | "incomplete" | "error" | "cancelled" | "pending";
  attachments?: ChatAttachment[];
  modelId?: string;
  errorCode?: string;
  errorHadAttachments?: boolean;
  /**
   * Live-memory error report context for this message's own error: its trace,
   * where that trace came from, and (when the server issued one) the signed
   * error report token. Runtime only -- every serializer in
   * lib/chatMessageSerialization.ts excludes it, so it never reaches
   * localStorage, /api/chat transcripts, imports or sync payloads.
   */
  errorReport?: MessageErrorReportContext;
  createdAt?: string;
  pendingJobId?: string | null;
  searchMetadata?: WebSearchExecution | null;
  /**
   * How many account memories this answer was given (§13.4). Server-computed
   * and read from the response header -- never counted here, and never sent
   * back: the serializers in lib/chatMessageSerialization.ts are allowlists,
   * so this runtime-only field stays out of transcripts and storage, where
   * it could only ever be a stale claim.
   */
  memoryUsedCount?: number;
  /**
   * docs/policy/external-conversation-import-and-memory.md §14.3: how many
   * assistant-profile knowledge excerpts this answer's prompt
   * carried. Same provenance and same handling as `memoryUsedCount` directly
   * above -- the server's own count, absent below one, and outside the
   * serializer allowlists so it never rides a transcript or localStorage.
   */
  knowledgeChunkCount?: number;
  /**
   * Files this answer produced (docs/policy/generated-artifacts.md).
   *
   * Absent on every message that made none, which is almost all of them --
   * an artifact is an addition to an answer, never a replacement for one, so
   * `content` still carries the whole reply. Arrives twice by two paths that
   * must agree: the streaming trailer while the answer is live, and the
   * conversation re-fetch afterwards.
   *
   * Public fields only. `objectKey` and the storage URL are not in
   * `ChatStreamArtifact` at all, so neither can arrive here.
   */
  artifacts?: ChatStreamArtifact[];
  /**
   * Runtime only: the server announced that a file is being generated for
   * this answer, and the trailer has not yet said what came of it.
   *
   * Never serialized -- the allowlists in lib/chatMessageSerialization.ts do
   * not name it -- because it describes a request that is in flight, and a
   * stored copy could only ever be a spinner for work that finished before
   * the page was reloaded. The renderer additionally requires the panel to be
   * actively streaming this message, so a cancelled turn cannot leave one
   * behind either.
   */
  isGeneratingArtifact?: boolean;
  /**
   * Which format is being generated, so the spinner can name it.
   *
   * Transient for the same reason the flag is, and separate from it because a
   * signal whose payload did not parse still means "a file is being made" --
   * the flag is the fact and this is the detail.
   */
  generatingArtifactFormat?: string;
};

export type Conversation = {
  id: string;
    title: string;
    /**
     * "chat" (default) or "image". Server-decided at creation. An image
     * conversation renders the image workspace instead of the chat panels;
     * chat send, comparison, AI Review, web search, deep research, share and
     * export are all unavailable for it (docs/policy/image-generation.md §1).
     */
    kind?: "chat" | "image";
    projectId?: string | null;
    selectedModels?: string[];
    disabledPanels?: string[];
    webSearchMode?: "off" | "auto" | "always";
    isLocked?: boolean;
    shareEnabled?: boolean;
    shareExpiresAt?: string | null;
    messageCount?: number;
    createdAt?: string;
};

export const MAX_SELECTED_MODELS = 3;

export {
    AVAILABLE_MODELS,
    ENABLED_MODELS,
    PUBLIC_MODELS,
    getEnabledModel,
    getModel,
    getModelUsageProfile,
    isEnabledModelId,
} from "@/lib/models";
export type {
    AiModel,
    AiProvider,
    ModelId,
    ModelStatus,
    ModelTier,
    ModelUsageCategory,
} from "@/lib/models";
