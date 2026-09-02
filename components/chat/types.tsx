import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import type { MessageErrorReportContext } from "@/lib/errorReportContract";
import type { ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import type { ConversationSurface } from "@/lib/continuationRoutes";

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
  /**
   * When object storage confirmed, with a 404, that this file's bytes are
   * gone.
   *
   * Read from the conversation payload, so it survives a reload -- which is
   * the point: a card that only knew it was broken during the failing turn
   * would look ordinary again the next time the conversation was opened, and
   * the person would attach nothing and ask about a file nobody has.
   *
   * A verdict, never a location. The server sends this and a reason; it never
   * sends a key, a bucket or a URL
   * (docs/policy/user-attachment-persistence.md section 5).
   */
  unavailableAt?: string;
  /** One of MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS. */
  unavailableReason?: string;
  /**
   * What the server made of an archive: how many entries it will read and how
   * many it left out.
   *
   * Runtime only, and display only. The count used to exist solely in a
   * four-second toast, so a person who looked away never learned that two of
   * the files they attached were not going to be read -- and later saw an
   * answer that did not mention them, with nothing on screen to explain why.
   * The chip carries it for as long as the file is attached.
   *
   * It is not sent anywhere: `lib/chatMessageSerialization.ts` is an
   * allowlist, so this field is dropped from every request and every stored
   * message without needing a rule of its own. The server recomputes the plan
   * on the turn that sends the archive; this is a copy of what it already
   * said, not an input to it.
   */
  archive?: {
    includedFiles: number;
    excludedFiles: number;
  };
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
   * The stored attachments this turn could not read, from an
   * ATTACHMENT_UNAVAILABLE refusal.
   *
   * Ids only, and only the ones the server named. They are what the "continue
   * without it" action sends back as its acknowledgement, which is why a
   * client cannot widen its own permission here: an id the server did not
   * name acknowledges nothing.
   */
  unavailableAttachmentIds?: string[];
  /**
   * Whether continuing without those files is offered.
   *
   * False for a file on the message being sent right now -- there the better
   * remedy is obvious and offering to proceed would invite a question about a
   * document that was just lost. True only for files from earlier turns.
   */
  canContinueWithoutUnavailableAttachments?: boolean;
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
   * The model Auto routed this turn to, and the Router's own reason
   * identifier.
   *
   * Both are read from this response's headers, and the server sets them only
   * when the Router actually chose the model (`autoSelection.routed`). A turn
   * that fell back to the user's own model carries neither, so a badge cannot
   * claim a routing decision that did not happen -- the same rule
   * `lib/autoModelSelection.ts` makes unrepresentable on the server.
   *
   * `routedReason` is a fixed identifier, never prose and never anything
   * derived from what the user wrote, so the client localises it and nothing
   * about the turn crosses the wire.
   *
   * Runtime-only, like `memoryUsedCount`: the serializers in
   * lib/chatMessageSerialization.ts are allowlists, so this stays out of
   * transcripts and storage, where it could only ever be a stale claim.
   */
  routedModelId?: string;
  routedReason?: string | null;
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
   * Present when this bubble is part of an imported transcript rather than a
   * turn taken in Tomverse.
   *
   * One optional object rather than the three loose fields it replaces
   * (`surface`, `readOnly`, `sourceProvider`): imported and read-only are the
   * same fact here, and a shape that could say "imported but writable" would
   * be a shape somebody eventually writes. Its presence *is* the surface.
   *
   * A view-model field only. The imported half is never copied into `Message`
   * rows -- docs/policy/external-conversation-continuation.md keeps the
   * snapshot immutable and outside this conversation's own storage -- and the
   * serializers in lib/chatMessageSerialization.ts are allowlists, so a
   * message carrying this can never ride a transcript, a request body or
   * localStorage.
   */
  imported?: {
    /** One of `EXTERNAL_IMPORT_PROVIDERS`, as the bridge recorded it. */
    provider: string;
    /**
     * What the source called the model that wrote this answer, verbatim.
     * Never resolved against the Tomverse catalogue: it names a model this
     * app may not serve, and rendering it as one of ours would claim a
     * Tomverse answer where there was none.
     */
    sourceModelLabel?: string | null;
    /** Whether the snapshot itself recorded this message as truncated. */
    truncated?: boolean;
  };
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
    /**
     * Where this conversation opens (`lib/continuationRoutes.ts`).
     *
     * Server-decided from the row, and absent on a guest conversation, which
     * has no server row and can never be a continuation. Absent reads as
     * `"workspace"` -- the behaviour every conversation had before
     * continuations existed.
     */
    surface?: ConversationSurface;
    /**
     * Which service this conversation's imported half came from, so the
     * sidebar row can carry that service's icon.
     *
     * Server-decided from the bridge's own column, which outlives the
     * snapshot. Absent on every conversation that has no imported half.
     */
    sourceProvider?: string | null;
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
