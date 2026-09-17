import { expect, test, type Page } from "@playwright/test";
import {
  createQaPngBuffer,
  expectNoHorizontalOverflow,
  mockAttachmentUpload,
  mockAuthenticatedApi,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import { skipUnlessCanonicalVisualBrowser } from "./support/canonical-visual";
import {
  freezeAnimations,
  installChatModelStub,
  mockDeepResearchStatus,
  mockGuestUsage,
  mockUserUsage,
  restoreActiveConversation,
  setDeterministicTheme,
  setRootFontSize,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

// ---------------------------------------------------------------------------
// The mobile composer contract: docs/ui-contracts/mobile-chat-composer.md
//
// The regression this guards against is a *layout* one, not a copy one. While
// reclaiming vertical space for ChatMessageList, the tool-status chip was moved
// onto the textarea's own flex row, so the input silently became "whatever
// horizontal space the chip did not want" -- on a 390px phone with a
// partial-web-search chip that is barely more than a third of the row.
//
// These tests measure geometry rather than class names, so any future change
// that squeezes, overlaps or scrolls the input away fails here regardless of
// how it is styled:
//
//   - the textarea's row is its own (nothing else intersects it),
//   - it keeps at least 90% of the composer's inner width,
//   - it shows at least one complete line box,
//   - nothing in the composer scrolls sideways,
//
// verified at 320/360/390/430px, with a Korean IME composition in flight, with
// the on-screen keyboard up, and at 200% text scaling.
//
// Runs on desktop-chromium with hasTouch so one project can drive the exact
// viewports the contract names; useIsMobileShell() needs a coarse pointer as
// well as a narrow width.
// ---------------------------------------------------------------------------

test.use({ hasTouch: true });

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Geometry is measured on one engine at explicit viewports; run with --project=desktop-chromium."
  );
});

/** 2 of these 3 can search on a request -- gpt-5-4-mini cannot, so the
 *  composer sits in the partial-support state the contract calls out. */
const MODEL_A = "gpt-5-4-mini";
const MODEL_B = "claude-sonnet-5";
const MODEL_C = "gpt-5-6-luna";
const THREE_MODELS = [MODEL_A, MODEL_B, MODEL_C];
/** Neither of these can search: the fully blocked state. */
const NO_SEARCH_MODELS = ["gpt-5-4-mini", "deepseek-v4-flash"];
/**
 * All three dispatchable: the full-support state.
 *
 * Anthropic and OpenAI only, which is a choice about the *golden images* rather
 * than about capability: these three have been the recorded composer since the
 * baselines were taken, and swapping a model in would change every pixel of a
 * screenshot whose job is to change only when the layout does. Gemini's own
 * search -- application-managed since 2026-08-27, and dispatchable -- is
 * covered by `web-search-composer-state.spec.ts`, which measures state rather
 * than pixels.
 */
const ALL_SEARCH_MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "gpt-5-6-luna"];
const DEEP_RESEARCH_MODEL = "perplexity/sonar-deep-research";

/** The contract's floor: the input keeps ~all of the composer's inner width. */
const MIN_WIDTH_RATIO = 0.9;

const MOBILE_WIDTHS = [320, 360, 390, 430];

const seededMessages = (models: string[]): QaConversationMessage[] => [
  { id: "u1", role: "user", content: "Testing in progress." },
  ...models.map((modelId, index) => ({
    id: `a${index + 1}`,
    role: "assistant" as const,
    modelId,
    status: "normal",
    content: "Yes, I confirmed the test.",
  })),
];

type EnterOptions = {
  lang?: "en" | "ko";
  models?: string[];
  viewport: { width: number; height: number };
  webSearchMode?: "off" | "auto" | "always";
  /** Install the stubs a deep-research run needs (see startDeepResearch). */
  deepResearch?: boolean;
};

async function enterMobileComposer(page: Page, options: EnterOptions) {
  const {
    lang = "ko",
    models = THREE_MODELS,
    viewport,
    webSearchMode = "always",
    deepResearch = false,
  } = options;

  await prepareGuestPage(page, "en");
  await mockAuthenticatedApi(page, {
    selectedModels: models,
    messages: seededMessages(models),
    webSearchMode,
  });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await restoreActiveConversation(page);
  if (deepResearch) {
    // Registered before goto: installChatModelStub and the usage patch both
    // rely on addInitScript / a pre-mount route, so a post-navigation call
    // silently loses the race (see chat-state-visual-regression.spec.ts).
    await installChatModelStub(page, {
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-progress" },
    });
    await mockUserUsage(page, { plan: "Pro" });
    await mockDeepResearchStatus(page, "hold");
  }

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
}

/** Puts a pending Deep Research job (and so its chip) in the composer. */
async function startDeepResearch(page: Page) {
  await page.getByTestId("chat-textarea").fill("Compare three regions.");
  await page.locator('button[aria-controls="chat-input-popover"]').nth(0).click();
  await page.getByTestId("tools-deep-research-row").click();
  await page.getByTestId("deep-research-depth-standard").click();
  await page.getByTestId("deep-research-confirm-start").click();
  // Wait for the sheet (and its full-screen backdrop) to actually close.
  await expect(page.getByTestId("deep-research-confirm-start")).toHaveCount(0);
  // This fixture starts at the model cap (THREE_MODELS, Pro), so the run has
  // no free slot and asks which model to give up rather than dropping one on
  // the user's behalf -- the panels are drawn from `selectedModels`, and a
  // dropped model takes its answers out of the conversation. Choosing here is
  // what the composer state under test comes after; the dialog itself is
  // covered by tests/e2e/deep-research-suggestion.spec.ts.
  // Asserted, not probed: this helper's only caller starts at the cap, so the
  // dialog is always due. A conditional here would quietly skip the step if it
  // ever stopped appearing, and the test would then fail somewhere else.
  const replaceDialog = page.getByTestId("replace-model-dialog");
  await expect(replaceDialog).toBeVisible();
  await replaceDialog.getByRole("button").first().click();
  await expect(replaceDialog).toHaveCount(0);
  // Confirming submits, so the composer comes back empty -- and, with this
  // fixture's quota bookkeeping, disabled. The contract holds in that state
  // too: a disabled input is still an input the user has to be able to read.
}

/** An image attachment, pasted rather than picked, so no file chooser is
 *  involved -- the composer geometry is what is under test, not the picker. */
async function attachPastedImage(page: Page) {
  await attachPastedImages(page, ["qa-image.png"]);
}

async function attachPastedImages(page: Page, names: string[]) {
  const bytes = Array.from(createQaPngBuffer());
  await page.getByTestId("chat-textarea").focus();
  await page.getByTestId("chat-textarea").evaluate((textarea, input) => {
    const dataTransfer = new DataTransfer();
    for (const name of input.names) {
      dataTransfer.items.add(
        new File([new Uint8Array(input.bytes)], name, { type: "image/png" })
      );
    }
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })
    );
  }, { bytes, names });
}

type ComposerGeometry = {
  textareaWidth: number;
  textareaHeight: number;
  /** Width available inside the composer's own padding and border. */
  innerWidth: number;
  widthRatio: number;
  /** Height of one complete line, including the textarea's own padding. */
  lineBox: number;
  /** Pixels the composer would need to scroll sideways. */
  composerOverflow: number;
  /** Pixels the textarea would need to scroll sideways. */
  textareaOverflow: number;
  /** Pixels of the value clipped below the visible box. */
  clippedValueHeight: number;
  /** Every other testable element in the composer that covers the textarea. */
  overlaps: { testId: string; area: number }[];
};

/**
 * Everything the contract measures, read from the live layout in one pass so
 * the numbers describe a single frame.
 */
async function readComposerGeometry(page: Page): Promise<ComposerGeometry> {
  return page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-textarea"]'
    );
    if (!composer) throw new Error("chat-input is not rendered");
    if (!textarea) throw new Error("chat-textarea is not rendered");

    const px = (value: string) => Number.parseFloat(value) || 0;
    const composerRect = composer.getBoundingClientRect();
    const composerStyle = getComputedStyle(composer);
    const innerWidth =
      composerRect.width -
      px(composerStyle.paddingLeft) -
      px(composerStyle.paddingRight) -
      px(composerStyle.borderLeftWidth) -
      px(composerStyle.borderRightWidth);

    const rect = textarea.getBoundingClientRect();
    const style = getComputedStyle(textarea);
    const lineHeight =
      style.lineHeight === "normal"
        ? px(style.fontSize) * 1.2
        : px(style.lineHeight);
    const lineBox =
      lineHeight +
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth);

    // Anything else in the composer that carries a test id -- chips, buttons,
    // badges, notices -- must not share a single pixel with the input box.
    const overlaps = Array.from(
      composer.querySelectorAll<HTMLElement>("[data-testid]")
    )
      .filter(
        (node) =>
          node !== textarea &&
          !node.contains(textarea) &&
          !textarea.contains(node)
      )
      .map((node) => {
        const box = node.getBoundingClientRect();
        const width = Math.max(
          0,
          Math.min(box.right, rect.right) - Math.max(box.left, rect.left)
        );
        const height = Math.max(
          0,
          Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top)
        );
        return { testId: node.dataset.testid ?? "", area: width * height };
      })
      .filter((entry) => entry.area > 0);

    return {
      textareaWidth: rect.width,
      textareaHeight: rect.height,
      innerWidth,
      widthRatio: rect.width / innerWidth,
      lineBox,
      composerOverflow: composer.scrollWidth - composer.clientWidth,
      textareaOverflow: textarea.scrollWidth - textarea.clientWidth,
      clippedValueHeight: textarea.scrollHeight - textarea.clientHeight,
      overlaps,
    };
  });
}

/**
 * The four invariants that hold in every state: own row, full width, one
 * complete line, no sideways scrolling.
 */
async function expectComposerContract(page: Page, label: string) {
  const geometry = await readComposerGeometry(page);
  // Printed so a failure report carries the measured numbers rather than an
  // estimate of them.
  console.log(`[composer] ${label} ${JSON.stringify(geometry)}`);

  expect(
    geometry.overlaps,
    `${label}: these composer elements cover the textarea`
  ).toEqual([]);
  expect(
    geometry.widthRatio,
    `${label}: textarea is ${Math.round(geometry.textareaWidth)}px of the composer's ${Math.round(geometry.innerWidth)}px inner width`
  ).toBeGreaterThanOrEqual(MIN_WIDTH_RATIO);
  expect(
    geometry.textareaHeight,
    `${label}: textarea is shorter than one complete line (${geometry.lineBox}px)`
  ).toBeGreaterThanOrEqual(geometry.lineBox - 0.5);
  expect(geometry.composerOverflow, `${label}: composer scrolls sideways`)
    .toBeLessThanOrEqual(1);
  expect(geometry.textareaOverflow, `${label}: textarea scrolls sideways`)
    .toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);

  return geometry;
}

test.describe("Mobile composer: the textarea owns its row", { tag: "@ui-risk" }, () => {
  for (const width of MOBILE_WIDTHS) {
    test(`${width}px keeps a full-width input line beside a partial-support chip`, async ({
      page,
    }) => {
      await enterMobileComposer(page, { viewport: { width, height: 680 } });

      // The state under test really is the expensive one: a chip that has
      // something to say.
      await expect(page.getByTestId("web-search-mode-chip")).toHaveAttribute(
        "data-tone",
        "warning"
      );

      const geometry = await expectComposerContract(page, `${width}x680`);
      // The chip row sits entirely above the input row, not beside it.
      const chipBox = await page.getByTestId("tool-status-chip-row").boundingBox();
      const textareaBox = await page.getByTestId("chat-textarea").boundingBox();
      expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(textareaBox!.y + 0.5);
      // A phone-sized composer, so "90% of the inner width" is a real number
      // of pixels rather than a ratio of something already tiny.
      expect(geometry.textareaWidth).toBeGreaterThan(width * 0.7);
    });
  }

  test("a fully blocked search state does not narrow the input either", async ({
    page,
  }) => {
    await enterMobileComposer(page, {
      models: NO_SEARCH_MODELS,
      viewport: { width: 320, height: 640 },
    });

    await expect(page.getByTestId("web-search-mode-chip")).toHaveAttribute(
      "data-tone",
      "blocked"
    );
    await expect(page.getByTestId("web-search-unavailable-notice")).toBeVisible();
    await expectComposerContract(page, "320x640 blocked");
  });

  test("the expanded exception detail stays above the input, not over it", async ({
    page,
  }) => {
    await enterMobileComposer(page, {
      lang: "en",
      viewport: { width: 390, height: 680 },
    });

    await page.getByTestId("web-search-exception-toggle").click();
    await expect(page.getByTestId("web-search-exception-detail")).toBeVisible();

    const detailBox = await page
      .getByTestId("web-search-exception-detail")
      .boundingBox();
    const textareaBox = await page.getByTestId("chat-textarea").boundingBox();
    expect(detailBox!.y + detailBox!.height).toBeLessThanOrEqual(
      textareaBox!.y + 0.5
    );
    await expectComposerContract(page, "390x680 exception open");
  });

  test("web search off keeps the same input row", async ({ page }) => {
    await enterMobileComposer(page, {
      viewport: { width: 390, height: 680 },
      webSearchMode: "off",
    });

    await expect(page.getByTestId("tool-status-chip-row")).toHaveCount(0);
    await expectComposerContract(page, "390x680 no chip");
  });

  test("full web-search support does not narrow the input either", async ({
    page,
  }) => {
    await enterMobileComposer(page, {
      models: ALL_SEARCH_MODELS,
      viewport: { width: 390, height: 680 },
    });

    await expect(page.getByTestId("web-search-mode-chip")).toHaveAttribute(
      "data-unsupported-count",
      "0"
    );
    await expectComposerContract(page, "390x680 full support");
  });

  test("an attached file rides its own row above the input", async ({ page }) => {
    await enterMobileComposer(page, { viewport: { width: 390, height: 680 } });
    await mockAttachmentUpload(page);
    await attachPastedImage(page);
    await expect(page.getByAltText("qa-image.png")).toBeVisible();

    const geometry = await expectComposerContract(page, "390x680 attachment");
    expect(geometry.overlaps).toEqual([]);
  });

  test("five account attachments wrap without a horizontal tray at 320px", async ({ page }) => {
    await enterMobileComposer(page, { viewport: { width: 320, height: 780 } });
    await mockAttachmentUpload(page);
    const names = Array.from({ length: 5 }, (_, index) => `qa-image-${index + 1}.png`);
    await attachPastedImages(page, names);
    for (const name of names) await expect(page.getByAltText(name)).toBeVisible();

    const trayOverflow = await page.getByTestId("attachment-tray").evaluate((tray) => ({
      horizontal: tray.scrollWidth - tray.clientWidth,
      overflowX: getComputedStyle(tray.firstElementChild as Element).overflowX,
    }));
    expect(trayOverflow.horizontal).toBeLessThanOrEqual(1);
    expect(trayOverflow.overflowX).not.toBe("auto");
    await expectComposerContract(page, "five account attachments @320px");
  });

  test("the chip's own controls keep a 44px touch target at 320px", async ({
    page,
  }) => {
    await enterMobileComposer(page, {
      lang: "en",
      viewport: { width: 320, height: 640 },
    });

    // The chip box itself is 32px tall so the row costs the answer canvas as
    // little as possible; the hit areas come from ::before insets.
    for (const target of [
      page.getByTestId("web-search-exception-toggle"),
      page.getByTestId("web-search-mode-chip").getByRole("button", {
        name: "Turn off web search",
      }),
    ]) {
      const hit = await target.evaluate((node) => {
        const before = getComputedStyle(node, "::before");
        const rect = node.getBoundingClientRect();
        const inset = (value: string) => Math.abs(Number.parseFloat(value) || 0);
        return {
          width: rect.width + inset(before.left) + inset(before.right),
          height: rect.height + inset(before.top) + inset(before.bottom),
        };
      });
      expect(hit.height).toBeGreaterThanOrEqual(43.5);
      expect(hit.width).toBeGreaterThanOrEqual(43.5);
    }
  });
});

test.describe("Mobile composer: disabled actions state their reason", { tag: "@ui-risk" }, () => {
  test("a blocked send names why, not just 'Send'", async ({ page }) => {
    // `title` alone reaches neither a screen reader nor a keyboard user, so
    // the reason is rendered as text the button points at.
    await prepareGuestPage(page, "ko");
    await mockGuestUsage(page, 20, 20); // used === limit -> guest limit reached
    await page.setViewportSize({ width: 390, height: 680 });
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-textarea")).toBeDisabled();

    const send = page.getByTestId("chat-send-button");
    await expect(send).toBeDisabled();
    const describedBy = await send.getAttribute("aria-describedby");
    expect(describedBy).toBe("chat-send-disabled-reason");
    await expect(page.locator(`#${describedBy}`)).toHaveText(/한도/);

    // And the input itself keeps a name that does not depend on a
    // placeholder a screen reader may never announce.
    await expect(page.getByTestId("chat-textarea")).toHaveAttribute(
      "aria-label",
      /.+/
    );
  });
});

test.describe("Mobile composer: two chips at once", { tag: "@ui-risk" }, () => {
  // Web search *and* a pending deep-research job is the widest tool state the
  // composer can be in. The chips wrap onto a second chip row; what they must
  // never do is wrap into -- or scroll across -- the input row.
  for (const width of [390, 320]) {
    test(`${width}px wraps a second chip instead of taking the input row`, async ({
      page,
    }) => {
      await enterMobileComposer(page, {
        viewport: { width, height: 680 },
        deepResearch: true,
      });

      await startDeepResearch(page);
      await expect(page.getByTestId("deep-research-chip")).toBeVisible();
      await expect(page.getByTestId("web-search-mode-chip")).toBeVisible();

      const geometry = await expectComposerContract(page, `${width}x680 two chips`);
      expect(geometry.overlaps).toEqual([]);
      const chipRow = await page.getByTestId("tool-status-chip-row").boundingBox();
      const textarea = await page.getByTestId("chat-textarea").boundingBox();
      expect(chipRow!.y + chipRow!.height).toBeLessThanOrEqual(textarea!.y + 0.5);
    });
  }
});

test.describe("Mobile composer: input remains reviewable", { tag: "@ui-risk" }, () => {
  test("Korean text and an in-flight IME composition stay fully visible", async ({
    page,
  }) => {
    await enterMobileComposer(page, { viewport: { width: 390, height: 680 } });

    const textarea = page.getByTestId("chat-textarea");
    await textarea.click();
    // insertText goes through the same input events a real IME commit does,
    // so React state (and the auto-grow effect) sees it.
    await page.keyboard.insertText("한국어 입력 확인");
    await expect(textarea).toHaveValue("한국어 입력 확인");

    let geometry = await expectComposerContract(page, "390x680 ko committed");
    expect(
      geometry.clippedValueHeight,
      "committed Korean text is clipped out of view"
    ).toBeLessThanOrEqual(1);

    // Mid-composition: the browser is holding an uncommitted syllable, the
    // caret is inside it, and nothing may cover either.
    await textarea.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
      element.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "하" })
      );
    });
    await page.keyboard.insertText("하");

    geometry = await expectComposerContract(page, "390x680 ko composing");
    expect(geometry.clippedValueHeight).toBeLessThanOrEqual(1);

    const caretVisible = await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return (
        input.selectionStart === input.value.length &&
        input.scrollLeft === 0 &&
        input.scrollTop === 0
      );
    });
    expect(caretVisible, "the caret scrolled out of the visible box").toBe(true);
  });

  test("focus and a single Korean character do not resize the input row", async ({
    page,
  }) => {
    await enterMobileComposer(page, { viewport: { width: 390, height: 680 } });

    const textarea = page.getByTestId("chat-textarea");
    const empty = (await textarea.boundingBox())!;
    // The contract's empty-state floor, in absolute pixels.
    expect(empty.height).toBeGreaterThanOrEqual(36);

    await textarea.click();
    const focused = (await textarea.boundingBox())!;
    expect(focused.width, "focus changed the input width").toBeCloseTo(empty.width, 1);
    expect(focused.x).toBeCloseTo(empty.x, 1);

    await page.keyboard.insertText("한");
    const typed = (await textarea.boundingBox())!;
    expect(typed.width, "typing changed the input width").toBeCloseTo(empty.width, 1);
    expect(typed.height).toBeGreaterThanOrEqual(36);
    await expectComposerContract(page, "390x680 single ko char");
  });

  test("a wrapped second line grows the input instead of clipping it", async ({
    page,
  }) => {
    await enterMobileComposer(page, { viewport: { width: 320, height: 640 } });

    const textarea = page.getByTestId("chat-textarea");
    const before = (await textarea.boundingBox())!.height;
    await textarea.click();
    await page.keyboard.insertText(
      "이 문장은 모바일 입력창에서 두 줄 이상으로 줄바꿈되도록 충분히 깁니다."
    );

    const after = (await textarea.boundingBox())!.height;
    expect(after).toBeGreaterThan(before);
    await expectComposerContract(page, "320x640 wrapped");
  });
});

/**
 * COMPOSER-FOCUS-CLIP-01. "Focus indicators must remain visible and must not
 * be clipped by the composer's overflow-hidden" had no test, and the global
 * `:focus-visible` outline drew 4px outside the textarea, where the rounded,
 * clipped composer cut it off.
 *
 * Measured, not eyeballed, within stated limits: an outline on the textarea
 * or on the composer is turned into a rectangle, which must lie inside every
 * clipping ancestor -- including the rounded corners, which a plain rectangle
 * test would pass. An outline counts as drawn only with a non-zero width and a
 * colour that is not transparent. This is clipping geometry, not contrast, and
 * it does not detect a descendant painted over the outline. A box-shadow ring
 * is not counted at all: forced-colors mode removes box-shadow, so a ring
 * cannot be the only indicator.
 */
async function readFocusIndicator(page: Page) {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLElement>('[data-testid="chat-textarea"]')!;
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-input"]')!;
    const px = (value: string) => Number.parseFloat(value) || 0;

    type Box = { left: number; top: number; right: number; bottom: number };
    const indicators: Array<{ owner: string; kind: string; box: Box }> = [];
    for (const [owner, element] of [
      ["textarea", textarea],
      ["composer", composer],
    ] as const) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const width = px(style.outlineWidth);
      const colour = style.outlineColor.replace(/\s+/g, "");
      const transparent =
        colour === "transparent" || /^rgba\(\d+,\d+,\d+,0\)$/.test(colour) || /\/0\)$/.test(colour);
      if (style.outlineStyle !== "none" && width > 0 && !transparent) {
        const grow = width + px(style.outlineOffset);
        indicators.push({
          owner,
          kind: "outline",
          box: {
            left: rect.left - grow,
            top: rect.top - grow,
            right: rect.right + grow,
            bottom: rect.bottom + grow,
          },
        });
      }
    }

    const escapes: string[] = [];
    for (const indicator of indicators) {
      // The element that owns an outline does not clip it; its ancestors do.
      const start = indicator.owner === "textarea" ? textarea.parentElement : composer.parentElement;
      for (let node = start; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const rect = node.getBoundingClientRect();
        const inner = {
          left: rect.left + px(style.borderLeftWidth),
          top: rect.top + px(style.borderTopWidth),
          right: rect.right - px(style.borderRightWidth),
          bottom: rect.bottom - px(style.borderBottomWidth),
        };
        const box = indicator.box;
        const tolerance = 0.5;
        if (
          box.left < inner.left - tolerance ||
          box.top < inner.top - tolerance ||
          box.right > inner.right + tolerance ||
          box.bottom > inner.bottom + tolerance
        ) {
          escapes.push(`${indicator.owner} ${indicator.kind} outside ${node.dataset.testid ?? node.tagName} rect`);
          continue;
        }
        const radius = Math.max(0, px(style.borderTopLeftRadius) - px(style.borderLeftWidth));
        if (radius === 0) continue;
        const corners = [
          [box.left, box.top, inner.left + radius, inner.top + radius, box.left < inner.left + radius && box.top < inner.top + radius],
          [box.right, box.top, inner.right - radius, inner.top + radius, box.right > inner.right - radius && box.top < inner.top + radius],
          [box.left, box.bottom, inner.left + radius, inner.bottom - radius, box.left < inner.left + radius && box.bottom > inner.bottom - radius],
          [box.right, box.bottom, inner.right - radius, inner.bottom - radius, box.right > inner.right - radius && box.bottom > inner.bottom - radius],
        ] as const;
        for (const [x, y, cx, cy, inZone] of corners) {
          if (inZone && Math.hypot(x - cx, y - cy) > radius + tolerance) {
            escapes.push(`${indicator.owner} ${indicator.kind} cut by ${node.dataset.testid ?? node.tagName} corner`);
          }
        }
      }
    }
    return {
      focused: document.activeElement === textarea,
      indicators: indicators.map((indicator) => `${indicator.owner}:${indicator.kind}`),
      escapes,
    };
  });
}

test.describe("Mobile composer: focus indicator", { tag: "@ui-risk" }, () => {
  for (const [width, webSearchMode, forcedColors] of [
    [320, "off", "none"],
    [390, "off", "none"],
    [390, "always", "none"],
    // Windows high contrast: box-shadow is removed, outlines are kept.
    [320, "off", "active"],
  ] as const) {
    // With web search off no chip row sits above the input, so the textarea is
    // the composer's first row -- inside the rounded corners.
    test(`the textarea's focus indicator is drawn and not clipped at ${width}px, web search ${webSearchMode}, forced colors ${forcedColors}`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors });
      await enterMobileComposer(page, { viewport: { width, height: 700 }, webSearchMode });
      const before = await readFocusIndicator(page);
      expect(before.indicators, "an indicator is drawn before focus").toEqual([]);

      await page.getByTestId("chat-textarea").focus();
      const focused = await readFocusIndicator(page);
      console.log(`[composer-focus] ${width} ${JSON.stringify(focused)}`);
      expect(focused.focused).toBe(true);
      expect(focused.indicators.length, "no focus indicator is drawn").toBeGreaterThan(0);
      expect(focused.escapes).toEqual([]);
    });
  }
});

test.describe("Mobile composer: keyboard, zoom and text scaling", { tag: "@ui-risk" }, () => {
  test("an on-screen keyboard does not collapse the input row", async ({ page }) => {
    await enterMobileComposer(page, { viewport: { width: 390, height: 680 } });
    await page.getByTestId("chat-textarea").click();

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
    await expect(page.getByTestId("comparison-action-rail")).toHaveAttribute(
      "data-collapsed",
      "true"
    );

    await expectComposerContract(page, "390x680 keyboard open");
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
  });

  test("200% text scaling keeps a full line and no overlap", async ({ page }) => {
    await enterMobileComposer(page, { viewport: { width: 390, height: 680 } });

    // Text-only scaling: the root font size doubles, the viewport does not.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    await expectComposerContract(page, "390x680 at 200% text");
  });

  for (const width of [320, 360]) {
    test(`200% text at ${width}px keeps the actions row's controls apart`, async ({
      page,
    }) => {
      // The textarea checks above do not look at the actions row itself. At
      // 200% text its 44px circles outgrew the space beside "+", and the
      // right-hand group overflowed leftwards over that button instead of
      // wrapping (2026-09-15). Controls that share pixels are a tap on the
      // wrong one.
      await enterMobileComposer(page, { viewport: { width, height: 680 } });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await expect(page.getByTestId("chat-send-button")).toBeVisible();

      // Polled, because the row reflows over a few frames after the root font
      // size changes (the textarea re-measures its own height). What must hold
      // is the settled layout, and a real overlap never settles away.
      const readOverlaps = () => page.evaluate(() => {
        const composer = document.querySelector('[data-testid="chat-input"]')!;
        const composerBox = composer.getBoundingClientRect();
        const boxes = Array.from(composer.querySelectorAll("button"))
          .map((button) => ({ button, box: button.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.height > 0);
        const found: string[] = [];
        boxes.forEach((a, i) => {
          if (a.box.left < composerBox.left - 1 || a.box.right > composerBox.right + 1) {
            found.push(`${a.button.dataset.testid ?? a.button.getAttribute("aria-label")} leaves the composer`);
          }
          boxes.slice(i + 1).forEach((b) => {
            if (a.button.contains(b.button) || b.button.contains(a.button)) return;
            const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
            const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
            if (w > 1 && h > 1) {
              found.push(
                `${a.button.dataset.testid ?? a.button.getAttribute("aria-label")} x ${
                  b.button.dataset.testid ?? b.button.getAttribute("aria-label")
                }`
              );
            }
          });
        });
        return found;
      });
      await expect
        .poll(readOverlaps, { message: `${width}px at 200% text`, timeout: 3_000 })
        .toEqual([]);
    });
  }

  test("200% page zoom (a 195px layout viewport) keeps the contract", async ({
    page,
  }) => {
    // 200% browser zoom halves the layout viewport in CSS pixels.
    await enterMobileComposer(page, { viewport: { width: 195, height: 340 } });

    await expectComposerContract(page, "195x340 (200% zoom)");
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Page zoom and short screens (COMPOSER-REFLOW-01).
//
// Staging, 2026-09-17, Galaxy S25+ / Edge "Default zoom": at 150% the notice
// under the composer was cut at "민감정…", at 200% the starters had no room at
// all, and at 300% (a ~137px layout viewport) Send, the credit estimate and
// the microphone were below the screen and the user could not drag them into
// view. Three causes, each measured here rather than inferred from classes:
//
//   - the empty textarea kept a one-line height while its placeholder wrapped
//     to two, so the box scrolled itself and took the drag meant for the shell;
//   - the notice was one truncated line;
//   - the conversation section could flex down to 0, leaving the starters (or
//     the answers) nothing to be drawn in.
//
// The sizes are Edge's zoom levels on that phone in CSS pixels, plus a
// landscape phone. `isMobile` because Chromium only turns a CDP touch drag
// into a scroll under mobile emulation; the drag is dispatched as raw touch
// points, which is what a finger does, and `elementFromPoint` at the control's
// centre is the reachability test, as in the sidebar drawer contract.
// ---------------------------------------------------------------------------

const ZOOM_VIEWPORTS = [
  { label: "150% page zoom", width: 275, height: 493 },
  { label: "200% page zoom", width: 206, height: 370 },
  { label: "300% page zoom", width: 137, height: 247 },
  { label: "landscape phone", width: 568, height: 320 },
];

const STARTER_COOKIE_URL = "http://127.0.0.1:3100";

async function touchDrag(page: Page, x: number, y: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + (dy * step) / steps }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Whether the control's centre is on screen and is the control itself. */
async function isReachableAtCentre(page: Page, testId: string) {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }, testId);
}

async function enterZoomedWelcome(page: Page, viewport: { width: number; height: number }) {
  await prepareGuestPage(page, "en");
  await page.context().addCookies([
    { name: "__tomverse_e2e_chat_starter", value: "1", url: STARTER_COOKIE_URL },
  ]);
  await mockAuthenticatedApi(page, { selectedModels: [MODEL_C] });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);
  await page.setViewportSize(viewport);
  await page.goto("/chat?lang=ko");
  await expect(page.getByTestId("chat-empty-state")).toBeAttached();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
}

test.describe("Mobile composer: page zoom and short screens", { tag: "@ui-risk" }, () => {
  test.use({ isMobile: true });

  for (const viewport of ZOOM_VIEWPORTS) {
    const size = `${viewport.width}x${viewport.height}`;

    test(`${viewport.label} (${size}): a drag started on the empty input brings Send into view`, async ({
      page,
    }) => {
      await enterZoomedWelcome(page, viewport);

      // The empty box has no vertical overflow: nothing of its placeholder is
      // cut off, and there is nothing inside it to scroll. The placeholder
      // arrives in its final language after mount, so this also fails if the
      // box is fitted only when the draft changes.
      const clipped = await page
        .getByTestId("chat-textarea")
        .evaluate((node: HTMLTextAreaElement) => node.scrollHeight - node.clientHeight);
      expect(clipped, `${size}: the placeholder is cut off inside the input`).toBeLessThanOrEqual(1);
      await expectComposerContract(page, `${size} (${viewport.label}, new chat)`);

      // The textarea is the largest target in the dock at this size, so a
      // drag that starts on it is the one a user makes.
      const input = await page.getByTestId("chat-textarea").boundingBox();
      if (!input) throw new Error("chat-textarea has no box");
      const startX = Math.round(input.x + input.width / 2);
      const startY = Math.round(Math.min(input.y + input.height / 2, viewport.height - 8));
      const startsOnInput = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-testid") === "chat-textarea",
        [startX, startY]
      );
      expect(startsOnInput, `${size}: the drag does not start on the input`).toBe(true);
      const sendReachableBefore = await isReachableAtCentre(page, "chat-send-button");
      const shellScrollTop = () =>
        page.getByTestId("mobile-chat-shell").evaluate((node) => node.scrollTop);
      const shellTopBefore = await shellScrollTop();
      await touchDrag(page, startX, startY, -viewport.height);

      await expect
        .poll(() => isReachableAtCentre(page, "chat-send-button"), {
          message: `${size}: Send is not reachable after one drag`,
          timeout: 3_000,
        })
        .toBe(true);
      // Through the shell, the composer's one scroll owner -- never the page.
      expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
      if (!sendReachableBefore) {
        // Where Send started off screen (300%), it is the shell that brought it.
        expect(
          await shellScrollTop(),
          `${size}: Send became reachable without the shell scrolling`
        ).toBeGreaterThan(shellTopBefore);
      }
    });

    test(`${viewport.label} (${size}): the sensitive-data notice is never cut off`, async ({
      page,
    }) => {
      await enterZoomedWelcome(page, viewport);

      const notice = page.getByTestId("chat-ai-disclaimer-mobile");
      const truncated = await notice.evaluate((node) =>
        Array.from(node.querySelectorAll("span")).some(
          (span) => span.scrollWidth > span.clientWidth + 1
        )
      );
      expect(truncated, `${size}: the notice is truncated`).toBe(false);
      const details = page.getByTestId("chat-ai-disclaimer-details");
      await details.scrollIntoViewIfNeeded();
      const detailsBox = await details.boundingBox();
      const noticeBox = await notice.boundingBox();
      if (!detailsBox || !noticeBox) throw new Error("notice has no box");
      // "Details" wraps inside the notice rather than being pushed past it.
      expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(noticeBox.x + noticeBox.width + 1);
    });

    test(`${viewport.label} (${size}): the starters keep a box to be reached in`, async ({
      page,
    }) => {
      await enterZoomedWelcome(page, viewport);

      const floor = await page.evaluate(
        () => 4 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
      );
      const surface = await page.getByTestId("mobile-conversation-surface").boundingBox();
      expect(surface?.height ?? 0, `${size}: the conversation section collapsed`).toBeGreaterThanOrEqual(
        floor - 1
      );

      // Reached through the section's own scroller, which is not an ancestor
      // of the composer.
      const firstCard = page.getByTestId("chat-starter-card").first();
      const cardIsReachable = () =>
        firstCard.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const section = document
            .querySelector('[data-testid="mobile-conversation-surface"]')
            ?.getBoundingClientRect();
          if (!section) return false;
          // A card taller than the section is reached once part of it is
          // drawn inside the section and hit-testable, so measure the middle
          // of the part the section actually shows.
          const top = Math.max(box.top, section.top, 0);
          const bottom = Math.min(box.bottom, section.bottom, window.innerHeight);
          if (bottom - top < 8) return false;
          const x = box.left + box.width / 2;
          const y = (top + bottom) / 2;
          if (x < 0 || x > window.innerWidth) return false;
          const hit = document.elementFromPoint(x, y);
          return Boolean(hit && (hit === element || element.contains(hit)));
        });
      // Drag inside the section until a card is drawn there, as a finger
      // would; bounded so a card that can never arrive fails rather than hangs.
      for (let drag = 0; drag < 40 && !(await cardIsReachable()); drag += 1) {
        const box = await page.getByTestId("mobile-conversation-surface").boundingBox();
        if (!box) throw new Error("mobile-conversation-surface has no box");
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(Math.max(box.y, 0) + Math.min(box.height, viewport.height) * 0.75);
        const startsInSection = await page.evaluate(
          ([px, py]) => {
            const section = document.querySelector('[data-testid="mobile-conversation-surface"]');
            const hit = document.elementFromPoint(px, py);
            return Boolean(section && hit && section.contains(hit));
          },
          [x, y]
        );
        expect(startsInSection, `${size}: the drag does not start in the section`).toBe(true);
        await touchDrag(page, x, y, -Math.round(box.height / 2));
      }
      expect(await cardIsReachable(), `${size}: no starter card can be reached`).toBe(true);
    });
  }

  test("zooming in after the page loaded refits the empty input", async ({ page }) => {
    // Page zoom changed while the chat is open: the width moves and the draft
    // does not, which is the path a value-only fit never ran on.
    await enterZoomedWelcome(page, { width: 390, height: 780 });
    await page.setViewportSize({ width: 137, height: 247 });
    await expect
      .poll(
        () =>
          page
            .getByTestId("chat-textarea")
            .evaluate((node: HTMLTextAreaElement) => node.scrollHeight - node.clientHeight),
        { message: "the placeholder is cut off after zooming in", timeout: 3_000 }
      )
      .toBeLessThanOrEqual(1);
  });

  for (const width of [137, 120]) {
    test(`the model button and its chevron stay inside the composer at ${width}px`, async ({
      page,
    }) => {
      await enterZoomedWelcome(page, { width, height: 247 });
      await page.getByTestId("composer-model-select").scrollIntoViewIfNeeded();
      const measured = await page.evaluate(() => {
        const composer = document.querySelector<HTMLElement>('[data-testid="chat-input"]')!;
        const button = document.querySelector<HTMLElement>('[data-testid="composer-model-select"]')!;
        const icons = button.querySelectorAll("svg");
        const chevron = icons[icons.length - 1].getBoundingClientRect();
        const outer = composer.getBoundingClientRect();
        const style = getComputedStyle(composer);
        // The padding box: what the composer's overflow-hidden clips to.
        const clipRight = outer.right - (Number.parseFloat(style.borderRightWidth) || 0);
        const x = chevron.left + chevron.width / 2;
        const y = chevron.top + chevron.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          buttonRight: button.getBoundingClientRect().right,
          chevronRight: chevron.right,
          clipRight,
          chevronHit: Boolean(hit && button.contains(hit)),
        };
      });
      expect(measured.buttonRight, JSON.stringify(measured)).toBeLessThanOrEqual(measured.clipRight + 0.5);
      expect(measured.chevronRight, JSON.stringify(measured)).toBeLessThanOrEqual(measured.clipRight + 0.5);
      expect(measured.chevronHit, JSON.stringify(measured)).toBe(true);
    });
  }

  test("300% page zoom: focusing a dock control does not move the dock under the press", async ({
    page,
  }) => {
    await enterZoomedWelcome(page, { width: 137, height: 247 });
    const tools = page.getByTestId("composer-tools-button");
    await tools.scrollIntoViewIfNeeded();
    const before = await tools.boundingBox();

    // Focus is what a press gives the control before its release lands; the
    // layout may not change in between, or the release hits something else.
    await tools.focus();
    const after = await tools.boundingBox();
    expect(after?.y).toBe(before?.y);

    // And a focused input is on screen without a second scroll.
    await page.getByTestId("chat-textarea").focus();
    await expect
      .poll(() => isReachableAtCentre(page, "chat-textarea"), { timeout: 3_000 })
      .toBe(true);
  });

  test("an ongoing conversation at 300% page zoom keeps its answers a box too", async ({
    page,
  }) => {
    await enterMobileComposer(page, {
      viewport: { width: 137, height: 247 },
      webSearchMode: "off",
    });
    const surface = await page.getByTestId("mobile-conversation-surface").boundingBox();
    expect(surface?.height ?? 0).toBeGreaterThanOrEqual(63);

    const header = await page.getByTestId("mobile-chat-header").boundingBox();
    if (!header) throw new Error("header has no box");
    await touchDrag(page, 68, Math.round(header.y + header.height / 2), -247);
    await expect
      .poll(() => isReachableAtCentre(page, "chat-send-button"), { timeout: 3_000 })
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guest attachments.
//
// Guests can now attach one local file, which puts a new chip, a new error
// surface and a new set of copy into the composer -- everything the contract
// exists to keep off the textarea's row. These cases drive the guest shell
// specifically, because the signed-in cases above cannot: the guest composer
// resolves a different upload endpoint, a different file cap and a different
// set of sentences.
// ---------------------------------------------------------------------------

/** The guest upload endpoint, answering as the real one does. */
async function mockGuestAttachmentUpload(
  page: Page,
  options: { failWith?: { status: number; code: string } } = {}
) {
  const uploads: string[] = [];
  await page.route("**/api/chat/guest-attachment**", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const url = new URL(route.request().url());
    const name = url.searchParams.get("name") || "file";
    const mediaType = url.searchParams.get("mediaType") || "text/plain";
    uploads.push(name);
    if (options.failWith) {
      await route.fulfill({
        status: options.failWith.status,
        contentType: "application/json",
        body: JSON.stringify({
          code: options.failWith.code,
          error: "QA fixture rejection.",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        objectKey: `guest-attachments/${"a".repeat(32)}/${"b".repeat(40)}`,
        name,
        mediaType,
        size: 2_048,
        kind: mediaType.startsWith("text/") || mediaType === "application/json" ? "text" : "file",
        ephemeral: true,
        expiresInMinutes: 60,
      }),
    });
  });
  return { uploads };
}

type GuestComposerOptions = {
  lang?: "en" | "ko";
  viewport: { width: number; height: number };
  uploadFailure?: { status: number; code: string };
};

async function enterGuestMobileComposer(
  page: Page,
  options: GuestComposerOptions
) {
  const { lang = "ko", viewport } = options;
  await prepareGuestPage(page, "en");
  await mockGuestUsage(page, 0, 20);
  const upload = await mockGuestAttachmentUpload(page, {
    failWith: options.uploadFailure,
  });
  await setDeterministicTheme(page, "light");
  await suppressTransientUi(page);

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  await freezeAnimations(page);
  return upload;
}

/** Pastes a file rather than picking one, so no chooser is involved. */
async function pasteGuestFile(
  page: Page,
  file: { name: string; type: string; bytes: number[] }
) {
  await page.getByTestId("chat-textarea").focus();
  await page.getByTestId("chat-textarea").evaluate((textarea, picked) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([new Uint8Array(picked.bytes)], picked.name, { type: picked.type })
    );
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })
    );
  }, file);
}

const guestTextFile = (name = "guest-notes.txt") => ({
  name,
  type: "text/plain",
  bytes: Array.from(Buffer.from("Compare these two approaches.", "utf8")),
});

test.describe("Mobile composer: guest attachments", { tag: "@ui-risk" }, () => {
  const openActions = async (page: Page) => {
    await page.locator('button[aria-controls="chat-input-popover"]').nth(0).click();
  };

  test("a guest can attach a local file, and Drive stays behind sign-in", async ({
    page,
  }) => {
    await enterGuestMobileComposer(page, { viewport: { width: 390, height: 780 } });
    await openActions(page);

    // Where a file comes from is now asked after the user says they want to
    // attach one, so the sources live one step in rather than as two root rows.
    await page.getByTestId("tools-attach-row").click();

    // The capability the homepage promises, actually offered.
    const local = page.getByTestId("attach-local-file-row");
    await expect(local).toBeVisible();
    await expect(local).toBeEnabled();

    // ...and the one that genuinely needs an account, named rather than dead.
    const drive = page.getByTestId("attach-google-drive-row");
    await expect(drive).toBeVisible();
    await expect(drive).toHaveAttribute("data-locked", "true");
    await expect(drive).toContainText(/로그인|Sign in/);

    // The temporary-file promise is made where the file is picked.
    await expect(page.getByTestId("guest-attachment-temporary-note")).toBeVisible();
  });

  for (const width of MOBILE_WIDTHS) {
    test(`${width}px keeps the textarea's row while a guest file is attached`, async ({
      page,
    }) => {
      await enterGuestMobileComposer(page, { viewport: { width, height: 780 } });
      await pasteGuestFile(page, guestTextFile());
      await expect(page.getByText("guest-notes.txt").first()).toBeVisible();

      // The whole point of the contract: a new chip in the composer must not
      // be paid for out of the input's row.
      await expectComposerContract(page, `guest attachment @${width}px`);
    });
  }

  test("a very long filename wraps or truncates rather than widening the row", async ({
    page,
  }) => {
    await enterGuestMobileComposer(page, { viewport: { width: 320, height: 780 } });
    await pasteGuestFile(
      page,
      guestTextFile(`${"분기별-실적-보고서-최종본-검토용".repeat(6)}.txt`)
    );
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expectComposerContract(page, "guest attachment with a long filename @320px");
  });

  test("an upload error states its own reason without taking the input's row", async ({
    page,
  }) => {
    await enterGuestMobileComposer(page, {
      viewport: { width: 320, height: 780 },
      uploadFailure: { status: 413, code: "GUEST_ATTACHMENT_TEXT_TOO_LARGE" },
    });
    await pasteGuestFile(page, guestTextFile());

    // The specific reason, not a generic failure -- and specifically not the
    // "unsupported file" one, which would send the user to change format.
    await expect(page.getByText(/게스트 입력 한도|guest input limit/)).toBeVisible();
    await expectComposerContract(page, "guest attachment error @320px");
  });

  test("attaching mid-composition does not disturb Korean input", async ({
    page,
  }) => {
    await enterGuestMobileComposer(page, { viewport: { width: 390, height: 780 } });
    const textarea = page.getByTestId("chat-textarea");

    // Committed text, then a composition left in flight, then the attachment
    // state changes underneath it. insertText goes through the same input
    // events a real IME does, so React state sees the composition rather than
    // reverting it on the next render.
    await textarea.click();
    await page.keyboard.insertText("한국어 입력 ");
    await textarea.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
      element.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "테" })
      );
    });
    await page.keyboard.insertText("테");

    await pasteGuestFile(page, guestTextFile());
    await expect(page.getByText("guest-notes.txt").first()).toBeVisible();

    // The composition survives, and stays visible inside the box.
    await expect(textarea).toHaveValue("한국어 입력 테");
    const geometry = await expectComposerContract(
      page,
      "guest attachment during IME composition"
    );
    expect(geometry.clippedValueHeight).toBeLessThanOrEqual(1);
  });

  test("200% text scaling keeps the contract with a guest file attached", async ({
    page,
  }) => {
    await enterGuestMobileComposer(page, { viewport: { width: 390, height: 780 } });
    await pasteGuestFile(page, guestTextFile());
    await expect(page.getByText("guest-notes.txt").first()).toBeVisible();

    await setRootFontSize(page, 32);
    await expectComposerContract(page, "guest attachment at 200% text scaling");
  });

  test("a taller message list never shortens the textarea's row", async ({
    page,
  }) => {
    await enterGuestMobileComposer(page, { viewport: { width: 390, height: 780 } });
    const before = await readComposerGeometry(page);
    await pasteGuestFile(page, guestTextFile());
    await expect(page.getByText("guest-notes.txt").first()).toBeVisible();

    // ChatMessageList takes whatever is left; the input's own line is not part
    // of what it may take.
    const after = await readComposerGeometry(page);
    expect(after.textareaHeight).toBeGreaterThanOrEqual(after.lineBox - 0.5);
    expect(after.widthRatio).toBeGreaterThanOrEqual(MIN_WIDTH_RATIO);
    expect(after.textareaHeight).toBeGreaterThanOrEqual(before.lineBox - 0.5);
  });
});

test.describe("Mobile composer: visual record", { tag: "@ui-risk" }, () => {
  // The before/after screenshots the change checklist asks reviewers to
  // compare, pinned as goldens so the next change has to update them
  // deliberately.
  //
  // Only these two tests are gated on the canonical browser. Everything above
  // measures geometry and behaviour, which a substitute Chromium answers just
  // as well; pixels are the one thing it cannot answer.
  test.beforeEach(skipUnlessCanonicalVisualBrowser);

  for (const width of [390, 320]) {
    test(`composer golden at ${width}px, 3 models, partial web search`, async ({
      page,
    }) => {
      await enterMobileComposer(page, {
        lang: "en",
        viewport: { width, height: 680 },
      });
      await expect(page.getByTestId("web-search-mode-chip")).toContainText("2/3");

      await expect(page.getByTestId("chat-input")).toHaveScreenshot(
        `mobile-composer-partial-web-search-${width}.png`,
        { animations: "disabled", maxDiffPixelRatio: 0.01 }
      );
    });
  }
});
