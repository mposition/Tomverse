import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

const patch = (old: string, replacement: string) => ({ toolCalls: [{ name: "apply_patch", args: {
  edits: [{ path: "sample.txt", action: "update", replacements: [{ old, new: replacement }] }],
} }] });

test("permission modes: read-only refuses a change, Allow all asks first and stays on show, and rules are added from settings", { timeout: 120_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-permission-modes-"));
  const root = join(folder, "project");
  const profile = join(folder, "profile");
  const home = join(folder, "tomverse-home");
  const descriptor = join(folder, "fixture.json");
  const previousHome = process.env.TOMVERSE_HOME;
  const gateway = await new FakeGateway({
    script(body, index) {
      if (index === 0) return fixtureInitialWorkPlan;
      if (index === 1) return patch("before", "after");
      if (index === 2) return { text: "Read-only: nothing was changed." };
      if (index === 3) return fixtureInitialWorkPlan;
      if (index === 4) return patch("before", "everything");
      return { text: "Allow all: the change was made." };
    },
  }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), mkdir(home)]);
    process.env.TOMVERSE_HOME = home;
    await writeFile(join(root, "sample.txt"), "before\n");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("agent");

    const openPermissions = async () => {
      await page.getByRole("button", { name: "Desktop settings" }).click();
      await page.getByRole("button", { name: "Task permissions", exact: true }).click();
    };
    const closeSettings = () => page.getByRole("button", { name: "Close", exact: true }).click();
    const sendRequest = async (text: string) => {
      await page.getByRole("textbox", { name: "Code request" }).fill(text);
      await page.getByRole("button", { name: "Send Code request" }).click();
    };

    // The default is to ask, and the screen says nothing extra.
    await openPermissions();
    await expect(page.getByRole("radio", { name: /^Ask each time/ })).toBeChecked();
    await expect(page.getByTestId("permission-mode-badge")).toHaveCount(0);

    // Read-only: the change is refused without an approval window, and the model is told.
    await page.getByRole("radio", { name: /^Read only/ }).check();
    await expect(page.getByRole("radio", { name: /^Read only/ })).toBeChecked();
    await closeSettings();
    await sendRequest("Change the sample file");
    await expect(page.getByText("Read-only: nothing was changed.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "before\n");
    const refused = (gateway.completions[2]?.body.messages as Array<{ role: string; content: unknown }>).filter(({ role }) => role === "tool").at(-1)?.content;
    assert.match(String(refused), /Read-only mode/);

    // A rule is added from settings and saved in the CLI's user folder.
    await openPermissions();
    await page.getByLabel("Effect").selectOption("deny");
    await page.getByLabel("Applies to").selectOption("run_command");
    await page.getByLabel("Pattern").fill("rm -rf");
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(page.getByText("Deny · Commands · rm -rf", { exact: true })).toBeVisible();
    const saved = JSON.parse(await readFile(join(home, "permissions.json"), "utf8"));
    assert.deepEqual(saved.rules, [{ effect: "deny", tool: "run_command", pattern: "rm -rf" }]);
    await page.getByRole("button", { name: /^Remove rule Deny · Commands · rm -rf$/ }).click();
    await expect(page.getByText("Deny · Commands · rm -rf", { exact: true })).toHaveCount(0);
    assert.deepEqual(JSON.parse(await readFile(join(home, "permissions.json"), "utf8")).rules, []);

    // Allow all asks for a confirmation of its own; cancelling changes nothing.
    await page.getByRole("radio", { name: /^Allow all/ }).click();
    await expect(page.getByRole("alertdialog", { name: "Allow everything without asking?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("radio", { name: /^Read only/ })).toBeChecked();
    await page.getByRole("radio", { name: /^Allow all/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Allow all", exact: true }).click();
    await expect(page.getByRole("radio", { name: /^Allow all/ })).toBeChecked();
    await closeSettings();
    await expect(page.getByTestId("permission-mode-badge")).toHaveText("Allow all is on");

    // With Allow all the change goes ahead with no approval window.
    await sendRequest("Change the sample file again");
    await expect(page.getByText("Allow all: the change was made.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "everything\n");
    assert.equal(app.windows().length, 1, "no approval window opened");
    const taskId = (await page.evaluate(() => window.desktop.state())).task?.id;
    assert.ok(taskId);
    assert.equal(await readFile(join(home, "permission-trust.json"), "utf8").catch(() => null), null);
  } finally {
    if (previousHome === undefined) delete process.env.TOMVERSE_HOME;
    else process.env.TOMVERSE_HOME = previousHome;
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
