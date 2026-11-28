import type { Page } from "@playwright/test";

const label = "Model and reasoning effort";

/** The Code composer's model control: the button that names the choice and opens the picker. */
export const codeModelControl = (page: Page) => page.getByRole("button", { name: label, exact: true });

/** The open model picker of the Code composer. */
export const codeModelPicker = (page: Page) => page.getByRole("dialog", { name: label, exact: true });

/** Opens the picker, chooses a model (Smart Adaptive is the picker's switch) and an effort, and closes it. */
export async function chooseCodeModel(page: Page, choice: { model?: string; effort?: string }) {
  await codeModelControl(page).click();
  const picker = codeModelPicker(page);
  if (choice.model === "smart-adaptive") {
    const auto = picker.getByRole("switch", { name: "Smart Adaptive", exact: true });
    if (await auto.getAttribute("aria-checked") !== "true") await auto.click();
  } else if (choice.model) {
    await picker.locator(`[data-testid="model-option"][data-model-id="${choice.model}"]`).click();
  }
  if (choice.effort) await picker.getByLabel("Task reasoning effort").selectOption(choice.effort);
  await picker.getByTestId("model-picker-done").click();
}
