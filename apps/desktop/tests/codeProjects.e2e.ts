import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { FakeGateway, fixtureInitialWorkPlan, fixtureNeedsWorkPlan, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { Journal } from "../../tomverse-cli/src/session.js";
import { codeHistoryScope } from "../src/host/history-scope";
import { bindProjectRoot } from "../src/host/project-root";
import { selectCodeMode } from "./code-project-fixture";
import { launchNativeFixture, removeNativeFixtureDirectory } from "./launch-native-fixture";

const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const hasGit = (() => { try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; } })();

async function workspace(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const folders = { alpha: join(directory, "alpha"), beta: join(directory, "beta"), repo: join(directory, "repo"), parent: join(directory, "parent") };
  await Promise.all(Object.values(folders).map((folder) => mkdir(folder)));
  const profile = join(directory, "profile");
  await mkdir(profile);
  await writeFile(join(profile, "language.txt"), "en");
  if (hasGit) {
    git(folders.repo, "init", "-b", "main");
    await writeFile(join(folders.repo, "tracked.txt"), "x");
    git(folders.repo, "add", ".");
    git(folders.repo, "commit", "-m", "baseline");
  }
  return { directory, profile, ...folders };
}

const state = (page: Page) => page.evaluate(() => window.desktop.state());
const picker = (page: Page) => page.getByTestId("code-project-picker");
const rows = (page: Page) => page.locator('[data-testid^="environment-project-"]');

async function openPicker(page: Page) {
  await picker(page).click();
  await expect(page.getByTestId("code-project-popover")).toBeVisible();
}

test("Create project registers folders, the picker lists, searches and favourites them, and a new conversation runs in the chosen folder", {
  timeout: 150_000, skip: !hasGit && "needs git",
}, async () => {
  const w = await workspace("tomverse-code-projects-");
  const gateway = await new FakeGateway({ script: (body) => fixtureNeedsWorkPlan(body) ? fixtureInitialWorkPlan : { text: "Done in the chosen folder." } }).start();
  let app: ElectronApplication | undefined;
  try {
    const descriptor = join(w.directory, "fixture.json");
    await writeFile(descriptor, JSON.stringify({
      root: w.alpha, profile: w.profile, endpoint: gateway.base, key: TEST_KEY,
      projectFolders: [w.alpha, w.beta, w.repo], projectParent: w.parent, wslDistributions: ["Ubuntu", "Debian"],
    }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Code", exact: true }).click();

    // The start screen offers "Create project", not "Open folder".
    await expect(page.getByRole("button", { name: /Open (local )?folder/i })).toHaveCount(0);
    await expect(picker(page)).toContainText("Choose a project");
    await page.getByTestId("create-project-welcome").click();
    await page.getByTestId("project-existing-folder").click();
    await expect(picker(page)).toContainText("alpha");
    assert.equal((await state(page)).root, w.alpha);

    // The history column's button makes the next one; a folder that is already a project is only opened again.
    await page.locator(".open-folder").click();
    await expect(page.getByTestId("project-new-folder")).toBeVisible();
    await page.getByTestId("project-existing-folder").click();
    await expect(picker(page)).toContainText("beta");
    await page.locator(".open-folder").click();
    await page.getByTestId("project-existing-folder").click();
    await expect(picker(page)).toContainText("repo");

    await openPicker(page);
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "Local" })).toBeVisible();
    await expect(page.getByTestId(/^environment-project-/).filter({ hasText: "repo" })).toHaveAttribute("aria-selected", "true");

    // Cloud is listed and switched off, with the reason, because this server does not offer it.
    const cloud = page.getByTestId("environment-cloud-auto");
    await expect(cloud).toHaveAttribute("aria-disabled", "true");
    await expect(cloud).toContainText("Cloud tasks are not offered for this account.");
    await expect(page.getByTestId("environment-cloud-default")).toHaveAttribute("aria-disabled", "true");

    // WSL lists the distributions on Windows only, switched off with the SSH hint.
    if (process.platform === "win32") {
      await expect(page.getByRole("heading", { name: "WSL" })).toBeVisible();
      const ubuntu = page.getByTestId("environment-wsl-Ubuntu");
      await expect(ubuntu).toHaveAttribute("aria-disabled", "true");
      await expect(ubuntu).toContainText("SSH remote (localhost)");
      await expect(page.getByTestId("environment-wsl-Debian")).toBeVisible();
    } else await expect(page.getByRole("heading", { name: "WSL" })).toHaveCount(0);

    // A favourite goes to the top; the order survives a restart (below).
    const star = (name: string) => page.getByRole("button", { name: `Add ${name} to favorites` });
    await star("beta").click();
    await expect(page.getByRole("button", { name: "Remove beta from favorites" })).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page).first()).toContainText("beta");

    // Search filters by name, and typing from a row goes to the search box.
    const search = page.getByTestId("project-search");
    await search.fill("alp");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("alpha");
    await expect(page.getByTestId("environment-cloud-auto")).toHaveCount(0);
    await search.fill("zzz");
    await expect(page.getByText("Nothing matches.").first()).toBeVisible();
    await search.fill("");

    // The keyboard: type, arrow, Enter. Escape closes and keeps the open project.
    await search.fill("alp");
    await search.press("Enter");
    await expect(picker(page)).toContainText("alpha");
    assert.equal((await state(page)).root, w.alpha);
    await openPicker(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("code-project-popover")).toHaveCount(0);
    await expect(picker(page)).toBeFocused();

    // Settings rename the project; the folder keeps its name.
    await openPicker(page);
    const alphaId = (await state(page)).codeProjects!.selectedId!;
    await page.getByTestId(`project-settings-${alphaId}`).click();
    await page.getByTestId("project-settings-name").fill("Alpha app");
    await page.getByTestId("project-settings-done").click();
    await expect(picker(page)).toContainText("Alpha app");
    assert.equal((await state(page)).project, "alpha");

    // A new conversation starts in the chosen project, whichever one that is.
    await selectCodeMode(page, "ask");
    const send = async (text: string) => {
      await page.getByRole("textbox", { name: "Code request", exact: true }).fill(text);
      await page.getByRole("button", { name: "Send Code request", exact: true }).click();
      await expect(page.getByText("Done in the chosen folder.", { exact: true }).last()).toBeVisible({ timeout: 30_000 });
    };
    await send("Run in alpha");
    assert.equal((await state(page)).task?.root, w.alpha);
    // The open conversation says which project it belongs to; choosing another starts a new one.
    await openPicker(page);
    await expect(page.getByText("Choosing another project starts a new conversation.")).toBeVisible();
    // Choosing the project that is open already leaves its conversation alone.
    const open = (await state(page)).task?.id;
    await page.getByTestId(/^environment-project-/).filter({ hasText: "Alpha app" }).click();
    await expect(page.getByTestId("code-project-popover")).toHaveCount(0);
    assert.equal((await state(page)).task?.id, open);
    await openPicker(page);
    await page.getByTestId(/^environment-project-/).filter({ hasText: "beta" }).click();
    await expect(picker(page)).toContainText("beta");
    assert.equal((await state(page)).task, null);
    await send("Run in beta");
    assert.equal((await state(page)).task?.root, w.beta);
    const calls = gateway.completions.map((completion) => JSON.stringify(completion.body.messages));
    assert.ok(calls.some((call) => call.includes("Run in alpha")) && calls.some((call) => call.includes("Run in beta")));

    // Worktree: on for a Git project (the first time), off and explained for a folder that is not one.
    await openPicker(page);
    await page.getByTestId(/^environment-project-/).filter({ hasText: "repo" }).click();
    await expect(picker(page)).toContainText("repo");
    await selectCodeMode(page, "agent");
    const box = page.getByTestId("worktree-checkbox");
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await box.uncheck();
    await openPicker(page);
    await page.getByTestId(/^environment-project-/).filter({ hasText: "Alpha app" }).click();
    await expect(picker(page)).toContainText("Alpha app");
    // Alpha app was last used in Read only, and a project starts with the mode it last had.
    await expect(page.getByTestId("permission-picker")).toHaveAttribute("data-mode", "read_only");
    await selectCodeMode(page, "agent");
    await expect(page.getByTestId("worktree-checkbox")).toBeDisabled();
    await expect(page.getByTestId("worktree-checkbox")).not.toBeChecked();
    await expect(page.getByTestId("worktree-toggle").locator("label")).toHaveAttribute("title", /needs a Git repository/);
    await openPicker(page);
    await page.getByTestId(/^environment-project-/).filter({ hasText: "repo" }).click();
    await expect(box).not.toBeChecked();
    await expect(box).toBeEnabled();
    await selectCodeMode(page, "ask");
    await expect(box).toBeDisabled();
    await expect(page.getByTestId("worktree-toggle").locator("label")).toHaveAttribute("title", /Read only does not change files/);

    // Removing a project removes the entry and nothing else.
    await selectCodeMode(page, "agent");
    await openPicker(page);
    await page.getByTestId(`project-settings-${(await state(page)).codeProjects!.items.find((item) => item.name === "beta")!.id}`).click();
    await page.getByTestId("project-remove").click();
    await expect(page.getByTestId("project-remove-confirm")).toContainText("The folder and its files are not deleted.");
    await page.getByTestId("project-remove-accept").click();
    await expect(page.getByTestId("project-settings")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(2);
    assert.equal(existsSync(w.beta), true);
    await page.keyboard.press("Escape");

    // The register is kept per account on this computer: after a restart the projects and their order are back.
    await app.close();
    app = await launchNativeFixture(descriptor);
    const again = await app.firstWindow();
    await again.getByRole("button", { name: "Code", exact: true }).click();
    await openPicker(again);
    assert.deepEqual((await state(again)).codeProjects!.items.map((item) => item.name), ["repo", "Alpha app"]);
    await expect(rows(again)).toHaveCount(2);
    await expect(again.getByTestId("environment-project-" + (await state(again)).codeProjects!.items.find((item) => item.name === "Alpha app")!.id)).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await gateway.stop();
    await removeNativeFixtureDirectory(w.directory);
  }
});

test("a new folder is made inside the chosen parent with git init, and an earlier folder of this account's history becomes a project once", {
  timeout: 120_000, skip: !hasGit && "needs git",
}, async () => {
  const w = await workspace("tomverse-code-projects-new-");
  const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
  let app: ElectronApplication | undefined;
  try {
    // A folder this account opened before projects existed: its history sits in the account's namespace for that folder.
    const connection = { endpoint: gateway.base, key: TEST_KEY };
    const scope = codeHistoryScope(w.profile, null, bindProjectRoot(w.beta), connection);
    Journal.create(scope.home, {
      workspace: { root: w.beta }, endpointOrigin: new URL(gateway.base).origin, keyPrefix: TEST_KEY.slice(0, 12), readOnly: true,
      model: { requested: "m", pinned: "m", pinnedFrom: "user", contextWindowTokens: 1000, maxOutputTokens: 100 },
      limits: { maxRequests: 5, timeoutMs: 60_000, commandTimeoutMs: 60_000 },
    });
    const descriptor = join(w.directory, "fixture.json");
    await writeFile(descriptor, JSON.stringify({ root: w.alpha, profile: w.profile, endpoint: gateway.base, key: TEST_KEY, projectParent: w.parent }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect.poll(async () => (await state(page)).codeProjects?.items.map((item) => item.folder)).toEqual([w.beta]);

    await page.getByTestId("create-project-welcome").click();
    await page.getByTestId("project-new-folder").click();
    await expect(page.getByTestId("project-new-form")).toContainText("You pick the parent folder next.");
    await page.getByTestId("project-new-name").fill("a/b");
    await page.getByTestId("project-new-submit").click();
    await expect(page.getByTestId("project-message")).toContainText("plain folder name");
    assert.equal(existsSync(join(w.parent, "a")), false);
    await page.getByTestId("project-new-name").fill("fresh app");
    await expect(page.getByTestId("project-new-git")).toBeChecked();
    await page.getByTestId("project-new-submit").click();
    await expect(picker(page)).toContainText("fresh app");
    assert.equal((await state(page)).root, join(w.parent, "fresh app"));
    assert.equal(existsSync(join(w.parent, "fresh app", ".git")), true);
    assert.equal(git(join(w.parent, "fresh app"), "rev-parse", "--is-inside-work-tree"), "true");

    // The same name again, and no git init when it is turned off.
    await page.locator(".open-folder").click();
    await page.getByTestId("project-new-folder").click();
    await page.getByTestId("project-new-name").fill("fresh app");
    await page.getByTestId("project-new-submit").click();
    await expect(page.getByTestId("project-message")).toContainText("already exists");
    await page.getByTestId("project-new-name").fill("plain");
    await page.getByTestId("project-new-git").uncheck();
    await page.getByTestId("project-new-submit").click();
    await expect(picker(page)).toContainText("plain");
    assert.equal(existsSync(join(w.parent, "plain", ".git")), false);
    await expect(page.getByTestId("worktree-checkbox")).toBeDisabled();

    // The list: the moved folder, and the two new ones. A project removed from the list stays out after a restart.
    await openPicker(page);
    await expect(rows(page)).toHaveCount(3);
    const betaId = (await state(page)).codeProjects!.items.find((item) => item.folder === w.beta)!.id;
    await page.getByTestId(`project-settings-${betaId}`).click();
    await page.getByTestId("project-remove").click();
    await page.getByTestId("project-remove-accept").click();
    await expect(rows(page)).toHaveCount(2);
    await app.close();
    app = await launchNativeFixture(descriptor);
    const again = await app.firstWindow();
    await again.getByRole("button", { name: "Code", exact: true }).click();
    await expect.poll(async () => (await state(again)).codeProjects?.items.map((item) => basename(item.folder)).sort()).toEqual(["fresh app", "plain"]);
    assert.match(await readFile(join(w.profile, "language.txt"), "utf8"), /en/);
  } finally {
    await app?.close().catch(() => undefined);
    await gateway.stop();
    await removeNativeFixtureDirectory(w.directory);
  }
});
