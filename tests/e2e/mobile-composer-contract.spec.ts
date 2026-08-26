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
 * All three dispatchable: the full-support state. Gemini is deliberately not
 * here -- its grounding is native but takes no per-request cost ceiling, so
 * the composer counts it unsupported and this would not be the full-support
 * case at all (lib/webSearchCapability.ts `nativeSearchIsDispatchable`).
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
