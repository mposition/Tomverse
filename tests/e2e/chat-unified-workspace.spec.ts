import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { buildRoutingRetryChunk } from "../../lib/routingRetrySignal";
import {
  expectNoHorizontalOverflow,
  createQaPdfBuffer,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  mockUserUsage,
  setDeterministicTheme,
  setRootFontSize,
  submitComposer,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

/**
 * Chat's additive entry and one-transcript contract, exercised with the real
 * client and fabricated API responses. No provider or database runs here.
 *
 * The server fixture cookie proves only that the client can be mounted. Real
 * entry eligibility and ownership are judged separately by server contracts.
 * The saved messages below are a mock of history, NOT persistence evidence.
 *
 * Controlled response bodies follow installChatModelStub's existing pattern,
 * with request recording and an explicit transport failure added locally.
 * The single init script makes recording survive reload without relying on
 * the order in which several fetch-patching init scripts would execute.
 */
const MODEL_A = "gpt-5-6-luna";
const MODEL_B = "claude-sonnet-5";
const CONVERSATION = "qa-conversation";
const SECOND_CONVERSATION = "qa-chat-second";
const UNCLASSIFIED_CONVERSATION = "qa-chat-unclassified";
const UNCLASSIFIED_ANSWER = "A late owned answer from the unclassified conversation.";
const FIRST_ANSWER = "A retained answer, written before the model changed.";
const SECOND_ANSWER = "B retained answer, from a different answering model.";

const qaMessageId = (conversationId: string, requestId: string) => {
  const bytes = createHash("sha256")
    .update(`qa-message\0${conversationId}\0${requestId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

type RecordedRequest = {
  modelId: string;
  conversationId?: string;
  messages?: Array<{ role: string; content: unknown }>;
  [key: string]: unknown;
};

type ConversationFixture = {
  id: string;
  title: string;
  selectedModels: string[];
  messages: QaConversationMessage[];
  productKey: "chat" | "review";
  surface: "chat" | "workspace";
};

type DraftFixture = {
  scopeKey: string;
  text: string;
  attachmentReferences: Array<{ uploadId?: string; attachmentId?: string }>;
  attachments: Array<Record<string, unknown>>;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

function installControlledChatFetch(options: {
  routedModelId?: string;
  responseErrorCode?: string;
  responseErrorOnceCode?: string;
  durableAttemptResponse?: boolean;
  messageSaveBodyStall?: boolean;
  messageReceiptBodyStall?: boolean;
} = {}) {
  const originalFetch = window.fetch.bind(window);
  const controls: Array<{
    request: RecordedRequest;
    push(text: string): void;
    finish(): void;
    fail(): void;
    aborted: boolean;
  }> = [];
  (window as unknown as { __unifiedChatControls: typeof controls }).__unifiedChatControls = controls;
  let hasReturnedOneShotError = false;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const isReceipt = /\/api\/conversations\/[^/]+\/messages\/receipt(?:$|\?)/.test(url);
    const isMessageSave = !isReceipt && /\/api\/conversations\/[^/]+\/messages(?:$|\?)/.test(url);
    if (method === "POST" && (
      (options.messageSaveBodyStall && isMessageSave) ||
      (options.messageReceiptBodyStall && isReceipt)
    )) {
      const response = await originalFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => {
            try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* Settled. */ }
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    }
    if (method !== "POST" || !/\/api\/chat($|\?)/.test(url)) {
      return originalFetch(input, init);
    }
    const request = JSON.parse(String(init?.body ?? "{}")) as RecordedRequest;
    const countKey = "__qa_unified_chat_post_count";
    const priorCount = Number(window.sessionStorage.getItem(countKey) ?? "0");
    window.sessionStorage.setItem(countKey, String(priorCount + 1));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const encoder = new TextEncoder();
    const control = {
      request,
      push: (text: string) => { void text; },
      finish: () => {},
      fail: () => {},
      aborted: false,
    };
    const responseErrorCode = options.responseErrorCode ??
      (!hasReturnedOneShotError ? options.responseErrorOnceCode : undefined);
    if (responseErrorCode) {
      hasReturnedOneShotError = true;
      controls.push(control);
      return new Response(JSON.stringify({
        code: responseErrorCode, error: "QA controlled model refusal", traceId: "qa-unified-refusal",
      }), {
        status: responseErrorCode === "MODEL_RETIRED"
          ? 410
          : responseErrorCode === "CHAT_CONTEXT_BUNDLE_ALREADY_CONSUMED"
            ? 409
            : 402,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (options.durableAttemptResponse) {
      controls.push(control);
      const assistantMessageId = String(request.assistantMessageId ?? "");
      const sourceUserMessageId = String(request.sourceUserMessageId ?? "");
      const conversationId = String(request.conversationId ?? "");
      const requestedModelId = String(request.modelId ?? "");
      return new Response(JSON.stringify({
        attempt: {
          assistantMessageId,
          conversationId,
          sourceUserMessageId,
          requestedModelId,
          actualModelId: options.routedModelId ?? requestedModelId,
          provider: "openai",
          status: "completed",
          partialContent: "The already-running attempt completed once.",
          checkpointRevision: 3,
          finishReason: "stop",
          failureCode: null,
          terminalAt: "2026-09-13T00:00:03.000Z",
          createdAt: "2026-09-13T00:00:00.000Z",
          updatedAt: "2026-09-13T00:00:03.000Z",
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Chat-Response-Mode": "durable-attempt",
          "X-Request-ID": "qa-durable-reattach",
        },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        control.push = (text) => {
          try { controller.enqueue(encoder.encode(text)); } catch { /* Settled. */ }
        };
        control.finish = () => {
          try { controller.close(); } catch { /* Settled. */ }
        };
        control.fail = () => {
          try { controller.error(new TypeError("QA transport interrupted")); } catch { /* Settled. */ }
        };
        const abort = () => {
          control.aborted = true;
          try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* Settled. */ }
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      },
    });
    const streamCountKey = "__qa_unified_provider_stream_count";
    const priorStreamCount = Number(window.sessionStorage.getItem(streamCountKey) ?? "0");
    window.sessionStorage.setItem(streamCountKey, String(priorStreamCount + 1));
    controls.push(control);
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Request-ID": "qa-unified-chat-trace",
        ...(options.routedModelId ? { "X-Chat-Routed-Model": options.routedModelId } : {}),
      },
    });
  }) as typeof window.fetch;
}

async function requests(page: Page) {
  return page.evaluate(() => (
    window as unknown as { __unifiedChatControls: Array<{ request: RecordedRequest }> }
  ).__unifiedChatControls.map((control) => control.request));
}

async function persistentChatPostCount(page: Page) {
  return page.evaluate(() =>
    Number(window.sessionStorage.getItem("__qa_unified_chat_post_count") ?? "0")
  );
}

async function persistentProviderStreamCount(page: Page) {
  return page.evaluate(() =>
    Number(window.sessionStorage.getItem("__qa_unified_provider_stream_count") ?? "0")
  );
}

async function drive(page: Page, index: number, action: "push" | "finish" | "fail", text = "") {
  await expect.poll(async () => (await requests(page)).length).toBeGreaterThan(index);
  await page.evaluate(({ index, action, text }) => {
    const control = (window as unknown as {
      __unifiedChatControls: Array<{ push(text: string): void; finish(): void; fail(): void }>;
    }).__unifiedChatControls[index];
    if (action === "push") control.push(text);
    else control[action]();
  }, { index, action, text });
}

const actionMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').first();

async function attachDraftFile(page: Page) {
  await actionMenuTrigger(page).click();
  await page.getByTestId("tools-attach-row").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("attach-local-file-row").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "recovery.pdf",
    mimeType: "application/pdf",
    buffer: createQaPdfBuffer(),
  });
}

async function openChat(page: Page, options: {
  viewport?: { width: number; height: number };
  messages?: QaConversationMessage[];
  disabledPanels?: string[];
  unclassifiedThird?: boolean;
  fresh?: boolean;
  accountDefaults?: string[];
  newAccount?: boolean;
  selectedModels?: string[];
  routedModelId?: string;
  responseErrorCode?: string;
  responseErrorOnceCode?: string;
  durableAttemptResponse?: boolean;
  contextBundle?: string | null;
  contextBundles?: Array<string | null>;
  sharedDrafts?: Map<string, DraftFixture>;
  legacyReview?: boolean;
  messageSaveFailure?: boolean;
  messageSaveFailureOnce?: boolean;
  messageSaveFailureStatus?: number;
  messageSaveResponseBody?: unknown;
  messageSaveResponseLostAfterCommit?: boolean;
  messageSaveBodyStall?: boolean;
  holdMessageSaveBeforeTransaction?: boolean;
  messageReceiptUnavailable?: boolean;
  messageReceiptResponseBody?: unknown;
  messageReceiptBodyStall?: boolean;
  holdMessageReceipt?: boolean;
  messageDeadlineMs?: number;
  holdDraftHydrate?: boolean;
  holdNextDraftMutation?: boolean;
  draftSyncFailure?: boolean;
  malformedDraftRead?: boolean;
  invalidDraftAttachmentRead?: boolean;
  draftFailurePlan?: Array<{ method: string; scopeKey: string }>;
} = {}) {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { selectedModels: [MODEL_A] });
  const userSettingsWrites: Array<Record<string, unknown>> = [];
  if (options.accountDefaults) {
    await page.route("**/api/user/settings**", async (route) => {
      if (route.request().method() !== "GET") userSettingsWrites.push(route.request().postDataJSON() ?? {});
      await route.fulfill({ json: {
        defaultModel: MODEL_A, newConversationModelIds: [...options.accountDefaults!],
        isNewAccount: options.newAccount ?? false,
        theme: "light", language: "en", timeZone: "UTC",
        timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangedAt: "2026-05-01T00:00:00.000Z", imageHandoffAutoGenerate: false,
      } });
    });
  }
  await mockUserUsage(page, { plan: "Pro" });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await page.context().addCookies([{
    name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100",
  }]);
  const conversations: ConversationFixture[] = [{
    id: CONVERSATION, title: "QA unified Chat", selectedModels: options.selectedModels ?? [MODEL_A],
    productKey: options.legacyReview ? "review" : "chat",
    surface: options.legacyReview ? "workspace" : "chat",
    messages: options.messages ?? [
      { id: "seed-u", role: "user", content: "A prior question." },
      { id: "seed-a", role: "assistant", content: FIRST_ANSWER, modelId: MODEL_A, status: "normal" },
    ],
  }, {
    id: SECOND_CONVERSATION, title: "Second unified Chat", selectedModels: [MODEL_B],
    productKey: "chat", surface: "chat",
    messages: [
      { id: "other-u", role: "user", content: "A second conversation question." },
      { id: "other-a", role: "assistant", content: SECOND_ANSWER, modelId: MODEL_B, status: "normal" },
    ],
  }];
  if (options.unclassifiedThird) conversations.push({
    id: UNCLASSIFIED_CONVERSATION, title: "Unclassified Chat", selectedModels: [MODEL_A],
    productKey: "chat", surface: "chat", messages: [
      { id: "late-u", role: "user", content: "An older third question." },
      { id: "late-a", role: "assistant", content: UNCLASSIFIED_ANSWER, modelId: MODEL_A, status: "normal" },
    ],
  });
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const historyReads: string[] = [];
  let responseAttempts: Array<Record<string, unknown>> = [];
  let attemptReadCount = 0;
  const attemptPollFailures: Array<{ status: number; retryAfter?: string }> = [];
  let contextBundleRead = 0;
  let messageSaveFailureReturned = false;
  let draftHydrateStarted = false;
  let draftReadCount = 0;
  const draftReadScopes: string[] = [];
  const draftRequests: Array<{ method: string; scopeKey: string }> = [];
  let draftFailuresReturned = 0;
  let draftMutationStarted = false;
  let messageSaveStarted = false;
  let messageReceiptStarted = false;
  let releaseDraftHydrate = () => {};
  let releaseDraftMutation = () => {};
  let releaseMessageSave = () => {};
  let releaseMessageReceipt = () => {};
  const draftHydrateGate = new Promise<void>((resolve) => {
    releaseDraftHydrate = resolve;
  });
  const draftMutationGate = new Promise<void>((resolve) => {
    releaseDraftMutation = resolve;
  });
  const messageSaveGate = new Promise<void>((resolve) => {
    releaseMessageSave = resolve;
  });
  const messageReceiptGate = new Promise<void>((resolve) => {
    releaseMessageReceipt = resolve;
  });
  let holdDraftMutation = options.holdNextDraftMutation ?? false;
  const drafts = options.sharedDrafts ?? new Map<string, DraftFixture>();
  const accountBDrafts = new Map<string, DraftFixture>();
  const accountBConversations: ConversationFixture[] = [];
  let exposePreviousAccountDrafts = true;
  let visibleConversations = conversations;
  const payload = (row: ConversationFixture) => ({
    ...row, disabledPanels: options.disabledPanels ?? [], webSearchMode: "off", memoryMode: "inherit",
    selectionMode: "manual", autoSelection: { offered: false },
    assistantProfile: null, isLocked: false, shareEnabled: false, nextCursor: null,
    responseAttempts,
  });
  await page.route(/\/api\/products\/chat\/attempts\/[^?]+(?:\?.*)?$/, async (route) => {
    attemptReadCount += 1;
    const forcedFailure = attemptPollFailures.shift();
    if (forcedFailure) {
      return route.fulfill({
        status: forcedFailure.status,
        headers: forcedFailure.retryAfter
          ? { "Retry-After": forcedFailure.retryAfter }
          : undefined,
        json: { code: "QA_ATTEMPT_POLL_FAILURE" },
      });
    }
    const assistantMessageId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop() ?? ""
    );
    const attempt = responseAttempts.find(
      (candidate) => candidate.assistantMessageId === assistantMessageId
    );
    if (!attempt) {
      return route.fulfill({ status: 404, json: { code: "CHAT_ATTEMPT_NOT_FOUND" } });
    }
    return route.fulfill({ json: { attempt } });
  });
  await page.route(/\/api\/products\/chat\/drafts\/[^?]+(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const scopeKey = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const currentDrafts = exposePreviousAccountDrafts ? drafts : accountBDrafts;
    draftRequests.push({ method, scopeKey });
    if (method === "GET") {
      draftReadCount += 1;
      draftReadScopes.push(scopeKey);
    }
    const plannedFailure = options.draftFailurePlan?.findIndex(
      (candidate) => candidate.method === method && candidate.scopeKey === scopeKey
    ) ?? -1;
    if (plannedFailure >= 0) options.draftFailurePlan?.splice(plannedFailure, 1);
    const shouldFailDraftRequest = options.draftSyncFailure || plannedFailure >= 0;
    if (method === "GET" && shouldFailDraftRequest) {
      draftFailuresReturned += 1;
      return route.fulfill({ status: 503, json: { code: "QA_DRAFT_SYNC_FAILED" } });
    }
    if (method === "GET") {
      // The fixture's Map is account A's server store. Account B must never
      // hydrate it merely because both accounts use the public `new` scope.
      const current = exposePreviousAccountDrafts
        ? currentDrafts.get(scopeKey) ?? null
        : null;
      if (options.holdDraftHydrate) {
        draftHydrateStarted = true;
        await draftHydrateGate;
      }
      if (options.invalidDraftAttachmentRead && current) {
        return route.fulfill({
          status: 409,
          json: {
            code: "CHAT_DRAFT_ATTACHMENT_INVALID",
            currentRevision: current.revision,
            currentDraft: {
              ...current,
              attachmentReferences: [],
              attachments: [],
            },
          },
        });
      }
      return route.fulfill({
        json: options.malformedDraftRead ? {} : { scopeKey, draft: current },
      });
    }
    if (holdDraftMutation) {
      holdDraftMutation = false;
      draftMutationStarted = true;
      await draftMutationGate;
    }
    if (shouldFailDraftRequest) {
      draftFailuresReturned += 1;
      return route.fulfill({ status: 503, json: { code: "QA_DRAFT_SYNC_FAILED" } });
    }
    const current = currentDrafts.get(scopeKey) ?? null;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    writes.push({ method, path: url.pathname, body });
    const expectedRevision = Number(body.expectedRevision);
    if (expectedRevision !== (current?.revision ?? 0)) {
      return route.fulfill({
        status: 409,
        json: {
          code: "CHAT_DRAFT_REVISION_CONFLICT",
          currentRevision: current?.revision ?? null,
          currentDraft: current,
        },
      });
    }
    if (method === "DELETE") {
      currentDrafts.delete(scopeKey);
      return route.fulfill({ status: 204, body: "" });
    }
    const now = "2026-09-13T00:00:00.000Z";
    const references = Array.isArray(body.attachmentReferences)
      ? body.attachmentReferences as Array<{ uploadId?: string; attachmentId?: string }>
      : [];
    const next = {
      scopeKey,
      text: typeof body.text === "string" ? body.text : "",
      attachmentReferences: references,
      attachments: references.map((reference, ordinal) => ({
        id: reference.attachmentId ?? reference.uploadId ?? `qa-draft-${ordinal}`,
        ordinal,
        name: `draft-${ordinal}.txt`,
        mediaType: "text/plain",
        size: 1,
        kind: "text",
        ...reference,
      })),
      revision: expectedRevision + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    currentDrafts.set(scopeKey, next);
    return route.fulfill({ json: { draft: next } });
  });
  await page.route(/\/api\/(?:products\/chat\/conversations|conversations)(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    const body = method === "GET" ? {} : (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/api/conversations" && method === "GET") {
      return route.fulfill({ json: visibleConversations.map((row) => (
        row.id === UNCLASSIFIED_CONVERSATION ? { ...payload(row), surface: undefined } : payload(row)
      )) });
    }
    if (path === "/api/products/chat/conversations" && method === "POST") {
      const created: ConversationFixture = {
        id: exposePreviousAccountDrafts ? "qa-chat-created" : "qa-chat-created-b",
        title: "New Chat", productKey: "chat", surface: "chat",
        selectedModels: Array.isArray(body.selectedModels) ? body.selectedModels as string[] : [MODEL_A],
        messages: [],
      };
      visibleConversations.push(created);
      return route.fulfill({ status: 201, json: payload(created) });
    }
    if (path.endsWith("/messages/receipt") && method === "POST") {
      messageReceiptStarted = true;
      if (options.holdMessageReceipt) await messageReceiptGate;
      if (options.messageReceiptUnavailable) {
        return route.fulfill({ status: 503, json: { code: "QA_RECEIPT_UNAVAILABLE" } });
      }
      if (options.messageReceiptResponseBody !== undefined) {
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
          json: options.messageReceiptResponseBody,
        });
      }
      const receipt = body as {
        draftConsume?: { scopeKey?: string; expectedRevision?: number; requestId?: string };
        message?: { clientRequestId?: string; content?: string; attachmentUploadIds?: string[]; attachmentReferences?: unknown[] };
      };
      const receiptConversation = visibleConversations.find((candidate) =>
        path === `/api/conversations/${candidate.id}/messages/receipt`
      );
      if (!receiptConversation || !receipt.draftConsume || !receipt.message) {
        return route.fulfill({ status: 200, json: { outcome: "ambiguous", attachments: [] } });
      }
      const receiptRequestId = receipt.message.clientRequestId ?? "";
      const receiptMessageId = qaMessageId(receiptConversation.id, receiptRequestId);
      const existing = receiptConversation.messages.find((candidate) =>
        candidate.id === receiptMessageId
      );
      if (existing && existing.role === "user" &&
          existing.content === receipt.message.content) {
        return route.fulfill({
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
          json: {
            outcome: "committed",
            requestId: receiptRequestId,
            messageId: receiptMessageId,
            attachments: existing.attachments ?? [],
          },
        });
      }
      const currentDrafts = exposePreviousAccountDrafts ? drafts : accountBDrafts;
      const currentDraft = receipt.draftConsume.scopeKey
        ? currentDrafts.get(receipt.draftConsume.scopeKey)
        : null;
      const references = receipt.message.attachmentReferences ??
        (receipt.message.attachmentUploadIds ?? []).map((uploadId) => ({ uploadId }));
      const unchanged = Boolean(
        currentDraft &&
        currentDraft.revision === receipt.draftConsume.expectedRevision &&
        currentDraft.text === receipt.message.content &&
        JSON.stringify(currentDraft.attachmentReferences) === JSON.stringify(references)
      );
      return route.fulfill({
        status: 200,
        headers: { "Cache-Control": "private, no-store" },
        json: { outcome: unchanged ? "unchanged" : "ambiguous", attachments: [] },
      });
    }
    const row = visibleConversations.find((candidate) => path === `/api/conversations/${candidate.id}` || path === `/api/conversations/${candidate.id}/messages`);
    if (!row) return route.fulfill({ status: 404, json: { code: "CONVERSATION_NOT_FOUND" } });
    if (path.endsWith("/messages") && method === "POST") {
      messageSaveStarted = true;
      if (options.holdMessageSaveBeforeTransaction) await messageSaveGate;
      if (
        options.messageSaveFailure ||
        (options.messageSaveFailureOnce && !messageSaveFailureReturned)
      ) {
        messageSaveFailureReturned = true;
        return route.fulfill({
          status: options.messageSaveFailureStatus ?? 500,
          json: { code: "QA_MESSAGE_SAVE_FAILED" },
        });
      }
      // A mock of the server's ordered restored-reference response, not proof
      // of object copying or DB atomicity. Those require the separate real-DB
      // tests. In particular, no attachmentId is invented as an uploadId.
      const bound: Array<NonNullable<QaConversationMessage["attachments"]>[number] & { messageId: string }> = [];
      const messageMappings: Array<{ requestId: string; messageId: string }> = [];
      for (const requestMessage of (body.messages ?? []) as Array<Omit<QaConversationMessage, "id"> & {
        clientRequestId: string;
        attachmentReferences?: Array<{ attachmentId: string }>;
        attachmentUploadIds?: string[];
      }>) {
        const messageId = qaMessageId(row.id, requestMessage.clientRequestId);
        const message = { ...requestMessage, id: messageId };
        messageMappings.push({ requestId: requestMessage.clientRequestId, messageId });
        const attachments = message.attachmentReferences
          ? message.attachmentReferences.map((reference, ordinal) => {
              const original = row.messages.flatMap((saved) => saved.attachments ?? [])
                .find((attachment) => attachment.id === reference.attachmentId);
              if (!original) throw new Error("QA restored attachment reference is not in this conversation");
              const id = `qa-restored-${message.id}-${ordinal}`;
              return { ...original, id, attachmentId: id, ordinal };
            })
          : message.attachmentUploadIds?.map((uploadId, ordinal) => {
              const id = `qa-uploaded-${message.id}-${ordinal}`;
              return {
                id,
                attachmentId: id,
                uploadId,
                ordinal,
                name: "recovery.pdf",
                mediaType: "application/pdf",
                size: createQaPdfBuffer().byteLength,
                kind: "file" as const,
              };
            });
        if (attachments) bound.push(...attachments.map((attachment) => ({ ...attachment, messageId: message.id })));
        if (!row.messages.some((saved) => saved.id === message.id)) row.messages.push({
          ...message, ...(attachments ? { attachments } : {}),
        });
      }
      let draftConsumed = false;
      if (body.draftConsume && typeof body.draftConsume === "object") {
        const consume = body.draftConsume as {
          scopeKey?: string;
          expectedRevision?: number;
          requestId?: string;
        };
        const currentDrafts = exposePreviousAccountDrafts ? drafts : accountBDrafts;
        const draft = consume.scopeKey ? currentDrafts.get(consume.scopeKey) : null;
        if (
          draft &&
          draft.revision === consume.expectedRevision &&
          (body.messages as Array<{ clientRequestId?: string }>)[0]?.clientRequestId === consume.requestId
        ) {
          currentDrafts.delete(consume.scopeKey!);
          draftConsumed = true;
        }
      }
      if (options.messageSaveResponseLostAfterCommit) {
        return route.abort("failed");
      }
      return route.fulfill({ status: 201, json:
        options.messageSaveResponseBody ?? {
          success: true,
          created: 1,
          messageMappings,
          attachments: bound,
          draftConsumed,
        }
      });
    }
    if (method === "PATCH" && Array.isArray(body.selectedModels)) row.selectedModels = body.selectedModels as string[];
    if (method === "GET") historyReads.push(url.pathname + url.search);
    return route.fulfill({ json: payload(row) });
  });
  // No title generation, provider operation or real ownership mutation escapes
  // the fabricated routes, even if a regression calls an unexpected endpoint.
  await page.route("**/api/conversations/*/generate-title", (route) => route.fulfill({ json: { title: "QA Chat" } }));
  // Same no-memory contract used by chat-memory-context.spec.ts. Preparation
  // stays local too; a dummy database refusal is not needed for this journey.
  await page.route("**/api/chat/context", (route) => {
    const bundles = options.contextBundles;
    const contextBundle = bundles
      ? bundles[Math.min(contextBundleRead, bundles.length - 1)] ?? null
      : options.contextBundle ?? null;
    contextBundleRead += 1;
    return route.fulfill({
      json: { ok: true, contextBundle, memoryUsedCount: 0 },
    });
  });
  await page.addInitScript(installControlledChatFetch, {
    routedModelId: options.routedModelId,
    responseErrorCode: options.responseErrorCode,
    responseErrorOnceCode: options.responseErrorOnceCode,
    durableAttemptResponse: options.durableAttemptResponse,
    messageSaveBodyStall: options.messageSaveBodyStall,
    messageReceiptBodyStall: options.messageReceiptBodyStall,
  });
  if (options.messageDeadlineMs) {
    await page.addInitScript((deadlineMs) => {
      window.__tomverseChatMessageDeadlineMs = deadlineMs;
    }, options.messageDeadlineMs);
  }
  await page.setViewportSize(options.viewport ?? DESKTOP_VIEWPORT);
  const workspacePath = options.legacyReview ? "/chat" : "/chat/workspace";
  await page.goto(`${workspacePath}?lang=en${options.fresh ? "" : `&conversation=${CONVERSATION}`}`);
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  if (!options.fresh) {
    // The server-rendered panel can already show history one commit before
    // ChatPageClient finishes adopting the URL conversation as the composer
    // scope. Tests that start an upload in that gap would correctly bind it
    // to `new`, then accidentally assert behavior for the stored conversation.
    await expect.poll(() => page.evaluate(() =>
      window.sessionStorage.getItem("tomverse_active_chat_id")
    )).toBe(CONVERSATION);
  }
  return {
    conversations, writes, historyReads, userSettingsWrites, drafts,
    detail: (id: string) => payload(conversations.find((row) => row.id === id)!),
    hidePreviousAccount: () => {
      visibleConversations = accountBConversations;
      exposePreviousAccountDrafts = false;
    },
    showPreviousAccount: () => {
      visibleConversations = conversations;
      exposePreviousAccountDrafts = true;
    },
    setResponseAttempts: (attempts: Array<Record<string, unknown>>) => {
      responseAttempts = attempts;
    },
    setAttemptPollFailures: (
      failures: Array<{ status: number; retryAfter?: string }>
    ) => {
      attemptPollFailures.push(...failures);
    },
    attemptReadCount: () => attemptReadCount,
    draftReadCount: () => draftReadCount,
    draftReadScopes: () => [...draftReadScopes],
    draftRequests: () => [...draftRequests],
    draftFailuresReturned: () => draftFailuresReturned,
    draftHydrateStarted: () => draftHydrateStarted,
    draftMutationStarted: () => draftMutationStarted,
    messageSaveStarted: () => messageSaveStarted,
    messageReceiptStarted: () => messageReceiptStarted,
    releaseDraftHydrate,
    releaseDraftMutation,
    releaseMessageSave,
    releaseMessageReceipt,
  };
}

async function chooseModel(page: Page, modelId: string) {
  const picker = await openModelPickerCatalogue(page);
  await picker.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`).click();
  await expect(picker.getByTestId("selected-model-chip")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-input-popover")).toHaveCount(0);
}

async function chooseConversation(page: Page, conversationId: string) {
  const mobileShell = page.getByTestId("mobile-chat-shell");
  if (await mobileShell.isVisible()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  await page.locator(
    `[data-testid="sidebar-conversation-item"][data-conversation-id="${conversationId}"]`
  ).click();
}

async function switchToFixtureAccountB(
  page: Page,
  state: Awaited<ReturnType<typeof openChat>>
) {
  state.hidePreviousAccount();
  await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
    user: { id: "qa-user-b", name: "QA B", email: "qa-b@example.test" },
    expires: "2099-01-01T00:00:00.000Z",
  } }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("chat-textarea")).toHaveValue("");
}

async function switchToFixtureAccountA(
  page: Page,
  state: Awaited<ReturnType<typeof openChat>>
) {
  state.showPreviousAccount();
  await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
    user: { id: "qa-user", name: "QA User", email: "qa@example.test" },
    expires: "2099-01-01T00:00:00.000Z",
  } }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const mobileShell = page.getByTestId("mobile-chat-shell");
  if (await mobileShell.isVisible()) {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("mobile-sidebar-drawer")).toBeVisible();
  }
  await expect(page.locator(
    `[data-testid="sidebar-conversation-item"][data-conversation-id="${CONVERSATION}"]`
  )).toHaveCount(1);
  if (await mobileShell.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mobile-sidebar-drawer")).toHaveCount(0);
  }
}

const message = (page: Page, text: string) => page.getByTestId("chat-message").filter({ hasText: text });

test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
  test("draft sync failure is visible and retry keeps the local question", async ({ page }) => {
    const state = await openChat(page, { draftSyncFailure: true });
    await page.getByTestId("chat-textarea").fill("Local text must survive");
    await expect.poll(state.draftReadCount).toBeGreaterThan(0);
    await expect(page.getByTestId("draft-sync-failed"), {
      message: `draft reads: ${state.draftReadScopes().join(",")}`,
    }).toBeVisible();
    const beforeRetry = state.draftReadCount();
    await page.getByTestId("draft-sync-retry").click();
    await expect.poll(state.draftReadCount).toBeGreaterThan(beforeRetry);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("Local text must survive");
  });

  test("leaving a failed hydration scope cancels its retry without restarting the new scope", async ({ page }) => {
    const state = await openChat(page, {
      holdDraftHydrate: true,
      draftFailurePlan: [{ method: "GET", scopeKey: CONVERSATION }],
    });
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();

    await chooseConversation(page, SECOND_CONVERSATION);
    await expect.poll(state.draftHydrateStarted).toBe(true);
    await page.waitForTimeout(1_200);

    const reads = state.draftRequests().filter(({ method }) => method === "GET");
    expect(reads.filter(({ scopeKey }) => scopeKey === CONVERSATION)).toHaveLength(1);
    expect(reads.filter(({ scopeKey }) => scopeKey === SECOND_CONVERSATION)).toHaveLength(1);
    state.releaseDraftHydrate();
  });

  test("leaving a failed persistence scope cancels its background retry", async ({ page }) => {
    const state = await openChat(page, {
      draftFailurePlan: [{ method: "PUT", scopeKey: CONVERSATION }],
    });
    await page.getByTestId("chat-textarea").fill("Do not retry this from another Chat.");
    await expect.poll(() => state.draftRequests().filter(
      ({ method, scopeKey }) => method === "PUT" && scopeKey === CONVERSATION
    ).length).toBe(1);
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();

    await chooseConversation(page, SECOND_CONVERSATION);
    await page.waitForTimeout(1_200);
    expect(state.draftRequests().filter(
      ({ method, scopeKey }) => method === "PUT" && scopeKey === CONVERSATION
    )).toHaveLength(1);
  });

  test("a transport failure followed by a revision conflict clears the stale failure banner", async ({ page }) => {
    const sharedDrafts = new Map<string, DraftFixture>();
    await openChat(page, {
      sharedDrafts,
      draftFailurePlan: [{ method: "PUT", scopeKey: CONVERSATION }],
    });
    await page.getByTestId("chat-textarea").fill("Keep this local version until I choose.");
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();

    const now = "2026-09-13T00:00:00.000Z";
    sharedDrafts.set(CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "Server version after the transport failure.",
      attachmentReferences: [],
      attachments: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await page.getByTestId("draft-sync-retry").click();
    const conflictNotice = page.getByTestId("draft-conflict-dialog");
    await expect(conflictNotice).toBeVisible();
    await expect(conflictNotice).toHaveAttribute("role", "alert");
    await expect(conflictNotice).not.toHaveAttribute("aria-modal");
    await expect(page.getByTestId("draft-sync-failed")).toHaveCount(0);

    await page.getByTestId("draft-conflict-use-server").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(
      "Server version after the transport failure."
    );
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    await expect(page.getByTestId("draft-sync-failed")).toHaveCount(0);
  });

  test("a dangling server attachment becomes an explicit choice and either choice can repair it", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "The server text remains recoverable.",
      attachmentReferences: [{ attachmentId: "missing_attachment" }],
      attachments: [{
        id: "missing_attachment", ordinal: 0, name: "missing.pdf",
        mediaType: "application/pdf", size: 12, kind: "file",
        attachmentId: "missing_attachment",
      }],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }]]);
    const state = await openChat(page, {
      sharedDrafts,
      invalidDraftAttachmentRead: true,
    });

    await expect(page.getByTestId("draft-conflict-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    await page.getByTestId("draft-conflict-use-server").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(
      "The server text remains recoverable."
    );
    await expect.poll(() => state.drafts.get(CONVERSATION)?.revision).toBe(2);
    expect(state.drafts.get(CONVERSATION)?.attachmentReferences).toEqual([]);
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    await expect(page.getByTestId("draft-sync-failed")).toHaveCount(0);
  });

  test("a malformed PUT conflict preserves local input as a retryable sync failure", async ({ page }) => {
    const state = await openChat(page);
    await expect.poll(state.draftReadCount).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    await page.route(`**/api/products/chat/drafts/${CONVERSATION}`, async (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({ status: 409, body: "not-json" });
      }
      return route.fallback();
    });

    const local = "Malformed conflict cannot erase this local question.";
    await page.getByTestId("chat-textarea").fill(local);
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(local);
  });

  test("a successful GET without an explicit draft envelope preserves local input", async ({ page }) => {
    const state = await openChat(page, {
      holdDraftHydrate: true,
      malformedDraftRead: true,
    });
    await expect.poll(state.draftHydrateStarted).toBe(true);
    const local = "A 200 without draft evidence cannot replace this question.";
    await page.getByTestId("chat-textarea").fill(local);
    state.releaseDraftHydrate();

    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(local);
  });

  test("a wrong-scope draft response cannot overwrite the active local question", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: SECOND_CONVERSATION,
      text: "This response belongs to another Chat.",
      attachmentReferences: [],
      attachments: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }]]);
    const state = await openChat(page, { sharedDrafts, holdDraftHydrate: true });
    await expect.poll(state.draftHydrateStarted).toBe(true);
    const local = "Keep this active Chat's local question.";
    await page.getByTestId("chat-textarea").fill(local);
    state.releaseDraftHydrate();

    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(local);
  });

  test("a malformed DELETE conflict remains a retryable failure, not a server choice", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "Remove this draft only after a valid acknowledgement.",
      attachmentReferences: [],
      attachments: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }]]);
    await openChat(page, { sharedDrafts });
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toHaveValue(
      "Remove this draft only after a valid acknowledgement."
    );
    await page.route(`**/api/products/chat/drafts/${CONVERSATION}`, async (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({
          status: 409,
          json: { code: "CHAT_DRAFT_REVISION_CONFLICT" },
        });
      }
      return route.fallback();
    });

    await textarea.fill("");
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    await expect(textarea).toHaveValue("");
  });

  test("a PUT success with a different snapshot is not accepted as durable", async ({ page }) => {
    const state = await openChat(page);
    await expect.poll(state.draftReadCount).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    await page.route(`**/api/products/chat/drafts/${CONVERSATION}`, async (route) => {
      if (route.request().method() === "PUT") {
        const now = "2026-09-13T00:00:00.000Z";
        return route.fulfill({ json: { draft: {
          scopeKey: CONVERSATION,
          text: "A different server snapshot.",
          attachmentReferences: [],
          attachments: [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        } } });
      }
      return route.fallback();
    });
    const local = "Only this exact local snapshot may be acknowledged.";
    await page.getByTestId("chat-textarea").fill(local);
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(local);
  });

  test("a DELETE 200 response is not accepted as deletion evidence", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "Delete only on the exact endpoint acknowledgement.",
      attachmentReferences: [],
      attachments: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }]]);
    await openChat(page, { sharedDrafts });
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toHaveValue(
      "Delete only on the exact endpoint acknowledgement."
    );
    await page.route(`**/api/products/chat/drafts/${CONVERSATION}`, async (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({ status: 200, json: {} });
      }
      return route.fallback();
    });

    await textarea.fill("");
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await expect(textarea).toHaveValue("");
  });

  test("a successful edit supersedes an older persistence failure retry", async ({ page }) => {
    const sharedDrafts = new Map<string, DraftFixture>();
    const state = await openChat(page, {
      sharedDrafts,
      draftFailurePlan: [{ method: "PUT", scopeKey: CONVERSATION }],
    });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("First snapshot fails.");
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();

    await textarea.fill("Second snapshot succeeds and owns the retry schedule.");
    await expect.poll(() => state.draftRequests().filter(
      ({ method, scopeKey }) => method === "PUT" && scopeKey === CONVERSATION
    ).length).toBe(2);
    await expect(page.getByTestId("draft-sync-failed")).toHaveCount(0);
    await page.waitForTimeout(1_100);

    expect(state.draftRequests().filter(
      ({ method, scopeKey }) => method === "PUT" && scopeKey === CONVERSATION
    )).toHaveLength(2);
    expect(sharedDrafts.get(CONVERSATION)?.revision).toBe(1);
    expect(sharedDrafts.get(CONVERSATION)?.text).toBe(
      "Second snapshot succeeds and owns the retry schedule."
    );
  });

  test("a mutation failing after navigation cannot recreate its cancelled retry", async ({ page }) => {
    const state = await openChat(page, {
      holdNextDraftMutation: true,
      draftFailurePlan: [{ method: "PUT", scopeKey: CONVERSATION }],
    });
    await page.getByTestId("chat-textarea").fill("The late failure stays manual.");
    await expect.poll(state.draftMutationStarted).toBe(true);

    await chooseConversation(page, SECOND_CONVERSATION);
    await expect.poll(() => page.evaluate(() =>
      window.sessionStorage.getItem("tomverse_active_chat_id")
    )).toBe(SECOND_CONVERSATION);
    state.releaseDraftMutation();
    await expect.poll(state.draftFailuresReturned).toBe(1);
    await page.waitForTimeout(100);
    await chooseConversation(page, CONVERSATION);
    await expect(page.getByTestId("draft-sync-failed")).toBeVisible();
    await page.waitForTimeout(1_100);

    expect(state.draftRequests().filter(
      ({ method, scopeKey }) => method === "PUT" && scopeKey === CONVERSATION
    )).toHaveLength(1);
  });

  test("authenticated Chat restores a text-and-attachment draft after reload without an answer POST", async ({ page }) => {
    const state = await openChat(page);
    await mockAttachmentUpload(page);
    await attachDraftFile(page);
    await expect(page.getByTestId("attachment-complete")).toContainText("recovery.pdf");
    await page.getByTestId("chat-textarea").fill("Keep this exact unsent question.");
    await expect.poll(() => state.drafts.get(CONVERSATION)?.revision ?? 0).toBeGreaterThan(0);
    const stored = state.drafts.get(CONVERSATION)!;
    // The real endpoint derives this safe metadata from the owned upload row;
    // the draft PUT intentionally sent only its opaque id.
    stored.attachments = stored.attachments.map((attachment) => ({
      ...attachment,
      name: "recovery.pdf",
      mediaType: "application/pdf",
      size: createQaPdfBuffer().byteLength,
      kind: "file",
    }));
    expect(await persistentChatPostCount(page)).toBe(0);

    await page.reload();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(
      "Keep this exact unsent question."
    );
    await expect(page.getByTestId("attachment-complete")).toContainText("recovery.pdf");
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a late hydrate with a different server draft latches conflict without overwriting or autosaving local edits", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "Remote draft captured when hydration began.",
      attachmentReferences: [],
      attachments: [],
      revision: 4,
      createdAt: now,
      updatedAt: now,
    }]]);
    const state = await openChat(page, { sharedDrafts, holdDraftHydrate: true });
    await expect.poll(state.draftHydrateStarted).toBe(true);
    const local = "Local edit made while hydration was delayed.";
    await page.getByTestId("chat-textarea").fill(local);
    state.releaseDraftHydrate();

    await expect(page.getByTestId("draft-conflict-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(local);
    await page.waitForTimeout(700);
    expect(state.writes.filter((write) => write.method === "PUT")).toHaveLength(0);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a late hydrate recognizes the same upload despite a different client attachment id", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "",
      attachmentReferences: [{ uploadId: "upl-qa-1" }],
      attachments: [{
        // The public draft contract uses the opaque reference as its id. The
        // locally selected file still has a different client-only id, so this
        // exercises identity matching by uploadId without inventing a server
        // response that production can never emit.
        id: "upl-qa-1",
        ordinal: 0,
        name: "recovery.pdf",
        mediaType: "application/pdf",
        size: createQaPdfBuffer().byteLength,
        kind: "file",
        uploadId: "upl-qa-1",
      }],
      revision: 4,
      createdAt: now,
      updatedAt: now,
    }]]);
    const state = await openChat(page, { sharedDrafts, holdDraftHydrate: true });
    await expect.poll(state.draftHydrateStarted).toBe(true);
    await mockAttachmentUpload(page);
    await attachDraftFile(page);
    await expect(page.getByTestId("attachment-complete")).toContainText("recovery.pdf");

    state.releaseDraftHydrate();
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    await page.getByTestId("chat-textarea").fill("Stable upload identity keeps the CAS revision.");
    await expect.poll(() => sharedDrafts.get(CONVERSATION)?.revision).toBe(5);
    expect(sharedDrafts.get(CONVERSATION)?.attachmentReferences).toEqual([
      { uploadId: "upl-qa-1" },
    ]);
    expect(state.writes.filter((write) => write.method === "PUT")).toHaveLength(1);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("two tabs race one draft revision; the stale tab gets 409 and keeps its local question", async ({ page, context }) => {
    const first = await openChat(page);
    const stalePage = await context.newPage();
    const stale = await openChat(stalePage, { sharedDrafts: first.drafts });
    const firstTextarea = page.getByTestId("chat-textarea");
    const staleTextarea = stalePage.getByTestId("chat-textarea");

    // Both tabs hydrated revision 0. The first tab wins revision 1; the
    // second tab still writes expectedRevision=0 and is refused.
    await firstTextarea.fill("First tab owns revision one.");
    await expect.poll(() => first.drafts.get(CONVERSATION)?.revision).toBe(1);
    await staleTextarea.fill("Stale tab local text must survive the conflict.");
    await expect(stalePage.getByTestId("draft-conflict-dialog")).toBeVisible();
    await expect(staleTextarea).toHaveValue(
      "Stale tab local text must survive the conflict."
    );
    const writesAtConflict = stale.writes.filter(
      (write) => write.method === "PUT" && write.path.endsWith(`/drafts/${CONVERSATION}`)
    ).length;
    await staleTextarea.fill("Edited again, but still explicitly unresolved.");
    await page.waitForTimeout(700);
    expect(stale.writes.filter(
      (write) => write.method === "PUT" && write.path.endsWith(`/drafts/${CONVERSATION}`)
    )).toHaveLength(writesAtConflict);
    await stalePage.getByTestId("chat-send-button").click({ force: true });
    await stalePage.waitForTimeout(300);
    expect(await persistentChatPostCount(stalePage)).toBe(0);
    await expect(stalePage.getByTestId("draft-conflict-dialog")).toBeVisible();
    expect(first.drafts.get(CONVERSATION)?.text).toBe(
      "First tab owns revision one."
    );
    await stalePage.getByTestId("draft-conflict-overwrite-local").click();
    await expect.poll(() => first.drafts.get(CONVERSATION)?.text).toBe(
      "Edited again, but still explicitly unresolved."
    );
    await expect(stalePage.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    expect(await persistentChatPostCount(stalePage)).toBe(0);
  });

  test("choosing the server draft replaces the stale tab without another PUT", async ({ page, context }) => {
    const first = await openChat(page);
    const stalePage = await context.newPage();
    const stale = await openChat(stalePage, { sharedDrafts: first.drafts });
    await page.getByTestId("chat-textarea").fill("The server-side winner.");
    await expect.poll(() => first.drafts.get(CONVERSATION)?.revision).toBe(1);
    await stalePage.getByTestId("chat-textarea").fill("The stale local draft.");
    await expect(stalePage.getByTestId("draft-conflict-dialog")).toBeVisible();
    const writesBeforeChoice = stale.writes.length;

    await stalePage.getByTestId("draft-conflict-use-server").click();
    await expect(stalePage.getByTestId("chat-textarea")).toHaveValue(
      "The server-side winner."
    );
    await stalePage.waitForTimeout(700);
    expect(stale.writes).toHaveLength(writesBeforeChoice);
  });

  test("send waits for a pending autosave 409 and cannot bypass the unresolved conflict", async ({ page }) => {
    const now = "2026-09-13T00:00:00.000Z";
    const sharedDrafts = new Map<string, DraftFixture>([[CONVERSATION, {
      scopeKey: CONVERSATION,
      text: "Hydrated revision one.",
      attachmentReferences: [],
      attachments: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }]]);
    const state = await openChat(page, {
      sharedDrafts,
      holdNextDraftMutation: true,
    });
    await expect(page.getByTestId("chat-textarea")).toHaveValue("Hydrated revision one.");
    const local = "This write will lose its CAS race.";
    await page.getByTestId("chat-textarea").fill(local);
    await expect.poll(state.draftMutationStarted).toBe(true);
    sharedDrafts.set(CONVERSATION, {
      ...sharedDrafts.get(CONVERSATION)!,
      text: "A different tab now owns revision two.",
      revision: 2,
      updatedAt: "2026-09-13T00:00:02.000Z",
    });

    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(150);
    expect(await persistentChatPostCount(page)).toBe(0);
    state.releaseDraftMutation();

    await expect(page.getByTestId("draft-conflict-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(local);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a model switch while prepare waits for a draft PUT aborts before Message persistence", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, {
      holdNextDraftMutation: true,
      viewport,
    });
    const prompt = "The delayed exact draft belongs only to the original model.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await expect.poll(state.draftMutationStarted).toBe(true);
    await page.getByTestId("chat-send-button").click();
    await chooseModel(page, MODEL_B);
    state.releaseDraftMutation();

    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    await expect(page.getByText(
      "The conversation or model changed while preparing the answer. Check your question and send again.",
      { exact: true }
    )).toBeVisible();
    expect(state.writes.filter((write) => write.path.endsWith("/messages"))).toEqual([]);
    expect(await requests(page)).toHaveLength(0);
  });

  test("the client sends one frozen draftConsume with the user message before one answer dispatch", async ({ page }) => {
    const state = await openChat(page);
    await page.getByTestId("chat-textarea").fill("Consume this revision once.");
    await expect.poll(() => state.drafts.get(CONVERSATION)?.revision ?? 0).toBeGreaterThan(0);
    await page.getByTestId("chat-send-button").click();
    await drive(page, 0, "push", "One accepted answer.");
    await drive(page, 0, "finish");
    await expect(message(page, "One accepted answer.")).toBeVisible();

    const messageWrite = state.writes.find(
      (write) => write.path === `/api/conversations/${CONVERSATION}/messages`
    );
    expect(messageWrite?.body.draftConsume).toMatchObject({
      scopeKey: CONVERSATION,
    });
    expect(
      (messageWrite?.body.draftConsume as { expectedRevision: number }).expectedRevision
    ).toBeGreaterThan(0);
    const sourceRequestId = (messageWrite?.body.draftConsume as { requestId: string }).requestId;
    expect((messageWrite?.body.messages as Array<{ clientRequestId: string }>)[0].clientRequestId).toBe(sourceRequestId);
    const sourceMessageId = qaMessageId(CONVERSATION, sourceRequestId);
    expect(sourceMessageId).not.toBe(sourceRequestId);
    expect((await requests(page))[0].sourceUserMessageId).toBe(sourceMessageId);
    expect(state.drafts.has(CONVERSATION)).toBe(false);
    expect(await persistentChatPostCount(page)).toBe(1);
  });

  test("a committed Message whose HTTP response is lost is recovered once before provider dispatch", async ({ page }) => {
    const state = await openChat(page, { messageSaveResponseLostAfterCommit: true });
    const prompt = "The receipt proves this committed question.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();
    await expect.poll(state.messageReceiptStarted).toBe(true);
    await drive(page, 0, "push", "Recovered after the lost response.");
    await drive(page, 0, "finish");

    await expect(message(page, "Recovered after the lost response.")).toBeVisible();
    expect(state.drafts.has(CONVERSATION)).toBe(false);
    expect(state.conversations[0].messages.filter((item) => item.content === prompt)).toHaveLength(1);
    expect(await persistentProviderStreamCount(page)).toBe(1);
  });

  test("a gateway 504 with an unchanged receipt remains recovery locked", async ({ page }) => {
    const state = await openChat(page, {
      messageSaveFailure: true,
      messageSaveFailureStatus: 504,
    });
    const prompt = "The gateway cannot prove whether upstream took the lock.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(state.messageReceiptStarted).toBe(true);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    const recoveryNotice = page.getByTestId("message-receipt-recovery-dialog");
    await expect(recoveryNotice).toBeVisible();
    await expect(recoveryNotice).toHaveAttribute("role", "alert");
    await expect(recoveryNotice).not.toHaveAttribute("aria-modal");
    expect(state.drafts.get(CONVERSATION)?.text).toBe(prompt);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a committed lost response across A-to-B-to-A clears A without stale navigation or dispatch", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, {
      messageSaveResponseLostAfterCommit: true,
      holdMessageReceipt: true,
      viewport,
    });
    const prompt = "Account A committed before its response was lost.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();
    await expect.poll(state.messageReceiptStarted).toBe(true);
    await switchToFixtureAccountB(page, state);
    await switchToFixtureAccountA(page, state);
    await chooseConversation(page, CONVERSATION);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");

    state.releaseMessageReceipt();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    expect(state.drafts.has(CONVERSATION)).toBe(false);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a completed 409 receipt across A-to-B-to-A restores A's authoritative revision", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, {
      messageSaveFailure: true,
      messageSaveFailureStatus: 409,
      holdMessageReceipt: true,
      viewport,
    });
    const prompt = "Account A rollback remains an explicit retry.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();
    await expect.poll(state.messageReceiptStarted).toBe(true);
    await switchToFixtureAccountB(page, state);
    await switchToFixtureAccountA(page, state);
    await chooseConversation(page, CONVERSATION);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");

    state.releaseMessageReceipt();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    expect(state.drafts.get(CONVERSATION)?.text).toBe(prompt);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a timed-out Message stays locked when its early receipt only sees the unchanged draft", async ({ page }) => {
    const state = await openChat(page, {
      holdMessageSaveBeforeTransaction: true,
      messageDeadlineMs: 50,
    });
    const prompt = "The original request may still take the lock later.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();
    await expect.poll(state.messageSaveStarted).toBe(true);
    await expect.poll(state.messageReceiptStarted).toBe(true);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    expect(await persistentChatPostCount(page)).toBe(0);

    // The original request commits after the receipt's unchanged observation.
    // The client must remain locked because unchanged was not authoritative
    // for a transport timeout.
    state.releaseMessageSave();
    await page.waitForTimeout(150);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    expect(state.drafts.has(CONVERSATION)).toBe(false);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("an unavailable receipt locks only account A and reload safely rehydrates its draft", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, {
      messageSaveFailure: true,
      messageReceiptUnavailable: true,
      viewport,
    });
    const prompt = "Account A needs an explicit recovery reload.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");

    await switchToFixtureAccountB(page, state);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    await page.getByTestId("chat-textarea").fill("Account B remains editable.");

    await switchToFixtureAccountA(page, state);
    await chooseConversation(page, CONVERSATION);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await page.getByTestId("message-receipt-recovery-reload").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toHaveCount(0);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a Message response body stall is covered by the deadline and a committed receipt dispatches once", async ({ page }) => {
    const state = await openChat(page, {
      messageSaveBodyStall: true,
      messageDeadlineMs: 50,
    });
    const prompt = "The Message body never completes, but its transaction committed.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(state.messageReceiptStarted).toBe(true);
    await drive(page, 0, "push", "The receipt recovered the body stall.");
    await drive(page, 0, "finish");
    await expect(message(page, "The receipt recovered the body stall.")).toBeVisible();
    expect(state.drafts.has(CONVERSATION)).toBe(false);
    expect(await persistentProviderStreamCount(page)).toBe(1);
  });

  test("a receipt response body stall reaches bounded recovery without provider dispatch", async ({ page }) => {
    const state = await openChat(page, {
      messageSaveFailure: true,
      messageSaveFailureStatus: 504,
      messageReceiptBodyStall: true,
      messageDeadlineMs: 50,
    });
    const prompt = "Neither gateway response body proves the Message outcome.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(state.messageReceiptStarted).toBe(true);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("malformed Message and receipt success bodies remain indeterminate", async ({ page }) => {
    const state = await openChat(page, {
      messageSaveResponseBody: { success: true, created: 1, attachments: [] },
      messageReceiptResponseBody: { outcome: "committed", attachments: null },
    });
    const prompt = "A 2xx without draftConsumed is not transaction evidence.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(state.messageReceiptStarted).toBe(true);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("an invalid committed attachment receipt cannot consume the local draft or dispatch", async ({ page }) => {
    const state = await openChat(page, {
      messageSaveResponseBody: {
        success: true, created: 1, draftConsumed: true, attachments: [],
      },
      messageReceiptResponseBody: {
        outcome: "committed",
        attachments: [{
          id: "", ordinal: 0, name: "recovery.pdf",
          mediaType: "application/pdf", size: 12, kind: "file",
        }],
      },
    });
    await mockAttachmentUpload(page);
    await attachDraftFile(page);
    await expect(page.getByTestId("attachment-complete")).toContainText("recovery.pdf");
    await page.getByTestId("chat-textarea").fill("The committed receipt has an invalid binding.");
    await page.getByTestId("chat-send-button").click();

    await expect.poll(state.messageReceiptStarted).toBe(true);
    await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("text and attachment sends persist and dispatch one whitespace-canonical snapshot", async ({ page }) => {
    const state = await openChat(page);
    await mockAttachmentUpload(page);
    await attachDraftFile(page);
    await expect(page.getByTestId("attachment-complete")).toContainText("recovery.pdf");
    await page.getByTestId("chat-textarea").fill("  Canonical attachment question.  \n");
    await page.getByTestId("chat-send-button").click();
    await drive(page, 0, "push", "Canonical answer.");
    await drive(page, 0, "finish");
    await expect(message(page, "Canonical answer.")).toBeVisible();

    const draftPuts = state.writes.filter(
      (write) => write.method === "PUT" && write.path.endsWith(`/drafts/${CONVERSATION}`)
    );
    expect(draftPuts.at(-1)?.body.text).toBe("Canonical attachment question.");
    const messageWrite = state.writes.find(
      (write) => write.path === `/api/conversations/${CONVERSATION}/messages`
    );
    expect((messageWrite?.body.messages as Array<{ content: string }>)[0].content).toBe(
      "Canonical attachment question."
    );
    const providerMessages = (await requests(page))[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(providerMessages.at(-1)).toMatchObject({
      role: "user",
      content: "Canonical attachment question.",
    });
  });

  test("a text-only send uses the same trimmed snapshot for draft, Message, and provider", async ({ page }) => {
    const state = await openChat(page);
    await page.getByTestId("chat-textarea").fill("\n  Canonical text-only question.\t ");
    await page.getByTestId("chat-send-button").click();
    await drive(page, 0, "push", "Text-only answer.");
    await drive(page, 0, "finish");

    const draftPuts = state.writes.filter(
      (write) => write.method === "PUT" && write.path.endsWith(`/drafts/${CONVERSATION}`)
    );
    expect(draftPuts.at(-1)?.body.text).toBe("Canonical text-only question.");
    const messageWrite = state.writes.find(
      (write) => write.path === `/api/conversations/${CONVERSATION}/messages`
    );
    expect((messageWrite?.body.messages as Array<{ content: string }>)[0].content).toBe(
      "Canonical text-only question."
    );
    const providerMessages = (await requests(page))[0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(providerMessages.at(-1)?.content).toBe("Canonical text-only question.");
  });

  test("a duplicate live request adopts the durable attempt response without opening a second stream", async ({ page }) => {
    await openChat(page, { durableAttemptResponse: true });
    await page.getByTestId("chat-textarea").fill("Attach to the one durable attempt.");
    await page.getByTestId("chat-send-button").click();

    await expect(message(page, "The already-running attempt completed once.")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await persistentChatPostCount(page)).toBe(1);
    expect(await requests(page)).toHaveLength(1);
  });

  test("a post-claim context collision retries with a fresh assistant id and reaches one provider stream", async ({ page }) => {
    await openChat(page, {
      responseErrorOnceCode: "CHAT_CONTEXT_BUNDLE_ALREADY_CONSUMED",
      contextBundles: ["qa-consumed-context-bundle", "qa-fresh-context-bundle"],
    });
    await page.getByTestId("chat-textarea").fill("Recover this claimed collision once.");
    await page.getByTestId("chat-send-button").click();
    await drive(page, 1, "push", "Recovered with one provider invocation.");
    await drive(page, 1, "finish");
    await expect(message(page, "Recovered with one provider invocation.")).toBeVisible();

    const sent = await requests(page);
    expect(sent).toHaveLength(2);
    expect(sent[0].assistantMessageId).not.toBe(sent[1].assistantMessageId);
    expect(sent[0].contextBundle).toBe("qa-consumed-context-bundle");
    expect(sent[0].sourceUserMessageId).toBe(sent[1].sourceUserMessageId);
    expect(sent[1].contextBundle).toBe("qa-fresh-context-bundle");
    expect(await persistentProviderStreamCount(page)).toBe(1);
  });

  test("reload adopts a durable partial and passively polls to terminal without resubmitting", async ({ page }) => {
    const state = await openChat(page);
    const active = {
      assistantMessageId: "durable-assistant-1",
      conversationId: CONVERSATION,
      sourceUserMessageId: "seed-u",
      requestedModelId: MODEL_A,
      actualModelId: MODEL_A,
      provider: "openai",
      status: "streaming",
      partialContent: "Checkpoint before reload.",
      checkpointRevision: 2,
      finishReason: null,
      failureCode: null,
      terminalAt: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:02.000Z",
    };
    state.setResponseAttempts([active]);
    await page.reload();
    await expect(message(page, "Checkpoint before reload.")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    await expect.poll(state.attemptReadCount).toBeGreaterThan(0);

    state.setResponseAttempts([{
      ...active,
      status: "completed",
      partialContent: "Checkpoint before reload. Final suffix.",
      checkpointRevision: 3,
      finishReason: "stop",
      terminalAt: "2026-09-13T00:00:03.000Z",
      updatedAt: "2026-09-13T00:00:03.000Z",
    }]);
    await expect(message(page, "Final suffix.")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("reload does not render an empty pre-dispatch request refusal as an assistant message", async ({ page }) => {
    const state = await openChat(page);
    state.setResponseAttempts([{
      assistantMessageId: "refused-before-dispatch",
      conversationId: CONVERSATION,
      sourceUserMessageId: "seed-u",
      requestedModelId: MODEL_A,
      actualModelId: null,
      provider: null,
      status: "failed",
      partialContent: "",
      checkpointRevision: 0,
      finishReason: "error",
      failureCode: "request_refused",
      terminalAt: "2026-09-13T00:00:01.000Z",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:01.000Z",
    }]);

    await page.reload();
    await expect(page.locator(
      '[data-testid="chat-message"][data-message-role="assistant"]'
    )).toHaveCount(1);
    await expect(message(page, FIRST_ANSWER)).toBeVisible();
    await expect(page.getByTestId("chat-recovery-notice")).toHaveCount(0);
    expect(state.attemptReadCount()).toBe(0);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("conversation recovery keeps polling an active attempt after the selected model changes", async ({ page }) => {
    const state = await openChat(page, { selectedModels: [MODEL_B] });
    const active = {
      assistantMessageId: "durable-prior-model",
      conversationId: CONVERSATION,
      sourceUserMessageId: "seed-u",
      requestedModelId: MODEL_A,
      actualModelId: MODEL_A,
      provider: "openai",
      status: "streaming",
      partialContent: "The prior model is still answering.",
      checkpointRevision: 1,
      finishReason: null,
      failureCode: null,
      terminalAt: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:01.000Z",
    };
    state.setResponseAttempts([active]);
    await page.reload();
    await expect(message(page, "The prior model is still answering.")).toBeVisible();
    await expect.poll(state.attemptReadCount).toBeGreaterThan(0);
    state.setResponseAttempts([{
      ...active,
      status: "completed",
      partialContent: "The prior model finished after the switch.",
      checkpointRevision: 2,
      finishReason: "stop",
      terminalAt: "2026-09-13T00:00:02.000Z",
      updatedAt: "2026-09-13T00:00:02.000Z",
    }]);
    await expect(message(page, "The prior model finished after the switch.")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a terminal attempt lookup refusal releases the composer without a provider resend", async ({ page }) => {
    const state = await openChat(page);
    state.setResponseAttempts([{
      assistantMessageId: "durable-forbidden-poll",
      conversationId: CONVERSATION,
      sourceUserMessageId: "seed-u",
      requestedModelId: MODEL_A,
      actualModelId: MODEL_A,
      provider: "openai",
      status: "streaming",
      partialContent: "Keep this last authorized checkpoint.",
      checkpointRevision: 1,
      finishReason: null,
      failureCode: null,
      terminalAt: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:01.000Z",
    }]);
    state.setAttemptPollFailures([{ status: 404 }]);
    await page.reload();
    await expect(message(page, "Keep this last authorized checkpoint.")).toBeVisible();
    await expect(page.getByTestId("chat-recovery-notice")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a 429 attempt poll honors retry and later reaches terminal without resending", async ({ page }) => {
    const state = await openChat(page);
    const active = {
      assistantMessageId: "durable-rate-limited-poll",
      conversationId: CONVERSATION,
      sourceUserMessageId: "seed-u",
      requestedModelId: MODEL_A,
      actualModelId: MODEL_A,
      provider: "openai",
      status: "streaming",
      partialContent: "Checkpoint before a poll throttle.",
      checkpointRevision: 1,
      finishReason: null,
      failureCode: null,
      terminalAt: null,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:01.000Z",
    };
    state.setResponseAttempts([active]);
    state.setAttemptPollFailures([{ status: 429, retryAfter: "0" }]);
    await page.reload();
    await expect.poll(state.attemptReadCount).toBeGreaterThan(0);
    state.setResponseAttempts([{
      ...active,
      status: "completed",
      partialContent: "Completed after the bounded poll retry.",
      checkpointRevision: 2,
      finishReason: "stop",
      terminalAt: "2026-09-13T00:00:03.000Z",
      updatedAt: "2026-09-13T00:00:03.000Z",
    }]);
    await expect.poll(state.attemptReadCount).toBeGreaterThan(1);
    await expect(message(page, "Completed after the bounded poll retry.")).toBeVisible();
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("an expired worker keeps its committed prefix and surfaces a terminal recovery", async ({ page }) => {
    const state = await openChat(page);
    state.setResponseAttempts([{
      assistantMessageId: "durable-assistant-expired",
      conversationId: CONVERSATION,
      sourceUserMessageId: "seed-u",
      requestedModelId: MODEL_A,
      actualModelId: MODEL_A,
      provider: "openai",
      status: "failed",
      partialContent: "Useful committed prefix.",
      checkpointRevision: 4,
      finishReason: "error",
      failureCode: "worker_lease_expired",
      terminalAt: "2026-09-13T00:05:00.000Z",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:05:00.000Z",
    }]);
    await page.reload();
    await expect(message(page, "Useful committed prefix.")).toBeVisible();
    await expect(page.getByTestId("chat-recovery-notice")).toBeVisible();
    expect(state.attemptReadCount()).toBe(0);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("new Chat is gated while legacy Review keeps its existing route", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    const response = await page.goto("/chat/workspace?lang=en");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("chat-textarea")).toHaveCount(0);
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
  });

  test("legacy Review keeps sending a text-only turn when best-effort message save fails", async ({ page }) => {
    await openChat(page, { legacyReview: true, messageSaveFailure: true });
    await page.getByTestId("chat-textarea").fill("Review must retain its non-durable behavior.");
    await page.getByTestId("chat-send-button").click();
    await drive(page, 0, "push", "Review provider response.");
    await drive(page, 0, "finish");
    await expect(message(page, "Review provider response.")).toBeVisible();
    expect(await persistentChatPostCount(page)).toBe(1);
  });

  test("legacy Review keeps its composer single-flight while a provider response is active", async ({ page }) => {
    await openChat(page, { legacyReview: true });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("Only one Review turn may be active.");
    await page.getByTestId("chat-send-button").click();

    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await expect(textarea).toBeDisabled();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    expect(await requests(page)).toHaveLength(1);
    expect(await persistentChatPostCount(page)).toBe(1);

    await drive(page, 0, "finish");
    await expect(textarea).toBeEnabled();
  });

  test("authenticated Chat can compose a successor draft without submitting it during a stream", async ({ page }) => {
    const state = await openChat(page);
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("The accepted turn starts one stream.");
    await page.getByTestId("chat-send-button").click();

    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await expect(textarea).toBeEnabled();
    await textarea.fill("This is the next durable draft, not a second request.");
    await expect.poll(() => state.drafts.get(CONVERSATION)?.text).toBe(
      "This is the next durable draft, not a second request."
    );
    expect(await requests(page)).toHaveLength(1);

    await drive(page, 0, "finish");
  });

  test("a fresh Chat creates the Chat product and sends exactly one answer request", async ({ page }) => {
    const state = await openChat(page, { fresh: true });
    await submitComposer(page, "Create one new Chat answer.", DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "One answer only.");
    await drive(page, 0, "finish");
    await expect(message(page, "One answer only.")).toBeVisible();
    const calls = await requests(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].conversationId).toBe("qa-chat-created");
    const createPaths = ["/api/conversations", "/api/products/chat/conversations", "/api/products/review/conversations"];
    const creates = state.writes.filter((write) => write.method === "POST" && createPaths.includes(write.path));
    expect(creates.map((write) => write.path)).toEqual(["/api/products/chat/conversations"]);
    expect(creates[0].body).not.toHaveProperty("productKey");
    expect(creates[0].body.selectedModels).toHaveLength(1);
  });

  test("a failed first Message save retries the same created Chat and never copies or deletes the new-scope draft", async ({ page }) => {
    const state = await openChat(page, {
      fresh: true,
      messageSaveFailureOnce: true,
      messageSaveFailureStatus: 409,
    });
    const prompt = "Retry this exact new-scope draft after the network refusal.";
    await page.getByTestId("chat-textarea").fill(prompt);
    await expect.poll(() => state.drafts.get("new")?.revision ?? 0).toBeGreaterThan(0);
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText(
      "The question could not be saved with its files. Your draft has been kept.",
      { exact: true }
    )).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await persistentChatPostCount(page)).toBe(0);

    const draftWritesAfterFailure = state.writes.filter((write) =>
      write.path.includes("/api/products/chat/drafts/")
    );
    expect(draftWritesAfterFailure.some((write) =>
      write.path.endsWith("/drafts/qa-chat-created") || write.method === "DELETE"
    )).toBe(false);
    expect(state.drafts.has("new")).toBe(true);
    expect(state.drafts.has("qa-chat-created")).toBe(false);

    await page.getByTestId("chat-send-button").click();
    await drive(page, 0, "push", "One answer after the Message retry.");
    await drive(page, 0, "finish");
    await expect(message(page, "One answer after the Message retry.")).toBeVisible();

    const creates = state.writes.filter((write) =>
      write.method === "POST" && write.path === "/api/products/chat/conversations"
    );
    expect(creates).toHaveLength(1);
    const messageWrites = state.writes.filter((write) =>
      write.method === "POST" && write.path === "/api/conversations/qa-chat-created/messages"
    );
    expect(messageWrites).toHaveLength(2);
    expect((messageWrites[1]?.body.draftConsume as { scopeKey?: string })?.scopeKey).toBe("new");
    expect(state.drafts.has("new")).toBe(false);
    expect(state.drafts.has("qa-chat-created")).toBe(false);
    expect(await persistentProviderStreamCount(page)).toBe(1);
  });

  test("a late Chat create response cannot adopt itself after navigation to another conversation", async ({ page }) => {
    await openChat(page, { fresh: true });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route("**/api/products/chat/conversations", async (route) => {
      held = true;
      await gate;
      await route.fallback();
    });
    await submitComposer(page, "The abandoned new-Chat question.", DESKTOP_VIEWPORT.width);
    await expect.poll(() => held).toBe(true);
    await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${SECOND_CONVERSATION}"]`).click();
    await expect(message(page, SECOND_ANSWER)).toBeVisible();
    const laterDraft = "Keep this draft in the second conversation.";
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    release();
    await expect(page.getByText("The conversation or model changed while preparing the answer. Check your question and send again.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    await page.getByTestId("chat-textarea").fill(laterDraft);
    await expect(page).toHaveURL(new RegExp(`conversation=${SECOND_CONVERSATION}`));
    await expect(message(page, SECOND_ANSWER)).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(laterDraft);
    expect(await requests(page)).toHaveLength(0);
  });

  test("New Chat from a still-null conversation invalidates an earlier pending create", async ({ page }) => {
    await openChat(page, { fresh: true });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route("**/api/products/chat/conversations", async (route) => {
      held = true;
      await gate;
      await route.fallback();
    });
    await submitComposer(page, "Earlier fresh Chat question that is now abandoned.", DESKTOP_VIEWPORT.width);
    await expect.poll(() => held).toBe(true);
    await page.getByTestId("sidebar-new-chat").click();
    const nextDraft = "New blank Chat draft that must remain untouched.";
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    expect(new URL(page.url()).searchParams.get("conversation")).toBeNull();
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/products/chat/conversations");
    release();
    await response;
    // Previously this exact null -> null reset sent the abandoned question.
    // No provider runs; the fixture records any answer-fetch attempt locally.
    await expect(page.getByText("The conversation or model changed while preparing the answer. Check your question and send again.", { exact: true })).toBeVisible();
    expect(await requests(page)).toHaveLength(0);
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    await page.getByTestId("chat-textarea").fill(nextDraft);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(nextDraft);
    expect(new URL(page.url()).searchParams.get("conversation")).toBeNull();
  });

  for (const entry of ["fresh", "fresh new-account", "New Chat"] as const) {
    test(`multi-model account defaults keep their settings while ${entry} uses one local Chat model`, async ({ page }) => {
      const accountDefaults = [MODEL_A, MODEL_B];
      const state = await openChat(page, { accountDefaults, fresh: entry !== "New Chat", newAccount: entry === "fresh new-account" });
      if (entry === "New Chat") await page.getByTestId("sidebar-new-chat").click();
      await expect(page.getByTestId("chat-single-model-notice")).toHaveCount(0);
      await submitComposer(page, "Send with one Chat-local default model.", DESKTOP_VIEWPORT.width);
      await drive(page, 0, "push", "A single default answer.");
      await drive(page, 0, "finish");
      expect(await requests(page)).toHaveLength(1);
      expect(state.writes.filter((write) => write.path === "/api/products/chat/conversations").map((write) => write.body.selectedModels)).toEqual([[MODEL_A]]);
      expect(state.userSettingsWrites).toEqual([]);
      expect(accountDefaults).toEqual([MODEL_A, MODEL_B]);
    });
  }

  test("an existing multi-model Chat keeps its stored selection and refuses silent collapse", async ({ page }) => {
    const state = await openChat(page, { selectedModels: [MODEL_A, MODEL_B] });
    await expect(page.getByTestId("chat-single-model-notice")).toBeVisible();
    await page.getByTestId("chat-textarea").fill("Do not silently rewrite this saved selection.");
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    expect(state.conversations[0].selectedModels).toEqual([MODEL_A, MODEL_B]);
    expect(state.writes.filter((write) => write.method === "PATCH")).toEqual([]);
    expect(await requests(page)).toHaveLength(0);
  });

  test("A-to-B selection keeps all answers and includes A's answer in B's request context", async ({ page }) => {
    const state = await openChat(page);
    await expect(message(page, FIRST_ANSWER)).toBeVisible();
    await chooseModel(page, MODEL_B);
    await expect(message(page, FIRST_ANSWER)).toBeVisible();
    await expect(page.getByTestId("chat-message-list")).toHaveCount(1);
    await submitComposer(page, "Continue the prior answer with model B.", DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "The new answer is from B.");
    await drive(page, 0, "finish");
    await expect(message(page, "The new answer is from B.")).toHaveAttribute("data-model-id", MODEL_B);
    await expect(message(page, FIRST_ANSWER)).toHaveAttribute("data-model-id", MODEL_A);
    const calls = await requests(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].modelId).toBe(MODEL_B);
    expect(JSON.stringify(calls[0].messages)).toContain(FIRST_ANSWER);
    expect(state.historyReads.length).toBeGreaterThan(0);
    expect(state.historyReads.every((url) => !new URL(url, "http://local").searchParams.has("modelId"))).toBe(true);
  });

  test("a saved paused selection leaves its existing transcript readable without sending", async ({ page }) => {
    await openChat(page, { disabledPanels: [MODEL_A] });
    await expect(message(page, FIRST_ANSWER)).toBeVisible();
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    expect(await requests(page)).toHaveLength(0);
  });

  test("changing selection during a stream retains its attribution and stop ownership", async ({ page }) => {
    await openChat(page);
    await submitComposer(page, "Keep this A stream open.", DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "A partial before model switch.");
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    await chooseModel(page, MODEL_B);
    await drive(page, 0, "push", " A partial after model switch.");
    await expect(message(page, "A partial before model switch.")).toContainText("A partial after model switch.");
    await expect(message(page, "A partial before model switch.")).toHaveAttribute("data-model-id", MODEL_A);
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    await page.getByTestId("stop-this-response").click();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __unifiedChatControls: Array<{ aborted: boolean }> }).__unifiedChatControls[0].aborted)).toBe(true);
    expect(await requests(page)).toHaveLength(1);
  });

  for (const heldEndpoint of ["context", "message-save"] as const) {
    test(heldEndpoint === "context"
      ? "changing selection during context preparation retains the draft and sends only after explicit submit"
      : "a model change before a committed Message response removes the consumed draft without dispatch",
    async ({ page }) => {
      await openChat(page);
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      let blockNext = true;
      const path = heldEndpoint === "context"
        ? "**/api/chat/context"
        : `**/api/conversations/${CONVERSATION}/messages`;
      await page.route(path, async (route) => {
        if (route.request().method() === "POST" && blockNext) {
          blockNext = false;
          held = true;
          await gate;
        }
        await route.fallback();
      });
      const prompt = `Keep the original ${heldEndpoint} draft.`;
      await submitComposer(page, prompt, DESKTOP_VIEWPORT.width);
      await expect.poll(() => held).toBe(true);
      await chooseModel(page, MODEL_B);
      release();
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      expect(await requests(page)).toHaveLength(0);
      if (heldEndpoint === "context") {
        await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
        await expect(page.getByText("The conversation or model changed while preparing the answer. Check your question and send again.", { exact: true })).toBeVisible();
        await page.getByTestId("chat-send-button").click();
        await drive(page, 0, "push", "Only the explicitly resubmitted model B answer.");
        await drive(page, 0, "finish");
        expect(await requests(page)).toHaveLength(1);
        expect((await requests(page))[0].modelId).toBe(MODEL_B);
      } else {
        // The Message transaction completed after the model changed. Its
        // exact consumed snapshot must disappear even though the stale screen
        // is not allowed to dispatch or navigate.
        await expect(page.getByTestId("chat-textarea")).toHaveValue("");
        await expect(page.getByText("The conversation or model changed while preparing the answer. Check your question and send again.", { exact: true })).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId("chat-textarea")).toHaveValue("");
        expect(await requests(page)).toHaveLength(0);
      }
    });

    test(`the ${heldEndpoint} preparation lock prevents a crash-only successor until Message acceptance`, async ({ page }) => {
      const state = await openChat(page);
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      let blockNext = true;
      const path = heldEndpoint === "context"
        ? "**/api/chat/context"
        : `**/api/conversations/${CONVERSATION}/messages`;
      await page.route(path, async (route) => {
        if (route.request().method() === "POST" && blockNext) {
          blockNext = false;
          held = true;
          await gate;
        }
        await route.fallback();
      });
      const sentPrompt = "Submit this original question.";
      const nextDraft = "A newly edited next question, not yet submitted.";
      await submitComposer(page, sentPrompt, DESKTOP_VIEWPORT.width);
      await expect.poll(() => held).toBe(true);
      const textarea = page.getByTestId("chat-textarea");
      await expect(textarea).toHaveAttribute("readonly", "");
      await textarea.pressSequentially(nextDraft);
      await expect(textarea).toHaveValue(sentPrompt);
      release();
      await expect.poll(async () => (await requests(page)).length).toBe(1);
      await expect(textarea).not.toHaveAttribute("readonly", "");
      await expect(textarea).toBeEnabled();
      await expect(textarea).toHaveValue("");
      await textarea.fill(nextDraft);
      await expect.poll(() => state.drafts.get(CONVERSATION)?.text).toBe(nextDraft);
      const lastDraftPut = state.writes.filter((write) =>
        write.method === "PUT" && write.path.endsWith(`/drafts/${CONVERSATION}`)
      ).at(-1);
      expect(lastDraftPut?.body).toMatchObject({
        expectedRevision: 0,
        text: nextDraft,
      });
      expect(await requests(page)).toHaveLength(1);
      expect(JSON.stringify((await requests(page))[0].messages)).toContain(sentPrompt);

      // Reload is the crash boundary. The successor could only be created
      // after Message acceptance, when revision zero persistence was active.
      await page.reload();
      await expect(page.getByTestId("chat-textarea")).toHaveValue(nextDraft);
      expect(await requests(page)).toHaveLength(0);
      await page.getByTestId("chat-send-button").click();
      await drive(page, 0, "push", "Answering only the explicitly resubmitted question.");
      await drive(page, 0, "finish");
      const calls = await requests(page);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0].messages)).toContain(nextDraft);
    });
  }

  test("a routed header and fallback signal name the actual author, never the current selection", async ({ page }) => {
    const fallbackModel = "gpt-5-6-terra";
    await openChat(page, { routedModelId: MODEL_B });
    await submitComposer(page, "An answer with a routed then fallback author.", DESKTOP_VIEWPORT.width);
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    const reply = page.locator('[data-testid="chat-message"][data-message-role="assistant"]').last();
    await expect(reply).toHaveAttribute("data-model-id", MODEL_B);
    await chooseModel(page, MODEL_B);
    await drive(page, 0, "push", buildRoutingRetryChunk(fallbackModel));
    await drive(page, 0, "push", "The fallback model wrote this answer.");
    await drive(page, 0, "finish");
    await expect(message(page, "The fallback model wrote this answer.")).toHaveAttribute("data-model-id", fallbackModel);
    await expect(message(page, "The fallback model wrote this answer.").getByTestId("auto-routed-by")).toHaveCount(0);
    expect((await requests(page))[0].modelId).toBe(MODEL_A);
    expect(await requests(page)).toHaveLength(1);
  });

  test("transport failure keeps partial text and restoration does not send until explicit submit", async ({ page }, testInfo) => {
    await openChat(page);
    const prompt = "The exact interrupted question.";
    await submitComposer(page, prompt, DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "Partial text must not become an error title.");
    await expect(message(page, "Partial text must not become an error title.")).toBeVisible();
    await drive(page, 0, "fail");
    await expect(page.getByTestId("chat-recovery-notice")).toBeVisible();
    await expect(message(page, "Partial text must not become an error title.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("chat-desktop-partial-recovery.png"), fullPage: true });
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await requests(page)).toHaveLength(1);
    await page.getByTestId("chat-send-button").click();
    await drive(page, 1, "push", "Explicit new attempt.");
    await drive(page, 1, "finish");
    await expect(message(page, "Explicit new attempt.")).toBeVisible();
    expect(await requests(page)).toHaveLength(2);
  });

  test("a failure before the first chunk is recoverable without an empty assistant in the next request", async ({ page }) => {
    await openChat(page);
    const prompt = "A failed-before-first-chunk question.";
    await submitComposer(page, prompt, DESKTOP_VIEWPORT.width);
    await drive(page, 0, "fail");
    await expect(page.getByTestId("chat-recovery-notice")).toBeVisible();
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await requests(page)).toHaveLength(1);
    await page.getByTestId("chat-send-button").click();
    await drive(page, 1, "push", "The explicit restored send succeeded.");
    await drive(page, 1, "finish");
    const second = (await requests(page))[1];
    const emptyAssistants = second.messages?.filter((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim() === "");
    expect(emptyAssistants).toEqual([]);
    expect(JSON.stringify(second.messages)).toContain(prompt);
    expect(await requests(page)).toHaveLength(2);
  });

  for (const errorCode of ["MODEL_RETIRED", "CREDIT_BALANCE_INSUFFICIENT"] as const) {
    test(`${errorCode} recovery returns focus to its button after an unfocused nested click and keyboard activation`, async ({ page }, testInfo) => {
      const viewport = testInfo.project.name === "mobile-chromium" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      const state = await openChat(page, { responseErrorCode: errorCode, viewport });
      await submitComposer(page, "Keep the transcript unchanged when I close recovery model selection.", viewport.width);
      const recoveryButton = page.getByRole("button", { name: "Choose another model", exact: true });
      await expect(recoveryButton).toBeVisible();
      const textarea = page.getByTestId("chat-textarea");
      await expect(textarea).toBeEnabled();
      const transcript = await page.getByTestId("chat-message").allTextContents();
      const writesBeforeOpen = [...state.writes];
      const picker = page.locator("#chat-input-popover");

      // dispatchEvent deliberately omits the browser's default click focus.
      // This reproduces the relevant event condition, NOT a Safari/macOS run.
      // The icon is the target; the recovery button must remain currentTarget.
      await textarea.focus();
      await expect(textarea).toBeFocused();
      await recoveryButton.locator("svg path").first().dispatchEvent("click");
      await expect(picker).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(recoveryButton).toBeFocused();

      // Normal keyboard activation must keep the same focus-return contract.
      await recoveryButton.press("Enter");
      await expect(picker).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(recoveryButton).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`conversation=${CONVERSATION}`));
      expect(state.conversations[0].selectedModels).toEqual([MODEL_A]);
      expect(await page.getByTestId("chat-message").allTextContents()).toEqual(transcript);
      expect(state.writes).toEqual(writesBeforeOpen);
      expect(state.writes.filter((write) => write.method === "DELETE")).toEqual([]);
      expect(await requests(page)).toHaveLength(1);
    });

    test(`${errorCode} recovery opens the model picker and changes selection without deleting history or resending`, async ({ page }, testInfo) => {
      const viewport = testInfo.project.name === "mobile-chromium" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
      const state = await openChat(page, { responseErrorCode: errorCode, viewport });
      await submitComposer(page, "Keep this refused question while I choose another model.", viewport.width);
      const recoveryButton = page.getByRole("button", { name: "Choose another model", exact: true });
      await expect(recoveryButton).toBeVisible();
      await expect(message(page, FIRST_ANSWER)).toBeVisible();
      const transcript = await page.getByTestId("chat-message").allTextContents();
      expect(await requests(page)).toHaveLength(1);
      await recoveryButton.click();
      const picker = page.locator("#chat-input-popover");
      // Do not use the general picker-opening helper here: that would conceal
      // an inert recovery button by independently opening the normal trigger.
      await expect(picker).toBeVisible();
      await picker.getByTestId("model-picker-open-all").click();
      await picker.locator(`[data-testid="model-option"][data-model-id="${MODEL_B}"]`).click();
      await expect(picker.getByTestId("selected-model-chip")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect.poll(() => state.conversations[0].selectedModels).toEqual([MODEL_B]);
      await expect(page).toHaveURL(new RegExp(`conversation=${CONVERSATION}`));
      expect(await page.getByTestId("chat-message").allTextContents()).toEqual(transcript);
      expect(state.writes.filter((write) => write.method === "DELETE")).toEqual([]);
      expect(await requests(page)).toHaveLength(1);
    });
  }

  test("reload is GET-only and restores the selected failed question, not the newest question", async ({ page }) => {
    const olderPrompt = "The older failed question that must be restored.";
    const newerPrompt = "A later successful and unrelated question.";
    const state = await openChat(page, { messages: [
      { id: "old-u", role: "user", content: olderPrompt },
      { id: "old-a", role: "assistant", content: "Saved failed answer.", modelId: MODEL_A, status: "error" },
      { id: "new-u", role: "user", content: newerPrompt },
      { id: "new-a", role: "assistant", content: "Saved successful answer.", modelId: MODEL_B, status: "normal" },
    ] });
    const writesBeforeReload = state.writes.length;
    await page.reload();
    await expect(message(page, "Saved successful answer.")).toBeVisible();
    await page.waitForTimeout(500);
    expect(await requests(page)).toHaveLength(0);
    expect(state.writes.slice(writesBeforeReload)).toEqual([]);
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(olderPrompt);
    expect(await requests(page)).toHaveLength(0);
  });

  test("a saved user-only interruption restores its draft without claiming a failed answer", async ({ page }) => {
    const prompt = "A saved question with no persisted answer yet.";
    await openChat(page, { messages: [{ id: "pending-u", role: "user", content: prompt }] });
    await page.reload();
    await expect(message(page, prompt)).toBeVisible();
    await expect(page.locator('[data-testid="chat-message"][data-message-role="assistant"]')).toHaveCount(0);
    expect(await requests(page)).toHaveLength(0);
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await requests(page)).toHaveLength(0);
  });

  test("leaving and re-entering the same in-memory Chat reuses its live partial stream", async ({ page }) => {
    await openChat(page);
    await submitComposer(page, "An in-memory stream to revisit.", DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "Partial before leaving.");
    await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${SECOND_CONVERSATION}"]`).click();
    await expect(message(page, SECOND_ANSWER)).toBeVisible();
    await expect(message(page, "Partial before leaving.")).toHaveCount(0);
    await drive(page, 0, "push", " More while away.");
    await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${CONVERSATION}"]`).click();
    await expect(message(page, "Partial before leaving.")).toContainText("More while away.");
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    await drive(page, 0, "finish");
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await requests(page)).toHaveLength(1);
  });

  test("an account change drops the previous identity's transcript and aborts its stream", async ({ page }) => {
    const state = await openChat(page);
    await submitComposer(page, "Private question from account A.", DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "Private partial from account A.");
    state.hidePreviousAccount();
    await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
      user: { id: "qa-user-b", name: "QA B", email: "qa-b@example.test" },
      expires: "2099-01-01T00:00:00.000Z",
    } }));
    // NextAuth's existing visibility-change session refresh; no production
    // authentication is bypassed by this browser-only fabricated session.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(message(page, "Private partial from account A.")).toHaveCount(0);
    await expect(message(page, FIRST_ANSWER)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __unifiedChatControls: Array<{ aborted: boolean }> }).__unifiedChatControls[0].aborted)).toBe(true);
    await drive(page, 0, "push", "Late private chunk after sign-in change.");
    await expect(message(page, "Late private chunk after sign-in change.")).toHaveCount(0);
    expect(await requests(page)).toHaveLength(1);
  });

  test("an account change never exposes the previous account's unsent draft", async ({ page }) => {
    const state = await openChat(page);
    const privateDraft = "Account A unsent private draft.";
    await page.getByTestId("chat-textarea").fill(privateDraft);
    await expect.poll(() => state.drafts.get(CONVERSATION)?.text).toBe(privateDraft);

    state.hidePreviousAccount();
    await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
      user: { id: "qa-user-b", name: "QA B", email: "qa-b@example.test" },
      expires: "2099-01-01T00:00:00.000Z",
    } }));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(message(page, FIRST_ANSWER)).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    await expect(page.getByText(privateDraft, { exact: true })).toHaveCount(0);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("an account switch cancels the previous identity's pending draft debounce", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, { viewport });
    const privateDraft = "Account A debounce must never run with account B authority.";
    await page.getByTestId("chat-textarea").fill(privateDraft);
    await switchToFixtureAccountB(page, state);
    await page.waitForTimeout(700);

    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    expect(state.writes.filter((write) =>
      write.method === "PUT" && write.body.text === privateDraft
    )).toEqual([]);
    expect(await persistentChatPostCount(page)).toBe(0);

    await switchToFixtureAccountA(page, state);
    await chooseConversation(page, CONVERSATION);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(privateDraft);
    await expect.poll(() => state.drafts.get(CONVERSATION)?.text).toBe(privateDraft);
    await page.reload();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(privateDraft);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a committed first Message cannot resurrect its consumed draft across A-to-B-to-A before the response", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, { fresh: true, viewport });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route("**/api/conversations/qa-chat-created/messages", async (route) => {
      if (route.request().method() === "POST") {
        const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
        state.writes.push({
          method: "POST",
          path: "/api/conversations/qa-chat-created/messages",
          body,
        });
        // The database transaction has committed. Only delivery of the HTTP
        // response is delayed, which is the crash window this test owns.
        state.drafts.delete("new");
        held = true;
        await gate;
        await route.fulfill({
          status: 201,
          json: {
            success: true,
            created: 1,
            attachments: [],
            draftConsumed: true,
            messageMappings: [{
              requestId: ((body.messages as Array<{ clientRequestId: string }>)[0]).clientRequestId,
              messageId: qaMessageId("qa-chat-created", ((body.messages as Array<{ clientRequestId: string }>)[0]).clientRequestId),
            }],
          },
        });
        return;
      }
      await route.fallback();
    });
    const privateDraft = "Account A pending Message must not migrate into account B.";
    await submitComposer(page, privateDraft, viewport.width);
    await expect.poll(() => held).toBe(true);
    await switchToFixtureAccountB(page, state);
    await switchToFixtureAccountA(page, state);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(privateDraft);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    const writesAtSwitch = state.writes.length;
    await page.waitForTimeout(700);
    expect(state.writes.slice(writesAtSwitch).filter((write) =>
      write.method === "PUT" && write.path.endsWith("/drafts/new")
    )).toEqual([]);
    release();
    await page.waitForTimeout(700);

    await expect(page).not.toHaveURL(/conversation=qa-chat-created/);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    expect(await requests(page)).toHaveLength(0);
    expect(state.writes.slice(writesAtSwitch).filter((write) =>
      write.path.includes("/api/products/chat/drafts/")
    )).toEqual([]);

    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
    expect(state.drafts.has("new")).toBe(false);
    await page.reload();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    await expect(page.getByTestId("draft-conflict-dialog")).toHaveCount(0);
  });

  test("account B can own a submit while A is pending and A's stale finally cannot unlock B", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, { viewport });
    let releaseA = () => {};
    let releaseB = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    let heldA = false;
    let heldB = false;
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/conversations/${CONVERSATION}/messages`) {
        const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
        state.writes.push({ method: "POST", path, body });
        state.drafts.delete(CONVERSATION);
        heldA = true;
        await gateA;
        return route.fulfill({
          status: 201,
          json: {
            success: true,
            created: 1,
            attachments: [],
            draftConsumed: true,
            messageMappings: [{
              requestId: (((body as { messages: Array<{ clientRequestId: string }> }).messages)[0]).clientRequestId,
              messageId: qaMessageId(CONVERSATION, (((body as { messages: Array<{ clientRequestId: string }> }).messages)[0]).clientRequestId),
            }],
          },
        });
      }
      if (path === "/api/conversations/qa-chat-created-b/messages") {
        heldB = true;
        await gateB;
      }
      return route.fallback();
    });

    await submitComposer(page, "Account A pending submit.", viewport.width);
    await expect.poll(() => heldA).toBe(true);
    await switchToFixtureAccountB(page, state);
    const bDraft = "Account B owns an independent submit.";
    await page.getByTestId("chat-textarea").fill(bDraft);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();
    await expect.poll(() => heldB).toBe(true);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");

    releaseA();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    await expect(page.getByTestId("chat-textarea")).toHaveValue(bDraft);
    expect(await requests(page)).toHaveLength(0);

    releaseB();
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    expect(JSON.stringify((await requests(page))[0].messages)).toContain(bDraft);
  });

  test("a stale preparation from the first A epoch cannot unfreeze or save the A draft after A-to-B-to-A", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, { viewport });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route("**/api/chat/context", async (route) => {
      if (route.request().method() === "POST") {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    const prompt = "The returning A epoch keeps this exact draft.";
    await submitComposer(page, prompt, viewport.width);
    await expect.poll(() => held).toBe(true);
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");

    await switchToFixtureAccountB(page, state);
    await switchToFixtureAccountA(page, state);
    await chooseConversation(page, CONVERSATION);
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    release();
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    // The detached A continuation is intentionally silent as well as
    // mutation-free. A toast from that continuation could overwrite feedback
    // owned by the current A epoch just as surely as a stale draft write.
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await requests(page)).toHaveLength(0);

    await page.getByTestId("chat-textarea").fill(`${prompt} Still current.`);
    await expect.poll(() => state.drafts.get(CONVERSATION)?.text).toBe(`${prompt} Still current.`);
    await page.reload();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(`${prompt} Still current.`);
    expect(await persistentChatPostCount(page)).toBe(0);
  });

  test("a same-account conversation switch during first Message persistence remains selected", async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.includes("mobile")
      ? MOBILE_VIEWPORT
      : DESKTOP_VIEWPORT;
    const state = await openChat(page, { fresh: true, viewport });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    await page.route("**/api/conversations/qa-chat-created/messages", async (route) => {
      if (route.request().method() === "POST") {
        held = true;
        await gate;
      }
      await route.fallback();
    });
    await submitComposer(page, "A pending first turn must not reclaim the screen.", viewport.width);
    await expect.poll(() => held).toBe(true);
    await chooseConversation(page, SECOND_CONVERSATION);
    const secondDraft = "The explicitly selected conversation keeps this draft.";
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
    release();
    await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
    await page.getByTestId("chat-textarea").fill(secondDraft);
    await page.waitForTimeout(700);

    await expect(page).toHaveURL(new RegExp(`conversation=${SECOND_CONVERSATION}`));
    await expect(message(page, SECOND_ANSWER)).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(secondDraft);
    expect(await requests(page)).toHaveLength(0);
    expect(state.drafts.get(SECOND_CONVERSATION)?.text).toBe(secondDraft);
  });

  test("a restored attached question sends ordered references and keeps both turns' file cards after reload", async ({ page }) => {
    const attachment = {
      id: "qa-original-attachment", attachmentId: "qa-original-attachment", ordinal: 0,
      name: "recovered-question.pdf", mediaType: "application/pdf", size: 1024, kind: "file" as const,
    };
    const secondAttachment = {
      id: "qa-second-attachment", attachmentId: "qa-second-attachment", ordinal: 1,
      name: "recovered-notes.txt", mediaType: "text/plain", size: 128, kind: "file" as const,
    };
    const prompt = "Please inspect this restored attachment.";
    const state = await openChat(page, { messages: [
      { id: "attached-user", role: "user", content: prompt, attachments: [attachment, secondAttachment] },
      { id: "attached-error", role: "assistant", content: "", modelId: MODEL_A, status: "error" },
    ] });
    await expect(page.getByTestId("chat-attachment-card")).toHaveCount(2);
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("attachment-complete")).toHaveCount(2);
    await expect(page.getByTestId("attachment-complete").first()).toContainText(attachment.name);
    expect(await requests(page)).toHaveLength(0);
    await page.getByTestId("chat-send-button").click();
    await drive(page, 0, "push", "Restored attachment answered.");
    await drive(page, 0, "finish");
    await expect(message(page, "Restored attachment answered.")).toBeVisible();
    const savedUser = state.writes.flatMap((write) => (
      write.method === "POST" && write.path.endsWith("/messages")
        ? (write.body.messages ?? []) as Array<Record<string, unknown>> : []
    )).find((saved) => saved.role === "user" && saved.clientRequestId)!;
    expect(savedUser.attachmentReferences).toEqual([{ attachmentId: attachment.id }, { attachmentId: secondAttachment.id }]);
    expect(savedUser).not.toHaveProperty("attachmentUploadIds");
    const rebound = state.conversations[0].messages.find((saved) =>
      saved.role === "user" && saved.content === savedUser.content && saved.id !== "attached-user"
    )!.attachments!;
    expect(rebound.map((item) => item.name)).toEqual([attachment.name, secondAttachment.name]);
    expect(rebound[0].id).not.toBe(attachment.id);
    const sent = (await requests(page))[0];
    const userMessages = sent.messages?.filter((item) => item.role === "user") as Array<{
      content: string; attachments?: Array<{ attachmentId?: string; uploadId?: string }>;
    }>;
    expect(userMessages.at(-1)?.attachments?.map((item) => item.attachmentId)).toEqual(rebound.map((item) => item.id));
    expect(userMessages.at(-1)?.attachments?.every((item) => item.uploadId === undefined)).toBe(true);
    await page.reload();
    await expect(page.getByTestId("chat-attachment-card")).toHaveCount(4);
    await expect(page.getByTestId("chat-attachment-card").nth(2)).toContainText(attachment.name);
    await expect(page.getByTestId("chat-attachment-card").nth(3)).toContainText(secondAttachment.name);
    expect(await requests(page)).toHaveLength(0);
  });

  for (const failure of ["missing-file-410", "storage-503", "invalid-success-map"] as const) {
    test(`a restored attachment save ${failure} retains the question and file without sending an answer`, async ({ page }) => {
      const prompt = "Keep this attached question until it can be saved.";
      const attachment = {
        id: "qa-retained-attachment", attachmentId: "qa-retained-attachment", ordinal: 0,
        name: "retained-document.pdf", mediaType: "application/pdf", size: 1024, kind: "file" as const,
      };
      await openChat(page, { messages: [
        { id: "retained-u", role: "user", content: prompt, attachments: [attachment] },
        { id: "retained-a", role: "assistant", content: "", modelId: MODEL_A, status: "error" },
      ] });
      const savedBodies: Array<Record<string, unknown>> = [];
      await page.route(`**/api/conversations/${CONVERSATION}/messages`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const body = route.request().postDataJSON() as { messages: Array<Record<string, unknown>> };
        savedBodies.push(...body.messages);
        if (failure === "invalid-success-map") {
          const requestId = String(body.messages[0].clientRequestId);
          const messageId = qaMessageId(CONVERSATION, requestId);
          return route.fulfill({ status: 200, json: {
            success: true,
            created: 1,
            draftConsumed: true,
            messageMappings: [{ requestId, messageId }],
            attachments: [{ messageId, id: "qa-invalid-ordinal", ordinal: 8 }],
          } });
        }
        return route.fulfill({ status: failure === "missing-file-410" ? 410 : 503, json: {
          code: failure === "missing-file-410" ? "ATTACHMENT_UNAVAILABLE" : "ATTACHMENT_STORAGE_UNAVAILABLE",
        } });
      });
      await page.getByTestId("restore-chat-question").click();
      await page.getByTestId("chat-send-button").click();
      if (failure === "missing-file-410") {
        await expect(page.getByText(
          "This file is no longer stored and could not be read. Attach it again to continue.",
          { exact: true }
        )).toBeVisible();
        await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("readonly", "");
      } else {
        // An unmarked 5xx and a malformed 2xx are both total-state
        // ambiguity. Neither may turn an unchanged receipt into resend
        // authority.
        await expect(page.getByTestId("message-receipt-recovery-dialog")).toBeVisible();
        await expect(page.getByTestId("chat-textarea")).toHaveAttribute("readonly", "");
      }
      expect(savedBodies).toHaveLength(1);
      expect(savedBodies[0].attachmentReferences).toEqual([{ attachmentId: attachment.id }]);
      expect(await requests(page)).toHaveLength(0);
      await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
      await expect(page.getByTestId("attachment-complete")).toContainText(attachment.name);
      await expect(page.getByTestId("chat-attachment-card")).toHaveCount(1);
    });
  }

  for (const change of ["conversation", "account"] as const) {
    test(`a late unclassified conversation lookup cannot overwrite a newer ${change}`, async ({ page }) => {
      const state = await openChat(page, { unclassifiedThird: true });
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      await page.route(`**/api/conversations/${UNCLASSIFIED_CONVERSATION}`, async (route) => {
        // Snapshot the first identity's owned response before the later change.
        const detail = state.detail(UNCLASSIFIED_CONVERSATION);
        held = true;
        await gate;
        await route.fulfill({ json: detail });
      });
      await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${UNCLASSIFIED_CONVERSATION}"]`).click();
      await expect.poll(() => held).toBe(true);
      if (change === "conversation") {
        await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${SECOND_CONVERSATION}"]`).click();
        await expect(message(page, SECOND_ANSWER)).toBeVisible();
      } else {
        state.hidePreviousAccount();
        await page.route("**/api/auth/session**", (route) => route.fulfill({ json: {
          user: { id: "qa-user-b", name: "QA B", email: "qa-b@example.test" },
          expires: "2099-01-01T00:00:00.000Z",
        } }));
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect(message(page, FIRST_ANSWER)).toHaveCount(0);
      }
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/conversations/${UNCLASSIFIED_CONVERSATION}`);
      release();
      await response;
      await page.waitForTimeout(300);
      await expect(message(page, UNCLASSIFIED_ANSWER)).toHaveCount(0);
      if (change === "conversation") {
        await expect(message(page, SECOND_ANSWER)).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`conversation=${SECOND_CONVERSATION}`));
      } else await expect(message(page, FIRST_ANSWER)).toHaveCount(0);
      expect(await requests(page)).toHaveLength(0);
    });
  }

  for (const failure of ["server-500", "network-reject"] as const) {
    test(`an unclassified lookup ${failure} describes failure without claiming or creating a new conversation`, async ({ page }) => {
      const state = await openChat(page, { unclassifiedThird: true });
      await page.route(`**/api/conversations/${UNCLASSIFIED_CONVERSATION}`, async (route) => {
        if (failure === "network-reject") await route.abort("failed");
        else await route.fulfill({ status: 500, json: { error: "QA detail temporarily unavailable" } });
      });
      await page.locator(`[data-testid="sidebar-conversation-item"][data-conversation-id="${UNCLASSIFIED_CONVERSATION}"]`).click();
      await expect(page.getByText("This conversation could not be opened. Your current conversation has not changed.", { exact: true })).toBeVisible();
      await expect(page.getByText("This conversation cannot be opened with the current account, so a new conversation was safely started instead.", { exact: true })).toHaveCount(0);
      await expect(message(page, FIRST_ANSWER)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`conversation=${CONVERSATION}`));
      expect(state.writes.filter((write) => write.method === "POST")).toEqual([]);
      expect(await requests(page)).toHaveLength(0);
    });
  }
});

test.describe("Chat single-transcript mobile composer", { tag: "@ui-risk" }, () => {
  test.use({ hasTouch: true });
  for (const width of [320, 390]) {
    test(`${width}px and 200% text preserve the textarea row and Korean composition`, async ({ page }, testInfo) => {
      await openChat(page, { viewport: { ...MOBILE_VIEWPORT, width } });
      await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
      await expect(page.getByTestId("chat-message-list")).toHaveCount(1);
      const textarea = page.getByTestId("chat-textarea");
      for (const fontSize of [16, 32] as const) {
        await setRootFontSize(page, fontSize);
        await textarea.fill("");
        const before = await textarea.boundingBox();
        await textarea.focus();
        await textarea.dispatchEvent("compositionstart", { data: "" });
        await textarea.fill("한국어 조합");
        await textarea.dispatchEvent("compositionupdate", { data: "한국어 조합" });
        await textarea.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
        expect(await requests(page)).toHaveLength(0);
        const geometry = await textarea.evaluate((input) => {
          const textarea = input as HTMLTextAreaElement;
          const composer = textarea.closest<HTMLElement>('[data-testid="chat-input"]')!;
          const rect = textarea.getBoundingClientRect();
          const style = getComputedStyle(textarea);
          const px = (value: string) => Number.parseFloat(value) || 0;
          const cs = getComputedStyle(composer);
          const innerWidth = composer.getBoundingClientRect().width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth);
          const overlaps = [...composer.querySelectorAll<HTMLElement>("[data-testid]")].filter((node) => node !== textarea && !node.contains(textarea)).filter((node) => {
            const box = node.getBoundingClientRect();
            return Math.min(box.right, rect.right) > Math.max(box.left, rect.left) && Math.min(box.bottom, rect.bottom) > Math.max(box.top, rect.top);
          }).map((node) => node.dataset.testid);
          return {
            x: rect.x, width: rect.width, ratio: rect.width / innerWidth, height: rect.height,
            line: px(style.lineHeight) + px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth),
            overflow: composer.scrollWidth - composer.clientWidth,
            clipped: textarea.scrollHeight - textarea.clientHeight, scrollLeft: textarea.scrollLeft, overlaps,
          };
        });
        expect(geometry.ratio).toBeGreaterThanOrEqual(0.9);
        expect(geometry.height).toBeGreaterThanOrEqual(geometry.line - 0.5);
        expect(geometry.overlaps).toEqual([]);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.clipped).toBeLessThanOrEqual(1);
        expect(geometry.scrollLeft).toBe(0);
        expect(geometry.x).toBeCloseTo(before!.x, 0);
        expect(geometry.width).toBeCloseTo(before!.width, 0);
        await expectNoHorizontalOverflow(page);
        if (width === 390 && fontSize === 16) {
          await page.screenshot({ path: testInfo.outputPath("chat-mobile-390-transcript.png"), fullPage: true });
        }
        await textarea.dispatchEvent("compositionend", { data: "한국어 조합" });
      }
    });
  }
});
