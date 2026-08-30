import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import {
  freezeAnimations,
  restoreActiveConversation,
} from "./support/chat-state-fixtures";
import {
  modelWebSearchIsDispatchable,
} from "@/lib/webSearchCapability";
import { ALL_WEB_SEARCH_BACKENDS_READY } from "@/lib/webSearchBackends";

// ---------------------------------------------------------------------------
// How much of a phone screen the *answers* actually get.
//
// The multi-model mobile shell stacks six horizontal bands above and below the
// answer canvas -- header, model tabs, comparison rail, composer tool chips,
// composer, disclaimer -- and each of them used to claim a full row of its
// own even in the steady state where it had nothing new to say. On a 390x680
// viewport that left ChatMessageList with under a third of the shell.
//
// These tests measure the answer canvas as a share of the shell rather than
// asserting on class names, so any future band that quietly reclaims a row
// fails here regardless of how it is styled.
//
// Runs on desktop-chromium with hasTouch so one project can drive the exact
// viewports the acceptance criteria name (390x680, 320x640, 430x680 ...).
// useIsMobileShell() needs a coarse pointer as well as a narrow width.
// ---------------------------------------------------------------------------

test.use({ hasTouch: true });

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Geometry is measured on one engine at explicit viewports; run with --project=desktop-chromium."
  );
});

// Two models that can dispatch a search and one that cannot -- the partial
// state the chip exists to make legible.
//
// The fixture has now moved twice under the same capability table, which is
// why the assertion below states it in the fixture's own terms rather than
// trusting the model ids. On 2026-08-26 `gpt-5-4-mini` was swapped out for
// `gpt-5-6-luna` because mini is UNVERIFIED and Gemini had stopped counting,
// leaving one supported model out of three. On 2026-08-27 the swap reversed:
// Gemini searches through the application-managed backend now, so it is
// supported, and mini comes back as the one model that cannot search. Both are
// Guest/standard tier, so the tiering of the fixture is unchanged.
const MODEL_A = "gpt-5-6-luna";
const MODEL_B = "gemini-3-6-flash";
const MODEL_C = "gpt-5-4-mini";
const THREE_MODELS = [MODEL_A, MODEL_B, MODEL_C];

/** The answer canvas must keep at least this share of the mobile shell. */
const MIN_LIST_SHARE = 0.34;
/** ... and this many CSS pixels on the smallest supported phone. */
const MIN_LIST_HEIGHT_SMALL = 180;

const seededMessages = (models: string[]): QaConversationMessage[] => [
  { id: "u1", role: "user", content: "Testing in progress." },
  ...models.map((modelId, index) => ({
    id: `a${index + 1}`,
    role: "assistant" as const,
    modelId,
    status: "normal",
    content:
      "Yes, I confirmed the test. You can keep sending messages, or I can help " +
      "you walk through a feature test.",
  })),
];

type EnterOptions = {
  lang?: string;
  models?: string[];
  viewport: { width: number; height: number };
  webSearchMode?: "off" | "auto" | "always";
};

async function enterMobileComparison(page: Page, options: EnterOptions) {
  const {
    lang = "ko",
    models = THREE_MODELS,
    viewport,
    webSearchMode = "always",
  } = options;

  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, {
    selectedModels: models,
    messages: seededMessages(models),
    webSearchMode,
  });
  await restoreActiveConversation(page);

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("chat-message-list").first()).toBeVisible();
  await freezeAnimations(page);
}

export type ShellMetrics = {
  shellHeight: number;
  listHeight: number;
  listShare: number;
  headerHeight: number;
  tabsHeight: number;
  railHeight: number;
  toolChipRowHeight: number;
  composerHeight: number;
  disclaimerHeight: number;
  /** Gap between the bottom of the last message and the top of the rail/composer. */
  lastMessageClearance: number;
};

async function readShellMetrics(page: Page): Promise<ShellMetrics> {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const visible = nodes.find((node) => node.getBoundingClientRect().height > 0);
      return visible?.getBoundingClientRect() ?? null;
    };
    const height = (selector: string) => box(selector)?.height ?? 0;

    const shell = box('[data-testid="mobile-chat-shell"]');
    if (!shell) throw new Error("mobile-chat-shell is not rendered");
    const list = box('[data-testid="chat-message-list"]');
    if (!list) throw new Error("chat-message-list is not rendered");

    // The model tab strip: the row that wraps the tablist.
    const tabs = document.querySelector<HTMLElement>('[role="tablist"]')?.parentElement;

    const messages = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="chat-message"]')
    ).filter((node) => node.getBoundingClientRect().height > 0);
    const lastMessage = messages[messages.length - 1] ?? null;
    const railTop =
      box('[data-testid="comparison-action-rail"]')?.top ??
      box('[data-testid="chat-input"]')?.top ??
      shell.bottom;

    return {
      shellHeight: shell.height,
      listHeight: list.height,
      listShare: list.height / shell.height,
      headerHeight: height('[data-testid="mobile-chat-header"]'),
      tabsHeight: tabs?.getBoundingClientRect().height ?? 0,
      railHeight: height('[data-testid="comparison-action-rail"]'),
      toolChipRowHeight: height('[data-testid="tool-status-chip-row"]'),
      composerHeight: height('[data-testid="chat-input"]'),
      disclaimerHeight: height('[data-testid="chat-ai-disclaimer-mobile"]'),
      lastMessageClearance: lastMessage
        ? railTop - lastMessage.getBoundingClientRect().bottom
        : Number.NaN,
    };
  });
}

function reportMetrics(label: string, metrics: ShellMetrics) {
  // Printed so the before/after height table in the change report is measured
  // rather than estimated.
  console.log(
    `[layout] ${label} ${JSON.stringify(
      Object.fromEntries(
        Object.entries(metrics).map(([key, value]) => [
          key,
          typeof value === "number" ? Math.round(value * 1000) / 1000 : value,
        ])
      )
    )}`
  );
}

test.describe("ChatMessageList visible height (multi-model, steady state)", { tag: "@ui-risk" }, () => {
  test("390x680 keeps at least a third of the shell for the answers", async ({
    page,
  }) => {
    await enterMobileComparison(page, { viewport: { width: 390, height: 680 } });

    const metrics = await readShellMetrics(page);
    reportMetrics("390x680 ko", metrics);

    expect(metrics.shellHeight).toBeCloseTo(680, 0);
    expect(
      metrics.listShare,
      `ChatMessageList share of the shell (${Math.round(metrics.listHeight)}px of ${Math.round(metrics.shellHeight)}px)`
    ).toBeGreaterThanOrEqual(MIN_LIST_SHARE);
  });

  test("320x640 still shows a usable answer canvas", async ({ page }) => {
    await enterMobileComparison(page, { viewport: { width: 320, height: 640 } });

    const metrics = await readShellMetrics(page);
    reportMetrics("320x640 ko", metrics);

    expect(metrics.listHeight).toBeGreaterThanOrEqual(MIN_LIST_HEIGHT_SMALL);
  });

  test("English keeps the same budget as Korean", async ({ page }) => {
    await enterMobileComparison(page, {
      lang: "en",
      viewport: { width: 390, height: 680 },
    });

    const metrics = await readShellMetrics(page);
    reportMetrics("390x680 en", metrics);

    expect(metrics.listShare).toBeGreaterThanOrEqual(MIN_LIST_SHARE);
  });

  for (const width of [320, 360, 390, 430]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await enterMobileComparison(page, { viewport: { width, height: 680 } });
      await expectNoHorizontalOverflow(page);

      const metrics = await readShellMetrics(page);
      reportMetrics(`${width}x680 ko`, metrics);
    });
  }

  test("the last message is never hidden behind the bottom dock", async ({ page }) => {
    await enterMobileComparison(page, { viewport: { width: 390, height: 680 } });

    const metrics = await readShellMetrics(page);
    reportMetrics("390x680 clearance", metrics);
    // The list is its own scroll container, so "not covered" means the last
    // message's box ends above the first bottom-dock band.
    expect(metrics.lastMessageClearance).toBeGreaterThanOrEqual(0);

    const copyButton = page
      .getByTestId("chat-message")
      .last()
      .getByRole("button")
      .first();
    if (await copyButton.count()) {
      const copyBox = await copyButton.boundingBox();
      const railBox = await page.getByTestId("comparison-action-rail").boundingBox();
      if (copyBox && railBox) {
        expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(railBox.y + 0.5);
      }
    }
  });

  test("landscape and a keyboard-shrunk viewport keep the composer usable", async ({
    page,
  }) => {
    await enterMobileComparison(page, { viewport: { width: 667, height: 375 } });
    reportMetrics("667x375 landscape", await readShellMetrics(page));

    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

// ===========================================================================
// The bands that gave the space back, each pinned to what it must still say.
// ===========================================================================

test.describe("Composer tool status", { tag: "@ui-risk" }, () => {
  test("partial web-search support stays legible in a row of its own", async ({
    page,
  }) => {
    await enterMobileComparison(page, {
      lang: "en",
      viewport: { width: 390, height: 680 },
    });

    const chipRow = page.getByTestId("tool-status-chip-row");
    await expect(chipRow).toHaveAttribute("data-placement", "row");
    await expect(chipRow).toHaveAttribute("data-label-variant", "compact");

    // Say it in the fixture's own terms, the way the fully-blocked test below
    // does. Without this the capability table moving under the fixture reads
    // as a chip defect: on 2026-08-26 it surfaced as "expected 2/3, got 1/3"
    // three tests deep, and the chip was right both times.
    const dispatchable = THREE_MODELS.filter((modelId) =>
      // Every backend reachable, because this assertion is about the capability
      // register rather than about one deployment's credentials -- the running
      // server under test sets `WEB_SEARCH_FAKE_BACKEND`, so its own readiness
      // map is full and the fixture has to describe the same population.
      modelWebSearchIsDispatchable(modelId, ALL_WEB_SEARCH_BACKENDS_READY)
    );
    expect(
      dispatchable.length,
      `fixture error: ${dispatchable.length} of ${THREE_MODELS.length} selected models can dispatch a search, so this is no longer the partial-support state`
    ).toBe(2);

    const chip = page.getByTestId("web-search-mode-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-tone", "warning");
    await expect(chip).toHaveAttribute("data-supported-count", "2");
    await expect(chip).toHaveAttribute("data-unsupported-count", "1");
    // Compact, but never reduced to a bare icon: the ratio is on screen.
    await expect(chip).toContainText("2/3");

    // The saving is the shorter *label*, never the textarea's row: the chip
    // sits entirely above the input line it used to share.
    // See docs/ui-contracts/mobile-chat-composer.md.
    const chipBox = await chipRow.boundingBox();
    const textareaBox = await page.getByTestId("chat-textarea").boundingBox();
    expect(
      chipBox!.y + chipBox!.height,
      "the chip row still overlaps the textarea's row"
    ).toBeLessThanOrEqual(textareaBox!.y + 0.5);

    // The whole sentence -- counts, credit ceiling, what the unsupported model
    // does instead -- is still what assistive tech gets.
    await expect(page.locator("#web-search-state-description")).toContainText(
      "2 of 3 selected models can search"
    );
    await expect(page.locator("#web-search-state-description")).toContainText(
      "extra credits are reserved"
    );
  });

  test("the exception detail expands next to the toggle that opens it", async ({
    page,
  }) => {
    await enterMobileComparison(page, {
      lang: "en",
      viewport: { width: 390, height: 680 },
    });

    const toggle = page.getByTestId("web-search-exception-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("web-search-exception-detail")).toHaveCount(0);

    await toggle.click();
    const detail = page.getByTestId("web-search-exception-detail");
    await expect(detail).toBeVisible();
    // The one model in the fixture that cannot search, named. Gemini is in
    // this selection and must *not* appear here: naming a model that will
    // search as one that will not is the same defect as the reverse.
    await expect(detail).toContainText("GPT-5.4 mini");
    await expect(detail).not.toContainText("Gemini");
    // The detail belongs below the chip that opened it, not above the textarea.
    const detailBox = await detail.boundingBox();
    const toggleBox = await toggle.boundingBox();
    expect(detailBox!.y).toBeGreaterThan(toggleBox!.y);
    await expectNoHorizontalOverflow(page);
  });

  test("a fully blocked search keeps its full-width notice, not just an icon", async ({
    page,
  }) => {
    // Neither of these can dispatch a search, so "always" with only these two
    // is the all-unsupported state. Not a Gemini: they searched through no
    // route at all when this was written and now search through the
    // application-managed backend, which would turn the fixture into the
    // one-of-two case the test above already covers -- the chip would correctly
    // read "warning" and this would read it as a defect.
    const blockedPair = ["gpt-5-4-mini", "deepseek-v4-flash"] as const;
    for (const modelId of blockedPair) {
      // The dispatchability question, not `support !== "native"`. That older
      // check would pass for an `app-managed` model, which is not native and
      // does search -- so it would have stopped guarding the fixture on the day
      // a third route existed.
      expect(
        modelWebSearchIsDispatchable(modelId, ALL_WEB_SEARCH_BACKENDS_READY),
        `fixture error: ${modelId} can now search, so this is no longer the fully blocked state`
      ).toBe(false);
    }
    await enterMobileComparison(page, {
      models: [...blockedPair],
      viewport: { width: 320, height: 640 },
    });

    await expect(page.getByTestId("web-search-mode-chip")).toHaveAttribute(
      "data-tone",
      "blocked"
    );
    const notice = page.getByTestId("web-search-unavailable-notice");
    await expect(notice).toBeVisible();
    const turnOff = page.getByTestId("web-search-unavailable-turn-off");
    const box = await turnOff.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    await expectNoHorizontalOverflow(page);
  });

  test("the textarea keeps its own full-width line, not the leftover space", async ({
    page,
  }) => {
    await enterMobileComparison(page, { viewport: { width: 320, height: 640 } });

    const chipBox = await page.getByTestId("tool-status-chip-row").boundingBox();
    const rowBox = await page.getByTestId("composer-textarea-row").boundingBox();
    const textareaBox = await page.getByTestId("chat-textarea").boundingBox();
    // The chip keeps its whole label and the input keeps the whole row --
    // neither is shrunk into the other.
    expect(textareaBox!.y).toBeGreaterThan(chipBox!.y + chipBox!.height - 1);
    expect(textareaBox!.width).toBeGreaterThanOrEqual(rowBox!.width * 0.9);
    await expect(page.getByTestId("web-search-mode-chip")).toContainText("2/3");
    await expectNoHorizontalOverflow(page);
  });

  test("desktop keeps the tool status in its own row", async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectedModels: THREE_MODELS,
      messages: seededMessages(THREE_MODELS),
      webSearchMode: "always",
    });
    await restoreActiveConversation(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();

    await expect(page.getByTestId("tool-status-chip-row")).toHaveAttribute(
      "data-placement",
      "row"
    );
    await expect(page.getByTestId("tool-status-chip-row")).toHaveAttribute(
      "data-label-variant",
      "full"
    );
    // The full sentence, not the compact ratio, is what desktop shows.
    await expect(page.getByTestId("web-search-mode-chip")).toContainText(
      "2/3 supported"
    );
  });
});

test.describe("AI and security disclaimer", { tag: "@ui-risk" }, () => {
  const disclaimer = (page: Page) => page.getByTestId("chat-ai-disclaimer-mobile");
  const details = (page: Page) => page.getByTestId("chat-ai-disclaimer-details");

  test("one line on screen, the approved wording one tap away", async ({ page }) => {
    await enterMobileComparison(page, {
      lang: "en",
      viewport: { width: 390, height: 680 },
    });

    await expect(disclaimer(page)).toContainText("AI answers can be inaccurate");
    await expect(disclaimer(page)).toContainText("Do not enter sensitive data");
    // One line, not four.
    const box = await disclaimer(page).boundingBox();
    expect(box!.height).toBeLessThanOrEqual(32);

    await details(page).click();
    const sheet = page.getByTestId("chat-ai-disclaimer-sheet");
    await expect(sheet).toBeVisible();
    // The full wording, verbatim -- the short line is a summary, never a
    // replacement for what legal approved.
    await expect(sheet).toContainText(
      "Your prompt and any attachment content may be sent to the selected AI providers"
    );
    await expect(sheet).toContainText("avoid entering unnecessary sensitive information");

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    // Focus comes back to what opened it.
    await expect(details(page)).toBeFocused();
  });

  test("the details control has a 44px target and passes AA contrast", async ({
    page,
  }) => {
    await enterMobileComparison(page, {
      lang: "en",
      viewport: { width: 390, height: 680 },
    });

    // The visible control is one line tall; the box a finger actually hits is
    // painted by a pseudo-element, so this measures that instead.
    const target = await details(page).evaluate((node) => {
      const before = getComputedStyle(node, "::before");
      const rect = node.getBoundingClientRect();
      const inset = (value: string) => Math.abs(Number.parseFloat(value) || 0);
      return {
        width: rect.width + inset(before.left) + inset(before.right),
        height: rect.height + inset(before.top) + inset(before.bottom),
      };
    });
    expect(target.width).toBeGreaterThanOrEqual(43.5);
    expect(target.height).toBeGreaterThanOrEqual(43.5);

    // Small text must clear 4.5:1. zinc-400 on white (the old colour) is 2.8:1.
    const contrast = await disclaimer(page).evaluate((node) => {
      const parse = (value: string) =>
        (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = ([r, g, b]: number[]) => {
        const channel = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      let background = "rgb(255, 255, 255)";
      for (let el: Element | null = node; el; el = el.parentElement) {
        const value = getComputedStyle(el).backgroundColor;
        if (value && !value.includes("rgba(0, 0, 0, 0)")) {
          background = value;
          break;
        }
      }
      const a = luminance(parse(getComputedStyle(node).color));
      const b = luminance(parse(background));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("Answer canvas protections", { tag: "@ui-risk" }, () => {
  test("an on-screen keyboard collapses the rail but keeps the composer usable", async ({
    page,
  }) => {
    await enterMobileComparison(page, { viewport: { width: 390, height: 680 } });
    const rail = page.getByTestId("comparison-action-rail");
    await expect(rail).toHaveAttribute("data-collapsed", "false");

    // Stand in for the keyboard: visualViewport shrinks, the layout viewport
    // does not -- the exact signal useCompactBottomDock reads.
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => window.innerHeight * 0.5,
      });
      viewport.dispatchEvent(new Event("resize"));
    });

    await expect(rail).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("comparison-action-rail-disclosure")).toBeVisible();
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
    const sendBox = await page.getByTestId("chat-send-button").boundingBox();
    expect(Math.min(sendBox!.width, sendBox!.height)).toBeGreaterThanOrEqual(43.5);
    await expectNoHorizontalOverflow(page);
  });

  test("200% text zoom keeps every bottom control operable and unclipped", async ({
    page,
  }) => {
    // 200% browser zoom halves the layout viewport in CSS pixels.
    await enterMobileComparison(page, { viewport: { width: 195, height: 340 } });

    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
    await expect(page.getByTestId("chat-ai-disclaimer-details")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("answers, then the comparison actions, then the composer", async ({ page }) => {
    await enterMobileComparison(page, { viewport: { width: 390, height: 680 } });

    const order = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          '[data-testid="mobile-model-tab"], [data-testid="chat-message"], [data-testid="comparison-action-rail"], [data-testid="chat-input"], [data-testid="chat-ai-disclaimer-mobile"]'
        )
      );
      const seen: string[] = [];
      for (const node of nodes) {
        const id = node.getAttribute("data-testid")!;
        if (!seen.includes(id)) seen.push(id);
      }
      return seen;
    });

    expect(order.indexOf("chat-message")).toBeGreaterThan(
      order.indexOf("mobile-model-tab")
    );
    expect(order.indexOf("comparison-action-rail")).toBeGreaterThan(
      order.indexOf("chat-message")
    );
    expect(order.indexOf("chat-input")).toBeGreaterThan(
      order.indexOf("comparison-action-rail")
    );
    expect(order.indexOf("chat-ai-disclaimer-mobile")).toBeGreaterThan(
      order.indexOf("chat-input")
    );
  });

  test("scrolling up keeps the comparison and send controls on screen", async ({
    page,
  }) => {
    await enterMobileComparison(page, { viewport: { width: 390, height: 680 } });

    const before = await page.getByTestId("comparison-action-rail").boundingBox();
    await page.getByTestId("chat-message-list").first().evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    const after = await page.getByTestId("comparison-action-rail").boundingBox();

    // No scroll-direction hiding: the rail is exactly where it was.
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.height).toBeCloseTo(before!.height, 0);
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
  });
});
