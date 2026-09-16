// Checks a main promotion branch against an owner-approved change manifest
// (docs/policy/trace-feedback-automation.md §9.3). Run by
// .github/workflows/feedback-autofix-promotion-pr.yml; reads git only.
//
//   node --import tsx scripts/feedback-autofix-promotion-manifest.mjs check-main <manifest.json> <mainRef>
//     main may receive the change: every approved path on <mainRef> is the
//     approved before-blob.
//   node --import tsx scripts/feedback-autofix-promotion-manifest.mjs check-branch <manifest.json> <baseRef> <headRef>
//     <headRef> against its merge base with <baseRef> is exactly the approved
//     change: same paths, same before-blobs, same after-blobs.
//
// Exit 0 when the check holds, 1 when it does not, 2 on a usage error. The
// server repeats the second check from the GitHub API before it records the
// PR, so this script is the workflow's own refusal, not the only one.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  isApprovedChange,
  mainAcceptsApprovedChange,
  parseStoredChangeManifest,
} from "../lib/feedbackAutoFixChangeManifest.ts";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The blob SHA of `path` at `ref`, or null when there is no file there. */
const blobAt = (ref, path) => {
  try {
    const type = git("cat-file", "-t", `${ref}:${path}`);
    if (type !== "blob") throw new Error(`${path} at ${ref} is a ${type}, not a file`);
    return git("rev-parse", `${ref}:${path}`).toLowerCase();
  } catch (error) {
    if (error instanceof Error && /is a .*, not a file/.test(error.message)) throw error;
    return null;
  }
};

const [command, manifestPath, ...refs] = process.argv.slice(2);
const approved = manifestPath
  ? parseStoredChangeManifest(JSON.parse(readFileSync(manifestPath, "utf8")))
  : null;
if (!approved) {
  console.error("usage: check-main|check-branch <manifest.json> <refs...> (manifest must be valid)");
  process.exit(2);
}

if (command === "check-main" && refs.length === 1) {
  const [mainRef] = refs;
  const mainBlobs = new Map(approved.map((entry) => [entry.path, blobAt(mainRef, entry.path)]));
  const verdict = mainAcceptsApprovedChange(approved, mainBlobs);
  if (!verdict.ok) {
    console.error(`main cannot receive the approved change: ${verdict.reason}`);
    process.exit(1);
  }
  console.log("main still has the approved base for every changed path.");
  process.exit(0);
}

if (command === "check-branch" && refs.length === 2) {
  const [baseRef, headRef] = refs;
  const mergeBase = git("merge-base", baseRef, headRef);
  const paths = git("diff", "--no-renames", "--name-only", `${mergeBase}`, headRef)
    .split("\n")
    .filter(Boolean);
  const candidate = paths.map((path) => ({
    path,
    baseBlob: blobAt(mergeBase, path),
    headBlob: blobAt(headRef, path),
  }));
  const verdict = isApprovedChange(approved, candidate);
  if (!verdict.ok) {
    console.error(`the promotion branch is not the approved change: ${verdict.reason}`);
    process.exit(1);
  }
  console.log("the promotion branch is exactly the approved change.");
  process.exit(0);
}

console.error("usage: check-main <manifest.json> <mainRef> | check-branch <manifest.json> <baseRef> <headRef>");
process.exit(2);
