import { expect, test } from "@playwright/test";

const bodyFamilies = {
  en: /system-ui.*Segoe UI/,
  ko: /Noto Sans KR.*Apple SD Gothic Neo.*Malgun Gothic/,
  zh: /Noto Sans SC.*PingFang SC.*Microsoft YaHei/,
};

for (const lang of ["en", "ko", "zh"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`bundled wordmark keeps ${lang} body fonts in ${theme}`, async ({ page, browserName }) => {
      const externalFonts: string[] = [];
      page.on("request", (request) => {
        if (request.resourceType() === "font" && new URL(request.url()).origin !== "http://127.0.0.1:5186") {
          externalFonts.push(request.url());
        }
      });
      await page.addInitScript(({ lang, theme }) => {
        localStorage.setItem("tomverse-language", lang);
        localStorage.setItem("tomverse-theme", theme);
      }, { lang, theme });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const wordmark = page.locator(".wordmark");
      await expect(wordmark).toHaveText("tomverse.");
      await page.evaluate(() => document.fonts.ready);
      const wordmarkStyle = await wordmark.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          family: style.fontFamily.replaceAll('"', ""), size: style.fontSize, weight: style.fontWeight,
          spacing: style.letterSpacing, lineHeight: Number.parseFloat(style.lineHeight),
          dotGap: getComputedStyle(node.lastElementChild!).marginLeft,
        };
      });
      expect(wordmarkStyle).toMatchObject({
        family: "Tomverse Wordmark, sans-serif", size: "24px", weight: "650",
        spacing: "-1px", dotGap: "1px",
      });
      expect(wordmarkStyle.lineHeight).toBeCloseTo(38.4, 3);
      expect(await page.evaluate(() => Array.from(document.fonts).some(font =>
        font.family.replaceAll('"', "") === "Tomverse Wordmark" && font.status === "loaded"))).toBe(true);
      const bodyFamily = await page.locator("body").evaluate((node) => getComputedStyle(node).fontFamily);
      expect(bodyFamily).toMatch(bodyFamilies[lang]);
      expect(bodyFamily).not.toContain("Tomverse Wordmark");
      await expect(page.locator(".welcome p").first()).toHaveCSS("font-family", bodyFamily);
      if (browserName === "chromium") {
        const client = await page.context().newCDPSession(page);
        try {
          await client.send("DOM.enable");
          await client.send("CSS.enable");
          const { root } = await client.send("DOM.getDocument");
          const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".wordmark" });
          const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
          expect(fonts.filter((font) => font.glyphCount > 0)).toEqual([
            expect.objectContaining({ familyName: "Roboto", isCustomFont: true }),
          ]);
        } finally {
          await client.detach();
        }
      }
      expect(externalFonts).toEqual([]);
    });
  }
}
