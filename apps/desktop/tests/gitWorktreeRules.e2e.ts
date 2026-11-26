import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, fixtureOperationResults, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { PermissionRuleStore } from "../../tomverse-cli/src/permission-rules";
import { decideNativePatch, launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const available = (() => {
  try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; }
})();

/** A project whose committed rules allow `node mark.mjs`, a task in its own worktree that runs it, and whether the person confirmed the project's rules. */
async function runInWorktree(confirmed: boolean) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "tomverse-worktree-rules-")));
  const root = join(folder, "repo");
  const profile = join(folder, "profile");
  const home = join(folder, "tomverse-home");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({
    script(body) {
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      if (fixtureOperationResults(body).length === 0) return { toolCalls: [{ name: "run_command", args: { argv: ["node", "mark.mjs"] } }] };
      return { text: "Marked." };
    },
  }).start();
  const previousHome = process.env.TOMVERSE_HOME;
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(join(root, ".tomverse"), { recursive: true }), mkdir(profile), mkdir(home)]);
    git(root, "init", "-b", "main");
    await writeFile(join(root, "mark.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("marked.txt", "ran in " + process.cwd());');
    await writeFile(join(root, ".tomverse", "permissions.json"), JSON.stringify({ version: 1, rules: [{ effect: "allow", tool: "run_command", pattern: "node mark.mjs" }] }));
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    // The person confirmed this project's allow rules in an earlier session (the confirmation is kept outside the repository).
    if (confirmed) new PermissionRuleStore({ root, env: { TOMVERSE_HOME: home } }).trustProject();
    process.env.TOMVERSE_HOME = home;
    application = await launchNativeFixture(descriptor);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByLabel("Code mode").selectOption("agent");
    // The worktree the task starts in is planned once the project is read; the draft is restored around the same time.
    await expect.poll(async () => (await page.evaluate(() => window.desktop.state())).codeGitWorkspace?.kind).toBe("git");
    const composer = page.getByRole("textbox", { name: "Code request", exact: true });
    await composer.fill("Run the marker script");
    await expect(composer).toHaveValue("Run the marker script");
    const asked = application.waitForEvent("window", { timeout: confirmed ? 4_000 : 20_000 });
    void asked.catch(() => undefined);
    await expect(page.getByRole("button", { name: "Send Code request", exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: "Send Code request", exact: true }).click();
    let approval = false;
    try {
      await decideNativePatch(await asked);
      approval = true;
    } catch { /* No approval window opened. */ }
    await expect(page.getByText("Marked.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const task = (await page.evaluate(() => window.desktop.state())).task!;
    assert.ok(task.worktree, "the task ran in its own worktree");
    assert.notEqual(task.root, root);
    assert.match(await readFile(join(task.root, "marked.txt"), "utf8"), /ran in/);
    await assert.rejects(readFile(join(root, "marked.txt")), "the project's own folder was not touched");
    return { approval };
  } finally {
    if (previousHome === undefined) delete process.env.TOMVERSE_HOME;
    else process.env.TOMVERSE_HOME = previousHome;
    await application?.close();
    await gateway.stop();
    await removeNativeFixtureDirectory(folder);
  }
}

test("a project's confirmed allow rule covers the task in its worktree: the command runs without asking", { timeout: 120_000, skip: !available }, async () => {
  assert.deepEqual(await runInWorktree(true), { approval: false });
});

test("without the person's confirmation the same rule does not apply in the worktree, and the command asks", { timeout: 120_000, skip: !available }, async () => {
  assert.deepEqual(await runInWorktree(false), { approval: true });
});
