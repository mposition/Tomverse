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
//   MOBILE_AUTH_VERIFY_MODE                preflight, rotation or emergency --
//                                          required, never defaulted: it decides
//                                          what a failure tells you to do, and an
//                                          emergency has no trustworthy Active to
//                                          roll back to
//   MOBILE_AUTH_VERIFY_MAX_AGE_SECONDS     how old the evidence may be
//                                          (default 900)
//   MOBILE_AUTH_VERIFY_DEPLOYMENT_ID       the deployment the evidence is
//                                          supposed to have come from -- the
//                                          value written by hand onto the
//                                          Pending (or Active) store entry
//   MOBILE_AUTH_VERIFY_MINTED_BY_DEPLOYMENT_ID
//                                          MobileRefreshRotation.mintedByDeploymentId
//                                          off the same row. Unset or empty
//                                          means the row carried NULL
//   MOBILE_AUTH_VERIFY_BINDING_TOLERANCE   open or closed -- required, never
//                                          defaulted (E9). See below
//   MOBILE_AUTH_VERIFY_SUMMARY_PATH        optional: write this run's
//                                          non-secret facts to that path, for
//                                          the three-sample round judge
//
// The binding axis (approved 2026-09-09, evidence-binding packet, option A):
// the access token carries a `dep` claim and the rotation row carries
// `mintedByDeploymentId`, both stamped by the process that produced them from
// its own RAILWAY_DEPLOYMENT_ID. Compared here against the expected id above.
//
// **A match is a self-report measured against a hand-entered expectation.** It
// is not proof that the evidence came from a given Railway deployment, and it
// does not establish that the deployment is stable or that no older instance
// is still serving. It also cannot see reuse (the id is constant for the
// deployment's life) or a repeat submission (nothing here keeps state -- E11's
// record-based detection is approved in direction only and NOT implemented).
//
// The exchange it reads is a real session. Revoke it when you are done --
// the runbook says so at the same step.
//
// Nothing here prints a secret: ids, verdicts and reasons only.
//
// Procedure: docs/ops/mobile-auth-key-rotation.md

import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
  MOBILE_ACTIVE_REFRESH_PEPPER_ENV,
  MOBILE_ACTIVE_SIGNING_KEY_ENV,
  MOBILE_RETIRED_REFRESH_PEPPERS_ENV,
  MOBILE_RETIRED_SIGNING_KEYS_ENV,
  MOBILE_TOKEN_AUDIENCE_ENV,
  MOBILE_TOKEN_ISSUER_ENV,
  activeMobileRefreshPepper,
  activeMobileSigningKey,
  futureDatedMobileRetirements,
  mobileRefreshPepperRetirements,
  mobileSigningKeyById,
  mobileSigningKeyRetirements,
  mobileTokenAudience,
  mobileTokenIssuer,
  normalizeMobileKeyId,
} from "../lib/mobileAuthKeyring.ts";
import { parseCompactJws } from "../lib/mobileAccessToken.ts";
import {
  MOBILE_ACCESS_TOKEN_DEPLOYMENT_CLAIM,
  MOBILE_BINDING_TOLERANCE_STATES,
  mobileBindingVerdict,
  normalizeDeploymentId,
} from "../lib/mobileDeploymentBinding.ts";
import {
  mobileRefreshSecretMatches,
  parseMobileRefreshToken,
} from "../lib/mobileRefreshToken.ts";

const ACCESS_TOKEN_ENV = "MOBILE_AUTH_VERIFY_ACCESS_TOKEN";
const REFRESH_TOKEN_ENV = "MOBILE_AUTH_VERIFY_REFRESH_TOKEN";
const SECRET_DIGEST_ENV = "MOBILE_AUTH_VERIFY_SECRET_DIGEST";
const PEPPER_KID_ENV = "MOBILE_AUTH_VERIFY_PEPPER_KID";
const MAX_AGE_ENV = "MOBILE_AUTH_VERIFY_MAX_AGE_SECONDS";
const MODE_ENV = "MOBILE_AUTH_VERIFY_MODE";
const EXPECTED_DEPLOYMENT_ENV = "MOBILE_AUTH_VERIFY_DEPLOYMENT_ID";
const ROW_DEPLOYMENT_ENV = "MOBILE_AUTH_VERIFY_MINTED_BY_DEPLOYMENT_ID";
const TOLERANCE_ENV = "MOBILE_AUTH_VERIFY_BINDING_TOLERANCE";
const SUMMARY_PATH_ENV = "MOBILE_AUTH_VERIFY_SUMMARY_PATH";

/**
 * How old the evidence may be.
 *
 * Everything below verifies material, and material does not change when a
 * token gets old -- a token this deployment's predecessor minted a week ago
 * verifies against the same key just as well. So a stale token proves the key
 * was right *then*, which is not the question. Fifteen minutes is long enough
 * to collect an exchange and read a row, and short enough that the evidence is
 * from the deployment being checked.
 */
const DEFAULT_MAX_AGE_SECONDS = 900;

/**
 * What to do when a check fails, which is not the same in the three situations
 * the runbook sends people here from.
 *
 *   preflight  before a deploy, against the *Active* values and the deployment
 *              that is running now. A failure means Railway has drifted from
 *              the authority: stop, restore from Active, start again.
 *   rotation   after a deploy, against Pending. There is a trustworthy Active
 *              to go back to.
 *   emergency  after a deploy in section 5.1. There is not -- an untrusted or
 *              lost previous ring is why that procedure is running, so rolling
 *              "back" would restore the ring it abandoned, which in a leak is
 *              the leaked one.
 *
 * **There is no default.** One was `rotation`, and forgetting the flag in an
 * emergency then produced the single most dangerous sentence this script can
 * print. A mode nobody chose is not a mode.
 */
const MODES = new Set(["preflight", "rotation", "emergency"]);

const EVIDENCE = [
  ACCESS_TOKEN_ENV,
  REFRESH_TOKEN_ENV,
  SECRET_DIGEST_ENV,
  PEPPER_KID_ENV,
];

const lines = [];
const failures = [];

/**
 * The non-secret facts of this run, for the three-sample round judge.
 *
 * Written only when MOBILE_AUTH_VERIFY_SUMMARY_PATH is set, so the ordinary run
 * writes nothing to disk. It exists because E5 judges three samples *together*
 * and re-checks all three at judgement time -- doing that from three consoles
 * means retyping `iat` and `exp` off tokens, and a transcription is exactly the
 * step this repository keeps taking away from people.
 *
 * What it holds is bounded on purpose: no token, no digest, no ring, no key id,
 * and **no `jti`**. A round file carrying a token identifier would be the raw
 * material for the duplicate detection of E11, which is approved in direction
 * only -- writing it down now would make it look implemented.
 */
const summary = {
  schema: "tomverse.mobile-auth-verify.v1",
  mode: null,
  tolerance: null,
  expectedDeploymentId: null,
  tokenIssuedAt: null,
  tokenExpiresAt: null,
  signingBinding: null,
  signingDeploymentId: null,
  pepperBinding: null,
  pepperDeploymentId: null,
  failures: [],
  passed: false,
};

const summaryPath = () => (process.env[SUMMARY_PATH_ENV] ?? "").trim();

/**
 * Claims the round file before anything is verified.
 *
 * Two failures this closes. A run that dies part-way used to leave the
 * *previous* run's file sitting at that path, and the round judge would read it
 * as this run's sample. And a path that cannot be written was only discovered
 * after the verification had been done, when the evidence was already spent.
 *
 * So the marker is written first. It parses, it carries the schema, and it says
 * `incomplete`, which the judge refuses -- an interrupted run leaves something
 * unusable rather than something stale.
 */
const prepareSummary = () => {
  const target = summaryPath();
  if (!target) return;
  try {
    writeFileSync(
      target,
      `${JSON.stringify({ schema: summary.schema, incomplete: true }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // The message is dropped: it can carry the path's surroundings, and the
    // path is the operator's own argument anyway.
    console.log("Mobile auth deployment verification");
    console.log(
      `FAIL mobile auth deployment: ${SUMMARY_PATH_ENV} cannot be written.\n` +
        "  Refused before verifying rather than after, so the exchange you\n" +
        "  collected is not spent on a run whose round file could not be kept.\n" +
        "  Create the directory first, or drop the variable if this run is not\n" +
        "  part of a three-sample round."
    );
    process.exit(1);
  }
};

/**
 * Replaces the marker with what this run found.
 *
 * A failure here is the run's failure. The material verdict is unchanged and
 * is still printed, but a run that was asked for a round file and did not
 * produce one must not exit 0 -- the next judgement would then read whatever
 * is at that path, and the caller would have no way to know.
 */
const writeSummary = () => {
  const target = summaryPath();
  if (!target) return true;
  summary.failures = failures.map(({ name, kind }) => ({ name, kind }));
  summary.passed = failures.length === 0;
  try {
    writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
};

/**
 * Why a check failed, which decides the remedy more than the mode does.
 *
 *   evidence  the evidence is unusable -- unparseable, expired, too old. It
 *             says nothing about the deployment, so the answer is to collect
 *             it again, never to undo a deploy.
 *   material  the deployment is not holding what the candidate says. This is
 *             the finding the modes were written for.
 */
const EVIDENCE_FAILURE = "evidence";
const MATERIAL_FAILURE = "material";
/**
 *   binding   the evidence names no deployment at all, after the tolerance for
 *             that closed (E9). Distinct from both of the above: it is not a
 *             mismatch between two known values, and it is not a claim that the
 *             deployed key material is wrong. What it says is that a deployment
 *             which is supposed to stamp its evidence did not.
 */
const BINDING_FAILURE = "binding";

const pass = (name, detail) => lines.push(`  OK    ${name}${detail ? ` -- ${detail}` : ""}`);
const fail = (name, detail, kind = MATERIAL_FAILURE) => {
  failures.push({ name, kind });
  lines.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
};

/**
 * One binding axis, reported the same way for both halves of the evidence.
 *
 * The two halves are separate evidence and are judged separately: binding the
 * token says nothing about the row, and binding the row says nothing about the
 * signature (W8, W9). Nothing here is folded into a single "bound" verdict.
 */
const bindingAxis = (name, evidenceDeploymentId) => {
  const verdict = mobileBindingVerdict({
    evidenceDeploymentId,
    expectedDeploymentId,
    tolerance,
  });
  switch (verdict.outcome) {
    case "matched":
      // Deliberately not "came from that deployment": what was compared is a
      // self-report against a hand-entered expectation.
      pass(name, "the evidence reports the expected deployment id");
      break;
    case "mismatched":
      fail(
        name,
        "the evidence reports a different deployment id -- normal during a rolling " +
          "deploy, so this is evidence to collect again rather than a deployment finding",
        EVIDENCE_FAILURE
      );
      break;
    case "undetermined":
      fail(
        name,
        "the evidence carries no deployment id; the tolerance is open, so this is " +
          "undetermined -- neither a pass nor a defect",
        EVIDENCE_FAILURE
      );
      break;
    case "refused":
      fail(
        name,
        "the evidence carries no deployment id and the tolerance is closed",
        BINDING_FAILURE
      );
      break;
    default:
      // Unreachable: a missing expectation exits before any axis runs. Kept so
      // a future outcome cannot fall through as a pass.
      fail(name, `unhandled binding outcome ${verdict.outcome}`, EVIDENCE_FAILURE);
  }
  return verdict.outcome;
};

const REMEDIES = {
  preflight:
    "  Do NOT deploy. Railway is not running the Active values, so this rotation\n" +
    "  would start from a state the authority does not describe. Restore Railway\n" +
    "  from Active, re-run this check, and only then continue:\n" +
    "  docs/ops/mobile-auth-key-rotation.md section 3",
  rotation:
    "  Do NOT promote Pending to Active. Roll Railway back to Active using the\n" +
    "  deployment id on the Pending entry, and discard this candidate:\n" +
    "  docs/ops/mobile-auth-key-rotation.md",
  emergency:
    "  Do NOT promote Emergency Pending to Active, and do NOT roll back: the\n" +
    "  previous ring is the one this procedure abandoned. Either disable mobile\n" +
    "  auth (remove the six required variables) or roll forward to a new\n" +
    "  candidate: docs/ops/mobile-auth-key-rotation.md section 5.1",
};

/**
 * Evidence that cannot be judged is not a verdict on the deployment.
 *
 * The remedy used to come from the mode alone, so a token that had simply
 * expired -- every id, both rings and both claims correct -- produced "restore
 * Railway from Active", "roll back", or "disable mobile auth". Three different
 * dangerous instructions for a stale copy-paste.
 *
 * **One evidence failure is enough to hold the whole run**, and that is the
 * second version of this rule. The first held only when *every* failure was an
 * evidence one, which still ordered a rollback for the commonest case there
 * is: evidence minted by the previous key, eight days old, compared against a
 * new candidate. Of course the material differs -- it was made with a
 * different key. The mismatch is a fact about the evidence, not about the
 * deployment, and there is no way to tell those apart once the evidence is
 * stale. So a material finding standing next to an evidence failure is not
 * attributable to the deployment, and the run decides nothing.
 */
const EVIDENCE_REMEDY =
  "  Nothing was decided about the deployment: the evidence could not be judged.\n" +
  "  Any mismatch above is a fact about this evidence, not about what is\n" +
  "  running -- evidence minted under an earlier key differs from a new\n" +
  "  candidate because it was made with a different key, not because the deploy\n" +
  "  went wrong.\n" +
  "  Do NOT promote, roll back, restore or disable anything on the strength of\n" +
  "  this run. Collect a fresh exchange against the deployment -- an access\n" +
  "  token, its refresh token, and the MobileRefreshRotation row they created --\n" +
  "  and run this again: docs/ops/mobile-auth-key-rotation.md";

/**
 * Evidence with no deployment identifier, once the tolerance has closed.
 *
 * Two things could produce it and this run cannot tell them apart: evidence
 * older than the change, or a running deployment that is not stamping. So the
 * remedy names the one action that distinguishes them, and refuses to promote
 * either way -- E9 accepted that a legitimate older piece of evidence gets
 * refused here, which is the whole cost of closing the tolerance.
 */
const BINDING_REMEDY =
  "  Do NOT promote. The evidence names no deployment, and the tolerance for\n" +
  "  that has closed: the Active generation is one that stamps its evidence, so\n" +
  "  evidence without an identifier is refused.\n" +
  "  Two causes look identical here -- evidence collected before the change, or\n" +
  "  a running deployment that is not stamping. Collect a fresh exchange against\n" +
  "  the deployment. If the new evidence still carries no identifier, the\n" +
  "  deployment is not running the code the Active entry describes:\n" +
  "  docs/ops/mobile-auth-key-rotation.md";

/**
 * Which remedy, in order of how little the run established.
 *
 * Evidence first: if the evidence could not be judged, nothing else in the run
 * is attributable to the deployment. Binding second: it is a finding, but not
 * one the mode's rollback instructions fit. The mode's own remedy is last.
 */
const remedy = (mode) => {
  if (failures.some((failure) => failure.kind === EVIDENCE_FAILURE)) return EVIDENCE_REMEDY;
  if (failures.some((failure) => failure.kind === BINDING_FAILURE)) return BINDING_REMEDY;
  return REMEDIES[mode];
};

const report = (mode) => {
  console.log("Mobile auth deployment verification");
  for (const line of lines) console.log(line);
  console.log("");
  if (failures.length === 0) {
    // Scoped deliberately. What was compared is the evidence handed in against
    // the candidate material -- nothing here ties that evidence to the
    // deployment now running, because nothing in the token or the row names a
    // deployment. Saying "the running deployment holds the candidate material"
    // claimed exactly the binding that is still an open decision.
    console.log(
      "PASS mobile auth deployment: the evidence provided was produced with the " +
        "candidate active signing key and active pepper, under the candidate " +
        "iss/aud, and both halves report the expected deployment id.\n" +
        "  What the binding establishes: the processes that signed the token and\n" +
        "  wrote the row each read that identifier out of their own environment,\n" +
        "  and it equals the value a person typed onto the store entry. It is a\n" +
        "  self-report against a hand-entered expectation -- NOT proof that this\n" +
        "  evidence came from that Railway deployment.\n" +
        "  NOT established: that the deployment is stable, or that no older\n" +
        "  instance is still serving. One sample says nothing about that; the\n" +
        "  three-sample round is a separate step and does not prove it either.\n" +
        "  NOT caught: reuse of older evidence from the same deployment (the id is\n" +
        "  constant for its life -- freshness is what bounds that), and the same\n" +
        "  evidence submitted twice (nothing here keeps state).\n" +
        "  NOT covered: retired entries and any other ring member; see the\n" +
        "  runbook's previous-generation check.\n" +
        "  This result alone does not satisfy the promotion condition:\n" +
        "  docs/ops/mobile-auth-key-rotation.md"
    );
    return 0;
  }
  console.log(
    `FAIL mobile auth deployment: ${failures.length} check(s) failed ` +
      `(${failures.map((failure) => failure.name).join(", ")}).\n` +
      remedy(mode)
  );
  return 1;
};

const mode = (process.env[MODE_ENV] ?? "").trim();
if (!MODES.has(mode)) {
  console.log("Mobile auth deployment verification");
  console.log(
    `FAIL mobile auth deployment: ${MODE_ENV} is ${mode === "" ? "not set" : `"${mode}"`}; ` +
      `it must be one of ${[...MODES].join(", ")}.\n` +
      "  The mode decides what a failure tells you to do, so it is required rather\n" +
      "  than defaulted: an emergency run that forgot the flag used to be told to\n" +
      "  roll back to the ring it had just abandoned."
  );
  process.exit(1);
}

const tolerance = (process.env[TOLERANCE_ENV] ?? "").trim();
if (!MOBILE_BINDING_TOLERANCE_STATES.includes(tolerance)) {
  console.log("Mobile auth deployment verification");
  console.log(
    `FAIL mobile auth deployment: ${TOLERANCE_ENV} is ${tolerance === "" ? "not set" : `"${tolerance}"`}; ` +
      `it must be one of ${MOBILE_BINDING_TOLERANCE_STATES.join(", ")}.\n` +
      "  It says whether evidence carrying no deployment identifier is undetermined\n" +
      "  (open -- Active predates the binding) or refused (closed -- Active is a\n" +
      "  generation that stamps its evidence). That is a fact about the store, not\n" +
      "  about this process, so it is required rather than defaulted: a default\n" +
      "  would have to be `open`, and `open` is wrong on exactly the runs where the\n" +
      "  tolerance has ended."
  );
  process.exit(1);
}

summary.mode = mode;
summary.tolerance = tolerance;

const maxAgeRaw = (process.env[MAX_AGE_ENV] ?? "").trim();
const maxAgeSeconds = maxAgeRaw === "" ? DEFAULT_MAX_AGE_SECONDS : Number(maxAgeRaw);
if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
  console.log("Mobile auth deployment verification");
  console.log(`FAIL mobile auth deployment: ${MAX_AGE_ENV} is not a positive number of seconds.`);
  process.exit(1);
}

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

// The expected identifier. Hand-entered from the store entry (E6), and that
// stays true of the verdict: what a match establishes is that the evidence
// reports the same value a person typed, not that either is the deployment.
const expectedDeploymentId = normalizeDeploymentId(process.env[EXPECTED_DEPLOYMENT_ENV]);
if (!expectedDeploymentId) {
  console.log("Mobile auth deployment verification");
  console.log(
    `FAIL mobile auth deployment: ${EXPECTED_DEPLOYMENT_ENV} is not a usable deployment id.\n` +
      "  Take it from the deployment id recorded on the store entry this run is\n" +
      "  checking -- Pending for a rotation, Active for a preflight:\n" +
      "  docs/ops/mobile-auth-key-rotation.md section 3"
  );
  process.exit(1);
}

summary.expectedDeploymentId = expectedDeploymentId;

prepareSummary();

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

// A retirement that has not arrived yet is not a retirement, and the key it
// names verifies nothing. The pre-deploy check refuses one; repeated here
// because this script is the last thing between a bad candidate and a
// promotion to Active, and the candidate rings are right here.
const nowMs = Date.now();
for (const [variable, retirements] of [
  [MOBILE_RETIRED_SIGNING_KEYS_ENV, mobileSigningKeyRetirements(process.env)],
  [MOBILE_RETIRED_REFRESH_PEPPERS_ENV, mobileRefreshPepperRetirements(process.env)],
]) {
  const misdated = futureDatedMobileRetirements(retirements, nowMs);
  if (misdated.length === 0) {
    pass(`${variable} instants have arrived`);
    continue;
  }
  fail(
    `${variable} instants have arrived`,
    misdated
      .map(({ keyId, retiredAtMs }) => `${keyId} is retired at ${new Date(retiredAtMs).toISOString()}`)
      .join("; ") + " -- a retirement records when trust was withdrawn, so that is in the future"
  );
}

const parsed = parseCompactJws((process.env[ACCESS_TOKEN_ENV] ?? "").trim());
if (!parsed) {
  fail("access token parses", "not a three-segment compact JWS", EVIDENCE_FAILURE);
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

  // Freshness. Everything above compares material, and material does not age:
  // a token minted a week ago by a deployment that is no longer running
  // verifies against the same key exactly as well. Without this, evidence kept
  // from a previous rotation passes every check and proves nothing about the
  // deployment in front of us. An expired token (`exp` in the past) is the
  // loud version of the same problem.
  const nowSeconds = Math.floor(nowMs / 1000);
  const exp = typeof parsed.claims.exp === "number" ? parsed.claims.exp : null;
  const iat = typeof parsed.claims.iat === "number" ? parsed.claims.iat : null;

  if (exp === null || iat === null) {
    fail(
      "evidence is fresh",
      "the token carries no numeric iat/exp to judge age by",
      EVIDENCE_FAILURE
    );
  } else if (exp <= nowSeconds) {
    fail(
      "evidence is fresh",
      `the token expired at ${new Date(exp * 1000).toISOString()} -- collect a new exchange against the deployment`,
      EVIDENCE_FAILURE
    );
  } else if (nowSeconds - iat > maxAgeSeconds) {
    fail(
      "evidence is fresh",
      `the token was issued ${nowSeconds - iat}s ago, over the ${maxAgeSeconds}s limit (${MAX_AGE_ENV})`,
      EVIDENCE_FAILURE
    );
  } else if (iat > nowSeconds + 60) {
    fail(
      "evidence is fresh",
      "the token is issued in the future; check the clocks",
      EVIDENCE_FAILURE
    );
  } else {
    pass("evidence is fresh", `issued ${nowSeconds - iat}s ago`);
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

  // A1. Additive: the freshness and material axes above still have to pass on
  // their own, and this one does not stand in for either (W5, W6).
  summary.tokenIssuedAt = iat;
  summary.tokenExpiresAt = exp;
  summary.signingDeploymentId = normalizeDeploymentId(
    parsed.claims[MOBILE_ACCESS_TOKEN_DEPLOYMENT_CLAIM]
  );
  summary.signingBinding = bindingAxis(
    "signing binding",
    parsed.claims[MOBILE_ACCESS_TOKEN_DEPLOYMENT_CLAIM]
  );
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
  fail("refresh token parses", "expected <recordId>.<secret>", EVIDENCE_FAILURE);
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

// A2. The row's own stamp, judged separately from the token's: one half being
// bound says nothing about the other.
summary.pepperDeploymentId = normalizeDeploymentId(process.env[ROW_DEPLOYMENT_ENV]);
summary.pepperBinding = bindingAxis("pepper binding", process.env[ROW_DEPLOYMENT_ENV]);

const summaryWritten = writeSummary();

const code = report(mode);
if (!summaryWritten) {
  // Printed after the verdict, and separately from it: what was verified is
  // still what was verified, and this says only that the artefact the run was
  // asked to produce is not there.
  console.log("");
  console.log(
    `FAIL mobile auth deployment: the verdict above stands, but ${SUMMARY_PATH_ENV}\n` +
      "  could not be written, so this run left no round file. Whatever is at\n" +
      "  that path is not this run. Do not judge a round with it -- fix the path\n" +
      "  and collect this sample again."
  );
  process.exit(1);
}

process.exit(code);
