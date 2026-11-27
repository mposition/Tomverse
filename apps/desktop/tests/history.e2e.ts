import assert from "node:assert/strict";
import { openCodeProject } from "./code-project-fixture";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { Journal } from "../../tomverse-cli/src/session.js";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { bindProjectRoot } from "../src/host/project-root";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function approve(page: Page) {
  const allow = page.getByRole("button", { name: "Allow once", exact: true });
  await expect(allow).toBeEnabled();
  try { await allow.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

test("Code deletes one confirmed local journal and keeps unsaved task evidence in memory", { timeout: 75_000 }, async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "tomverse-local-history-"));
  context.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(temporary, "project");
  const profile = join(temporary, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(root, "private.txt"), "original content");
  const gateway = await new FakeGateway({
    script(body) {
      const conversation = JSON.stringify(body.messages);
      const toolCount = fixtureOperationResults(body).length;
      if (conversation.includes("Active task")) return { fault: "hang" };
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      if (conversation.includes("Saved change") && !toolCount) return { toolCalls: [{ name: "apply_patch", args: {
        edits: [{ action: "create", path: "kept.txt", content: "Project content survives removing the task record." }],
      } }] };
      if (conversation.includes("Session-only prompt")) {
        if (!toolCount) return { toolCalls: [{ name: "apply_patch", args: {
          edits: [{ action: "update", path: "private.txt", replacements: [{ old: "original content", new: "updated content" }] }],
        } }] };
        if (toolCount === 1) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", "console.log('session-only command result')"] } }] };
      }
      return { text: "The task finished." };
    },
  }).start();
  context.after(() => gateway.stop());
  const descriptor = join(temporary, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const launch = () => electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  let app: Awaited<ReturnType<typeof launch>> | undefined = await launch();
  const { home, legacyHome } = codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: gateway.base, key: TEST_KEY });
  const sessionDirectory = (id: string) => join(home, "sessions", id);
  try {
    let page = await app.firstWindow();
    await openCodeProject(page);
    const state = () => page.evaluate(() => window.desktop.state());
    const composer = () => page.getByRole("textbox", { name: "Code request" });
    const send = () => page.getByRole("button", { name: "Send Code request" });
    const newTask = () => page.getByRole("button", { name: "New task", exact: true });
    const actions = () => page.getByLabel("Code task actions");
    const deleteAction = () => page.getByRole("button", { name: "Delete local task", exact: true });

    await composer().fill("Saved change");
    const [savedApproval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send().click()]);
    await approve(savedApproval);
    await expect(page.getByRole("button", { name: "Saved change", exact: true })).toBeVisible();
    const target = (await state()).task!;
    assert.ok(target.savedLocally && target.id);
    assert.ok((await readdir(join(sessionDirectory(target.id), "backups"))).length > 0);

    await composer().fill("Another saved task");
    await send().click();
    await expect(page.getByRole("button", { name: "Another saved task", exact: true })).toBeVisible();
    const otherId = (await state()).task!.id!;
    const otherCheckpoint = await readFile(join(sessionDirectory(otherId), "session.json"));

    await page.getByLabel("Model and reasoning effort").click();
    await page.getByLabel("Model", { exact: true }).selectOption("fake-coder");
    await page.getByLabel("Model and reasoning effort").click();
    await composer().fill("Active task");
    await send().click();
    await expect(page.getByRole("button", { name: "Stop Code task" })).toBeVisible();
    await expect.poll(async () => Boolean((await state()).task?.id)).toBe(true);
    const activeId = (await state()).task!.id!;
    assert.equal(await page.evaluate((id) => window.desktop.deleteHistory(id), activeId), "unavailable");
    assert.equal(await page.evaluate((id) => window.desktop.deleteHistory(id), target.id), "unavailable");
    await page.getByRole("button", { name: "Stop Code task" }).click();
    await expect(newTask()).toBeEnabled();
    assert.ok(await readFile(join(sessionDirectory(activeId), "session.json")));

    await page.getByRole("button", { name: "Saved change", exact: true }).click();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await actions().click();
    await deleteAction().click();
    await expect(actions()).toBeVisible();
    assert.ok(await readFile(join(sessionDirectory(target.id), "session.json")));

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const lease = Journal.open(home, target.id);
    try {
      await actions().click();
      await deleteAction().click();
      await expect(page.getByRole("alert")).toHaveText("This task is open in another Code process.");
      assert.ok(await readFile(join(sessionDirectory(target.id), "session.json")));
    } finally { lease.release(); }

    const requestCount = gateway.requests.length;
    await actions().click();
    await deleteAction().click();
    await expect(page.getByRole("button", { name: "Saved change", exact: true })).toHaveCount(0);
    assert.equal((await state()).task, null);
    await assert.rejects(readdir(sessionDirectory(target.id)), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "kept.txt"), "utf8"), "Project content survives removing the task record.");
    assert.deepEqual(await readFile(join(sessionDirectory(otherId), "session.json")), otherCheckpoint);
    assert.equal(gateway.requests.length, requestCount);

    await page.getByRole("button", { name: "Another saved task", exact: true }).click();
    const otherDir = sessionDirectory(otherId);
    const moved = join(temporary, "original-journal");
    await app.evaluate(({ dialog }, paths) => {
      dialog.showMessageBox = async () => {
        const fs = process.getBuiltinModule("node:fs")!.promises;
        await fs.rename(paths.otherDir, paths.moved);
        await fs.symlink(paths.root, paths.otherDir, process.platform === "win32" ? "junction" : "dir");
        return { response: 1, checkboxChecked: false };
      };
    }, { root, otherDir, moved });
    try {
      assert.equal(await page.evaluate((id) => window.desktop.deleteHistory(id), otherId), "unavailable");
      assert.deepEqual(await readFile(join(moved, "session.json")), otherCheckpoint);
      assert.equal(await readFile(join(root, "private.txt"), "utf8"), "original content");
    } finally {
      await rm(otherDir, { force: true });
      await rename(moved, otherDir);
    }
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });

    const { workspace, endpointOrigin, keyPrefix, readOnly, model, limits, tasks } = Journal.read(otherDir);
    const legacy = Journal.create(legacyHome, { workspace, endpointOrigin, keyPrefix, readOnly, model, limits });
    try {
      legacy.state.tasks.push({ ...tasks[0]!, prompt: "Legacy saved task" });
      legacy.state.status = "completed";
      legacy.commit();
    } finally { legacy.release(); }
    await openCodeProject(page);
    await page.getByRole("button", { name: "Legacy saved task", exact: true }).click();
    assert.equal(await page.evaluate((id) => window.desktop.deleteHistory(id), legacy.state.id), "deleted");
    await assert.rejects(readdir(join(legacyHome, "sessions", legacy.state.id)), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(otherDir, "session.json")), otherCheckpoint);

    const sessionNames = (await readdir(join(home, "sessions"))).sort();
    await composer().fill("Draft before opting out");
    assert.ok(await page.evaluate(() => Object.values(localStorage).includes("Draft before opting out")));
    await page.getByRole("checkbox", { name: "Save to local history" }).uncheck();
    await composer().fill("Session-only prompt");
    assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => /Draft before opting out|Session-only prompt/.test(value))), false);
    const [privateApproval] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), send().click()]);
    const [privateCommand] = await Promise.all([app.waitForEvent("window", { timeout: 10_000 }), approve(privateApproval)]);
    await approve(privateCommand);
    await expect(page.getByText("Session only", { exact: true })).toBeVisible();
    await expect(newTask()).toBeEnabled();
    const unsaved = (await state()).task!;
    assert.equal(unsaved.savedLocally, false);
    assert.ok(unsaved.id);
    assert.deepEqual((await readdir(join(home, "sessions"))).sort(), sessionNames);
    await expect(page.getByRole("button", { name: "Session-only prompt", exact: true })).toHaveCount(0);
    await expect(actions()).toHaveCount(0);
    await page.getByText("Command results · 1", { exact: true }).click();
    await page.getByText("run_command · exited · exit 0", { exact: true }).click();
    await expect(page.getByLabel("Standard output")).toContainText("session-only command result");
    await page.getByText("Changes · 1", { exact: true }).click();
    await page.getByRole("button", { name: "private.txt", exact: true }).click();
    await expect(page.getByLabel("Recorded file diff")).toContainText("updated content");
    await page.getByRole("button", { name: "Undo file edit", exact: true }).click();
    await expect.poll(() => readFile(join(root, "private.txt"), "utf8")).toBe("original content");
    assert.deepEqual((await readdir(join(home, "sessions"))).sort(), sessionNames);

    await app.close();
    app = undefined;
    app = await launch();
    page = await app.firstWindow();
    await openCodeProject(page);
    await expect(page.getByRole("button", { name: "Another saved task", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Session-only prompt", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Saved change", exact: true })).toHaveCount(0);
    await expect(composer()).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: "Save to local history" })).toBeChecked();
  } finally {
    if (app) await app.close();
  }
});
