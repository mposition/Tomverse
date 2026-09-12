import { expect, test, type Page } from "@playwright/test";
import { buildRoutingRetryChunk } from "../../lib/routingRetrySignal";
import {
  expectNoHorizontalOverflow,
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

function installControlledChatFetch(options: { routedModelId?: string } = {}) {
  const originalFetch = window.fetch.bind(window);
  const controls: Array<{
    request: RecordedRequest;
    push(text: string): void;
    finish(): void;
    fail(): void;
    aborted: boolean;
  }> = [];
  (window as unknown as { __unifiedChatControls: typeof controls }).__unifiedChatControls = controls;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "POST" || !/\/api\/chat($|\?)/.test(url)) {
      return originalFetch(input, init);
    }
    const request = JSON.parse(String(init?.body ?? "{}")) as RecordedRequest;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const encoder = new TextEncoder();
    const control = {
      request,
      push: (text: string) => { void text; },
      finish: () => {},
      fail: () => {},
      aborted: false,
    };
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

async function openChat(page: Page, options: {
  viewport?: { width: number; height: number };
  messages?: QaConversationMessage[];
  disabledPanels?: string[];
  unclassifiedThird?: boolean;
  fresh?: boolean;
  routedModelId?: string;
} = {}) {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { selectedModels: [MODEL_A] });
  await mockUserUsage(page, { plan: "Pro" });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await page.context().addCookies([{
    name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100",
  }]);
  const conversations: ConversationFixture[] = [{
    id: CONVERSATION, title: "QA unified Chat", selectedModels: [MODEL_A],
    productKey: "chat", surface: "chat",
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
  let visibleConversations = conversations;
  const payload = (row: ConversationFixture) => ({
    ...row, disabledPanels: options.disabledPanels ?? [], webSearchMode: "off", memoryMode: "inherit",
    selectionMode: "manual", autoSelection: { offered: false },
    assistantProfile: null, isLocked: false, shareEnabled: false, nextCursor: null,
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
        id: "qa-chat-created", title: "New Chat", productKey: "chat", surface: "chat",
        selectedModels: Array.isArray(body.selectedModels) ? body.selectedModels as string[] : [MODEL_A],
        messages: [],
      };
      conversations.push(created);
      return route.fulfill({ status: 201, json: payload(created) });
    }
    const row = visibleConversations.find((candidate) => path === `/api/conversations/${candidate.id}` || path === `/api/conversations/${candidate.id}/messages`);
    if (!row) return route.fulfill({ status: 404, json: { code: "CONVERSATION_NOT_FOUND" } });
    if (path.endsWith("/messages") && method === "POST") {
      for (const message of (body.messages ?? []) as QaConversationMessage[]) {
        if (!row.messages.some((saved) => saved.id === message.id)) row.messages.push(message);
      }
      return route.fulfill({ status: 201, json: { success: true, attachments: [] } });
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
  await page.route("**/api/chat/context", (route) => route.fulfill({
    json: { ok: true, contextBundle: null, memoryUsedCount: 0 },
  }));
  await page.addInitScript(installControlledChatFetch, { routedModelId: options.routedModelId });
  await page.setViewportSize(options.viewport ?? DESKTOP_VIEWPORT);
  await page.goto(`/chat/workspace?lang=en${options.fresh ? "" : `&conversation=${CONVERSATION}`}`);
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  return {
    conversations, writes, historyReads,
    detail: (id: string) => payload(conversations.find((row) => row.id === id)!),
    hidePreviousAccount: () => { visibleConversations = []; },
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

const message = (page: Page, text: string) => page.getByTestId("chat-message").filter({ hasText: text });

test.describe("Chat unified workspace", { tag: "@ui-risk" }, () => {
  test("new Chat is gated while legacy Review keeps its existing route", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    const response = await page.goto("/chat/workspace?lang=en");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("chat-textarea")).toHaveCount(0);
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
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
    await page.getByTestId("chat-textarea").fill(laterDraft);
    release();
    await expect(page.getByText("The conversation or model changed while preparing the answer. Check your question and send again.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`conversation=${SECOND_CONVERSATION}`));
    await expect(message(page, SECOND_ANSWER)).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(laterDraft);
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
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    await chooseModel(page, MODEL_B);
    await drive(page, 0, "push", " A partial after model switch.");
    await expect(message(page, "A partial before model switch.")).toContainText("A partial after model switch.");
    await expect(message(page, "A partial before model switch.")).toHaveAttribute("data-model-id", MODEL_A);
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    await page.getByTestId("stop-this-response").click();
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __unifiedChatControls: Array<{ aborted: boolean }> }).__unifiedChatControls[0].aborted)).toBe(true);
    expect(await requests(page)).toHaveLength(1);
  });

  for (const heldEndpoint of ["context", "message-save"] as const) {
    test(`changing selection during ${heldEndpoint} preparation retains the draft and sends only after explicit submit`, async ({ page }) => {
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
      await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
      await expect(page.getByText("The conversation or model changed while preparing the answer. Check your question and send again.", { exact: true })).toBeVisible();
      expect(await requests(page)).toHaveLength(0);
      await page.getByTestId("chat-send-button").click();
      await drive(page, 0, "push", "Only the explicitly resubmitted model B answer.");
      await drive(page, 0, "finish");
      expect(await requests(page)).toHaveLength(1);
      expect((await requests(page))[0].modelId).toBe(MODEL_B);
    });

    test(`editing the next draft during ${heldEndpoint} preparation does not let the old send erase it`, async ({ page }) => {
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
      const sentPrompt = "Submit this original question.";
      const nextDraft = "A newly edited next question, not yet submitted.";
      await submitComposer(page, sentPrompt, DESKTOP_VIEWPORT.width);
      await expect.poll(() => held).toBe(true);
      await page.getByTestId("chat-textarea").fill(nextDraft);
      release();
      await drive(page, 0, "push", "Answering only the original question.");
      await drive(page, 0, "finish");
      await expect(page.getByTestId("chat-textarea")).toBeEnabled();
      await expect(page.getByTestId("chat-textarea")).toHaveValue(nextDraft);
      const calls = await requests(page);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0].messages)).toContain(sentPrompt);
      expect(JSON.stringify(calls[0].messages)).not.toContain(nextDraft);
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

  test("transport failure keeps partial text and restoration does not send until explicit submit", async ({ page }) => {
    await openChat(page);
    const prompt = "The exact interrupted question.";
    await submitComposer(page, prompt, DESKTOP_VIEWPORT.width);
    await drive(page, 0, "push", "Partial text must not become an error title.");
    await expect(message(page, "Partial text must not become an error title.")).toBeVisible();
    await drive(page, 0, "fail");
    await expect(page.getByTestId("chat-recovery-notice")).toBeVisible();
    await expect(message(page, "Partial text must not become an error title.")).toBeVisible();
    await page.getByTestId("restore-chat-question").click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue(prompt);
    expect(await requests(page)).toHaveLength(1);
    await page.getByTestId("chat-send-button").click();
    await drive(page, 1, "push", "Explicit new attempt.");
    await drive(page, 1, "finish");
    await expect(message(page, "Explicit new attempt.")).toBeVisible();
    expect(await requests(page)).toHaveLength(2);
  });

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
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
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
});

test.describe("Chat single-transcript mobile composer", { tag: "@ui-risk" }, () => {
  test.use({ hasTouch: true });
  for (const width of [320, 390]) {
    test(`${width}px and 200% text preserve the textarea row and Korean composition`, async ({ page }) => {
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
        await textarea.dispatchEvent("compositionend", { data: "한국어 조합" });
      }
    });
  }
});
