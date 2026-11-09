import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

for (const country of ["DE", "AU"]) {
  test(`Korean FAQ analytics purpose stays explicit in ${country}`, async ({ page, baseURL }, info) => {
    const mobile = info.project.name.includes("mobile");
    await page.setViewportSize({ width: mobile ? 320 : 1440, height: 900 });
    await prepareGuestPage(page, "ko");
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": country });
    await page.route("**/api/analytics/events", (route) => route.fulfill({ status: 202, body: "" }));
    await page.route("https://www.googletagmanager.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    await page.goto("/faq?lang=ko");
    const notice = page.getByTestId("chat-consent-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("프롬프트, 응답, 파일명 및 파일 내용", { useInnerText: true });
    await expect(notice).toContainText(country === "DE" ? "동의하면 기능 사용·유입 경로 통계를 수집해 Tomverse를 개선합니다." : "개인정보를 최소화한 제품 분석", { useInnerText: true });
    const accept = notice.getByTestId("analytics-consent-accept");
    await expect(accept).toHaveText(country === "DE" ? "사용 통계 허용" : "분석 유지");
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
