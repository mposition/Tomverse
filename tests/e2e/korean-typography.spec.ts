import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockPublicBillingConfig,
  mockPublicProofMetrics,
  prepareGuestPage,
} from "./support/app-fixtures";

// Measures the rendered line each character of `word` lands on inside
// `selector`, using Range.getBoundingClientRect() so wrapping is read from
// actual layout rather than guessed from string length. Returns the number
// of distinct line positions the word's characters occupy -- 1 means the
// word stayed on a single line.
async function countLinesForWord(
  page: Page,
  selector: string,
  word: string
): Promise<number> {
  return page.evaluate(
    ({ selector, word }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Selector not found: ${selector}`);
      const fullText = el.textContent ?? "";
      const wordStart = fullText.indexOf(word);
      if (wordStart === -1) {
        throw new Error(`Word "${word}" not found in "${fullText}"`);
      }
      const wordEnd = wordStart + word.length;

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const lineTops = new Set<number>();
      let node: Node | null;
      let consumed = 0;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? "";
        const nodeStart = consumed;
        const nodeEnd = consumed + text.length;
        const from = Math.max(nodeStart, wordStart);
        const to = Math.min(nodeEnd, wordEnd);
        for (let i = from; i < to; i++) {
          const range = document.createRange();
          range.setStart(node, i - nodeStart);
          range.setEnd(node, i - nodeStart + 1);
          const rect = range.getBoundingClientRect();
          lineTops.add(Math.round(rect.top));
        }
        consumed = nodeEnd;
      }
      return lineTops.size;
    },
    { selector, word }
  );
}

// Counts rendered lines of an element by clustering the top offsets of every
// non-whitespace character's Range rect -- robust to soft-wraps that a plain
// string/line-height calculation would miss or mis-measure with CJK glyphs.
async function countRenderedLines(page: Page, selector: string): Promise<number> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Selector not found: ${selector}`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const lineTops = new Set<number>();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        lineTops.add(Math.round(rect.top));
      }
    }
    return lineTops.size;
  }, selector);
}

async function selectLanguage(page: Page, lang: "ko" | "en" | "zh") {
  const select = page.getByLabel("Language");
  if ((await select.inputValue()) !== lang) {
    await select.selectOption(lang);
  }
}

test.describe("Korean typography: landing hero", () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
  });

  test("keeps 비교하세요 intact and wraps within 4 lines at 320x568", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await selectLanguage(page, "ko");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toBeVisible();
    await expect(title).toContainText("비교하세요");

    const lineCount = await countRenderedLines(page, "[data-testid='landing-hero-title']");
    expect(lineCount).toBeLessThanOrEqual(4);

    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "비교하세요");
    expect(wordLines).toBe(1);

    const box = await title.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 1);

    await expectNoHorizontalOverflow(page);
  });

  test("keeps CTA reachable and hero readable at 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await selectLanguage(page, "ko");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toContainText("비교하세요");
    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "비교하세요");
    expect(wordLines).toBe(1);

    await expect(page.getByTestId("landing-primary-cta")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("keeps desktop hero hierarchy and line count at 1440x900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await selectLanguage(page, "ko");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toBeVisible();
    const lineCount = await countRenderedLines(page, "[data-testid='landing-hero-title']");
    expect(lineCount).toBeLessThanOrEqual(3);

    const fontSize = await title.evaluate((el) => window.getComputedStyle(el).fontSize);
    expect(parseFloat(fontSize)).toBeGreaterThanOrEqual(48);

    await expectNoHorizontalOverflow(page);
  });

  test("does not break English hero words mid-character at 320x568", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toContainText("Compare multiple AI answers.");
    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "Compare");
    expect(wordLines).toBe(1);

    await expectNoHorizontalOverflow(page);
  });

  test("still wraps long Chinese hero text without overflow at 320x568", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await selectLanguage(page, "zh");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toContainText("比较多个 AI 的回答");
    await expectNoHorizontalOverflow(page);

    const box = await title.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 1);
  });

  test("keeps hero readable under 200% browser zoom", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await selectLanguage(page, "ko");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page.waitForTimeout(100);

    await expectNoHorizontalOverflow(page);
    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "비교하세요");
    expect(wordLines).toBe(1);
  });

  test("dark theme keeps the same wrapping behavior", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await selectLanguage(page, "ko");

    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "비교하세요");
    expect(wordLines).toBe(1);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("Korean typography: chat welcome screen", () => {
  test("keeps 도와드릴까요 intact and wraps within 2 lines at 320x568", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toBeVisible();
    await expect(greeting).toContainText("도와드릴까요");

    const lineCount = await countRenderedLines(page, "[data-testid='chat-welcome-greeting']");
    expect(lineCount).toBeLessThanOrEqual(2);

    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "도와드릴까요");
    expect(wordLines).toBe(1);

    await expectNoHorizontalOverflow(page);
  });

  test("welcome text never overlaps the chat input box at 320x568", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    const input = page.getByTestId("chat-textarea");
    await expect(greeting).toBeVisible();
    await expect(input).toBeVisible();

    const greetingBox = await greeting.boundingBox();
    const inputBox = await input.boundingBox();
    expect(greetingBox).not.toBeNull();
    expect(inputBox).not.toBeNull();

    const overlaps =
      greetingBox!.y < inputBox!.y + inputBox!.height &&
      greetingBox!.y + greetingBox!.height > inputBox!.y;
    expect(overlaps).toBe(false);
  });

  test("keeps welcome layout correct at 390x844", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toContainText("도와드릴까요");
    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "도와드릴까요");
    expect(wordLines).toBe(1);

    await expectNoHorizontalOverflow(page);
  });

  test("does not break the English welcome greeting mid-word at 320x568", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toContainText("How can I help you today?");
    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "today");
    expect(wordLines).toBe(1);

    await expectNoHorizontalOverflow(page);
  });

  test("keeps the Chinese welcome greeting wrapping naturally at 320x568", async ({ page }) => {
    await prepareGuestPage(page, "zh");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toContainText("你好");
    await expectNoHorizontalOverflow(page);
  });

  test("dark theme keeps the same welcome wrapping behavior", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/chat?entry=guest-preview");
    await expect(page.getByTestId("chat-welcome-greeting")).toBeVisible();

    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "도와드릴까요");
    expect(wordLines).toBe(1);
    await expectNoHorizontalOverflow(page);
  });
});
