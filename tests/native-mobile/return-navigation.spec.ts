import { expect, test } from "@playwright/test";
import { selectProduct } from "./workspaceNavigation";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tomverse-language", "en"));
  await page.route("https://tomverse.app/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Tomverse", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeEnabled();
});

for (const product of ["chat", "review"] as const) {
  test(`${product} history returns through the header without a duplicate exit row`, async ({ page }) => {
    await selectProduct(page, product);
    await page.getByRole("textbox").fill("Keep this unsent question");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await expect(page.locator(".history-scroll > .workspace-return")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Return to conversation", exact: true })).toBeInViewport();
    await expect(page.getByTestId("product-switcher")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`${product}-history.png`) });
    await page.getByRole("button", { name: "Return to conversation", exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveValue("Keep this unsent question");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await page.getByRole("button", { name: "Tomverse home", exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveValue("Keep this unsent question");
    const center = await page.locator(".brand-lockup").evaluate(node => { const box = node.getBoundingClientRect(); return box.x + box.width / 2; });
    expect(center).toBeCloseTo(195, 0);
  });
}

test("settings and account details have a global exit that preserves the draft", async ({ page }) => {
  await page.getByRole("textbox").fill("Keep my draft while changing settings");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await page.getByTestId("native-settings-tab-ai").click();
  await dialog.getByRole("button", { name: "Account memory", exact: true }).click();
  await dialog.getByRole("button", { name: "Return to conversation", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveValue("Keep my draft while changing settings");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("native-settings-tab-data").click();
  await dialog.getByRole("button", { name: "Your account data", exact: true }).click();
  await page.getByRole("dialog", { name: "Your account data", exact: true }).getByRole("button", { name: "Return to conversation", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Keep my draft while changing settings");
});
