import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const rows = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("the review panel switches scope, turns line comments into the next instruction, takes a hunk back, and shows other models' findings", { timeout: 150_000, skip: !available }, async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "tomverse-review-panel-")));
  const root = join(folder, "repo");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const reviewerFinding = { summary: "One real problem.", findings: [
    { file: "src/app.ts", line: 3, severity: "high", description: "Renaming line 3 breaks the caller that expects the old text.", suggestion: "Keep the old text." },
    { file: "notes.txt", line: 40, severity: "low", description: "A finding on a line the diff does not show." },
  ] };
  const gateway = await new FakeGateway({
    script(body) {
      if (JSON.stringify(body.messages).includes("independent code reviewer")) return { text: JSON.stringify(reviewerFinding) };
      if (fixtureNeedsWorkPlan(body)) return fixtureInitialWorkPlan;
      if (fixtureOperationResults(body).length === 0) {
        return { toolCalls: [{ name: "apply_patch", args: { edits: [
          { path: "src/app.ts", action: "update", replacements: [{ old: "line 3\n", new: "line three\n" }, { old: "line 27\n", new: "line twenty-seven\n" }] },
          { path: "notes.txt", action: "create", content: "agent notes\n" },
        ] } }] };
      }
      return { text: "Review edit complete." };
    },
  }).start();
  let application: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(profile, { recursive: true })]);
    git(root, "init", "-b", "main");
    await writeFile(join(root, "src", "app.ts"), rows(30));
    await writeFile(join(root, "README.md"), "readme\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "baseline");
    git(root, "switch", "-c", "feature");
    await writeFile(join(root, "feature.txt"), "committed on the branch\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "feature work");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));

    application = await launchNativeFixture(descriptor);
    const page: Page = await application.firstWindow();
    const editor = () => page.getByRole("textbox", { name: "Code request", exact: true });
    const task = () => page.evaluate(() => window.desktop.state().then((state) => state.task));
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.locator('summary[aria-label="Code workspace"]').click();
    await page.getByRole("combobox", { name: "Code workspace" }).selectOption("local");
    await page.locator('summary[aria-label="Code workspace"]').click();
    await editor().fill("Rename two lines and add notes");
    const approval = application.waitForEvent("window", { timeout: 15_000 });
    void approval.catch(() => undefined);
    await page.getByRole("button", { name: "Send Code request", exact: true }).click();
    await decideNativePatch(await approval);
    await expect(page.getByText("Review edit complete.", { exact: true })).toBeVisible({ timeout: 30_000 });
    // The person edits a file too, after the agent's turn.
    await writeFile(join(root, "README.md"), "readme, changed by the person\n");
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });

    // /review opens the panel instead of being sent to the agent.
    await editor().fill("/review");
    await editor().press("Enter");
    const panel = page.getByTestId("review-panel");
    await expect(panel).toHaveAttribute("open", "");
    const files = page.getByTestId("review-file");
    const paths = () => files.evaluateAll((items) => items.map((item) => item.getAttribute("data-path")));
    await expect.poll(paths).toEqual(["README.md", "notes.txt", "src/app.ts"]);
    await expect(editor()).toHaveValue("");
    assert.equal((await task())?.entries.filter((entry) => entry.role === "user").length, 1, "the command was not sent to the agent");

    // Scope: last turn is the agent's writes only; the branch also has what was committed on it.
    await panel.getByRole("button", { name: "Last turn", exact: true }).click();
    await expect.poll(paths).toEqual(["notes.txt", "src/app.ts"]);
    await panel.getByRole("button", { name: "Branch", exact: true }).click();
    await expect.poll(paths).toEqual(["README.md", "feature.txt", "notes.txt", "src/app.ts"]);
    await expect(panel.getByLabel("Compare with")).toHaveValue("refs/heads/main");
    await panel.getByRole("button", { name: "Uncommitted changes", exact: true }).click();
    await expect.poll(paths).toEqual(["README.md", "notes.txt", "src/app.ts"]);

    // A comment on a line becomes part of the next instruction with its file, line and code.
    const app = page.locator('[data-testid="review-file"][data-path="src/app.ts"]');
    const changedLine = app.getByTestId("review-line").filter({ hasText: "line three" });
    await changedLine.getByRole("button", { name: "Comment on line 3" }).click();
    await panel.getByRole("textbox", { name: "Comment for the agent" }).fill("Why rename this line?");
    await panel.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect(panel.getByTestId("review-comments")).toContainText("src/app.ts:3");
    await panel.getByRole("button", { name: "Add comments to the instruction" }).click();
    const instruction = await editor().inputValue();
    assert.match(instruction, /Review comments on the current changes/);
    assert.match(instruction, /1\. src\/app\.ts:3\n```\nline three\n```\nComment: Why rename this line\?/);
    await expect(panel.getByTestId("review-comments")).toHaveCount(0);
    await editor().fill("");

    // Other models review the diff; their findings sit under the line they are about.
    await panel.getByRole("checkbox", { name: "Fake Coder" }).check();
    await expect(panel.getByText("1 model(s) will each receive this diff", { exact: false })).toBeVisible();
    await panel.getByRole("button", { name: "Run review", exact: true }).click();
    await expect(panel.getByTestId("review-results")).toBeVisible({ timeout: 30_000 });
    const anchored = changedLine.getByTestId("review-finding");
    await expect(anchored).toContainText("Renaming line 3 breaks the caller");
    await expect(anchored).toContainText("Reported by Fake Coder");
    await expect(panel.getByTestId("review-results").getByTestId("review-finding")).toHaveCount(1);
    await expect(panel.getByText("A finding on a line the diff does not show.")).toBeVisible();
    await anchored.getByRole("button", { name: "Ask the agent to fix" }).click();
    assert.match(await editor().inputValue(), /^Fix this review finding \(high, reported by Fake Coder\):\nsrc\/app\.ts:3\nRenaming line 3/);
    await editor().fill("");
    const reviewRequests = gateway.completions.filter((request) => JSON.stringify(request.body.messages).includes("independent code reviewer"));
    assert.equal(reviewRequests.length, 1);
    assert.deepEqual((reviewRequests[0]!.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name).sort(), ["list_files", "read_file", "search_text"]);

    // One hunk goes back; the other stays, and the revert is a change of the task that the usual undo takes back.
    const before = (await task())!.changes.length;
    const hunks = app.getByTestId("review-hunk");
    await expect(hunks).toHaveCount(2);
    await hunks.first().getByRole("button", { name: "Revert hunk" }).click();
    await expect(panel.getByText("The hunk was reverted.", { exact: false })).toBeVisible();
    await expect(hunks).toHaveCount(1);
    const afterRevert = await readFile(join(root, "src", "app.ts"), "utf8");
    assert.equal(afterRevert, rows(30).replace("line 27\n", "line twenty-seven\n"));
    const changes = (await task())!.changes;
    assert.equal(changes.length, before + 1);
    const reverted = changes.at(-1)!;
    assert.equal(reverted.path, "src/app.ts");
    assert.equal((await page.evaluate((id) => window.desktop.readChange(id), reverted.id))?.canUndo, true);
    assert.equal(await page.evaluate((id) => window.desktop.undoChange(id), reverted.id), "undone");
    assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), rows(30).replace("line 3\n", "line three\n").replace("line 27\n", "line twenty-seven\n"));

    // A hunk the file no longer has is refused, and the file keeps what the person wrote.
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(hunks).toHaveCount(2);
    const edited = rows(30).replace("line 3\n", "line three\n").replace("line 27\n", "line 27 edited by hand\n");
    await writeFile(join(root, "src", "app.ts"), edited);
    await hunks.last().getByRole("button", { name: "Revert hunk" }).click();
    await expect(panel.getByText("nothing was reverted", { exact: false })).toBeVisible();
    assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), edited);
    assert.equal((await task())!.changes.length, before + 1, "a refused revert records nothing");
  } finally {
    await application?.close();
    await gateway.stop();
    assert.equal(dirname(folder), await realpath(tmpdir()));
    await removeNativeFixtureDirectory(folder);
  }
});
