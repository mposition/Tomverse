import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

// Regression coverage for the "Chrome browser test error" hotfix (PR #76,
// commit c7744e6): the desktop per-panel model <select> used to stay
// interactive while the initial conversation/model selection was still
// loading, so a change made during that window could be silently discarded
// once the real conversation data arrived. app/(application)/chat/page.tsx
// now derives isModelSelectionReady and DesktopChatShell disables the
// select (and marks it aria-busy) until that resolves.

test.describe("desktop model selection readiness", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Per-panel model <select> only renders in the desktop chat shell."
    );
  });

  test("model select stays disabled and aria-busy until the initial conversation resolves", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });

    let releaseConversationList: (() => void) | null = null;
    const conversationListGate = new Promise<void>((resolve) => {
      releaseConversationList = resolve;
    });

    await page.unroute("**/api/conversations");
    await page.route("**/api/conversations", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await conversationListGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "qa-conversation",
            title: "QA conversation",
            selectedModels: ["gpt-5-4-mini"],
            disabledPanels: [],
            isLocked: false,
            shareEnabled: false,
            shareExpiresAt: null,
          },
        ]),
      });
    });

    await page.goto("/chat");

    const panel = page.getByTestId("desktop-model-panel").first();
    await expect(panel).toBeVisible();
    const select = panel.locator("select");

    await expect(select).toBeDisabled();
    await expect(select).toHaveAttribute("aria-busy", "true");

    releaseConversationList!();

    await expect(select).toBeEnabled();
    await expect(select).toHaveAttribute("aria-busy", "false");
    await expect(select).toHaveValue("gpt-5-4-mini");
  });

  test("guest mode never gates the model select on conversation loading", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await page.goto("/chat");

    const panel = page.getByTestId("desktop-model-panel").first();
    await expect(panel).toBeVisible();
    const select = panel.locator("select");

    await expect(select).toBeEnabled();
    await expect(select).toHaveAttribute("aria-busy", "false");
  });

  test("a model change made before load resolves is not discarded", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
    });

    let releaseConversationList: (() => void) | null = null;
    const conversationListGate = new Promise<void>((resolve) => {
      releaseConversationList = resolve;
    });

    await page.unroute("**/api/conversations");
    await page.route("**/api/conversations", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await conversationListGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "qa-conversation",
            title: "QA conversation",
            selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
            disabledPanels: [],
            isLocked: false,
            shareEnabled: false,
            shareExpiresAt: null,
          },
        ]),
      });
    });

    await page.goto("/chat");

    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await expect(firstPanel.locator("select")).toBeDisabled();

    releaseConversationList!();

    await expect(firstPanel.locator("select")).toBeEnabled();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");
    await expect(firstPanel).toHaveAttribute("data-model-id", "gemini-2-5-flash");
  });
});
