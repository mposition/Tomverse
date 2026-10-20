import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { finishControlledStream, installChatModelStub, mockUserUsage, pushControlledChunk, restoreActiveConversation, setDeterministicTheme, suppressTransientUi, THREE_MODELS, waitForControlledStream } from "./support/chat-state-fixtures";
import { expectTappableInVisibleViewport, openOnScreenKeyboard } from "./support/ui-audit";

test.setTimeout(120_000);
test.beforeEach(async ({}, info) => { test.skip(info.project.name !== "desktop-chromium", "Explicit desktop and phone viewports use one browser engine."); });

async function prepare(page: Page, width: number, theme: "light" | "dark" = "light", models = THREE_MODELS, providerCount = 3) {
  await page.setViewportSize({ width, height: width > 768 ? 1000 : 932 });
  await prepareGuestPage(page, "ko", "studio");
  const account = await mockAuthenticatedApi(page, {
    selectedModels: models, productKey: "review", assistantProfiles: [],
    extraConversations: [{ id: "qa-studio-other", title: "Other Studio task", selectedModels: models,
      messages: [{ id: "other-answer", role: "assistant", content: "The other task's saved answer.", modelId: models[0] }] }],
  });
  account.theme = theme;
  await mockUserUsage(page, { plan: "Max", limits: { maxModels: 3, creditsDay: 0, creditsMonth: 10000 }, usage: { creditsMonth: 2500 } });
  await restoreActiveConversation(page);
  await suppressTransientUi(page);
  await setDeterministicTheme(page, theme);
  await page.context().addCookies([{ name: "__tomverse_e2e_review_easy", value: "1", url: "http://127.0.0.1:3100" }, { name: "__tomverse_e2e_chat_starter", value: "1", url: "http://127.0.0.1:3100" }, { name: "__tomverse_e2e_image_generation", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.goto("/review?lang=ko", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("review-command-bar").getByRole("button", { name: "Easy", exact: true }).click();
  await expect(page.locator(".review-participant-list>button")).toHaveCount(providerCount, { timeout: 20000 });
}

async function expectHeaderControlsFit(page: Page) {
  await expect.poll(() => page.locator(".review-command-bar button").evaluateAll(buttons => buttons.flatMap(button => {
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const range = document.createRange(); range.selectNodeContents(button);
    const text = range.getBoundingClientRect();
    return box.left < -1 || box.right > innerWidth + 1 || text.left < box.left - 1 || text.right > box.right + 1
      ? [button.textContent || button.getAttribute("aria-label")] : [];
  }))).toEqual([]);
}

for (const width of [1600, 430]) for (const theme of ["light", "dark"] as const) {
  test(`Studio ${width > 768 ? "PC" : "mobile"} ${theme}, Classic and Professional keep the draft`, { tag: "@ui-risk" }, async ({ page }) => {
    await prepare(page, width, theme);
    await expect(page.getByTestId("request-credit-estimate")).toHaveCount(0);
    await expect(page.getByTestId("auto-variable-credit-notice")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect.poll(() => page.locator("img").evaluateAll(nodes => nodes.filter(node => node instanceof HTMLImageElement && node.getClientRects().length > 0 && (!node.complete || !node.naturalWidth)).map(node => node.getAttribute("src"))), { timeout: 20000 }).toEqual([]);
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    await expectHeaderControlsFit(page);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ style: "nextjs-portal { display: none !important; }", path: `artifacts/review-studio-${width > 768 ? "pc" : "mobile"}-${theme}.png`, fullPage: true });
    const input = page.getByTestId("chat-textarea");
    await input.fill("Preserve this draft across appearance and mode changes.");
    await page.getByTestId("review-appearance").selectOption("classic");
    await expect(page.getByTestId("chat-textarea")).toHaveValue("Preserve this draft across appearance and mode changes.");
    if (width <= 768) {
      await expect(page.getByTestId("review-command-bar")).toHaveCount(0);
      await page.getByTestId("mobile-sidebar-open").click();
      await expect(page.getByTestId("mobile-sidebar-drawer").getByTestId("review-command-bar")).toBeVisible();
      await expectHeaderControlsFit(page);
      await page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true }).click();
      await expect(page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByTestId("review-appearance").selectOption("studio");
    await page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true }).click();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("Preserve this draft across appearance and mode changes.");
    await page.locator(".review-participants-heading").click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
  });
}

test("Classic phone drawer keeps Review controls reachable at short heights and 200% text", { tag: "@ui-risk" }, async ({ page }) => {
  await prepare(page, 320, "dark");
  await page.getByTestId("review-appearance").selectOption("classic");
  await page.getByTestId("mobile-sidebar-open").click();
  const drawer = page.getByTestId("mobile-sidebar-drawer");
  for (const { height, fontSize } of [{ height: 700, fontSize: 16 }, { height: 480, fontSize: 32 }]) {
    await page.setViewportSize({ width: 320, height });
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    const controls = drawer.getByTestId("review-command-bar").locator("button, select");
    for (const control of await controls.all()) {
      await expectTappableInVisibleViewport(page, control, `Review drawer control at ${height}px`);
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
    }
    await expectTappableInVisibleViewport(page, drawer.getByTestId("sidebar-feedback-button"), "Drawer feedback");
    await expect.poll(() => drawer.getByTestId("chat-sidebar").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId("mobile-sidebar-open")).toBeFocused();
});

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
  await page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true }).click();
  await expect.poll(() => page.getByTestId("desktop-model-panel").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-model-id")))).toEqual(THREE_MODELS);
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
  await expectHeaderControlsFit(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const input = (await page.getByTestId("chat-textarea").boundingBox())!;
  const row = (await page.getByTestId("composer-textarea-row").boundingBox())!;
  expect(input.width / row.width).toBeGreaterThanOrEqual(.9);
  await page.getByTestId("chat-send-button").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("chat-send-button")).toBeInViewport();
});

test("Easy deduplicates Professional providers and restores every model when switched back", async ({ page }) => {
  await prepare(page, 1600, "light", ["gpt-5-4-mini", "gpt-6-luna", "claude-haiku-4-5"], 2);
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(2);
  await page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true }).click();
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);
});

test("Studio history preserves the collapse preference, traps focus and returns it on dismissal", async ({ page }) => {
  await prepare(page, 430);
  await page.setViewportSize({ width: 430, height: 480 });
  await page.evaluate(() => localStorage.setItem("tomverse_sidebar_collapsed_v1", "collapsed"));
  const opener = page.locator(".review-navigation-history");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "기록", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("account-menu-trigger")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("tomverse_sidebar_collapsed_v1"))).toBe("collapsed");
  await dialog.getByTestId("account-menu-trigger").scrollIntoViewIfNeeded();
  await expect(dialog.getByTestId("account-menu-trigger")).toBeInViewport();
  await openOnScreenKeyboard(page, 160);
  await expect.poll(() => dialog.evaluate(element => element.getBoundingClientRect().bottom <= window.visualViewport!.height)).toBe(true);
  await dialog.getByTestId("account-menu-trigger").scrollIntoViewIfNeeded();
  await expect.poll(() => dialog.getByTestId("account-menu-trigger").evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    return y < window.visualViewport!.height && element.contains(document.elementFromPoint(x, y));
  })).toBe(true);
  const close = dialog.locator(".review-drawer-close");
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("tomverse_sidebar_collapsed_v1"))).toBe("collapsed");
});

for (const [width, theme] of [[1600, "light"], [430, "dark"]] as const) {
  test(`Studio Professional isolates retry and a streaming history switch at ${width}px ${theme}`, async ({ page }) => {
    const [failed, ...healthy] = THREE_MODELS;
    await installChatModelStub(page, {
      [failed]: [
        { kind: "error", status: 503, message: "QA fixture: provider busy." },
        { kind: "success", chunks: ["Recovered Studio answer."] },
        { kind: "controlled", channel: "studio-history" },
      ],
      ...Object.fromEntries(healthy.map(id => [id, { kind: "success", chunks: [`Healthy ${id}.`] }])),
    });
    await prepare(page, width, theme);
    await page.getByTestId("review-command-bar").getByRole("button", { name: "Professional", exact: true }).click();
    await page.getByTestId("chat-textarea").fill("Compare, then recover the failed provider.");
    await page.getByTestId("chat-send-button").click();
    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(page.getByText("Recovered Studio answer.", { exact: true })).toBeVisible();
    const requestedModels = await page.evaluate(() => ((window as typeof window & {
      __chatModelStubRequests?: Array<{ modelId: string }>;
    }).__chatModelStubRequests ?? []).map(request => request.modelId));
    expect(requestedModels.filter(id => id === failed)).toHaveLength(2);
    for (const id of healthy) expect(requestedModels.filter(model => model === id)).toHaveLength(1);

    if (width < 768) await page.locator(".review-view-switch button").first().click();
    await page.getByTestId("chat-textarea").fill("Keep this response running while I switch tasks.");
    await page.getByTestId("chat-send-button").click();
    await waitForControlledStream(page, "studio-history");
    await pushControlledChunk(page, "studio-history", "STUDIO-PARTIAL-ONE");
    await expect(page.getByText("STUDIO-PARTIAL-ONE", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    const openHistory = async () => {
      await page.locator(".review-navigation-history").click();
      return page.getByRole("dialog", { name: "기록", exact: true });
    };
    const history = await openHistory();
    await history.getByTestId("sidebar-conversation-item").filter({ hasText: "Other Studio task" }).click();
    await expect(page.getByText("The other task's saved answer.", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(history).toHaveCount(0);
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    await pushControlledChunk(page, "studio-history", "-TWO");
    await expect(page.getByText("STUDIO-PARTIAL-ONE-TWO", { exact: true })).toHaveCount(0);
    const returnHistory = await openHistory();
    await returnHistory.locator('[data-testid="sidebar-conversation-item"][data-conversation-id="qa-conversation"]').click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("STUDIO-PARTIAL-ONE-TWO", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    await finishControlledStream(page, "studio-history");
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  });
}
