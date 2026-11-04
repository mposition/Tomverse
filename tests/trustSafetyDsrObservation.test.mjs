import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DSR_OBSERVATION_SELECT,
  observeDsrDeadlines,
} from "../lib/trustSafetyDsrObservation.ts";

/**
 * The observer's one read (docs/policy/trust-safety-compliance-agent.md §1-1,
 * §5.6).
 *
 * What these hold is the boundary: seven fields and no more, one read and no
 * writes, and no `where` that would drop rows the counts are defined over.
 */

const MODULE = "lib/trustSafetyDsrObservation.ts";
const NOW = new Date("2026-11-04T00:00:00.000Z");
const DAY = 86_400_000;
const at = (days) => new Date(NOW.getTime() + days * DAY);

const fakePrisma = (rows, record = {}) => ({
  privacyRequest: {
    findMany: async (args) => {
      record.calls = (record.calls ?? 0) + 1;
      record.args = args;
      return rows;
    },
  },
});

test("the select names exactly the seven fields §1-1 allows", () => {
  assert.deepEqual(Object.keys(DSR_OBSERVATION_SELECT).sort(), [
    "completedAt",
    "createdAt",
    "dueAt",
    "id",
    "legalHold",
    "requestType",
    "status",
  ]);
  assert.ok(
    Object.values(DSR_OBSERVATION_SELECT).every((v) => v === true),
    "a nested select could reach a relation the allowlist does not name",
  );
});

test("the read passes that select and nothing else", () => {
  const record = {};
  return observeDsrDeadlines({
    prisma: fakePrisma([], record),
    now: NOW,
    imminentWithinDays: 7,
  }).then(() => {
    assert.equal(record.calls, 1, "one read");
    assert.deepEqual(Object.keys(record.args), ["select"], "no where, no include, no take");
    assert.equal(record.args.select, DSR_OBSERVATION_SELECT);
  });
});

test("no where clause: filtering would drop rows the counts are defined over", async () => {
  // §1-1 counts regardless of status and keeps legal hold in the denominator.
  // A `where` in SQL would make the denominator something else.
  const record = {};
  await observeDsrDeadlines({ prisma: fakePrisma([], record), now: NOW, imminentWithinDays: 7 });
  assert.equal(record.args.where, undefined);
});

test("the counts come back from the pure core", async () => {
  const counts = await observeDsrDeadlines({
    prisma: fakePrisma([
      {
        id: "a",
        requestType: "erasure",
        status: "open",
        dueAt: at(-2),
        legalHold: true,
        createdAt: at(-30),
        completedAt: null,
      },
      {
        id: "b",
        requestType: "access",
        status: "open",
        dueAt: at(3),
        legalHold: false,
        createdAt: at(-5),
        completedAt: null,
      },
      {
        id: "c",
        requestType: "erasure",
        status: "completed",
        dueAt: at(-9),
        legalHold: false,
        createdAt: at(-40),
        completedAt: at(-4),
      },
    ]),
    now: NOW,
    imminentWithinDays: 7,
  });
  assert.equal(counts.observed.total, 3);
  assert.equal(counts.overdue.total, 1);
  assert.equal(counts.overdue.legalHold, 1, "the held request stays in the bucket");
  assert.equal(counts.imminent.total, 1);
  assert.equal(counts.closedLate.total, 1);
  assert.equal(counts.worstLateClosureDays, 5);
});

test("the module writes nothing and calls nothing outside the app", () => {
  // §5.6: E2's closure allows zero writes, and the only request leaving the app
  // in the whole active scope is E1's ping. Neither belongs in this module.
  const source = readFileSync(MODULE, "utf8");
  // Anchored to the call, not to the characters: `createdAt: true` is a field
  // on the allowlist and contains "create". A substring guard failed on it.
  assert.doesNotMatch(
    source,
    /\.\s*(create|update|upsert|delete)(Many)?\s*\(/,
    "no Prisma write delegate may be called here",
  );
  for (const forbidden of [
    "executeRaw",
    "queryRaw",
    "fetch(",
    "adminAudit",
    "writeSystemAuditLog",
  ]) {
    assert.ok(!source.includes(forbidden), `a read-only module must not contain ${forbidden}`);
  }
});

test("the forbidden fields are not reachable from here", () => {
  const source = readFileSync(MODULE, "utf8");
  // Named in prose as examples of what the allowlist excludes, so the check
  // looks for them as property reads rather than as any occurrence.
  for (const field of ["email", "note", "handledById", "handledByEmail", "legalHoldReason"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`${field}\\s*:\\s*true`),
      `${field} must not be selected`,
    );
  }
});
