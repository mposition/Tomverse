import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
}

test("The Git panel commits locally, and a push leaves the app only after the approval window is allowed", { timeout: 120_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "tomverse-git-publish-"));
  const root = join(folder, "project");
  const bare = join(folder, "remote.git");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({ script: () => ({ text: "Done." }) }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root), mkdir(bare), mkdir(profile)]);
    await writeFile(join(profile, "language.txt"), "en");
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(root, "init", "-q", "-b", "main");
    for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"]]) git(root, "config", key!, value!);
    await writeFile(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    git(root, "remote", "add", "origin", bare);
    git(root, "push", "-q", "origin", "main");
    git(root, "remote", "set-head", "origin", "main");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByRole("button", { name: "Git and pull request", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Git", exact: true });
    await expect(panel.getByText("main", { exact: true })).toBeVisible();
    await panel.getByRole("textbox", { name: "New branch name" }).fill("feature");
    await panel.getByRole("button", { name: "Create and switch" }).click();
    await expect(panel.getByText("Switched to feature.")).toBeVisible();
    assert.equal(git(root, "branch", "--show-current"), "feature");

    await writeFile(join(root, "feature.txt"), "feature\n");
    await panel.getByRole("button", { name: "Refresh" }).click();
    await expect(panel.getByRole("checkbox", { name: "feature.txt" })).toBeChecked();
    await panel.getByRole("textbox", { name: "Commit message" }).fill("Add feature file");
    await panel.getByRole("button", { name: "Commit selected files" }).click();
    await expect(panel.getByText(/^Committed /)).toBeVisible();
    assert.equal(git(root, "log", "-1", "--format=%s"), "Add feature file");

    // Denying the card sends nothing.
    const publish = panel.getByRole("button", { name: "Review and push…" });
    const [denied] = await Promise.all([app.waitForEvent("window", { timeout: 15_000 }), publish.click()]);
    await expect(denied.getByTestId("git-approval")).toContainText("Push to a remote");
    await denied.getByRole("button", { name: "Deny", exact: true }).click().catch(() => undefined);
    await expect(panel.getByText("Not approved. Nothing was sent.")).toBeVisible();
    assert.equal(git(bare, "for-each-ref", "refs/heads/feature"), "");

    // Allowing it pushes exactly the commit the card listed.
    const [approval] = await Promise.all([app.waitForEvent("window", { timeout: 15_000 }), publish.click()]);
    const card = approval.getByTestId("git-approval");
    await expect(card).toContainText("Requested by you");
    await expect(card).toContainText("Add feature file");
    await expect(card).toContainText("feature");
    await expect(card).toContainText(bare);
    const head = git(root, "rev-parse", "HEAD");
    await expect(card).toContainText(head);
    await approval.getByRole("button", { name: "Allow once", exact: true }).click().catch(() => undefined);
    await expect(panel.getByText(/^Pushed /)).toBeVisible();
    assert.match(git(bare, "for-each-ref", "--format=%(objectname)", "refs/heads/feature"), new RegExp("^" + head + "$"));
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
