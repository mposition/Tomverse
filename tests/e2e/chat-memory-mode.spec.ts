import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
} from "./support/app-fixtures";

/**
 * §8.1 invariant 1 — the per-conversation memory control.
 *
 * The server side is covered by unit and DB suites. What only a browser can
 * show is the part that decides whether the control is usable: that a guest
 * is never offered it, that choosing a mode actually reaches the server as a
 * stored value, and that `inherit` says which way it currently points instead
 * of only that it follows something.
 */

const toolsMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(0);

const openMemoryMenu = async (page: Page) => {
  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-memory-row").click();
};

test("a saved conversation offers the memory control", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=en");
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toBeVisible();
});

test("a guest is not offered it at all", async ({ page }) => {
  // §8.1 invariant 2: a guest has no account memory for the control to act
  // on. Absent rather than disabled — a disabled control implies there is
  // something there to enable.
  await page.goto("/chat?lang=en");

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toHaveCount(0);
});

test("turning memory off for this conversation stores it as off", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=en");
  await openRecentConversation(page);

  await openMemoryMenu(page);
  await page.getByTestId("memory-mode-option-off").click();

  // The row reports the stored state, so this is also the assertion that the
  // PATCH round-tripped rather than the menu merely repainting itself.
  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toContainText(
    "Do not use in this conversation"
  );
});

test("inherit says which way the account default currently points", async ({
  page,
}) => {
  // "Follows your default" alone leaves a privacy control ambiguous: the user
  // cannot tell whether memory is on for this conversation.
  await mockAuthenticatedApi(page, { accountMemoryDefault: "off" });
  await page.goto("/chat?lang=en");
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toContainText(
    "not in use"
  );
});

test("an explicit choice survives a return to the conversation", async ({
  page,
}) => {
  // The stored value is what the menu reads on the way back in; a mode that
  // only lived in component state would silently revert.
  await mockAuthenticatedApi(page, { memoryMode: "off" });
  await page.goto("/chat?lang=en");
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toContainText(
    "Do not use in this conversation"
  );
});
