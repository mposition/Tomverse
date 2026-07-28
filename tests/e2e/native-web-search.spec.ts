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

const setWebSearchModeAlways = async (page: Page) => {
  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-web-search-row").click();
  await page.getByTestId("web-search-mode-option-always").click();
};

// gpt-5-5 and claude-sonnet-5 are Pro-tier; the default mocked plan is Free.
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

// A fresh account starts on the single compiled-in default model
// (gpt-5-4-mini). toggleModel() refuses to drop the last remaining model, so
// the default can only be removed once at least one target is already
// selected -- add the first target, drop the default, then add the rest.
const selectModelsViaPicker = async (page: Page, models: string[]) => {
  // STG-F008: specific models are picked from the full catalogue, which is the
  // picker's second step.
  await openModelPickerCatalogue(page);
  const optionFor = (modelId: string) =>
    page.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`);
  await optionFor(models[0]).click();
  await optionFor("gpt-5-4-mini").click();
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

  test("3 different providers each get their own native tool, with independent per-panel outcomes and unchanged model list", async ({
    page,
  }, testInfo) => {
    const models = ["gpt-5-5", "claude-sonnet-5", "gemini-3-5-flash"];
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

      if (modelId === "gpt-5-5") {
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
      if (modelId === "gemini-3-5-flash") {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: { "X-Request-ID": "qa-trace-google" },
          body: withSearchMetadata("Falling back to a general answer.", {
            requested: true,
            supported: true,
            executed: false,
            provider: "google",
            tool: "google_search",
            citations: [],
            failureCode: "provider_tool_error",
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

    await expect(assistantBadge(page, "gpt-5-5")).toHaveAttribute(
      "data-search-status",
      "executed"
    );
    await expect(assistantBadge(page, "claude-sonnet-5")).toHaveAttribute(
      "data-search-status",
      "requested-not-executed"
    );
    await expect(assistantBadge(page, "gemini-3-5-flash")).toHaveAttribute(
      "data-search-status",
      "failed"
    );

    // Citations only render for the panel that actually executed a search,
    // as a real, safe external link.
    const citationLink = page
      .locator('[data-testid="chat-message"][data-model-id="gpt-5-5"]')
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

  test("off mode sends no webSearchMode and every panel reads as training knowledge", async ({
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
    await expect(assistantBadge(page, "gpt-5-5")).toHaveAttribute(
      "data-search-status",
      "training-knowledge"
    );
  });

  test("mixed supported/unsupported selection shows a compact partial-support chip and an unsupported badge", async ({
    page,
  }, testInfo) => {
    // gpt-5-4-mini and gemini-2-5-flash are deliberately "unverified" (not
    // confirmed native) in lib/webSearchCapability.ts; claude-haiku-4-5 is
    // confirmed native -- this is the app's own real guest default trio, so
    // this one test runs as a guest to also cover the guest code path.
    const models = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
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
      const executed = body.modelId === "claude-haiku-4-5";
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "X-Request-ID": "qa-trace-mixed" },
        body: withSearchMetadata(
          executed ? "Searched and answered." : "Answered without search.",
          {
            requested: true,
            supported: executed,
            executed,
            provider: executed ? "anthropic" : "openai",
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
    await expect(chip).toContainText("1/3 supported");
    await expect(page.getByTestId("web-search-readiness-summary")).toHaveCount(0);
    await expect(page.getByTestId("web-search-exception-detail")).toHaveCount(0);
    await page.getByTestId("web-search-exception-toggle").click();
    const detail = page.getByTestId("web-search-exception-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("GPT-5.4 mini");
    await expect(detail).toContainText("training knowledge only");

    await sendChatMessage(page, testInfo, "Any current news?");

    await expect(page.getByText("Searched and answered.")).toBeVisible();
    await expect(assistantBadge(page, "claude-haiku-4-5")).toHaveAttribute(
      "data-search-status",
      "executed"
    );
    await expect(assistantBadge(page, "gpt-5-4-mini")).toHaveAttribute(
      "data-search-status",
      "unsupported"
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
    await page.getByTestId("tools-web-search-row").click();
    await page.getByTestId("web-search-mode-option-off").click();
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

    // Before enabling search: only the base model-response total (1 + 4 = 5,
    // gpt-5-5 premium=8 and claude-sonnet-5 advanced=4 -- both Pro-tier).
    const estimate = page.getByTestId("request-credit-estimate");
    await expect(estimate).toContainText("12");

    await setWebSearchModeAlways(page);
    // Both models are native-search-eligible: base 12 + 2 * 8 surcharge = 28.
    await expect(estimate).toContainText("28");

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
