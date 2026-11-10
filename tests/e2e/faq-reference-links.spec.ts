import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test("Korean FAQ answers expose working credit safety and privacy references", async ({ page, baseURL, isMobile }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  await prepareGuestPage(page, "ko");
  await page.goto("/faq?lang=ko");
  // Phones collapse FAQ answers behind toggles (#3602, #3608); open them all.
  await expect(page.getByRole("article").first()).toBeVisible({ timeout: 30_000 });
  for (const article of await page.getByRole("article").all()) {
    const toggle = article.getByRole("button");
    if (!(await toggle.isVisible())) continue;
    // A click before hydration is lost, so retry until the answer opens.
    await expect(async () => {
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  }
  const answers = page.getByRole("article");
  for (const [label, path] of [["모델별 크레딧 확인", "/models"], ["안전한 데이터 처리", "/safety/security-privacy"], ["개인정보 처리방침", "/privacy"]]) {
    const link = answers.getByRole("link", { name: label, exact: true });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
    await link.focus();
    await expect(link).toBeFocused();
    const target = new URL((await link.getAttribute("href"))!, baseURL!);
    expect(target.origin).toBe(new URL(baseURL!).origin);
    expect(target.pathname.endsWith(path)).toBe(true);
    expect((await page.request.get(`${target.pathname}${target.search}`)).status()).toBe(200);
  }
  const fileAnswer = answers.filter({ has: page.getByRole("link", { name: "안전한 데이터 처리", exact: true }) });
  const related = fileAnswer.getByRole("link");
  await expect(related).toHaveCount(2);
  expect(await related.evaluateAll(links => {
    const [a, b] = links.map(link => link.getBoundingClientRect());
    return a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
  })).toBe(true);
  await expectNoHorizontalOverflow(page);
});
