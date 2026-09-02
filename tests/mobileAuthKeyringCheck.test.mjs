import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

/**
 * The pre-deploy check, run as an operator runs it.
 *
 * `lib/mobileAuthKeyring.ts` makes an undeclared key verify nothing, which is
 * the safe default and is *silent*: a mistyped retirement looks like a healthy
 * deployment until somebody notices the previous key stopped working. This
 * script is the loud half, so it is the half most worth testing -- and until
 * now nothing ran it at all, which is how it shipped exiting 0 on a deployment
 * with no variables loaded.
 *
 * Every case goes through a subprocess, because the exit code is the contract.
 */

const ed25519 = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

const SIGN_1 = ed25519();
const SIGN_2 = ed25519();
const PEPPER_1 = "p".repeat(48);
const PEPPER_2 = "q".repeat(48);
/** Comfortably past every grace this file exercises. */
const LONG_RETIRED = "2020-01-01T00:00:00.000Z";
/** Retired just now, so it is inside its grace. */
const justRetired = () => new Date().toISOString();

/** Only the variables a case names; nothing inherited from this process. */
const run = (variables = {}, args = []) => {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("MOBILE_AUTH_")) delete inherited[key];
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/check-mobile-auth-keyring.mjs", ...args],
    { encoding: "utf8", env: { ...inherited, ...variables } }
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

const healthy = {
  MOBILE_AUTH_SIGNING_KEYS: `sign-2:${SIGN_2}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER_2}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.app",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
};

test("a healthy configuration passes and names every key's state", () => {
  const { code, out } = run(healthy);
  assert.equal(code, 0, out);
  assert.match(out, /sign-2\s+ACTIVE \(signs\)/);
  assert.match(out, /pep-2\s+ACTIVE/);
});

test("nothing configured passes by default and fails when the caller demands it", () => {
  // The hole the first version had, from the other side: an operator who loads
  // no variables at all must not get a green release check.
  assert.equal(run().code, 0);
  assert.equal(run({}, ["--require-configured"]).code, 1);
  assert.match(run({}, ["--require-configured"]).out, /nothing is configured/);
});

test("a partly configured deployment fails in both modes, and says what is missing", () => {
  // Every one of these would answer 503 to every request, and the endpoints
  // deliberately do not say which variable is absent.
  const partials = [
    { MOBILE_AUTH_TOKEN_ISSUER: healthy.MOBILE_AUTH_TOKEN_ISSUER },
    { MOBILE_AUTH_SIGNING_KEYS: healthy.MOBILE_AUTH_SIGNING_KEYS },
    { ...healthy, MOBILE_AUTH_TOKEN_AUDIENCE: "" },
    { ...healthy, MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "" },
    { ...healthy, MOBILE_AUTH_REFRESH_PEPPERS: "" },
  ];
  for (const variables of partials) {
    for (const args of [[], ["--require-configured"]]) {
      const { code, out } = run(variables, args);
      assert.equal(code, 1, `${JSON.stringify(Object.keys(variables))}: ${out}`);
      assert.match(out, /partly configured/);
      assert.match(out, /Missing: MOBILE_AUTH_/);
    }
  }
});

test("a retirement list alone is still a partial configuration", () => {
  // It names keys that are not there. Passing this would be the first
  // version's failure with an extra step.
  const { code, out } = run({
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${LONG_RETIRED}`,
  });
  assert.equal(code, 1);
  assert.match(out, /partly configured/);
});

test("an undeclared ring key fails, which is the case the runtime is silent about", () => {
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /sign-1\s+UNDECLARED -- verifies nothing/);
  assert.match(out, /neither active nor retired/);
});

test("the reviewer's mistyped retirement fails, naming both halves of it", () => {
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-l@${LONG_RETIRED}`,
  });
  assert.equal(code, 1, out);
  // The key that is now silently inert...
  assert.match(out, /"sign-1" is in the ring but is neither active nor retired/);
  // ...and the line that was meant to cover it.
  assert.match(out, /a retirement names "sign-l", which is not in the ring/);
});

test("a correctly retired key passes and reports when it stops verifying", () => {
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${justRetired()}`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /sign-1\s+RETIRED, verifies until/);
});

test("a key whose grace has passed is a note, not a failure", () => {
  // It already verifies nothing, so it endangers nothing. Tidying is optional
  // and the check says so rather than blocking a deploy on housekeeping.
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${LONG_RETIRED}`,
  });
  assert.equal(code, 0, out);
  assert.match(out, /sign-1\s+RETIRED, grace over/);
  assert.match(out, /NOTE/);
});

test("whitespace around an active id is read the way the runtime reads it", () => {
  // The two used to disagree: the check trimmed, `activeMobileSigningKey` did
  // not, so a padded value passed here and answered 503 in production. One
  // normalisation now, shared.
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "  sign-2  ",
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: " pep-2 ",
  });
  assert.equal(code, 0, out);
  assert.match(out, /sign-2\s+ACTIVE/);
});

test("an active id that names nothing fails", () => {
  const { code, out } = run({ ...healthy, MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-9" });
  assert.equal(code, 1, out);
  assert.match(out, /active id "sign-9" is not in the ring/);
});

test("a key that cannot sign fails, and says so as the reason", () => {
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_SIGNING_KEYS: `sign-2:${Buffer.from("x".repeat(64), "utf8").toString("base64")}`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /cannot sign/i);
});

test("an active key that is also retired fails", () => {
  const { code, out } = run({
    ...healthy,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-2@${LONG_RETIRED}`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /is the active key and is also retired/);
});

test("no output carries key material", () => {
  const { out } = run({
    ...healthy,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
  });
  for (const secret of [SIGN_1, SIGN_2, PEPPER_1, PEPPER_2]) {
    assert.ok(!out.includes(secret), "the report printed a secret");
  }
});
