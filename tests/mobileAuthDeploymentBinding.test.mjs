// Binding evidence to a deployment, vector by vector.
//
// Contract and vectors: `.github/audits/2026-09-09-mobile-auth-evidence-
// deployment-binding-approval.md` sections 8, 9 and 10.2, approved 2026-09-09
// (option A: A1 the `dep` claim, A2 the row column; E9 the tolerance window;
// E11 partly, in direction only).
//
// W10 and W11 are absent on purpose: they are the two rollback scenarios and
// exactly one of them becomes valid once E7 is measured, which this approval
// did not permit. W18 is absent for the same kind of reason -- its expected
// value is whatever the four open questions of section 10.3 settle on.
//
// Each test names the vector it is. Where a vector needs more than one
// assertion the assertions stay in that one test, so the count of tests and
// the count of vectors can be compared without a table.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MOBILE_BINDING_ROUND_MIN_INTERVAL_SECONDS,
  MOBILE_BINDING_ROUND_MODEL_CAVEAT,
  judgeMobileBindingRound,
} from "../scripts/mobile-auth-binding-round-core.mjs";

const VERIFIER = fileURLToPath(
  new URL("../scripts/verify-mobile-auth-deployment.mjs", import.meta.url)
);
const JUDGE = fileURLToPath(
  new URL("../scripts/judge-mobile-auth-binding-round.mjs", import.meta.url)
);

const ISSUER = "https://tomverse.example";
const AUDIENCE = "tomverse-mobile-api";
const TTL_SECONDS = 600;

/** The deployment a person wrote onto the store entry. */
const PENDING = "dep-aaaaaaaa-1111-2222-3333-444444444444";
/** The one that was running before it, still answering during a rolling deploy. */
const PREVIOUS = "dep-bbbbbbbb-5555-6666-7777-888888888888";

const PEPPER = `intended-pepper-${"i".repeat(48)}`;

const ed25519 = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
};

const b64url = (value) => Buffer.from(value).toString("base64url");

const mintToken = ({
  privateKey,
  kid = "sign-2",
  issuedAt = Math.floor(Date.now() / 1000),
  ttlSeconds = TTL_SECONDS,
  dep,
}) => {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid }));
  const claims = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user_1",
      tkn: "access",
      ...(dep === null ? {} : { dep }),
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + ttlSeconds,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
};

/**
 * One exchange's worth of evidence.
 *
 * `dep` is what the evidence *reports*, which is not the same thing as where it
 * came from -- that is exactly the gap this axis cannot close, so the fixtures
 * keep the two words apart.
 */
const evidence = ({
  signing,
  pepper = PEPPER,
  issuedAt = Math.floor(Date.now() / 1000),
  ttlSeconds = TTL_SECONDS,
  dep = PENDING,
  rowDep = undefined,
}) => {
  const secret = randomBytes(32).toString("base64url");
  return {
    MOBILE_AUTH_VERIFY_ACCESS_TOKEN: mintToken({
      privateKey: signing.privateKey,
      issuedAt,
      ttlSeconds,
      dep,
    }),
    MOBILE_AUTH_VERIFY_REFRESH_TOKEN: `${randomBytes(16).toString("base64url")}.${secret}`,
    MOBILE_AUTH_VERIFY_SECRET_DIGEST: createHmac("sha256", pepper).update(secret).digest("hex"),
    MOBILE_AUTH_VERIFY_PEPPER_KID: "pep-2",
    MOBILE_AUTH_VERIFY_MINTED_BY_DEPLOYMENT_ID:
      rowDep === undefined ? (dep === null ? "" : dep) : (rowDep ?? ""),
  };
};

const candidate = ({ signingPkcs8, mode = "rotation", tolerance = "open" }) => ({
  MOBILE_AUTH_VERIFY_MODE: mode,
  MOBILE_AUTH_VERIFY_BINDING_TOLERANCE: tolerance,
  MOBILE_AUTH_VERIFY_DEPLOYMENT_ID: PENDING,
  MOBILE_AUTH_SIGNING_KEYS: `sign-2:${signingPkcs8}`,
  MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID: "sign-2",
  MOBILE_AUTH_RETIRED_SIGNING_KEYS: "",
  MOBILE_AUTH_REFRESH_PEPPERS: `pep-2:${PEPPER}`,
  MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID: "pep-2",
  MOBILE_AUTH_RETIRED_REFRESH_PEPPERS: "",
  MOBILE_AUTH_TOKEN_ISSUER: ISSUER,
  MOBILE_AUTH_TOKEN_AUDIENCE: AUDIENCE,
});

const run = (environment) => {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", VERIFIER],
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

test("W1: evidence naming the expected deployment passes, without replacing the material check", () => {
  const signing = ed25519();
  const result = run({ ...candidate({ signingPkcs8: signing.pkcs8 }), ...evidence({ signing }) });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /OK {4}signing binding/);
  assert.match(result.stdout, /OK {4}pepper binding/);
  // Still there, and still separately reported: the binding is an added axis,
  // not a substitute for either of the two it joins.
  assert.match(result.stdout, /OK {4}signing key material/);
  assert.match(result.stdout, /OK {4}pepper material/);
  assert.match(result.stdout, /OK {4}evidence is fresh/);
  // And the pass says what it is worth.
  assert.match(result.stdout, /self-report against a hand-entered expectation/);
  assert.match(result.stdout, /NOT proof that this/);
});

test("W2: evidence naming another deployment is insufficient evidence, not a rollback order", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, dep: PREVIOUS }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}signing binding/);
  assert.match(result.stdout, /normal during a rolling deploy/);
  assert.match(result.stdout, /Nothing was decided about the deployment/);
  assert.equal(/Roll Railway back to Active/.test(result.stdout), false);
  assert.equal(/Do NOT deploy/.test(result.stdout), false);
});

test("W3: evidence with no identifier is undetermined while the tolerance is open", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, tolerance: "open" }),
    ...evidence({ signing, dep: null }),
  });
  // Not a pass. The exit code is the only thing that stops a promotion, and
  // "undetermined" has to stop one.
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}signing binding/);
  assert.match(result.stdout, /neither a pass nor a defect/);
  assert.match(result.stdout, /Nothing was decided about the deployment/);
  assert.equal(/Roll Railway back to Active/.test(result.stdout), false);
});

test("W3b: the same evidence is refused once the tolerance has closed", () => {
  // E9. The identical input, judged on the other side of the promotion: what
  // changes is not the evidence but what Active is, and the run says so.
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8, tolerance: "closed" }),
    ...evidence({ signing, dep: null }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}signing binding/);
  assert.match(result.stdout, /the tolerance is closed/);
  assert.match(result.stdout, /Do NOT promote/);
  // Two causes look the same from here, and the remedy names the one action
  // that tells them apart rather than picking one.
  assert.match(result.stdout, /Two causes look identical/);
  assert.equal(/neither a pass nor a defect/.test(result.stdout), false);
});

test("W3c: the tolerance is required rather than defaulted", () => {
  const signing = ed25519();
  const rings = candidate({ signingPkcs8: signing.pkcs8 });
  rings.MOBILE_AUTH_VERIFY_BINDING_TOLERANCE = "";
  const result = run({ ...rings, ...evidence({ signing }) });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /MOBILE_AUTH_VERIFY_BINDING_TOLERANCE is not set/);
  assert.match(result.stdout, /`open` is wrong on exactly the runs where the/);
});

test("W4: an earlier deployment's evidence is caught even when its iat is fresh", () => {
  // The case freshness alone could never see: minted seconds ago, every id and
  // both rings correct, and produced by the instance that is on its way out.
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, dep: PREVIOUS, issuedAt: Math.floor(Date.now() / 1000) - 5 }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /OK {4}evidence is fresh/);
  assert.match(result.stdout, /FAIL {2}signing binding/);
});

test("W5: a matching identifier does not rescue expired evidence", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, issuedAt: Math.floor(Date.now() / 1000) - 120, ttlSeconds: 60 }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /OK {4}signing binding/);
  assert.match(result.stdout, /FAIL {2}evidence is fresh/);
});

test("W6: reuse of old evidence from the same deployment passes the binding and fails freshness", () => {
  // The identifier is constant for the deployment's whole life, so it cannot
  // see age. Recorded as a vector because the two axes are easy to read as one
  // stronger check, and they are not.
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, issuedAt: Math.floor(Date.now() / 1000) - 8 * 24 * 3600 }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /OK {4}signing binding/);
  assert.match(result.stdout, /OK {4}pepper binding/);
  assert.match(result.stdout, /FAIL {2}evidence is fresh/);
});

test("W7: a rolling deploy is caught here, and nothing in the run asks the deployment itself", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, dep: PREVIOUS }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}signing binding/);
  // B1 -- asking the deployment separately -- would have passed this: the
  // build-info answer and the exchange can land on different instances. The
  // script never asks, and this is the assertion that keeps it that way.
  const source = readFileSync(VERIFIER, "utf8");
  assert.equal(/fetch\(|build-info/.test(source), false);
});

test("W8: binding the token leaves the row unbound", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, rowDep: null }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /OK {4}signing binding/);
  assert.match(result.stdout, /FAIL {2}pepper binding/);
  assert.match(result.stdout, /neither a pass nor a defect/);
});

test("W9: binding the row leaves the signature unbound", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing, dep: null, rowDep: PENDING }),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}signing binding/);
  assert.match(result.stdout, /OK {4}pepper binding/);
});

test("W12: no token, digest, ring or key material reaches the output or the round file", () => {
  const signing = ed25519();
  const facts = evidence({ signing });
  const directory = mkdtempSync(join(tmpdir(), "binding-w12-"));
  const summaryPath = join(directory, "run.json");
  try {
    const result = run({
      ...candidate({ signingPkcs8: signing.pkcs8 }),
      ...facts,
      MOBILE_AUTH_VERIFY_SUMMARY_PATH: summaryPath,
    });
    const secret = facts.MOBILE_AUTH_VERIFY_REFRESH_TOKEN.split(".")[1];
    const summary = readFileSync(summaryPath, "utf8");
    for (const text of [result.stdout, summary]) {
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes(facts.MOBILE_AUTH_VERIFY_SECRET_DIGEST), false);
      assert.equal(text.includes(facts.MOBILE_AUTH_VERIFY_ACCESS_TOKEN), false);
      assert.equal(text.includes(signing.pkcs8), false);
      assert.equal(text.includes(PEPPER), false);
    }
    // And no token identifier: writing one down would be the raw material for
    // the duplicate detection E11 approved in direction only.
    assert.equal(/"jti"/.test(summary), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("W13: an identifier transcribed from elsewhere passes every axis", () => {
  // The counter-example the packet insists on. An older instance mints the
  // token; both deployments hold the same key material, so nothing about the
  // material differs; and the identifier is whatever the collector typed. Any
  // procedure that takes the identifier separately fails this vector -- which
  // is the whole reason B2 needed an unsplit response and A is a self-report.
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    // The evidence reports the expected id because the process that made it
    // was told to; nothing here establishes which instance that was.
    ...evidence({ signing }),
  });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /NOT established: that the deployment is stable/);
  assert.match(result.stdout, /no older\n?\s*instance is still serving/);
});

test("W14 and W19: the same fresh evidence passes twice, and nothing notices", () => {
  const signing = ed25519();
  const rings = candidate({ signingPkcs8: signing.pkcs8 });
  const facts = evidence({ signing });
  const first = run({ ...rings, ...facts });
  const second = run({ ...rings, ...facts });
  assert.equal(first.code, 0, first.stdout);
  assert.equal(second.code, 0, second.stdout);
  // Stated in the pass text rather than left for a reader to work out.
  assert.match(second.stdout, /the same\n?\s*evidence submitted twice \(nothing here keeps state\)/);
});

// --- the three-sample round (E5) -------------------------------------------

/**
 * A run summary shaped the way the verifier writes one.
 *
 * `failures` is derived rather than passed in: the round now tells a binding
 * finding apart from a stale token by reading it, so a fixture that set it by
 * hand would be free to describe a run that cannot happen.
 */
const sample = ({
  issuedAt,
  ttlSeconds = TTL_SECONDS,
  signingDeploymentId = PENDING,
  pepperDeploymentId = undefined,
  otherFailures = [],
}) => {
  const pepperId = pepperDeploymentId === undefined ? signingDeploymentId : pepperDeploymentId;
  const failures = [...otherFailures];
  if (signingDeploymentId !== PENDING) failures.push({ name: "signing binding", kind: "evidence" });
  if (pepperId !== PENDING) failures.push({ name: "pepper binding", kind: "evidence" });
  return {
    schema: "tomverse.mobile-auth-verify.v1",
    mode: "rotation",
    tolerance: "open",
    expectedDeploymentId: PENDING,
    tokenIssuedAt: issuedAt,
    tokenExpiresAt: issuedAt + ttlSeconds,
    signingBinding: signingDeploymentId === PENDING ? "matched" : "mismatched",
    signingDeploymentId,
    pepperBinding: pepperId === PENDING ? "matched" : "mismatched",
    pepperDeploymentId: pepperId,
    failures,
    passed: failures.length === 0,
  };
};

const STALE = [{ name: "evidence is fresh", kind: "evidence" }];

const threeSamples = (base, overrides = [{}, {}, {}]) =>
  overrides.map((override, index) =>
    sample({
      issuedAt: base + index * MOBILE_BINDING_ROUND_MIN_INTERVAL_SECONDS,
      ...override,
    })
  );

test("W15: one sample naming another deployment makes the round undetermined, with no retry", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base, [{}, { signingDeploymentId: PREVIOUS }, {}]),
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /signingBinding mismatched, not matched/);
  // The round ends here. Nothing in the result offers another sample, and the
  // CLI's undetermined text says so out loud.
  const cliText = readFileSync(JUDGE, "utf8");
  assert.match(cliText, /do NOT re-sample to get a/);
});

test("W16: a second round is refused without a person, and its record carries the caveat", () => {
  const base = Math.floor(Date.now() / 1000);
  const input = { round: 2, judgedAtSeconds: base + 300, samples: threeSamples(base) };

  const unattended = judgeMobileBindingRound(input);
  assert.equal(unattended.verdict, "refused");
  assert.match(unattended.reasons.join(" "), /needs a person to decide the resumption/);

  const decided = judgeMobileBindingRound({ ...input, resumeApprovedBy: "mposition" });
  assert.equal(decided.verdict, "sample_condition_met");
  assert.equal(decided.record.round, 2);
  assert.equal(decided.record.resumeDecidedBy, "mposition");
  // A bare number would read as a measurement of this deployment. It is not
  // one, so the record cannot carry the number without the sentence.
  assert.equal(decided.record.illustrativeMiss, "23.4%");
  assert.equal(decided.record.modelCaveat, MOBILE_BINDING_ROUND_MODEL_CAVEAT);
  assert.match(decided.record.modelCaveat, /the real distribution is unmeasured/);
  assert.match(decided.record.modelCaveat, /not this number/);
});

test("W16a: a mixed state that failed one round passes the next, unchanged", () => {
  // new / old / new, then new / new / new against the same deployment. Nothing
  // about the deployment changed between them. This is why reopening a round
  // is a person's decision and not an automatic next step.
  const base = Math.floor(Date.now() / 1000);
  const first = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base, [{}, { signingDeploymentId: PREVIOUS }, {}]),
  });
  assert.equal(first.verdict, "undetermined");

  const second = judgeMobileBindingRound({
    round: 2,
    resumeApprovedBy: "mposition",
    judgedAtSeconds: base + 900,
    samples: threeSamples(base + 600),
  });
  assert.equal(second.verdict, "sample_condition_met");
  assert.equal(second.record.illustrativeMiss, "23.4%");
});

test("W16b: a sample that has expired by judgement time does not carry its earlier pass", () => {
  const base = Math.floor(Date.now() / 1000);
  // Each sample passed its own run; the first one's 600s lifetime then ran out
  // before the round was judged. The verifier's own 900s age limit never
  // binds, because the token's lifetime is shorter.
  const samples = threeSamples(base);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + TTL_SECONDS + 1,
    samples,
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /no longer valid/);
  assert.match(result.reasons.join(" "), /an earlier pass is not carried forward/);
  assert.equal(samples[0].tokenExpiresAt - samples[0].tokenIssuedAt, TTL_SECONDS);
});

test("W17: three matching samples meet the condition and claim nothing about stability", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base),
  });
  assert.equal(result.verdict, "sample_condition_met");
  // The fourth sample the round never took. Nothing in the verdict's name or
  // in either script's text may present the round as evidence of stabilisation.
  const fourth = sample({ issuedAt: base + 720, signingDeploymentId: PREVIOUS });
  assert.equal(fourth.signingBinding, "mismatched");
  for (const path of [JUDGE, VERIFIER]) {
    const text = readFileSync(path, "utf8");
    assert.equal(/stabilis|stabiliz/i.test(text.replace(/does not prove it either/g, "")), false, path);
  }
  const cliText = readFileSync(JUDGE, "utf8");
  assert.match(cliText, /NOT established: that the deployment is stable/);
  assert.match(cliText, /A fourth/);
  assert.match(cliText, /sample could name a different deployment and this round would not know/);
});

test("a partial round is not judged on what arrived", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base).slice(0, 2),
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /a partial round is not judged/);
});

test("samples closer together than two minutes are not three looks at different moments", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: [
      sample({ issuedAt: base }),
      sample({ issuedAt: base + 30 }),
      sample({ issuedAt: base + 300 }),
    ],
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /30s apart, under the 120s minimum/);
});

test("three samples all naming the same other deployment stop the procedure", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base, [
      { signingDeploymentId: PREVIOUS },
      { signingDeploymentId: PREVIOUS },
      { signingDeploymentId: PREVIOUS },
    ]),
  });
  assert.equal(result.verdict, "halt");
  assert.match(result.reasons.join(" "), /stop rather than opening another round/);
});

test("a file the judge cannot parse has nothing of its contents printed", () => {
  // The operator points at the wrong file -- an exported ring, a saved
  // response. `JSON.parse` puts the offending text in its own message, so the
  // tool that refuses the file used to print what was in it.
  const directory = mkdtempSync(join(tmpdir(), "binding-parse-"));
  const secret = "TEST-RING-SECRET-4f8ad2c1b9";
  const decoy = join(directory, "not-a-summary.json");
  try {
    writeFileSync(decoy, `MOBILE_AUTH_SIGNING_KEYS=sign-2:${secret}\n`, "utf8");
    const base = Math.floor(Date.now() / 1000);
    const others = [1, 2].map((index) => {
      const path = join(directory, `run-${index}.json`);
      writeFileSync(
        path,
        JSON.stringify(sample({ issuedAt: base + index * 200 })),
        "utf8"
      );
      return path;
    });

    const result = spawnSync(process.execPath, [JUDGE, "--round", "1", decoy, ...others], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    const streams = `${result.stdout}${result.stderr}`;
    assert.equal(streams.includes(secret), false, streams);
    assert.equal(streams.includes("MOBILE_AUTH_SIGNING_KEYS=sign-2"), false, streams);
    assert.match(streams, /is not a readable run summary/);
    // The path is the operator's own argument, so naming it tells them nothing
    // they did not type.
    assert.match(streams, /not-a-summary\.json/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the judge reads the verifier's own run files end to end", () => {
  // The round is judged from what the verifier wrote, not from anything a
  // person retyped -- so this exercises the two halves against each other
  // rather than the judge against its own fixture shape.
  const signing = ed25519();
  const directory = mkdtempSync(join(tmpdir(), "binding-round-"));
  try {
    const base = Math.floor(Date.now() / 1000);
    const paths = [0, 1, 2].map((index) => {
      const summaryPath = join(directory, `run-${index}.json`);
      const result = run({
        ...candidate({ signingPkcs8: signing.pkcs8 }),
        ...evidence({
          signing,
          issuedAt: base - 300 + index * MOBILE_BINDING_ROUND_MIN_INTERVAL_SECONDS,
        }),
        MOBILE_AUTH_VERIFY_SUMMARY_PATH: summaryPath,
      });
      assert.equal(result.code, 0, result.stdout);
      return summaryPath;
    });

    const judged = execFileSync(process.execPath, [JUDGE, "--round", "1", ...paths], {
      encoding: "utf8",
    });
    assert.match(judged, /verdict {6}sample_condition_met/);
    assert.match(judged, /illustrative miss probability: 12\.5%/);
    assert.match(judged, /Illustrative value of a model/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a round with both binding axes deleted is not judged as a pass", () => {
  // `passed: true` is one boolean about one run, and it used to be the only
  // thing standing between a summary with no binding at all and
  // `sample_condition_met`.
  const base = Math.floor(Date.now() / 1000);
  const stripped = threeSamples(base).map((entry) => {
    const copy = { ...entry };
    delete copy.signingBinding;
    delete copy.signingDeploymentId;
    delete copy.pepperBinding;
    delete copy.pepperDeploymentId;
    return copy;
  });
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: stripped,
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /has no signingBinding/);
  assert.match(result.reasons.join(" "), /has no pepperDeploymentId/);
});

test("an axis that reports another deployment is not covered by the other axis", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    // The row is bound; the token is not. One bound half is not a bound sample.
    samples: threeSamples(base, [{}, {}, { signingDeploymentId: PREVIOUS, pepperDeploymentId: PENDING }]),
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /signingBinding mismatched, not matched/);
});

test("a file that is not a run summary is refused as a whole, not field by field", () => {
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: [{ some: "other file" }, ...threeSamples(base).slice(1)],
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /is not a tomverse\.mobile-auth-verify\.v1 run summary/);
});

test("expired evidence from another deployment is undetermined, not a reason to stop", () => {
  // Three samples that all name the previous deployment *and* were stale when
  // they were taken. Nothing here says where traffic is going; the remedy is to
  // collect them again. Reported as `halt` before, which is an instruction to
  // stop a rotation on the strength of unjudgeable evidence.
  const base = Math.floor(Date.now() / 1000);
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base, [
      { signingDeploymentId: PREVIOUS, otherFailures: STALE },
      { signingDeploymentId: PREVIOUS, otherFailures: STALE },
      { signingDeploymentId: PREVIOUS, otherFailures: STALE },
    ]),
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /failed a check other than the binding/);
});

test("a token from one deployment beside a row from another does not stop the procedure", () => {
  // Exactly the mixed state this round cannot resolve: the signing half names
  // the old instance and the pepper half the new one. Deciding `halt` on the
  // signing half alone reported that as a settled fact about where traffic goes.
  const base = Math.floor(Date.now() / 1000);
  const split = { signingDeploymentId: PREVIOUS, pepperDeploymentId: PENDING };
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: threeSamples(base, [split, split, split]),
  });
  assert.equal(result.verdict, "undetermined");
  assert.equal(/stop rather than opening another round/.test(result.reasons.join(" ")), false);
});

test("a round file that lost a field is not judged as though it still had it", () => {
  const base = Math.floor(Date.now() / 1000);
  const [first, second, third] = threeSamples(base);
  delete first.tokenExpiresAt;
  const result = judgeMobileBindingRound({
    round: 1,
    judgedAtSeconds: base + 300,
    samples: [first, second, third],
  });
  assert.equal(result.verdict, "undetermined");
  assert.match(result.reasons.join(" "), /sample 1 has no integer tokenExpiresAt/);
});

test("a written round file holds only what the judge needs", () => {
  const signing = ed25519();
  const directory = mkdtempSync(join(tmpdir(), "binding-shape-"));
  const summaryPath = join(directory, "run.json");
  try {
    run({
      ...candidate({ signingPkcs8: signing.pkcs8 }),
      ...evidence({ signing }),
      MOBILE_AUTH_VERIFY_SUMMARY_PATH: summaryPath,
    });
    const written = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.deepEqual(Object.keys(written).sort(), [
      "expectedDeploymentId",
      "failures",
      "mode",
      "passed",
      "pepperBinding",
      "pepperDeploymentId",
      "schema",
      "signingBinding",
      "signingDeploymentId",
      "tokenExpiresAt",
      "tokenIssuedAt",
      "tolerance",
    ]);
    assert.equal(written.passed, true);
    assert.equal(written.signingBinding, "matched");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a round file that cannot be written fails the run, before the evidence is spent", () => {
  // Asked for an artefact and unable to produce one, the run must not exit 0:
  // the next judgement would read whatever is at that path and the caller would
  // have no way to know it was not this run.
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing }),
    MOBILE_AUTH_VERIFY_SUMMARY_PATH: join(tmpdir(), "no-such-directory-here", "run.json"),
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /MOBILE_AUTH_VERIFY_SUMMARY_PATH cannot be written/);
  // Refused before the material was compared, so the exchange is still usable.
  assert.equal(/signing key material/.test(result.stdout), false);
  assert.match(result.stdout, /the exchange you/);
});

test("an interrupted run leaves an unusable file rather than the previous run's", () => {
  const signing = ed25519();
  const directory = mkdtempSync(join(tmpdir(), "binding-stale-"));
  const summaryPath = join(directory, "run.json");
  try {
    // A complete run first: this is the file a later, half-finished run must
    // not leave sitting there.
    const first = run({
      ...candidate({ signingPkcs8: signing.pkcs8 }),
      ...evidence({ signing }),
      MOBILE_AUTH_VERIFY_SUMMARY_PATH: summaryPath,
    });
    assert.equal(first.code, 0, first.stdout);
    assert.equal(JSON.parse(readFileSync(summaryPath, "utf8")).passed, true);

    // Now a run that dies before it can finish -- the rings are unusable, so it
    // exits at the configuration check, after the marker and before a verdict.
    const second = run({
      ...candidate({ signingPkcs8: signing.pkcs8 }),
      ...evidence({ signing }),
      MOBILE_AUTH_SIGNING_KEYS: "sign-2:too-short",
      MOBILE_AUTH_VERIFY_SUMMARY_PATH: summaryPath,
    });
    assert.equal(second.code, 1, second.stdout);

    const left = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(left.incomplete, true);
    assert.equal(left.passed, undefined);

    // And the judge refuses it rather than reading it as a sample.
    const base = Math.floor(Date.now() / 1000);
    const judged = judgeMobileBindingRound({
      round: 1,
      judgedAtSeconds: base + 300,
      samples: [left, ...threeSamples(base).slice(1)],
    });
    assert.equal(judged.verdict, "undetermined");
    assert.match(judged.reasons.join(" "), /incomplete run file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a deployment id is compared as written, and a pasted one is not repaired", () => {
  const signing = ed25519();
  const result = run({
    ...candidate({ signingPkcs8: signing.pkcs8 }),
    ...evidence({ signing }),
    MOBILE_AUTH_VERIFY_DEPLOYMENT_ID: `${PENDING} trailing-word`,
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /MOBILE_AUTH_VERIFY_DEPLOYMENT_ID is not a usable deployment id/);
});
