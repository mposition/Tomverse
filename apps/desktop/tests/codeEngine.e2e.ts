import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { openCodeProject, selectCodeMode } from "./code-project-fixture";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";

const electronPath: string = createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

const isJudge = (body: { messages?: Array<{ content?: unknown }> }) =>
  typeof body.messages?.[0]?.content === "string" && body.messages[0].content.startsWith("You judge whether");
const userTexts = (body: { messages?: Array<{ role: string; content?: unknown }> }) =>
  (body.messages ?? []).filter(({ role }) => role === "user").map(({ content }) => String(content));

async function launch(prefix: string, gateway: FakeGateway) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const root = join(directory, "project");
  const profile = join(directory, "profile");
  await Promise.all([mkdir(root), mkdir(profile)]);
  await Promise.all([writeFile(join(profile, "language.txt"), "en"), writeFile(join(root, "first.txt"), "Existing search behavior\n")]);
  const descriptor = join(directory, "fixture.json");
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
  const app = await electron.launch({ executablePath: electronPath, args: [desktopDir, "--desktop-fixture", descriptor], timeout: 20_000 });
  const page = await app.firstWindow();
  await openCodeProject(page);
  return { directory, app, page };
}

const entry = (page: Page, text: string) => page.locator(".code-queue li").filter({ hasText: text });

test("Code queues several messages, reorders, edits and removes them, and runs them in order after the turn", { timeout: 90_000 }, async () => {
  let releaseReply!: () => void;
  const heldReply = new Promise<void>((release) => { releaseReply = release; });
  const gateway = await new FakeGateway({
    async script(_body, index) {
      if (index === 0) return { toolCalls: [{ name: "read_file", args: { path: "first.txt" } }] };
      if (index === 1) await heldReply;
      return { text: `reply ${index}` };
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-queue-", gateway);
  try {
    await selectCodeMode(page, "ask");
    const composer = page.getByRole("textbox", { name: "Code request" });
    await composer.fill("first");
    await page.getByRole("button", { name: "Send Code request" }).click();
    await expect.poll(() => gateway.completions.length).toBe(2);

    // One instruction goes into the running turn; a second waits in the queue.
    await composer.fill("steer one");
    await page.getByRole("button", { name: "Send follow-up instruction" }).click();
    await expect(page.getByText("Queued for the next model request.")).toBeVisible();
    await composer.fill("queue A");
    await composer.press("Enter");
    await expect(entry(page, "queue A")).toBeVisible();
    for (const text of ["queue B", "queue C"]) {
      await composer.fill(text);
      await page.getByRole("button", { name: "Queue", exact: true }).click();
      await expect(entry(page, text)).toBeVisible();
    }
    const order = () => page.locator(".code-queue li > span:first-child").allTextContents();
    assert.deepEqual(await order(), ["queue A", "queue B", "queue C"]);
    await entry(page, "queue C").getByRole("button", { name: "Move earlier" }).click();
    await expect.poll(order).toEqual(["queue A", "queue C", "queue B"]);
    await entry(page, "queue C").getByRole("button", { name: "Move earlier" }).click();
    await expect.poll(order).toEqual(["queue C", "queue A", "queue B"]);
    await entry(page, "queue B").getByRole("button", { name: "Edit queued message" }).click();
    await page.getByRole("textbox", { name: "Edit queued message" }).fill("queue B edited");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(order).toEqual(["queue C", "queue A", "queue B edited"]);
    await entry(page, "queue A").getByRole("button", { name: "Remove queued message" }).click();
    await expect.poll(order).toEqual(["queue C", "queue B edited"]);
    assert.equal(await page.evaluate(() => window.desktop.queueMessage("s-20000101-000000-abcdef", { kind: "add", text: "elsewhere" })), false);

    releaseReply();
    await expect(page.getByText("reply 4", { exact: true })).toBeVisible();
    await expect(page.locator(".code-queue")).toHaveCount(0);
    assert.equal(gateway.completions.length, 5);
    assert.deepEqual(userTexts(gateway.completions[4]!.body), ["first", "steer one", "queue C", "queue B edited"]);
    // The steer joined the history after the whole tool exchange, never inside it.
    assert.equal((gateway.completions[2]!.body.messages as Array<{ role: string }>).map(({ role }) => role).join(), "system,user,assistant,tool,assistant,user");
  } finally {
    releaseReply();
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("Code runs goal mode with no task limit and compacts a finished task on request", { timeout: 90_000 }, async () => {
  const gateway = await new FakeGateway({
    script(body, index) {
      if (typeof body.messages?.[0]?.content === "string" && body.messages[0].content.startsWith("You compress a coding session")) {
        return { text: "The task read first.txt and verified it." };
      }
      if (isJudge(body)) {
        return { text: index < 4 ? '{"met": false, "summary": "Nothing was read.", "next": "Read first.txt."}' : '{"met": true, "summary": "first.txt was read."}' };
      }
      switch (index) {
        case 0: return { toolCalls: [{ name: "update_task_plan", args: { revision: 0, items: [{ id: "work", title: "Check first.txt" }], activeId: "work", analysis: fixtureWorkAnalysis } }] };
        case 1: return { text: "Nothing to do." };
        case 3: return { toolCalls: [{ name: "read_file", args: { path: "first.txt" } }] };
        default: return { text: "Verified first.txt." };
      }
    },
  }).start();
  const { directory, app, page } = await launch("tomverse-desktop-goal-", gateway);
  try {
    await page.evaluate(() => window.desktop.start({ prompt: "Check first.txt", model: "fake-coder", mode: "agent", effort: "default",
      saveHistory: true, workspace: { kind: "local" }, limits: "unlimited", goal: true }));
    const bar = page.locator(".code-engine");
    await expect(bar).toHaveCount(1, { timeout: 30_000 });
    await expect(bar).toContainText("Goal verified", { timeout: 30_000 });
    await expect(bar).toContainText("Goal mode · 1 of 10 automatic continuations");
    await expect(bar).toContainText("Limits · No limit");
    await expect(bar).toContainText(/Context ≈ \d+%/);
    const finished = (await page.evaluate(() => window.desktop.state())).task!;
    assert.equal(finished.limits, "unlimited");
    assert.equal(finished.goal?.continuations, 1);
    assert.equal(finished.goal?.last?.met, true);
    assert.deepEqual(gateway.completions.map(({ body }) => isJudge(body)), [false, false, true, false, false, true]);
    await expect(page.getByRole("button", { name: "Stop Code task" })).toHaveCount(0);

    await page.getByRole("button", { name: "Compact context", exact: true }).click();
    await expect(page.getByText("The earlier part of the conversation was summarized.")).toBeVisible({ timeout: 30_000 });
    const compacted = (await page.evaluate(() => window.desktop.state())).task!;
    assert.equal(compacted.id, finished.id);
    assert.equal(gateway.completions.length, 7);
    assert.equal(compacted.transmission.at(-1)?.purpose, "compact");
  } finally {
    await app.close();
    await gateway.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
