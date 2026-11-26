import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("Code queues a follow-up, checks revised work and preserves the conversation", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tomverse-desktop-follow-up-"));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  const firstFile = join(root, "first.txt");
  await Promise.all([
    writeFile(join(profile, "language.txt"), "en"),
    writeFile(firstFile, "Existing search behavior\n"),
    writeFile(join(root, "keyboard.txt"), "Keyboard regression evidence\n"),
  ]);
  const firstPrompt = "Review the original search behavior";
  const followUp = "Use the keyboard evidence and leave the original files untouched";
  const done = "The follow-up was verified.";
  const initialRows = [{ id: "inspect", title: "Inspect search" }, { id: "verify", title: "Verify search" }];
  const revisedRows = [initialRows[0]!, { id: "verify", title: "Verify keyboard search" }];
  const revisedAnalysis = { ...fixtureWorkAnalysis, objective: "Verify search with the current keyboard evidence." };
  const update = (revision: number, items: typeof initialRows, activeId: string | null, completeId?: string) => ({
    toolCalls: [{ name: "update_task_plan", args: { revision, items, activeId, completeId,
      analysis: items === revisedRows ? revisedAnalysis : fixtureWorkAnalysis } }],
  });
  const read = (path: string) => ({ toolCalls: [{ name: "read_file", args: { path } }] });
  let releaseReply!: () => void;
  const heldReply = new Promise<void>((release) => { releaseReply = release; });
  const gateway = await new FakeGateway({
    async script(body, index) {
      switch (index) {
        case 0: return update(0, initialRows, "inspect");
        case 1: return read("first.txt");
        case 2: return update(1, initialRows, "verify", "inspect");
        case 3: return read("first.txt");
        case 4:
          await heldReply;
          return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "stale.txt", action: "create", content: "Stale proposal" }] } }] };
        case 5:
          assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
            // The analysis stage: the read tools, the plan, and explore subagents (read-only; a worker is refused until a work item is active).
            ["delegate", "list_files", "read_file", "search_text", "update_task_plan"]);
          return update(2, revisedRows, "verify");
        case 6: return update(3, revisedRows, null, "verify");
        case 7: return read("keyboard.txt");
        case 8: return update(3, revisedRows, null, "verify");
        default: return { text: done };
      }
    },
  }).start();
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  const page = await app.firstWindow();
  try {
    await page.getByRole("button", { name: "Open local folder" }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, firstFile);
    await page.getByLabel("Attach project files or folders").click();
    await page.getByRole("button", { name: "Attach files", exact: true }).click();
    await expect(page.getByRole("list", { name: "Project references", exact: true })).toContainText("first.txt");
    const composer = page.getByRole("textbox", { name: "Code request" });
    await composer.fill(firstPrompt);
    await page.getByRole("button", { name: "Send Code request" }).click();

    await expect.poll(() => gateway.completions.length).toBe(5);
    const list = page.locator(".code-task-list");
    await expect(list.getByText("1/2 complete")).toBeVisible();
    const analysis = page.getByRole("region", { name: "Request analysis" });
    await expect(analysis).toContainText(fixtureWorkAnalysis.objective);
    const taskId = (await page.evaluate(() => window.desktop.state())).task!.id!;
    await composer.fill(followUp);
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(composer).toBeEmpty();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    await expect(page.getByText(followUp, { exact: true })).toHaveCount(1);
    assert.equal(gateway.completions.length, 5);
    assert.equal(await page.evaluate((id) => window.desktop.followUp(id, "Duplicate queued instruction"), taskId), false);
    assert.equal(await page.evaluate(() => window.desktop.followUp("s-20000101-000000-abcdef", "Another session")), false);

    releaseReply();
    await expect(page.getByText(done)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Code task" })).toHaveCount(0);
    await expect(list.getByText("Verify keyboard search", { exact: true })).toBeVisible();
    await expect(list.getByText("2/2 complete")).toBeVisible();
    await expect(page.getByText("Queued for the next model request.")).toHaveCount(0);
    await expect(page.getByText(followUp, { exact: true })).toHaveCount(1);
    await assert.rejects(readFile(join(root, "stale.txt")), { code: "ENOENT" });
    await expect(analysis).toContainText(revisedAnalysis.objective);
    await expect(analysis).not.toContainText(fixtureWorkAnalysis.objective);
    assert.ok(await analysis.evaluate((element) => Boolean(
      element.compareDocumentPosition(Array.from(document.querySelectorAll(".entry--user")).at(-1)!) &
      Node.DOCUMENT_POSITION_PRECEDING)));
    assert.equal(await readFile(firstFile, "utf8"), "Existing search behavior\n");
    const requests = gateway.completions;
    assert.equal(requests.length, 10);
    assert.ok(requests.slice(0, 5).every(({ body }) => !JSON.stringify(body.messages).includes(followUp)));
    const next = JSON.stringify(requests[5]?.body.messages);
    assert.match(next, /Use the keyboard evidence/);
    assert.match(next, /user follow-up arrived before this proposal was approved/i);
    assert.match(JSON.stringify(requests[7]?.body.messages), /completion requires successful recorded work/i);
    assert.deepEqual([requests[0]?.body.model, ...requests.slice(1).map(({ body }) => body.model)],
      ["smart-adaptive", ...Array(9).fill("fake-coder")]);
    assert.equal(app.windows().length, 1);

    const finished = (await page.evaluate(() => window.desktop.state())).task!;
    assert.equal(finished.id, taskId);
    assert.deepEqual(finished.plan?.items[1]?.evidence.map(({ state }) => state), ["succeeded", "denied", "succeeded"]);
    const showHistory = page.getByRole("button", { name: "Show history", exact: true });
    if (await showHistory.isVisible()) await showHistory.click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("button", { name: firstPrompt, exact: true }).click();
    await expect(page.getByText(followUp, { exact: true })).toHaveCount(1);
    await expect(page.getByRole("list", { name: "Attached project references" })).toContainText("first.txt");
    assert.deepEqual((await page.evaluate(() => window.desktop.state())).task?.plan, finished.plan);
  } catch (error) {
    const artifact = process.env.TOMVERSE_CODE_FOLLOW_UP_QA;
    if (artifact && !page.isClosed()) {
      const state = await page.evaluate(() => window.desktop.state());
      await writeFile(join(artifact, "follow-up-failure.json"), JSON.stringify({ task: state.task,
        messages: gateway.completions.map(({ body }) => body.messages) }, null, 2));
    }
    throw error;
  } finally {
    releaseReply();
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
