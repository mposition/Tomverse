// The committed ROUTE-01 decision pre-registrations are well-formed, and `n`
// was not edited under a version that had already been published.
//
// This runs in CI. The failure it exists to catch is the one nobody does on
// purpose: a decision run comes back at the edge of the margin, somebody
// observes -- correctly -- that the pilot's discordance estimate was noisy, and
// `n` is revised. The file still reads as a pre-registration afterwards. So a
// change to `n` under an unchanged version is refused here, and the harness
// separately refuses a run whose --preregistered-n is not the registered one.
//
// The procedure is docs/ops/tomverse-chat-router-evaluation-set.md §3.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  preRegistrationEditProblems,
  preRegistrationProblems,
} from "../lib/routerDecisionPreRegistration.ts";

const DIRECTORY = "docs/ops/router-evaluation-set";
const PREFIX = "decision-preregistration-";

const problems = [];
const note = (where, message) => problems.push(`${where}: ${message}`);

const files = existsSync(DIRECTORY)
  ? readdirSync(DIRECTORY).filter((name) => name.startsWith(PREFIX) && name.endsWith(".json"))
  : [];

const baseRef = () => {
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "origin/develop";
};

const atBase = (path) => {
  try {
    const base = execSync(`git merge-base HEAD ${baseRef()}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return JSON.parse(execSync(`git show ${base}:${path}`, { stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch {
    // No base, or the file is new there. Either way there is no earlier
    // version to compare against, and a new file is not an edit.
    return null;
  }
};

const versions = new Map();
for (const name of files) {
  const path = join(DIRECTORY, name);
  let registration;
  try {
    registration = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    note(path, `is not readable JSON (${String(error)})`);
    continue;
  }
  for (const problem of preRegistrationProblems(registration)) note(path, problem);

  const version = registration.preRegistrationVersion;
  if (versions.has(version)) {
    note(path, `shares the version "${version}" with ${versions.get(version)}`);
  } else {
    versions.set(version, path);
  }

  const before = atBase(path);
  if (before) {
    for (const problem of preRegistrationEditProblems(before, registration)) note(path, problem);
  }
}

// An active registration that nothing supersedes is the one a decision run
// would cite, and there must not be two of them.
const active = [...files]
  .map((name) => [join(DIRECTORY, name), JSON.parse(readFileSync(join(DIRECTORY, name), "utf8"))])
  .filter(([, r]) => r.activation?.state === "active" && !r.supersededBy);
if (active.length > 1) {
  note(
    DIRECTORY,
    `${active.length} registrations are active and unsuperseded (${active.map(([p]) => p).join(", ")}), ` +
      "so which `n` binds is ambiguous"
  );
}

if (problems.length > 0) {
  console.error("Decision pre-registration check failed.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\n`n` is fixed before the run and conditional on what the file names. Changing it is a new\n" +
      "pre-registration, frozen before collecting, with the old one marked superseded -- never an\n" +
      "edit to a published one."
  );
  process.exit(1);
}

if (files.length === 0) {
  console.log(`No decision pre-registration is committed under ${DIRECTORY}/, so there is nothing to check.`);
} else {
  const states = files
    .map((name) => JSON.parse(readFileSync(join(DIRECTORY, name), "utf8")))
    .map((r) => `${r.preRegistrationVersion} n=${r.n} ${r.activation?.state}`);
  console.log(`Decision pre-registration check passed: ${states.join("; ")}.`);
}
