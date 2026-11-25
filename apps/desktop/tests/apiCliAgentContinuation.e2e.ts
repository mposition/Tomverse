import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { codexFixtureAnswer, codexFixtureCall, flattenCodexTools, writeCodexResponse, type CodexRequest } from "./codex-response-fixture";

import { launchNativeFixture } from "./launch-native-fixture";
const executable = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;

async function allow(page: Page, label: string) {
  const button = page.getByRole("button", { name: label, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

test("Agent continuation verifies prior API edits and requires fresh approval for Codex changes", {
  timeout: 95_000, skip: executable ? false : "Requires the pinned Codex executable",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-api-codex-agent-"));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const model = "gpt-5.5";
  const taskTitle = "Make and verify the source edit";
  const sourceBytes = "Verified API edit bytes.\n";
  const destinationBytes = "Separately approved Codex edit.\n";
  const resumedBytes = "Freshly approved edit after the limit.\n";
  const answer = "Agent continuation is complete.";
  const sourceRow = "Apply the verified API edit";
  const cliRow = "Write the approved remaining change";
  const rows = [{ id: "first", title: sourceRow }];
  let sourceFile = "api-source.txt";
  let destinationRequests = 0;
  let sourceStep = 0;
  let receiptReads = 0;
  let lastRefusal = false;
  let scenario: "changes" | "resume" | "drift" | "summary" = "changes";
  let endpointError: unknown;
  const gateway = new FakeGateway({
    cappedContinuation: { creditCap: 50, beforeUsage: async () => {
      if (lastRefusal && ++receiptReads === 2 && scenario === "drift") {
        await writeFile(join(root, sourceFile), "An editor changed the verified result.\n");
      }
    } },
    script: () => {
      switch (sourceStep++) {
        case 0: return { toolCalls: [{ name: "update_task_plan", args: { revision: 0, items: rows, analysis: fixtureWorkAnalysis, activeId: "first" } }] };
        case 1: return { appliedEffortHeader: "default",
          toolCalls: [{ name: "apply_patch", args: { edits: [{ path: sourceFile, action: "create", content: sourceBytes }] } }] };
        case 2: return { toolCalls: [{ name: "update_task_plan", args: { revision: 1, items: rows, activeId: null, completeId: "first" } }] };
        default:
          assert.equal(sourceStep, 4);
          lastRefusal = true;
          return { fault: "http", status: 429, code: "key_credit_cap_reached", releasedReceipt: true };
      }
    },
  });
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    try {
      assert.equal(request.headers.authorization, undefined);
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(chunk);
      const body: CodexRequest = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      assert.equal(body.model, model);
      assert.equal((body as CodexRequest & { reasoning?: { effort?: string } }).reasoning?.effort, "high");
      const index = ++destinationRequests;
      const payload = JSON.stringify(body.input);
      const tools = flattenCodexTools(body.tools ?? []);
      const plan = (status: "in_progress" | "completed") =>
        codexFixtureCall(tools, index, "update_plan", { explanation: JSON.stringify(fixtureWorkAnalysis), plan: [{ step: cliRow, status }] });
      if (scenario === "summary") {
        assert.equal(index, 9);
        assert.match(payload, /completedEdits.*1/);
        assert.doesNotMatch(payload, /api-summary\.txt|Verified API edit bytes/);
        writeCodexResponse(response, model, index, codexFixtureAnswer(index, "The edit count is sufficient."));
      } else if (scenario === "resume") {
        assert.match(payload, /Continue from the verified edit and add the remaining file/);
        if (index === 5) {
          writeCodexResponse(response, model, index, plan("in_progress"));
        } else if (index === 6) {
          writeCodexResponse(response, model, index, codexFixtureCall(tools, index, "desktop_apply_patch", {
            edits: [{ path: "cli-resumed.txt", action: "create", content: resumedBytes }],
            explanation: "Apply the separately approved follow-up.",
          }));
        } else if (index === 7) {
          assert.match(payload, /approved Desktop patch was verified/);
          writeCodexResponse(response, model, index, plan("completed"));
        } else {
          assert.equal(index, 8);
          writeCodexResponse(response, model, index, codexFixtureAnswer(index, answer));
        }
      } else if (index === 1) {
        assert.equal(scenario, "changes");
        assert.match(payload, /api-source\.txt/);
        assert.match(payload, /New file edits require fresh Desktop approval/);
        assert.doesNotMatch(payload, /Verified API edit bytes|PRIVATE_AGENT_TAIL/);
        writeCodexResponse(response, model, index, plan("in_progress"));
      } else if (index === 2) {
        writeCodexResponse(response, model, index, codexFixtureCall(tools, index, "desktop_apply_patch", {
          edits: [{ path: "cli-destination.txt", action: "create", content: destinationBytes }],
          explanation: "Apply the remaining change.",
        }));
      } else if (index === 3) {
        assert.match(payload, /approved Desktop patch was verified/);
        writeCodexResponse(response, model, index, plan("completed"));
      } else {
        assert.equal(index, 4);
        response.writeHead(429, { "content-type": "application/json", "x-request-id": "req_fixture_limit" });
        response.end(JSON.stringify({ error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "Synthetic limit" } }));
      }
    } catch (error) {
      endpointError = error;
      response.writeHead(400).end();
    }
  });
  let app: ElectronApplication | undefined;
  const launch = () => launchNativeFixture(descriptor);
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(descriptor, JSON.stringify({
      root, profile, endpoint: gateway.base, key: TEST_KEY,
      codex: { executable, version: "0.171.0-alpha.13", model, origin: "http://127.0.0.1:" + address.port,
        allowSavedHistory: true, allowFileEdits: true },
    }));
    app = await launch();
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.evaluate(async (model) => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "openai" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "transfer", transfer: "summary_and_changes" });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    }, model);
    const start = (prompt: string) => page.evaluate((prompt) => window.desktop.start({
      model: "fake-coder", mode: "agent", effort: "high", executionMode: "tomverse_api", saveHistory: true, prompt,
    }), prompt);
    const [source] = await Promise.all([app.waitForEvent("window", { timeout: 20_000 }),
      start(taskTitle + "\n" + "Additional request context. ".repeat(8) + "PRIVATE_AGENT_TAIL")]);
    const first = (await state()).task;
    assert.ok(first?.id);
    await expect(source.getByRole("heading", { name: "api-source.txt · create" })).toBeVisible();
    await assert.rejects(readFile(join(root, "api-source.txt")), { code: "ENOENT" });
    const [destination] = await Promise.all([app.waitForEvent("window", { timeout: 25_000 }), allow(source, "Allow for this run")]);
    await expect(destination.getByRole("heading", { name: "cli-destination.txt · create" })).toBeVisible();
    await expect(destination.getByRole("button", { name: "Allow for this run", exact: true })).toHaveCount(0);
    assert.equal((await state()).task?.id, first.id);
    assert.equal(await readFile(join(root, "api-source.txt"), "utf8"), sourceBytes);
    await assert.rejects(readFile(join(root, "cli-destination.txt")), { code: "ENOENT" });
    await allow(destination, "Allow once");
    await expect.poll(async () => (await state()).task?.quota?.source, { timeout: 20_000 }).toBe("codex");
    const paused = (await state()).task;
    assert.ok(paused?.canResumeAfterQuota);
    assert.deepEqual(paused.nativeRuns?.[0]?.usage, { source: "codex_thread", totalTokens: 144 });
    assert.deepEqual(paused.nativeRuns?.[0]?.quota, paused.quota);
    assert.equal(paused.effort, "high");
    await expect(page.getByLabel("Model and reasoning effort")).toContainText(`${model} · High`);
    assert.equal(await readFile(join(root, "cli-destination.txt"), "utf8"), destinationBytes);
    scenario = "resume";
    await page.getByRole("textbox", { name: "Code request" }).fill("Continue from the verified edit and add the remaining file.");
    const [resumedApproval] = await Promise.all([app.waitForEvent("window", { timeout: 25_000 }),
      page.getByRole("button", { name: "Send follow-up instruction" }).click()]);
    await expect(resumedApproval.getByRole("heading", { name: "cli-resumed.txt · create" })).toBeVisible();
    await assert.rejects(readFile(join(root, "cli-resumed.txt")), { code: "ENOENT" });
    await allow(resumedApproval, "Allow once");
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    assert.equal(await readFile(join(root, "cli-resumed.txt"), "utf8"), resumedBytes);
    assert.equal(await readFile(join(root, "cli-destination.txt"), "utf8"), destinationBytes);
    const finished = (await state()).task;
    assert.ok(finished?.cliContinuation?.stage === "started");
    assert.equal(finished.readOnly, false);
    assert.deepEqual(finished.plan?.items.map(({ title, complete }) => [title, complete]), [[sourceRow, true], [cliRow, true]]);
    assert.deepEqual(finished.plan?.items.map(({ segmentId }) => segmentId), [first.id, finished.cliContinuation.segmentId]);
    assert.equal(finished.plan?.items[0]?.evidence[0]?.appliedEffort, "default");
    assert.equal(finished.plan?.items[1]?.evidence[0]?.appliedEffort, undefined);
    const nativeEvidence = page.locator(".code-task-list-item").filter({ hasText: cliRow });
    await nativeEvidence.locator("summary").click();
    const reportedEffort = nativeEvidence.getByText(/Model unconfirmed · Applied effort unconfirmed/);
    await expect(reportedEffort).toHaveCount(2);
    await expect(reportedEffort.first()).toBeVisible();
    await expect(reportedEffort.last()).toBeVisible();
    assert.equal(finished.transmission.filter(({ receipt }) => receipt.status === "settled").length, 3);
    assert.ok(finished.transmission.every(({ segmentId, requestId }) => segmentId === first.id && requestId));
    assert.equal(finished.transmission.at(-1)?.quota?.reason, "key_credit_cap_reached");
    assert.equal(finished.nativeRuns?.length, 2);
    assert.deepEqual(finished.nativeRuns?.[0], paused.nativeRuns?.[0]);
    assert.deepEqual(finished.nativeRuns?.[1]?.usage, { source: "codex_thread", totalTokens: 336 });
    await page.getByText("View execution and usage", { exact: true }).click();
    await page.getByText("Provider usage · Codex", { exact: true }).click();
    await expect(page.getByText(/Billing source unconfirmed/)).toBeVisible();
    await expect(page.getByText("Reported thread total · 144 tokens", { exact: true })).toBeVisible();
    await expect(page.getByText("Reported thread total · 336 tokens", { exact: true })).toBeVisible();
    await page.getByText("API requests · 4", { exact: true }).click();
    await expect(page.getByText("9 credits charged · 0 credits held · 0 receipts unconfirmed", { exact: true })).toBeVisible();
    const artifacts = process.env.TOMVERSE_CODE_CONTINUATION_QA;
    if (artifacts) await page.locator(".code-continuation-details").screenshot({ path: join(artifacts, "mixed-execution-usage.png") });
    assert.equal(gateway.completions.length, 4);
    assert.equal(destinationRequests, 8);
    assert.ifError(endpointError);

    scenario = "drift";
    sourceFile = "api-drift.txt";
    sourceStep = receiptReads = 0;
    lastRefusal = false;
    const [drift] = await Promise.all([app.waitForEvent("window", { timeout: 20_000 }), start("Pause when the verified source file changes")]);
    await allow(drift, "Allow once");
    await expect.poll(async () => (await state()).task?.cliContinuation?.stage).toBe("unavailable");
    assert.equal((await state()).task?.status, "blocked");
    assert.match(await readFile(join(root, sourceFile), "utf8"), /An editor changed/);
    assert.equal(destinationRequests, 8);

    scenario = "summary";
    sourceFile = "api-summary.txt";
    sourceStep = receiptReads = 0;
    lastRefusal = false;
    await page.evaluate(async () => {
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "transfer", transfer: "summary" });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    const [summary] = await Promise.all([app.waitForEvent("window", { timeout: 20_000 }), start("Continue with only the approved summary")]);
    await allow(summary, "Allow once");
    await expect(page.getByText("The edit count is sufficient.", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    assert.equal(destinationRequests, 9);
    assert.ifError(endpointError);

    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.getByRole("button", { name: "Open local folder" }).click();
    await reopened.getByRole("complementary", { name: "History" }).getByRole("button", { name: new RegExp(taskTitle) }).click();
    await expect(reopened.getByText(answer, { exact: true })).toBeVisible();
    const saved = await reopened.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(saved?.id, first.id);
    assert.deepEqual(saved?.nativeSession, finished.nativeSession);
    assert.deepEqual(JSON.parse(JSON.stringify(saved?.nativeRuns)), JSON.parse(JSON.stringify(finished.nativeRuns)));
    assert.deepEqual(saved?.apiUsage, finished.apiUsage);
    assert.deepEqual(saved?.changes, finished.changes);
    const [apiChange, cliChange] = saved?.changes ?? [];
    assert.ok(apiChange && cliChange);
    const inspect = (id: string) => reopened.evaluate((id) => window.desktop.readChange(id), id);
    const apiDiff = await inspect(apiChange.id);
    const cliDiff = await inspect(cliChange.id);
    assert.match(apiDiff?.text ?? "", /Verified API edit bytes/);
    assert.match(cliDiff?.text ?? "", /Separately approved Codex edit/);
    assert.equal(apiDiff?.canUndo, true);
    assert.equal(cliDiff?.canUndo, false);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    assert.equal(await reopened.evaluate((id) => window.desktop.undoChange(id), apiChange.id), "undone");
    await assert.rejects(readFile(join(root, "api-source.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "cli-destination.txt"), "utf8"), destinationBytes);
    const undone = await reopened.evaluate(() => window.desktop.state().then(({ task }) => task));
    assert.equal(undone?.changes[1]?.id, cliChange.id);
    assert.equal(destinationRequests, 9);
    assert.equal(gateway.completions.length, 12);
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
