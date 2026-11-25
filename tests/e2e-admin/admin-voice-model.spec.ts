import { expect, test } from "./support/console";

test("the voice model picker discovers a successor, saves it and can switch back", async ({ page, signInAs }) => {
  await signInAs("owner");
  let modelId = "gpt-live-1.1";
  const options = ["gpt-live-1.2", modelId];
  await page.route("**/api/admin/app-settings*", async route => {
    if (route.request().method() === "PATCH") {
      modelId = route.request().postDataJSON().voiceConversationModel;
      return route.fulfill({ json: { modelId } });
    }
    if (new URL(route.request().url()).searchParams.get("section") === "voice-model") {
      return route.fulfill({ json: { modelId, options, canWrite: true } });
    }
    return route.continue();
  });
  await page.goto("/admin/models?tab=defaults");
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Chat voice conversation" }) });
  await expect(card.getByText("gpt-live-1.1", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Check for new models" }).click();
  for (const option of options) {
    await card.getByRole("combobox").selectOption(option);
    await card.getByRole("button", { name: "Save model" }).click();
    await expect(card.getByRole("status")).toHaveText("Saved. New calls use this model.");
    await expect(card.locator("strong")).toHaveText(option);
  }
});
