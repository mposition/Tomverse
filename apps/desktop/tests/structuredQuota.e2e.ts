import assert from "node:assert/strict";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const cases = [
  {
    key: "grok", name: "Grok Build", version: "1.0.92", executable: process.env.TOMVERSE_DESKTOP_GROK_TASK_BINARY,
    faults: [
      { title: "Report a temporary rate limit", http: 429, code: "rate_limit_error",
        message: "A rate limit can mention subscription:free-usage-exhausted.", expected: "failed" },
      { title: "Report a generic payment failure", http: 402, code: "payment_required",
        message: "This request requires payment.", expected: "failed" },
      { title: "Report the free allowance is exhausted", http: 429, code: "subscription:free-usage-exhausted",
        message: "The free usage allowance is exhausted.", expected: "blocked", flat: true },
    ],
  },
  {
    key: "kimi", name: "Kimi Code", version: "2.7.2", executable: process.env.TOMVERSE_DESKTOP_KIMI_TASK_BINARY,
    faults: [
      { title: "Report a refused model request", http: 403, code: "permission_error",
        message: "Permission to use the model was denied.", expected: "failed" },
      { title: "Report an ambiguous billing refusal", http: 403, code: "permission_error",
        message: "The billing cycle usage limit has been reached.", expected: "failed" },
      { title: "Leave a silent provider response unconfirmed", http: 402, code: "insufficient_quota",
        message: "Insufficient Balance", expected: "unknown" },
    ],
  },
  {
    key: "minimax", name: "MiniMax Code", version: "0.7.9", executable: process.env.TOMVERSE_DESKTOP_MINIMAX_TASK_DIR,
    faults: [
      { title: "Leave the empty MiniMax turn unconfirmed", http: 200, text: "", expected: "unknown" },
      { title: "Report an invalid MiniMax connection", http: 401, code: "authentication_error",
        message: "Invalid authentication.", expected: "failed" },
      { title: "Report a MiniMax billing error without quota evidence", http: 402, code: "payment_required",
        message: "Insufficient Balance (2056).", expected: "failed" },
      { title: "Report a rejected MiniMax request", http: 403, code: "permission_error",
        message: "This request is not authorized.", expected: "failed" },
      { title: "Finish with a MiniMax response", http: 200, text: "MiniMax returned an answer.", expected: "completed" },
    ],
  },
  {
    key: "vibe", name: "Mistral Vibe", version: "3.1.4", executable: process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE,
    faults: [
      { title: "Leave the empty Vibe turn unconfirmed", http: 200, text: "", expected: "unknown" },
      { title: "Report a Vibe payment refusal", http: 402, code: "insufficient_quota",
        message: "The request requires payment.", expected: "failed" },
      { title: "Report a Vibe permission error", http: 403, code: "permission_error",
        message: "The account cannot use this model.", expected: "failed" },
      { title: "Finish after a temporary Vibe rate limit", http: 200, retry: true,
        text: "Vibe answered after retrying.", expected: "completed" },
    ],
  },
] as const;
const linux = process.platform === "linux";
const taskWait = linux ? 100_000 : 30_000;

function sendCompletion(response: ServerResponse, model: string, text: string) {
  const chunk = { id: "native-quota-fixture", object: "chat.completion.chunk", created: 1, model };
  const send = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  send({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", ...(text && { content: text }) }, finish_reason: null }] });
  send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  const output = text ? 6 : 0;
  send({ ...chunk, choices: [], usage: { prompt_tokens: 17, completion_tokens: output, total_tokens: 17 + output } });
  response.end("data: [DONE]\n\n");
}

for (const vendor of cases) test(`${vendor.name} classifies only confirmed native quota and keeps the task history`, {
  timeout: 5 * taskWait, skip: !vendor.executable,
}, async () => {
  const miniMax = vendor.key === "minimax";
  const temp = await realpath(await mkdtemp(join(tmpdir(), miniMax ? "tv-" : "tomverse-quota-qa-")));
  const project = join(temp, "project"), profile = join(temp, miniMax ? "p" : "profile"), descriptor = join(temp, "fixture.json");
  const gateway = new FakeGateway({ script: () => ({ text: "An unexpected fallback ran." }) });
  const model = "quota-desktop-fixture";
  let fault: (typeof cases)[number]["faults"][number] | undefined;
  let retryBeforeSuccess = false;
  let modelRequests = 0;
  let app: ElectronApplication | undefined;
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" || !fault) {
      response.writeHead(403).end();
      return;
    }
    const current = fault;
    request.resume();
    await once(request, "end");
    modelRequests++;
    if (current.http === 200) {
      if (!retryBeforeSuccess) return sendCompletion(response, model, current.text);
      retryBeforeSuccess = false;
      return response.writeHead(429, { "content-type": "application/json", "retry-after": "0" }).end(JSON.stringify({
        error: { code: "rate_limit_error", type: "rate_limit_error", message: "Synthetic temporary request limit." },
      }));
    }
    const error = { code: current.code, message: current.message };
    const body = "flat" in current && current.flat ? error : { error: { ...error, type: current.code } };
    response.writeHead(current.http, { "content-type": "application/json", "retry-after": "0" });
    response.end(JSON.stringify(body));
  });
  endpoint.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  try {
    await Promise.all([mkdir(project), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(descriptor, JSON.stringify({ root: project, profile, endpoint: gateway.base, key: TEST_KEY, [vendor.key]: {
      executable: vendor.executable, version: vendor.version, model,
      origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true,
    } }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const snapshot = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await expect.poll(async () => (await snapshot()).models.some(({ id }) => id === "fake-coder"), { timeout: taskWait }).toBe(true);
    await page.evaluate(async () => {
      await window.desktop.setCodeExecutionPreference("provider_cli");
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "tomverse_api" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model: "fake-coder" });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    assert.equal((await snapshot()).codeFallback?.settings.automaticFrom, "provider_cli");

    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    const quota = page.getByRole("region", { name: "Code paused at a usage limit" });
    let unconfirmed: Awaited<ReturnType<typeof snapshot>>["task"] = null;
    for (const scenario of vendor.faults) {
      fault = scenario;
      retryBeforeSuccess = "retry" in scenario && scenario.retry;
      const before = modelRequests;
      const expected = scenario.expected;
      if ((await snapshot()).task?.status === "blocked") {
        await page.getByRole("button", { name: "New task", exact: true }).click();
      }
      await selectCodeMode(page, "ask");
      await page.getByRole("checkbox", { name: "Save to local history" }).check();
      await composer.fill(scenario.title);
      await send.click();
      await expect.poll(async () => {
        const task = (await snapshot()).task;
        return [task?.title, task?.status];
      }, { timeout: taskWait }).toEqual([scenario.title, expected]);
      const { task } = await snapshot();
      assert.equal(task?.root, project);
      assert.ok(modelRequests > before, `No CLI model request for ${scenario.title}`);
      if ("retry" in scenario && scenario.retry) assert.ok(modelRequests >= before + 2);
      assert.equal(task?.continuation, undefined);
      assert.equal(task?.canResumeAfterQuota, false);
      if (expected === "unknown") unconfirmed = task;
      if (scenario.http === 200 && scenario.text) {
        await expect(page.getByText(scenario.text, { exact: true })).toBeVisible();
      }
      if (expected === "blocked") {
        assert.equal(task?.quota?.source, "grok_build");
        assert.equal(task?.quota?.reason, "grokFreeUsageExhausted");
        await expect(quota).toContainText("Grok Build reported that its free usage allowance is exhausted.");
        await expect(quota).toContainText("Reset time unavailable");
        await expect(quota).toContainText("Remaining allowance unconfirmed");
        await expect(quota).toContainText("Overage unconfirmed");
      } else {
        assert.equal(task?.quota, undefined);
        await expect(quota).toHaveCount(0);
      }
    }
    const saved = unconfirmed ?? (await snapshot()).task;
    assert.ok(saved?.id && saved.nativeSession);
    await app.close();
    app = await launchNativeFixture(descriptor);
    const restored = await app.firstWindow();
    await openCodeProject(restored);
    await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: saved.title, exact: true }).click();
    await expect.poll(async () => (await restored.evaluate(() => window.desktop.state())).task?.id).toBe(saved.id);
    const task = (await restored.evaluate(() => window.desktop.state())).task;
    assert.deepEqual(task?.nativeSession, saved.nativeSession);
    assert.deepEqual(task?.quota, saved.quota);
    assert.equal(task?.status, saved.status);
    assert.equal(gateway.completions.length, 0);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await gateway.stop();
    await removeNativeFixtureDirectory(temp);
  }
});
