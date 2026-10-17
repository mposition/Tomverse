// Where `npm run build:amux-decision-maker -- --out <directory>` may write,
// stage S2-3b (docs/policy/amux-decision-maker.md §5a), after the independent
// reviews r-20261017-113433-e16efc (3) and r-20261017-114940-a271fb: the
// build refreshes its output directory, so it is never given one that holds
// anything it did not make, nor one reached through a link.
//
//   - a filesystem root, the repository, a home and their ancestors: refused;
//   - a link anywhere on the way (the path itself or any existing ancestor),
//     or a real path that is not the path as written: refused, the default
//     output included;
//   - a missing or empty directory: used;
//   - a non-empty directory: used only with this build's marker and nothing
//     but the release's own files in it, which are then unlinked one by one.
//
// Each test lays out a repository of its own in a temporary directory, so the
// judgement is tried on a `.next` that is a link without touching the real
// one. The refusals for the real repository, home and root are checked by the
// judgement alone: a test that built into them would, on a regression, delete
// what it is testing. Links are directory junctions on Windows, which need no
// privilege; Node reports both as links.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DM_RELEASE_MARKER,
  DM_RELEASE_TOP_FILES,
  DM_RELEASE_UNIT_FILES,
  dmPrepareReleaseOut,
  dmReleaseOutRefusal,
} from "../scripts/amux-decision-maker-release-out.mjs";

const realRepository = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const realOptions = { repositoryRoot: realRepository, home: homedir(), defaultOut: join(realRepository, ".next", "amux-decision-maker") };

const linkDirectory = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

/** A repository of its own, an outside directory, and the options the build would use for that repository. */
const withLayout = (body) => {
  const root = mkdtempSync(join(tmpdir(), "amux-dm-release-out-"));
  try {
    const repository = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repository);
    mkdirSync(outside);
    const options = { repositoryRoot: repository, home: homedir(), defaultOut: join(repository, ".next", "amux-decision-maker") };
    return body({ root, repository, outside, options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** A directory the build made: the marker and every release file. */
const makeRelease = (path) => {
  mkdirSync(join(path, "systemd"), { recursive: true });
  writeFileSync(join(path, DM_RELEASE_MARKER), "");
  for (const name of DM_RELEASE_TOP_FILES) writeFileSync(join(path, name), "old");
  for (const unit of DM_RELEASE_UNIT_FILES) writeFileSync(join(path, "systemd", unit), "old");
};

// ---------------------------------------------------------------------------
// r-20261017-114940-a271fb: links on the way
// ---------------------------------------------------------------------------

test("re-review, reproduced: a .next that is a link makes even the default output refused, and the data behind it stays", () =>
  withLayout(({ repository, outside, options }) => {
    mkdirSync(join(outside, "amux-decision-maker"));
    writeFileSync(join(outside, "amux-decision-maker", "data.txt"), "someone else's");
    linkDirectory(outside, join(repository, ".next"));
    assert.equal(dmReleaseOutRefusal(options.defaultOut, options), "link");
    assert.throws(() => dmPrepareReleaseOut(options.defaultOut, options), /link/);
    assert.equal(readFileSync(join(outside, "amux-decision-maker", "data.txt"), "utf8"), "someone else's");
  }),
);

test("re-review: a link anywhere on the way is refused even when what it reaches is a marked release", () =>
  withLayout(({ root, outside, options }) => {
    makeRelease(join(outside, "release"));
    writeFileSync(join(outside, "release", "broker.mjs"), "keep me");
    linkDirectory(outside, join(root, "via"));
    for (const out of [join(root, "via", "release"), join(root, "via", "new", "deeper"), join(root, "via")]) {
      assert.equal(dmReleaseOutRefusal(out, options), "link", out);
      assert.throws(() => dmPrepareReleaseOut(out, options), /link/, out);
    }
    assert.equal(readFileSync(join(outside, "release", "broker.mjs"), "utf8"), "keep me");
    assert.equal(existsSync(join(outside, "new")), false, "nothing was made behind the link");
  }),
);

const build = (out) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/build-amux-decision-maker.mjs", "--out", out], {
    cwd: realRepository,
    encoding: "utf8",
  });

test("re-review, reproduced through the build: an output reached through a link is refused and nothing behind it is deleted", () =>
  withLayout(({ root, outside }) => {
    makeRelease(join(outside, "release"));
    writeFileSync(join(outside, "release", "launcher.mjs"), "keep me");
    linkDirectory(outside, join(root, "via"));
    const run = build(join(root, "via", "release"));
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /link/);
    assert.equal(readFileSync(join(outside, "release", "launcher.mjs"), "utf8"), "keep me");
  }),
);

// ---------------------------------------------------------------------------
// r-20261017-113433-e16efc (3): what may be replaced
// ---------------------------------------------------------------------------

test("review (3): the repository, a home, a filesystem root and any ancestor of them are always refused", () => {
  assert.equal(dmReleaseOutRefusal(realRepository, realOptions), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal(`${realRepository}/`, realOptions), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal(dirname(realRepository), realOptions), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal(parse(realRepository).root, realOptions), "filesystem_root");
  assert.equal(dmReleaseOutRefusal(homedir(), realOptions), "home_or_ancestor");
  if (dirname(homedir()) !== parse(homedir()).root) assert.equal(dmReleaseOutRefusal(dirname(homedir()), realOptions), "home_or_ancestor");
  // Relative paths are judged as the build resolves them, from the repository.
  assert.equal(dmReleaseOutRefusal(".", realOptions), "repository_or_ancestor");
  assert.equal(dmReleaseOutRefusal("..", realOptions), "repository_or_ancestor");
  // Non-empty directories inside the repository have no marker.
  assert.equal(dmReleaseOutRefusal("scripts", realOptions), "not_empty_without_marker");
  assert.equal(dmReleaseOutRefusal("lib/amux", realOptions), "not_empty_without_marker");
});

test("review (3): a missing or empty directory is used, the default output too", () =>
  withLayout(({ root, options }) => {
    assert.equal(dmReleaseOutRefusal(options.defaultOut, options), null);
    assert.equal(dmReleaseOutRefusal(join(root, "new"), options), null);
    mkdirSync(join(root, "empty"));
    assert.equal(dmReleaseOutRefusal(join(root, "empty"), options), null);
    writeFileSync(join(root, "file"), "x");
    assert.equal(dmReleaseOutRefusal(join(root, "file"), options), "not_a_directory");
  }),
);

test("review (3): a non-empty directory needs the marker and nothing but the release's files, the default output too", () =>
  withLayout(({ options }) => {
    const out = options.defaultOut;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "broker.mjs"), "old");
    assert.equal(dmReleaseOutRefusal(out, options), "not_empty_without_marker", "the default output is not exempt");
    makeRelease(out);
    assert.equal(dmReleaseOutRefusal(out, options), null);
    writeFileSync(join(out, "notes.txt"), "mine");
    assert.equal(dmReleaseOutRefusal(out, options), "unexpected_entry");
    rmSync(join(out, "notes.txt"));
    writeFileSync(join(out, "systemd", "other.service"), "mine");
    assert.equal(dmReleaseOutRefusal(out, options), "unexpected_entry");
    rmSync(join(out, "systemd", "other.service"));
    rmSync(join(out, "broker.mjs"));
    mkdirSync(join(out, "broker.mjs"));
    assert.equal(dmReleaseOutRefusal(out, options), "unexpected_entry", "a release file must be a regular file");
  }),
);

test("review (3): preparing a marked release unlinks only its own files and keeps the directory", () =>
  withLayout(({ options }) => {
    const out = options.defaultOut;
    makeRelease(out);
    assert.equal(dmPrepareReleaseOut(out, options), out);
    assert.equal(existsSync(join(out, DM_RELEASE_MARKER)), true);
    for (const name of [...DM_RELEASE_TOP_FILES, "systemd"]) assert.equal(existsSync(join(out, name)), false, name);
  }),
);

test("review (3), reproduced through the build: a directory with someone's files is not deleted", () =>
  withLayout(({ root }) => {
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "keep.txt"), "uncommitted work");
    const run = build(data);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /not_empty_without_marker/);
    assert.equal(readFileSync(join(data, "keep.txt"), "utf8"), "uncommitted work");
  }),
);

test("review (3): the build marks what it made, refreshes it, and refuses it once someone else's file is in it", () =>
  withLayout(({ root }) => {
    const out = join(root, "release");
    assert.equal(build(out).status, 0);
    assert.equal(existsSync(join(out, DM_RELEASE_MARKER)), true);
    assert.equal(readFileSync(join(out, "manifest.sha256"), "utf8").includes(DM_RELEASE_MARKER), false, "the marker is not a release file");
    const again = build(out);
    assert.equal(again.status, 0, again.stderr);
    writeFileSync(join(out, "notes.txt"), "mine");
    const refused = build(out);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /unexpected_entry/);
    assert.equal(readFileSync(join(out, "notes.txt"), "utf8"), "mine");
    assert.equal(existsSync(join(out, "manifest.sha256")), true, "nothing of the earlier release was removed either");
  }),
);
