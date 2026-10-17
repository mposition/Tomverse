// AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
// §10's system retention sweep (lib/amux/decisionMakerRetentionSweep.ts),
// without a database: which key periods it rotates in and destroys, the order
// of its writes, where an error stops it, and that it never throws, sends
// nothing twice or reads a switch. Its read's statements are pinned against
// its DB boundary here; each write's are pinned with its store's own tests
// (tests/amuxDecisionMakerRequest.test.mjs, tests/amuxDecisionMakerBody.test.mjs),
// and the whole sweep runs against PostgreSQL in
// tests/integration/amux-decision-maker-body.db.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError } from "../lib/amux/dbBoundary.ts";
import { DM_KEY_PERIOD_MS, dmKeyPeriodOf } from "../lib/amux/decisionMakerBodyCore.ts";
import { DecisionMakerDigestKeyError } from "../lib/amux/decisionMakerDigestKeys.ts";
import {
  DM_RETENTION_SWEEP_LIMIT,
  dmKeyPeriodsToDestroy,
  dmKeyPeriodsToRotate,
  readDecisionMakerRetentionCandidates,
  runDecisionMakerRetentionSweep,
} from "../lib/amux/decisionMakerRetentionSweep.ts";

const NOW = 1_790_000_000_000;
const CURRENT = dmKeyPeriodOf(NOW);
const KEY = Buffer.alloc(32, 7);
const ring = (...periods) => new Map(periods.map((period) => [period, KEY]));
const entry = (keyPeriod, fields = {}) => ({ keyPeriod, rotated: true, destroyed: false, hasBodies: false, ...fields });
const registry = (periods = [], dbNowMs = NOW) => ({ dbNowMs, periods });

const REQUEST_A = "00000000-0000-4000-8000-00000000000a";
const REQUEST_B = "00000000-0000-4000-8000-00000000000b";
const REQUEST_C = "00000000-0000-4000-8000-00000000000c";

test("the key periods to rotate in: the current and the next, held by the ring and not yet in the registry", () => {
  assert.deepEqual(dmKeyPeriodsToRotate(registry(), ring(CURRENT, CURRENT + 1)), [CURRENT, CURRENT + 1]);
  // One the ring does not hold is not rotated; one further ahead is never asked for.
  assert.deepEqual(dmKeyPeriodsToRotate(registry(), ring(CURRENT + 1, CURRENT + 2)), [CURRENT + 1]);
  assert.deepEqual(dmKeyPeriodsToRotate(registry(), ring(CURRENT - 1)), []);
  // Rotated or destroyed already: nothing to do.
  assert.deepEqual(dmKeyPeriodsToRotate(registry([entry(CURRENT)]), ring(CURRENT, CURRENT + 1)), [CURRENT + 1]);
  assert.deepEqual(
    dmKeyPeriodsToRotate(registry([entry(CURRENT + 1, { rotated: false, destroyed: true })]), ring(CURRENT, CURRENT + 1)),
    [CURRENT],
  );
  // The period is the database clock's, not the caller's.
  const lateInPeriod = (CURRENT + 1) * DM_KEY_PERIOD_MS - 1;
  assert.deepEqual(dmKeyPeriodsToRotate(registry([], lateInPeriod), ring(CURRENT, CURRENT + 1, CURRENT + 2)), [CURRENT, CURRENT + 1]);
  assert.deepEqual(dmKeyPeriodsToRotate(registry([], lateInPeriod + 1), ring(CURRENT, CURRENT + 1, CURRENT + 2)), [CURRENT + 1, CURRENT + 2]);
});

test("the key periods to destroy: rotated, not destroyed, ended by the database clock, with no body left", () => {
  const periods = [
    entry(CURRENT - 3),
    entry(CURRENT - 2, { hasBodies: true }),
    entry(CURRENT - 1, { destroyed: true }),
    entry(CURRENT),
    entry(CURRENT + 1),
    entry(CURRENT - 4, { rotated: false, destroyed: false }),
  ];
  assert.deepEqual(dmKeyPeriodsToDestroy(registry(periods)), [CURRENT - 3]);
  // The current period ends at its last millisecond, not before.
  const end = (CURRENT + 1) * DM_KEY_PERIOD_MS;
  assert.deepEqual(dmKeyPeriodsToDestroy(registry([entry(CURRENT)], end - 1)), []);
  assert.deepEqual(dmKeyPeriodsToDestroy(registry([entry(CURRENT)], end)), [CURRENT]);
});

/** Collaborators that record every call and answer as told. */
const fakeDeps = ({
  candidates = { staleRequestIds: [], purgeRequestIds: [], registry: registry() },
  keyRing = ring(CURRENT, CURRENT + 1),
  answers = {},
} = {}) => {
  const calls = [];
  const answer = (name, arg, fallback) => {
    calls.push([name, arg]);
    const value = answers[`${name}:${arg}`];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? fallback);
  };
  return {
    calls,
    deps: {
      validationLatch: (instance) => answer("validationLatch", instance, { latched: false, reason: "no_streak" }),
      readCandidates: () => {
        calls.push(["read"]);
        return candidates instanceof Error ? Promise.reject(candidates) : Promise.resolve(candidates);
      },
      loadKeyRing: () => {
        calls.push(["keyRing"]);
        if (keyRing instanceof Error) throw keyRing;
        return keyRing;
      },
      rotate: (keyPeriod) => answer("rotate", keyPeriod, { recorded: true }),
      staleClose: (requestId) => answer("staleClose", requestId, { recorded: true }),
      purge: (requestId) => answer("purge", requestId, { deleted: true }),
      destroy: (keyPeriod) => answer("destroy", keyPeriod, { recorded: true }),
    },
  };
};

const quiet = async (work) => {
  const warn = console.warn;
  const warned = [];
  console.warn = (line) => warned.push(line);
  try {
    return { value: await work(), warned };
  } finally {
    console.warn = warn;
  }
};

const LATCH_CHECKS = [
  ["validationLatch", "decision-maker-openai"],
  ["validationLatch", "decision-maker-anthropic"],
];

test("one sweep: §8's latch check for each instance, then read once, rotate, close, purge and destroy, each candidate once, in that order", async () => {
  const { deps, calls } = fakeDeps({
    candidates: {
      staleRequestIds: [REQUEST_A, REQUEST_B],
      purgeRequestIds: [REQUEST_C],
      registry: registry([entry(CURRENT - 2), entry(CURRENT - 1, { hasBodies: true })]),
    },
    answers: { [`staleClose:${REQUEST_B}`]: { recorded: false, reason: "closed" } },
  });
  const { value, warned } = await quiet(() => runDecisionMakerRetentionSweep(deps));
  assert.deepEqual(calls, [
    ...LATCH_CHECKS,
    ["read"],
    ["keyRing"],
    ["rotate", CURRENT],
    ["rotate", CURRENT + 1],
    ["staleClose", REQUEST_A],
    ["staleClose", REQUEST_B],
    ["purge", REQUEST_C],
    ["destroy", CURRENT - 2],
  ]);
  assert.deepEqual(value, {
    validationLatched: 0,
    validationLatchUnsettled: 0,
    keyRing: "loaded",
    keysRotated: 2,
    staleClosed: 1,
    purged: 1,
    keysDestroyed: 1,
    refused: 1,
    stopped: null,
  });
  assert.deepEqual(warned, []);
});

test("§8's latch check counts the instances it latched, and an instance already latched is not a refusal", async () => {
  const { deps, calls } = fakeDeps({
    answers: {
      "validationLatch:decision-maker-openai": { latched: true, event: { eventId: "e" } },
      "validationLatch:decision-maker-anthropic": { latched: false, reason: "already_latched" },
    },
  });
  const { value, warned } = await quiet(() => runDecisionMakerRetentionSweep(deps));
  assert.deepEqual(calls.slice(0, 3), [...LATCH_CHECKS, ["read"]]);
  assert.equal(value.validationLatched, 1);
  assert.equal(value.refused, 0);
  assert.equal(value.stopped, null);
  assert.deepEqual(warned, []);
});

test("a latch check that fails holds back neither the other instance's check nor any of the retention work", async () => {
  // Review r-20261017-015440-e7035c: a switch read or a result that fails every
  // run must not stop the expiry purge, the stale close or the key destruction
  // (docs/policy/amux-decision-maker.md §10).
  const candidates = {
    staleRequestIds: [REQUEST_A],
    purgeRequestIds: [REQUEST_C],
    registry: registry([entry(CURRENT - 2)]),
  };
  const retention = [
    ["read"],
    ["keyRing"],
    ["rotate", CURRENT],
    ["rotate", CURRENT + 1],
    ["staleClose", REQUEST_A],
    ["purge", REQUEST_C],
    ["destroy", CURRENT - 2],
  ];
  for (const [failing, codes] of [
    [["decision-maker-openai"], ["AMUX_DB_OUTCOME_UNKNOWN"]],
    [["decision-maker-anthropic"], ["AMUX_DB_OUTCOME_UNKNOWN"]],
    [["decision-maker-openai", "decision-maker-anthropic"], ["AMUX_DB_OUTCOME_UNKNOWN", "AMUX_DB_OUTCOME_UNKNOWN"]],
  ]) {
    const answers = Object.fromEntries(
      failing.map((instance) => [`validationLatch:${instance}`, new AmuxDbBoundaryError("AMUX_DB_OUTCOME_UNKNOWN", "test")]),
    );
    const { deps, calls } = fakeDeps({ candidates, answers });
    const { value, warned } = await quiet(() => runDecisionMakerRetentionSweep(deps));
    // Both checks are tried, once each, and the retention work runs through.
    assert.deepEqual(calls, [...LATCH_CHECKS, ...retention], failing.join());
    assert.equal(value.stopped, null, failing.join());
    assert.equal(value.validationLatchUnsettled, failing.length, failing.join());
    assert.deepEqual([value.staleClosed, value.purged, value.keysDestroyed, value.keysRotated], [1, 1, 1, 2], failing.join());
    // One line per failed check: the instance and the code, nothing else.
    assert.deepEqual(
      warned.map((line) => JSON.parse(line)),
      failing.map((instance, index) => ({
        subsystem: "amux",
        event: "decision_maker_validation_latch_check_failed",
        instance,
        code: codes[index],
      })),
      failing.join(),
    );
  }
  // An error the sweep does not know reports no code, never its message.
  const { deps } = fakeDeps({ answers: { "validationLatch:decision-maker-openai": new Error("relation with a value in it") } });
  const { value, warned } = await quiet(() => runDecisionMakerRetentionSweep(deps));
  assert.equal(value.stopped, null);
  assert.deepEqual(JSON.parse(warned[0]), {
    subsystem: "amux",
    event: "decision_maker_validation_latch_check_failed",
    instance: "decision-maker-openai",
    code: null,
  });
  assert.doesNotMatch(warned.join("\n"), /value in it/);
});

test("an error stops the sweep where it is: nothing after it, nothing sent again, nothing thrown", async () => {
  for (const [step, key] of [
    ["rotate", `rotate:${CURRENT + 1}`],
    ["stale_close", `staleClose:${REQUEST_A}`],
    ["purge", `purge:${REQUEST_C}`],
    ["destroy", `destroy:${CURRENT - 2}`],
  ]) {
    const { deps, calls } = fakeDeps({
      candidates: {
        staleRequestIds: [REQUEST_A, REQUEST_B],
        purgeRequestIds: [REQUEST_C],
        registry: registry([entry(CURRENT - 2), entry(CURRENT - 3)]),
      },
      answers: { [key]: new AmuxDbBoundaryError("AMUX_DB_OUTCOME_UNKNOWN", "test") },
    });
    const { value, warned } = await quiet(() => runDecisionMakerRetentionSweep(deps));
    assert.deepEqual(value.stopped, { step, code: "AMUX_DB_OUTCOME_UNKNOWN" }, step);
    // The failing call is the last call, and no call is made twice.
    assert.deepEqual(calls.at(-1), [key.split(":")[0], key.includes("-") ? key.slice(key.indexOf(":") + 1) : Number(key.split(":")[1])], step);
    assert.equal(new Set(calls.map((call) => JSON.stringify(call))).size, calls.length, step);
    assert.equal(warned.length, 1, step);
    assert.deepEqual(JSON.parse(warned[0]), {
      subsystem: "amux",
      event: "decision_maker_retention_sweep_stopped",
      step,
      code: "AMUX_DB_OUTCOME_UNKNOWN",
    });
  }
});

test("a failed read writes nothing after the latch checks", async () => {
  const { deps, calls } = fakeDeps({ candidates: new AmuxDbBoundaryError("AMUX_DB_READ_BUSY", "test") });
  const { value } = await quiet(() => runDecisionMakerRetentionSweep(deps));
  assert.deepEqual(calls, [...LATCH_CHECKS, ["read"]]);
  assert.deepEqual(value.stopped, { step: "read", code: "AMUX_DB_READ_BUSY" });
  assert.equal(value.keysRotated + value.staleClosed + value.purged + value.keysDestroyed, 0);
});

test("no key ring rotates nothing and stays quiet; a malformed one is reported; the rest of the sweep runs either way", async () => {
  for (const [error, expected, warnings] of [
    [new DecisionMakerDigestKeyError("not_configured"), "not_configured", 0],
    [new DecisionMakerDigestKeyError("malformed"), "malformed", 1],
  ]) {
    const { deps, calls } = fakeDeps({
      keyRing: error,
      candidates: { staleRequestIds: [REQUEST_A], purgeRequestIds: [], registry: registry() },
    });
    const { value, warned } = await quiet(() => runDecisionMakerRetentionSweep(deps));
    assert.equal(value.keyRing, expected);
    assert.equal(value.keysRotated, 0);
    assert.equal(value.staleClosed, 1);
    assert.ok(!calls.some(([name]) => name === "rotate"));
    assert.equal(warned.length, warnings);
    // The warning names nothing about the ring's contents.
    for (const line of warned) assert.deepEqual(Object.keys(JSON.parse(line)), ["subsystem", "event"]);
  }
});

test("the sweep's read is three statements, and its boundary is those plus setup and fence", async () => {
  const sent = [];
  const tx = {
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ sql, values });
      if (sql.includes('FROM "AmuxDecisionMakerRequest" r')) return Promise.resolve([{ id: REQUEST_A }]);
      if (sql.includes('FROM "AmuxDecisionMakerRetentionEvent" re')) return Promise.resolve([{ requestId: REQUEST_C }]);
      if (sql.includes("WITH db_clock AS MATERIALIZED")) {
        return Promise.resolve([{ dbNowEpochMs: BigInt(NOW), keyPeriod: CURRENT, rotated: true, destroyed: false, hasBodies: true }]);
      }
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
  };
  const candidates = await readDecisionMakerRetentionCandidates(tx);
  assert.deepEqual(candidates, {
    staleRequestIds: [REQUEST_A],
    purgeRequestIds: [REQUEST_C],
    registry: { dbNowMs: NOW, periods: [entry(CURRENT, { hasBodies: true })] },
  });
  assert.equal(sent.length, 3);
  for (const statement of sent) assert.doesNotMatch(statement.sql, /INSERT|UPDATE|DELETE/);
  // Each list is bounded by the sweep's limit.
  assert.deepEqual(sent[0].values.at(-1), DM_RETENTION_SWEEP_LIMIT);
  assert.deepEqual(sent[1].values.at(-1), DM_RETENTION_SWEEP_LIMIT);
  // The stale threshold is §10's 30 days, by the database clock.
  assert.match(sent[0].sql, /r\."createdAt" <= clock_timestamp\(\) - \$ \* INTERVAL '1 millisecond'/);
  assert.equal(sent[0].values[0], 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerRetentionRead, {
    operation: "decision_maker_retention_read",
    prismaCallCeiling: sent.length + 2,
    isolation: "read",
  });
});

test("an empty registry still carries the database clock", async () => {
  const tx = {
    $queryRaw: (strings) => {
      const sql = strings.join("$");
      if (sql.includes("WITH db_clock AS MATERIALIZED")) {
        return Promise.resolve([{ dbNowEpochMs: BigInt(NOW), keyPeriod: null, rotated: null, destroyed: null, hasBodies: null }]);
      }
      return Promise.resolve([]);
    },
  };
  assert.deepEqual((await readDecisionMakerRetentionCandidates(tx)).registry, { dbNowMs: NOW, periods: [] });
});

test("the sweep writes only through the stores, reads no switch, and is on the maintenance schedule", () => {
  const sweep = readFileSync(join(process.cwd(), "lib/amux/decisionMakerRetentionSweep.ts"), "utf8");
  // No SQL of its own: every read and write is a store's.
  assert.doesNotMatch(sweep, /\$queryRaw|\$executeRaw|INSERT|UPDATE|DELETE FROM/);
  // §6's table allows all of it under the kill switch, and a latch only turns an
  // instance off, so no switch is read here; the latch check is the request store's.
  assert.doesNotMatch(sweep, /readDecisionMakerSwitches|decisionMakerSwitchStore|latchDecisionMakerInstanceOff/);
  assert.match(sweep, /recordDecisionMakerValidationLatch\(tx, \{ instance \}\)/);
  // Each write is in its own boundary transaction.
  for (const boundary of [
    "decisionMakerValidationLatch",
    "decisionMakerRetentionRead",
    "decisionMakerDigestKeyRotate",
    "decisionMakerStaleClose",
    "decisionMakerBodyPurge",
    "decisionMakerDigestKeyDestroy",
  ]) {
    assert.match(sweep, new RegExp(`AMUX_DB_BOUNDARIES\\.${boundary}\\b`), boundary);
  }
  const route = readFileSync(join(process.cwd(), "app/api/internal/maintenance/credit-reservations/route.ts"), "utf8");
  assert.match(route, /const decisionMakerRetention = await runDecisionMakerRetentionMaintenanceQuietly\(\);/);
});
