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
// It is not a CI gate: CI has no mobile auth keys, and an unconfigured
// deployment is a legitimate state (the endpoints answer 503 by design). With
// nothing configured this reports that and exits 0.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

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
} from "../lib/mobileAuthKeyring.ts";
import {
  MOBILE_PREVIOUS_PEPPER_SECONDS,
  MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
} from "../lib/mobileAuthContract.ts";

const now = Date.now();
const problems = [];
const notes = [];

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

const describe = (label, ring, retirements, activeId, graceSeconds, canSign) => {
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

  for (const keyId of retirements.keys()) {
    if (!ring.has(keyId)) {
      problems.push(
        `${label}: a retirement names "${keyId}", which is not in the ring. It is either a leftover from a cleanup -- harmless -- or a mistyped id, in which case the key you meant to retire is undeclared and verifies nothing.`
      );
    }
  }

  if (activeId === "") {
    problems.push(`${label}: no active key is named.`);
  } else if (!ring.has(activeId)) {
    problems.push(`${label}: the active id "${activeId}" is not in the ring.`);
  }
};

let signingRing;
let pepperRing;
try {
  signingRing = mobileSigningKeyring();
  pepperRing = mobileRefreshPepperRing();
} catch (error) {
  console.error(`FAIL mobile auth keyring: ${error.message}`);
  process.exit(1);
}

if (signingRing.size === 0 && pepperRing.size === 0) {
  console.log(
    "OK mobile auth keyring: nothing configured, which is a legitimate state -- the endpoints answer 503 by design."
  );
  process.exit(0);
}

try {
  describe(
    `${MOBILE_SIGNING_KEYS_ENV} (grace ${MOBILE_PREVIOUS_SIGNING_KEY_SECONDS}s)`,
    signingRing,
    mobileSigningKeyRetirements(),
    process.env[MOBILE_ACTIVE_SIGNING_KEY_ENV]?.trim() ?? "",
    MOBILE_PREVIOUS_SIGNING_KEY_SECONDS,
    true
  );
  describe(
    `${MOBILE_REFRESH_PEPPERS_ENV} (grace ${MOBILE_PREVIOUS_PEPPER_SECONDS}s)`,
    pepperRing,
    mobileRefreshPepperRetirements(),
    process.env[MOBILE_ACTIVE_REFRESH_PEPPER_ENV]?.trim() ?? "",
    MOBILE_PREVIOUS_PEPPER_SECONDS,
    false
  );
} catch (error) {
  console.error(`\nFAIL mobile auth keyring: ${error.message}`);
  process.exit(1);
}

for (const variable of [MOBILE_TOKEN_ISSUER_ENV, MOBILE_TOKEN_AUDIENCE_ENV]) {
  if (!process.env[variable]?.trim()) {
    problems.push(`${variable} is not set, so no token can be minted or verified.`);
  }
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
