// The CI auto-fix's two decisions (lib/prCiAutoFixGuardCore.ts), for the
// workflow .github/workflows/pr-ci-auto-fix.yml.
//
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json>
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs diff <checkout-dir>
//
// `target` reads the pull request and its commits as `gh api --paginate
// --slurp` returned them; `diff` reads the diff against HEAD of another
// checkout. The workflow runs this file from a trusted checkout, never from
// the tree the model or the pull request could change. Prints the verdict as
// one JSON line and exits 0 to proceed, 1 to stop.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { judgePrCiAutoFixDiff, judgePrCiAutoFixTarget } from "../lib/prCiAutoFixGuardCore.ts";

const [mode, prPath, commitsPath] = process.argv.slice(2);
let verdict;
if (mode === "target") {
  const pr = JSON.parse(readFileSync(prPath, "utf8"));
  // --slurp: one array per page.
  const pages = JSON.parse(readFileSync(commitsPath, "utf8"));
  const commits = Array.isArray(pages) ? pages.flat() : [];
  verdict = judgePrCiAutoFixTarget({
    headBranch: pr.head?.ref ?? "",
    baseBranch: pr.base?.ref ?? "",
    draft: pr.draft === true,
    sameRepository: pr.head?.repo?.full_name === pr.base?.repo?.full_name,
    commitMessages: commits.map((c) => String(c.commit?.message ?? "")),
    commitCount: pr.commits,
  });
} else if (mode === "diff" && prPath) {
  const git = (args) => execFileSync("git", ["-C", prPath, ...args], { encoding: "utf8" });
  git(["add", "--intent-to-add", "--all"]);
  verdict = judgePrCiAutoFixDiff({
    nameStatus: git(["diff", "--name-status", "-M", "HEAD"]),
    numstat: git(["diff", "--numstat", "-M", "HEAD"]),
  });
} else {
  console.error("usage: pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json> | diff <checkout-dir>");
  process.exit(2);
}
console.log(JSON.stringify(verdict));
process.exit(verdict.push ? 0 : 1);
