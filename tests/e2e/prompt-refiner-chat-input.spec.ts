import { expect, test, type Page } from "@playwright/test";

import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  mockUserUsage,
  restoreActiveConversation,
  setDeterministicTheme,
  setRootFontSize,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

const SOURCE_PROMPT = "한국어 원문 질문";
const PRIMARY_CONVERSATION = "qa-conversation";
const SECOND_CONVERSATION = "qa-prompt-refiner-second";

async function mockDurableDrafts(page: Page) {
  const writes: string[] = [];
  const drafts = new Map<string, { text: string; revision: number }>();
  await page.route(/\/api\/products\/chat\/drafts\/[^?]+(?:\?.*)?$/, async (route) => {
    const scopeKey = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const current = drafts.get(scopeKey);
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { scopeKey, draft: current
        ? { scopeKey, ...current, attachmentReferences: [], attachments: [],
          createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" }
        : null } });
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as { text?: string; expectedRevision?: number };
    if (route.request().method() === "PUT") writes.push(body.text ?? "");
    if (body.expectedRevision !== (current?.revision ?? 0)) {
      await route.fulfill({ status: 409, json: { code: "CHAT_DRAFT_REVISION_CONFLICT",
        currentRevision: current?.revision ?? null, currentDraft: null } });
      return;
    }
    if (route.request().method() === "DELETE") {
      drafts.delete(scopeKey);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const next = { text: body.text ?? "", revision: (current?.revision ?? 0) + 1 };
    drafts.set(scopeKey, next);
    await route.fulfill({ json: { draft: { scopeKey, ...next, attachmentReferences: [],
      attachments: [], createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z" } } });
  });
  return { writes, drafts };
}

test.use({ hasTouch: true });

async function enterChat(page: Page, options: {
  offered?: boolean;
  withImageGeneration?: boolean;
  withConversationPair?: boolean;
  durableChat?: boolean;
  modeRefresh?: boolean;
  viewport?: { width: number; height: number };
  expectedShell?: "mobile" | "desktop";
} = {}) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, options.withConversationPair
    ? {
        messages: [{ id: "primary-user", role: "user", content: "Primary history" }],
        extraConversations: [{
          id: SECOND_CONVERSATION,
          title: "Second prompt scope",
          messages: [{ id: "second-user", role: "user", content: "Second history" }],
        }],
      }
    : {});
  await mockUserUsage(page, { plan: "Pro" });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_chat_workspace",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
    ...(options.offered
      ? [{
          name: "__tomverse_e2e_prompt_refiner",
          value: "1",
          url: "http://127.0.0.1:3100",
        }]
      : []),
    ...(options.withImageGeneration
      ? [{
          name: "__tomverse_e2e_image_generation",
          value: "1",
          url: "http://127.0.0.1:3100",
        }]
      : []),
    ...(options.modeRefresh
      ? [{
          name: "__tomverse_e2e_prompt_refiner_mode_refresh",
          value: "1",
          url: "http://127.0.0.1:3100",
        }]
      : []),
  ]);
  if (options.withConversationPair && !options.durableChat) {
    await restoreActiveConversation(page, PRIMARY_CONVERSATION);
  }
  await page.setViewportSize(options.viewport ?? { width: 390, height: 680 });
  await page.goto(options.durableChat ? "/chat/workspace?lang=ko" : "/chat?lang=ko");
  await expect(page.getByTestId(`${options.expectedShell ?? "mobile"}-chat-shell`))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  if (options.withConversationPair) {
    await expect(page.getByText("Primary history", { exact: true })).toBeVisible();
  }
}

async function refreshPromptRefinerFixtureMode(page: Page, enabled: boolean) {
  if (enabled) {
    await page.context().addCookies([{
      name: "__tomverse_e2e_prompt_refiner",
      value: "1",
      url: "http://127.0.0.1:3100",
    }]);
  } else {
    await page.evaluate(() => {
      document.cookie = "__tomverse_e2e_prompt_refiner=; Max-Age=0; Path=/";
    });
  }
  await page.getByTestId("prompt-refiner-fixture-refresh").evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
    button.click();
  });
  await expect(page.getByTestId("prompt-refiner-fixture-refresh"))
    .toHaveAttribute("data-mode", enabled ? "e2e_fixture" : "off", { timeout: 20_000 });
  if (enabled) {
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
  } else {
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
  }
}

async function markPromptRefinerComposerInstance(page: Page) {
  await page.evaluate(() => {
    const probe = window as Window & {
      __promptRefinerComposerProbe?: Element | null;
      __promptRefinerWindowProbe?: string;
    };
    probe.__promptRefinerComposerProbe = document.querySelector('[data-testid="chat-textarea"]');
    probe.__promptRefinerWindowProbe = "same-document";
  });
}

async function expectPromptRefinerComposerInstancePreserved(page: Page) {
  expect(await page.evaluate(() => {
    const probe = window as Window & {
      __promptRefinerComposerProbe?: Element | null;
      __promptRefinerWindowProbe?: string;
    };
    return probe.__promptRefinerWindowProbe === "same-document" &&
      probe.__promptRefinerComposerProbe !== null &&
      probe.__promptRefinerComposerProbe === document.querySelector('[data-testid="chat-textarea"]');
  }), "the Chat composer remounted during the server-prop transition").toBe(true);
}

async function selectConversation(page: Page, conversationId: string) {
  await page.getByTestId("mobile-sidebar-open").click();
  const drawer = page.getByTestId("mobile-chat-shell").getByRole("dialog");
  await drawer
    .locator(
      `[data-testid="sidebar-conversation-item"][data-conversation-id="${conversationId}"]`
    )
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("tomverse_active_chat_id"))
    )
    .toBe(conversationId);
}

async function expectRefinerInsideViewport(page: Page) {
  await expectNoHorizontalOverflow(page);
  const panel = page.getByTestId("prompt-refiner-ready");
  const box = await panel.boundingBox();
  expect(box, "ready proposal has no layout box").not.toBeNull();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth + 1);
  for (const id of ["prompt-refiner-keep-original", "prompt-refiner-use"]) {
    const actionBox = await page.getByTestId(id).boundingBox();
    expect(actionBox, `${id} has no layout box`).not.toBeNull();
    expect(actionBox!.height, `${id} lost its 44px target`).toBeGreaterThanOrEqual(44);
  }
}

async function holdRefinerResponse(page: Page) {
  let release!: () => void;
  let observed!: () => void;
  let markSettled!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  await page.route("**/e2e/prompt-refiner-adapter", async (route) => {
    observed();
    await released;
    try {
      await route.continue();
    } catch {
      // Editing or switching conversation intentionally aborts this request.
    } finally {
      markSettled();
    }
  });
  return { intercepted, release, settled };
}

test.describe("Prompt Refiner in the actual ChatInput", { tag: "@ui-risk" }, () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Explicit mobile geometry is measured once with Chromium and touch enabled."
    );
  });

  test("default-off server decision renders no disabled teaser", async ({ page }) => {
    await enterChat(page);
    await page.getByTestId("chat-textarea").fill(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-fixture-refresh")).toHaveCount(0);
  });

  test("both explicit decisions return focus and never submit", async ({ page }) => {
    let chatPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/chat(?:$|\?)/.test(request.url())) {
        chatPosts += 1;
      }
    });
    await enterChat(page, { offered: true });
    const responseGate = await holdRefinerResponse(page);
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);

    await page.getByTestId("prompt-refiner-request").click();
    await responseGate.intercepted;
    await expect(page.getByTestId("prompt-refiner-requesting")).toBeFocused();
    responseGate.release();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused({ timeout: 30_000 });
    await page.getByTestId("prompt-refiner-keep-original").click();
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatPosts, "the fixture sent even the kept-original draft").toBe(0);

    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();
    // The duplicate-consumption branch is covered by the pure validator test.
    // A second browser click may target a detached button after React commits.
    await page.getByTestId("prompt-refiner-use").click();
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toContainText("목표, 제약 조건, 원하는 출력 형식");
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatPosts, "a Refiner decision submitted the turn").toBe(0);
  });

  test("accepted preview leaves authored draft intact and cannot be re-requested", async ({ page }) => {
    let chatPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/chat(?:$|\?)/.test(request.url())) {
        chatPosts += 1;
      }
    });
    await enterChat(page, { offered: true });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible();
    await page.getByTestId("prompt-refiner-use").click();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toBeVisible();
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatPosts, "accepted fixture text reached Chat after re-request was withheld").toBe(0);

    await textarea.fill("새로 작성한 사용자 질문");
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
  });

  test("restored accepted fixture draft cannot submit after a conversation switch", async ({ page }) => {
    let chatPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/chat(?:$|\?)/.test(request.url())) {
        chatPosts += 1;
      }
    });
    await enterChat(page, { offered: true, withConversationPair: true });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("prompt-refiner-use").click();
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toBeVisible();
    await selectConversation(page, SECOND_CONVERSATION);
    await selectConversation(page, PRIMARY_CONVERSATION);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatPosts, "restored accepted fixture draft reached Chat").toBe(0);
  });

  test("accepted fixture draft cannot seed the Image workspace", async ({ page }) => {
    await enterChat(page, { offered: true, withImageGeneration: true });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible();
    await page.getByTestId("prompt-refiner-use").click();
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toBeVisible();
    await page.getByTestId("composer-tools-button").click();
    await expect(page.getByTestId("tools-image-generation-row")).toBeVisible();
    await page.getByTestId("tools-image-generation-row").click();
    await expect(page.getByTestId("image-generation-prompt")).toHaveCount(0);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
  });

  test("accepted preview never writes synthetic text to durable drafts or survives mode-off reload", async ({ page }) => {
    const durable = await mockDurableDrafts(page);
    await enterChat(page, { offered: true, durableChat: true });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await expect.poll(() => durable.writes.includes(SOURCE_PROMPT)).toBe(true);
    await expect.poll(() => [...durable.drafts.values()].some((draft) => draft.text === SOURCE_PROMPT)).toBe(true);
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("prompt-refiner-use").click();
    const proposal = page.getByTestId("prompt-refiner-accepted-preview-proposal");
    await expect(proposal).toContainText("목표, 제약 조건, 원하는 출력 형식");
    const synthetic = (await proposal.textContent()) ?? "";
    expect(synthetic).not.toBe(SOURCE_PROMPT);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await page.waitForTimeout(1000); // allow a full durable draft debounce after acceptance
    expect(durable.writes).not.toContain(synthetic);
    expect([...durable.drafts.values()].every((draft) => draft.text !== synthetic)).toBe(true);
    await page.evaluate(() => { document.cookie = "__tomverse_e2e_prompt_refiner=; Max-Age=0; Path=/"; });
    await page.reload();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    expect(durable.writes).not.toContain(synthetic);
    await page.context().addCookies([{
      name: "__tomverse_e2e_prompt_refiner",
      value: "1",
      url: "http://127.0.0.1:3100",
    }]);
    await page.reload();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    expect(durable.writes).not.toContain(synthetic);
  });

  test("editing during the fixture request discards the late result", async ({ page }) => {
    await enterChat(page, { offered: true });
    // A transport abort is only the first defence. Disable it in this test so
    // the owner-side sequence and draft binding must reject a response that
    // really reaches the page after the edit.
    await page.evaluate(() => {
      AbortController.prototype.abort = function abortWithoutCancelling() {};
    });
    const responseGate = await holdRefinerResponse(page);
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await responseGate.intercepted;
    await textarea.pressSequentially(" 변경");
    await expect(page.getByTestId("prompt-refiner-requesting")).toHaveCount(0);
    await textarea.fill(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith("/e2e/prompt-refiner-adapter") &&
      response.request().method() === "POST"
    );
    responseGate.release();
    const response = await lateResponse;
    await response.finished();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.promptRefinerFixtureSettled
        )
      )
      .toBe("1");
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
  });

  test("the same draft in another conversation cannot inherit a ready proposal", async ({
    page,
  }) => {
    await enterChat(page, { offered: true, withConversationPair: true });
    const textarea = page.getByTestId("chat-textarea");

    await textarea.fill(SOURCE_PROMPT);
    await selectConversation(page, SECOND_CONVERSATION);
    await textarea.fill(SOURCE_PROMPT);
    await selectConversation(page, PRIMARY_CONVERSATION);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);

    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused({ timeout: 30_000 });
    await selectConversation(page, SECOND_CONVERSATION);

    // Text equality cannot satisfy this assertion: only the conversation scope
    // changed, so the ready proposal must be discarded by the scope binding.
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
  });

  test("starting a new chat aborts and discards a pending proposal", async ({ page }) => {
    await enterChat(page, { offered: true });
    const responseGate = await holdRefinerResponse(page);
    await page.getByTestId("chat-textarea").fill(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await responseGate.intercepted;
    await page.getByTestId("mobile-sidebar-open").click();
    const drawer = page.getByTestId("mobile-chat-shell").getByRole("dialog");
    await drawer.getByTestId("sidebar-new-chat").click();
    responseGate.release();
    await responseGate.settled;
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
  });

  test("an invalid fixture response fails closed and retry recovers", async ({ page }) => {
    await enterChat(page, { offered: true });
    await page.route("**/e2e/prompt-refiner-adapter", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ refinedPrompt: "missing contract fields" }),
      });
    }, { times: 1 });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-failed")).toBeVisible();
    await expect(page.getByTestId("prompt-refiner-retry")).toBeFocused();
    await page.getByTestId("prompt-refiner-retry").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();
  });

  test("a maximum-length legal draft receives a bounded proposal", async ({ page }) => {
    await enterChat(page, { offered: true });
    await page.getByTestId("chat-textarea").fill("a".repeat(16_000));
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();
    await expect(page.getByTestId("prompt-refiner-proposal")).not.toBeEmpty();
  });

  test("IME composition blocks mutation without resizing the status copy", async ({ page }) => {
    await enterChat(page, { offered: true });
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    const idle = page.getByTestId("prompt-refiner-idle");
    const before = await idle.boundingBox();
    await textarea.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      element.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "하" })
      );
    });
    const request = page.getByTestId("prompt-refiner-request");
    await expect(request).toBeDisabled();
    await expect(request).toHaveAttribute("aria-label", /조합|composition/i);
    const during = await idle.boundingBox();
    expect(during!.height).toBeCloseTo(before!.height, 1);
    await expect(page.getByTestId("prompt-refiner-requesting")).toHaveCount(0);
  });

  for (const scenario of [
    { name: "320px and 200% text", viewport: { width: 320, height: 640 }, font: 32 },
    { name: "200% page zoom equivalent", viewport: { width: 195, height: 340 }, font: 16 },
  ] as const) {
    test(`${scenario.name} keeps proposal and actions inside the composer`, async ({ page }) => {
      await enterChat(page, { offered: true, viewport: scenario.viewport });
      await setRootFontSize(page, scenario.font);
      await page.getByTestId("chat-textarea").fill(SOURCE_PROMPT);
      await page.getByTestId("prompt-refiner-request").click();
      await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible();
      await expectRefinerInsideViewport(page);
    });
  }
});

async function blockAndCountChatPosts(page: Page, durable: Awaited<ReturnType<typeof mockDurableDrafts>>) {
  let posts = 0;
  const postBodies: string[] = [];
  const unexpectedCreateMethods: string[] = [];
  // The positive control needs the real Chat send path to reach /api/chat.
  // Keep its preceding durable create/save steps inside the browser fixture;
  // they do not touch the database or a provider.
  await page.route("**/api/products/chat/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      unexpectedCreateMethods.push(route.request().method());
      await route.abort("aborted");
      return;
    }
    const conversation = {
      id: PRIMARY_CONVERSATION, title: "QA conversation", productKey: "chat",
      surface: "chat", selectedModels: ["gpt-5-6-luna"], disabledPanels: [],
      webSearchMode: "off", isLocked: false,
    };
    await route.fulfill({ status: 201, json: conversation });
  });
  await page.route("**/api/chat/context", (route) =>
    route.fulfill({ json: { contextBundle: null } })
  );
  await page.route(`**/api/conversations/${PRIMARY_CONVERSATION}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      messages?: Array<{ clientRequestId?: string }>;
      draftConsume?: { scopeKey?: string; expectedRevision?: number; requestId?: string };
    };
    const consume = body.draftConsume;
    const requestId = body.messages?.[0]?.clientRequestId;
    const draft = consume?.scopeKey ? durable.drafts.get(consume.scopeKey) : null;
    if (!requestId || requestId !== consume?.requestId || !draft ||
        draft.revision !== consume.expectedRevision) {
      return route.fulfill({ status: 409, json: { code: "QA_DRAFT_CONSUME_MISMATCH" } });
    }
    durable.drafts.delete(consume.scopeKey!);
    return route.fulfill({ status: 201, json: {
      success: true, created: 1, draftConsumed: true,
      messageMappings: [{ requestId, messageId: "11111111-1111-4111-8111-111111111111" }],
      attachments: [],
    } });
  });
  // Install after the authenticated fixture routes, so this exact Chat route
  // wins route precedence and no request can reach a provider.
  await page.route(/\/api\/chat(?:$|\?)/, async (route) => {
    if (route.request().method() === "POST") {
      posts += 1;
      postBodies.push(route.request().postData() ?? "");
      await route.abort("aborted");
      return;
    }
    await route.fallback();
  });
  return {
    posts: () => posts,
    bodies: () => [...postBodies],
    unexpectedCreateMethods: () => [...unexpectedCreateMethods],
  };
}

test.describe("Prompt Refiner same-instance fixture mode transitions", { tag: "@ui-risk" }, () => {
  test.setTimeout(60_000); // cold loopback RSC compilation may outlast the default 30s test budget
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name),
      "Same-instance fixture transitions are measured on desktop and mobile Chromium."
    );
  });

  test("off/on/off/on discards ready and accepted previews without changing the authored draft", async ({ page }, testInfo) => {
    const durable = await mockDurableDrafts(page);
    const desktop = testInfo.project.name === "desktop-chromium";
    await enterChat(page, { durableChat: true, modeRefresh: true,
      viewport: desktop ? { width: 1366, height: 768 } : undefined,
      expectedShell: desktop ? "desktop" : "mobile" });
    const chatProbe = await blockAndCountChatPosts(page, durable);
    await expect(page.getByTestId("prompt-refiner-fixture-refresh")).toHaveCount(1);
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
    await markPromptRefinerComposerInstance(page);
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await expect.poll(() => durable.writes.includes(SOURCE_PROMPT)).toBe(true);

    await refreshPromptRefinerFixtureMode(page, true);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible({ timeout: 30_000 });

    await refreshPromptRefinerFixtureMode(page, false);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await refreshPromptRefinerFixtureMode(page, true);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);

    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("prompt-refiner-use").click();
    const proposal = page.getByTestId("prompt-refiner-accepted-preview-proposal");
    await expect(proposal).toContainText("목표, 제약 조건, 원하는 출력 형식");
    const synthetic = (await proposal.textContent()) ?? "";
    expect(synthetic).not.toBe(SOURCE_PROMPT);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);

    await refreshPromptRefinerFixtureMode(page, false);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    await refreshPromptRefinerFixtureMode(page, true);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await page.waitForTimeout(1000); // full durable-draft debounce after the mode transitions
    expect(durable.writes).not.toContain(synthetic);
    expect([...durable.drafts.values()].every((draft) => draft.text !== synthetic)).toBe(true);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatProbe.posts(), "fixture mode dispatched a Chat turn").toBe(0);
    await refreshPromptRefinerFixtureMode(page, false);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();
    await expect.poll(chatProbe.posts).toBe(1); // positive control: off mode reaches the blocked Chat route
    expect(chatProbe.bodies()).toHaveLength(1);
    expect(chatProbe.bodies()[0]).toContain(SOURCE_PROMPT);
    expect(chatProbe.bodies()[0]).not.toContain(synthetic);
    expect(chatProbe.unexpectedCreateMethods()).toEqual([]);
  });

  test("a pending response stays stale after off/on while the same Chat instance survives", async ({ page }, testInfo) => {
    const durable = await mockDurableDrafts(page);
    const desktop = testInfo.project.name === "desktop-chromium";
    await enterChat(page, { durableChat: true, modeRefresh: true,
      viewport: desktop ? { width: 1366, height: 768 } : undefined,
      expectedShell: desktop ? "desktop" : "mobile" });
    const chatProbe = await blockAndCountChatPosts(page, durable);
    await markPromptRefinerComposerInstance(page);
    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill(SOURCE_PROMPT);
    await expect.poll(() => durable.writes.includes(SOURCE_PROMPT)).toBe(true);
    await refreshPromptRefinerFixtureMode(page, true);
    await expectPromptRefinerComposerInstancePreserved(page);

    // Keep the fixture response deliverable after its owner aborts, so the
    // scope epoch must reject it. Other requests, including router.refresh,
    // keep their normal AbortController and fetch cancellation semantics.
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url, window.location.href).pathname === "/e2e/prompt-refiner-adapter") {
          return originalFetch(input, { ...init, signal: undefined });
        }
        return originalFetch(input, init);
      };
    });
    const responseGate = await holdRefinerResponse(page);
    await page.getByTestId("prompt-refiner-request").click();
    await responseGate.intercepted;
    await expect(page.getByTestId("prompt-refiner-requesting")).toBeVisible();
    await refreshPromptRefinerFixtureMode(page, false);
    await expectPromptRefinerComposerInstancePreserved(page);
    await refreshPromptRefinerFixtureMode(page, true);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(page.getByTestId("prompt-refiner-requesting")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith("/e2e/prompt-refiner-adapter") &&
      response.request().method() === "POST"
    );
    const previouslySettled = Number(await page.evaluate(
      () => document.documentElement.dataset.promptRefinerFixtureSettled ?? "0"
    ));
    responseGate.release();
    const response = await lateResponse;
    await response.finished();
    await expect.poll(() => page.evaluate(
      () => Number(document.documentElement.dataset.promptRefinerFixtureSettled ?? "0")
    )).toBeGreaterThan(previouslySettled);
    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expectPromptRefinerComposerInstancePreserved(page);
    expect(durable.writes.every((text) => text === SOURCE_PROMPT)).toBe(true);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatProbe.posts(), "stale fixture response dispatched a Chat turn").toBe(0);
    await refreshPromptRefinerFixtureMode(page, false);
    await expectPromptRefinerComposerInstancePreserved(page);
    await expect(textarea).toHaveValue(SOURCE_PROMPT);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();
    await expect.poll(chatProbe.posts).toBe(1); // positive control cannot reach the server/provider
    expect(chatProbe.bodies()).toHaveLength(1);
    expect(chatProbe.bodies()[0]).toContain(SOURCE_PROMPT);
    expect(chatProbe.bodies()[0]).not.toContain("목표, 제약 조건, 원하는 출력 형식");
    expect(chatProbe.unexpectedCreateMethods()).toEqual([]);
  });
});
