import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { installChatModelStub, mockUserUsage, restoreActiveConversation, setDeterministicTheme, suppressTransientUi, THREE_MODELS } from "./support/chat-state-fixtures";

test.setTimeout(120_000);
test.beforeEach(async ({}, info) => { test.skip(info.project.name !== "desktop-chromium", "Explicit desktop and phone viewports use one browser engine."); });

async function prepare(page: Page, width: number, theme: "light" | "dark" = "light") {
  await page.setViewportSize({ width, height: width > 768 ? 1000 : 932 });
  await prepareGuestPage(page, "ko", "studio");
  const account = await mockAuthenticatedApi(page, { selectedModels: THREE_MODELS, productKey: "review", assistantProfiles: [] });
  account.theme = theme;
  await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsDay: 0, creditsMonth: 10000 }, usage: { creditsMonth: 2500 } });
  await restoreActiveConversation(page);
  await suppressTransientUi(page);
  await setDeterministicTheme(page, theme);
  await page.context().addCookies([{ name: "__tomverse_e2e_review_easy", value: "1", url: "http://127.0.0.1:3100" }, { name: "__tomverse_e2e_chat_starter", value: "1", url: "http://127.0.0.1:3100" }, { name: "__tomverse_e2e_image_generation", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.goto("/review?lang=ko");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.getByTestId("review-command-bar").getByRole("button", { name: "Easy", exact: true }).click();
  await expect(page.locator(".review-participant-list>button")).toHaveCount(3, { timeout: 20000 });
}

for (const width of [1600, 430]) for (const theme of ["light", "dark"] as const) {
  test(`Studio ${width > 768 ? "PC" : "mobile"} ${theme}, Classic and Professional keep the draft`, async ({ page }) => {
    await prepare(page, width, theme);
    await expect(page.getByTestId("request-credit-estimate")).toHaveCount(0);
    await expect(page.getByTestId("auto-variable-credit-notice")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect.poll(() => page.locator("img").evaluateAll(nodes => nodes.filter(node => node.getClientRects().length > 0).every(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0))).toBe(true);
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ style: "nextjs-portal { display: none !important; }", path: `artifacts/review-studio-${width > 768 ? "pc" : "mobile"}-${theme}.png`, fullPage: true });
    const input = page.getByTestId("chat-textarea");
    await input.fill("Preserve this draft across appearance and mode changes.");
    await page.getByTestId("review-appearance").selectOption("classic");
    await expect(page.getByTestId("chat-textarea")).toHaveValue("Preserve this draft across appearance and mode changes.");
    await page.getByTestId("review-appearance").selectOption("studio");
    await page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true }).click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("Preserve this draft across appearance and mode changes.");
    await page.locator(".review-participants-heading").click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
  });
}

test("Easy routes once and dispatches each selected provider through the existing comparison send", async ({ page }) => {
  await installChatModelStub(page, Object.fromEntries([...THREE_MODELS, "gpt-6-luna"].map(id => [id, { kind: "success", chunks: [`Answer from ${id}.`] }])));
  await prepare(page, 1600);
  let routes = 0;
  await page.route("**/api/review/route", async route => {
    routes++;
    const body = route.request().postDataJSON();
    expect(body.providers).toEqual(["openai", "anthropic", "google"]);
    await route.fulfill({ json: { kind: "text", preset: "standard", choices: body.providers.map((provider: string, index: number) => ({ provider, modelId: routes > 1 && provider === "openai" ? "gpt-6-luna" : THREE_MODELS[index] })) } });
  });
  await page.getByTestId("chat-textarea").fill("Compare these three perspectives.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByText(`Answer from ${THREE_MODELS[0]}.`, { exact: true })).toBeVisible();
  await expect.poll(() => routes).toBe(1);
  await page.getByTestId("chat-textarea").fill("Now explain the same problem in more detail.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByText("Answer from gpt-6-luna.", { exact: true })).toBeVisible();
  await expect(page.getByText(`Answer from ${THREE_MODELS[0]}.`, { exact: true })).toBeVisible();
  expect(routes).toBe(2);
});

test("unsupported image providers show a local notice and never start a text or substitute image call", async ({ page }) => {
  await prepare(page, 430);
  let images = 0, text = 0;
  await page.route("**/api/images/generations", route => { images++; return route.fulfill({ status: 500, json: {} }); });
  await page.route("**/api/chat", route => { text++; return route.fulfill({ status: 500, json: {} }); });
  await page.route("**/api/review/route", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { kind: "image", preset: "standard", choices: body.providers.map((provider: string) => ({ provider, modelId: null })) } });
  });
  await page.getByTestId("chat-textarea").fill("Create an illustration.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("review-image-unsupported")).toHaveCount(3);
  expect(images).toBe(0); expect(text).toBe(0);
});

test("a supported image provider still executes while unsupported peers keep their notices", async ({ page }) => {
  await prepare(page, 1600);
  const imageCalls: string[][] = [];
  await page.route("**/api/images/generations", route => {
    imageCalls.push(route.request().postDataJSON().modelIds);
    return route.fulfill({ status: 500, json: { error: "QA_PROVIDER_FAILURE" } });
  });
  await page.route("**/api/review/route", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { kind: "image", preset: "standard", choices: body.providers.map((provider: string) => ({ provider, modelId: provider === "openai" ? "gpt-image-2" : null })) } });
  });
  await page.getByTestId("chat-textarea").fill("Create an illustration of a mountain.");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("review-image-unsupported")).toHaveCount(2);
  await page.getByTestId("image-generation-submit").click();
  await expect.poll(() => imageCalls).toEqual([["gpt-image-2"]]);
});

test("Studio at 320px preserves a full-width textarea and reachable controls at 200% text size", async ({ page }) => {
  await prepare(page, 320);
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const input = (await page.getByTestId("chat-textarea").boundingBox())!;
  const row = (await page.getByTestId("composer-textarea-row").boundingBox())!;
  expect(input.width / row.width).toBeGreaterThanOrEqual(.9);
  await page.getByTestId("chat-send-button").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("chat-send-button")).toBeInViewport();
});
