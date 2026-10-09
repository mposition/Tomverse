import { PROMPT_REFINER_INPUT_SCOPE } from "@/lib/promptRefinerSuggestion";
import { buildArtifactProgressChunk } from "@/lib/generatedArtifactProgressSignal";
import { buildChatStreamTrailerChunk } from "@/lib/webSearchStreamTrailer";
import { parseChatE04AutoAction } from "@/lib/chatE04StagingFixture";

export const CHAT_E04_CONVERSATION = "e0400000-0000-4000-8000-000000000001";
export const CHAT_E04_SESSION = { user: { id: "e04-synthetic-user", name: "E04 Synthetic QA",
  email: "e04-synthetic@example.invalid", plan: "Free" as const }, expires: "2099-01-01T00:00:00.000Z" };
type Message = { id: string; role: string; content: string; modelId?: string; clientRequestId?: string;
  attachmentUploadIds?: string[]; attachmentReferences?: { uploadId?: string; attachmentId?: string }[];
  attachments?: Record<string, unknown>[]; artifacts?: Record<string, unknown>[]; searchMetadata?: unknown };
export type ChatE04TransportEvidence = {
  syntheticRequests: number; blockedRequests: number; serverAutoRequests: number;
  chatRequests: number; contextRequests: number; contextBundleReused: boolean;
  attachmentFinalizations: number; voiceRequests: number; searchRequests: number; artifactDownloads: number;
  providerCalls: 0; productDatabaseWrites: 0; auditWrites: 0; costMicroUsd: 0;
};
const storageKey = "tomverse_e04_synthetic_qa_messages_v1";
let documentFetch: typeof fetch | null = null;

/** Installed only after the server's admin/staging page gate. No product fetch passes through. */
export function installChatE04FixtureTransport(onEvidence: (value: ChatE04TransportEvidence) => void) {
  const nativeFetch = documentFetch ??= window.fetch;
  let retired = false;
  let scenario: "success" | "error" = "success";
  let webSearchMode = "off"; let includeArtifact = false;
  const artifactText = "E04 synthetic generated Markdown.\n";
  const uploads = new Map<string, Record<string, unknown>>();
  let messages: Message[] = [
    { id: "e04-history-user", role: "user", content: "E04 synthetic prior question." },
    { id: "e04-history-answer", role: "assistant", modelId: "gpt-5-6-luna",
      content: "E04 synthetic retained history answer." },
  ];
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(saved) && saved.every((item) => typeof item === "object" && item !== null
      && typeof item.id === "string" && typeof item.role === "string" && typeof item.content === "string")) messages = saved;
  } catch { /* Broken QA cache is discarded, never promoted to a product record. */ }
  const drafts = new Map<string, Record<string, unknown>>();
  const evidence: ChatE04TransportEvidence = { syntheticRequests: 0, blockedRequests: 0,
    serverAutoRequests: 0, chatRequests: 0, contextRequests: 0, contextBundleReused: false,
    attachmentFinalizations: 0, voiceRequests: 0, searchRequests: 0, artifactDownloads: 0,
    providerCalls: 0, productDatabaseWrites: 0, auditWrites: 0, costMicroUsd: 0 };
  const emit = () => { if (!retired) onEvidence({ ...evidence }); };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const conversation = () => ({ id: CHAT_E04_CONVERSATION, title: "E04 synthetic conversation",
    selectedModels: ["gpt-5-6-luna"], disabledPanels: [], webSearchMode, memoryMode: "off",
    selectionMode: "manual", autoSelection: { offered: false }, assistantProfile: null,
    productKey: "chat", surface: "chat", isLocked: false, shareEnabled: false, messages,
    messagePage: { hasMore: false, nextCursor: null } });
  const save = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(messages)); } catch { /* QA cache only. */ } };
  const blocked = () => { evidence.blockedRequests++; emit(); return json({ code: "CHAT_E04_QA_REQUEST_BLOCKED" }, 503); };
  window.fetch = async (input, init) => {
    if (retired) return blocked();
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(new URL(input, window.location.origin), init);
    if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const url = new URL(request.url);
    if (url.origin !== window.location.origin) return blocked();
    const path = url.pathname; const method = request.method;
    if (path === "/api/admin/chat-e2e-fixture") {
      const query = url.search.slice(1);
      const parameters = [...url.searchParams.entries()];
      if (method !== "GET" || request.body !== null || new TextEncoder().encode(query).byteLength > 512
        || query.split("&").length !== 1 || parameters.length !== 1 || parameters[0][0] !== "action"
        || !parseChatE04AutoAction({ action: parameters[0][1] })) return blocked();
      evidence.serverAutoRequests++; emit(); return nativeFetch.call(window, request);
    }
    if (path === "/api/chat/voice-transcription" && method === "POST") {
      evidence.voiceRequests++; evidence.syntheticRequests++; emit();
      return json({ transcript: "E04 synthetic voice text. Send only when I choose." });
    }
    if (path === "/__e04_qa_upload__" && method === "PUT") {
      evidence.syntheticRequests++; emit(); return new Response(null, { status: 200 });
    }
    let body: Record<string, unknown> = {};
    if (!["GET", "HEAD"].includes(method)) {
      try { body = await request.json() as Record<string, unknown>; } catch { return blocked(); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return blocked();
    }
    let response: Response | null = null;
    if (path === "/e2e/prompt-refiner-adapter" && method === "POST"
      && typeof body.prompt === "string" && typeof body.requestId === "string") {
      response = json({ requestId: body.requestId, suggestionId: crypto.randomUUID(),
        refinedPrompt: `E04 synthetic preview: ${body.prompt}`, refinerVersion: "suggest-v1",
        inputScope: PROMPT_REFINER_INPUT_SCOPE });
    } else if (path === "/api/auth/session" && method === "GET") response = json(CHAT_E04_SESSION);
    else if (path === "/api/user/settings" && ["GET", "POST"].includes(method)) response = json({
      theme: "dark", language: "en", defaultModel: "gpt-5-6-luna", timeZone: "UTC",
      timeZoneInitializedAt: "2026-10-01T00:00:00.000Z", imageHandoffAutoGenerate: false,
    });
    else if (path === "/api/user/usage" && method === "GET") response = json({ plan: "Free",
      usage: { creditsDay: 0, creditsMonth: 0 }, balances: { dailyRemainingCredits: 300, planRemainingCredits: 300 },
      entitlement: { creditsAvailableNow: 300, dailyCreditsRemaining: 300, planCreditsRemaining: 300 },
      limits: { maxModels: 3, allowAttachments: true, allowSharing: false, allowDownloads: true },
    });
    else if (path === "/api/models/status" && method === "GET") response = json({ models: [] });
    else if (path === "/api/projects" && method === "GET") response = json({ projects: [] });
    else if (path === "/api/assistant-profiles" && method === "GET") response = json({ profiles: [] });
    else if (path === "/api/memories/settings" && method === "GET") response = json({ masterEnabled: false, styleEnabled: false, defaultConversationMode: "off" });
    else if ((path === "/api/conversations" || path === "/api/products/chat/conversations") && method === "GET") response = json([conversation()]);
    else if (path === `/api/conversations/${CHAT_E04_CONVERSATION}` && method === "GET") response = json(conversation());
    else if (path === `/api/conversations/${CHAT_E04_CONVERSATION}` && method === "PATCH") {
      if (["off", "auto", "always"].includes(String(body.webSearchMode))) webSearchMode = String(body.webSearchMode);
      response = json(conversation());
    }
    else if (path === "/api/chat" && method === "PUT") response = json({ key: "e04-synthetic-upload",
      uploadUrl: new URL("/__e04_qa_upload__", window.location.origin).href,
      uploadHeaders: { "Content-Type": "application/octet-stream" } });
    else if (path === "/api/chat" && method === "PATCH") {
      const uploadId = `upl-e04-${++evidence.attachmentFinalizations}`;
      const upload = { uploadId, name: typeof body.name === "string" ? body.name : "e04-synthetic.txt",
        mediaType: typeof body.mediaType === "string" ? body.mediaType : "text/plain", size: typeof body.size === "number" ? body.size : 1,
        kind: typeof body.mediaType === "string" && body.mediaType.startsWith("text/") ? "text" : "file" };
      uploads.set(uploadId, upload); response = json(upload);
    }
    else if (path === "/api/chat" && method === "DELETE") response = new Response(null, { status: 204 });
    else if (path === "/api/chat/availability" && method === "POST") response = json({
      traceId: "e04-synthetic-availability", plan: "Free", runnable: true, blockCode: null, blockLayer: null,
      webSearchMode: body.webSearchMode ?? "off", estimate: { requiredCredits: 0, models: [] },
      entitlement: { dailyCreditLimit: 300, dailyCreditsRemaining: 300, planCreditsRemaining: 300, creditsAvailableNow: 300, creditShortfall: 0 },
    });
    else if (path === "/api/chat/context" && method === "POST") {
      evidence.contextRequests++; response = json({ contextBundle: "e04-synthetic-context", memoryUsedCount: 0 });
    } else if (path === "/api/chat/preflight" && method === "POST") response = json({ ok: true,
      comparisonId: body.comparisonId, modelCount: Array.isArray(body.modelIds) ? body.modelIds.length : 0, requiredCredits: 0 });
    else if (path === `/api/conversations/${CHAT_E04_CONVERSATION}/messages` && method === "POST" && Array.isArray(body.messages)) {
      const mappings: { requestId: string; messageId: string }[] = [];
      const bound: Record<string, unknown>[] = [];
      for (const item of body.messages as Message[]) {
        if (!item.clientRequestId) continue;
        const existing = messages.find((message) => message.clientRequestId === item.clientRequestId);
        const message = existing ?? { ...item, id: crypto.randomUUID() };
        const references: NonNullable<Message["attachmentReferences"]> = item.attachmentReferences
          ?? (item.attachmentUploadIds ?? []).map((uploadId) => ({ uploadId }));
        message.attachments = references.map((reference, ordinal) => {
          const metadata = reference.uploadId ? uploads.get(reference.uploadId)
            : messages.flatMap((saved) => saved.attachments ?? []).find((attachment) => attachment.attachmentId === reference.attachmentId);
          const attachmentId = reference.attachmentId ?? `ma-e04-${message.id}-${ordinal}`;
          return { ...metadata, uploadId: undefined, id: attachmentId, attachmentId, ordinal };
        });
        bound.push(...message.attachments.map((attachment) => ({ messageId: message.id, ...attachment })));
        if (!existing) messages.push(message);
        mappings.push({ requestId: item.clientRequestId, messageId: message.id });
      }
      const consume = body.draftConsume as { scopeKey?: string; expectedRevision?: number; requestId?: string } | undefined;
      const currentDraft = consume?.scopeKey ? drafts.get(consume.scopeKey) : null;
      const draftConsumed = Boolean(currentDraft && currentDraft.revision === consume?.expectedRevision
        && mappings.some((mapping) => mapping.requestId === consume?.requestId));
      if (draftConsumed) drafts.delete(consume!.scopeKey!);
      save(); response = json({ success: true, created: mappings.length, messageMappings: mappings, attachments: bound, draftConsumed }, 201);
    } else if (path === `/api/conversations/${CHAT_E04_CONVERSATION}/messages/receipt` && method === "POST") {
      const requestMessage = body.message as Message | undefined;
      const existing = messages.find((item) => item.clientRequestId === requestMessage?.clientRequestId && item.content === requestMessage?.content);
      const consume = body.draftConsume as { scopeKey?: string; expectedRevision?: number } | undefined;
      const currentDraft = consume?.scopeKey ? drafts.get(consume.scopeKey) : null;
      const unchanged = Boolean(currentDraft && currentDraft.revision === consume?.expectedRevision && currentDraft.text === requestMessage?.content);
      response = json(existing ? { outcome: "committed", requestId: existing.clientRequestId, messageId: existing.id, attachments: existing.attachments ?? [] }
        : { outcome: unchanged ? "unchanged" : "ambiguous", attachments: [] });
    }
    else if (path.startsWith("/api/products/chat/drafts/") && ["GET", "PUT", "DELETE"].includes(method)) {
      const scopeKey = decodeURIComponent(path.slice("/api/products/chat/drafts/".length));
      if (method !== "GET" && body.expectedRevision !== Number(drafts.get(scopeKey)?.revision ?? 0)) {
        response = json({ code: "CHAT_DRAFT_REVISION_CONFLICT", currentRevision: drafts.get(scopeKey)?.revision ?? null, currentDraft: drafts.get(scopeKey) ?? null }, 409);
      } else if (method === "DELETE") { drafts.delete(scopeKey); response = new Response(null, { status: 204 }); }
      else {
        if (method === "PUT") drafts.set(scopeKey, { scopeKey, text: typeof body.text === "string" ? body.text : "",
          revision: Number(drafts.get(scopeKey)?.revision ?? 0) + 1,
          attachmentReferences: Array.isArray(body.attachmentReferences) ? body.attachmentReferences : [],
          attachments: Array.isArray(body.attachmentReferences) ? (body.attachmentReferences as { uploadId?: string; attachmentId?: string }[]).map((reference, ordinal) => {
            const metadata = reference.uploadId ? uploads.get(reference.uploadId)
              : messages.flatMap((saved) => saved.attachments ?? []).find((attachment) => attachment.attachmentId === reference.attachmentId);
            return { ...metadata, id: reference.uploadId ?? reference.attachmentId, ...reference, ordinal };
          }) : [],
          createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
        response = json({ scopeKey, draft: drafts.get(scopeKey) ?? null });
      }
    } else if (path === "/api/chat" && method === "POST") {
      evidence.chatRequests++; evidence.contextBundleReused = body.contextBundle === "e04-synthetic-context";
      if (scenario === "error") {
        scenario = "success"; response = json({ error: "E04 synthetic transport failure", code: "AI_PROVIDER_ERROR", traceId: "e04-synthetic-trace" }, 500);
      } else {
        const answer = "E04 synthetic answer. No provider was called.";
        const searchMetadata = body.webSearchMode === "always" ? { requested: true, supported: true, executed: true,
          provider: "openai", tool: "web_search", citations: [{ url: "https://example.invalid/e04-synthetic-source", title: "E04 synthetic source" }] } : null;
        if (searchMetadata) evidence.searchRequests++;
        const artifacts = includeArtifact ? [{ id: "art_e04_synthetic", ordinal: 0, format: "md" as const,
          filename: "e04-synthetic.md", mediaType: "text/markdown", byteSize: new TextEncoder().encode(artifactText).length,
          status: "ready" as const, modelId: "gpt-5-6-luna" }] : [];
        messages.push({ id: crypto.randomUUID(), role: "assistant", modelId: typeof body.modelId === "string" ? body.modelId : "gpt-5-6-luna",
          content: answer, artifacts, searchMetadata }); save();
        response = new Response((includeArtifact ? buildArtifactProgressChunk("md") : "") + answer + buildChatStreamTrailerChunk({
          completion: { status: "normal" }, searchMetadata, artifacts,
        }), { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Request-ID": "e04-synthetic-trace" } });
      }
    } else if (path === "/api/artifacts/art_e04_synthetic" && method === "GET") {
      evidence.artifactDownloads++; response = new Response(artifactText, { headers: {
        "Content-Type": "text/markdown", "Content-Disposition": 'attachment; filename="e04-synthetic.md"',
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      } });
    } else if (path === `/api/conversations/${CHAT_E04_CONVERSATION}/generate-title` && method === "POST") response = json({ title: "E04 synthetic conversation" });
    if (!response) return blocked();
    evidence.syntheticRequests++; emit(); return response;
  };
  navigator.sendBeacon = () => { evidence.blockedRequests++; emit(); return false; };
  XMLHttpRequest.prototype.send = function () { evidence.blockedRequests++; emit(); throw new Error("CHAT_E04_QA_REQUEST_BLOCKED"); };
  // Synthetic capture is installed before the real voice control mounts.
  // This document can never ask an OS microphone for access.
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
  } });
  class SyntheticRecorder {
    static isTypeSupported(type: string) { return type.split(";", 1)[0] === "audio/mp4"; }
    state = "inactive"; readonly mimeType = "audio/mp4";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null; onerror: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: this.mimeType }) }); this.onstop?.(); });
    }
  }
  Object.defineProperty(window, "MediaRecorder", { configurable: true, value: SyntheticRecorder });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: SyntheticRecorder });
  emit();
  return {
    setScenario: (value: "success" | "error") => { scenario = value; },
    setIncludeArtifact: (value: boolean) => { includeArtifact = value; },
    reset: () => { sessionStorage.removeItem(storageKey); },
    // A late callback must never regain the product transport. Leave this
    // document sealed until the explicit exit performs a hard navigation.
    retire: () => { retired = true; },
  };
}
