import { expect, test, type Page } from "@playwright/test";
import { openModelCatalogue, prepareGuestPage } from "./support/app-fixtures";

// Regression coverage for STG-F006: a new guest's composer briefly showed a
// single-model "1 credit" estimate before an effect (which waited on
// /api/app-settings) swapped in the 3-model brand-trio default and re-priced
// it at 3 credits.
//
// These tests are about the *history* of the displayed numbers, not their
// final value: a passing final state proves nothing here, since the bug
// always converged on the right answer. The recorder below runs before any
// application script and captures every distinct value the composer has ever
// shown, so an intermediate wrong price fails the assertion even if it was
// only on screen for one frame.

// The product contract for a brand-new guest. The catalogue-derived version
// of these numbers -- including what happens when a base cost changes -- is
// asserted in tests/guestDefaultModels.test.ts; here they are the fixed
// expectation the UI has to meet.
const GUEST_MODEL_COUNT = 3;
const GUEST_CREDITS = 3;
const GUEST_SEND_LABEL = `Send · ${GUEST_CREDITS} credits`;
const GUEST_ENTRY = "/chat?lang=en&entry=guest-preview";

type FirstPaintSample = {
  modelCount: number | null;
  estimatedCredits: number | null;
  sendLabel: string | null;
  panelCount: number;
  modelTabCount: number;
};

declare global {
  interface Window {
    __firstPaintHistory?: FirstPaintSample[];
  }
}

async function installFirstPaintRecorder(page: Page) {
  await page.addInitScript(() => {
    const history: FirstPaintSample[] = [];
    window.__firstPaintHistory = history;

    const numberFrom = (text: string | null | undefined, pattern: RegExp) => {
      const match = typeof text === "string" ? text.match(pattern) : null;
      return match ? Number(match[1]) : null;
    };

    const sample = () => {
      const modelButton = document.querySelector(
        'button[aria-label="Choose AI models"]'
      );
      const estimate = document.querySelector(
        '[data-testid="request-credit-estimate"]'
      );
      const sendButton = document.querySelector(
        '[data-testid="chat-send-button"]'
      );

      // The button also renders a count badge, so its combined textContent
      // reads "33 AIs" for three models. Read the label span on its own.
      const modelCountLabel = Array.from(
        modelButton?.querySelectorAll("span") ?? []
      ).find((node) => /^\d+\s+AIs?$/.test(node.textContent?.trim() ?? ""));

      const entry: FirstPaintSample = {
        modelCount: numberFrom(modelCountLabel?.textContent?.trim(), /^(\d+)\s+AIs?$/),
        estimatedCredits: numberFrom(
          estimate?.getAttribute("aria-label"),
          /Estimated\s+(\d+)\s+credits/
        ),
        sendLabel: sendButton?.getAttribute("aria-label") ?? null,
        panelCount: document.querySelectorAll(
          '[data-testid="desktop-model-panel"]'
        ).length,
        modelTabCount: document.querySelectorAll(
          '[data-testid="mobile-model-tab"]'
        ).length,
      };

      // Nothing of the composer on screen yet (skeleton, or a chunk that has
      // not been parsed). Not a state worth recording -- an absent number is
      // never a wrong number.
      if (
        entry.modelCount === null &&
        entry.estimatedCredits === null &&
        entry.sendLabel === null &&
        entry.panelCount === 0 &&
        entry.modelTabCount === 0
      ) {
        return;
      }

      const previous = history[history.length - 1];
      if (
        previous &&
        previous.modelCount === entry.modelCount &&
        previous.estimatedCredits === entry.estimatedCredits &&
        previous.sendLabel === entry.sendLabel &&
        previous.panelCount === entry.panelCount &&
        previous.modelTabCount === entry.modelTabCount
      ) {
        return;
      }
      history.push(entry);
    };

    // Observes `document`, not `documentElement`: this script runs before the
    // page has parsed anything, so there is no root element to attach to yet.
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });

    // MutationObserver delivers batched records, so a value that appeared and
    // was replaced within one batch would be invisible to it. Sampling every
    // frame as well catches those, and costs nothing once the page settles.
    const tick = () => {
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    sample();
  });
}

const readHistory = (page: Page) =>
  page.evaluate(() => window.__firstPaintHistory ?? []);

/**
 * The value history of one field, with absent values dropped and consecutive
 * repeats collapsed. Absent is never wrong -- only a *different* number is --
 * and the recorder samples every field together, so an unrelated field
 * changing must not look like this one changed.
 */
function distinctValues<T>(values: Array<T | null>): T[] {
  const present = values.filter((value): value is T => value !== null);
  return present.filter(
    (value, index) => index === 0 || value !== present[index - 1]
  );
}

const creditsHistory = (history: FirstPaintSample[]) =>
  distinctValues(history.map((entry) => entry.estimatedCredits));
const modelCountHistory = (history: FirstPaintSample[]) =>
  distinctValues(history.map((entry) => entry.modelCount));
const sendLabelHistory = (history: FirstPaintSample[]) =>
  distinctValues(history.map((entry) => entry.sendLabel));

/**
 * Waits until the composer is on screen and the recorder has gone two
 * consecutive polls without seeing a new value -- i.e. every correction the
 * page was going to make has already happened.
 */
async function settleComposer(page: Page) {
  await expect(page.getByTestId("request-credit-estimate")).toBeVisible();
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = JSON.stringify(await readHistory(page));
        const unchanged = current === previous;
        previous = current;
        return unchanged;
      },
      { timeout: 15_000, intervals: [400, 400, 600, 600, 1_000] }
    )
    .toBe(true);
}

function collectHydrationConsoleErrors(page: Page) {
  const hydrationMessages: string[] = [];
  const otherMessages: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    if (
      /hydrat/i.test(text) ||
      /did not match/i.test(text) ||
      /server rendered HTML/i.test(text) ||
      /text content does not match/i.test(text)
    ) {
      hydrationMessages.push(text);
      return;
    }
    otherMessages.push(text);
  });

  return { hydrationMessages, otherMessages };
}

function expectStableGuestDefault(history: FirstPaintSample[]) {
  expect(history.length).toBeGreaterThan(0);
  expect(modelCountHistory(history)).toEqual([GUEST_MODEL_COUNT]);
  expect(creditsHistory(history)).toEqual([GUEST_CREDITS]);
  expect(sendLabelHistory(history)).toEqual([GUEST_SEND_LABEL]);
}

/** Seeds a guest conversation this tab will restore on load. */
async function seedGuestConversation(page: Page, selectedModels: string[]) {
  await page.addInitScript(
    ({ models }) => {
      const conversation = {
        id: "guest_seeded",
        title: "Seeded guest chat",
        selectedModels: models,
        disabledPanels: [],
        webSearchMode: "off",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      localStorage.setItem("guest_conversations", JSON.stringify([conversation]));
      localStorage.setItem(
        `guest_messages_${conversation.id}_${models[0]}`,
        JSON.stringify([
          { id: "m1", role: "user", content: "seeded", status: "normal" },
          { id: "m2", role: "assistant", content: "seeded reply", status: "normal" },
        ])
      );
      sessionStorage.setItem("tomverse_active_chat_id", conversation.id);
    },
    { models: selectedModels }
  );
}

test.describe("guest initial cost hydration", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await installFirstPaintRecorder(page);
  });

  test("a new guest is never shown a price other than the brand trio's", async ({
    page,
  }) => {
    const consoleMessages = collectHydrationConsoleErrors(page);

    await page.goto(GUEST_ENTRY);
    await settleComposer(page);

    const history = await readHistory(page);
    expectStableGuestDefault(history);

    // Panels/tabs come from the same state as the price, so they must have
    // been at three for exactly as long.
    const panelCounts = new Set(history.map((entry) => entry.panelCount));
    const tabCounts = new Set(history.map((entry) => entry.modelTabCount));
    expect([...panelCounts].every((count) => count === 0 || count === GUEST_MODEL_COUNT)).toBe(true);
    expect([...tabCounts].every((count) => count === 0 || count === GUEST_MODEL_COUNT)).toBe(true);

    // The visible number and the accessible name are the same value.
    await expect(page.getByTestId("request-credit-estimate")).toHaveAttribute(
      "aria-label",
      `Estimated ${GUEST_CREDITS} credits, view breakdown`
    );
    await expect(page.getByTestId("chat-send-button")).toHaveAttribute(
      "aria-label",
      GUEST_SEND_LABEL
    );

    // Only hydration diagnostics are asserted on: unrelated console noise
    // this page already produces is collected separately so a pre-existing
    // warning can never be mistaken for a hydration mismatch.
    expect(consoleMessages.hydrationMessages).toEqual([]);
  });

  test("plain /chat applies the same guest default as the preview entry", async ({
    page,
  }) => {
    await page.goto("/chat?lang=en");
    await settleComposer(page);

    expectStableGuestDefault(await readHistory(page));
  });

  test("the model count and price never depend on the viewport", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "Emulated touch devices have a fixed viewport; the widths are swept on the desktop projects, which cross the mobile shell breakpoint at 320-767px anyway."
    );
    test.slow();

    // The defect was reported at 320px, but the model count and price come
    // from state that no media query touches -- so every width has to agree.
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 360, height: 640 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      // Each navigation gets a fresh recorder, so the history is per width.
      await page.goto(GUEST_ENTRY);
      await settleComposer(page);

      const history = await readHistory(page);
      const label = `${viewport.width}x${viewport.height}`;
      expect(creditsHistory(history), label).toEqual([GUEST_CREDITS]);
      expect(modelCountHistory(history), label).toEqual([GUEST_MODEL_COUNT]);
    }
  });

  test("the server sends no price at all rather than a wrong one", async ({
    page,
  }) => {
    const response = await page.request.get(GUEST_ENTRY);
    expect(response.ok()).toBe(true);
    const html = await response.text();

    // The chat shell picks between the mobile and desktop layouts from a
    // media query, so the server renders a numberless skeleton and the first
    // product frame is the hydration commit (asserted by the recorder tests
    // above). What matters here is that no wrong price is ever served.
    expect(html).toContain("chat-shell-skeleton");
    expect(html).not.toMatch(/Estimated\s+\d+\s+credits/);
    expect(html).not.toMatch(/Send\s+·\s+\d+\s+credits/);

    // The guest default's lead model is resolved on the server and shipped in
    // the initial payload -- that is what lets the client's first render know
    // the trio without a request of its own.
    expect(html).toContain("guestDefaultModelId");

    // And it is settled without the client ever asking for it.
    const appSettingsRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/app-settings")) {
        appSettingsRequests.push(request.url());
      }
    });
    await page.goto(GUEST_ENTRY);
    await settleComposer(page);
    expect(appSettingsRequests).toEqual([]);
  });

  test("a slow model catalogue never produces an interim price", async ({
    page,
  }) => {
    // The catalogue the composer prices against is already in the initial
    // payload; this refresh only revalidates it. Delaying it must not move
    // any number.
    await page.route("**/api/models/catalog**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.route("**/api/user/guest-usage**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue();
    });

    await page.goto(GUEST_ENTRY);
    await settleComposer(page);

    expectStableGuestDefault(await readHistory(page));
  });

  test("a failing model catalogue never produces an interim price", async ({
    page,
  }) => {
    await page.route("**/api/models/catalog**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Model catalog unavailable." }),
      })
    );

    await page.goto(GUEST_ENTRY);
    await settleComposer(page);

    expectStableGuestDefault(await readHistory(page));
  });

  for (const size of [1, 2, 3]) {
    test(`a saved ${size}-model guest conversation is priced correctly from the first frame`, async ({
      page,
    }) => {
      const saved = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"].slice(
        0,
        size
      );
      await seedGuestConversation(page, saved);

      await page.goto(GUEST_ENTRY);
      await settleComposer(page);

      const history = await readHistory(page);
      expect(modelCountHistory(history)).toEqual([size]);
      expect(creditsHistory(history)).toEqual([size]);
      expect(sendLabelHistory(history)).toEqual([`Send · ${size} credits`]);
    });
  }

  test("a saved conversation naming retired models falls back without a price flicker", async ({
    page,
  }) => {
    await seedGuestConversation(page, ["retired-model-id", "another-retired-id"]);

    await page.goto(GUEST_ENTRY);
    await settleComposer(page);

    expectStableGuestDefault(await readHistory(page));
  });

  test("an explicit ?models= link is priced from its own selection only", async ({
    page,
  }) => {
    await page.goto("/chat?lang=en&models=gpt-5-4-mini,claude-haiku-4-5");
    await settleComposer(page);

    const history = await readHistory(page);
    expect(modelCountHistory(history)).toEqual([2]);
    expect(creditsHistory(history)).toEqual([2]);
  });

  test("changing the selection re-prices immediately and consistently", async ({
    page,
  }) => {
    await page.goto(GUEST_ENTRY);
    await settleComposer(page);

    const estimate = page.getByTestId("request-credit-estimate");
    const sendButton = page.getByTestId("chat-send-button");
    const modelMenu = page.getByRole("button", { name: "Choose AI models" });

    await modelMenu.click();
    const dialog = page.locator("#chat-input-popover");
    await expect(dialog).toBeVisible();
    // STG-F008: the picker opens on recommendations; deselecting a specific
    // model by id means stepping into the full catalogue first.
    await openModelCatalogue(page);

    const removed = "claude-haiku-4-5";
    const option = dialog.locator(
      `[data-testid="model-option"][data-model-id="${removed}"]`
    );
    await expect(option).toBeVisible();

    await option.click();
    await expect(estimate).toHaveAttribute(
      "aria-label",
      `Estimated ${GUEST_CREDITS - 1} credits, view breakdown`
    );
    await expect(sendButton).toHaveAttribute(
      "aria-label",
      `Send · ${GUEST_CREDITS - 1} credits`
    );

    await option.click();
    await expect(estimate).toHaveAttribute(
      "aria-label",
      `Estimated ${GUEST_CREDITS} credits, view breakdown`
    );
    await expect(sendButton).toHaveAttribute("aria-label", GUEST_SEND_LABEL);

    // Sanity check on the recorder itself: it has to be able to see a price
    // change, otherwise the "history is a single value" assertions in the
    // other tests would pass vacuously.
    expect(creditsHistory(await readHistory(page))).toEqual([
      GUEST_CREDITS,
      GUEST_CREDITS - 1,
      GUEST_CREDITS,
    ]);

    // Escape is layered in the two-step picker: the first press leaves the
    // catalogue for the recommendations, the second closes the dialog.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(modelMenu).toContainText(`${GUEST_MODEL_COUNT} AIs`);

    // The breakdown sheet is derived from the same selection, so its rows
    // have to sum to exactly what the composer and the Send button quote.
    await estimate.click();
    const usageDialog = page.getByRole("dialog", { name: "Estimated usage" });
    await expect(usageDialog).toBeVisible();

    const badges = usageDialog.getByTestId("credit-cost-badge");
    await expect(badges).toHaveCount(GUEST_MODEL_COUNT + 1);
    const values = (await badges.allInnerTexts()).map((text) =>
      Number(text.trim())
    );
    const rowTotal = values
      .slice(0, GUEST_MODEL_COUNT)
      .reduce((sum, value) => sum + value, 0);
    expect(rowTotal).toBe(GUEST_CREDITS);
    expect(values[values.length - 1]).toBe(GUEST_CREDITS);
  });
});
