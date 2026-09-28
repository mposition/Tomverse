// The admission code manifest still describes this tree.
//
// `config/marketing-admission-code-manifest.json` is generated, and an
// autonomous insert writes its digest into the audit row that authorises the
// post. Dispatch compares that digest against the running deployment's. If the
// manifest drifts from the tree, the number written is a number about code
// nobody is running -- so this fails closed rather than regenerating quietly.
//
// Regenerate with `npm run generate:marketing-admission-code`, and read the
// diff before committing it: a file appearing in that list is a file whose
// bytes now decide whether a post goes out by itself.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MARKETING_ADMISSION_CODE_MANIFEST_PATH,
  MARKETING_ADMISSION_CODE_SCHEMA_VERSION,
  marketingAdmissionCodeClosure,
  marketingAdmissionCodeDigest,
} from "./marketing-admission-code-core.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const fail = (message) => {
  console.error(`check:marketing-admission-code — ${message}`);
  process.exitCode = 1;
};

const { files, unresolved } = marketingAdmissionCodeClosure(repositoryRoot);

if (unresolved.length > 0) {
  for (const entry of unresolved) {
    fail(
      `${entry.from} imports ${entry.specifier}, which resolves to no file in ` +
        `this repository. An admission decision cannot rest on bytes this ` +
        `check cannot find.`
    );
  }
}

let stored;
try {
  stored = JSON.parse(
    readFileSync(new URL(`../${MARKETING_ADMISSION_CODE_MANIFEST_PATH}`, import.meta.url), "utf8")
  );
} catch {
  fail(
    `${MARKETING_ADMISSION_CODE_MANIFEST_PATH} is missing or unreadable. Run ` +
      `npm run generate:marketing-admission-code.`
  );
  process.exit();
}

if (stored.schemaVersion !== MARKETING_ADMISSION_CODE_SCHEMA_VERSION) {
  fail(
    `the manifest says schema ${stored.schemaVersion} and this check speaks ` +
      `${MARKETING_ADMISSION_CODE_SCHEMA_VERSION}. Two schemas produce two ` +
      `numbers that look alike and are not comparable.`
  );
}

const storedPaths = new Set((stored.files ?? []).map((file) => file.path));
const treePaths = new Set(files.map((file) => file.path));

const added = [...treePaths].filter((path) => !storedPaths.has(path)).sort();
const removed = [...storedPaths].filter((path) => !treePaths.has(path)).sort();

for (const path of added) {
  fail(`${path} is reachable from an admission root and is not in the manifest`);
}
for (const path of removed) {
  fail(`${path} is in the manifest and is no longer reachable from an admission root`);
}

const changed = files
  .filter((file) => {
    const previous = (stored.files ?? []).find((entry) => entry.path === file.path);
    return previous && previous.sha256 !== file.sha256;
  })
  .map((file) => file.path);
for (const path of changed) {
  fail(`${path} has changed since the manifest was generated`);
}

const digest = marketingAdmissionCodeDigest(files);
if (stored.digest !== digest && added.length === 0 && removed.length === 0 && changed.length === 0) {
  fail(
    `every file matches but the recorded digest does not. The manifest was ` +
      `edited by hand, or written by something that computes it differently.`
  );
}

if (process.exitCode !== 1) {
  console.log(
    `check:marketing-admission-code — ${files.length} file(s) decide an ` +
      `autonomous admission, digest ${digest.slice(0, 12)}…, and the manifest ` +
      `says the same.`
  );
}
