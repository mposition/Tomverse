import { chatStreamDisplayText } from "@tomverse/chat-core";
import { fitChatRequestTranscript } from "../../../lib/chatRequestLimits";
import { toChatRequestMessage } from "../../../lib/chatMessageSerialization";
import { resolveChatAttachmentFormat } from "../../../lib/chatAttachmentFormats";
import { createChatLivenessWatchdog } from "../../../lib/chatStreamLiveness";
import { isPubliclySelectableModel } from "../../../lib/models";
import type { PublicCatalogModel } from "../../../lib/publicModelCatalog";
import { mobileApiFetch, MobileAuth } from "./authBridge";
import type { ChatTransport, Conversation, MobileAttachment } from "./chatTransport";

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
type Attempt = { assistantMessageId: string; partialContent: string; status: string; actualModelId?: string; requestedModelId: string };
export class MobileApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function createApiTransport(source: ApiFetch = mobileApiFetch, bridge = MobileAuth): ChatTransport {
  const listeners = new Set<() => void>();
  const notifySessionLost = () => { for (const listener of listeners) listener(); };
  const run: ApiFetch = async (path, init) => {
    try { const response = await source(path, init); if (response.status === 401) notifySessionLost(); return response; }
    catch (error) { if ((error as { code?: string }).code === "SIGN_IN_REQUIRED") notifySessionLost(); throw error; }
  };
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await run(path, { cache: "no-store", ...init });
    const body = await response.json();
    if (!response.ok) throw new MobileApiError(response.status, body.code ?? "MOBILE_REQUEST_FAILED");
    return body as T;
  }
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const pathFor = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
  async function load(id: string): Promise<Conversation> {
    let item = await request<Conversation & { responseAttempts?: Attempt[] }>(pathFor(id));
    const active = (item.responseAttempts ?? []).filter((attempt) => ["claimed", "streaming"].includes(attempt.status));
    // The existing recovery endpoint reconciles expired leases without issuing
    // another model request. Read the canonical conversation again afterwards.
    for (const attempt of active) {
      await request(`/api/products/chat/attempts/${encodeURIComponent(attempt.assistantMessageId)}`);
    }
    if (active.length) item = await request<Conversation & { responseAttempts?: Attempt[] }>(pathFor(id));
    const messages = [...item.messages];
    for (const attempt of item.responseAttempts ?? []) {
      if (messages.some((message) => message.id === attempt.assistantMessageId)) continue;
      messages.push({ id: attempt.assistantMessageId, role: "assistant", content: attempt.partialContent,
        modelId: attempt.actualModelId ?? attempt.requestedModelId, status: attempt.status });
    }
    return { ...item, messages, activeAttempt: item.responseAttempts?.some((attempt) => ["claimed", "streaming"].includes(attempt.status)) ?? false };
  }
  async function configure(id: string, modelId: string, auto: boolean) {
    await request(pathFor(id), json("PATCH", { selectionMode: auto ? "auto" : "manual", ...(!auto ? { selectedModels: [modelId] } : {}) }));
    return load(id);
  }
  return {
    onSessionLost: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    session: async () => (await bridge.hasSession()).signedIn,
    signIn: async () => { await bridge.signIn(); },
    signOut: () => bridge.signOut(),
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
      const requestId = crypto.randomUUID();
      const saved = await request<{ messageMappings: Array<{ requestId: string; messageId: string }> }>(`${pathFor(conversation.id)}/messages`, {
        ...json("POST", { messages: [{ clientRequestId: requestId, role: "user", content: text,
          ...(files.length ? { attachmentUploadIds: files.map((file) => file.uploadId) } : {}) }] }), signal,
      });
      const sourceId = saved.messageMappings.find((mapping) => mapping.requestId === requestId)?.messageId;
      if (!sourceId) throw Error("MESSAGE_RECEIPT_MISSING");
      // Read the server-authored attachment references and the durable message id.
      const persisted = await load(conversation.id);
      const source = persisted.messages.find((message) => message.id === sourceId);
      if (!source) throw Error("SAVED_MESSAGE_MISSING");
      const messages = fitChatRequestTranscript(persisted.messages.filter((message) => message.role === "user" || message.status === "normal" || message.status === "incomplete" || !message.status)
        .map((message) => toChatRequestMessage({ id: message.id, role: message.role, content: message.content, attachments: message.attachments })));
      const assistantMessageId = crypto.randomUUID();
      const controller = new AbortController();
      const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      const watchdog = createChatLivenessWatchdog({ onExpire: abort });
      try {
      const response = await run("/api/chat", { ...json("POST", {
        messages, modelId: persisted.selectedModels[0], conversationId: conversation.id,
        assistantMessageId, sourceUserMessageId: sourceId,
      }), signal: controller.signal });
      watchdog.noteHeaders();
      if (!response.ok) {
        const body = await response.json();
        throw new MobileApiError(response.status, body.code ?? "CHAT_REQUEST_FAILED");
      }
      if (!response.body) throw Error("CHAT_STREAM_MISSING");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      let visibleLength = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          const visible = chatStreamDisplayText(raw);
          if (visible.length > visibleLength) { visibleLength = visible.length; watchdog.noteVisibleChunk(); }
          onProgress(visible);
        }
        raw += decoder.decode(); onProgress(chatStreamDisplayText(raw));
      } finally { reader.releaseLock(); }
      // A closed HTTP body alone does not establish a completed paid execution.
      const final = await load(conversation.id);
      if (!final.messages.some((message) => message.id === assistantMessageId && ["normal", "incomplete"].includes(message.status ?? ""))) throw Error("CHAT_OUTCOME_PENDING");
      } finally { watchdog.stop(); signal.removeEventListener("abort", abort); }
    },
    upload: async (file) => {
      const format = resolveChatAttachmentFormat({ filename: file.name, declaredMediaType: file.type });
      if (!format) throw new MobileApiError(400, "ATTACHMENT_UNSUPPORTED_FORMAT");
      const metadata = { name: file.name, size: file.size, mediaType: format.mediaType };
      const prepared = await request<{ key: string; uploadUrl: string; uploadHeaders: Record<string, string> }>("/api/chat", json("PUT", metadata));
      // Signed storage URLs receive bytes only; never the mobile bearer.
      const target = new URL(prepared.uploadUrl);
      if (target.protocol !== "https:" || target.username || target.password) throw Error("UNSAFE_UPLOAD_URL");
      const uploaded = await fetch(target, { method: "PUT", headers: prepared.uploadHeaders, body: file, credentials: "omit", redirect: "error" });
      if (!uploaded.ok) throw Error("UPLOAD_FAILED");
      return request<MobileAttachment>("/api/chat", json("PATCH", { ...metadata, key: prepared.key }));
    },
    transcribe: async (clip, signal) => {
      const result = await request<{ transcript: string }>("/api/chat/voice-transcription", { method: "POST", headers: { "Content-Type": clip.type }, body: clip, signal });
      return result.transcript;
    },
  };
}
