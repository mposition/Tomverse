import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { openCodeProject } from "./code-project-fixture";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const state = (page: Page) => page.evaluate(() => window.desktop.state());
const button = (page: Page) => page.getByTestId("permission-picker");
const modes = ["read_only", "ask", "auto_review", "allow_all"] as const;

async function choose(page: Page, mode: (typeof modes)[number]) {
  await button(page).click();
  await page.getByTestId(`permission-item-${mode}`).click();
}

test("one dropdown under the composer replaces Agent / Ask / Plan: four modes, a confirmation for Allow all, shared with Settings, remembered per project", {
  timeout: 150_000,
}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tomverse-permission-picker-")));
  const alpha = join(directory, "alpha");
  const beta = join(directory, "beta");
  const profile = join(directory, "profile");
  const home = join(directory, "tomverse-home");
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(profile), mkdir(home)]);
  await writeFile(join(profile, "language.txt"), "en");
  const previousHome = process.env.TOMVERSE_HOME;
  process.env.TOMVERSE_HOME = home;
  let hold: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { hold = resolve; });
  const gateway = await new FakeGateway({
    async script(body) {
      if (JSON.stringify(body.messages).includes("Hold this request")) { await release; return { text: "Released." }; }
      return fixtureNeedsWorkPlan(body) ? fixtureInitialWorkPlan : { text: "Answered." };
    },
  }).start();
  let app: ElectronApplication | undefined;
  try {
    const descriptor = join(directory, "fixture.json");
    await writeFile(descriptor, JSON.stringify({ root: alpha, profile, endpoint: gateway.base, key: TEST_KEY, projectFolders: [alpha, beta] }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await openCodeProject(page);
    await expect(page.getByLabel("Code mode")).toHaveCount(0);

    // The default is Ask each time, and the dropdown lists the four modes with their one-line descriptions.
    await expect(button(page)).toHaveAttribute("data-mode", "ask");
    await expect(button(page)).toContainText("Ask each time");
    await button(page).click();
    for (const mode of modes) {
      const item = page.getByTestId(`permission-item-${mode}`);
      await expect(item).toBeVisible();
      await expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    await expect(page.getByTestId("permission-item-read_only")).toContainText("cannot change files or run commands");
    await expect(page.getByTestId("permission-item-ask")).toHaveAttribute("aria-checked", "true");
    // The keyboard: arrows walk the items, Escape closes and hands the focus back.
    await page.getByTestId("permission-item-ask").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("permission-item-auto_review")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("permission-item-read_only")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("permission-popover")).toHaveCount(0);
    await expect(button(page)).toBeFocused();

    // Read only: saved at once, Settings shows the same state, and the next request is a read-and-answer task.
    await choose(page, "read_only");
    await expect(button(page)).toHaveAttribute("data-mode", "read_only");
    assert.equal((await state(page)).permissions?.mode, "read_only");
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Task permissions", exact: true }).click();
    await expect(page.getByRole("radio", { name: /^Read only/ })).toBeChecked();
    await page.getByRole("radio", { name: /^Auto review/ }).check();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(button(page)).toHaveAttribute("data-mode", "auto_review");
    await choose(page, "read_only");
    const send = async (text: string) => {
      await page.getByRole("textbox", { name: "Code request", exact: true }).fill(text);
      await page.getByRole("button", { name: "Send Code request", exact: true }).click();
    };
    await send("Answer without changing anything");
    await expect(page.getByText("Answered.", { exact: true })).toBeVisible({ timeout: 30_000 });
    assert.equal((await state(page)).task?.readOnly, true);

    // Allow all asks first. Cancel changes nothing; confirming turns it on and the button says so.
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await button(page).click();
    await page.getByTestId("permission-item-allow_all").click();
    await expect(page.getByRole("alertdialog", { name: "Allow everything without asking?" })).toBeVisible();
    assert.equal((await state(page)).permissions?.mode, "read_only", "nothing changed before the confirmation");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(button(page)).toHaveAttribute("data-mode", "read_only");
    await page.getByTestId("permission-item-allow_all").click();
    await page.getByTestId("permission-allow-all-accept").click();
    await expect(button(page)).toHaveAttribute("data-mode", "allow_all");
    await expect(button(page)).toContainText("Allow all is on");
    assert.equal((await state(page)).permissions?.mode, "allow_all");

    // A mode picked in a project is that project's mode: it is back when the project is opened again, and Allow all is never carried over.
    await choose(page, "auto_review");
    await page.locator(".open-folder").click();
    await page.getByTestId("project-existing-folder").click();
    await expect(page.getByTestId("code-project-picker")).toContainText("beta");
    await expect(button(page)).toHaveAttribute("data-mode", "auto_review");
    await choose(page, "ask");
    await page.getByTestId("code-project-picker").click();
    await page.getByTestId(/^environment-project-/).filter({ hasText: "alpha" }).click();
    await expect(page.getByTestId("code-project-picker")).toContainText("alpha");
    await expect(button(page)).toHaveAttribute("data-mode", "auto_review");
    await page.getByTestId("code-project-picker").click();
    await page.getByTestId(/^environment-project-/).filter({ hasText: "beta" }).click();
    await expect(button(page)).toHaveAttribute("data-mode", "ask");
    await choose(page, "allow_all");
    await page.getByTestId("permission-allow-all-accept").click();
    await expect(button(page)).toHaveAttribute("data-mode", "allow_all");
    await page.getByTestId("code-project-picker").click();
    await page.getByTestId(/^environment-project-/).filter({ hasText: "alpha" }).click();
    await expect(page.getByTestId("code-project-picker")).toContainText("alpha");
    await expect(button(page)).toHaveAttribute("data-mode", "auto_review");

    // While a task runs, the dropdown stays usable and says when the change takes effect.
    await choose(page, "ask");
    await send("Hold this request");
    await expect.poll(async () => (await state(page)).busy).toBe(true);
    await button(page).click();
    await expect(page.getByTestId("permission-popover")).toContainText("From the next tool call of the running task.");
    await page.getByTestId("permission-item-read_only").click();
    await expect(button(page)).toHaveAttribute("data-mode", "read_only");
    assert.equal((await state(page)).permissions?.mode, "read_only");
    hold?.();
    await expect.poll(async () => (await state(page)).busy).toBe(false);

    // Auto review and Allow all are for the Tomverse API route. On any other route they stay listed, switched off, with the reason.
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    await button(page).click();
    for (const mode of ["auto_review", "allow_all"] as const) {
      const item = page.getByTestId(`permission-item-${mode}`);
      await expect(item).toHaveAttribute("aria-disabled", "true");
      await expect(item).toContainText("Only when Code uses the Tomverse API.");
    }
    await page.getByTestId("permission-item-allow_all").click({ force: true });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    assert.equal((await state(page)).permissions?.mode, "read_only");
    await page.getByTestId("permission-item-read_only").click();
    await expect(button(page)).toHaveAttribute("data-mode", "read_only");
    // Another project takes the app's mode over (beta's own), so the file the app keeps no longer says Read only.
    await page.getByTestId("code-project-picker").click();
    await page.getByTestId(/^environment-project-/).filter({ hasText: "beta" }).click();
    await expect(button(page)).toHaveAttribute("data-mode", "ask");

    // The remembered modes survive a restart.
    await app.close();
    app = await launchNativeFixture(descriptor);
    const again = await app.firstWindow();
    await again.getByRole("button", { name: "Code", exact: true }).click();
    await again.getByTestId("code-project-picker").click();
    await again.getByTestId(/^environment-project-/).filter({ hasText: "alpha" }).click();
    await expect(again.getByTestId("code-project-picker")).toContainText("alpha");
    await expect(button(again)).toHaveAttribute("data-mode", "read_only");
  } finally {
    hold?.();
    if (previousHome === undefined) delete process.env.TOMVERSE_HOME;
    else process.env.TOMVERSE_HOME = previousHome;
    await app?.close().catch(() => undefined);
    await gateway.stop();
    await removeNativeFixtureDirectory(directory);
  }
});
