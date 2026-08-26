import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  openRecentConversation,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";

// Provider-native web search for webSearchMode === "always": selecting
// "always" must enable each selected model's own provider-native search tool
// (never swap in a Perplexity model), and the per-message badge/citations
// must reflect what actually happened that turn -- never a false "완료".
//
// The marker must match lib/webSearchStreamTrailer.ts exactly: the chat
// stream ends with one extra out-of-band chunk carrying this turn's
// WebSearchExecution JSON, which is how the client (and these mocks) deliver
// search status/citations without a second request -- the only path that
// also reaches guest sessions, whose messages are never persisted server-side.
const SEARCH_METADATA_MARKER = `${String.fromCharCode(0)}TOMVERSE_SEARCH_METADATA`;
const withSearchMetadata = (
  text: string,
  execution: Record<string, unknown>
) => `${text}${SEARCH_METADATA_MARKER}${JSON.stringify(execution)}`;

const toolsMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(0);

// Web search is one switch, flipped in place. The menu deliberately stays
// open afterwards (the row's own description and cost note are what change),
// so it is dismissed here rather than closing itself.
const setWebSearchModeAlways = async (page: Page) => {
  await toolsMenuTrigger(page).click();
  const toggle = page.getByTestId("tools-web-search-row");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
};

// GPT-5.6 Sol and Claude Sonnet 5 are Pro-tier; the default mocked plan is Free.
const asProPlan = async (page: Page) => {
  await page.unroute("**/api/user/usage**");
  await page.route("**/api/user/usage**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: "Pro",
        subscription: {
          status: "active",
          billingInterval: "monthly",
          currentPeriodEnd: "2099-01-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        usage: {
          creditsDay: 0,
          creditsMonth: 0,
          proModelResponsesMonth: 0,
          tokensDay: 0,
          tokensMonth: 0,
          costDay: 0,
          costMonth: 0,
        },
        balances: {
          dailyRemainingCredits: 300,
          dailyResetsAt: "2099-01-02T00:00:00.000Z",
          planRemainingCredits: 3000,
          planResetsAt: "2099-02-01T00:00:00.000Z",
          purchasedRemainingCredits: 0,
          purchasedFundedCostMicroUsd: 0,
          purchasedEarliestExpiry: null,
        },
        creditDebt: {
          credits: 0,
          fundedCostMicroUsd: 0,
          riskStatus: "clear",
          riskReason: null,
          riskAt: null,
        },
        recommendation: { primary: null, secondary: null },
        limits: {
          creditsDay: 300,
          creditsMonth: 3000,
          proModelResponsesMonth: 3000,
          tokensDay: 0,
          tokensMonth: 0,
          costDay: 0,
          costMonth: 0,
          maxModels: 3,
          allowAttachments: true,
          allowSharing: true,
          allowDownloads: true,
        },
      }),
    })
  );
};

// A fresh /chat never auto-opens a conversation as "current"; restoring one
// via sessionStorage (like an F5 reload) races against
// isInitialConversationResolved in a way that can leave the per-panel model
// <select> permanently disabled. The one path that resolves deterministically
// is the brand-new-account bootstrap (no conversations at all yet), which
// sets it directly -- so this forces the conversation list empty and picks
// the target models through the real model picker UI afterwards.
const seedFreshAccount = async (page: Page) => {
  // Deliberately not unrouted first: POST (creating the conversation on the
  // first send) must still fall through to mockAuthenticatedApi's own
  // handler, which is only reachable via .fallback() if that earlier
  // registration is left in place.
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
};

// A fresh account starts on the single compiled-in default model, which moved
// from gpt-5-4-mini to gpt-5-6-luna on 2026-08-01. toggleModel() refuses to
// drop the last remaining model, so the default can only be removed once at
// least one target is already selected -- add the first target, drop the
// default, then add the rest.
const COMPILED_IN_DEFAULT_MODEL_ID = "gpt-5-6-luna";

const selectModelsViaPicker = async (page: Page, models: string[]) => {
  // STG-F008: specific models are picked from the full catalogue, which is the
  // picker's second step.
  await openModelPickerCatalogue(page);
  const optionFor = (modelId: string) =>
    page.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`);
  await optionFor(models[0]).click();
  // Skipped when the default is itself one of the targets, so this never
  // deselects a model the caller asked for.
  if (!models.includes(COMPILED_IN_DEFAULT_MODEL_ID)) {
    await optionFor(COMPILED_IN_DEFAULT_MODEL_ID).click();
  }
  for (const modelId of models.slice(1)) {
    await optionFor(modelId).click();
  }
  // Escape only steps back one level in the two-step picker, so close via the
  // completion control -- the dialog's backdrop blocks the tools menu until it
  // is actually dismissed.
  await page.getByTestId("model-picker-done").click();
  await expect(page.locator("#chat-input-popover")).toBeHidden();
};

const assistantBadge = (page: Page, modelId: string) =>
  page
    .locator(
      `[data-testid="chat-message"][data-model-id="${modelId}"][data-message-role="assistant"]`
    )
    .last()
    .getByTestId("search-status-badge");

test.describe("native web search (webSearchMode: always)", () => {
  // These assert on the desktop-only per-panel <select>/tab layout and
  // multi-panel simultaneous sends; badge/citation rendering itself is
  // shell-agnostic (ChatMessageList.tsx) and already covered here on
  // desktop plus at the unit level in tests/webSearchExecutionNormalizer.test.mjs.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Multi-panel model selection and per-panel selects only render in the desktop chat shell."
    );
  });

  test("each dispatchable provider gets its own native tool, one that cannot be bounded is marked unsupported, and the model list is unchanged", async ({
    page,
  }, testInfo) => {
    // Three native providers, two of which a request may actually carry.
    // OpenAI's ceiling rides on the request (`max_tool_calls`) and
    // Anthropic's on the tool (`maxUses`); Google's grounding takes neither,
    // so its per-query cost has no worst case to reserve and no tool is
    // attached. That panel answers without a search and says so -- what it
    // must never do is claim one.
    const models = ["gpt-5-6-sol", "claude-sonnet-5", "gemini-3-6-flash"];
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await asProPlan(page);
    await seedFreshAccount(page);

    const requestedModelIds: string[] = [];
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as {
        modelId?: string;
        webSearchMode?: string;
      };
      const modelId = body.modelId || "";
      requestedModelIds.push(modelId);
      expect(body.webSearchMode).toBe("always");

      if (modelId === "gpt-5-6-sol") {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: { "X-Request-ID": "qa-trace-openai" },
          body: withSearchMetadata("The latest figure is 42.", {
            requested: true,
            supported: true,
            executed: true,
            provider: "openai",
            tool: "web_search",
            citations: [{ url: "https://example.com/openai-source", title: "OpenAI source" }],
          }),
        });
        return;
      }
      if (modelId === "claude-sonnet-5") {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: { "X-Request-ID": "qa-trace-anthropic" },
          body: withSearchMetadata("I can answer this without searching.", {
            requested: true,
            supported: true,
            executed: false,
            provider: "anthropic",
            tool: "web_search",
            citations: [],
          }),
        });
        return;
      }
      if (modelId === "gemini-3-6-flash") {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: { "X-Request-ID": "qa-trace-google" },
          // What the server now reports for a native capability nothing may
          // dispatch: the search was asked for and this model could not run
          // one. Not `supported: true, executed: false`, which would read as
          // "it could have and chose not to".
          body: withSearchMetadata("Falling back to a general answer.", {
            requested: true,
            supported: false,
            executed: false,
            provider: "google",
            citations: [],
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/chat");
    // The per-panel model <select> starts disabled with a transient default
    // until the initial conversation state resolves (see
    // chat-model-selection-readiness spec) -- wait for it before touching
    // the model picker, or a selection made too early can be discarded.
    await expect(page.locator('[data-testid="desktop-model-panel"] select').first()).toBeEnabled();
    await selectModelsViaPicker(page, models);
    await expect(page.locator('[data-testid="desktop-model-panel"] select')).toHaveCount(3);
    await setWebSearchModeAlways(page);
    await sendChatMessage(page, testInfo, "What's the latest figure?");

    // Each panel's search failing/declining must not block the others.
    await expect(page.getByText("The latest figure is 42.")).toBeVisible();
    await expect(page.getByText("I can answer this without searching.")).toBeVisible();
    await expect(page.getByText("Falling back to a general answer.")).toBeVisible();

    await expect(assistantBadge(page, "gpt-5-6-sol")).toHaveAttribute(
      "data-search-status",
      "executed"
    );
    await expect(assistantBadge(page, "claude-sonnet-5")).toHaveAttribute(
      "data-search-status",
      "requested-not-executed"
    );
    await expect(assistantBadge(page, "gemini-3-6-flash")).toHaveAttribute(
      "data-search-status",
      "unsupported"
    );

    // Citations only render for the panel that actually executed a search,
    // as a real, safe external link.
    const citationLink = page
      .locator('[data-testid="chat-message"][data-model-id="gpt-5-6-sol"]')
      .last()
      .getByTestId("search-citation-list")
      .getByRole("link");
    await expect(citationLink).toHaveAttribute("href", "https://example.com/openai-source");
    await expect(citationLink).toHaveAttribute("target", "_blank");
    await expect(citationLink).toHaveAttribute("rel", "noopener noreferrer");

    await expect(
      page
        .locator('[data-testid="chat-message"][data-model-id="claude-sonnet-5"]')
        .last()
        .getByTestId("search-citation-list")
    ).toHaveCount(0);

    // "always" must never add/swap in a Perplexity model -- the selection is
    // exactly what was requested, before and after sending.
    expect(requestedModelIds.sort()).toEqual([...models].sort());
    for (const modelId of models) {
      expect(requestedModelIds).toContain(modelId);
    }
  });

  test("off mode sends no webSearchMode and every panel reads as not searched", async ({
    page,
  }, testInfo) => {
    const models = ["gpt-5-5", "claude-sonnet-5"];
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await asProPlan(page);
    await seedFreshAccount(page);

    let sawWebSearchModeField = false;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { webSearchMode?: string };
      if (body.webSearchMode !== undefined) sawWebSearchModeField = true;
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-off" },
        body: withSearchMetadata("Plain answer, no search.", {
          requested: false,
          supported: true,
          executed: false,
          provider: "openai",
          citations: [],
        }),
      });
    });

    // Default webSearchMode is "off" -- no tools-menu interaction needed.
    await page.goto("/chat");
    await expect(page.locator('[data-testid="desktop-model-panel"] select').first()).toBeEnabled();
    await selectModelsViaPicker(page, models);
    await expect(page.locator('[data-testid="desktop-model-panel"] select')).toHaveCount(2);
    await sendChatMessage(page, testInfo, "Just a normal question");

    await expect(page.getByText("Plain answer, no search.").first()).toBeVisible();
    expect(sawWebSearchModeField).toBe(false);
    // The badge reports the search and stops there. It used to say "training
    // knowledge" here, which is a claim about the source of the answer that
    // nothing on this path checks -- see lib/webSearchStatusBadge.ts.
    await expect(assistantBadge(page, "gpt-5-5")).toHaveAttribute(
      "data-search-status",
      "not-searched"
    );
  });

  test("mixed supported/unsupported selection shows a compact partial-support chip and an unsupported badge", async ({
    page,
  }, testInfo) => {
    // The app's real guest default trio, so this also covers the guest code
    // path. Luna and Haiku both have a native search a request can bound;
    // Gemini 3.5 Flash-Lite's grounding takes no per-request ceiling, so
    // nothing may dispatch it and it is the panel that cannot search.
    const models = ["gpt-5-6-luna", "claude-haiku-4-5", "gemini-2-5-flash"];
    const CHAT_ID = "guest_native_search_mixed";
    await prepareGuestPage(page, "en");
    await page.addInitScript(
      ({ chatId, models }) => {
        const conversation = {
          id: chatId,
          title: "Native search test",
          selectedModels: models,
          disabledPanels: [],
          webSearchMode: "always",
          createdAt: new Date().toISOString(),
        };
        window.localStorage.setItem("guest_conversations", JSON.stringify([conversation]));
        for (const modelId of models) {
          window.localStorage.setItem(
            `guest_messages_${chatId}_${modelId}`,
            JSON.stringify([
              { id: "u0", role: "user", content: "Hello", status: "normal" },
              { id: "a0", role: "assistant", content: "Hi there.", status: "normal" },
            ])
          );
        }
      },
      { chatId: CHAT_ID, models }
    );

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { modelId?: string };
      const modelId = body.modelId || "";
      // Gemini cannot search on this turn at all; the other two can, and one
      // of them decided it did not need to. Three different answers to
      // "did this panel search", which is what the badges have to keep apart.
      const supported = modelId !== "gemini-2-5-flash";
      const executed = modelId === "gpt-5-6-luna";
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-mixed" },
        body: withSearchMetadata(
          executed ? "Searched and answered." : "Answered without search.",
          {
            requested: true,
            supported,
            executed,
            provider:
              modelId === "gpt-5-6-luna"
                ? "openai"
                : modelId === "claude-haiku-4-5"
                  ? "anthropic"
                  : "google",
            citations: [],
          }
        ),
      });
    });

    await page.goto("/chat?lang=en");
    await openRecentConversation(page, { title: "Native search test" });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);

    // The mixed selection is the exception case, so it -- and only it -- earns
    // a visible warning on the chip itself. There is no separate readiness
    // row any more, and tapping the chip names the models that cannot search.
    const chip = page.getByTestId("web-search-mode-chip");
    await expect(chip).toHaveAttribute("data-tone", "warning");
    await expect(chip).toContainText("2/3 supported");
    await expect(page.getByTestId("web-search-readiness-summary")).toHaveCount(0);
    await expect(page.getByTestId("web-search-exception-detail")).toHaveCount(0);
    await page.getByTestId("web-search-exception-toggle").click();
    const detail = page.getByTestId("web-search-exception-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Gemini");
    await expect(detail).toContainText("without a web search");

    await sendChatMessage(page, testInfo, "Any current news?");

    await expect(page.getByText("Searched and answered.")).toHaveCount(1);
    await expect(page.getByText("Answered without search.")).toHaveCount(2);
    // Three distinct honest statements: one search ran, one could have run and
    // did not, and one was never possible. None of them says a search happened
    // where none did.
    await expect(assistantBadge(page, "gpt-5-6-luna")).toHaveAttribute(
      "data-search-status",
      "executed"
    );
    await expect(assistantBadge(page, "claude-haiku-4-5")).toHaveAttribute(
      "data-search-status",
      "requested-not-executed"
    );
    await expect(assistantBadge(page, "gemini-2-5-flash")).toHaveAttribute(
      "data-search-status",
      "unsupported"
    );
  });

  /**
   * FINAL-F003. The original defect was a stale closure: `runComparisonPreflight`
   * did not list `webSearchMode` in its dependency array, so the preflight sent
   * whatever mode had been current when the callback was last built. The source
   * fix is in place; what was never proven is that the *transitions* agree --
   * that the mode the composer shows, the mode `/api/chat/preflight` is told,
   * and the mode every `/api/chat` fan-out request carries are one value at
   * every point a user can reach.
   *
   * Each case below submits immediately after a transition, with no settling
   * step in between, and reads the mode straight out of the request bodies.
   */
  const readModesOnSubmit = async (page: Page) => {
    const preflightModes: (string | undefined)[] = [];
    const chatModes: (string | undefined)[] = [];
    await page.route("**/api/chat/preflight", async (route) => {
      preflightModes.push(
        (route.request().postDataJSON() as { webSearchMode?: string })
          .webSearchMode
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, modelCount: 2, requiredCredits: 2 }),
      });
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      chatModes.push(
        (route.request().postDataJSON() as { webSearchMode?: string })
          .webSearchMode
      );
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: "Answered.",
      });
    });
    return { preflightModes, chatModes };
  };

  const setWebSearchModeOff = async (page: Page) => {
    await toolsMenuTrigger(page).click();
    const toggle = page.getByTestId("tools-web-search-row");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
  };

  const prepareTwoModelChat = async (page: Page) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await asProPlan(page);
    await seedFreshAccount(page);
    await page.goto("/chat?lang=en");
    await expect(
      page.locator('[data-testid="desktop-model-panel"] select').first()
    ).toBeEnabled();
    await selectModelsViaPicker(page, ["gpt-5-5", "claude-sonnet-5"]);
    await expect(page.locator('[data-testid="desktop-model-panel"] select')).toHaveCount(2);
  };

  test("a submit immediately after switching web search on carries the new mode everywhere", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    await setWebSearchModeAlways(page);
    await page.getByTestId("chat-textarea").fill("Search for the latest figure");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightModes.length).toBe(1);
    expect(preflightModes[0]).toBe("always");
    await expect.poll(() => chatModes.length).toBe(2);
    expect(new Set(chatModes)).toEqual(new Set(["always"]));
  });

  test("a submit immediately after switching web search back off carries no stale 'always'", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    await setWebSearchModeAlways(page);
    await setWebSearchModeOff(page);
    await page.getByTestId("chat-textarea").fill("Answer from what you know");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightModes.length).toBe(1);
    expect(preflightModes[0]).not.toBe("always");
    await expect.poll(() => chatModes.length).toBe(2);
    expect(chatModes.filter((mode) => mode === "always")).toHaveLength(0);
  });

  test("rapid mode toggling before a submit settles on the last choice", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    await setWebSearchModeAlways(page);
    await setWebSearchModeOff(page);
    await setWebSearchModeAlways(page);
    await page.getByTestId("chat-textarea").fill("Latest figure please");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightModes.length).toBe(1);
    expect(preflightModes[0]).toBe("always");
    await expect.poll(() => chatModes.length).toBe(2);
    expect(new Set(chatModes)).toEqual(new Set(["always"]));
  });

  // FINAL-F003 (R-06). The original defect was a stale closure: the submit
  // handler captured `webSearchMode` without listing it as a dependency, so a
  // send could carry the previous mode. That specific bug is fixed (the
  // dependency array now includes it), and the three tests above cover
  // toggling the mode itself. What was still uncovered is the other half of
  // the same class of bug: a *lifecycle* event between the user's choice and
  // the submit -- changing the model set, forcing the composer to re-render,
  // or switching conversations. Each one rebuilds the handler, and each one is
  // a place a stale mode could be reintroduced without any of the existing
  // tests noticing. The assertion in all three is the same: what the UI shows,
  // what preflight reserves, and what every /api/chat body carries agree.

  const expectModeEverywhere = async (
    page: Page,
    preflightModes: (string | undefined)[],
    chatModes: (string | undefined)[],
    expected: "always" | "off",
    panels: number
  ) => {
    await expect.poll(() => preflightModes.length).toBe(1);
    await expect.poll(() => chatModes.length).toBe(panels);
    if (expected === "always") {
      expect(preflightModes[0]).toBe("always");
      expect(new Set(chatModes)).toEqual(new Set(["always"]));
    } else {
      expect(preflightModes[0]).not.toBe("always");
      expect(chatModes.filter((mode) => mode === "always")).toHaveLength(0);
    }
  };

  test("a submit immediately after changing the model set keeps the chosen mode", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    await setWebSearchModeAlways(page);
    // The model change happens after the mode choice and before the submit.
    // Swapping a panel's own model is the narrowest way to trigger it: it
    // rebuilds the submit handler without touching the mode.
    await page
      .locator('[data-testid="desktop-model-panel"] select')
      .first()
      .selectOption("gemini-2-5-flash");
    await expect(
      page.locator('[data-testid="desktop-model-panel"] select').first()
    ).toHaveValue("gemini-2-5-flash");

    await page.getByTestId("chat-textarea").fill("Latest figure after a model swap");
    await page.getByTestId("chat-textarea").press("Enter");

    await expectModeEverywhere(page, preflightModes, chatModes, "always", 2);
  });

  test("a submit immediately after changing the model set carries no stale 'always'", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    await setWebSearchModeAlways(page);
    await setWebSearchModeOff(page);
    await page
      .locator('[data-testid="desktop-model-panel"] select')
      .first()
      .selectOption("gemini-2-5-flash");
    await expect(
      page.locator('[data-testid="desktop-model-panel"] select').first()
    ).toHaveValue("gemini-2-5-flash");

    await page.getByTestId("chat-textarea").fill("Answer from what you know");
    await page.getByTestId("chat-textarea").press("Enter");

    await expectModeEverywhere(page, preflightModes, chatModes, "off", 2);
  });

  test("a submit immediately after the composer re-renders keeps the chosen mode", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    await setWebSearchModeAlways(page);

    // A viewport change swaps the shell and re-renders the composer, which
    // rebuilds the submit handler -- the cheapest deterministic way to force
    // exactly the re-render the finding describes.
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("chat-textarea")).toBeVisible();

    await page.getByTestId("chat-textarea").fill("Latest figure after a re-render");
    await page.getByTestId("chat-textarea").press("Enter");

    await expectModeEverywhere(page, preflightModes, chatModes, "always", 2);
  });

  test("switching conversations applies the target conversation's own mode, not the previous one", async ({
    page,
  }) => {
    await prepareTwoModelChat(page);
    // Registered once: re-registering mid-test would leave the first handler
    // in place and silently split the record across two sets of arrays.
    const { preflightModes, chatModes } = await readModesOnSubmit(page);

    // Conversation one runs with web search on.
    await setWebSearchModeAlways(page);
    await page.getByTestId("chat-textarea").fill("First conversation question");
    await page.getByTestId("chat-textarea").press("Enter");
    await expect.poll(() => preflightModes.length).toBe(1);
    expect(preflightModes[0]).toBe("always");
    // Both panels, not "at least one": snapshotting mid-flight would put the
    // first conversation's second body on the wrong side of the slice below.
    await expect.poll(() => chatModes.length).toBe(2);
    const firstConversationCount = chatModes.length;
    expect(new Set(chatModes)).toEqual(new Set(["always"]));

    // A new conversation resets the mode to the app default; the next submit
    // must carry that, not conversation one's "always". New Chat also resets
    // the panel set to a single default model, and a single-model send skips
    // preflight entirely -- so the two-model selection is restored first,
    // keeping the second submit comparable to the first.
    await page.getByTestId("sidebar-new-chat").click();
    await expect(page.getByTestId("chat-textarea")).toBeEmpty();
    await selectModelsViaPicker(page, ["gpt-5-5", "claude-sonnet-5"]);
    await expect(
      page.locator('[data-testid="desktop-model-panel"] select')
    ).toHaveCount(2);

    await page.getByTestId("chat-textarea").fill("Second conversation question");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightModes.length).toBe(2);
    expect(preflightModes[1]).not.toBe("always");
    await expect.poll(() => chatModes.length).toBe(firstConversationCount + 2);
    expect(
      chatModes.slice(firstConversationCount).filter((mode) => mode === "always")
    ).toHaveLength(0);
  });

  test("the credit estimate breakdown shows the web search reservation for native-capable models", async ({
    page,
  }) => {
    const models = ["gpt-5-5", "claude-sonnet-5"];
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await asProPlan(page);
    await seedFreshAccount(page);

    await page.goto("/chat");
    await expect(page.locator('[data-testid="desktop-model-panel"] select').first()).toBeEnabled();
    await selectModelsViaPicker(page, models);
    await expect(page.locator('[data-testid="desktop-model-panel"] select')).toHaveCount(2);

    // Before enabling search: only the base model-response total --
    // gpt-5-5 carries an explicit creditWeight of 16 and claude-sonnet-5
    // costs its advanced-class 4.
    const estimate = page.getByTestId("request-credit-estimate");
    await expect(estimate).toContainText("20");

    await setWebSearchModeAlways(page);
    // Both models are native-search-eligible: base 20 + 2 * 8 surcharge = 36.
    await expect(estimate).toContainText("36");

    await estimate.click();
    const sheet = page.getByTestId("web-search-reservation-breakdown");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("16");
    // mockAuthenticatedApi's mocked account settings response fixes the
    // language server-side, overriding the "en" passed to prepareGuestPage
    // (a pre-existing quirk of that fixture) -- match both.
    await expect(
      page.getByText(
        /Search credits are refunded for models that do not perform a web search\.|검색이 실행되지 않은 모델의 검색 크레딧은 자동 환불됩니다\./
      )
    ).toBeVisible();
  });
});

/**
 * Perplexity Sonar returns its sources as TOP-LEVEL `citations` /
 * `search_results` response fields, not as `choices[].message.annotations`.
 * The OpenAI-compatible chat adapter Perplexity runs through carries only
 * annotations across, so the answer arrived with its "[1] [4] [7]" markers
 * intact and no source list underneath. The server now reads those fields off
 * the response body it already captures for billing and puts them in the
 * stream trailer -- with the reference number each source has in the answer
 * text, so "[4]" in the prose and "[4]" in the list are the same source.
 *
 * The same trailer also reports whether the provider actually finished: a
 * `length` finish reason is HTTP 200 with real text, and used to be presented
 * as a completed answer.
 */
test.describe("Perplexity citations and incomplete answers", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Uses the desktop per-panel model picker; the rendering under test is shell-agnostic (ChatMessageList.tsx)."
    );
  });

  const PERPLEXITY_MODEL_ID = "perplexity/sonar";
  const ANSWER_WITH_MARKERS =
    "Google documents thought tokens separately[1], Vertex AI reports them in usage metadata[4], and the pricing page confirms billing[7].";
  // Seven sources, exactly as `citations[]` ordered them. [1], [4] and [7] are
  // the three the answer text actually cites.
  const PERPLEXITY_CITATIONS = Array.from({ length: 7 }, (_, index) => ({
    url: `https://example.com/source-${index + 1}`,
    title: `Perplexity source ${index + 1}`,
    referenceNumber: index + 1,
    sourceProvider: "perplexity",
  }));
  const PERPLEXITY_SEARCH_METADATA = {
    requested: true,
    supported: true,
    executed: true,
    provider: "perplexity",
    citations: PERPLEXITY_CITATIONS,
  };

  const citationRow = (page: Page, referenceNumber: number) =>
    page
      .locator(
        `[data-testid="chat-message"][data-model-id="${PERPLEXITY_MODEL_ID}"][data-message-role="assistant"]`
      )
      .last()
      .locator(
        `[data-testid="search-citation-item"][data-reference-number="${referenceNumber}"]`
      );

  const expectCitationsAndNotice = async (page: Page) => {
    const list = page
      .locator(
        `[data-testid="chat-message"][data-model-id="${PERPLEXITY_MODEL_ID}"][data-message-role="assistant"]`
      )
      .last()
      .getByTestId("search-citation-list");
    await expect(list).toBeVisible();
    await expect(list.getByTestId("search-citation-item")).toHaveCount(7);

    // Every number the answer text cites resolves to the source the provider
    // numbered that way -- the body's markers are never rewritten.
    for (const referenceNumber of [1, 4, 7]) {
      const row = citationRow(page, referenceNumber);
      await expect(row).toContainText(`[${referenceNumber}]`);
      const link = row.getByRole("link");
      await expect(link).toHaveAttribute(
        "href",
        `https://example.com/source-${referenceNumber}`
      );
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(link).toHaveText(`Perplexity source ${referenceNumber}`);
    }

    // The body survives untouched, and the cut-off is stated rather than
    // implied -- with no follow-up request sent on the user's behalf.
    await expect(page.getByText(ANSWER_WITH_MARKERS)).toBeVisible();
    await expect(page.getByTestId("response-incomplete-notice")).toBeVisible();
    await expect(page.getByTestId("response-incomplete-notice")).toContainText(
      /output length limit|출력 길이 제한/
    );
  };

  test("sources and the incomplete notice render immediately after streaming", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page);
    await seedFreshAccount(page);

    let chatRequestCount = 0;
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      chatRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-perplexity" },
        body: `${ANSWER_WITH_MARKERS}${SEARCH_METADATA_MARKER}${JSON.stringify({
          searchMetadata: PERPLEXITY_SEARCH_METADATA,
          completion: { status: "incomplete", incompleteReason: "length" },
        })}`,
      });
    });

    await page.goto("/chat");
    await expect(
      page.locator('[data-testid="desktop-model-panel"] select').first()
    ).toBeEnabled();
    await selectModelsViaPicker(page, [PERPLEXITY_MODEL_ID]);
    await sendChatMessage(page, testInfo, "Are thought tokens counted separately?");

    await expectCitationsAndNotice(page);
    // Perplexity searches as part of normal completion, so the badge still
    // reads as executed -- an incomplete answer is not a failed search.
    await expect(assistantBadge(page, PERPLEXITY_MODEL_ID)).toHaveAttribute(
      "data-search-status",
      "executed"
    );
    // Nothing continues the answer automatically: exactly one request was
    // made, so no second turn's credits were spent without being asked for.
    expect(chatRequestCount).toBe(1);
  });

  test("sources and the incomplete notice survive re-opening the stored conversation", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await mockAuthenticatedApi(page, {
      selectedModels: [PERPLEXITY_MODEL_ID],
      messages: [
        { id: "u1", role: "user", content: "Are thought tokens counted separately?" },
        {
          id: "a1",
          role: "assistant",
          content: ANSWER_WITH_MARKERS,
          modelId: PERPLEXITY_MODEL_ID,
          // Persisted by app/api/chat/route.ts on a `length` finish reason.
          status: "incomplete",
          searchMetadata: PERPLEXITY_SEARCH_METADATA,
        },
      ],
    });

    await page.goto("/chat?lang=en");
    await openRecentConversation(page, { title: "QA conversation" });
    await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);

    await expectCitationsAndNotice(page);
  });
});
