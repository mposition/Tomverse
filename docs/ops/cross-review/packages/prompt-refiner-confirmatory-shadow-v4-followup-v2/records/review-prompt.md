# Independent review — task prompt-refiner-confirmatory-shadow-v4-followup-v2, round 0

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

prompt-refiner-confirmatory-shadow-v4 exchange가 round 2에서 approve와 재현 가능한 PostgreSQL 함수 속성 finding 1건을 함께 남기고 on_hold(revisions_exhausted)로 종료됐다. 기존 구현과 검토 기록은 보존한다. 후속 변경은 v4 prompt_refiner_runtime_manifest_valid wrapper가 위임 대상 v2 validator와 동일하게 STRICT 및 PARALLEL SAFE가 되도록 migration을 수정하고, fresh migration DB의 pg_proc에서 두 함수가 모두 proisstrict=true 및 proparallel='s'임을 통합 테스트로 고정한다. 그 밖의 Prompt Refiner 계약, provider 호출, 권한, 비용, flag, stage/run 또는 rollout 동작은 바꾸지 않는다. author는 Codex, reviewer는 Claude Code Max다.

## Completion criteria

- 원 exchange의 on_hold 상태와 round 2 finding을 supersedes lineage와 inherited finding으로 보존한다.
- v4 migration의 runtime-manifest wrapper가 IMMUTABLE, STRICT, PARALLEL SAFE이고 기존 v2 validator의 반환·위임 의미는 변하지 않는다.
- fresh migration DB에서 v2 validator와 v4 wrapper의 proisstrict=true 및 proparallel='s'를 실제 pg_proc로 검증한다.
- Prompt Refiner DB integration, unit, TypeScript, ESLint, schema·문서·정책·protected-writer 검사가 통과한다.
- 검토 record 디렉터리만 reviewed diff에서 제외하고 task, authorization, migration과 테스트는 exact digest에 포함한다.
- Claude verdict는 exact package digest에 결속하고 open finding 없이 approve해야 한다.

## Change under review — digest sha256:774e004606fe6a745822a4396c7cc6e92e1576377e0d2090d3df14f4b7fb28ef, commit 24cb29092be5311a8c612a46c69561d750edfe2d

```diff
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/authorization.md b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/authorization.md
new file mode 100644
index 00000000..8e7e0d0c
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/authorization.md
@@ -0,0 +1,18 @@
+# Prompt Refiner confirmatory shadow v4 후속 검토 승인 기록
+
+- approvedBy: `mposition`
+- approvedAt: `2026-09-21` (Australia/Brisbane)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+
+사용자는 Tomverse Chat 개발을 완료할 때까지 권장 순서로 자동 진행하고, 필요한
+Claude Code Max 독립 검토와 `--skip-preflight` 예외를 허용했으며 수정 round 상한을
+두지 않았다. 원 exchange는 round 2에서 `approve`와 재현 가능한 finding 1건을 함께
+남겨 `on_hold(revisions_exhausted)`로 닫혔다. 이 successor는 그 finding을 수정하고
+동일한 읽기 전용 reviewer에게 다시 확인받기 위한 기록이다.
+
+승인 범위는 PostgreSQL 함수 속성 parity 수정, 그 회귀 테스트, package·검토 기록,
+로컬 검증, push와 PR 및 CI 확인까지다. provider 호출, stage/run 승인, Railway flag,
+유료 shadow 실행, 제품 Prompt Refiner 노출, Router 결합 또는 rollout 승인이 아니다.
+Claude 호출은 저장된 `claude.ai` Max 구독만 사용하며 API key/token 환경 변수는
+제거하고 `firstParty`·`max` 인증을 확인한다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/task.json b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/task.json
new file mode 100644
index 00000000..16ace8d6
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2/task.json
@@ -0,0 +1,23 @@
+{
+  "taskId": "prompt-refiner-confirmatory-shadow-v4-followup-v2",
+  "requirement": "prompt-refiner-confirmatory-shadow-v4 exchange가 round 2에서 approve와 재현 가능한 PostgreSQL 함수 속성 finding 1건을 함께 남기고 on_hold(revisions_exhausted)로 종료됐다. 기존 구현과 검토 기록은 보존한다. 후속 변경은 v4 prompt_refiner_runtime_manifest_valid wrapper가 위임 대상 v2 validator와 동일하게 STRICT 및 PARALLEL SAFE가 되도록 migration을 수정하고, fresh migration DB의 pg_proc에서 두 함수가 모두 proisstrict=true 및 proparallel='s'임을 통합 테스트로 고정한다. 그 밖의 Prompt Refiner 계약, provider 호출, 권한, 비용, flag, stage/run 또는 rollout 동작은 바꾸지 않는다. author는 Codex, reviewer는 Claude Code Max다.",
+  "completionCriteria": [
+    "원 exchange의 on_hold 상태와 round 2 finding을 supersedes lineage와 inherited finding으로 보존한다.",
+    "v4 migration의 runtime-manifest wrapper가 IMMUTABLE, STRICT, PARALLEL SAFE이고 기존 v2 validator의 반환·위임 의미는 변하지 않는다.",
+    "fresh migration DB에서 v2 validator와 v4 wrapper의 proisstrict=true 및 proparallel='s'를 실제 pg_proc로 검증한다.",
+    "Prompt Refiner DB integration, unit, TypeScript, ESLint, schema·문서·정책·protected-writer 검사가 통과한다.",
+    "검토 record 디렉터리만 reviewed diff에서 제외하고 task, authorization, migration과 테스트는 exact digest에 포함한다.",
+    "Claude verdict는 exact package digest에 결속하고 open finding 없이 approve해야 한다."
+  ],
+  "baseCommit": "bc5a47468b046406ce7631cf2732a26356294352",
+  "writableScope": [
+    "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4-followup-v2",
+    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
+    "tests/integration/prompt-refiner-shadow-run.db.test.ts"
+  ],
+  "generatedPaths": [],
+  "supersedes": {
+    "taskId": "prompt-refiner-confirmatory-shadow-v4",
+    "exchange": "docs/ops/cross-review/packages/prompt-refiner-confirmatory-shadow-v4/exchange.json"
+  }
+}
diff --git a/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql b/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql
index a03abb36..88fdf224 100644
--- a/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql
+++ b/prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql
@@ -17,6 +17,8 @@ CREATE FUNCTION "prompt_refiner_runtime_manifest_valid"(
 RETURNS BOOLEAN
 LANGUAGE plpgsql
 IMMUTABLE
+STRICT
+PARALLEL SAFE
 AS $$
 DECLARE
     files JSONB;
diff --git a/tests/integration/prompt-refiner-shadow-run.db.test.ts b/tests/integration/prompt-refiner-shadow-run.db.test.ts
index 23fd7243..44fae750 100644
--- a/tests/integration/prompt-refiner-shadow-run.db.test.ts
+++ b/tests/integration/prompt-refiner-shadow-run.db.test.ts
@@ -463,6 +463,35 @@ test("v4 terminal duration is bounded before an immutable receipt can be stored"
     );
 });
 
+test("v4 runtime manifest wrapper preserves strict and parallel-safe validator metadata", async () => {
+    const functions = await prisma.$queryRawUnsafe<
+        Array<{ name: string; parallel: string; strict: boolean }>
+    >(`
+        SELECT
+          proname AS name,
+          proparallel::TEXT AS parallel,
+          proisstrict AS strict
+        FROM pg_proc
+        WHERE proname IN (
+          'prompt_refiner_runtime_manifest_valid',
+          'prompt_refiner_runtime_manifest_v2_valid'
+        )
+        ORDER BY proname
+    `);
+    assert.deepEqual(functions, [
+        {
+            name: "prompt_refiner_runtime_manifest_v2_valid",
+            parallel: "s",
+            strict: true,
+        },
+        {
+            name: "prompt_refiner_runtime_manifest_valid",
+            parallel: "s",
+            strict: true,
+        },
+    ]);
+});
+
 test("completed durable evidence rebuilds a content-free aggregate from all 16 cases", async () => {
     await approveStage();
     await approveRun();

```

## Test results (run by the control program)

- PASS `npm run test:unit` (1116739ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 13084.8463

## Guard results (run by the control program)

- PASS `npm run typecheck` (74679ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm run lint` (70273ms)
  > ai-chat-hub@0.1.0 lint
  > eslint
- PASS `npm run check:enum-constraints` (1111ms)
  > ai-chat-hub@0.1.0 check:enum-constraints
  > node --conditions=react-server --import tsx scripts/check-enum-constraints.mjs
  
  Enum constraint check passed: 118 closed list(s) in the schema — 62 compared against an application list, 22 held only as a TypeScript union, 34 written down only in the database.
- PASS `npm run check:protected-table-writers` (3115ms)
  tingStore.ts; no direct MarketingPost write found outside lib/marketingStore.ts; no direct MarketingReport write found outside lib/marketingStore.ts; no direct AiVisibilityRun write found outside lib/marketingStore.ts; no direct PromptRefinerShadowRun write found outside lib/promptRefinerShadowRunStore.ts; no direct PromptRefinerShadowAttempt write found outside lib/promptRefinerShadowRunStore.ts.
- PASS `npm run check:doc-references` (1462ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 903 referenced path(s) across 119 instruction document(s), and 1013 path(s) named by comments across 3057 source file(s), all present.
- PASS `npm run check:policy-section-references` (1131ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4545 citation(s) against 38 policy document(s). 2978 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1334 and 233 predate this change).
- PASS `NODE_ENV=test DATABASE_URL=postgresql://postgres@127.0.0.1:55439/tomverse_test_v4g?schema=public DIRECT_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/tomverse_test_v4g?schema=public NEXTAUTH_SECRET=tomverse-db-integration-test-secret-2026 MANIFEST_HASH_KEYS=db-integration-test:tomverse-db-integration-manifest-key-2026 MANIFEST_HASH_ACTIVE_KEY_ID=db-integration-test node --conditions=react-server --import tsx --test --test-concurrency=1 tests/integration/prompt-refiner-reservation.db.test.ts tests/integration/prompt-refiner-reservation-admission.db.test.ts tests/integration/prompt-refiner-shadow-run.db.test.ts` (83561ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 83476.3948

## Findings from the superseded exchange prompt-refiner-confirmatory-shadow-v4, left open there (check each was addressed)

- [nit/evidence] prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql:11-20 (CREATE FUNCTION "prompt_refiner_runtime_manifest_valid"): The replacement wrapper keeps IMMUTABLE but drops the PARALLEL SAFE marker the renamed v2 validator carries, so a CHECK constraint on PromptRefinerReservationStage now calls a parallel-unsafe function; correctness is unaffected (the STRICT loss is inert because a STRICT function also yields NULL on NULL input, and every argument column is NOT NULL), only planning is.

## Author's account (read last; a claim, not a finding)

Summary: (no summary supplied; the diff is the record)

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-confirmatory-shadow-v4-followup-v2",
  "round": 0,
  "reviewedDigest": "sha256:774e004606fe6a745822a4396c7cc6e92e1576377e0d2090d3df14f4b7fb28ef",
  "conclusion": "approve | request_changes | blocked",
  "findings": [
    {
      "location": "path:line or symbol",
      "severity": "error | warning | nit",
      "basis": "evidence | preference | judgement",
      "claim": "what is wrong, in one sentence",
      "reproduction": "how to see it: a command, or an input and its expected output (required for the finding to be acted on)"
    }
  ],
  "nextAction": "one sentence"
}
```

`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands.
