import assert from "node:assert/strict";
import test from "node:test";

import {
  MANIFEST_HASH_ALGORITHM,
  ManifestHashKeyringError,
  activeManifestHashKey,
  manifestHashKeyById,
  manifestHashKeyring,
} from "../lib/manifestHashKeyring.ts";

// The manifest keyring exists because the digests were keyed with the session
// secret. That secret rotates on authentication's schedule, and every rotation
// would leave the manifests written before it holding a commitment nothing
// could check -- a ninety-day audit record hanging off somebody else's key.

const KEY = "k".repeat(48);
const OTHER = "j".repeat(48);
const env = (overrides = {}) => ({
  MANIFEST_HASH_KEYS: `2026-08:${KEY}`,
  MANIFEST_HASH_ACTIVE_KEY_ID: "2026-08",
  ...overrides,
});

test("the active key is the one its id names", () => {
  const key = activeManifestHashKey(env());
  assert.equal(key.keyId, "2026-08");
  assert.equal(key.secret, KEY);
  assert.equal(MANIFEST_HASH_ALGORITHM, "hmac-sha256");
});

// A manifest whose key nobody can name is worse than one that was never
// written, because the first looks like evidence.
test("an unset keyring refuses rather than falling back to something", () => {
  assert.throws(() => activeManifestHashKey({}), ManifestHashKeyringError);
  assert.throws(
    () => activeManifestHashKey({ MANIFEST_HASH_KEYS: `a:${KEY}` }),
    ManifestHashKeyringError
  );
  assert.throws(
    () => activeManifestHashKey(env({ MANIFEST_HASH_ACTIVE_KEY_ID: "nope" })),
    ManifestHashKeyringError
  );
});

// The whole point of an id: last quarter's manifest is still checkable this
// quarter, and dropping a key is a deliberate decision that those records no
// longer need to be.
test("a rotated-out key stays checkable while it stays in the ring", () => {
  const rotated = env({
    MANIFEST_HASH_KEYS: `2026-05:${OTHER},2026-08:${KEY}`,
  });
  assert.equal(activeManifestHashKey(rotated).keyId, "2026-08");
  assert.equal(manifestHashKeyById("2026-05", rotated)?.secret, OTHER);
});

// "This does not match" and "nothing here can tell" are different findings,
// and only one of them is evidence of anything.
test("a key that has left the ring reads as unverifiable, not as a mismatch", () => {
  assert.equal(manifestHashKeyById("2020-01", env()), null);
  assert.equal(manifestHashKeyById(null, env()), null);
});

test("a malformed ring is refused rather than half-loaded", () => {
  for (const keys of [
    "no-separator",
    `:${KEY}`,
    "short-key:tooshort",
    `dup:${KEY},dup:${OTHER}`,
    `bad id:${KEY}`,
  ]) {
    assert.throws(
      () => manifestHashKeyring({ MANIFEST_HASH_KEYS: keys }),
      ManifestHashKeyringError,
      `"${keys}" was accepted`
    );
  }
});

// The key itself is never written to a manifest: a record carrying its own
// verification key lets whoever reads the table forge a match.
test("nothing in the keyring's own output invites storing the secret", () => {
  const key = activeManifestHashKey(env());
  assert.deepEqual(Object.keys(key).sort(), ["keyId", "secret"]);
});

// `lib/routingDispatchInstrumentation.ts` puts these messages into an
// operational incident so the operator can tell the four failures apart
// without a debugger. That is only safe while none of them interpolates the
// secret -- a message naming the value would move the key from an environment
// variable into the incident log, which is exactly the disclosure the keyring
// exists to avoid. Ids, lengths and variable names are fine: the id is already
// stored in plaintext on every manifest row.
test("no keyring failure message carries the secret it failed on", () => {
  const cases = [
    {},
    { MANIFEST_HASH_KEYS: KEY },
    { MANIFEST_HASH_KEYS: `:${KEY}` },
    { MANIFEST_HASH_KEYS: `bad id:${KEY}` },
    { MANIFEST_HASH_KEYS: "short:tooshort", MANIFEST_HASH_ACTIVE_KEY_ID: "short" },
    { MANIFEST_HASH_KEYS: `dup:${KEY},dup:${OTHER}` },
    env({ MANIFEST_HASH_ACTIVE_KEY_ID: "nope" }),
  ];
  for (const environment of cases) {
    assert.throws(
      () => activeManifestHashKey(environment),
      (error) => {
        assert.ok(error instanceof ManifestHashKeyringError);
        // Substrings too: a message that printed a prefix of the key would
        // leak just as surely as one that printed all of it.
        for (const secret of [KEY, OTHER, "tooshort"]) {
          for (const fragment of [secret, secret.slice(0, 8)]) {
            assert.ok(
              !error.message.includes(fragment),
              `"${error.message}" carries the secret`
            );
          }
        }
        return true;
      }
    );
  }
});
