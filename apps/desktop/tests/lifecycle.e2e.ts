import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { chooseCodeModel } from "./code-model-picker";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const execFileAsync = promisify(execFile);

test("Code retains one run across view changes and recovers evidence after suspend and process exit", { timeout: 80_000 }, async (context) => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-lifecycle-"));
  context.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  const gateway = await new FakeGateway({
    script(body) {
      return JSON.stringify(body.messages).includes("Offline transport") ? { fault: "drop_unrecorded" } : { fault: "hang" };
    },
  }).start();
  context.after(() => gateway.stop());
  const descriptor = join(tmp, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const launch = () => electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 25_000 });
  let application: Awaited<ReturnType<typeof launch>> | undefined = await launch();
  const open = async (page: Page) => {
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("ask");
    await chooseCodeModel(page, { model: "fake-coder" });
  };
  const start = async (page: Page, prompt: string, expectedCount: number) => {
    await page.getByRole("textbox", { name: "Code request" }).fill(prompt);
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length).toBe(expectedCount);
  };
  try {
    let page = await application.firstWindow();
    await open(page);
    await start(page, "Retain the running task", 1);
    const initial = await page.evaluate(() => window.desktop.state());
    assert.ok(initial.busy && initial.task?.id);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()), true);
    assert.equal((await page.evaluate(() => window.desktop.state())).task?.id, initial.task.id);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
    const nav = page.getByRole("navigation", { name: "Workspaces" });
    await nav.getByRole("button", { name: "Chat", exact: true }).click();
    await nav.getByRole("button", { name: "Code", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Stop Code task" })).toBeVisible();
    assert.equal((await page.evaluate(() => window.desktop.state())).task?.id, initial.task.id);
    assert.equal(gateway.completions.length, 1);

    await application.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
    await expect(page.getByRole("button", { name: "Stop Code task" })).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.desktop.state())).task?.status, "stopped");
    await assert.rejects(page.evaluate((model) => window.desktop.start({ prompt: "Blocked before wake", model, mode: "ask", effort: "default" }), initial.models[0]!.id));
    await application.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    assert.equal(gateway.completions.length, 1);

    await application.context().setOffline(true);
    await page.getByRole("textbox", { name: "Code request" }).fill("Offline transport");
    await expect(page.getByRole("button", { name: "Send Code request" })).toBeDisabled();
    await application.context().setOffline(false);
    await start(page, "Offline transport", 2);
    await expect(page.getByText("Outcome unconfirmed", { exact: true })).toBeVisible();

    await start(page, "Interrupted by main process exit", 3);
    const main = application.process();
    assert.ok(main.pid);
    const died = Promise.all([once(main, "exit"), application.waitForEvent("close")]);
    if (process.platform === "win32") {
      // Leave the journal mid-request while releasing the fixture's Chromium profile handles.
      await execFileAsync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(main.pid), "/T", "/F"], { windowsHide: true });
    } else assert.equal(main.kill("SIGKILL"), true);
    await died;
    application = undefined;

    application = await launch();
    page = await application.firstWindow();
    await open(page);
    await page.getByRole("button", { name: "Interrupted by main process exit", exact: true }).click();
    await expect(page.getByText("Outcome unconfirmed", { exact: true })).toBeVisible();
    assert.equal(gateway.completions.length, 3);

    await start(page, "Graceful app quit", 4);
    const closed = application.waitForEvent("close");
    await application.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await closed;
    application = undefined;

    application = await launch();
    page = await application.firstWindow();
    await open(page);
    await page.getByRole("button", { name: "Graceful app quit", exact: true }).click();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    assert.equal(gateway.completions.length, 4);

    await start(page, "Graceful window close", 5);
    const windowClosed = application.waitForEvent("close");
    await application.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0]?.close()); });
    await windowClosed;
    application = undefined;

    application = await launch();
    page = await application.firstWindow();
    await open(page);
    await page.getByRole("button", { name: "Graceful window close", exact: true }).click();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    assert.equal(gateway.completions.length, 5);
  } finally {
    if (application) await application.close();
  }
});
