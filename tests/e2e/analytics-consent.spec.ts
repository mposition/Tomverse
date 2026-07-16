import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("mobile analytics consent stays compact with one-row actions", async ({
  page,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile"),
    "Mobile consent layout only runs in mobile projects."
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.route("**/api/analytics/events", (route) =>
    route.fulfill({ status: 202, body: "" })
  );
  await page.goto("/");

  const banner = page.getByRole("dialog", {
    name: "Privacy-safe product analytics",
  });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "Help improve Tomverse. Prompts and file contents are never collected."
  );

  const decline = banner.getByRole("button", { name: "Decline" });
  const accept = banner.getByRole("button", { name: "Allow analytics" });
  const [bannerBox, declineBox, acceptBox] = await Promise.all([
    banner.boundingBox(),
    decline.boundingBox(),
    accept.boundingBox(),
  ]);

  expect(bannerBox).not.toBeNull();
  expect(declineBox).not.toBeNull();
  expect(acceptBox).not.toBeNull();
  expect(bannerBox!.height).toBeLessThanOrEqual(80);
  expect(Math.abs(declineBox!.y - acceptBox!.y)).toBeLessThanOrEqual(1);
  expect(declineBox!.x + declineBox!.width).toBeLessThan(acceptBox!.x);

  await accept.click();
  await expect(banner).toBeHidden();
});

test("Australia starts privacy-minimized analytics with an immediate opt-out", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Regional consent behavior is covered once in desktop Chromium."
  );

  let analyticsEvents = 0;
  await prepareGuestPage(page, "en");
  await page.context().addCookies([
    {
      name: "_ga",
      value: "GA1.1.123.456",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.route("**/api/analytics/consent-policy", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ country: "AU", mode: "notice_opt_out" }),
    })
  );
  await page.route("**/api/analytics/events", (route) => {
    analyticsEvents += 1;
    return route.fulfill({ status: 202, body: "" });
  });
  await page.goto("/?utm_source=regional-qa");

  const notice = page.getByRole("dialog", {
    name: "Privacy-safe analytics is on",
  });
  await expect(notice).toBeVisible();
  await expect.poll(() => analyticsEvents).toBeGreaterThan(0);

  await notice.getByRole("button", { name: "Turn off analytics" }).click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("tomverse_analytics_consent_v1")
      )
    )
    .toBe("declined");
  await expect
    .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === "_ga"))
    .toBe(false);
});

test("UK visitors do not load GA4 before explicit consent", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Regional consent behavior is covered once in desktop Chromium."
  );

  let analyticsEvents = 0;
  await prepareGuestPage(page, "en");
  await page.route("**/api/analytics/consent-policy", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ country: "GB", mode: "opt_in" }),
    })
  );
  await page.route("**/api/analytics/events", (route) => {
    analyticsEvents += 1;
    return route.fulfill({ status: 202, body: "" });
  });

  await page.goto("/");
  const banner = page.getByRole("dialog", {
    name: "Privacy-safe product analytics",
  });
  await expect(banner).toBeVisible();
  expect(analyticsEvents).toBe(0);

  await banner.getByRole("button", { name: "Allow analytics" }).click();
  await expect.poll(() => analyticsEvents).toBeGreaterThan(0);
});
