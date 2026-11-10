import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

for (const country of ["DE", "AU"]) {
  test(`file-analysis analytics exclusions stay scoped in ${country}`, async ({ page, baseURL }, info) => {
    const mobile = info.project.name.includes("mobile");
    await page.setViewportSize({ width: mobile ? 320 : 1440, height: 900 });
    await prepareGuestPage(page, "en");
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": country });
    await page.route("**/api/analytics/events", (route) => route.fulfill({ status: 202, body: "" }));
    await page.route("https://www.googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.goto("/ai-for-file-analysis?lang=en");
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("Prompts, responses, filenames, and file contents are never included", { useInnerText: true });
    await expect(notice).toContainText(country === "DE" ? "measures product usage and campaign attribution" : "product analytics with a clear opt-out", { useInnerText: true });
    const accept = notice.getByTestId("analytics-consent-accept");
    await expect(accept).toHaveText(country === "DE" ? "Allow analytics" : "Keep analytics on");
    if (mobile) {
      const layout = await notice.evaluate(node => {
        const p = node.querySelector("p")!;
        const button = node.querySelector("button")!;
        return { bodyBottom: p.getBoundingClientRect().bottom, buttonTop: button.getBoundingClientRect().top, size: parseFloat(getComputedStyle(p).fontSize) };
      });
      expect(layout.size).toBeGreaterThanOrEqual(14);
      expect(layout.buttonTop).toBeGreaterThan(layout.bodyBottom);
    }
    await notice.getByTestId("analytics-consent-decline").click();
    await expect(notice).toBeHidden();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("tomverse_analytics_consent_v1"))).toBe("declined");
  });
}
