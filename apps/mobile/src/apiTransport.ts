import { createApiClient, ApiClientError } from "@tomverse/api-client";
import { consumeChatStream } from "../../../lib/chatStreamConsumer";
import { fitChatRequestTranscript } from "../../../lib/chatRequestLimits";
import { toChatRequestMessage } from "../../../lib/chatMessageSerialization";
import { resolveChatAttachmentFormat } from "../../../lib/chatAttachmentFormats";
import { createChatLivenessWatchdog } from "../../../lib/chatStreamLiveness";
import { isPubliclySelectableModel } from "../../../lib/models";
import type { PublicCatalogModel } from "../../../lib/publicModelCatalog";
import { mobileApiFetch, MobileAuth } from "./authBridge";
import { artifactDownloadPath, ARTIFACT_LIMITS } from "../../../lib/generatedArtifactCore";
import { saveMobileResponse } from "./fileSave";
import { askReviewRoute } from "../../../lib/reviewRoutingClient";
import { uploadMobileFile } from "./nativeUpload";
import type { ChatTransport, Conversation, MobileAttachment, MobileCapabilities } from "./chatTransport";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Attempt = { assistantMessageId: string; partialContent: string; status: string; actualModelId?: string; requestedModelId: string };
export function createApiTransport(source: ApiFetch = mobileApiFetch, bridge = MobileAuth, saveFile = saveMobileResponse, uploadFile = uploadMobileFile): ChatTransport {
  const listeners = new Set<() => void>();
  let capabilityCache: { value: MobileCapabilities; expires: number } | null = null;
  let capabilityRequest: Promise<MobileCapabilities> | null = null;
  const routedModelByMessage = new Map<string, string>();
  const notifySessionLost = () => { capabilityCache = null; for (const listener of listeners) listener(); };
  const run: ApiFetch = async (path, init) => {
    try { const response = await source(path, init); if (response.status === 401) notifySessionLost(); return response; }
    catch (error) { if ((error as { code?: string }).code === "SIGN_IN_REQUIRED") notifySessionLost(); throw error; }
  };
  const client = createApiClient(run);
  const request = client.json;
  async function requireParity(refresh = false) {
    if (refresh) capabilityCache = null;
    if (capabilityCache && capabilityCache.expires > Date.now()) return capabilityCache.value;
    capabilityRequest ??= request<MobileCapabilities>("/api/products/mobile/capabilities");
    try { const value = await capabilityRequest;
      if (typeof value.reviewEasy !== "boolean" || typeof value.assistants !== "boolean" || !["Guest", "Free", "Pro", "Max"].includes(value.plan) || !Number.isInteger(value.maxModels) || value.maxModels < 1 || value.maxModels > 8) throw Error("NATIVE_CAPABILITIES_INVALID");
      capabilityCache = { value, expires: Date.now() + 30_000 }; return value; }
    finally { capabilityRequest = null; }
  }
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const pathFor = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
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
    for (const attempt of item.responseAttempts ?? []) {
      if (messages.some((message) => message.id === attempt.assistantMessageId)) continue;
      messages.push({ id: attempt.assistantMessageId, role: "assistant", content: attempt.partialContent,
        modelId: attempt.actualModelId ?? attempt.requestedModelId, status: attempt.status });
    }
    const withRouting = messages.map((message) => routedModelByMessage.has(message.id) ? { ...message, routedModelId: routedModelByMessage.get(message.id) } : message);
    return { ...item, messages: withRouting, assistantProfileId: item.assistantProfile?.profileId ?? item.assistantProfileId ?? null, activeAttempt: messages.some(message => Boolean(message.pendingJobId) && message.status === "pending") || Boolean(item.responseAttempts?.some((attempt) => ["claimed", "streaming"].includes(attempt.status))) };
  }
  async function configure(id: string, modelId: string, auto: boolean) {
    await request(pathFor(id), json("PATCH", { selectionMode: auto ? "auto" : "manual", ...(!auto ? { selectedModels: [modelId] } : {}) }));
    return load(id);
  }
  async function persistQuestion(conversation: Conversation, text: string, files: MobileAttachment[], signal: AbortSignal) {
    const requestId = crypto.randomUUID();
    const saved = await request<{ messageMappings: Array<{ requestId: string; messageId: string }> }>(`${pathFor(conversation.id)}/messages`, {
      ...json("POST", { messages: [{ clientRequestId: requestId, role: "user", content: text,
        ...(files.length ? { attachmentUploadIds: files.map(file => file.uploadId) } : {}) }] }), signal,
    });
    const sourceId = saved.messageMappings.find(mapping => mapping.requestId === requestId)?.messageId;
    if (!sourceId) throw Error("MESSAGE_RECEIPT_MISSING");
    const persisted = await load(conversation.id);
    if (!persisted.messages.some(message => message.id === sourceId)) throw Error("SAVED_MESSAGE_MISSING");
    return { persisted, sourceId };
  }
  async function streamModel(persisted: Conversation, sourceId: string, modelId: string, signal: AbortSignal, progress: (text: string) => void, review = false, admission?: { admissionToken: string; contextBundle?: string }) {
    const messages = fitChatRequestTranscript(persisted.messages.filter(message =>
      (message.role === "user" || !review || message.modelId === modelId) &&
      (message.role === "user" || message.status === "normal" || message.status === "incomplete" || !message.status))
      .map(message => toChatRequestMessage({ id: message.id, role: message.role, content: message.content, attachments: message.attachments })));
    const assistantMessageId = crypto.randomUUID();
    const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const watchdog = createChatLivenessWatchdog({ onExpire: abort });
    try {
      const response = await run("/api/chat", { ...json("POST", { messages, modelId, webSearchMode: persisted.webSearchMode ?? "off", conversationId: persisted.id,
        assistantMessageId, sourceUserMessageId: sourceId, ...(admission ?? {}) }), signal: controller.signal });
      watchdog.noteHeaders();
      // Auto's choice arrives only as a header, as on the web; it is kept for
      // this session and attached to the message when the conversation reloads.
      const routed = response.headers.get("X-Chat-Routed-Model");
      if (routed) routedModelByMessage.set(assistantMessageId, routed);
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new ApiClientError(response.status, typeof body?.code === "string" ? body.code : "CHAT_REQUEST_FAILED"); }
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
      try { await consumeChatStream({ reader, liveness: watchdog, onProgress: ({ displayText }) => progress(displayText) }); }
      finally { reader.releaseLock(); }
      const final = await load(persisted.id);
      if (!final.messages.some(message => message.id === assistantMessageId && ["normal", "incomplete"].includes(message.status ?? ""))) throw Error("CHAT_OUTCOME_PENDING");
    } finally { watchdog.stop(); signal.removeEventListener("abort", abort); }
  }
  return {
    voiceConfiguration: async () => (await request<{ voiceConversation?: { enabled: boolean; maxSeconds: number } }>("/api/products/chat/capabilities")).voiceConversation ?? { enabled: false, maxSeconds: 300 },
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
    preferences: async () => { await requireParity(); return request("/api/user/settings"); },
    reportAnswer: async ({ messageId, modelId, message, language }) => { await requireParity(); await request("/api/feedback", json("POST", { type: "bug", message, messageId, answerSignal: "needs_improvement", language, ...(modelId ? { modelId } : {}) })); },
    savePreferences: async (input) => { await requireParity(); await request("/api/user/settings", json("POST", input)); },
    memoryPreferences: async () => { await requireParity(); return request("/api/memories/settings"); },
    saveMemoryPreferences: async (input) => { await requireParity(); await request("/api/memories/settings", json("PUT", input)); },
    assistants: async () => { await requireParity(); return (await request<{ profiles: import("./chatTransport").AssistantSummary[] }>("/api/assistant-profiles")).profiles; },
    configureTools: async (id, input) => { await request(pathFor(id), json("PATCH", input)); return load(id); },
    deviceSecurity: () => bridge.getDeviceSecurity?.() ?? Promise.resolve({ available: false, enabled: false, locked: false }),
    setDeviceLock: async (enabled, reason) => { await bridge.setDeviceLock({ enabled, reason }); window.dispatchEvent(new Event("tomverse-device-security-changed")); },
    unlockDevice: async (reason) => { await bridge.unlockDevice({ reason }); },
    listReview: async () => (await request<Array<import("./chatTransport").ChatSummary & { surface: string; kind: string; isLocked: boolean }>>("/api/conversations")).filter(row => row.surface === "workspace" && ["chat", "image"].includes(row.kind) && !row.isLocked),
    createReview: async (models) => { await requireParity(); const value = await request<{ id: string }>("/api/products/review/conversations", json("POST", { selectedModels: models })); return load(value.id); },
    configureReview: async (id, models) => { await request(pathFor(id), json("PATCH", { selectedModels: models, selectionMode: "manual" })); return load(id); },
    routeReview: async (input) => { await requireParity(); const result = await askReviewRoute(input, (path, init) => { if (typeof path !== "string" || path !== "/api/review/route") throw Error("INVALID_REVIEW_ROUTE"); return run(path, init); }); if (!result || result.kind === "blocked") throw Error("REVIEW_ROUTE_UNAVAILABLE"); return result; },
    reviewPreview: async (id, mode = "balanced", synthesis = false) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews?reviewMode=${encodeURIComponent(mode)}&includeSynthesis=${synthesis}`); },
    runComparison: async (id, input) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews`, json("POST", input)); },
    reviewFeedback: async (id, reviewId) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews/item-feedback?reviewId=${encodeURIComponent(reviewId)}`); },
    setReviewFeedback: async (id, reviewId, reviewItemId, verdict) => { await requireParity(); await request(`${pathFor(id)}/comparison-reviews/item-feedback`, json(verdict ? "PUT" : "DELETE", { reviewId, reviewItemId, ...(verdict ? { verdict } : {}) })); },
    verifyReviewItem: async (id, item) => { await requireParity(); return request(`${pathFor(id)}/comparison-reviews/verify-item`, json("POST", { item })); },
    generateImages: async input => { await requireParity(); return request("/api/images/generations", json("POST", input)); },
    imageHistory: async id => { await requireParity(); return request(`${pathFor(id)}/generations`); },
    imageRequest: async key => { await requireParity(); return request(`/api/images/generations?requestKey=${encodeURIComponent(key)}`); },
    imageGroup: async (id) => { await requireParity(); return request(`/api/images/groups/${encodeURIComponent(id)}`); },
    account: () => request("/api/user/account"),
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
    },
    downloadArtifact: async (artifact) => {
      if (artifact.status !== "ready") throw Error("ARTIFACT_UNAVAILABLE");
      const response = await run(artifactDownloadPath(artifact.id), { cache: "no-store", redirect: "error" });
      if (!response.ok) throw new ApiClientError(response.status, "ARTIFACT_UNAVAILABLE");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > ARTIFACT_LIMITS.maxOutputBytes || bytes.byteLength !== artifact.byteSize) throw Error("ARTIFACT_SIZE_MISMATCH");
      await saveFile(new Response(bytes, { headers: response.headers }), artifact.filename);
    },
    onSessionLost: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    session: async () => (await bridge.hasSession()).signedIn,
    signIn: async () => { await bridge.signIn(); },
    requestEmailCode: (email, language) => bridge.requestEmailCode({ email, language }),
    verifyEmailCode: (email, code) => bridge.verifyEmailCode({ email, code }),
    signOut: () => { capabilityCache = null; return bridge.signOut(); },
    list: async () => {
      const rows = await request<Array<{ id: string; title: string; surface: string; kind: string; isLocked: boolean }>>("/api/conversations");
      return rows.filter((row) => row.surface === "chat" && row.kind === "chat" && !row.isLocked);
    },
    load,
    models: async () => (await request<{ models: PublicCatalogModel[] }>("/api/models/catalog")).models.filter(isPubliclySelectableModel),
    capabilities: async () => ({ offered: (await request<{ autoSelection: { offered: boolean } }>("/api/products/chat/capabilities")).autoSelection.offered }),
    configure,
    create: async () => {
      const item = await request<{ id: string }>("/api/products/chat/conversations", json("POST", {}));
      const detail = await load(item.id);
      return detail.autoSelection?.offered ? configure(item.id, "", true) : detail;
    },
    send: async (conversation, text, files, signal, onProgress) => {
      const { persisted, sourceId } = await persistQuestion(conversation, text, files, signal);
      await streamModel(persisted, sourceId, persisted.selectedModels[0], signal, onProgress);
    },
    sendReview: async (conversation, text, files, signal, progress) => {
      let admission: { admissionToken: string; contextBundle?: string } | undefined;
      try { if (conversation.selectedModels.length > 1) {
        await requireParity();
        const input = { comparisonId: Date.now().toString(), conversationId: conversation.id, modelIds: conversation.selectedModels, prompt: text, attachments: files.map(file => ({ mediaType: file.mediaType, size: file.size })), webSearchMode: conversation.webSearchMode ?? "off" };
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
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const { persisted, sourceId } = await persistQuestion(conversation, text, files, signal);
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
