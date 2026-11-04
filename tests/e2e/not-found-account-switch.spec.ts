import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * The 404 page's account-switch recovery, from the browser.
 *
 * `/admin/**` answers a visitor it will not serve with a 404 rather than a 403,
 * so nothing confirms the console exists. That left the page with no way to
 * change the one thing that could actually be wrong -- the account -- and a
 * plain link to sign-in could not fix it, because the sign-in page forwards an
 * already-authenticated visitor straight back to the 404 it came from.
 *
 * The session-clearing half of this runs in the admin suite
 * (`tests/e2e-admin/admin-access-control.spec.ts`), which has real sessions.
 * What is asserted here is the part this suite can see: which 404s offer the
 * recovery, and where the button sends the browser.
 *
 * The path used below is deliberately one no route matches, so the admin
 * layout never runs and the decision under test is the request path alone.
 */

const SWITCH_ACCOUNT_BUTTON = "Sign out and use another account";
const UNMATCHED_ADMIN_PATH = "/admin/unmatched/deep/path";

test("an unmatched URL is a 404 with somewhere to go, not a server error", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  const response = await page.goto("/this-route-does-not-exist");

  // This app has two root layouts, so an unmatched URL has none to compose
  // `app/not-found.tsx` with and Next answered every one of them with a 500
  // (`not-found.tsx doesn't have a root layout`). `app/global-not-found.tsx`
  // is the 404 that needs no layout; the status is the whole point of it.
  expect(response?.status()).toBe(404);
  // It renders its own document, so the stylesheet and the guide links are
  // the parts that go missing if that file stops being served.
  await expect(
    page.getByRole("link", { name: /help centre/i })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /contact support/i })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /couldn't find that page/i })
  ).toBeVisible();
  await expect(
    page.getByText("Nothing is wrong with your account")
  ).toBeVisible();
  // Nobody who mistyped a public URL is asked to end their session.
  await expect(
    page.getByRole("button", { name: SWITCH_ACCOUNT_BUTTON })
  ).toHaveCount(0);
  // The homepage stays the page's primary action there.
  await expect(page.getByRole("link", { name: /homepage/i })).toBeVisible();
});

test("/help reaches the help centre instead of an error", async ({ page }) => {
  await prepareGuestPage(page, "en");
  // The product calls it "Help" in the sidebar and the marketing nav, so
  // `/help` is the URL a visitor types; it was never a route, and before the
  // routing-level 404 it was one of the paths answering 500.
  const response = await page.goto("/help");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/support\/help-centre$/);
});

test("a 404 under /admin offers the account switch and keeps the destination", async ({
  page,
}) => {
  await prepareGuestPage(page, "en");
  const response = await page.goto(UNMATCHED_ADMIN_PATH);

  expect(response?.status()).toBe(404);
  await expect(
    page.getByText(
      "The link may be out of date, the page may have moved, or you may need to use a different account."
    )
  ).toBeVisible();
  // Nothing names the console, a role, or an allowlist.
  await expect(page.getByText(/admin console|administrat/i)).toHaveCount(0);

  const switchAccount = page.getByRole("button", {
    name: SWITCH_ACCOUNT_BUTTON,
  });
  await expect(switchAccount).toBeVisible();
  await switchAccount.focus();
  await expect(switchAccount).toBeFocused();
  await switchAccount.press("Enter");

  await expect(page).toHaveURL(
    `/auth/signin?callbackUrl=${encodeURIComponent(
      UNMATCHED_ADMIN_PATH
    )}&reason=switch-account`
  );
  await expect(page.getByTestId("signin-account-switch-notice")).toHaveText(
    "The previous session was ended. Choose an account to continue."
  );
  // The ordinary sign-in entry says nothing of the sort.
  await page.goto("/auth/signin?callbackUrl=%2Fchat");
  await expect(page.getByTestId("signin-account-switch-notice")).toHaveCount(0);
});

test("the request path the 404 reads cannot be supplied by the caller", async ({
  request,
  baseURL,
}) => {
  // proxy.ts *sets* both headers, so a caller-supplied value is overwritten
  // rather than merged. If it were ever trusted as sent, a crafted request
  // could point the button's callbackUrl wherever it liked.
  const response = await request.get(`${baseURL}/this-route-does-not-exist`, {
    headers: {
      "x-tomverse-pathname": "/admin/overview",
      "x-tomverse-search": "?next=https://evil.example",
    },
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(404);
  const html = await response.text();
  expect(html).not.toContain(SWITCH_ACCOUNT_BUTTON);
  expect(html).not.toContain("evil.example");
});
