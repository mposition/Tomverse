// One provider port, and nothing that goes round it.
//
//   npm run check:email-provider-port
//
// Contract: docs/policy/email-notifications.md §8.2, §9.1 step [5].
//
// ## What this holds
//
// §8.2 asks for a port with two methods and one implementation, and is explicit
// that templates, contacts, segments and automations stay out of it: they live
// in our database, and that is what actually removes the lock-in. An
// abstraction is not self-enforcing, though. A port stays thin because
// something fails when it does not.
//
// Three things fail here.
//
//  1. **A second wire call.** Any file that posts to the provider's send
//     endpoint without going through the port. This is the failure with
//     precedent: on 2026-08-21 the transactional sender moved domain and three
//     of four senders stayed behind, because each had built its own request
//     (docs/ops/email-sending-domains.md §1.2).
//  2. **A widening port.** A method on the port whose name is one of the
//     capabilities §8.2 keeps out.
//  3. **A drifting surface.** The interface declaring anything other than the
//     two methods `EMAIL_PROVIDER_PORT_SURFACE` names.
//
// The first two are read from the source. The third is also asserted at runtime
// against the implementation's own keys in `tests/emailProviderPort.test.mjs`,
// because an interface is erased and enforces nothing by itself.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  EMAIL_PROVIDER_PORT_SURFACE,
  PORT_FORBIDDEN_CAPABILITIES,
  RESEND_SEND_ENDPOINT,
} from "../lib/emailProviderPortCore.ts";

const PORT_CORE = "lib/emailProviderPortCore.ts";

/**
 * Files allowed to name the send endpoint.
 *
 * The core owns the wire call. The security reporter runs inside GitHub
 * Actions, where it cannot import a `server-only` module and does not have this
 * repository's server environment; it already shares the From resolver through
 * `lib/emailSendingIdentityCore.ts`, and sharing the port is the next step
 * rather than this one. It is listed here so the exception is visible instead
 * of silent.
 */
const ENDPOINT_ALLOWED = new Map([
  [PORT_CORE, "owns the wire call"],
  [
    "scripts/send-security-audit-report.mjs",
    "runs in GitHub Actions, outside the server module graph",
  ],
  [
    "scripts/security-regression-check.mjs",
    "asserts the endpoint, does not post to it",
  ],
]);

const tracked = (patterns) =>
  execSync(`git ls-files ${patterns.map((p) => `'${p}'`).join(" ")}`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

const problems = [];

for (const file of tracked(["*.ts", "*.tsx", "*.mjs"])) {
  if (file.startsWith("tests/") || ENDPOINT_ALLOWED.has(file)) continue;
  const source = readFileSync(file, "utf8");
  if (source.includes(RESEND_SEND_ENDPOINT)) {
    problems.push(
      `${file}: posts to the provider's send endpoint directly. Send through emailProvider() instead.`
    );
  }
}

const core = readFileSync(PORT_CORE, "utf8");

// The interface body, so a `template` in prose does not read as a method.
const interfaceBody = /interface EmailProviderPort\s*\{([\s\S]*?)\n\}/.exec(core)?.[1];
if (!interfaceBody) {
  problems.push(
    `${PORT_CORE}: the EmailProviderPort interface could not be read, so its surface cannot be checked.`
  );
} else {
  const declared = [...interfaceBody.matchAll(/^\s{2}(\w+)\s*[(<]/gm)].map(
    (match) => match[1]
  );
  const expected = [...EMAIL_PROVIDER_PORT_SURFACE];
  if (declared.join(",") !== expected.join(",")) {
    problems.push(
      `${PORT_CORE}: the port declares [${declared.join(", ")}] but EMAIL_PROVIDER_PORT_SURFACE names [${expected.join(", ")}].`
    );
  }
  for (const name of declared) {
    const forbidden = PORT_FORBIDDEN_CAPABILITIES.find((capability) =>
      name.toLowerCase().includes(capability)
    );
    if (forbidden) {
      problems.push(
        `${PORT_CORE}: the port has a "${name}" method. ${forbidden}s live in our database, not at the provider (§8.2).`
      );
    }
  }
}

if (problems.length > 0) {
  console.error("Email provider port check failed.\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nThe port is two methods over one provider. It stays that way because" +
      "\nthis fails when it does not (docs/policy/email-notifications.md §8.2)."
  );
  process.exit(1);
}

console.log(
  `Email provider port check passed: surface is [${[...EMAIL_PROVIDER_PORT_SURFACE].join(", ")}], no direct sends.`
);
