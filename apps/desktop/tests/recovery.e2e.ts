import assert from "node:assert/strict";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { Journal, sha256 } from "../../tomverse-cli/src/session.js";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { bindProjectRoot } from "../src/host/project-root";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("Desktop checks interrupted journals through their active key and never replays requests or commands", { timeout: 70_000 }, async (context) => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-recovery-"));
  context.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(root, "checkpoint-command.mjs"), `
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync("invocations.txt", "command ran\\n");
writeFileSync("command.pid", String(process.pid));
setTimeout(() => {}, 2600);
`);
  const gateway = await new FakeGateway({
    script(body) {
      const conversation = JSON.stringify(body.messages);
      if (conversation.includes("Stream cut")) return { fault: "drop_mid_stream", text: "An interrupted answer." };
      if (conversation.includes("Status unavailable")) return { fault: "drop_unrecorded" };
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "checkpoint-command.mjs"] } }] };
    },
  }).start();
  context.after(() => gateway.stop());
  const descriptor = join(tmp, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const args = [desktopDir, "--desktop-fixture", descriptor];
  const application = await electron.launch({ executablePath: electronPath, args, timeout: 30_000 });
  const scope = codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: gateway.base, key: TEST_KEY });
  const { home } = scope;
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    await openCodeProject(page);
    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send Code request" });
    const recovery = page.getByRole("button", { name: "Check recovery" });
    const view = () => page.evaluate(() => window.desktop.state());

    await selectCodeMode(page, "ask");
    await composer.fill("Stream cut");
    await send.click();
    await expect(recovery).toBeEnabled();
    const stream = (await view()).task!;
    assert.equal(stream.status, "unknown");
    assert.equal(stream.transmission[0]?.receipt.status, "settled");
    await recovery.click();
    await expect(page.getByText("Review the recorded API requests and any file or command evidence above.")).toBeVisible();
    assert.equal((await view()).task?.status, "unknown", "a settled receipt cannot recover a lost answer");
    assert.equal(gateway.completions.length, 1);

    gateway.statusFails = true;
    await composer.fill("Status unavailable");
    await send.click();
    await expect(recovery).toBeEnabled();
    const interrupted = (await view()).task!;
    assert.equal(interrupted.transmission[0]?.receipt.status, "unknown");
    assert.equal(interrupted.transmission[0]?.receiptNotFound, undefined);
    const initialStatusReads = gateway.requests.filter(({ url }) => url.includes("/requests/status")).length;
    assert.ok(initialStatusReads > 0);

    const otherProcess = Journal.open(home, interrupted.id!);
    try {
      // A second Desktop process with the same profile must defer to the existing window.
      const second = spawn(electronPath, args, { windowsHide: true, stdio: "ignore" });
      const deadline = setTimeout(() => second.kill(), 12_000);
      try { assert.deepEqual(await once(second, "exit"), [0, null]); }
      finally { clearTimeout(deadline); }
      await recovery.click();
      await expect(page.getByText("This task is open in another Code process. Try again once it closes.")).toBeVisible();
      assert.equal(gateway.requests.filter(({ url }) => url.includes("/requests/status")).length, initialStatusReads);
    } finally {
      otherProcess.release();
    }
    gateway.statusFails = false;
    gateway.statusDelayMs = 700;
    await recovery.click();
    await expect.poll(() => gateway.requests.filter(({ url }) => url.includes("/requests/status")).length).toBeGreaterThan(initialStatusReads);
    await assert.rejects(page.evaluate(() => window.desktop.start({
      prompt: "Start during recovery", model: "fake-coder", mode: "ask", effort: "default",
    })), /Wait for the recovery check to finish/);
    await expect(page.getByText("Review the recorded API requests and any file or command evidence above.")).toBeVisible();
    gateway.statusDelayMs = 0;
    await page.getByText("API requests · 1", { exact: true }).click();
    await expect(page.getByText(/receipt unconfirmed · no matching receipt found/)).toBeVisible();
    await expect(page.getByText("Outcome unconfirmed", { exact: true })).toBeVisible();
    assert.equal(gateway.completions.length, 2);
    assert.equal(Journal.read(join(home, "sessions", interrupted.id!)).generations[0]?.lookup, "not_found");

    const saved = Journal.create(home, {
      workspace: { root: scope.root }, endpointOrigin: scope.origin, endpointBase: scope.base,
      keyPrefix: scope.keyPrefix, keyIdentity: scope.keyIdentity, readOnly: false,
      model: { requested: "fake-coder", pinned: "fake-coder", pinnedFrom: "user", contextWindowTokens: 200_000, maxOutputTokens: 8_000 },
      limits: { maxRequests: 20, timeoutMs: 900_000, commandTimeoutMs: 120_000 },
    });
    const persistedText = "bytes written before the process stopped";
    try {
      await writeFile(join(root, "interrupted.txt"), persistedText);
      await writeFile(join(root, "already-completed.txt"), persistedText);
      const change = {
        toolCallId: "local-fixture", kind: "create" as const, preimage: { sha256: null, backup: null },
        postimage: { sha256: sha256(persistedText) },
      };
      saved.state.status = "error";
      saved.state.tasks.push({ prompt: "Interrupted patch checkpoint", startedAt: new Date().toISOString(),
        requests: 0, activeMs: 0, allowance: 20, timeAllowanceMs: 900_000 });
      saved.state.tools.push({ toolCallId: "local-fixture", toolName: "apply_patch", inputDigest: "test", state: "failed", startedAt: new Date().toISOString() });
      saved.state.changes.push({ ...change, changeId: "interrupted-file", path: "interrupted.txt", state: "writing" },
        { ...change, changeId: "completed-file", path: "already-completed.txt", state: "applied" });
      saved.commit();
    } finally {
      saved.release();
    }
    await openCodeProject(page);
    await page.getByRole("button", { name: "Interrupted patch checkpoint", exact: true }).click();
    await expect(page.getByText("Outcome unconfirmed", { exact: true })).toBeVisible();
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    assert.equal(await page.evaluate(() => window.desktop.undoChange("completed-file")), "unavailable");
    assert.equal(await readFile(join(root, "already-completed.txt"), "utf8"), persistedText);
    await recovery.click();
    await expect(page.getByText(/A write of interrupted\.txt was under way: it is complete/)).toBeVisible();
    assert.equal(Journal.read(join(home, "sessions", saved.state.id)).changes[0]?.state, "applied");
    assert.equal(await readFile(join(root, "interrupted.txt"), "utf8"), persistedText);
    assert.equal(gateway.completions.length, 2);

    await selectCodeMode(page, "agent");
    await composer.fill("Interrupted command");
    const [approval] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(approval.getByRole("heading", { name: "Exact command" })).toBeVisible();
    const allow = approval.getByRole("button", { name: "Allow once", exact: true });
    await expect(allow).toBeEnabled();
    try { await allow.click(); }
    catch (error) { if (!approval.isClosed()) throw error; }
    const pidPath = join(root, "command.pid");
    await expect.poll(async () => (await readFile(pidPath, "utf8").catch(() => "")).length).toBeGreaterThan(0);
    const commandPid = Number(await readFile(pidPath, "utf8"));
    await application.evaluate(({ app }) => {
      const runtime = app.getAppMetrics().find((item) => item.type === "Utility" && (item.name === "Tomverse Code Runtime" || item.serviceName === "Tomverse Code Runtime"));
      if (!runtime) throw new Error("Code utility worker is missing.");
      process.kill(runtime.pid);
    });
    await expect(recovery).toBeEnabled();
    await recovery.click();
    await expect(page.getByText(/run_command .* had started and its outcome is unknown/)).toBeVisible();
    await expect(page.locator("footer").getByText("Outcome unconfirmed", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "invocations.txt"), "utf8"), "command ran\n");
    assert.equal(gateway.completions.length, 4);
    await expect.poll(() => {
      try { process.kill(commandPid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    }).toBe(false);

    const streamDir = join(home, "sessions", stream.id!);
    const previous = await readFile(join(streamDir, "session.prev.json"));
    await writeFile(join(streamDir, "session.json"), '{"schemaVersion":1,"id":"cut');
    await page.getByRole("button", { name: "Stream cut", exact: true }).click();
    await expect(page.getByRole("list", { name: "Task conversation" }).locator("summary"))
      .toHaveText("The saved checkpoint is unreadable. Check the session folder before retrying.");
    await expect(recovery).toHaveCount(0);
    assert.deepEqual(await readFile(join(streamDir, "session.prev.json")), previous);
    assert.equal(gateway.completions.length, 4);

    await rename(root, join(tmp, "old-project"));
    await mkdir(root);
    await openCodeProject(page);
    await expect(page.getByRole("button", { name: "Status unavailable", exact: true })).toHaveCount(0);
    assert.equal((await view()).history.length, 0);
    await page.evaluate((id) => window.desktop.openHistory(id), saved.state.id);
    assert.equal((await view()).task, null);
    assert.equal(await page.evaluate(() => window.desktop.readChange("completed-file")), null);
    assert.equal(await page.evaluate(() => window.desktop.undoChange("completed-file")), "unavailable");
  } finally {
    await application.close();
  }
});
