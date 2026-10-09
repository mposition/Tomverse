// The daily budget (docs/policy/sre-ops.md §5): new opens and the first
// worsening per key per date are never capped, everything else shares a cap of
// 6, one message per run, and over any sequence of observations one owner date
// carries at most 15 page messages (16 with the channel check, 31 on a genesis
// day).

import assert from "node:assert/strict";
import test from "node:test";

import { S2_PAGE_SIGNALS, evaluateKey, initialKeyState } from "../scripts/ops-observer/classify-core.mjs";
import {
  DAILY_CAPPED_LIMIT,
  admitOwedItems,
  maxDailyMessages,
  maxMessagesOnGenesisDay,
  planRunMessage,
} from "../scripts/ops-observer/notification-budget-core.mjs";

const S2 = {
  keyCount: S2_PAGE_SIGNALS.reduce((n, s) => n + s.scopes.length, 0),
  worseningKeyCount: S2_PAGE_SIGNALS.filter((s) => s.bands.length > 1).reduce((n, s) => n + s.scopes.length, 0),
};

test("the S2 maxima are the policy's 15 / 16 / 31", () => {
  assert.deepEqual(S2, { keyCount: 8, worseningKeyCount: 1 });
  assert.equal(maxDailyMessages(S2), 15);
  assert.equal(maxDailyMessages({ ...S2, channelCheckDay: true }), 16);
  assert.equal(maxMessagesOnGenesisDay(S2), 31);
});

test("new opens pass even when the shared cap is spent", () => {
  const reservedToday = Array.from({ length: DAILY_CAPPED_LIMIT }, (_, i) => ({
    key: `k${i}`,
    kind: i % 2 ? "recovery" : "reopen",
    capped: true,
  }));
  const { admitted, deferred } = admitOwedItems({
    reservedToday,
    owed: [
      { key: "a", kind: "new_open" },
      { key: "a", kind: "worsening" },
      { key: "b", kind: "recovery" },
    ],
  });
  assert.deepEqual(admitted.map((i) => [i.key, i.kind, i.capped]), [
    ["a", "new_open", false],
    ["a", "worsening", false],
  ]);
  assert.deepEqual(deferred.map((i) => [i.key, i.kind]), [["b", "recovery"]]);
});

test("a key's second worsening on the same date is capped, whatever started the incident", () => {
  const { admitted } = admitOwedItems({
    reservedToday: [{ key: "cron", kind: "worsening", capped: false }],
    owed: [{ key: "cron", kind: "worsening" }],
  });
  assert.deepEqual(admitted.map((i) => i.capped), [true]);
});

test("one message per run, bundling the check when due", () => {
  assert.equal(planRunMessage({ admitted: [], channelCheckDue: false }), null);
  assert.deepEqual(planRunMessage({ admitted: [], channelCheckDue: true }), {
    kind: "channel_check",
    items: [],
    withChannelCheck: true,
  });
  const items = [{ key: "a", kind: "new_open", capped: false }, { key: "b", kind: "recovery", capped: true }];
  const plan = planRunMessage({ admitted: items, channelCheckDue: true });
  assert.equal(plan.kind, "page");
  assert.equal(plan.items.length, 2);
  assert.equal(plan.withChannelCheck, true);
});

test("unknown kinds and empty keys throw", () => {
  assert.throws(() => admitOwedItems({ reservedToday: [], owed: [{ key: "a", kind: "heartbeat" }] }), /kind_unknown/);
  assert.throws(() => admitOwedItems({ reservedToday: [], owed: [{ key: "", kind: "new_open" }] }), /key_invalid/);
});

// A seeded generator so a failure reproduces.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

function simulateDay(seed, { evaluations = 150, badBias = 0.5 } = {}) {
  const random = rng(seed);
  const keys = S2_PAGE_SIGNALS.flatMap((s) => s.scopes.map((scope) => ({ key: `${s.id}#${scope}`, signal: s })));
  const states = new Map(keys.map(({ key }) => [key, initialKeyState()]));
  const reservedToday = [];
  let messages = 0;
  for (let i = 0; i < evaluations; i += 1) {
    const owed = [];
    for (const { key, signal } of keys) {
      const r = random();
      const observation = r < 0.1 ? "unknown" : r < 0.1 + badBias ? signal.bands[Math.floor(random() * signal.bands.length)] : "ok";
      const out = evaluateKey(signal, states.get(key), observation, { now: i * 10 * 60_000, ownerDate: "2026-11-01" });
      states.set(key, out.state);
      if (out.message) owed.push({ key, kind: out.message });
    }
    const { admitted } = admitOwedItems({ reservedToday, owed });
    reservedToday.push(...admitted);
    if (planRunMessage({ admitted, channelCheckDue: false })) messages += 1;
  }
  return { messages, reservedToday };
}

test("property: no observation sequence puts more than 15 messages on one owner date", () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const bias = [0.2, 0.5, 0.8][seed % 3];
    const { messages, reservedToday } = simulateDay(seed, { badBias: bias });
    assert.ok(messages <= maxDailyMessages(S2), `seed ${seed}: ${messages} messages`);
    assert.ok(reservedToday.filter((i) => i.capped).length <= DAILY_CAPPED_LIMIT, `seed ${seed}: capped`);
    const newOpens = reservedToday.filter((i) => i.kind === "new_open").map((i) => i.key);
    assert.equal(new Set(newOpens).size, newOpens.length, `seed ${seed}: a key newly opened twice`);
  }
});
