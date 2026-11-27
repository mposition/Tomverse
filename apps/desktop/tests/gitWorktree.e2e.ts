import assert from "node:assert/strict";
import { openCodeProject } from "./code-project-fixture";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { decideNativePatch, launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const available = (() => {
  try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; }
})();

test("Agent edits are isolated by task and a stopped saved task resumes in its own worktree", { timeout: 100_000, skip: !available }, async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "tomverse-agent-worktree-")));
  const root = join(folder, "repo");
  const profileParent = join(folder, "profile-data");
  const profileAlias = join(folder, "profile-alias");
  const profile = join(profileAlias, "profile");
  const descriptor = join(folder, "fixture.json");
  const firstPrompt = "First isolated edit";
  const secondPrompt = "Second isolated edit";
  let readyToResume = false;
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      const prompt = JSON.stringify(body.messages.findLast((item: { role: string }) => item.role === "user"));
      const results = fixtureOperationResults(body);
      const first = prompt.includes(firstPrompt);
      if (first && results.length === 1 && !readyToResume) {
        return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "wait.mjs"] } }] };
      }
      const filename = results.length === 0 ? "created.txt" : first && results.length === 2 ? "resumed.txt" : undefined;
      if (filename) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: filename, action: "create", content: prompt }] } }] };
      return { text: "Workspace edit complete." };
    },
  }).start();
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(join(profileParent, "profile"), { recursive: true })]);
    await symlink(profileParent, profileAlias, process.platform === "win32" ? "junction" : "dir");
    git(root, "init", "-b", "main");
    await writeFile(join(root, "tracked.txt"), "original");
    await writeFile(join(root, "wait.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync("started.txt", "started\\n"); setInterval(() => {}, 1000);');
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");
    git(root, "switch", "-c", "candidate");
    await writeFile(join(root, "tracked.txt"), "candidate");
    git(root, "commit", "-am", "candidate");
    git(root, "switch", "main");
    await writeFile(join(root, "tracked.txt"), "uncommitted original");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    const openProject = async () => {
      application = await launchNativeFixture(descriptor);
      const page = await application.firstWindow();
      await page.getByRole("button", { name: "Code", exact: true }).click();
      await openCodeProject(page);
      return page;
    };
    let page = await openProject();
    const task = () => page.evaluate(() => window.desktop.state().then(state => state.task));
    const editor = () => page.getByRole("textbox", { name: "Code request", exact: true });
    const worktreeBox = () => page.getByTestId("worktree-checkbox");
    const send = () => page.getByRole("button", { name: "Send Code request", exact: true }).click();
    const approve = async (trigger: () => Promise<void>) => {
      const prompted = application!.waitForEvent("window", { timeout: 15_000 });
      void prompted.catch(() => undefined);
      await trigger();
      await decideNativePatch(await prompted);
    };
    await expect(worktreeBox()).toBeChecked();
    await page.getByRole("combobox", { name: "Starting branch" }).selectOption("refs/heads/candidate");
    const planned = (await page.evaluate(() => window.desktop.state())).codeGitWorkspace;
    assert.equal(planned?.kind, "git");
    assert.ok(planned.path.startsWith(join(profileParent, "Tomverse Worktrees")));
    await expect(page.getByTestId("worktree-toggle")).toHaveAttribute("data-worktree-path", planned.path);
    await editor().fill(firstPrompt);
    const firstApproval = application!.waitForEvent("window", { timeout: 15_000 });
    void firstApproval.catch(() => undefined);
    await send();
    const fileApproval = await firstApproval;
    await approve(() => decideNativePatch(fileApproval));
    await expect.poll(() => readFile(join(planned.path, "started.txt"), "utf8").catch(() => "")).toBe("started\n");
    const running = await task();
    assert.ok(running?.id && running.worktree);
    git(running.root, "switch", "--detach");
    assert.equal(await page.evaluate(id => window.desktop.followUp(id, "Refuse a follow-up on a different branch"), running.id), false);
    git(running.root, "switch", running.worktree.branch);
    await page.getByRole("button", { name: "Stop Code task", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toBeVisible({ timeout: 15_000 });
    const first = await task();
    assert.ok(first?.id && first.worktree);
    assert.equal(first.root, planned.path);
    assert.equal(first.worktree.base.ref, "refs/heads/candidate");
    assert.equal(await readFile(join(first.root, "tracked.txt"), "utf8"), "candidate");
    assert.match(await readFile(join(first.root, "created.txt"), "utf8"), /First isolated edit/);
    await assert.rejects(readFile(join(root, "created.txt")));

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect.poll(task).toBeNull();
    await editor().fill(secondPrompt);
    await approve(send);
    await expect(page.getByText("Workspace edit complete.", { exact: true })).toBeVisible();
    const second = await task();
    assert.ok(second?.worktree);
    assert.notEqual(second.root, first.root);
    assert.notEqual(second.worktree.branch, first.worktree.branch);
    assert.equal(await readFile(join(second.root, "tracked.txt"), "utf8"), "original");
    assert.match(await readFile(join(second.root, "created.txt"), "utf8"), /Second isolated edit/);

    await application!.close();
    page = await openProject();
    git(first.root, "switch", "--detach");
    await page.getByRole("button", { name: firstPrompt, exact: true }).click();
    await expect.poll(async () => (await task())?.worktree?.unavailable).toBe(true);
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
    const change = (await task())?.changes[0];
    assert.ok(change);
    const diff = await page.evaluate(id => window.desktop.readChange(id), change.id);
    assert.match(diff?.text ?? "", /First isolated edit/);
    assert.equal(diff?.canUndo, false);
    const check = (await task())?.checks.find(item => item.tool === "run_command");
    assert.ok(check);
    const command = await page.evaluate(id => window.desktop.readCommand(id), check.id);
    assert.deepEqual(command?.command?.args, ["wait.mjs"]);
    git(first.root, "switch", first.worktree.branch);
    await page.getByRole("button", { name: firstPrompt, exact: true }).click();
    await expect.poll(async () => (await task())?.root).toBe(first.root);
    readyToResume = true;
    await approve(() => page.getByRole("button", { name: "Resume task", exact: true }).click());
    await expect(page.getByText("Workspace edit complete.", { exact: true })).toBeVisible();
    assert.equal((await task())?.id, first.id);
    assert.match(await readFile(join(first.root, "resumed.txt"), "utf8"), /First isolated edit/);
    assert.equal(await readFile(join(first.root, "started.txt"), "utf8"), "started\n");
    await assert.rejects(readFile(join(second.root, "resumed.txt")));

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect.poll(task).toBeNull();
    await worktreeBox().uncheck();
    await editor().fill("Edit the current folder");
    await approve(send);
    await expect(page.getByText("Workspace edit complete.", { exact: true })).toBeVisible();
    assert.equal((await task())?.root, root);
    assert.match(await readFile(join(root, "created.txt"), "utf8"), /Edit the current folder/);
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "uncommitted original");
    assert.equal(git(root, "branch", "--show-current"), "main");

    await page.getByRole("button", { name: "New task", exact: true }).click();
    // The Worktree box is remembered per project: it stays off after the person turned it off.
    await expect(worktreeBox()).not.toBeChecked();
    await worktreeBox().check();
    await editor().fill("Refuse an edit after an external branch switch");
    const switchedApproval = application!.waitForEvent("window", { timeout: 15_000 });
    void switchedApproval.catch(() => undefined);
    await send();
    const switchedDialog = await switchedApproval;
    const switched = await task();
    assert.ok(switched?.worktree);
    git(switched.root, "switch", "--detach");
    await decideNativePatch(switchedDialog);
    await expect.poll(() => page.evaluate(() => window.desktop.state().then(state => state.busy))).toBe(false);
    await assert.rejects(readFile(join(switched.root, "created.txt")));
    assert.match(await readFile(join(root, "created.txt"), "utf8"), /Edit the current folder/);

    const moved = join(dirname(first.root), "moved-checkout");
    await rename(first.root, moved);
    await page.getByRole("button", { name: firstPrompt, exact: true }).click();
    await expect.poll(async () => (await task())?.worktree?.unavailable).toBe(true);
    const movedDiff = await page.evaluate(id => window.desktop.readChange(id), change.id);
    assert.match(movedDiff?.text ?? "", /First isolated edit/);
    await application!.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    assert.equal(await page.evaluate(id => window.desktop.deleteHistory(id), first.id), "deleted");
    await expect(page.getByRole("button", { name: firstPrompt, exact: true })).toHaveCount(0);
    assert.match(await readFile(join(moved, "created.txt"), "utf8"), /First isolated edit/);
  } finally {
    await application?.close();
    await gateway.stop();
    assert.equal(dirname(folder), await realpath(tmpdir()));
    await removeNativeFixtureDirectory(folder);
  }
});
