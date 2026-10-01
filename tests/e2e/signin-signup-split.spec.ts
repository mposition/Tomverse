import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/app-fixtures";

// Sign-in and sign-up are separate screens
// (docs/policy/email-product-news-redesign-draft.md section 5.2a, v25). The
// sign-in screen never shows the consent devices and links to sign-up; the
// sign-up screen links back; a provider sign-in with no account lands on
// sign-up with a notice that names only a provider it knows.

async function gotoAuth(page: Page, path: string, lang = "en") {
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" })
  );
  await page.addInitScript((l) => {
    window.localStorage.clear();
    window.localStorage.setItem("tomverse_language", l);
  }, lang);
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  return page.getByTestId("signin-card");
}

test.describe("sign-in and sign-up are separate screens", () => {
  test("sign-in shows no consent devices and links to sign-up with the destination", async ({
    page,
  }) => {
    const card = await gotoAuth(page, "/auth/signin?callbackUrl=%2Fpricing");
    await expect(card.getByTestId("signup-consent-devices")).toHaveCount(0);
    await expect(card.getByText("Log in to your personal AI chat hub")).toHaveCount(1);
    const toSignup = card.getByTestId("signin-to-signup-link");
    await expect(toSignup).toHaveText("Sign up");
    const href = await toSignup.getAttribute("href");
    const url = new URL(href ?? "", "http://localhost");
    expect(url.pathname).toBe("/auth/signup");
    expect(url.searchParams.get("callbackUrl")).toContain("/pricing");
  });

  test("sign-up links back to sign-in and says what it is for", async ({ page }) => {
    const card = await gotoAuth(page, "/auth/signup");
    await expect(
      card.getByText("Create an account to start your personal AI chat hub")
    ).toHaveCount(1);
    await expect(card.getByTestId("signup-to-signin-link")).toHaveText("Log in");
    await expect(card.getByTestId("signin-to-signup-link")).toHaveCount(0);
    // The legal links stay singular on this screen too.
    await expect(card.locator('a[href="/terms"]')).toHaveCount(1);
    await expect(card.locator('a[href="/privacy"]')).toHaveCount(1);
  });

  test("a provider sign-in with no account lands on sign-up with the provider named", async ({
    page,
  }) => {
    const card = await gotoAuth(page, "/auth/signup?notice=no_account&provider=google");
    await expect(card.getByTestId("signup-no-account-notice")).toContainText(
      "There is no account for this Google account"
    );
  });

  test("the notice names nothing it does not know", async ({ page }) => {
    const card = await gotoAuth(page, "/auth/signup?notice=no_account&provider=evil");
    await expect(card.getByTestId("signup-no-account-notice")).toHaveCount(0);
    // And never on the sign-in screen.
    const signin = await gotoAuth(page, "/auth/signin?notice=no_account&provider=google");
    await expect(signin.getByTestId("signup-no-account-notice")).toHaveCount(0);
  });

  test("Korean copy on both screens", async ({ page }) => {
    const signin = await gotoAuth(page, "/auth/signin?lang=ko", "ko");
    await expect(signin.getByText("아직 회원이 아니신가요?")).toHaveCount(1);
    await expect(signin.getByTestId("signin-to-signup-link")).toHaveText("회원가입");
    const signup = await gotoAuth(page, "/auth/signup?lang=ko", "ko");
    await expect(signup.getByText("이미 회원이신가요?")).toHaveCount(1);
    await expect(signup.getByTestId("signup-to-signin-link")).toHaveText("로그인");
  });

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    test(`no horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await gotoAuth(page, "/auth/signup?notice=no_account&provider=azure-ad");
      await expectNoHorizontalOverflow(page);
      await gotoAuth(page, "/auth/signin");
      await expectNoHorizontalOverflow(page);
    });
  }
});
