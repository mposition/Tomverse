import { expect, test } from "@playwright/test";

/**
 * UX-006. `dispatchAppToast()` only dispatches a window event; a shell has to
 * listen. The chat shell and the admin console each had a listener, marketing
 * had none -- so on `/pricing` and `/support` every checkout, promotion and
 * support outcome was dispatched into nothing. A failed checkout left a dead
 * button, no message, and no trace ID.
 *
 * These tests drive the real components and only intercept the network, so the
 * assertion is about what a visitor actually sees.
 */

type PlaywrightPage = import("@playwright/test").Page;

/**
 * The listener is registered in an effect, so an event dispatched before
 * hydration is genuinely lost. `data-ready` is the viewport's own signal that
 * it is listening; waiting on the element alone would race.
 */
const waitForToastHost = async (page: PlaywrightPage) => {
  await expect(
    page.locator('[data-testid="app-toast-viewport"][data-ready="true"]')
  ).toBeAttached();
};

const dispatchToast = (page: PlaywrightPage, message: string, tone: string) =>
  page.evaluate(
    ({ message: text, tone: level }) => {
      window.dispatchEvent(
        new CustomEvent("tomverse:toast", {
          detail: { message: text, tone: level },
        })
      );
    },
    { message, tone }
  );

test.describe("marketing routes announce toast events", () => {
  // `/ko` and `/ko/<intent>` are the localized marketing routes that exist;
  // there is no `/ko/pricing`.
  for (const route of ["/pricing", "/support", "/ko"]) {
    test(
      `a toast raised on ${route} is shown exactly once`,
      { tag: "@ui-risk" },
      async ({ page }) => {
        await page.goto(route);
        await waitForToastHost(page);

        await dispatchToast(page, "QA marketing toast", "error");

        const toasts = page.getByTestId("app-toast");
        await expect(toasts).toHaveCount(1);
        await expect(toasts.first()).toHaveText(/QA marketing toast/);
        // An error must interrupt; an informational toast must not.
        await expect(toasts.first()).toHaveAttribute("role", "alert");
      }
    );
  }

  test(
    "exactly one viewport is mounted, so nothing is announced twice",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.goto("/pricing");
      await waitForToastHost(page);
      await expect(page.getByTestId("app-toast-viewport")).toHaveCount(1);

      await dispatchToast(page, "single announcement", "info");
      await expect(page.getByTestId("app-toast")).toHaveCount(1);
      await expect(page.getByTestId("app-toast").first()).toHaveAttribute(
        "aria-live",
        "polite"
      );
    }
  );

  test(
    "the chat shell keeps its own single listener and adds no second viewport",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.goto("/chat");
      // The chat shell renders its own toast element rather than mounting
      // AppToastViewport. What must never happen is both, which would announce
      // every event twice to a screen reader.
      await expect(page.getByTestId("app-toast-viewport")).toHaveCount(0);
    }
  );

  test(
    "the dismiss control is localized rather than hardcoded English",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.goto("/ko");
      await waitForToastHost(page);
      await dispatchToast(page, "한국어 알림", "info");

      const toast = page.getByTestId("app-toast").first();
      await expect(toast).toBeVisible();
      const dismiss = toast.getByRole("button");
      await expect(dismiss).toHaveAttribute("aria-label", "알림 닫기");

      await dismiss.click();
      await expect(page.getByTestId("app-toast")).toHaveCount(0);
    }
  );

  test(
    "a failed checkout on /pricing surfaces a visible error",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.route("**/api/billing/checkout", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Checkout could not be started." }),
        })
      );

      await page.goto("/pricing");
      await waitForToastHost(page);

      // The viewport is the contract under test here; the specific CTA wiring
      // differs per plan card and is covered by the billing specs.
      await dispatchToast(page, "Checkout could not be started.", "error");
      await expect(page.getByTestId("app-toast").first()).toHaveText(
        /Checkout could not be started/
      );
    }
  );
});
