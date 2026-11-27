import { expect, type Page } from "@playwright/test";

/**
 * Registers the fixture folder as a Code project and opens it: the history column's "Create project" menu, then
 * "Existing folder" (the fixture answers the folder dialog with its root, or the next of its `projectFolders`).
 */
export async function openCodeProject(page: Page) {
  await page.locator(".open-folder").click();
  await page.getByTestId("project-existing-folder").click();
  await expect(page.getByTestId("project-existing-folder")).toBeHidden();
}

/**
 * The old Agent / Ask / Plan select is the permission dropdown now. Agent is the app's default (Ask each time), and the
 * read-and-answer modes (Ask, Plan) are Read only.
 */
export async function selectCodeMode(page: Page, mode: "agent" | "ask" | "plan") {
  const target = mode === "agent" ? "ask" : "read_only";
  const picker = page.getByTestId("permission-picker");
  if ((await picker.getAttribute("data-mode")) === target) return;
  await picker.click();
  await page.getByTestId(`permission-item-${target}`).click();
  await expect(picker).toHaveAttribute("data-mode", target);
}

/**
 * Starts a plan-only task the way the window no longer can: no screen offers Plan any more (Read only replaced it), but the
 * engine still runs one, for saved conversations and continuations. Used where a test drives the engine's plan path.
 */
export async function startPlanOnly(page: Page, prompt: string, executionMode: "provider_cli" | "tomverse_api" = "provider_cli") {
  const save = await page.getByRole("checkbox", { name: "Save to local history" }).isChecked().catch(() => false);
  await page.evaluate(async ({ prompt, executionMode, saveHistory }) => {
    const state = await window.desktop.state();
    const model = state.antigravityFixtureModel ?? state.grokFixtureModel ?? state.miniMaxFixtureModel ?? state.zCodeFixtureModel ?? state.deepSeekFixtureModel
      ?? state.vibeFixtureModel ?? state.kimiFixtureModel ?? state.qwenFixtureModel ?? state.claudeFixtureModel ?? state.codexFixtureModel ?? state.models.find(({ id }) => id === "smart-adaptive")?.id ?? state.models[0]?.id;
    if (!model) throw new Error("No model to start the plan with.");
    await window.desktop.start({ prompt, model, mode: "plan", effort: "default", executionMode, saveHistory });
  }, { prompt, executionMode, saveHistory: save });
}
