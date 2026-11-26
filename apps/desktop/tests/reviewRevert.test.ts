import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace, createSession, resolveLimits, undoChange, type CatalogModel } from "../../tomverse-cli/src/runtime";
import { planPatch } from "../../tomverse-cli/src/patch";
import { applyPlannedPatch, type ToolContext } from "../../tomverse-cli/src/tools";
import { journalChanges } from "../src/host/journal-view";
import { diffTexts } from "../src/host/review-diff";
import { lastTurnFiles, revertHunkInJournal } from "../src/host/review-revert";

const model: CatalogModel = { id: "m", name: "M", provider: "p", tools: true, vision: false, reasoning: false, protocols: ["chat_completions"],
  contextWindowTokens: 100_000, maxOutputTokens: 4_000, creditsPerRequest: 1 };
const rows = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function setup(t: test.TestContext) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "tomverse-review-revert-")));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
  const root = join(temp, "project");
  mkdirSync(root);
  const workspace = new Workspace(root, [join(temp, "profile")]);
  const journal = createSession(join(temp, "home"), {
    root, endpoint: { base: "http://127.0.0.1:1/api/code/v1", origin: "http://127.0.0.1:1", basePath: "/api/code/v1" } as never,
    keyPrefix: "tvk_testkey00", model, readOnly: false, limits: resolveLimits("standard"), codeMode: "agent",
  });
  t.after(() => journal.release());
  journal.state.checkpoints = [{ kind: "prompt", task: 0, messageIndex: 0, changeStart: 0, toolStart: 0, at: new Date().toISOString(), text: "Do it" }];
  const context: ToolContext = {
    readByteLimit: 0, workspace, journal, commandTimeoutMs: 0, commandEnv: [], signal: () => new AbortController().signal,
    onActivity: () => undefined, onCommandOutput: () => undefined,
  };
  /** An edit as the agent makes it: planned from the file, recorded in the journal, then written. */
  const agentEdit = (edit: Parameters<typeof planPatch>[1][number]) => {
    const result = applyPlannedPatch(context, `call-${journal.state.changes.length}`, planPatch(workspace, [edit]));
    assert.equal(result.status, "ok");
  };
  return { root, workspace, journal, agentEdit };
}

test("the last turn is what the agent's writes changed, read against the files as they are now", (t) => {
  const { root, workspace, journal, agentEdit } = setup(t);
  writeFileSync(join(root, "a.txt"), rows(30));
  agentEdit({ path: "a.txt", action: "update", replacements: [{ old: "line 4\n", new: "line four\n" }] });
  agentEdit({ path: "a.txt", action: "update", replacements: [{ old: "line 20\n", new: "line twenty\n" }] });
  agentEdit({ path: "made.txt", action: "create", content: "new\n" });
  agentEdit({ path: "a.txt", action: "update", replacements: [{ old: "line four\n", new: "line four\nextra\n" }] });
  const files = lastTurnFiles(journal, workspace)!;
  assert.deepEqual(files.map((file) => [file.path, file.status, file.hunks.length]), [["a.txt", "modified", 2], ["made.txt", "added", 1]]);
  assert.deepEqual([files[0]!.added, files[0]!.removed], [3, 2]);
  // A turn that has not started yet, and an older session that kept no turn marks, have nothing to show.
  journal.state.checkpoints!.push({ kind: "follow_up", task: 0, messageIndex: 3, changeStart: journal.state.changes.length, toolStart: 0, at: "", text: "next" });
  assert.deepEqual(lastTurnFiles(journal, workspace), []);
  journal.state.checkpoints = undefined;
  assert.equal(lastTurnFiles(journal, workspace), null);
});

test("a hunk goes back through the journal, shows as a change of the task, and the existing undo puts it again", (t) => {
  const { root, workspace, journal, agentEdit } = setup(t);
  writeFileSync(join(root, "a.txt"), rows(30));
  agentEdit({ path: "a.txt", action: "update", replacements: [{ old: "line 4\n", new: "line four\n" }, { old: "line 25\n", new: "line twenty-five\n" }] });
  const agentText = readFileSync(join(root, "a.txt"), "utf8");
  const file = lastTurnFiles(journal, workspace)![0]!;
  assert.equal(file.hunks.length, 2);
  assert.equal(revertHunkInJournal(journal, workspace, { path: "a.txt", status: "modified", hunk: file.hunks[1]! }, () => undefined), "reverted");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), agentText.replace("line twenty-five", "line 25"));
  const recorded = journal.state.changes.at(-1)!;
  assert.deepEqual([journal.state.changes.length, recorded.kind, recorded.state, recorded.path], [2, "update", "applied", "a.txt"]);
  assert.ok(recorded.preimage.backup && recorded.directory && recorded.postimage.identity, "kept for a verified undo");
  assert.equal(journalChanges(journal.state).at(-1)!.current, "applied");
  // The same hunk is not in the file any more.
  assert.equal(revertHunkInJournal(journal, workspace, { path: "a.txt", status: "modified", hunk: file.hunks[1]! }, () => undefined), "stale");
  assert.equal(journal.state.changes.length, 2);
  // Undo with the same call the Changes list uses.
  undoChange(journal, recorded.changeId, undefined, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), agentText);
  assert.equal(journal.state.changes.at(-1)!.state, "undone");
});

test("a hunk is never forced over a file that changed since the diff, and nothing is recorded for the refusal", (t) => {
  const { root, workspace, journal, agentEdit } = setup(t);
  writeFileSync(join(root, "a.txt"), rows(10));
  agentEdit({ path: "a.txt", action: "update", replacements: [{ old: "line 5\n", new: "line five\n" }] });
  const hunk = lastTurnFiles(journal, workspace)![0]!.hunks[0]!;
  const edited = readFileSync(join(root, "a.txt"), "utf8").replace("line five", "line 5, edited by the person");
  writeFileSync(join(root, "a.txt"), edited);
  assert.equal(revertHunkInJournal(journal, workspace, { path: "a.txt", status: "modified", hunk }, () => undefined), "stale");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), edited);
  assert.equal(journal.state.changes.length, 1);
  // A binary file, a missing file and a credential file are refused too.
  writeFileSync(join(root, "a.txt"), Buffer.from([0, 1, 2]));
  assert.equal(revertHunkInJournal(journal, workspace, { path: "a.txt", status: "modified", hunk }, () => undefined), "unsupported");
  rmSync(join(root, "a.txt"));
  assert.equal(revertHunkInJournal(journal, workspace, { path: "a.txt", status: "modified", hunk }, () => undefined), "stale");
  assert.throws(() => revertHunkInJournal(journal, workspace, { path: ".env", status: "modified", hunk }, () => undefined));
  // The check the host makes before every write is made again, and stops it.
  writeFileSync(join(root, "a.txt"), edited.replace("line 5, edited by the person", "line five"));
  assert.throws(() => revertHunkInJournal(journal, workspace, { path: "a.txt", status: "modified", hunk }, () => { throw new Error("The project folder changed."); }), /project folder changed/);
  assert.equal(journal.state.changes.length, 1);
});

test("a new file goes back by deleting it and a deleted file by writing it again, and both can be undone", (t) => {
  const { root, workspace, journal, agentEdit } = setup(t);
  writeFileSync(join(root, "old.txt"), rows(3));
  agentEdit({ path: "fresh.txt", action: "create", content: "one\ntwo\n" });
  agentEdit({ path: "old.txt", action: "delete" });
  const [fresh, old] = lastTurnFiles(journal, workspace)!;
  assert.deepEqual([fresh!.path, fresh!.status, old!.path, old!.status], ["fresh.txt", "added", "old.txt", "deleted"]);
  assert.equal(revertHunkInJournal(journal, workspace, { path: "fresh.txt", status: "added", hunk: fresh!.hunks[0]! }, () => undefined), "reverted");
  assert.equal(existsSync(join(root, "fresh.txt")), false);
  assert.equal(journal.state.changes.at(-1)!.kind, "delete");
  assert.equal(revertHunkInJournal(journal, workspace, { path: "old.txt", status: "deleted", hunk: old!.hunks[0]! }, () => undefined), "reverted");
  assert.equal(readFileSync(join(root, "old.txt"), "utf8"), rows(3));
  assert.equal(journal.state.changes.at(-1)!.kind, "create");
  undoChange(journal, journal.state.changes.at(-1)!.changeId, undefined, true);
  assert.equal(existsSync(join(root, "old.txt")), false);
  undoChange(journal, journal.state.changes.at(-2)!.changeId, undefined, true);
  assert.equal(readFileSync(join(root, "fresh.txt"), "utf8"), "one\ntwo\n");
  // A file that came back by itself is not written over.
  writeFileSync(join(root, "old.txt"), "someone else\n");
  assert.equal(revertHunkInJournal(journal, workspace, { path: "old.txt", status: "deleted", hunk: diffTexts("old.txt", rows(3), null).hunks[0]! }, () => undefined), "stale");
});
