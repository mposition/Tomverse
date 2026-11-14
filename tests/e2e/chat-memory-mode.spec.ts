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
  page.getByTestId("composer-tools-button");

const openMemoryMenu = async (page: Page) => {
  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-memory-row").click();
};

test("a saved conversation offers the memory control", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/review?lang=en");
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toBeVisible();
});

test("a guest is not offered it at all", async ({ page }) => {
  // §8.1 invariant 2: a guest has no account memory for the control to act
  // on. Absent rather than disabled — a disabled control implies there is
  // something there to enable.
  await page.goto("/review?lang=en");

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toHaveCount(0);
});

test("turning memory off for this conversation stores it as off", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/review?lang=en");
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
  await page.goto("/review?lang=en");
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toContainText(
    "default (off)"
  );
});

for (const memoryMode of ["on", "inherit"] as const) {
  test(`account master off keeps the saved ${memoryMode} mode and exposes settings`, async ({ page }) => {
    const state = await mockAuthenticatedApi(page, { memoryMode });
    const methods: string[] = [];
    await page.route("**/api/memories/settings", (route) => {
      methods.push(route.request().method());
      return route.fulfill({ json: { masterEnabled: false, defaultConversationMode: "on" } });
    });
    await page.goto("/review?lang=en");
    await openRecentConversation(page);
    await toolsMenuTrigger(page).click();
    await expect(page.getByTestId("memory-account-status")).toContainText("Account memory is off");
    await expect(page.getByTestId("tools-memory-row")).toContainText(memoryMode === "on"
      ? "Use in this conversation" : "default (on)");
    expect(state.memoryMode).toBe(memoryMode);
    expect(methods.every((method) => method === "GET")).toBe(true);
    await page.getByTestId("tools-memory-row").click();
    await expect(page.getByTestId(`memory-mode-option-${memoryMode}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: "Open memory settings", exact: true })).toHaveAttribute("href", "/settings/memory");
  });
}

test("opening tools refreshes account permission and a failed response displays unknown", async ({ page }) => {
  const state = await mockAuthenticatedApi(page, { memoryMode: "on" });
  let status = 200;
  let masterEnabled = true;
  let reads = 0;
  await page.route("**/api/memories/settings", (route) => {
    reads += 1;
    return route.fulfill({ status, json: { masterEnabled, defaultConversationMode: "on" } });
  });
  await page.goto("/review?lang=en");
  await openRecentConversation(page);
  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("memory-account-status")).toContainText("Account settings permit memory");
  // The compact popover covers the trigger; use its supported dismissal path.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tools-memory-row")).toBeHidden();
  const before = reads;
  masterEnabled = false;
  await toolsMenuTrigger(page).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByTestId("memory-account-status")).toContainText("Account memory is off");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tools-memory-row")).toBeHidden();
  status = 503;
  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("memory-account-status")).toHaveText("Account memory settings are not confirmed.");
  await expect(page.getByTestId("tools-memory-row")).toContainText("Use in this conversation");
  expect(state.memoryMode).toBe("on");
});

test("a known assistant restriction is shown separately from the saved conversation mode", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    memoryMode: "on",
    assistantProfile: { profileId: "profile-no-memory", name: "QA assistant", icon: null,
      revision: 1, latestRevision: 1, status: "current", useAccountMemory: false },
  });
  await page.goto("/review?lang=en");
  await openRecentConversation(page);
  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("memory-account-status")).toHaveText("This assistant does not use account memory.");
  await expect(page.getByTestId("tools-memory-row")).toContainText("Use in this conversation");
});

test("an explicit choice survives a return to the conversation", async ({
  page,
}) => {
  // The stored value is what the menu reads on the way back in; a mode that
  // only lived in component state would silently revert.
  await mockAuthenticatedApi(page, { memoryMode: "off" });
  await page.goto("/review?lang=en");
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-memory-row")).toContainText(
    "Do not use in this conversation"
  );
});
