import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeProject, selectCodeMode, startPlanOnly } from "./code-project-fixture";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { inspectClaudeTranscript } from "../src/host/claude-transcript";
import { claudePatchToolName } from "../src/host/claude-patch-protocol";
import { codeHistoryScope } from "../src/host/history-scope";
import { nativeHistoryHome, nativeSessionDirectory, readNativeHistory, saveNativeHistory } from "../src/host/native-history";
import { bindProjectRoot } from "../src/host/project-root";
import { claudeReadScenario, writeClaudeResponse } from "./claude-message-fixture";
import { decideNativePatch, launchNativeFixture } from "./launch-native-fixture";

const binary = process.env.TOMVERSE_DESKTOP_CLAUDE_TASK_BINARY;

test("Claude Code Agent uses Desktop approval for verified edits and resumes the same task", {
  timeout: 90_000,
  skip: binary ? false : "Requires the pinned Claude Code executable and a local fixture",
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-claude-edits-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const vendor = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  const model = "claude-haiku-4-5-20251001";
  const prompt = "Apply an approved Claude patch";
  const title = "Record the approved file";
  const content = "Claude Code proposed this file through Desktop.\n";
  const outsideMarker = "The out-of-workspace fixture must not appear in a model request.";
  const patch = (path: string) => ({ name: claudePatchToolName,
    input: { explanation: "Record the fixture output.", edits: [{ path, action: "create", content }] } });
  const analyze = (objective: string) => JSON.stringify({ ...fixtureWorkAnalysis, objective });
  const operations = [
    patch("before-analysis.txt"),
    { name: "TaskCreate", input: { subject: title, description: analyze(title), activeForm: "Recording the approved file" } },
    { name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } },
    patch("accepted.txt"),
    { name: "TaskUpdate", input: { taskId: "1", status: "completed" } },
    { name: "TaskCreate", input: { subject: "Review the remaining edits", description: analyze("Review the remaining files"),
      activeForm: "Reviewing the remaining edits" } },
    { name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } },
    patch("denied.txt"),
    patch("../outside.txt"),
    { name: "Write", input: { file_path: join(root, "native-write.txt"), content: "Must never be allowed." } },
    { name: "Read", input: { file_path: join(temp, "outside-read.txt") } },
  ];
  const resumedOperations = [
    patch("stale-analysis.txt"),
    { name: "TaskUpdate", input: { taskId: "2", description: analyze("Verify the resumed edit separately") } },
    patch("changed-during-preview.txt"),
    { name: "TaskUpdate", input: { taskId: "2", status: "completed" } },
    { name: "TaskCreate", input: { subject: "Record a fresh edit", description: analyze("Verify the resumed edit separately"),
      activeForm: "Recording a fresh edit" } },
    { name: "TaskUpdate", input: { taskId: "3", status: "in_progress" } },
    patch("resumed.txt"),
    { name: "TaskUpdate", input: { taskId: "3", status: "completed" } },
  ];
  let calls = 0;
  let fixtureError: unknown;
  let requestStopped = false;
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString("utf8");
      assert.ok(!bodyText.includes(outsideMarker));
      const body = JSON.parse(bodyText);
      assert.deepEqual(body.tools.map(({ name }: { name: string }) => name).sort(),
        ["Read", "TaskCreate", "TaskUpdate", claudePatchToolName].sort());
      const index = calls++;
      if (index === 1) {
        assert.match(bodyText, /Record the read-only analysis in the active task description/);
        await assert.rejects(readFile(join(root, "before-analysis.txt")), { code: "ENOENT" });
      }
      if (index === 4) assert.match(bodyText, /approved Desktop patch was verified on disk/);
      if (index === 8 || index === 9) assert.match(bodyText, /No approved Desktop file edit was applied/);
      if (index === operations.length) {
        response.once("close", () => { requestStopped = true; });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting\n\n");
        return;
      }
      if (index > operations.length) {
        assert.match(bodyText, /Continue the stopped task from its saved context/);
        if (index === operations.length + 2) {
          assert.match(bodyText, /stale-analysis\.txt.*Record the read-only analysis in the active task description/);
          await assert.rejects(readFile(join(root, "stale-analysis.txt")), { code: "ENOENT" });
        }
        if (index === operations.length + 4) assert.match(bodyText, /The project or files changed after the preview/);
      }
      const operation = index < operations.length ? operations[index] : resumedOperations[index - operations.length - 1];
      writeClaudeResponse(response, model, index + 1, operation ?? { text: "The Claude file task is complete." });
    } catch (error) {
      fixtureError = error;
      response.writeHead(400).end();
    }
  });
  const launch = () => launchNativeFixture(descriptor);
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), vendor.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(temp, "outside-read.txt"), outsideMarker);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const claude = { executable: binary!, version: "2.1.278", model, origin: `http://127.0.0.1:${address.port}`,
      allowSavedHistory: true, allowFileEdits: true };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: vendor.base, key: TEST_KEY, claude }));
    app = await launch();
    const page = await app.firstWindow();
    const task = () => page.evaluate(() => window.desktop.state().then((state) => state.task));
    await openCodeProject(page);
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    await selectCodeMode(page, "agent");
    await expect(page.getByTestId("permission-picker")).toHaveAttribute("data-mode", "ask");
    await page.getByRole("textbox", { name: "Code request" }).fill(prompt);
    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    await expect(send).toBeDisabled();
    await page.getByRole("checkbox", { name: "Save to local history" }).check();
    const allowWindow = app.waitForEvent("window", { timeout: 15_000 }).catch(async (error) => {
      assert.ifError(fixtureError);
      throw new Error(`Claude Agent did not request approval after ${calls} model calls. Task status: ${(await task())?.status}.`, { cause: error });
    });
    const [allowed] = await Promise.all([allowWindow, send.click()]);
    await expect(allowed.getByRole("heading", { name: "accepted.txt · create" })).toBeVisible();
    await expect(page.locator(".code-task-list-item").filter({ hasText: title })).toHaveAttribute("data-status", "approval");
    const analysis = page.getByRole("region", { name: "Request analysis" });
    await expect(analysis).toContainText(title);
    await expect(allowed.getByRole("button", { name: "Allow for this run" })).toHaveCount(0);
    await assert.rejects(readFile(join(root, "accepted.txt")), { code: "ENOENT" });
    const [denied] = await Promise.all([
      app.waitForEvent("window", { timeout: 20_000 }),
      decideNativePatch(allowed),
    ]);
    await expect(denied.getByRole("heading", { name: "denied.txt · create" })).toBeVisible();
    assert.equal(await readFile(join(root, "accepted.txt"), "utf8"), content);
    await decideNativePatch(denied, "Deny");
    await expect.poll(() => fixtureError ?? calls, { timeout: 20_000 }).toBe(operations.length + 1);
    await page.getByRole("button", { name: "Stop Code task" }).click();
    await expect.poll(async () => (await task())?.status, { timeout: 15_000 }).toBe("stopped");
    assert.ok(requestStopped);
    const stopped = await task();
    assert.ok(stopped?.id && stopped.nativeSession && stopped.canResume);
    const row = stopped.plan?.items[0];
    assert.equal(row?.complete, true);
    assert.deepEqual(row.evidence.map(({ tool, state, assignment }) => [tool, state, assignment?.model]),
      [["apply_patch", "succeeded", model]]);
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await openCodeProject(restored);
    await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: prompt, exact: true }).click();
    const restoredAnalysis = restored.getByRole("region", { name: "Request analysis" });
    await expect(restoredAnalysis).toContainText("Review the remaining files");
    const changeId = stopped.changes[0]?.id;
    assert.ok(changeId);
    const diff = await restored.evaluate((id) => window.desktop.readChange(id), changeId);
    assert.match(diff?.text ?? "", /Claude Code proposed this file through Desktop/);
    assert.equal(diff?.canUndo, false);
    assert.equal(calls, operations.length + 1);
    const [outdated] = await Promise.all([
      app.waitForEvent("window", { timeout: 20_000 }), restored.getByRole("button", { name: "Resume task", exact: true }).click(),
    ]);
    await expect(outdated.getByRole("heading", { name: "changed-during-preview.txt · create" })).toBeVisible();
    const changedFile = join(root, "changed-during-preview.txt");
    const userContents = "The user's edit made during approval.\n";
    await writeFile(changedFile, userContents, { flag: "wx" });
    const [resumedApproval] = await Promise.all([app.waitForEvent("window", { timeout: 20_000 }), decideNativePatch(outdated)]);
    await expect(resumedApproval.getByRole("heading", { name: "resumed.txt · create" })).toBeVisible();
    await expect(restoredAnalysis).toContainText("Verify the resumed edit separately");
    await expect(restoredAnalysis).not.toContainText("Review the remaining files");
    await assert.rejects(readFile(join(root, "resumed.txt")), { code: "ENOENT" });
    await decideNativePatch(resumedApproval);
    await expect(restored.getByText("The Claude file task is complete.", { exact: true })).toBeVisible({ timeout: 20_000 });
    const restoredTask = () => restored.evaluate(() => window.desktop.state().then((state) => state.task));
    await expect.poll(async () => (await restoredTask())?.status).toBe("completed");
    const complete = await restoredTask();
    assert.equal(complete?.id, stopped.id);
    assert.equal(complete?.nativeSession?.threadId, stopped.nativeSession.threadId);
    assert.notEqual(complete?.nativeSession?.turnId, stopped.nativeSession.turnId);
    assert.deepEqual(complete?.changes.slice(0, 1), stopped.changes);
    assert.deepEqual(complete?.changes.map(({ path }) => path), ["accepted.txt", "resumed.txt"]);
    assert.equal(complete?.plan?.items[0]?.complete, true);
    assert.equal(await readFile(join(root, "accepted.txt"), "utf8"), content);
    assert.equal(complete?.plan?.items[1]?.completionUnverified, true);
    assert.equal(complete?.plan?.items[2]?.complete, true);
    assert.equal(await readFile(changedFile, "utf8"), userContents);
    assert.equal(await readFile(join(root, "resumed.txt"), "utf8"), content);
    for (const path of [join(root, "before-analysis.txt"), join(root, "stale-analysis.txt"), join(root, "denied.txt"),
      join(root, "native-write.txt"), join(temp, "outside.txt")]) {
      await assert.rejects(readFile(path), { code: "ENOENT" });
    }
    assert.equal(calls, operations.length + resumedOperations.length + 2);
    assert.equal(vendor.completions.length, 0);
    assert.ifError(fixtureError);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((done) => endpoint.close(() => done()));
    await vendor.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test("A recorded Claude quota pause can resume the same saved native session", {
  timeout: 60_000,
  skip: binary ? false : "Requires the pinned Claude Code executable and a development fixture",
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-claude-quota-resume-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const vendor = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  const model = "claude-haiku-4-5-20251001";
  const title = "Check the saved Claude task";
  const followUp = "Resume the same Claude task after the usage limit clears.";
  const requests: string[] = [];
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(chunk);
    requests.push(Buffer.concat(body).toString("utf8"));
    writeClaudeResponse(response, model, requests.length, { text: requests.length === 1 ? "Initial Claude answer." : "The same Claude task is complete." });
  });
  const launch = () => launchNativeFixture(descriptor);
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), vendor.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const claude = { executable: binary!, version: "2.1.278", model, origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true as const };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: vendor.base, key: TEST_KEY, claude }));
    app = await launch();
    const page = await app.firstWindow();
    await openCodeProject(page);
    await page.evaluate(async ({ model, prompt }) => {
      await window.desktop.setCodeExecutionPreference("provider_cli");
      await window.desktop.start({ model, mode: "ask", effort: "default", executionMode: "provider_cli", prompt, saveHistory: true });
    }, { model, prompt: title });
    await expect.poll(() => page.evaluate(() => window.desktop.state().then(({ task }) => task?.status)), { timeout: 25_000 }).toBe("completed");
    const initial = await page.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.ok(initial?.id && initial.nativeSession);
    await app.close();
    app = undefined;
    // The vendor account refusal is seeded. The session and the resumed turn use the pinned CLI.
    const scope = codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: vendor.base, key: TEST_KEY });
    const home = nativeHistoryHome(scope.home, claude, "anthropic");
    saveNativeHistory(home, { ...initial, status: "blocked", quota: { source: "claude_code", reason: "credits_required",
      eventId: randomUUID(), threadId: initial.nativeSession.threadId, turnId: initial.nativeSession.turnId } }, "ask");

    app = await launch();
    const restored = await app.firstWindow();
    await openCodeProject(restored);
    await restored.getByRole("button", { name: title, exact: true }).click();
    await expect(restored.getByRole("region", { name: "Code paused at a usage limit" })).toBeVisible();
    assert.equal(requests.length, 1);
    await restored.getByRole("textbox", { name: "Code request" }).fill(followUp);
    await restored.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(restored.getByText("The same Claude task is complete.", { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => restored.evaluate(() => window.desktop.state().then(({ task }) => task?.status))).toBe("completed");
    const final = readNativeHistory(home, initial.id, root, "anthropic");
    assert.equal(final?.id, initial.id);
    assert.equal(final?.nativeSession?.threadId, initial.nativeSession.threadId);
    assert.notEqual(final?.nativeSession?.turnId, initial.nativeSession.turnId);
    assert.equal(final?.entries.filter((entry) => entry.role === "user" && entry.text === followUp).length, 1);
    assert.equal(requests.length, 2);
    assert.ok(requests[1]?.includes(title) && requests[1]?.includes(followUp));
    assert.equal(vendor.completions.length, 0);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((done) => endpoint.close(() => done()));
    await vendor.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test("Desktop resumes saved Claude Code work and inspects uncertain reads without repeating it", {
  timeout: 135_000,
  skip: binary ? false : "Requires the pinned Claude Code executable and a development fixture",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-desktop-claude-code-"));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const inside = join(root, "marker.txt");
  const revisedFile = join(root, "revised.txt");
  const outside = join(temp, "outside.txt");
  const denied = join(root, "forbidden.txt");
  const vendor = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  let finish!: () => void;
  const rest = new Promise<void>((resolve) => { finish = resolve; });
  let releaseRecheck!: () => void;
  const recheck = new Promise<void>((resolve) => { releaseRecheck = resolve; });
  let releaseStop!: () => void;
  const stopReady = new Promise<void>((resolve) => { releaseStop = resolve; });
  const scenario = claudeReadScenario({ inside, outside, denied }, rest, { read: revisedFile, ready: recheck, stopReady });
  const { endpoint, model, marker, outsideMarker, inspect, scope, first, answer } = scenario;
  let app: ElectronApplication | undefined;
  try {
    const projectSettings = join(root, ".claude");
    await Promise.all([mkdir(projectSettings, { recursive: true }), mkdir(profile), vendor.start()]);
    await Promise.all([writeFile(inside, marker), writeFile(revisedFile, scenario.revisedMarker), writeFile(outside, outsideMarker),
      writeFile(join(profile, "language.txt"), "en")]);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    await Promise.all([
      writeFile(join(projectSettings, "settings.json"), JSON.stringify({
        permissions: { allow: ["Edit", "Write"] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "prompt", prompt: scenario.projectHook }] }] },
        enableAllProjectMcpServers: true,
      })),
      writeFile(join(root, ".mcp.json"), JSON.stringify({
        mcpServers: { project_fixture: { type: "http", url: `${origin}${scenario.projectMcpPath}` } },
      })),
    ]);
    const descriptor = join(temp, "fixture.json");
    const claude = { executable: binary!, version: "2.1.278", model, origin, allowSavedHistory: true as const };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: vendor.base, key: TEST_KEY, claude }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByLabel("Preferred execution mode").selectOption("provider_cli");
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "tomverse_api" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model: "fake-coder" });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    assert.equal((await state()).codeFallback?.settings.automaticFrom, "provider_cli");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByText("Claude Code · Local test", { exact: true })).toBeVisible();
    // Claude here reads only: Read only is the mode that holds, and the others are listed switched off.
    await expect(page.getByTestId("permission-picker")).toHaveAttribute("data-mode", "read_only");
    await page.getByTestId("permission-picker").click();
    await expect(page.getByTestId("permission-item-ask")).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    const saveHistory = page.getByRole("checkbox", { name: "Save to local history" });
    await expect(saveHistory).not.toBeChecked();
    await assert.rejects(page.evaluate((model) => window.desktop.start({
      model, prompt: "Reject a Claude write-capable session", mode: "agent", effort: "default",
      executionMode: "provider_cli", saveHistory: false,
    }), model), /read-only request/);
    assert.equal(scenario.requests, 0);
    await startPlanOnly(page, "Analyze search behavior and show the steps");
    await expect(page.getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
    const draft = (await state()).task;
    assert.equal(draft?.status, "running");
    assert.equal(draft.streamingAnswer, first);
    const list = page.locator(".code-task-list");
    const analyzed = list.locator(".code-task-list-item").filter({ hasText: inspect });
    const rejectedRead = list.locator(".code-task-list-item").filter({ hasText: scope });
    await expect(analyzed).toHaveAttribute("data-status", "pending");
    await expect(analyzed).toContainText("Awaiting assignment");
    await expect(rejectedRead).toHaveAttribute("data-status", "pending");
    await expect(rejectedRead).toContainText("Awaiting assignment");
    await expect(list.getByText("0/2 complete", { exact: true })).toBeVisible();
    assert.equal(draft.plan?.activeId, null);
    assert.deepEqual(draft.plan?.items.map(({ evidence }) => evidence.map(({ state }) => state)), [["succeeded"], ["failed"]]);
    assert.deepEqual(draft.plan?.analysis, scenario.firstAnalysis);
    const publicAnalysis = page.getByRole("region", { name: "Request analysis" });
    await expect(publicAnalysis).toContainText(scenario.firstAnalysis.objective);
    await expect(publicAnalysis).toContainText(marker);
    const composer = page.getByRole("textbox", { name: "Code request", exact: true });
    const steer = page.getByRole("button", { name: "Send follow-up instruction", exact: true });
    const queued = page.getByText("Queued for the next model request.");
    assert.ok(draft.nativeSession);
    await composer.fill(scenario.followUp);
    await steer.click();
    await expect(queued).toBeVisible();
    await expect(composer).toHaveValue(scenario.followUp);
    assert.equal(scenario.requests, 10);
    assert.equal(scenario.projectMcpRequests, 0);
    const beforeDelivery = (await state()).task;
    assert.equal(beforeDelivery?.entries.some((entry) => entry.role === "user" && entry.text === scenario.followUp), false);
    finish();
    await expect.poll(() => scenario.requests, { timeout: 30_000 }).toBe(12);
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(page.getByText(scenario.followUp, { exact: true })).toHaveCount(1);
    await expect(composer).toBeEmpty();
    const reopened = (await state()).task!;
    assert.equal(reopened.nativeSession?.threadId, draft.nativeSession.threadId);
    assert.notEqual(reopened.nativeSession?.turnId, draft.nativeSession.turnId);
    assert.equal(reopened.plan?.items[0]?.complete, false);
    assert.equal(reopened.plan?.items[0]?.evidenceStart, 1);
    await expect(list.locator(".code-task-list-item").filter({ hasText: scenario.revised })).toHaveAttribute("data-status", "pending");
    assert.equal(await page.evaluate(({ threadId, turnId }) => window.desktop.followUp({ threadId, turnId }, "Stale Claude instruction"), draft.nativeSession), false);
    await composer.fill(scenario.steer);
    await steer.click();
    await expect(queued).toBeVisible();
    releaseRecheck();
    await expect.poll(async () => (await state()).task?.status, { timeout: 30_000 }).toBe("completed");
    await expect(page.getByText(scenario.revisedAnswer, { exact: true })).toBeVisible();
    await expect(page.getByText(scenario.steer, { exact: true })).toHaveCount(1);
    await expect(queued).toHaveCount(0);
    const completed = (await state()).task!;
    assert.equal(completed.nativeSession?.provider, "anthropic");
    assert.equal(completed.nativeSession.threadId, reopened.nativeSession?.threadId);
    assert.notEqual(completed.nativeSession.turnId, reopened.nativeSession?.turnId);
    const revised = completed.plan?.items[0];
    assert.ok(revised);
    assert.equal(revised.complete, false);
    assert.equal(completed.plan?.activeId, null);
    assert.equal(revised.evidenceStart, 2);
    assert.deepEqual(revised.evidence.map(({ state }) => state), ["succeeded", "failed", "succeeded"]);
    assert.deepEqual(revised.evidence.map(({ assignment }) => assignment && "turnId" in assignment && assignment.turnId),
      [draft.nativeSession.turnId, reopened.nativeSession?.turnId, completed.nativeSession.turnId]);
    assert.equal(completed.plan?.items[1]?.completionUnverified, false);
    assert.deepEqual(completed.plan?.analysis, scenario.revisedAnalysis);
    await expect(publicAnalysis).toContainText(scenario.revisedMarker);
    await expect(publicAnalysis).not.toContainText(marker);
    assert.deepEqual(completed.transmission, []);
    assert.equal(completed.execution?.billingSource, "unknown");
    assert.equal(completed.savedLocally, false);
    assert.deepEqual((await state()).history, []);
    assert.equal(await readFile(inside, "utf8"), marker);
    assert.equal(await readFile(outside, "utf8"), outsideMarker);
    await assert.rejects(readFile(denied), { code: "ENOENT" });
    assert.equal(scenario.requests, 15);
    assert.equal(vendor.completions.length, 0);
    assert.equal(scenario.error, undefined);
    const artifact = process.env.TOMVERSE_CLAUDE_DESKTOP_QA;
    if (artifact) {
      await list.screenshot({ path: join(artifact, "claude-task-list-dark.png") });
      await page.getByRole("button", { name: "Use light theme" }).click();
      await list.screenshot({ path: join(artifact, "claude-task-list-light.png") });
    }
    await saveHistory.check();
    await composer.fill(scenario.savedPrompt);
    await page.getByRole("button", { name: "Send Code request", exact: true }).click();
    await expect.poll(() => scenario.requests, { timeout: 30_000 }).toBe(17);
    await composer.fill(scenario.savedInstruction);
    await steer.click();
    await expect(queued).toBeVisible();
    releaseStop();
    await expect.poll(() => scenario.requests, { timeout: 30_000 }).toBe(19);
    await expect(composer).toBeEmpty();
    await composer.fill(scenario.cancelled);
    await steer.click();
    await expect(queued).toBeVisible();
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect.poll(async () => (await state()).task?.status, { timeout: 20_000 }).toBe("stopped");
    await expect.poll(() => scenario.stopRequestClosed).toBe(true);
    await expect(list.locator('[data-status="cancelled"]')).toContainText(scenario.stopTask);
    await expect(composer).toHaveValue(scenario.cancelled);
    await expect(queued).toHaveCount(0);
    assert.equal((await state()).task?.entries.some((entry) => entry.role === "user" && entry.text === scenario.cancelled), false);
    assert.equal(scenario.requests, 19);
    const saved = (await state()).task;
    assert.ok(saved?.id && saved.nativeSession && saved.canResume);
    assert.equal(saved.plan?.items[0]?.nativeStatus, "in_progress");
    assert.equal(saved.plan?.items[0]?.evidence[0]?.state, "succeeded");
    const store = nativeHistoryHome(codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: vendor.base, key: TEST_KEY }).home, claude, "anthropic");
    assert.equal(readNativeHistory(store, saved.id, root, "openai"), null);
    const savedCheckpoint = readNativeHistory(store, saved.id, root, "anthropic");
    assert.deepEqual(savedCheckpoint?.nativeSession, saved.nativeSession);
    await app.close();
    app = undefined;
    app = await launchNativeFixture(descriptor);
    const restored = await app.firstWindow();
    const restoredState = () => restored.evaluate(() => window.desktop.state());
    await openCodeProject(restored);
    await expect(restored.getByRole("checkbox", { name: "Save to local history" })).not.toBeChecked();
    assert.equal(await restored.evaluate((id) => window.desktop.resume(id), saved.id), false);
    await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: scenario.savedPrompt, exact: true }).click();
    const prior = (await restoredState()).task;
    assert.equal(prior?.id, saved.id);
    assert.deepEqual(prior?.nativeSession, saved.nativeSession);
    assert.deepEqual(prior?.plan, JSON.parse(JSON.stringify(saved.plan)));
    assert.equal(scenario.requests, 19);
    await expect(restored.getByText(scenario.savedInstruction, { exact: true })).toHaveCount(1);
    await restored.getByRole("button", { name: "Resume task", exact: true }).click();
    await expect(restored.getByText(scenario.continuedAnswer, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await restoredState()).task?.status).toBe("completed");
    const continued = (await restoredState()).task;
    assert.equal(continued?.id, saved.id);
    assert.equal(continued.nativeSession?.threadId, saved.nativeSession.threadId);
    assert.notEqual(continued.nativeSession?.turnId, saved.nativeSession.turnId);
    assert.equal(continued.plan?.items[0]?.segmentId, saved.nativeSession.threadId);
    const readModels = continued.plan?.items[0]?.evidence.map(({ assignment }) =>
      assignment && "threadId" in assignment ? assignment.reportedModel : undefined);
    assert.deepEqual(readModels, Array(2).fill({ model: saved.nativeSession.model, source: "claude_assistant" }));
    assert.equal(continued.nativeRuns?.at(-1)?.usage?.source, "claude_turn");
    await restored.getByText("Provider usage · Claude Code", { exact: true }).click();
    await expect(restored.getByText(/Reported turn usage · \d+ input · \d+ output tokens/).last()).toBeVisible();
    assert.deepEqual(continued.plan?.items.map(({ id, complete, evidenceStart, evidence }) => ({ id, complete, evidenceStart,
      reads: evidence.map(({ state }) => state) })), [{ id: "claude-1", complete: false, evidenceStart: 1, reads: ["succeeded", "succeeded"] }]);
    await expect(restored.locator(".code-task-list-item")).toHaveAttribute("data-status", "pending");
    await expect(restored.getByText(scenario.savedInstruction, { exact: true })).toHaveCount(1);
    assert.equal(scenario.requests, 22);

    await restored.getByRole("checkbox", { name: "Save to local history" }).check();
    await restored.getByRole("textbox", { name: "Code request", exact: true }).fill(scenario.crashPrompt);
    await restored.getByRole("button", { name: "Send Code request", exact: true }).click();
    await expect.poll(() => scenario.requests, { timeout: 30_000 }).toBe(27);
    const interrupted = (await restoredState()).task;
    assert.ok(interrupted?.id && interrupted.nativeSession);
    const interruptedId = interrupted.id;
    await expect.poll(() => readNativeHistory(store, interruptedId, root, "anthropic")?.plan?.items[0]?.evidence.map(({ state }) => state))
      .toEqual(["succeeded", "failed"]);
    const checkpoint = readNativeHistory(store, interruptedId, root, "anthropic");
    assert.ok(checkpoint?.plan);
    const unconfirmed = { ...checkpoint.plan, items: checkpoint.plan.items.map((row) => ({
      ...row, evidence: row.evidence.map((read) => ({ ...read, state: "unconfirmed" as const })),
    })) };
    // The CLI can flush its transcript after sending the corresponding stream frames.
    await expect.poll(async () => {
      const receipts = await inspectClaudeTranscript({
        profile: join(nativeSessionDirectory(store, interruptedId), "profile"), project: bindProjectRoot(root),
        session: interrupted.nativeSession!, plan: unconfirmed, version: claude.version, signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      return receipts && [...receipts.values()];
    }, { timeout: 12_000 }).toEqual(["succeeded", "failed"]);
    await app.evaluate(({ app }) => {
      const runtime = app.getAppMetrics().find((item) => item.type === "Utility" && (item.name === "Tomverse Code Runtime" || item.serviceName === "Tomverse Code Runtime"));
      if (!runtime) throw new Error("The fixture Code worker was not found");
      process.kill(runtime.pid);
    });
    await expect.poll(async () => (await restoredState()).task?.status).toBe("unknown");
    await expect.poll(() => scenario.crashRequestClosed, { timeout: 20_000 }).toBe(true);
    const unknown = readNativeHistory(store, interruptedId, root, "anthropic");
    assert.equal(unknown?.status, "unknown");
    assert.deepEqual(unknown.nativeSession, interrupted.nativeSession);
    const reads = unknown.plan?.items[0]?.evidence;
    assert.deepEqual(reads?.map(({ state }) => state), ["succeeded", "failed"]);
    assert.ok(reads?.every(({ nativeCallId }) => !!nativeCallId));
    await app.close();
    app = undefined;

    // Keep the observed call records and emulate a checkpoint that missed their receipts.
    await writeFile(join(nativeSessionDirectory(store, interruptedId), "session.json"), JSON.stringify({ ...unknown, plan: unconfirmed }));
    app = await launchNativeFixture(descriptor);
    const recovered = await app.firstWindow();
    await openCodeProject(recovered);
    await recovered.getByRole("complementary", { name: "History" }).getByRole("button", { name: scenario.crashPrompt, exact: true }).click();
    await recovered.getByRole("button", { name: "Check recovery", exact: true }).click();
    await expect(recovered.getByText("Claude Code · Outcome unconfirmed", { exact: true })).toBeVisible();
    await expect(recovered.getByText("File reads · 1 confirmed · 1 failed · 0 unconfirmed", { exact: true })).toBeVisible();
    const checked = await recovered.evaluate(() => window.desktop.state()).then(({ task }) => task);
    assert.equal(checked?.status, "unknown");
    assert.equal(checked.plan?.items[0]?.complete, false);
    assert.deepEqual(checked.plan?.items[0]?.evidence.map(({ state }) => state), ["succeeded", "failed"]);
    assert.equal(await recovered.evaluate((id) => window.desktop.resume(id), interruptedId), false);
    await expect(recovered.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
    assert.equal(scenario.requests, 27);
    assert.equal(scenario.transientRetries, 1);
    assert.equal(scenario.projectMcpRequests, 0);
    assert.equal(vendor.completions.length, 0);
    assert.equal(scenario.error, undefined);
  } catch (error) {
    const artifact = process.env.TOMVERSE_CLAUDE_DESKTOP_QA;
    const page = app?.windows()[0];
    if (artifact && page && !page.isClosed()) {
      const task = await page.evaluate(() => window.desktop.state().then(({ task }) => task));
      const notice = await page.locator(".notice").allTextContents();
      await writeFile(join(artifact, "claude-e2e-failure.json"), JSON.stringify({ task, notice, requests: scenario.requests, endpointError: String(scenario.error ?? "") }, null, 2));
    }
    throw error;
  } finally {
    finish();
    releaseRecheck();
    releaseStop();
    if (app) await app.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await vendor.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
