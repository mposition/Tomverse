import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeProject } from "./code-project-fixture";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { apiCliDirectory, nativeSessionDirectory, readNativeCheckpoint } from "../src/host/native-history";
import { bindProjectRoot } from "../src/host/project-root";
import { codexFixtureAnswer, writeCodexResponse } from "./codex-response-fixture";
import { launchNativeFixture } from "./launch-native-fixture";
const codex = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;

test("A reconciled API refusal starts one confirmed read-only Codex continuation and preserves the same task", {
  timeout: 90_000, skip: codex ? false : "Requires the pinned Codex executable",
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-api-cli-continuation-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const model = "gpt-5.5";
  const heading = "Inspect remaining project evidence";
  const privateTail = "PRIVATE_ORIGINAL_REQUEST_TAIL";
  const marker = "PRIVATE_API_FILE_RECEIPT";
  const answer = "Codex continued the inspection.";
  const resumePrompt = "Resume the saved Codex turn after the limit clears.";
  const resumedAnswer = "Codex finished the same task.";
  const rows = [{ id: "read", title: "Check the marker" }, { id: "report", title: "Report remaining findings" }];
  let phase: "settled" | "held" | "generic" | "revoked" | "key_revoked" | "late_stop" | "both_blocked" |
    "source_recovered" | "manual_resume" = "settled";
  let step = 0;
  let receiptReads = 0;
  let keyReceiptReads = 0;
  let stopReceiptReads = 0;
  let heldRequest: string | undefined;
  let releaseUsage!: () => void;
  const duringRevocation = new Promise<void>((resolve) => { releaseUsage = resolve; });
  let releaseFinalStatus!: () => void;
  const duringStop = new Promise<void>((resolve) => { releaseFinalStatus = resolve; });
  const gateway: FakeGateway = new FakeGateway({
    beforeStatus: async (requestId) => {
      if (phase === "key_revoked" && requestId && ++keyReceiptReads === 2) gateway.revoked = true;
      if (phase === "late_stop" && requestId && ++stopReceiptReads === 3) await duringStop;
    },
    cappedContinuation: { creditCap: 50, beforeUsage: async () => {
      if (!heldRequest) return;
      receiptReads += 1;
      if (receiptReads === 2 && phase === "revoked") await duringRevocation;
      if (receiptReads === 2 && phase === "settled") {
        const receipt = gateway.receipts.get(heldRequest);
        assert.ok(receipt);
        Object.assign(receipt, { status: "settled", chargedCredits: 3, heldCredits: 0 });
      }
    } },
    script: (_body, index) => {
      if (phase === "source_recovered" || phase === "manual_resume") return { text: "The original API route is available again." };
      if (phase === "generic") return { fault: "http", status: 429, code: "rate_limit_exceeded" };
      if (phase === "key_revoked" || phase === "late_stop" || phase === "both_blocked") {
        return { fault: "http", status: 429, code: "key_credit_cap_reached", releasedReceipt: true };
      }
      switch (step++) {
        case 0: return { toolCalls: [{ name: "update_task_plan", args: { revision: 0, items: rows, analysis: fixtureWorkAnalysis, activeId: null } }] };
        case 1: return { toolCalls: [{ name: "read_file", args: { path: "marker.txt" } }] };
        case 2: return { toolCalls: [{ name: "update_task_plan", args: { revision: 1, items: rows, activeId: null } }] };
        default: {
          assert.equal(step, 4, `Unexpected API completion ${index}`);
          const latest = [...gateway.receipts.values()].at(-1);
          assert.ok(latest);
          heldRequest = latest.requestId;
          receiptReads = 0;
          Object.assign(latest, { status: "held", chargedCredits: null, heldCredits: 3 });
          return { fault: "http", status: 429, code: "key_credit_cap_reached", releasedReceipt: true };
        }
      }
    },
  });
  let codexRequests = 0;
  let nativeError: unknown;
  const codexModel = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    codexRequests += 1;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(JSON.parse(raw).model, model);
      if (phase === "manual_resume") {
        assert.ok(raw.includes(resumePrompt));
        writeCodexResponse(response, model, codexRequests, codexFixtureAnswer(codexRequests, resumedAnswer));
        return;
      }
      assert.match(raw, /Continue the unfinished work from this checkpoint/);
      if (phase === "key_revoked" || phase === "late_stop") {
        writeCodexResponse(response, model, codexRequests, codexFixtureAnswer(codexRequests, "This request should have been blocked."));
        return;
      }
      if (phase === "both_blocked") {
        response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_fixture_limit" });
        response.end(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "Synthetic limit" } }));
        return;
      }
      const proposals = JSON.stringify(rows.map(({ title }) => ({ title, status: "pending" })));
      assert.ok(raw.includes(JSON.stringify(proposals).slice(1, -1)), "The checkpoint must carry both proposals as pending work.");
      for (const value of [privateTail, marker, TEST_KEY]) assert.ok(!raw.includes(value));
      writeCodexResponse(response, model, codexRequests, codexFixtureAnswer(codexRequests, answer));
    } catch (error) {
      nativeError = error;
      response.writeHead(400).end();
    }
  });
  let app: ElectronApplication | undefined;
  const open = () => launchNativeFixture(descriptor);
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await Promise.all([writeFile(join(profile, "language.txt"), "en"), writeFile(join(root, "marker.txt"), marker)]);
    codexModel.listen(0, "127.0.0.1");
    await once(codexModel, "listening");
    const address = codexModel.address();
    assert.ok(address && typeof address !== "string");
    const fixture = { executable: codex, version: "0.171.0-alpha.13", model, origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, codex: fixture }));
    app = await open();
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await expect.poll(async () => (await state()).codeFallback?.scope).toBeTruthy();
    await page.evaluate(async (model) => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "openai" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    }, model);
    const start = (prompt: string) => page.evaluate((prompt) => window.desktop.start({ model: "fake-coder",
      mode: "plan", effort: "default", executionMode: "tomverse_api", prompt, saveHistory: true }), prompt);
    await start(`${heading}\n${"Long private prompt detail. ".repeat(5)}${privateTail}`);
    await expect(page.getByText(answer, { exact: true })).toBeVisible({ timeout: 35_000 });
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    const finished = (await state()).task;
    assert.ok(finished?.id && finished.nativeSession && finished.cliContinuation);
    assert.equal(finished.cliContinuation.stage, "started");
    assert.equal(finished.execution?.billingSource, "unknown");
    assert.equal(finished.transmission.filter(({ receipt }) => receipt.status === "settled").length, 3);
    assert.equal(finished.plan?.proposalOnly, true);
    assert.deepEqual(finished.plan?.items.map(({ id, complete }) => [id, complete]), [["read", false], ["report", false]]);
    assert.equal(receiptReads, 2, "The earlier hold settles during the continuation's second reconciliation read");
    assert.equal(gateway.completions.length, 4);
    assert.equal(codexRequests, 1);
    assert.equal(nativeError, undefined);
    const scope = codeHistoryScope(profile, null, bindProjectRoot(root), { key: TEST_KEY, endpoint: gateway.base });
    const directory = apiCliDirectory(scope.home, finished.id);
    const saved = readNativeCheckpoint(directory, finished.id, root, "openai");
    assert.equal(saved?.apiSource?.segmentId, finished.cliContinuation.segmentId);
    assert.deepEqual(saved?.nativeSession, finished.nativeSession);
    await expect(page.getByText("Tomverse API reached its usage limit. Codex is continuing the same task.", { exact: true })).toBeVisible();

    phase = "held";
    step = 0;
    await start("Pause while an earlier API receipt is held");
    await expect.poll(async () => (await state()).task?.cliContinuation?.stage).toBe("unavailable");
    assert.equal((await state()).task?.status, "blocked");
    assert.equal(gateway.completions.length, 8);
    assert.equal(codexRequests, 1);

    phase = "generic";
    await start("Pause on a transient API rate limit");
    await expect.poll(async () => (await state()).task?.status).toBe("failed");
    assert.equal((await state()).task?.cliContinuation, undefined);
    assert.equal(codexRequests, 1);

    phase = "revoked";
    step = 0;
    await start("Revoke the fallback while the receipt is still being checked");
    await expect.poll(() => receiptReads).toBe(2);
    await expect.poll(async () => (await state()).task?.cliContinuation?.stage).toBe("checking");
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: false });
    });
    await expect.poll(async () => (await state()).task?.cliContinuation?.stage).toBe("unavailable");
    releaseUsage();
    assert.equal((await state()).task?.status, "blocked");
    assert.equal(codexRequests, 1);

    phase = "key_revoked";
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    const statusRequestsBefore = gateway.requests.filter(({ url }) => url.startsWith("/api/code/v1/requests/status")).length;
    await start("Revoke the API key after confirming its refusal");
    await expect.poll(async () => (await state()).task?.cliContinuation?.stage, { timeout: 25_000 }).toBe("unavailable");
    assert.equal((await state()).task?.status, "blocked");
    assert.equal(codexRequests, 1);
    assert.equal(keyReceiptReads, 2);
    assert.equal(gateway.requests.filter(({ url }) => url.startsWith("/api/code/v1/requests/status")).length - statusRequestsBefore, 3);

    gateway.revoked = false;
    phase = "late_stop";
    await start("Stop while the API receipt is being checked before the Codex prompt");
    await expect.poll(() => stopReceiptReads, { timeout: 25_000 }).toBe(3);
    const stopping = (await state()).task;
    assert.ok(stopping?.id);
    await page.evaluate(() => window.desktop.stop());
    await expect.poll(async () => (await state()).busy, { timeout: 20_000 }).toBe(false);
    releaseFinalStatus();
    assert.equal((await state()).task?.status, "blocked");
    const stoppedCheckpoint = readNativeCheckpoint(apiCliDirectory(scope.home, stopping.id), stopping.id, root, "openai");
    assert.equal(stoppedCheckpoint?.status, "stopped");
    assert.equal(codexRequests, 1);

    phase = "both_blocked";
    const bothBlockedTitle = "Keep the task paused after both execution routes reach their limits";
    await start(bothBlockedTitle);
    await expect.poll(async () => (await state()).task?.quota?.source, { timeout: 25_000 }).toBe("codex");
    const paused = (await state()).task;
    assert.ok(paused?.id);
    assert.equal(paused.status, "blocked");
    assert.equal(paused.cliContinuation?.stage, "started");
    assert.equal(gateway.completions.length, 16);
    assert.equal(codexRequests, 2);

    phase = "source_recovered";
    await app.close();
    app = await open();
    const restored = await app.firstWindow();
    await openCodeProject(restored);
    const openSavedTask = async (name: string | RegExp) => {
      const showHistory = restored.getByRole("button", { name: "Show history", exact: true });
      if (await showHistory.isVisible()) await showHistory.click();
      await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name, exact: true }).click();
    };
    await openSavedTask(bothBlockedTitle);
    await expect(restored.getByRole("region", { name: "Code paused at a usage limit" })).toBeVisible();
    const reopenedPause = await restored.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(reopenedPause?.id, paused.id);
    assert.deepEqual(reopenedPause?.quota, paused.quota);
    assert.equal(gateway.completions.length, 16);
    assert.equal(codexRequests, 2);
    const composer = restored.getByRole("textbox", { name: "Code request" });
    const send = restored.getByRole("button", { name: "Send follow-up instruction" });
    await composer.fill(resumePrompt);
    gateway.revoked = true;
    await send.click();
    await expect(restored.getByRole("alert")).toBeVisible();
    await expect(composer).toHaveValue(resumePrompt);
    assert.equal(codexRequests, 2);
    gateway.revoked = false;
    phase = "manual_resume";
    await send.click();
    await expect(restored.getByText(resumedAnswer, { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => restored.evaluate(() => window.desktop.state().then(({ task }) => task?.status))).toBe("completed");
    const resumed = await restored.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(resumed?.id, paused.id);
    assert.equal(resumed?.cliContinuation?.segmentId, paused.cliContinuation?.segmentId);
    assert.equal(resumed?.nativeSession?.threadId, paused.nativeSession?.threadId);
    assert.notEqual(resumed?.nativeSession?.turnId, paused.nativeSession?.turnId);
    assert.equal(gateway.completions.length, 16);
    assert.equal(codexRequests, 3);
    await openSavedTask(new RegExp(heading));
    await expect(restored.getByText(answer, { exact: true })).toBeVisible();
    const task = await restored.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(task?.id, finished.id);
    assert.deepEqual(task?.nativeSession, finished.nativeSession);
    assert.equal(task?.transmission.filter(({ receipt }) => receipt.status === "settled").length, 3);
    assert.equal(gateway.completions.length, 16);
    assert.equal(codexRequests, 3);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    assert.equal(await restored.evaluate((id) => window.desktop.deleteHistory(id), finished.id), "deleted");
    await assert.rejects(access(nativeSessionDirectory(scope.home, finished.id)), { code: "ENOENT" });
    await assert.rejects(access(directory), { code: "ENOENT" });
  } catch (error) {
    const page = app?.windows()[0];
    const task = page && !page.isClosed() ? await page.evaluate(() => window.desktop.state().then(({ task }) => task)) : undefined;
    throw new Error(JSON.stringify({ task, phase, codexRequests, apiRequests: gateway.completions.length,
      nativeError: String(nativeError ?? ""), assertion: error instanceof Error ? error.message : String(error) }), { cause: error });
  } finally {
    releaseUsage();
    releaseFinalStatus();
    await app?.close();
    codexModel.closeAllConnections();
    await new Promise<void>((resolve) => codexModel.close(() => resolve()));
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
