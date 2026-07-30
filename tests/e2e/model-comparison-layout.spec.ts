import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

// STG-F002: at 768-1024px, an always-expanded 320px sidebar plus 3
// side-by-side panels could leave each panel's model-name control at ~0px.
// DesktopChatShell now auto-collapses the sidebar and/or falls back to a
// single-active-panel tabs pattern once width-per-model would drop below a
// usable minimum. These tests seed a guest conversation with real messages
// (so the layout under test -- panels/tabs, not the empty-state welcome
// screen -- is what actually renders) across the specified widths, model
// counts, and sidebar states.

const GUEST_MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
const CHAT_ID = "guest_layout_test";

// `messageSeededModels` defaults to `activeModels`; pass a superset to seed
// messages for models not yet in `activeModels`.
const seedGuestComparison = async (
  page: Page,
  activeModels: string[],
  messageSeededModels: string[] = activeModels
) => {
  await page.addInitScript(
    ({ chatId, activeModels, messageSeededModels }) => {
      const conversation = {
        id: chatId,
        title: "Layout test",
        selectedModels: activeModels,
        disabledPanels: [],
        webSearchMode: "off",
        createdAt: new Date().toISOString(),
      };
      window.localStorage.setItem("guest_conversations", JSON.stringify([conversation]));
      for (const modelId of messageSeededModels) {
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "What is the capital of France?", status: "normal" },
            { id: "a1", role: "assistant", content: "The capital of France is Paris.", status: "normal" },
          ])
        );
      }
    },
    { chatId: CHAT_ID, activeModels, messageSeededModels }
  );
};

// The seeded conversation isn't auto-restored as "current" -- it shows up
// under "Continue a recent chat" on the fresh empty-state welcome screen,
// same as any other saved guest conversation, and needs a click to open.
const openSeededConversation = async (page: Page) => {
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: "Layout test" });
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
};

// Real WebKit/Chrome window resizes fire a native `resize` event; some
// automated viewport-override paths don't, so tests dispatch one
// explicitly after resizing to keep this deterministic across runners.
const resizeAndSettle = async (page: Page, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(150);
};

const desktopShell = (page: Page) => page.getByTestId("desktop-chat-shell");

const expectNoHorizontalOverflow = async (page: Page) => {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
};

// Returns each model's readable-name control -- either the panel's <select>
// (columns layout) or its tab's name span (tabs layout) -- whichever is
// actually rendered, so tests don't need to know which layout won.
const modelNameControls = (page: Page) => {
  const tabNames = page.locator('[data-testid="model-compare-tab"] > span > span:first-child');
  const selects = page.locator('[data-testid="desktop-model-panel"] select');
  return { tabNames, selects };
};

const REQUIRED_VIEWPORTS = [
  { width: 767, height: 1024 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 912, height: 1368 },
  { width: 1024, height: 768 },
  { width: 1180, height: 820 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

for (const viewport of REQUIRED_VIEWPORTS) {
  test(`STG-F002: 3-model comparison stays usable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Layout-collapse regression is viewport-driven via explicit setViewportSize, covered once."
    );
    // 767px is the mobile/desktop shell boundary itself (max-width:767px)
    // -- confirm the mobile shell (already covered elsewhere) renders
    // instead of a collapsed desktop shell, then stop; the rest of this
    // test is desktop-shell-specific.
    if (viewport.width <= 767) {
      await page.setViewportSize(viewport);
      await prepareGuestPage(page, "en");
      await seedGuestComparison(page, GUEST_MODELS);
      await openSeededConversation(page);
      await expect(desktopShell(page)).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      return;
    }

    await page.setViewportSize(viewport);
    await prepareGuestPage(page, "en");
    await seedGuestComparison(page, GUEST_MODELS);
    await openSeededConversation(page);

    await expect(desktopShell(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const { tabNames, selects } = modelNameControls(page);
    const tabCount = await tabNames.count();
    const selectCount = await selects.count();
    // Exactly one of the two patterns is active for 3 models at every one
    // of these widths (never neither, never a broken hybrid).
    expect(tabCount === 3 || selectCount === 3).toBe(true);

    const nameControls = tabCount === 3 ? tabNames : selects;
    for (let i = 0; i < 3; i += 1) {
      const control = nameControls.nth(i);
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `model name control ${i} bounding box`).not.toBeNull();
      if (box) {
        expect(box.width, `model name control ${i} width`).toBeGreaterThanOrEqual(120);
      }
      // Truncated text still exposes the full name via title/text content --
      // not clipped down to an icon-only or blank control.
      const text = (await control.textContent())?.trim() || "";
      expect(text.length).toBeGreaterThan(0);
    }

    // Every model's own change control is reachable, whichever layout won.
    if (selectCount === 3) {
      await expect(selects.nth(0)).toBeEnabled();
    } else {
      for (let i = 0; i < 3; i += 1) {
        await expect(tabNames.nth(i).locator("xpath=ancestor::button[1]")).toHaveAttribute(
          "role",
          "tab"
        );
      }
    }
  });
}

test("STG-F002: tabs mode lets keyboard and click navigate between all 3 model panels", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 768, 1024);
  await prepareGuestPage(page, "en");
  await seedGuestComparison(page, GUEST_MODELS);
  await openSeededConversation(page);

  const tablist = page.getByTestId("model-compare-tablist");
  await expect(tablist).toBeVisible();
  await expect(tablist).toHaveAttribute("role", "tablist");

  const tabs = page.getByTestId("model-compare-tab");
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  // Click-to-switch.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "false");

  // Keyboard: ArrowRight moves both selection and focus (roving tabindex).
  await tabs.nth(1).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(":focus")).toHaveAttribute("data-testid", "model-compare-tab");

  // Only the active tab is in the natural Tab order.
  await expect(tabs.nth(2)).toHaveAttribute("tabindex", "0");
  await expect(tabs.nth(0)).toHaveAttribute("tabindex", "-1");
});

test("STG-F002: sidebar auto-collapses at 768px, and the user can reopen it without breaking compare controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 768, 1024);
  await prepareGuestPage(page, "en");
  await seedGuestComparison(page, GUEST_MODELS);
  await openSeededConversation(page);

  const expandButton = page.getByTestId("sidebar-expand-button");
  await expect(expandButton).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await expandButton.click();
  await expect(page.getByTestId("sidebar-collapse-button")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Reopening it (even though there's now less room) must not silently
  // drop any of the 3 models' controls -- the layout falls back to tabs
  // instead of breaking.
  const { tabNames, selects } = modelNameControls(page);
  const tabCount = await tabNames.count();
  const selectCount = await selects.count();
  expect(tabCount === 3 || selectCount === 3).toBe(true);

  const collapseButton = page.getByTestId("sidebar-collapse-button");
  await collapseButton.click();
  await expect(page.getByTestId("sidebar-expand-button")).toBeVisible();
});

test("STG-F002: 1 selected model never triggers tabs or an unnecessary sidebar collapse at 768px", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 768, 1024);
  await prepareGuestPage(page, "en");
  await seedGuestComparison(page, [GUEST_MODELS[0]]);
  await openSeededConversation(page);

  await expect(page.getByTestId("model-compare-tablist")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-expand-button")).toHaveCount(0);
  const singleSelect = page.locator('[data-testid="desktop-model-panel"] select');
  await expect(singleSelect).toHaveCount(1);
  const box = await singleSelect.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(120);
});

test("STG-F002: 2 selected models never trigger tabs at 768px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 768, 1024);
  await prepareGuestPage(page, "en");
  await seedGuestComparison(page, GUEST_MODELS.slice(0, 2));
  await openSeededConversation(page);

  await expect(page.getByTestId("model-compare-tablist")).toHaveCount(0);
  const twoSelects = page.locator('[data-testid="desktop-model-panel"] select');
  await expect(twoSelects).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) {
    const selectBox = await twoSelects.nth(i).boundingBox();
    expect(selectBox?.width).toBeGreaterThanOrEqual(120);
  }
});

test("STG-F002: selected models and draft input survive crossing the mobile/desktop shell boundary", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 1024, 768);
  await prepareGuestPage(page, "en");
  await seedGuestComparison(page, GUEST_MODELS);
  await openSeededConversation(page);
  await expect(desktopShell(page)).toBeVisible();

  const draft = "Draft text that must survive a shell swap";
  const desktopTextarea = page.getByTestId("chat-textarea").first();
  await desktopTextarea.fill(draft);
  await expect(desktopTextarea).toHaveValue(draft);

  await resizeAndSettle(page, 390, 844);
  await expect(desktopShell(page)).toHaveCount(0);
  const mobileTextarea = page.getByTestId("chat-textarea").first();
  await expect(mobileTextarea).toHaveValue(draft);

  await resizeAndSettle(page, 1024, 768);
  await expect(desktopShell(page)).toBeVisible();
  const panels = page.locator('[data-testid="desktop-model-panel"]');
  await expect(panels).toHaveCount(3);
  await expect(page.getByTestId("chat-textarea").first()).toHaveValue(draft);
});

test("STG-F002: 1440px keeps the existing always-expanded 3-column desktop layout", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 1440, 900);
  await prepareGuestPage(page, "en");
  await seedGuestComparison(page, GUEST_MODELS);
  await openSeededConversation(page);

  await expect(page.getByTestId("model-compare-tablist")).toHaveCount(0);
  await expect(page.getByTestId("chat-sidebar-rail")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-collapse-button")).toBeVisible();

  const panels = page.locator('[data-testid="desktop-model-panel"]');
  await expect(panels).toHaveCount(3);
  const selects = page.locator('[data-testid="desktop-model-panel"] select');
  for (let i = 0; i < 3; i += 1) {
    const box = await selects.nth(i).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(120);
  }
  await expectNoHorizontalOverflow(page);
});

// AUD-R003: ChatPageClient.tsx's comparisonPresetAppliedRef effect (the
// signed-in counterpart to lib/guestChatInitialModels.ts's guest-only
// resolver, which already has full unit coverage) has no dedicated e2e case
// for a real authenticated account. This exercises it directly: duplicates
// collapse, an unknown model is dropped, and the URL is cleaned up so a
// refresh doesn't re-apply the same preset.
test("AUD-R003: an authenticated account's ?models= preset dedupes, drops unknown models, and clears the URL", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Covered once in desktop Chromium.");

  await resizeAndSettle(page, 1440, 900);
  await mockAuthenticatedApi(page);
  await page.goto(
    "/chat?lang=en&models=gpt-5-4-mini,not-a-real-model,claude-haiku-4-5,gpt-5-4-mini"
  );

  const panels = page.locator('[data-testid="desktop-model-panel"]');
  await expect(panels).toHaveCount(2);

  await expect
    .poll(() => new URL(page.url()).searchParams.has("models"))
    .toBe(false);
  await expect
    .poll(() => new URL(page.url()).searchParams.has("prompt"))
    .toBe(false);
});
