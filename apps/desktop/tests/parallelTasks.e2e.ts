import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { decideNativePatch, launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const available = (() => {
  try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; }
})();

test("two tasks run at once in their own worktrees, both show in the activity list, and one approval never answers the other", { timeout: 150_000, skip: !available }, async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "tomverse-parallel-")));
  const root = join(folder, "repo");
  const profile = join(folder, "profile-data", "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const prompt = JSON.stringify(body.messages.findLast((item: { role: string }) => item.role === "user"));
      const name = prompt.includes("Task Alpha") ? "alpha.txt" : "beta.txt";
      if (fixtureOperationResults(body).length === 0) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: name, action: "create", content: prompt }] } }] };
      return { text: name === "alpha.txt" ? "Alpha is done." : "Beta is done." };
    },
  }).start();
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(profile, { recursive: true })]);
    git(root, "init", "-b", "main");
    await writeFile(join(root, "tracked.txt"), "original");
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    application = await launchNativeFixture(descriptor);
    const page: Page = await application.firstWindow();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open local folder" }).click();
    const state = () => page.evaluate(() => window.desktop.state());
    const editor = page.getByRole("textbox", { name: "Code request", exact: true });
    await expect(page.locator('summary[aria-label="Code workspace"]')).toHaveText("New worktree · main");

    // The open task starts in its own worktree and waits for a file approval.
    const firstCard = application.waitForEvent("window", { timeout: 20_000 });
    void firstCard.catch(() => undefined);
    await editor.fill("Task Alpha: write alpha.txt");
    await page.getByRole("button", { name: "Send Code request", exact: true }).click();
    const alphaCard = await firstCard;
    await expect(alphaCard.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
    await expect.poll(async () => (await state()).task?.status).toBe("approval");
    const alphaRoot = (await state()).task!.root;

    // A second task starts next to it from the activity list, in a worktree of its own.
    await page.getByTestId("activity-button").click();
    await expect(page.getByTestId("activity-dialog")).toBeVisible();
    await page.getByTestId("activity-start").getByRole("textbox").fill("Task Beta: write beta.txt");
    await page.getByTestId("start-parallel").click();
    await expect.poll(async () => (await state()).parallel?.rows.length, { timeout: 20_000 }).toBe(2);
    await expect.poll(async () => (await state()).parallel?.rows.map((row) => row.state).join(","), { timeout: 30_000 }).toBe("approval,approval");
    const rows = (await state()).parallel!.rows;
    assert.deepEqual(rows.map((row) => row.kind), ["foreground", "parallel"]);
    assert.notEqual(rows[0]!.folder, rows[1]!.folder);
    assert.equal(rows[0]!.folder, alphaRoot);
    assert.equal(rows[1]!.isolated, true);
    const betaRoot = rows[1]!.folder;
    assert.ok(betaRoot.includes("Tomverse Worktrees"));
    // Both tasks are in the list at once, each with its state in one line.
    await expect(page.getByTestId("activity-row")).toHaveCount(2);
    await expect(page.getByTestId("row-status")).toHaveText(["Waiting for approval", "Waiting for approval"]);

    // Only the first card is on screen, and approving it leaves the other task waiting.
    const secondCard = application.waitForEvent("window", { timeout: 20_000 });
    void secondCard.catch(() => undefined);
    await decideNativePatch(alphaCard);
    await expect.poll(() => readFile(join(alphaRoot, "alpha.txt"), "utf8").catch(() => ""), { timeout: 20_000 }).toContain("Task Alpha");
    const betaCard = await secondCard;
    await expect(betaCard.getByTestId("approval-origin")).toContainText("Parallel task");
    await expect(betaCard.getByTestId("approval-origin")).toContainText("Task Beta");
    await expect(betaCard.getByTestId("approval-origin")).toContainText(betaRoot);
    await expect.poll(async () => (await state()).task?.status, { timeout: 20_000 }).toBe("completed");
    const afterAlpha = (await state()).parallel!.rows.find((row) => row.kind === "parallel");
    assert.equal(afterAlpha?.state, "approval", "the other task still waits for its own approval");
    await assert.rejects(readFile(join(betaRoot, "beta.txt"), "utf8"));
    await assert.rejects(readFile(join(alphaRoot, "beta.txt"), "utf8"));

    // The second task is answered on its own card; the first task's files are untouched by it.
    await decideNativePatch(betaCard);
    await expect.poll(() => readFile(join(betaRoot, "beta.txt"), "utf8").catch(() => ""), { timeout: 20_000 }).toContain("Task Beta");
    await expect.poll(async () => (await state()).parallel?.rows.find((row) => row.kind === "parallel")?.outcome, { timeout: 30_000 }).toBe("completed");
    await assert.rejects(readFile(join(alphaRoot, "beta.txt"), "utf8"));
    await assert.rejects(readFile(join(betaRoot, "alpha.txt"), "utf8"));
    await expect(page.getByTestId("row-status").last()).toHaveText("Completed");

    // A finished task opens side by side with the other one.
    await page.getByTestId("row-split").first().click();
    await page.getByTestId("row-split").last().click();
    await expect(page.getByTestId("lane-task-view")).toHaveCount(2);
    await expect(page.getByTestId("split-panes")).toContainText("Beta is done.");
    await expect(page.getByTestId("split-panes")).toContainText("Alpha is done.");

    // A task moves into a window of its own, which shows that task and no other.
    const detached = application.waitForEvent("window", { timeout: 15_000 });
    await page.getByTestId("row-window").click();
    const taskWindow = await detached;
    await expect(taskWindow.getByTestId("task-window")).toContainText("Beta is done.");
    await expect(taskWindow.getByTestId("task-window")).not.toContainText("Alpha is done.");
    assert.equal(await taskWindow.evaluate(() => typeof (window as unknown as { desktop?: unknown }).desktop), "undefined");
  } finally {
    await application?.close().catch(() => undefined);
    await gateway.stop();
    await removeNativeFixtureDirectory(folder);
  }
});
