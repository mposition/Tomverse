import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Journal } from "../../tomverse-cli/src/runtime.js";
import { nativePatches, verifiedContinuationEdits } from "../src/host/native-patches";
import { bindProjectRoot } from "../src/host/project-root";

async function setup(context: TestContext, approve: Parameters<typeof nativePatches>[0]["approve"]) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-codex-patch-")));
  const root = join(temp, "workspace");
  const directory = join(temp, "profile");
  await Promise.all([mkdir(root), mkdir(directory)]);
  const controller = new AbortController();
  const patch = nativePatches({
    directory, project: bindProjectRoot(root), protectedRoots: [directory], id: Journal.newId(), model: "codex-fixture",
    connectionKey: "tvk_abcdefgh_fixture_key_for_patch_test", signal: controller.signal, approve,
  });
  context.after(async () => { patch.journal.release(); await rm(temp, { recursive: true, force: true }); });
  return { ...patch, root, controller };
}

test("the Codex patch bridge applies only the approved call and refuses a duplicate or stale edit", async (context) => {
  let approvals = 0;
  const { root, tool, journal, controller } = await setup(context, async () => ++approvals === 1);
  const args = { edits: [{ path: "approved.txt", action: "create", content: "Approved contents.\n" }] };
  assert.equal((await tool.invoke("approved", args, controller.signal)).success, true);
  assert.deepEqual(verifiedContinuationEdits(journal), [{ path: "approved.txt", action: "create" }]);
  const binding = journal.state.approvals[0]?.binding.files?.[0];
  assert.ok(binding);
  binding.preimage = "different-preimage";
  assert.throws(() => verifiedContinuationEdits(journal), /does not have a verified outcome/);
  binding.preimage = null;
  assert.equal((await tool.invoke("approved", args, controller.signal)).success, false);
  assert.equal((await tool.invoke("outside", { edits: [{ path: "../out.txt", action: "create", content: "Outside" }] }, controller.signal)).success, false);
  assert.equal((await tool.invoke("declined", { edits: [{ path: "declined.txt", action: "create", content: "Declined" }] }, controller.signal)).success, false);
  assert.equal(approvals, 2);
  assert.equal(journal.state.tools.length, 1);
  assert.equal(await readFile(join(root, "approved.txt"), "utf8"), "Approved contents.\n");
  await assert.rejects(readFile(join(root, "declined.txt")), { code: "ENOENT" });
  await writeFile(join(root, "approved.txt"), "User changed this file.\n");
  assert.throws(() => verifiedContinuationEdits(journal), /changed after it was applied/);
});

test("an outdated preview leaves no pending approval and a fresh preview can be approved", async (context) => {
  let approvals = 0;
  const { root, tool, journal, controller } = await setup(context, async (view) => {
    const approvedPath = view.patch?.[0]?.absolute;
    assert.ok(approvedPath);
    if (++approvals === 1) await writeFile(approvedPath, "Original text.\nChanged by the user.\n");
    return true;
  });
  const file = join(root, "tracked.txt");
  await writeFile(file, "Original text.\n");
  const args = { edits: [{ path: "tracked.txt", action: "update",
    replacements: [{ old: "Original text.", new: "Replacement text." }] }] };
  let delegated = false;
  const result = await tool.invoke("edited-after-preview", args, controller.signal, async () => {
    delegated = true;
    return true;
  });
  assert.equal(result.success, false);
  assert.match(result.text, /changed after the preview/);
  assert.equal(delegated, false);
  assert.equal(await readFile(file, "utf8"), "Original text.\nChanged by the user.\n");
  assert.deepEqual(journal.state.approvals, []);
  assert.deepEqual(verifiedContinuationEdits(journal), []);
  assert.equal((await tool.invoke("fresh-preview", args, controller.signal)).success, true);
  assert.equal(await readFile(file, "utf8"), "Replacement text.\nChanged by the user.\n");
  assert.deepEqual(verifiedContinuationEdits(journal), [{ path: "tracked.txt", action: "update" }]);
});

test("a delegated write is refused when the previewed file was replaced with identical content", async (context) => {
  const { root, tool, journal, controller } = await setup(context, async () => true);
  const file = join(root, "tracked.txt");
  const contents = "Original text.\n";
  await writeFile(file, contents);
  const result = await tool.invoke("delegated-edit", { edits: [{ path: "tracked.txt", action: "update",
    replacements: [{ old: "Original text.", new: "Replacement text." }] }] }, controller.signal, async () => {
    await rename(file, join(root, "original.txt"));
    await writeFile(file, contents);
    return true;
  });
  assert.equal(result.success, false);
  assert.match(result.text, /changed after the preview/);
  assert.equal(await readFile(file, "utf8"), contents);
  assert.deepEqual(journal.state.approvals, []);
  assert.deepEqual(verifiedContinuationEdits(journal), []);
});

test("replacing the approved project folder cancels the edit before it is delegated", async (context) => {
  const { root, tool, journal, controller } = await setup(context, async ({ root: approvedRoot }) => {
    assert.ok(approvedRoot);
    await rename(approvedRoot, join(dirname(approvedRoot), "original-workspace"));
    await mkdir(approvedRoot);
    return true;
  });
  const result = await tool.invoke("moved-workspace", { edits: [{ path: "new.txt", action: "create",
    content: "Do not write to the replaced workspace." }] }, controller.signal, async () => {
    assert.fail("The edit was delegated for a different workspace.");
  });
  assert.equal(result.success, false);
  await assert.rejects(readFile(join(root, "new.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(dirname(root), "original-workspace", "new.txt")), { code: "ENOENT" });
  assert.deepEqual(journal.state.approvals, []);
});
