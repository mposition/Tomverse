import { researchRunMessage } from "../../../lib/researchPreviewRunClient";
import { createResearchApi } from "@tomverse/api-client";
import type { ResearchPreviewRunDto } from "../../../lib/researchPreviewRunTypes";
import { createWorkspaceTransport } from "./workspaceTransport";
import { createApiClient, ApiClientError, requestChatLocationIntent, createProjectWorkspaceClient } from "@tomverse/api-client";
import { CONTINUATION_RECEIPT_HEADER, receiptForAttempt, type ContinuationReceipt } from "../../../lib/continuationReceipt";
import { PASSAGE_HEADER, encodePassages } from "../../../lib/continuationPassages";
import { parseChatStreamTrailer } from "../../../lib/webSearchStreamTrailer";
import { consumeChatStream } from "../../../lib/chatStreamConsumer";
import { fitChatRequestTranscript } from "../../../lib/chatRequestLimits";
import { toChatRequestMessage } from "../../../lib/chatMessageSerialization";
import { resolveChatAttachmentFormat } from "../../../lib/chatAttachmentFormats";
import { createChatLivenessWatchdog } from "../../../lib/chatStreamLiveness";
import { isPubliclySelectableModel } from "../../../lib/models";
import type { PublicCatalogModel } from "../../../lib/publicModelCatalog";
import { mobileApiFetch, MobileAuth } from "./authBridge";
import { artifactDownloadPath, ARTIFACT_LIMITS } from "../../../lib/generatedArtifactCore";
import { artifactVersionsPath, parseGeneratedArtifactVersions } from "../../../lib/generatedArtifactVersions";
import { saveMobileResponse } from "./fileSave";
import { askReviewRoute } from "../../../lib/reviewRoutingClient";
import { displayTimeZoneHeaders } from "../../../lib/continuationTitleContext";
import { readChatImageTurnRequest, readChatImageTurnRef, type ChatImageTurnRequest } from "../../../lib/chatImageTurnCore";
import { askChatImageIntent } from "../../../lib/chatImageIntentClient";
import { IMAGE_EDIT_SOURCE_MEDIA_TYPES } from "../../../lib/imageGenerationPricing";
import { uploadMobileFile } from "./nativeUpload";
import type { ChatTransport, Conversation, ImportedTranscript, MobileAttachment, MobileCapabilities, ContinuationTurnContext, PreparedArtifactRevision } from "./chatTransport";

import { nativeChatLocation } from "./chatLocation";
import type { MobileRequestInit } from "./authenticatedFetch";

/** A factory is evaluated by the credential boundary immediately before dispatch. */
type ApiFetch = (path: string, init?: MobileRequestInit) => Promise<Response>;
type Attempt = { assistantMessageId: string; partialContent: string; status: string; actualModelId?: string; requestedModelId: string };
export function createApiTransport(source: ApiFetch = mobileApiFetch, bridge = MobileAuth, saveFile = saveMobileResponse, uploadFile = uploadMobileFile, location = nativeChatLocation): ChatTransport {
  const requestedTitles = new Set<string>();
  const listeners = new Set<() => void>();
  const unlockGrants = new Map<string, string>();
  const pinSequences = new Map<string, number>();
  let locationIdentity: string | null = null;
  let sessionRevision = 0;
  let capabilityCache: { value: MobileCapabilities; expires: number } | null = null;
  let capabilityRequest: { revision: number; promise: Promise<MobileCapabilities> } | null = null;
  const routedModelByMessage = new Map<string, string>();
  const sourceReceiptByMessage = new Map<string, ContinuationReceipt>();
  const clearSessionState = () => { sessionRevision++; locationIdentity = null; location.setIdentity(null); capabilityCache = null; capabilityRequest = null; unlockGrants.clear(); pinSequences.clear(); routedModelByMessage.clear(); sourceReceiptByMessage.clear(); };
  const notifySessionLost = () => { clearSessionState(); for (const listener of listeners) listener(); };
  const run = async (path: string, init?: MobileRequestInit, softAuth = false): Promise<Response> => {
    try {
      for (const [id, token] of unlockGrants) if (Number(token.split(".")[0]) <= Date.now() / 1000) unlockGrants.delete(id);
      if (unlockGrants.size && (/^\/api\/(?:conversations|artifacts)(?:\/|\?)/.test(path) || path.startsWith("/api/chat/research-preview/") || path.startsWith("/api/chat/research/") || path === "/api/chat" || path === "/api/chat/preflight" || path === "/api/chat/context")) {
        const grantHeaders = (value?: RequestInit) => {
          const headers = new Headers(value?.headers);
          headers.set("X-Tomverse-Conversation-Unlocks", [...unlockGrants].map(([id, token]) => `${id}=${token}`).join("; "));
          return { ...value, headers };
        };
        const original = init;
        init = typeof original === "function" ? () => grantHeaders(original()) : grantHeaders(original);
      }
      const response = await source(path, init);
      if (response.status === 401) {
        // A route the server has not switched on for this device refuses with the
        // same 401 a revoked sign-in gets. For those routes, ask an enrolled one
        // before concluding the session is gone, so a switched-off project
        // workspace never signs the user out.
        if (softAuth) {
          const probe = await run("/api/user/account");
          return probe.status === 401 ? response : Response.json({ code: "NATIVE_ROUTE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        notifySessionLost();
      }
      if (response.status === 423) { const id = path.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)/)?.[1]; if (id) unlockGrants.delete(id); }
      return response;
    }
    catch (error) { if ((error as { code?: string }).code === "SIGN_IN_REQUIRED") notifySessionLost(); throw error; }
  };
  const client = createApiClient(run);
  const request = client.json;
  async function requireParity(refresh = false) {
    if (refresh) capabilityCache = null;
    if (capabilityCache && capabilityCache.expires > Date.now()) return capabilityCache.value;
    const pending = capabilityRequest ?? { revision: sessionRevision, promise: request<MobileCapabilities>("/api/products/mobile/capabilities") };
    capabilityRequest = pending;
    try { const value = await pending.promise;
      if (pending.revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
      if (typeof value.reviewEasy !== "boolean" || typeof value.assistants !== "boolean" || !["Guest", "Free", "Pro", "Max"].includes(value.plan) || !Number.isInteger(value.maxModels) || value.maxModels < 1 || value.maxModels > 8) throw Error("NATIVE_CAPABILITIES_INVALID");
      capabilityCache = { value, expires: Date.now() + 30_000 }; return value; }
    finally { if (capabilityRequest === pending) capabilityRequest = null; }
  }
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const pathFor = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
  const historySupport = async () => {
    const capability = await requireParity();
    if (!capability.historyActions) throw Object.assign(Error("NATIVE_HISTORY_UNAVAILABLE"), { code: "NATIVE_HISTORY_UNAVAILABLE" });
  };
  const historyWrite = async (path: string, method: string, body?: unknown) => {
    await historySupport(); await request(path, body === undefined ? { method } : json(method, body));
  };
  type ConversationReply = Conversation & { responseAttempts?: Attempt[]; assistantProfile?: { profileId: string } | null; messagePage?: { hasMore: boolean; nextCursor: string | null } };
  async function readConversation(id: string) {
    const first = await request<ConversationReply>(pathFor(id));
    const messages = [...first.messages]; let page = first.messagePage; const cursors = new Set<string>();
    while (page?.hasMore) {
      if (!page.nextCursor || !/^[A-Za-z0-9_-]{1,100}$/.test(page.nextCursor) || cursors.has(page.nextCursor) || cursors.size >= 100) throw Error("MOBILE_HISTORY_LIMIT");
      cursors.add(page.nextCursor);
      const next = await request<ConversationReply>(`${pathFor(id)}?cursor=${encodeURIComponent(page.nextCursor)}`);
      messages.push(...next.messages); page = next.messagePage;
    }
    return { ...first, assistantProfileId: first.assistantProfile?.profileId ?? first.assistantProfileId ?? null, messages: [...new Map(messages.map(message => [message.id, message])).values()] };
  }
  async function researchStatus(id: string, signal?: AbortSignal) {
    await requireParity();
    return request<{ status: string; content?: string }>("/api/chat/deep-research/status", { ...json("POST", { assistantMessageId: id }), signal });
  }
  async function load(id: string): Promise<Conversation> {
    let item = await readConversation(id);
    const active = (item.responseAttempts ?? []).filter((attempt) => ["claimed", "streaming"].includes(attempt.status));
    // The existing recovery endpoint reconciles expired leases without issuing
    // another model request. Read the canonical conversation again afterwards.
    for (const attempt of active) {
      await request(`/api/products/chat/attempts/${encodeURIComponent(attempt.assistantMessageId)}`);
    }
    if (active.length) item = await readConversation(id);
    let researchChanged = false;
    for (const message of item.messages.filter(message => message.pendingJobId && message.status === "pending")) {
      try { const status = await researchStatus(message.id); if (["completed", "failed"].includes(status.status)) researchChanged = true; }
      catch (error) { if ((error as { status?: number }).status === 401) throw error; }
    }
    if (researchChanged) item = await readConversation(id);
    const messages = [...item.messages];
    if (capabilityCache?.value.researchPreview?.enabled) {
      try {
      const result = await request<{ runs: ResearchPreviewRunDto[] }>(`/api/chat/research-preview/runs?conversationId=${encodeURIComponent(id)}`, { cache: "no-store" });
      for (const run of result.runs) {
        if (run.conversationId !== id) continue;
        const index = messages.findIndex(message => message.id === run.assistantMessageId);
        if (index >= 0) messages[index] = { ...messages[index], researchRunId: run.id };
        else messages.push(researchRunMessage(run));
      }
      } catch (error) { if ((error as { status?: number }).status === 401) throw error; }
    }
    if (capabilityCache?.value.researchEngine?.enabled) {
      try {
        const result = await request<{ runs: Array<{ id: string; conversationId: string; assistantMessageId: string; createdAt: string; status: string }> }>(`/api/chat/research/runs?conversationId=${encodeURIComponent(id)}`, { cache: "no-store" });
        for (const run of result.runs) {
          if (run.conversationId !== id) continue;
          const index = messages.findIndex(message => message.id === run.assistantMessageId);
          if (index >= 0) messages[index] = { ...messages[index], researchRunId: run.id, researchEngineRun: true };
          else messages.push({ id: run.assistantMessageId, role: "assistant", content: "", researchRunId: run.id, researchEngineRun: true, status: "pending", createdAt: run.createdAt } as never);
        }
      } catch (error) { if ((error as { status?: number }).status === 401) throw error; }
    }
    for (const attempt of item.responseAttempts ?? []) {
      if (messages.some((message) => message.id === attempt.assistantMessageId)) continue;
      messages.push({ id: attempt.assistantMessageId, role: "assistant", content: attempt.partialContent,
        modelId: attempt.actualModelId ?? attempt.requestedModelId, status: attempt.status });
    }
    const withRouting = messages.map(message => {
      const attempt = item.responseAttempts?.find(value => value.assistantMessageId === message.id);
      const modelId = attempt?.actualModelId ?? message.modelId;
      return { ...message, ...(sourceReceiptByMessage.has(message.id) ? { continuationReceipt: sourceReceiptByMessage.get(message.id) } : {}), ...(modelId ? { modelId } : {}), ...(routedModelByMessage.has(message.id) ? { routedModelId: attempt?.actualModelId ?? routedModelByMessage.get(message.id) } : {}) };
    });
    // A continuation carries its imported original; an unreadable source is
    // drawn as the divider alone rather than as an ordinary empty chat.
    const imported = item.surface === "continuation" ? await continuationSource(id).catch(() => undefined) : undefined;
    return { ...item, ...(imported ? { imported, ...(imported.reviewHandoff ? { reviewHandoff: imported.reviewHandoff } : {}) } : {}), messages: withRouting, assistantProfileId: item.assistantProfile?.profileId ?? item.assistantProfileId ?? null, activeAttempt: messages.some(message => Boolean(message.pendingJobId) && message.status === "pending") || Boolean(item.responseAttempts?.some((attempt) => ["claimed", "streaming"].includes(attempt.status))) };
  }
  // The imported original of a continuation, one page at a time; `offset`
  // omitted asks for the page that ends at the divider (policy §8.2 of
  // docs/policy/external-conversation-continuation.md).
  async function continuationSource(id: string, offset?: number): Promise<ImportedTranscript> {
    const value = await request<{ provider: string; importedAt: string; reviewHandoff?: import("./chatTransport").ReviewHandoffSummary; source: { status: string; messageTotal?: number; offset?: number; limit?: number; messages?: Array<{ id: string; role: string; content: string; ordinal?: number; sourceModelLabel?: string | null }> } }>(
      `${pathFor(id)}/continuation?offset=${offset === undefined ? "end" : Math.max(0, Math.trunc(offset))}`, { cache: "no-store" });
    const status = value.source.status === "deleted" || value.source.status === "locked" ? value.source.status : "available";
    const messages = status === "available" ? (value.source.messages ?? []).filter(message => message.role === "user" || message.role === "assistant")
      .map(message => ({ id: message.id, role: message.role as "user" | "assistant", content: message.content, ordinal: message.ordinal, sourceModelLabel: message.sourceModelLabel ?? null })) : [];
    return { provider: value.provider, importedAt: value.importedAt, status, messages, messageTotal: value.source.messageTotal, offset: value.source.offset ?? 0, pageSize: value.source.limit ?? 100, ...(value.reviewHandoff ? { reviewHandoff: value.reviewHandoff } : {}) };
  }
  async function configure(id: string, modelId: string, auto: boolean) {
    await request(pathFor(id), json("PATCH", { selectionMode: auto ? "auto" : "manual", ...(!auto ? { selectedModels: [modelId] } : {}) }));
    return load(id);
  }
  async function persistQuestion(conversation: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal, draft?: { revision: number }) {
    const requestId = crypto.randomUUID();
    const saved = await request<{ messageMappings: Array<{ requestId: string; messageId: string }> }>(`${pathFor(conversation.id)}/messages`, {
      ...json("POST", { ...(draft ? { draftConsume: { scopeKey: conversation.id, expectedRevision: draft.revision, requestId } } : {}), messages: [{ clientRequestId: requestId, role: "user", content: text,
        ...(files.length ? { attachmentUploadIds: files.map(file => file.uploadId) } : {}) }] }), signal,
    });
    const sourceId = saved.messageMappings.find(mapping => mapping.requestId === requestId)?.messageId;
    if (!sourceId) throw Error("MESSAGE_RECEIPT_MISSING");
    const persisted = await load(conversation.id);
    if (!persisted.messages.some(message => message.id === sourceId)) throw Error("SAVED_MESSAGE_MISSING");
    return { persisted, sourceId };
  }
  // Reuse the saved question and this answer's idempotency key. An unreadable
  // outcome is restored through load(), never resubmitted. An edit only says
  // so: the server finds the photo from the saved question.
  async function postImageTurn(conversationId: string, sourceId: string, assistantMessageId: string, modelId: string, decision: ChatImageTurnRequest, signal: AbortSignal) {
    const receipt = await request<{ imageTurn?: unknown }>(`${pathFor(conversationId)}/image-turn`, {
      ...json("POST", { sourceUserMessageId: sourceId, assistantMessageId, modelId,
        imageModelIds: decision.modelIds, preset: decision.preset,
        ...(decision.prompt ? { prompt: decision.prompt } : {}),
        ...(decision.edit ? { edit: true } : {}) }), signal,
    });
    if (!readChatImageTurnRef(receipt.imageTurn)) throw Error("CHAT_IMAGE_RECEIPT_INVALID");
  }
  // A manual-mode send with a photo may ask to change it. Auto asks on the
  // server beside its router call; here the composer asks, as the web's does.
  // Only when the server advertises edits, so an older server is never sent a
  // bearer it does not enroll; any failure or "no" leaves the ordinary send.
  async function manualPhotoEdit(persisted: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal): Promise<ChatImageTurnRequest | null> {
    if (persisted.selectionMode === "auto" || !text.trim() ||
      !files.some(file => IMAGE_EDIT_SOURCE_MEDIA_TYPES.includes(file.mediaType.toLowerCase()))) return null;
    try { if (!(await requireParity()).chatImageEdits) return null; } catch { return null; }
    const revision = sessionRevision;
    const decision = await askChatImageIntent(text, { conversationId: persisted.id, attachedPhoto: true }, (path, init) => run(String(path), () => {
      if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
      return init ?? {};
    }));
    signal.throwIfAborted();
    return decision.image && decision.edit
      ? { modelIds: decision.modelId ? [decision.modelId] : [], preset: decision.preset, edit: true }
      : null;
  }
  async function streamModel(persisted: Conversation, sourceId: string, modelId: string, signal: AbortSignal, progress: (text: string) => void, review = false, admission?: { admissionToken: string; contextBundle?: string }, continuation?: ContinuationTurnContext, research?: { locale: string }) {
    // A prepared Review binds the saved authored question. Concurrent appends
    // cannot become its current query or alter the transcript being verified.
    const sourceIndex = admission?.contextBundle ? persisted.messages.findIndex(message => message.id === sourceId) : -1;
    if (admission?.contextBundle && sourceIndex < 0) throw Error("SAVED_MESSAGE_MISSING");
    const transcript = admission?.contextBundle ? persisted.messages.slice(0, sourceIndex + 1) : persisted.messages;
    const messages = research ? persisted.messages.filter(message => message.id === sourceId && message.role === "user").map(message => ({ id: message.id, role: "user" as const, content: message.content })) : fitChatRequestTranscript(transcript.filter(message =>
      (message.role === "user" || !review || message.modelId === modelId) &&
      (message.role === "user" || message.status === "normal" || message.status === "incomplete" || !message.status))
      .map(message => toChatRequestMessage({ id: message.id, role: message.role, content: message.content, attachments: message.attachments })));
    const assistantMessageId = crypto.randomUUID();
    const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const scope = locationIdentity;
    const revision = sessionRevision;
    let sourceReceipt: ContinuationReceipt | undefined;
    let sourceAttemptTextLength = 0;
    const publishReceipt = (receipt: ContinuationReceipt | undefined) => {
      if (!receipt || revision !== sessionRevision || signal.aborted) return;
      sourceReceipt = receipt; sourceReceiptByMessage.set(assistantMessageId, receipt);
      continuation?.onReceipt?.(receipt);
    };
    let watchdog: ReturnType<typeof createChatLivenessWatchdog> | undefined;
    try {
      const fix = research ? null : await location.readForTurn(scope, controller.signal, {
        turnId: sourceId,
        requiresLocation: () => requestChatLocationIntent(String(persisted.messages.find(message => message.id === sourceId && message.role === "user")?.content ?? ""), (path, init) => run(path, () => {
          if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
          return init ?? {};
        })),
      });
      controller.signal.throwIfAborted();
      // An ordinary Chat send prepares its own context, as the web does: a
      // conversation in a project with context on is refused without one, and
      // memory and profile context ride in the same signed bundle. Review and
      // Research arrive with their own admission (or none) and are unchanged.
      const ownsContext = !admission && !research && !review;
      const projectReferences = ownsContext ? continuation?.projectReferences : undefined;
      const prepareContext = async (previous?: string) => {
        if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
        const prompt = String(persisted.messages.find(message => message.id === sourceId && message.role === "user")?.content ?? "");
        let prepared: { contextBundle?: string | null };
        try {
          prepared = await request<{ contextBundle?: string | null }>("/api/chat/context", {
            ...json("POST", { conversationId: persisted.id, modelIds: [modelId], prompt,
              ...(previous ? { previousContextBundle: previous } : {}),
              ...(projectReferences?.length ? { projectReferences } : {}) }), signal: controller.signal,
          });
        } catch (error) {
          // The project workspace switch is off for this device: a folder-era
          // project (context off) still sends, and the server alone refuses a
          // project whose context is on but cannot be prepared here.
          if (error instanceof ApiClientError && error.status === 503 && error.code === "NATIVE_PROJECT_WORKSPACE_UNAVAILABLE") return undefined;
          throw error;
        }
        controller.signal.throwIfAborted();
        if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
        return typeof prepared.contextBundle === "string" ? prepared.contextBundle : undefined;
      };
      let contextBundle = ownsContext && persisted.projectId ? await prepareContext() : undefined;
      watchdog = createChatLivenessWatchdog({ onExpire: abort });
      const dispatch = () => run("/api/chat", () => {
        controller.signal.throwIfAborted();
        if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
        return { ...json("POST", { messages, modelId, webSearchMode: research ? "always" : persisted.webSearchMode ?? "off", conversationId: persisted.id,
          ...(research ? { researchMode: "preview" } : {}),
          assistantMessageId, sourceUserMessageId: sourceId, ...(admission ?? {}),
          ...(contextBundle ? { contextBundle } : {}),
          ...(projectReferences?.length ? { projectReferences } : {}),
          ...(fix && location.canShare(fix, scope) ? { currentLocation: fix } : {}) }),
          ...(continuation?.sourcePassages !== undefined && !review && !research ? { headers: { "Content-Type": "application/json",
            [PASSAGE_HEADER]: encodePassages(continuation.sourcePassages) } } : {}), ...(research ? { headers: { "Content-Type": "application/json", "Accept-Language": research.locale } } : {}), signal: controller.signal };
      });
      let response = await dispatch();
      // One automatic re-preparation when the context drifted before anything
      // streamed (the web's decideBundleStaleRecovery rule for a single send).
      if (ownsContext && response.status === 409) {
        const refusal = await response.clone().json().catch(() => null) as { code?: string; details?: { refusalReason?: string } } | null;
        if (refusal?.code === "CHAT_CONTEXT_BUNDLE_STALE" && refusal.details?.refusalReason !== "already_consumed") {
          const refreshed = await prepareContext(contextBundle);
          if (refreshed) {
            contextBundle = refreshed;
            response = await dispatch();
          }
        }
      }
      watchdog.noteHeaders();
      const traceId = response.headers.get("X-Request-ID");
      publishReceipt(receiptForAttempt(response.headers.get(CONTINUATION_RECEIPT_HEADER), traceId, assistantMessageId));
      // Auto's choice arrives only as a header, as on the web; it is kept for
      // this session and attached to the message when the conversation reloads.
      const routed = response.headers.get("X-Chat-Routed-Model");
      if (routed) routedModelByMessage.set(assistantMessageId, routed);
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new ApiClientError(response.status, typeof body?.code === "string" ? body.code : "CHAT_REQUEST_FAILED"); }
      if (response.headers.get("X-Chat-Response-Mode") === "image-turn") {
        watchdog.stop();
        const body = await response.json().catch(() => null);
        const decision = readChatImageTurnRequest(body?.imageTurn);
        if (!decision || review) throw Error("CHAT_IMAGE_TURN_INVALID");
        // An older server's image-turn route accepts web cookies only. Never
        // call it with a native bearer until the server advertises enrollment.
        if (!(await requireParity()).chatImageTurns) throw new ApiClientError(503, "NATIVE_IMAGE_TURNS_UNAVAILABLE");
        controller.signal.throwIfAborted();
        await postImageTurn(persisted.id, sourceId, assistantMessageId, modelId, decision, controller.signal);
        return;
      }
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        const receipt = await response.json();
        if (receipt.deepResearchJobId !== assistantMessageId) throw Error("RESEARCH_RECEIPT_INVALID");
        watchdog.stop();
        while (!signal.aborted) {
          const outcome = await researchStatus(assistantMessageId, signal);
          if (outcome.status === "completed") { if (outcome.content) progress(outcome.content); return; }
          if (outcome.status === "failed") throw Error("DEEP_RESEARCH_FAILED");
          await new Promise<void>((resolve, reject) => {
            const abortWait = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abortWait); resolve(); }, 8000);
            signal.addEventListener("abort", abortWait, { once: true }); if (signal.aborted) abortWait();
          });
        }
        throw new DOMException("Stopped", "AbortError");
      }
      if (!response.body) throw Error("CHAT_STREAM_MISSING");
      const reader = response.body.getReader();
      try {
        const result = await consumeChatStream({ reader, liveness: watchdog, onProgress: ({ displayText, retryingWithModelId }) => {
          if (revision !== sessionRevision || signal.aborted) return;
          const retryStarted = Boolean(retryingWithModelId && sourceReceipt?.attempt === 0);
          if (displayText.length > sourceAttemptTextLength && displayText.trim() && sourceReceipt?.status === "unknown" && !retryStarted)
            publishReceipt({ ...sourceReceipt, status: "dispatched" });
          if (retryStarted && sourceReceipt) {
            sourceAttemptTextLength = displayText.length;
            publishReceipt({ ...sourceReceipt, attempt: 1, status: "unknown" });
          }
          progress(displayText);
        } });
        const trailer = parseChatStreamTrailer(result.searchMetadataJson);
        publishReceipt(receiptForAttempt(trailer?.continuationReceipt, traceId, assistantMessageId, sourceReceipt));
      }
      finally { reader.releaseLock(); }
      const final = await load(persisted.id);
      if (!final.messages.some(message => message.id === assistantMessageId && ["normal", "incomplete"].includes(message.status ?? ""))) throw Error("CHAT_OUTCOME_PENDING");
    } finally { watchdog?.stop(); signal.removeEventListener("abort", abort); }
  }
  return {
    get workspace() {
      const revision = sessionRevision;
      const assertScope = () => { if (revision !== sessionRevision) throw Error("SIGN_IN_REQUIRED"); };
      return createWorkspaceTransport(async <T,>(path: string, init?: RequestInit) => {
        assertScope(); const value = await request<T>(path, init); assertScope(); return value;
      }, async () => { assertScope(); const value = await requireParity(); assertScope(); return value; }, async (url, headers, file) => { assertScope(); await uploadFile(url, headers, file); assertScope(); });
    },
    location,
    // Project workspace: bound to this sign-in. A request issued under an
    // earlier session (logout, another account) is refused before it leaves
    // and its answer is discarded after it returns.
    get projects() {
      const revision = sessionRevision;
      const assertScope = () => { if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError"); };
      return createProjectWorkspaceClient(async (path, init) => {
        assertScope(); const response = await run(path, init, true); assertScope(); return response;
      }, async (url, headers, file) => { assertScope(); await uploadFile(url, headers, file as File); assertScope(); });
    },
    researchPreviewOffer: async (input, signal, locale) => {
      if (!(await requireParity()).researchPreview?.enabled) return { offered: false, reason: "disabled" };
      return request("/api/chat/research-preview/offer", { ...json("POST", input), ...(locale ? { headers: { "Content-Type": "application/json", "Accept-Language": locale } } : {}), signal });
    },
    researchEngine: createResearchApi((path, init) => run(path, init)),
    researchEngineEnabled: async () => Boolean((await requireParity()).researchEngine?.enabled),
    researchRuns: {
      read: async (id, signal) => { if (!(await requireParity()).researchPreview?.enabled) throw Error("NATIVE_RESEARCH_UNAVAILABLE"); return (await request<{ run: ResearchPreviewRunDto }>(`/api/chat/research-preview/runs/${encodeURIComponent(id)}`, { cache: "no-store", signal })).run; },
      resume: async id => { if (!(await requireParity()).researchPreview?.enabled) throw Error("NATIVE_RESEARCH_UNAVAILABLE"); return (await request<{ run: ResearchPreviewRunDto }>(`/api/chat/research-preview/runs/${encodeURIComponent(id)}/resume`, { method: "POST" })).run; },
      cancel: async id => { if (!(await requireParity()).researchPreview?.enabled) throw Error("NATIVE_RESEARCH_UNAVAILABLE"); return (await request<{ run: ResearchPreviewRunDto }>(`/api/chat/research-preview/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" })).run; },
    },
    sendResearchPreview: async (conversation, text, files, signal, progress, options) => {
      const refusal = () => Object.assign(Error("RESEARCH_PREVIEW_UNAVAILABLE"), { questionPersisted: false });
      if (files.length || !text.trim() || text.trim().length > 4000 || conversation.selectionMode !== "manual" || conversation.selectedModels.length !== 1) throw refusal();
      if (!(await requireParity()).researchPreview?.enabled) throw refusal();
      const offered = await request<{ offered: boolean; features?: { durableRuns: boolean } }>("/api/chat/research-preview/offer", { ...json("POST", { conversationId: conversation.id, modelId: conversation.selectedModels[0], question: text.trim() }), headers: { "Content-Type": "application/json", "Accept-Language": options.locale }, signal });
      if (!offered.offered) throw refusal();
      const { persisted, sourceId } = await persistQuestion(conversation, text.trim(), [], signal);
      if (persisted.selectionMode !== "manual" || persisted.selectedModels.length !== 1 || persisted.selectedModels[0] !== conversation.selectedModels[0]) throw Error("RESEARCH_PREVIEW_SELECTION_CHANGED");
      if (options.durable && offered.features?.durableRuns) {
        await request("/api/chat/research-preview/runs", { ...json("POST", { conversationId: persisted.id, sourceUserMessageId: sourceId, assistantMessageId: crypto.randomUUID(), modelId: persisted.selectedModels[0], locale: options.locale }), signal });
        return;
      }
      await streamModel(persisted, sourceId, persisted.selectedModels[0], signal, progress, false, undefined, undefined, { locale: options.locale });
    },
    history: {
      projects: async () => { await historySupport(); return (await request<{ projects: import("./chatTransport").HistoryProject[] }>("/api/projects")).projects; },
      saveProject: (id, name) => historyWrite(id ? `/api/projects/${encodeURIComponent(id)}` : "/api/projects", id ? "PATCH" : "POST", { name }),
      deleteProject: id => historyWrite(`/api/projects/${encodeURIComponent(id)}`, "DELETE"),
      search: async (query, signal) => {
        await historySupport(); return request(`/api/conversations/search?q=${encodeURIComponent(query)}`, { signal, headers: { "X-Tomverse-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone }, cache: "no-store" });
      },
      rename: (id, title) => historyWrite(pathFor(id), "PATCH", { title }),
      pin: async (chat, pinned) => {
        const revision = sessionRevision; await historySupport();
        const profile = await request<{ id: string }>("/api/user/account");
        if (revision !== sessionRevision) throw Error("SIGN_IN_REQUIRED");
        const seq = Math.max(Date.now(), (chat.pinSeq ?? 0) + 1, (pinSequences.get(chat.id) ?? 0) + 1);
        pinSequences.set(chat.id, seq);
        await request(`${pathFor(chat.id)}/pin`, json("PUT", { pinned, seq, ownerId: profile.id }));
      },
      move: (id, projectId) => historyWrite(pathFor(id), "PATCH", { projectId }),
      share: async id => {
        await historySupport(); const result = await request<{ url: string }>(`${pathFor(id)}/share`, json("POST", {}));
        const url = new URL(result.url);
        if (url.protocol !== "https:" || !["tomverse.app", "dev.tomverse.app", "staging.tomverse.app"].includes(url.hostname) || !url.pathname.startsWith("/share/") || url.username || url.password || url.port) throw Error("INVALID_SHARE_URL");
        return { url: url.toString() };
      },
      revokeShare: id => historyWrite(`${pathFor(id)}/share`, "DELETE"),
      export: async (id, title, includeSource) => {
        await historySupport(); const response = await run(`${pathFor(id)}/export${includeSource ? "?include=source" : ""}`, { headers: { "X-Tomverse-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone } });
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new ApiClientError(response.status, body.code ?? "MOBILE_REQUEST_FAILED"); }
        await saveFile(response, `${title}.txt`);
      },
      remove: async id => { await historyWrite(pathFor(id), "DELETE"); unlockGrants.delete(id); },
      password: async (id, password, currentPassword) => { await historyWrite(pathFor(id), "PATCH", { password, ...(currentPassword ? { currentPassword } : {}) }); unlockGrants.delete(id); },
      unlock: async (id, password) => {
        const revision = sessionRevision; await historySupport();
        const reply = await request<{ unlockToken: string }>(`${pathFor(id)}/verify`, json("POST", { password }));
        if (revision !== sessionRevision) throw Error("SIGN_IN_REQUIRED");
        if (typeof reply.unlockToken !== "string" || reply.unlockToken.length > 200 || !/^\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(reply.unlockToken)) throw Error("INVALID_UNLOCK_GRANT");
        if (unlockGrants.size >= 32 && !unlockGrants.has(id)) unlockGrants.delete(unlockGrants.keys().next().value!);
        unlockGrants.set(id, reply.unlockToken);
      },
      unlocked: id => Number(unlockGrants.get(id)?.split(".")[0] ?? 0) > Date.now() / 1000,
    },
    voiceConfiguration: async () => {
      const config = (await request<{ voiceConversation?: { enabled: boolean; maxSeconds: number | null; continuous?: boolean } }>("/api/products/chat/capabilities")).voiceConversation;
      return config ? { enabled: config.enabled, maxSeconds: config.continuous ? null : config.maxSeconds } : { enabled: false, maxSeconds: 300 };
    },
    voiceRequest: (body, signal) => run("/api/chat/voice", { ...json("POST", body), signal }),
    sendVoice: async (conversation, text, signal, onProgress) => {
      const { persisted, sourceId } = await persistQuestion(conversation, text, [], signal);
      await streamModel(persisted, sourceId, persisted.selectedModels[0], signal, onProgress);
      return { conversationId: persisted.id, sourceUserMessageId: sourceId };
    },
    resumeResearch: async (conversation, signal, update) => {
      let pending = conversation.messages.filter(message => message.pendingJobId && message.status === "pending").map(message => message.id);
      while (pending.length && !signal.aborted) {
        try {
        for (const id of pending) await researchStatus(id, signal);
        const item = await readConversation(conversation.id);
        if (signal.aborted) return;
        const next = { ...item, activeAttempt: item.messages.some(message => message.pendingJobId && message.status === "pending") };
        update(next);
        pending = next.messages.filter(message => message.pendingJobId && message.status === "pending").map(message => message.id);
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (signal.aborted || (status && status < 500 && status !== 408 && status !== 429)) throw error;
          // Retry reads after a temporary connection/server failure, never the paid submission.
        }
        if (pending.length) await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 8000);
          signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
        });
      }
    },
    mobileCapabilities: requireParity,
    usage: async () => {
      if (!(await requireParity(true)).accountUsage) throw Object.assign(Error("NATIVE_USAGE_UNAVAILABLE"), { code: "NATIVE_USAGE_UNAVAILABLE" });
      return request("/api/user/usage");
    },
    generateTitle: async conversation => {
      if (requestedTitles.has(conversation.id) || conversation.messages.filter(message => message.role === "user").length !== 1 || !conversation.messages.some(message => message.role === "assistant" && message.status === "normal")) return null;
      requestedTitles.add(conversation.id);
      if (!(await requireParity()).conversationTitles) return null;
      const result = await request<{ updated: boolean; title?: string }>(`${pathFor(conversation.id)}/generate-title`, json("POST", { expectedTitle: conversation.title }));
      return result.updated && typeof result.title === "string" ? result.title : null;
    },
    preferences: async () => { await requireParity(); return request("/api/user/settings"); },
    reportAnswer: async ({ messageId, modelId, message, language }) => { await requireParity(); const result = await request<{ reference?: unknown }>("/api/feedback", json("POST", { type: "bug", message, messageId, answerSignal: "needs_improvement", language, ...(modelId ? { modelId } : {}) })); return typeof result?.reference === "string" ? { reference: result.reference } : {}; },
    savePreferences: async (input) => { await requireParity(); await request("/api/user/settings", json("POST", input)); },
    memoryPreferences: async () => { await requireParity(); return request("/api/memories/settings"); },
    saveMemoryPreferences: async (input) => { await requireParity(); await request("/api/memories/settings", json("PUT", input)); },
    assistants: async () => { await requireParity(); return (await request<{ profiles: import("./chatTransport").AssistantSummary[] }>("/api/assistant-profiles")).profiles; },
    configureTools: async (id, input) => { await request(pathFor(id), json("PATCH", input)); return load(id); },
    deviceSecurity: () => bridge.getDeviceSecurity?.() ?? Promise.resolve({ available: false, enabled: false, locked: false }),
    setDeviceLock: async (enabled, reason) => { await bridge.setDeviceLock({ enabled, reason }); window.dispatchEvent(new Event("tomverse-device-security-changed")); },
    unlockDevice: async (reason) => { await bridge.unlockDevice({ reason }); },
    // A Review continuation is listed with Review (owner request 2026-10-26).
    listReview: async () => (await request<Array<import("./chatTransport").ChatSummary & { surface: string; kind: string }>>("/api/conversations", { headers: displayTimeZoneHeaders() })).filter(row => (row.surface === "workspace" && ["chat", "image"].includes(row.kind)) || (row.surface === "continuation" && row.productKey === "review")),
    createReview: async (models, assistantProfileId) => { await requireParity(); const value = await request<{ id: string }>("/api/products/review/conversations", json("POST", { selectedModels: models, webSearchMode: "always", ...(assistantProfileId ? { assistantProfileId } : {}) })); return load(value.id); },
    prepareReviewHandoff: async (id, input, signal) => {
      const revision = sessionRevision;
      const result = await request<import("./chatTransport").ReviewHandoffResult>(`${pathFor(id)}/continuation/review-handoff`, { ...json("POST", input), signal });
      if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(result.conversationId) || !result.reviewHandoff) throw Error("REVIEW_HANDOFF_INVALID");
      return result;
    },
    reviewHandoffDraft: {
      get: id => request(`${pathFor(id)}/continuation/review-handoff/draft`),
      put: async (id, input) => {
        const result = await request<{ draft: import("./chatTransport").ReviewHandoffDraft }>(`${pathFor(id)}/continuation/review-handoff/draft`, json("PUT", input));
        return { scopeKey: id, draft: result.draft };
      },
      remove: async (id, expectedRevision) => {
        const response = await client.response(`${pathFor(id)}/continuation/review-handoff/draft`, json("DELETE", { expectedRevision }));
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new ApiClientError(response.status, body.code ?? "REVIEW_HANDOFF_DRAFT_DELETE_FAILED"); }
        return { scopeKey: id, draft: null };
      },
    },
    configureReview: async (id, models) => { await request(pathFor(id), json("PATCH", { selectedModels: models, selectionMode: "manual" })); return load(id); },
    routeReview: async (input) => { await requireParity(); const result = await askReviewRoute(input, (path, init) => { if (typeof path !== "string" || path !== "/api/review/route") throw Error("INVALID_REVIEW_ROUTE"); return run(path, init); }); if (!result || result.kind === "blocked") throw Error("REVIEW_ROUTE_UNAVAILABLE"); return result; },
    quickSummaryPreview: async id => { if (!(await requireParity()).reviewAnalysis?.quickSummary) throw Error("NATIVE_QUICK_SUMMARY_UNAVAILABLE"); return request(`${pathFor(id)}/compare-summary?handoff=1`, { cache: "no-store" }); },
    runQuickSummary: async id => { if (!(await requireParity()).reviewAnalysis?.quickSummary) throw Error("NATIVE_QUICK_SUMMARY_UNAVAILABLE"); return request(`${pathFor(id)}/compare-summary`, json("POST", {})); },
    reviewPreview: async (id, mode = "balanced", synthesis = false) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews?reviewMode=${encodeURIComponent(mode)}&includeSynthesis=${synthesis}`); },
    runComparison: async (id, input) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews`, json("POST", input)); },
    reviewFeedback: async (id, reviewId) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews/item-feedback?reviewId=${encodeURIComponent(reviewId)}`); },
    setReviewFeedback: async (id, reviewId, reviewItemId, verdict) => { await requireParity(); await request(`${pathFor(id)}/comparison-reviews/item-feedback`, json(verdict ? "PUT" : "DELETE", { reviewId, reviewItemId, ...(verdict ? { verdict } : {}) })); },
    verifyReviewItem: async (id, item) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews/verify-item`, json("POST", { item })); },
    generateImages: async input => { await requireParity(); return request("/api/images/generations", json("POST", input)); },
    imageHistory: async id => { await requireParity(); return request(`${pathFor(id)}/generations`); },
    imageRequest: async key => { await requireParity(); return request(`/api/images/generations?requestKey=${encodeURIComponent(key)}`); },
    imageGroup: async (id) => { await requireParity(); return request(`/api/images/groups/${encodeURIComponent(id)}`); },
    account: async () => {
      const revision = sessionRevision;
      const profile = await request<{ id: string; name?: string | null; email?: string | null; actionsEnabled: boolean }>("/api/user/account");
      if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
      if (locationIdentity && locationIdentity !== profile.id) clearSessionState();
      locationIdentity = profile.id; location.setIdentity(profile.id);
      return profile;
    },
    exportAccount: async () => {
      const ticket = await request<{ downloadPath: string }>("/api/user/account/export", json("POST", {}));
      if (!/^\/api\/user\/account\/export\/[A-Za-z0-9_-]{32,128}$/.test(ticket.downloadPath)) throw Error("EXPORT_PATH_INVALID");
      const response = await run(ticket.downloadPath, { cache: "no-store", redirect: "error" });
      if (!response.ok) throw new ApiClientError(response.status, "EXPORT_DOWNLOAD_FAILED");
      await saveFile(response, "tomverse-account-data.json");
    },
    deleteAccount: async (confirmationText) => {
      if (confirmationText !== "DELETE MY ACCOUNT") throw Error("CONFIRMATION_REQUIRED");
      await request("/api/user/account", json("DELETE", { confirm: true, confirmationText }));
      clearSessionState();
    },
    downloadArtifact: async (artifact) => {
      if (artifact.status !== "ready") throw Error("ARTIFACT_UNAVAILABLE");
      const response = await run(artifactDownloadPath(artifact.id), { cache: "no-store", redirect: "error" });
      if (!response.ok) throw new ApiClientError(response.status, "ARTIFACT_UNAVAILABLE");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > ARTIFACT_LIMITS.maxOutputBytes || bytes.byteLength !== artifact.byteSize) throw Error("ARTIFACT_SIZE_MISMATCH");
      await saveFile(new Response(bytes, { headers: response.headers }), artifact.filename);
    },
    prepareArtifactRevision: async (input) => {
      if (!(await requireParity()).generatedFileRevisions) throw new ApiClientError(503, "GENERATED_ARTIFACT_REVISION_DISABLED");
      const revision = sessionRevision;
      const result = await request<PreparedArtifactRevision>("/api/chat", json("PUT", { action: "generated-artifact-copy", ...input }));
      if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
      if (!result || typeof result.uploadId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(result.uploadId) ||
          typeof result.name !== "string" || !result.name || result.name.length > 255 ||
          typeof result.mediaType !== "string" || result.mediaType.length > 200 ||
          !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 50 * 1024 * 1024) throw Error("ARTIFACT_REVISION_RECEIPT_INVALID");
      return { uploadId: result.uploadId, name: result.name, mediaType: result.mediaType, size: result.size,
        ...(["workbook", "workbook-values"].includes(result.revisionMode ?? "") ? { revisionMode: result.revisionMode } : {}) };
    },
    discardAttachment: async (uploadId) => {
      if (!(await requireParity()).generatedFileRevisions) return;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(uploadId)) throw Error("ATTACHMENT_RECEIPT_INVALID");
      const response = await run("/api/chat", json("DELETE", { uploadId }));
      if (!response.ok) throw new ApiClientError(response.status, "ATTACHMENT_CLEANUP_FAILED");
      await response.body?.cancel().catch(() => {});
    },
    artifactVersions: async (artifactId, cursor) => {
      if (!(await requireParity()).generatedFileRevisions) throw new ApiClientError(503, "GENERATED_ARTIFACT_REVISION_DISABLED");
      const revision = sessionRevision;
      const result = parseGeneratedArtifactVersions(await request(artifactVersionsPath(artifactId, cursor), { cache: "no-store" }));
      if (revision !== sessionRevision) throw new DOMException("Session changed", "AbortError");
      if (!result) throw Error("ARTIFACT_VERSIONS_INVALID");
      return result;
    },
    onSessionLost: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    session: async () => { const active = (await bridge.hasSession()).signedIn; if (!active) clearSessionState(); return active; },
    signIn: async () => { clearSessionState(); await bridge.signIn(); },
    requestEmailCode: (email, language) => bridge.requestEmailCode({ email, language }),
    verifyEmailCode: (email, code, signup) => { clearSessionState(); return bridge.verifyEmailCode({ email, code, ...signup }); },
    signOut: () => { clearSessionState(); return bridge.signOut(); },
    list: async () => {
      const rows = await request<Array<{ id: string; title: string; surface: string; kind: string; isLocked: boolean; productKey?: string | null }>>("/api/conversations", { headers: displayTimeZoneHeaders() });
      // A Chat continuation is a Chat conversation with its imported original
      // above it, so it is listed with Chat (owner request 2026-10-26).
      return rows.filter((row) => row.kind === "chat" && (row.surface === "chat" || (row.surface === "continuation" && row.productKey === "chat")));
    },
    load,
    continuationSource,
    models: async () => (await request<{ models: PublicCatalogModel[] }>("/api/models/catalog")).models.filter(isPubliclySelectableModel),
    capabilities: async () => ({ offered: (await request<{ autoSelection: { offered: boolean } }>("/api/products/chat/capabilities")).autoSelection.offered }),
    configure,
    create: async (title, assistantProfileId, projectId) => {
      // The project is fixed by the create call itself, before the first send,
      // so the first answer already runs in the project's context.
      const item = await request<{ id: string }>("/api/products/chat/conversations", json("POST", { webSearchMode: "always", ...(assistantProfileId ? { assistantProfileId } : {}), ...(projectId ? { projectId } : {}), ...(title ? { title: title.slice(0, 30) } : {}) }));
      const detail = await load(item.id);
      return !assistantProfileId && detail.autoSelection?.offered ? configure(item.id, "", true) : detail;
    },
    send: async (conversation, text, files, signal, onProgress, continuation) => {
      const { persisted, sourceId } = await persistQuestion(conversation, text, files, signal);
      const edit = await manualPhotoEdit(persisted, text, files, signal);
      if (edit) {
        await postImageTurn(persisted.id, sourceId, crypto.randomUUID(), persisted.selectedModels[0], edit, signal);
        return;
      }
      await streamModel(persisted, sourceId, persisted.selectedModels[0], signal, onProgress, false, undefined, continuation);
    },
    sendReview: async (conversation, text, files, signal, progress, draft) => {
      // Match the ordinary message persistence route before pricing its query.
      const prompt = draft ? text : text.trim();
      const handoffTarget = conversation.productKey === "review" && Boolean(conversation.reviewHandoff ?? conversation.imported?.reviewHandoff);
      const handoffSessionRevision = handoffTarget ? sessionRevision : null;
      let admission: { admissionToken: string; contextBundle?: string } | undefined;
      try {
        if (handoffTarget && conversation.selectedModels.length === 1) {
          // The existing source loader validates both resources and every linked
          // reference before a single-model send can consume its editable draft.
          const context = await request<{ reviewHandoff?: { status?: string } }>(`${pathFor(conversation.id)}/continuation?limit=1&offset=end`, { signal });
          if (context.reviewHandoff?.status !== "available") throw new ApiClientError(409, "REVIEW_HANDOFF_UNAVAILABLE");
        }
        if (conversation.selectedModels.length > 1) {
        await requireParity();
        const input = { comparisonId: Date.now().toString(), conversationId: conversation.id, modelIds: conversation.selectedModels, prompt, attachments: files.map(file => ({ mediaType: file.mediaType, size: file.size })), webSearchMode: conversation.webSearchMode ?? "off" };
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await client.response("/api/chat/preflight", { ...json("POST", input), signal });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
              const seconds = Number(response.headers.get("Retry-After") ?? result?.details?.retryAfterSeconds);
              const traceId = response.headers.get("X-Request-ID") ?? (typeof result?.traceId === "string" ? result.traceId : typeof result?.requestId === "string" ? result.requestId : null);
              throw Object.assign(new ApiClientError(response.status, typeof result?.code === "string" ? result.code : "COMPARISON_PREFLIGHT_FAILED"), {
                retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 && seconds <= 86400 ? Math.ceil(seconds) : undefined,
                traceId: traceId && /^[A-Za-z0-9_-]{1,100}$/.test(traceId) ? traceId : undefined,
              });
            }
            if (result?.ok !== true || typeof result.admissionToken !== "string" || !result.admissionToken) throw Error("COMPARISON_ADMISSION_MISSING");
            if (result.contextBundle != null && typeof result.contextBundle !== "string") throw Error("COMPARISON_CONTEXT_INVALID");
            admission = { admissionToken: result.admissionToken, ...(result.contextBundle ? { contextBundle: result.contextBundle } : {}) }; break;
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (signal.aborted || !([500, 503].includes(status ?? 0) || error instanceof TypeError)) throw error;
            // One infrastructure retry, then retain each model's ordinary server admission.
          }
        }
      } } catch (error) { throw Object.assign(error instanceof Error ? error : new Error("COMPARISON_PREFLIGHT_FAILED"), { questionPersisted: false }); }
      if (handoffTarget && handoffSessionRevision !== sessionRevision) {
        throw Object.assign(new DOMException("Session changed", "AbortError"), { questionPersisted: false });
      }
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const { persisted, sourceId } = await persistQuestion(conversation, prompt, files, signal, draft);
      const outcomes = await Promise.allSettled(persisted.selectedModels.map(modelId =>
        streamModel(persisted, sourceId, modelId, signal, value => progress(modelId, value), true, admission)));
      return { failedModelIds: persisted.selectedModels.filter((_, index) => outcomes[index].status === "rejected") };
    },
    upload: async (file) => {
      const format = resolveChatAttachmentFormat({ filename: file.name, declaredMediaType: file.type });
      if (!format) throw new ApiClientError(400, "ATTACHMENT_UNSUPPORTED_FORMAT");
      const metadata = { name: file.name, size: file.size, mediaType: format.mediaType };
      const prepared = await request<{ key: string; uploadUrl: string; uploadHeaders: Record<string, string> }>("/api/chat", json("PUT", metadata));
      // Signed storage URLs receive bytes only; never the mobile bearer.
      await uploadFile(prepared.uploadUrl, prepared.uploadHeaders, file);
      const receipt = await request<MobileAttachment>("/api/chat", json("PATCH", { ...metadata, key: prepared.key }));
      return { uploadId: receipt.uploadId, name: receipt.name, size: receipt.size, mediaType: receipt.mediaType };
    },
    transcribe: async (clip, signal) => {
      const result = await request<{ transcript: string }>("/api/chat/voice-transcription", { method: "POST", headers: { "Content-Type": clip.type }, body: clip, signal });
      return result.transcript;
    },
  };
}
