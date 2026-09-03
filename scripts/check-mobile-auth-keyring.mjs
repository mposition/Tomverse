// What a mobile auth key configuration would actually do, before it is deployed.
//
//   npm run check:mobile-auth-keyring
//
// Reads the same environment the runtime reads and reports the state of every
// key. This is the "verify before deploying" half of the rule in
// `lib/mobileAuthKeyring.ts`: at runtime a ring key that is neither active nor
// explicitly retired verifies nothing, which is the safe default but is silent
// -- a mistyped retirement id looks exactly like a healthy deployment until
// somebody notices that the previous key stopped working.
//
// So the loud version lives here, where an operator is looking. Run it against
// the variables you are about to deploy.
//
// Two modes, because "nothing is configured" is a legitimate state in one
// place and a failure in another:
//
//   default              an entirely unconfigured deployment passes. CI has no
//                        mobile keys, and the endpoints answer 503 by design.
//   --require-configured an unconfigured deployment fails. This is the mode a
//                        release check for a deployment that is meant to serve
//                        mobile auth runs in.
//
// A **partly** configured deployment fails in both modes. That is the hole the
// first version had: it exited 0 the moment both rings were empty, so an
// operator who forgot to load the variables at all -- or who loaded the issuer
// and audience and not the keys -- got a green release check for a deployment
// that answers 503 to everything.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import {
  MOBILE_RETIREMENT_FUTURE_SKEW_SECONDS,
  normalizeMobileKeyId,
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
} from "../lib/mobileAuthKeyring.ts";
import {
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
} from "../lib/mobileAuthContract.ts";

const now = Date.now();
const problems = [];
const notes = [];
const requireConfigured = process.argv.includes("--require-configured");

/**
 * The variables that have to move together.
 *
 * All empty is a deployment that has deliberately not turned mobile auth on.
 * Any of them set means somebody meant to, so the rest being empty is a
 * half-applied change rather than a choice -- and the runtime's answer to a
 * half-applied change is 503 with no indication of which half is missing.
 */
const REQUIRED = [
  MOBILE_SIGNING_KEYS_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_REFRESH_PEPPERS_ENV,
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
];
const OPTIONAL = [MOBILE_RETIRED_SIGNING_KEYS_ENV, MOBILE_RETIRED_REFRESH_PEPPERS_ENV];

const isSet = (variable) => (process.env[variable] ?? "").trim() !== "";
const setRequired = REQUIRED.filter(isSet);
const missingRequired = REQUIRED.filter((variable) => !isSet(variable));

/** Ed25519, exercised rather than shape-checked. */
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

const describe = (
  label,
  ring,
  retirements,
  rawRetirements,
  activeId,
  graceSeconds,
  canSign
) => {
  console.log(`\n${label}`);
  if (ring.size === 0) {
    console.log("  (nothing configured)");
    return;
  }

  for (const keyId of ring.keys()) {
    const retiredAt = retirements.get(keyId);
    if (keyId === activeId) {
      if (retiredAt !== undefined) {
        problems.push(
          `${label}: "${keyId}" is the active key and is also retired. It would keep minting credentials under a key you have stopped trusting.`
        );
      }
      const signs = canSign ? signsAndVerifies(ring.get(keyId)) : true;
      if (!signs) {
        problems.push(
          `${label}: the active key "${keyId}" cannot sign. Every mobile auth request would answer 503.`
        );
      }
      console.log(`  ${keyId}  ACTIVE${canSign ? (signs ? " (signs)" : " (CANNOT SIGN)") : ""}`);
      continue;
    }

    if (retiredAt === undefined) {
      // The finding this check exists for. At runtime this key silently
      // verifies nothing; here it is said out loud.
      problems.push(
        `${label}: "${keyId}" is in the ring but is neither active nor retired, so it verifies nothing. ` +
          `Either retire it (check the id you typed) or remove it from the ring.`
      );
      console.log(`  ${keyId}  UNDECLARED -- verifies nothing`);
      continue;
    }

    // A retirement instant that has not arrived is not a retirement. Left
    // alone it reads as healthy and keeps the key trusted until that date --
    // `sign-old@2099-01-01T00:00:00Z` is seventy years of trust reported as
    // "RETIRED, verifies until 2099". The runtime refuses such a key; this
    // says why before the deploy.
    if (retiredAt > now + MOBILE_RETIREMENT_FUTURE_SKEW_SECONDS * 1000) {
      problems.push(
        `${label}: "${keyId}" is retired at ${new Date(retiredAt).toISOString()}, which is in the future. ` +
          `A retirement records when trust was withdrawn, so that is a typo, and until it is fixed the key verifies nothing.`
      );
      console.log(
        `  ${keyId}  RETIREMENT IN THE FUTURE (${new Date(retiredAt).toISOString()}) -- verifies nothing`
      );
      continue;
    }

    const expiresAt = retiredAt + graceSeconds * 1000;
    if (now >= expiresAt) {
      notes.push(
        `${label}: "${keyId}" retired at ${new Date(retiredAt).toISOString()} and its grace has passed, so it already verifies nothing. Removing it and its retirement line together is tidy, and optional.`
      );
      console.log(`  ${keyId}  RETIRED, grace over`);
    } else {
      console.log(
        `  ${keyId}  RETIRED, verifies until ${new Date(expiresAt).toISOString()}`
      );
    }
  }

  // Read from the raw variable, not from the parsed map: the parser drops an
  // id it cannot find in the ring (that is what keeps a leftover line from
  // taking the deployment down), so by the time it hands back a map the very
  // thing an operator needs to see here is gone.
  for (const entry of (rawRetirements ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const keyId = trimmed.slice(0, trimmed.indexOf("@"));
    if (keyId && !ring.has(keyId)) {
      problems.push(
        `${label}: a retirement names "${keyId}", which is not in the ring. It is either a leftover from a cleanup -- harmless -- or a mistyped id, in which case the key you meant to retire is undeclared above and verifies nothing.`
      );
    }
  }

  if (activeId === "") {
    problems.push(`${label}: no active key is named.`);
  } else if (!ring.has(activeId)) {
    problems.push(`${label}: the active id "${activeId}" is not in the ring.`);
  }
};

// Nothing at all: a choice in the default mode, a failure when the caller says
// this deployment is supposed to serve mobile auth.
if (setRequired.length === 0 && !OPTIONAL.some(isSet)) {
  if (requireConfigured) {
    console.error(
      "FAIL mobile auth keyring: --require-configured was given and nothing is configured.\n" +
        `  Set: ${REQUIRED.join(", ")}`
    );
    process.exit(1);
  }
  console.log(
    "OK mobile auth keyring: nothing configured, which is a legitimate state -- the endpoints answer 503 by design.\n" +
      "   Pass --require-configured to make this a failure."
  );
  process.exit(0);
}

// Something but not everything. The runtime answers 503 to this and says
// nothing about which half is missing, so it is said here.
if (missingRequired.length > 0) {
  console.error(
    `FAIL mobile auth keyring: partly configured (${setRequired.length} of ${REQUIRED.length} variables set).\n` +
      "  Mobile auth would answer 503 to every request, and the endpoints do not say which variable is missing.\n" +
      `  Set: ${setRequired.join(", ") || "(none)"}\n` +
      `  Missing: ${missingRequired.join(", ")}`
  );
  process.exit(1);
}

let signingRing;
let pepperRing;
try {
  signingRing = mobileSigningKeyring();
  pepperRing = mobileRefreshPepperRing();
} catch (error) {
  console.error(`FAIL mobile auth keyring: ${error.message}`);
  process.exit(1);
}

try {
  describe(
    `${MOBILE_SIGNING_KEYS_ENV} (grace ${MOBILE_PREVIOUS_SIGNING_KEY_SECONDS}s)`,
    signingRing,
    mobileSigningKeyRetirements(),
    process.env[MOBILE_RETIRED_SIGNING_KEYS_ENV],
    normalizeMobileKeyId(process.env[MOBILE_ACTIVE_SIGNING_KEY_ENV]),
    MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
    true
  );
  describe(
    `${MOBILE_REFRESH_PEPPERS_ENV} (grace ${MOBILE_PREVIOUS_PEPPER_SECONDS}s)`,
    pepperRing,
    mobileRefreshPepperRetirements(),
    process.env[MOBILE_RETIRED_REFRESH_PEPPERS_ENV],
    normalizeMobileKeyId(process.env[MOBILE_ACTIVE_REFRESH_PEPPER_ENV]),
    MOBILE_PREVIOUS_PEPPER_SECONDS,
    false
  );
} catch (error) {
  console.error(`\nFAIL mobile auth keyring: ${error.message}`);
  process.exit(1);
}

// Named so the report is a complete picture of what the runtime will read.
console.log(
  `\n${MOBILE_TOKEN_ISSUER_ENV}=${process.env[MOBILE_TOKEN_ISSUER_ENV] ?? "(unset)"}` +
    `\n${MOBILE_TOKEN_AUDIENCE_ENV}=${process.env[MOBILE_TOKEN_AUDIENCE_ENV] ?? "(unset)"}` +
    `\n${MOBILE_RETIRED_SIGNING_KEYS_ENV}=${process.env[MOBILE_RETIRED_SIGNING_KEYS_ENV] ?? "(unset)"}` +
    `\n${MOBILE_RETIRED_REFRESH_PEPPERS_ENV}=${process.env[MOBILE_RETIRED_REFRESH_PEPPERS_ENV] ?? "(unset)"}`
);

for (const note of notes) console.log(`\nNOTE  ${note}`);

if (problems.length > 0) {
  console.error(
    `\nFAIL mobile auth keyring (${problems.length} problem${problems.length === 1 ? "" : "s"})`
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nOK mobile auth keyring: every key is either active or explicitly retired.");
