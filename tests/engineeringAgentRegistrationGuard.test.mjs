import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKLOG_TABLE_SCHEMAS,
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

/**
 * Shaped like the shared backlog: every ID-table shape it uses, a table with
 * no ID column, a table shape nobody listed, and the investment table that has
 * no status column.
 */
const BACKLOG = [
  "# Backlog",
  "",
  "| 순서 | 작업 | 범위 |",
  "| --- | --- | --- |",
  "| **1** | **CACHE-01 — 보고서** | 집계 |",
  "",
  "| 투자 순위 | ID | 작업 | 다음 완료 목표 |",
  "| --- | --- | --- | --- |",
  "| 1 | CHAT-01 | Chat 완성 | 단일 답변 화면 |",
  "",
  "### B. 병행 개선 과제",
  "",
  "| ID | 작업 | 우선순위·상태 | 다음 완료 단위 |",
  "| --- | --- | --- | --- |",
  "| CACHE-01 | 캐시 계측 | 병행 P1 / 구현 미착수 | 읽기 전용 보고서 |",
  "| CONT-TITLE-01 | 대화명 안정화 | 완료 / 병합 | 재착수 후보에서 제외 |",
  "| CREDIT-UX-01 | 비용 정보 공개 | CHAT-01 하위 병행 P2 / UI·정책 결정 대기 | 축약 |",
  "| TASK-ORCH-01 (IDEA-A1) | 지속 실행 | 후속 P2 / 범위 미정 | 기반 |",
  "| threshold note | 설명 | 착수 가능 | 행 |",
  "",
  "| 순서 | ID | 작업 | 우선순위·다음 완료 단위 |",
  "| --- | --- | --- | --- |",
  "| **1** | **SEO-I18N-01** | 지역 중립 metadata | P1 — **완료** (2026-09-17) |",
  "| **2** | **AEO-04** | sitemap 변경일 | P1 — 다음 완료 단위: 페이지별 변경일 |",
  "",
  "| ID | 우선순위·상태 | 다음 완료 단위·착수 조건 |",
  "| --- | --- | --- |",
  "| SEC-OPS-01 | P2 / 기존 주간 자동화 일시중지 | 재개 조건 |",
  "| MOBILE-KB-INSET-01 | CHAT-01 하위 **P2** / 수정 미착수 | 재현 |",
  "",
  "| 새 형식 | ID | 무엇 |",
  "| --- | --- | --- |",
  "| x | NEW-SHAPE-01 | 읽을 수 없는 형식 |",
  "",
  "| ID | 작업 | 우선순위·상태 | 다음 완료 단위 |",
  "| --- | --- | --- | --- |",
  "| HELP-NAV-01 | 도움말 | P2 / 착수 가능 | MVP |",
  "| HELP-NAV-01 | 도움말(중복) | P2 / 착수 가능 | MVP |",
].join("\n");

test("the backlog parser reads the known ID-table shapes and holds back anything it cannot read", () => {
  const { items, ambiguousKeys } = parseBacklogItems(BACKLOG);
  assert.deepEqual(
    items.map((item) => item.key).sort(),
    [
      "AEO-04",
      "CACHE-01",
      "CONT-TITLE-01",
      "CREDIT-UX-01",
      "MOBILE-KB-INSET-01",
      "SEC-OPS-01",
      "SEO-I18N-01",
      "TASK-ORCH-01",
    ],
  );
  // Named twice; in a shape nobody listed; in a table with no status column.
  assert.deepEqual(ambiguousKeys, ["CHAT-01", "HELP-NAV-01", "NEW-SHAPE-01"]);
  const cache = items.find((item) => item.key === "CACHE-01");
  assert.equal(cache.priority, "p1");
  assert.equal(cache.digest, sha256("| CACHE-01 | 캐시 계측 | 병행 P1 / 구현 미착수 | 읽기 전용 보고서 |"));
  assert.equal(items.find((item) => item.key === "AEO-04").priority, "p1");
  assert.equal(items.find((item) => item.key === "MOBILE-KB-INSET-01").priority, "p2");
});

test("every listed schema names a status column that is in its own header", () => {
  for (const schema of BACKLOG_TABLE_SCHEMAS) {
    assert.ok(schema.header.includes("ID"));
    if (schema.statusColumn !== null) assert.ok(schema.header.includes(schema.statusColumn));
  }
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

test("done, paused, waiting and existing items are never offered; a 'completion unit' phrase is not 'done'", () => {
  const { eligible, excluded } = prefilter({
    existingSourceIdentities: new Set([registrationSourceIdentity("S1", "MOBILE-KB-INSET-01")]),
    pendingSourceIdentities: new Set([registrationSourceIdentity("S1", "TASK-ORCH-01")]),
  });
  assert.deepEqual(eligible.map((item) => item.key).sort(), ["AEO-04", "CACHE-01"]);
  assert.deepEqual(
    excluded.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: "CHAT-01", reason: "ambiguous" },
      { key: "CONT-TITLE-01", reason: "status_excluded" },
      { key: "CREDIT-UX-01", reason: "status_excluded" },
      { key: "HELP-NAV-01", reason: "ambiguous" },
      { key: "MOBILE-KB-INSET-01", reason: "existing_card" },
      { key: "NEW-SHAPE-01", reason: "ambiguous" },
      { key: "SEC-OPS-01", reason: "status_excluded" },
      { key: "SEO-I18N-01", reason: "status_excluded" },
      { key: "TASK-ORCH-01", reason: "already_proposed" },
    ],
  );
});

test("decision-pending wording keeps an item out", () => {
  for (const status of ["P2 / 결정 필요", "P2 / 정책 확정 필요", "조건부 P2", "P3 / 승인 후 착수", "P1 / 운영자 전용"]) {
    const markdown = [
      "| ID | 작업 | 우선순위·상태 | 다음 완료 단위 |",
      "| --- | --- | --- | --- |",
      `| WAIT-01 | 작업 | ${status} | 단위 |`,
    ].join("\n");
    const { items, ambiguousKeys } = parseBacklogItems(markdown);
    const result = prefilterItems({
      items,
      ambiguousKeys,
      existingSourceIdentities: new Set(),
      pendingSourceIdentities: new Set(),
    });
    assert.deepEqual(result.eligible, [], status);
  }
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
    "xai-key": `xai-${"g".repeat(30)}`,
    "huggingface-token": `hf_${"h".repeat(34)}`,
    "credential-assignment": 'R2_SECRET_ACCESS_KEY="Q7xk9Pz2Lm4Rt8Vw3Ny6"',
    "password-assignment": 'DB_password = "hunter2-but-longer!"',
  };
  for (const [id, sample] of Object.entries(samples)) {
    const found = detectSecrets(`before ${sample} after`);
    assert.ok(found.includes(id), `${id}: ${JSON.stringify(found)}`);
    for (const reported of found) assert.doesNotMatch(reported, /[=:]/);
  }
});

test("a credential name is evidence enough whatever the value's alphabet", () => {
  for (const value of [
    "abcdefghijklmnopqrstuvwxyzABCDEFGH",
    "1234567890123456789012",
    "dGhpcyBpcyBhIGJhc2U2NCB0b2tlbg==",
    "Zm9vYmFy_url-safe-base64_value",
  ]) {
    for (const name of ["CLOUDFLARE_API_TOKEN", "api_key", "clientSecret", "R2_SECRET_ACCESS_KEY"]) {
      assert.ok(detectSecrets(`${name}=${value}`).length > 0, name);
    }
  }
});

test("every secret-named variable this repository reads is caught when an opaque value is assigned", () => {
  // Names only; the value is synthetic and never printed.
  const opaque = "Q7xk9Pz2Lm4Rt8Vw3Ny6Hc5";
  const root = new URL("..", import.meta.url);
  const files = execFileSync("git", ["ls-files", "-z", "lib", "scripts", "app"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => /\.(?:ts|tsx|mjs|js)$/.test(path));
  const names = new Set();
  for (const path of files) {
    for (const match of readFileSync(new URL(path, root), "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (/(?:KEY|SECRET|TOKEN|PASSWORD)$/.test(match[1])) names.add(match[1]);
    }
  }
  assert.ok(names.size >= 10, `only ${names.size} secret-named variables found`);
  const missed = [...names].filter(
    (name) =>
      detectSecrets(`${name}=${opaque}`).length === 0 ||
      detectSecrets(`"${name}": "${opaque}"`).length === 0,
  );
  assert.deepEqual(missed, [], "these names escaped the assignment rule");
});

test("placeholders, plain passwords in tests and ordinary code are not secrets", () => {
  for (const text of [
    "API_KEY=your-key-here",
    "password: process.env.DB_PASSWORD",
    "const token = await getToken();",
    "postgresql://localhost:5432/app",
    "ask-anthropic-docs",
    'password = "correcthorsebattery"',
    "CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "R2_SECRET_ACCESS_KEY=example-value-1234567890",
    'const password = "test-password-123456";',
  ]) {
    assert.deepEqual(detectSecrets(text), [], text);
  }
  assert.deepEqual(detectSecretsInFields({ a: "clean", b: "also clean" }), []);
});
