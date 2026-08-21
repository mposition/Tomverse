// Every sender resolves its From through one function, and nothing hard-codes one.
//
//   npm run check:sending-identity            # static: no bypasses in the tree
//   npm run check:sending-identity -- --env   # runtime: this environment resolves
//
// Contract: docs/policy/email-notifications.md §14.1.
// Background: docs/ops/email-sending-domains.md §1.2.
//
// ## The failure this exists for
//
// On 2026-08-21 the transactional sender moved to `mail.tomverse.app` by
// changing one environment variable. Three other senders -- the operational
// alert path, the provider alert path and the GitHub Actions security report --
// each held their own variable and their own literal fallback, so none of them
// moved, and nothing in the repository could tell. `/api/ready` checks the
// sending identity, but only the identity that goes through
// `lib/emailSendingIdentity.ts`; the other three called the provider API
// directly and were invisible to it.
//
// A health check cannot find a sender that never asks it anything. So this is
// static: it reads the tree for the shape of the mistake rather than waiting
// for a deployment to exhibit it.
//
// ## The two modes
//
// Without `--env` it is a lint over the source: an address literal in a `from`
// position, or a sender variable nobody should read any more. That is what runs
// in the PR gate.
//
// With `--env` it resolves the current environment and reports what it got.
// GitHub Actions runs that before the security report sends, because
// `/api/ready` runs in the deployment and knows nothing about the runner's
// variables -- the two environments have to be checked where they are.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  SENDING_IDENTITY_ENV_KEYS,
  hardCodedSenders,
  parseFromAddress,
  resolveSendingIdentity,
  sendingIdentityInputFrom,
  sendingIdentityProblems,
} from "../lib/emailSendingIdentityCore.ts";

const runtimeMode = process.argv.includes("--env");

/**
 * Variables that used to name a sender and must not come back.
 *
 * Removing them from the code is step 6 of the cutover; this is what stops
 * step 6 from being undone by the next person who needs a From address and
 * finds an old name in the git history.
 */
const RETIRED_ENV_NAMES = ["ADMIN_ALERT_FROM", "SECURITY_AUDIT_EMAIL_FROM"];

/**
 * Files allowed to contain an address literal in a `from` position.
 *
 * Exactly one: the core owns the fallback, and it is the only place that may
 * decide what an unconfigured deployment sends as.
 */
const FROM_LITERAL_ALLOWED = new Set(["lib/emailSendingIdentityCore.ts"]);

/** Files that legitimately mention the retired names: this check, and the record. */
const RETIRED_NAME_ALLOWED = new Set([
  "scripts/check-sending-identity.mjs",
  "docs/ops/email-sending-domains.md",
  "tests/sendingIdentity.test.mjs",
]);

const tracked = (patterns) =>
  execSync(`git ls-files ${patterns.map((p) => `'${p}'`).join(" ")}`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

const problems = [];

if (!runtimeMode) {
  for (const file of tracked(["*.ts", "*.tsx", "*.mjs"])) {
    if (file.startsWith("tests/")) continue;
    const source = readFileSync(file, "utf8");

    if (!FROM_LITERAL_ALLOWED.has(file)) {
      for (const found of hardCodedSenders(source)) {
        problems.push(
          `${file}:${found.line}: hard-codes a sender (${found.literal}). Resolve it with resolveSendingIdentity() instead.`
        );
      }
    }
    if (!RETIRED_NAME_ALLOWED.has(file)) {
      for (const name of RETIRED_ENV_NAMES) {
        if (source.includes(name)) {
          problems.push(
            `${file}: reads ${name}, which was retired when the senders were unified.`
          );
        }
      }
    }
  }

  for (const file of tracked([".github/workflows/*.yml"])) {
    const source = readFileSync(file, "utf8");
    for (const name of RETIRED_ENV_NAMES) {
      if (source.includes(name)) {
        problems.push(`${file}: passes ${name}, which was retired.`);
      }
    }
  }

  if (problems.length > 0) {
    console.error("Sending identity check failed.\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nOne resolver decides what every message is sent from. A second one is" +
        "\nhow three of four senders stayed on the old domain through a cutover" +
        "\nthat moved the fourth (docs/ops/email-sending-domains.md §1.2)."
    );
    process.exit(1);
  }

  console.log(
    "Sending identity check passed: no hard-coded sender and no retired sender variable."
  );
  process.exit(0);
}

// --- runtime mode -----------------------------------------------------------

const input = sendingIdentityInputFrom(process.env);
const transactional = resolveSendingIdentity("transactional", process.env);
const configuredBy =
  SENDING_IDENTITY_ENV_KEYS.transactional.find((key) => process.env[key]?.trim()) ??
  null;

console.log("Sending identity, resolved from this environment\n");
console.log(`  source        ${configuredBy ?? "none set — compiled fallback"}`);
console.log(
  `  transactional ${transactional.ok ? transactional.from : `REFUSED (${transactional.code})`}`
);

if (!transactional.ok) {
  console.error(`\n  ${transactional.message}`);
  process.exit(1);
}

const readiness = sendingIdentityProblems({ ...input, nodeEnv: "production" });
for (const problem of readiness) {
  console.log(`  [${problem.severity}] ${problem.code}: ${problem.message}`);
}

// Warnings do not fail. The outstanding move onto a sending subdomain is one,
// and failing on it would stop the daily security report to announce a
// migration somebody is already planning.
const errors = readiness.filter((problem) => problem.severity === "error");
if (errors.length > 0) process.exit(1);

const domain = parseFromAddress(transactional.from)?.domain;
console.log(`\n  Sends will be attributed to ${domain}.`);
