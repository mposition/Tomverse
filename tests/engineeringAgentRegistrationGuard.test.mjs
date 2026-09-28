import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  REGISTRATION_CAPS,
  REGISTRATION_SOURCES,
  ciFailureItem,
  dependabotFailureItem,
  guardRegistrationProposal,
  parseBacklogItems,
  prefilterItems,
  registrationSourceIdentity,
} from "../lib/engineeringAgentRegistrationGuard.ts";
import { detectSecrets, detectSecretsInFields } from "../lib/engineeringAgentSecretPatterns.ts";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Shaped like the shared backlog: several tables, only some with an ID column. */
const BACKLOG = [
  "# Backlog",
  "",
  "| 순서 | 작업 | 범위 |",
  "| --- | --- | --- |",
  "| **1** | **CACHE-01 — 보고서** | 집계 |",
  "",
  "### B. 병행 개선 과제",
  "",
  "| ID | 작업 | 우선순위·상태 | 다음 완료 단위 |",
  "| --- | --- | --- | --- |",
  "| CACHE-01 | 캐시 계측 | 병행 P1 / 구현 미착수 | 읽기 전용 보고서 |",
  "| CONT-TITLE-01 | 대화명 안정화 | 완료 / 병합 | 재착수 후보에서 제외 |",
  "| CREDIT-UX-01 | 비용 정보 공개 | CHAT-01 하위 병행 P2 / UI·정책 결정 대기 | 축약 |",
  "| TASK-ORCH-01 (IDEA-A1) | 지속 실행 | 후속 P2 / 범위 미정 | 기반 |",
  "| HELP-NAV-01 | 도움말 | 착수 가능 | MVP |",
  "| threshold note | 설명 | 착수 가능 | 행 |",
  "",
  "| 투자 순위 | ID | 작업 |",
  "| --- | --- | --- |",
  "| 1 | CHAT-01 | Chat 완성 |",
  "| 2 | HELP-NAV-01 | 중복 |",
].join("\n");

test("the backlog parser reads only ID tables and marks an item named twice as ambiguous", () => {
  const { items, ambiguousKeys } = parseBacklogItems(BACKLOG);
  assert.deepEqual(
    items.map((item) => item.key).sort(),
    ["CACHE-01", "CHAT-01", "CONT-TITLE-01", "CREDIT-UX-01", "TASK-ORCH-01"],
  );
  assert.deepEqual(ambiguousKeys, ["HELP-NAV-01"]);
  const cache = items.find((item) => item.key === "CACHE-01");
  assert.equal(cache.priority, "p1");
  assert.equal(cache.digest, sha256("| CACHE-01 | 캐시 계측 | 병행 P1 / 구현 미착수 | 읽기 전용 보고서 |"));
  assert.equal(items.find((item) => item.key === "CHAT-01").priority, null);
});

test("the digest moves with the item's text and with nothing else", () => {
  const before = parseBacklogItems(BACKLOG).items.find((item) => item.key === "CACHE-01");
  const edited = parseBacklogItems(BACKLOG.replace("읽기 전용 보고서", "읽기 전용 보고서 v2"));
  assert.notEqual(edited.items.find((item) => item.key === "CACHE-01").digest, before.digest);
  const elsewhere = parseBacklogItems(`${BACKLOG}\n\nMore prose.\n`);
  assert.equal(elsewhere.items.find((item) => item.key === "CACHE-01").digest, before.digest);
});

const prefilter = (overrides = {}) => {
  const { items, ambiguousKeys } = parseBacklogItems(BACKLOG);
  return prefilterItems({
    items,
    ambiguousKeys,
    existingSourceIdentities: new Set(),
    pendingSourceIdentities: new Set(),
    ...overrides,
  });
};

test("done, waiting and existing items are never offered", () => {
  const { eligible, excluded } = prefilter({
    existingSourceIdentities: new Set([registrationSourceIdentity("S1", "CHAT-01")]),
    pendingSourceIdentities: new Set([registrationSourceIdentity("S1", "TASK-ORCH-01")]),
  });
  assert.deepEqual(eligible.map((item) => item.key), ["CACHE-01"]);
  assert.deepEqual(
    excluded.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: "CHAT-01", reason: "existing_card" },
      { key: "CONT-TITLE-01", reason: "status_excluded" },
      { key: "CREDIT-UX-01", reason: "status_excluded" },
      { key: "HELP-NAV-01", reason: "ambiguous" },
      { key: "TASK-ORCH-01", reason: "already_proposed" },
    ],
  );
});

const eligible = () => prefilter().eligible;
const cacheItem = () => eligible().find((item) => item.key === "CACHE-01");

const proposal = (overrides = {}) => ({
  source: "S1",
  itemKey: "CACHE-01",
  itemDigest: cacheItem().digest,
  title: "Read-only cache report by provider and model",
  scope: "Aggregate existing cache token fields into a report.",
  completion: "A report script and fixtures reproduce the expected totals.",
  ...overrides,
});

const guard = (overrides = {}, counts = {}) =>
  guardRegistrationProposal({
    proposal: proposal(overrides),
    eligible: eligible(),
    counts: { thisRound: 0, todayUtc: 0, unpromoted: 0, ...counts },
  });

test("a clean proposal registers a backlog card whose priority comes from the source", () => {
  const verdict = guard();
  assert.equal(verdict.outcome, "register");
  assert.equal(verdict.card.status, "backlog");
  assert.equal(verdict.card.kind, "unknown");
  assert.equal(verdict.card.priority, "p1");
  assert.equal(verdict.card.owner, null);
  assert.equal(verdict.card.executionBrief, null);
  assert.equal(verdict.card.sourceIdentity, "engineering-agent:S1:CACHE-01");
  assert.equal(verdict.card.actor, "engineering-agent-registrar");
});

test("the proposal cannot set priority, promotion or anything beyond its six fields", () => {
  for (const extra of [{ priority: "p0" }, { status: "todo" }, { owner: "x" }, { executionBrief: "do it" }]) {
    assert.deepEqual(guard(extra), { outcome: "refuse", reason: "schema_rejected" }, JSON.stringify(extra));
  }
  const missing = proposal();
  delete missing.scope;
  assert.equal(
    guardRegistrationProposal({ proposal: missing, eligible: eligible(), counts: { thisRound: 0, todayUtc: 0, unpromoted: 0 } }).reason,
    "schema_rejected",
  );
  assert.equal(guard({ title: 7 }).reason, "schema_rejected");
});

test("the proposal must name an eligible item at the pinned revision with its exact digest", () => {
  assert.equal(guard({ source: "S9" }).reason, "source_not_allowed");
  assert.equal(guard({ source: "constructor" }).reason, "source_not_allowed");
  assert.equal(guard({ itemKey: "CONT-TITLE-01" }).reason, "item_not_eligible");
  assert.equal(guard({ itemKey: "NOPE-01" }).reason, "item_not_eligible");
  assert.equal(guard({ itemDigest: "0".repeat(64) }).reason, "item_digest_mismatch");
  assert.equal(guard({ itemDigest: "not-hex" }).reason, "schema_rejected");
});

test("text meets AMUX intake's limits and scanner, and no control characters or secrets", () => {
  assert.equal(guard({ title: "" }).reason, "content_refused");
  assert.equal(guard({ title: "x".repeat(201) }).reason, "content_refused");
  assert.equal(guard({ scope: "y".repeat(2001) }).reason, "content_refused");
  assert.equal(guard({ title: "a/b" }).reason, "path_separator_in_title");
  assert.equal(guard({ title: "a\\b" }).reason, "path_separator_in_title");
  assert.equal(guard({ scope: "bell\u0007" }).reason, "control_character");
  assert.equal(guard({ completion: "ok\u009bnot" }).reason, "control_character");
  assert.equal(
    guard({ scope: `token ghp_${"a".repeat(36)} here` }).reason === "secret_detected" ||
      guard({ scope: `token ghp_${"a".repeat(36)} here` }).reason === "content_refused",
    true,
  );
  assert.equal(guard({ completion: "Line one\nLine two\tindented" }).outcome, "register");
});

test("the caps hold at their edges", () => {
  assert.equal(guard({}, { thisRound: REGISTRATION_CAPS.perRound - 1 }).outcome, "register");
  assert.equal(guard({}, { thisRound: REGISTRATION_CAPS.perRound }).reason, "round_cap_reached");
  assert.equal(guard({}, { todayUtc: REGISTRATION_CAPS.perUtcDay }).reason, "daily_cap_reached");
  assert.equal(guard({}, { unpromoted: REGISTRATION_CAPS.unpromoted }).reason, "unpromoted_cap_reached");
  assert.deepEqual(REGISTRATION_CAPS, { perRound: 3, perUtcDay: 10, unpromoted: 20 });
});

test("the sources are exactly the policy's three", () => {
  assert.deepEqual(Object.keys(REGISTRATION_SOURCES), ["S1", "S2", "S3"]);
  assert.equal(REGISTRATION_SOURCES.S1.branch, "codex/product-idea-backlog-2026-09-15");
});

test("CI and dependabot failures become items only when they failed", () => {
  assert.equal(ciFailureItem({ checkName: "lint", headSha: "a".repeat(40), conclusion: "success" }), null);
  const ci = ciFailureItem({ checkName: "lint", headSha: "a".repeat(40), conclusion: "failure" });
  assert.equal(ci.source, "S2");
  assert.match(ci.key, /^CI-[0-9A-F]{12}$/);
  const sameCheckNextHead = ciFailureItem({ checkName: "lint", headSha: "b".repeat(40), conclusion: "failure" });
  assert.equal(sameCheckNextHead.key, ci.key, "one card per failing check, not per head");
  assert.notEqual(sameCheckNextHead.digest, ci.digest);

  assert.equal(dependabotFailureItem({ prNumber: 12, headSha: "c".repeat(40), failingChecks: [] }), null);
  const dep = dependabotFailureItem({ prNumber: 12, headSha: "c".repeat(40), failingChecks: ["b", "a"] });
  assert.equal(dep.key, "DEPENDABOT-12");
  assert.equal(
    dep.digest,
    dependabotFailureItem({ prNumber: 12, headSha: "c".repeat(40), failingChecks: ["a", "b"] }).digest,
  );
});

/* Secret patterns ------------------------------------------------------ */

test("each secret rule fires on its shape and reports only its id", () => {
  const samples = {
    "aws-access-key-id": "AKIAABCDEFGHIJKLMNOP",
    "github-token": `ghp_${"A".repeat(36)}`,
    "github-fine-grained-token": `github_pat_${"A".repeat(50)}`,
    "npm-token": `npm_${"a".repeat(36)}`,
    "slack-token": "xoxb-1234567890-abcdef",
    "google-api-key": `AIza${"B".repeat(35)}`,
    "stripe-key": `sk_live_${"c".repeat(20)}`,
    "stripe-webhook-secret": `whsec_${"d".repeat(20)}`,
    "openai-key": `sk-proj-${"e".repeat(30)}`,
    "anthropic-key": `sk-ant-${"f".repeat(30)}`,
    "private-key-block": "-----BEGIN OPENSSH PRIVATE KEY-----",
    "connection-string-with-password": "postgresql://user:hunter22@db.example:5432/app",
    "authorization-bearer": "Authorization: Bearer abcdefghijklmnopqrstu",
    "json-web-token": "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK",
    "credential-assignment": 'password = "correcthorsebattery"',
  };
  for (const [id, sample] of Object.entries(samples)) {
    const found = detectSecrets(`before ${sample} after`);
    assert.ok(found.includes(id), `${id}: ${JSON.stringify(found)}`);
    for (const reported of found) assert.doesNotMatch(reported, /[=:]/);
  }
});

test("placeholders and ordinary code are not secrets", () => {
  for (const text of [
    "API_KEY=your-key-here",
    "password: process.env.DB_PASSWORD",
    "const token = await getToken();",
    "postgresql://localhost:5432/app",
    "ask-anthropic-docs",
  ]) {
    assert.deepEqual(detectSecrets(text), [], text);
  }
  assert.deepEqual(detectSecretsInFields({ a: "clean", b: "also clean" }), []);
});
