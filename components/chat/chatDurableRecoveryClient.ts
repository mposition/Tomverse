import type { ChatAttachment, Message } from "@/components/chat/types";
import { parseChatStreamArtifacts } from "@/lib/generatedArtifactCore";
import { sanitizeWebSearchCitations } from "@/lib/webSearchCitations";
import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";

export type PublicChatDraft = {
  scopeKey: string;
  text: string;
  attachmentReferences: Array<{ uploadId: string } | { attachmentId: string }>;
  attachments: ChatAttachment[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicChatResponseAttempt = {
  assistantMessageId: string;
  conversationId: string;
  sourceUserMessageId: string;
  requestedModelId: string;
  actualModelId: string | null;
  provider: string | null;
  status: "claimed" | "streaming" | "completed" | "failed" | "cancelled";
  partialContent: string;
  checkpointRevision: number;
  finishReason: string | null;
  failureCode: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const stringOrNull = (value: unknown) =>
  typeof value === "string" ? value : value === null ? null : undefined;

const parseAttachment = (value: unknown): ChatAttachment | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    typeof value.mediaType !== "string" ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    (value.kind !== "file" && value.kind !== "text")
  ) {
    return null;
  }
  if (
    (value.uploadId != null && typeof value.uploadId !== "string") ||
    (value.attachmentId != null && typeof value.attachmentId !== "string") ||
    (value.unavailableAt != null && typeof value.unavailableAt !== "string") ||
    (value.unavailableReason != null && typeof value.unavailableReason !== "string")
  ) {
    return null;
  }
  const uploadId = typeof value.uploadId === "string" ? value.uploadId : null;
  const attachmentId =
    typeof value.attachmentId === "string" ? value.attachmentId : null;
  const unavailableAt =
    typeof value.unavailableAt === "string" ? value.unavailableAt : null;
  const unavailableReason =
    typeof value.unavailableReason === "string" ? value.unavailableReason : null;
  return {
    id: value.id,
    name: value.name,
    mediaType: value.mediaType,
    size: value.size,
    kind: value.kind,
    ...(uploadId ? { uploadId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    ...(unavailableAt ? { unavailableAt } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
};

export type ParsedBoundMessageAttachment = ChatAttachment & {
  ordinal: number;
  messageId?: string;
};

const parseBoundMessageAttachments = (
  value: unknown,
  expectedCount: number,
  messageId?: string
): ParsedBoundMessageAttachment[] | null => {
  if (!Array.isArray(value) || value.length !== expectedCount) return null;
  const parsed: ParsedBoundMessageAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isSafeInteger(item.ordinal) ||
        (item.ordinal as number) < 0 || (item.ordinal as number) >= expectedCount) {
      return null;
    }
    if (messageId !== undefined && item.messageId !== messageId) return null;
    const attachment = parseAttachment(item);
    if (!attachment) return null;
    parsed.push({
      ...attachment,
      ordinal: item.ordinal as number,
      ...(messageId !== undefined ? { messageId } : {}),
    });
  }
  if (new Set(parsed.map((item) => item.ordinal)).size !== expectedCount) {
    return null;
  }
  parsed.sort((left, right) => left.ordinal - right.ordinal);
  return parsed;
};

export type ParsedChatMessageSaveResponse = {
  requestId: string;
  messageId: string;
  draftConsumed: true;
  attachments: ParsedBoundMessageAttachment[];
};

export type ParsedMessageSaveMapping = {
  requestId: string;
  messageId: string;
};

const parseOneMessageMapping = (
  value: unknown,
  requestId: string
): ParsedMessageSaveMapping | null => {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0]) ||
      value[0].requestId !== requestId || !isUuid(value[0].messageId) ||
      value[0].messageId === requestId) {
    return null;
  }
  return { requestId, messageId: value[0].messageId };
};

export function parseMessageSaveMapping(
  value: unknown,
  requestId: string
): ParsedMessageSaveMapping | null {
  if (!isRecord(value) || value.success !== true ||
      !Number.isSafeInteger(value.created) || (value.created as number) < 0) {
    return null;
  }
  return parseOneMessageMapping(value.messageMappings, requestId);
}

/**
 * A 2xx is transport metadata, not proof that the Message transaction was
 * accepted. The durable Chat path requires the exact acknowledgement and the
 * complete ordered attachment binding before it consumes local state.
 */
export function parseChatMessageSaveResponse(
  value: unknown,
  input: { requestId: string; expectedAttachmentCount: number }
): ParsedChatMessageSaveResponse | null {
  if (!isRecord(value) || value.success !== true ||
      !Number.isSafeInteger(value.created) || (value.created as number) < 0 ||
      value.draftConsumed !== true) {
    return null;
  }
  const mapping = parseOneMessageMapping(value.messageMappings, input.requestId);
  if (!mapping) return null;
  const attachments = parseBoundMessageAttachments(
    value.attachments ?? [],
    input.expectedAttachmentCount,
    mapping.messageId
  );
  if (!attachments) return null;
  return { ...mapping, draftConsumed: true, attachments };
}

export type ParsedChatDraftMessageReceipt =
  | {
      outcome: "committed";
      requestId: string;
      messageId: string;
      attachments: ParsedBoundMessageAttachment[];
    }
  | { outcome: "unchanged" | "ambiguous"; attachments: [] };

export function parseChatDraftMessageReceipt(
  value: unknown,
  input: { requestId: string; expectedAttachmentCount: number }
): ParsedChatDraftMessageReceipt | null {
  if (!isRecord(value) ||
      !["committed", "unchanged", "ambiguous"].includes(String(value.outcome))) {
    return null;
  }
  if (value.outcome === "committed") {
    if (value.requestId !== input.requestId || !isUuid(value.messageId) ||
        value.messageId === input.requestId) {
      return null;
    }
    const attachments = parseBoundMessageAttachments(
      value.attachments,
      input.expectedAttachmentCount
    );
    return attachments ? {
      outcome: "committed",
      requestId: input.requestId,
      messageId: value.messageId,
      attachments,
    } : null;
  }
  if (!Array.isArray(value.attachments) || value.attachments.length !== 0) {
    return null;
  }
  return { outcome: value.outcome as "unchanged" | "ambiguous", attachments: [] };
}

export function parsePublicChatDraft(
  value: unknown,
  expectedScopeKey?: string
): PublicChatDraft | null {
  if (!isRecord(value)) return null;
  const revision = value.revision;
  const references = value.attachmentReferences;
  const attachments = value.attachments;
  if (
    typeof value.scopeKey !== "string" ||
    (expectedScopeKey !== undefined && value.scopeKey !== expectedScopeKey) ||
    typeof value.text !== "string" ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(references) ||
    !Array.isArray(attachments)
  ) {
    return null;
  }
  const parsedReferences: PublicChatDraft["attachmentReferences"] = [];
  const parsedAttachments: ChatAttachment[] = [];
  const seenReferences = new Set<string>();
  for (let ordinal = 0; ordinal < references.length; ordinal += 1) {
    const reference = references[ordinal];
    const rawAttachment = attachments[ordinal];
    if (!isRecord(reference) || !isRecord(rawAttachment) ||
        rawAttachment.ordinal !== ordinal) return null;
    const referenceKeys = Object.keys(reference);
    const isUpload = referenceKeys.length === 1 &&
      referenceKeys[0] === "uploadId" &&
      typeof reference.uploadId === "string" && reference.uploadId.length > 0;
    const isAttachment = referenceKeys.length === 1 &&
      referenceKeys[0] === "attachmentId" &&
      typeof reference.attachmentId === "string" && reference.attachmentId.length > 0;
    if (isUpload === isAttachment) return null;
    const id = isUpload ? reference.uploadId as string : reference.attachmentId as string;
    const identity = `${isUpload ? "upload" : "attachment"}:${id}`;
    if (seenReferences.has(identity) || rawAttachment.id !== id ||
        (isUpload && (rawAttachment.uploadId !== id ||
          Object.prototype.hasOwnProperty.call(rawAttachment, "attachmentId"))) ||
        (isAttachment && (rawAttachment.attachmentId !== id ||
          Object.prototype.hasOwnProperty.call(rawAttachment, "uploadId")))) {
      return null;
    }
    const parsedAttachment = parseAttachment(rawAttachment);
    if (!parsedAttachment) return null;
    seenReferences.add(identity);
    parsedReferences.push(isUpload ? { uploadId: id } : { attachmentId: id });
    parsedAttachments.push(parsedAttachment);
  }
  if (attachments.length !== parsedReferences.length) return null;
  return {
    scopeKey: value.scopeKey,
    text: value.text,
    attachmentReferences: parsedReferences,
    attachments: parsedAttachments,
    revision: revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export type ParsedChatDraftResponse = { draft: PublicChatDraft | null };

/** A successful read/write response must explicitly carry its scoped draft. */
export function parseChatDraftResponse(
  value: unknown,
  expectedScopeKey: string
): ParsedChatDraftResponse | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "draft")) {
    return null;
  }
  if (value.draft === null) return { draft: null };
  const draft = parsePublicChatDraft(value.draft, expectedScopeKey);
  return draft ? { draft } : null;
}

export type ParsedChatDraftConflict = {
  currentRevision: number;
  currentDraft: PublicChatDraft | null;
};

export const isChatDraftAttachmentRecoveryConflict = (value: unknown) =>
  isRecord(value) && value.code === "CHAT_DRAFT_ATTACHMENT_INVALID";

/**
 * A 409 is not enough to discard local input. Accept only the two snapshots
 * the server can coherently report: no row at all, or one parsed draft whose
 * revision exactly matches the advertised CAS value.
 */
export function parseChatDraftConflict(
  value: unknown,
  expectedScopeKey: string
): ParsedChatDraftConflict | null {
  if (!isRecord(value) ||
      (value.code !== "CHAT_DRAFT_REVISION_CONFLICT" &&
        value.code !== "CHAT_DRAFT_ATTACHMENT_INVALID") ||
      !Object.prototype.hasOwnProperty.call(value, "currentRevision") ||
      !Object.prototype.hasOwnProperty.call(value, "currentDraft")) {
    return null;
  }
  if (value.currentRevision === null && value.currentDraft === null) {
    return { currentRevision: 0, currentDraft: null };
  }
  if (!Number.isSafeInteger(value.currentRevision) ||
      (value.currentRevision as number) < 1) {
    return null;
  }
  const currentDraft = parsePublicChatDraft(value.currentDraft, expectedScopeKey);
  if (!currentDraft || currentDraft.revision !== value.currentRevision) return null;
  return {
    currentRevision: value.currentRevision as number,
    currentDraft,
  };
}

export function parsePublicChatResponseAttempt(
  value: unknown
): PublicChatResponseAttempt | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const checkpointRevision = value.checkpointRevision;
  if (
    typeof value.assistantMessageId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.sourceUserMessageId !== "string" ||
    typeof value.requestedModelId !== "string" ||
    !["claimed", "streaming", "completed", "failed", "cancelled"].includes(
      String(status)
    ) ||
    !Number.isSafeInteger(checkpointRevision) ||
    (checkpointRevision as number) < 0 ||
    typeof value.partialContent !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  const actualModelId = stringOrNull(value.actualModelId);
  const provider = stringOrNull(value.provider);
  const finishReason = stringOrNull(value.finishReason);
  const failureCode = stringOrNull(value.failureCode);
  const terminalAt = stringOrNull(value.terminalAt);
  if (
    actualModelId === undefined ||
    provider === undefined ||
    finishReason === undefined ||
    failureCode === undefined ||
    terminalAt === undefined
  ) {
    return null;
  }
  return {
    assistantMessageId: value.assistantMessageId,
    conversationId: value.conversationId,
    sourceUserMessageId: value.sourceUserMessageId,
    requestedModelId: value.requestedModelId,
    actualModelId,
    provider,
    status: status as PublicChatResponseAttempt["status"],
    partialContent: value.partialContent,
    checkpointRevision: checkpointRevision as number,
    finishReason,
    failureCode,
    terminalAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

const parseStoredWebSearchExecution = (
  value: unknown
): { ok: true; value: WebSearchExecution | null } | { ok: false } => {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (
    !isRecord(value) ||
    typeof value.requested !== "boolean" ||
    typeof value.supported !== "boolean" ||
    typeof value.executed !== "boolean" ||
    typeof value.provider !== "string" ||
    !Array.isArray(value.citations) ||
    value.citations.some((citation) => !isRecord(citation))
  ) {
    return { ok: false };
  }
  const optionalCount = (candidate: unknown) =>
    candidate === undefined ||
    (Number.isSafeInteger(candidate) && (candidate as number) >= 0);
  if (
    (value.tool !== undefined && typeof value.tool !== "string") ||
    !optionalCount(value.queryCount) ||
    (value.failureCode !== undefined && typeof value.failureCode !== "string") ||
    (value.executionKind !== undefined &&
      !["provider_native", "search_model", "app_managed"].includes(
        String(value.executionKind)
      )) ||
    (value.searchBackend !== undefined && typeof value.searchBackend !== "string") ||
    !optionalCount(value.backendRequestCount)
  ) {
    return { ok: false };
  }
  let costMetadata: Record<string, number> | undefined;
  if (value.costMetadata !== undefined) {
    if (!isRecord(value.costMetadata)) return { ok: false };
    const entries = Object.entries(value.costMetadata);
    if (entries.some(([, amount]) =>
      typeof amount !== "number" || !Number.isFinite(amount) || amount < 0
    )) {
      return { ok: false };
    }
    costMetadata = Object.fromEntries(entries) as Record<string, number>;
  }
  return {
    ok: true,
    value: {
      requested: value.requested,
      supported: value.supported,
      executed: value.executed,
      provider: value.provider,
      citations: sanitizeWebSearchCitations(value.citations),
      ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
      ...(typeof value.queryCount === "number" ? { queryCount: value.queryCount } : {}),
      ...(typeof value.failureCode === "string"
        ? { failureCode: value.failureCode }
        : {}),
      ...(costMetadata ? { costMetadata } : {}),
      ...(typeof value.executionKind === "string"
        ? { executionKind: value.executionKind as WebSearchExecution["executionKind"] }
        : {}),
      ...(typeof value.searchBackend === "string"
        ? { searchBackend: value.searchBackend }
        : {}),
      ...(typeof value.backendRequestCount === "number"
        ? { backendRequestCount: value.backendRequestCount }
        : {}),
    },
  };
};

/**
 * Accepts the canonical Message bundled with a completed attempt read.
 *
 * This is an allowlist, not a cast. A response containing a storage key or
 * provider-private state may still be valid JSON, but none of those fields can
 * enter the browser's Message object through this function. Identity, model
 * attribution and completion status are also bound back to the attempt so a
 * malformed envelope cannot replace an unrelated transcript row. Content is
 * deliberately taken from the Message instead of requiring byte equality with
 * partialContent: the attempt checkpoint has a different storage bound, while
 * the committed Message is the canonical completed transcript row.
 */
export function parseCompletedChatResponseMessage(
  value: unknown,
  attempt: PublicChatResponseAttempt
): Message | null {
  if (attempt.status !== "completed" || !isRecord(value)) return null;
  const expectedModelId = attempt.actualModelId ?? attempt.requestedModelId;
  const expectedStatus = attempt.finishReason === "length" ? "incomplete" : "normal";
  if (
    value.id !== attempt.assistantMessageId ||
    value.role !== "assistant" ||
    typeof value.content !== "string" ||
    value.status !== expectedStatus ||
    value.modelId !== expectedModelId ||
    typeof value.createdAt !== "string" ||
    (value.pendingJobId !== undefined && value.pendingJobId !== null)
  ) {
    return null;
  }
  const searchMetadata = parseStoredWebSearchExecution(value.searchMetadata);
  if (!searchMetadata.ok) return null;
  const positiveCount = (candidate: unknown) =>
    candidate === undefined ||
    (Number.isSafeInteger(candidate) && (candidate as number) > 0);
  if (
    !positiveCount(value.memoryUsedCount) ||
    !positiveCount(value.knowledgeChunkCount) ||
    value.attachments !== undefined
  ) {
    return null;
  }
  let artifacts: ReturnType<typeof parseChatStreamArtifacts> = null;
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts)) return null;
    artifacts = parseChatStreamArtifacts(value.artifacts);
    if (!artifacts || artifacts.length !== value.artifacts.length) return null;
  }
  return {
    id: value.id,
    role: "assistant",
    content: value.content,
    status: expectedStatus,
    modelId: expectedModelId,
    createdAt: value.createdAt,
    searchMetadata: searchMetadata.value,
    ...(typeof value.memoryUsedCount === "number"
      ? { memoryUsedCount: value.memoryUsedCount }
      : {}),
    ...(typeof value.knowledgeChunkCount === "number"
      ? { knowledgeChunkCount: value.knowledgeChunkCount }
      : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

export const isActiveChatResponseAttempt = (
  attempt: PublicChatResponseAttempt
) => attempt.status === "claimed" || attempt.status === "streaming";

/**
 * A claim that was refused before dispatch has no assistant content to show.
 * The durable row remains useful for audit/retry exclusion, but rendering an
 * empty error bubble after reload creates a transcript message that never
 * existed. The server filters these rows; keep the client defensive for old or
 * rolling-deploy responses.
 */
export const isInvisiblePreDispatchAttempt = (
  attempt: PublicChatResponseAttempt
) =>
  attempt.status === "failed" &&
  attempt.failureCode === "request_refused" &&
  attempt.partialContent.length === 0;

export function messageFromChatResponseAttempt(
  attempt: PublicChatResponseAttempt,
  failureNotice: string
): Message {
  const modelId = attempt.actualModelId ?? attempt.requestedModelId;
  if (attempt.status === "failed") {
    return {
      id: attempt.assistantMessageId,
      role: "assistant",
      content: attempt.partialContent,
      status: "error",
      modelId,
      errorCode: attempt.failureCode ?? "CHAT_ATTEMPT_FAILED",
      recoveryNotice: failureNotice,
      createdAt: attempt.createdAt,
    };
  }
  if (attempt.status === "cancelled") {
    return {
      id: attempt.assistantMessageId,
      role: "assistant",
      content: attempt.partialContent,
      status: "cancelled",
      modelId,
      createdAt: attempt.createdAt,
    };
  }
  return {
    id: attempt.assistantMessageId,
    role: "assistant",
    content: attempt.partialContent,
    status: attempt.status === "completed" && attempt.finishReason === "length"
      ? "incomplete"
      : "normal",
    modelId,
    createdAt: attempt.createdAt,
  };
}

/**
 * Adds recovery-only attempts beside their source question. A stored Message
 * with the same id always wins: it is the canonical completed transcript and
 * an attempt is only a crash/reload bridge until that Message exists.
 */
export function mergeChatResponseAttempts(
  messages: Message[],
  attempts: PublicChatResponseAttempt[],
  requestedModelId: string,
  failureNotice: string,
  transcriptScope: "conversation" | "model" = "model"
) {
  const next = [...messages];
  const attemptBackedIds = new Set<string>();
  const existingIds = new Set(next.map((message) => message.id));
  const eligible = attempts
    .filter(
      (attempt) =>
        !isInvisiblePreDispatchAttempt(attempt) &&
        (transcriptScope === "conversation" ||
          attempt.requestedModelId === requestedModelId)
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const attempt of eligible) {
    if (existingIds.has(attempt.assistantMessageId)) continue;
    const sourceIndex = next.findIndex(
      (message) => message.id === attempt.sourceUserMessageId && message.role === "user"
    );
    if (sourceIndex < 0) continue;
    let insertAt = sourceIndex + 1;
    while (insertAt < next.length && next[insertAt]?.role === "assistant") {
      insertAt += 1;
    }
    next.splice(insertAt, 0, messageFromChatResponseAttempt(attempt, failureNotice));
    existingIds.add(attempt.assistantMessageId);
    attemptBackedIds.add(attempt.assistantMessageId);
  }
  return { messages: next, attemptBackedIds };
}

export function replaceAttemptBackedMessage(
  messages: Message[],
  attempt: PublicChatResponseAttempt,
  attemptBackedIds: ReadonlySet<string>,
  failureNotice: string
) {
  if (!attemptBackedIds.has(attempt.assistantMessageId)) return messages;
  const index = messages.findIndex(
    (message) => message.id === attempt.assistantMessageId
  );
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = messageFromChatResponseAttempt(attempt, failureNotice);
  return next;
}

export function draftAttachmentReferences(attachments: ChatAttachment[]) {
  const references: PublicChatDraft["attachmentReferences"] = [];
  for (const attachment of attachments) {
    if (attachment.attachmentId) {
      references.push({ attachmentId: attachment.attachmentId });
    } else if (attachment.uploadId) {
      references.push({ uploadId: attachment.uploadId });
    } else {
      return null;
    }
  }
  return references;
}

export const sameDraftSnapshot = (
  first: { text: string; attachments: ChatAttachment[] },
  second: { text: string; attachments: ChatAttachment[] }
) =>
  first.text === second.text &&
  first.attachments.length === second.attachments.length &&
  first.attachments.every((attachment, index) => {
    const other = second.attachments[index];
    const attachmentReference = attachment.attachmentId
      ? `attachment:${attachment.attachmentId}`
      : attachment.uploadId
        ? `upload:${attachment.uploadId}`
        : null;
    const otherReference = other?.attachmentId
      ? `attachment:${other.attachmentId}`
      : other?.uploadId
        ? `upload:${other.uploadId}`
        : null;
    return Boolean(
      other &&
      (attachmentReference !== null || otherReference !== null
        ? attachmentReference === otherReference
        : attachment.id === other.id)
    );
  });
