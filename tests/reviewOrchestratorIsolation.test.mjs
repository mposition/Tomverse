// The reviewer's checkout must carry the base instruction files whatever the
// author did to them: rename them away, replace their directory with a
// symlink, or give them names that are pathspec patterns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, instructionDiff, isolateInstructionFiles } from "../tools/review-orchestrator/lib/git.mjs";
import { buildPrompt } from "../tools/review-orchestrator/lib/prompt.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", input: "" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const write = (root, path, body) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
};
const read = (root, path) => readFileSync(join(root, path), "utf8");

test("rename, symlinked directory and glob-named files all come back as base", () => {
  const root = mkdtempSync(join(tmpdir(), "review-orch-iso-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "develop");
    write(repo, "AGENTS.md", "BASE RULES");
    write(repo, ".claude/agents/r.md", "base agent");
    write(repo, ".cursor/rules/foo[a].md", "base glob");
    write(repo, ".cursor/rules/fooa.md", "base sibling");
    write(repo, "src/x.txt", "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");

    // The author: AGENTS.md renamed away, .claude replaced by a symlink to a
    // directory the author controls, the glob-named file edited, a new
    // nested CLAUDE.md added.
    git(repo, "mv", "AGENTS.md", "notes-old.md");
    git(repo, "rm", "-q", "-r", "--cached", ".claude");
    rmSync(join(repo, ".claude"), { recursive: true, force: true });
    write(repo, "payload/agents/r.md", "PLANTED AGENT");
    const link = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "payload", encoding: "utf8" }).stdout.trim();
    git(repo, "update-index", "--add", "--cacheinfo", `120000,${link},.claude`);
    write(repo, ".cursor/rules/foo[a].md", "PLANTED GLOB");
    write(repo, "src/CLAUDE.md", "PLANTED NESTED");
    git(repo, "add", "payload", ".cursor", "src");
    git(repo, "commit", "-q", "-m", "author");
    const head = git(repo, "rev-parse", "HEAD");

    const worktree = join(root, "wt");
    git(repo, "worktree", "add", "--detach", "-q", worktree, head);
    isolateInstructionFiles(worktree, base, head);

    assert.equal(read(worktree, "AGENTS.md"), "BASE RULES");
    assert.equal(lstatSync(join(worktree, ".claude")).isDirectory(), true, ".claude must be a real directory");
    assert.equal(read(worktree, ".claude/agents/r.md"), "base agent");
    assert.equal(read(worktree, ".cursor/rules/foo[a].md"), "base glob");
    assert.equal(read(worktree, ".cursor/rules/fooa.md"), "base sibling");
    assert.equal(existsSync(join(worktree, "src/CLAUDE.md")), false);
    // Non-instruction content is the author's, untouched.
    assert.equal(read(worktree, "notes-old.md"), "BASE RULES");
    assert.equal(read(worktree, "payload/agents/r.md"), "PLANTED AGENT");

    // The rename source is listed, and every instruction change is in the
    // instruction diff the prompt shows first and whole.
    const files = changedFiles(repo, base, head);
    assert.ok(files.includes("AGENTS.md"), "rename source must be listed");
    const instructions = instructionDiff(repo, base, head, files);
    assert.deepEqual(
      [...instructions.paths].sort(),
      [".claude", ".claude/agents/r.md", ".cursor/rules/foo[a].md", "AGENTS.md", "src/CLAUDE.md"],
    );
    assert.match(instructions.text, /PLANTED GLOB/);
    assert.match(instructions.text, /PLANTED NESTED/);
    const prompt = buildPrompt({
      job: { repo: "demo", base, head, scope: "" },
      files,
      instructions,
      diff: "x".repeat(500),
      maxDiffBytes: Buffer.byteLength(instructions.text) + 100,
    });
    assert.match(prompt, /edits 5 of them/);
    assert.ok(prompt.indexOf("PLANTED GLOB") < prompt.indexOf("<<<DIFF"), "instruction diff comes first");
    assert.match(prompt, /truncated at 100 bytes of 500/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
