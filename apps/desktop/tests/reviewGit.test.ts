import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindProjectRoot } from "../src/host/project-root";
import { readScopeDiff } from "../src/host/review-git";
import { planHunkRevert } from "../src/host/review-diff";

const git = (root: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
const gitAvailable = (() => {
  try { return git(tmpdir(), "--version").startsWith("git version"); } catch { return false; }
})();
const rows = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
/** Removes a test's folder. Windows can hold a folder git just used for a moment; a folder left in the temp directory is not a failed test. */
const discard = (folder: string) => {
  try { rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* left for the OS to clean */ }
};

function makeRepo(t: test.TestContext) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "tomverse-review-git-")));
  t.after(() => discard(temp));
  const root = join(temp, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "src", "a.ts"), rows(30));
  writeFileSync(join(root, "src", "gone.ts"), rows(3));
  writeFileSync(join(root, "README.md"), "readme\n");
  writeFileSync(join(root, ".env"), "TOKEN=one\n");
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return { temp, root };
}

test("the uncommitted scope shows edits, deletions and new files, and keeps credentials and binaries out", { skip: !gitAvailable }, async (t) => {
  const { root } = makeRepo(t);
  writeFileSync(join(root, "src", "a.ts"), rows(30).replace("line 5\n", "line five\n").replace("line 25\n", ""));
  rmSync(join(root, "src", "gone.ts"));
  writeFileSync(join(root, "src", "fresh.ts"), "export const fresh = 1;\n");
  writeFileSync(join(root, ".env"), "TOKEN=two\n");
  writeFileSync(join(root, ".env.local"), "TOKEN=untracked\n");
  writeFileSync(join(root, "blob.bin"), Buffer.from([9, 2, 0, 3]));
  const result = await readScopeDiff(bindProjectRoot(root), "uncommitted");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const byPath = new Map(result.diff.files.map((file) => [file.path, file]));
  assert.deepEqual([...byPath.keys()], [".env", ".env.local", "blob.bin", "src/a.ts", "src/fresh.ts", "src/gone.ts"]);
  assert.deepEqual([byPath.get(".env")!.omitted, byPath.get(".env.local")!.omitted, byPath.get("blob.bin")!.omitted], ["secret", "secret", "binary"]);
  assert.equal(byPath.get(".env")!.hunks.length, 0);
  const edited = byPath.get("src/a.ts")!;
  assert.equal(edited.hunks.length, 2);
  assert.deepEqual([edited.added, edited.removed], [1, 2]);
  assert.equal(byPath.get("src/fresh.ts")!.status, "added");
  assert.equal(byPath.get("src/gone.ts")!.status, "deleted");
  // A hunk as git printed it puts the working file back to what was committed.
  let current = readFileSync(join(root, "src", "a.ts"));
  for (const hunk of [...edited.hunks].reverse()) {
    const plan = planHunkRevert(current, { status: "modified", hunk });
    assert.ok(plan.ok && plan.text !== null);
    current = Buffer.from(plan.text!);
  }
  assert.equal(current.toString(), rows(30));
  assert.equal(result.diff.base, undefined);
});

test("the branch scope compares with where the branch left its base, committed and uncommitted work together", { skip: !gitAvailable }, async (t) => {
  const { root } = makeRepo(t);
  git(root, "switch", "-c", "feature");
  writeFileSync(join(root, "README.md"), "readme\ncommitted on the branch\n");
  git(root, "commit", "-am", "branch work");
  // The base moves on afterwards; the comparison is with the point the branch left it.
  git(root, "switch", "main");
  writeFileSync(join(root, "elsewhere.txt"), "main moved\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "main moved");
  git(root, "switch", "feature");
  writeFileSync(join(root, "src", "a.ts"), rows(30).replace("line 2\n", "line two\n"));
  const project = bindProjectRoot(root);
  const result = await readScopeDiff(project, "branch");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.diff.files.map((file) => file.path), ["README.md", "src/a.ts"]);
  assert.deepEqual(result.diff.base, { ref: "refs/heads/main", label: "main" });
  assert.ok(result.diff.bases?.some((base) => base.label === "feature"));
  // Another branch may be chosen, but only one the repository really has.
  const chosen = await readScopeDiff(project, "branch", { base: "refs/heads/feature" });
  assert.equal(chosen.status === "ok" && chosen.diff.files.map((file) => file.path).join(), "src/a.ts");
  assert.deepEqual(await readScopeDiff(project, "branch", { base: "refs/heads/nope" }), { status: "unavailable", reason: "no-base" });
  // A worktree starts from a commit: that is the base when nothing else is chosen.
  const start = git(root, "rev-parse", "main~1");
  const fromCommit = await readScopeDiff(project, "branch", { worktreeBase: { ref: "refs/heads/main", commit: start } });
  assert.equal(fromCommit.status === "ok" && fromCommit.diff.files.map((file) => file.path).join(), "README.md,src/a.ts");
});

test("a project folder inside the repository sees only its own files, with paths relative to it", { skip: !gitAvailable }, async (t) => {
  const { root } = makeRepo(t);
  writeFileSync(join(root, "src", "a.ts"), rows(30).replace("line 9\n", "line nine\n"));
  writeFileSync(join(root, "README.md"), "changed\n");
  writeFileSync(join(root, "src", "new file.ts"), "x\n");
  const result = await readScopeDiff(bindProjectRoot(join(root, "src")), "uncommitted");
  assert.equal(result.status === "ok" && result.diff.files.map((file) => file.path).join(), "a.ts,new file.ts");
});

test("folders that are not repositories, and repositories with nothing committed, are reported and not guessed at", { skip: !gitAvailable }, async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "tomverse-review-plain-")));
  t.after(() => discard(temp));
  assert.deepEqual(await readScopeDiff(bindProjectRoot(temp), "uncommitted"), { status: "unavailable", reason: "not-git" });
  git(temp, "init", "-b", "main");
  assert.deepEqual(await readScopeDiff(bindProjectRoot(temp), "uncommitted"), { status: "unavailable", reason: "git-unavailable" });
});

test("a diff driver configured in the repository is never run", { skip: !gitAvailable }, async (t) => {
  const { temp, root } = makeRepo(t);
  const marker = join(temp, "ran.txt");
  const program = join(temp, "driver.mjs");
  writeFileSync(program, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`);
  git(root, "config", "diff.external", `node ${program.replaceAll("\\", "/")}`);
  git(root, "config", "diff.driver.textconv", `node ${program.replaceAll("\\", "/")}`);
  writeFileSync(join(root, ".gitattributes"), "*.ts diff=driver\n");
  writeFileSync(join(root, "src", "a.ts"), rows(30).replace("line 3\n", "line three\n"));
  const result = await readScopeDiff(bindProjectRoot(root), "uncommitted");
  assert.equal(result.status, "ok");
  assert.throws(() => readFileSync(marker), /ENOENT/);
});
