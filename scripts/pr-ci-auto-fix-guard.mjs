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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  // One side of a conflicted path, or null when that side deleted it.
  const side = (stage, path) => {
    try {
      return git(["show", `:${stage}:${path}`]);
    } catch {
      return null;
    }
  };
  const conflicted = git(["diff", "--name-only", "-z", "--diff-filter=U"]).split("\0").filter(Boolean);
  const resolution = JSON.parse(readFileSync(resolutionPath, "utf8"));
  const proposed = resolution && typeof resolution.files === "object" && resolution.files !== null ? resolution.files : {};
  const text = (path) => (typeof proposed[path] === "string" ? Buffer.from(proposed[path], "base64").toString("utf8") : null);
  const files = conflicted.map((path) => ({ path, ours: side(2, path), theirs: side(3, path), resolved: text(path) }));
  verdict = judgePrCiAutoFixConflict({ files, proposed: Object.keys(proposed), headBranch });
  if (verdict.push) {
    for (const file of files) writeFileSync(join(checkoutDir, file.path), file.resolved);
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
