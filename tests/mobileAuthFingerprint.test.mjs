// The approved keyring fingerprint, vector by vector.
//
// Rule and vectors: `.github/audits/2026-09-08-mobile-auth-fingerprint-rule-
// approval.md` sections 5, 5.6 and 10. First tranche only -- D1 · D2 · D2a-D2d
// · D3 · D5 · D7 · D10 · D11, approved 2026-09-08. The second tranche (D4 ·
// D6 · D6a · D8 · D9) is NOT approved, so nothing here implements a
// recomputation procedure or an emergency exemption: the four regression cases
// record what the store-entry checker already answers and stop there.
//
// Each test names the vector it is. Where a vector needs more than one
// assertion the assertions stay in that one test, so the count of tests and
// the count of vectors can be compared without a table.

import assert from "node:assert/strict";
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  MOBILE_FINGERPRINT_KEY_BYTES,
  MOBILE_FINGERPRINT_RULE_ID,
  MobileFingerprintError,
  mobileFingerprintAlgorithm,
  mobileFingerprintKeyFromBase64,
  mobileKeyringFingerprint,
  mobileKeyringFingerprintEntry,
  mobileKeyringFingerprintFromMaterials,
} from "../scripts/mobile-auth-fingerprint-core.mjs";
import {
  mobileStoreEntryProblems,
  mobileStorePairProblems,
} from "../scripts/mobile-auth-store-entry-core.mjs";
import {
  mobileRefreshPepperRing,
  mobileSigningKeyring,
} from "../lib/mobileAuthKeyring.ts";

// --- the approved fixtures (section 5.6) -----------------------------------

const K = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const spki = (publicHex) =>
  Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicHex, "hex")]);
const SIG_A = spki("aa".repeat(32));
const SIG_B = spki("aa".repeat(31) + "ab");
const PEP_A = Buffer.from("pepper-alpha-0000000000000000000", "utf8");
const PEP_B = Buffer.from("pepper-bravo-0000000000000000000", "utf8");

/** The six published values. */
const FIXED = {
  "{SIG_A} x {PEP_A}": "8a05e20970a70b8d0124b727c87bc51daa769044172d80020429fcc9b7e29e62",
  "{SIG_B} x {PEP_A}": "3e4df6937a4fbce83171905b4835c44610118d9e45f50999f2e15d7c63fbcc35",
  "{SIG_A} x {PEP_A,PEP_B}": "3ffa49717df53831a5efbb07ad273b0bc87d86c437b1dc351079f4fc9d1654ec",
  "{SIG_A,SIG_B} x {PEP_A}": "8c3a76db02fe1b6e6805fc4f100bd8a50780763ab9eb0fde35044d0b67b43626",
  "little-endian counts": "9afbf112ddc135f4b357370dabeb1e136d06a6d13f4ba7779ead1733fbfe4b91",
};

const fromMaterials = (signingMaterials, pepperMaterials) =>
  mobileKeyringFingerprintFromMaterials({ key: K, signingMaterials, pepperMaterials });

// Real keys, for the derivation step the published vectors cannot cover.
const privateKey = () =>
  generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const SIGN_1 = privateKey();
const SIGN_2 = privateKey();
const SIGN_3 = privateKey();
const PEPPER_1 = "pepper-one-000000000000000000000";
const PEPPER_2 = "pepper-two-000000000000000000000";

const ring = (signing, peppers) =>
  mobileKeyringFingerprint({ key: K, signing, peppers });

// --- 1차: 계산기 -----------------------------------------------------------

test("V1  the same input twice gives the same value", () => {
  assert.equal(fromMaterials([SIG_A], [PEP_A]), fromMaterials([SIG_A], [PEP_A]));
  assert.equal(ring([SIGN_1], [PEPPER_1]), ring([SIGN_1], [PEPPER_1]));
});

test("V2  the order entries appear in does not change the value", () => {
  // The leaves are sorted, and ids are not in the input, so the ring's written
  // order cannot reach the result.
  assert.equal(
    fromMaterials([SIG_A, SIG_B], [PEP_A, PEP_B]),
    fromMaterials([SIG_B, SIG_A], [PEP_B, PEP_A])
  );
});

test("V3  renaming an entry leaves the value unchanged", () => {
  // The reason the pair check can catch "renamed instead of rotated": the id
  // is not part of what is hashed.
  const named = new Map([["sign-old", SIGN_1]]);
  const renamed = new Map([["sign-older", SIGN_1]]);
  assert.equal(
    mobileKeyringFingerprint({ key: K, signing: named, peppers: new Map([["pep-1", PEPPER_1]]) }),
    mobileKeyringFingerprint({ key: K, signing: renamed, peppers: new Map([["pep-1", PEPPER_1]]) })
  );
});

test("V4  one byte of signing material, or one character of a pepper, changes it", () => {
  assert.notEqual(fromMaterials([SIG_A], [PEP_A]), fromMaterials([SIG_B], [PEP_A]));
  assert.notEqual(
    fromMaterials([SIG_A], [PEP_A]),
    fromMaterials([SIG_A], [Buffer.from("Pepper-alpha-0000000000000000000", "utf8")])
  );
  // And through the real derivation, two different private keys differ.
  assert.notEqual(ring([SIGN_1], [PEPPER_1]), ring([SIGN_2], [PEPPER_1]));
});

test("V5  a grace-expired cleanup changes the value, so it is not a false refusal", () => {
  // Section 3.1 removes the retired entry and keeps the active key. Scoped to
  // the active key alone the two would be equal and the pair check would call
  // a legitimate cleanup "not a rotation".
  const before = ring([SIGN_1, SIGN_2], [PEPPER_1]);
  const after = ring([SIGN_2], [PEPPER_1]);
  assert.notEqual(before, after);
});

test("V6  the domain tag keeps a signing leaf and a pepper leaf apart", () => {
  // Same two byte strings, swapped between the rings. The counts are identical
  // (1 and 1), so only the tag can separate them -- drop it and the leaf
  // multiset is the same and the roots collide.
  const x = Buffer.from("x".repeat(40), "utf8");
  const y = Buffer.from("y".repeat(40), "utf8");
  assert.notEqual(fromMaterials([x], [y]), fromMaterials([y], [x]));
});

test("V7  regrouping entries between the rings changes the value", () => {
  const a = Buffer.from("a".repeat(40), "utf8");
  const b = Buffer.from("b".repeat(40), "utf8");
  const c = Buffer.from("c".repeat(40), "utf8");
  // Different, and the reason is the domain tag rather than the counts: b
  // moves between rings, so its leaf changes on its own.
  assert.notEqual(fromMaterials([a], [b, c]), fromMaterials([a, b], [c]));
});

test("V8  a different key gives a different value, and the identifier says so", () => {
  const other = Buffer.alloc(MOBILE_FINGERPRINT_KEY_BYTES, 9);
  assert.notEqual(
    fromMaterials([SIG_A], [PEP_A]),
    mobileKeyringFingerprintFromMaterials({
      key: other,
      signingMaterials: [SIG_A],
      pepperMaterials: [PEP_A],
    })
  );
  assert.equal(mobileFingerprintAlgorithm("k1"), `${MOBILE_FINGERPRINT_RULE_ID}/k1`);
  assert.notEqual(mobileFingerprintAlgorithm("k1"), mobileFingerprintAlgorithm("k2"));
});

test("V9  a space after the colon is part of the pepper", () => {
  // `parseRing()` splits at the first colon and keeps what follows verbatim.
  const withSpace = mobileRefreshPepperRing({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1: ${PEPPER_1}`,
  });
  const without = mobileRefreshPepperRing({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1}`,
  });
  assert.equal(withSpace.get("pep-1"), ` ${PEPPER_1}`);
  assert.notEqual(ring([SIGN_1], withSpace), ring([SIGN_1], without));
});

test("V9a trailing whitespace on an entry is gone before the fingerprint sees it", () => {
  // The rule's input is what the parser returns, not what was typed: the
  // parser trims the whole entry, so the runtime uses the trimmed secret and
  // the fingerprint has to describe that same value.
  const padded = mobileRefreshPepperRing({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1}   `,
  });
  const plain = mobileRefreshPepperRing({
    MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${PEPPER_1}`,
  });
  assert.equal(padded.get("pep-1"), PEPPER_1);
  assert.equal(ring([SIGN_1], padded), ring([SIGN_1], plain));
});

test("V10 unusable signing material fails the calculation instead of standing in for one", () => {
  // Not an empty string, not a zero digest: a value that means "this went
  // wrong" would compare equal to every other thing that went wrong.
  assert.throws(
    () => ring(["not-a-key"], [PEPPER_1]),
    (error) => error instanceof MobileFingerprintError && /usable PKCS#8/.test(error.message)
  );
});

test("V11 the value is 64 lowercase hex characters and the entry contract accepts it", () => {
  const value = ring([SIGN_1], [PEPPER_1]);
  assert.match(value, /^[0-9a-f]{64}$/);
  const entry = {
    kind: "active",
    phase: "deployed",
    rotationId: "rot-2026-09-08-a",
    createdAt: "2026-09-08T12:00:00Z",
    fingerprint: { algorithm: mobileFingerprintAlgorithm("k1"), value },
    targetSha: "a".repeat(40),
    deploymentId: "11111111-1111-1111-1111-111111111111",
  };
  assert.deepEqual(mobileStoreEntryProblems(entry, "e"), []);
});

test("V12 nothing the calculator returns or throws carries key material", () => {
  const secret = "pepper-synthetic-00000000000000";
  const material = `${secret}-and-more`;

  // Success: the output is a digest, and the material is not in it.
  const value = ring([SIGN_1], [material]);
  assert.equal(value.includes(secret), false);

  // Failure: the message names the problem, not the value.
  let message = "";
  try {
    ring([material], [PEPPER_1]);
  } catch (error) {
    message = `${error.message}${error.stack ?? ""}`;
  }
  assert.notEqual(message, "");
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes(SIGN_1.slice(0, 24)), false);

  // And the key itself is never quoted.
  let keyMessage = "";
  try {
    mobileFingerprintKeyFromBase64(Buffer.alloc(8, 7).toString("base64"));
  } catch (error) {
    keyMessage = error.message;
  }
  assert.match(keyMessage, /32 bytes/);
  assert.equal(keyMessage.includes(Buffer.alloc(8, 7).toString("base64")), false);
});

test("V14 the three ordinary procedures are not refused as 'the same material'", () => {
  const cases = [
    ["section 3 signing rotation", [[SIGN_1], [PEPPER_1]], [[SIGN_1, SIGN_2], [PEPPER_1]]],
    ["section 4 pepper rotation", [[SIGN_1], [PEPPER_1]], [[SIGN_1], [PEPPER_1, PEPPER_2]]],
    ["section 3.1 cleanup", [[SIGN_1, SIGN_2], [PEPPER_1]], [[SIGN_2], [PEPPER_1]]],
  ];
  for (const [name, active, pending] of cases) {
    const activeValue = ring(...active);
    const pendingValue = ring(...pending);
    assert.notEqual(activeValue, pendingValue, name);
    const problems = mobileStorePairProblems({
      active: storeEntry({ kind: "active", value: activeValue }),
      pending: storeEntry({ kind: "pending", value: pendingValue, second: true }),
    });
    assert.deepEqual(problems, [], name);
  }
});

test("V14a a section 5.1 replacement under the same key generation is not refused", () => {
  const activeValue = ring([SIGN_1], [PEPPER_1]);
  const pendingValue = ring([SIGN_3], [PEPPER_2]);
  assert.notEqual(activeValue, pendingValue);
  assert.deepEqual(
    mobileStorePairProblems({
      active: storeEntry({ kind: "active", value: activeValue }),
      pending: storeEntry({ kind: "emergency-pending", value: pendingValue, second: true }),
    }),
    []
  );
});

test("V15 the ring is read by the runtime parser, including a pepper with a colon", () => {
  // A pepper may contain a colon -- that is why retirements are a separate
  // variable -- and only the runtime parser splits at the *first* one. A
  // second parser would disagree here, and the fingerprint would describe a
  // value the runtime never uses.
  const secret = "pep:with:colons-0000000000000000";
  const parsed = mobileRefreshPepperRing({ MOBILE_AUTH_REFRESH_PEPPERS: `pep-1:${secret}` });
  assert.equal(parsed.get("pep-1"), secret);
  assert.equal(ring([SIGN_1], parsed), ring([SIGN_1], [secret]));

  const keys = mobileSigningKeyring({ MOBILE_AUTH_SIGNING_KEYS: `sign-1:${SIGN_1}` });
  assert.equal(ring(keys, [PEPPER_1]), ring([SIGN_1], [PEPPER_1]));
});

test("V17a the signing material is the derived public key, not the private one", () => {
  // The published vectors name an SPKI directly, so no PKCS#8 key derives to
  // them and they cannot cover step 2 at all. Without this, an implementation
  // that hashed the private key would reproduce every one of them -- checked
  // by mutation, and it did.
  //
  // It matters beyond conformance: hashing the public half is why the signing
  // side of the fingerprint leaks nothing (rule section 3).
  const derived = createPublicKey(
    createPrivateKey({ key: Buffer.from(SIGN_1, "base64"), format: "der", type: "pkcs8" })
  ).export({ format: "der", type: "spki" });

  assert.equal(ring([SIGN_1], [PEPPER_1]), fromMaterials([derived], [Buffer.from(PEPPER_1, "utf8")]));
  assert.notEqual(
    ring([SIGN_1], [PEPPER_1]),
    fromMaterials([Buffer.from(SIGN_1, "base64")], [Buffer.from(PEPPER_1, "utf8")])
  );
});

test("V16 little-endian counts produce the published contrast value, not the real one", () => {
  const leaf = (tag, material) =>
    createHmac("sha256", K)
      .update(Buffer.concat([Buffer.from(tag, "ascii"), Buffer.from([0]), material]))
      .digest();
  const uint32le = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const wrong = createHmac("sha256", K)
    .update(
      Buffer.concat([
        Buffer.from(MOBILE_FINGERPRINT_RULE_ID, "ascii"),
        Buffer.from([0]),
        uint32le(1),
        uint32le(1),
        ...[leaf("sig", SIG_A), leaf("pep", PEP_A)].sort(Buffer.compare),
      ])
    )
    .digest("hex");
  assert.equal(wrong, FIXED["little-endian counts"]);
  assert.notEqual(wrong, FIXED["{SIG_A} x {PEP_A}"]);
});

test("V17 the six published values are reproduced", () => {
  assert.equal(fromMaterials([SIG_A], [PEP_A]), FIXED["{SIG_A} x {PEP_A}"]);
  // The same input with the ring order swapped: the same value, which is the
  // second published line.
  assert.equal(fromMaterials([SIG_A], [PEP_A]), fromMaterials([SIG_A], [PEP_A]));
  assert.equal(fromMaterials([SIG_B], [PEP_A]), FIXED["{SIG_B} x {PEP_A}"]);
  assert.equal(fromMaterials([SIG_A], [PEP_A, PEP_B]), FIXED["{SIG_A} x {PEP_A,PEP_B}"]);
  assert.equal(fromMaterials([SIG_A, SIG_B], [PEP_A]), FIXED["{SIG_A,SIG_B} x {PEP_A}"]);
});

// --- 1차: the key's own conditions (D2b, D2c) ------------------------------

test("the key is the decoded bytes of what is stored, at the approved length", () => {
  const base64 = K.toString("base64");
  assert.deepEqual(mobileFingerprintKeyFromBase64(base64), K);

  // Using the base64 *string* as the key is a different calculation, which is
  // the ambiguity D2c settles.
  const asString = createHmac("sha256", base64).update("x").digest("hex");
  const asBytes = createHmac("sha256", K).update("x").digest("hex");
  assert.notEqual(asString, asBytes);

  assert.throws(() => mobileFingerprintKeyFromBase64(Buffer.alloc(16).toString("base64")), MobileFingerprintError);
  assert.throws(() => mobileFingerprintKeyFromBase64(""), MobileFingerprintError);
  assert.throws(() => mobileFingerprintKeyFromBase64("not base64!!"), MobileFingerprintError);
  assert.throws(
    () => mobileKeyringFingerprint({ key: K.toString("base64"), signing: [SIGN_1], peppers: [PEPPER_1] }),
    MobileFingerprintError
  );
  // The length is enforced by the calculator too, not only by the decoder --
  // a caller holding raw bytes must not be able to walk past it.
  assert.throws(
    () => mobileKeyringFingerprint({ key: Buffer.alloc(16, 3), signing: [SIGN_1], peppers: [PEPPER_1] }),
    MobileFingerprintError
  );
  assert.throws(
    () =>
      mobileKeyringFingerprintFromMaterials({
        key: Buffer.alloc(64, 3),
        signingMaterials: [SIG_A],
        pepperMaterials: [PEP_A],
      }),
    MobileFingerprintError
  );
});

test("the generation label is only constrained by the identifier's own syntax", () => {
  // Its exact format is not part of the approved rule. What is enforced is
  // what `/` as a separator forces, and nothing narrower.
  assert.equal(mobileFingerprintAlgorithm("k1"), "tv-mobile-keyring-fp-1/k1");
  assert.equal(mobileFingerprintAlgorithm("2026-09-08"), "tv-mobile-keyring-fp-1/2026-09-08");
  assert.throws(() => mobileFingerprintAlgorithm(""), MobileFingerprintError);
  assert.throws(() => mobileFingerprintAlgorithm("k1/k2"), MobileFingerprintError);
  assert.throws(() => mobileFingerprintAlgorithm("k 1"), MobileFingerprintError);
});

test("an entry carries the value and the identifier that scopes it", () => {
  const entry = mobileKeyringFingerprintEntry({
    key: K,
    generation: "k1",
    signing: [SIGN_1],
    peppers: [PEPPER_1],
  });
  assert.equal(entry.algorithm, "tv-mobile-keyring-fp-1/k1");
  assert.match(entry.value, /^[0-9a-f]{64}$/);
});

// --- 기존 회귀: what the checker already answers ---------------------------
//
// These four record the store-entry checker's current diagnostics. **How to
// treat that answer -- exempt it, hold it, judge it on what -- is D9, which is
// not approved**, so nothing below decides it.

function storeEntry({ kind, value, generation = "k1", second = false }) {
  const base = {
    kind,
    phase: kind === "active" ? "deployed" : "drafted",
    rotationId: second ? "rot-2026-09-08-b" : "rot-2026-09-08-a",
    createdAt: second ? "2026-09-08T13:00:00Z" : "2026-09-08T12:00:00Z",
    fingerprint: { algorithm: mobileFingerprintAlgorithm(generation), value },
    targetSha: (second ? "b" : "a").repeat(40),
  };
  if (kind === "active") base.deploymentId = "11111111-1111-1111-1111-111111111111";
  return base;
}

test("V13 two entries under different algorithms are undetermined, not different", () => {
  const problems = mobileStorePairProblems({
    active: storeEntry({ kind: "active", value: "a".repeat(64), generation: "k1" }),
    pending: storeEntry({ kind: "pending", value: "b".repeat(64), generation: "k2", second: true }),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /different fingerprint algorithms/);
  assert.match(problems[0], /undetermined/);
});

test("V14b a section 5.1 replacement across key generations is refused with one diagnostic", () => {
  const problems = mobileStorePairProblems({
    active: storeEntry({ kind: "active", value: ring([SIGN_1], [PEPPER_1]), generation: "k1" }),
    pending: storeEntry({
      kind: "emergency-pending",
      value: ring([SIGN_3], [PEPPER_2]),
      generation: "k2",
      second: true,
    }),
  });
  // One diagnostic, and that is the whole of what this records.
  assert.equal(problems.length, 1);
  assert.match(problems[0], /different fingerprint algorithms/);
});

test("V14c the same sentence covers three different situations", () => {
  const active = storeEntry({ kind: "active", value: "a".repeat(64), generation: "k1" });
  const cases = [
    storeEntry({ kind: "emergency-pending", value: "b".repeat(64), generation: "k2", second: true }),
    { ...storeEntry({ kind: "emergency-pending", value: "b".repeat(64), second: true }),
      fingerprint: { algorithm: "tv-mobile-keyring-fp-2/k2", value: "b".repeat(64) } },
    storeEntry({ kind: "pending", value: "b".repeat(64), generation: "k2", second: true }),
  ];
  const messages = cases.map((pending) => {
    const problems = mobileStorePairProblems({ active, pending });
    assert.equal(problems.length, 1);
    return problems[0];
  });
  assert.equal(new Set(messages).size, 1, "the three situations do not share one message");
});

test("V18 an Active at k1 against a candidate at k2 is refused today", () => {
  const problems = mobileStorePairProblems({
    active: storeEntry({ kind: "active", value: "a".repeat(64), generation: "k1" }),
    pending: storeEntry({ kind: "emergency-pending", value: "b".repeat(64), generation: "k2", second: true }),
  });
  assert.equal(problems.length, 1);
});
