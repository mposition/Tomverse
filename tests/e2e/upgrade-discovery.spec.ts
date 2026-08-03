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
    // The history below is seeded so the panel is in the state its follow-up
    // input is meant for: a conversation that already has an answer to follow
    // up on. That is what this test is about -- the ordering between the model
    // PATCH and the message POST -- not the empty state.
    //
    // The comment that used to sit here said the panels are `inert` while the
    // conversation is empty. They are not: that was tried and reverted, and
    // the empty state still leaves the panels' own controls reachable. The
    // open defect and the decision it is waiting on are tracked in
    // .github/audits/ui-empty-001-keyboard-exposure-2026-08-01.md, which also
    // records that no test currently covers a panel-only send on an empty
    // conversation -- this one stopped doing so when it started seeding.
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
    // Wait for the seeded history to actually be on screen before driving the
    // panel. This replaces a `not.toHaveAttribute("inert", "")` check that
    // could not fail: no panel is ever `inert` today, so it passed on the
    // first evaluation whether or not the conversation had loaded, and the
    // readiness it claimed to establish was never established. The rendered
    // answer is positive evidence that this panel has the conversation.
    await expect(
      page.getByTestId("desktop-model-panel").first().getByText("seeded answer")
    ).toBeVisible();

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

  /**
   * Trace 5dc1d2ee-6c98-44fa-8b6f-03d798c3f011 (MODEL_NOT_SELECTED). The old
   * sync aborted the in-flight PATCH when a newer change arrived -- but an
   * aborted fetch still commits server-side, so when the *older* request
   * finished after the newer one, the database kept the stale selection and
   * the next send was refused. The queue serializes writes per conversation:
   * a second PATCH may not even be issued until the first response has been
   * observed, and the write that runs then carries the newest snapshot.
   */
  test("overlapping model changes are serialized and the final PATCH carries the newest selection", async ({
    page,
  }) => {
    let patchCount = 0;
    let inFlightPatches = 0;
    let sawOverlappingPatch = false;
    const completedPatchBodies: string[][] = [];
    let releaseFirstPatch: (() => void) | null = null;
    const firstPatchGate = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve;
    });

    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        const index = (patchCount += 1);
        inFlightPatches += 1;
        if (inFlightPatches > 1) sawOverlappingPatch = true;
        const body = route.request().postDataJSON() as {
          selectedModels?: string[];
        };
        // The first save is slow -- exactly the window in which the old
        // abort-based sync let a newer PATCH finish first and be overwritten.
        if (index === 1) await firstPatchGate;
        inFlightPatches -= 1;
        completedPatchBodies.push(body.selectedModels || []);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation",
            selectedModels: body.selectedModels || [],
            disabledPanels: [],
          }),
        });
      }
    );

    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");
    await expect.poll(() => patchCount).toBe(1);

    // A second change while the first PATCH is still being processed.
    await firstPanel.locator("select").selectOption("gemini-3-6-flash");
    // Give a wrongly-implemented client every opportunity to overlap.
    await page.waitForTimeout(600);
    expect(patchCount).toBe(1);

    releaseFirstPatch!();
    await expect.poll(() => completedPatchBodies.length).toBe(2);
    expect(sawOverlappingPatch).toBe(false);
    const finalPatch = completedPatchBodies.at(-1)!;
    expect(finalPatch).toContain("gemini-3-6-flash");
    expect(finalPatch).not.toContain("gemini-2-5-flash");
  });

  test("a send issued while a model PATCH is already in flight waits for that save", async ({
    page,
  }) => {
    let patchCount = 0;
    let patchCompleted = false;
    let preflightCount = 0;
    let preflightAfterPatch = false;
    let releasePatch: (() => void) | null = null;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        patchCount += 1;
        const body = route.request().postDataJSON() as {
          selectedModels?: string[];
        };
        await patchGate;
        patchCompleted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation",
            selectedModels: body.selectedModels || [],
            disabledPanels: [],
          }),
        });
      }
    );
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightCount += 1;
      preflightAfterPatch = patchCompleted;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, modelCount: 2, requiredCredits: 2 }),
      });
    });

    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");
    await expect.poll(() => patchCount).toBe(1);

    await page.getByTestId("chat-textarea").fill("Send during the save");
    await page.getByTestId("chat-textarea").press("Enter");
    // The barrier must hold the preflight back while the save is running.
    await page.waitForTimeout(500);
    expect(preflightCount).toBe(0);

    releasePatch!();
    await expect.poll(() => preflightCount).toBe(1);
    expect(preflightAfterPatch).toBe(true);
  });

  /**
   * The single-model path never runs the comparison preflight, so the
   * MODEL_NOT_SELECTED guard in /api/chat is the first server check it meets.
   * The send barrier has to protect this path on its own: the swap's PATCH
   * must be confirmed before /api/chat is called with the new model.
   */
  test("a single-model send right after a model swap reaches /api/chat only after the swap is saved", async ({
    page,
  }) => {
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
    await page.reload();
    await expect(page.getByTestId("chat-input")).toBeVisible();

    let patchCompleted = false;
    let preflightCount = 0;
    const chatRequests: Array<{ afterPatch: boolean; modelId: string }> = [];
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        patchCompleted = true;
        const body = route.request().postDataJSON() as {
          selectedModels?: string[];
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation",
            selectedModels: body.selectedModels || [],
            disabledPanels: [],
          }),
        });
      }
    );
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, modelCount: 1, requiredCredits: 1 }),
      });
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { modelId?: string };
      chatRequests.push({
        afterPatch: patchCompleted,
        modelId: body.modelId || "",
      });
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: "Single model answer",
      });
    });

    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");
    await page.getByTestId("chat-textarea").fill("Swap then send immediately");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => chatRequests.length, { timeout: 10_000 }).toBe(1);
    expect(chatRequests[0]!.afterPatch).toBe(true);
    expect(chatRequests[0]!.modelId).toBe("gemini-2-5-flash");
    expect(preflightCount).toBe(0);
  });

  test("retry waits for a pending model selection save before re-sending", async ({
    page,
  }) => {
    let chatFailuresServed = 0;
    let patchCompleted = false;
    const retryChatRequests: Array<{ afterPatch: boolean; modelId: string }> =
      [];
    let releasePatch: (() => void) | null = null;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as { modelId?: string };
      if (body.modelId === "gpt-5-4-mini" && chatFailuresServed === 0) {
        chatFailuresServed += 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: "QA fixture: upstream failure.",
            code: "UPSTREAM_FAILURE",
          }),
        });
        return;
      }
      if (body.modelId === "gpt-5-4-mini") {
        retryChatRequests.push({
          afterPatch: patchCompleted,
          modelId: body.modelId,
        });
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: "Recovered answer",
      });
    });

    await page.getByTestId("chat-textarea").fill("Fail one panel");
    await page.getByTestId("chat-textarea").press("Enter");
    const retry = page.getByRole("button", { name: "다시 시도", exact: true });
    await expect(retry).toHaveCount(1);

    // A model change on the *other* panel leaves this panel (and its retry
    // affordance) mounted while its save hangs.
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        const body = route.request().postDataJSON() as {
          selectedModels?: string[];
        };
        await patchGate;
        patchCompleted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation",
            selectedModels: body.selectedModels || [],
            disabledPanels: [],
          }),
        });
      }
    );
    const secondPanel = page.getByTestId("desktop-model-panel").nth(1);
    await secondPanel.locator("select").selectOption("gemini-2-5-flash");

    await retry.click();
    await page.waitForTimeout(500);
    expect(retryChatRequests.length).toBe(0);

    releasePatch!();
    await expect.poll(() => retryChatRequests.length).toBe(1);
    expect(retryChatRequests[0]!.afterPatch).toBe(true);
  });

  test("one conversation's hanging model save does not block another conversation's send", async ({
    page,
  }) => {
    // A second conversation beside the seeded qa-conversation.
    await page.unroute("**/api/conversations");
    await page.route("**/api/conversations", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "qa-conversation",
            title: "QA conversation",
            selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
            disabledPanels: [],
            isLocked: false,
            shareEnabled: false,
            shareExpiresAt: null,
          },
          {
            id: "qa-conversation-b",
            title: "QA conversation B",
            selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
            disabledPanels: [],
            isLocked: false,
            shareEnabled: false,
            shareExpiresAt: null,
          },
        ]),
      });
    });
    let conversationAPatchResolved = false;
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.fallback();
          return;
        }
        // Conversation A's save hangs for the whole test.
        await new Promise(() => {});
        conversationAPatchResolved = true;
      }
    );
    const conversationBPatchBodies: string[][] = [];
    await page.route(
      /.*\/api\/conversations\/qa-conversation-b(\?.*)?$/,
      async (route) => {
        const method = route.request().method();
        if (method === "PATCH") {
          const body = route.request().postDataJSON() as {
            selectedModels?: string[];
          };
          conversationBPatchBodies.push(body.selectedModels || []);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: "qa-conversation-b",
              selectedModels: body.selectedModels || [],
              disabledPanels: [],
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "qa-conversation-b",
            title: "QA conversation B",
            selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
            disabledPanels: [],
            webSearchMode: "off",
            isLocked: false,
            shareEnabled: false,
            shareExpiresAt: null,
            messages: [],
            messagePage: { hasMore: false, nextCursor: null },
          }),
        });
      }
    );
    await page.route(
      "**/api/conversations/qa-conversation-b/messages**",
      async (route) => {
        await route.fulfill({
          status: route.request().method() === "POST" ? 201 : 200,
          contentType: "application/json",
          body: "{}",
        });
      }
    );
    let preflightCount = 0;
    await page.unroute("**/api/chat/preflight");
    await page.route("**/api/chat/preflight", async (route) => {
      preflightCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, modelCount: 2, requiredCredits: 2 }),
      });
    });
    // Refresh the sidebar list so conversation B exists to switch to.
    await page.reload();
    await expect(page.getByTestId("chat-input")).toBeVisible();

    // A model change in conversation A whose save never completes.
    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");

    // Switching to conversation B and sending there must not wait on A.
    await page
      .getByTestId("sidebar-conversation-item")
      .filter({ hasText: "QA conversation B" })
      .click();
    await page.getByTestId("chat-textarea").fill("Send in conversation B");
    await page.getByTestId("chat-textarea").press("Enter");

    await expect.poll(() => preflightCount, { timeout: 10_000 }).toBe(1);
    expect(conversationAPatchResolved).toBe(false);
    // Nothing queued for A ever leaked into B's PATCHes.
    for (const body of conversationBPatchBodies) {
      expect(body).not.toContain("gemini-2-5-flash");
    }
  });

  test("a late conversation detail response does not revert a newer local model change", async ({
    page,
  }) => {
    let releaseDetailGet: (() => void) | null = null;
    const detailGate = new Promise<void>((resolve) => {
      releaseDetailGet = resolve;
    });
    let patchCount = 0;
    await page.route(
      /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
      async (route) => {
        const method = route.request().method();
        const url = route.request().url();
        if (method === "PATCH") {
          patchCount += 1;
          const body = route.request().postDataJSON() as {
            selectedModels?: string[];
          };
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: "qa-conversation",
              selectedModels: body.selectedModels || [],
              disabledPanels: [],
            }),
          });
          return;
        }
        // Only the settings read (no modelId) is delayed; the per-panel
        // history loads keep flowing.
        if (method === "GET" && !url.includes("modelId=")) {
          await detailGate;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: "qa-conversation",
              title: "QA conversation",
              // The state as it was BEFORE the change below -- a response
              // this old must not roll the panel back.
              selectedModels: ["gpt-5-4-mini", "claude-haiku-4-5"],
              disabledPanels: [],
              webSearchMode: "off",
              isLocked: false,
              shareEnabled: false,
              shareExpiresAt: null,
              messages: [],
              messagePage: { hasMore: false, nextCursor: null },
            }),
          });
          return;
        }
        await route.fallback();
      }
    );

    // Re-select the conversation so its (now gated) settings read is in
    // flight. The welcome-screen helper does not apply here -- the beforeEach
    // already opened the conversation, so the sidebar entry is the re-entry
    // point.
    await page
      .getByTestId("sidebar-conversation-item")
      .filter({ hasText: "QA conversation" })
      .first()
      .click();
    const firstPanel = page.getByTestId("desktop-model-panel").first();
    await firstPanel.locator("select").selectOption("gemini-2-5-flash");
    await expect(firstPanel).toHaveAttribute(
      "data-model-id",
      "gemini-2-5-flash"
    );
    await expect.poll(() => patchCount).toBeGreaterThan(0);

    releaseDetailGet!();
    // The stale read has landed; the newer local (and now saved) selection
    // must survive it.
    await page.waitForTimeout(400);
    await expect(firstPanel).toHaveAttribute(
      "data-model-id",
      "gemini-2-5-flash"
    );
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
            selectedModels: ["gemini-3-6-flash", "claude-haiku-4-5"],
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
    await firstPanel.locator("select").selectOption("gemini-3-6-flash");
    await expect(firstPanel).toHaveAttribute("data-model-id", "gemini-3-6-flash");

    await expect(firstPanel.getByText("Shared conversation question")).toBeVisible();
    await expect(firstPanel.getByText("Answer from the previous model")).toHaveCount(0);
  });
});
