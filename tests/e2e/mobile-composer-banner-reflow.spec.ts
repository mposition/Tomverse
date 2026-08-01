import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelCatalogue,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import { restoreActiveConversation } from "./support/chat-state-fixtures";
import { openOnScreenKeyboard, closeOnScreenKeyboard } from "./support/ui-audit";
import { setRootFontSize } from "./support/chat-state-fixtures";

/**
 * REAUDIT-P1-04. The mobile shell was `h-[100dvh] overflow-hidden`: a box that
 * could not grow and could not scroll. Everything below the fold was therefore
 * not merely off-screen but unreachable -- there was no scroll owner to reach
 * it with. Measured on the build before this spec, at 320x568 with a provider
 * outage banner and Korean copy:
 *
 * | root | textarea top | send top | reachable |
 * |---:|---:|---:|---|
 * | 16px | 442 | 486 | yes |
 * | 24px | 593 | 659 | no  |
 * | 32px | 1012 | 1100 | no |
 *
 * `document.elementFromPoint` returned `null` at both centres in the failing
 * rows while `documentElement.scrollWidth - clientWidth` stayed at 0, which is
 * exactly why a document-level overflow check could never have caught this.
 * The assertions below are per-element rects and hit-tests for that reason.
 *
 * REFLOW-P1-01 extends it. The original matrix only ever fixtured a *healthy*
 * replacement (`fallbackModelIds: ["mistral-medium-3-1"]`,
 * `fallbackHealth: "operational"`), so the state where the banner is at its
 * tallest and the user has the least room -- no replacement exists, so the
 * banner adds "현재 사용할 수 있는 대체 모델이 없습니다." and a picker action
 * on top of the title -- was never rendered here at all. Combined with an open
 * on-screen keyboard it reproduced a P1. Measured at 390x844 / ko / 200% text
 * with a 320px keyboard, where the user can see 524px:
 *
 * | row | before | after |
 * |---|---:|---:|
 * | header | 0..215 | 0..215 |
 * | banner | 231..471 (cap 379.8px = 45dvh) | 160px (cap 160px = 5rem) |
 * | conversation section | 0px | 586px |
 * | textarea | 601..705 | 505..609, 308..412 after one scroll |
 * | send | 721..809 | 625..713, 428..516 after one scroll |
 * | scroll owners to the composer | welcome overlay (h=0) + shell | shell |
 *
 * Before the fix `elementFromPoint` at the textarea's centre returned
 * `mobile-chat-shell`, and `chat-ai-disclaimer-mobile` at the send button's;
 * after scrolling the nearest owner (a 0px-tall welcome overlay holding 586px
 * of content) they returned `provider-status-title` and
 * `chat-ai-disclaimer-details`. The composer was not painted anywhere the user
 * could reach, and no amount of scrolling either region brought it back.
 *
 * The banner scenario is therefore an explicit fixture rather than a boolean,
 * and every fallback health is regression-tested rather than replaced.
 */

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 320, height: 640 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
] as const;

const LOCALES = ["ko", "en"] as const;
const ROOT_FONT_SIZES = [16, 20, 24, 32] as const;

/** The exact reproduction geometry, pinned so it cannot drift. */
const REPRO_VIEWPORT = { width: 390, height: 844 } as const;
const REPRO_ROOT_FONT = 32;
const REPRO_KEYBOARD_INSET = 320;

/** The guest's default model (see prepareGuestPage), so it is always selected. */
const IMPACTED_MODEL = "gemini-2-5-flash";
const FALLBACK_MODEL = "mistral-medium-3-1";

type FallbackHealth = "operational" | "degraded" | "none" | "unknown";

/**
 * `withBanner: boolean` could only ever describe two of the states this shell
 * has to survive. The banner's height -- and so everything downstream of it --
 * is decided by how healthy the offered replacements are, which is four states,
 * not two.
 */
type BannerScenario =
  | "absent"
  | "operational-fallback"
  | "degraded-fallback"
  | "no-fallback";

type StatusSnapshot = {
  generatedAt: string;
  models: {
    id: string;
    provider: string;
    status: "available" | "limited" | "unavailable";
    fallbackModelIds: string[];
    fallbackHealth: FallbackHealth;
  }[];
};

const unavailable = (
  id: string,
  fallbackModelIds: string[],
  fallbackHealth: FallbackHealth
): StatusSnapshot["models"][number] => ({
  id,
  provider: "google",
  status: "unavailable",
  fallbackModelIds,
  fallbackHealth,
});

const HEALTHY_SNAPSHOT: StatusSnapshot = {
  generatedAt: "2099-01-01T00:00:00.000Z",
  models: [],
};

const OUTAGE_WITH_FALLBACK_SNAPSHOT: StatusSnapshot = {
  generatedAt: "2099-01-01T00:00:00.000Z",
  models: [unavailable(IMPACTED_MODEL, [FALLBACK_MODEL], "operational")],
};

const OUTAGE_WITH_DEGRADED_FALLBACK_SNAPSHOT: StatusSnapshot = {
  generatedAt: "2099-01-01T00:00:00.000Z",
  models: [unavailable(IMPACTED_MODEL, [FALLBACK_MODEL], "degraded")],
};

/**
 * The state this spec exists for: the model the user is standing on is out and
 * nothing can replace it, so the banner carries a title, a full sentence of
 * guidance and a picker action -- its tallest, least compressible form.
 */
const OUTAGE_WITHOUT_FALLBACK_SNAPSHOT: StatusSnapshot = {
  generatedAt: "2099-01-01T00:00:00.000Z",
  models: [unavailable(IMPACTED_MODEL, [], "none")],
};

const SNAPSHOTS: Record<BannerScenario, StatusSnapshot> = {
  absent: HEALTHY_SNAPSHOT,
  "operational-fallback": OUTAGE_WITH_FALLBACK_SNAPSHOT,
  "degraded-fallback": OUTAGE_WITH_DEGRADED_FALLBACK_SNAPSHOT,
  "no-fallback": OUTAGE_WITHOUT_FALLBACK_SNAPSHOT,
};

async function mockStatus(page: Page, snapshot: BannerScenario | StatusSnapshot) {
  const body = typeof snapshot === "string" ? SNAPSHOTS[snapshot] : snapshot;
  await page.route("**/api/models/status**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  );
}

async function seedGuestPreferences(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
  });
}

async function setRootFont(page: Page, size: number) {
  if (size !== 16 && size !== 20 && size !== 24 && size !== 32) {
    throw new Error(`Unsupported QA root font size: ${size}px`);
  }
  await setRootFontSize(page, size);
}

type CellReport = {
  textareaHit: string;
  sendHit: string;
  sendEnabled: boolean;
  textareaLines: number;
  textareaWidthRatio: number;
  disclaimerIntersection: number;
  bannerIntersection: number;
  scrollOwners: string[];
  documentHorizontalOverflow: number;
  widestElementOverhang: number;
};

/**
 * Everything the cell is judged on, read in one evaluate so the numbers all
 * describe the same frame. `scrollIntoViewIfNeeded` runs first, because a
 * control that needs one scroll to reach is allowed -- a control that no
 * amount of scrolling reaches is not.
 */
async function scrollIntoVisibleViewport(page: Page, testId: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded().catch(() => {});
  // `scrollIntoViewIfNeeded` reasons about the *layout* viewport, so with a
  // raised keyboard it stops as soon as the element is nominally on the page.
  // One further scroll of the element's own scroll owner is what the user
  // actually does, and it is still one scroll.
  await page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!element) return;
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    const rect = element.getBoundingClientRect();
    const overshoot = rect.bottom - visibleHeight;
    if (overshoot <= 0) return;
    let ancestor: HTMLElement | null = element.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        ancestor.scrollHeight - ancestor.clientHeight > 1
      ) {
        ancestor.scrollTop = Math.min(
          ancestor.scrollTop + overshoot + 8,
          ancestor.scrollHeight - ancestor.clientHeight
        );
        return;
      }
      ancestor = ancestor.parentElement;
    }
  }, testId);
}

/**
 * Is this control operable *where the user can see it*: is its centre inside
 * the visible viewport, and does a hit-test there land on the control itself?
 * "self" is the only passing answer.
 */
async function hitTestByTestId(page: Page, testId: string) {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!element) return "missing";
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    if (y < 0 || y > visibleHeight || x < 0 || x > window.innerWidth) {
      return "outside-visible-viewport";
    }
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit) return "null";
    if (hit === element || element.contains(hit)) return "self";
    return hit.dataset.testid || hit.tagName;
  }, testId);
}

/** One scroll, then a hit-test -- the same budget the composer gets. */
async function reach(page: Page, testId: string) {
  await scrollIntoVisibleViewport(page, testId);
  return hitTestByTestId(page, testId);
}

type BannerBudget = {
  heightBasis: string;
  bannerHeight: number;
  maxHeight: number;
  visibleHeight: number;
  layoutHeight: number;
};

/**
 * PROV-BANNER-001. What the banner is allowed to take, and of *which*
 * viewport. Before the fix `maxHeight` was 45dvh -- 380px of an 844px layout
 * viewport -- while the user could only see 524px of it.
 */
async function readBannerBudget(page: Page): Promise<BannerBudget> {
  return page.evaluate(() => {
    const banner = document.querySelector<HTMLElement>(
      '[data-testid="provider-outage-banner"]'
    );
    if (!banner) throw new Error("provider-outage-banner is not rendered");
    return {
      heightBasis: banner.dataset.heightBasis ?? "",
      bannerHeight: banner.getBoundingClientRect().height,
      maxHeight: parseFloat(getComputedStyle(banner).maxHeight) || 0,
      visibleHeight: window.visualViewport?.height ?? window.innerHeight,
      layoutHeight: window.innerHeight,
    };
  });
}

async function readCell(page: Page): Promise<CellReport> {
  // Each control is judged after being scrolled to in its own right. The
  // requirement is that every control is reachable, not that they all fit on
  // screen together -- at 200% text with a full-height outage banner on a
  // 568px phone, nothing could satisfy the latter.
  await scrollIntoVisibleViewport(page, "chat-textarea");
  const textareaHit = await hitTestByTestId(page, "chat-textarea");

  await scrollIntoVisibleViewport(page, "chat-send-button");
  const report = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('[data-testid="mobile-chat-shell"]')!;
    const textarea = document.querySelector<HTMLElement>('[data-testid="chat-textarea"]');
    const send = document.querySelector<HTMLElement>('[data-testid="chat-send-button"]');
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const row = document.querySelector<HTMLElement>('[data-testid="composer-textarea-row"]');
    const disclaimer = document.querySelector<HTMLElement>(
      '[data-testid="chat-ai-disclaimer-mobile"]'
    );
    const banner = document.querySelector<HTMLElement>('[data-testid="provider-outage-banner"]');

    const hitAt = (element: HTMLElement | null) => {
      if (!element) return "missing";
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      // The *visible* viewport, not the layout one: a control under a raised
      // on-screen keyboard still has a hit-testable layout position, and
      // calling that "reachable" is the mistake this spec exists to catch.
      const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
      if (y < 0 || y > visibleHeight || x < 0 || x > window.innerWidth) {
        return "outside-visible-viewport";
      }
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!hit) return "null";
      if (hit === element || element.contains(hit)) return "self";
      return hit.dataset.testid || hit.tagName;
    };

    // The part of an element that is actually painted: its own box clipped by
    // every scrolling/clipping ancestor. A control scrolled out of its own
    // region is not "over" anything, and treating its raw rect as if it were
    // would flag overlaps that no user can see.
    const paintedRect = (element: HTMLElement) => {
      let box = element.getBoundingClientRect();
      let top = box.top;
      let bottom = box.bottom;
      let left = box.left;
      let right = box.right;
      let ancestor: HTMLElement | null = element.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflow !== "visible" || style.overflowY !== "visible" || style.overflowX !== "visible") {
          box = ancestor.getBoundingClientRect();
          if (style.overflowY !== "visible") {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
          }
          if (style.overflowX !== "visible") {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
        }
        ancestor = ancestor.parentElement;
      }
      return { top, bottom, left, right };
    };

    const area = (a: HTMLElement | null, b: HTMLElement | null) => {
      if (!a || !b) return 0;
      const ra = paintedRect(a);
      const rb = paintedRect(b);
      const w = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const h = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      return Math.round(w * h);
    };

    // "Reachable through exactly one scroll owner" is about the scrolls the
    // user actually has to perform, so this counts the ancestors that were
    // genuinely moved to bring the composer into view (readCell scrolls first).
    // A scroller that exists but stayed at the top was not part of the path.
    const scrollOwners: string[] = [];
    if (composer) {
      let ancestor: HTMLElement | null = composer.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        const scrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          ancestor.scrollHeight - ancestor.clientHeight > 1;
        if (scrollable && ancestor.scrollTop > 0) {
          scrollOwners.push(ancestor.dataset.testid || ancestor.tagName.toLowerCase());
        }
        ancestor = ancestor.parentElement;
      }
      if (document.documentElement.scrollTop > 0) {
        // The page behind the shell should never be the path to the composer.
        scrollOwners.push("document");
      }
    }

    // Per-element horizontal overhang inside the shell, so the shell's own
    // `overflow-x: hidden` cannot make a sideways overflow look like zero.
    let widestElementOverhang = 0;
    shell.querySelectorAll<HTMLElement>("*").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      let ancestor: HTMLElement | null = element.parentElement;
      while (ancestor && ancestor !== shell) {
        const overflowX = getComputedStyle(ancestor).overflowX;
        // An element inside a declared horizontal scroller is allowed to be
        // wider than the viewport; that is what the scroller is for.
        if (overflowX === "auto" || overflowX === "scroll") return;
        ancestor = ancestor.parentElement;
      }
      widestElementOverhang = Math.max(
        widestElementOverhang,
        Math.round(rect.right - window.innerWidth)
      );
    });

    const lineHeight = textarea
      ? parseFloat(getComputedStyle(textarea).lineHeight) || 0
      : 0;
    const textareaRect = textarea?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();

    return {
      textareaHit: "unused",
      sendHit: hitAt(send),
      sendEnabled: send ? !(send as HTMLButtonElement).disabled : false,
      textareaLines:
        textareaRect && lineHeight > 0 ? textareaRect.height / lineHeight : 0,
      textareaWidthRatio:
        textareaRect && rowRect && rowRect.width > 0
          ? textareaRect.width / rowRect.width
          : 0,
      disclaimerIntersection: area(disclaimer, composer),
      bannerIntersection: area(banner, composer),
      scrollOwners,
      documentHorizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      widestElementOverhang,
    };
  });
  return { ...report, textareaHit };
}

function assertCell(report: CellReport, label: string) {
  expect(report.textareaHit, `${label}: textarea centre hit-test`).toBe("self");
  expect(report.sendEnabled, `${label}: send is enabled with a draft`).toBe(true);
  expect(report.sendHit, `${label}: send centre hit-test after one scroll`).toBe("self");
  expect(report.textareaLines, `${label}: textarea shows a full line`).toBeGreaterThanOrEqual(
    0.95
  );
  expect(
    report.textareaWidthRatio,
    `${label}: textarea owns its row`
  ).toBeGreaterThanOrEqual(0.9);
  expect(
    report.disclaimerIntersection,
    `${label}: disclaimer over composer`
  ).toBe(0);
  expect(report.bannerIntersection, `${label}: banner over composer`).toBe(0);
  // None is the ideal (already on screen); one is allowed; two would mean the
  // user has to work out which surface to drag.
  expect(
    report.scrollOwners.length,
    `${label}: the composer must be reachable through at most one scroll owner (saw ${
      report.scrollOwners.join(", ") || "none"
    })`
  ).toBeLessThanOrEqual(1);
  expect(
    report.scrollOwners.includes("document"),
    `${label}: the page behind the shell must not be the path to the composer`
  ).toBe(false);
  expect(
    report.documentHorizontalOverflow,
    `${label}: document horizontal overflow`
  ).toBeLessThanOrEqual(1);
  expect(
    report.widestElementOverhang,
    `${label}: element wider than the viewport inside the shell`
  ).toBeLessThanOrEqual(1);
}

/**
 * The banner may scroll inside itself, but it may never be the reason the
 * composer is out of reach, and its cap has to come from the viewport the user
 * can actually see.
 */
async function assertBannerBudget(page: Page, label: string) {
  const budget = await readBannerBudget(page);
  expect(
    budget.heightBasis,
    `${label}: the banner cap must be measured against the visible viewport`
  ).toBe("visible-viewport");
  expect(
    budget.maxHeight,
    `${label}: banner cap ${budget.maxHeight}px vs 45% of the ${budget.visibleHeight}px the user can see`
  ).toBeLessThanOrEqual(budget.visibleHeight * 0.45 + 1);
  expect(
    budget.bannerHeight,
    `${label}: rendered banner height`
  ).toBeLessThanOrEqual(budget.maxHeight + 1);
  return budget;
}

/**
 * Every action the banner offers is still on screen and still operable. The
 * no-fallback state is exactly the one where hiding any of them would be the
 * cheap fix, so this is asserted rather than assumed.
 */
async function assertBannerActionsReachable(
  page: Page,
  label: string,
  options: { expectChooseModel?: boolean; expectSwap?: boolean } = {}
) {
  await expect(page.getByTestId("provider-status-title")).toBeVisible();
  if (options.expectChooseModel) {
    await expect(page.getByTestId("provider-status-guidance")).toBeVisible();
    expect(
      await reach(page, "provider-status-choose-model"),
      `${label}: the "choose another model" action`
    ).toBe("self");
  }
  if (options.expectSwap) {
    expect(await reach(page, "provider-status-swap"), `${label}: the swap action`).toBe(
      "self"
    );
  }
  expect(await reach(page, "provider-status-refresh"), `${label}: refresh`).toBe("self");
}

/**
 * The banner's compact chips and its refresh box are the two things a
 * space-saving "fix" reaches for first, so their 44px touch floor is measured
 * rather than reviewed.
 */
async function assertTouchTargets(page: Page, label: string) {
  const boxes = await page.evaluate(() => {
    const ids = [
      "provider-status-choose-model",
      "provider-status-swap",
      "provider-status-refresh",
      "chat-send-button",
      "composer-model-select",
    ];
    return ids.flatMap((id) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)).map(
        (element) => {
          const rect = element.getBoundingClientRect();
          return { id, width: rect.width, height: rect.height };
        }
      )
    );
  });
  for (const box of boxes) {
    expect(box.height, `${label}: ${box.id} touch height`).toBeGreaterThanOrEqual(43.5);
    // The composer's model button is content-width by design (`max-w-[112px]`,
    // truncating): its horizontal extent is whatever the model's name needs and
    // has never been pinned to 44px. Every other control here is a square or a
    // min-width chip, and those are.
    if (box.id === "composer-model-select") continue;
    expect(box.width, `${label}: ${box.id} touch width`).toBeGreaterThanOrEqual(43.5);
  }
}

async function enterGuestChat(
  page: Page,
  options: {
    lang: (typeof LOCALES)[number];
    scenario: BannerScenario | StatusSnapshot;
    viewport: { width: number; height: number };
  }
) {
  await prepareGuestPage(page, options.lang);
  await mockStatus(page, options.scenario);
  await seedGuestPreferences(page);
  await page.setViewportSize(options.viewport);
  await page.goto(`/chat?lang=${options.lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
}

const seededMessages = (models: string[]): QaConversationMessage[] => [
  { id: "u1", role: "user", content: "가용성 회귀 확인" },
  ...models.map((modelId, index) => ({
    id: `a${index + 1}`,
    role: "assistant" as const,
    modelId,
    status: "normal",
    content: "확인했습니다. 계속 질문해 주세요.",
  })),
];

/** A signed-in Free-plan conversation that already has answers in it. */
async function enterSignedInConversation(
  page: Page,
  options: {
    lang: (typeof LOCALES)[number];
    models: string[];
    scenario: BannerScenario | StatusSnapshot;
    viewport: { width: number; height: number };
  }
) {
  await prepareGuestPage(page, options.lang);
  await mockAuthenticatedApi(page, {
    selectedModels: options.models,
    messages: seededMessages(options.models),
  });
  await restoreActiveConversation(page);
  await mockStatus(page, options.scenario);
  await seedGuestPreferences(page);
  await page.setViewportSize(options.viewport);
  await page.goto(`/chat?lang=${options.lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Geometry matrix
//
// Kept to 4 viewports x 2 locales x 4 root font sizes, now across banner
// scenarios instead of a boolean. `degraded-fallback` renders the same anatomy
// as `operational-fallback` with one extra sentence, so it runs on the two
// viewports that bound the range (the smallest and the reproduction one)
// rather than on all four; `absent`, `operational-fallback` and `no-fallback`
// run everywhere. 320px, 390px, Korean, 200% text and keyboard-open are never
// skipped.
// ---------------------------------------------------------------------------

const ALWAYS_SCENARIOS: BannerScenario[] = [
  "absent",
  "operational-fallback",
  "no-fallback",
];
const DEGRADED_VIEWPORT_KEYS = new Set(["320x568", "390x844"]);

test.describe("mobile composer stays operable with a provider banner at every text size", () => {
  test.use({ hasTouch: true });

  // Playwright requires the first argument to be an object destructuring
  // pattern, even when the hook only needs `testInfo`.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name.includes("safari"),
      "The matrix pins explicit viewports and runs on one engine."
    );
  });

  for (const viewport of VIEWPORTS) {
    const viewportKey = `${viewport.width}x${viewport.height}`;
    const scenarios: BannerScenario[] = DEGRADED_VIEWPORT_KEYS.has(viewportKey)
      ? [...ALWAYS_SCENARIOS, "degraded-fallback"]
      : ALWAYS_SCENARIOS;

    for (const scenario of scenarios) {
      test(
        `${viewportKey}, provider banner ${scenario}`,
        { tag: "@ui-risk" },
        async ({ page }) => {
          test.setTimeout(180_000);
          for (const lang of LOCALES) {
            await enterGuestChat(page, { lang, scenario, viewport });
            if (scenario === "absent") {
              await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
            } else {
              await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
            }
            // A draft, so "send" is the real enabled control rather than the
            // disabled placeholder an empty composer shows.
            await page.getByTestId("chat-textarea").fill("가용성 회귀 확인");

            for (const rootFont of ROOT_FONT_SIZES) {
              await setRootFont(page, rootFont);
              const label = `${viewportKey} ${lang} banner=${scenario} root=${rootFont}px`;
              assertCell(await readCell(page), label);
              if (scenario !== "absent") {
                await assertBannerBudget(page, label);
              }
            }
            await setRootFont(page, 16);
          }
        }
      );
    }
  }
});

test.describe("mobile composer reachability under IME, keyboard and safe areas", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name.includes("safari"),
      "The matrix pins explicit viewports and runs on one engine."
    );
  });

  test(
    "Korean composition stays visible at 200% text with an outage banner",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(120_000);
      await enterGuestChat(page, {
        lang: "ko",
        scenario: "no-fallback",
        viewport: { width: 320, height: 568 },
      });
      await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
      await setRootFont(page, 32);

      const textarea = page.getByTestId("chat-textarea");
      await scrollIntoVisibleViewport(page, "chat-textarea");
      await textarea.click();
      const before = await textarea.boundingBox();

      // A real composition, not a paste: the caret and the in-flight syllable
      // both have to stay inside the visible box.
      await page.keyboard.insertText("안녕하세");
      await textarea.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(
          new CompositionEvent("compositionupdate", { bubbles: true, data: "요" })
        );
      });

      await scrollIntoVisibleViewport(page, "chat-textarea");
      const composing = await readCell(page);
      expect(composing.textareaHit, "textarea reachable mid-composition").toBe("self");
      const overflow = await textarea.evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        return {
          vertical: field.scrollHeight - field.clientHeight,
          horizontal: field.scrollLeft,
          focused: document.activeElement === field,
        };
      });
      expect(overflow.horizontal, "no horizontal scroll inside the textarea").toBe(0);
      expect(overflow.vertical, "composition text stays in the visible box").toBeLessThanOrEqual(1);
      expect(overflow.focused, "composition keeps focus in the textarea").toBe(true);

      // The composer is not re-hosted or re-flowed by anything that happens
      // during a composition: same x, same width.
      const after = await textarea.boundingBox();
      expect(after?.x, "textarea x-position during composition").toBeCloseTo(before?.x ?? 0, 0);
      expect(after?.width, "textarea width during composition").toBeCloseTo(
        before?.width ?? 0,
        0
      );

      // A banner refresh mid-composition must not interrupt it. Focus moving
      // to the button the user just pressed is correct and expected; what must
      // not happen is the composer being rebuilt underneath them, which would
      // take the in-flight composition, the draft and the caret with it.
      await textarea.evaluate((element) => {
        (element as HTMLElement & { __imeMarker?: string }).__imeMarker = "before-refresh";
      });
      await page.getByTestId("provider-status-refresh").click({ force: true });
      const stillComposing = await textarea.evaluate((element) => ({
        value: (element as HTMLTextAreaElement).value,
        marker: (element as HTMLElement & { __imeMarker?: string }).__imeMarker,
        x: element.getBoundingClientRect().x,
        width: element.getBoundingClientRect().width,
      }));
      expect(stillComposing.value, "committed text survives a banner refresh").toContain(
        "안녕하세"
      );
      expect(
        stillComposing.marker,
        "the composer's textarea node survives a banner refresh"
      ).toBe("before-refresh");
      expect(stillComposing.x, "textarea x-position after a banner refresh").toBeCloseTo(
        before?.x ?? 0,
        0
      );
      expect(stillComposing.width, "textarea width after a banner refresh").toBeCloseTo(
        before?.width ?? 0,
        0
      );

      await textarea.evaluate((element) =>
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
      );
    }
  );

  for (const scenario of ["operational-fallback", "no-fallback"] as const) {
    test(
      `an open on-screen keyboard leaves the input and send reachable at 200% text (${scenario})`,
      { tag: "@ui-risk" },
      async ({ page }) => {
        test.setTimeout(120_000);
        await enterGuestChat(page, {
          lang: "ko",
          scenario,
          viewport: REPRO_VIEWPORT,
        });
        await setRootFont(page, REPRO_ROOT_FONT);
        await page.getByTestId("chat-textarea").fill("키보드 회귀 확인");

        await openOnScreenKeyboard(page, REPRO_KEYBOARD_INSET);
        const label = `390x844 ko root=32px keyboard=320 banner=${scenario}`;
        assertCell(await readCell(page), label);
        await assertBannerBudget(page, label);

        await closeOnScreenKeyboard(page);
        // Closing the keyboard must return the layout to its own steady state
        // rather than leaving it wherever the compensation put it.
        assertCell(await readCell(page), `${label} (keyboard closed)`);
      }
    );
  }

  for (const scenario of ["operational-fallback", "no-fallback"] as const) {
    test(
      `safe-area insets do not push the composer under the home indicator (${scenario})`,
      { tag: "@ui-risk" },
      async ({ page }) => {
        test.setTimeout(120_000);
        await enterGuestChat(page, {
          lang: "ko",
          scenario,
          viewport: REPRO_VIEWPORT,
        });
        // env() cannot be forced from a test, so the fixture reproduces what the
        // inset buys: 34px of reserved space below the composer's own padding.
        await page.addStyleTag({
          content: `[data-testid="chat-ai-disclaimer-mobile"]{padding-bottom:calc(0.4rem + 34px)}`,
        });
        await setRootFont(page, REPRO_ROOT_FONT);
        await page.getByTestId("chat-textarea").fill("세이프 에어리어 확인");

        const report = await readCell(page);
        expect(report.sendHit, "send above the home indicator").toBe("self");
        expect(report.textareaHit, "textarea above the home indicator").toBe("self");
        expect(
          report.disclaimerIntersection,
          "the disclaimer sits below the composer, not over it"
        ).toBe(0);
      }
    );
  }
});

// ---------------------------------------------------------------------------
// The exact reproduction. Pinned geometry, pinned locale, pinned text size,
// pinned keyboard inset: 390x844 / ko / 32px root / 320px keyboard, a guest's
// empty new chat, the selected model unavailable and nothing able to replace
// it.
// ---------------------------------------------------------------------------

test.describe("no-fallback provider banner with the keyboard open", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name.includes("safari"),
      "The matrix pins explicit viewports and runs on one engine."
    );
  });

  test(
    "no-fallback Korean provider banner keeps the composer operable with the keyboard open at 200% text",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(180_000);
      await enterGuestChat(page, {
        lang: "ko",
        scenario: "no-fallback",
        viewport: REPRO_VIEWPORT,
      });
      // The state under test is a *new* chat: the composer is portalled into
      // the welcome surface there, which is where the two scroll owners used
      // to appear.
      await expect(page.getByTestId("chat-empty-state")).toBeVisible();
      await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
      await setRootFont(page, REPRO_ROOT_FONT);
      await page.getByTestId("chat-textarea").fill("대체 모델 없음 회귀 확인");
      await openOnScreenKeyboard(page, REPRO_KEYBOARD_INSET);

      const label = "390x844 ko root=32px keyboard=320 no-fallback";

      // 1. The banner still says everything it has to say. Nothing here may be
      //    hidden, shortened or demoted to make room.
      await expect(page.getByTestId("provider-status-title")).toBeVisible();
      await expect(page.getByTestId("provider-status-guidance")).toHaveText(
        "현재 사용할 수 있는 대체 모델이 없습니다."
      );
      await expect(page.getByTestId("provider-status-swap")).toHaveCount(0);
      await expect(page.getByTestId("provider-status-choose-model")).toHaveCount(1);

      // 2. ... and it is capped against the viewport the user can see.
      const budget = await assertBannerBudget(page, label);
      expect(
        budget.visibleHeight,
        "the fixture really did raise a 320px keyboard"
      ).toBeCloseTo(budget.layoutHeight - REPRO_KEYBOARD_INSET, 0);

      // 3. The composer is operable: one scroll owner at most, both controls
      //    hit-testable inside the visible viewport, the textarea still owning
      //    a full-width row of at least one line, and nothing painted over it.
      assertCell(await readCell(page), label);

      // 4. Every recovery action is reachable in its own right.
      await assertBannerActionsReachable(page, label, { expectChooseModel: true });
      await assertTouchTargets(page, label);

      await closeOnScreenKeyboard(page);
    }
  );

  test(
    "safe-area insets do not push the composer under the home indicator",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/chat?lang=ko");
      await expect(page.getByTestId("chat-textarea")).toBeVisible();
      // env() cannot be forced from a test, so the fixture reproduces what the
      // inset buys: 34px of reserved space below the composer's own padding.
      await page.addStyleTag({ url: "/qa/mobile-safe-area-200.css" });
      await page.getByTestId("chat-textarea").fill("세이프 에어리어 확인");

      const report = await readCell(page);
      expect(report.sendHit, "send above the home indicator").toBe("self");
      expect(report.textareaHit, "textarea above the home indicator").toBe("self");
      expect(
        report.disclaimerIntersection,
        "the disclaimer sits below the composer, not over it"
      ).toBe(0);
    }
  );

  test(
    "the no-fallback banner's model action recovers the selection without losing the draft",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(180_000);
      await enterGuestChat(page, {
        lang: "ko",
        scenario: "no-fallback",
        viewport: REPRO_VIEWPORT,
      });
      await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
      const draft = "초안 유지 확인";
      await page.getByTestId("chat-textarea").fill(draft);

      // "No fallback" means "no replacement we can recommend", never "no way
      // to change your model".
      await scrollIntoVisibleViewport(page, "provider-status-choose-model");
      await page.getByTestId("provider-status-choose-model").click();
      const picker = page.locator("#chat-input-popover");
      await expect(picker).toBeVisible();
      // Opening the picker must not focus the composer, or the phone keyboard
      // reopens over the very dialog the user just asked for.
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName
        ),
        "the picker owns focus, not the textarea"
      ).not.toBe("chat-textarea");

      // Add a healthy model, then drop the one that is out. Both halves go
      // through the same catalogue the banner opened.
      await openModelCatalogue(page);
      await picker.locator('[data-testid="model-option"][data-model-id="claude-haiku-4-5"]').click();
      await picker.locator(`[data-testid="model-option"][data-model-id="${IMPACTED_MODEL}"]`).click();
      // Escape steps back to the recommendations first, then closes.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();

      // The outage is no longer standing on the user's selection, so the
      // banner has nothing left to warn about.
      await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
      // Focus lands on something that still means "your models" -- never on
      // the textarea, which would raise the keyboard again.
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "focus returns to a model control"
      ).not.toBe("chat-textarea");

      await expect(page.getByTestId("chat-textarea")).toHaveValue(draft);
      assertCell(await readCell(page), "after recovering from a no-fallback outage");
    }
  );

  test(
    "a signed-in Free plan conversation keeps the composer operable with several models out and no fallback",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(180_000);
      const models = ["gpt-5-4-mini", "claude-haiku-4-5"];
      await enterSignedInConversation(page, {
        lang: "ko",
        models,
        scenario: {
          generatedAt: "2099-01-01T00:00:00.000Z",
          models: models.map((id) => unavailable(id, [], "none")),
        },
        viewport: REPRO_VIEWPORT,
      });
      await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
      // Two impacted models, so the banner offers one action per model rather
      // than one action for the pair.
      await expect(page.getByTestId("provider-status-choose-model")).toHaveCount(2);
      await setRootFont(page, REPRO_ROOT_FONT);
      await page.getByTestId("chat-textarea").fill("여러 모델 장애 확인");
      await openOnScreenKeyboard(page, REPRO_KEYBOARD_INSET);

      const label = "signed-in 390x844 ko root=32px keyboard=320 two models out";
      assertCell(await readCell(page), label);
      await assertBannerBudget(page, label);
      expect(await reach(page, "provider-status-refresh"), `${label}: refresh`).toBe("self");

      // The plan lock is disclosed in the picker this banner opens, and it
      // does not cost the composer its usability.
      await scrollIntoVisibleViewport(page, "provider-status-choose-model");
      await page.getByTestId("provider-status-choose-model").first().click();
      const picker = page.locator("#chat-input-popover");
      await expect(picker).toBeVisible();
      await openModelCatalogue(page);
      await expect(
        picker.locator('[data-testid="model-option"][data-model-plan-locked="true"]').first()
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();

      assertCell(await readCell(page), `${label} (after the picker closed)`);
      await closeOnScreenKeyboard(page);
    }
  );
});
