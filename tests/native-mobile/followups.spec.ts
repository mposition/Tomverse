import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tomverse-language", "en"); });
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Tomverse" }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
});

test("Enter inserts newlines; only the send button submits; header starts the next chat", async ({ page }) => {
  const input = page.getByRole("textbox");
  await input.fill("First line"); await input.press("Enter"); await input.press("Shift+Enter");
  await input.press("Control+Enter");
  await expect(page.locator("article.user")).toHaveCount(0);
  await expect(input).toHaveValue(/^First line\n\n/);
  await input.press("End"); await input.type("Last line");
  const text = await input.inputValue();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.locator("article.user")).toHaveText(text);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.locator("article.user")).toHaveCount(0);
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect(page.locator(".conversation-row")).toContainText("First line");
  const footer = page.getByTestId("sidebar-account");
  await expect(footer.getByText("Demo User", { exact: true })).toBeVisible();
  await expect(footer.getByText("25%", { exact: true })).toBeVisible();
  await expect(footer.getByRole("button", { name: "Settings" })).toBeInViewport();
  await page.screenshot({ path: resolve(process.cwd(), "../../.tmp/native-parity/followups-sidebar.png") });
  await footer.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});

test("Easy uses server effective providers, preserves an explicit empty selection and resets on new Review", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("tomverse-native-synthetic-demo:preferences", JSON.stringify({ theme: "system", language: "en", defaultModel: "demo", timeZone: "UTC", imageHandoffAutoGenerate: false, reviewEasyEffectiveProviders: ["Synthetic B"], reviewEasyProviderOptions: ["Synthetic A", "Synthetic B", "Synthetic C"], reviewEasyMaxProviders: 3 }));
  });
  await page.getByTestId("product-switcher").selectOption("review");
  const picker = page.getByRole("button", { name: /Choose participants · Easy/ });
  await expect(picker).toBeEnabled(); await picker.click();
  await expect(page.getByRole("checkbox", { name: "Synthetic A", exact: true })).not.toBeChecked();
  const selected = page.getByRole("checkbox", { name: "Synthetic B", exact: true });
  await expect(selected).toBeChecked(); await selected.uncheck();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await picker.click(); await expect(selected).not.toBeChecked();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await picker.click(); await expect(selected).toBeChecked();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("textbox").fill("Only the configured provider");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local demo B", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tomverse-native-synthetic-demo")!)[0]);
  expect(saved.selectedModels).toEqual(["demo-b"]);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.locator("article.user")).toHaveCount(0);
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect(page.getByTestId("sidebar-account").getByText("Demo User", { exact: true })).toBeVisible();
});

test("account footer and one-tap new chat remain reachable on a short narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const settings = page.getByTestId("sidebar-account").getByRole("button", { name: "Settings" });
  await expect(settings).toBeInViewport();
  expect(await settings.evaluate(node => {
    const box = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: resolve(process.cwd(), "../../.tmp/native-parity/followups-sidebar-dark.png") });
});
