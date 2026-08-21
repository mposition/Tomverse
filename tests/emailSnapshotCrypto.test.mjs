import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptSnapshot,
  encryptSnapshot,
  isEncryptedSnapshot,
  readSnapshotKeyring,
} from "../lib/emailSnapshotCrypto.ts";

// Envelope encryption for the personalisation snapshot. Contract §10.3.

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

test("nothing recognisable survives into the stored value", () => {
  const sealed = encryptSnapshot(
    { name: "Someone", plan: "Pro", email: "someone@example.com" },
    keyring
  );
  const asText = JSON.stringify(sealed);

  for (const secret of ["Someone", "Pro", "someone@example.com"]) {
    assert.equal(
      asText.includes(secret),
      false,
      `${secret} leaked into the stored envelope`
    );
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
