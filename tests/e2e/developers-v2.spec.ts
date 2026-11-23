import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { formatContrastSample, measureContrastInScope } from "./support/ui-audit";
import { developersPageContent } from "@/components/marketing/v2/developers/developersPageContent";
import { editorExtensionsCopy, vscodeGuideCopy } from "@/locales/developerTools";

// Developer page V2 (approved concept 2026-11-20): it opens, shows its title and the
// primary action, does not overflow a 320px phone, and the tool tabs work from the keyboard.
test.setTimeout(90_000);

test("the homepage Developers submenu orders API, CLI, editor extensions and integrations", async ({ page }, testInfo) => {
  await prepareGuestPage(page, "en");
  await page.route("**/_next/static/**", route => route.continue());
  await page.goto("/", { waitUntil: "load" });
  const mobile = testInfo.project.name.startsWith("mobile");
  if (mobile) await page.getByTestId("marketing-menu-button").click();
  else await page.getByTestId("header-developers-link").focus();
  const menu = page.locator('[aria-label="Developer menu"]:visible');
  await expect(menu.locator("a")).toContainText(["API", "Tomverse CLI", "Editor extensions", "Connect coding tools"], { useInnerText: true });
  const links = await menu.locator("a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
  expect(links).toEqual(["/developers", "/developers/cli", "/developers#editor-extensions", "/developers#connect"]);
  await page.screenshot({ path: testInfo.outputPath("developers-menu.png") });
  await menu.getByRole("link", { name: /Editor extensions/ }).click();
  await expect(page).toHaveURL(/#editor-extensions$/);
  await expect(page.getByTestId("editor-extensions").getByRole("heading", { level: 2 })).toContainText(vscodeGuideCopy.en.title[0]);
  await expectNoHorizontalOverflow(page);
});

const pages = [
  { lang: "en", path: "/developers" },
  { lang: "ko", path: "/ko/developers" },
] as const;

test("the Marketplace cards and the four-step VS Code guide are readable across locales", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const mobile = testInfo.project.name.startsWith("mobile");
  await page.setViewportSize({ width: mobile ? 375 : 1440, height: 1000 });
  const expectedCards = [
    { name: "Tomverse for VS Code", url: "https://marketplace.visualstudio.com/items?itemName=Tomverse.tomverse-vscode" },
    { name: "Tomverse for Visual Studio", url: "https://marketplace.visualstudio.com/items?itemName=Tomverse.tomverseforvs" },
  ] as const;

  for (const { lang, path } of [...pages, { lang: "zh", path: "/zh/developers" }] as const) {
    await prepareGuestPage(page, lang);
    await page.goto(path + "#tomverse-vscode");
    const section = page.getByTestId("editor-extensions");
    const guide = page.getByTestId("tomverse-vscode-guide");
    const copy = vscodeGuideCopy[lang];
    const extensions = editorExtensionsCopy[lang];
    await expect(guide).toHaveAttribute("id", "tomverse-vscode");
    await expect(guide.getByRole("heading", { level: 3 })).toHaveText(extensions.guideTitle);
    await expect(guide.locator("ol > li")).toHaveCount(4);
    await expect(guide.locator("ol > li").first()).toContainText("Extensions: Install from VSIX");
    await expect(guide.locator("ul > li")).toHaveCount(4);
    const cards = section.getByRole("article");
    await expect(cards).toHaveCount(2);
    for (const { name, url } of expectedCards) {
      const card = section.getByRole("article", { name });
      await expect(card.getByRole("link", { name: `${extensions.installAction} ${name}` })).toHaveAttribute("href", url);
    }
    await expect(section.getByRole("article", { name: "Tomverse for Visual Studio" })).toContainText(extensions.visualStudio[1]);
    await expect(section.getByRole("link")).toHaveCount(3);
    await expect(section.getByRole("link", { name: copy.createKey })).toHaveAttribute("href", "/settings/api");
    await expect(guide.locator(".vsc-window")).toHaveAttribute("aria-hidden", "true");
    await expect(guide.locator(".vsc-editor")).toBeVisible({ visible: !mobile });
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    if (!first || !second) throw new Error("Both editor install cards must have layout bounds.");
    if (mobile) expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    else expect(first.y).toBeCloseTo(second.y);
    await expectNoHorizontalOverflow(page);
    await section.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    if (!mobile) {
      const lines = await section.getByRole("heading", { level: 2 }).evaluate(
        heading => heading.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(heading).lineHeight),
      );
      expect(lines).toBeCloseTo(2);
    }
    const samples = await measureContrastInScope(section);
    expect(samples.some(sample => sample.text === copy.mock.effort + " ▾")).toBe(true);
    const failures = samples.filter(sample => sample.ratio < 4.5).map(sample => formatContrastSample(lang, sample));
    expect(failures).toEqual([]);
    await testInfo.attach(`editor-extensions-contrast-${lang}`, {
      body: JSON.stringify({ samples: samples.length, minimum: Math.min(...samples.map(sample => sample.ratio)) }),
      contentType: "application/json",
    });
    await section.screenshot({
      path: testInfo.outputPath(`editor-extensions-${lang}-${mobile ? 375 : 1440}.png`),
      animations: "disabled",
      scale: "css",
      style: '[data-testid="launch-marketing-header"], [data-testid="chat-consent-notice"], [data-testid="analytics-settings-button"] { visibility: hidden; }',
    });
  }
});

for (const { lang, path } of pages) {
  test(`${lang} developer page opens with its title and primary action`, async ({ page }) => {
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const copy = developersPageContent[lang];
    await expect(page.getByTestId("developers-page")).toBeVisible();
    await expect(page.getByTestId("developers-title")).toContainText(copy.hero.title[0]);
    const action = page.getByTestId("developers-primary-cta");
    await expect(action).toHaveAccessibleName(new RegExp(copy.hero.primary));
    await expect(action).toHaveAttribute("href", "/settings/api");
    // The header menu jumps to these two sections.
    await expect(page.locator("#connect")).toHaveCount(1);
    await expect(page.locator("#keys")).toHaveCount(1);
  });

  test(`${lang} developer page does not overflow a 320px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    await page.goto(path);
    await expect(page.getByTestId("developers-title")).toBeVisible();
    await page.locator("#keys").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
  });
}

test("the tool tabs change with the arrow keys and stay readable as one tablist", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers");
  const codex = page.getByTestId("developers-tool-codex");
  await codex.scrollIntoViewIfNeeded();
  await codex.click();
  await expect(codex).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("developers-console")).toContainText("model_providers.tomverse");
  // Coding tools use the coding API (docs/policy/external-api.md §10.4).
  await expect(page.getByTestId("developers-console")).toContainText("https://tomverse.app/api/code/v1");
  await page.keyboard.press("ArrowRight");
  const claude = page.getByTestId("developers-tool-claude");
  await expect(claude).toHaveAttribute("aria-selected", "true");
  await expect(claude).toBeFocused();
  await expect(page.getByTestId("developers-console")).toContainText("ANTHROPIC_BASE_URL");
  await expect(page.getByTestId("developers-console")).toContainText("https://tomverse.app/api/code/anthropic");
  await page.keyboard.press("End");
  await expect(page.getByTestId("developers-tool-other")).toHaveAttribute("aria-selected", "true");
  // Other apps stay on the general API.
  await expect(page.getByTestId("developers-console")).toContainText("https://tomverse.app/api/v1");
  await expect(page.getByTestId("developers-console")).not.toContainText("/api/code/");
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
});

test("the hero motion control pauses every moving part", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers");
  const root = page.getByTestId("developers-page");
  await expect(root).toHaveAttribute("data-motion", "running");
  await page.getByTestId("developers-motion-toggle").click();
  await expect(root).toHaveAttribute("data-motion", "paused");
});
