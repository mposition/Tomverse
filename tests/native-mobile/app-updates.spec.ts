import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, options: { state?: string; fail?: boolean; language?: string } = {}) {
  await page.addInitScript(({ state, fail, language }) => {
    localStorage.setItem("tomverse-language", language);
    const fixture = {
      snapshot: { state, versionCode: 19 }, checks: 0, starts: 0, completions: 0, accepted: true, fail,
      listener: null as null | ((state: { state: string; versionCode: number }) => void),
    };
    Object.assign(window, { updateFixture: fixture, testAppUpdates: {
      check: async () => { fixture.checks++; if (fixture.fail) throw Error("Play unavailable"); return fixture.snapshot; },
      start: async () => { fixture.starts++; if (fixture.accepted) fixture.snapshot = { ...fixture.snapshot, state: "downloading" }; return { accepted: fixture.accepted }; },
      complete: async () => { fixture.completions++; },
      addListener: async (_event: string, listener: typeof fixture.listener) => {
        fixture.listener = listener;
        return { remove: async () => { if (fixture.listener === listener) fixture.listener = null; } };
      },
    } });
  }, { state: options.state ?? "available", fail: options.fail ?? false, language: options.language ?? "en" });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.route("**/src/appUpdates.ts", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/export const nativeAppUpdates = .*?;/, "export const nativeAppUpdates = window.testAppUpdates;");
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await page.getByRole("button", { name: options.language === "ko" ? "Tomverse로 계속" : "Continue with Tomverse", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
}
async function counts(page: Page) {
  return page.evaluate(() => { const state = (window as unknown as { updateFixture: { starts: number; completions: number } }).updateFixture; return [state.starts, state.completions]; });
}

test("launch prompts without opening Play and downloads only on a user click; restart preserves the draft", async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole("status").filter({ hasText: "A new version is ready" })).toBeVisible();
  expect(await counts(page)).toEqual([0, 0]);
  await page.getByRole("textbox").fill("Keep this unsent draft");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.locator(".app-update-banner")).toHaveCount(0);
  expect(await counts(page)).toEqual([1, 0]);
  await page.evaluate(() => { const state = (window as unknown as { updateFixture: { snapshot: { state: string; versionCode: number }; listener: (value: unknown) => void } }).updateFixture; state.snapshot = { ...state.snapshot, state: "downloaded" }; state.listener(state.snapshot); });
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  expect(await counts(page)).toEqual([1, 0]);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  expect(await counts(page)).toEqual([1, 1]);
  await page.reload(); await expect(page.getByRole("textbox")).toHaveValue("Keep this unsent draft");
});

test("Later suppresses the same version for a day but a newer version is offered", async ({ page }) => {
  await fixture(page); await page.getByRole("button", { name: "Later", exact: true }).click();
  await page.reload(); await expect(page.getByRole("textbox")).toBeVisible(); await expect(page.locator(".app-update-banner")).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("tomverse-update-later", JSON.stringify({ version: 19, at: Date.now() - 86_400_001 })));
  await page.reload(); await expect(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await page.evaluate(() => { const state = (window as unknown as { updateFixture: { listener: (value: unknown) => void } }).updateFixture; state.listener({ state: "available", versionCode: 20 }); });
  await expect(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  expect(await counts(page)).toEqual([0, 0]);
});

test("a downloaded update waits for the response to finish before offering restart", async ({ page }) => {
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const injection = `const originalSend = transport.send; transport.send = async (...args) => { await new Promise(resolve => { window.finishUpdateTestResponse = resolve; }); return originalSend(...args); };`;
    await route.fulfill({ response, body: (await response.text()).replace("createRoot(container).render(", injection + "createRoot(container).render(") });
  });
  await fixture(page, { state: "downloaded" });
  await page.getByRole("textbox").fill("A synthetic question"); await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
  await expect(page.locator(".app-update-banner")).toHaveCount(0);
  expect(await counts(page)).toEqual([0, 0]);
  await page.evaluate(() => (window as unknown as { finishUpdateTestResponse: () => void }).finishUpdateTestResponse());
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
});

test("the Korean dark-theme prompt fits a narrow phone without covering the composer", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => localStorage.setItem("tomverse-theme", "dark"));
  await fixture(page, { language: "ko" });
  await expect(page.getByText("새 버전이 있어요", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "업데이트", exact: true })).toBeInViewport();
  await expect(page.getByRole("textbox")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("canceling Play consent postpones the prompt without blocking chat", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as unknown as { updateFixture: { accepted: boolean } }).updateFixture.accepted = false; });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.locator(".app-update-banner")).toHaveCount(0); await expect(page.getByRole("textbox")).toBeEnabled();
  await page.reload(); await expect(page.getByRole("textbox")).toBeVisible(); await expect(page.locator(".app-update-banner")).toHaveCount(0);
  expect(await counts(page)).toEqual([0, 0]);
});

for (const state of ["none", "downloading", "error"]) test(`unavailable updates do not block launch: ${state}`, async ({ page }) => {
  await fixture(page, { state, fail: state === "error" });
  await expect(page.locator(".app-update-banner")).toHaveCount(0); await expect(page.getByRole("textbox")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0); expect(await counts(page)).toEqual([0, 0]);
});

test("an already downloaded update offers restart after relaunch without another download", async ({ page }) => {
  await fixture(page, { state: "downloaded" });
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await expect(page.locator(".app-update-banner")).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  expect(await counts(page)).toEqual([0, 0]);
});
