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
