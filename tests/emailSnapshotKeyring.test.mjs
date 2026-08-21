import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptSnapshot,
  encryptSnapshot,
  readSnapshotKeyring,
  snapshotKeyringProblems,
  snapshotKeyringReadiness,
} from "../lib/emailSnapshotCrypto.ts";

// The keyring the standard lane seals its render snapshots with, and the
// readiness view of it.
// Contract: docs/policy/email-notifications.md §10.3.
//
// The failure these exist for has no symptom. `lib/standardEmailLane.ts`
// throws when the keyring is absent; its four callers each swallow that so the
// user's own action still succeeds, so the welcome email, the receipt, the
// deletion notice and the restore notice disappear into one log line. Nothing
// on screen says so and /api/ready used to answer 200 throughout.

const KEYS = "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TWO_KEYS = `${KEYS},v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;

const codes = (env) => snapshotKeyringProblems(env).map((problem) => problem.code);

test("a configured keyring is ready", () => {
  const readiness = snapshotKeyringReadiness({
    EMAIL_SNAPSHOT_KEYS: KEYS,
    EMAIL_SNAPSHOT_KEY_VERSION: "v1",
  });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.errors, []);
  assert.deepEqual(readiness.warnings, []);
  assert.equal(readiness.versionCount, 1);
});

test("a single key needs no pinned version", () => {
  // Pinning is about *choosing* between keys. With one there is nothing to
  // choose, and demanding the variable anyway would fail a correct setup.
  const readiness = snapshotKeyringReadiness({ EMAIL_SNAPSHOT_KEYS: KEYS });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.warnings, []);
});

test("an absent keyring is an error, not a warning", () => {
  // The lane is behind no feature flag, so there is no "flag off, key absent"
  // intermediate state to protect -- the state this describes is mail already
  // being lost, not a migration somebody has not finished.
  const readiness = snapshotKeyringReadiness({});
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.errors.map((problem) => problem.code),
    ["SNAPSHOT_KEYS_MISSING"]
  );
  assert.equal(readiness.errors[0].severity, "error");
});

test("set but unreadable is its own error, because it looks configured", () => {
  // An operator who sees the variable in the list has no reason to suspect it,
  // which is exactly why this cannot share a code with "not set".
  assert.deepEqual(codes({ EMAIL_SNAPSHOT_KEYS: "not-a-pair" }), [
    "SNAPSHOT_KEYS_UNPARSEABLE",
  ]);
  assert.deepEqual(codes({ EMAIL_SNAPSHOT_KEYS: ":secret-with-no-version" }), [
    "SNAPSHOT_KEYS_UNPARSEABLE",
  ]);
  assert.deepEqual(codes({ EMAIL_SNAPSHOT_KEYS: "v1:" }), [
    "SNAPSHOT_KEYS_UNPARSEABLE",
  ]);
  // Blank is not configured, the same reading the sending identity uses.
  assert.deepEqual(codes({ EMAIL_SNAPSHOT_KEYS: "   " }), [
    "SNAPSHOT_KEYS_MISSING",
  ]);
});

test("a pinned version with no matching key is an error", () => {
  // This is the state that throws rather than returning null: nothing can be
  // sealed *and* nothing already stored can be read.
  assert.deepEqual(
    codes({ EMAIL_SNAPSHOT_KEYS: KEYS, EMAIL_SNAPSHOT_KEY_VERSION: "v9" }),
    ["SNAPSHOT_ACTIVE_VERSION_UNKNOWN"]
  );
  assert.throws(() =>
    readSnapshotKeyring({
      EMAIL_SNAPSHOT_KEYS: KEYS,
      EMAIL_SNAPSHOT_KEY_VERSION: "v9",
    })
  );
  // And the check survives it. A readiness check that threw on the state it
  // exists to find would take the endpoint down instead of reporting.
  assert.equal(
    snapshotKeyringReadiness({
      EMAIL_SNAPSHOT_KEYS: KEYS,
      EMAIL_SNAPSHOT_KEY_VERSION: "v9",
    }).ready,
    false
  );
});

test("two keys with nothing pinned is a warning, and still ready", () => {
  // Writes succeed and every version stays readable, so this must not refuse
  // traffic. What it does mean is that a rotation which added a key before
  // pinning one moved the active version without anyone choosing to.
  const readiness = snapshotKeyringReadiness({ EMAIL_SNAPSHOT_KEYS: TWO_KEYS });
  assert.equal(readiness.ready, true);
  assert.deepEqual(
    readiness.warnings.map((problem) => problem.code),
    ["SNAPSHOT_ACTIVE_VERSION_UNPINNED"]
  );
  assert.equal(readiness.versionCount, 2);
  // Pinning clears it.
  assert.deepEqual(
    snapshotKeyringReadiness({
      EMAIL_SNAPSHOT_KEYS: TWO_KEYS,
      EMAIL_SNAPSHOT_KEY_VERSION: "v2",
    }).warnings,
    []
  );
});

test("no message quotes the environment back", () => {
  // A keyring is misconfigured most often by a value pasted into the wrong
  // variable, and the wrong variable here holds key material. Counts are
  // enough to act on; the value never is.
  const secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const environments = [
    {},
    { EMAIL_SNAPSHOT_KEYS: `nonsense-${secret}` },
    { EMAIL_SNAPSHOT_KEYS: KEYS, EMAIL_SNAPSHOT_KEY_VERSION: secret },
    { EMAIL_SNAPSHOT_KEYS: TWO_KEYS },
  ];
  for (const env of environments) {
    for (const problem of snapshotKeyringProblems(env)) {
      assert.ok(
        !problem.message.includes(secret),
        `${problem.code} quoted the environment: ${problem.message}`
      );
      assert.ok(
        !problem.message.includes("v1:"),
        `${problem.code} quoted a pair: ${problem.message}`
      );
    }
  }
});

test("the check and the reader agree about every environment", () => {
  // The whole reason the parser is shared. A check that called a keyring good
  // while `readSnapshotKeyring` returned null or threw would be worse than no
  // check: it would say the lane is fine while the lane is failing.
  const environments = [
    {},
    { EMAIL_SNAPSHOT_KEYS: "   " },
    { EMAIL_SNAPSHOT_KEYS: "not-a-pair" },
    { EMAIL_SNAPSHOT_KEYS: "v1:" },
    { EMAIL_SNAPSHOT_KEYS: KEYS },
    { EMAIL_SNAPSHOT_KEYS: KEYS, EMAIL_SNAPSHOT_KEY_VERSION: "v1" },
    { EMAIL_SNAPSHOT_KEYS: KEYS, EMAIL_SNAPSHOT_KEY_VERSION: "v9" },
    { EMAIL_SNAPSHOT_KEYS: TWO_KEYS },
    { EMAIL_SNAPSHOT_KEYS: TWO_KEYS, EMAIL_SNAPSHOT_KEY_VERSION: "v2" },
  ];

  for (const env of environments) {
    let usable = false;
    try {
      usable = readSnapshotKeyring(env) !== null;
    } catch {
      usable = false;
    }
    assert.equal(
      snapshotKeyringReadiness(env).ready,
      usable,
      `disagreement on ${JSON.stringify(env)}`
    );
  }
});

test("a ready keyring actually seals and opens a snapshot", () => {
  // `ready` has to mean the lane works, not that the string parsed.
  const keyring = readSnapshotKeyring({
    EMAIL_SNAPSHOT_KEYS: TWO_KEYS,
    EMAIL_SNAPSHOT_KEY_VERSION: "v2",
  });
  assert.ok(keyring);
  const payload = { name: "QA", plan: "Pro" };
  const sealed = encryptSnapshot(payload, keyring);
  assert.equal(sealed.keyVersion, "v2");
  assert.deepEqual(decryptSnapshot(sealed, keyring), payload);
  // And a row sealed under the older key stays readable after the rotation,
  // which is what keeping every version in the map is for.
  const older = readSnapshotKeyring({
    EMAIL_SNAPSHOT_KEYS: TWO_KEYS,
    EMAIL_SNAPSHOT_KEY_VERSION: "v1",
  });
  assert.deepEqual(decryptSnapshot(encryptSnapshot(payload, older), keyring), payload);
});
