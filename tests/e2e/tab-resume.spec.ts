import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

const qaSession = {
  user: {
    id: "qa-user",
    name: "QA User",
    email: "qa@tomverse.app",
    image: null,
  },
  expires: "2099-01-01T00:00:00.000Z",
};

test("server response contains an immediate chat shell", async ({ request }) => {
  const response = await request.get("/chat");
  expect(response.ok()).toBeTruthy();
  expect(await response.text()).toContain('data-testid="chat-shell-skeleton"');
});

test("session revalidation preserves chat data without redundant reloads", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  const state = await mockAuthenticatedApi(page);
  await mockChatStream(page, "Tab resume response");

  await page.unroute("**/api/auth/session**");
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(qaSession),
    })
  );

  await page.goto("/chat");
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await page.getByTestId("chat-textarea").fill("Keep this message");
  await page.getByTestId("chat-textarea").press("Enter");
  await expect(page.getByText("Tab resume response", { exact: true })).toBeVisible();

  const conversationReads = state.conversationListReads;
  const settingsReads = state.userSettingsReads;
  const sessionResponse = page.waitForResponse((response) =>
    response.url().includes("/api/auth/session")
  );
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sessionResponse;

  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-shell-skeleton")).toBeHidden();
  await expect(page.getByText("Tab resume response", { exact: true })).toBeVisible();
  await expect.poll(() => state.conversationListReads).toBe(conversationReads);
  await expect.poll(() => state.userSettingsReads).toBe(settingsReads);
});
