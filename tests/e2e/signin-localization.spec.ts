import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/app-fixtures";

// UI-P2-02: the sign-in screen used to render its terms/privacy consent
// notice twice (once above the OAuth buttons, once again in a footer card),
// and the footer copy ("Terms and Conditions" / "Review the terms before
// continuing.") was hardcoded in English so it leaked into every locale.
// These tests pin down the fixed, single-block behavior per locale.

const HANGUL_RE = /[가-힣]/;

async function gotoSignIn(
  page: Page,
  lang: string,
  callbackUrl = "/chat"
) {
  await page.route("**/api/auth/session**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    })
  );
  await page.addInitScript((l) => {
    window.localStorage.clear();
    window.localStorage.setItem("tomverse_language", l);
  }, lang);
  await page.goto(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
}

test.describe("sign-in legal consent localization", () => {
  test("Korean sign-in shows exactly one consent block with no English leakage", async ({
    page,
  }) => {
    await gotoSignIn(page, "ko");
    const card = page.getByTestId("signin-card");

    await expect(
      card.getByText("Terms and Conditions", { exact: true })
    ).toHaveCount(0);
    await expect(
      card.getByText("Review the terms before continuing.", { exact: true })
    ).toHaveCount(0);

    // The one consent sentence, present exactly once (it shares a <p> with
    // the trailing links, so match it as a substring rather than exact text).
    await expect(
      card.getByText(
        "로그인하면 Tomverse의 서비스 이용약관과 개인정보 처리방침에 동의하게 됩니다."
      )
    ).toHaveCount(1);

    const termsLink = card.getByRole("link", { name: "이용약관", exact: true });
    await expect(termsLink).toHaveCount(1);
    await expect(termsLink).toHaveAttribute("href", "/terms");

    const privacyLink = card.getByRole("link", {
      name: "개인정보 처리방침",
      exact: true,
    });
    await expect(privacyLink).toHaveCount(1);
    await expect(privacyLink).toHaveAttribute("href", "/privacy");

    // Count by destination URL too, matching the ticket's own acceptance
    // criteria ("/terms exactly once, /privacy exactly once").
    await expect(card.locator('a[href="/terms"]')).toHaveCount(1);
    await expect(card.locator('a[href="/privacy"]')).toHaveCount(1);
  });

  test("the exact reported URL (/auth/signin?lang=ko) has singular terms/privacy links", async ({
    page,
  }) => {
    await page.route("**/api/auth/session**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "null" })
    );
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
    await page.goto("/auth/signin?lang=ko");
    await expect(page.locator("html")).toHaveAttribute("lang", "ko");

    const card = page.getByTestId("signin-card");
    await expect(card.locator('a[href="/terms"]')).toHaveCount(1);
    await expect(card.locator('a[href="/privacy"]')).toHaveCount(1);
    await expect(
      card.getByText("Terms and Conditions", { exact: true })
    ).toHaveCount(0);
    await expect(
      card.getByText("Review the terms before continuing.", { exact: true })
    ).toHaveCount(0);
  });

  test("English sign-in shows exactly one natural consent block with no Korean leakage", async ({
    page,
  }) => {
    await gotoSignIn(page, "en");
    const card = page.getByTestId("signin-card");

    const bodyText = await page.locator("body").innerText();
    expect(HANGUL_RE.test(bodyText)).toBe(false);

    await expect(
      card.getByText(
        "By logging in, you agree to Tomverse's Terms of Service and Privacy Policy."
      )
    ).toHaveCount(1);

    const termsLink = card.getByRole("link", {
      name: "Terms and Conditions",
      exact: true,
    });
    await expect(termsLink).toHaveCount(1);
    await expect(termsLink).toHaveAttribute("href", "/terms");

    const privacyLink = card.getByRole("link", {
      name: "Privacy Policy",
      exact: true,
    });
    await expect(privacyLink).toHaveCount(1);
    await expect(privacyLink).toHaveAttribute("href", "/privacy");
  });

  test("a third supported locale (German) has its own translation with no Korean/English leakage or duplication", async ({
    page,
  }) => {
    await gotoSignIn(page, "de");
    const card = page.getByTestId("signin-card");

    const bodyText = await card.innerText();
    expect(HANGUL_RE.test(bodyText)).toBe(false);
    expect(bodyText).not.toContain("이용약관");
    expect(bodyText).not.toContain("개인정보 처리방침");
    expect(bodyText).not.toContain("Review the terms before continuing.");

    const termsLink = card.getByRole("link", {
      name: "Nutzungsbedingungen",
      exact: true,
    });
    await expect(termsLink).toHaveCount(1);
    await expect(termsLink).toHaveAttribute("href", "/terms");

    const privacyLink = card.getByRole("link", {
      name: "Datenschutzerklärung",
      exact: true,
    });
    await expect(privacyLink).toHaveCount(1);
    await expect(privacyLink).toHaveAttribute("href", "/privacy");
  });

  test("auth affordances, callback URL, and email validation regress cleanly", async ({
    page,
  }) => {
    await gotoSignIn(page, "en", "/chat?foo=bar");

    await expect(
      page.getByRole("button", { name: "Continue with Google" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Microsoft" })
    ).toBeVisible();

    const emailInput = page.getByPlaceholder("you@example.com");
    await expect(emailInput).toBeVisible();
    const sendCodeButton = page.getByRole("button", {
      name: "Get login code",
    });
    await expect(sendCodeButton).toBeDisabled();

    await emailInput.fill("not-an-email");
    await emailInput.blur();
    await expect(
      page.getByText("Enter a valid email address.", { exact: true })
    ).toBeVisible();
    await expect(sendCodeButton).toBeDisabled();

    // Clicking the legal links must not start any auth request or navigate
    // the sign-in tab away from itself -- they open the legal docs in a new
    // tab and the callback URL stays intact underneath.
    let authRequestFired = false;
    await page.route("**/api/auth/**", (route) => {
      authRequestFired = true;
      return route.continue();
    });
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page
        .getByTestId("signin-card")
        .getByRole("link", { name: "Terms and Conditions" })
        .click(),
    ]);
    await popup.close();
    expect(authRequestFired).toBe(false);
    await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=/);
    expect(page.url()).toContain(encodeURIComponent("/chat?foo=bar"));
  });

  test("responsive: no overflow and no duplicated legal links at 320x568, 390x844, and 1440x900", async ({
    page,
  }) => {
    await gotoSignIn(page, "ko");
    const card = page.getByTestId("signin-card");

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expectNoHorizontalOverflow(page);
      await expect(
        card.getByRole("link", { name: "이용약관", exact: true })
      ).toHaveCount(1);
      await expect(
        card.getByRole("link", { name: "개인정보 처리방침", exact: true })
      ).toHaveCount(1);
    }
  });

  test("renders without duplication in light and dark theme", async ({
    page,
  }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await gotoSignIn(page, "ko");
      const card = page.getByTestId("signin-card");
      await expect(
        card.getByRole("link", { name: "이용약관", exact: true })
      ).toHaveCount(1);
      await expect(
        card.getByRole("link", { name: "개인정보 처리방침", exact: true })
      ).toHaveCount(1);
    }
  });

  test("the sign-in card's terms/privacy links stay singular and separate from the analytics consent banner", async ({
    page,
  }) => {
    // UI-P1-02's analytics consent banner also links to /privacy. It is a
    // different feature (cookie/opt-out notice, not legal sign-in consent)
    // and must never be merged with, or counted as part of, the sign-in
    // card's own terms/privacy block.
    await page.context().addCookies([
      { name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" },
    ]);
    await gotoSignIn(page, "ko");

    const card = page.getByTestId("signin-card");
    await expect(
      card.getByRole("link", { name: "이용약관", exact: true })
    ).toHaveCount(1);
    await expect(
      card.getByRole("link", { name: "개인정보 처리방침", exact: true })
    ).toHaveCount(1);

    const banner = page.getByTestId("chat-consent-notice");
    if (await banner.count()) {
      // The banner is a sibling overlay, not part of the sign-in card, and
      // may carry its own separate privacy link -- that's expected and must
      // not be conflated with the card's single privacy link above.
      await expect(card).not.toContainText(await banner.innerText());
    }
  });
});
