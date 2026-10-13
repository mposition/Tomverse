import { expect, test } from "@playwright/test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { LOCALIZED_MARKETING_BASE_PATHS } from "@/lib/marketingRoutes";
import { SEO_LOCALES, localizedPath } from "@/lib/seo";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

function expectSharedChrome(html: string, path: string) {
  const found = { header: 0, footer: 0 };
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const testId = node.attrs.find(attr => attr.name === "data-testid")?.value;
      if (node.tagName === "header" && testId === "launch-marketing-header") found.header++;
      if (node.tagName === "footer" && testId === "launch-marketing-footer") found.footer++;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(html));
  expect(found, `${path} must serve exactly one approved site header and footer`).toEqual({ header: 1, footer: 1 });
}

for (const language of SEO_LOCALES) {
  test(`${language}: every public site route serves the shared homepage chrome`, async ({ request }) => {
    for (const base of LOCALIZED_MARKETING_BASE_PATHS) {
      const path = localizedPath(language, base);
      await test.step(path, async () => {
        const response = await request.get(path);
        expect(response.status(), path).toBe(200);
        expectSharedChrome(await response.text(), path);
      });
    }
    for (const path of [
      `/guides/assistant-knowledge?lang=${language}`,
      `/status?lang=${language}`,
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expectSharedChrome(await response.text(), path);
    }
  });
}

test("English aliases and legal pages use the same site chrome", async ({ request }) => {
  for (const path of [...LOCALIZED_MARKETING_BASE_PATHS, "/terms", "/privacy", "/refund"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expectSharedChrome(await response.text(), path);
  }
});

test("status chrome preserves saved language and language changes reload the body", async ({ page }) => {
  await prepareGuestPage(page, "ko");
  await page.goto("/status");
  await expect(page).toHaveURL(url => url.pathname === "/status" && url.searchParams.get("lang") === "ko");
  await expect(page.locator("main")).toHaveAttribute("lang", "ko");
  const select = page.getByTestId("marketing-language-switcher");
  await expect(select).toHaveValue("ko");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tomverse_language"))).toBe("ko");
  await expect.poll(async () => (await page.context().cookies()).find(cookie => cookie.name === "tomverse_lang")?.value).toBe("ko");
  await select.selectOption("en");
  await expect(page).toHaveURL(url => url.pathname === "/status" && url.searchParams.get("lang") === "en");
  await expect(page.locator("main")).toHaveAttribute("lang", "en");
  await page.goBack();
  await expect(page).toHaveURL(url => url.pathname === "/status" && url.searchParams.get("lang") === "ko");
  await expect(page.locator("main")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("marketing-language-switcher")).toHaveValue("ko");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tomverse_language"))).toBe("ko");
  await expect.poll(async () => (await page.context().cookies()).find(cookie => cookie.name === "tomverse_lang")?.value).toBe("ko");
  await page.getByTestId("marketing-language-switcher").selectOption("en");
  await expect(page).toHaveURL(url => url.pathname === "/status" && url.searchParams.get("lang") === "en");
  // prepareGuestPage seeds its language on every document load. Use a separate
  // English fixture for the opposite preference instead of reseeding Korean.
  const englishPage = await page.context().newPage();
  try {
    await prepareGuestPage(englishPage, "en");
    await englishPage.setExtraHTTPHeaders({ "Accept-Language": "ko-KR,ko;q=0.9" });
    await englishPage.goto("/status");
    await expect(englishPage.locator("main")).toHaveAttribute("lang", "en");
    await expect(englishPage.getByTestId("marketing-language-switcher")).toHaveValue("en");
    await expect(englishPage.locator("html")).toHaveAttribute("lang", "en");
    await expect.poll(() => englishPage.evaluate(() => localStorage.getItem("tomverse_language"))).toBe("en");
    await expect.poll(async () => (await englishPage.context().cookies()).find(cookie => cookie.name === "tomverse_lang")?.value).toBe("en");
  } finally { await englishPage.close(); }
});

test("German pricing remains readable at 160px with enlarged text", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: 160, height: 900 });
  await page.goto("/de/pricing");
  await expect(page.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "unauthenticated");
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "html { font-size: 104% !important; }" });
  await expectNoHorizontalOverflow(page);
});

for (const width of [160, 320, 390, 1024, 1440]) {
  for (const language of SEO_LOCALES) {
    test(`${language}: pricing and models share readable chrome at ${width}px`, async ({ page }) => {
      await prepareGuestPage(page, "en");
      await page.setViewportSize({ width, height: 900 });
      for (const base of ["/pricing", "/models"]) {
        await page.goto(localizedPath(language, base));
        const header = page.getByTestId("launch-marketing-header");
        const footer = page.getByTestId("launch-marketing-footer");
        await expect(header).toHaveCount(1);
        await expect(footer).toHaveCount(1);
        await expect(header).toBeVisible();
        await expect(header.getByTestId("marketing-brand-name")).toHaveText("Tomverse");
        await expect(header.getByTestId("marketing-header-app-cta")).toHaveAttribute("data-session-state", "unauthenticated");
        await footer.scrollIntoViewIfNeeded();
        await expect(footer).toBeVisible();
        await expect(footer.locator("nav")).toHaveCount(4);
        for (const slug of ["compare-ai-models", "ai-answer-review", "chatgpt-vs-claude", "ai-for-file-analysis"]) {
          await expect(footer.locator(`a[href='${localizedPath(language, `/${slug}`)}']`)).toHaveCount(1);
        }
        await expectNoHorizontalOverflow(page);
        if (width < 1024) {
          await header.scrollIntoViewIfNeeded();
          const button = header.getByTestId("marketing-menu-button");
          await button.click();
          await expect(button).toHaveAttribute("aria-expanded", "true");
          await expect(header.getByTestId("mobile-review-link")).toHaveAttribute("href", localizedPath(language, "/products/review"));
          await expect(header.getByTestId("mobile-chat-link")).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(button).toHaveAttribute("aria-expanded", "false");
          await expect(button).toBeFocused();
        }
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`all public page families display the approved chrome at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      ...LOCALIZED_MARKETING_BASE_PATHS.map(base => localizedPath("ko", base)),
      "/terms?lang=ko", "/privacy?lang=ko", "/refund?lang=ko",
      "/guides/assistant-knowledge?lang=ko", "/status?lang=ko",
    ]) {
      await test.step(path, async () => {
        await page.goto(path);
        await expect(page.getByTestId("launch-marketing-header")).toBeVisible();
        const footer = page.getByTestId("launch-marketing-footer");
        await expect(footer).toHaveCount(1);
        await footer.scrollIntoViewIfNeeded();
        await expect(footer).toBeVisible();
      });
    }
  });
}
