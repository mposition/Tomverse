import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { remotePath } from "../../tomverse-cli/tests/remote-fixture.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktop = resolve(fileURLToPath(new URL("../", import.meta.url)));
const fakeSsh = fileURLToPath(new URL("../../tomverse-cli/tests/fake-ssh.mjs", import.meta.url));

/** The approval window closes as the click lands, so a closed page after the click is the expected end. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

test("a remote project over SSH: off until switched on, a connection test names what is wrong, the task reads and edits the other machine after an approval that names it, and what a local folder needs is not offered", { timeout: 180_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-desktop-remote-"));
  const root = join(temp, "local-project");
  const profile = join(temp, "profile");
  const machine = join(temp, "the-other-machine", "app");
  const descriptor = join(temp, "fixture.json");
  const control = join(temp, "control.json");
  const log = join(temp, "ssh-log.jsonl");
  await Promise.all([mkdir(root), mkdir(profile), mkdir(join(machine, "src"), { recursive: true })]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(join(machine, "src", "app.ts"), "export const greeting = \"hello\";\n");
  await writeFile(join(machine, "AGENTS.md"), "Remote project rules.\n");
  await writeFile(control, "{}");
  await writeFile(log, "");
  await writeFile(join(root, "local-only.txt"), "this folder is on this computer\n");
  const remoteFolder = remotePath(machine);
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body).length;
      if (results === 0) return { toolCalls: [{ name: "read_file", args: { path: "src/app.ts" } }] };
      if (results === 1) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "src/app.ts", action: "update", replacements: [{ old: "hello", new: "hello from afar" }] }], explanation: "Change the greeting" } }] };
      if (results === 2) return { toolCalls: [{ name: "run_command", args: { argv: ["sh", "-c", "cat src/app.ts"] } }] };
      return { text: "The greeting now says hello from afar." };
    },
  }).start();
  await writeFile(descriptor, JSON.stringify({
    root, profile, endpoint: gateway.base, key: TEST_KEY,
    sshFixture: { file: process.execPath, args: [fakeSsh, `--fake-control=${control}`, `--fake-log=${log}`] },
  }));
  const app = await electron.launch({ executablePath, args: [desktop, "--desktop-fixture", descriptor], timeout: 25_000 });
  try {
    const page = await app.firstWindow();

    // Off by default: the start screen offers nothing remote.
    await expect(page.getByTestId("remote-picker-button")).toHaveCount(0);
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    const section = page.getByTestId("remote-project");
    await expect(section.getByRole("heading", { name: "Remote project (SSH)" })).toBeVisible();
    await expect(section.getByText("never asks for or stores a password, a passphrase or a key", { exact: false })).toBeVisible();
    await expect(section.getByTestId("remote-switch")).not.toBeChecked();
    await expect(section.getByTestId("remote-destination")).toHaveCount(0);
    // The main process refuses what the switch has not allowed, whatever a window sends.
    const refused = await page.evaluate(() => window.desktop.remoteProject({ action: "test", target: { destination: "devbox", folder: "/srv/app" } }));
    assert.equal(refused.result?.ok, false);
    assert.equal((await readFile(log, "utf8")).trim(), "", "no ssh was started while the switch was off");

    await section.getByTestId("remote-switch").check();
    await expect(section.getByTestId("remote-destination")).toBeVisible();

    // The connection test says what is wrong, in words that say what to do, without asking for a password.
    await section.getByTestId("remote-folder").fill(remoteFolder);
    await section.getByTestId("remote-destination").fill("badauth");
    await section.getByTestId("remote-test").click();
    const result = section.getByTestId("remote-result");
    await expect(result).toHaveAttribute("data-failure", "auth");
    await expect(result).toContainText("The app never asks for them");
    await section.getByTestId("remote-destination").fill("newhost");
    await section.getByTestId("remote-test").click();
    await expect(result).toHaveAttribute("data-failure", "host-key");
    await expect(result).toContainText("never accepts an unknown host");
    await section.getByTestId("remote-destination").fill("nohost");
    await section.getByTestId("remote-test").click();
    await expect(result).toHaveAttribute("data-failure", "name-not-found");
    await section.getByTestId("remote-destination").fill("devbox");
    await section.getByTestId("remote-folder").fill(`${remoteFolder}/missing`);
    await section.getByTestId("remote-test").click();
    await expect(result).toHaveAttribute("data-failure", "folder-missing");
    await section.getByTestId("remote-folder").fill("not/absolute");
    await section.getByTestId("remote-test").click();
    await expect(result).toHaveAttribute("data-failure", "invalid-target");
    await section.getByTestId("remote-destination").fill("-oProxyCommand=calc");
    await section.getByTestId("remote-folder").fill(remoteFolder);
    await section.getByTestId("remote-test").click();
    await expect(result).toHaveAttribute("data-failure", "invalid-target");
    // Nothing that looks like an option ever reached ssh.
    for (const line of (await readFile(log, "utf8")).split("\n").filter(Boolean)) assert.doesNotMatch(JSON.parse(line).destination, /^-/);
    await section.getByTestId("remote-destination").fill("devbox");
    await section.getByTestId("remote-test").click();
    await expect(result).toHaveAttribute("data-ok", "true");

    // The command sandbox is on for this computer: a remote project says its commands are outside it.
    await page.evaluate(() => window.desktop.codeSandbox({ action: "set-mode", mode: "workspace-write" }));
    await page.getByRole("button", { name: "Close", exact: true }).first().click();

    // Open it from the start screen.
    await page.getByTestId("remote-picker-button").click();
    const picker = page.locator(".remote-picker");
    await picker.getByTestId("remote-destination").fill("devbox");
    await picker.getByTestId("remote-folder").fill(remoteFolder);
    await picker.getByTestId("remote-open").click();
    const status = page.getByTestId("remote-status");
    await expect(status).toBeVisible();
    await expect(status.getByTestId("remote-state")).toHaveText("Connected");
    await expect(status).toContainText("devbox");
    await expect(status.getByTestId("remote-sandbox-note")).toContainText("outside it");
    await expect(status.getByTestId("remote-hidden-panels")).toBeVisible();
    // What needs a folder of this computer is not offered.
    const opened = await page.evaluate(() => window.desktop.state());
    assert.equal(opened.remote?.label, "devbox");
    assert.equal(opened.codeTerminal?.available, false);
    await expect(page.locator(".code-attach-menu")).toHaveCount(0);

    // The task works on the other machine.
    await page.getByRole("textbox", { name: "Code request" }).fill("Change the greeting");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 20_000 }), page.getByRole("button", { name: "Send Code request" }).click()]);
    await expect(approval.getByTestId("approval-remote")).toBeVisible();
    await expect(approval.getByTestId("approval-remote-target")).toHaveText("devbox");
    await expect(approval.getByText("outside the command sandbox", { exact: false })).toBeVisible();
    await expect(approval.getByText("hello from afar", { exact: false }).first()).toBeVisible();
    assert.equal(await readFile(join(machine, "src", "app.ts"), "utf8"), "export const greeting = \"hello\";\n", "nothing is written before the approval");
    const nextWindow = app.waitForEvent("window", { timeout: 20_000 });
    await press(approval, "Allow once");
    const command = await nextWindow;
    await expect(command.getByTestId("approval-remote-target")).toHaveText("devbox");
    await expect(command.getByText("cat src/app.ts", { exact: false }).first()).toBeVisible();
    await press(command, "Allow once");
    await expect(page.getByText("The greeting now says hello from afar.", { exact: true })).toBeVisible({ timeout: 30_000 });

    assert.equal(await readFile(join(machine, "src", "app.ts"), "utf8"), "export const greeting = \"hello from afar\";\n");
    assert.deepEqual((await readdir(root)).sort(), ["local-only.txt"], "nothing was written to a folder of this computer");
    const seen = JSON.stringify(gateway.completions.at(-1)!.body.messages);
    assert.match(seen, /Remote project rules\./, "the remote AGENTS.md reached the model");
    assert.doesNotMatch(seen, /this folder is on this computer/);

    // The connection goes: it is shown, nothing more is done there, and a reconnect brings it back.
    await writeFile(control, JSON.stringify({ fail: "reset", times: 1 }));
    await status.getByTestId("remote-reconnect").click();
    await expect(status.getByTestId("remote-state")).toHaveText("Connection lost");
    await expect(status.getByTestId("remote-lost")).toContainText("devbox");
    await status.getByTestId("remote-reconnect").click();
    await expect(status.getByTestId("remote-state")).toHaveText("Connected");

    // Every ssh call was made without ever being able to ask a question.
    const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { options: string[][] });
    assert.ok(calls.length > 5);
    for (const call of calls) assert.ok(call.options.some(([flag, value]) => flag === "-o" && value === "BatchMode=yes"));
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await gateway.stop();
  }
});
