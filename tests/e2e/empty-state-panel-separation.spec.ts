import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  DESKTOP_VIEWPORT,
  enterConversation,
  restoreActiveConversation,
} from "./support/chat-state-fixtures";

/**
 * UI-EMPTY-001. The empty chat screen is a start screen, not a transparent lid
 * over a live comparison.
 *
 * The welcome screen is painted over the three comparison panels so the first
 * screen still reads as a comparison product. That is a deliberate visual
 * choice, and it used to come with an accessibility defect: the overlay stops
 * the pointer, but it does not stop the tab order, so a keyboard user reached
 * 24 panel controls a mouse user could not -- every one of them covered on
 * screen. Per-panel follow-up inputs were among them, in a state where there is
 * no answer to follow up on.
 *
 * These are the two halves of the settled contract, plus the separate one that
 * keeps model selection available. None of them asserts on `inert`, or on any
 * other implementation of the ban: an attribute check is exactly what stopped
 * meaning anything the last time the implementation moved (a
 * `not.toHaveAttribute("inert", "")` guard survived the attribute's removal and
 * passed vacuously ever after). What is asserted here is what a user can
 * observe -- the tab path, `document.activeElement`, the accessibility tree,
 * `elementFromPoint`, and whether a request is made.
 */

const PANEL = '[data-testid="desktop-model-panel"]';

test.use({ hasTouch: true });

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("desktop"),
    "The panels behind the welcome screen are a desktop-shell layout; the mobile shell renders one panel at a time and hides it while the welcome surface is up."
  );
});

/** Every element the tab order actually stops on, in order. */
async function walkTabOrder(page: Page, steps = 60) {
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  const stops: Array<{ inPanel: boolean; covered: boolean; describe: string }> = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((panelSelector) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const box = el.getBoundingClientRect();
      const hit =
        box.width > 0 && box.height > 0
          ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          : null;
      return {
        inPanel: Boolean(el.closest(panelSelector)),
        // Something else is painted at this control's own centre point.
        covered: Boolean(hit && hit !== el && !el.contains(hit)),
        describe: `${el.tagName.toLowerCase()}[${
          el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? ""
        }]`,
      };
    }, PANEL);
    if (stop) stops.push(stop);
  }
  return stops;
}

// ---------------------------------------------------------------------------
// 1. Empty conversation -- the negative contract
// ---------------------------------------------------------------------------
test.describe("empty conversation: the panels are not operable", () => {
  test("no tab stop lands inside a comparison panel, and none is covered", async ({
    page,
  }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);
    await expect(page.locator(PANEL)).toHaveCount(3);

    const stops = await walkTabOrder(page);
    expect(stops.length, "the start screen still has its own tab stops").toBeGreaterThan(0);

    expect(
      stops.filter((stop) => stop.inPanel).map((stop) => stop.describe),
      "keyboard must not reach a control the pointer cannot"
    ).toEqual([]);

    // The general form of the same rule: focus never lands on anything that is
    // painted over, wherever it lives. The theme/width/text-scale matrix at the
    // bottom of this file re-measures both across the axes that move the
    // overlay and the panel layout.
    expect(
      stops.filter((stop) => stop.covered).map((stop) => stop.describe),
      "no tab stop may be hidden behind another surface"
    ).toEqual([]);
  });

  test("the panel follow-up input takes no focus and no typing", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

    const result = await page.evaluate((panelSelector) => {
      const textarea = document.querySelector(
        `${panelSelector} textarea`
      ) as HTMLTextAreaElement | null;
      if (!textarea) return { present: false, focused: false };
      textarea.focus();
      return { present: true, focused: document.activeElement === textarea };
    }, PANEL);

    // Either it is not rendered at all, or it refuses focus. Both satisfy the
    // contract; what is forbidden is a focusable follow-up in this state.
    expect(
      result.present && result.focused,
      "the per-panel follow-up must not take focus while the conversation is empty"
    ).toBe(false);
  });

  test("the panel is not in the accessibility tree", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

    // Playwright's ARIA snapshot is the accessibility tree as assistive tech
    // sees it. The panel's own controls must not appear in it.
    const snapshot = await page.locator("body").ariaSnapshot();
    expect(
      snapshot,
      "the per-panel follow-up placeholder must not be exposed to assistive tech"
    ).not.toContain("이 모델에게만 추가 질문");
  });

  test("pointer cannot reach the panel controls either", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

    // Same rule stated from the pointer's side: hit-testing every panel
    // control's own centre must land on something else.
    const reachable = await page.evaluate((panelSelector) => {
      const controls = Array.from(
        document.querySelectorAll(`${panelSelector} button, ${panelSelector} select, ${panelSelector} textarea`)
      );
      return controls
        .filter((control) => {
          const box = control.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) return false;
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return hit === control || Boolean(hit && control.contains(hit));
        })
        .map((control) => control.tagName.toLowerCase());
    }, PANEL);
    expect(reachable, "no panel control may be hit-testable while empty").toEqual([]);
  });

  test("pressing Enter in the composer starts a comparison, never a panel-only send", async ({
    page,
  }) => {
    const panelOnlyPosts: string[] = [];
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await page.route("**/api/conversations/*/messages**", async (route) => {
      if (route.request().method() === "POST") {
        panelOnlyPosts.push(route.request().url());
      }
      await route.fulfill({
        status: route.request().method() === "POST" ? 201 : 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

    // Drive the keyboard the way a user would: tab to wherever focus goes and
    // press Enter, without ever targeting the panel directly.
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const isPanelTextarea = await page.evaluate((panelSelector) => {
        const el = document.activeElement;
        return Boolean(
          el && el.tagName === "TEXTAREA" && el.closest(panelSelector)
        );
      }, PANEL);
      if (isPanelTextarea) {
        await page.keyboard.type("panel only");
        await page.keyboard.press("Enter");
      }
    }
    await page.waitForTimeout(300);

    expect(
      panelOnlyPosts,
      "no message may be posted from a panel while the conversation is empty"
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Conversation with an answer -- the positive contract
// ---------------------------------------------------------------------------
test.describe("conversation with an answer: the panels are operable", () => {
  // Same shape as upgrade-discovery.spec.ts: open the chat as an
  // authenticated user first, then re-mock with history and reload, so the
  // conversation the panels restore is the seeded one.
  // The panels only restore a conversation the shell was told to reopen, so
  // this reuses enterConversation's restore/theme setup, then re-mocks with
  // history and reloads. The active-conversation marker is sessionStorage, so
  // it survives the reload and the seeded conversation is what comes back.
  const seedConversation = async (page: Page) => {
    await restoreActiveConversation(page);
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
      messages: [
        { id: "seed-user", role: "user", content: "seeded question" },
        {
          id: "seed-assistant",
          role: "assistant",
          content: "seeded answer",
          modelId: "gpt-5-4-mini",
        },
      ],
    });
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(
      page.locator(PANEL).first().getByText("seeded answer")
    ).toBeVisible();
  };

  test("the panel follow-up takes focus and accepts typing", async ({ page }) => {
    await seedConversation(page);

    const followUp = page.locator(PANEL).first().locator("textarea");
    await followUp.focus();
    await expect(followUp).toBeFocused();
    await followUp.fill("follow up on this");
    await expect(followUp).toHaveValue("follow up on this");
  });

  test("panel controls are reachable by keyboard once there is an answer", async ({
    page,
  }) => {
    await seedConversation(page);

    const stops = await walkTabOrder(page);
    expect(
      stops.filter((stop) => stop.inPanel).length,
      "the panels rejoin the tab order once the conversation has an answer"
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Model selection -- a separate contract from the follow-up ban
// ---------------------------------------------------------------------------
test.describe("model selection stays available before the first question", () => {
  test("the front-of-screen picker opens from the empty state and changes the selection", async ({
    page,
  }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

    // The composer -- and with it the model picker -- lives inside the start
    // screen, which is what makes banning the hidden panel selector safe.
    const welcomeHoldsComposer = await page.evaluate(() => {
      const welcome = document.querySelector('[data-testid="chat-empty-state"]');
      const input = document.querySelector('[data-testid="chat-input"]');
      return Boolean(welcome && input && welcome.contains(input));
    });
    expect(welcomeHoldsComposer, "the start screen carries the composer itself").toBe(true);

    const dialog = await openModelPickerCatalogue(page);
    const option = dialog
      .locator('[data-testid="model-option"]:not([disabled])')
      .first();
    await expect(option).toBeVisible();
    const before = await page
      .locator('button[aria-controls="chat-input-popover"]')
      .nth(1)
      .innerText();
    await option.click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const after = await page
      .locator('button[aria-controls="chat-input-popover"]')
      .nth(1)
      .innerText();
    expect(
      after,
      "choosing a model from the front picker must change the selection"
    ).not.toBe(before);
  });

  test("a locked model still offers upgrade discovery from the empty state", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
    await page.goto("/chat?lang=ko&utm_source=qa&utm_medium=e2e");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

    const dialog = await openModelPickerCatalogue(page);
    const locked = dialog
      .locator(
        '[data-testid="model-option"][data-model-plan-locked="true"]:not([disabled])'
      )
      .first();
    if ((await locked.count()) === 0) {
      test.skip(true, "This fixture's plan exposes no locked model to discover.");
    }
    await locked.click();
    await expect(
      page.getByTestId("locked-model-plan-cta"),
      "upgrade discovery must work through the front path, not the hidden panel selector"
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The ban must not depend on theme, shell width or text scale
// ---------------------------------------------------------------------------
// The overlay's own appearance changes across these (its dark alpha is what
// started UI-EMPTY-001), and a narrow or zoomed layout re-flows the panels --
// so "nothing in a panel is reachable" is re-measured rather than assumed to
// carry over from the 1440x900 light case above.
for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 900, name: "desktop" },
    { width: 1057, height: 900, name: "compact" },
  ]) {
    for (const zoom of [100, 200]) {
      test(`panels stay unreachable at ${viewport.name} ${zoom}% (${theme})`, async ({
        page,
      }) => {
        // 200% text scaling, expressed the way the typography contract does:
        // the root font size, not a browser zoom the harness cannot set.
        if (zoom !== 100) {
          await page.addInitScript((scale) => {
            document.documentElement.style.fontSize = `${(16 * scale) / 100}px`;
          }, zoom);
        }
        await enterConversation(page, {
          theme,
          viewport: { width: viewport.width, height: viewport.height },
        });
        await expect(page.getByTestId("chat-empty-state")).toHaveCount(1);

        const stops = await walkTabOrder(page, 45);
        expect(
          stops.filter((stop) => stop.inPanel).map((stop) => stop.describe),
          `[${viewport.name} ${zoom}% ${theme}] keyboard reached a panel control`
        ).toEqual([]);
        expect(
          stops.filter((stop) => stop.covered).map((stop) => stop.describe),
          `[${viewport.name} ${zoom}% ${theme}] focus landed on a covered control`
        ).toEqual([]);
      });
    }
  }
}
