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

test.use({ hasTouch: true });

async function enterChat(page: Page, options: {
  offered?: boolean;
  withConversationPair?: boolean;
  viewport?: { width: number; height: number };
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
  ]);
  if (options.withConversationPair) {
    await restoreActiveConversation(page, PRIMARY_CONVERSATION);
  }
  await page.setViewportSize(options.viewport ?? { width: 390, height: 680 });
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
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
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();
    await page.getByTestId("prompt-refiner-keep-original").click();
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue(SOURCE_PROMPT);

    await page.getByTestId("prompt-refiner-request").click();
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();
    await page.getByTestId("prompt-refiner-use").click();
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue(/목표, 제약 조건, 원하는 출력 형식/);
    await page.getByTestId("chat-send-button").click();
    await page.waitForTimeout(500);
    expect(chatPosts, "a Refiner decision submitted the turn").toBe(0);
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
    await expect(page.getByTestId("prompt-refiner-ready")).toBeFocused();
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
