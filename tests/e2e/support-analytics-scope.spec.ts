import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

for (const country of ["DE", "AU"]) {
  test(`support analytics exclusions stay scoped in ${country}`, async ({ page, baseURL }, info) => {
    const mobile = info.project.name.includes("mobile");
    await page.setViewportSize({ width: mobile ? 320 : 1440, height: 900 });
    await prepareGuestPage(page, "en");
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": country });
    await page.route("**/api/analytics/events", (route) => route.fulfill({ status: 202, body: "" }));
    await page.route("https://www.googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.goto("/support?lang=en");
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    if (mobile) {
      await expect(notice).toContainText(country === "DE" ? "Usage analytics excludes prompts and file content." : "Usage analytics is on; prompts and file content are excluded.", { useInnerText: true });
    } else {
      await expect(notice).toContainText("Prompts, responses, filenames, and file contents are never included", { useInnerText: true });
    }
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toBeHidden();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("tomverse_analytics_consent_v1"))).toBe("declined");
  });
}
