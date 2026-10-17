// Where `npm run build:amux-decision-maker -- --out <directory>` may write,
// stage S2-3b (docs/policy/amux-decision-maker.md §5a), after the independent
// review r-20261017-113433-e16efc (3): the build replaces its output
// directory, so it must never be given one that holds anything it did not
// make. The repository, a home, a filesystem root and their ancestors are
// always refused; elsewhere a non-empty directory is replaced only when this
// build's marker is in it.
//
// The refusals for the repository, the home and the root are checked by the
// judgement alone: a test that built into them would, on a regression, delete
// what it is testing. The deletions are tried only on temporary directories.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DM_RELEASE_MARKER, dmReleaseOutRefusal } from "../scripts/amux-decision-maker-release-out.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const defaultOut = join(repositoryRoot, ".next", "amux-decision-maker");
const options = { repositoryRoot, home: homedir(), defaultOut };
const posix = process.platform !== "win32";

const withTemporary = (body) => {
  const root = mkdtempSync(join(tmpdir(), "amux-dm-release-out-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("review (3): the repository, a home, a filesystem root and any ancestor of them are always refused", () => {
  assert.equal(dmReleaseOutRefusal(repositoryRoot, options), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal(`${repositoryRoot}/`, options), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal(dirname(repositoryRoot), options), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal(parse(repositoryRoot).root, options), "filesystem_root");
  assert.equal(dmReleaseOutRefusal(homedir(), options), "home_or_ancestor");
  if (dirname(homedir()) !== parse(homedir()).root) assert.equal(dmReleaseOutRefusal(dirname(homedir()), options), "home_or_ancestor");
  // Relative paths are judged as the build resolves them, from the repository.
  assert.equal(dmReleaseOutRefusal(".", options), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal("..", options), "repository_or_ancestor");
  // Non-empty directories inside the repository have no marker either.
  assert.equal(dmReleaseOutRefusal("scripts", options), "not_empty_without_marker");
  assert.equal(dmReleaseOutRefusal("lib/amux", options), "not_empty_without_marker");
});

test("review (3): the default output, a missing or empty directory, or one this build made may be used", () =>
  withTemporary((root) => {
    assert.equal(dmReleaseOutRefusal(defaultOut, options), null);
    assert.equal(dmReleaseOutRefusal(join(root, "new"), options), null);
    mkdirSync(join(root, "empty"));
    assert.equal(dmReleaseOutRefusal(join(root, "empty"), options), null);
    mkdirSync(join(root, "made"));
    writeFileSync(join(root, "made", "broker.mjs"), "old");
    assert.equal(dmReleaseOutRefusal(join(root, "made"), options), "not_empty_without_marker");
    writeFileSync(join(root, "made", DM_RELEASE_MARKER), "");
    assert.equal(dmReleaseOutRefusal(join(root, "made"), options), null);
    writeFileSync(join(root, "file"), "x");
    assert.equal(dmReleaseOutRefusal(join(root, "file"), options), "not_a_directory");
  }),
);

test("review (3): a link given as the output is refused, whatever it points at", { skip: !posix }, () =>
  withTemporary((root) => {
    mkdirSync(join(root, "target"));
    symlinkSync(join(root, "target"), join(root, "pointer"));
    assert.equal(dmReleaseOutRefusal(join(root, "pointer"), options), "link");
    // A marker reached through a link does not count.
    mkdirSync(join(root, "marked"));
    symlinkSync(join(root, "target"), join(root, "marked", DM_RELEASE_MARKER));
    writeFileSync(join(root, "marked", "kept.txt"), "x");
    assert.equal(dmReleaseOutRefusal(join(root, "marked"), options), "not_empty_without_marker");
  }),
);

const build = (out) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/build-amux-decision-maker.mjs", "--out", out], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

test("review (3), reproduced: a directory with someone's files is not deleted by the build", () =>
  withTemporary((root) => {
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "keep.txt"), "uncommitted work");
    const run = build(data);
    assert.notEqual(run.status, 0, "the build refuses the directory");
    assert.match(run.stderr, /not_empty_without_marker/);
    assert.equal(readFileSync(join(data, "keep.txt"), "utf8"), "uncommitted work");
  }),
);

test("review (3): the build marks what it made, and replaces only that", () =>
  withTemporary((root) => {
    const out = join(root, "release");
    assert.equal(build(out).status, 0);
    assert.equal(existsSync(join(out, DM_RELEASE_MARKER)), true);
    assert.equal(readFileSync(join(out, "manifest.sha256"), "utf8").includes(DM_RELEASE_MARKER), false, "the marker is not a release file");
    writeFileSync(join(out, "stale.txt"), "from an earlier build");
    const again = build(out);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(existsSync(join(out, "stale.txt")), false);
    assert.equal(existsSync(join(out, "manifest.sha256")), true);
  }),
);
