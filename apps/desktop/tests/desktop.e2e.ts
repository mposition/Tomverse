import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { DEFAULT_MODELS, FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { cancelWindowsDialog, expectWindowsAccessibleNames } from "./windows-accessibility";

const require = createRequire(import.meta.url);
const electronPath: string = require("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));
const htmlAnswer = '<strong data-testid="model-markup-probe">The project contains a sum function.</strong>';

async function answer(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try {
    await button.click();
  } catch (error) {
    if (!page.isClosed()) throw error;
  }
}

test("Code shows only its task receipts and preserves Smart Adaptive pin and applied effort", { timeout: 60_000 }, async (context) => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-receipts-"));
  context.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(root, "marker.txt"), "This file was read after model pinning.");
  const gateway = await new FakeGateway({
    // fake-small keeps its credits and provider but gets a window a real model has: with the 6,000-token window of the stock fixture the
    // request's fixed reserve alone leaves the system prompt about 500 tokens, so any growth of that prompt makes the engine compact a
    // three-message conversation, and this test counts the task's own requests.
    models: [...DEFAULT_MODELS.map((model) => model.id === "fake-small" ? { ...model, tomverse: { ...model.tomverse, context_window_tokens: 128_000, max_output_tokens: 8_000 } } : model),
      { ...DEFAULT_MODELS[0], id: "legacy-coder", tomverse: { ...DEFAULT_MODELS[0]!.tomverse, reasoning_efforts: undefined } }],
    routedModel: "fake-small",
    script(body) {
      const conversation = JSON.stringify(body.messages);
      if (conversation.includes("Held receipt")) return { fault: "http", status: 429, code: "limit", heldReceipt: true };
      if (conversation.includes("Released receipt")) return { fault: "http", status: 400, code: "released", releasedReceipt: true };
      if (conversation.includes("No receipt")) return { fault: "http", status: 429, code: "limit" };
      if (conversation.includes("Malformed effort")) return { text: "Malformed header received.", appliedEffortHeader: "extra" };
      if (conversation.includes("Missing effort")) return { text: "Missing header received.", appliedEffortHeader: null };
      if (conversation.includes("Pin before reading") && !body.messages.some((message: { role: string }) => message.role === "tool")) {
        return { toolCalls: [{ name: "read_file", args: { path: "marker.txt" } }] };
      }
      if (conversation.includes("Pin before reading")) assert.match(conversation, /This file was read after model pinning/);
      return { text: "The request finished." };
    },
  }).start();
  context.after(() => gateway.stop());
  gateway.receipts.set("unrelated", { requestId: "unrelated", idempotencyKey: null, status: "settled", chargedCredits: 999, heldCredits: 0, modelId: "fake-coder" });
  const descriptor = join(tmp, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const application = await electron.launch({ executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 30_000 });
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const setNotificationFocus = (focused: boolean) => application.evaluate(({ BrowserWindow }, value) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.isFocused = () => value;
    }, focused);
    await application.evaluate(({ Notification }) => {
      const fixture = globalThis as typeof globalThis & { notificationBodies: Array<{ title: string; body: string }> };
      fixture.notificationBodies = [];
      Notification.prototype.show = function (this: Electron.Notification) {
        fixture.notificationBodies.push({ title: this.title, body: this.body });
      };
    });
    const notifications = () => application.evaluate(() =>
      (globalThis as typeof globalThis & { notificationBodies: Array<{ title: string; body: string }> }).notificationBodies);
    await setNotificationFocus(false);
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("ask");
    const composing = page.getByRole("textbox", { name: "Code request" });
    await composing.fill("조합 중");
    await composing.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await expect(composing).toHaveValue("조합 중");
    assert.equal(gateway.completions.length, 0);
    const select = async (model: string, effort: string) => {
      const menu = page.getByLabel("Model and reasoning effort");
      await menu.click();
      await page.getByLabel("Model", { exact: true }).selectOption(model);
      await page.getByLabel("Task reasoning effort").selectOption(effort);
      await menu.click();
    };
    const run = async (prompt: string) => {
      const view = () => page.evaluate(() => window.desktop.state());
      const previous = gateway.completions.length;
      await page.getByRole("textbox", { name: "Code request" }).fill(prompt);
      await page.getByRole("button", { name: "Send Code request" }).click();
      await expect.poll(async () => {
        const state = await view();
        return !state.busy && state.task?.title;
      }).toBe(prompt);
      return { requests: gateway.completions.slice(previous), task: (await view()).task };
    };
    await select("smart-adaptive", "high");
    const pinned = await run("Pin before reading");
    assert.deepEqual(pinned.requests.map(({ body }) => [body.model, body.tomverse_effort]), [["smart-adaptive", "high"], ["fake-small", "high"]]);
    assert.deepEqual(pinned.task?.transmission.map(({ appliedEffort, model, receipt }) => [appliedEffort, model, receipt]),
      Array.from({ length: 2 }, () => ["default", "fake-small", { status: "settled", credits: 1 }]));
    await expect(page.getByText("Requested effort · High", { exact: true })).toBeVisible();
    await expect(page.getByText("Applied effort · Default", { exact: true })).toBeVisible();
    await page.getByText("API requests · 2", { exact: true }).click();
    await expect(page.getByText("2 credits charged · 0 credits held · 0 receipts unconfirmed", { exact: true })).toBeVisible();
    await expect(page.getByText(/reported fake-small · catalog provider deepseek/)).toHaveCount(2);
    assert.deepEqual(await notifications(), []);

    const setNotifications = async (enabled: boolean) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByTestId("desktop-settings-preferences").click();
      const checkbox = page.getByRole("checkbox", { name: "Notify me when Code tasks finish" });
      await expect(checkbox).toBeChecked({ checked: !enabled });
      await checkbox.click();
      await expect(checkbox).toBeChecked({ checked: enabled });
      assert.equal(await readFile(join(profile, "code-notifications.txt"), "utf8"), enabled ? "enabled" : "disabled");
      await page.getByRole("button", { name: "Code", exact: true }).click();
    };
    await setNotifications(true);

    await select("fake-coder", "low");
    const fixed = await run("Low effort");
    assert.equal(fixed.task?.actual, "low");
    assert.equal(fixed.task?.transmission[0]?.catalogProvider, "openai");
    const backgroundNotification = { title: "Tomverse Desktop", body: "A Code task finished." };
    assert.deepEqual(await notifications(), [backgroundNotification]);
    await setNotificationFocus(true);
    assert.equal((await run("Malformed effort")).task?.actual, undefined);
    assert.deepEqual(await notifications(), [backgroundNotification]);
    await setNotifications(false);
    await setNotificationFocus(false);
    assert.equal((await run("Missing effort")).task?.actual, undefined);
    assert.deepEqual(await notifications(), [backgroundNotification]);
    await select("legacy-coder", "high");
    const legacy = await run("Legacy effort");
    assert.equal(legacy.task?.actual, "default");
    assert.equal(legacy.requests[0]?.body.tomverse_effort, undefined);
    await select("fake-small", "high");
    const unsupported = await run("Fixed unsupported effort");
    assert.equal(unsupported.requests[0]?.body.model, "fake-small");
    assert.equal(unsupported.task?.actual, "default");
    await select("fake-coder", "default");
    const defaulted = await run("Return to default");
    assert.equal(defaulted.requests[0]?.body.tomverse_effort, undefined);
    assert.equal(defaulted.task?.actual, undefined);

    for (const [prompt, receipt] of [
      ["Held receipt", { status: "held", credits: 3 }],
      ["Released receipt", { status: "released", credits: 0 }],
      ["No receipt", { status: "unknown" }],
    ] as const) {
      const outcome = await run(prompt);
      assert.equal(outcome.requests.length, 1);
      assert.deepEqual(outcome.task?.transmission[0]?.receipt, receipt);
    }
    const count = gateway.requests.length;
    await page.getByRole("button", { name: "Pin before reading", exact: true }).click();
    await expect(page.getByText("Applied effort · Default", { exact: true })).toBeVisible();
    const reopened = await page.evaluate(() => window.desktop.state());
    assert.deepEqual(reopened.task?.transmission, pinned.task?.transmission);
    assert.equal(gateway.requests.length, count);
  } finally {
    await application.close();
  }
});

test("Electron uses real approval, patch, command, history, effort and Stop over a loopback fixture", { timeout: 90_000 }, async (context) => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-test-"));
  context.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const root = join(tmp, "sample-project");
  const profile = join(tmp, "profile");
  await mkdir(root);
  await mkdir(profile);
  await mkdir(join(root, "fixtures"));
  const original = await readFile(new URL("./fixtures/sum.mjs", import.meta.url), "utf8");
  const crlfSource = Buffer.from("\ufeffstart\r\noriginal\r\nend\r\n");
  const deletedSource = Buffer.from("visible\u202etext\r\n");
  const largeDiff = Array.from({ length: 810 }, (_, index) => `line ${index + 1}\n`).join("") + "Visible final line.\n";
  await writeFile(join(root, "sum.mjs"), original);
  await writeFile(join(root, "fixtures", "marker.txt"), "Read this only when needed.");
  await writeFile(join(root, ".env"), "PRIVATE_FIXTURE=guarded");
  await writeFile(join(root, "delete-one.txt"), "Keep this file.");
  await writeFile(join(root, "delete-two.txt"), "Disposable test file.");
  await writeFile(join(root, "lines-crlf.txt"), crlfSource);
  await writeFile(join(root, "undo-deleted.txt"), deletedSource);
  const outsidePath = join(tmp, "outside.txt");
  await writeFile(outsidePath, "Outside the project.");
  await copyFile(new URL("./fixtures/check.mjs", import.meta.url), join(root, "check.mjs"));
  await writeFile(join(root, "check-failure.mjs"), 'console.error("fixture assertion failed");\nprocess.exitCode = 7;\n');
  await writeFile(join(root, "noisy-tree.mjs"), `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
const child = (kind) => spawn(process.execPath, [process.argv[1], kind], { stdio: "ignore", windowsHide: true });
if (mode === "child") {
  const leaf = child("leaf");
  writeFileSync("command-tree.json", JSON.stringify([process.ppid, process.pid, leaf.pid]));
} else if (mode !== "leaf") {
  child("child");
}
setInterval(() => {
  if (!mode && process.stdout.writableLength === 0) process.stdout.write("Output pulse ".repeat(5000) + "\\n");
}, 8);
setTimeout(() => process.exit(0), 35000).unref();
`);
  await writeFile(join(root, "AGENTS.md"), "Follow the fixture instructions.\n");
  const gateway = await new FakeGateway({
    script(body) {
      const conversation = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "user"));
      if (conversation.includes("Cancel this request") || conversation.includes("Wait while the worker exits")) return { fault: "hang" };
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      if (conversation.includes("Close while approval is pending")) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "never-created.txt", action: "create", content: "Approval required." }] } }] };
      const toolMessages = fixtureOperationResults(body);
      if (conversation.includes("Remember edits within this run")) {
        const edit = [
          { path: "memo-one.txt", action: "create", content: "First approval." },
          { path: "memo-two.txt", action: "create", content: "Remembered approval." },
          { path: "delete-one.txt", action: "delete" },
          { path: "delete-two.txt", action: "delete" },
        ][toolMessages.length];
        return edit ? { toolCalls: [{ name: "apply_patch", args: { edits: [edit] } }] } : { text: "The approvals were recorded." };
      }
      if (conversation.includes("Keep the user change during approval")) {
        return toolMessages.length ? { text: "The changed file was preserved." } :
          { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "raced.txt", action: "create", content: "Proposed change." }] } }] };
      }
      if (conversation.includes("Stop if the project changes during approval")) {
        return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "swapped.txt", action: "create", content: "Unreachable change." }] } }] };
      }
      if (conversation.includes("Apply the reversible file batch")) {
        return toolMessages.length ? { text: "The reversible batch was applied." } :
          { toolCalls: [{ name: "apply_patch", args: { edits: [
            { path: "large-new.txt", action: "create", content: largeDiff },
            { path: "lines-crlf.txt", action: "update", replacements: [{ old: "original", new: "edited" }] },
            { path: "undo-deleted.txt", action: "delete" },
          ] } }] };
      }
      if (conversation.includes("Inspect the project")) {
        if (!toolMessages.length) return { toolCalls: [{ name: "list_files", args: { path: "fixtures" } }] };
        if (toolMessages.length === 1) return { toolCalls: [{ name: "search_text", args: { pattern: "Read this only", path: "fixtures" } }] };
        if (toolMessages.length === 2) return { toolCalls: [{ name: "search_text", args: { pattern: "^(a+)+b$", path: "fixtures", regex: true } }] };
        if (toolMessages.length === 3) return { toolCalls: [{ name: "read_file", args: { path: "sum.mjs" } }] };
        return { text: htmlAnswer };
      }
      if (conversation.includes("Stop the noisy command tree")) {
        return toolMessages.length ? { text: "The stop returned." } :
          { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "noisy-tree.mjs"] } }] };
      }
      if (conversation.includes("Refuse hidden credential")) {
        return toolMessages.length ? { text: "The protected edit was declined." } : {
          toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "never-secret.txt", action: "create", content: TEST_KEY }] } }],
        };
      }
      if (!toolMessages.length) return {
        toolCalls: [{ name: "apply_patch", args: {
          edits: [{ path: "sum.mjs", action: "update", replacements: [{ old: "a - b", new: "a + b" }] }],
          explanation: "Correct the sum function.",
        } }],
      };
      if (conversation.includes("Apply the patch") && toolMessages.length === 1) return {
        toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "check.mjs"] } }],
      };
      if (conversation.includes("Apply the patch") && toolMessages.length === 2) return {
        toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "check-failure.mjs"], timeoutSeconds: 8 } }],
      };
      return { text: conversation.includes("Apply the patch") ? "The command returned." : "The patch was declined." };
    },
  }).start();
  context.after(() => gateway.stop());
  const descriptor = join(tmp, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
  const application = await electron.launch({ executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor],
    env: { ...env, PATH: root }, timeout: 30_000 });
  let closed = false;
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    const send = page.getByRole("button", { name: "Send Code request" });
    const composer = page.getByRole("textbox", { name: "Code request" });
    await expect(page.getByRole("heading", { name: "What shall we build?" })).toBeVisible();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await expect(page.getByText("sample-project", { exact: true }).first()).toBeVisible();
    assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.approvalHost]), ["undefined", "undefined"]);
    const originalRoot = join(tmp, "original-project");
    await rename(root, originalRoot);
    await mkdir(root);
    try {
      await composer.fill("Read the replaced project");
      await expect(send).toBeEnabled({ timeout: 15_000 });
      await send.click();
      await expect(page.getByRole("alert")).toContainText("The desktop host could not complete that action.");
      await expect(composer).toHaveValue("Read the replaced project");
      assert.equal(gateway.completions.length, 0);
    } finally {
      await rmdir(root);
      await rename(originalRoot, root);
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByTestId("desktop-settings-preferences").click();
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ko");
    await expect(page.getByRole("heading", { name: "Desktop 업데이트" })).toBeVisible();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("textbox", { name: "Code 요청", exact: true }).fill("Propose a rejected edit");
    const sendKorean = page.getByRole("button", { name: "Code 요청 보내기" });
    await expect(sendKorean).toBeEnabled({ timeout: 15_000 });
    const deniedWindow = application.waitForEvent("window");
    await sendKorean.click();
    const deny = await deniedWindow;
    await expect(deny.locator("html")).toHaveAttribute("lang", "ko");
    await expect(deny.getByRole("heading", { name: "Code 작업 승인" })).toBeVisible();
    await expect(deny.getByRole("heading", { name: "sum.mjs · 수정" })).toBeVisible();
    await expect(deny.getByRole("button", { name: "거부", exact: true })).toBeFocused();
    await expectWindowsAccessibleNames(application, deny, { "거부": "ControlType.Button", "한 번 허용": "ControlType.Button" });
    assert.equal(await deny.evaluate(() => typeof window.desktop), "undefined");
    await expect(deny.getByText("Correct the sum function.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "sum.mjs"), "utf8"), original);
    await answer(deny, "거부");
    await expect(page.getByText("The patch was declined.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "sum.mjs"), "utf8"), original);
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByTestId("desktop-settings-preferences").click();
    await page.getByRole("combobox", { name: "언어", exact: true }).selectOption("en");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();

    await page.getByLabel("Model and reasoning effort").click();
    await page.getByLabel("Task reasoning effort").selectOption("high");
    await page.getByLabel("Model and reasoning effort").click();
    await composer.fill("Apply the patch and run its check");
    const patchWindow = application.waitForEvent("window");
    await send.click();
    const patch = await patchWindow;
    await expect(patch.getByRole("heading", { name: "sum.mjs · update" })).toBeVisible();
    await expect(patch.getByText(/a \+ b/)).toBeVisible();
    assert.equal(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === "tomverse://desktop/approval")?.getTitle()),
    "Tomverse Code Approval");
    const requestReplay = await patch.evaluate(async () => {
      const pending = await window.approvalHost.approval();
      if (!pending) return "missing";
      return window.approvalHost.decide({ id: "2d52a755-739f-46f1-8cb4-506bbf3db123", action: "once" });
    });
    assert.equal(requestReplay, false);
    assert.equal(await readFile(join(root, "sum.mjs"), "utf8"), original);
    const [command] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), answer(patch, "Allow once")]);
    await expect(command.getByRole("heading", { name: "Exact command" })).toBeVisible();
    await expect(command.getByText("check.mjs", { exact: false }).first()).toBeVisible();
    const [failingCommand] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), answer(command, "Allow once")]);
    await expect(failingCommand.getByText("check-failure.mjs", { exact: false }).first()).toBeVisible();
    await answer(failingCommand, "Allow once");
    await expect(page.getByText("The command returned.", { exact: true })).toBeVisible();
    assert.match(await readFile(join(root, "sum.mjs"), "utf8"), /a \+ b/);
    await expect(page.getByText("Applied effort · High", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply the patch and run its check" })).toBeVisible();
    await page.getByText("API requests · 5", { exact: true }).click();
    await expect(page.getByText("Command output · 2 results", { exact: true })).toBeVisible();
    const commandResults = page.getByText("Command results · 2", { exact: true });
    await commandResults.click();
    await expect(page.getByText("1 exited successfully · 1 failed · 0 unconfirmed")).toBeVisible();
    await page.getByText("run_command · exited · exit 0", { exact: true }).click();
    await expect(page.getByLabel("Standard output")).toContainText("sum passed");
    await page.getByText("run_command · exited · exit 7", { exact: true }).click();
    await expect(page.getByLabel("Standard error")).toContainText("fixture assertion failed");
    const lastCommand = page.locator("details[open]").filter({ has: page.getByText("run_command · exited · exit 7", { exact: true }) }).last();
    await expect(lastCommand).toContainText("check-failure.mjs");
    await expect(lastCommand).toContainText("8000 ms");
    await expect(lastCommand).toContainText(root);
    await expect(lastCommand).toContainText("Environment names");
    await expect(lastCommand).toContainText(process.execPath);
    await page.getByText("Changes · 1", { exact: true }).click();
    await page.getByRole("button", { name: "sum.mjs", exact: true }).click();
    await expect(page.getByLabel("Recorded file diff")).toContainText("a + b");

    await page.getByLabel("Code mode").selectOption("ask");
    await application.evaluate(({ dialog }, { root, outsidePath, file, hidden, duplicate, folder }) => {
      dialog.showOpenDialog = async (_window: unknown, options?: Electron.OpenDialogOptions) => {
        if (options?.defaultPath !== root) throw new Error("Unexpected project picker root.");
        return { canceled: false, filePaths: options.properties?.includes("openDirectory")
          ? [folder]
          : [file, hidden, duplicate, outsidePath, file] };
      };
    }, { root, outsidePath, file: join(root, "sum.mjs"), hidden: join(root, ".env"), duplicate: join(root, "check.mjs"), folder: join(root, "fixtures") });
    const attach = page.getByLabel("Attach project files or folders");
    const draftReferences = page.getByRole("list", { name: "Project references", exact: true });
    const savedReferences = page.getByRole("list", { name: "Attached project references" });
    const requestsBeforeAttach = gateway.completions.length;
    await attach.click();
    await page.getByRole("button", { name: "Attach files", exact: true }).click();
    await expect(draftReferences.getByRole("listitem")).toHaveCount(2);
    await expect(attach).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("Some items could not be attached");
    await draftReferences.getByRole("button", { name: "Remove check.mjs" }).click();
    await expect(draftReferences.getByRole("listitem")).toHaveCount(1);
    await attach.click();
    await page.getByRole("button", { name: "Attach folders", exact: true }).click();
    await expect(draftReferences.getByRole("listitem")).toHaveCount(2);
    await expect(attach).toBeFocused();
    await expect(draftReferences).toContainText("fixtures");
    await page.getByRole("button", { name: "Open local folder" }).click();
    await expect(draftReferences.getByRole("listitem")).toHaveCount(2);
    assert.equal(gateway.completions.length, requestsBeforeAttach);

    await composer.fill("Inspect the project");
    await send.click();
    await expect(page.getByText(htmlAnswer, { exact: true })).toBeVisible();
    await expect(draftReferences).toHaveCount(0);
    await expect(savedReferences.getByRole("listitem")).toHaveCount(2);
    const firstReferenceRequest = gateway.completions[requestsBeforeAttach]?.body.messages.find((message: { role: string }) => message.role === "user");
    assert.match(firstReferenceRequest.content, /"path":"sum\.mjs","kind":"file"/);
    assert.match(firstReferenceRequest.content, /"path":"fixtures","kind":"folder"/);
    assert.doesNotMatch(firstReferenceRequest.content, /marker\.txt|check\.mjs|outside\.txt|sample-project|\.env/);
    assert.ok(gateway.completions.slice(requestsBeforeAttach).some((request) => JSON.stringify(request.body.messages).includes("fixtures/marker.txt")));
    assert.equal(await page.getByTestId("model-markup-probe").count(), 0);
    // Ask mode: the read tools, and delegate for explore subagents (read-only too; there is no worker where nothing can change).
    assert.deepEqual(gateway.completions.at(-1)?.body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
      ["delegate", "list_files", "read_file", "search_text"]);
    assert.ok(gateway.completions.slice(requestsBeforeAttach).some((request) =>
      request.body.messages.some((message: { role: string; content: string }) =>
        message.role === "tool" && message.content.includes("Read this only when needed."))));
    const searchEvidence = JSON.stringify(gateway.completions.slice(requestsBeforeAttach).at(-1)?.body.messages);
    assert.match(searchEvidence, /engine\\":\\"builtin/);
    assert.match(searchEvidence, /Regex search requires ripgrep/);
    await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();
    await page.getByText("API requests · 5", { exact: true }).click();
    await expect(page.getByText("Via Tomverse Code API", { exact: true })).toBeVisible();
    await expect(page.getByText("File read · sum.mjs", { exact: true })).toBeVisible();
    await expect(page.getByText("Included project instructions", { exact: true }).first()).toBeVisible();
    const diagnosticsPath = join(tmp, "diagnostics.json");
    await application.evaluate(({ clipboard, dialog }, filePath) => {
      const fixture = globalThis as typeof globalThis & { copiedDiagnostics: string[] };
      fixture.copiedDiagnostics = [];
      clipboard.writeText = async (value) => { fixture.copiedDiagnostics.push(value); };
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, diagnosticsPath);
    await page.getByRole("button", { name: "Export diagnostics" }).click();
    await expect(page.getByText("Diagnostics saved.", { exact: true })).toBeVisible();
    const diagnostics = await readFile(diagnosticsPath, "utf8");
    assert.match(diagnostics, /"requests"/);
    assert.doesNotMatch(diagnostics, /Inspect the project|sum\.mjs|Follow the fixture instructions/);
    const copied = () => application.evaluate(() => (globalThis as typeof globalThis & { copiedDiagnostics: string[] }).copiedDiagnostics);
    assert.deepEqual(await copied(), []);
    await page.getByRole("button", { name: "Copy diagnostics" }).click();
    await expect(page.getByText("Diagnostics copied.", { exact: true })).toBeVisible();
    assert.deepEqual(await copied(), [diagnostics]);
    await page.getByLabel("Model and reasoning effort").click();
    await page.getByLabel("Model", { exact: true }).selectOption("fake-coder");
    await page.getByLabel("Model and reasoning effort").click();
    await composer.fill("Cancel this request");
    await send.click();
    await expect.poll(() => gateway.completions.some((request) => JSON.stringify(request.body).includes("Cancel this request"))).toBe(true);
    const running = await page.evaluate(() => window.desktop.state());
    assert.equal(running.busy, true, JSON.stringify({ status: running.task?.status, entries: running.task?.entries }));
    await page.getByRole("button", { name: "Stop Code task" }).click();
    await expect(page.getByRole("button", { name: "Stop Code task" })).toHaveCount(0);
    const namespace = (await readdir(join(profile, "code")))[0]!;
    const journalRoot = join(profile, "code", namespace, "sessions");
    const journals = await Promise.all((await readdir(journalRoot)).map(async (id) => JSON.parse(await readFile(join(journalRoot, id, "session.json"), "utf8"))));
    assert.equal(journals.length, 4);
    assert.ok(journals.some((journal) => journal.approvals.some((entry: { decision: string }) => entry.decision === "denied")));
    assert.ok(journals.some((journal) => journal.tools.some((entry: { output?: { exitCode?: number } }) => entry.output?.exitCode === 0)));
    assert.ok(journals.some((journal) => journal.status === "unknown_outcome" || journal.status === "cancelled"));
    assert.ok(gateway.completions.some((request) => request.body.tomverse_effort === "high"));
    assert.deepEqual(journals.find((journal) => journal.tasks[0].prompt === "Inspect the project")?.tasks[0].references,
      [{ path: "sum.mjs", kind: "file" }, { path: "fixtures", kind: "folder" }]);

    await page.getByRole("button", { name: "Inspect the project", exact: true }).click();
    await expect(savedReferences.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("list", { name: "Task conversation" })).not.toContainText("workspace-relative path identifiers");
    await page.getByRole("button", { name: "Apply the patch and run its check" }).click();
    await expect(page.getByText("The command returned.", { exact: true })).toBeVisible();
    await commandResults.click();
    await page.getByText("run_command · exited · exit 7", { exact: true }).click();
    await expect(page.getByLabel("Standard error")).toContainText("fixture assertion failed");
    await writeFile(join(root, "sum.mjs"), "export const userEdit = true;\n");
    await page.getByText("Changes · 1", { exact: true }).click();
    await page.getByRole("button", { name: "sum.mjs", exact: true }).click();
    await expect(page.getByText(/File changed since this edit/)).toBeVisible();
    await expect(page.getByLabel("Recorded file diff")).toContainText("a + b");
    await expect(page.getByRole("button", { name: "Undo file edit" })).toHaveCount(0);
    await page.getByRole("button", { name: "Use light theme" }).click();
    assert.equal(await page.locator(".rail").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(10, 16, 32)");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(870, 500));
    const bottom = await page.getByRole("form", { name: "Code composer" }).evaluate((element) => innerHeight - element.getBoundingClientRect().bottom);
    assert.ok(bottom > 0 && bottom <= 20, `composer gap: ${bottom}`);
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByTestId("desktop-settings-preferences").click();
    await expect(page.getByRole("heading", { name: "Desktop updates" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check for updates" })).toBeDisabled();

    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByLabel("Code mode").selectOption("agent");
    await composer.fill("Apply the reversible file batch");
    await expect(send).toBeEnabled();
    const [batchApproval] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(batchApproval.getByRole("heading", { name: "undo-deleted.txt · delete" })).toBeVisible();
    await answer(batchApproval, "Allow once");
    await expect(page.getByText("The reversible batch was applied.")).toBeVisible();
    assert.deepEqual(await readFile(join(root, "lines-crlf.txt")), Buffer.from("\ufeffstart\r\nedited\r\nend\r\n"));
    await assert.rejects(readFile(join(root, "undo-deleted.txt")), { code: "ENOENT" });
    if (process.platform === "win32") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByTestId("desktop-settings-preferences").click();
      await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("de");
      await page.getByRole("button", { name: "Code", exact: true }).click();
      await expect(page.getByRole("group", { name: "Modellantwort" })).toContainText("The reversible batch was applied.");
      await page.getByText("Änderungen · 3", { exact: true }).click();
      await page.getByRole("button", { name: "large-new.txt", exact: true }).click();
      const undo = page.getByRole("button", { name: "Dateibearbeitung rückgängig machen", exact: true });
      await expect(undo).toBeEnabled();
      await expectWindowsAccessibleNames(application, page, { "Dateibearbeitung rückgängig machen": "ControlType.Button" });
      await Promise.all([
        cancelWindowsDialog(application, "Code-Bearbeitung rückgängig machen", "Abbrechen"),
        undo.click(),
      ]);
      await expect(undo).toBeFocused();
      assert.equal(await readFile(join(root, "large-new.txt"), "utf8"), largeDiff);
      await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
      await page.getByTestId("desktop-settings-preferences").click();
      await page.getByRole("combobox", { name: "Sprache", exact: true }).selectOption("en");
      await page.getByRole("button", { name: "Code", exact: true }).click();
    }
    await page.getByText("Changes · 3", { exact: true }).click();
    await page.getByRole("button", { name: "large-new.txt", exact: true }).click();
    const fileDiff = page.getByLabel("Recorded file diff");
    const undoEdit = page.getByRole("button", { name: "Undo file edit", exact: true });
    await expect(fileDiff).toBeVisible();
    await expect(fileDiff).not.toContainText("Visible final line.");
    await page.getByRole("button", { name: /Show all lines/ }).click();
    await expect(fileDiff).toContainText("Visible final line.");
    await application.evaluate(({ dialog }) => {
      let attempts = 0;
      dialog.showMessageBox = async () => ({ response: attempts++ === 0 ? 0 : 1, checkboxChecked: false });
    });
    await undoEdit.click();
    await expect(undoEdit).toBeEnabled();
    assert.equal(await readFile(join(root, "large-new.txt"), "utf8"), largeDiff);
    await undoEdit.click();
    await expect(page.getByText("File edit undone.", { exact: true })).toBeVisible();
    await assert.rejects(readFile(join(root, "large-new.txt")), { code: "ENOENT" });
    await expect(fileDiff).toBeVisible();
    await application.evaluate(({ dialog }, path) => {
      dialog.showMessageBox = async () => {
        process.getBuiltinModule("node:fs")!.writeFileSync(path, "Another editor saved this file.");
        return { response: 1, checkboxChecked: false };
      };
    }, join(root, "lines-crlf.txt"));
    await page.getByRole("button", { name: "lines-crlf.txt", exact: true }).click();
    await undoEdit.click();
    await expect(page.getByText(/The file changed before undo/)).toBeVisible();
    assert.equal(await readFile(join(root, "lines-crlf.txt"), "utf8"), "Another editor saved this file.");
    await writeFile(join(root, "lines-crlf.txt"), Buffer.from("\ufeffstart\r\nedited\r\nend\r\n"));
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole("button", { name: "lines-crlf.txt", exact: true }).click();
    await undoEdit.click();
    await expect(page.getByText("File edit undone.", { exact: true })).toBeVisible();
    assert.deepEqual(await readFile(join(root, "lines-crlf.txt")), crlfSource);
    await page.getByRole("button", { name: "undo-deleted.txt", exact: true }).click();
    await expect(fileDiff).toContainText("\\u{202e}");
    await undoEdit.click();
    await expect(page.getByText("File edit undone.", { exact: true })).toBeVisible();
    assert.deepEqual(await readFile(join(root, "undo-deleted.txt")), deletedSource);
    await page.getByRole("button", { name: "Inspect the project", exact: true }).click();
    await expect(page.getByText(htmlAnswer, { exact: true })).toBeVisible();
    await page.getByRole("complementary", { name: "History" }).getByRole("button", { name: "Apply the reversible file batch" }).click();
    await page.getByText("Changes · 3", { exact: true }).click();
    await page.getByRole("button", { name: "undo-deleted.txt", exact: true }).click();
    await expect(fileDiff).toContainText("\\u{202e}");
    await expect(undoEdit).toHaveCount(0);

    await page.getByLabel("Code mode").selectOption("agent");
    await composer.fill("Refuse hidden credential");
    await send.click();
    await expect(page.getByText("The protected edit was declined.", { exact: true })).toBeVisible();
    await assert.rejects(readFile(join(root, "never-secret.txt")), { code: "ENOENT" });
    assert.ok(!(await page.locator("main").innerText()).includes(TEST_KEY));
    await expect(page.getByRole("button", { name: "New task" })).toBeEnabled();

    await composer.fill("Stop the noisy command tree");
    const [noisyCommand] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(noisyCommand.getByRole("heading", { name: "Exact command" })).toBeVisible();
    await answer(noisyCommand, "Allow once");
    const treePath = join(root, "command-tree.json");
    await expect.poll(async () => (await readFile(treePath, "utf8").catch(() => "")).length).toBeGreaterThan(0);
    const tree: number[] = JSON.parse(await readFile(treePath, "utf8"));
    assert.equal(tree.length, 3);
    assert.ok(tree.every((pid) => Number.isInteger(pid) && pid > 0));
    await expect(page.getByText(/stdout · .*Output pulse/).first()).toBeVisible();
    await page.getByRole("button", { name: "Stop Code task" }).click();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 25_000 });
    for (const pid of tree) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await page.getByText("Command results · 1", { exact: true }).click();
    await page.getByText(/run_command · cancelled/).click();
    await expect(page.getByText(/standard output bytes omitted/)).toBeVisible();

    await composer.fill("Wait while the worker exits");
    await send.click();
    const countCrashRequests = () => gateway.completions.filter((request) => JSON.stringify(request.body).includes("Wait while the worker exits")).length;
    await expect.poll(countCrashRequests).toBe(1);
    await application.evaluate(({ app }) => {
      const runtime = app.getAppMetrics().find((item) => item.type === "Utility" && (item.name === "Tomverse Code Runtime" || item.serviceName === "Tomverse Code Runtime"));
      if (!runtime) throw Error("No test Code worker was found.");
      process.kill(runtime.pid);
    });
    await expect(page.getByText("Outcome unconfirmed", { exact: true })).toBeVisible();
    assert.equal(countCrashRequests(), 1);
    await composer.fill("Remember edits within this run");
    await expect(send).toBeEnabled();
    const [initialApproval] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(initialApproval.getByRole("heading", { name: "memo-one.txt · create" })).toBeVisible();
    const previousId = await initialApproval.evaluate(async () => (await window.approvalHost.approval())?.id);
    assert.ok(previousId);
    const [firstDelete] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), answer(initialApproval, "Allow for this run")]);
    await expect(firstDelete.getByRole("heading", { name: "delete-one.txt · delete" })).toBeVisible();
    await expect(firstDelete.getByRole("button", { name: "Allow for this run" })).toHaveCount(0);
    assert.equal(await readFile(join(root, "memo-two.txt"), "utf8"), "Remembered approval.");
    const stale = await firstDelete.evaluate((id) => window.approvalHost.decide({ id, action: "once" }), previousId);
    assert.equal(stale, false);
    const rememberDelete = await firstDelete.evaluate(async () => {
      const current = await window.approvalHost.approval();
      return current && window.approvalHost.decide({ id: current.id, action: "run" });
    });
    assert.equal(rememberDelete, false);
    const [secondDelete] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), answer(firstDelete, "Deny")]);
    await expect(secondDelete.getByRole("heading", { name: "delete-two.txt · delete" })).toBeVisible();
    await expect(secondDelete.getByRole("button", { name: "Allow for this run" })).toHaveCount(0);
    await answer(secondDelete, "Allow once");
    await expect(page.getByText("The approvals were recorded.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "delete-one.txt"), "utf8"), "Keep this file.");
    await assert.rejects(readFile(join(root, "delete-two.txt")), { code: "ENOENT" });

    await composer.fill("Keep the user change during approval");
    await expect(send).toBeEnabled();
    const [changedFile] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(changedFile.getByRole("heading", { name: "raced.txt · create" })).toBeVisible();
    await writeFile(join(root, "raced.txt"), "User change.");
    await answer(changedFile, "Allow once");
    await expect(page.getByText("The changed file was preserved.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "raced.txt"), "utf8"), "User change.");

    await composer.fill("Stop if the project changes during approval");
    await expect(send).toBeEnabled();
    const [swappedProject] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(swappedProject.getByRole("heading", { name: "swapped.txt · create" })).toBeVisible();
    await rename(root, originalRoot);
    await mkdir(root);
    try {
      const calls = gateway.completions.length;
      await answer(swappedProject, "Allow once");
      await expect.poll(() => page.evaluate(async () => (await window.desktop.state()).busy)).toBe(false);
      assert.equal(gateway.completions.length, calls);
      await assert.rejects(readFile(join(root, "swapped.txt")), { code: "ENOENT" });
      await assert.rejects(readFile(join(originalRoot, "swapped.txt")), { code: "ENOENT" });
    } finally {
      await rmdir(root);
      await rename(originalRoot, root);
    }

    await composer.fill("Close while approval is pending");
    await expect(send).toBeEnabled();
    const [pending] = await Promise.all([application.waitForEvent("window", { timeout: 10_000 }), send.click()]);
    await expect(pending.getByRole("heading", { name: "never-created.txt · create" })).toBeVisible();
    await application.close();
    closed = true;
    await assert.rejects(readFile(join(root, "never-created.txt")), { code: "ENOENT" });
  } finally {
    if (!closed) await application.close();
  }
});
