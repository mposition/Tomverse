import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  openModelPickerCatalogue,
  openRecentConversation,
  prepareGuestPage,
} from "./support/app-fixtures";

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

async function prepareAuthenticatedChat(
  page: Page,
  selectedModels = ["gpt-5-4-mini"]
) {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels });
  await page.goto(
    "/chat?lang=ko&utm_source=qa&utm_medium=e2e&utm_campaign=upgrade-discovery"
  );
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

test.describe("desktop upgrade discovery", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Desktop upgrade discovery runs in desktop projects."
    );
    await prepareAuthenticatedChat(page);
  });

  test("compact account card exposes a direct localized upgrade path", async ({
    page,
  }) => {
    await expect(page.getByTestId("sidebar-upgrade-card")).toHaveCount(0);
    const accountUpgrade = page.getByTestId("account-plan-upgrade-badge");
    await expect(accountUpgrade).toBeVisible();
    await expect(accountUpgrade).toHaveAttribute("href", /\/pricing\?/);
    await expect(accountUpgrade).toHaveAttribute("href", /lang=ko/);
    await expect(accountUpgrade).toHaveAttribute("href", /trigger=account/);
    await expect(accountUpgrade).toHaveAttribute("href", /utm_source=qa/);
    await expect(accountUpgrade).toHaveAttribute("href", /utm_medium=e2e/);
    await expect(accountUpgrade).toHaveAttribute(
      "href",
      /utm_campaign=upgrade-discovery/
    );

    await page.getByTestId("account-menu-trigger").click();
    const accountMenu = page.getByTestId("account-menu");
    await expect(accountMenu).toBeVisible();
    await expect(accountMenu.getByTestId("account-daily-credits")).toContainText(
      "30 / 30"
    );
    await expect(accountMenu.getByText(/월간 .*크레딧 남음/)).toBeVisible();
    await expect(accountMenu.getByText(/추가 구매 크레딧 남음/)).toBeVisible();
    await expect(accountMenu.getByTestId("account-plan-view")).toBeVisible();
  });

  test("locked paid model opens an actionable plan dialog", { tag: "@smoke" }, async ({ page }) => {
    const modelDialog = await openModelPickerCatalogue(page);
    const lockedModel = modelDialog
      .locator(
        '[data-testid="model-option"][data-model-minimum-plan="Pro"][data-model-plan-locked="true"]:not([disabled])'
      )
      .first();
    await expect(lockedModel).toBeVisible();
    await lockedModel.click();

    const planCta = page.getByTestId("locked-model-plan-cta");
    await expect(planCta).toBeVisible();
    await expect(planCta).toHaveAttribute("href", /lang=ko/);
    await expect(planCta).toHaveAttribute("href", /trigger=proactive/);
    await expect(planCta).toHaveAttribute("href", /utm_source=qa/);

    await page.getByTestId("locked-model-choose-another").click();
    await expect(planCta).toBeHidden();
  });
});

test.describe("mobile upgrade discovery", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Mobile upgrade discovery runs in mobile projects."
    );
    await prepareAuthenticatedChat(page);
  });

  test("compact upgrade action is visible immediately when the sidebar opens", async ({
    page,
  }) => {
    await page.getByTestId("mobile-sidebar-open").click();
    await expect(page.getByTestId("sidebar-upgrade-card")).toHaveCount(0);
    const accountUpgrade = page.getByTestId("account-plan-upgrade-badge");
    await expect(accountUpgrade).toBeVisible();

    const box = await accountUpgrade.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
    await expect(accountUpgrade).toHaveAttribute("href", /trigger=account/);
    await expect(accountUpgrade).toHaveAttribute("href", /utm_campaign=upgrade-discovery/);
  });

  test("compact account launcher opens an in-viewport mobile account sheet", async ({
    page,
  }) => {
    await page.getByTestId("mobile-sidebar-open").click();
    await page.getByTestId("account-menu-trigger").click();

    const accountMenu = page.getByTestId("account-menu");
    await expect(accountMenu).toBeVisible();
    await expect(page.getByTestId("account-menu-backdrop")).toBeVisible();
    await expect(accountMenu.getByTestId("account-plan-view")).toBeVisible();

    const menuBox = await accountMenu.boundingBox();
    const viewport = page.viewportSize();
    expect(menuBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport!.width);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height);
  });
});

test.describe("value-moment upgrade prompt", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "Value prompt is covered once in desktop projects."
    );
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, {
      selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
    });
    await mockChatStream(page, "Comparison response");
    await page.goto("/chat?lang=ko");
    // A fresh chat starts with a single default model -- these tests need
    // the persisted qa-conversation's 2-model comparison selection active
    // (and a real currentChatId) for the comparison preflight/upgrade-prompt
    // flow to trigger at all.
    await openRecentConversation(page);
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("first successful comparison shows a one-time nonblocking prompt", async ({
    page,
  }) => {
    await page.getByTestId("chat-textarea").fill("Compare these answers");
    await page.getByTestId("chat-textarea").press("Enter");

    const prompt = page.getByTestId("value-upgrade-prompt");
    await expect(prompt).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("tomverse_value_upgrade_prompt_seen_v1")
        )
      )
      .toBe("1");
  });

  test("comparison preflight rejection prevents every provider request", { tag: "@smoke" }, async ({
    page,
  }) => {
    let providerRequestCount = 0;
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "X-Request-ID": "qa-preflight-limit" },
        body: JSON.stringify({
          error: "Internal daily cost safety limit reached.",
          code: "INTERNAL_DAILY_COST_SAFETY_LIMIT",
        }),
      })
    );
    await page.unroute("**/api/chat");
    await page.route("**/api/chat", (route) => {
      providerRequestCount += 1;
      return route.fulfill({ status: 200, body: "Unexpected response" });
    });

    await page.getByTestId("chat-textarea").fill("Compare safely");
    await page.getByTestId("chat-textarea").press("Enter");

    // Error-toned toasts render role="alert" (assertive) rather than
    // role="status" (polite), so screen readers announce them immediately.
    // Filtered by text to disambiguate from Next.js's own role="alert"
    // route announcer (id="__next-route-announcer__").
    const toast = page
      .getByRole("alert")
      .filter({ hasText: "오늘 처리할 수 있는 한도를 넘었습니다" });
    await expect(toast).toBeVisible();
    await expect.poll(() => providerRequestCount).toBe(0);
  });

  test("comparison preflight retries one transient network failure", { tag: "@smoke" }, async ({
    page,
  }) => {
    let preflightAttempts = 0;
    const clientTraceIds = new Set<string>();
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightAttempts += 1;
      const clientTraceId =
        (await route.request().headerValue("X-Client-Request-ID")) || "";
      clientTraceIds.add(clientTraceId);
      if (preflightAttempts === 1) {
        await route.abort("connectionfailed");
        return;
      }
      const body = route.request().postDataJSON() as {
        comparisonId?: string;
        modelIds?: string[];
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "X-Request-ID": clientTraceId },
        body: JSON.stringify({
          ok: true,
          comparisonId: body.comparisonId,
          modelCount: body.modelIds?.length || 0,
          requiredCredits: body.modelIds?.length || 0,
        }),
      });
    });

    await page.getByTestId("chat-textarea").fill("Retry this comparison");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightAttempts).toBe(2);
    expect(clientTraceIds.size).toBe(1);
    expect([...clientTraceIds][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    await expect(page.getByTestId("value-upgrade-prompt")).toBeVisible();
  });

  test("unexpected aggregate preflight failure falls back to authoritative chat checks", { tag: "@smoke" }, async ({
    page,
  }) => {
    let preflightAttempts = 0;
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightAttempts += 1;
      const traceId =
        (await route.request().headerValue("X-Client-Request-ID")) ||
        "qa-degraded-preflight";
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "X-Request-ID": traceId },
        body: JSON.stringify({
          error: "Aggregate preflight failed.",
          code: "COMPARISON_PREFLIGHT_FAILED",
          traceId,
        }),
      });
    });

    await page.getByTestId("chat-textarea").fill("Use authoritative checks");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightAttempts).toBe(2);
    await expect(page.getByTestId("value-upgrade-prompt")).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("pending model selection is persisted before comparison preflight", async ({
    page,
  }) => {
    let modelPatchCompleted = false;
    let preflightAfterPatch = false;
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        modelPatchCompleted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "qa-conversation" }),
        });
      }
    );
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightAfterPatch = modelPatchCompleted;
      await route.fulfill({
        status: preflightAfterPatch ? 200 : 409,
        contentType: "application/json",
        body: JSON.stringify(
          preflightAfterPatch
            ? { ok: true, modelCount: 3, requiredCredits: 3 }
            : {
                error: "Model selection was not persisted.",
                code: "MODEL_NOT_SELECTED",
              }
        ),
      });
    });

    await modelMenuTrigger(page).click();
    const availableRecommendation = page
      .locator(
        '[data-testid="recommended-model-option"][aria-pressed="false"][data-model-plan-locked="false"]:not([disabled])'
      )
      .first();
    await expect(availableRecommendation).toBeVisible();
    await availableRecommendation.click();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-textarea").fill("Persist then compare");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => modelPatchCompleted).toBe(true);
    await expect.poll(() => preflightAfterPatch).toBe(true);
    await expect(page.getByTestId("value-upgrade-prompt")).toBeVisible();
  });

  /**
   * STG-F003 root cause. The composer is portalled into one of two slots --
   * the welcome screen's while the conversation is empty, the bottom dock
   * once it is not -- and `isConversationEmpty` only settles once every panel
   * has reported back whether it has messages. Portalling straight into those
   * two elements meant the switch unmounted the whole ChatInput subtree and
   * built a new one, replacing the <textarea> DOM node: the text already
   * typed into the old node was dropped, focus was lost, and the Enter that
   * followed hit an empty composer. The user saw no request, no error, and no
   * prompt.
   *
   * Here the per-model message loads are held back so the switch lands after
   * the prompt is typed, which is exactly the window that produced the 25%
   * failure rate on the persistence test above.
   */
  test("a prompt typed while the panels are still loading is not lost", async ({
    page,
  }) => {
    let preflightCount = 0;
    await page.route(
      /.*\/api\/conversations\/qa-conversation\?.*modelId=.*/,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        await route.fallback();
      }
    );
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, modelCount: 2, requiredCredits: 2 }),
      });
    });

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("Typed while the panels were still loading");
    // The composer must still hold the prompt after the panels settle and the
    // welcome screen gives way to the conversation view.
    await expect
      .poll(() => textarea.inputValue(), { timeout: 5_000 })
      .toBe("Typed while the panels were still loading");
    await expect(page.getByTestId("chat-textarea")).toBeFocused();

    await textarea.press("Enter");
    await expect.poll(() => preflightCount).toBe(1);
  });

  /**
   * STG-F003. Nothing marks the composer busy until after the conversation
   * create, the model-settings flush and the preflight have all resolved, so
   * a second Enter inside that window used to run a second, independent
   * submit: two preflights, two saved user messages, two charges for one
   * intent.
   */
  test("a second Enter during a slow preflight does not start a second comparison", async ({
    page,
  }) => {
    let preflightCount = 0;
    let messagePostCount = 0;
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, modelCount: 2, requiredCredits: 2 }),
      });
    });
    await page.route(
      "**/api/conversations/qa-conversation/messages**",
      async (route) => {
        if (route.request().method() === "POST") messagePostCount += 1;
        await route.fulfill({
          status: route.request().method() === "POST" ? 201 : 200,
          contentType: "application/json",
          body: "{}",
        });
      }
    );

    const textarea = page.getByTestId("chat-textarea");
    await textarea.fill("Only one of these may run");
    await textarea.press("Enter");
    await textarea.press("Enter");
    await textarea.press("Enter");

    await expect.poll(() => preflightCount, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId("value-upgrade-prompt")).toBeVisible();
    expect(preflightCount).toBe(1);
    expect(messagePostCount).toBeLessThanOrEqual(1);
  });

  test("panel-only send waits for a changed model selection to persist", async ({
    page,
  }) => {
    // UI-EMPTY-001 makes the whole comparison panel `inert` while the
    // conversation has no messages yet, so that a keyboard or screen-reader
    // user cannot reach a comparison the conversation does not have. The
    // per-panel follow-up input is inside that subtree, which means an empty
    // conversation cannot produce a panel-only send at all -- the input takes
    // no focus, no keystroke and no submit.
    //
    // This test predates that contract and was seeding no messages, so it was
    // asserting on an interaction the product deliberately refuses: the send
    // never happened, `messageSavedAfterPatch` kept its initial false, and the
    // failure read like a persistence-ordering bug. Seeding history puts the
    // panel in the only state where its follow-up input is meant to work, so
    // the ordering this test exists to protect is actually exercised.
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
    await page.reload();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    // The panel is only interactive once the conversation is known to be
    // non-empty; without this the send below would be silently refused again.
    await expect(page.getByTestId("desktop-model-panel").first()).not.toHaveAttribute(
      "inert",
      ""
    );

    let modelPatchCompleted = false;
    let messageSavedAfterPatch = false;
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        modelPatchCompleted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "qa-conversation" }),
        });
      }
    );
    await page.route(
      "**/api/conversations/qa-conversation/messages**",
      async (route) => {
        if (route.request().method() === "POST") {
          messageSavedAfterPatch = modelPatchCompleted;
        }
        await route.fulfill({
          status: route.request().method() === "POST" ? 201 : 200,
          contentType: "application/json",
          body: "{}",
        });
      }
    );

    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");
    await expect(firstPanel).toHaveAttribute("data-model-id", "gemini-2-5-flash");
    await firstPanel.locator("textarea").fill("Send only to the changed model");
    await firstPanel.locator("textarea").press("Enter");

    await expect.poll(() => modelPatchCompleted).toBe(true);
    await expect.poll(() => messageSavedAfterPatch).toBe(true);
  });

  test("changing a panel model keeps the conversation's shared user history", async ({
    page,
  }) => {
    await page.route(
      /.*\/api\/conversations\/qa-conversation\?.*modelId=.*/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation",
            selectedModels: ["gemini-3-5-flash", "claude-haiku-4-5"],
            disabledPanels: [],
            messages: [
              {
                id: "shared-user-message",
                role: "user",
                content: "Shared conversation question",
                modelId: null,
              },
              {
                id: "old-model-answer",
                role: "assistant",
                content: "Answer from the previous model",
                modelId: "gpt-5-4-mini",
                status: "normal",
              },
            ],
            messagePage: { hasMore: false, nextCursor: null },
          }),
        });
      }
    );

    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-3-5-flash");
    await expect(firstPanel).toHaveAttribute("data-model-id", "gemini-3-5-flash");

    await expect(firstPanel.getByText("Shared conversation question")).toBeVisible();
    await expect(firstPanel.getByText("Answer from the previous model")).toHaveCount(0);
  });
});
