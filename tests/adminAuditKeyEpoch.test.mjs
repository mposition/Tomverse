import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseAdminAuditKeyring,
  secretForEpoch,
} from "../lib/adminAuditIntegrityCore.ts";

// The signing-key epoch (#883).
//
// Contract: docs/ops/admin-audit-key-epochs.md.
//
// The rules the database half cannot state: what the environment means, and
// what a missing key is. The chain behaviour is next door in
// tests/integration/admin-audit-key-epoch.db.test.ts.

test("epochs are read as version:secret pairs, like the snapshot keyring", () => {
  // Deliberately the same shape as EMAIL_SNAPSHOT_KEYS so an operator learns
  // one convention rather than two.
  const keyring = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEYS: "v2:second-secret, v1:first-secret",
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v2",
  });
  assert.deepEqual(keyring.epochs.sort(), ["v1", "v2"]);
  assert.equal(secretForEpoch(keyring, "v1"), "first-secret");
  assert.equal(secretForEpoch(keyring, "v2"), "second-secret");
  assert.equal(keyring.activeEpoch, "v2");
});

test("a rotation is adding a pair and moving the pointer", () => {
  // The whole point: after rotating, the old epoch still resolves. That is what
  // makes the chain verifiable across the boundary instead of permanently red.
  const before = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEYS: "v1:first-secret",
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v1",
  });
  const after = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEYS: "v1:first-secret,v2:second-secret",
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v2",
  });
  assert.equal(before.activeEpoch, "v1");
  assert.equal(after.activeEpoch, "v2");
  assert.equal(
    secretForEpoch(after, "v1"),
    "first-secret",
    "rows from the old epoch must still resolve after a rotation"
  );
});

test("a null epoch is the pre-epoch key, not an unknown one", () => {
  // Every row written before the keyring existed carries NULL, and it has a
  // definite meaning: the key the writer used before epochs. Reading it as
  // "unknown" would make the entire existing chain unverifiable on deploy.
  const keyring = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEY: "legacy-secret",
  });
  assert.equal(secretForEpoch(keyring, null), "legacy-secret");
  assert.equal(keyring.activeEpoch, null, "with no keyring, writes stay pre-epoch");
});

test("the NEXTAUTH_SECRET fallback reaches the past only", () => {
  // Kept deliberately: docs/ops/admin-audit-key-epochs.md records that both
  // environments rely on it today, so removing it would make every existing row
  // unverifiable on deploy -- the outcome this change exists to prevent. It
  // resolves the pre-epoch key and nothing else; a named epoch never falls back.
  const keyring = parseAdminAuditKeyring({ NEXTAUTH_SECRET: "session-secret" });
  assert.equal(secretForEpoch(keyring, null), "session-secret");
  assert.equal(secretForEpoch(keyring, "v1"), null);
});

test("a dedicated key wins over the session secret", () => {
  const keyring = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEY: "dedicated",
    NEXTAUTH_SECRET: "session-secret",
  });
  assert.equal(secretForEpoch(keyring, null), "dedicated");
});

test("an epoch with no secret resolves to null, never to a different key", () => {
  // This is the rule the report depends on: no secret means unverifiable, and
  // silently falling back to some other key would verify a row against a key
  // that did not sign it.
  const keyring = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEYS: "v2:second-secret",
    ADMIN_AUDIT_INTEGRITY_KEY: "legacy-secret",
  });
  assert.equal(secretForEpoch(keyring, "v1"), null);
});

test("a pointer at an epoch the keyring lacks is reported, not silently used", () => {
  // Misconfiguration, and it must not quietly sign new entries under some other
  // epoch: that would mislabel them for every future verification.
  const keyring = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEYS: "v1:first-secret",
    ADMIN_AUDIT_INTEGRITY_KEY_VERSION: "v9",
  });
  assert.equal(keyring.pinnedEpochMissing, true);
  assert.equal(keyring.activeEpoch, null);
});

test("malformed pairs are skipped rather than half-parsed", () => {
  const keyring = parseAdminAuditKeyring({
    ADMIN_AUDIT_INTEGRITY_KEYS: "novalue,:leading,v1:ok,  ,v2:",
  });
  assert.deepEqual(keyring.epochs, ["v1"]);
  assert.equal(secretForEpoch(keyring, "v1"), "ok");
});

test("no keys at all is no keys, not an empty pass", () => {
  const keyring = parseAdminAuditKeyring({});
  assert.equal(keyring.legacySecret, null);
  assert.deepEqual(keyring.epochs, []);
  assert.equal(secretForEpoch(keyring, null), null);
});
