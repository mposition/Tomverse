import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openCodeProject } from "./code-project-fixture";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication } from "@playwright/test";
import { claimLock, Journal } from "../../tomverse-cli/src/session.js";
import { FakeGateway, TEST_KEY, type ScriptedReply } from "../../tomverse-cli/tests/fakeGateway.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { nativeHistoryHome, nativeSessionDirectory } from "../src/host/native-history";
import { bindProjectRoot } from "../src/host/project-root";
import { codexFixtureAnswer, codexFixtureCall, flattenCodexTools, writeCodexResponse, type CodexRequest } from "./codex-response-fixture";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktop = resolve(fileURLToPath(new URL("../", import.meta.url)));
const launch = (descriptor: string) => electron.launch({ executablePath, args: [desktop, "--desktop-fixture", descriptor], timeout: 20_000 });

test("Code persists verified API credit limits and does not misclassify ambiguous refusals", { timeout: 75_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-code-api-quota-"));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const descriptor = join(temp, "fixture.json");
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const cases: Array<{ prompt: string; reply: ScriptedReply; status: string; quota?: string }> = [
    { prompt: "Verify the account-local reset", reply: { fault: "http", status: 429, code: "PLAN_DAILY_CREDIT_LIMIT_REACHED",
      details: { resetAt } }, status: "blocked", quota: "PLAN_DAILY_CREDIT_LIMIT_REACHED" },
    { prompt: "Verify the API key limit", reply: { fault: "http", status: 429, code: "key_credit_cap_reached", releasedReceipt: true },
      status: "blocked", quota: "key_credit_cap_reached" },
    { prompt: "Verify insufficient credits", reply: { fault: "http", status: 402, code: "CREDIT_BALANCE_INSUFFICIENT" },
      status: "blocked", quota: "CREDIT_BALANCE_INSUFFICIENT" },
    { prompt: "Do not infer quota from throttling", reply: { fault: "http", status: 429, code: "rate_limit_exceeded" }, status: "failed" },
    { prompt: "Do not infer quota from operational limits", reply: { fault: "http", status: 429, code: "PROVIDER_BUDGET_EXHAUSTED" }, status: "failed" },
    { prompt: "Do not infer quota from authentication", reply: { fault: "http", status: 401, code: "invalid_api_key" }, status: "failed" },
    { prompt: "Do not infer quota from a full context", reply: { fault: "http", status: 400, code: "context_length_exceeded" }, status: "failed" },
    { prompt: "Keep the outcome with a held receipt unknown", reply: { fault: "http", status: 429, code: "key_credit_cap_reached", heldReceipt: true },
      status: "unknown" },
    { prompt: "Keep the proxy refusal unknown", reply: { fault: "http", status: 429, code: "key_credit_cap_reached", fromProxy: true }, status: "unknown" },
    { prompt: "Keep the disconnected outcome unknown", reply: { fault: "drop_unrecorded" }, status: "unknown" },
  ];
  const gateway = new FakeGateway({ script: (_, index) => {
    assert.ok(cases[index], "A quota pause must not cause a second model request");
    return cases[index].reply;
  } });
  let app: ElectronApplication | undefined;
  let failureCase: string | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launch(descriptor);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    const pause = page.getByRole("region", { name: "Code paused at a usage limit" });
    for (const [index, trial] of cases.entries()) {
      failureCase = trial.prompt;
      await page.evaluate((prompt) => window.desktop.start({ model: "fake-coder", mode: "ask", effort: "default",
        executionMode: "tomverse_api", prompt }), trial.prompt);
      await expect.poll(async () => (await state()).task?.status).toBe(trial.status);
      const task = (await state()).task;
      assert.equal(task?.quota?.reason, trial.quota);
      assert.equal(gateway.completions.length, index + 1);
      if (trial.quota) {
        await expect(pause).toBeVisible();
        await expect(pause.getByText("Remaining allowance unconfirmed")).toBeVisible();
        assert.ok(!task?.canResume);
      } else {
        await expect(pause).toHaveCount(0);
      }
      if (index === 0) {
        assert.equal(task?.quota?.source === "tomverse_api" && task.quota.resetAt, resetAt);
        await expect(pause.getByText(/Reported reset/)).toBeVisible();
      }
      if (index === 1) {
        await expect(pause.getByText("Reset time unavailable")).toBeVisible();
        const qa = process.env.TOMVERSE_CODE_QUOTA_QA;
        if (qa) {
          await pause.screenshot({ path: join(qa, "quota-dark.png") });
          await page.getByRole("button", { name: "Use light theme", exact: true }).click();
          await pause.screenshot({ path: join(qa, "quota-light.png") });
        }
        await pause.getByRole("button", { name: "Open execution settings" }).click();
        await expect(page.getByRole("heading", { name: "Execution and limits" })).toBeVisible();
        await page.getByRole("button", { name: "Code", exact: true }).click();
      }
    }
    await app.close();
    app = await launch(descriptor);
    const reopened = await app.firstWindow();
    await openCodeProject(reopened);
    await reopened.getByRole("button", { name: cases[0].prompt }).click();
    await expect(reopened.getByRole("region", { name: "Code paused at a usage limit" })).toBeVisible();
    assert.equal(gateway.completions.length, cases.length);
    const reopenedState = () => reopened.evaluate(() => window.desktop.state());
    const paused = (await reopenedState()).task;
    assert.ok(paused?.id && paused.canResumeAfterQuota);
    const prompt = "Continue here after the account limit resets.";
    const composer = reopened.getByRole("textbox", { name: "Code request" });
    const send = reopened.getByRole("button", { name: "Send follow-up instruction" });
    await composer.fill(prompt);
    gateway.revoked = true;
    const beforeResume = gateway.requests.length;
    await send.click();
    await expect(reopened.getByRole("alert")).toBeVisible();
    await expect(composer).toHaveValue(prompt);
    assert.equal((await reopenedState()).task?.status, "blocked");
    assert.equal(gateway.completions.length, cases.length);
    assert.match(gateway.requests[beforeResume]?.url ?? "", /\/requests\/status\?request_id=/);

    gateway.revoked = false;
    gateway.options.script = (body) => {
      assert.equal(body.model, "fake-coder");
      assert.deepEqual(body.messages.filter(({ role }: { role: string }) => role === "user").map(({ content }: { content: string }) => content),
        [cases[0].prompt, prompt]);
      return { text: "The original API task is complete." };
    };
    await send.click();
    await expect(reopened.getByText("The original API task is complete.", { exact: true })).toBeVisible();
    await expect.poll(async () => (await reopenedState()).task?.status).toBe("completed");
    assert.equal((await reopenedState()).task?.id, paused.id);
    assert.equal(gateway.completions.length, cases.length + 1);
  } catch (error) {
    const artifact = process.env.TOMVERSE_CODE_QUOTA_QA;
    const page = app?.windows()[0];
    if (artifact && page && !page.isClosed()) {
      const task = await page.evaluate(() => window.desktop.state().then(({ task }) => task));
      await writeFile(join(artifact, "api-quota-failure.json"), JSON.stringify({ case: failureCase, task }, null, 2));
    }
    throw error;
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

const codex = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;

test("A confirmed Codex limit continues the saved read-only task on the capped Code API once", {
  timeout: 90_000, skip: codex ? false : "Requires the pinned Codex executable",
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-code-switch-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const model = "gpt-5.4";
  const row = "Check the remaining project evidence";
  const objective = "Inspect the project after the Codex limit";
  const privateTail = "PRIVATE_ORIGINAL_TAIL";
  const answer = "Tomverse confirmed the remaining evidence.";
  let nativeRequests = 0;
  let nativeFailure: unknown;
  let includePlan = true;
  let apiExhausted = false;
  let nativeRecovered = false;
  let releaseFirstApiReply!: () => void;
  const firstApiReply = new Promise<void>((resolve) => { releaseFirstApiReply = resolve; });
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    try {
      assert.equal(request.headers.authorization, undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body: CodexRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const index = ++nativeRequests;
      if (nativeRecovered) {
        writeCodexResponse(response, model, index, codexFixtureAnswer(index, "The original provider is available again."));
        return;
      }
      if (includePlan && index === 1) {
        writeCodexResponse(response, model, index, codexFixtureCall(flattenCodexTools(body.tools ?? []), index, "update_plan", {
          plan: [{ step: row, status: "in_progress" }],
        }));
        return;
      }
      response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_fixture_limit" });
      response.end(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "Synthetic limit" } }));
    } catch (error) {
      nativeFailure = error;
      response.writeHead(400).end();
    }
  });
  const gateway = new FakeGateway({
    cappedContinuation: { creditCap: 45 },
    script: async (body, index) => {
      if (apiExhausted) return { fault: "http", status: 402, code: "PLAN_ENTITLEMENT_EXHAUSTED", releasedReceipt: true };
      if (index === 0) {
        await firstApiReply;
        return { toolCalls: [{ name: "read_file", args: { path: "marker.txt" } }] };
      }
      assert.match(JSON.stringify(body.messages), /Remaining test evidence/);
      return { text: answer };
    },
  });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await Promise.all([
      writeFile(join(profile, "language.txt"), "en"), writeFile(join(root, "marker.txt"), "Remaining test evidence."),
      writeFile(join(root, "AGENTS.md"), "PRIVATE_PROJECT_INSTRUCTIONS"),
    ]);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const cli = { executable: codex!, version: "0.171.0-alpha.13", model, origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true as const };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, codex: cli }));
    app = await launch(descriptor);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.setCodeExecutionPreference("provider_cli");
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "tomverse_api" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model: "fake-coder" });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    const request = (prompt: string, mode: "ask" | "plan" = "ask") => page.evaluate(({ prompt, model, mode }) => window.desktop.start({
      model, mode, effort: "default", executionMode: "provider_cli", prompt, saveHistory: true,
    }), { prompt, model, mode });
    const firstPrompt = `${objective}\n${"Long request details. ".repeat(6)}${privateTail}`;
    await request(firstPrompt, "plan");
    const started = (await state()).task;
    assert.ok(started?.id);
    await expect(page.getByLabel("Model and reasoning effort")).toContainText("Fake Coder", { timeout: 20_000 });
    releaseFirstApiReply();
    await expect.poll(async () => (await state()).busy, { timeout: 25_000 }).toBe(false);
    assert.ifError(nativeFailure);
    assert.equal(nativeRequests, 2);
    const completed = (await state()).task;
    assert.equal(completed?.status, "completed", JSON.stringify({ completed, nativeRequests, apiRequests: gateway.requests.map(({ url }) => url) }));
    assert.equal(completed?.id, started.id);
    assert.equal(completed?.execution?.executionMode, "tomverse_api");
    assert.equal(completed?.continuation?.stage, "started");
    assert.equal(completed?.continuation?.source.model, model);
    assert.equal(completed?.continuation?.model, "fake-coder");
    assert.equal(completed?.plan?.items[0]?.title, row);
    assert.equal(completed?.plan?.items[0]?.nativeAssignment, undefined);
    assert.equal(completed?.nativeRuns?.at(-1)?.session.model, model);
    assert.equal(completed?.entries[0]?.role === "user" && completed.entries[0].text, firstPrompt);
    assert.equal(completed?.transmission.length, 2);
    assert.ok(completed.transmission.every(({ receipt }) => receipt.status === "settled"));
    const historyScope = codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: gateway.base, key: TEST_KEY });
    const source = nativeSessionDirectory(nativeHistoryHome(historyScope.home, cli, "openai"), started.id);
    const api = join(historyScope.home, "sessions", started.id, "session.json");
    const saved = JSON.parse(await readFile(join(source, "session.json"), "utf8"));
    const segment = JSON.parse(await readFile(api, "utf8"));
    assert.equal(saved.continuation.segmentId, completed.continuation.segmentId);
    assert.equal(segment.codeContinuation.segmentId, saved.continuation.segmentId);
    assert.equal(saved.status, "blocked");
    assert.equal(gateway.completions.length, 2);
    for (const { body } of gateway.completions) {
      assert.equal(body.model, "fake-coder");
      assert.equal(body.tomverse_max_key_credit_cap, 50);
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE_ORIGINAL_TAIL|PRIVATE_PROJECT_INSTRUCTIONS|run_command|apply_patch/);
      assert.ok(!JSON.stringify(body).includes(JSON.stringify(root).slice(1, -1)));
    }
    assert.match(JSON.stringify(gateway.completions[0].body.messages), new RegExp(row));
    await expect(page.getByText("Continuing with your saved settings.")).toBeVisible();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(page.locator(".code-task-list").getByText(row, { exact: true })).toBeVisible();
    const evidence = process.env.TOMVERSE_CODE_CONTINUATION_QA;
    if (evidence) {
      await page.screenshot({ path: join(evidence, "continuation-dark.png") });
      await page.getByRole("button", { name: "Use light theme" }).click();
      await page.screenshot({ path: join(evidence, "continuation-light.png") });
    }
    await page.getByText("View execution and usage", { exact: true }).click();
    await expect(page.getByText("Approved limit · 50 credits", { exact: true })).toBeVisible();

    includePlan = false;
    gateway.options.cappedContinuation!.creditCap = 51;
    await request("Pause if the Code key cap is too high");
    await expect.poll(async () => {
      const current = await state();
      return !current.busy && current.task?.continuation?.stage;
    }, { timeout: 25_000 }).toBe("unavailable");
    assert.equal((await state()).task?.status, "blocked");
    assert.equal(gateway.completions.length, 2);

    let reachedUsage = false;
    let releaseUsage!: () => void;
    const usageReply = new Promise<void>((resolve) => { releaseUsage = resolve; });
    gateway.options.cappedContinuation = { creditCap: 45, beforeUsage: async () => {
      reachedUsage = true;
      await usageReply;
    } };
    await request("Revoke continuation before API dispatch");
    try {
      await expect.poll(() => reachedUsage, { timeout: 25_000 }).toBe(true);
      await page.evaluate(async () => {
        const scope = (await window.desktop.state()).codeFallback!.scope;
        await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: false });
      });
    } finally { releaseUsage(); }
    await expect.poll(async () => (await state()).busy).toBe(false);
    assert.equal((await state()).task?.status, "blocked");
    assert.equal(gateway.completions.length, 2);
    assert.equal(nativeRequests, 4);

    gateway.options.cappedContinuation = { creditCap: 45 };
    apiExhausted = true;
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    const bothBlockedTitle = "Keep the Code task paused after the capped API also reaches its limit";
    await request(bothBlockedTitle);
    await expect.poll(async () => (await state()).task?.quota?.source, { timeout: 25_000 }).toBe("tomverse_api");
    const bothBlocked = (await state()).task;
    assert.ok(bothBlocked?.id);
    assert.equal(bothBlocked.status, "blocked");
    assert.equal(bothBlocked.continuation?.stage, "started");
    assert.equal(bothBlocked.quota?.reason, "PLAN_ENTITLEMENT_EXHAUSTED");
    assert.equal(gateway.completions.length, 3);
    assert.equal(nativeRequests, 5);
    assert.equal(gateway.completions[2]?.body.tomverse_max_key_credit_cap, 50);

    nativeRecovered = true;
    await app.close();
    app = await launch(descriptor);
    const reopened = await app.firstWindow();
    await openCodeProject(reopened);
    await reopened.getByRole("button", { name: bothBlockedTitle, exact: true }).click();
    await expect(reopened.getByRole("region", { name: "Code paused at a usage limit" })).toBeVisible();
    const reopenedPause = await reopened.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(reopenedPause?.id, bothBlocked.id);
    assert.deepEqual(reopenedPause?.quota, bothBlocked.quota);
    assert.equal(gateway.completions.length, 3);
    assert.equal(nativeRequests, 5);
    const resumePrompt = "Continue the work from its existing capped API segment.";
    const composer = reopened.getByRole("textbox", { name: "Code request" });
    const send = reopened.getByRole("button", { name: "Send follow-up instruction" });
    await composer.fill(resumePrompt);
    gateway.options.cappedContinuation = { creditCap: 51 };
    await send.click();
    await expect(reopened.getByRole("alert")).toBeVisible();
    await expect(composer).toHaveValue(resumePrompt);
    assert.equal(gateway.completions.length, 3);
    assert.equal(nativeRequests, 5);
    gateway.options.cappedContinuation = { creditCap: 45 };
    gateway.options.script = (body) => {
      assert.equal(body.model, "fake-coder");
      assert.equal(body.tomverse_max_key_credit_cap, 50);
      assert.match(JSON.stringify(body.messages), new RegExp(resumePrompt));
      return { text: "The capped API segment completed the task." };
    };
    await send.click();
    await expect(reopened.getByText("The capped API segment completed the task.", { exact: true })).toBeVisible();
    await expect.poll(() => reopened.evaluate(() => window.desktop.state().then(({ task }) => task?.status))).toBe("completed");
    const resumed = await reopened.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(resumed?.id, bothBlocked.id);
    assert.equal(resumed?.continuation?.segmentId, bothBlocked.continuation?.segmentId);
    const oldTask = reopened.getByRole("button", { name: new RegExp(objective) });
    await expect(oldTask).toHaveCount(1);
    await oldTask.click();
    const restored = (await reopened.evaluate(() => window.desktop.state())).task;
    assert.equal(restored?.id, completed.id);
    assert.deepEqual(restored?.continuation, completed.continuation);
    assert.deepEqual(restored?.plan, completed.plan);
    assert.ok(!restored?.canResume);
    await expect(reopened.getByText(answer, { exact: true })).toBeVisible();
    assert.equal(gateway.completions.length, 4);
    assert.equal(nativeRequests, 5);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const taskId = started.id;
    const removeTask = () => reopened.evaluate((id) => window.desktop.deleteHistory(id), taskId);
    const apiBytes = await readFile(api);
    const sourceCheckpoint = join(source, "session.json");
    const sourceBytes = await readFile(sourceCheckpoint);
    const lease = Journal.open(historyScope.home, taskId);
    try {
      assert.equal(await removeTask(), "locked");
      assert.deepEqual(await readFile(api), apiBytes);
      assert.deepEqual(await readFile(sourceCheckpoint), sourceBytes);
    } finally { lease.release(); }

    const nativeLock = join(source, "lock");
    claimLock(nativeLock, taskId);
    try {
      assert.equal(await removeTask(), "locked");
      assert.deepEqual(await readFile(api), apiBytes);
      assert.deepEqual(await readFile(sourceCheckpoint), sourceBytes);
    } finally { await unlink(nativeLock); }

    const changedSource = JSON.stringify({ ...saved, continuation: { ...saved.continuation, maximumKeyCreditCap: 49 } });
    await writeFile(sourceCheckpoint, changedSource);
    assert.equal(await removeTask(), "unavailable");
    assert.deepEqual(await readFile(api), apiBytes);
    assert.equal(await readFile(sourceCheckpoint, "utf8"), changedSource);
    await writeFile(sourceCheckpoint, sourceBytes);

    assert.equal(await removeTask(), "deleted");
    await assert.rejects(readFile(api), { code: "ENOENT" });
    await assert.rejects(readFile(sourceCheckpoint), { code: "ENOENT" });
    assert.ok(!(await readdir(join(historyScope.home, "sessions"))).some((name) => name.includes(taskId)));
    await expect(oldTask).toHaveCount(0);
  } finally {
    releaseFirstApiReply();
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((done) => endpoint.close(() => done()));
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test("Code pauses on the official Codex usage-limit terminal event and leaves generic 429 failed", {
  timeout: 85_000, skip: codex ? false : "Requires the pinned Codex executable",
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-code-native-quota-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const vendor = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse generation" }) });
  let requests = 0;
  const model = "gpt-5";
  const endpoint = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    const count = ++requests;
    if (count === 3) {
      writeCodexResponse(response, model, count, codexFixtureAnswer(count, "The saved Codex task is complete."));
      return;
    }
    const code = count === 1 ? "usage_limit_reached" : "rate_limit_exceeded";
    response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_fixture_limit" });
    response.end(JSON.stringify({ error: { type: code, code, message: "Synthetic limit", resets_at: 1_800_000_000 } }));
  });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), vendor.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const fixture = { executable: codex!, version: "0.171.0-alpha.13", model, origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true as const };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: vendor.base, key: TEST_KEY,
      codex: fixture }));
    app = await launch(descriptor);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    const request = (prompt: string) => page.evaluate(({ prompt, model }) => window.desktop.start({
      model, mode: "ask", effort: "default", executionMode: "provider_cli", prompt, saveHistory: true,
    }), { prompt, model });
    await request("Wait for the confirmed Codex quota");
    await expect.poll(async () => (await state()).task?.status, { timeout: 25_000 }).toBe("blocked");
    const pause = page.getByRole("region", { name: "Code paused at a usage limit" });
    await expect(pause.getByText("Overage unconfirmed")).toBeVisible();
    await expect(pause.getByText("Reset time unavailable")).toBeVisible();
    const codexTask = (await state()).task;
    assert.equal(codexTask?.quota?.source, "codex");
    assert.ok(codexTask.id);
    assert.equal(codexTask.quota.turnId, codexTask.nativeSession?.turnId);
    assert.equal(requests, 1);
    await request("Handle the Codex transient rate error");
    await expect.poll(async () => (await state()).task?.status, { timeout: 25_000 }).toBe("failed");
    await expect(pause).toHaveCount(0);
    assert.equal((await state()).task?.quota, undefined);
    await page.getByRole("button", { name: "Wait for the confirmed Codex quota" }).click();
    await expect(pause).toBeVisible();
    assert.equal(requests, 2);
    const followUp = "Resume the original saved Codex task.";
    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send follow-up instruction" });
    await composer.fill(followUp);
    const history = codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: vendor.base, key: TEST_KEY });
    const folder = nativeSessionDirectory(nativeHistoryHome(history.home, fixture, "openai"), codexTask.id);
    const checkpoint = join(folder, "session.json");
    const saved = await readFile(checkpoint);
    const lock = join(folder, "lock");
    claimLock(lock, codexTask.id);
    try {
      await send.click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(composer).toHaveValue(followUp);
      assert.deepEqual(await readFile(checkpoint), saved);
      assert.equal(requests, 2);
    } finally { await unlink(lock); }
    await send.click();
    await expect(page.getByText("The saved Codex task is complete.", { exact: true })).toBeVisible({ timeout: 25_000 });
    const resumed = (await state()).task;
    assert.equal(resumed?.id, codexTask.id);
    assert.equal(resumed?.nativeSession?.threadId, codexTask.nativeSession?.threadId);
    assert.equal(requests, 3);
    assert.equal(vendor.completions.length, 0);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((done) => endpoint.close(() => done()));
    await vendor.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
