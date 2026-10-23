import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { installChatModelStub, restoreActiveConversation, setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";
import { expectAccessibleContrast, expectInsideVisibleViewport, expectTappableInVisibleViewport, openOnScreenKeyboard } from "./support/ui-audit";

test.use({ hasTouch: true });

test("PWA actions preserve the mobile composer and explicitly restore an offline draft", { tag: "@ui-risk" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: ["gpt-6-luna"], selectionMode: "manual", language: "en", messages: [{ id: "pwa-existing-question", role: "user", content: "Saved conversation marker" }] });
  await restoreActiveConversation(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.route("**/api/products/chat/capabilities", (route) => route.fulfill({ json: { autoSelection: { offered: true } } }));
  await page.goto("/chat?lang=en");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem("tomverse-offline-draft", JSON.stringify({ owner: sessionStorage.getItem("tomverse-offline-owner"), text: "Recovered offline idea" })));
  await page.reload();
  await expect(page.getByText("Saved conversation marker", { exact: true })).toBeVisible();
  const textarea = page.getByTestId("chat-textarea");
  await textarea.fill("Existing draft");
  await page.getByRole("button", { name: "Restore offline draft" }).click();
  await expect(textarea).toHaveValue("Existing draft\nRecovered offline idea");
  await page.evaluate(() => { const event = new Event("beforeinstallprompt"); Object.assign(event, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" }) }); window.dispatchEvent(event); });
  await expect(page.getByRole("button", { name: "Install Tomverse" })).toBeVisible();
  await expectTappableInVisibleViewport(page, textarea, "PWA composer");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200); expect((await manifest.json()).start_url).toBe("/chat");
  const shell = await page.request.get("/chat-offline.html");
  expect(shell.status()).toBe(200);
  expect(shell.headers()["content-security-policy"] ?? shell.headers()["content-security-policy-report-only"]).toContain("default-src 'none'");
});
test.setTimeout(120_000);
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Explicit desktop and mobile viewport coverage.");
});

async function setAppearance(page: Page, width: number, appearance: "classic" | "studio") {
  if (width <= 768) await page.getByTestId("mobile-sidebar-open").click();
  await page.getByTestId("chat-appearance").selectOption(appearance);
  if (width <= 768) await page.keyboard.press("Escape");
  await expect(page.locator(`[data-studio-product="chat"][data-review-appearance="${appearance}"]`)).toBeVisible();
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
  test(`Chat Studio ${width}px ${theme} preserves draft, Auto, tools and answers across Classic`, { tag: "@ui-risk" }, async ({ page }) => {
    await installChatModelStub(page, { "gpt-6-luna": { kind: "success", chunks: ["The Studio answer completed."] } });
    await page.setViewportSize({ width, height: width > 768 ? 960 : 844 });
    await prepareGuestPage(page, "ko", "studio", "studio");
    const account = await mockAuthenticatedApi(page, {
      productKey: "chat", selectedModels: ["gpt-6-luna"], selectionMode: "auto", autoSelectionOffered: true,
      language: "ko", messages: width > 768 ? [] : [
        { id: "studio-question", role: "user", content: "처음 출시하는 서비스의 사용자 피드백은 어떻게 모으면 좋을까요?" },
        { id: "studio-answer", role: "assistant", modelId: "gpt-6-luna", content: "처음에는 세 가지 질문에 집중해 보세요.\n\n1. 사용자가 해결하려던 문제는 무엇인가요?\n2. 어느 순간 막히거나 멈췄나요?\n3. 다음에도 이 서비스를 사용할 이유가 있나요?\n\n대화 마지막에 짧게 질문하고, 답변에서 반복되는 문제부터 개선하세요." },
      ],
    });
    account.title = "출시 전 피드백 정리";
    account.theme = theme;
    await setDeterministicTheme(page, theme);
    await suppressTransientUi(page);
    await restoreActiveConversation(page);
    await page.context().addCookies([
      { name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" },
      { name: "__tomverse_e2e_chat_starter", value: "1", url: "http://127.0.0.1:3100" },
    ]);
    await page.route("**/api/products/chat/capabilities", route => route.fulfill({ json: { autoSelection: { offered: true } } }));
    await page.route("**/api/chat/context", route => route.fulfill({ json: { ok: true, contextBundle: null, memoryUsedCount: 0 } }));
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    await expect(page.locator('[data-review-appearance="studio"][data-studio-product="chat"]')).toBeVisible();
    if (width > 768) {
      await page.getByTestId("chat-textarea").fill("새로 출시할 서비스의 첫 사용자 인터뷰를 준비하고 싶어요.");
      await page.getByTestId("chat-command-bar").getByText("Chat", { exact: true }).click();
    }
    await expect.poll(() => page.locator("img").evaluateAll(nodes => nodes.filter(node => node instanceof HTMLImageElement && node.getClientRects().length > 0 && (!node.complete || !node.naturalWidth)).map(node => node.getAttribute("src"))), { timeout: 30_000 }).toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `artifacts/chat-studio-${width > 768 ? "pc" : "mobile"}-${theme}.png`, fullPage: true,
      style: "nextjs-portal { display:none!important; }" });
    const draft = "Keep this draft while changing appearance.";
    await page.getByTestId("chat-textarea").fill(draft);
    await expectAccessibleContrast(page.getByTestId("chat-textarea"), "Studio input");
    await setAppearance(page, width, "classic");
    await expect(page.getByTestId("chat-textarea")).toHaveValue(draft);
    expect(account.selectionMode).toBe("auto");
    await setAppearance(page, width, "studio");
    await expect(page.getByTestId("chat-textarea")).toHaveValue(draft);
    const auto = page.getByTestId("composer-auto-routing-toggle");
    await expect(auto).toBeChecked();
    await auto.click();
    await expect(auto).not.toBeChecked();
    await expect.poll(() => account.selectionMode).toBe("manual");
    await page.getByTestId("composer-tools-button").click();
    await expect(page.getByTestId("tools-web-search-row")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width <= 768) {
      await page.getByTestId("chat-textarea").focus();
      await openOnScreenKeyboard(page);
      await expectInsideVisibleViewport(page, page.getByTestId("chat-textarea"), "Studio input with keyboard");
      await expectTappableInVisibleViewport(page, page.getByTestId("chat-send-button"), "Studio send with keyboard");
    }
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("The Studio answer completed.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
    const requests = await page.evaluate(() => (window as unknown as { __chatModelStubRequests?: unknown[] }).__chatModelStubRequests);
    expect(requests).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem("tomverse_chat_appearance"))).toBe("studio");
  });
}

test("Chat Studio small phone retains full-width input and reachable appearance controls at 200% text", { tag: "@ui-risk" }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await prepareGuestPage(page, "ko", "classic", "studio");
  const account = await mockAuthenticatedApi(page, { productKey: "chat", language: "ko", selectedModels: ["gpt-6-luna"] });
  account.theme = "dark";
  await setDeterministicTheme(page, "dark");
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100" }]);
  await page.goto("/chat?lang=ko");
  const textarea = page.getByTestId("chat-textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("가나다 IME composition draft");
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    await expect.poll(() => textarea.evaluate(element => {
      const row = element.closest('[data-testid="composer-textarea-row"]')!;
      return element.getBoundingClientRect().width / row.getBoundingClientRect().width;
    })).toBeGreaterThanOrEqual(0.9);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByTestId("mobile-sidebar-open").click();
    for (const control of await page.getByTestId("chat-command-bar").locator("button,select").all()) {
      await expectTappableInVisibleViewport(page, control, "Chat appearance drawer");
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    }
    await page.keyboard.press("Escape");
    await expect(textarea).toHaveValue("가나다 IME composition draft");
  }
  expect(await page.evaluate(() => localStorage.getItem("tomverse_review_appearance"))).toBe("classic");
});
