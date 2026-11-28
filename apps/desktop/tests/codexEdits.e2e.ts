import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeProject } from "./code-project-fixture";
import { expect, type ElectronApplication } from "@playwright/test";
import { pathIdentity } from "../../tomverse-cli/src/patch.js";
import { claimLock } from "../../tomverse-cli/src/session.js";
import { FakeGateway, fixtureInitialWorkPlan, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { nativeHistoryHome, nativeSessionDirectory, retiredHistoryDirectory, stagedNativeDirectory } from "../src/host/native-history";
import { bindProjectRoot } from "../src/host/project-root";
import { codexFixtureAnswer, codexFixtureCall, flattenCodexTools, writeCodexResponse, type CodexRequest } from "./codex-response-fixture";
import { decideNativePatch as decidePatch, launchNativeFixture } from "./launch-native-fixture";

const executable = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;

test("Codex honors patch decisions and carries verified edits across quota continuation", {
  timeout: 130_000, skip: executable ? false : "Requires the pinned Codex executable",
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-codex-agent-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const model = "gpt-5.4";
  const objective = "Make and verify the approved edits";
  const originalEdit = "Native changes stay in place.\n";
  const newEdit = "A separately approved API change.\n";
  const deniedAnswer = "The declined edit was left unapplied.";
  let sourceFile = "source.txt";
  let refusePatch = false;
  let calls = 0;
  let fixtureError: unknown;
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    try {
      assert.equal(request.headers.authorization, undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body: CodexRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const index = ++calls;
      const tools = flattenCodexTools(body.tools ?? []);
      assert.ok(!tools.some(({ name }) => ["exec_command", "shell_command", "shell", "write_stdin"].includes(name)));
      if (index === 1) {
        writeCodexResponse(response, model, index, codexFixtureCall(tools, index, "desktop_apply_patch", {
          edits: [{ path: "before-analysis.txt", action: "create", content: "This proposal must never reach approval." }],
        }));
        return;
      }
      if (index === 2) {
        assert.match(JSON.stringify(body.input), /Publish the read-only analysis in update_plan/);
        await assert.rejects(readFile(join(root, "before-analysis.txt")), { code: "ENOENT" });
      }
      const plan = (status: "in_progress" | "completed") =>
        codexFixtureCall(tools, index, "update_plan", { explanation: JSON.stringify(fixtureWorkAnalysis),
          plan: [{ step: "Record the approved Codex edit", status }] });
      const phase = (index - 2) % 4;
      if (phase === 0) writeCodexResponse(response, model, index, plan("in_progress"));
      else if (phase === 1) writeCodexResponse(response, model, index, codexFixtureCall(tools, index, "desktop_apply_patch", {
        edits: [{ path: sourceFile, action: "create", content: originalEdit }], explanation: "Record the approved Codex edit.",
      }));
      else if (phase === 2) {
        if (refusePatch) {
          assert.match(JSON.stringify(body.input), /No approved Desktop file edit was applied/);
          await assert.rejects(readFile(join(root, sourceFile)), { code: "ENOENT" });
          writeCodexResponse(response, model, index, codexFixtureAnswer(index, deniedAnswer));
        } else {
          assert.match(JSON.stringify(body.input), /approved Desktop patch was verified on disk/);
          assert.equal(await readFile(join(root, sourceFile), "utf8"), originalEdit);
          writeCodexResponse(response, model, index, plan("completed"));
        }
      } else {
        response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_fixture_limit" });
        response.end(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "Synthetic limit" } }));
      }
    } catch (error) {
      fixtureError = error;
      response.writeHead(400).end();
    }
  });
  const gateway = new FakeGateway({
    cappedContinuation: { creditCap: 45 },
    script: (body, index) => {
      assert.equal(body.tomverse_max_key_credit_cap, 50);
      assert.equal(body.model, "fake-coder");
      if (index === 0) {
        const messages = JSON.stringify(body.messages);
        assert.match(messages, /source\.txt/);
        assert.doesNotMatch(messages, /Native changes stay in place|approved Desktop patch was verified/);
        return { toolCalls: [{ name: "read_file", args: { path: "source.txt" } }] };
      }
      if (index === 1) {
        assert.match(JSON.stringify(body.messages), /Native changes stay in place/);
        return fixtureInitialWorkPlan;
      }
      if (index === 2) {
        return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "next.txt", action: "create", content: newEdit }] } }] };
      }
      if (index === 3) return { text: "Both file changes are recorded." };
      assert.equal(index, 4);
      const messages = JSON.stringify(body.messages);
      assert.match(messages, /completedEdits/);
      assert.doesNotMatch(messages, /summary-only\.txt|Native changes stay in place/);
      return { text: "The summary is sufficient." };
    },
  });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const codex = { executable: executable!, version: "0.171.0-alpha.13", model, origin: `http://127.0.0.1:${address.port}`,
      allowSavedHistory: true as const, allowFileEdits: true as const };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, codex }));
    const launch = () => launchNativeFixture(descriptor);
    app = await launch();
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.setCodeExecutionPreference("provider_cli");
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "tomverse_api" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model: "fake-coder" });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "transfer", transfer: "summary_and_changes" });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    const start = (prompt: string, saveHistory = true) => page.evaluate(({ prompt, model, saveHistory }) => window.desktop.start({
      model, mode: "agent", effort: "default", executionMode: "provider_cli", prompt, saveHistory,
    }), { prompt, model, saveHistory });
    await expect(page.getByTestId("permission-picker")).toHaveAttribute("data-mode", "ask");
    await assert.rejects(start("File edits need saved history", false));
    const [native] = await Promise.all([app.waitForEvent("window", { timeout: 23_000 }), start(objective)]);
    const original = (await state()).task;
    assert.ok(original?.id);
    await expect(native.getByRole("heading", { name: "source.txt · create" })).toBeVisible();
    await expect(page.locator('.code-task-list-item[data-status="approval"]')).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(fixtureWorkAnalysis.objective);
    await expect(native.getByRole("button", { name: "Allow for this run", exact: true })).toHaveCount(0);
    await assert.rejects(readFile(join(root, "source.txt")), { code: "ENOENT" });
    const [api] = await Promise.all([
      app.waitForEvent("window", { timeout: 25_000 }), decidePatch(native),
    ]);
    assert.ifError(fixtureError);
    assert.equal(calls, 5);
    assert.equal((await state()).task?.id, original.id);
    await expect(api.getByRole("heading", { name: "next.txt · create" })).toBeVisible();
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), originalEdit);
    await assert.rejects(readFile(join(root, "next.txt")), { code: "ENOENT" });
    await decidePatch(api);
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    assert.equal(await readFile(join(root, "next.txt"), "utf8"), newEdit);
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), originalEdit);
    const completed = (await state()).task;
    const nativeRow = completed?.plan?.items[0];
    assert.equal(nativeRow?.complete, true);
    assert.equal(nativeRow?.evidence[0]?.tool, "apply_patch");
    assert.equal(nativeRow?.nativeAssignment?.model, model);
    assert.deepEqual(completed?.changes.map(({ path }) => path), ["source.txt", "next.txt"]);
    assert.equal(gateway.completions.length, 4);
    const sourceChange = completed?.changes[0]?.id;
    assert.ok(sourceChange);
    const readDiff = () => page.evaluate((id) => window.desktop.readChange(id), sourceChange);
    assert.match((await readDiff())?.text ?? "", /Native changes stay in place/);
    assert.equal((await readDiff())?.canUndo, false);

    sourceFile = "drift.txt";
    gateway.options.cappedContinuation = { creditCap: 45, beforeUsage: async () => {
      await writeFile(join(root, "drift.txt"), "Changed by another editor.\n");
    } };
    const [second] = await Promise.all([app.waitForEvent("window", { timeout: 23_000 }), start("Pause if an editor replaces the verified edit")]);
    await decidePatch(second);
    await expect.poll(async () => (await state()).task?.continuation?.stage, { timeout: 25_000 }).toBe("unavailable");
    assert.equal((await state()).task?.status, "blocked");
    assert.equal(gateway.completions.length, 4);
    assert.equal(await readFile(join(root, "drift.txt"), "utf8"), "Changed by another editor.\n");

    sourceFile = "summary-only.txt";
    gateway.options.cappedContinuation = { creditCap: 45 };
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "transfer", transfer: "summary" });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    const [summary] = await Promise.all([app.waitForEvent("window", { timeout: 23_000 }), start("Continue with the summary scope")]);
    await decidePatch(summary);
    await expect.poll(async () => (await state()).task?.status, { timeout: 25_000 }).toBe("completed");
    await expect(page.getByText("The summary is sufficient.", { exact: true })).toBeVisible();
    assert.equal(await readFile(join(root, "summary-only.txt"), "utf8"), originalEdit);
    const summaryId = (await state()).task?.id;
    assert.ok(summaryId);

    const formerProcessId = await app.evaluate(() => process.pid);
    await app.close();
    const scope = codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: gateway.base, key: TEST_KEY });
    const sourceHome = nativeHistoryHome(scope.home, codex, "openai");
    const source = nativeSessionDirectory(sourceHome, original.id);
    const staged = stagedNativeDirectory(scope.home, original.id);
    // Persist the directory layout left by an interrupted deletion before its commit.
    await rename(source, staged);

    // Reproduce a committed deletion that is still waiting for physical cleanup.
    const summaryDirectory = nativeSessionDirectory(scope.home, summaryId);
    const identity = pathIdentity(summaryDirectory, "directory");
    assert.ok(identity);
    const retired = retiredHistoryDirectory(summaryDirectory, identity);
    await rename(nativeSessionDirectory(sourceHome, summaryId), stagedNativeDirectory(scope.home, summaryId));
    claimLock(join(summaryDirectory, "lock"), summaryId);
    await rename(summaryDirectory, retired);
    const unrelated = retiredHistoryDirectory(summaryDirectory, "0:0");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep.txt"), "Unrelated directory.");
    const profileAlias = join(temp, "profile-alias");
    await symlink(profile, profileAlias, process.platform === "win32" ? "junction" : "dir");
    await writeFile(descriptor, JSON.stringify({ root, profile: profileAlias, endpoint: gateway.base, key: TEST_KEY, codex }));
    app = await launch();
    assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
    const pending = await app.firstWindow();
    await openCodeProject(pending);
    await expect.poll(() => pending.evaluate(async () => (await window.desktop.state()).models.map(({ id }) => id))).toContain("fake-coder");
    await expect(pending.getByRole("button", { name: "Continue with the summary scope", exact: true })).toHaveCount(0);
    assert.ok(await readFile(join(retired, "session.json")));
    await writeFile(join(retired, "lock"), JSON.stringify({ pid: formerProcessId, host: hostname(), at: new Date().toISOString() }));
    await app.close();

    app = await launch();
    const reopened = await app.firstWindow();
    await openCodeProject(reopened);
    await expect.poll(() => pathIdentity(retired, "directory")).toBeNull();
    assert.equal(await readFile(join(unrelated, "keep.txt"), "utf8"), "Unrelated directory.");
    await reopened.getByRole("button", { name: objective, exact: true }).click();
    const retrieved = await reopened.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(retrieved?.id, original.id);
    assert.deepEqual(retrieved?.changes, completed?.changes);
    assert.deepEqual(retrieved?.plan, completed?.plan);
    assert.match((await reopened.evaluate((id) => window.desktop.readChange(id), sourceChange))?.text ?? "", /Native changes stay in place/);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    assert.equal(await reopened.evaluate((id) => window.desktop.deleteHistory(id), original.id), "deleted");
    await expect(reopened.getByRole("button", { name: objective, exact: true })).toHaveCount(0);
    await assert.rejects(readdir(nativeSessionDirectory(scope.home, original.id)), { code: "ENOENT" });
    await assert.rejects(readdir(source), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), originalEdit);
    assert.equal(await readFile(join(root, "next.txt"), "utf8"), newEdit);
    assert.equal(calls, 13);
    assert.equal(gateway.completions.length, 5);

    refusePatch = true;
    sourceFile = "denied.txt";
    const [denied] = await Promise.all([
      app.waitForEvent("window", { timeout: 23_000 }),
      reopened.evaluate((model) => window.desktop.start({
        model, mode: "agent", effort: "default", executionMode: "provider_cli", prompt: "Propose a separate edit.", saveHistory: true,
      }), model),
    ]);
    await expect(denied.getByRole("heading", { name: "denied.txt · create" })).toBeVisible();
    await decidePatch(denied, "Deny");
    await expect(reopened.getByText(deniedAnswer, { exact: true })).toBeVisible();
    await expect.poll(() => reopened.evaluate(async () => (await window.desktop.state()).task?.status)).toBe("completed");
    const declined = await reopened.evaluate(async () => (await window.desktop.state()).task);
    assert.deepEqual(declined?.changes, []);
    assert.equal(declined?.plan?.items[0]?.complete, false);
    await assert.rejects(readFile(join(root, sourceFile)), { code: "ENOENT" });
    assert.equal(calls, 16);
    assert.equal(gateway.completions.length, 5);
    assert.ifError(fixtureError);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((done) => endpoint.close(() => done()));
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
