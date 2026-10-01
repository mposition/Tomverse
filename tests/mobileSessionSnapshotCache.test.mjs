import assert from "node:assert/strict";
import test from "node:test";

import { createMobileSnapshotStore } from "../lib/mobileSessionSnapshotCache.ts";

/**
 * The fifteen-second bound, at the level where it is actually implemented.
 *
 * Design D12, approved 2026-08-31 with its three requirements mandatory
 * (decisions 6 and 18). `tests/mobileRevocationFreshnessCore.test.mjs` settles
 * the judgement; this settles the machinery -- the cache the judgement writes
 * into, the generation counter it compares, and the retry it earns.
 *
 * The clock and the lookup are both injected, so a lookup "slower than the
 * window" is a number rather than twenty real seconds.
 */

const TTL_MS = 15_000;

const snapshotFor = (familyId = "family_1", userId = "user_1") => ({
  userId,
  deviceId: "device_1",
  familyId,
  accountStatus: "active",
  sessionsRevokedAtMs: null,
  familyRevokedAtMs: null,
  deviceRevokedAtMs: null,
  absoluteExpiresAtMs: Number.MAX_SAFE_INTEGER,
  lastRotatedAtMs: 0,
});

/** A clock a test moves by hand, and a lookup that can advance it. */
const harness = (options = {}) => {
  let clock = options.startAt ?? 1_000_000;
  const calls = [];
  const store = createMobileSnapshotStore({
    ttlMs: TTL_MS,
    now: () => clock,
    loadSnapshot: async (familyId) => {
      calls.push(familyId);
      // Whatever the lookup does to the clock or to the store happens *during*
      // the query, which is exactly the window D12 is about.
      await (options.during?.(api, calls.length) ?? Promise.resolve());
      if (options.fail?.(calls.length)) throw new Error("lookup exploded");
      if (options.missing?.(calls.length)) return null;
      return options.snapshot?.(calls.length) ?? snapshotFor(familyId);
    },
  });
  const api = {
    store,
    calls,
    advance: (ms) => {
      clock += ms;
    },
    at: () => clock,
  };
  return api;
};

test("a normal read answers, caches, and the next read spends no query", async () => {
  const { store, calls } = harness();

  const first = await store.read("family_1", "user_1");
  assert.equal(first.snapshot?.familyId, "family_1");
  assert.equal(calls.length, 1);

  const second = await store.read("family_1", "user_1");
  assert.equal(second.snapshot?.familyId, "family_1");
  assert.equal(calls.length, 1, "a cache hit must not re-query");
});

test("the cached entry expires on the window, measured from the query's start", async () => {
  // Requirement 1. The entry stops being usable fifteen seconds after the
  // query was *issued*, not after it returned -- otherwise a slow query buys
  // itself extra life and the real bound is `ttl + latency`.
  const { store, calls, advance } = harness({
    during: (api) => {
      // Five seconds of latency on the first lookup only.
      if (api.calls.length === 1) api.advance(5_000);
      return Promise.resolve();
    },
  });

  await store.read("family_1", "user_1");
  assert.equal(calls.length, 1);

  // Nine more seconds: fourteen since the query started, still inside.
  advance(9_000);
  await store.read("family_1", "user_1");
  assert.equal(calls.length, 1);

  // One more: fifteen since the start. Had the window been measured from the
  // return, this would still be a hit with four seconds to spare.
  advance(1_000);
  await store.read("family_1", "user_1");
  assert.equal(calls.length, 2);
});

test("V29a -- a lookup slower than the window authorizes nothing, and is retried", async () => {
  // The failure the packet describes: refusing to *cache* a stale answer does
  // not stop it authorizing the request that was waiting for it.
  const { store, calls } = harness({
    during: (api) => {
      if (api.calls.length === 1) api.advance(20_000);
      return Promise.resolve();
    },
  });

  const result = await store.read("family_1", "user_1");

  // The second attempt is fast, so the caller does get an answer -- from a
  // fresh read, not from the twenty-second-old one.
  assert.ok("snapshot" in result);
  assert.equal(calls.length, 2, "the stale attempt must be retried, not returned");
});

test("V29a -- when every attempt is too slow, the waiting request is refused", async () => {
  const { store, calls } = harness({
    during: (api) => {
      api.advance(20_000);
      return Promise.resolve();
    },
  });

  const result = await store.read("family_1", "user_1");
  assert.deepEqual(result, { refusal: "stale_on_arrival" });
  assert.equal(calls.length, 2, "one retry, and then the refusal");
  assert.equal(store.size(), 0, "and nothing stale was written");
});

test("V29a -- a revocation landing mid-flight discards the result it raced", async () => {
  // Requirement 2. The lookup was quick; it still straddled the revocation.
  let revoked = false;
  const { store, calls } = harness({
    during: (api) => {
      if (api.calls.length === 1) {
        api.store.invalidate("user_1");
        revoked = true;
      }
      return Promise.resolve();
    },
    snapshot: () =>
      revoked
        ? { ...snapshotFor(), familyRevokedAtMs: 1 }
        : snapshotFor(),
  });

  const result = await store.read("family_1", "user_1");
  assert.equal(calls.length, 2, "the raced attempt must be discarded and retried");
  // And the retry reads the truth the revocation wrote.
  assert.equal(result.snapshot?.familyRevokedAtMs, 1);
});

test("V29b -- what a slow read leaves behind is dated from the retry, not the slow query", async () => {
  // The other half of the pair, and the assertion has to be about the *date*
  // rather than about there being a cache hit at all. The slow attempt is
  // discarded; the retry succeeds and is cached. The question V29b asks is
  // whether that entry carries the retry's window or the original query's --
  // because carrying the original one would hand a later request a value from
  // before the twenty seconds elapsed.
  const api = harness({
    during: (inner) => {
      if (inner.calls.length === 1) inner.advance(20_000);
      return Promise.resolve();
    },
  });
  const originalQueryStartedAt = api.at();

  await api.store.read("family_1", "user_1");
  const retryStartedAt = originalQueryStartedAt + 20_000;
  assert.equal(api.at(), retryStartedAt, "the retry began after the slow attempt");
  assert.equal(api.calls.length, 2);

  // One millisecond before the retry's own window closes: still a hit.
  api.advance(retryStartedAt + TTL_MS - 1 - api.at());
  await api.store.read("family_1", "user_1");
  assert.equal(api.calls.length, 2);

  // And at the window's end, a fresh read. Had the entry been dated from the
  // original query, it would have expired 20 seconds ago and this would be the
  // third query rather than the third-and-fourth boundary being here.
  api.advance(1);
  await api.store.read("family_1", "user_1");
  assert.equal(api.calls.length, 3);
});

test("the bound is never exceeded, whatever the latency", async () => {
  // Swept rather than sampled: for each latency, the entry the store keeps
  // must expire no later than fifteen seconds after that query began.
  for (const latency of [0, 1, 999, 5_000, 14_999]) {
    const api = harness({
      during: (inner) => {
        if (inner.calls.length === 1) inner.advance(latency);
        return Promise.resolve();
      },
    });
    const startedAt = api.at();
    await api.store.read("family_1", "user_1");

    // Move to exactly the window's end, measured from the start of the query.
    api.advance(startedAt + TTL_MS - api.at());
    const before = api.calls.length;
    await api.store.read("family_1", "user_1");
    assert.equal(
      api.calls.length,
      before + 1,
      `latency ${latency}: the entry outlived the window`
    );
  }
});

test("a failed lookup fails closed, and is not retried into a second failure", async () => {
  // A lookup that could not be performed is not evidence that nothing was
  // revoked. It is also not a race, so retrying it would only repeat it.
  const { store, calls } = harness({ fail: () => true });

  const result = await store.read("family_1", "user_1");
  assert.deepEqual(result, { refusal: "lookup_failed" });
  assert.equal(calls.length, 1);
});

test("a family that does not exist is refused, not treated as unrevoked", async () => {
  const { store, calls } = harness({ missing: () => true });

  const result = await store.read("family_1", "user_1");
  assert.deepEqual(result, { refusal: "subject_missing" });
  assert.equal(calls.length, 1);
  assert.equal(store.size(), 0);
});

test("invalidation drops this account's entries and leaves other accounts alone", async () => {
  const { store, calls } = harness({
    snapshot: () => snapshotFor("family_1", "user_1"),
  });
  await store.read("family_1", "user_1");
  assert.equal(store.size(), 1);

  store.invalidate("user_2");
  assert.equal(store.size(), 1, "another account's revocation is not this one's");

  store.invalidate("user_1");
  assert.equal(store.size(), 0);

  await store.read("family_1", "user_1");
  assert.equal(calls.length, 2);
});

test("the cache is keyed by family, so one device's revocation is not another's", async () => {
  // D11's reach. An account-keyed cache would make the narrow events behave
  // like the wide one.
  const api = harness({
    snapshot: (call) =>
      call === 1 ? snapshotFor("family_1") : snapshotFor("family_2"),
  });
  await api.store.read("family_1", "user_1");
  await api.store.read("family_2", "user_1");
  assert.equal(api.store.size(), 2);
  assert.equal(api.calls.length, 2);
});

test("an entry is never served to an account it does not belong to", async () => {
  const { store, calls } = harness({
    snapshot: () => snapshotFor("family_1", "user_1"),
  });
  await store.read("family_1", "user_1");

  // Same family id, different account asking. The entry must not be handed
  // over on the strength of the key alone.
  await store.read("family_1", "user_2");
  assert.equal(calls.length, 2);
});
