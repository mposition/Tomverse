import { expect, test, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openRecentConversation,
} from "./support/app-fixtures";

// The "+" trigger (opens the tools/actions sheet) is the first of the two
// chat-input-popover triggers; the model-selector button (used by
// model-finder.spec.ts) is the second. Mixing these up opens the wrong sheet.
const toolsMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(0);

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

test("the + menu opens a tools sheet with web search, Deep Research, and an unchanged attach flow", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.goto("/chat?lang=en");

  await toolsMenuTrigger(page).click();
  await expect(page.getByTestId("tools-web-search-row")).toBeVisible();
  await expect(page.getByTestId("tools-deep-research-row")).toBeVisible();
  // The "read a webpage" row is gone rather than disabled. Shipping a control
  // that cannot be used costs a row in a menu whose whole problem was length,
  // and tells the user about a feature they cannot have.
  await expect(page.getByTestId("tools-read-webpage-row")).toHaveCount(0);
  // Regression check: the file-attach affordance is untouched by the new rows.
  await expect(page.getByTestId("tools-attach-row")).toBeVisible();
});

test("selecting a web search mode shows a removable status chip", { tag: "@ui-risk" }, async ({ page }) => {
  // The selection is pinned rather than inherited from the app default: this
  // test is about the state where NO selected model can search, and the
  // default model moved to gpt-5-6-luna, which has verified provider-native
  // search. gpt-5-4-mini is still enabled and still "unverified" in
  // lib/webSearchCapability.ts, so it is what actually produces the blocked
  // state under test.
  await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
  await page.goto("/chat?lang=en");
  // /chat opens on the welcome screen with no active conversation, where the
  // selection is DEFAULT_MODEL_ID rather than anything this fixture seeded.
  // The seeded conversation has to actually be opened for its selectedModels
  // to apply -- the same reason the "does not repeat across a new chat" test
  // below opens it.
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-web-search-row").click();
  await page.keyboard.press("Escape");

  // The chip carries the request state itself instead of echoing the menu
  // label ("Web search - Use web search"): the only selected model here is
  // gpt-5-4-mini, pinned above, which has no verified provider-native search, so the honest
  // state is "unavailable" plus a way out -- never a silent fall back to
  // answering without a search.
  const chip = page.getByTestId("web-search-mode-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-tone", "blocked");
  // The mobile chip says the same thing more tightly ("No web search") in the
  // same row of its own; the blocking notice below is unchanged in both
  // shells, so the state is never reduced to a bare icon.
  const labelVariant = await page
    .getByTestId("tool-status-chip-row")
    .getAttribute("data-label-variant");
  await expect(chip).toContainText(
    labelVariant === "compact" ? "No web search" : "Web search unavailable"
  );
  await expect(chip).not.toContainText("Use web search");

  const notice = page.getByTestId("web-search-unavailable-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Add a search-capable model");

  // The normal-state readiness line ("Search-ready N - Unsupported 0") no
  // longer exists as its own row at all.
  await expect(page.getByTestId("web-search-readiness-summary")).toHaveCount(0);

  await chip.getByRole("button", { name: "Turn off web search" }).click();
  await expect(page.getByTestId("web-search-mode-chip")).toHaveCount(0);
  await expect(page.getByTestId("web-search-unavailable-notice")).toHaveCount(0);
});

test("web search mode selection does not repeat across a new chat", { tag: "@ui-risk" }, async ({ page }) => {
  // Seeded with history on purpose. The mobile shell deliberately hides its
  // header "New chat" button while the open conversation is still empty
  // (components/chat/MobileChatShell.tsx), so driving this contract from the
  // welcome screen made the test wait on a control that is never meant to
  // exist there -- it failed deterministically on mobile-chromium while
  // passing on desktop. Starting from a non-empty conversation exercises the
  // same reset through the affordance each shell actually offers.
  await mockAuthenticatedApi(page, {
    selectedModels: ["gpt-5-4-mini"],
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
  await page.goto("/chat?lang=en");

  // Seeding history is not enough on its own: /chat opens on the welcome
  // screen with no active conversation, so the panel still reports itself
  // empty and the mobile header still hides its button. The seeded
  // conversation has to actually be opened first.
  await openRecentConversation(page);

  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-web-search-row").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("web-search-mode-chip")).toBeVisible();

  const newChatButton = page.getByRole("button", { name: "New chat" }).first();
  await expect(newChatButton).toBeVisible();
  await newChatButton.click();

  await expect(page.getByTestId("web-search-mode-chip")).toHaveCount(0);
});

test("Deep Research is gated behind login for guests", { tag: "@ui-risk" }, async ({ page }) => {
  const { prepareGuestPage } = await import("./support/app-fixtures");
  await prepareGuestPage(page, "en");
  await page.goto("/chat");

  const dismissOnboarding = page.getByRole("button", { name: "Start using Tomverse" });
  if (await dismissOnboarding.isVisible()) {
    await dismissOnboarding.click();
  }

  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-deep-research-row").click();
  // Guests never reach the setup sheet -- the click reuses the existing
  // guest sign-in prompt instead of opening a sheet with nothing usable in it.
  await expect(page.getByTestId("deep-research-confirm-start")).toHaveCount(0);
});

test("Deep Research setup sheet opens for an eligible Pro user and requires explicit confirm", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await asProPlan(page);
  await page.goto("/chat?lang=en");

  await page.getByPlaceholder("Ask anything...").fill("Compare inflation trends across regions");

  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-deep-research-row").click();

  const confirmButton = page.getByTestId("deep-research-confirm-start");
  await expect(confirmButton).toBeVisible();
  await expect(page.getByTestId("deep-research-depth-standard")).toBeVisible();
  // Never auto-starts -- closing must not have triggered a submission.
  await page.getByTestId("deep-research-cancel").click();
  await expect(confirmButton).toHaveCount(0);
});

for (const width of [320, 360, 375, 390, 430]) {
  test(`no input-row or tools-sheet control is clipped at a ${width}px viewport`, { tag: "@ui-risk" }, async ({
    page,
  }) => {
    await mockAuthenticatedApi(page);
    await asProPlan(page);
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/chat?lang=en");

    const sendButton = page.getByTestId("chat-send-button");
    await expect(sendButton).toBeVisible();
    const sendBox = await sendButton.boundingBox();
    expect(sendBox).not.toBeNull();
    if (sendBox) {
      expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(width);
      expect(sendBox.x).toBeGreaterThanOrEqual(0);
    }

    await toolsMenuTrigger(page).click();
    const webSearchRow = page.getByTestId("tools-web-search-row");
    await expect(webSearchRow).toBeVisible();
    const rowBox = await webSearchRow.boundingBox();
    expect(rowBox).not.toBeNull();
    if (rowBox) {
      expect(rowBox.x).toBeGreaterThanOrEqual(0);
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(width);
    }

    await page.getByTestId("tools-deep-research-row").click();
    const depthOption = page.getByTestId("deep-research-depth-standard");
    await expect(depthOption).toBeVisible();
    const depthBox = await depthOption.boundingBox();
    expect(depthBox).not.toBeNull();
    if (depthBox) {
      expect(depthBox.x).toBeGreaterThanOrEqual(0);
      expect(depthBox.x + depthBox.width).toBeLessThanOrEqual(width);
    }
  });
}
