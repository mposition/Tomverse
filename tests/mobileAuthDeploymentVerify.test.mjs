// The post-deploy verifier, run as a subprocess.
//
// It exists because id-level checks pass on the wrong key material, so the
// cases that matter are the ones where every id is right and a value is not.
// Those are only convincing against the real script: a test that imported the
// comparison and called it would be checking its own arithmetic.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/verify-mobile-auth-deployment.mjs", import.meta.url)
);

const ed25519 = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
};

// The ring parser refuses a short entry, so these are full-length and
// obviously not real.
const PEPPER_INTENDED = `intended-pepper-${"i".repeat(48)}`;
const PEPPER_DEPLOYED = `deployed-pepper-${"d".repeat(48)}`;

const ISSUER = "https://tomverse.example";
const AUDIENCE = "tomverse-mobile-api";

const b64url = (value) =>
  Buffer.from(value).toString("base64url");

const TTL_SECONDS = 600;

/** A compact JWS shaped the way the runtime mints one, including its clock. */
const mintToken = ({
  privateKey,
  kid,
  iss = ISSUER,
  aud = AUDIENCE,
  issuedAt = Math.floor(Date.now() / 1000),
  ttlSeconds = TTL_SECONDS,
}) => {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid }));
  const claims = b64url(
    JSON.stringify({
      iss,
      aud,
      sub: "user_1",
      tkn: "access",
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + ttlSeconds,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
};

const run = (environment) => {
  try {
    const stdout = execFileSync(
      process.execPath,
      // Same flags as the npm script: lib/mobileAccessToken.ts imports
      // `server-only`, which throws without the react-server condition. The
      // repo has been bitten by dropping this flag when retyping a command.
      ["--conditions=react-server", "--import", "tsx", SCRIPT],
      {
        env: { ...process.env, ...environment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

/**
 * One deployment's worth of evidence: the rings that were deployed, a token
 * that deployment minted, and the row its refresh created.
 */
const evidence = ({
  signing,
  pepper,
  signingKid = "sign-2",
  pepperKid = "pep-2",
  issuedAt = Math.floor(Date.now() / 1000),
  ttlSeconds = TTL_SECONDS,
}) => {
  const secret = randomBytes(32).toString("base64url");
  return {
    MOBILE_AUTH_VERIFY_ACCESS_TOKEN: mintToken({
      privateKey: signing.privateKey,
      kid: signingKid,
      issuedAt,
      ttlSeconds,
    }),
    MOBILE_AUTH_VERIFY_REFRESH_TOKEN: `${randomBytes(16).toString("base64url")}.${secret}`,
    MOBILE_AUTH_VERIFY_SECRET_DIGEST: createHmac("sha256", pepper)
      .update(secret)
      .digest("hex"),
    MOBILE_AUTH_VERIFY_PEPPER_KID: pepperKid,
  };
};

const candidate = ({ signingPkcs8, pepper }) => ({
  MOBILE_AUTH_SIGNING_KEYS: `sign-2:${signingPkcs8}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_RETIRED_SIGNING_KEYS: "",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${pepper}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: "",
  MOBILE_AUTH_TOKEN_ISSUER: ISSUER,
  MOBILE_AUTH_TOKEN_AUDIENCE: AUDIENCE,
});

test("a deployment running the candidate material passes", () => {
  const signing = ed25519();
  const pepper = PEPPER_INTENDED;
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper }),
    ...evidence({ signing, pepper }),
  });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /OK {4}signing key material/);
  assert.match(result.stdout, /OK {4}pepper material/);
  assert.match(result.stdout, /Not covered: retired entries/);
});

test("a different signing key under the same kid fails, and the ids do not hide it", () => {
  const deployed = ed25519();
  const intended = ed25519();
  const pepper = PEPPER_INTENDED;
  const result = run({
    ...candidate({ signingPkcs8: intended.pkcs8, pepper }),
    ...evidence({ signing: deployed, pepper }),
  });
  assert.equal(result.code, 1, result.stdout);
  // The id check passes -- that is the whole point of the material check.
  assert.match(result.stdout, /OK {4}signing kid -- sign-2/);
  assert.match(result.stdout, /FAIL {2}signing key material/);
  assert.match(result.stdout, /Do NOT promote Pending to Active/);
});

test("a different pepper under the same kid fails", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper: PEPPER_INTENDED }),
    ...evidence({ signing, pepper: PEPPER_DEPLOYED }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /OK {4}pepper kid -- pep-2/);
  assert.match(result.stdout, /FAIL {2}pepper material/);
});

test("a mismatched kid is reported without the material check swallowing it", () => {
  const signing = ed25519();
  const pepper = PEPPER_INTENDED;
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper }),
    ...evidence({ signing, pepper, signingKid: "sign-1" }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}signing kid/);
});

test("a wrong audience fails even when both rings are right", () => {
  const signing = ed25519();
  const pepper = PEPPER_INTENDED;
  const wrong = evidence({ signing, pepper });
  wrong.MOBILE_AUTH_VERIFY_ACCESS_TOKEN = mintToken({
    privateKey: signing.privateKey,
    kid: "sign-2",
    aud: "some-other-audience",
  });
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper }),
    ...wrong,
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}aud/);
});

test("no evidence is a failure, not a pass", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper: PEPPER_INTENDED }),
    MOBILE_AUTH_VERIFY_ACCESS_TOKEN: "",
    MOBILE_AUTH_VERIFY_REFRESH_TOKEN: "",
    MOBILE_AUTH_VERIFY_SECRET_DIGEST: "",
    MOBILE_AUTH_VERIFY_PEPPER_KID: "",
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /no evidence to check/);
});

test("neither the refresh secret nor the rings appear in the output", () => {
  const signing = ed25519();
  const pepper = PEPPER_INTENDED;
  const facts = evidence({ signing, pepper });
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper }),
    ...facts,
  });
  const secret = facts.MOBILE_AUTH_VERIFY_REFRESH_TOKEN.split(".")[1];
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(signing.pkcs8), false);
  assert.equal(result.stdout.includes(pepper), false);
});

test("evidence kept from an earlier deployment does not pass", () => {
  // The material checks cannot see age: a token minted a week ago verifies
  // against the same key exactly as well, so without a freshness bound the
  // whole script proves the key was right *then*. Everything else here is
  // correct -- the same rings, the same ids -- which is what makes it
  // dangerous.
  const signing = ed25519();
  const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper: PEPPER_INTENDED }),
    ...evidence({ signing, pepper: PEPPER_INTENDED, issuedAt: eightDaysAgo }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /OK {4}signing key material/);
  assert.match(result.stdout, /FAIL {2}evidence is fresh/);
});

test("an expired token is refused even when it is minutes old", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper: PEPPER_INTENDED }),
    ...evidence({
      signing,
      pepper: PEPPER_INTENDED,
      issuedAt: Math.floor(Date.now() / 1000) - 120,
      ttlSeconds: 60,
    }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /expired at/);
});

test("a retirement dated in the future fails before anything is promoted", () => {
  // The pre-deploy check refuses this too. Repeated here because this script
  // is the last thing between a bad candidate and a promotion to Active, and a
  // retirement at 2099 is seventy years of trust that reads as healthy.
  const signing = ed25519();
  const facts = evidence({ signing, pepper: PEPPER_INTENDED });
  const rings = candidate({ signingPkcs8: signing.pkcs8, pepper: PEPPER_INTENDED });
  const result = run({
    ...rings,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${ed25519().pkcs8},${rings.MOBILE_AUTH_SIGNING_KEYS}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: "sign-1@2099-01-01T00:00:00.000Z",
    ...facts,
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /MOBILE_AUTH_RETIRED_SIGNING_KEYS instants have arrived/);
});

test("the emergency mode does not tell anyone to roll back", () => {
  // The remedy is the whole output in a failure, and section 5.1 is reached
  // precisely because the previous ring is untrusted or gone. "Roll Railway
  // back to Active" there means restoring the abandoned ring -- in a leak,
  // the leaked one.
  const deployed = ed25519();
  const intended = ed25519();
  const failing = {
    ...candidate({ signingPkcs8: intended.pkcs8, pepper: PEPPER_INTENDED }),
    ...evidence({ signing: deployed, pepper: PEPPER_INTENDED }),
  };

  const rotation = run(failing);
  assert.match(rotation.stdout, /Roll Railway back to Active/);

  const emergency = run({ ...failing, MOBILE_AUTH_VERIFY_MODE: "emergency" });
  assert.equal(emergency.code, 1, emergency.stdout);
  assert.match(emergency.stdout, /do NOT roll back/);
  assert.match(emergency.stdout, /disable mobile\n?\s*auth|roll forward/);
  assert.equal(/Roll Railway back to Active/.test(emergency.stdout), false);
});

test("an unrecognised mode fails rather than defaulting to the rollback advice", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, pepper: PEPPER_INTENDED }),
    ...evidence({ signing, pepper: PEPPER_INTENDED }),
    MOBILE_AUTH_VERIFY_MODE: "incident",
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /expected one of rotation, emergency/);
});
