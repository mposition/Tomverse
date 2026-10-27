import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "en"); });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Tomverse" }).click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
});

test("settings match web tab order and keep details in their owning tabs", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog.locator(".settings-tabs button")).toHaveText(["Account", "Preferences", "AI assistants", "AI personalization", "Data", "Plan"]);
  await expect(dialog.getByRole("button", { name: "Email notifications", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Login methods", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("settings-account.png") });
  await page.getByTestId("native-settings-tab-preferences").click();
  const themes = dialog.getByRole("group", { name: "Theme", exact: true });
  await themes.getByRole("button", { name: "Dark Theme", exact: true }).click();
  await expect(themes.getByRole("button", { name: "Dark Theme", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dialog.getByRole("combobox")).toHaveCount(2);
  await expect(dialog.getByRole("combobox").nth(0)).toHaveAccessibleName("Language");
  await expect(dialog.getByRole("combobox").nth(1)).toHaveAccessibleName("Daily reset time zone");
  await page.screenshot({ path: test.info().outputPath("settings-preferences.png") });
  await page.getByTestId("native-settings-tab-assistants").click();
  await expect(dialog.getByText("Synthetic writing assistant", { exact: true })).toBeVisible();
  await page.getByTestId("native-settings-tab-ai").click();
  await dialog.getByRole("button", { name: "Account memory", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Memory", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Back to settings", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Account memory", exact: true })).toBeFocused();
  await page.getByTestId("native-settings-tab-data").click();
  await page.screenshot({ path: test.info().outputPath("settings-data.png") });
  await expect(dialog.locator(".settings-entry")).toHaveCount(2);
  await expect(dialog.locator(".settings-entry").nth(0)).toHaveAccessibleName("Import from another AI service");
  await dialog.getByRole("button", { name: "Your account data", exact: true }).click();
  const account = page.getByRole("dialog", { name: "Your account data", exact: true });
  await expect(account.getByRole("button", { name: "Export my data", exact: true })).toBeVisible();
  await account.getByRole("button", { name: "Back to settings", exact: true }).click();
  await expect(page.getByTestId("native-settings-tab-data")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
});

test("settings remain usable on a short screen with larger text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
  let dialogTop: number | undefined;
  for (const tab of ["account", "preferences", "assistants", "ai", "data", "plan"]) {
    await page.getByTestId(`native-settings-tab-${tab}`).click();
    expect(await page.getByRole("dialog").evaluate(node => node.scrollWidth <= node.clientWidth), `No horizontal overflow on ${tab}`).toBe(true);
    const bounds = await page.getByRole("dialog").boundingBox();
    if (dialogTop === undefined) dialogTop = bounds!.y;
    expect(bounds!.y, `Stable settings surface on ${tab}`).toBeCloseTo(dialogTop, 0);
  }
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
});

test("failed settings reads show retry instead of an empty collection", async ({ page }) => {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace("createRoot(container).render(", "transport.assistants=async()=>{throw Error('Temporarily unavailable');};createRoot(container).render(") });
  });
  await page.reload();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("native-settings-tab-assistants").click();
  await expect(page.getByRole("button", { name: /Retry|Try again/ })).toBeVisible();
  await expect(page.getByText("No saved assistants yet.")).toHaveCount(0);
});

test("personalization and memory keep their save behavior in the grouped controls", async ({ page }) => {
  await page.getByTestId("native-settings-tab-ai").click();
  await page.getByRole("combobox", { name: "Default manual model", exact: true }).selectOption("demo-b");
  await expect(page.getByRole("switch", { name: "Generate images after choosing the image action", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo:preferences")!))).toMatchObject({ defaultModel: "demo-b", imageHandoffAutoGenerate: false });
  await page.getByRole("button", { name: "Account memory", exact: true }).click();
  await page.getByRole("switch", { name: "Memory", exact: true }).uncheck();
  const style = page.getByRole("switch").nth(1);
  await expect(style).toBeDisabled();
  await expect(page.getByRole("combobox")).toBeDisabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo:memory")!))).toMatchObject({ masterEnabled: false });
  await page.getByRole("button", { name: "Back to settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Account memory", exact: true })).toBeFocused();
});
