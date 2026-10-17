// Where the AMUX Decision Maker release build may write (scripts/build-amux-decision-maker.mjs,
// stage S2-3b). The build replaces its output directory, so it is never
// given one that holds anything it did not make:
//
//   - a filesystem root, the repository, a home, and any ancestor of the
//     repository or a home: always refused;
//   - a link: refused, whatever it points at;
//   - the default output (.next/amux-decision-maker), a missing directory or
//     an empty one: used;
//   - any other non-empty directory: used only when this build's marker,
//     a regular file it writes into every release, is in it.

import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";

/** The file every release directory carries; not part of the manifest. */
export const DM_RELEASE_MARKER = ".amux-decision-maker-release";

const sameOrAncestor = (candidate, path) => {
  const rel = relative(candidate, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Why `out` may not be the release directory, or null. Relative paths are
 * resolved from the repository, as the build resolves them. Reads only.
 */
export const dmReleaseOutRefusal = (out, { repositoryRoot, home, defaultOut }) => {
  const path = resolve(repositoryRoot, out);
  if (parse(path).root === path) return "filesystem_root";
  if (sameOrAncestor(path, resolve(repositoryRoot))) return "repository_or_ancestor";
  if (typeof home === "string" && home !== "" && sameOrAncestor(path, resolve(home))) return "home_or_ancestor";
  const stats = lstatOrNull(path);
  if (stats === null) return null;
  if (stats.isSymbolicLink()) return "link";
  if (!stats.isDirectory()) return "not_a_directory";
  if (relative(resolve(defaultOut), path) === "") return null;
  const entries = readdirSync(path);
  if (entries.length === 0) return null;
  const marker = lstatOrNull(`${path}/${DM_RELEASE_MARKER}`);
  return marker !== null && marker.isFile() && !marker.isSymbolicLink() ? null : "not_empty_without_marker";
};

/**
 * Makes `out` an empty, marked release directory, or throws without touching
 * anything when `dmReleaseOutRefusal()` refuses it.
 */
export const dmPrepareReleaseOut = (out, options) => {
  const refusal = dmReleaseOutRefusal(out, options);
  if (refusal !== null) throw new Error(`refusing --out ${out}: ${refusal}`);
  const path = resolve(options.repositoryRoot, out);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  writeFileSync(`${path}/${DM_RELEASE_MARKER}`, "AMUX Decision Maker release, made by scripts/build-amux-decision-maker.mjs\n");
  return path;
};
