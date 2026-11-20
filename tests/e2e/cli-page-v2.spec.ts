import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { cliPageContent } from "@/components/marketing/v2/cli/cliPageContent";

// The CLI download page (/developers/cli). The package is not on npm yet, so the page
// must say "coming soon" next to the install command, and every interactive part of the
// concept (OS tabs, copy buttons, doctor terminal, motion control) must work without
// an inline script.
test.setTimeout(90_000);

const pages = [
  { path: "/developers/cli", lang: "en" },
  { path: "/ko/developers/cli", lang: "ko" },
] as const;

for (const { path, lang } of pages) {
  const copy = cliPageContent[lang];

  test(`${path} opens with its title, the coming-soon notice and no horizontal overflow at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    const title = page.getByTestId("cli-title");
    await expect(title).toBeVisible();
    await expect(title).toContainText(copy.hero.title[0]);
    await expect(title).toContainText(copy.hero.title[1]);
    await expect(page.getByTestId("cli-page")).toHaveAttribute("lang", lang);
    await expect(page.getByText(copy.hero.soonNote)).toBeVisible();
    await expect(page.getByText(copy.install.soonNote)).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // A command wraps inside its box instead of scrolling or leaving the viewport.
    const boxes = await page.locator(".tv-page .cmd:visible").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
    expect(boxes.length).toBeGreaterThan(0);
    for (const right of boxes) expect(right).toBeLessThanOrEqual(320);
  });
}

test("the OS tabs switch the install commands", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const unixTab = page.getByRole("tab", { name: "macOS · Linux" });
  const winTab = page.getByRole("tab", { name: "Windows (PowerShell)" });
  const unixPanel = page.locator("#cli-os-panel-unix");
  const winPanel = page.locator("#cli-os-panel-win");

  await unixTab.click();
  await expect(unixTab).toHaveAttribute("aria-selected", "true");
  await expect(unixPanel).toBeVisible();
  await expect(unixPanel).toContainText("export TOMVERSE_API_KEY=");
  await expect(winPanel).toBeHidden();

  await winTab.click();
  await expect(winTab).toHaveAttribute("aria-selected", "true");
  await expect(winPanel).toBeVisible();
  await expect(winPanel).toContainText("$env:TOMVERSE_API_KEY");
  await expect(unixPanel).toBeHidden();

  await winTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(unixTab).toHaveAttribute("aria-selected", "true");
  await expect(unixTab).toBeFocused();
});

test("a copy button copies exactly its command and confirms it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { (window as unknown as { __copied: string }).__copied = text; } },
    });
  });
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const button = page.locator(".hero-cmd").getByRole("button");
  await expect(button).toHaveText(cliPageContent.en.copy);
  await button.click();
  await expect(button).toHaveText(cliPageContent.en.copied);
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe("npm install -g @tomverse/cli");
});

test("the motion control stops the page's motion and reduced motion shows the finished terminal", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const root = page.getByTestId("cli-page");
  const toggle = page.getByTestId("launch-motion-toggle");
  await expect(root).toHaveAttribute("data-motion", "running");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(root).toHaveAttribute("data-motion", "paused");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("pre.doctor")).toContainText("PASS  recovery");
  await toggle.click();
  await expect(root).toHaveAttribute("data-motion", "running");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.getByTestId("cli-page")).toHaveAttribute("data-motion", "paused");
  await expect(page.getByTestId("launch-motion-toggle")).toHaveCount(0);
  await expect(page.locator("pre.doctor")).toContainText("PASS  recovery");
});
