import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptSnapshot,
  encryptSnapshot,
  isEncryptedSnapshot,
  readSnapshotKeyring,
} from "../lib/emailSnapshotCrypto.ts";

// Envelope encryption for the personalisation snapshot.
// Contract: docs/policy/email-notifications.md §10.3.

const keyring = {
  activeVersion: "v1",
  secrets: { v1: "a-high-entropy-secret-for-v1" },
};

test("a snapshot round-trips through the envelope", () => {
  const payload = { plan: "Pro", amount: 1900, name: "Someone" };
  const sealed = encryptSnapshot(payload, keyring);

  assert.equal(isEncryptedSnapshot(sealed), true);
  assert.equal(sealed.keyVersion, "v1");
  assert.deepEqual(decryptSnapshot(sealed, keyring), payload);
});

// The envelope's whole field set, so a value added beside the ciphertext is a
// failure on its own rather than something the search below has to notice.
// Everything except `v` and `keyVersion` is base64 of a random-looking buffer.
const ENVELOPE_FIELDS = ["v", "keyVersion", "dk", "dkIv", "dkTag", "ct", "iv", "tag"];

// Long enough that a chance hit is not a thing that happens.
//
// This assertion used to search for `"Pro"`, and on 2026-09-12 it failed the
// Daily Security Audit: the ciphertext's base64 spelled those three characters.
// Nothing had leaked. A three-character needle over ~230 base64 positions hits
// with probability 230 / 64^3, and measuring the real `encryptSnapshot` over
// 400,000 envelopes gave 298 -- 0.0745%, against 0.0877% predicted. Every hit
// was `"Pro"`; the two longer needles never fired.
//
// The cost was not the red run. This is a test that says a secret leaked, and
// one that says so at random teaches its readers to re-run it -- so the first
// real leak reads as the last false alarm. The needles are now 12+ characters
// (230 / 64^12, which is once in about 10^17 runs), and the payload is checked
// against itself below so the search is still known to be able to find them.
const PAYLOAD = {
  name: "Someone Recognisable",
  plan: "Pro-Subscription-Tier",
  email: "recognisable.someone@example.com",
};
const NEEDLES = Object.values(PAYLOAD);

test("nothing recognisable survives into the stored value", () => {
  const sealed = encryptSnapshot(PAYLOAD, keyring);
  const asText = JSON.stringify(sealed);

  for (const secret of NEEDLES) {
    assert.equal(
      asText.includes(secret),
      false,
      `${secret} leaked into the stored envelope`
    );
  }
});

test("the search that found nothing would have found a plaintext store", () => {
  // The positive control the assertion above needs to mean anything. Without
  // it, a `NEEDLES` that no longer matches `PAYLOAD` -- or an `encryptSnapshot`
  // that returned an empty object -- passes by finding nothing anywhere.
  const inTheClear = JSON.stringify(PAYLOAD);
  for (const secret of NEEDLES) {
    assert.equal(inTheClear.includes(secret), true, secret);
  }
});

test("the envelope carries ciphertext and key metadata, and nothing else", () => {
  // The deterministic half of "nothing recognisable survives": a field added
  // beside the ciphertext -- a plan name kept for indexing, a preview string --
  // fails here whatever it contains and however short it is. The search above
  // is probabilistic in the other direction, and this is not.
  const sealed = encryptSnapshot(PAYLOAD, keyring);

  assert.deepEqual(Object.keys(sealed).sort(), [...ENVELOPE_FIELDS].sort());
  assert.equal(sealed.v, 1);
  assert.equal(sealed.keyVersion, "v1");

  for (const field of ENVELOPE_FIELDS.filter(
    (name) => name !== "v" && name !== "keyVersion"
  )) {
    const value = sealed[field];
    assert.equal(typeof value, "string", field);
    assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/, field);
    // Round-trips through base64, so the field is encoded bytes rather than a
    // readable string that happens to use the same alphabet.
    assert.equal(Buffer.from(value, "base64").toString("base64"), value, field);
  }
});

test("each snapshot gets its own data key", () => {
  const a = encryptSnapshot({ same: "payload" }, keyring);
  const b = encryptSnapshot({ same: "payload" }, keyring);

  // Identical input, different ciphertext and different wrapped key. Reusing
  // one key across rows would make identical messages recognisable as
  // identical, and would make a rotation mean re-encrypting every payload
  // rather than re-wrapping every key.
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.dk, b.dk);
  assert.notEqual(a.iv, b.iv);
});

test("tampering is refused rather than tolerated", () => {
  const sealed = encryptSnapshot({ amount: 1900 }, keyring);

  const flipped = Buffer.from(sealed.ct, "base64");
  flipped[0] ^= 0xff;

  assert.throws(() =>
    decryptSnapshot({ ...sealed, ct: flipped.toString("base64") }, keyring)
  );

  // Swapping in another row's wrapped key fails too: GCM authenticates the
  // key unwrap as well as the payload.
  const other = encryptSnapshot({ amount: 100 }, keyring);
  assert.throws(() => decryptSnapshot({ ...sealed, dk: other.dk }, keyring));
});

test("a rotation leaves rows sealed under the old key readable", () => {
  const old = encryptSnapshot({ plan: "Pro" }, keyring);

  const rotated = {
    activeVersion: "v2",
    secrets: { ...keyring.secrets, v2: "a-high-entropy-secret-for-v2" },
  };

  // New rows take the new version...
  assert.equal(encryptSnapshot({ plan: "Max" }, rotated).keyVersion, "v2");
  // ...and the old ones still open, which is the whole point of the version.
  assert.deepEqual(decryptSnapshot(old, rotated), { plan: "Pro" });
});

test("a key that was dropped is reported, never guessed around", () => {
  const sealed = encryptSnapshot({ plan: "Pro" }, keyring);
  const withoutV1 = {
    activeVersion: "v2",
    secrets: { v2: "a-high-entropy-secret-for-v2" },
  };

  // Dropping a version does not delete the rows, it makes them unreadable --
  // so this has to say so rather than return an empty snapshot that would read
  // as "there was nothing to reproduce".
  assert.throws(
    () => decryptSnapshot(sealed, withoutV1),
    /does not hold/
  );
});

test("the keyring is read as version:secret pairs", () => {
  const parsed = readSnapshotKeyring({
    EMAIL_SNAPSHOT_KEYS: "v1:secret-one, v2:secret-two",
    EMAIL_SNAPSHOT_KEY_VERSION: "v2",
  });

  assert.deepEqual(parsed, {
    activeVersion: "v2",
    secrets: { v1: "secret-one", v2: "secret-two" },
  });

  assert.equal(readSnapshotKeyring({}), null);

  // An active version with no key is a deployment that would write rows it
  // cannot read back, so it fails at startup rather than at decrypt time.
  assert.throws(
    () =>
      readSnapshotKeyring({
        EMAIL_SNAPSHOT_KEYS: "v1:secret-one",
        EMAIL_SNAPSHOT_KEY_VERSION: "v9",
      }),
    /no matching key/
  );
});
