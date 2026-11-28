import assert from "node:assert/strict";
import test from "node:test";

import {
  READOUT_CHUNK_MAX_CHARACTERS,
  READOUT_ENV,
  READOUT_MAX_CHUNKS,
  readoutRefusal,
  resolveReadoutLimits,
} from "../lib/chatReadoutAccess.ts";
import {
  READOUT_BUDGET_PERIODS,
  ReadoutBudgetError,
  reserveReadoutCharacters,
  settleReadoutReservation,
} from "../lib/chatReadoutBudgetCore.ts";
import {
  READOUT_MODEL_PRICE_REGISTER,
  auditReadoutPriceRegister,
  readoutModelPriceRefusal,
} from "../lib/chatReadoutPricing.ts";
import { readoutSpeechEndpoint, synthesizeReadoutSpeech } from "../lib/chatReadoutSpeechCore.ts";
import { readoutPieces } from "../lib/chatReadoutText.ts";
import { createReadoutAudioCache, readoutCacheKey } from "../lib/chatServerReadout.ts";

/* ------------------------------------------------------------- text ---- */

test("server read-aloud skips code, Mermaid, charts, tables and formulas", () => {
  const { chunks, truncated } = readoutPieces(
    [
      "# Plan",
      "Read **this** part.",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "```chart",
      '{"type":"bar"}',
      "```",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "$$x^2$$",
      "And this one.",
    ].join("\n")
  );
  assert.equal(truncated, false);
  assert.deepEqual(chunks, ["Plan\nRead this part.\nAnd this one."]);
});

test("pieces are packed up to the piece size and capped in number", () => {
  const sentence = "This sentence is exactly fifty characters long ok. ";
  const long = Array.from({ length: 400 }, () => sentence).join("\n");
  const { chunks, truncated } = readoutPieces(long);
  assert.equal(chunks.length, READOUT_MAX_CHUNKS);
  assert.equal(truncated, true);
  assert.ok(chunks.every((chunk) => chunk.length <= READOUT_CHUNK_MAX_CHARACTERS));
  // Packed, not one request per sentence.
  assert.ok(chunks[0].length > READOUT_CHUNK_MAX_CHARACTERS - sentence.length - 1);
  // Deterministic: the route recomputes the same piece on every request.
  assert.deepEqual(readoutPieces(long).chunks, chunks);
  assert.deepEqual(readoutPieces("```js\nonly code\n```").chunks, []);
  const small = readoutPieces("One. Two. Three.", { maxCharacters: 6, maxChunks: 2 });
  assert.deepEqual(small, { chunks: ["One.", "Two."], truncated: true });
});

/* --------------------------------------------------------- register ---- */

const observed = (overrides = {}) => [
  {
    ...READOUT_MODEL_PRICE_REGISTER[0],
    costObservation: {
      billedOn: "2026-11-29",
      // 100 text tokens at 0.60/1M + 1,000 audio tokens at 12/1M.
      totalUsd: 0.01206,
      requests: 1,
      billedTextInputQuantity: 100,
      billedAudioOutputQuantity: 1000,
      billedTextInputQuantityUnit: "tokens",
      billedAudioOutputQuantityUnit: "tokens",
      isolation: "one approved call",
      source: "GET /organization/costs",
    },
    ...overrides,
  },
];

test("the price register fails closed until an invoice has been reconciled", () => {
  assert.equal(readoutModelPriceRefusal({ modelId: "gpt-4o-mini-tts" })?.code, "cost_never_observed");
  assert.equal(readoutModelPriceRefusal({ modelId: "gpt-4o-mini-ttts" })?.code, "model_not_in_register");
  assert.equal(readoutModelPriceRefusal({ modelId: "tts-1" })?.code, "model_not_in_register");
  assert.equal(readoutModelPriceRefusal({ modelId: "gpt-4o-mini-tts", register: observed() }), null);
});

test("the register audit holds the deadline, the sources and the arithmetic", () => {
  const modelIds = ["gpt-4o-mini-tts"];
  assert.deepEqual(auditReadoutPriceRegister({ modelIds, now: new Date("2026-11-28T12:00:00Z") }), []);
  assert.deepEqual(
    auditReadoutPriceRegister({ modelIds, now: new Date("2027-01-06T00:00:00Z") }).map((problem) => problem.code),
    ["expired"]
  );
  assert.deepEqual(
    auditReadoutPriceRegister({ modelIds: ["tts-1"], now: new Date("2026-11-28T00:00:00Z") }).map((p) => p.code),
    ["missing_entry"]
  );
  const now = new Date("2026-11-30T00:00:00Z");
  assert.deepEqual(auditReadoutPriceRegister({ modelIds, now, register: observed() }), []);
  const codes = (register) => auditReadoutPriceRegister({ modelIds, now, register }).map((problem) => problem.code);
  assert.deepEqual(codes(observed({ reverifyBy: "2027-06-01" })), ["reverify_window_too_long"]);
  assert.deepEqual(codes(observed({ sources: ["pricing page"] })), ["source_missing"]);
  assert.deepEqual(codes(observed({ owner: " " })), ["owner_missing"]);
  const [entry] = observed();
  assert.deepEqual(
    codes([{ ...entry, costObservation: { ...entry.costObservation, totalUsd: 0.02 } }]),
    ["observation_does_not_reconcile"]
  );
  assert.deepEqual(
    codes([{ ...entry, costObservation: { ...entry.costObservation, billedAudioOutputQuantityUnit: "seconds" } }]),
    ["billed_unit_is_not_tokens"]
  );
});

/* --------------------------------------------------------- switches ---- */

const limitsEnv = {
  [READOUT_ENV.accountCharactersPerDay]: "20000",
  [READOUT_ENV.providerCharactersPerDay]: "200000",
  [READOUT_ENV.providerCharactersPerMonth]: "2000000",
};

test("the server voice opens only when every switch and limit agrees", () => {
  const register = observed();
  const on = { ...limitsEnv, [READOUT_ENV.enabled]: "true" };
  assert.equal(readoutRefusal({ env: on, hasProviderKey: true, register }), null);
  // The real register has no invoice yet, so the real answer today is "no".
  assert.equal(readoutRefusal({ env: on, hasProviderKey: true }), "price_not_verified");
  assert.equal(readoutRefusal({ env: {}, hasProviderKey: true, register }), "switch_off");
  for (const value of ["TRUE", "1", "yes", " true", ""]) {
    assert.equal(readoutRefusal({ env: { ...on, [READOUT_ENV.enabled]: value }, hasProviderKey: true, register }), "switch_off");
  }
  for (const value of ["1", "y", "off", "false"]) {
    assert.equal(
      readoutRefusal({ env: { ...on, [READOUT_ENV.killSwitch]: value }, hasProviderKey: true, register }),
      "kill_switch"
    );
  }
  assert.equal(readoutRefusal({ env: { ...on, [READOUT_ENV.killSwitch]: "  " }, hasProviderKey: true, register }), null);
  assert.equal(readoutRefusal({ env: on, hasProviderKey: false, register }), "provider_key_missing");
  const withoutMonth = { ...on, [READOUT_ENV.providerCharactersPerMonth]: undefined };
  assert.equal(readoutRefusal({ env: withoutMonth, hasProviderKey: true, register }), "limits_not_configured");
});

test("limits have no default and refuse unusable values", () => {
  assert.deepEqual(resolveReadoutLimits(limitsEnv), {
    accountCharactersPerDay: 20000,
    providerCharactersPerDay: 200000,
    providerCharactersPerMonth: 2000000,
  });
  assert.equal(resolveReadoutLimits({}), null);
  for (const bad of ["0", "-5", "1.5", "abc", "9007199254740993"]) {
    assert.equal(resolveReadoutLimits({ ...limitsEnv, [READOUT_ENV.accountCharactersPerDay]: bad }), null, bad);
  }
  assert.equal(resolveReadoutLimits({ ...limitsEnv, [READOUT_ENV.providerCharactersPerMonth]: "100" }), null);
});

/* ----------------------------------------------------------- budget ---- */

const memoryStore = () => {
  const rows = new Map();
  const id = (booking) => `${booking.key}|${booking.period}|${booking.periodStart.toISOString()}`;
  return {
    rows,
    count: (key, period, periodStart) => rows.get(`${key}|${period}|${periodStart.toISOString()}`) ?? 0,
    async book(booking) {
      const current = rows.get(id(booking)) ?? 0;
      // The SQL's shape: the first insert always lands, an update only with room.
      if (rows.has(id(booking)) && current > booking.limit - booking.characters) return false;
      rows.set(id(booking), current + booking.characters);
      return true;
    },
    async unbook(booking) {
      rows.set(id(booking), Math.max(0, (rows.get(id(booking)) ?? 0) - booking.characters));
    },
  };
};

const limits = { accountCharactersPerDay: 3000, providerCharactersPerDay: 5000, providerCharactersPerMonth: 6000 };
const now = new Date("2026-11-28T10:00:00Z");
const day = new Date("2026-11-28T00:00:00Z");
const month = new Date("2026-11-01T00:00:00Z");

test("a reservation books the account day and the provider day and month", async () => {
  const store = memoryStore();
  const reservation = await reserveReadoutCharacters({
    store, accountKey: "a", providerKey: "p", characters: 1200, limits, now,
  });
  assert.equal(reservation.characters, 1200);
  assert.equal(store.count("a", READOUT_BUDGET_PERIODS.accountDay, day), 1200);
  assert.equal(store.count("p", READOUT_BUDGET_PERIODS.providerDay, day), 1200);
  assert.equal(store.count("p", READOUT_BUDGET_PERIODS.providerMonth, month), 1200);
});

test("success and unknown outcomes keep the booking; refusals give it back, once", async () => {
  for (const [disposition, kept] of [["billed", true], ["indeterminate", true], ["refused", false], ["not_sent", false]]) {
    const store = memoryStore();
    const reservation = await reserveReadoutCharacters({ store, accountKey: "a", providerKey: "p", characters: 900, limits, now });
    const first = await settleReadoutReservation({ store, reservation, disposition });
    const second = await settleReadoutReservation({ store, reservation, disposition: "refused" });
    assert.equal(first.releasedCharacters, kept ? 0 : 900, disposition);
    assert.equal(second.releasedCharacters, 0, `${disposition}: a handle settles once`);
    assert.equal(store.count("a", READOUT_BUDGET_PERIODS.accountDay, day), kept ? 900 : 0, disposition);
    assert.equal(store.count("p", READOUT_BUDGET_PERIODS.providerMonth, month), kept ? 900 : 0, disposition);
  }
});

test("the account limit refuses before the shared budget is touched", async () => {
  const store = memoryStore();
  await reserveReadoutCharacters({ store, accountKey: "a", providerKey: "p", characters: 2500, limits, now });
  await assert.rejects(
    reserveReadoutCharacters({ store, accountKey: "a", providerKey: "p", characters: 600, limits, now }),
    (error) => error instanceof ReadoutBudgetError && error.bucket === "account_day" && error.retryAfterSeconds === 14 * 3600
  );
  assert.equal(store.count("p", READOUT_BUDGET_PERIODS.providerDay, day), 2500);
  // Another account still fits under the provider's day.
  await reserveReadoutCharacters({ store, accountKey: "b", providerKey: "p", characters: 2400, limits, now });
});

test("a refused month gives back the day and the account it already booked", async () => {
  const store = memoryStore();
  const tight = { ...limits, providerCharactersPerMonth: 5000 };
  await reserveReadoutCharacters({ store, accountKey: "a", providerKey: "p", characters: 2000, limits: tight, now });
  // Earlier this month, on another day: it fills the month but not today.
  await reserveReadoutCharacters({
    store, accountKey: "b", providerKey: "p", characters: 2900, limits: tight, now: new Date("2026-11-20T10:00:00Z"),
  });
  await assert.rejects(
    reserveReadoutCharacters({ store, accountKey: "c", providerKey: "p", characters: 200, limits: tight, now }),
    (error) => error instanceof ReadoutBudgetError && error.bucket === "provider_month"
  );
  assert.equal(store.count("c", READOUT_BUDGET_PERIODS.accountDay, day), 0);
  assert.equal(store.count("p", READOUT_BUDGET_PERIODS.providerDay, day), 2000);
});

test("a piece larger than a whole bucket is refused without booking anything", async () => {
  const store = memoryStore();
  await assert.rejects(
    reserveReadoutCharacters({ store, accountKey: "a", providerKey: "p", characters: 3001, limits, now }),
    (error) => error instanceof ReadoutBudgetError && error.bucket === "account_day"
  );
  assert.equal(store.rows.size, 0);
});

test("settlement returns the booking to the bucket it was taken from, across midnight", async () => {
  const store = memoryStore();
  const reservation = await reserveReadoutCharacters({
    store, accountKey: "a", providerKey: "p", characters: 700, limits, now: new Date("2026-11-30T23:59:59Z"),
  });
  await settleReadoutReservation({ store, reservation, disposition: "refused" });
  assert.equal(store.count("a", READOUT_BUDGET_PERIODS.accountDay, new Date("2026-11-30T00:00:00Z")), 0);
  assert.equal(store.count("p", READOUT_BUDGET_PERIODS.providerMonth, month), 0);
});

/* --------------------------------------------------------- provider ---- */

const fakeFetch = (respond) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond();
  };
  return { calls, fetchImpl };
};

test("the provider call is classified so unknown outcomes keep their booking", async () => {
  const notSent = fakeFetch(() => new Response("x"));
  assert.equal((await synthesizeReadoutSpeech({ text: "Hi", apiKey: "", fetchImpl: notSent.fetchImpl })).disposition, "not_sent");
  assert.equal(notSent.calls.length, 0);

  const cases = [
    [() => { throw new TypeError("fetch failed"); }, "indeterminate"],
    [() => new Response("no", { status: 429 }), "refused"],
    [() => new Response("no", { status: 400 }), "refused"],
    [() => new Response("no", { status: 503 }), "indeterminate"],
    [() => new Response(new Uint8Array(0), { status: 200 }), "indeterminate"],
    [() => new Response(new Uint8Array(20), { status: 200 }), "indeterminate", 10],
  ];
  for (const [respond, expected, maxBytes] of cases) {
    const { fetchImpl, calls } = fakeFetch(respond);
    const result = await synthesizeReadoutSpeech({ text: "Hi", apiKey: "k", fetchImpl, maxBytes });
    assert.equal(result.disposition, expected);
    assert.equal(calls.length, 1, "never retried");
  }

  const ok = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
  const spoken = await synthesizeReadoutSpeech({ text: "Hello there", apiKey: "k", fetchImpl: ok.fetchImpl });
  assert.equal(spoken.ok, true);
  assert.equal(spoken.disposition, "billed");
  assert.deepEqual([...spoken.audio], [1, 2, 3]);
  assert.equal(ok.calls[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(readoutSpeechEndpoint("https://example.test/"), "https://example.test/v1/audio/speech");
  assert.deepEqual(ok.calls[0].body, { model: "gpt-4o-mini-tts", voice: "marin", input: "Hello there", response_format: "mp3" });
  assert.equal(ok.calls[0].init.headers.Authorization, "Bearer k");
});

/* ------------------------------------------------------------ cache ---- */

test("fetched audio is kept per answer so a second press does not buy it again", () => {
  const cache = createReadoutAudioCache(2);
  const blob = new Blob([new Uint8Array([1])]);
  cache.set("m1", 0, blob, 2);
  assert.deepEqual(cache.get("m1", 0), { blob, chunks: 2 });
  assert.equal(cache.get("m1", 1), null);
  cache.set("m2", 0, blob, 1);
  cache.get("m1", 0); // m1 is now the most recent
  cache.set("m3", 0, blob, 1);
  assert.deepEqual(cache.keys(), ["m1", "m3"]);
  assert.notEqual(readoutCacheKey("m1", "Hello"), readoutCacheKey("m1", "Hello!"));
  assert.equal(readoutCacheKey("m1", "Hello"), readoutCacheKey("m1", "Hello"));
});
