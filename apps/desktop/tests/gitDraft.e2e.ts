import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway";
import { launchNativeFixture } from "./launch-native-fixture";

const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const available = (() => {
  try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; }
})();

test("the Git panel drafts a commit message and a pull request with a model after the person agrees, and commits and pushes nothing", { timeout: 120_000, skip: !available }, async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "tomverse-git-draft-")));
  const root = join(folder, "repo");
  const profile = join(folder, "profile");
  const descriptor = join(folder, "fixture.json");
  const gateway = await new FakeGateway({
    script(body) {
      const text = JSON.stringify(body.messages);
      if (text.includes("title and description of a pull request")) return { text: '```json\n{"title":"Add the feature file","body":"Adds feature.txt.\\n\\n- the list filter"}\n```' };
      if (text.includes("commit message for the changes")) return { text: '{"message":"Add feature file\\n\\nIt holds the feature notes."}' };
      return { text: "Unexpected request" };
    },
  }).start();
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(root, { recursive: true }), mkdir(profile, { recursive: true })]);
    git(root, "init", "-b", "main");
    await writeFile(join(root, "a.txt"), "a\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "initial");
    git(root, "switch", "-c", "feature");
    await writeFile(join(root, "committed.txt"), "already on the branch\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "branch work");
    await writeFile(join(root, "feature.txt"), "feature notes\n");
    await writeFile(join(root, "unselected.txt"), "not part of the commit\n");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: gateway.base, key: TEST_KEY }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open local folder" }).click();
    await page.getByRole("button", { name: "Git and pull request", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Git", exact: true });
    await expect(panel.getByRole("checkbox", { name: "feature.txt" })).toBeChecked();
    await panel.getByRole("checkbox", { name: "unselected.txt" }).uncheck();

    // The note says what a draft costs before anything is clicked.
    const note = panel.getByTestId("git-draft");
    await expect(note).toContainText("1 model request, charged in credits like a normal Code task");
    await expect(note).toContainText("commits and pushes nothing");
    await panel.getByLabel("Model for drafts").selectOption("fake-coder");

    // Declining the native question sends nothing to any model.
    await app.evaluate(({ dialog }) => {
      (globalThis as { __asked?: number }).__asked = 0;
      dialog.showMessageBox = async () => { (globalThis as { __asked?: number }).__asked! += 1; return { response: 0, checkboxChecked: false }; };
    });
    const commitDraft = panel.getByRole("button", { name: "Draft with model" });
    await commitDraft.click();
    await expect.poll(() => app!.evaluate(() => (globalThis as { __asked?: number }).__asked)).toBe(1);
    await expect(commitDraft).toBeEnabled();
    assert.equal(await panel.getByRole("textbox", { name: "Commit message" }).inputValue(), "");
    assert.equal(gateway.completions.length, 0, "declined: no model request");

    // Agreeing makes one request with the selected file only; the text lands in the box the person edits.
    await app.evaluate(({ dialog }) => {
      (globalThis as { __draftDialog?: { message: string; detail: string } }).__draftDialog = undefined;
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as { message: string; detail: string };
        (globalThis as { __draftDialog?: { message: string; detail: string } }).__draftDialog = { message: options.message, detail: options.detail };
        return { response: 1, checkboxChecked: false };
      };
    });
    await commitDraft.click();
    const message = panel.getByRole("textbox", { name: "Commit message" });
    await expect(message).toHaveValue("Add feature file\n\nIt holds the feature notes.");
    await expect(panel.getByText("Draft added. Read and edit it before you use it.")).toBeVisible();
    const asked = await app.evaluate(() => (globalThis as { __draftDialog?: { message: string; detail: string } }).__draftDialog);
    assert.match(asked?.detail ?? "", /1 model request, charged in credits/);
    assert.equal(gateway.completions.length, 1);
    const first = gateway.completions[0]!.body;
    assert.equal(first.model, "fake-coder");
    assert.match(JSON.stringify(first.messages), /feature notes/);
    assert.doesNotMatch(JSON.stringify(first.messages), /not part of the commit/, "a file that was not selected is not sent");
    assert.deepEqual((first.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name).filter((name: string) => !["list_files", "search_text", "read_file"].includes(name)), []);
    assert.equal(git(root, "log", "-1", "--format=%s"), "branch work", "nothing was committed");

    // A pull request draft fills the title and the body.
    await panel.getByRole("checkbox", { name: "Also open a pull request" }).check();
    await panel.getByLabel("Target branch").fill("main");
    await panel.getByRole("button", { name: "Draft with model" }).nth(1).click();
    await expect(panel.getByLabel("Pull request title")).toHaveValue("Add the feature file");
    await expect(panel.getByLabel("Pull request description")).toHaveValue("Adds feature.txt.\n\n- the list filter");
    assert.equal(gateway.completions.length, 2);
    assert.match(JSON.stringify(gateway.completions[1]!.body.messages), /committed\.txt/, "the branch's own changes are described");
    assert.equal(git(root, "branch", "--show-current"), "feature");
    assert.equal(git(root, "remote").length, 0, "nothing was pushed: there is no remote at all");
  } finally {
    await app?.close();
    await gateway.stop();
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});
