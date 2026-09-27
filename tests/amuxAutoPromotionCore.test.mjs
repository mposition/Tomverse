import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { RECOMMENDATION_CODE_LATCH } from "../lib/amux/recommendationPoolCore.ts";
import {
  AUTO_COST_24H_CENTS,
  AUTO_COST_30D_CENTS,
  AUTO_COST_EVENT_CENTS,
  AUTO_GRADUATION_DECISIONS,
  AUTO_GRADUATION_SPAN_MS,
  AUTO_PROMOTION_CODE_LATCH as AUTO_LATCH,
  autoCostAccepted,
  autoGlobalWipAccepted,
  autoGraduationAccepted,
  autoGrantExpiresAt,
  autoGrantUsable,
  autoHaltRequired,
  autoPromotionApplyPermitted,
  autoReadbackCritical,
  autoWorkerAdmitted,
  parseAutoConsumeRequest,
  parseAutoGrantRequest,
} from "../lib/amux/autoPromotionCore.ts";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-25T00:00:00.000Z");
const at = (ms) => new Date(now.getTime() + ms);

test("version 8 ships the auto latch closed and leaves the recommendation latch closed", () => {
  assert.equal(AUTO_LATCH, false);
  assert.equal(RECOMMENDATION_CODE_LATCH, false);
  assert.equal(autoPromotionApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(autoPromotionApplyPermitted({ envValue: "true", codeLatch: true }), false);
  assert.equal(AUTO_GRADUATION_DECISIONS, 20);
  assert.equal(AUTO_GRADUATION_SPAN_MS, 14 * day);
  assert.equal(AUTO_COST_EVENT_CENTS, 500);
  assert.equal(AUTO_COST_24H_CENTS, 1500);
  assert.equal(AUTO_COST_30D_CENTS, 10000);
});

test("graduation needs 20 human decisions spanning 14 days", () => {
  const nineteen = Array.from({ length: 19 }, (_, index) => ({ createdAt: at(index * day) }));
  assert.equal(autoGraduationAccepted(nineteen).ok, false);
  const burst = Array.from({ length: 20 }, () => ({ createdAt: now }));
  assert.equal(autoGraduationAccepted(burst).ok, false);
  const spanned = [
    { createdAt: now },
    ...Array.from({ length: 18 }, () => ({ createdAt: at(day) })),
    { createdAt: at(14 * day) },
  ];
  assert.equal(autoGraduationAccepted(spanned).ok, true);
  const exact = [{ createdAt: now }, { createdAt: at(14 * day) }];
  while (exact.length < 20) exact.push({ createdAt: at(14 * day) });
  assert.equal(autoGraduationAccepted(exact).ok, true);
});

test("cost caps are USD cents and ordinary overages refuse before a card write", () => {
  assert.equal(autoCostAccepted({ proposedCents: 501, entries: [], now }).ok, false);
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: [], now }).ok, true);
  const dayEntries = [{ amountCents: 1000, recordedAt: now }];
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: dayEntries, now }).ok, true);
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: [{ amountCents: 1001, recordedAt: now }], now }).ok, false);
  const old = [{ amountCents: 10000, recordedAt: at(-31 * day) }];
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: old, now }).ok, true);
  const month = [{ amountCents: 9600, recordedAt: at(-day) }];
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: month, now }).ok, false);
});

test("worker isolation refuses a worker id and a fourth active card without calling either a critical violation", () => {
  assert.equal(autoWorkerAdmitted(null).ok, true);
  assert.equal(autoWorkerAdmitted("worker-a").code, "worker_not_admitted");
  assert.equal(autoGlobalWipAccepted(3).code, "auto_wip_full");
  assert.equal(autoGlobalWipAccepted(2).ok, true);
  assert.deepEqual(autoReadbackCritical({
    activeCount: 4,
    ownerCounts: [2],
    costCents24h: 0,
    costCents30d: 0,
    unapprovedTodo: 0,
    lifecycleWrites: 0,
  }), ["global_wip_exceeded", "worker_cap_exceeded"]);
});

test("a grant lasts seven days and an expired grant is missing", () => {
  const expires = autoGrantExpiresAt(now);
  assert.equal(expires.getTime() - now.getTime(), 7 * day);
  assert.equal(autoGrantUsable({ status: "active", expiresAt: expires, now: at(7 * day - 1) }).ok, true);
  assert.equal(autoGrantUsable({ status: "active", expiresAt: expires, now: at(7 * day) }).code, "grant_missing");
  assert.equal(autoGrantUsable({ status: "consumed", expiresAt: expires, now }).code, "grant_missing");
});

test("one critical violation or two unknown outcomes inside 15 minutes halts", () => {
  assert.equal(autoHaltRequired({ criticalCodes: [], unknownAt: [now], now }).halt, false);
  assert.equal(autoHaltRequired({ criticalCodes: ["cost_exceeded"], unknownAt: [], now }).halt, true);
  const burst = autoHaltRequired({ criticalCodes: [], unknownAt: [at(-15 * 60 * 1000), now], now });
  assert.equal(burst.halt, true);
  assert.equal(burst.reason, "outcome_unknown_burst");
  const apart = autoHaltRequired({ criticalCodes: [], unknownAt: [at(-15 * 60 * 1000 - 1), now], now });
  assert.equal(apart.halt, false);
});

test("a consume request is one card and a worker id is refused", () => {
  const item = {
    cardId: `c${"a".padEnd(24, "0")}`,
    classification: { complexity: 3, files_expected: 2, risk: 1, task_kind: "bugfix" },
    executionBrief: "Keep the daily job window from treating frequent jobs as delayed.",
    expectedRevision: 0,
    kind: "bug",
    priority: "p2",
    sourceDigest: "ab".repeat(32),
  };
  const base = {
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 8,
    grantId: "11111111-1111-4111-8111-111111111111",
    consumptionId: "22222222-2222-4222-8222-222222222222",
    snapshotId: "33333333-3333-4333-8333-333333333333",
    workerId: null,
    amountCents: 0,
    item,
  };
  const parsed = parseAutoConsumeRequest(JSON.stringify(base));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, workerId: "worker-a" })).code, "worker_not_admitted");
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, items: [item, item] })).code, "one_card");
  const grant = parseAutoGrantRequest(JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 8,
    grantId: base.grantId,
    cardId: item.cardId,
  }));
  assert.equal(grant.ok, true);
});

test("the public auto route returns before the service while the latch is false", () => {
  const route = readFileSync(new URL("../app/api/admin/amux/board-auto-promotion/route.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../lib/amux/autoPromotionService.ts", import.meta.url), "utf8");
  const core = readFileSync(new URL("../lib/amux/autoPromotionCore.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!AUTO_PROMOTION_CODE_LATCH\)/);
  assert.match(route, /apply_disabled/);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(core.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTION_API_ENABLED"), false);
  assert.match(service, /from "@\/lib\/amux\/recommendationPoolCore"/);
  assert.match(service, /pg_advisory_xact_lock\(hashtext\(\$\{RECOMMENDATION_LOCK_NAME\}\)\)/);
  assert.equal(service.includes("unapprovedTodo: 0"), false);
});
