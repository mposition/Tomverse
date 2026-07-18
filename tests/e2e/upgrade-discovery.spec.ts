import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
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

  test("locked paid model opens an actionable plan dialog", async ({ page }) => {
    await modelMenuTrigger(page).click();
    const modelDialog = page.locator("#chat-input-popover");
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

  test("comparison preflight rejection prevents every provider request", async ({
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

    await expect(page.getByRole("status")).toContainText("비용 안전 한도");
    await expect.poll(() => providerRequestCount).toBe(0);
  });

  test("comparison preflight retries one transient network failure", async ({
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

  test("unexpected aggregate preflight failure falls back to authoritative chat checks", async ({
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
});
