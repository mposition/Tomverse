import { expect, test, type Page } from "@playwright/test";
import { openRecentConversation, prepareGuestPage } from "./support/app-fixtures";

/**
 * Web search is one switch.
 *
 * It used to be three choices -- off, "ask me before searching", and search --
 * and the middle one is what this change removed. A mode that offers a search
 * and waits for an answer is a second decision on every turn that could want
 * the web, and the offer arrived mid-draft, under the cursor. The switch
 * replaces the whole flow: flipping it on *is* the consent to search and to
 * the surcharge, and the switch says on the same row that the search is
 * conditional, so "on" never reads as "every question is searched".
 *
 * What this spec holds:
 *   - the middle choice is unreachable, and its mid-draft nudge is gone;
 *   - the control is a real switch -- named, checked, keyboard-operable;
 *   - both states say what they do, and only the on state quotes a price;
 *   - the composer keeps showing the state after the menu closes.
 */

// claude-haiku-4-5 has confirmed provider-native search and is guest
// selectable, so the on state here is the ordinary all-supported one rather
// than a blocked or partial-support special case.
const SUPPORTED = "claude-haiku-4-5";
const TITLE = "Web search toggle";
const CHAT_ID = "guest_web_search_toggle";

const seedGuestConversation = async (
  page: Page,
  webSearchMode: "off" | "auto" | "always"
) => {
  await page.addInitScript(
    ({ chatId, model, title, webSearchMode }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title,
            selectedModels: [model],
            disabledPanels: [],
            webSearchMode,
            createdAt: new Date().toISOString(),
          },
        ])
      );
      window.localStorage.setItem(
        `guest_messages_${chatId}_${model}`,
        JSON.stringify([
          { id: "u1", role: "user", content: "Hello", status: "normal" },
          { id: "a1", role: "assistant", content: "Hi there.", status: "normal" },
        ])
      );
    },
    { chatId: CHAT_ID, model: SUPPORTED, title: TITLE, webSearchMode }
  );
};

const open = async (page: Page) => {
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: TITLE });
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
};

const toolsMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(0);
const toggle = (page: Page) => page.getByTestId("tools-web-search-row");
const chip = (page: Page) => page.getByTestId("web-search-mode-chip");

const openTools = async (page: Page) => {
  await toolsMenuTrigger(page).click();
  await expect(toggle(page)).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "en");
});

test("the tools menu offers a switch, not a screen of three choices", async ({
  page,
}) => {
  await seedGuestConversation(page, "off");
  await open(page);
  await openTools(page);

  await expect(toggle(page)).toHaveRole("switch");
  await expect(toggle(page)).toHaveAccessibleName("Web search");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");

  // The row is the control. It no longer opens a sub-view, so the menu still
  // shows the rest of the tools after it is used.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tools-deep-research-row")).toBeVisible();

  // And there is nowhere left to ask for a search to be offered rather than
  // run. The three option rows are gone, not hidden, and the wording that
  // named the middle one is gone with them.
  for (const mode of ["off", "auto", "always"]) {
    await expect(page.getByTestId(`web-search-mode-option-${mode}`)).toHaveCount(0);
  }
  const menu = page.locator("#chat-input-popover");
  await expect(menu).not.toContainText("Auto");
  await expect(menu).not.toContainText("Use web search");
});

test("both states say what they do, and only the on state quotes a price", async ({
  page,
}) => {
  await seedGuestConversation(page, "off");
  await open(page);
  await openTools(page);

  const description = page.locator("#tools-web-search-description");
  await expect(description).toContainText("without searching the web");
  // Off costs nothing, so it says nothing about credits.
  await expect(description).not.toContainText("credits");

  await toggle(page).click();
  // Conditional by wording, deliberately: the switch grants permission to
  // search, it does not promise a search on every turn.
  await expect(description).toContainText(
    "Searches the web automatically when current information or sources are needed"
  );
  // The surcharge comes from MODEL_USAGE_CREDIT_WEIGHTS.webSearchSurcharge --
  // the same constant the reservation is sized on -- rather than being written
  // into the sentence by hand.
  await expect(description).toContainText("8 credits");
  await expect(description).toContainText("No search, no extra credits");
});

test("the switch is operable from the keyboard alone", async ({ page }) => {
  await seedGuestConversation(page, "off");
  await open(page);
  await openTools(page);

  await toggle(page).focus();
  await expect(toggle(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
});

test("the state stays visible in the composer after the menu is dismissed", async ({
  page,
}) => {
  await seedGuestConversation(page, "off");
  await open(page);
  await openTools(page);
  await toggle(page).click();
  await page.keyboard.press("Escape");

  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveAttribute("data-tone", "neutral");

  // Turning it back off is one control away from the composer itself -- the
  // chip's own remove button -- so the round trip does not require the menu.
  await chip(page).getByRole("button", { name: "Turn off web search" }).click();
  await expect(chip(page)).toHaveCount(0);
  await openTools(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
});

test("no mid-draft offer to search appears in either state", async ({ page }) => {
  await seedGuestConversation(page, "off");
  await open(page);

  // Wording that used to raise the "auto" nudge: recency keywords plus an
  // explicit request for sources. Nothing may interrupt the draft now -- there
  // is no state for the nudge to switch the conversation into.
  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill("What is today's latest exchange rate, with sources?");
  await expect(page.getByTestId("web-search-auto-suggestion")).toHaveCount(0);

  await openTools(page);
  await toggle(page).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("web-search-auto-suggestion")).toHaveCount(0);
  await expect(chip(page)).toBeVisible();
});

test("a conversation stored as the retired auto mode opens with the switch off", async ({
  page,
}) => {
  await seedGuestConversation(page, "auto");
  await open(page);
  await expect(chip(page)).toHaveCount(0);
  await openTools(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
});

test("a conversation stored as always opens with the switch on", async ({ page }) => {
  await seedGuestConversation(page, "always");
  await open(page);
  await expect(chip(page)).toBeVisible();
  await openTools(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
});
