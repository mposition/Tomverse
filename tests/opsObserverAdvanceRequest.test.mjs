// The advance request body: closed keys, valid key states, and at most one
// reservation whose items each name a page key once per kind and agree with
// the key state the same request writes. Whether an item is capped is the
// store's to decide, so the body cannot say.

import assert from "node:assert/strict";
import test from "node:test";

import { S2_PAGE_KEYS, S2_PAGE_SIGNALS, evaluateKey, initialKeyState } from "../scripts/ops-observer/classify-core.mjs";
import { parseAdvanceRequest } from "../scripts/ops-observer/advance-request-core.mjs";
import { REQUEST_BODY_MAX_BYTES } from "../scripts/ops-observer/request-schema-core.mjs";

const NOW = Date.parse("2026-10-04T01:00:00.000Z");
const OWNER_DATE = "2026-10-04";
const GENESIS = "11111111-1111-4111-8111-111111111111";
const P3 = S2_PAGE_SIGNALS.find((s) => s.id === "P3");
const P3_KEY = "P3#credit_reservation_reconciliation";

/** Keys after P3 opened at NOW (new_open), every other key at its genesis state. */
function keysWithP3Open() {
  const keys = Object.fromEntries(S2_PAGE_KEYS.map((key) => [key, initialKeyState()]));
  keys[P3_KEY] = evaluateKey(P3, initialKeyState(), "delayed", { now: NOW, ownerDate: OWNER_DATE }).state;
  return keys;
}

function body(overrides = {}) {
  return {
    runDeadline: new Date(NOW + 60_000).toISOString(),
    runId: "run-1",
    baseGenesisId: GENESIS,
    baseGeneration: 7,
    keys: keysWithP3Open(),
    reservation: {
      ownerDate: OWNER_DATE,
      channelCheck: false,
      items: [{ signal: "P3", scope: "credit_reservation_reconciliation", kind: "new_open", origin: "new", openedAt: NOW }],
    },
    ...overrides,
  };
}

const parse = (value) => parseAdvanceRequest(typeof value === "string" ? value : JSON.stringify(value), NOW);
const edited = (mutate) => {
  const value = body();
  mutate(value);
  return parse(value);
};

test("a well-formed advance parses, items carrying their open time as a Date", () => {
  const result = parse(body());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.reservation.items, [
    { signal: "P3", scope: "credit_reservation_reconciliation", kind: "new_open", origin: "new", openedAt: new Date(NOW) },
  ]);
  assert.equal(result.value.runDeadline.getTime(), NOW + 60_000);
  assert.equal(parse(body({ reservation: null })).ok, true);
  assert.equal(parse(body({ reservation: { ownerDate: OWNER_DATE, channelCheck: true, items: [] } })).ok, true);
});

test("worsening and recovery items agree with the key state written alongside", () => {
  const keys = keysWithP3Open();
  const worse = evaluateKey(P3, keys[P3_KEY], "stuck", { now: NOW + 600_000, ownerDate: OWNER_DATE }).state;
  const item = { signal: "P3", scope: "credit_reservation_reconciliation", origin: "new", openedAt: NOW };
  assert.equal(
    parse(body({ keys: { ...keys, [P3_KEY]: worse }, reservation: { ownerDate: OWNER_DATE, channelCheck: false, items: [{ ...item, kind: "worsening" }] } })).ok,
    true,
  );
  let recovered = evaluateKey(P3, worse, "ok", { now: NOW + 1_200_000, ownerDate: OWNER_DATE }).state;
  recovered = evaluateKey(P3, recovered, "ok", { now: NOW + 1_800_000, ownerDate: OWNER_DATE }).state;
  assert.equal(recovered.status, "closed");
  assert.equal(
    parse(body({ keys: { ...keys, [P3_KEY]: recovered }, reservation: { ownerDate: OWNER_DATE, channelCheck: false, items: [{ ...item, kind: "recovery" }] } })).ok,
    true,
  );
  // A recovery for a key that is still open, or an open message for a closed key.
  assert.deepEqual(
    parse(body({ reservation: { ownerDate: OWNER_DATE, channelCheck: false, items: [{ ...item, kind: "recovery" }] } })),
    { ok: false, error: "reservation_invalid" },
  );
  assert.deepEqual(
    parse(body({ keys: { ...keys, [P3_KEY]: recovered }, reservation: { ownerDate: OWNER_DATE, channelCheck: false, items: [{ ...item, kind: "worsening" }] } })),
    { ok: false, error: "reservation_invalid" },
  );
});

test("a reservation that disagrees with the keys or repeats itself is refused", () => {
  const cases = [
    (b) => (b.reservation.items[0].openedAt = NOW - 1),
    (b) => (b.reservation.items[0].origin = "reopen"),
    (b) => (b.reservation.items[0].kind = "reopen"),
    (b) => (b.reservation.items[0].scope = "database"),
    (b) => (b.reservation.items[0].signal = "P9"),
    (b) => b.reservation.items.push({ ...b.reservation.items[0] }),
    (b) => (b.reservation.items = []),
    (b) => (b.reservation.items = Array.from({ length: S2_PAGE_KEYS.length + 1 }, () => b.reservation.items[0])),
  ];
  for (const mutate of cases) {
    assert.deepEqual(edited(mutate), { ok: false, error: "reservation_invalid" }, String(mutate));
  }
});

test("the body and the reservation are closed, and a capped flag cannot be sent", () => {
  const shapes = [
    (b) => (b.extra = 1),
    (b) => delete b.reservation,
    (b) => (b.reservation.items[0].capped = false),
    (b) => (b.reservation.extra = 1),
    (b) => (b.reservation.ownerDate = "2026-02-30"),
    (b) => (b.reservation.channelCheck = "false"),
    (b) => (b.reservation.items[0].kind = "page"),
    (b) => (b.reservation.items[0].openedAt = new Date(NOW).toISOString()),
    (b) => (b.runId = "Run 1"),
    (b) => (b.baseGenesisId = GENESIS.toUpperCase().replace("1", "A")),
    (b) => (b.baseGeneration = -1),
    (b) => (b.baseGeneration = "7"),
  ];
  for (const mutate of shapes) {
    assert.deepEqual(edited(mutate), { ok: false, error: "shape" }, String(mutate));
  }
});

test("keys, deadline, size and JSON are checked", () => {
  assert.deepEqual(edited((b) => (b.keys[P3_KEY].streak = 3)), { ok: false, error: "keys_invalid" });
  assert.deepEqual(edited((b) => delete b.keys[P3_KEY]), { ok: false, error: "keys_invalid" });
  assert.deepEqual(edited((b) => (b.runDeadline = new Date(NOW + 181_000).toISOString())), { ok: false, error: "deadline_invalid" });
  assert.deepEqual(parse("{"), { ok: false, error: "not_json" });
  assert.deepEqual(parse(`${JSON.stringify(body())}${" ".repeat(REQUEST_BODY_MAX_BYTES)}`), { ok: false, error: "too_large" });
  assert.deepEqual(parse("[]"), { ok: false, error: "shape" });
});
