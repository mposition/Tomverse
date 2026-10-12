import { expect, test, type Page } from "@playwright/test";
import { GUEST_BRAND_TRIO_MODEL_IDS } from "@/lib/appDefaults";
import {
  openModelCatalogue,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

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
// A new conversation starts with web search on (APP_DEFAULTS), and every trio
// model can search, so each one's reservation carries the web search surcharge
// on top of its 1-credit base.
const WEB_SEARCH_SURCHARGE = 8;
const SEARCHING_MODEL_CREDITS = 1 + WEB_SEARCH_SURCHARGE;
const GUEST_CREDITS = GUEST_MODEL_COUNT * SEARCHING_MODEL_CREDITS;
const GUEST_CHAT_MODEL_COUNT = 1;
const GUEST_CHAT_CREDITS = SEARCHING_MODEL_CREDITS;
// The same trio in a restored conversation whose switch is off.
const GUEST_CREDITS_SEARCH_OFF = GUEST_MODEL_COUNT;
const GUEST_SEND_LABEL = `Send · ${GUEST_CREDITS} credits`;
const GUEST_ENTRY = "/review?lang=en&entry=guest-preview";

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

function expectStableGuestDefault(
  history: FirstPaintSample[],
  credits: number = GUEST_CREDITS,
  modelCount: number = GUEST_MODEL_COUNT
) {
  expect(history.length).toBeGreaterThan(0);
  expect(modelCountHistory(history)).toEqual([modelCount]);
  expect(creditsHistory(history)).toEqual([credits]);
  expect(sendLabelHistory(history)).toEqual([`Send · ${credits} credits`]);
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

async function seedSavedGuestAuto(page: Page) {
  await page.addInitScript((models) => {
    const id = "guest_chat_lifecycle_saved";
    localStorage.setItem("guest_chat_conversations", JSON.stringify([{
      id, title: "Saved Auto lifecycle", selectedModels: [models[0]],
      disabledPanels: [], selectionMode: "auto", webSearchMode: "off",
      createdAt: "2026-10-12T00:00:00.000Z",
    }]));
    localStorage.setItem("guest_messages_" + id + "_" + models[0], JSON.stringify([
      { id: "lifecycle-question", role: "user", content: "saved lifecycle question", status: "normal" },
      { id: "lifecycle-answer", role: "assistant", content: "saved lifecycle answer", status: "normal" },
    ]));
    sessionStorage.setItem("tomverse_chat_active_chat_id", id);
  }, GUEST_BRAND_TRIO_MODEL_IDS);
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

  test("plain /chat starts the guest Chat trial on exactly one model", async ({
    page,
  }) => {
    await page.goto("/chat?lang=en");
    await settleComposer(page);

    expectStableGuestDefault(
      await readHistory(page),
      GUEST_CHAT_CREDITS,
      GUEST_CHAT_MODEL_COUNT
    );
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveCount(0);
    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
  });

  test("guest Chat sends once, restores locally, and never rewrites Review history", async ({
    page,
  }, testInfo) => {
    const prompt = "guest Chat keeps its own local history";
    const answer = "single guest Chat answer";
    const chosenModel = "claude-haiku-4-5";
    const requests: Array<Record<string, unknown>> = [];
    const accountOnlyRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/api/chat/prompt-refiner/") ||
        request.url().includes("/api/conversations")
      ) {
        accountOnlyRequests.push(request.url());
      }
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-guest-chat-single" },
        body: answer,
      });
    });

    await page.goto("/chat?lang=en");
    await settleComposer(page);
    const modelCatalogue = await openModelCatalogue(page);
    await modelCatalogue.locator(
      `[data-testid="model-option"][data-model-id="${chosenModel}"]`
    ).click();
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem("guest_chat_conversations");
      const rows = raw ? JSON.parse(raw) : [];
      return rows[0]?.selectedModels ?? [];
    })).toEqual([chosenModel]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.reload();
    await settleComposer(page);
    const restoredCatalogue = await openModelCatalogue(page);
    await expect(restoredCatalogue.locator(
      `[data-testid="model-option"][data-model-id="${chosenModel}"]`
    )).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.evaluate((reviewModels) => {
      const review = {
        id: "guest_review_preserved",
        title: "Review history must survive",
        selectedModels: reviewModels,
        disabledPanels: [],
        webSearchMode: "off",
        createdAt: "2026-10-12T00:00:00.000Z",
      };
      localStorage.setItem("guest_conversations", JSON.stringify([review]));
      sessionStorage.setItem("tomverse_active_chat_id", review.id);
    }, GUEST_BRAND_TRIO_MODEL_IDS);
    const reviewBefore = await page.evaluate(() => ({
      conversations: localStorage.getItem("guest_conversations"),
      activeId: sessionStorage.getItem("tomverse_active_chat_id"),
    }));

    await sendChatMessage(page, testInfo, prompt);
    await expect(page.getByText(prompt).first()).toBeVisible();
    await expect(page.getByText(answer).first()).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    expect(accountOnlyRequests).toEqual([]);

    expect(requests[0]?.modelId).toBe(chosenModel);
    expect(requests[0]?.conversationId).toBeUndefined();
    expect(requests[0]?.assistantMessageId).toBeUndefined();
    expect(requests[0]?.sourceUserMessageId).toBeUndefined();
    expect(requests[0]?.promptRefinerDecision).toBeUndefined();
    expect(
      (requests[0]?.messages as Array<{ role?: string; content?: string }> | undefined)
        ?.filter((message) => message.role === "user" && message.content === prompt)
    ).toHaveLength(1);

    const readGuestChatState = () => page.evaluate(() => {
      const activeId = sessionStorage.getItem("tomverse_chat_active_chat_id");
      const raw = localStorage.getItem("guest_chat_conversations");
      const conversations = raw ? JSON.parse(raw) : [];
      const transcriptKeys = Array.from(
        { length: localStorage.length },
        (_, index) => localStorage.key(index)
      ).filter((key): key is string =>
        Boolean(key && activeId && key.startsWith(`guest_messages_${activeId}_`))
      );
      return {
        activeId,
        conversations,
        transcriptKeys,
        transcripts: transcriptKeys.map((key) => localStorage.getItem(key)),
        reviewConversations: localStorage.getItem("guest_conversations"),
        reviewActiveId: sessionStorage.getItem("tomverse_active_chat_id"),
      };
    });
    await expect.poll(readGuestChatState).toMatchObject({
      activeId: expect.stringMatching(/^guest_chat_/),
      conversations: [
        expect.objectContaining({
          id: expect.stringMatching(/^guest_chat_/),
          selectedModels: [chosenModel],
        }),
      ],
      transcriptKeys: expect.arrayContaining([
        expect.stringMatching(new RegExp(`^guest_messages_guest_chat_.*_${chosenModel}$`)),
      ]),
      reviewConversations: reviewBefore.conversations,
      reviewActiveId: reviewBefore.activeId,
    });
    const guestChatState = await readGuestChatState();
    // A model changed before Send may leave its welcome-only panel key behind.
    // Verify one answered transcript, rather than deleting preserved history.
    const nonemptyTranscripts = guestChatState.transcripts.map((raw) =>
      (JSON.parse(raw ?? "[]") as Array<{ id: string; role: string; content: string }>)
        .filter((message) => message.id !== "welcome")
    ).filter((messages) => messages.length > 0);
    expect(nonemptyTranscripts).toHaveLength(1);
    expect(nonemptyTranscripts[0]).toHaveLength(2);
    expect(nonemptyTranscripts[0].filter((message) =>
      message.role === "user" && message.content === prompt
    )).toHaveLength(1);
    expect(nonemptyTranscripts[0].filter((message) =>
      message.role === "assistant" && message.content === answer
    )).toHaveLength(1);

    await page.reload();
    await expect(page.getByText(prompt).first()).toBeVisible();
    await expect(page.getByText(answer).first()).toBeVisible();
    expect(requests).toHaveLength(1);

    await page.goto("/review?lang=en");
    await settleComposer(page);
    await expect(page.getByText("3 AIs", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({
      conversations: localStorage.getItem("guest_conversations"),
      activeId: sessionStorage.getItem("tomverse_active_chat_id"),
      chatConversations: localStorage.getItem("guest_chat_conversations"),
      chatActiveId: sessionStorage.getItem("tomverse_chat_active_chat_id"),
    }))).toMatchObject({
      conversations: reviewBefore.conversations,
      activeId: reviewBefore.activeId,
      chatConversations: expect.any(String),
      chatActiveId: expect.stringMatching(/^guest_chat_/),
    });
  });

  test("Guest Smart Adaptive is offered before the first turn and sends one original question", async ({
    page,
  }, testInfo) => {
    // An opaque browser transport fixture: signature verification and actual
    // Refiner/Router/ledger execution are exercised by server contracts.
    const authority = "qa-guest-auto-transport-only";
    const prompt = "Guest Smart Adaptive keeps the authored question";
    const answer = "one routed Guest answer";
    const requests: Array<Record<string, unknown>> = [];
    const accountWrites: string[] = [];
    let capabilityReads = 0;
    await page.route("**/api/products/chat/capabilities", async (route) => {
      capabilityReads += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          autoSelection: { offered: true },
          guestAutoCapability: authority,
          guestAuto: { attachmentSupport: "manual_only" },
        }),
      });
    });
    page.on("request", (request) => {
      if (request.method() !== "GET" &&
          /\/api\/(conversations|chat\/prompt-refiner\/)/.test(request.url())) {
        accountWrites.push(request.url());
      }
    });
    await page.route("**/api/chat", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: {
          "X-Request-ID": "qa-guest-auto-once",
          "X-Chat-Routed-Model": "claude-haiku-4-5",
        },
        body: answer,
      });
    });

    await page.goto("/chat?lang=en");
    const toggle = page.getByTestId("composer-auto-routing-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("composer-active-model-count"))
      .toHaveText("Smart Adaptive");
    await expect(page.getByTestId("request-credit-estimate")).toHaveCount(0);
    await page.getByRole("button", { name: "Choose AI models" }).click();
    const dialog = page.locator("#chat-input-popover");
    await expect(dialog.getByTestId("auto-routing-toggle").getByRole("switch"))
      .toHaveAttribute("aria-checked", "true");
    // The remembered manual return preference may remain visible, but it
    // must not claim to be Auto's selected answer model.
    await expect(dialog.getByText("Manual return model", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Used after Smart Adaptive is turned off.", { exact: true }))
      .toBeVisible();
    await expect(dialog.locator('[data-testid="recommended-model-option"][aria-pressed="true"]'))
      .toHaveCount(0);
    await page.keyboard.press("Escape");

    await sendChatMessage(page, testInfo, prompt);
    await expect(page.getByText(answer, { exact: true }).first()).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(capabilityReads).toBeGreaterThanOrEqual(2);
    expect(accountWrites).toEqual([]);
    expect(requests[0]).toMatchObject({
      guestAutoCapability: authority,
      guestClientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(requests[0].conversationId).toBeUndefined();
    expect(requests[0].promptRefinerDecision).toBeUndefined();
    expect((requests[0].messages as Array<{ role: string; content: string }>)
      .filter((message) => message.role === "user" && message.content === prompt))
      .toHaveLength(1);
    const persisted = await page.evaluate(() => Object.values(localStorage).join("\n"));
    expect(persisted).not.toContain(authority);
    await page.reload();
    await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(answer, { exact: true }).first()).toBeVisible();
    expect(requests).toHaveLength(1);
  });

  test("restored Guest Auto waits for a fresh capability instead of sending manually", async ({
    page,
  }, testInfo) => {
    const prompt = "restored Guest Auto must keep its execution mode";
    const authority = "qa-restored-guest-auto-fresh-capability";
    const requests: Array<Record<string, unknown>> = [];
    let capabilityReads = 0;
    let capabilityReleased = false;
    let releaseCapability!: () => void;
    const capabilityGate = new Promise<void>((resolve) => { releaseCapability = resolve; });
    await page.addInitScript((models) => {
      const id = "guest_chat_auto_saved";
      const conversation = {
        id,
        title: "Saved Smart Adaptive conversation",
        selectedModels: [models[0]],
        disabledPanels: [],
        selectionMode: "auto",
        webSearchMode: "off",
        createdAt: "2026-10-12T00:00:00.000Z",
      };
      localStorage.setItem("guest_chat_conversations", JSON.stringify([conversation]));
      localStorage.setItem("guest_messages_" + id + "_" + models[0], JSON.stringify([
        { id: "restored-question", role: "user", content: "saved original question", status: "normal" },
        { id: "restored-answer", role: "assistant", content: "saved original answer", status: "normal" },
      ]));
      sessionStorage.setItem("tomverse_chat_active_chat_id", id);
    }, GUEST_BRAND_TRIO_MODEL_IDS);
    await page.route("**/api/products/chat/capabilities", async (route) => {
      capabilityReads += 1;
      await capabilityGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          autoSelection: { offered: true },
          guestAutoCapability: authority,
          guestAuto: { attachmentSupport: "manual_only" },
        }),
      }).catch(() => {});
    });
    await page.route("**/api/chat", async (route) => {
      requests.push({
        ...route.request().postDataJSON() as Record<string, unknown>,
        observedBeforeCapability: !capabilityReleased,
      });
      await route.fulfill({ status: 200, contentType: "text/plain", body: "fresh Auto reply" });
    });
    try {
      await page.goto("/chat?lang=en");
      await expect(page.getByText("saved original question", { exact: true }).first()).toBeVisible();
      await expect.poll(() => capabilityReads).toBeGreaterThan(0);
      const textarea = page.getByTestId("chat-textarea");
      await expect(textarea).not.toBeEditable();
      await expect(page.getByTestId("guest-auto-capability-pending")).toBeVisible();
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      await textarea.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      expect(requests).toEqual([]);
      expect(await page.evaluate(() => JSON.parse(
        localStorage.getItem("guest_chat_conversations") ?? "[]"
      )[0]?.selectionMode)).toBe("auto");
      capabilityReleased = true;
      releaseCapability();
      const toggle = page.getByTestId("composer-auto-routing-toggle");
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      // Pending input was locked, so only this explicit action may dispatch.
      expect(requests).toEqual([]);
      await sendChatMessage(page, testInfo, prompt);
      await expect(page.getByText("fresh Auto reply", { exact: true }).first()).toBeVisible();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        guestAutoCapability: authority,
        guestClientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        observedBeforeCapability: false,
      });
      expect((requests[0].messages as Array<{ role: string; content: string }>)
        .filter((message) => message.role === "user" && message.content === prompt))
        .toHaveLength(1);
      expect(await page.evaluate(() => Object.values(localStorage).join("\n")))
        .not.toContain(authority);
    } finally {
      capabilityReleased = true;
      releaseCapability();
    }
  });

  test("Guest Auto OFF then ON renews authority and sends exactly once", async ({ page }, testInfo) => {
    const authority = "qa-guest-auto-toggle-renewed";
    const requests: Array<Record<string, unknown>> = [];
    await page.route("**/api/products/chat/capabilities", (route) => route.fulfill({
      json: { autoSelection: { offered: true }, guestAutoCapability: authority,
        guestAuto: { attachmentSupport: "manual_only" } },
    }));
    await page.route("**/api/chat", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, body: "renewed Auto answer" });
    });
    await page.goto("/chat?lang=en");
    const toggle = page.getByTestId("composer-auto-routing-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("chat-textarea")).toBeEditable();
    await sendChatMessage(page, testInfo, "one Guest Auto turn after OFF and ON");
    await expect(page.getByText("renewed Auto answer", { exact: true }).first()).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      guestAutoCapability: authority,
      guestClientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test("reselecting the current Guest Auto conversation preserves its ready draft", async ({ page }, testInfo) => {
    const authority = "qa-current-guest-auto-capability";
    const prompt = "current Auto conversation still sends";
    const requests: Array<Record<string, unknown>> = [];
    await seedSavedGuestAuto(page);
    await page.route("**/api/products/chat/capabilities", (route) => route.fulfill({
      json: { autoSelection: { offered: true }, guestAutoCapability: authority,
        guestAuto: { attachmentSupport: "manual_only" } },
    }));
    await page.route("**/api/chat", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, body: "current Auto answer" });
    });
    await page.goto("/chat?lang=en");
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeEditable();
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveAttribute("aria-checked", "true");
    await textarea.fill(prompt);
    const mobileMenu = page.getByTestId("mobile-sidebar-open");
    if (await mobileMenu.isVisible()) await mobileMenu.click();
    await page.locator('[data-testid="sidebar-conversation-item"][data-conversation-id="guest_chat_lifecycle_saved"]').click();
    await expect(textarea).toBeEditable();
    await expect(textarea).toHaveValue(prompt);
    await expect(page.getByTestId("guest-auto-capability-pending")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("tomverse_chat_active_chat_id")))
      .toBe("guest_chat_lifecycle_saved");
    await sendChatMessage(page, testInfo, prompt);
    await expect(page.getByText("current Auto answer", { exact: true }).first()).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ guestAutoCapability: authority,
      guestClientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  test("Guest Auto recovers from a failed pre-send capability read without manual dispatch", async ({ page }, testInfo) => {
    const authority = "qa-guest-auto-capability-recovered";
    const prompt = "recover the authority before this Auto turn";
    const requests: Array<Record<string, unknown>> = [];
    let reads = 0;
    await page.route("**/api/products/chat/capabilities", async (route) => {
      reads += 1;
      if (reads === 2) { await route.abort("connectionreset"); return; }
      await route.fulfill({ json: { autoSelection: { offered: true }, guestAutoCapability: authority,
        guestAuto: { attachmentSupport: "manual_only" } } });
    });
    await page.route("**/api/chat", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, body: "recovered Auto answer" });
    });
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveAttribute("aria-checked", "true");
    await sendChatMessage(page, testInfo, prompt);
    await expect(page.getByTestId("app-toast").filter({ hasText: "That Auto setting could not be saved." })).toBeVisible();
    expect(requests).toEqual([]);
    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toHaveValue(prompt);
    await expect(textarea).toBeEditable();
    await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveAttribute("aria-checked", "true");
    // This is an explicit retry of a read-only authority check; the failed
    // attempt dispatched no Chat request, reservation or provider call.
    await sendChatMessage(page, testInfo, prompt);
    await expect(page.getByText("recovered Auto answer", { exact: true }).first()).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ guestAutoCapability: authority,
      guestClientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  test("a Guest can explicitly leave Auto while the capability read remains hung", async ({ page }, testInfo) => {
    const requests: Array<Record<string, unknown>> = [];
    let releaseCapability!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCapability = resolve; });
    await seedSavedGuestAuto(page);
    await page.route("**/api/products/chat/capabilities", async (route) => {
      await gate;
      await route.fulfill({ json: { autoSelection: { offered: true },
        guestAutoCapability: "qa-hung-late-authority", guestAuto: { attachmentSupport: "manual_only" } } }).catch(() => {});
    });
    await page.route("**/api/chat", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, body: "explicit manual answer" });
    });
    try {
      await page.goto("/chat?lang=en");
      await expect(page.getByTestId("guest-auto-capability-pending")).toBeVisible();
      await expect(page.getByTestId("chat-textarea")).not.toBeEditable();
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      const dialog = await openModelCatalogue(page);
      await dialog.locator('[data-testid="model-option"][data-model-id="' + GUEST_BRAND_TRIO_MODEL_IDS[0] + '"]').click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chat-textarea")).toBeEditable();
      await sendChatMessage(page, testInfo, "explicitly choose a manual Guest turn");
      await expect(page.getByText("explicit manual answer", { exact: true }).first()).toBeVisible();
      expect(requests).toHaveLength(1);
      expect(requests[0].guestAutoCapability).toBeUndefined();
      expect(requests[0].guestClientTurnId).toBeUndefined();
      releaseCapability();
      await expect(page.getByTestId("composer-auto-routing-toggle")).toHaveAttribute("aria-checked", "false");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("guest_chat_conversations") ?? "[]")
        .find((row: { id: string; selectionMode?: string }) => row.id === "guest_chat_lifecycle_saved")?.selectionMode))
        .toBe("manual");
      expect(requests).toHaveLength(1);
    } finally { releaseCapability(); }
  });

  test("Guest Auto manual choice survives a local conversation reload", async ({ page }) => {
    await page.route("**/api/products/chat/capabilities", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          autoSelection: { offered: true },
          guestAutoCapability: "qa-guest-auto-mode-transport-only",
          guestAuto: { attachmentSupport: "manual_only" },
        }),
      })
    );
    await page.goto("/chat?lang=en");
    const toggle = page.getByTestId("composer-auto-routing-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const activeId = await page.evaluate(() =>
      sessionStorage.getItem("tomverse_chat_active_chat_id")
    );
    expect(activeId).toMatch(/^guest_chat_/);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("request-credit-estimate")).toBeVisible();
    expect(await page.evaluate(() =>
      sessionStorage.getItem("tomverse_chat_active_chat_id")
    )).toBe(activeId);
  });

  for (const failure of ["unknown_receipt", "lost_response"] as const) {
    test(`Guest Auto ${failure} does not offer prompt replay after reload`, async ({
      page,
    }, testInfo) => {
      const prompt = `Guest unknown turn ${failure}`;
      let sends = 0;
      await page.route("**/api/products/chat/capabilities", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            autoSelection: { offered: true },
            guestAutoCapability: "qa-guest-auto-unknown-transport-only",
            guestAuto: { attachmentSupport: "manual_only" },
          }),
        })
      );
      await page.route("**/api/chat", async (route) => {
        sends += 1;
        if (failure === "lost_response") {
          await route.abort("connectionreset");
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Guest Auto outcome is unknown; do not retry this turn.",
            code: "GUEST_AUTO_OUTCOME_UNKNOWN",
            details: { retryAuthorized: false, humanReviewRequired: true },
          }),
        });
      });
      await page.goto("/chat?lang=en");
      await expect(page.getByTestId("composer-auto-routing-toggle"))
        .toHaveAttribute("aria-checked", "true");
      await sendChatMessage(page, testInfo, prompt);
      await expect.poll(() => page.evaluate(() =>
        Object.values(localStorage).join("\n")
          .includes('"errorCode":"GUEST_AUTO_OUTCOME_UNKNOWN"')
      )).toBe(true);
      await expect(page.getByTestId("restore-chat-question")).toHaveCount(0);
      expect(sends).toBe(1);
      await page.reload();
      await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("restore-chat-question")).toHaveCount(0);
      expect(sends).toBe(1);
    });
  }

  test("Guest Auto reload during an unanswered POST preserves unknown and offers no replay", async ({
    page,
  }, testInfo) => {
    const prompt = "Guest Auto interrupted before its response arrived";
    let sends = 0;
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await page.route("**/api/products/chat/capabilities", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          autoSelection: { offered: true },
          guestAutoCapability: "qa-guest-auto-interrupted-transport-only",
          guestAuto: { attachmentSupport: "manual_only" },
        }),
      })
    );
    await page.route("**/api/chat", async (route) => {
      sends += 1;
      await responseGate;
      // Reload closes the original request. Its delayed response cannot
      // authorize a new attempt or replay on the newly mounted workspace.
      await route.fulfill({ status: 200, body: "late answer" }).catch(() => {});
    });
    try {
      await page.goto("/chat?lang=en");
      await expect(page.getByTestId("composer-auto-routing-toggle"))
        .toHaveAttribute("aria-checked", "true");
      await sendChatMessage(page, testInfo, prompt);
      await expect.poll(() => sends).toBe(1);
      await expect.poll(() => page.evaluate((question) =>
        Object.values(localStorage).join("\n").includes(question), prompt
      )).toBe(true);
      await page.reload();
      await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible();
      await expect.poll(() => page.evaluate(() =>
        Object.values(localStorage).join("\n")
          .includes('"errorCode":"GUEST_AUTO_OUTCOME_UNKNOWN"')
      )).toBe(true);
      await expect(page.getByTestId("restore-chat-question")).toHaveCount(0);
      expect(sends).toBe(1);
    } finally {
      releaseResponse();
    }
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

    // The models fall back to the trio; the conversation's own switch (off)
    // is kept from the first frame rather than priced as a new chat first.
    expectStableGuestDefault(await readHistory(page), GUEST_CREDITS_SEARCH_OFF);
  });

  test("an explicit ?models= link is priced from its own selection only", async ({
    page,
  }) => {
    await page.goto("/review?lang=en&models=gpt-5-4-mini,claude-haiku-4-5");
    await settleComposer(page);

    const history = await readHistory(page);
    expect(modelCountHistory(history)).toEqual([2]);
    // A new conversation, so search is on and both models can search.
    expect(creditsHistory(history)).toEqual([2 * SEARCHING_MODEL_CREDITS]);
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
      `Estimated ${GUEST_CREDITS - SEARCHING_MODEL_CREDITS} credits, view breakdown`
    );
    await expect(sendButton).toHaveAttribute(
      "aria-label",
      `Send · ${GUEST_CREDITS - SEARCHING_MODEL_CREDITS} credits`
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
      GUEST_CREDITS - SEARCHING_MODEL_CREDITS,
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

    // One row per model (each already including its search reservation),
    // the web search reservation broken out on its own, and the total. Search
    // is on for a new conversation, which is what adds the middle row.
    const badges = usageDialog.getByTestId("credit-cost-badge");
    await expect(badges).toHaveCount(GUEST_MODEL_COUNT + 2);
    const values = (await badges.allInnerTexts()).map((text) =>
      Number(text.trim())
    );
    const rowTotal = values
      .slice(0, GUEST_MODEL_COUNT)
      .reduce((sum, value) => sum + value, 0);
    expect(values[GUEST_MODEL_COUNT]).toBe(
      GUEST_MODEL_COUNT * WEB_SEARCH_SURCHARGE
    );
    expect(rowTotal).toBe(GUEST_CREDITS);
    expect(values[values.length - 1]).toBe(GUEST_CREDITS);
  });
});
