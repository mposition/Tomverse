import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage, sendChatMessage } from "./support/app-fixtures";

// Regression coverage for the streaming auto-scroll fix: the chat panel used
// to force the viewport back to the bottom on every streamed chunk (a fixed
// ~650ms "auto-stick" window re-armed by each chunk, which never actually
// expired once chunks arrived faster than that), so a user who scrolled up
// mid-stream to read earlier content was yanked back down. ChatMessageList.tsx
// now tracks an explicit following/paused mode driven by real scroll input,
// never by a clock -- see lib/chatAutoScroll.ts.
//
// The mocked response body is deliberately large (tens of thousands of
// characters): Chromium's fetch Streams implementation splits a body that
// size across multiple `reader.read()` calls even when the whole response
// was fulfilled by Playwright in one shot, which reproduces "many chunks
// landing in quick succession" without needing a real token-by-token backend.
const LONG_RESPONSE = Array.from(
  { length: 500 },
  (_, i) => `Paragraph ${i + 1}: ${"the quick brown fox jumps over the lazy dog. ".repeat(6)}`
).join("\n\n");

const seedGuestModels = async (page: Page, models: string[]) => {
  await page.addInitScript((models) => {
    const conversation = {
      id: "guest_scroll_test",
      title: "Scroll test",
      selectedModels: models,
      disabledPanels: [],
      webSearchMode: "off",
      createdAt: new Date().toISOString(),
    };
    window.localStorage.setItem("guest_conversations", JSON.stringify([conversation]));
    window.sessionStorage.setItem("tomverse_active_chat_id", conversation.id);
  }, models);
};

const mockLongStream = async (page: Page, body: string = LONG_RESPONSE) => {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: { "X-Request-ID": "qa-trace-scroll" },
      body,
    });
  });
};

const messageList = (page: Page, index = 0) =>
  page.getByTestId("chat-message-list").nth(index);

const distanceFromBottom = (page: Page, index = 0) =>
  messageList(page, index).evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight
  );

const wheelUp = async (page: Page, index = 0) => {
  const box = await messageList(page, index).boundingBox();
  if (!box) throw new Error("message list not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -800);
};

const waitForContentGrowth = async (page: Page, index = 0) => {
  await page.waitForFunction(
    (i) => {
      const el = document.querySelectorAll('[data-testid="chat-message-list"]')[i];
      return !!el && el.scrollHeight > el.clientHeight + 300;
    },
    index
  );
};

test.describe("streaming auto-scroll", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Assertions target the desktop per-panel layout; mobile coverage is in its own describe block below."
    );
  });

  test("scrolling up mid-stream pauses auto-scroll and later chunks never force it back down", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "Tell me something long");
    await waitForContentGrowth(page);

    await wheelUp(page);
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(150);
    const distanceRightAfterScroll = await distanceFromBottom(page);

    // The response keeps growing after this point (more of the large body
    // still streaming in) -- none of that growth may move scrollTop.
    await expect(page.getByTestId("scroll-to-latest-button")).toBeVisible();
    const distanceOnceFinished = await distanceFromBottom(page);
    expect(distanceOnceFinished).toBeGreaterThanOrEqual(distanceRightAfterScroll - 5);
  });

  test("jump-to-latest button scrolls to bottom and resumes following", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "Tell me something long");
    await waitForContentGrowth(page);
    await wheelUp(page);
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(150);

    const button = page.getByTestId("scroll-to-latest-button");
    await expect(button).toBeVisible();
    await button.click();

    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(80);
    await expect(button).toHaveCount(0);
  });

  test("manually scrolling back to the bottom resumes following without the button", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "Tell me something long");
    await waitForContentGrowth(page);
    await wheelUp(page);
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(150);

    // Real user input scrolling back down, not a button click.
    const box = await messageList(page).boundingBox();
    if (!box) throw new Error("message list not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 4000);

    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(80);
    await expect(page.getByTestId("scroll-to-latest-button")).toHaveCount(0);
  });

  test("sending a new message resumes following even if the previous turn was paused", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "First long question");
    await waitForContentGrowth(page);
    await wheelUp(page);
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(150);
    await expect(page.getByTestId("scroll-to-latest-button")).toBeVisible();

    await sendChatMessage(page, testInfo, "Second question, please follow this one");
    await waitForContentGrowth(page);

    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(80);
    await expect(page.getByTestId("scroll-to-latest-button")).toHaveCount(0);
  });

  test("PC wheel and keyboard input both pause auto-scroll", async ({ page }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "Tell me something long");
    await waitForContentGrowth(page);
    await wheelUp(page);
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(150);
    await expect(page.getByTestId("scroll-to-latest-button")).toBeVisible();

    // Resume, then re-pause via a keyboard scroll instead of wheel --
    // Home/PageUp/ArrowUp all move scrollTop the same native way once the
    // scroll container is focused.
    await page.getByTestId("scroll-to-latest-button").click();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(80);

    await messageList(page).click();
    await page.keyboard.press("Home");
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(150);
  });

  test("two model panels pause independently -- one paused panel doesn't affect the other", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini", "claude-haiku-4-5"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "Tell both of you something long");
    await waitForContentGrowth(page, 0);
    await waitForContentGrowth(page, 1);

    // Only the first panel's user scrolls up.
    await wheelUp(page, 0);
    await expect.poll(() => distanceFromBottom(page, 0)).toBeGreaterThan(150);

    // The second panel is untouched and must still be following.
    await expect.poll(() => distanceFromBottom(page, 1)).toBeLessThan(80);

    const firstPanelMessages = page
      .locator('[data-testid="desktop-model-panel"]')
      .nth(0)
      .getByTestId("scroll-to-latest-button");
    const secondPanelMessages = page
      .locator('[data-testid="desktop-model-panel"]')
      .nth(1)
      .getByTestId("scroll-to-latest-button");
    await expect(firstPanelMessages).toBeVisible();
    await expect(secondPanelMessages).toHaveCount(0);
  });
});

test.describe("streaming auto-scroll (mobile)", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Mobile-tab isolation only applies to the mobile shell's tabbed layout."
    );
  });

  test("pausing the active model tab survives switching away and back, without touching the other tab's own following state", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await seedGuestModels(page, ["gpt-5-4-mini", "claude-haiku-4-5"]);
    await mockLongStream(page);
    await page.goto("/chat");

    await sendChatMessage(page, testInfo, "Tell both of you something long");
    // Both panels stay mounted (CSS-hidden, never unmounted) the whole time,
    // but a `display:none` panel's scrollHeight reads as 0 -- metrics on the
    // inactive one can only be checked once it's actually visible again,
    // hence switching tabs below rather than reading it while hidden.
    await waitForContentGrowth(page, 0);

    await wheelUp(page, 0);
    await expect.poll(() => distanceFromBottom(page, 0)).toBeGreaterThan(150);
    await expect(page.getByTestId("scroll-to-latest-button").first()).toBeVisible();

    // Switch to the second model's tab -- its own stream was running the
    // whole time in the background; it must show up already caught up to
    // its own latest content, unaffected by the first tab's pause.
    await page.locator('[data-testid="mobile-model-tab"][data-model-id="claude-haiku-4-5"]').click();
    await waitForContentGrowth(page, 1);
    await expect.poll(() => distanceFromBottom(page, 1)).toBeLessThan(80);
    // The first tab's own button still exists in the DOM (its panel is only
    // CSS-hidden, not unmounted) -- only a *visible* button would mean this
    // (now-visible) second tab is itself paused, which it must not be.
    await expect(page.locator('[data-testid="scroll-to-latest-button"]:visible')).toHaveCount(0);

    // Switching back, the first tab's pause (and scroll position) must
    // still be exactly as the user left it -- proving the panel was never
    // unmounted/reset by the tab switch.
    await page.locator('[data-testid="mobile-model-tab"][data-model-id="gpt-5-4-mini"]').click();
    await expect.poll(() => distanceFromBottom(page, 0)).toBeGreaterThan(150);
    await expect(page.locator('[data-testid="scroll-to-latest-button"]:visible')).toHaveCount(1);
  });
});
