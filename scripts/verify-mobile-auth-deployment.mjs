// Whether the deployment is running the key material we meant to deploy.
//
//   npm run verify:mobile-auth-deployment
//
// `check:mobile-auth-keyring` answers "would these values work?" before a
// deploy. This answers a different question after one: **is the running
// deployment holding the same bytes?**
//
// Why it has to be asked at all: Railway's sealed variables cannot be read
// back through the dashboard or the API, so "the store's Active entry equals
// what is deployed" is not something anyone can look at. The rotation
// procedure used to settle for comparing the ids -- the `kid` of a minted
// access token, and the `pepperKid` of the row a refresh created. That proves
// the ids and nothing else: paste a *different, well-formed* private key under
// the same id and every id-level check still passes, while the value that gets
// promoted to Active is wrong. The break shows up later, at a rollback or the
// next rotation, as tokens that stop verifying.
//
// So this compares material, not labels:
//
//   signing   the token's signature is verified against the public key derived
//             from the candidate private key for that `kid`. Ed25519 public
//             keys are determined by the private key, so a signature that
//             verifies is the deployed key being the candidate key.
//   pepper    `HMAC-SHA256(candidate pepper, secret)` is compared against the
//             `secretDigest` the deployment stored for that exact refresh
//             token, through the runtime's own comparison.
//   iss/aud   read off the claims and compared to the candidate values, since
//             a token carries them and getting them wrong is silent.
//
// What it does NOT prove, stated here because a comparison that quietly covers
// less than it claims is worse than none: only the **active** entries are
// observable this way. Retired entries and any other ring member are not --
// see the runbook for the behavioural check that covers the previous
// generation during its grace window.
//
// Inputs are environment variables, never arguments: three of them are live
// credentials or key material, and an argument is in the command line.
//
//   MOBILE_AUTH_SIGNING_KEYS               the candidate (Pending) rings and
//   MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID      their active ids -- the same
//   MOBILE_AUTH_REFRESH_PEPPERS            variables the runtime reads
//   MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID
//   MOBILE_AUTH_TOKEN_ISSUER
//   MOBILE_AUTH_TOKEN_AUDIENCE
//   MOBILE_AUTH_VERIFY_ACCESS_TOKEN        from one controlled exchange
//   MOBILE_AUTH_VERIFY_REFRESH_TOKEN       against the deployment
//   MOBILE_AUTH_VERIFY_SECRET_DIGEST       MobileRefreshRotation.secretDigest
//   MOBILE_AUTH_VERIFY_PEPPER_KID          MobileRefreshRotation.pepperKid
//                                          (both read from the row that
//                                          exchange created)
//
// The exchange it reads is a real session. Revoke it when you are done --
// the runbook says so at the same step.
//
// Nothing here prints a secret: ids, verdicts and reasons only.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import { createPrivateKey, createPublicKey, verify } from "node:crypto";

import {
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  activeMobileRefreshPepper,
  activeMobileSigningKey,
  mobileSigningKeyById,
  mobileTokenAudience,
  mobileTokenIssuer,
  normalizeMobileKeyId,
} from "../lib/mobileAuthKeyring.ts";
import { parseCompactJws } from "../lib/mobileAccessToken.ts";
import {
  mobileRefreshSecretMatches,
  parseMobileRefreshToken,
} from "../lib/mobileRefreshToken.ts";

const ACCESS_TOKEN_ENV = "MOBILE_AUTH_VERIFY_ACCESS_TOKEN";
const REFRESH_TOKEN_ENV = "MOBILE_AUTH_VERIFY_REFRESH_TOKEN";
const SECRET_DIGEST_ENV = "MOBILE_AUTH_VERIFY_SECRET_DIGEST";
const PEPPER_KID_ENV = "MOBILE_AUTH_VERIFY_PEPPER_KID";

const EVIDENCE = [
  ACCESS_TOKEN_ENV,
  REFRESH_TOKEN_ENV,
  SECRET_DIGEST_ENV,
  PEPPER_KID_ENV,
];

const lines = [];
const failures = [];

const pass = (name, detail) => lines.push(`  OK    ${name}${detail ? ` -- ${detail}` : ""}`);
const fail = (name, detail) => {
  failures.push(name);
  lines.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
};

const report = () => {
  console.log("Mobile auth deployment verification");
  for (const line of lines) console.log(line);
  console.log("");
  if (failures.length === 0) {
    console.log(
      "PASS mobile auth deployment: the running deployment holds the candidate " +
        "active signing key and active pepper, and issues the candidate iss/aud.\n" +
        "  Not covered: retired entries and any other ring member. Nothing " +
        "observes those; see the runbook's previous-generation check."
    );
    return 0;
  }
  console.log(
    `FAIL mobile auth deployment: ${failures.length} check(s) failed (${failures.join(", ")}).\n` +
      "  Do NOT promote Pending to Active. Roll Railway back to Active and\n" +
      "  discard this candidate: docs/ops/mobile-auth-key-rotation.md"
  );
  return 1;
};

const missingEvidence = EVIDENCE.filter((name) => !(process.env[name] ?? "").trim());
if (missingEvidence.length > 0) {
  console.log("Mobile auth deployment verification");
  console.log(
    `FAIL mobile auth deployment: no evidence to check (${missingEvidence.join(", ")} not set).\n` +
      "  Run one controlled exchange against the deployment, then read\n" +
      "  secretDigest and pepperKid off the MobileRefreshRotation row it created."
  );
  process.exit(1);
}

// The candidate rings. A configuration error here is the checker's business,
// not this script's, so it says so rather than reporting a mismatch.
let activeSigning;
let activePepper;
try {
  activeSigning = activeMobileSigningKey(process.env);
  activePepper = activeMobileRefreshPepper(process.env);
} catch (error) {
  console.log("Mobile auth deployment verification");
  console.log(
    `FAIL mobile auth deployment: the candidate configuration is not usable (${error.message}).\n` +
      "  Run npm run check:mobile-auth-keyring -- --require-configured first."
  );
  process.exit(1);
}

const parsed = parseCompactJws((process.env[ACCESS_TOKEN_ENV] ?? "").trim());
if (!parsed) {
  fail("access token parses", "not a three-segment compact JWS");
} else {
  const kid = normalizeMobileKeyId(
    typeof parsed.header.kid === "string" ? parsed.header.kid : null
  );

  if (kid !== activeSigning.keyId) {
    fail(
      "signing kid",
      `token says ${kid || "(none)"}, candidate ${MOBILE_ACTIVE_SIGNING_KEY_ENV} says ${activeSigning.keyId}`
    );
  } else {
    pass("signing kid", kid);
  }

  // The material check. Verified against the key the token names rather than
  // the active one, so a kid mismatch reports both facts instead of one
  // failure hiding the other.
  const candidate = kid ? mobileSigningKeyById(kid, process.env) : null;
  if (!candidate) {
    fail("signing key material", `the candidate ring holds no usable key ${kid || "(none)"}`);
  } else {
    let verified = false;
    try {
      const publicKey = createPublicKey(
        createPrivateKey({
          key: Buffer.from(candidate.secret, "base64"),
          format: "der",
          type: "pkcs8",
        })
      );
      verified = verify(
        null,
        Buffer.from(parsed.signingInput, "utf8"),
        publicKey,
        parsed.signature
      );
    } catch (error) {
      fail("signing key material", `could not derive a public key (${error.message})`);
    }
    if (verified) {
      pass("signing key material", "the deployment signed with the candidate private key");
    } else if (failures[failures.length - 1] !== "signing key material") {
      fail(
        "signing key material",
        "signature does not verify -- the deployed key differs from the candidate under the same id"
      );
    }
  }

  const issuer = mobileTokenIssuer(process.env);
  const audience = mobileTokenAudience(process.env);
  if (parsed.claims.iss !== issuer) {
    fail("iss", `token differs from the candidate ${MOBILE_TOKEN_ISSUER_ENV}`);
  } else {
    pass("iss", issuer);
  }
  const audienceMatches = Array.isArray(parsed.claims.aud)
    ? parsed.claims.aud.length === 1 && parsed.claims.aud[0] === audience
    : parsed.claims.aud === audience;
  if (!audienceMatches) {
    fail("aud", `token differs from the candidate ${MOBILE_TOKEN_AUDIENCE_ENV}`);
  } else {
    pass("aud", audience);
  }
}

const pepperKid = normalizeMobileKeyId(process.env[PEPPER_KID_ENV]);
if (pepperKid !== activePepper.keyId) {
  fail(
    "pepper kid",
    `row says ${pepperKid || "(none)"}, candidate ${MOBILE_ACTIVE_REFRESH_PEPPER_ENV} says ${activePepper.keyId}`
  );
} else {
  pass("pepper kid", pepperKid);
}

const refresh = parseMobileRefreshToken((process.env[REFRESH_TOKEN_ENV] ?? "").trim());
if (!refresh) {
  fail("refresh token parses", "expected <recordId>.<secret>");
} else if (!pepperKid) {
  fail("pepper material", `${PEPPER_KID_ENV} is not a usable key id`);
} else {
  // The runtime's own comparison, so this cannot drift from what the
  // deployment actually does with the same three values.
  const matches = mobileRefreshSecretMatches(
    {
      secret: refresh.secret,
      storedDigest: (process.env[SECRET_DIGEST_ENV] ?? "").trim(),
      pepperKid,
    },
    process.env
  );
  if (matches) {
    pass("pepper material", "the deployment computed the digest with the candidate pepper");
  } else {
    fail(
      "pepper material",
      "the stored digest is not what the candidate pepper computes -- the deployed pepper differs under the same id"
    );
  }
}

process.exit(report());
