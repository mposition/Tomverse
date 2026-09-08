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
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

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
  mobileRingFindings,
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

/**
 * The same probes the pre-deploy check uses, for the findings that need
 * crypto. Kept beside each other so a reader can see they are the same two
 * questions: can the active key sign, and are two ids holding one key.
 */
const signsAndVerifies = (base64Pkcs8) => {
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(base64Pkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const probe = Buffer.from("mobile-auth-keyring-check", "utf8");
    return verify(null, probe, createPublicKey(privateKey), sign(null, probe, privateKey));
  } catch {
    return false;
  }
};

/** A hash of the derived public key: nothing secret, and equal for equal keys. */
const signingIdentity = (base64Pkcs8) => {
  try {
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.from(base64Pkcs8, "base64"),
        format: "der",
        type: "pkcs8",
      })
    );
    return createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
  } catch {
    return null;
  }
};

/** Peppers have no derived form, so equality is a constant-time comparison. */
const pepperIdentities = new Map();
const pepperIdentity = (secret) => {
  const candidate = Buffer.from(secret, "utf8");
  for (const [known] of pepperIdentities) {
    const other = Buffer.from(known, "utf8");
    if (other.length === candidate.length && timingSafeEqual(other, candidate)) {
      return known;
    }
  }
  pepperIdentities.set(secret, true);
  return secret;
};

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
  // Partial configuration is a finding, not a quiet fact: every mobile
  // endpoint answers 503 and none of them says which variable is missing. It
  // used to reach the operator as "nothing wants attention".
  const attention =
    configuration.state === "partial"
      ? [
          `partly configured: ${configuration.missing.join(", ")} missing. ` +
            "Mobile auth answers 503 to every request, and the endpoints do not say which variable it is.",
        ]
      : [];
  render({ ...emptyReport(configuration), attention });
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
      signsAndVerifies,
      materialIdentity: signingIdentity,
    },
    {
      variable: MOBILE_REFRESH_PEPPERS_ENV,
      graceSeconds: MOBILE_PREVIOUS_PEPPER_SECONDS,
      ring: mobileRefreshPepperRing(),
      retirements: mobileRefreshPepperRetirements(),
      raw: process.env[MOBILE_RETIRED_REFRESH_PEPPERS_ENV],
      activeKeyId: normalizeMobileKeyId(process.env[MOBILE_ACTIVE_REFRESH_PEPPER_ENV]),
      // A pepper is an HMAC key, not a signer: there is nothing to sign with.
      signsAndVerifies: null,
      materialIdentity: pepperIdentity,
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

/**
 * One sentence per finding code. Exhaustive on purpose: a code with no entry
 * here would be dropped silently, which is the failure this whole change is
 * about.
 */
const FINDING_TEXT = {
  no_active_key_named: () => "no active key is named.",
  active_key_not_in_ring: ({ keyId }) =>
    `the active id "${keyId}" is not in the ring, so nothing can be minted.`,
  active_key_also_retired: ({ keyId }) =>
    `"${keyId}" is the active key and is also retired.`,
  active_key_cannot_sign: ({ keyId }) =>
    `the active key "${keyId}" cannot sign. Every mobile auth request answers 503.`,
  undeclared: ({ keyId }) =>
    `"${keyId}" is neither active nor retired, so it verifies nothing.`,
  retirement_in_future: ({ keyId, retiredAtMs }) =>
    `"${keyId}" is retired at ${new Date(retiredAtMs).toISOString()}, which has not arrived, so it verifies nothing.`,
  grace_over: ({ keyId }) =>
    `"${keyId}" has spent its window and verifies nothing. Removing it and its retirement line together is tidy, and optional.`,
  retirement_names_nothing: ({ keyId }) =>
    `a retirement names "${keyId}", which is not in the ring.`,
  duplicate_material: ({ keyId, otherKeyId }) =>
    `"${keyId}" and "${otherKeyId}" are different ids holding the same material. Renaming a key is not rotating it.`,
};

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

    // Wording, not judgement: which findings exist is decided once, in the
    // shared module, and said in two places with two consequences.
    const findings = mobileRingFindings({
      ring: entry.ring,
      retirements: entry.retirements,
      rawRetirements: entry.raw,
      activeKeyId: entry.activeKeyId,
      graceSeconds: entry.graceSeconds,
      nowMs,
      signsAndVerifies: entry.signsAndVerifies,
      materialIdentity: entry.materialIdentity,
    });
    for (const finding of findings) {
      attention.push(`${entry.variable}: ${FINDING_TEXT[finding.code](finding)}`);
    }
    return {
      variable: entry.variable,
      graceSeconds: entry.graceSeconds,
      keys,
      retirementsNamingNothing,
      findings,
    };
  }),
};
report.attention = attention;

render(report);
process.exit(0);
