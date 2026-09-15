import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The promotion workflow's own refusal, run against a real git repository
 * (scripts/feedback-autofix-promotion-manifest.mjs). What must hold:
 *   - a clean cherry-pick of the approved change onto a main that still has
 *     the approved base passes both checks;
 *   - a main whose copy of a changed file drifted is refused before anything
 *     is built;
 *   - the same edit applied at another place in the file -- identical added
 *     and removed lines -- is refused as a different change;
 *   - an extra file on the branch is refused.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "feedback-autofix-promotion-manifest.mjs");
const TSX_LOADER = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

const TWO_BLOCKS = "const a = false;\nconst sep = 1;\nconst a2 = false;\n";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "autofix-manifest-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  const write = (path: string, content: string) => writeFileSync(join(dir, path), content);
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, write, commit };
};

const blob = (r: ReturnType<typeof repo>, ref: string, path: string) =>
  r.git("rev-parse", `${ref}:${path}`);

const run = (cwd: string, ...args: string[]) =>
  // tsx resolved from this repository: the child runs inside a scratch repo
  // that has no node_modules of its own.
  spawnSync(process.execPath, ["--import", TSX_LOADER, SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  });

/** A repo where develop fixes the first block of fix.ts and adds a test. */
const scenario = () => {
  const r = repo();
  r.write("fix.ts", TWO_BLOCKS);
  const base = r.commit("base");
  r.git("checkout", "-q", "-b", "develop");
  r.write("fix.ts", TWO_BLOCKS.replace("const a = false;", "const a = true;"));
  r.write("fix.test.ts", "test();\n");
  const head = r.commit("fix");
  const manifest = [
    { path: "fix.test.ts", baseBlob: null, headBlob: blob(r, head, "fix.test.ts") },
    { path: "fix.ts", baseBlob: blob(r, base, "fix.ts"), headBlob: blob(r, head, "fix.ts") },
  ];
  const manifestPath = join(r.dir, "..", `${r.dir.split(/[\\/]/).pop()}-manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  r.git("checkout", "-q", "main");
  return { r, head, manifestPath };
};

test("a clean cherry-pick onto an unchanged main passes both checks", () => {
  const { r, head, manifestPath } = scenario();
  try {
    assert.equal(run(r.dir, "check-main", manifestPath, "main").status, 0);
    r.git("checkout", "-q", "-b", "promotion", "main");
    r.git("-c", "user.name=t", "-c", "user.email=t@example.com", "cherry-pick", head);
    const result = run(r.dir, "check-branch", manifestPath, "main", "HEAD");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
  }
});

test("a main whose copy of a changed file drifted is refused", () => {
  const { r, manifestPath } = scenario();
  try {
    r.write("fix.ts", `${TWO_BLOCKS}// hotfix on main\n`);
    r.commit("main drift");
    const result = run(r.dir, "check-main", manifestPath, "main");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /differs from the approved base at fix\.ts/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
  }
});

test("the same edit at another place in the file is refused", () => {
  const { r, manifestPath } = scenario();
  try {
    r.git("checkout", "-q", "-b", "promotion", "main");
    // Same added and removed lines, second block instead of the first.
    r.write("fix.ts", TWO_BLOCKS.replace("const a2 = false;", "const a2 = true;"));
    r.write("fix.test.ts", "test();\n");
    r.commit("elsewhere");
    const result = run(r.dir, "check-branch", manifestPath, "main", "HEAD");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /contents differ/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
  }
});

test("an extra file on the promotion branch is refused", () => {
  const { r, head, manifestPath } = scenario();
  try {
    r.git("checkout", "-q", "-b", "promotion", "main");
    r.git("-c", "user.name=t", "-c", "user.email=t@example.com", "cherry-pick", head);
    r.write("extra.ts", "export {};\n");
    r.commit("extra");
    const result = run(r.dir, "check-branch", manifestPath, "main", "HEAD");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /set of changed files/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
  }
});
