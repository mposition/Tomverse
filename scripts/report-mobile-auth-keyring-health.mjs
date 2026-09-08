// What the mobile auth key rings look like right now, as a report.
//
//   npm run report:mobile-auth-keyring-health
//   npm run report:mobile-auth-keyring-health -- --json
//
// **A report, not a gate.** `check:mobile-auth-keyring` answers "may this be
// deployed?" and exits non-zero when the answer is no. This answers "what is
// there?" and exits 0 whether the news is good or bad, because a standing
// check that fails is a standing check somebody turns off. The one non-zero
// exit is a configuration this cannot parse at all, which means the report
// itself is not to be believed -- the same rule
// `report:issue-backlog` follows.
//
// The judgement is shared with the pre-deploy check
// (`mobile-auth-keyring-state.mjs`). Two implementations would eventually
// disagree, and an operator reading "healthy" here and "undeclared" there has
// no way to tell which is right.
//
// ## What it does not do
//
// It reads environment variables and nothing else. It does not reach a vault,
// register itself anywhere, send anything, or change a key. Running it on a
// schedule, who hears about the result, and how long results are kept are
// decisions nobody has taken -- see the rotation runbook's remaining
// decisions.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import {
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_REFRESH_PEPPERS_ENV,
  MOBILE_RETIRED_REFRESH_PEPPERS_ENV,
  MOBILE_RETIRED_SIGNING_KEYS_ENV,
  MOBILE_SIGNING_KEYS_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  mobileRefreshPepperRetirements,
  mobileRefreshPepperRing,
  mobileSigningKeyRetirements,
  mobileSigningKeyring,
  normalizeMobileKeyId,
} from "../lib/mobileAuthKeyring.ts";
import {
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
} from "../lib/mobileAuthContract.ts";
import {
  classifyMobileRing,
  mobileAuthConfigurationState,
  unmatchedMobileRetirements,
} from "./mobile-auth-keyring-state.mjs";

const REQUIRED = [
  MOBILE_SIGNING_KEYS_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_REFRESH_PEPPERS_ENV,
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
];
const OPTIONAL = [MOBILE_RETIRED_SIGNING_KEYS_ENV, MOBILE_RETIRED_REFRESH_PEPPERS_ENV];

const asJson = process.argv.includes("--json");
const nowMs = Date.now();
const isSet = (variable) => (process.env[variable] ?? "").trim() !== "";

const configuration = mobileAuthConfigurationState({
  required: REQUIRED,
  optional: OPTIONAL,
  isSet,
});

/** Everything this report can say when there is nothing to read. */
const emptyReport = (state) => ({
  observedAt: new Date(nowMs).toISOString(),
  configuration: state,
  rings: [],
});

const render = (report) => {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Mobile auth keyring health (${report.observedAt})`);
  console.log(`  configuration: ${report.configuration.state}`);
  if (report.configuration.missing.length > 0) {
    console.log(`  missing: ${report.configuration.missing.join(", ")}`);
  }
  for (const ring of report.rings) {
    console.log(`\n  ${ring.variable} (grace ${ring.graceSeconds}s)`);
    for (const key of ring.keys) {
      const detail =
        key.state === "retired_in_grace"
          ? ` (${key.remainingSeconds}s left)`
          : key.state === "retirement_in_future"
            ? ` (${new Date(key.retiredAtMs).toISOString()})`
            : "";
      console.log(`    ${key.keyId}  ${key.state}${detail}`);
    }
    for (const keyId of ring.retirementsNamingNothing) {
      console.log(`    (retirement names "${keyId}", which is not in the ring)`);
    }
  }
  console.log("");
  for (const line of report.attention) console.log(`  ATTENTION  ${line}`);
  if (report.attention.length === 0) {
    console.log("  Nothing wants attention.");
  }
  console.log(
    "\n  A report, not a gate: this exits 0 either way. What to do about a line\n" +
      "  above is docs/ops/mobile-auth-key-rotation.md."
  );
};

if (configuration.state !== "configured") {
  render({ ...emptyReport(configuration), attention: [] });
  process.exit(0);
}

let rings;
try {
  rings = [
    {
      variable: MOBILE_SIGNING_KEYS_ENV,
      graceSeconds: MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
      ring: mobileSigningKeyring(),
      retirements: mobileSigningKeyRetirements(),
      raw: process.env[MOBILE_RETIRED_SIGNING_KEYS_ENV],
      activeKeyId: normalizeMobileKeyId(process.env[MOBILE_ACTIVE_SIGNING_KEY_ENV]),
    },
    {
      variable: MOBILE_REFRESH_PEPPERS_ENV,
      graceSeconds: MOBILE_PREVIOUS_PEPPER_SECONDS,
      ring: mobileRefreshPepperRing(),
      retirements: mobileRefreshPepperRetirements(),
      raw: process.env[MOBILE_RETIRED_REFRESH_PEPPERS_ENV],
      activeKeyId: normalizeMobileKeyId(process.env[MOBILE_ACTIVE_REFRESH_PEPPER_ENV]),
    },
  ];
} catch (error) {
  // The one non-zero exit. A ring that will not parse means every line this
  // report could print is about something other than what is deployed.
  console.error(
    `FAIL mobile auth keyring health: the rings do not parse (${error.message}).\n` +
      "  Nothing below would describe what is running. Fix the configuration, or\n" +
      "  read docs/ops/mobile-auth-key-rotation.md."
  );
  process.exit(1);
}

const attention = [];
const report = {
  observedAt: new Date(nowMs).toISOString(),
  configuration,
  rings: rings.map((entry) => {
    const keys = classifyMobileRing({
      ring: entry.ring,
      retirements: entry.retirements,
      activeKeyId: entry.activeKeyId,
      graceSeconds: entry.graceSeconds,
      nowMs,
    });
    const retirementsNamingNothing = unmatchedMobileRetirements({
      ring: entry.ring,
      rawRetirements: entry.raw,
    });

    for (const key of keys) {
      // Wording, not judgement: what these states mean is decided once, in the
      // shared module, and said in two places.
      if (key.state === "undeclared") {
        attention.push(
          `${entry.variable}: "${key.keyId}" is neither active nor retired, so it verifies nothing.`
        );
      }
      if (key.state === "retirement_in_future") {
        attention.push(
          `${entry.variable}: "${key.keyId}" is retired at ${new Date(key.retiredAtMs).toISOString()}, which has not arrived, so it verifies nothing.`
        );
      }
      if (key.state === "active" && key.alsoRetired) {
        attention.push(
          `${entry.variable}: "${key.keyId}" is the active key and is also retired.`
        );
      }
      if (key.state === "retired_grace_over") {
        attention.push(
          `${entry.variable}: "${key.keyId}" has spent its window and verifies nothing. Removing it and its retirement line together is tidy, and optional.`
        );
      }
    }
    for (const keyId of retirementsNamingNothing) {
      attention.push(
        `${entry.variable}: a retirement names "${keyId}", which is not in the ring.`
      );
    }
    return {
      variable: entry.variable,
      graceSeconds: entry.graceSeconds,
      keys,
      retirementsNamingNothing,
    };
  }),
};
report.attention = attention;

render(report);
process.exit(0);
