import { expect, test, type Page, type Route } from "@playwright/test";
import {
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

// ---------------------------------------------------------------------------
// The support form's email status updates consent.
//
// The form already requires an address for a written reply, so the consent
// defaults to on -- but it is a visible, revocable checkbox, and the payload
// carries exactly what the user chose. The success toast promises status
// emails only when consent was actually given.
//
// These run signed in: the support page's guest path verifies with the
// build-time NEXT_PUBLIC_TURNSTILE_SITE_KEY, which the E2E build does not
// bake in (the chat modal's guest flow, which resolves its key at request
// time, covers the guest Turnstile journey in feedback-modal.spec.ts).
// ---------------------------------------------------------------------------

type SupportRequest = {
  emailUpdates?: boolean;
  email?: string;
  language?: string;
};

async function mockFeedbackApi(page: Page) {
  const state: { requests: SupportRequest[] } = { requests: [] };
  await page.route("**/api/feedback", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as SupportRequest;
    state.requests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        feedbackId: "clzfeedback0002abcd",
        reference: "0002ABCD",
        emailUpdatesEnabled: body.emailUpdates === true,
      }),
    });
  });
  return state;
}

const fillSupportForm = async (page: Page) => {
  await page.getByLabel(/email address/i).fill("reporter@example.com");
  await page
    .getByLabel(/tell us what happened/i)
    .fill("The export button fails on the settings page.");
};

test.describe("support page email updates consent", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
    await page.goto("/support?lang=en");
  });

  test("consent is visible, on by default, and travels with the payload", async ({
    page,
  }) => {
    const feedback = await mockFeedbackApi(page);

    const consent = page.getByTestId("support-email-updates");
    await expect(consent).toBeVisible();
    await expect(consent).toBeChecked();
    await expect(page.getByTestId("support-email-updates-note")).toContainText(
      /status updates/i
    );

    await fillSupportForm(page);
    await page.getByTestId("support-submit").click();

    await expect
      .poll(() => feedback.requests.length, { timeout: 10_000 })
      .toBe(1);
    expect(feedback.requests[0].emailUpdates).toBe(true);
    expect(feedback.requests[0].email).toBe("reporter@example.com");
    expect(feedback.requests[0].language).toBe("en");

    const toast = page.getByTestId("app-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-tone", "success");
    await expect(toast).toContainText("0002ABCD");
    await expect(toast).toContainText(/receipt and status updates/i);
  });

  test("unchecking consent still submits, without promising emails", async ({
    page,
  }) => {
    const feedback = await mockFeedbackApi(page);

    await page.getByTestId("support-email-updates").uncheck();
    await fillSupportForm(page);
    await page.getByTestId("support-submit").click();

    await expect
      .poll(() => feedback.requests.length, { timeout: 10_000 })
      .toBe(1);
    expect(feedback.requests[0].emailUpdates).toBe(false);
    // The address still travels: the support team needs it for a written
    // reply, which is a different promise from automated status emails.
    expect(feedback.requests[0].email).toBe("reporter@example.com");

    const toast = page.getByTestId("app-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("0002ABCD");
    await expect(toast).not.toContainText(/status updates/i);
  });
});
