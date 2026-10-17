// The AMUX Decision Maker installer's file and directory judgements, stage
// S2-3b (docs/policy/amux-decision-maker.md §5a), against the independent
// review r-20261017-113433-e16efc:
//
//   (1) equal bytes are not enough: a destination is left alone only as
//       root's regular file with the wanted mode and one link; anything else
//       with the right bytes is repaired by an atomic replacement.
//   (2) every existing directory on the way to a destination or the backup is
//       checked -- not a link, root's, no group or other write -- before
//       anything changes, and the dry run reports the same check.
//
// The judgements are pure functions of a state line and run everywhere; the
// observers read a temporary directory and need POSIX links and modes. This
// file needs nothing of the repository but the installer itself.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const INSTALLER = "scripts/install-amux-decision-maker.sh";
const installer = readFileSync(join(repositoryRoot, INSTALLER), "utf8");
const posix = process.platform !== "win32";
const bashPath =
  process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/bash";

const bash = (script, ...args) =>
  spawnSync(bashPath, ["-c", `source ${INSTALLER}\n${script}`, "test", ...args], { cwd: repositoryRoot, encoding: "utf8" });

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const withTemporary = (body) => {
  const root = mkdtempSync(join(tmpdir(), "amux-dm-install-shell-"));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// (1) equal bytes are not enough
// ---------------------------------------------------------------------------

const action = (state, wanted = SHA, mode = "0444") => {
  const run = bash('dm_file_action "$1" "$2" "$3"', state, wanted, mode);
  return run.status === 0 ? run.stdout.trim() : "refused";
};

test("review (1): equal bytes are left alone only as root's regular file with the wanted mode and one link", () => {
  assert.equal(action("absent"), "install");
  assert.equal(action(`file 0 0 444 1 ${SHA}`), "same");
  assert.equal(action(`file 0 0 555 1 ${SHA}`, SHA, "0555"), "same");
  for (const state of [
    `file 992 992 444 1 ${SHA}`, // another account's
    `file 1000 0 444 1 ${SHA}`,
    `file 0 992 444 1 ${SHA}`, // another group
    `file 0 0 666 1 ${SHA}`, // anyone can rewrite it
    `file 0 0 644 1 ${SHA}`, // not the wanted mode
    `file 0 0 4444 1 ${SHA}`, // setuid
    `file 0 0 444 2 ${SHA}`, // a second name somebody else may hold
  ]) {
    assert.equal(action(state), "repair", state);
  }
  assert.equal(action(`file 0 0 444 1 ${OTHER}`), "replace");
  assert.equal(action(`file 992 992 666 3 ${OTHER}`), "replace");
});

test("review (1): a link, a directory or anything unreadable at a destination is refused, never followed", () => {
  for (const state of ["link", "other", "unreadable", `file 0 0 444 1 nothex`, "file 0 0", "", "absent extra"]) {
    assert.equal(action(state), "refused", JSON.stringify(state));
  }
  assert.equal(action(`file 0 0 444 1 ${SHA}`, "nothex"), "refused");
  assert.equal(action(`file 0 0 444 1 ${SHA}`, SHA, "0844"), "refused");
});

test("review (1), on disk: the observer reports owner, mode, links and bytes, and a link as a link", { skip: !posix }, () =>
  withTemporary((root) => {
    const uid = process.getuid();
    const gid = process.getgid();
    const file = join(root, "broker.mjs");
    writeFileSync(file, "bundle");
    chmodSync(file, 0o444);
    const state = (path) => bash('dm_file_state "$1"', path).stdout.trim();
    assert.equal(state(file), `file ${uid} ${gid} 444 1 ${sha256("bundle")}`);
    chmodSync(file, 0o666);
    assert.equal(state(file), `file ${uid} ${gid} 666 1 ${sha256("bundle")}`);
    linkSync(file, join(root, "second-name"));
    assert.equal(state(file), `file ${uid} ${gid} 666 2 ${sha256("bundle")}`);
    symlinkSync(file, join(root, "pointer"));
    assert.equal(state(join(root, "pointer")), "link");
    mkdirSync(join(root, "directory"));
    assert.equal(state(join(root, "directory")), "other");
    assert.equal(state(join(root, "missing")), "absent");
    // Whatever account wrote it, a file with the right bytes that is not root's is not "same".
    assert.equal(action(state(file), sha256("bundle"), "0444"), "repair");
  }),
);

// ---------------------------------------------------------------------------
// (2) the directories on the way
// ---------------------------------------------------------------------------

test("review (2): a directory on the way is safe only as root's real directory without group or other write", () => {
  const fits = (state) => bash('dm_directory_fits "$1"', state).status === 0;
  for (const state of ["dir 0 755", "dir 0 700", "dir 0 711", "dir 0 1755"]) assert.equal(fits(state), true, state);
  for (const state of ["dir 0 775", "dir 0 757", "dir 0 777", "dir 992 755", "dir 1000 700", "link", "other", "absent", "dir 0", "dir 0 9z"]) {
    assert.equal(fits(state), false, state);
  }
});

test("review (2), on disk: the deepest existing directory on the way is checked first, and a link is named as a link", { skip: !posix }, () =>
  withTemporary((root) => {
    const problem = (path) => {
      const run = bash('dm_ancestors_problem "$1"', path);
      return { status: run.status, line: run.stdout.trim() };
    };
    // /opt/tomverse-amux-dm is a link to somewhere else: install -d and mv would follow it.
    mkdirSync(join(root, "elsewhere"), { mode: 0o755 });
    symlinkSync(join(root, "elsewhere"), join(root, "tomverse-amux-dm"));
    const linked = problem(join(root, "tomverse-amux-dm", "codex-cli-0.162.1", "codex"));
    assert.equal(linked.status, 1);
    assert.equal(linked.line, `${join(root, "tomverse-amux-dm")} link`);
    // A directory others can write, on the way to a unit.
    mkdirSync(join(root, "units"));
    chmodSync(join(root, "units"), 0o777);
    const writable = problem(join(root, "units", "amux-dm-broker.service"));
    assert.equal(writable.status, 1);
    assert.match(writable.line, new RegExp(`^${join(root, "units")} .*writable`));
    // Missing directories are skipped; the first one that exists is judged (here: not root's).
    const missing = problem(join(root, "none", "deeper", "file"));
    assert.equal(missing.status, 1);
    assert.match(missing.line, new RegExp(`^${root} .*owner`));
  }),
);

test("review (2): every destination and the backup are walked before any change, in the dry run too", () => {
  const listed = bash("dm_destination_paths").stdout.trim().split("\n");
  for (const path of [
    "/opt/tomverse-amux-dm/broker.mjs",
    "/opt/tomverse-amux-dm/launcher.mjs",
    "/opt/tomverse-amux-dm/dm-output-schema-v1.json",
    "/opt/tomverse-amux-dm/codex-cli-0.162.1/codex",
    "/opt/tomverse-amux-dm/claude-code-2.1.296/claude",
    "/etc/systemd/system/amux-dm-broker.socket",
    "/etc/systemd/system/amux-dm-launcher-anthropic@.service",
  ]) {
    assert.ok(listed.includes(path), path);
  }
  assert.ok(listed.some((path) => path.startsWith("/var/backups/tomverse-amux-dm/")), "the backup is walked");
  assert.equal(listed.length, 12);
  const code = installer.replace(/^\s*#.*$/gm, "");
  const main = code.slice(code.indexOf("dm_main() {"));
  const check = main.indexOf("dm_check \"every existing directory on the way");
  assert.ok(check > 0, "the dry run reports the directory check");
  assert.ok(check < main.indexOf("if ((DM_APPLY == 0)); then"), "before the dry run ends");
  // The apply re-checks right before each move, after its own install -d.
  const put = code.slice(code.indexOf("dm_put() {"), code.indexOf("dm_main() {"));
  assert.ok(put.indexOf("dm_ancestors_problem") >= 0 && put.indexOf("dm_ancestors_problem") < put.indexOf("/usr/bin/mv"));
});
