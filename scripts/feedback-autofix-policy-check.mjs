import { execFileSync } from "node:child_process";
import { evaluateAutoFixChangePolicy, FORBIDDEN_ADDED_LINE_PATTERNS } from "../lib/feedbackAutoFixPolicy.ts";

/**
 * Phase 3 workflow-side change policy gate. Run with:
 *
 *   node --import tsx scripts/feedback-autofix-policy-check.mjs <baseRef>
 *
 * Recomputes the change manifest from the actual git diff against <baseRef>
 * (never from the fix agent's own report), evaluates the shared policy in
 * lib/feedbackAutoFixPolicy.ts, and scans added lines for test-weakening
 * patterns. Exit 0 = the change may proceed to the Red→Green stage; the
 * manifest is printed as JSON on stdout for the result callback. Exit 1 =
 * refused, with the violations on stderr.
 *
 * The server re-validates the same manifest on the result endpoint -- this
 * script failing open would still not get a violating change accepted.
 */

const baseRef = process.argv[2];
if (!baseRef) {
  console.error("usage: feedback-autofix-policy-check.mjs <baseRef>");
  process.exit(1);
}

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const numstat = git("diff", "--numstat", `${baseRef}...HEAD`).trim();
const nameStatus = git("diff", "--name-status", `${baseRef}...HEAD`).trim();

const kinds = new Map(
  nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split("\t");
      const path = paths[paths.length - 1];
      const kind = status.startsWith("A")
        ? "added"
        : status.startsWith("D")
          ? "deleted"
          : "modified";
      return [path, kind];
    })
);

const files = numstat
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [added, removed, path] = line.split("\t");
    // Binary files report "-": the policy engine refuses them via the
    // NaN-free fallback of treating them as over-limit.
    const addedLines = added === "-" ? Number.MAX_SAFE_INTEGER : Number(added);
    const removedLines =
      removed === "-" ? Number.MAX_SAFE_INTEGER : Number(removed);
    return {
      path,
      addedLines,
      removedLines,
      changeKind: kinds.get(path) || "modified",
    };
  });

const outcome = evaluateAutoFixChangePolicy(files);
if (!outcome.allowed) {
  console.error("Auto-fix change policy refused this change set:");
  for (const violation of outcome.violations) console.error(`- ${violation}`);
  process.exit(1);
}

const addedLines = git("diff", "--unified=0", `${baseRef}...HEAD`)
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
for (const pattern of FORBIDDEN_ADDED_LINE_PATTERNS) {
  const hit = addedLines.find((line) => pattern.test(line));
  if (hit) {
    console.error(
      `Auto-fix change policy refused an added line matching ${pattern}: ${hit.slice(0, 120)}`
    );
    process.exit(1);
  }
}

console.log(JSON.stringify({ changedFiles: files }));
