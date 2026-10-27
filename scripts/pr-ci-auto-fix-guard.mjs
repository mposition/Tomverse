// The CI auto-fix's decisions (lib/prCiAutoFixGuardCore.ts), for the
// workflow .github/workflows/pr-ci-auto-fix.yml.
//
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json> [ci|conflict]
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs diff <checkout-dir> [<head-branch>]
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs conflict <checkout-dir> <resolution.json> [<head-branch>]
//
// `diff` takes the head branch the target job read from GitHub; without it no
// root file is allowed.
//
// `target` reads the pull request and its commits as `gh api --paginate
// --slurp` returned them; `diff` reads the diff against HEAD of another
// checkout. `conflict` reads a checkout where the workflow has merged develop
// and stopped on conflicts, and the proposed resolution ({ files: { path:
// base64 } }); only when the resolution passes does it write the files there.
// The workflow runs this file from a trusted checkout, never from the tree the
// model or the pull request could change. Prints the verdict as one JSON line
// and exits 0 to proceed, 1 to stop.
import { execFileSync } from "node:child_process";
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { judgePrCiAutoFixConflict, judgePrCiAutoFixDiff, judgePrCiAutoFixTarget } from "../lib/prCiAutoFixGuardCore.ts";

const [mode, ...args] = process.argv.slice(2);
let verdict;
if (mode === "target" && (args.length === 2 || args.length === 3)) {
  const [prPath, commitsPath, kind = "ci"] = args;
  const pr = JSON.parse(readFileSync(prPath, "utf8"));
  // --slurp: one array per page.
  const pages = JSON.parse(readFileSync(commitsPath, "utf8"));
  const commits = Array.isArray(pages) ? pages.flat() : [];
  verdict = judgePrCiAutoFixTarget({
    headBranch: pr.head?.ref ?? "",
    baseBranch: pr.base?.ref ?? "",
    draft: pr.draft === true,
    sameRepository: pr.head?.repo?.full_name === pr.base?.repo?.full_name,
    author: String(pr.user?.login ?? ""),
    commitMessages: commits.map((c) => String(c.commit?.message ?? "")),
    commitCount: pr.commits,
    kind: kind === "conflict" ? "conflict" : "ci",
  });
} else if (mode === "diff" && (args.length === 1 || args.length === 2)) {
  const [checkoutDir, headBranch] = args;
  const git = (gitArgs) => execFileSync("git", ["-C", checkoutDir, ...gitArgs], { encoding: "utf8" });
  git(["add", "--intent-to-add", "--all"]);
  verdict = judgePrCiAutoFixDiff({
    nameStatus: git(["diff", "--name-status", "-M", "HEAD"]),
    numstat: git(["diff", "--numstat", "-M", "HEAD"]),
    headBranch,
  });
} else if (mode === "conflict" && (args.length === 2 || args.length === 3)) {
  const [checkoutDir, resolutionPath, headBranch] = args;
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
  // never a link a write would follow, nor a path through one.
  const regular = (path) => {
    const seen = stages.get(path) ?? {};
    if (!["2", "3"].every((stage) => seen[stage] === "100644" || seen[stage] === "100755")) return false;
    try {
      return lstatSync(fullPath(path)).isFile() && realpathSync(dirname(fullPath(path))).startsWith(root);
    } catch {
      return false;
    }
  };
  const conflicted = [...stages.keys()].sort();
  const resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
  const proposed = resolution && typeof resolution.files === "object" && resolution.files !== null ? resolution.files : {};
  const text = (path) => (typeof proposed[path] === "string" ? Buffer.from(proposed[path], "base64").toString("utf8") : null);
  const files = conflicted.map((path) => {
    const ok = regular(path);
    // What git left in the file, markers and all: the resolution keeps its text outside the conflicts.
    const merged = ok && stages.get(path)["2"] && stages.get(path)["3"] ? readFileSync(fullPath(path), "utf8") : null;
    return { path, regular: ok, merged, resolved: text(path) };
  });
  verdict = judgePrCiAutoFixConflict({ files, proposed: Object.keys(proposed), headBranch });
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
    "usage: pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json> [ci|conflict] | diff <checkout-dir> [<head-branch>] | conflict <checkout-dir> <resolution.json> [<head-branch>]",
  );
  process.exit(2);
}
console.log(JSON.stringify(verdict));
process.exit(verdict.push ? 0 : 1);
