import assert from "node:assert/strict";
import test from "node:test";

import { KEY_ENVELOPE, keyRecoveryProblems } from "../lib/routerHumanReviewSource.ts";

const FINGERPRINT = "sha256:eaf8c01f47eecdef3c6f1ad00849f899c7348bf8e20a142bebf1afd653726fe5";
const OTHER = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const verified = {
  verifiedBy: "R-OP",
  verifiedAt: "2026-08-31T00:00:00Z",
  recipientKeyFingerprint: FINGERPRINT,
  probeSha256: "sha256:bbf66999b84010cbcd19045ef2f34451dfd389e619528858f2036648c1d9892e",
  probeRunId: "33341270395",
};

test("a draw with nobody able to open the key is refused", () => {
  const problems = keyRecoveryProblems({ keyRecovery: null }, { recipientKeyFingerprint: FINGERPRINT });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /recovery-probe workflow/);
  assert.match(problems[0], /a key nobody has proved they can open is a key nobody can open/);
});

test("a completed recovery against the committed key permits the draw", () => {
  assert.deepEqual(
    keyRecoveryProblems({ keyRecovery: verified }, { recipientKeyFingerprint: FINGERPRINT }),
    []
  );
});

// The reason the fingerprint is in the record at all: swapping the public key
// after somebody proved recovery would otherwise carry their proof onto a key
// they have never held the private half of.
test("a recovery proved against a key that has since been replaced does not carry", () => {
  const problems = keyRecoveryProblems({ keyRecovery: verified }, { recipientKeyFingerprint: OTHER });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /the key was replaced after it was verified/i);
});

test("every field of the record is required, and named when missing", () => {
  for (const field of Object.keys(verified)) {
    const partial = { ...verified, [field]: "" };
    const problems = keyRecoveryProblems(
      { keyRecovery: partial },
      { recipientKeyFingerprint: FINGERPRINT }
    );
    assert.deepEqual(problems, [`the keyRecovery record has no ${field}`], `for ${field}`);
  }
});

// A missing field must not be reported as a fingerprint mismatch: the operator
// would go looking for a key swap that never happened.
test("a record missing its fingerprint reports the missing field, not a mismatch", () => {
  const problems = keyRecoveryProblems(
    { keyRecovery: { ...verified, recipientKeyFingerprint: "" } },
    { recipientKeyFingerprint: FINGERPRINT }
  );
  assert.deepEqual(problems, ["the keyRecovery record has no recipientKeyFingerprint"]);
});

// These parameters are what a recipient needs and what OpenSSL will not tell
// them: an OAEP ciphertext "decrypts" under the PKCS#1 v1.5 default, returning
// garbage rather than an error.
test("the envelope pins the padding rather than leaving it to a default", () => {
  assert.equal(KEY_ENVELOPE.keyTransport, "rsa-oaep");
  assert.equal(KEY_ENVELOPE.keyTransportHash, "sha256");
  assert.equal(KEY_ENVELOPE.keyTransportMgf1Hash, "sha256");
  assert.equal(KEY_ENVELOPE.payloadCipher, "aes-256-cbc");
  assert.equal(KEY_ENVELOPE.payloadKdfIterations, 600_000);
  assert.match(KEY_ENVELOPE.version, /^router-human-review-key-envelope-v\d+$/);
});

// The defect v2 exists for: `openssl enc -pass file:` reads the first LINE of
// the key file, so raw random bytes are read differently depending on what the
// randomness produced, and differently again by a Windows text-mode read (0x1a
// is EOF there). A byte-identical file then yields two different passphrases
// and the recipient sees "bad decrypt" with nothing visibly wrong.
test("the payload key is written text-safe, so every platform reads the whole of it", () => {
  assert.equal(KEY_ENVELOPE.payloadKeyEncoding, "base64-no-newline");
  // base64's alphabet is exactly what makes the guarantee: no byte in it can
  // end a line or an MS-DOS text read.
  const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  for (const byte of [0x0a, 0x0d, 0x1a]) {
    assert.ok(
      !base64Alphabet.includes(String.fromCharCode(byte)),
      `0x${byte.toString(16)} must not be producible by the payload key encoding`
    );
  }
});
