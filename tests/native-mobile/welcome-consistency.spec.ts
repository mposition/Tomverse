import { expect, test } from "@playwright/test";
import { mobileCopy, mobileLanguages } from "../../locales/mobile";
import { mobileWorkspaceStartCopy } from "../../locales/mobileWorkspaceStart";
import { selectProduct } from "./workspaceNavigation";

test.beforeEach(async ({ page }) => {
  await page.route("https://tomverse.app/**", route => route.abort());
});

for (const theme of ["light", "dark"]) for (const language of mobileLanguages) {
  test(`clean workspaces keep ${language} copy, themed art and an empty draft in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(({ theme, language }) => {
      localStorage.setItem("tomverse-theme", theme); localStorage.setItem("tomverse-language", language);
    }, { theme, language });
    await page.goto("/"); await page.getByRole("button", { name: mobileCopy[language].signIn, exact: true }).click();
    const c = mobileWorkspaceStartCopy(language);
    const start = page.getByTestId("workspace-start");
    await expect(start.getByRole("heading")).toContainText(c.chatLast);
    await expect(start.getByText(c.chatAutomatic, { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await expect(start.locator("article, button")).toHaveCount(0);
    const visibleArt = start.locator(`.welcome-art-${theme}`);
    await expect(visibleArt).toBeVisible();
    await expect.poll(() => visibleArt.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("textbox").fill("My own question");
    await selectProduct(page, "review");
    await expect(start.getByRole("heading")).toContainText(c.reviewLast);
    await expect(start.getByText(c.reviewDescription, { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await expect(start.locator("article, button")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(page.getByRole("textbox")).toBeInViewport();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo") ?? "[]").length)).toBe(0);
  });
}

test("the welcome does not promise automatic model choice when the server does not offer it", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(); const source = await response.text();
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", "transport.capabilities=async()=>({offered:false});createRoot(container).render(") });
  });
  await page.addInitScript(() => localStorage.setItem("tomverse-language", "ko"));
  await page.goto("/"); await page.getByRole("button", { name: "Tomverse로 계속" }).click();
  await expect(page.getByText(mobileWorkspaceStartCopy("ko").chatDescription, { exact: true })).toBeVisible();
  await expect(page.getByText(mobileWorkspaceStartCopy("ko").chatAutomatic, { exact: true })).toHaveCount(0);
});
