import { expect, test } from "@playwright/test";

import { prepareGuestPage } from "./support/app-fixtures";

// The unsubscribe link, as a recipient and as a mailbox provider reach it.
//
// Contract: docs/policy/email-notifications.md §11.3, §11.4; RFC 8058.
//
// Both halves were broken and nothing noticed. The page read its token from a
// server `searchParams` that the `force-static` marketing layout empties, so
// every link said "no longer valid". And the one-click POST went to the page,
// which answered 200 with HTML: a success to the provider, an unsubscribe for
// nobody. These run against the built app, because both failures lived in how
// the framework routes a request rather than in any function a unit test calls.

const TOKEN = "u1.v1.iv.ct.tag";

test("the page reads the token from the link and posts it only when pressed @ui-risk", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");

  const posts: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/unsubscribe",
    async (route) => {
      posts.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, scope: "purpose" }),
      });
    }
  );

  await page.goto(`/unsubscribe?t=${encodeURIComponent(TOKEN)}`);
  const main = page.locator("main");
  await expect(main.getByRole("button").first()).toBeVisible();
  await expect(main).not.toContainText("no longer valid");
  await page.waitForLoadState("networkidle");
  expect(posts).toEqual([]);

  await main.getByRole("button").first().click();
  await expect.poll(() => posts.length).toBe(1);
  expect(new URLSearchParams(posts[0]).get("t")).toBe(TOKEN);
});

test("a link with no token says so instead of offering a button @ui-risk", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/unsubscribe");
  await expect(page.locator("main")).toContainText("no longer valid");
  await expect(page.locator("main").getByRole("button")).toHaveCount(0);
});

test("the RFC 8058 one-click POST to the header URL reaches the unsubscribe route @ui-risk", async ({
  request,
}) => {
  // Sent the way a mailbox provider sends it: to the List-Unsubscribe URL
  // itself, as a form body, with no Origin. What matters here is where it
  // lands. The route's JSON answer (an invalid token here) proves it reached
  // the handler; the page would have answered with an HTML document.
  const response = await request.post(`/unsubscribe?t=${encodeURIComponent(TOKEN)}`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: "List-Unsubscribe=One-Click",
    maxRedirects: 0,
  });
  expect(response.headers()["content-type"] ?? "").toContain("application/json");
  expect(response.status()).not.toBe(200);
});
