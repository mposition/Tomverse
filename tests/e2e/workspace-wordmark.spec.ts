import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

test.use({ hasTouch: true });

async function expectWordmark(page: Page, scope: Locator) {
  const wordmark = scope.getByTestId("tomverse-wordmark");
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveText("tomverse.");
  await page.evaluate(() => document.fonts.ready);
  const bodyFamily = await page.locator("body").evaluate(
    (node) => getComputedStyle(node).fontFamily
  );
  const style = await wordmark.evaluate((node) => {
    const computed = getComputedStyle(node);
    return {
      family: computed.fontFamily,
      size: computed.fontSize,
      weight: computed.fontWeight,
      spacing: computed.letterSpacing,
      dotGap: getComputedStyle(node.lastElementChild!).marginLeft,
    };
  });
  expect(style).toEqual({
    family: '"Tomverse Wordmark", sans-serif',
    size: "24px",
    weight: "650",
    spacing: "-1px",
    dotGap: "1px",
  });
  expect(bodyFamily).not.toContain("Tomverse Wordmark");
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument");
    const { nodeId } = await client.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-testid="${await scope.getAttribute("data-testid")}"] [data-testid="tomverse-wordmark"]`,
    });
    const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.filter((font) => font.glyphCount > 0)).toEqual([
      expect.objectContaining({ familyName: "Roboto", isCustomFont: true }),
    ]);
  } finally {
    await client.detach();
  }
  return wordmark;
}

for (const product of ["chat", "review"] as const) {
  for (const lang of ["en", "ko", "zh"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${product} wordmark uses the shared brand font with ${lang} UI in ${theme} on desktop and mobile`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium project exercises both layouts.");
        await prepareGuestPage(page, lang);
        const account = await mockAuthenticatedApi(page, { productKey: product });
        account.theme = theme;
        await setDeterministicTheme(page, theme);
        await page.context().addCookies([{
          name: "__tomverse_e2e_chat_workspace",
          value: "1",
          url: "http://127.0.0.1:3100",
        }]);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`/${product}?lang=${lang}`);
        await expect(page.locator("html")).toHaveAttribute("lang", lang);
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await expectWordmark(page, page.getByTestId("chat-sidebar"));
        if (lang === "ko") await page.screenshot({ path: testInfo.outputPath("desktop.png") });
        const bodyTypography = await page.locator("body").evaluate((node) => {
          const style = getComputedStyle(node);
          return { family: style.fontFamily, weight: style.fontWeight };
        });

        await page.setViewportSize({ width: 320, height: 568 });
        const header = page.getByTestId("mobile-chat-header");
        const wordmark = await expectWordmark(page, header);
        await expect(page.getByTestId("mobile-header-model-summary")).toBeVisible();
        const mark = await wordmark.boundingBox();
        const menu = await page.getByTestId("mobile-sidebar-open").boundingBox();
        const model = await page.getByTestId("mobile-header-model-summary").boundingBox();
        expect(mark).not.toBeNull();
        expect(menu).not.toBeNull();
        expect(model).not.toBeNull();
        expect(mark!.x).toBeGreaterThanOrEqual(menu!.x + menu!.width);
        expect(mark!.x + mark!.width).toBeLessThanOrEqual(model!.x + 0.5);
        await expectNoHorizontalOverflow(page);
        expect(await page.locator("body").evaluate((node) => {
          const style = getComputedStyle(node);
          return { family: style.fontFamily, weight: style.fontWeight };
        })).toEqual(bodyTypography);
        await expect(page.getByTestId("chat-textarea")).toHaveCSS("font-weight", "400");
        if (lang === "ko") await page.screenshot({ path: testInfo.outputPath("mobile.png") });

        await page.getByTestId("mobile-sidebar-open").click();
        await expectWordmark(page, page.getByTestId("mobile-sidebar-drawer"));
        await expectNoHorizontalOverflow(page);
      });
    }
  }
}
