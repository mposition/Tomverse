// T2's closed key schema: exactly the S2 page keys; every state evaluateKey()
// can produce is accepted, and anything it cannot produce is refused.

import assert from "node:assert/strict";
import test from "node:test";

import {
  S2_PAGE_KEYS,
  S2_PAGE_SIGNALS,
  evaluateKey,
  initialKeyState,
} from "../scripts/ops-observer/classify-core.mjs";
import { isKeyState, keysAreValid } from "../scripts/ops-observer/keys-schema-core.mjs";

const initialKeys = () => Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
const P3 = S2_PAGE_SIGNALS.find((s) => s.id === "P3");

test("the keys a genesis starts with are valid", () => {
  assert.equal(keysAreValid(initialKeys()), true);
});

test("every state evaluateKey() reaches from a genesis is valid", () => {
  // Drive each signal through its bands, recovery, reopen and unknowns.
  const observationsFor = (signal) => [...signal.bands, "ok", "unknown"];
  let now = Date.parse("2026-10-04T00:00:00.000Z");
  for (const signal of S2_PAGE_SIGNALS) {
    let state = initialKeyState();
    const seen = [];
    let seed = 12345;
    for (let step = 0; step < 400; step += 1) {
      const options = observationsFor(signal);
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const observation = options[seed % options.length];
      now += 10 * 60 * 1000;
      const ownerDate = new Date(now).toISOString().slice(0, 10);
      ({ state } = evaluateKey(signal, state, observation, { now, ownerDate }));
      seen.push(state.status);
      assert.equal(isKeyState(signal, state), true, `${signal.id} ${JSON.stringify(state)}`);
    }
    assert.ok(seen.includes("open") && seen.includes("closed"), signal.id);
  }
});

test("a state evaluateKey() could not produce is refused", () => {
  const open = { status: "open", streak: 0, openedAt: 1, lastBand: "delayed", recoveredAt: null, newOpenOwnerDate: "2026-10-04" };
  assert.equal(isKeyState(P3, open), true);
  for (const bad of [
    { ...open, status: "paused" },
    { ...open, streak: 4 },
    { ...open, streak: -1 },
    { ...open, streak: 1.5 },
    { ...open, openedAt: null },
    { ...open, openedAt: "2026-10-04T00:00:00Z" },
    { ...open, openedAt: -1 },
    { ...open, lastBand: "false" },
    { ...open, lastBand: null },
    { ...open, newOpenOwnerDate: null },
    { ...open, newOpenOwnerDate: "2026-02-30" },
    { ...open, newOpenOwnerDate: "2026-10-4" },
    { ...open, recoveredAt: 1.5 },
    { ...open, extra: true },
    Object.fromEntries(Object.entries(open).filter(([field]) => field !== "lastBand")),
    { ...initialKeyState(), lastBand: "delayed" },
    null,
    [],
  ]) {
    assert.equal(isKeyState(P3, bad), false, JSON.stringify(bad));
  }
});

test("streaks and closed-state triples evaluateKey() never writes are refused", () => {
  const P1a = S2_PAGE_SIGNALS.find((s) => s.id === "P1a"); // opens after 3
  const PD = S2_PAGE_SIGNALS.find((s) => s.id === "P-D"); // opens after 1
  const open = { status: "open", streak: 0, openedAt: 2_000, lastBand: "false", recoveredAt: null, newOpenOwnerDate: "2026-10-04" };
  const never = initialKeyState();
  const recovered = { ...never, openedAt: 1_000, recoveredAt: 2_000, newOpenOwnerDate: "2026-10-04" };
  for (const [signal, state] of [
    [P1a, open],
    [P1a, { ...open, streak: 1 }],
    [P1a, { ...open, recoveredAt: 1_000 }],
    [P1a, never],
    [P1a, { ...never, streak: 2 }],
    [P1a, recovered],
    [PD, never],
  ]) {
    assert.equal(isKeyState(signal, state), true, JSON.stringify(state));
  }
  for (const [signal, state] of [
    // An open key with a recovery-sized streak would recover on one good sample.
    [P1a, { ...open, streak: 2 }],
    [P1a, { ...open, streak: 3 }],
    // A recovery after the current open belongs to no incident.
    [P1a, { ...open, recoveredAt: 3_000 }],
    // A closed key at its opening streak would have opened.
    [P1a, { ...never, streak: 3 }],
    [PD, { ...never, streak: 1 }],
    // Mixed closed triples.
    [P1a, { ...never, newOpenOwnerDate: "2026-10-04" }],
    [P1a, { ...never, recoveredAt: 2_000 }],
    [P1a, { ...never, openedAt: 1_000 }],
    [P1a, { ...recovered, newOpenOwnerDate: null }],
    [P1a, { ...recovered, recoveredAt: null }],
    [P1a, { ...recovered, openedAt: null }],
    [P1a, { ...recovered, recoveredAt: 500 }],
  ]) {
    assert.equal(isKeyState(signal, state), false, JSON.stringify(state));
  }
});

test("the key set is exactly the S2 page keys", () => {
  const keys = initialKeys();
  assert.equal(keysAreValid({ ...keys, "P9#x": initialKeyState() }), false);
  const missing = Object.fromEntries(Object.entries(keys).slice(1));
  assert.equal(keysAreValid(missing), false);
  assert.equal(keysAreValid({ ...keys, [S2_PAGE_KEYS[0]]: { ...initialKeyState(), status: "open" } }), false);
  for (const value of [null, [], "{}", Object.create(null)]) assert.equal(keysAreValid(value), false);
});
