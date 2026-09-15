import { expect, test } from "@playwright/test";

import { prepareGuestPage } from "./support/app-fixtures";

// The page a consent confirmation link opens.
//
// Contract: docs/policy/email-double-opt-in.md §3 rule 4.
//
// Mail scanners and link previewers fetch URLs unprompted. A page that
// confirmed on load would turn that fetch into a consent nobody gave, so the
// thing pinned here is that opening the page sends nothing, and only the button
// does. The token rides in the URL fragment, which no server ever receives.

const TOKEN = "c1.v1.iv.ct.tag";

test("opening a confirmation link changes nothing until the button is pressed", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");

  const posts: string[] = [];
  let answer: { status: number; body: Record<string, unknown> } = {
    status: 200,
    body: { ok: true, purpose: "product_updates" },
  };
  await page.route(
    (url) => url.pathname === "/api/consent/confirm",
    async (route) => {
      posts.push(route.request().method() + " " + (route.request().postData() ?? ""));
      await route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify(answer.body),
      });
    }
  );

  await page.goto(`/consent/confirm#t=${encodeURIComponent(TOKEN)}`);
  const button = page.getByTestId("consent-confirm-button");
  await expect(button).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts).toEqual([]);

  // The token is taken out of the address bar once read.
  await expect.poll(() => page.url()).not.toContain("#t=");

  await button.click();
  await expect(page.getByTestId("consent-confirm-done")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toBe(`POST t=${encodeURIComponent(TOKEN)}`);

  // An expired link says so and points back to the settings screen.
  // A fresh document, as opening a second mailed link would be.
  answer = { status: 400, body: { code: "EXPIRED" } };
  await page.goto("about:blank");
  await page.goto(`/consent/confirm?again=1#t=${encodeURIComponent(TOKEN)}`);
  await page.getByTestId("consent-confirm-button").click();
  await expect(page.getByTestId("consent-confirm-error")).toContainText("expired");
});
