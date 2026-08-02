import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage, mockPublicProofMetrics } from "./support/app-fixtures";

/**
 * RECON-I18N-001. The localized marketing routes have their own root layout, so
 * switching language away from an English page crosses a root boundary and
 * reloads the document -- measured at ~2x, and 2.6s slower on a mid-tier phone
 * over 4G (.github/audits/ko-root-language-2026-07-29.md). Keeping that cost
 * was decided on the argument that the path is rare, and nothing was measuring
 * whether that is true.
 *
 * This event is the missing input, and what these tests hold is that it reports
 * the switch correctly on both sides of that boundary -- `navigation` is the
 * field the frequency argument turns on, so a switch classified as "client"
 * when it in fact reloaded would answer the wrong question.
 *
 * They deliberately do *not* claim to hold the `keepalive` delivery. Route
 * interception observes a request when it is issued, and a request issued
 * without `keepalive` is still issued -- the cancellation happens afterwards.
 * Verified: flipping the flag off leaves both tests below green. That property
 * is asserted in tests/productAnalyticsDelivery.test.mjs instead, where it
 * fails when the flag is dropped.
 */

const EVENTS_ROUTE = "**/api/analytics/events";

type Captured = { event_name: string; properties: Record<string, unknown> };

/**
 * Consent is granted in localStorage before the first document rather than by
 * clicking the notice: an unconfigured analytics client does not drop an event,
 * it queues it in sessionStorage and flushes on the next configure. A test that
 * raced the notice would therefore still see the event arrive -- one document
 * later, from the queue -- and would report the wrong thing about when it was
 * sent.
 *
 * Call this *after* `prepareGuestPage`: init scripts run in registration order
 * and that fixture resets local storage, so consent granted before it is wiped.
 */
async function captureAnalytics(page: Page): Promise<Captured[]> {
  const captured: Captured[] = [];
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
    window.sessionStorage.removeItem("tomverse_analytics_pending_events_v1");
  });
  await page.route(EVENTS_ROUTE, async (route) => {
    try {
      const body = route.request().postDataJSON() as Captured;
      if (body?.event_name) captured.push(body);
    } catch {
      /* a malformed body is the assertion's problem, not the route's */
    }
    // The switch's own request is in flight across a document navigation, so
    // its frame may be gone by the time the handler runs; the capture above
    // is what the assertions read either way.
    await route.fulfill({ status: 202, body: "" }).catch(() => {});
  });
  return captured;
}

// The client only sends once `configureAnalyticsClient` has run, which waits on
// the consent-policy fetch. Until then events sit in the pending queue.
async function waitForAnalyticsClient(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.sessionStorage.getItem("tomverse_analytics_session_v1") !== null
        ),
      { message: "the analytics client never configured itself" }
    )
    .toBe(true);
}

test("switching to a localized route reports the switch and that it reloaded", {
  tag: "@ui-risk",
}, async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Analytics delivery does not depend on the viewport; covered once."
  );
  await prepareGuestPage(page, "en");
  await mockPublicProofMetrics(page);
  const captured = await captureAnalytics(page);
  await page.goto("/?lang=en");
  await expect(page.getByTestId("landing-hero-title")).toBeVisible();
  await waitForAnalyticsClient(page);

  await page.getByTestId("marketing-language-switcher").selectOption("ko");
  // The destination is a different root layout, so this is a document load.
  await page.waitForURL((url) => url.pathname === "/ko");
  await expect(page.getByTestId("landing-hero-title")).toBeVisible();

  await expect
    .poll(() => captured.filter((e) => e.event_name === "marketing_language_switched").length, {
      message: "the switch event did not survive the document navigation",
    })
    .toBeGreaterThan(0);

  const event = captured.find((e) => e.event_name === "marketing_language_switched")!;
  expect(event.properties.language_from).toBe("en");
  expect(event.properties.language_to).toBe("ko");
  expect(
    event.properties.navigation,
    "this switch crossed the root boundary, which is the cost being measured"
  ).toBe("document");
});

test("a switch that stays in the same document reports itself as a client one", {
  tag: "@ui-risk",
}, async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Analytics delivery does not depend on the viewport; covered once."
  );
  await prepareGuestPage(page, "en");
  await mockPublicProofMetrics(page);
  const captured = await captureAnalytics(page);
  // /pricing has no localized variant, so the switcher does not navigate.
  await page.goto("/pricing?lang=en");
  await waitForAnalyticsClient(page);

  await page.getByTestId("marketing-language-switcher").selectOption("ko");

  await expect
    .poll(() => captured.filter((e) => e.event_name === "marketing_language_switched").length)
    .toBeGreaterThan(0);
  const event = captured.find((e) => e.event_name === "marketing_language_switched")!;
  expect(event.properties.navigation).toBe("client");
  expect(event.properties.language_to).toBe("ko");
  expect(new URL(page.url()).pathname).toBe("/pricing");
});
