// The standing health report, run as a subprocess with synthetic rings.
//
// Two things are being held. That the report says what is there -- expired
// windows, undeclared keys, a partial configuration -- and that it says the
// same thing the pre-deploy check says, because they share one judgement and a
// divergence between them is worse than either being wrong alone.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

const ed25519 = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");

const SIGN_1 = ed25519();
const SIGN_2 = ed25519();
const PEPPER_1 = "p".repeat(48);
const PEPPER_2 = "q".repeat(48);

const isoAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

const configured = {
  MOBILE_AUTH_SIGNING_KEYS: `sign-2:${SIGN_2}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER_2}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_TOKEN_ISSUER: "https://tomverse.example",
  MOBILE_AUTH_TOKEN_AUDIENCE: "tomverse-mobile-api",
};

const run = (variables, script, args = []) => {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("MOBILE_AUTH_")) delete inherited[key];
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    { encoding: "utf8", env: { ...inherited, ...variables } }
  );
  // stdout separately: --json writes the document there, while the keyring
  // module writes its own notice about an unmatched retirement to stderr.
  // Concatenating them makes the JSON unparseable exactly when the report has
  // something to say.
  return {
    code: result.status,
    stdout: result.stdout,
    out: `${result.stdout}${result.stderr}`,
  };
};

const report = (variables, args = []) =>
  run(variables, "scripts/report-mobile-auth-keyring-health.mjs", args);
const check = (variables, args = []) =>
  run(variables, "scripts/check-mobile-auth-keyring.mjs", args);

const asJson = (variables) => JSON.parse(report(variables, ["--json"]).stdout);

test("a healthy configuration reports the active keys and asks for nothing", () => {
  const json = asJson(configured);
  assert.equal(json.configuration.state, "configured");
  assert.deepEqual(
    json.rings.map((ring) => ring.keys.map((key) => key.state)),
    [["active"], ["active"]]
  );
  assert.deepEqual(json.attention, []);
});

test("nothing configured is a state, not a failure", () => {
  // The report has to be runnable on a deployment that does not serve mobile
  // auth. A standing check that fails there is a standing check somebody
  // silences.
  const { code, out } = report({});
  assert.equal(code, 0, out);
  assert.match(out, /configuration: unconfigured/);
});

test("a partial configuration is named, and named as partial", () => {
  // The dangerous middle state: every endpoint answers 503 and none of them
  // says which variable is missing.
  const partial = { ...configured };
  delete partial.MOBILE_AUTH_TOKEN_AUDIENCE;
  const json = asJson(partial);
  assert.equal(json.configuration.state, "partial");
  assert.deepEqual(json.configuration.missing, ["MOBILE_AUTH_TOKEN_AUDIENCE"]);
});

test("an undeclared key is reported, and the report still exits 0", () => {
  const variables = {
    ...configured,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
  };
  const { code, out } = report(variables);
  assert.equal(code, 0, out);
  assert.match(out, /sign-1 {2}undeclared/);
  assert.match(out, /ATTENTION.*sign-1.*verifies nothing/);
  // And the pre-deploy check refuses the same configuration. That difference
  // -- same judgement, different consequence -- is the whole point of having
  // both.
  assert.equal(check(variables).code, 1);
});

test("a window still open reports the seconds left; a spent one asks for tidying", () => {
  const inGrace = asJson({
    ...configured,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(60)}`,
  });
  const [signing] = inGrace.rings;
  const retired = signing.keys.find((key) => key.keyId === "sign-1");
  assert.equal(retired.state, "retired_in_grace");
  assert.ok(retired.remainingSeconds > 0 && retired.remainingSeconds <= 900 - 59);
  assert.deepEqual(inGrace.attention, []);

  const spent = asJson({
    ...configured,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(3_600)}`,
  });
  const over = spent.rings[0].keys.find((key) => key.keyId === "sign-1");
  assert.equal(over.state, "retired_grace_over");
  assert.equal(over.remainingSeconds, 0);
  assert.match(spent.attention.join("\n"), /spent its window/);
});

test("the pepper's own window is judged against the pepper's grace", () => {
  // Thirty days rather than fifteen minutes. Sharing one classifier makes it
  // easy to share one constant by accident too.
  const json = asJson({
    ...configured,
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1},pep-2:${PEPPER_2}`,
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${isoAgo(3_600)}`,
  });
  const pepperRing = json.rings.find(
    (ring) => ring.variable === "MOBILE_AUTH_REFRESH_PEPPERS"
  );
  const retired = pepperRing.keys.find((key) => key.keyId === "pep-1");
  // An hour spends a signing key's window and barely touches a pepper's.
  assert.equal(retired.state, "retired_in_grace");
  assert.ok(retired.remainingSeconds > 29 * 24 * 3600);
});

test("a retirement dated in the future is reported as verifying nothing", () => {
  const variables = {
    ...configured,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: "sign-1@2099-01-01T00:00:00.000Z",
  };
  const json = asJson(variables);
  const key = json.rings[0].keys.find((entry) => entry.keyId === "sign-1");
  assert.equal(key.state, "retirement_in_future");
  assert.match(json.attention.join("\n"), /has not arrived/);
  assert.equal(check(variables).code, 1);
});

test("a retirement naming nothing is reported without taking the report down", () => {
  const json = asJson({
    ...configured,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-typo@${isoAgo(60)}`,
  });
  assert.deepEqual(json.rings[0].retirementsNamingNothing, ["sign-typo"]);
  assert.match(json.attention.join("\n"), /not in the ring/);
});

test("a ring that will not parse is the one non-zero exit", () => {
  // Everything else this report could print would be about something other
  // than what is deployed, so it says that instead of describing a fiction.
  const { code, out } = report({ ...configured, MOBILE_AUTH_SIGNING_KEYS: "sign-2" });
  assert.equal(code, 1, out);
  assert.match(out, /do not parse/);
});

test("no output carries key material", () => {
  const { out } = report({
    ...configured,
    MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1},sign-2:${SIGN_2}`,
    MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(60)}`,
  });
  for (const secret of [SIGN_1, SIGN_2, PEPPER_1, PEPPER_2]) {
    assert.equal(out.includes(secret), false);
  }
});

// --- the two must not disagree -------------------------------------------
//
// The failure this section exists for: the report shared only the per-key
// states, so four configurations the check rejected came back as "nothing
// wants attention". Sharing half a diagnosis reads as agreement.
//
// Every case here asserts both sides -- the check refuses, and the report has
// something to say -- because either alone would have passed while the pair
// was broken.
const CONTRADICTIONS = [
  {
    name: "an active id that names nothing",
    variables: () => ({ ...configured, MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-9" }),
    attention: /active id "sign-9" is not in the ring/,
  },
  {
    name: "an active key that cannot sign",
    variables: () => ({
      ...configured,
      MOBILE_AUTH_SIGNING_KEYS: `sign-2:${"z".repeat(48)}`,
    }),
    attention: /cannot sign/,
  },
  {
    name: "two signing ids holding one key",
    variables: () => ({
      ...configured,
      MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_2},sign-2:${SIGN_2}`,
      MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-1@${isoAgo(60)}`,
    }),
    attention: /same material/,
  },
  {
    name: "two pepper ids holding one pepper",
    variables: () => ({
      ...configured,
      MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_2},pep-2:${PEPPER_2}`,
      MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: `pep-1@${isoAgo(60)}`,
    }),
    attention: /same material/,
  },
  {
    name: "the active key also carrying a retirement",
    variables: () => ({
      ...configured,
      MOBILE_AUTH_RETIRED_SIGNING_KEYS: `sign-2@${isoAgo(60)}`,
    }),
    attention: /active key and is also retired/,
  },
];

for (const contradiction of CONTRADICTIONS) {
  test(`${contradiction.name}: the check refuses and the report says so`, () => {
    const variables = contradiction.variables();
    assert.equal(check(variables).code, 1, "the check should refuse this");

    const { code, out } = report(variables);
    assert.equal(code, 0, out);
    assert.match(out, contradiction.attention);
    assert.equal(/Nothing wants attention/.test(out), false, out);
  });
}

test("a partial configuration is not reported as nothing to attend to", () => {
  // The same shape one level up: every endpoint answers 503 and none of them
  // says which variable is missing, and the report used to call that quiet.
  const partial = { ...configured };
  delete partial.MOBILE_AUTH_TOKEN_AUDIENCE;
  const { code, out } = report(partial);
  assert.equal(code, 0, out);
  assert.match(out, /partly configured/);
  assert.equal(/Nothing wants attention/.test(out), false, out);
  assert.equal(check(partial).code, 1);
});
