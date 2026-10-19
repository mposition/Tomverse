// The CI auto-fix's two decisions (lib/prCiAutoFixGuardCore.ts), for the
// workflow .github/workflows/pr-ci-auto-fix.yml.
//
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json>
//   node --experimental-strip-types scripts/pr-ci-auto-fix-guard.mjs diff
//
// `target` reads the pull request and its commits as `gh api` returned them;
// `diff` reads the working tree's diff against HEAD. Prints the verdict as
// one JSON line and exits 0 to proceed, 1 to stop.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { judgePrCiAutoFixDiff, judgePrCiAutoFixTarget } from "../lib/prCiAutoFixGuardCore.ts";

const [mode, prPath, commitsPath] = process.argv.slice(2);
let verdict;
if (mode === "target") {
  const pr = JSON.parse(readFileSync(prPath, "utf8"));
  const commits = JSON.parse(readFileSync(commitsPath, "utf8"));
  verdict = judgePrCiAutoFixTarget({
    headBranch: pr.head?.ref ?? "",
    baseBranch: pr.base?.ref ?? "",
    draft: pr.draft === true,
    sameRepository: pr.head?.repo?.full_name === pr.base?.repo?.full_name,
    commitMessages: Array.isArray(commits) ? commits.map((c) => String(c.commit?.message ?? "")) : [],
  });
} else if (mode === "diff") {
  execFileSync("git", ["add", "--intent-to-add", "--all"]);
  const git = (args) => execFileSync("git", args, { encoding: "utf8" });
  verdict = judgePrCiAutoFixDiff({
    nameStatus: git(["diff", "--name-status", "-M", "HEAD"]),
    numstat: git(["diff", "--numstat", "-M", "HEAD"]),
  });
} else {
  console.error("usage: pr-ci-auto-fix-guard.mjs target <pr.json> <commits.json> | diff");
  process.exit(2);
}
console.log(JSON.stringify(verdict));
process.exit(verdict.push ? 0 : 1);
