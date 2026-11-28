import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { nativeHistoryHome, nativeSessionDirectory } from "../src/host/native-history";
import { codeHistoryScope } from "../src/host/history-scope";
import { bindProjectRoot } from "../src/host/project-root";
import { codexFixtureAnswer, codexFixtureCall, flattenCodexTools, writeCodexResponse, type CodexRequest } from "./codex-response-fixture";
import { launchNativeFixture } from "./launch-native-fixture";

const binary = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;

test("Code steers, resumes and checks saved Codex work without replaying uncertain requests", {
  timeout: 120_000,
  skip: binary ? false : "Requires the pinned Codex executable and a development fixture",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-desktop-native-code-"));
  const root = join(temp, "project");
  const profile = join(temp, "profile");
  const model = "gpt-5.4";
  const vendor = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  const followUp = "Check keyboard navigation before concluding";
  const stopFollowUp = "Consider another scenario before concluding";
  const revisedTitle = "Verify keyboard navigation";
  const firstDelta = "The revised Codex plan";
  const finalAnswer = `${firstDelta} is ready.`;
  const workspaceMarker = "Search fixture available through the Desktop workspace reader.";
  const stopDelta = "An unfinished answer";
  const savedPrompt = "Inspect the project and save this task";
  const continuedAnswer = "The saved Codex task continued.";
  const crashPrompt = "Inspect the project until the Code runtime exits";
  const requests: CodexRequest[] = [];
  let requestedListing = false;
  let waitingToRevise = false;
  let requestError: unknown;
  let savedDirectory: string | undefined;
  const held = new Set<number>();
  const heldClosed = new Set<number>();
  let resumeCurrentResponse!: () => void;
  const currentResponse = new Promise<void>((resolve) => { resumeCurrentResponse = resolve; });
  let finishAnswer!: () => void;
  const remainingAnswer = new Promise<void>((resolve) => { finishAnswer = resolve; });
  let finishStopAnswer!: () => void;
  const remainingStopAnswer = new Promise<void>((resolve) => { finishStopAnswer = resolve; });
  const endpoint = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    try {
      assert.equal(request.headers.authorization, undefined);
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 512_000);
        parts.push(chunk);
      }
      const body: CodexRequest = JSON.parse(Buffer.concat(parts).toString());
      assert.equal(body.model, model);
      const tools = flattenCodexTools(body.tools ?? []);
      if (!requestedListing) {
        requestedListing = true;
        assert.ok(!tools.some(({ name }) => ["exec_command", "shell_command", "shell", "write_stdin", "desktop_apply_patch"].includes(name)));
        writeCodexResponse(response, model, 100, codexFixtureCall(tools, 100, "desktop_list_files", {}));
        return;
      }
      if (requests.length === 2 && !waitingToRevise) {
        waitingToRevise = true;
        await currentResponse;
        writeCodexResponse(response, model, 101, codexFixtureCall(tools, 101, "update_plan", { plan: [
          { step: "Inspect search behavior", status: "completed" }, { step: "Check keyboard search", status: "pending" },
        ] }));
        return;
      }
      const index = requests.push(body);
      if (index <= 4) assert.ok(!tools.some(({ name }) => ["exec_command", "shell_command", "shell", "write_stdin"].includes(name)));
      const plan = (firstStatus: string, secondTitle = "Check keyboard search", secondStatus = "pending") =>
        codexFixtureCall(flattenCodexTools(body.tools ?? []), index, "update_plan", {
          plan: [
            { step: "Inspect search behavior", status: firstStatus },
            { step: secondTitle, status: secondStatus },
          ],
        });
      if (index === 1) {
        const outputs = JSON.stringify(body.input?.filter(({ type }) => type === "function_call_output"));
        assert.match(outputs, /marker\.txt/);
        assert.doesNotMatch(outputs, /\.env/);
        writeCodexResponse(response, model, index, codexFixtureCall(tools, index, "desktop_read_file", { path: "marker.txt" }));
      }
      else if (index === 2) {
        assert.ok(body.input?.some(({ type, output }) => type === "function_call_output" && JSON.stringify(output).includes(workspaceMarker)));
        writeCodexResponse(response, model, index, plan("in_progress"));
      } else if (index === 3) {
        assert.ok(JSON.stringify(body.input).includes(followUp));
        writeCodexResponse(response, model, index, plan("completed", revisedTitle, "in_progress"));
      } else if (index === 4) {
        await writeCodexResponse(response, model, index, codexFixtureAnswer(index, finalAnswer), { firstDelta, rest: remainingAnswer });
      } else if (index === 5 || index === 7 || index === 9 || index === 11 || index === 13 || index === 17) {
        writeCodexResponse(response, model, index, plan("in_progress"));
      }
      else if (index === 15) {
        const input = JSON.stringify(body.input);
        assert.ok(savedDirectory);
        const checkpoint = JSON.parse(await readFile(join(savedDirectory, "session.json"), "utf8"));
        assert.equal(checkpoint.status, "unknown");
        assert.equal(input.split(savedPrompt).length - 1, 1);
        assert.equal(input.split("Continue the stopped task from its saved context.").length - 1, 1);
        writeCodexResponse(response, model, index, plan("completed", "Confirm the restored project", "in_progress"));
      } else if (index === 16) writeCodexResponse(response, model, index, codexFixtureAnswer(index, continuedAnswer));
      else {
        assert.ok(index === 6 || index === 8 || index === 10 || index === 12 || index === 14 || index === 18);
        response.once("close", () => { heldClosed.add(index); });
        held.add(index);
        if (index === 8) {
          await writeCodexResponse(response, model, index, codexFixtureAnswer(index, `${stopDelta} would end here.`),
            { firstDelta: stopDelta, rest: remainingStopAnswer });
        } else if (index !== 6) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting for the lifecycle stop\n\n");
        }
      }
    } catch (error) {
      requestError = error;
      response.writeHead(400).end("Unexpected fixture request");
    }
  });
  endpoint.on("connect", (_request, socket) => socket.destroy());
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), vendor.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(root, "marker.txt"), workspaceMarker);
    await writeFile(join(root, ".env"), "FIXTURE_ONLY=dummy\n");
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const descriptor = join(temp, "fixture.json");
    const codex = { executable: binary!, version: "0.171.0-alpha.13", model, origin: `http://127.0.0.1:${address.port}`, allowSavedHistory: true as const };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: vendor.base, key: TEST_KEY,
      codex }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    assert.equal((await state()).codexFixtureModel, model);
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByRole("button", { name: "Desktop settings" }).click();
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByLabel("Preferred execution mode").selectOption("provider_cli");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByText("Codex · Local test", { exact: true })).toBeVisible();
    const mode = page.getByLabel("Code mode");
    await expect(mode).toHaveValue("ask");
    assert.equal(await mode.locator('option[value="agent"]').isDisabled(), true);
    const retention = page.getByRole("checkbox", { name: "Save to local history" });
    await expect(retention).toBeEnabled();
    await expect(retention).not.toBeChecked();
    await assert.rejects(page.evaluate((model) => window.desktop.start({ model, prompt: "Rejected fixture mode", mode: "agent", effort: "default",
      executionMode: "provider_cli", saveHistory: false }), model), /read-only request/);
    assert.equal(requests.length, 0);

    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    const steer = page.getByRole("button", { name: "Send follow-up instruction", exact: true });
    const request = page.getByRole("textbox", { name: "Code request", exact: true });
    await mode.selectOption("plan");
    await request.fill("Inspect the search plan only");
    await send.click();
    await expect.poll(() => waitingToRevise, { timeout: 30_000 }).toBe(true);
    await expect(page.locator('.code-task-list [data-status="pending"]')).toHaveCount(2);
    const inFlight = (await state()).task?.nativeSession;
    assert.ok(inFlight);
    assert.equal(await page.evaluate(({ threadId }) => window.desktop.followUp({ threadId, turnId: "stale-turn" }, "Foreign turn"), inFlight), false);
    await request.fill(followUp);
    await steer.click();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    await expect(request).toHaveValue(followUp);
    assert.ok(requests.every(({ input }) => !JSON.stringify(input).includes(followUp)));
    resumeCurrentResponse();
    await expect(page.getByText(firstDelta, { exact: true })).toBeVisible();
    const streaming = (await state()).task;
    assert.equal(streaming?.status, "running");
    assert.equal(streaming.streamingAnswer, firstDelta);
    assert.ok(streaming.entries.every(({ role }) => role !== "assistant"));
    await expect(page.locator('[data-handoff-content="code"]').getByText(firstDelta, { exact: true })).toHaveCount(0);
    finishAnswer();
    await expect.poll(async () => (await state()).task?.status, { timeout: 30_000 }).toBe("completed");
    await expect(page.getByText(finalAnswer, { exact: true })).toHaveCount(1);
    await expect(page.getByText(firstDelta, { exact: true })).toHaveCount(0);
    await expect(request).toBeEmpty();
    await expect(page.getByText(followUp, { exact: true })).toHaveCount(1);
    await expect(page.getByText("Queued for the next model request.")).toHaveCount(0);
    const list = page.locator(".code-task-list");
    const planRow = list.locator(".code-task-list-item").filter({ hasText: "Inspect search behavior" });
    const revisedRow = list.locator(".code-task-list-item").filter({ hasText: revisedTitle });
    await expect(list.getByText(revisedTitle, { exact: true })).toBeVisible();
    await expect(list.getByText("0/3 complete", { exact: true })).toBeVisible();
    await expect(planRow).toHaveAttribute("data-status", "pending");
    await expect(revisedRow).toHaveAttribute("data-status", "pending");
    await expect(revisedRow).toContainText("Awaiting assignment");
    await expect(list.locator('[data-status="cancelled"]')).toContainText("Check keyboard search");
    const planTask = (await state()).task!;
    assert.ok(planTask.nativeSession?.threadId && planTask.nativeSession.turnId);
    assert.deepEqual(planTask.nativeSession, inFlight);
    assert.equal(planTask.execution?.billingSource, "unknown");
    assert.deepEqual(planTask.transmission, []);
    assert.equal(vendor.completions.length, 0);
    const artifact = process.env.TOMVERSE_CODEX_DESKTOP_QA;
    if (artifact) {
      await list.screenshot({ path: join(artifact, "codex-task-list-dark.png") });
      await page.getByRole("button", { name: "Use light theme" }).click();
      await expect(list.getByText(revisedTitle, { exact: true })).toBeVisible();
      await list.screenshot({ path: join(artifact, "codex-task-list-light.png") });
    }

    await mode.selectOption("ask");
    await request.fill("Stop the next Codex plan");
    await send.click();
    await expect.poll(() => held.has(6), { timeout: 30_000 }).toBe(true);
    await expect(list.locator('[data-status="running"]')).toContainText("Inspect search behavior");
    await expect(list.locator('[data-status="running"]')).toContainText(model);
    await request.fill(stopFollowUp);
    await steer.click();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect.poll(async () => (await state()).task?.status, { timeout: 25_000 }).toBe("unknown");
    await expect.poll(() => heldClosed.has(6)).toBe(true);
    const unconfirmed = (await state()).task;
    assert.notEqual(unconfirmed?.nativeSession?.turnId, planTask.nativeSession.turnId);
    await expect(request).toHaveValue(stopFollowUp);
    await expect(page.getByText("Queued for the next model request.")).toHaveCount(0);
    assert.ok(unconfirmed?.entries.every((entry) => entry.role !== "user" || entry.text !== stopFollowUp));
    assert.equal(requests.length, 6);
    assert.ok(requests.every(({ input }) => !JSON.stringify(input ?? []).includes(stopFollowUp)));

    await request.fill("Stop Codex without a queued instruction");
    await send.click();
    await expect.poll(() => held.has(8), { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(stopDelta, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect.poll(async () => (await state()).task?.status, { timeout: 20_000 }).toBe("stopped");
    await expect.poll(() => heldClosed.has(8)).toBe(true);
    await expect(list.locator('[data-status="cancelled"]')).toHaveCount(2);
    const stopped = await state();
    assert.equal(stopped.task?.streamingAnswer, undefined);
    assert.ok(stopped.task?.entries.every(({ role }) => role !== "assistant"));
    await expect(page.getByText(stopDelta, { exact: true })).toHaveCount(0);
    assert.deepEqual(stopped.history, []);

    await request.fill("Stop Codex when the desktop suspends");
    await send.click();
    await expect.poll(() => held.has(10), { timeout: 30_000 }).toBe(true);
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("suspend"); });
    await expect.poll(async () => (await state()).task?.status, { timeout: 20_000 }).toBe("stopped");
    await expect.poll(() => heldClosed.has(10)).toBe(true);
    assert.deepEqual((await state()).history, []);
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("resume"); });

    await request.fill("Stop Codex before closing Desktop");
    await send.click();
    await expect.poll(() => held.has(12), { timeout: 30_000 }).toBe(true);
    const appClosed = new Promise<void>((resolve) => { app!.once("close", resolve); });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
    await expect.poll(() => heldClosed.has(12), { timeout: 20_000 }).toBe(true);
    await appClosed;
    app = undefined;
    app = await launchNativeFixture(descriptor);
    const reopened = await app.firstWindow();
    await expect(reopened.getByText("Codex · Local test", { exact: true })).toBeVisible();
    const restored = await reopened.evaluate(() => window.desktop.state());
    assert.equal(restored.busy, false);
    assert.equal(restored.task, null);
    assert.deepEqual(restored.history, []);
    assert.equal(requests.length, 12);

    await reopened.getByRole("button", { name: "Open local folder" }).click();
    const savedInput = reopened.getByRole("textbox", { name: "Code request", exact: true });
    await reopened.getByRole("checkbox", { name: "Save to local history" }).check();
    await savedInput.fill(savedPrompt);
    await reopened.getByRole("button", { name: "Send Code request", exact: true }).click();
    await expect.poll(() => held.has(14), { timeout: 30_000 }).toBe(true);
    await reopened.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect.poll(async () => (await reopened.evaluate(() => window.desktop.state())).task?.status, { timeout: 20_000 }).toBe("stopped");
    const saved = (await reopened.evaluate(() => window.desktop.state())).task;
    assert.ok(saved?.id && saved.nativeSession && saved.canResume);
    const savedId = saved.id;
    const store = nativeHistoryHome(codeHistoryScope(profile, null, bindProjectRoot(root), { endpoint: vendor.base, key: TEST_KEY }).home, codex, "openai");
    savedDirectory = nativeSessionDirectory(store, savedId);
    assert.ok((await stat(join(savedDirectory, "profile"))).isDirectory());
    await app.close();
    app = undefined;
    const checkpointPath = join(savedDirectory, "session.json");
    const legacyCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    delete legacyCheckpoint.provider;
    await writeFile(checkpointPath, JSON.stringify(legacyCheckpoint));
    app = await launchNativeFixture(descriptor);
    const restoredApp = await app.firstWindow();
    const restoredState = () => restoredApp.evaluate(() => window.desktop.state());
    await restoredApp.getByRole("button", { name: "Open local folder" }).click();
    await expect(restoredApp.getByRole("checkbox", { name: "Save to local history" })).not.toBeChecked();
    assert.equal(await restoredApp.evaluate((id) => window.desktop.resume(id), savedId), false);
    const history = restoredApp.getByRole("complementary", { name: "History" });
    await history.getByRole("button", { name: savedPrompt, exact: true }).click();
    const prior = (await restoredState()).task;
    assert.equal(prior?.id, savedId);
    assert.deepEqual(prior?.nativeSession, saved.nativeSession);
    assert.deepEqual(prior?.plan, JSON.parse(JSON.stringify(saved.plan)));
    assert.equal(requests.length, 14);
    await restoredApp.getByRole("button", { name: "Resume task", exact: true }).click();
    await expect(restoredApp.getByText(continuedAnswer, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await restoredState()).task?.status).toBe("completed");
    const continued = (await restoredState()).task;
    assert.equal(continued?.id, savedId);
    assert.equal(continued?.nativeSession?.threadId, saved.nativeSession.threadId);
    assert.notEqual(continued?.nativeSession?.turnId, saved.nativeSession.turnId);
    await expect(restoredApp.locator(".code-task-list").getByText("Confirm the restored project", { exact: true })).toBeVisible();
    await expect(restoredApp.locator('[data-handoff-content="code"]').getByText(savedPrompt, { exact: true })).toHaveCount(1);
    assert.equal(requests.length, 16);

    await app.evaluate(({ dialog }) => {
      let choices = 0;
      dialog.showMessageBox = async () => ({ response: choices++ === 0 ? 0 : 1, checkboxChecked: false });
    });
    assert.equal(await restoredApp.evaluate((id) => window.desktop.deleteHistory(id), savedId), "cancelled");
    assert.ok((await stat(savedDirectory)).isDirectory());
    assert.equal(await restoredApp.evaluate((id) => window.desktop.deleteHistory(id), savedId), "deleted");
    await assert.rejects(stat(savedDirectory), { code: "ENOENT" });
    assert.deepEqual((await restoredState()).history, []);

    await restoredApp.getByRole("checkbox", { name: "Save to local history" }).check();
    await restoredApp.getByRole("textbox", { name: "Code request", exact: true }).fill(crashPrompt);
    await restoredApp.getByRole("button", { name: "Send Code request", exact: true }).click();
    await expect.poll(() => held.has(18), { timeout: 30_000 }).toBe(true);
    const interrupted = (await restoredState()).task;
    assert.ok(interrupted?.id && interrupted.nativeSession);
    const crashId = interrupted.id;
    const beforeCrash = JSON.parse(await readFile(join(nativeSessionDirectory(store, crashId), "session.json"), "utf8"));
    assert.equal(beforeCrash.status, "unknown");
    assert.deepEqual(beforeCrash.nativeSession, interrupted.nativeSession);
    await app.evaluate(({ app }) => {
      const runtime = app.getAppMetrics().find((item) => item.type === "Utility" && (item.name === "Tomverse Code Runtime" || item.serviceName === "Tomverse Code Runtime"));
      if (!runtime) throw new Error("The fixture Code worker was not found");
      process.kill(runtime.pid);
    });
    await expect.poll(async () => (await restoredState()).task?.status).toBe("unknown");
    await expect.poll(() => heldClosed.has(18), { timeout: 20_000 }).toBe(true);
    await app.close();
    app = undefined;
    app = await launchNativeFixture(descriptor);
    const recoveryApp = await app.firstWindow();
    await recoveryApp.getByRole("button", { name: "Open local folder" }).click();
    await recoveryApp.getByRole("complementary", { name: "History" }).getByRole("button", { name: crashPrompt, exact: true }).click();
    const recoveredState = () => recoveryApp.evaluate(() => window.desktop.state());
    const recovered = (await recoveredState()).task;
    assert.equal(recovered?.id, crashId);
    assert.equal(recovered?.status, "unknown");
    assert.deepEqual(recovered?.nativeSession, interrupted.nativeSession);
    assert.equal(requests.length, 18);
    await expect(recoveryApp.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
    await recoveryApp.getByRole("button", { name: "Check recovery", exact: true }).click();
    await expect(recoveryApp.getByRole("status").filter({ hasText: /^Codex · / })).toBeVisible({ timeout: 35_000 });
    assert.equal((await recoveredState()).task?.status, "unknown");
    assert.equal(requests.length, 18);
    assert.equal(vendor.completions.length, 0);
    assert.equal(requestError, undefined);
  } catch (error) {
    const artifact = process.env.TOMVERSE_CODEX_DESKTOP_QA;
    const page = app?.windows()[0];
    if (artifact && page && !page.isClosed()) {
      const snapshot = await page.evaluate(() => window.desktop.state());
      await writeFile(join(artifact, "codex-steer-failure.json"), JSON.stringify({ task: snapshot.task,
        requestError: String(requestError ?? ""), held: [...held], heldClosed: [...heldClosed], requests: requests.map(({ input }) => ({
          revised: JSON.stringify(input ?? []).includes(followUp), second: JSON.stringify(input ?? []).includes(stopFollowUp),
        })),
      }, null, 2));
    }
    throw error;
  } finally {
    resumeCurrentResponse();
    finishAnswer();
    finishStopAnswer();
    if (app) await app.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await vendor.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
