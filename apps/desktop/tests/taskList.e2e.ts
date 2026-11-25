import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type Page } from "@playwright/test";
import { Journal } from "../../tomverse-cli/src/session.js";
import { DEFAULT_MODELS, FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { launchNativeFixture } from "./launch-native-fixture";
import { canAnswerClarification } from "../src/host/journal-view";
import { desktopShellCopy } from "../../../locales/desktopShell";

const packaged = !!process.env.TOMVERSE_DESKTOP_TASK_QA_EXECUTABLE;
const codex = process.env.TOMVERSE_DESKTOP_CODEX_TASK_BINARY;
const launchWait = process.platform === "linux" ? 35_000 : 20_000;
const approvalWait = process.platform === "linux" ? 35_000 : 10_000;

test("Code adds a live task list with confirmed models, verified completion and history", {
  timeout: process.platform === "linux" ? 150_000 : 60_000,
  skip: packaged && !codex ? "Requires the pinned Codex file to start the Task QA package" : false,
}, async (context) => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-task-list-"));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(join(root, "marker.txt"), "Search behavior fixture");
  await writeFile(join(root, "fail.mjs"), "process.exitCode = 7;\n");
  await writeFile(join(root, "resume.mjs"), `import { appendFileSync, existsSync } from "node:fs";
const first = !existsSync("resume-starts.txt");
appendFileSync("resume-starts.txt", "started\\n");
if (first) setInterval(() => {}, 1000);
`);
  const rows = [
    { id: "inspect", title: "Inspect search requests" },
    { id: "verify", title: "Run the regression check" },
    { id: "follow-up", title: "Review keyboard behavior" },
  ];
  const credentialFact = `Fixture credential ${TEST_KEY}`;
  const workAnalysis = { ...fixtureWorkAnalysis, verifiedFacts: [...fixtureWorkAnalysis.verifiedFacts, credentialFact] };
  const update = (revision: number, items: typeof rows, activeId: string | null, completeId?: string) => ({
    toolCalls: [{ name: "update_task_plan", args: { revision, items, activeId, completeId, analysis: workAnalysis } }],
  });
  let runStep = 0;
  let planStep = 0;
  let resumeStep = 0;
  const resumeInstruction = "Confirm the command result after resuming";
  const gateway = await new FakeGateway({
    routedModel: "fake-small",
    models: DEFAULT_MODELS.map((model) => ({ ...model, tomverse: { ...model.tomverse, context_window_tokens: 200_000,
      ...(model.id === "fake-small" ? { reasoning_efforts: ["low", "high"] } : {}),
    } })),
    script(body) {
      const prompt = body.messages.find((item: { role: string }) => item.role === "user")?.content ?? "";
      const tools = body.messages.filter((item: { role: string }) => item.role === "tool");
      if (JSON.stringify(prompt).includes("Stop planned work")) {
        return tools.length ? { fault: "hang" } : { ...update(0, rows, "inspect"), routedModelHeader: "fake-coder" };
      }
      if (JSON.stringify(prompt).includes("Resume the recorded work")) {
        const items = rows.slice(0, 2);
        switch (resumeStep++) {
          case 0: return update(0, items, "inspect");
          case 1: return { toolCalls: [{ name: "read_file", args: { path: "marker.txt" } }] };
          case 2: return update(1, items, "verify", "inspect");
          case 3:
          case 5: return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "resume.mjs"] } }] };
          case 4: return update(2, items, "verify");
          case 6: return update(3, items, null, "verify");
          default: return { text: "The resumed work is verified." };
        }
      }
      if (JSON.stringify(prompt).includes("Plan a read-only change")) {
        assert.ok(!body.tools?.some((entry: { function?: { name?: string } }) => ["apply_patch", "run_command"].includes(entry.function?.name ?? "")));
        switch (planStep++) {
          case 0: return update(0, rows, "inspect");
          case 1: return { toolCalls: [{ name: "read_file", args: { path: "marker.txt" } }] };
          case 2: return update(1, rows, null, "inspect");
          case 3: return update(0, rows, null);
          default: return { text: "Here is the proposed work." };
        }
      }
      switch (runStep++) {
        case 0: return { text: "I will confirm search behavior first.", ...update(0, rows.slice(0, 2), "inspect") };
        case 1: return { toolCalls: [{ name: "read_file", args: { path: "marker.txt" } }],
          routedModelHeader: "fake-coder", appliedEffortHeader: "default" };
        case 2: return update(1, rows, "verify", "inspect");
        case 3: return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "fail.mjs"] } }] };
        case 4: return update(2, rows, null, "verify");
        case 5: return update(1, [{ ...rows[0]!, title: "Stale replacement" }, ...rows.slice(1)], null);
        default: return { text: "The regression check needs attention." };
      }
    },
  }).start();
  context.after(() => gateway.stop());
  const descriptor = join(tmp, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY,
    ...(packaged && { codex: { executable: codex, version: "0.171.0-alpha.13", model: "fake-coder",
      origin: new URL(gateway.base).origin } }),
  }));
  const application = await launchNativeFixture(descriptor, launchWait);
  const page = await application.firstWindow();
  try {
    await page.getByRole("button", { name: "Open local folder" }).click();
    const send = async (prompt: string) => {
      await page.getByRole("textbox", { name: "Code request" }).fill(prompt);
      await page.getByRole("button", { name: "Send Code request" }).click();
    };
    const answer = async (approval: Page, name: string) => {
      try { await approval.getByRole("button", { name, exact: true }).click(); }
      catch (error) { if (!approval.isClosed()) throw error; }
    };
    await page.getByLabel("Model and reasoning effort").click();
    await page.getByLabel("Model", { exact: true }).selectOption("smart-adaptive");
    await page.getByLabel("Model and reasoning effort").click();
    const approvalWindow = application.waitForEvent("window", { predicate: (candidate) => candidate !== page, timeout: approvalWait });
    void approvalWindow.catch(() => undefined);
    await send("Verify the search task list");
    const list = page.locator(".code-task-list");
    const analysis = page.getByRole("region", { name: "Request analysis" });
    await expect(analysis).toBeVisible();
    await expect(analysis).toContainText(fixtureWorkAnalysis.objective);
    await expect(analysis).toContainText(fixtureWorkAnalysis.assumptions[0]!);
    await expect(analysis).toContainText("Fixture credential [credential removed]");
    await expect(analysis).not.toContainText(TEST_KEY);
    assert.ok(await analysis.evaluate((element) => Boolean(
      element.compareDocumentPosition(document.querySelector(".code-task-list")!) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await expect(list.getByText("Task List", { exact: true })).toBeVisible();
    await expect(list.getByText("1/3 complete")).toBeVisible();
    await expect(list.getByText("Waiting for approval", { exact: true })).toBeVisible();
    await answer(await approvalWindow, "Allow once");
    await expect(page.getByText("The regression check needs attention.")).toBeVisible();
    await expect(list.getByText("1/3 complete")).toBeVisible();
    await expect(list.getByText("Completion unverified", { exact: true })).toBeVisible();
    await expect(list.getByText("Awaiting assignment", { exact: true })).toBeVisible();
    await expect(list.getByText("Stale replacement")).toHaveCount(0);
    const state = await page.evaluate(() => window.desktop.state());
    const transcript = JSON.stringify(gateway.completions.at(-1)?.body.messages);
    assert.match(transcript, /plan revision changed/i);
    assert.match(transcript, /completion requires successful recorded work/i);
    assert.deepEqual(state.task?.plan?.items.map((row) => [row.id, row.complete, row.evidence.at(-1)?.assignment?.model]), [
      ["inspect", true, "fake-small"], ["verify", false, "fake-small"], ["follow-up", false, undefined],
    ]);
    assert.equal(state.task?.plan?.items[1]?.evidence.at(-1)?.state, "failed");
    assert.deepEqual(state.task?.plan?.items[0]?.evidence[0]?.reportedModel, { model: "fake-coder", source: "api_header" });
    assert.deepEqual(state.task?.plan?.items[1]?.evidence[0]?.reportedModel, { model: "fake-small", source: "api_receipt" });
    assert.ok(state.task?.plan?.items.every(({ segmentId }) => segmentId === state.task?.id));
    assert.equal(gateway.completions[0]?.body.model, "smart-adaptive");
    assert.ok(gateway.completions.slice(1).every((record) => record.body.model === "fake-small"));
    await list.getByText("Task List", { exact: true }).click();
    await expect(list.getByText("Inspect search requests", { exact: true })).toBeHidden();
    await list.getByText("Task List", { exact: true }).click();
    await expect(list.getByText("Inspect search requests", { exact: true })).toBeVisible();
    const hasIcons = (theme: "dark" | "light", naturalSize: number) =>
      list.locator(`img.${theme}-icon`).evaluateAll((icons, expected) =>
        icons.length === 3 && icons.every((icon) => icon instanceof HTMLImageElement && icon.naturalWidth === expected &&
          Math.round(icon.getBoundingClientRect().width) === 14 && Math.round(icon.getBoundingClientRect().height) === 14), naturalSize);
    await expect.poll(() => hasIcons("dark", 24)).toBe(true);
    const inspect = list.locator(".code-task-list-item").filter({ hasText: "Inspect search requests" });
    await inspect.locator("summary").click();
    await expect(inspect.getByText(/Actual model Fake Coder \(Tomverse API response header\)/)).toBeVisible();
    await expect(inspect.getByText(/Applied effort · Default/)).toBeVisible();
    const artifact = process.env.TOMVERSE_CODE_TASK_LIST_QA;
    if (artifact) {
      await list.screenshot({ path: join(artifact, "task-list-dark.png") });
      await page.locator(".thread").screenshot({ path: join(artifact, "code-analysis-dark.png") });
    }
    await page.getByRole("button", { name: "Use light theme" }).click();
    await expect.poll(() => hasIcons("light", 14)).toBe(true);
    if (artifact) {
      await list.screenshot({ path: join(artifact, "task-list-light.png") });
      await page.locator(".thread").screenshot({ path: join(artifact, "code-analysis-light.png") });
    }
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.setViewportSize({ width: 420, height: 760 });
    await expect.poll(() => analysis.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect.poll(() => list.locator(".code-task-list-row").first().evaluate((row) =>
      row.querySelector(".code-task-list-model")!.getBoundingClientRect().top >= row.querySelector(".code-task-list-title")!.getBoundingClientRect().bottom - 1,
    )).toBe(true);
    if (artifact) await list.screenshot({ path: join(artifact, "task-list-compact.png") });
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Show history", exact: true }).click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("button", { name: "Verify the search task list", exact: true }).click();
    await expect(list.getByText("1/3 complete")).toBeVisible();
    await expect(list.getByText("Completion unverified", { exact: true })).toBeVisible();
    assert.deepEqual((await page.evaluate(() => window.desktop.state())).task?.plan, state.task?.plan);

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Code mode").selectOption("plan");
    await send("Plan a read-only change");
    await expect(page.getByText("Here is the proposed work.")).toBeVisible();
    await expect(analysis).toContainText(fixtureWorkAnalysis.objective);
    await expect(list.getByText("0/3 complete")).toBeVisible();
    await expect(list.locator('[data-status="pending"]')).toHaveCount(3);
    const planned = (await page.evaluate(() => window.desktop.state())).task!;
    assert.equal(planned.plan?.activeId, null);
    assert.equal(planned.plan?.proposalOnly, true);
    assert.ok(planned.plan?.items.every((row) => !row.complete && !row.apiAssignment && row.evidence.length === 0));
    const planTranscript = JSON.stringify(gateway.completions.at(-1)?.body.messages);
    assert.match(planTranscript, /Search behavior fixture/);
    assert.equal(planTranscript.match(/Plan mode only publishes proposed items/g)?.length, 2);
    assert.equal(application.windows().length, 1);

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByLabel("Code mode").selectOption("agent");
    await page.getByLabel("Model and reasoning effort").click();
    await page.getByLabel("Task reasoning effort").selectOption("high");
    await page.getByLabel("Model and reasoning effort").click();
    const [beforeStop] = await Promise.all([application.waitForEvent("window", { timeout: approvalWait }), send("Resume the recorded work")]);
    await answer(beforeStop, "Allow for this run");
    const starts = join(root, "resume-starts.txt");
    await expect.poll(() => readFile(starts, "utf8").catch(() => "")).toBe("started\n");
    await page.getByRole("textbox", { name: "Code request" }).fill(resumeInstruction);
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    const resume = page.getByRole("button", { name: "Resume task", exact: true });
    await expect(resume).toBeVisible({ timeout: 15_000 });
    await expect(list.locator('[data-status="completed"]')).toHaveCount(1);
    await expect(list.locator('[data-status="cancelled"]')).toHaveCount(1);
    const stopped = (await page.evaluate(() => window.desktop.state())).task!;
    const codeHistory = join(profile, "code");
    const [historyScope] = await readdir(codeHistory);
    const journalDirectory = join(codeHistory, historyScope!, "sessions", stopped.id!);
    const stoppedJournal = Journal.read(journalDirectory);
    assert.deepEqual(stoppedJournal.tasks[0]?.followUps, [{ text: resumeInstruction }]);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("button", { name: "Resume the recorded work", exact: true }).click();
    await expect(resume).toBeVisible();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    const [afterStop] = await Promise.all([application.waitForEvent("window", { timeout: approvalWait }), resume.click()]);
    assert.equal(await readFile(starts, "utf8"), "started\n");
    await answer(afterStop, "Allow once");
    await expect(page.getByText("The resumed work is verified.")).toBeVisible();
    await expect(list.getByText("2/2 complete")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Code task", exact: true })).toHaveCount(0);
    const resumed = (await page.evaluate(() => window.desktop.state())).task!;
    assert.equal(resumed.id, stopped.id);
    assert.equal(resumed.effort, "high");
    assert.deepEqual(resumed.plan?.items[0]?.apiAssignment, stopped.plan?.items[0]?.apiAssignment);
    assert.deepEqual(resumed.plan?.items[1]?.apiAssignment?.assignment, { model: "fake-small", requestSeq: 5 });
    const stoppedEvidence = stopped.plan?.items[0]?.evidence[0];
    const resumedEvidence = resumed.plan?.items[0]?.evidence[0];
    assert.ok(stoppedEvidence && resumedEvidence);
    assert.deepEqual(resumedEvidence.assignment, stoppedEvidence.assignment);
    assert.equal(resumedEvidence.appliedEffort, stoppedEvidence.appliedEffort);
    assert.equal(resumedEvidence.state, stoppedEvidence.state);
    assert.deepEqual(resumedEvidence.reportedModel,
      stoppedEvidence.reportedModel ?? { model: "fake-small", source: "api_receipt" });
    assert.ok(resumed.plan?.items.every(({ segmentId }) => segmentId === stopped.id));
    assert.deepEqual(stopped.transmission.map(({ seq }) => seq), [1, 2, 3, 4]);
    assert.deepEqual(resumed.transmission.map(({ seq }) => seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    const resumedJournal = Journal.read(journalDirectory);
    assert.equal(resumedJournal.tasks.length, 1);
    assert.equal(resumedJournal.tasks[0]?.startedAt, stoppedJournal.tasks[0]?.startedAt);
    assert.equal(resumedJournal.tasks[0]?.allowance, stoppedJournal.tasks[0]?.allowance);
    assert.equal(resumedJournal.tasks[0]?.timeAllowanceMs, stoppedJournal.tasks[0]?.timeAllowanceMs);
    assert.ok(resumedJournal.tasks[0]!.activeMs >= stoppedJournal.tasks[0]!.activeMs);
    assert.equal(resumedJournal.tasks[0]?.requests, 8);
    assert.equal(await readFile(starts, "utf8"), "started\nstarted\n");
    const resumeRequests = gateway.completions.filter(({ body }) => JSON.stringify(body.messages).includes("Resume the recorded work"));
    assert.equal(resumeRequests[0]?.body.model, "smart-adaptive");
    assert.ok(resumeRequests.slice(1).every(({ body }) => body.model === "fake-small" && body.tomverse_effort === "high"));
    assert.ok(resumeRequests.slice(0, 4).every(({ body }) => !JSON.stringify(body.messages).includes(resumeInstruction)));
    assert.ok(JSON.stringify(resumeRequests[4]?.body.messages).includes(resumeInstruction));

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await send("Stop planned work");
    await expect(list.getByText("0/3 complete")).toBeVisible();
    await expect.poll(() => gateway.completions.filter(({ body }) => JSON.stringify(body.messages).includes("Stop planned work")).length).toBe(2);
    const active = list.locator('.code-task-list-item[data-status="running"]');
    await expect(active.locator(".code-task-list-model")).toHaveText("Fake Coder");
    await expect(list.getByText("Awaiting assignment", { exact: true })).toHaveCount(2);
    const assigned = (await page.evaluate(() => window.desktop.state())).task!;
    assert.deepEqual(assigned.plan?.items[0]?.evidence, []);
    const assignedRequests = gateway.completions.filter(({ body }) => JSON.stringify(body.messages).includes("Stop planned work"));
    assert.deepEqual(assignedRequests.map(({ body }) => body.model), ["smart-adaptive", "fake-coder"]);
    await active.locator("summary").click();
    await expect(active.getByText(/Actual model Fake Coder \(Tomverse API response header\)/)).toBeVisible();
    if (artifact) await list.screenshot({ path: join(artifact, "task-list-activation.png") });
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect(list.locator('[data-status="cancelled"]')).toHaveCount(3);
    await expect(resume).toHaveCount(0);
    assert.equal(await page.evaluate(async () => {
      const state = await window.desktop.state();
      return window.desktop.resume(state.task!.id!);
    }), false);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("button", { name: "Stop planned work", exact: true }).click();
    await expect(list.locator(".code-task-list-model").first()).toHaveText("Fake Coder");
  } catch (error) {
    const artifact = process.env.TOMVERSE_CODE_TASK_LIST_QA;
    if (artifact) {
      const state = await page.evaluate(() => window.desktop.state());
      await writeFile(join(artifact, "task-list-failure.json"), JSON.stringify({ task: state.task,
        messages: gateway.completions.map(({ body }) => body.messages) }, null, 2));
    }
    throw error;
  } finally {
    await application.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Code waits for a clarification and keeps the answer in the saved conversation", {
  timeout: process.platform === "linux" ? 150_000 : 70_000,
  skip: packaged && !codex ? "Requires the pinned Codex file to start the Task QA package" : false,
}, async () => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-clarification-"));
  const root = join(tmp, "project");
  const profile = join(tmp, "profile");
  const question = "Should search include archived records?";
  const reply = "Include archived records in this report.";
  const original = "Check whether search is missing records.";
  const marker = "Search currently excludes archived records.";
  const analysis = { ...fixtureWorkAnalysis, verifiedFacts: [marker], assumptions: ["The report may need archived records."] };
  const gateway = await new FakeGateway({
    script(body, index) {
      const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      const transcript = JSON.stringify(body.messages);
      if (index < 3) assert.deepEqual(names.sort(), ["list_files", "read_file", "search_text", "update_task_plan"]);
      if (index === 0) return { toolCalls: [{ name: "read_file", args: { path: "search.txt" } }] };
      assert.ok(transcript.includes(marker));
      if (index === 1) return { toolCalls: [{ name: "update_task_plan", args: {
        revision: 0, items: [], activeId: null, analysis, clarification: question,
      } }] };
      assert.ok(transcript.includes(question) && transcript.includes(original) && transcript.includes(reply));
      if (index === 2) return { toolCalls: [{ name: "update_task_plan", args: {
        revision: 1, items: [{ id: "inspect", title: "Check archived search records" }], activeId: "inspect", analysis,
      } }] };
      assert.ok(names.includes("apply_patch") && names.includes("run_command"));
      return { text: "The archive scope is confirmed." };
    },
  }).start();
  let application: Awaited<ReturnType<typeof launchNativeFixture>> | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(join(root, "search.txt"), marker);
    const descriptor = join(tmp, "fixture.json");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY,
      ...(packaged && { codex: { executable: codex, version: "0.171.0-alpha.13", model: "fake-coder",
        origin: new URL(gateway.base).origin } }),
    }));
    application = await launchNativeFixture(descriptor, launchWait);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("agent");
    await page.getByRole("textbox", { name: "Code request" }).fill(original);
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).task?.status).toBe("clarification");
    const held = (await page.evaluate(() => window.desktop.state())).task!;
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(marker);
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(analysis.assumptions[0]!);
    await expect(page.getByText(question, { exact: true })).toHaveCount(1);
    await expect(page.locator(".code-task-list")).toHaveCount(0);
    const store = join(profile, "code");
    const [scope] = await readdir(store);
    const directory = join(store, scope!, "sessions", held.id!);
    const pausedJournal = Journal.read(directory);
    assert.equal(canAnswerClarification(pausedJournal), true);
    const savedTask = pausedJournal.tasks[0]!;
    assert.equal(canAnswerClarification({ ...pausedJournal, tasks: [{ ...savedTask, allowance: savedTask.requests }] }), false);
    assert.equal(canAnswerClarification({ ...pausedJournal, tasks: [{ ...savedTask, activeMs: savedTask.timeAllowanceMs }] }), false);
    assert.equal(gateway.completions.length, 2);
    assert.equal(application.windows().length, 1);
    assert.equal(await readFile(join(root, "search.txt"), "utf8"), marker);
    await application.close();
    application = await launchNativeFixture(descriptor, launchWait);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    const showHistory = page.getByRole("button", { name: "Show history", exact: true });
    if (await showHistory.isVisible()) await showHistory.click();
    await page.getByRole("button", { name: original, exact: true }).click();
    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await expect(page.getByText(desktopShellCopy.en.newHistoryRequest, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Request analysis" })).toContainText(marker);
    assert.equal(gateway.completions.length, 2);
    await page.getByRole("textbox", { name: "Code request" }).fill(reply);
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(page.getByText("The archive scope is confirmed.", { exact: true })).toBeVisible();
    await expect(page.locator(".code-task-list").getByText("Check archived search records", { exact: true })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).task?.status).toBe("completed");
    const finished = (await page.evaluate(() => window.desktop.state())).task!;
    assert.equal(finished.id, held.id);
    const completedJournal = Journal.read(directory);
    assert.equal(completedJournal.tasks.length, 1);
    assert.equal(completedJournal.tasks[0]?.allowance, pausedJournal.tasks[0]?.allowance);
    assert.equal(completedJournal.tasks[0]?.timeAllowanceMs, pausedJournal.tasks[0]?.timeAllowanceMs);
    assert.equal(completedJournal.tasks[0]?.requests, 4);
    assert.equal(gateway.completions.length, 4);
    const userAnswer = page.getByText(reply, { exact: true });
    assert.ok(await userAnswer.evaluate((element) => Boolean(
      element.compareDocumentPosition(document.querySelector(".code-task-list")!) & Node.DOCUMENT_POSITION_FOLLOWING)));
  } finally {
    await application?.close();
    await gateway.stop();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
