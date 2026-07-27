import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

// The two comparison actions act on *finished answers*, so they are their own
// labelled section rather than another row of composer controls -- but they
// share the composer's alignment axis inside one bottom workflow dock.
//
// Before this, desktop pinned them to the far left of the shell while the
// composer stayed centred at max-w-4xl (so the gap grew with the screen), and
// mobile rendered them *above* the answers they summarise. These tests pin
// both the alignment and the reading order, plus the readiness states that
// decide whether the actions may run at all.

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
const CHAT_ID = "guest_rail_test";
const TITLE = "Rail test";

type SeededStatus = "normal" | "error";

const seedGuestComparison = async (
  page: Page,
  statuses: Record<string, SeededStatus | "missing"> = {}
) => {
  await page.addInitScript(
    ({ chatId, models, title, statuses }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title,
            selectedModels: models,
            disabledPanels: [],
            webSearchMode: "off",
            createdAt: new Date().toISOString(),
          },
        ])
      );
      for (const modelId of models) {
        const status = statuses[modelId] || "normal";
        if (status === "missing") continue;
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "Compare these.", status: "normal" },
            {
              id: "a1",
              role: "assistant",
              content:
                status === "error"
                  ? "QA fixture: this model failed."
                  : `Answer from ${modelId}.`,
              status,
            },
          ])
        );
      }
    },
    { chatId: CHAT_ID, models: MODELS, title: TITLE, statuses }
  );
};

const openSeeded = async (page: Page) => {
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: TITLE });
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
};

const rail = (page: Page) => page.getByTestId("comparison-action-rail");
const quickButton = (page: Page) => page.getByTestId("quick-comparison-button");

test.describe("desktop workflow dock alignment", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "The desktop dock only renders in the desktop shell."
    );
    await prepareGuestPage(page, "en");
  });

  for (const width of [768, 1024, 1280, 1440, 1920]) {
    test(`the rail and the composer share one alignment axis at ${width}px`, async ({
      page,
    }) => {
      await seedGuestComparison(page);
      await page.setViewportSize({ width, height: 900 });
      await openSeeded(page);

      await expect(rail(page)).toBeVisible();
      const railBox = await rail(page)
        .locator("> div")
        .first()
        .boundingBox();
      const composerBox = await page.getByTestId("chat-input").boundingBox();
      expect(railBox).not.toBeNull();
      expect(composerBox).not.toBeNull();

      expect(Math.abs(railBox!.x - composerBox!.x)).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          railBox!.x + railBox!.width - (composerBox!.x + composerBox!.width)
        )
      ).toBeLessThanOrEqual(4);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("the dock keeps a single full-width seam against the answer canvas", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeeded(page);

    await expect(rail(page)).toBeVisible();
    // The rail owns the boundary; the composer must not draw a second one at
    // the same seam, which used to stack two hairlines a few pixels apart.
    const borders = await page.evaluate(() => {
      const railSection = document.querySelector(
        '[data-testid="comparison-action-rail"]'
      );
      const composerWrapper = document.querySelector('[data-testid="chat-input"]')
        ?.parentElement;
      const topBorder = (element: Element | null | undefined) =>
        element
          ? Number.parseFloat(getComputedStyle(element).borderTopWidth) || 0
          : 0;
      return {
        rail: topBorder(railSection),
        composer: topBorder(composerWrapper),
      };
    });
    expect(borders.rail).toBeGreaterThan(0);
    expect(borders.composer).toBe(0);
  });

  test("each action keeps a 44px hit area", async ({ page }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeeded(page);

    for (const testId of ["quick-comparison-button", "ai-review-guest-locked"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, testId).not.toBeNull();
      expect(box!.height, testId).toBeGreaterThanOrEqual(44);
      expect(box!.width, testId).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("mobile comparison rail", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The mobile rail ordering only applies to the mobile shell."
    );
    await prepareGuestPage(page, "en");
  });

  test("follow-up tools come after the answers and before the composer", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await openSeeded(page);

    await expect(rail(page)).toBeVisible();
    const order = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          '[data-testid="mobile-model-tab"], [data-testid="chat-message"], [data-testid="comparison-action-rail"], [data-testid="chat-input"]'
        )
      );
      // Reduce to the first occurrence of each landmark, in document order.
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
  });

  for (const width of [320, 360, 390]) {
    test(`the two actions fit ${width}px without truncating away their meaning`, async ({
      page,
    }) => {
      await seedGuestComparison(page);
      await page.setViewportSize({ width, height: 640 });
      await openSeeded(page);

      await expect(rail(page)).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const label = quickButton(page).locator("span").first();
      await expect(label).toHaveText("Differences");
      const clipped = await label.evaluate(
        (node) => node.scrollWidth > node.clientWidth + 1
      );
      expect(clipped).toBe(false);

      const box = await quickButton(page).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  }

  test("landscape gets the same one-row treatment, without losing the actions", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 740, height: 360 });
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    const disclosure = page.getByTestId("comparison-action-rail-disclosure");
    await expect(disclosure).toBeVisible();
    const box = await disclosure.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // Still reachable: expanding brings both actions back on the same screen.
    await disclosure.click();
    await expect(quickButton(page)).toBeVisible();
    await expect(page.getByTestId("ai-review-guest-locked")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the rail collapses to one row while the keyboard covers the viewport", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSeeded(page);
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");

    // Stand in for the on-screen keyboard: visualViewport shrinks while the
    // layout viewport does not, which is exactly the signal the shell reads.
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => window.innerHeight * 0.5,
      });
      viewport.dispatchEvent(new Event("resize"));
    });

    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("comparison-action-rail-disclosure")).toBeVisible();
    await expect(quickButton(page)).toHaveCount(0);

    // The composer keeps its rows: both the textarea and the send control stay
    // hit-testable with the keyboard up.
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("comparison readiness states", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
  });

  test("a conversation with no answers at all offers no rail", async ({ page }) => {
    await seedGuestComparison(page, {
      "gpt-5-4-mini": "missing",
      "claude-haiku-4-5": "missing",
      "gemini-2-5-flash": "missing",
    });
    await page.goto("/chat?lang=en");
    await expect(rail(page)).toHaveCount(0);
  });

  test("three completed answers run against all three", async ({ page }) => {
    await seedGuestComparison(page);
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-state", "ready");
    await expect(rail(page)).toHaveAttribute("data-ready-count", "3");
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("comparison-action-rail-status")).toContainText(
      "Comparing 3 completed answers"
    );
  });

  test("a failed answer is excluded, said so, and does not block the rest", async ({
    page,
  }) => {
    await seedGuestComparison(page, { "gemini-2-5-flash": "error" });
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-state", "ready");
    await expect(rail(page)).toHaveAttribute("data-ready-count", "2");
    await expect(rail(page)).toHaveAttribute("data-excluded-count", "1");
    const status = page.getByTestId("comparison-action-rail-status");
    await expect(status).toContainText("Comparing 2 completed answers");
    await expect(status).toContainText("1 unfinished excluded");
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
  });

  test("one usable answer blocks both actions and says why, reachably", async ({
    page,
  }) => {
    await seedGuestComparison(page, {
      "claude-haiku-4-5": "error",
      "gemini-2-5-flash": "error",
    });
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-state", "needsMore");
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "true");

    // The reason is a described-by status, not a `title` -- so it survives
    // keyboard focus and screen readers, and the control stays focusable.
    const describedBy = await quickButton(page).getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText(
      "one more completed answer is needed"
    );
    await quickButton(page).focus();
    await expect(quickButton(page)).toBeFocused();

    // aria-disabled blocks activation rather than only dimming the control:
    // Playwright already refuses a normal click on an aria-disabled control,
    // so force one through and confirm nothing runs.
    await quickButton(page).click({ force: true });
    await expect(page.getByTestId("quick-comparison-dialog")).toHaveCount(0);
  });

  test("the quick summary never quotes a fixed price it cannot guarantee", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await openSeeded(page);

    const badge = page.getByTestId("quick-comparison-credit-cost");
    await expect(badge).toHaveAttribute("data-approximate", "true");
    await expect(badge).toContainText("~1");
    await expect(badge).toHaveAttribute(
      "aria-label",
      /About 1 credit .*Long answers may use more/
    );
  });
});
