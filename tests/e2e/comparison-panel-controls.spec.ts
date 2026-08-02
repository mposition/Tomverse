import { expect, test, type Page } from "@playwright/test";
import { openRecentConversation, prepareGuestPage } from "./support/app-fixtures";

/**
 * UX-013 and UI-014, both on the comparison panel header.
 *
 * UX-013: the pause/resume toggle carried a `title` but its text content was
 * "ON"/"OFF", and content wins over `title` when a name is computed -- so with
 * three panels open a screen reader announced three buttons all called "ON",
 * none of which said which model it controlled. The close button had only a
 * `title` around an inline SVG, giving three identical "Close model panel"
 * buttons for a destructive action.
 *
 * UI-014: the model select was borderless, background-less text with no focus
 * ring, so the primary way to change a panel's model read as a static label.
 */

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

/** The per-panel model selects, excluding the shell's own selects. */
const panelSelects = (page: Page) =>
  page.getByTestId("desktop-model-panel").locator("select");
const CHAT_ID = "guest_panel_controls";

/**
 * Seeds a conversation that already has answers in every panel, then opens it.
 *
 * Both parts matter: the panel header only renders once a conversation has
 * content -- an empty one shows the welcome screen -- and the pause/close
 * controls only render with more than one model. This mirrors
 * tests/e2e/model-comparison-layout.spec.ts, the established way to reach a
 * real multi-panel layout.
 */
const openWithPanels = async (page: Page, modelCount: number) => {
  const models = MODELS.slice(0, modelCount);
  await prepareGuestPage(page, "en");
  await page.addInitScript(
    ({ chatId, activeModels }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title: "Panel controls",
            selectedModels: activeModels,
            disabledPanels: [],
            webSearchMode: "off",
            createdAt: new Date().toISOString(),
          },
        ])
      );
      for (const modelId of activeModels) {
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "Compare these.", status: "normal" },
            { id: "a1", role: "assistant", content: "An answer.", status: "normal" },
          ])
        );
      }
    },
    { chatId: CHAT_ID, activeModels: models }
  );

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: "Panel controls" });
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
  // The controls under test only exist once more than one panel is open.
  // Scoped to the panels: the shell renders other selects of its own.
  await expect(panelSelects(page)).toHaveCount(modelCount);
};

test.describe("comparison panel controls", () => {
  test(
    "each panel's pause and close controls have a distinct accessible name",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openWithPanels(page, 2);

      // The failure mode was several controls sharing one name, so the
      // assertion is on uniqueness, not on any single string.
      const names = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button[aria-pressed]"))
          .map((button) => button.getAttribute("aria-label"))
          .filter((name): name is string => Boolean(name))
      );
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(new Set(names).size).toBe(names.length);

      // "ON" must no longer be anyone's accessible name.
      await expect(
        page.getByRole("button", { name: "ON", exact: true })
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "OFF", exact: true })
      ).toHaveCount(0);

      // Each name states the panel and the model it acts on.
      for (const name of names) {
        expect(name).toMatch(/panel \d/i);
      }
    }
  );

  test(
    "the pause control's state matches aria-pressed",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openWithPanels(page, 2);

      const toggle = page.locator("button[aria-pressed]").first();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(toggle).toHaveAccessibleName(/pause/i);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(toggle).toHaveAccessibleName(/resume/i);
    }
  );

  test(
    "close controls name the panel they discard",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openWithPanels(page, 2);

      const closeButtons = page.getByRole("button", { name: /close panel \d/i });
      await expect(closeButtons).toHaveCount(2);

      const names = await closeButtons.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label"))
      );
      expect(new Set(names).size).toBe(names.length);
    }
  );

  test(
    "the model select reads as a field, not as a label",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openWithPanels(page, 2);

      const select = panelSelects(page).first();
      const style = await select.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          borderWidth: parseFloat(computed.borderTopWidth),
          backgroundImage: computed.backgroundImage,
          backgroundColor: computed.backgroundColor,
        };
      });
      // A visible border is the affordance that was missing.
      expect(style.borderWidth).toBeGreaterThan(0);
      // It keeps a surface of its own rather than dissolving into the header.
      expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

      // The unique per-panel name UX-013 relies on is still there.
      await expect(select).toHaveAccessibleName(/comparison panel 1/i);
    }
  );

  test(
    "three panels at 200% text keep the select inside the panel",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openWithPanels(page, 3);
      await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
      await page.waitForTimeout(250);

      const overflow = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);

      const selects = panelSelects(page);
      const count = await selects.count();
      expect(count).toBe(3);
      for (let index = 0; index < count; index += 1) {
        const box = await selects.nth(index).boundingBox();
        if (!box) continue;
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(overflow.client + 1);
      }
    }
  );
});
