import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktop = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("the command sandbox settings show what this computer enforces, save the allowed sites, and keep both after a restart", { timeout: 90_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-code-sandbox-"));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const descriptor = join(temp, "fixture.json");
  const endpoint = new FakeGateway({ script: () => ({ text: "Unexpected request" }) });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), endpoint.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    async function launch() {
      await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: endpoint.base, key: TEST_KEY }));
      return electron.launch({ executablePath, args: [desktop, "--desktop-fixture", descriptor], timeout: 25_000 });
    }
    async function openSettings(window: Awaited<ReturnType<ElectronApplication["firstWindow"]>>) {
      await window.getByRole("button", { name: "Desktop settings" }).click();
      await window.getByRole("button", { name: "Execution and limits", exact: true }).click();
      return window.getByTestId("code-sandbox");
    }
    app = await launch();
    const page = await app.firstWindow();
    const section = await openSettings(page);
    const mode = section.getByLabel("Sandbox", { exact: true });
    await expect(section.getByRole("heading", { name: "Command sandbox" })).toBeVisible();
    await expect(mode).toHaveValue("off");

    // Off by default; what turning it on would enforce here is already shown, and it is the real platform's answer.
    const report = section.getByTestId("sandbox-enforcement");
    await expect(report.getByRole("heading")).toHaveText("If you turn it on, this computer would enforce");
    const platform = (await report.getAttribute("data-platform"))!;
    assert.ok(["windows", "macos", "linux", "other"].includes(platform));
    if (process.platform === "win32") {
      assert.equal(platform, "windows");
      await expect(section.getByTestId("sandbox-enforcement-writes")).toContainText("Enforced by the operating system");
      await expect(section.getByTestId("sandbox-enforcement-reads")).toContainText("Not blocked");
      await expect(section.getByTestId("sandbox-enforcement-network")).toContainText("Not enforced. The list below reaches programs only as proxy settings");
      await expect(section.getByTestId("sandbox-windows-marks")).toContainText("No folders are marked.");
    }

    await mode.selectOption("read-only");
    await expect(report.getByRole("heading")).toHaveText("What this computer enforces");
    assert.equal((await page.evaluate(() => window.desktop.codeSandbox({ action: "read" }))).mode, "read-only");

    // The list is edited as text; a line that is not a host name is dropped and said so.
    const domains = section.getByLabel("Allowed sites");
    await expect(domains).toHaveValue(/registry\.npmjs\.org/);
    await domains.fill("pypi.org\nnot a host\n*.corp.test");
    await section.getByRole("button", { name: "Save list" }).click();
    await expect(domains).toHaveValue("pypi.org\n*.corp.test");
    await expect(section.getByText("1 line(s) were not host names and were not saved.")).toBeVisible();
    await section.getByLabel("Allow connections to localhost").selectOption("on");
    await expect(section.getByLabel("Allow connections to localhost")).toHaveValue("on");

    // The main process validates what the screen sends: a mode that does not exist, or a path, is refused.
    await assert.rejects(page.evaluate(() => (window.desktop.codeSandbox as (input: unknown) => Promise<unknown>)({ action: "set-mode", mode: "danger-full-access" })));
    await assert.rejects(page.evaluate(() => (window.desktop.codeSandbox as (input: unknown) => Promise<unknown>)({ action: "clear-marks", path: "C:\\Users" })));

    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    const again = await openSettings(reopened);
    await expect(again.getByLabel("Sandbox", { exact: true })).toHaveValue("read-only");
    await expect(again.getByLabel("Allowed sites")).toHaveValue("pypi.org\n*.corp.test");
    await expect(again.getByLabel("Allow connections to localhost")).toHaveValue("on");
    await again.getByRole("button", { name: "Use the default list" }).click();
    await expect(again.getByLabel("Allowed sites")).toHaveValue(/registry\.npmjs\.org/);
    await again.getByLabel("Sandbox", { exact: true }).selectOption("off");
    assert.equal(endpoint.completions.length, 0);
  } finally {
    if (app) await app.close();
    await endpoint.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** The approval window closes as the click lands, so a closed page after the click is the expected end. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

test("a task's approved command runs inside the sandbox: it writes the project and cannot write outside it", { timeout: 120_000 }, async () => {
  // Under the home folder, not the temp folder: Windows keeps a low-integrity process out of %LOCALAPPDATA%, and a project is never there.
  const base = await mkdtemp(join(homedir(), ".tvsbx-e2e-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  const profile = join(base, "profile");
  const descriptor = join(base, "fixture.json");
  let seen = "";
  const gateway = await new FakeGateway({
    async script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const results = fixtureOperationResults(body);
      if (!results.length) {
        const program = "const fs=require('fs');fs.writeFileSync('inside.txt','in');try{fs.writeFileSync(process.argv[1],'out');console.log('outside-written')}catch(e){console.log('outside-denied '+e.code)}";
        return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", program, join(outside, "o.txt")] } }] };
      }
      seen = JSON.stringify(results);
      return { text: "The command finished." };
    },
  }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(outside), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    // The fixture only accepts folders under the temp folder, so the temp folder is moved under the home folder for this run.
    app = await electron.launch({ executablePath, args: [desktop, "--desktop-fixture", descriptor], timeout: 25_000, env: { ...process.env as Record<string, string>, TEMP: base, TMP: base, TMPDIR: base } });
    const page = await app.firstWindow();
    await page.evaluate(() => window.desktop.codeSandbox({ action: "set-mode", mode: "workspace-write" }));
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByRole("textbox", { name: "Code request" }).fill("Run the check");
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), page.getByRole("button", { name: "Send Code request" }).click()]);
    await press(approval, "Allow once");
    await expect(page.getByText("The command finished.", { exact: true })).toBeVisible({ timeout: 60_000 });
    const sandboxed = (await page.evaluate(() => window.desktop.codeSandbox({ action: "read" }))).enforcement;
    // Windows has a sandbox this test can build; a refusal there would be a failure, not an accepted outcome.
    if (process.platform === "win32") assert.equal(sandboxed.available, true);
    if (sandboxed.available) {
      assert.ok(existsSync(join(root, "inside.txt")), `the project folder is writable: ${seen}`);
      assert.equal(await readFile(join(root, "inside.txt"), "utf8"), "in");
      assert.equal(existsSync(join(outside, "o.txt")), false, "a folder outside the project is not");
      assert.match(seen, /outside-denied (EPERM|EACCES)/);
    } else {
      // Where the OS has no sandbox the command is refused, and nothing ran at all.
      assert.equal(existsSync(join(root, "inside.txt")), false);
      assert.match(seen, /so the command was not run/);
    }
    assert.ok(!seen.includes("outside-written"));
  } finally {
    if (app) {
      const page = await app.firstWindow().catch(() => undefined);
      await page?.evaluate(() => window.desktop.codeSandbox({ action: "clear-marks" })).catch(() => undefined);
      await app.close();
    }
    await gateway.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
