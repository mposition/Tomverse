import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  mockPublicBillingConfig,
  mockPublicProofMetrics,
  prepareGuestPage,
} from "./support/app-fixtures";

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.y < b.y + b.height && a.y + a.height > b.y && a.x < b.x + b.width && a.x + a.width > b.x;
}

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

// ---------------------------------------------------------------------------
// UI-006. Word preservation was only enforced on the landing H1. Everything
// else in the Korean display hierarchy -- the landing section headings, the
// pricing H1 and its section headings -- wrapped with the browser default,
// which treats every Hangul syllable as a break opportunity and produces
// "선택하\n세요". The rule now lives in one place (lib/displayHeading.ts) and
// this block is what keeps it applied where it belongs.
//
// Line positions come from Range rects, not from string indices: with a
// system font substituted for the product's, a character-count heuristic
// measures the test runner's font stack rather than the layout.
// ---------------------------------------------------------------------------
const KO_DISPLAY_HEADINGS = [
  { route: "/", selector: "[data-testid='landing-hero-title']", word: "비교하세요", label: "landing H1" },
  { route: "/", selector: "h2:has-text('업그레이드하세요')", word: "업그레이드하세요", label: "landing pricing H2" },
  { route: "/", selector: "h2:has-text('시작됩니다')", word: "시작됩니다", label: "landing CTA H2" },
  { route: "/pricing", selector: "h1:has-text('선택하세요')", word: "선택하세요", label: "pricing H1" },
  { route: "/pricing", selector: "h2:has-text('플랜별 제공 기능 비교')", word: "제공", label: "pricing compare H2" },
] as const;

const KO_HEADING_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

test.describe("Korean typography: display headings keep 어절 intact", () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
  });

  for (const viewport of KO_HEADING_VIEWPORTS) {
    test(`no mid-word break at ${viewport.width}x${viewport.height}`, { tag: "@ui-risk" }, async ({ page }) => {
      await page.setViewportSize(viewport);
      let currentRoute = "";
      for (const heading of KO_DISPLAY_HEADINGS) {
        if (heading.route !== currentRoute) {
          await page.goto(heading.route);
          await selectLanguage(page, "ko");
          currentRoute = heading.route;
        }
        const locator = page.locator(heading.selector).first();
        await expect(locator, `${heading.label} present`).toBeVisible();
        await locator.evaluate((element) => element.setAttribute("data-ko-heading", "1"));
        const lines = await countLinesForWord(page, "[data-ko-heading]", heading.word);
        expect(lines, `${heading.label}: "${heading.word}" split across lines`).toBe(1);
        await locator.evaluate((element) => element.removeAttribute("data-ko-heading"));
      }
      await expectNoHorizontalOverflow(page);
    });
  }

  // Browser zoom is emulated the way ui-zoom-reflow.spec.ts does it -- by
  // shrinking the viewport -- because that is what real zoom does: it changes
  // how many CSS pixels the viewport holds, it does not change CSS pixel
  // sizes. (`document.documentElement.style.zoom` scales the page instead,
  // which is pinch-zoom, and reflows nothing.)
  //
  // 150% of 390 leaves a 260px column, which still fits a five-syllable 어절
  // at the display scale. Below that the column is narrower than the word
  // itself, and no wrapping policy can keep it whole without pushing the page
  // into horizontal overflow -- see lib/displayHeading.ts for why the escape
  // hatch wins that trade.
  test("150% zoom keeps 어절 intact", { tag: "@ui-risk" }, async ({ page }) => {
    await page.setViewportSize({ width: 260, height: 563 });
    await page.goto("/pricing");
    await selectLanguage(page, "ko");

    const heading = page.locator("h1:has-text('선택하세요')").first();
    await heading.evaluate((element) => element.setAttribute("data-ko-heading", "1"));
    expect(await countLinesForWord(page, "[data-ko-heading]", "선택하세요")).toBe(1);
  });

  test("English and Chinese headings keep their existing wrapping", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/pricing");

    // English is unaffected: `keep-all` is only applied for ko.
    const englishHeading = page.locator("h1").first();
    const englishWordBreak = await englishHeading.evaluate(
      (element) => getComputedStyle(element).wordBreak
    );
    expect(englishWordBreak).not.toBe("keep-all");
    await expectNoHorizontalOverflow(page);

    await selectLanguage(page, "zh");
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

    expect(boxesOverlap(greetingBox!, inputBox!)).toBe(false);
  });

  test("keeps welcome layout correct at 390x844", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toContainText("도와드릴까요");
    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "도와드릴까요");
    expect(wordLines).toBe(1);

    const lineCount = await countRenderedLines(page, "[data-testid='chat-welcome-greeting']");
    expect(lineCount).toBeLessThanOrEqual(2);

    await expectNoHorizontalOverflow(page);
  });

  test("keeps the signed-in welcomeBack greeting intact at 320x568", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toBeVisible();
    await expect(greeting).toContainText("도와드릴까요");
    await expect(greeting).toContainText("다시 만나 반가워요");

    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "도와드릴까요");
    expect(wordLines).toBe(1);

    const box = await greeting.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 1);

    await expectNoHorizontalOverflow(page);
  });

  test("welcome text never overlaps the mobile header or the analytics consent notice at 320x568", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Mobile header overlap only applies to the mobile shell."
    );

    await page.context().addCookies([
      { name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" },
    ]);
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toBeVisible();
    await expect(greeting).toContainText("도와드릴까요");

    const header = page.locator("[data-testid='mobile-chat-shell'] header");
    const consentNotice = page.getByTestId("chat-consent-notice");
    const input = page.getByTestId("chat-textarea");
    await expect(header).toBeVisible();
    await expect(consentNotice).toBeVisible();
    await expect(input).toBeVisible();

    const greetingBox = await greeting.boundingBox();
    const headerBox = await header.boundingBox();
    const consentBox = await consentNotice.boundingBox();
    const inputBox = await input.boundingBox();
    expect(greetingBox && headerBox && consentBox && inputBox).toBeTruthy();

    expect(boxesOverlap(greetingBox!, headerBox!)).toBe(false);
    expect(boxesOverlap(greetingBox!, consentBox!)).toBe(false);
    expect(boxesOverlap(greetingBox!, inputBox!)).toBe(false);

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
