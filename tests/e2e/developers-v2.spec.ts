import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { formatContrastSample, measureContrastInScope } from "./support/ui-audit";
import { developersPageContent } from "@/components/marketing/v2/developers/developersPageContent";
import { vscodeGuideCopy } from "@/locales/developerTools";

// Developer page V2 (approved concept 2026-11-20): it opens, shows its title and the
// primary action, does not overflow a 320px phone, and the tool tabs work from the keyboard.
test.setTimeout(90_000);

test("the existing Developers submenu orders API, CLI, native VS Code and integrations", async ({ page }, testInfo) => {
  await prepareGuestPage(page, "en");
  // Static chunks bypass the API predicate routes, including in a local dev build.
  await page.route("**/_next/static/**", route => route.continue());
  await page.goto("/developers", { waitUntil: "load" });
  const mobile = testInfo.project.name.startsWith("mobile");
  if (mobile) await page.getByTestId("marketing-menu-button").click();
  else await page.getByTestId("header-developers-link").focus();
  const menu = page.locator('[aria-label="Developer menu"]:visible');
  await expect(menu.locator("a")).toContainText(["Tomverse API", "Install Tomverse CLI", "Tomverse for VS Code", "Connect coding tools"], { useInnerText: true });
  await page.screenshot({ path: testInfo.outputPath("developers-menu.png") });
  const links = await menu.locator("a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
  expect(links).toEqual(["/developers", "/developers/cli", "/developers#tomverse-vscode", "/developers#connect"]);
  await menu.getByRole("link", { name: /Tomverse for VS Code/ }).click();
  await expect(page).toHaveURL(/#tomverse-vscode$/);
  await expect(page.getByTestId("tomverse-vscode-guide").getByRole("heading", { level: 2 })).toContainText(vscodeGuideCopy.en.title[0]);
  await expectNoHorizontalOverflow(page);
});

const pages = [
  { lang: "en", path: "/developers" },
  { lang: "ko", path: "/ko/developers" },
] as const;

test("the VS Code guide keeps its steps, single action, and readable mockup across locales", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const mobile = testInfo.project.name.startsWith("mobile");
  await page.setViewportSize({ width: mobile ? 375 : 1440, height: 1000 });
  for (const { lang, path } of [...pages, { lang: "zh", path: "/zh/developers" }] as const) {
    await prepareGuestPage(page, lang);
    await page.goto(path);
    const guide = page.getByTestId("tomverse-vscode-guide");
    const copy = vscodeGuideCopy[lang];
    await expect(guide.getByRole("heading", { level: 2 })).toContainText(copy.title[1]);
    await expect(guide.locator("ol > li")).toHaveCount(4);
    await expect(guide.locator("ul > li")).toHaveCount(4);
    await expect(guide.getByRole("link")).toHaveCount(1);
    await expect(guide.getByRole("link", { name: copy.createKey })).toHaveAttribute("href", "/settings/api");
    await expect(guide.locator(".vsc-window")).toHaveAttribute("aria-hidden", "true");
    await expect(guide.locator(".vsc-note")).toHaveText(copy.availability);
    await expect(guide.locator(".vsc-editor")).toBeVisible({ visible: !mobile });
    await expectNoHorizontalOverflow(page);
    await guide.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    if (!mobile) {
      const lines = await guide.getByRole("heading", { level: 2 }).evaluate(
        heading => heading.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(heading).lineHeight),
      );
      expect(lines).toBeCloseTo(2);
    }
    const samples = await measureContrastInScope(guide);
    expect(samples.some(sample => sample.text === copy.mock.effort + " ▾")).toBe(true);
    const failures = samples.filter(sample => sample.ratio < 4.5).map(sample => formatContrastSample(lang, sample));
    expect(failures).toEqual([]);
    await testInfo.attach(`vscode-contrast-${lang}`, {
      body: JSON.stringify({ samples: samples.length, minimum: Math.min(...samples.map(sample => sample.ratio)) }),
      contentType: "application/json",
    });
    await guide.screenshot({
      path: testInfo.outputPath(`vscode-${lang}-${mobile ? 375 : 1440}.png`),
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
