import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, openModelCatalogue } from "./support/app-fixtures";

/**
 * The account settings "New chat default combination" editor
 * (docs/ui-contracts/account-model-settings.md):
 *
 *   - the lead badge sits on the first model and "Make lead" reorders;
 *   - a plan-locked model is not selectable and shows an upgrade path;
 *   - a newly added higher-cost model demands explicit recurring-cost
 *     consent before anything is sent to the server;
 *   - a save sends the combination, and the next new chat and a reload both
 *     start from it.
 */

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function expectSelectedModels(page: Page, expected: string[]) {
  await modelMenuTrigger(page).click();
  await openModelCatalogue(page);
  for (const modelId of expected) {
    await expect(
      page.locator(`[data-testid="model-option"][data-model-id="${modelId}"]`)
    ).toHaveAttribute("aria-pressed", "true");
  }
  await expect(
    page.locator('[data-testid="model-option"][aria-pressed="true"]')
  ).toHaveCount(expected.length);
  await page.getByTestId("model-picker-done").click();
  await expect(page.locator("#chat-input-popover")).toBeHidden();
}

async function startNewChat(page: Page) {
  const sidebarButton = page.getByTestId("sidebar-new-chat");
  if (await sidebarButton.isVisible()) {
    await sidebarButton.click();
    return;
  }
  const headerButton = page.getByRole("button", { name: "New Chat" });
  if (await headerButton.isVisible()) {
    await headerButton.click();
  }
}

async function openSettingsAiTab(page: Page) {
  const accountTrigger = page.getByTestId("account-menu-trigger");
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole("button", { name: "Open chat menu" }).click();
  }
  await expect(accountTrigger).toBeVisible();
  await accountTrigger.click();
  await page
    .getByTestId("account-menu")
    .getByTestId("account-settings")
    .click();
  const settings = page.getByRole("dialog", { name: "User Settings" });
  await expect(settings).toBeVisible();
  // The new-conversation combination lives on the AI personalization tab. It
  // was on "Preferences" beside theme, language and time zone -- a tab about
  // how the app looks, holding the decision about which models answer.
  //
  // Reached by test id, not by label. This test is about the combination
  // editor, and pinning it to the tab's wording made it fail when the tab was
  // renamed -- a rename this file had no reason to care about. The label
  // itself is asserted by tests/e2e/settings-information-architecture.spec.ts.
  await settings.getByTestId("settings-tab-ai").click();
  return settings;
}

test("the combination editor designates a lead, gates high-cost and plan-locked models, and persists", async ({
  page,
}) => {
  await mockAuthenticatedApi(page);
  await page.unroute("**/api/user/settings");

  // The mock holds the saved combination, exactly like the real routes:
  // POST validates nothing here but records what would be persisted, and GET
  // serves it back so a reload rebuilds from the saved state.
  let saved: string[] | null = null;
  let lastCombinationPost: Record<string, unknown> | null = null;

  await page.route("**/api/user/settings**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (Array.isArray(body.newConversationModelIds)) {
        lastCombinationPost = body;
        saved = body.newConversationModelIds as string[];
      }
      await route.fulfill(
        json({
          success: true,
          settings: {
            theme: "dark",
            language: "en",
            defaultModel: (saved ?? ["gpt-5-6-luna"])[0],
            newConversationModelIds: saved ?? ["gpt-5-6-luna"],
            timeZone: "UTC",
            timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
            timeZoneChangedAt: "2026-05-01T00:00:00.000Z",
            timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
          },
        })
      );
      return;
    }
    const lead = saved?.[0] ?? "gpt-5-6-luna";
    await route.fulfill(
      json({
        theme: "dark",
        language: "en",
        defaultModel: lead,
        defaultModelId: lead,
        newConversationModelIds: saved ?? [lead],
        modelSelectionNotice: null,
        timeZone: "UTC",
        timeZoneInitializedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangedAt: "2026-05-01T00:00:00.000Z",
        timeZoneChangeAllowedAt: "2026-05-31T00:00:00.000Z",
      })
    );
  });

  await page.goto("/chat?lang=en");
  const settings = await openSettingsAiTab(page);
  const editor = settings.getByTestId("settings-new-conversation-models");
  await expect(editor).toBeVisible();

  // The stored single-model account renders one row with the lead badge.
  const rows = editor.getByTestId("settings-combination-row");
  await expect(rows).toHaveCount(1);
  await expect(editor.getByTestId("settings-lead-model-badge")).toBeVisible();
  await expect(rows.first().locator("select")).toHaveValue("gpt-5-6-luna");
  await expect(editor.getByTestId("settings-combination-total")).toBeVisible();

  // Plan lock: the Pro-only model is not selectable on this Free account and
  // the editor offers an upgrade path instead.
  await expect(
    rows.first().locator('option[value="grok-4-5"]')
  ).toBeDisabled();
  await expect(
    editor.getByTestId("settings-combination-upgrade")
  ).toBeVisible();

  // Add a second slot and put a higher-cost (Advanced) model in it: the
  // recurring-cost consent appears and blocks the save until checked.
  await editor.getByTestId("settings-combination-add").click();
  await expect(rows).toHaveCount(2);
  await rows.nth(1).locator("select").selectOption("gpt-5-6-terra");
  const consent = editor.getByTestId("settings-high-cost-consent");
  await expect(consent).toBeVisible();

  // Make the Advanced model the lead: the badge and the first row follow.
  await editor.getByRole("button", { name: "Make lead" }).click();
  await expect(rows.first().locator("select")).toHaveValue("gpt-5-6-terra");
  await expect(rows.nth(1).locator("select")).toHaveValue("gpt-5-6-luna");
  await expect(editor.getByTestId("settings-lead-model-badge")).toBeVisible();

  // Saving without consent never reaches the server.
  await settings.getByRole("button", { name: "OK" }).click();
  await expect(settings).toBeVisible();
  expect(lastCombinationPost).toBeNull();

  await consent.check();
  await settings.getByRole("button", { name: "OK" }).click();
  await expect(settings).toBeHidden();
  expect(lastCombinationPost).toMatchObject({
    newConversationModelIds: ["gpt-5-6-terra", "gpt-5-6-luna"],
  });

  // The next new chat starts from the saved combination...
  await startNewChat(page);
  await expectSelectedModels(page, ["gpt-5-6-terra", "gpt-5-6-luna"]);

  // ...and so does a new chat after a full reload, rebuilt from GET.
  await page.reload();
  await expect(modelMenuTrigger(page)).toBeVisible();
  await startNewChat(page);
  await expectSelectedModels(page, ["gpt-5-6-terra", "gpt-5-6-luna"]);

  // Reopening settings shows the saved combination with the lead first, and
  // the already-saved higher-cost model no longer demands fresh consent.
  const reopened = await openSettingsAiTab(page);
  const reopenedRows = reopened
    .getByTestId("settings-new-conversation-models")
    .getByTestId("settings-combination-row");
  await expect(reopenedRows).toHaveCount(2);
  await expect(reopenedRows.first().locator("select")).toHaveValue(
    "gpt-5-6-terra"
  );
  await expect(
    reopened.getByTestId("settings-high-cost-consent")
  ).toBeHidden();
});
