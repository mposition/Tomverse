import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const executablePath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

type Body = { messages?: Array<{ role: string; content?: unknown }> };
const system = (body: Body) => String(body.messages?.[0]?.content);
const isSub = (body: Body) => /subagent of Tomverse CLI/.test(system(body));
const isVerifier = (body: Body) => /independent verifier of one subtask/.test(system(body));
const goalOf = (body: Body) => String(body.messages?.find((message) => message.role === "user")?.content);
const hasTool = (body: Body) => (body.messages ?? []).some((message) => message.role === "tool");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(prefix: string, gateway: FakeGateway) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await writeFile(join(profile, "language.txt"), "en");
  await writeFile(join(root, "sum.js"), "export const sum = (a, b) => a - b;\n");
  await writeFile(join(root, "test.js"), "// Covers sum() of sum.js: sum(2, 3) must be 5.\n");
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Open local folder" }).click();
  return { directory, app, page };
}

const send = (page: Page) => page.getByRole("button", { name: "Send Code request" });

/** Settings, Execution and limits: turns the per-task switch on and shows what it may use. */
async function turnOrchestrationOn(page: Page) {
  await page.getByRole("button", { name: "Desktop settings" }).click();
  await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
  const setting = page.getByLabel("Subagent orchestration", { exact: true });
  await expect(setting).toHaveValue("off");
  await expect(page.getByText(/Up to 3 subagents at once and 90 requests in all/)).toBeVisible();
  await setting.selectOption("on");
  await expect(setting).toHaveValue("on");
  await page.getByRole("button", { name: "Code", exact: true }).click();
}

test("Code hands two subtasks to subagents at once, lists them in the activity view and shows how each was verified", { timeout: 120_000 }, async () => {
  const started = new Set<string>();
  let release!: () => void;
  const hold = new Promise<void>((open) => { release = open; });
  let verdicts = 0;
  const gateway = await new FakeGateway({
    async script(body) {
      if (isVerifier(body)) {
        if (!hasTool(body)) return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
        verdicts += 1;
        return { text: '{"met": true, "reason": "The report names the file and the line.", "evidence": "sum.js line 1"}' };
      }
      if (isSub(body)) {
        if (hasTool(body)) return { text: `Report for ${goalOf(body)}: sum.js line 1 subtracts instead of adding.` };
        started.add(goalOf(body));
        await Promise.race([hold, wait(30_000)]);
        return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
      }
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      return fixtureOperationResults(body).length === 0
        ? { toolCalls: [{ name: "delegate", args: { subtasks: [
          { title: "Find sum", goal: "FIND-SUM: where is sum defined?", done_when: "The report names the file and the line." },
          { title: "Find test", goal: "FIND-TEST: which test covers sum?", done_when: "The report names the file and the line." },
        ] } }] }
        : { text: "Both subtasks reported." };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-orchestrate-", gateway);
  try {
    await turnOrchestrationOn(page);
    await page.getByRole("textbox", { name: "Code request" }).fill("Investigate sum");
    await send(page).click();

    // Both subtasks are in flight together: the model has two requests open at once, and the view shows two running rows.
    await expect.poll(() => started.size, { timeout: 30_000 }).toBe(2);
    const panel = page.getByRole("region", { name: "Subagent activity · 2" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Up to 3 subagents at once, 90 requests in all", { exact: false })).toBeVisible();
    await expect(panel.locator("li[data-subtask-state='running']")).toHaveCount(2);
    await expect(panel.getByRole("button", { name: "Stop all subagents" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop subtask Find sum" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop subtask Find test" })).toBeVisible();
    const before = (await page.evaluate(() => window.desktop.state())).task!;
    assert.ok(before.entries.some((entry) => "text" in entry && /orchestration: up to 3 subagents at once, 90 requests in all/.test(entry.text)), "the limits are shown before the run");
    assert.equal(before.orchestration?.maxSubagents, 3);

    release();
    await expect(page.getByText("Both subtasks reported.", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator("li[data-subtask-state='success']")).toHaveCount(2);
    await expect(panel.getByText("Verified", { exact: true })).toHaveCount(2);
    await expect(panel.getByText(/The report names the file and the line\./).first()).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop all subagents" })).toHaveCount(0);
    assert.equal(verdicts, 2);
    const done = (await page.evaluate(() => window.desktop.state())).task!;
    assert.deepEqual(done.orchestration?.subtasks.map((row) => [row.title, row.state, row.verification?.state]), [["Find sum", "success", "passed"], ["Find test", "success", "passed"]]);
    // The subagents' requests are the task's own requests: the plan step, the delegate step, its answer, two reports and two verifications each.
    assert.equal(gateway.completions.filter((entry) => isSub(entry.body)).length, 8);
    assert.equal(done.apiUsage?.requestCount, 11);
  } finally {
    release();
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Code stops one subagent subtask on its own while the other goes on", { timeout: 90_000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>((open) => { release = open; });
  let slowStarted = false;
  const gateway = await new FakeGateway({
    async script(body) {
      if (isSub(body)) {
        if (goalOf(body) === "SLOW") {
          slowStarted = true;
          await Promise.race([hold, wait(30_000)]);
          return { text: "Too late." };
        }
        return { text: "Quick report." };
      }
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      return fixtureOperationResults(body).length === 0
        ? { toolCalls: [{ name: "delegate", args: { subtasks: [{ title: "Slow one", goal: "SLOW" }, { title: "Quick one", goal: "QUICK" }] } }] }
        : { text: "Finished." };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-orchestrate-stop-", gateway);
  try {
    await turnOrchestrationOn(page);
    await page.getByRole("textbox", { name: "Code request" }).fill("Do both");
    await send(page).click();
    const panel = page.getByRole("region", { name: "Subagent activity · 2" });
    await expect(panel.locator("li", { hasText: "Quick one" })).toHaveAttribute("data-subtask-state", "success", { timeout: 30_000 });
    await expect.poll(() => slowStarted).toBe(true);
    await expect(panel.locator("li", { hasText: "Slow one" })).toHaveAttribute("data-subtask-state", "running");
    await panel.getByRole("button", { name: "Stop subtask Slow one" }).click();
    await expect(panel.locator("li", { hasText: "Slow one" })).toHaveAttribute("data-subtask-state", "cancelled", { timeout: 30_000 });
    await expect(panel.locator("li", { hasText: "Quick one" })).toHaveAttribute("data-subtask-state", "success");
    await expect(panel.getByRole("button", { name: "Stop all subagents" })).toHaveCount(0);
  } finally {
    release();
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** The approval window closes as the click lands, so a closed page after the click is the expected end. */
async function press(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeEnabled();
  try { await button.click(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

test("Code asks about two workers' changes one at a time, each saying which subtask it is for", { timeout: 120_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body) {
      if (isSub(body)) {
        if (hasTool(body)) return { text: "Changed my file." };
        return { toolCalls: [/FIX-SUM/.test(goalOf(body))
          ? { name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "a - b", new: "a + b" }] }], explanation: "fix sum" } }
          : { name: "apply_patch", args: { edits: [{ path: "notes.md", action: "create", content: "notes\n" }], explanation: "add notes" } }] };
      }
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      return fixtureOperationResults(body).length === 0
        ? { toolCalls: [{ name: "delegate", args: { subtasks: [
          { title: "Fix sum", goal: "FIX-SUM", paths: ["sum.js"] },
          { title: "Add notes", goal: "ADD-NOTES", paths: ["notes.md"] },
        ] } }] }
        : { text: "Workers finished." };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-orchestrate-ask-", gateway);
  try {
    await turnOrchestrationOn(page);
    await page.getByRole("textbox", { name: "Code request" }).fill("Fix sum and add notes");
    const baseline = app.windows().length;
    const [first] = await Promise.all([app.waitForEvent("window", { timeout: 30_000 }), send(page).click()]);
    const asked = async (window: Page) => (await window.getByText(/^Asked by subagent: /).textContent())!.replace("Asked by subagent: ", "");
    const firstTitle = await asked(first);
    // The other worker is waiting its turn: no second question is on screen.
    await wait(800);
    assert.equal(app.windows().length, baseline + 1);
    const [second] = await Promise.all([app.waitForEvent("window", { timeout: 30_000 }), press(first, "Allow once")]);
    const secondTitle = await asked(second);
    assert.deepEqual([firstTitle, secondTitle].sort(), ["Add notes", "Fix sum"]);
    await press(second, "Allow once");
    await expect(page.getByText("Workers finished.", { exact: true })).toBeVisible({ timeout: 60_000 });
    const root = (await page.evaluate(() => window.desktop.state())).task!.root;
    assert.match(await readFile(join(root, "sum.js"), "utf8"), /a \+ b/);
    assert.equal(await readFile(join(root, "notes.md"), "utf8"), "notes\n");
    const rows = (await page.evaluate(() => window.desktop.state())).task!.orchestration!.subtasks;
    assert.deepEqual(rows.map((row) => [row.title, row.state, row.filesChanged]), [["Fix sum", "success", ["sum.js"]], ["Add notes", "success", ["notes.md"]]]);
  } finally {
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
