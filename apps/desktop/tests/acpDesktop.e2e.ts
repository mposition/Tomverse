import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeProject, selectCodeMode, startPlanOnly } from "./code-project-fixture";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { decideNativePatch, launchNativeFixture } from "./launch-native-fixture";

type Output = { name: string; args: object } | { text: string };

function sendModelResponse(response: ServerResponse, model: string, index: number, output: Output, usage?: [number, number]) {
  const chunk = { id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1, model };
  const send = (delta: object, finish_reason: string | null = null) =>
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  send({ role: "assistant" });
  if ("name" in output) send({ tool_calls: [{ index: 0, id: `call_${index}`, type: "function",
    function: { name: output.name, arguments: JSON.stringify(output.args) } }] });
  else send({ content: output.text });
  send({}, "name" in output ? "tool_calls" : "stop");
  if (usage) {
    const [prompt_tokens, completion_tokens] = usage;
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [], usage: {
      prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens,
    } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

const vendors = [
  { key: "qwen", provider: "qwen", name: "Qwen Code", version: "0.28.4", executable: process.env.TOMVERSE_DESKTOP_QWEN_TASK_BINARY },
  { key: "kimi", provider: "moonshot", name: "Kimi Code", version: "2.7.2", executable: process.env.TOMVERSE_DESKTOP_KIMI_TASK_BINARY },
] as const;

// CLI staging and Electron run in the same emulated Debian guest.
const nativeStartWait = process.platform === "linux" ? 100_000 : 35_000;
const nativeTurnWait = process.platform === "linux" ? 55_000 : 25_000;

for (const vendor of vendors) test(`${vendor.name} uses the ACP file boundary and resumes a stopped native task`, {
  timeout: process.platform === "linux" ? 700_000 : 180_000, skip: vendor.executable ? false : `Requires the pinned official ${vendor.name} artifact`,
}, async () => {
  const kimi = vendor.key === "kimi";
  const model = `${vendor.key}-desktop-fixture`;
  const readName = kimi ? "Read" : "read_file";
  const writeName = kimi ? "Write" : "write_file";
  const todoName = kimi ? "TodoList" : "todo_write";
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-acp-desktop-")));
  const root = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const gateway = new FakeGateway({ script: () => ({ text: "Unexpected Tomverse API execution." }) });
  const marker = "The scoped fixture was read.\n";
  const privateMarker = "This out-of-workspace marker cannot reach the model.";
  const edited = "This fixture has a verified edit.\n";
  const askTitle = "Inspect the workspace without edits";
  const planTitle = "Plan a project change without implementing it";
  const quickTitle = "Answer this question without changing the project";
  const quickAnswer = "Here is the explanation without any project changes.";
  const outsideTitle = "Try to read outside the workspace";
  const staleTitle = "Try to edit with analysis from an earlier turn";
  const driftTitle = "Keep the workspace file that changes during approval";
  const agentTitle = "Apply a verified edit";
  const followUpText = "Check the approved file and leave its contents unchanged";
  const rowTitle = "Save the scoped fixture";
  const revisionTitle = "Verify the existing file after the new instruction";
  const removedRow = "Review the optional follow-up";
  const item = (id: string, label: string, status: "pending" | "in_progress" | "completed") =>
    kimi ? { title: label, status: status === "completed" ? "done" : status } :
      { id, content: label, status, activeForm: "Reviewing the fixture" };
  const todo = (status: "pending" | "in_progress" | "completed", turnId: string, includePending = false) => {
    const todos = [item("fixture", JSON.stringify({ title: rowTitle, turnId, analysis: fixtureWorkAnalysis }), status)];
    if (includePending) todos.push(item("review", removedRow, "pending"));
    return { name: todoName, args: { todos } };
  };
  const revisedTodo = (status: "in_progress" | "completed", turnId: string) => ({ name: todoName, args: { todos: [
    item("fixture", rowTitle, "completed"),
    item("revision", JSON.stringify({ title: revisionTitle, turnId,
      analysis: { ...fixtureWorkAnalysis, objective: followUpText } }), status),
  ] } });
  const pathArgs = (path: string) => kimi ? { path } : { file_path: path };
  const read = (path: string) => ({ name: readName, args: pathArgs(path) });
  const write = (file: string) => ({ name: writeName, args: { ...pathArgs(join(root, file)), content: edited } });
  const answer = { text: "The read-only task finished." };
  let phase: "ask" | "plan" | "outside" | "quick" | "stale" | "drift" | "agent" | "followUp" | "resume" = "ask";
  const counts = { ask: 0, plan: 0, outside: 0, quick: 0, stale: 0, drift: 0, agent: 0, followUp: 0, resume: 0 };
  let analyzedTurn = "";
  let requestedApprovalWithStaleAnalysis = false;
  let fixtureError: unknown;
  let originalRequestClosed = false;
  let followUpRequestClosed = false;
  const endpoint = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const requestText = Buffer.concat(chunks).toString("utf8");
      assert.ok(!requestText.includes(privateMarker));
      const body = JSON.parse(requestText);
      assert.equal(body.model, model);
      assert.deepEqual(body.tools.map(({ function: { name } }: { function: { name: string } }) => name).sort(),
        (phase === "ask" || phase === "plan" || phase === "outside" ? [readName, todoName] : [readName, todoName, writeName]).sort());
      const index = counts[phase]++;
      const serial = Object.values(counts).reduce((total, count) => total + count, 0);
      const reply = (output: Output) => sendModelResponse(response, model, serial, output,
        kimi || phase !== "resume" || index === 0 ? [10 + index, 1 + index] : undefined);
      if ((phase === "plan" || phase === "drift" || phase === "agent" || phase === "followUp" || phase === "resume") && index === 0) {
        const user = body.messages.findLast((message: { role: string }) =>
          message.role === "user" && JSON.stringify(message).includes("Desktop instructions:"));
        const currentTurn = JSON.stringify(user).match(/\\"turnId\\":\\"([a-f0-9-]{36})\\"/)?.[1];
        assert.ok(currentTurn);
        assert.notEqual(currentTurn, analyzedTurn);
        analyzedTurn = currentTurn;
        if (phase === "plan") assert.match(JSON.stringify(user), /stop before implementation/);
      }
      if (phase === "ask") {
        if (index === 1) assert.ok(body.messages.at(-1) && JSON.stringify(body.messages.at(-1)).includes(marker.trim()));
        if (index === 2) assert.match(requestText, /not listed in the active core tools allowlist/);
        const operations = [read(join(root, "marker.txt")), ...(kimi ? [] : [write("ask-denied.txt")]), answer];
        assert.ok(operations[index]);
        reply(operations[index]!);
      } else if (phase === "plan") {
        if (index === 2) assert.ok(JSON.stringify(body.messages.at(-1)).includes(marker.trim()));
        const operations = [todo("in_progress", analyzedTurn, true), read(join(root, "marker.txt")),
          todo("completed", analyzedTurn, true), write("plan-denied.txt"), answer];
        assert.ok(operations[index]);
        reply(operations[index]!);
      } else if (phase === "outside") {
        assert.ok(index <= (kimi ? 1 : 0));
        reply(index === 0 ? read(join(temp, "private.txt")) : answer);
      } else if (phase === "quick") {
        assert.equal(index, 0);
        reply({ text: quickAnswer });
      } else if (phase === "stale") {
        assert.ok(index <= (kimi ? 2 : 1));
        reply(index === 0 ? todo("in_progress", "a493083e-cdfb-450a-b913-dee8e80052b8") :
          index === 1 ? write("stale-analysis.txt") : answer);
      } else if (phase === "drift") {
        assert.ok(index <= (kimi ? 2 : 1));
        if (index === 2) assert.doesNotMatch(requestText, /Wrote \d+ bytes|Successfully created and wrote to new file/);
        reply(index === 0 ? todo("in_progress", analyzedTurn) : index === 1 ? write("changed-during-preview.txt") : answer);
      } else if (phase === "agent") {
        if (index === 2) assert.match(requestText, kimi ? /Wrote \d+ bytes/ : /Successfully created and wrote to new file/);
        if (index === 3) {
          response.once("close", () => { originalRequestClosed = true; });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting\n\n");
        } else {
          const operations = [todo("in_progress", analyzedTurn, true), write("allowed.txt"), todo("completed", analyzedTurn)];
          assert.ok(operations[index]);
          reply(operations[index]!);
        }
      } else if (phase === "followUp") {
        if (index === 0) assert.ok(requestText.includes(followUpText));
        if (index === 2) assert.ok(JSON.stringify(body.messages.at(-1)).includes(edited.trim()));
        if (index === 3) {
          response.once("close", () => { followUpRequestClosed = true; });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting\n\n");
        } else {
          const operations = [revisedTodo("in_progress", analyzedTurn), read(join(root, "allowed.txt")), revisedTodo("completed", analyzedTurn)];
          assert.ok(operations[index]);
          reply(operations[index]!);
        }
      } else {
        assert.ok(index <= (kimi ? 2 : 1));
        if (index === 0) {
          assert.ok(requestText.includes(agentTitle) && requestText.includes("Continue the stopped task from its saved context"));
          reply(todo("in_progress", analyzedTurn));
        } else if (index === 1) reply(write("resume-denied.txt"));
        else reply({ text: "The unapproved edit was skipped." });
      }
    } catch (error) {
      fixtureError = error;
      response.writeHead(400).end();
    }
  });
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile), gateway.start()]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(root, "marker.txt"), marker);
    await writeFile(join(temp, "private.txt"), privateMarker);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const fixture = { executable: vendor.executable, version: vendor.version, model, origin: `http://127.0.0.1:${address.port}`,
      allowSavedHistory: true, allowFileEdits: true };
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY, [vendor.key]: fixture }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const state = () => page.evaluate(() => window.desktop.state());
    await openCodeProject(page);
    await page.evaluate(() => window.desktop.setCodeExecutionPreference("provider_cli"));
    const composer = page.getByRole("textbox", { name: "Code request" });
    const send = page.getByRole("button", { name: "Send Code request", exact: true });
    await selectCodeMode(page, "ask");
    await composer.fill(askTitle);
    await send.click();
    await expect.poll(async () => (await state()).task?.status, { timeout: nativeStartWait }).toBe("completed");
    assert.ifError(fixtureError);
    await expect(page.getByText(answer.text, { exact: true })).toBeVisible();
    assert.equal((await state()).task?.nativeSession?.provider, vendor.provider);
    assert.equal(counts.ask, kimi ? 2 : 3);
    const usage = page.getByText(`Provider usage · ${vendor.name}`, { exact: true });
    await usage.click();
    await expect(usage.locator("..")).toContainText(kimi ? "Token usage unconfirmed"
      : "Reported usage for 3 of 3 model requests · Input tokens 33 · Output tokens 6");
    await assert.rejects(readFile(join(root, "ask-denied.txt")), { code: "ENOENT" });

    let planApproval = false;
    app.on("window", () => { if (phase === "plan") planApproval = true; });
    phase = "plan";
    await startPlanOnly(page, planTitle);
    await expect.poll(async () => {
      assert.ifError(fixtureError);
      const { task } = await state();
      return [task?.title, task?.status];
    }, { timeout: nativeStartWait }).toEqual([planTitle, "completed"]);
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(fixtureWorkAnalysis.objective);
    await expect(page.locator(".code-task-list")).toContainText("0/2 complete");
    await expect(page.locator('.code-task-list-item[data-status="pending"]')).toHaveCount(2);
    await expect(page.locator(".code-task-list").getByText("Awaiting assignment", { exact: true })).toHaveCount(2);
    const proposed = (await state()).task?.plan;
    assert.equal(proposed?.activeId, null);
    assert.equal(proposed?.items[0]?.nativeStatus, "completed");
    assert.deepEqual(proposed?.items[0]?.evidence.map(({ state }) => state), ["succeeded"]);
    assert.ok(counts.plan >= 3);
    assert.equal(planApproval, false);
    assert.equal((await state()).task?.changes.length, 0);
    await assert.rejects(readFile(join(root, "plan-denied.txt")), { code: "ENOENT" });

    phase = "outside";
    await selectCodeMode(page, "ask");
    await composer.fill(outsideTitle);
    await send.click();
    await expect.poll(async () => {
      const { task } = await state();
      return [task?.title, task?.status];
    }, { timeout: nativeStartWait }).toEqual([outsideTitle, "completed"]);
    assert.ifError(fixtureError);
    assert.equal(counts.outside, kimi ? 2 : 1);
    await expect(page.getByText(privateMarker, { exact: true })).toHaveCount(0);

    phase = "quick";
    await selectCodeMode(page, "agent");
    await page.getByRole("checkbox", { name: "Save to local history" }).check();
    await composer.fill(quickTitle);
    await send.click();
    await expect(page.getByText(quickAnswer, { exact: true })).toBeVisible({ timeout: nativeStartWait });
    await expect.poll(async () => (await state()).task?.status).toBe("completed");
    await expect(page.locator(".code-task-list")).toHaveCount(0);
    assert.equal(counts.quick, 1);
    assert.equal((await state()).task?.changes.length, 0);

    phase = "stale";
    app.on("window", () => { if (phase === "stale") requestedApprovalWithStaleAnalysis = true; });
    await composer.fill(staleTitle);
    await send.click();
    await expect.poll(async () => {
      const { task } = await state();
      return [task?.title, task?.status];
    }, { timeout: nativeStartWait }).toEqual([staleTitle, "completed"]);
    assert.ifError(fixtureError);
    assert.equal(counts.stale, kimi ? 3 : 2);
    assert.equal(requestedApprovalWithStaleAnalysis, false);
    await assert.rejects(readFile(join(root, "stale-analysis.txt")), { code: "ENOENT" });
    await expect(page.getByRole("region", { name: "Request analysis" })).toHaveCount(0);

    phase = "drift";
    await composer.fill(driftTitle);
    const [outdated] = await Promise.all([app.waitForEvent("window", { timeout: nativeStartWait }), send.click()]);
    await expect(outdated.getByRole("heading", { name: "changed-during-preview.txt · create" })).toBeVisible({ timeout: nativeTurnWait });
    const changedFile = join(root, "changed-during-preview.txt");
    const userContents = "I created this file while reviewing the proposed edit.\n";
    await writeFile(changedFile, userContents, { flag: "wx" });
    await decideNativePatch(outdated);
    await expect.poll(async () => (await state()).task?.status, { timeout: nativeTurnWait }).toBe("completed");
    assert.ifError(fixtureError);
    assert.equal((await state()).task?.changes.length, 0);
    assert.equal(await readFile(changedFile, "utf8"), userContents);

    phase = "agent";
    await composer.fill(agentTitle);
    const initialApproval = app.waitForEvent("window", { timeout: nativeStartWait }).catch(async (error) => {
      assert.ifError(fixtureError);
      const { task } = await state();
      throw new Error(`The ${vendor.name} task did not request approval after ${counts.agent} model requests (status: ${task?.status}).`, { cause: error });
    });
    const [approved] = await Promise.all([initialApproval, send.click()]);
    await expect(approved.getByRole("heading", { name: "allowed.txt · create" })).toBeVisible({ timeout: nativeTurnWait });
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(fixtureWorkAnalysis.objective);
    const pending = page.locator(".code-task-list-item").filter({ hasText: removedRow });
    await expect(pending).toContainText("Awaiting assignment");
    await expect(pending).toHaveAttribute("data-status", "pending");
    const active = page.locator(".code-task-list-item").filter({ hasText: rowTitle });
    await expect(active).toHaveAttribute("data-status", "approval");
    await expect(active).toContainText("Waiting for approval");
    await expect(approved.getByRole("button", { name: "Allow for this run" })).toHaveCount(0);
    await assert.rejects(readFile(join(root, "allowed.txt")), { code: "ENOENT" });
    await decideNativePatch(approved);
    await expect.poll(() => counts.agent, { timeout: nativeTurnWait }).toBe(4);
    const original = (await state()).task;
    assert.ok(original?.id && original.nativeSession);
    phase = "followUp";
    await composer.fill(followUpText);
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect.poll(() => counts.followUp, { timeout: 32_000 }).toBe(4);
    assert.ok(originalRequestClosed);
    await expect(composer).toBeEmpty();
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(followUpText);
    const revised = (await state()).task;
    assert.equal(revised?.id, original.id);
    assert.equal(revised?.nativeSession?.threadId, original.nativeSession.threadId);
    assert.notEqual(revised?.nativeSession?.turnId, original.nativeSession.turnId);
    await page.getByRole("button", { name: "Stop Code task" }).click();
    await expect.poll(async () => (await state()).task?.status, { timeout: 22_000 }).toBe("stopped");
    assert.ok(followUpRequestClosed);
    const stopped = (await state()).task;
    assert.ok(stopped?.id && stopped.nativeSession);
    assert.equal(await readFile(join(root, "allowed.txt"), "utf8"), edited);
    assert.deepEqual(stopped.plan?.items.map(({ title, complete, cancelled, nativeAssignment, evidence }) =>
      [title, complete, cancelled, nativeAssignment?.model, evidence.map(({ state }) => state)]),
    [[rowTitle, true, false, model, ["succeeded"]], [revisionTitle, true, false, model, ["succeeded"]],
      [removedRow, false, true, undefined, []]]);
    await app.close();
    app = undefined;

    phase = "resume";
    app = await launchNativeFixture(descriptor);
    const restored = await app.firstWindow();
    await openCodeProject(restored);
    await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: agentTitle, exact: true }).click();
    await expect(restored.getByRole("region", { name: "Request analysis" })).toContainText(followUpText);
    await expect(restored.locator(".entry--user").filter({ hasText: followUpText })).toHaveCount(1);
    await expect(restored.locator(".code-task-list-item").filter({ hasText: removedRow })).toHaveAttribute("data-status", "cancelled");
    const change = stopped.changes[0]?.id;
    assert.ok(change);
    const diff = await restored.evaluate((id) => window.desktop.readChange(id), change);
    assert.match(diff?.text ?? "", /verified edit/);
    const approval = app.waitForEvent("window", { timeout: nativeStartWait }).catch((error) => {
      assert.ifError(fixtureError);
      throw new Error(`The resumed ${vendor.name} task did not request approval after ${counts.resume} model requests.`, { cause: error });
    });
    const [rejected] = await Promise.all([approval,
      restored.getByRole("button", { name: "Resume task", exact: true }).click()]);
    await expect(rejected.getByRole("heading", { name: "resume-denied.txt · create" })).toBeVisible({ timeout: nativeTurnWait });
    await decideNativePatch(rejected, "Deny");
    const current = () => restored.evaluate(() => window.desktop.state().then(({ task }) => task));
    await expect.poll(async () => (await current())?.status, { timeout: 20_000 }).toBe("completed");
    const final = await current();
    assert.equal(final?.id, stopped.id);
    assert.equal(final?.nativeSession?.threadId, stopped.nativeSession.threadId);
    assert.notEqual(final?.nativeSession?.turnId, stopped.nativeSession.turnId);
    assert.deepEqual(final?.changes, stopped.changes);
    const reopened = final?.plan?.items[0];
    assert.equal(reopened?.id, stopped.plan?.items[0]?.id);
    assert.equal(reopened?.complete, false);
    assert.equal(reopened?.evidenceStart, 1);
    assert.deepEqual(reopened?.evidence.map(({ state, assignment }) => [state, assignment && "turnId" in assignment && assignment.turnId]),
      [["succeeded", original.nativeSession.turnId], ["failed", final?.nativeSession?.turnId]]);
    assert.equal(counts.resume, kimi ? 3 : 2);
    assert.equal(gateway.completions.length, 0);
    if (!kimi) {
      assert.equal(final?.apiUsage, undefined);
      assert.deepEqual(final?.transmission, []);
      const finalUsage = final?.nativeRuns?.at(-1)?.usage;
      assert.equal(finalUsage?.source, "qwen_requests");
      assert.equal(final?.nativeRuns?.at(-1)?.session.turnId, final?.nativeSession?.turnId);
      const verifyUsage = async (window: typeof restored) => {
        const usage = window.getByText("Provider usage · Qwen Code", { exact: true });
        await usage.click();
        await expect(usage.locator("..")).toContainText("Reported usage for 1 of 2 model requests · Input tokens 10 · Output tokens 1");
        await expect(usage.locator("..")).toContainText("Billing source unconfirmed");
      };
      await verifyUsage(restored);
      await app.close();
      app = await launchNativeFixture(descriptor);
      const reopened = await app.firstWindow();
      await openCodeProject(reopened);
      await reopened.getByRole("complementary", { name: "History" }).getByRole("button", { name: agentTitle, exact: true }).click();
      await verifyUsage(reopened);
      assert.deepEqual(await reopened.evaluate(() => window.desktop.state().then(({ task }) => task?.nativeRuns?.at(-1)?.usage)), finalUsage);
    }
    assert.ifError(fixtureError);
    await assert.rejects(readFile(join(root, "resume-denied.txt")), { code: "ENOENT" });
  } finally {
    await app?.close();
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
