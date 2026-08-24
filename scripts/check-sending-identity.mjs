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
  SENDER_ROLES,
  SENDER_ROLE_SPECS,
  SENDING_IDENTITY_ENV_KEYS,
  hardCodedSenders,
  parseFromAddress,
  resolveSenderIdentity,
  resolveSendingIdentity,
  sendCallsMissingSenderRole,
  sendingIdentityInputFrom,
  sendingIdentityProblems,
  sendingSubdomainAddresses,
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

/**
 * Files allowed to name an address on a sending subdomain.
 *
 * The same one, and for the same reason. This is the rule that catches a role
 * bypass: roles gave the tree five more addresses to hard-code and none of them
 * has to sit on a `from` line to work -- a plain constant holding the alerts
 * mailbox on the sending subdomain reads as ordinary code. What separates a
 * sender from every other address here is the domain: `tomverse.app` carries
 * the published support address and the fixtures, while its sending subdomains
 * exist only to send.
 */
const SENDING_SUBDOMAIN_ALLOWED = new Set(["lib/emailSendingIdentityCore.ts"]);

/**
 * Files whose send calls do not name a role literally, on purpose.
 *
 * One: `lib/email.ts` defines both entry points, and `sendTransactionalEmail`
 * forwards its own already-typed input to `deliverEmailOnce` with a spread. The
 * role is present there and TypeScript is what proves it -- `SendEmailInput`
 * requires it, so a caller that omitted it never compiled. Restating it would
 * be a second place for the two to disagree.
 */
const SEND_ROLE_LITERAL_EXEMPT = new Set(["lib/email.ts"]);

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
          `${file}:${found.line}: hard-codes a sender (${found.literal}). Resolve it with resolveSenderIdentity() instead.`
        );
      }
    }
    if (!SENDING_SUBDOMAIN_ALLOWED.has(file)) {
      for (const found of sendingSubdomainAddresses(source)) {
        problems.push(
          `${file}:${found.line}: names an address on a sending subdomain (${found.literal}). ` +
            "Sending subdomains exist only to send, so ask resolveSenderIdentity() for the role instead."
        );
      }
    }
    for (const found of SEND_ROLE_LITERAL_EXEMPT.has(file)
      ? []
      : sendCallsMissingSenderRole(source)) {
      problems.push(
        `${file}:${found.line}: calls ${found.call}() without naming a senderRole. ` +
          "Every message says who it is from, and the value it would take by omission " +
          "is whoever the general identity is."
      );
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
    "Sending identity check passed: no hard-coded sender, no address on a " +
      "sending subdomain, no send without a role, and no retired sender variable."
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

// Every role, not only the stream. `/api/ready` checks these in the deployment;
// this is the same check where GitHub Actions can see it, because the runner's
// `TRANSACTIONAL_EMAIL_FROM` is a repository variable the deployment knows
// nothing about and vice versa. A role that refuses here is a security report
// that will not send.
console.log("\n  Senders by role\n");
const roleFailures = [];
for (const role of SENDER_ROLES) {
  const stream = SENDER_ROLE_SPECS[role].stream;
  const resolved = resolveSenderIdentity(stream, role, process.env);
  const label = `  ${role.padEnd(11)} ${stream.padEnd(14)}`;
  if (resolved.ok) {
    console.log(`${label}${resolved.from}`);
    continue;
  }
  // Marketing has no identity on any deployment today and is production-
  // disabled until the suppression-boundary decision (A18). Reported, not
  // failed -- failing here would stop the daily security report to announce a
  // capability nobody has turned on.
  const fatal = stream !== "marketing";
  console.log(`${label}${fatal ? "REFUSED" : "not configured"} (${resolved.code})`);
  if (fatal) roleFailures.push(`${role}: ${resolved.message}`);
}

if (roleFailures.length > 0) {
  console.error("\n  Transactional senders that do not resolve:\n");
  for (const failure of roleFailures) console.error(`    - ${failure}`);
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
