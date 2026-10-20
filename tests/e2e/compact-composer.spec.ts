import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { freezeAnimations, restoreActiveConversation, setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";

const reviewModels = ["claude-haiku-4-5", "claude-sonnet-5", "gpt-5-6-luna"];

async function enterCompactComposer(page: Page, product: "chat" | "review", width: number, height: number, language: "en" | "ko" | "de" | "fr" | "es" | "pt" | "zh" = "ko") {
  const models = product === "chat" ? ["gpt-5-6-luna"] : reviewModels;
  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, {
    productKey: product,
    selectedModels: models,
    selectionMode: product === "chat" ? "auto" : "manual",
    autoSelectionOffered: product === "chat",
    webSearchMode: "off",
    messages: [
      { id: "compact-user", role: "user", content: "내일 아침을 준비하고 싶어요." },
      ...models.map((modelId, index) => ({
        id: `compact-answer-${index}`,
        role: "assistant" as const,
        modelId,
        status: "normal",
        content: "준비할 일을 세 가지로 줄여보세요.",
      })),
    ],
  });
  await page.route("**/api/products/chat/capabilities", route => route.fulfill({
    json: { autoSelection: { offered: product === "chat" } },
  }));
  await page.context().addCookies([{
    name: "__tomverse_e2e_chat_workspace", value: "1", url: "http://127.0.0.1:3100",
  }]);
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  await page.setViewportSize({ width, height });
  await page.goto(`/${product}?lang=${language}`);
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
}

async function inputMetrics(page: Page) {
  return page.getByTestId("chat-textarea").evaluate(node => {
    const style = getComputedStyle(node);
    const composer = node.closest<HTMLElement>('[data-testid="chat-input"]')!;
    const box = node.getBoundingClientRect();
    const px = (value: string) => Number.parseFloat(value) || 0;
    return {
      height: box.height,
      lineHeight: px(style.lineHeight),
      padding: px(style.paddingTop) + px(style.paddingBottom),
      fontSize: px(style.fontSize),
      clipped: node.scrollHeight - node.clientHeight,
      widthRatio: box.width / (composer.clientWidth - px(getComputedStyle(composer).paddingLeft) - px(getComputedStyle(composer).paddingRight)),
      cardHeight: composer.getBoundingClientRect().height,
    };
  });
}

test.describe("Approved compact Composer", () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Explicit geometry is covered once on Chromium.");
  });

  for (const product of ["chat", "review"] as const) {
    test.describe(`PC pointer ${product}`, () => {
      test.use({ hasTouch: false });
    test(`PC ${product} keeps two input lines without the previous empty space`, { tag: "@ui-risk" }, async ({ page }, testInfo) => {
      await enterCompactComposer(page, product, 1280, 900);
      const input = page.getByTestId("chat-textarea");
      const empty = await inputMetrics(page);
      await testInfo.attach("compact-pc-metrics", { body: JSON.stringify(empty), contentType: "application/json" });
      expect(empty.fontSize).toBe(16);
      expect(empty.height).toBeGreaterThanOrEqual(empty.lineHeight * 2 + empty.padding - 1);
      expect(empty.height).toBeLessThanOrEqual(72);
      expect(empty.cardHeight).toBeLessThanOrEqual(172);
      expect(empty.widthRatio).toBeGreaterThanOrEqual(0.9);
      await input.fill("두 줄의 입력공간을 유지합니다.\n다음 줄도 온전히 보입니다.");
      const typed = await inputMetrics(page);
      expect(typed.clipped).toBeLessThanOrEqual(1);
      expect(typed.height).toBeGreaterThanOrEqual(typed.lineHeight * 2 + typed.padding - 1);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`compact-pc-${product}.png`), fullPage: false });
      if (product === "review") {
        const originalSizes: Record<string, number> = {
          "icon-plus.svg": 21, "icon-chevron-down-14.svg": 14,
          "icon-chevron-down-12.svg": 12, "icon-coins.svg": 15,
          "icon-mic.svg": 21, "icon-arrow-up.svg": 21, "icon-globe.svg": 16,
        };
        const slots = await page.getByTestId("chat-input").locator('span[style*="/assets/composer-compact/"]').evaluateAll(nodes => nodes.map(node => {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return { mask: style.maskImage, width: box.width, height: box.height };
        }));
        expect(slots.length).toBeGreaterThanOrEqual(4);
        for (const slot of slots) {
          const filename = slot.mask.match(/icon-[a-z0-9-]+\.svg/)?.[0];
          expect(filename).toBeTruthy();
          expect(slot.width).toBe(originalSizes[filename!]);
          expect(slot.height).toBe(originalSizes[filename!]);
        }
        for (const filename of Object.keys(originalSizes)) {
          const response = await page.request.head(`/assets/composer-compact/${filename}`);
          expect(response.ok(), filename).toBe(true);
          expect(Number(response.headers()["content-length"]), filename).toBeGreaterThan(0);
        }
      }
    });
    });

    test(`touch tablet ${product} keeps primary controls at 44px`, { tag: "@ui-risk" }, async ({ page }) => {
      await enterCompactComposer(page, product, 1024, 900);
      const composer = page.getByTestId("chat-input");
      for (const id of ["composer-tools-button", "composer-model-select", "chat-send-button"]) {
        const box = (await composer.getByTestId(id).boundingBox())!;
        expect(box.width, id).toBeGreaterThanOrEqual(44);
        expect(box.height, id).toBeGreaterThanOrEqual(44);
      }
      if (product === "chat") expect((await composer.getByTestId("composer-auto-routing-toggle").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expectNoHorizontalOverflow(page);
    });

    for (const width of [320, 360, 390, 430]) {
      test(`mobile ${product} at ${width}px keeps conversation room and full-width input`, { tag: "@ui-risk" }, async ({ page }, testInfo) => {
        await enterCompactComposer(page, product, width, 680);
        await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
        const metrics = await inputMetrics(page);
        if (width === 390) await testInfo.attach("compact-mobile-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
        expect(metrics.fontSize).toBe(16);
        expect(metrics.height).toBeGreaterThanOrEqual(metrics.lineHeight + metrics.padding - 1);
        expect(metrics.widthRatio).toBeGreaterThanOrEqual(0.9);
        expect(metrics.cardHeight).toBeLessThanOrEqual(164);
        const inputBox = (await page.getByTestId("chat-textarea").boundingBox())!;
        const composer = page.getByTestId("chat-input");
        for (const id of ["composer-tools-button", "chat-send-button"]) {
          const control = composer.getByTestId(id);
          const box = (await control.boundingBox())!;
          expect(box.height, id).toBeGreaterThanOrEqual(44);
          expect(box.width, id).toBeGreaterThanOrEqual(44);
          expect(box.y, id).toBeGreaterThanOrEqual(inputBox.y + inputBox.height - 1);
        }
        const modelBox = (await composer.getByTestId("composer-model-select").boundingBox())!;
        expect(modelBox.height).toBeGreaterThanOrEqual(44);
        expect(modelBox.width).toBeGreaterThanOrEqual(44);
        expect(modelBox.y + modelBox.height <= inputBox.y + 1 || modelBox.y >= inputBox.y + inputBox.height - 1).toBe(true);
        const modeRow = composer.getByTestId("composer-product-mode-row");
        await expect(modeRow).toBeVisible();
        const modeBox = (await modeRow.boundingBox())!;
        expect(modeBox.y + modeBox.height).toBeLessThanOrEqual(inputBox.y + 1);
        await expectNoHorizontalOverflow(page);
        if (width === 390) await page.screenshot({ path: testInfo.outputPath(`compact-mobile-${product}.png`), fullPage: false });
        await expect(composer.getByTestId("request-credit-estimate")).toHaveCount(0);
        await expect(composer.getByTestId("auto-variable-credit-notice")).toHaveCount(0);
      });
    }

    test(`keyboard ${product} folds context while retaining input, models and controls`, { tag: "@ui-risk" }, async ({ page }, testInfo) => {
      await enterCompactComposer(page, product, 390, 680);
      const input = page.getByTestId("chat-textarea");
      await input.focus();
      await input.evaluate(node => {
        node.dataset.compactCompositionInstance = "original";
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        node.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
      });
      await page.keyboard.insertText("한글 조합");
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", { configurable: true, get: () => 430 });
        viewport.dispatchEvent(new Event("resize"));
      });
      await expect(page.getByTestId("composer-product-mode-row")).toHaveCount(0);
      const metrics = await inputMetrics(page);
      await testInfo.attach("compact-keyboard-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
      expect(metrics.cardHeight).toBeLessThanOrEqual(120);
      expect(metrics.clipped).toBeLessThanOrEqual(1);
      await expect(input).toHaveAttribute("data-compact-composition-instance", "original");
      await expect(input).toHaveValue("한글 조합");
      const trigger = page.getByTestId("composer-model-select");
      await trigger.click();
      const picker = page.locator("#chat-input-popover");
      await expect(picker).toBeVisible();
      if (product === "chat") {
        const autoControl = picker.getByTestId("auto-routing-toggle").getByRole("switch");
        await expect(autoControl).toHaveAttribute("aria-checked", "true");
        await autoControl.click();
        await expect(autoControl).toHaveAttribute("aria-checked", "false");
        await autoControl.click();
        await expect(autoControl).toHaveAttribute("aria-checked", "true");
      }
      await page.keyboard.press("Escape");
      await expect(input).toHaveValue("한글 조합");
      await input.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한글 조합" })));
      await expectNoHorizontalOverflow(page);
    });
  }

  for (const language of ["en", "ko", "de", "fr", "es", "pt", "zh"] as const) {
    test(`${language} Auto context keeps product targets and complete labels at 320px`, { tag: "@ui-risk" }, async ({ page }) => {
      await enterCompactComposer(page, "chat", 320, 680, language);
      const composer = page.getByTestId("chat-input");
      const modelPicker = composer.getByTestId("composer-model-select");
      const modelLabel = (await modelPicker.innerText()).trim();
      expect(await modelPicker.getAttribute("aria-label")).toContain(modelLabel);
      for (const product of ["chat", "review"]) {
        const target = composer.getByTestId(`chat-product-${product}`);
        const box = (await target.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        const outside = await target.evaluate(node => {
          const bounds = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node.querySelector("span")!);
          return Array.from(range.getClientRects()).some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        });
        expect(outside).toBe(false);
      }
      const mode = composer.getByTestId("composer-auto-routing-toggle");
      await expect(mode).toHaveAttribute("aria-checked", "true");
      expect(await mode.getAttribute("aria-label")).toContain((await mode.locator(":scope > span").first().innerText()).trim());
      const modeBox = (await mode.boundingBox())!;
      const inputBox = (await composer.getByTestId("chat-textarea").boundingBox())!;
      expect(modeBox.y + modeBox.height).toBeLessThanOrEqual(inputBox.y + 1);
      await expectNoHorizontalOverflow(page);
    });
  }
});
