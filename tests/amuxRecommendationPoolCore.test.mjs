import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  RECOMMENDATION_AUDIT_KEYS,
  RECOMMENDATION_CODE_LATCH,
  parseRecommendationDecisionRequest,
  recommendationApplyPermitted,
  recommendationApproveStillIncluded,
  recommendationAuditMetadata,
  recommendationRemaining,
  selectRecommendationRows,
} from "../lib/amux/recommendationPoolCore.ts";

const now = new Date("2026-09-24T12:00:00.000Z");
const digest = "ab".repeat(32);

const card = (id, overrides = {}) => ({
  id,
  revision: 0,
  status: "backlog",
  owner: null,
  claimedAt: null,
  archivedAt: null,
  sourceDigest: digest,
  executionBriefDigest: null,
  kind: "bug",
  priority: "p3",
  pinned: false,
  drag: 0,
  createdAt: new Date("2026-09-23T00:00:00.000Z"),
  attemptCount: 0,
  deliveryCount: 0,
  routeDecisionCount: 0,
  dependentCount: 0,
  dependencies: [],
  reviewAfter: null,
  ...overrides,
});

const id = (suffix) => `c${suffix.padEnd(24, "0").slice(0, 24)}`;

test("version 7 ships the recommendation latch closed", () => {
  assert.equal(RECOMMENDATION_CODE_LATCH, false);
  assert.equal(recommendationApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(recommendationApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
  assert.equal(recommendationApplyPermitted({ envValue: "true", codeLatch: true }), false);
  assert.equal(recommendationApplyPermitted({ envValue: undefined, codeLatch: true }), false);
});

test("unconfigured capacity includes nothing", () => {
  const view = recommendationRemaining(null, 0);
  assert.equal(view.configured, false);
  assert.equal(view.remaining, 0);
  const selected = selectRecommendationRows({
    cards: [card(id("a")), card(id("b"))],
    capacity: null,
    occupied: 3,
    blocksAdmission: false,
    now,
  });
  assert.equal(selected.includedCount, 0);
  assert.ok(selected.rows.every((row) => row.exclusionCode === "capacity_unconfigured"));
});

test("a full queue excludes overflow and keeps owner-null todo in the numerator", () => {
  const selected = selectRecommendationRows({
    cards: [card(id("b"), { priority: "p0" }), card(id("a"), { priority: "p3" })],
    capacity: { active: true, wipLimit: 4 },
    occupied: 3,
    blocksAdmission: false,
    now,
  });
  assert.equal(selected.remaining, 1);
  assert.equal(selected.includedCount, 1);
  assert.equal(selected.rows.find((row) => row.disposition === "included")?.cardId, id("b"));
  assert.equal(selected.rows.find((row) => row.cardId === id("a"))?.exclusionCode, "capacity_full");
});

test("dependency, incident, and review waiting fail closed", () => {
  const blocked = selectRecommendationRows({
    cards: [
      card(id("d"), { dependencies: [{ status: "backlog", archivedAt: null }] }),
      card(id("r"), { reviewAfter: new Date("2026-09-25T00:00:00.000Z") }),
    ],
    capacity: { active: true, wipLimit: 5 },
    occupied: 0,
    blocksAdmission: false,
    now,
  });
  assert.equal(blocked.rows.find((row) => row.cardId === id("d"))?.exclusionCode, "dependency_open");
  assert.equal(blocked.rows.find((row) => row.cardId === id("r"))?.exclusionCode, "review_waiting");
  const incident = selectRecommendationRows({
    cards: [card(id("i"))],
    capacity: { active: true, wipLimit: 5 },
    occupied: 0,
    blocksAdmission: true,
    now,
  });
  assert.equal(incident.includedCount, 0);
  assert.equal(incident.rows[0]?.exclusionCode, "incident_blocked");
});

test("a decision is exactly one card and the whole request is scanned", () => {
  const item = {
    cardId: id("a"),
    classification: { complexity: 3, files_expected: 2, risk: 1, task_kind: "bugfix" },
    executionBrief: "Keep the daily job window from treating frequent jobs as delayed.",
    expectedRevision: 0,
    kind: "bug",
    priority: "p2",
    sourceDigest: digest,
  };
  const approved = parseRecommendationDecisionRequest(
    JSON.stringify({
      canonicalizationVersion: "amux-json-v1",
      policyVersion: 7,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      decisionId: "22222222-2222-4222-8222-222222222222",
      decision: "approve",
      item,
    }),
    now,
  );
  assert.equal(approved.ok, true);
  const token = parseRecommendationDecisionRequest(
    JSON.stringify({
      canonicalizationVersion: "amux-json-v1",
      policyVersion: 7,
      snapshotId: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      decisionId: "22222222-2222-4222-8222-222222222222",
      decision: "approve",
      item,
    }),
    now,
  );
  assert.equal(token.ok, false);
  const two = parseRecommendationDecisionRequest(
    JSON.stringify({
      canonicalizationVersion: "amux-json-v1",
      policyVersion: 7,
      items: [item, item],
    }),
    now,
  );
  assert.equal(two.ok, false);
  const linked = parseRecommendationDecisionRequest(
    JSON.stringify({
      canonicalizationVersion: "amux-json-v1",
      policyVersion: 7,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      decisionId: "22222222-2222-4222-8222-222222222222",
      decision: "approve",
      item: { ...item, executionBrief: "See https://example.test/path" },
    }),
    now,
  );
  assert.equal(linked.ok, false);
  const far = parseRecommendationDecisionRequest(
    JSON.stringify({
      canonicalizationVersion: "amux-json-v1",
      policyVersion: 7,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      decisionId: "22222222-2222-4222-8222-222222222222",
      decision: "hold",
      cardId: id("a"),
      reasonCode: "not_now",
      reviewAfter: "2028-01-01T00:00:00.000Z",
    }),
    now,
  );
  assert.equal(far.ok, false);
  const noted = parseRecommendationDecisionRequest(
    JSON.stringify({
      canonicalizationVersion: "amux-json-v1",
      policyVersion: 7,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      decisionId: "22222222-2222-4222-8222-222222222222",
      decision: "hold",
      cardId: id("a"),
      reasonCode: "not_now",
      reviewAfter: "Thu Oct 01 2026 00:00:00 GMT+0000 (hold because the brief says secret)",
    }),
    now,
  );
  assert.equal(noted.ok, false);
});

test("approval rechecks capacity and a changed brief digest", () => {
  const row = {
    cardId: id("a"),
    expectedRevision: 0,
    sourceDigest: digest,
    executionBriefDigest: null,
    scoreTotal: 1,
    disposition: "included",
    exclusionCode: null,
  };
  const item = {
    cardId: id("a"),
    expectedRevision: 0,
    sourceDigest: digest,
    kind: "bug",
    priority: "p2",
    classification: { task_kind: "bugfix", complexity: 3, risk: 1, files_expected: 2 },
    executionBrief: "Keep the daily job window from treating frequent jobs as delayed.",
  };
  assert.equal(
    recommendationApproveStillIncluded({
      row,
      live: card(id("a")),
      item,
      blocksAdmission: false,
      configured: true,
      remaining: 1,
      now,
    }).ok,
    true,
  );
  const changed = recommendationApproveStillIncluded({
    row,
    live: card(id("a"), { executionBriefDigest: "cd".repeat(32) }),
    item,
    blocksAdmission: false,
    configured: true,
    remaining: 1,
    now,
  });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.code, "brief_digest_changed");
  const full = recommendationApproveStillIncluded({
    row,
    live: card(id("a")),
    item,
    blocksAdmission: false,
    configured: true,
    remaining: 0,
    now,
  });
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.code, "capacity_full");
  const unconfigured = recommendationApproveStillIncluded({
    row,
    live: card(id("a")),
    item,
    blocksAdmission: false,
    configured: false,
    remaining: 0,
    now,
  });
  assert.equal(unconfigured.ok, false);
  if (!unconfigured.ok) assert.equal(unconfigured.code, "capacity_unconfigured");
  const outside = recommendationApproveStillIncluded({
    row: { ...row, disposition: "excluded", exclusionCode: "capacity_full" },
    live: card(id("a")),
    item,
    blocksAdmission: false,
    configured: true,
    remaining: 1,
    now,
  });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.code, "not_included");
});

test("audit metadata keeps only the allowlist", () => {
  const metadata = recommendationAuditMetadata({
    snapshotId: "11111111-1111-4111-8111-111111111111",
    digest,
    occupied: 3,
    wipLimit: 4,
    title: "hidden",
    sourceKey: "OPS",
  });
  assert.deepEqual(Object.keys(metadata).sort(), ["digest", "occupied", "snapshotId", "wipLimit"]);
  for (const key of Object.keys(metadata)) assert.ok(RECOMMENDATION_AUDIT_KEYS.includes(key));
});

test("the route passes the shipped latch and does not mention execution", () => {
  const route = readFileSync("app/api/admin/amux/board-recommendation/route.ts", "utf8");
  const service = readFileSync("lib/amux/recommendationPoolService.ts", "utf8");
  const core = readFileSync("lib/amux/recommendationPoolCore.ts", "utf8");
  assert.match(route, /RECOMMENDATION_CODE_LATCH/);
  assert.equal(route.includes("codeLatch: true"), false);
  assert.equal(route.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(service.includes("amuxRecommendationCapacity.create"), false);
  assert.equal(service.includes("amuxRecommendationCapacity.update"), false);
  assert.match(core, /RECOMMENDATION_CODE_LATCH = false/);
});
