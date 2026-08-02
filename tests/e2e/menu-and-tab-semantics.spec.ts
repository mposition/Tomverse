import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import { restoreActiveConversation } from "./support/chat-state-fixtures";

/**
 * UX-026 and UX-032.
 *
 * UX-026: the mobile model tab strip announced `role="tablist"` and put
 * `role="tab"` on a non-focusable wrapper holding two buttons. `aria-selected`
 * therefore described something that could never be focused, the button the
 * user actually pressed announced nothing, no tab named a panel, and every tab
 * sat in the tab order with no arrow-key movement between them. The desktop
 * shell had all of this right; only the mobile one did not.
 *
 * UX-032: three sidebar popups declared `role="menu"` with `role="menuitem"`
 * children and implemented none of a menu's keyboard model. Two also held
 * children `menu` does not permit -- a section heading, a user-info block, an
 * expandable build-info panel. In application mode a screen-reader user was
 * told to press arrow keys and nothing happened.
 */

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

const seededMessages = (models: string[]): QaConversationMessage[] => [
  { id: "u1", role: "user", content: "Compare these answers" },
  ...models.map((modelId, index) => ({
    id: `a${index + 1}`,
    role: "assistant" as const,
    modelId,
    status: "normal",
    content: "Here is my answer.",
  })),
];

/**
 * The strip only exists on a conversation that is *not* empty and has more than
 * one model, so both have to be seeded -- sending a live message would depend
 * on a provider this suite does not have.
 */
const openMobileConversation = async (page: Page) => {
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, {
    selectedModels: MODELS,
    messages: seededMessages(MODELS),
  });
  await restoreActiveConversation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat?lang=en");
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("mobile-model-tab").first()).toBeVisible();
};

test.describe("mobile model tabs", () => {
  test(
    "the tab role is on the control, not on a wrapper that cannot take focus",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openMobileConversation(page);

      const tabs = page.getByRole("tab");
      const count = await tabs.count();
      expect(count).toBe(MODELS.length);

      for (let index = 0; index < count; index += 1) {
        const tab = tabs.nth(index);
        // A tab must be the thing the user activates.
        expect(await tab.evaluate((node) => node.tagName)).toBe("BUTTON");
        await expect(tab).toHaveAttribute("aria-controls", /.+/);
        await expect(tab).toHaveAttribute("aria-selected", /true|false/);
        // ...and must not contain another control.
        const nested = await tab.evaluate(
          (node) => node.querySelectorAll("button, a[href]").length
        );
        expect(nested).toBe(0);
      }
    }
  );

  test(
    "every tab names a panel that exists and points back",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openMobileConversation(page);

      const pairs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => {
          const controls = tab.getAttribute("aria-controls");
          const panel = controls ? document.getElementById(controls) : null;
          return {
            panelExists: Boolean(panel),
            panelRole: panel?.getAttribute("role") ?? null,
            labelledBy: panel?.getAttribute("aria-labelledby") ?? null,
            tabId: tab.id,
          };
        })
      );
      expect(pairs).toHaveLength(MODELS.length);
      for (const pair of pairs) {
        expect(pair.panelExists).toBe(true);
        expect(pair.panelRole).toBe("tabpanel");
        expect(pair.labelledBy).toBe(pair.tabId);
      }
    }
  );

  test(
    "the strip is one tab stop and the arrow keys move within it",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openMobileConversation(page);

      const tabs = page.getByRole("tab");
      const count = await tabs.count();
      // Roving tabindex: exactly one tab is reachable with Tab.
      const tabbable = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('[role="tab"]')).filter(
            (tab) => tab.getAttribute("tabindex") !== "-1"
          ).length
      );
      expect(tabbable).toBe(1);

      await tabs.first().focus();
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

      await page.keyboard.press("ArrowRight");
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(tabs.first()).toHaveAttribute("aria-selected", "false");

      await page.keyboard.press("ArrowLeft");
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

      await page.keyboard.press("End");
      await expect(tabs.nth(count - 1)).toHaveAttribute("aria-selected", "true");

      await page.keyboard.press("Home");
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    }
  );
});

test.describe("sidebar popups", () => {
  /**
   * Desktop only. The sidebar lives in a drawer on the mobile shell, and the
   * popups under test are the same components in both -- the semantics this
   * asserts are shell-independent, so asserting them twice would only add a
   * second way to open the drawer, not a second thing being tested.
   */
  test.skip(
    ({ viewport }) => (viewport?.width ?? 1280) < 768,
    "the sidebar is a drawer on the mobile shell"
  );

  const openConversation = async (page: Page) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectedModels: MODELS,
      messages: seededMessages(MODELS),
    });
    await restoreActiveConversation(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("sidebar-help-button")).toBeVisible();
  };

  test(
    "no popup claims a menu it does not implement",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openConversation(page);
      await page.getByTestId("sidebar-help-button").click();
      await expect(page.getByTestId("sidebar-help-link")).toBeVisible();

      // A `menu` commits to arrow-key navigation, a roving tab stop and Tab
      // leaving the menu. None of these popups do that, so none of them may
      // say so. Asserted over the whole rendered page rather than one popup, so
      // a future popup cannot reintroduce the claim somewhere else.
      const claimed = await page.evaluate(() => ({
        menus: document.querySelectorAll('[role="menu"]').length,
        menuItems: document.querySelectorAll('[role="menuitem"]').length,
        haspopupMenu: document.querySelectorAll('[aria-haspopup="menu"]').length,
      }));
      expect(claimed).toEqual({ menus: 0, menuItems: 0, haspopupMenu: 0 });
    }
  );

  test(
    "the help popup is named, referenced, and takes focus",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openConversation(page);
      const trigger = page.getByTestId("sidebar-help-button");
      await trigger.click();

      const controls = await trigger.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      // An attribute selector, not `#id`: React's useId emits colons, which a
      // CSS id selector cannot carry unescaped.
      const popup = page.locator(`[id="${controls}"]`);
      await expect(popup).toBeVisible();
      await expect(popup).toHaveAttribute("aria-label", /.+/);
      await expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Focus lands on the first control rather than staying on the trigger,
      // so the popup is reachable without hunting for it.
      await expect(page.getByTestId("sidebar-tour-replay")).toBeFocused();

      // ...and comes back on Escape, rather than stranding the user at the top
      // of the document.
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  );

  test(
    "the conversation actions popup takes focus and returns it",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await openConversation(page);

      // Anchored to the start of the name: the conversation row is itself a
      // button, and its computed name contains this one's label, so an
      // unanchored match resolves to the row instead of the control.
      const trigger = page
        .getByRole("button", { name: /^more actions: /i })
        .first();
      await expect(trigger).toBeVisible();
      await trigger.click();

      const panel = page.getByTestId("conversation-menu-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("aria-label", /.+/);

      // The panel is portalled to the end of <body>, so without this the next
      // Tab after opening it went to whatever followed the trigger in the
      // sidebar -- on screen beside the row, nowhere near it in the tab order.
      const focusedInsidePanel = await page.evaluate(() => {
        const panelElement = document.querySelector(
          '[data-testid="conversation-menu-panel"]'
        );
        return Boolean(
          panelElement &&
            document.activeElement &&
            panelElement.contains(document.activeElement)
        );
      });
      expect(focusedInsidePanel).toBe(true);

      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  );
});
