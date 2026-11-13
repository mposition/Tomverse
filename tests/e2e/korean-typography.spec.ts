import { expect, test, type Locator, type Page } from "@playwright/test";
import { LOCALIZED_SEO_PATHS } from "@/lib/seo";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  mockChatStream,
  mockPublicBillingConfig,
  mockPublicProofMetrics,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.y < b.y + b.height && a.y + a.height > b.y && a.x < b.x + b.width && a.x + a.width > b.x;
}

/**
 * Waits until the element actually contains the word about to be measured.
 *
 * Being *visible* is not the same as carrying the right copy. On a route the
 * server rendered in English, LanguageProvider restores a stored preference in
 * an effect scheduled with `setTimeout(..., 0)` -- the documented migration
 * path for a visitor whose choice predates the `tomverse_lang` cookie the
 * server reads, which is exactly what prepareGuestPage sets up. So an element
 * can be on screen, and still be showing "Hello! How can I help you today?"
 * when the Korean measurement runs.
 *
 * That is how `dark theme keeps the same welcome wrapping behavior` flaked on
 * mobile-safari in run #39: it waited for the greeting to be visible and then
 * measured, and reported `Word "도와드릴까요" not found in "Hello! How can I
 * help you today?"`. Every sibling test happened to wait for its own text
 * first -- through `toContainText` or a `:has-text()` locator -- so the gap was
 * one call site rather than a rule.
 *
 * Waiting here makes it a rule, and it cannot hide a copy that never arrives:
 * the wait fails on its own timeout, naming the word and the element.
 */
async function expectWordPresent(locator: Locator, word: string) {
  await expect(locator, `waiting for "${word}" before measuring its wrapping`).toContainText(word);
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
  await expectWordPresent(page.locator(selector).first(), word);
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

// Locator-based variant of countLinesForWord.
//
// The block below used to stamp a `data-ko-heading` attribute on the element
// and then look it up by selector. React can re-render (or recreate) the
// heading between those two steps -- the pricing page hydrates its runtime
// prices -- and the mark goes with it, so the measurement failed with
// "Selector not found" rather than with anything about wrapping. Measuring
// through the locator's own element handle removes the window entirely.
async function countLinesForWordIn(locator: Locator, word: string): Promise<number> {
  await expectWordPresent(locator, word);
  return locator.evaluate((el, target) => {
    const fullText = el.textContent ?? "";
    const wordStart = fullText.indexOf(target);
    if (wordStart === -1) {
      throw new Error(`Word "${target}" not found in "${fullText}"`);
    }
    const wordEnd = wordStart + target.length;

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
        lineTops.add(Math.round(range.getBoundingClientRect().top));
      }
      consumed = nodeEnd;
    }
    return lineTops.size;
  }, word);
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
  const select = page.getByTestId("marketing-language-switcher");
  if ((await select.inputValue()) === lang) return;

  // The switcher pushes to the localized route for pages that have one
  // (lib/seo.ts LOCALIZED_SEO_PATHS), and those routes have their own root
  // layout, so it is a *document* navigation rather than a client one. Two
  // things follow, and both bit this helper:
  //
  // - an evaluate issued straight after `selectOption` can hit the destroyed
  //   context of the old document;
  // - `LanguageProvider` sets `documentElement.lang` on the *old* page before
  //   the navigation even starts, so waiting for the language alone returns
  //   while the old document is still on screen, and the measurement races
  //   the navigation.
  //
  // Waiting for the URL first pins which document is being measured. On a
  // route with no localized variant (e.g. /pricing) no navigation happens and
  // the path simply stays put.
  const before = new URL(page.url()).pathname;
  const localizable = LOCALIZED_SEO_PATHS.includes(
    before as (typeof LOCALIZED_SEO_PATHS)[number]
  );
  await select.selectOption(lang);
  if (localizable) {
    const destination = before === "/" ? `/${lang}` : `/${lang}${before}`;
    await page.waitForURL((url) => url.pathname === destination);
    await page.waitForLoadState("load");
  }

  // Only now the fonts: ko and zh re-point `--font-ui` through `:lang()`, and
  // those faces are `preload: false` by policy
  // (docs/ui-contracts/typography.md), so they are fetched once the language
  // changes. Measuring line breaks before the swap settles measures the
  // *fallback* face's metrics -- the same heading wraps differently, and an
  // intact "비교하세요" reads as split across lines.
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            await document.fonts.ready;
            return document.documentElement.lang;
          });
        } catch {
          return null;
        }
      },
      { message: `language did not settle on "${lang}"` }
    )
    .toBe(lang);
}

test.describe("Korean typography: landing hero", () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
  });

  test("keeps 고민은 intact and wraps within 4 lines at 320x568", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await selectLanguage(page, "ko");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toBeVisible();
    await expect(title).toContainText("고민은");

    const lineCount = await countRenderedLines(page, "[data-testid='landing-hero-title']");
    expect(lineCount).toBeLessThanOrEqual(4);

    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "고민은");
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
    await expect(title).toContainText("고민은");
    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "고민은");
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
    await expect(title).toContainText("Let Tomverse help you choose.");
    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "Tomverse");
    expect(wordLines).toBe(1);

    await expectNoHorizontalOverflow(page);
  });

  test("still wraps long Chinese hero text without overflow at 320x568", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await selectLanguage(page, "zh");

    const title = page.getByTestId("landing-hero-title");
    await expect(title).toContainText("让 Tomverse 帮你选。");
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
    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "고민은");
    expect(wordLines).toBe(1);
  });

  test("dark theme keeps the same wrapping behavior", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await selectLanguage(page, "ko");

    const wordLines = await countLinesForWord(page, "[data-testid='landing-hero-title']", "고민은");
    expect(wordLines).toBe(1);
    await expectNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// UI-006. Word preservation was only enforced on the landing H1. Everything
// else in the Korean display hierarchy -- the Review section headings, the
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
  { route: "/products/review", selector: "[data-testid='landing-hero-title']", word: "비교하세요", label: "Review H1" },
  { route: "/products/review", selector: "h2:has-text('업그레이드하세요')", word: "업그레이드하세요", label: "Review pricing H2" },
  { route: "/products/review", selector: "h2:has-text('시작됩니다')", word: "시작됩니다", label: "Review CTA H2" },
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
        const lines = await countLinesForWordIn(locator, heading.word);
        expect(lines, `${heading.label}: "${heading.word}" split across lines`).toBe(1);
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
    await expect(heading).toBeVisible();
    expect(await countLinesForWordIn(heading, "선택하세요")).toBe(1);
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
    await page.goto("/review?entry=guest-preview");

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
    await page.goto("/review?entry=guest-preview");

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
    await page.goto("/review?entry=guest-preview");

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
    await page.goto("/review");

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
    await page.goto("/review?entry=guest-preview");

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
    await page.goto("/review?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toContainText("How can I help you today?");
    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "today");
    expect(wordLines).toBe(1);

    await expectNoHorizontalOverflow(page);
  });

  test("keeps the Chinese welcome greeting wrapping naturally at 320x568", async ({ page }) => {
    await prepareGuestPage(page, "zh");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/review?entry=guest-preview");

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toContainText("你好");
    await expectNoHorizontalOverflow(page);
  });

  test("dark theme keeps the same welcome wrapping behavior", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/review?entry=guest-preview");
    await expect(page.getByTestId("chat-welcome-greeting")).toBeVisible();

    const wordLines = await countLinesForWord(page, "[data-testid='chat-welcome-greeting']", "도와드릴까요");
    expect(wordLines).toBe(1);
    await expectNoHorizontalOverflow(page);
  });
});

/*
 * Answer bodies in Chat and in each Review comparison panel. A production
 * capture of the guest-default three-panel Review at 1440x900 printed
 * "6주 이사 준비 체크 / 리스트" and split "도시/로" across lines: Hangul may break
 * after any syllable under `word-break: normal`, and a third of 1440px is
 * narrow enough to hit it on every paragraph.
 */
const KOREAN_ANSWER_URL =
  "https://example.com/moving/checklist/a-very-long-path-segment-without-any-spaces-0123456789abcdef";
const KOREAN_ANSWER = [
  "## 6주 이사 준비 체크리스트 (예산 $3,000)",
  "",
  "새로운 도시로 이사할 때는 체크리스트를 미리 만들어 두면 예산과 일정을 한눈에 관리할 수 있습니다. 이삿짐센터 견적은 최소 세 곳에서 받아 비교하고, 전입신고와 공과금 이전은 이사 당일 전후로 처리하세요.",
  "",
  `참고: ${KOREAN_ANSWER_URL}`,
].join("\n");
const CHINESE_ANSWER =
  "搬家前六周就应该开始准备清单，把预算和日程放在一起管理会更轻松。至少比较三家搬家公司的报价，并在搬家当天前后办理地址变更和水电燃气的转移手续。";

/**
 * Every whitespace-delimited token of `el` that contains Hangul but whose
 * characters landed on more than one rendered line, plus how far any
 * character sticks out past the element's right edge.
 */
async function measureAnswerWrapping(el: Locator) {
  return el.evaluate((root) => {
    const chars: { ch: string; top: number; right: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) {
          chars.push({ ch: " ", top: -1, right: 0 });
          continue;
        }
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        chars.push({ ch: text[i], top: Math.round(rect.top), right: rect.right });
      }
      // Separate text nodes are separate tokens (heading vs paragraph).
      chars.push({ ch: " ", top: -1, right: 0 });
    }
    const split: string[] = [];
    let token: typeof chars = [];
    const flush = () => {
      const word = token.map((c) => c.ch).join("");
      // A line-height of half a glyph is enough to tell two lines apart.
      const tops = token.map((c) => c.top);
      if (/[가-힣]/.test(word) && Math.max(...tops) - Math.min(...tops) > 4) split.push(word);
      token = [];
    };
    for (const c of chars) {
      if (c.ch === " ") flush();
      else token.push(c);
    }
    flush();
    const edge = root.getBoundingClientRect().right;
    const overflow = Math.max(0, ...chars.filter((c) => c.top >= 0).map((c) => c.right - edge));
    return { split, overflow };
  });
}

async function sendGuestAnswer(page: Page, testInfo: Parameters<typeof sendChatMessage>[1], answer: string, lang: "ko" | "zh") {
  await prepareGuestPage(page, lang);
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
  });
  await mockChatStream(page, answer);
  await page.goto("/review?entry=guest-preview");
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await sendChatMessage(page, testInfo, lang === "ko" ? "이사 준비 체크리스트" : "搬家清单");
}

test.describe("Korean typography: answer bodies wrap between 어절", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    test(`no mid-word break in answers at ${viewport.width}x${viewport.height}`, { tag: "@ui-risk" }, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await sendGuestAnswer(page, testInfo, KOREAN_ANSWER, "ko");

      const answers = page.locator('[data-testid="chat-message"]').filter({ hasText: "체크리스트를" });
      await expect(answers.first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const visible = await answers.evaluateAll((els) =>
        els.map((el, i) => (el.getBoundingClientRect().width > 0 ? i : -1)).filter((i) => i >= 0)
      );
      expect(visible.length).toBeGreaterThan(0);
      for (const i of visible) {
        const answer = answers.nth(i);
        const { split, overflow } = await measureAnswerWrapping(answer);
        expect(split, "Korean words split across lines").toEqual([]);
        // The URL has no break opportunity, so it must still break rather
        // than push past the answer's edge.
        expect(overflow).toBeLessThanOrEqual(1);
      }
      await expectNoHorizontalOverflow(page);
    });
  }

  test("Chinese answers keep breaking between characters", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await sendGuestAnswer(page, testInfo, CHINESE_ANSWER, "zh");

    const answer = page.locator('[data-testid="chat-message"]').filter({ hasText: "搬家公司" }).first();
    await expect(answer).toBeVisible();
    const wordBreak = await answer.locator("p").first().evaluate((el) => getComputedStyle(el).wordBreak);
    expect(wordBreak).not.toBe("keep-all");
    await expectNoHorizontalOverflow(page);
  });
});
