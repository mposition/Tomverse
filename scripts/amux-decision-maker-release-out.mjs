// Where the AMUX Decision Maker release build may write (scripts/build-amux-decision-maker.mjs,
// stage S2-3b), after the independent reviews r-20261017-113433-e16efc (3)
// and r-20261017-114940-a271fb. The build refreshes its output directory, so
// it is never given one that holds anything it did not make, nor one it
// reaches through a link:
//
//   - a filesystem root, the repository, a home, or any ancestor of the
//     repository or a home (as written and as resolved): refused;
//   - a link on the way -- the path itself or any existing ancestor, up to
//     the filesystem root -- or a real path that is not the path as written:
//     refused, the default output (.next/amux-decision-maker) included;
//   - a missing or empty directory: used;
//   - a non-empty directory: used only when this build's marker is in it and
//     everything else is a release file of its own, each a regular file with
//     no second name (and `systemd/` a real directory of the six units); a
//     hard link anywhere refuses (r-20261017-121031-9ff0a9).
//
// Nothing is deleted recursively and nothing existing is written into.
// Preparing a marked release unlinks its own files and the marker by name,
// removes the emptied `systemd/`, keeps the directory and creates a new
// marker exclusively; the build creates every other file the same way.

import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

/** The file every release directory carries; not part of the manifest. */
export const DM_RELEASE_MARKER = ".amux-decision-maker-release";

/** Every file the build writes at the top of a release (scripts/install-amux-decision-maker.sh `DM_RELEASE_FILES`, plus the manifest). */
export const DM_RELEASE_TOP_FILES = Object.freeze([
  "broker.mjs",
  "launcher.mjs",
  "dm-output-schema-v1.json",
  "install-amux-decision-maker.sh",
  "manifest.sha256",
]);

/** The units in `systemd/`. */
export const DM_RELEASE_UNIT_FILES = Object.freeze([
  "amux-dm-broker.socket",
  "amux-dm-broker.service",
  "amux-dm-launcher-openai.socket",
  "amux-dm-launcher-openai@.service",
  "amux-dm-launcher-anthropic.socket",
  "amux-dm-launcher-anthropic@.service",
]);

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
};

/** Windows compares paths without case; everywhere else the bytes are the path. */
const samePath = (left, right) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

const sameOrAncestor = (candidate, path) => {
  const rel = relative(candidate, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The path as written and as resolved, when it can be resolved. */
const spellings = (path) => {
  const written = resolve(path);
  try {
    return [written, realpathSync.native(written)];
  } catch {
    return [written];
  }
};

/** The first link from `path` up to the filesystem root, by lstat; null when there is none. */
const linkOnTheWay = (path) => {
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const stats = lstatOrNull(cursor);
    if (stats !== null && stats.isSymbolicLink()) return cursor;
    if (dirname(cursor) === cursor) return null;
  }
};

/** The deepest of `path` and its ancestors that exists. */
const deepestExisting = (path) => {
  let cursor = path;
  while (lstatOrNull(cursor) === null && dirname(cursor) !== cursor) cursor = dirname(cursor);
  return cursor;
};

const isRegularFile = (stats) => stats !== null && stats.isFile() && !stats.isSymbolicLink();
const isRealDirectory = (stats) => stats !== null && stats.isDirectory() && !stats.isSymbolicLink();

/**
 * One file of the release, as found: a regular file with no other name. A
 * second name (a hard link) means the bytes belong to someone else as well;
 * the build never writes into an existing file anyway, but it does not take
 * such a directory for its own.
 */
const releaseFileProblem = (stats) => (!isRegularFile(stats) ? "unexpected_entry" : stats.nlink !== 1 ? "hard_link" : null);

/** Everything in a non-empty output is the marker or a release file of its own kind, each with one name. */
const releaseEntriesProblem = (path) => {
  for (const name of readdirSync(path)) {
    const stats = lstatOrNull(join(path, name));
    if (name === DM_RELEASE_MARKER || DM_RELEASE_TOP_FILES.includes(name)) {
      const problem = releaseFileProblem(stats);
      if (problem !== null) return problem;
      continue;
    }
    if (name !== "systemd" || !isRealDirectory(stats)) return "unexpected_entry";
    for (const unit of readdirSync(join(path, name))) {
      if (!DM_RELEASE_UNIT_FILES.includes(unit)) return "unexpected_entry";
      const problem = releaseFileProblem(lstatOrNull(join(path, name, unit)));
      if (problem !== null) return problem;
    }
  }
  return null;
};

/**
 * Why `out` may not be the release directory, or null. Relative paths are
 * resolved from the repository, as the build resolves them. Reads only.
 */
export const dmReleaseOutRefusal = (out, { repositoryRoot, home }) => {
  const path = resolve(repositoryRoot, out);
  if (parse(path).root === path) return "filesystem_root";
  if (spellings(repositoryRoot).some((repository) => sameOrAncestor(path, repository))) return "repository_or_ancestor";
  if (typeof home === "string" && home !== "" && spellings(home).some((each) => sameOrAncestor(path, each))) {
    return "home_or_ancestor";
  }
  if (linkOnTheWay(path) !== null) return "link";
  const existing = deepestExisting(path);
  let real;
  try {
    real = realpathSync.native(existing);
  } catch {
    return "not_canonical";
  }
  if (!samePath(real, existing)) return "not_canonical";
  const stats = lstatOrNull(path);
  if (stats === null) return null;
  if (!isRealDirectory(stats)) return "not_a_directory";
  if (readdirSync(path).length === 0) return null;
  if (!isRegularFile(lstatOrNull(join(path, DM_RELEASE_MARKER)))) return "not_empty_without_marker";
  return releaseEntriesProblem(path);
};

const unlinkRegularFile = (path) => {
  const stats = lstatOrNull(path);
  if (stats === null) return;
  if (!isRegularFile(stats)) throw new Error(`refusing to remove ${path}: not a regular file`);
  unlinkSync(path);
};

/**
 * Makes `out` an empty release directory holding only a new marker, or
 * throws without touching anything when `dmReleaseOutRefusal()` refuses it.
 * Every existing name -- the release's files, the units and the marker -- is
 * unlinked, never written through; the marker is then created exclusively
 * (`wx`), as the build creates every other file. Never deletes recursively
 * and never deletes the directory.
 */
export const dmPrepareReleaseOut = (out, options) => {
  const refusal = dmReleaseOutRefusal(out, options);
  if (refusal !== null) throw new Error(`refusing --out ${out}: ${refusal}`);
  const path = resolve(options.repositoryRoot, out);
  if (lstatOrNull(path) === null) {
    mkdirSync(path, { recursive: true });
  } else {
    const units = join(path, "systemd");
    if (lstatOrNull(units) !== null) {
      for (const unit of DM_RELEASE_UNIT_FILES) unlinkRegularFile(join(units, unit));
      rmdirSync(units);
    }
    for (const name of [...DM_RELEASE_TOP_FILES, DM_RELEASE_MARKER]) unlinkRegularFile(join(path, name));
  }
  writeFileSync(join(path, DM_RELEASE_MARKER), "AMUX Decision Maker release, made by scripts/build-amux-decision-maker.mjs\n", {
    flag: "wx",
  });
  return path;
};
