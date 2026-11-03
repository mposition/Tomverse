// The CI auto-fix's decisions (lib/prCiAutoFixGuardCore.ts), for the
// workflow .github/workflows/pr-ci-auto-fix.yml.
//
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json> [ci|conflict]
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs diff <checkout-dir>
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs conflict <checkout-dir> <resolution.json>
//
// `target` reads the pull request and its commits as `gh api --paginate
// --slurp` returned them; `diff` reads the diff against HEAD of another
// checkout. `conflict` reads a checkout where the workflow has merged the
// pull request's base and stopped on conflicts, and the proposed resolution
// ({ files: { path: base64 | { merged: sha256, hunks: lines[][] } } }); only
// when the resolution passes does it write the files there.
// The workflow runs this file from a trusted checkout, never from the tree the
// model or the pull request could change. Prints the verdict as one JSON line
// and exits 0 to proceed, 1 to stop.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { judgePrCiAutoFixConflict, judgePrCiAutoFixDiff, judgePrCiAutoFixTarget, rebuildConflictResolution } from "../lib/prCiAutoFixGuardCore.ts";

const [mode, ...args] = process.argv.slice(2);
let verdict;
if (mode === "target" && (args.length === 2 || args.length === 3)) {
  const [prPath, commitsPath, kind = "ci"] = args;
  const pr = JSON.parse(readFileSync(prPath, "utf8"));
  // --slurp: one array per page.
  const pages = JSON.parse(readFileSync(commitsPath, "utf8"));
  const commits = Array.isArray(pages) ? pages.flat() : [];
  verdict = judgePrCiAutoFixTarget({
    headBranch: String(pr.head?.ref ?? ""),
    baseBranch: String(pr.base?.ref ?? ""),
    sameRepository: pr.head?.repo?.full_name === pr.base?.repo?.full_name,
    commitMessages: commits.map((c) => String(c.commit?.message ?? "")),
    commitCount: pr.commits,
    kind: kind === "conflict" ? "conflict" : "ci",
  });
} else if (mode === "diff" && args.length === 1) {
  const [checkoutDir] = args;
  const git = (gitArgs) => execFileSync("git", ["-C", checkoutDir, ...gitArgs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  git(["add", "--intent-to-add", "--all"]);
  // NUL-separated: every path as it is, never quoted.
  verdict = judgePrCiAutoFixDiff({
    nameStatus: git(["diff", "-z", "--name-status", "-M", "HEAD"]),
    numstat: git(["diff", "-z", "--numstat", "-M", "HEAD"]),
  });
} else if (mode === "conflict" && args.length === 2) {
  const [checkoutDir, resolutionPath] = args;
  const git = (gitArgs) =>
    execFileSync("git", ["-C", checkoutDir, "--literal-pathspecs", ...gitArgs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Each unmerged path's stages and modes, from the index git wrote here.
  const stages = new Map();
  for (const entry of git(["ls-files", "-u", "-z"]).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, , stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    stages.set(path, { ...(stages.get(path) ?? {}), [stage]: mode });
  }
  const root = realpathSync(checkoutDir);
  const fullPath = (path) => join(root, path);
  // A regular file on both sides, and here a regular file inside the checkout:
  // never a link a write would follow, nor a path through one. Inside means
  // under the root's own directory, not a sibling whose name extends it.
  const regular = (path) => {
    const seen = stages.get(path) ?? {};
    if (!["2", "3"].every((stage) => seen[stage] === "100644" || seen[stage] === "100755")) return false;
    try {
      const dir = realpathSync(dirname(fullPath(path)));
      return lstatSync(fullPath(path)).isFile() && (dir === root || dir.startsWith(root + sep));
    } catch {
      return false;
    }
  };
  const conflicted = [...stages.keys()].sort();
  const resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
  const proposed = resolution && typeof resolution.files === "object" && resolution.files !== null ? resolution.files : {};
  // A whole file (base64), or { merged, hunks }: the lines for each conflict,
  // put back only into the very file the server resolved (its sha256), since
  // another conflict style would place them differently.
  const text = (path, merged) => {
    const entry = proposed[path];
    if (typeof entry === "string") return Buffer.from(entry, "base64").toString("utf8");
    if (entry === null || typeof entry !== "object" || merged === null) return null;
    if (entry.merged !== createHash("sha256").update(merged, "utf8").digest("hex")) return null;
    return rebuildConflictResolution(merged, entry.hunks);
  };
  const files = conflicted.map((path) => {
    const ok = regular(path);
    // What git left in the file, markers and all: the resolution keeps its text outside the conflicts.
    const merged = ok && stages.get(path)["2"] && stages.get(path)["3"] ? readFileSync(fullPath(path), "utf8") : null;
    return { path, regular: ok, merged, resolved: text(path, merged) };
  });
  verdict = judgePrCiAutoFixConflict({ files, proposed: Object.keys(proposed) });
  if (verdict.push) {
    for (const file of files) {
      // Opened without following a link, on top of the checks above (the
      // workflow's Linux runner; a platform without O_NOFOLLOW relies on them).
      const flags = constants.O_NOFOLLOW === undefined ? "w" : constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;
      const fd = openSync(fullPath(file.path), flags);
      try {
        writeSync(fd, file.resolved);
      } finally {
        closeSync(fd);
      }
    }
    git(["add", "--", ...conflicted]);
  }
} else {
  console.error(
    "usage: pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json> [ci|conflict] | diff <checkout-dir> | conflict <checkout-dir> <resolution.json>",
  );
  process.exit(2);
}
console.log(JSON.stringify(verdict));
process.exit(verdict.push ? 0 : 1);
