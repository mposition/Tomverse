import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { restoreActiveConversation, suppressTransientUi } from "./support/chat-state-fixtures";
import { scoutPageLanguageMatches } from "../../lib/productResearchScoutBrowserPolicy.mjs";

test("an English account renders English Chat and consent despite a Korean guest preference", async ({ page, baseURL, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  await prepareGuestPage(page, "ko", "studio", "studio");
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: ["gpt-6-luna"], selectionMode: "auto", autoSelectionOffered: true, language: "en" });
  await restoreActiveConversation(page);
  await suppressTransientUi(page);
  await page.context().addCookies([
    { name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! },
    { name: "__tomverse_e2e_analytics", value: "1", url: baseURL! },
  ]);
  await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
  await page.route("**/api/products/chat/capabilities", route => route.fulfill({ json: { autoSelection: { offered: true } } }));
  await page.route("**/api/analytics/events", route => route.fulfill({ status: 202, body: "" }));
  await page.route("https://www.googletagmanager.com/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.goto("/chat?lang=ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "en", { timeout: 15_000 });
  await expect(page.getByTestId("chat-textarea")).toHaveAttribute("placeholder", /[A-Za-z]/);
  await expect(page.getByTestId("chat-textarea")).not.toHaveAttribute("placeholder", /[가-힣]/);
  await expect(page.getByRole("region", { name: "Privacy-safe product analytics" })).toBeVisible();
  const actual = await page.locator("html").getAttribute("lang");
  expect(scoutPageLanguageMatches("en", actual)).toBe(true);
  expect(scoutPageLanguageMatches("ko", actual)).toBe(false);
});
