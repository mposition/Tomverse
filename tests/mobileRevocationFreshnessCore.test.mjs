// D12, as executable vectors.
//
// Source: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
// D12 and 8.1.1 #6 -- a fifteen-second bound, with the three conditions that
// have to hold for that number to be true rather than merely written down.
//
// V29a and V29b are the pair. They look similar and fail for different reasons:
// a implementation can refuse to *cache* a stale result and still *authorize*
// the request that was waiting for it, which is the failure the existing web
// path has and this contract exists to avoid inheriting.

import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedRevocationSnapshotUsable,
  judgeMobileRevocationFreshness,
} from "../lib/mobileRevocationFreshnessCore.ts";
import { MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS } from "../lib/mobileAuthContract.ts";

const TTL_MS = MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS * 1000;
const T0 = 1_800_000_000_000;

const judge = (overrides = {}) =>
  judgeMobileRevocationFreshness({
    queryStartedAtMs: T0,
    completedAtMs: T0 + 50,
    nowMs: T0 + 50,
    ttlMs: TTL_MS,
    generationAtStart: 7,
    generationAtCompletion: 7,
    outcome: "ok",
    ...overrides,
  });

test("the approved bound is fifteen seconds", () => {
  assert.equal(MOBILE_REVOCATION_OBSERVATION_BOUND_SECONDS, 15);
});

test("a prompt lookup is usable and cacheable, dated from the query start", () => {
  const verdict = judge();
  assert.deepEqual(verdict, {
    usable: true,
    cacheable: true,
    // T0 + TTL, not completion + TTL. That difference is the whole point.
    expiresAtMs: T0 + TTL_MS,
    refusal: null,
  });
});

// --- V29a: the request that waited for the slow lookup -------------------

test("V29a -- a lookup slower than the window authorizes nothing, not even its waiter", () => {
  const verdict = judge({
    completedAtMs: T0 + 20_000,
    nowMs: T0 + 20_000,
  });
  assert.equal(
    verdict.usable,
    false,
    "the waiting request must not be authorized by a result older than the bound"
  );
  assert.equal(verdict.cacheable, false);
  assert.equal(verdict.refusal, "stale_on_arrival");
});

test("V29a -- a revocation landing mid-flight refuses however fast the lookup was", () => {
  const verdict = judge({ generationAtCompletion: 8 });
  assert.deepEqual(verdict, {
    usable: false,
    cacheable: false,
    expiresAtMs: null,
    refusal: "raced_invalidation",
  });
});

test("V29a -- usable and cacheable are answered separately, never as one flag", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("lib/mobileRevocationFreshnessCore.ts", "utf8");
  // Every refusal path sets both to false; there is no branch that returns
  // `usable: true, cacheable: false`, which would be the shape of "do not store
  // it but go ahead and let this one through".
  assert.equal(/usable:\s*true,\s*cacheable:\s*false/.test(source), false);
});

// --- V29b: the request that arrives after the slow lookup ----------------

test("V29b -- a later request finds nothing cached and is not served the stale value", () => {
  // The slow lookup refused to cache (V29a), so a request arriving afterwards
  // has no entry to hit. Simulated by asking whether an entry that was never
  // written could be used: the stale result carries no expiry to check.
  const stale = judge({ completedAtMs: T0 + 20_000, nowMs: T0 + 20_000 });
  assert.equal(stale.expiresAtMs, null, "nothing to store means nothing to hit");

  // And a fresh lookup made after it is dated from its own start, so the bound
  // does not inherit the earlier delay.
  const fresh = judge({
    queryStartedAtMs: T0 + 20_000,
    completedAtMs: T0 + 20_050,
    nowMs: T0 + 20_050,
    generationAtStart: 8,
    generationAtCompletion: 8,
  });
  assert.equal(fresh.usable, true);
  assert.equal(fresh.expiresAtMs, T0 + 20_000 + TTL_MS);
});

test("V29b -- the bound never exceeds the approved value, whatever the latency", () => {
  for (const latencyMs of [0, 1, 500, 5_000, 14_999, 15_000, 60_000]) {
    const verdict = judge({
      completedAtMs: T0 + latencyMs,
      nowMs: T0 + latencyMs,
    });
    if (!verdict.usable) continue;
    assert.ok(
      verdict.expiresAtMs - T0 <= TTL_MS,
      `latency ${latencyMs}ms produced a window of ${verdict.expiresAtMs - T0}ms`
    );
  }
});

// --- fail closed, exactly as the web path does ---------------------------

test("a failed lookup and a missing subject both fail closed", () => {
  for (const outcome of ["lookup_failed", "subject_missing"]) {
    const verdict = judge({ outcome });
    assert.equal(verdict.usable, false, `${outcome} must not authorize`);
    assert.equal(verdict.cacheable, false);
    assert.equal(verdict.refusal, outcome);
  }
});

test("a race is refused before the clock is consulted", () => {
  // A lookup that took one millisecond can still straddle a revocation, so the
  // generation check cannot be an optimisation applied only to slow queries.
  const verdict = judge({
    completedAtMs: T0 + 1,
    nowMs: T0 + 1,
    generationAtCompletion: 8,
  });
  assert.equal(verdict.refusal, "raced_invalidation");
});

// --- cached entries ------------------------------------------------------

test("a cached entry is usable only while in date and on the current generation", () => {
  const base = {
    expiresAtMs: T0 + TTL_MS,
    storedGeneration: 7,
    currentGeneration: 7,
  };
  assert.equal(cachedRevocationSnapshotUsable({ ...base, nowMs: T0 }), true);
  assert.equal(
    cachedRevocationSnapshotUsable({ ...base, nowMs: T0 + TTL_MS }),
    false,
    "expiry is exclusive"
  );
  assert.equal(
    cachedRevocationSnapshotUsable({ ...base, nowMs: T0, currentGeneration: 8 }),
    false,
    "a revocation since it was stored invalidates the entry"
  );
});
