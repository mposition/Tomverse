# Independent review — task prompt-refiner-durable-stage-writer-ci-fix-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

PR #1555의 Prompt Refiner durable stage writer가 추가한 외래 키, runtime source manifest, 설치 의존성 해석과 SQL 상수 때문에 기존 CI가 실패한 부분을 정확한 최소 예외와 FK-aware test cleanup으로 정합화한다. AdminAuditLog test cleanup은 관련된 세 integration suite 모두 PromptRefinerReservation 및 PromptRefinerReservationStage와 함께 명시적으로 truncate하되 CASCADE를 쓰지 않는다. automatic fallback 경계는 fallback source의 content-free digest manifest만 허용하고 exports 조회나 dispatch를 허용하지 않는다. runtime source closure는 node_modules 아래 비-workspace 설치 의존성 선언을 외부로 취급하되 등록된 workspace source는 계속 local closure 규칙과 정확한 진단을 적용하고, 미등록 @tomverse/* 이름은 fail-closed한다. protected-table writer 예외는 새 migration과 constant LOCK TABLE statement의 실제 동작·개수에 exact-match하며, retention report의 Prompt Refiner 문구 때문에 바뀐 정적 write-verb count도 정확히 설명하고 protected table write를 허용하지 않는다. author는 Codex, reviewer는 Claude Code Max이고 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only 및 strict MCP로 검토한다.

## Completion criteria

- 세 PostgreSQL integration test의 cleanup은 PromptRefinerReservation, PromptRefinerReservationStage, AdminAuditLog를 한 TRUNCATE statement에 명시하고 CASCADE를 사용하지 않는다.
- automaticFallbackBoundary의 새 exact allowlist는 lib/promptRefinerStageAdmissionCore.ts가 providerFallbackCandidates source bytes를 content-free manifest에 결속하는 경우만 설명하며 fallback exports 조회 또는 model dispatch를 숨기지 않는다.
- runtime source closure는 Linux checkout 내부 node_modules resolution을 external dependency로 제외하면서 등록된 workspace source와 @/* alias source를 계속 local closure에 포함하고 실제 next-auth/next resolution 경로와 미등록 @tomverse/* 거부를 테스트한다.
- protected-table writer allowlist는 20260918130000 migration의 AdminAuditLog read-only FK/guard reference, promptRefinerStageAdmission.ts의 constant ModelRegistryEntry lock 및 report-unswept-tables의 Prompt Refiner retention 문구로 인한 정적 count를 exact path/count로 설명하며 실제 protected table write를 허용하지 않는다.
- 관련 focused tests, full unit suite, PostgreSQL accounts integration lane, TypeScript, ESLint, strict encoding 및 diff whitespace 검사가 통과한다.
- 변경은 CI 정합성으로 한정되고 Prompt Refiner product/provider/network/credential/stage seed/flag/rollout/spending 경계를 바꾸지 않는다.
- Claude verdict는 package digest와 결속하며 finding마다 location, severity, basis와 reproduction을 제공한다. 최초 검토와 최대 두 번의 수정 검토 후 actionable finding이 남으면 on_hold다.

## Change under review — digest sha256:00a6ce12d2fde96f12440d8905faa48fea7effeb8bac75649d60b8e8b99a192f, commit 77a4270d0a72dd16e27a66ab3e3570b48e2cbc75

```diff
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.authorization.md b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.authorization.md
new file mode 100644
index 00000000..9769b4f5
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.authorization.md
@@ -0,0 +1,36 @@
+# Prompt Refiner durable stage writer CI 후속 수정 Claude 독립 검토 제한 승인
+
+Codex가 현재 대화의 사용자 승인을 기록한다. 사용자 메시지의 시각은 기록하거나
+추정하지 않는다. 이 문서는 전자서명, 검토 통과, 구현 승인 또는 제품 실행 승인이
+아니다.
+
+## 승인 문구와 적용 범위
+
+현재 대화에서 사용자는 다음과 같이 지시했다.
+
+> 네 권장 순서로 자동으로 진행해주세요. 단, 독립 검토 필요시에는 꼭 Claude에 요청해주세요. --skip-preflight 예외 또한 승인합니다.
+
+이 승인은
+[검토 task](prompt-refiner-durable-stage-writer-ci-fix-v1.task.json)에 정의된 새
+exchange의 Claude 읽기 전용 독립 검토에만 적용한다. author는 Codex,
+reviewer는 Claude이며 exact base는
+`29d7f98a4986ae8d1226854a43ed785b5086fd9f`이다. writable scope는 CI 후속
+수정 6개 경로와 이 task 및 authorization 2개 경로인 exact 8개이고 generated
+paths는 비어 있다. controller의 임시 산출물은 exchange 종결 전까지 저장소 밖에서
+유지하고, 최종 기록만 별도 커밋으로 보존한다.
+
+## 유지되는 경계
+
+- Claude는 저장된 Claude Max `claude.ai` 로그인으로 `claude --print
+  --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools
+  Read,Grep,Glob --strict-mcp-config`를 사용한다. shell, write, 추가 MCP, 모델
+  override는 허용하지 않는다.
+- review child 환경에서 `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고
+  `claude auth status --json`이 `authMethod=claude.ai`,
+  `subscriptionType=max`임을 확인한다. 실패하면 API key 방식으로 전환하지 않는다.
+- `--skip-preflight`만 허용하며 `--review-despite-check-failures`와 test/CI 우회는
+  금지한다.
+- 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토만 허용한다.
+- Prompt Refiner provider/model 호출, external 또는 Railway API, credential 조회,
+  stage mutation, flag/rollout, 유료 실행과 실제 지출은 승인하지 않는다.
+- 이 기록의 작성·검증·커밋은 검토 통과, push, merge 또는 deploy 승인이 아니다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.task.json
new file mode 100644
index 00000000..71ab9b6b
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.task.json
@@ -0,0 +1,25 @@
+{
+  "taskId": "prompt-refiner-durable-stage-writer-ci-fix-v1",
+  "requirement": "PR #1555의 Prompt Refiner durable stage writer가 추가한 외래 키, runtime source manifest, 설치 의존성 해석과 SQL 상수 때문에 기존 CI가 실패한 부분을 정확한 최소 예외와 FK-aware test cleanup으로 정합화한다. AdminAuditLog test cleanup은 관련된 세 integration suite 모두 PromptRefinerReservation 및 PromptRefinerReservationStage와 함께 명시적으로 truncate하되 CASCADE를 쓰지 않는다. automatic fallback 경계는 fallback source의 content-free digest manifest만 허용하고 exports 조회나 dispatch를 허용하지 않는다. runtime source closure는 node_modules 아래 비-workspace 설치 의존성 선언을 외부로 취급하되 등록된 workspace source는 계속 local closure 규칙과 정확한 진단을 적용하고, 미등록 @tomverse/* 이름은 fail-closed한다. protected-table writer 예외는 새 migration과 constant LOCK TABLE statement의 실제 동작·개수에 exact-match하며, retention report의 Prompt Refiner 문구 때문에 바뀐 정적 write-verb count도 정확히 설명하고 protected table write를 허용하지 않는다. author는 Codex, reviewer는 Claude Code Max이고 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only 및 strict MCP로 검토한다.",
+  "completionCriteria": [
+    "세 PostgreSQL integration test의 cleanup은 PromptRefinerReservation, PromptRefinerReservationStage, AdminAuditLog를 한 TRUNCATE statement에 명시하고 CASCADE를 사용하지 않는다.",
+    "automaticFallbackBoundary의 새 exact allowlist는 lib/promptRefinerStageAdmissionCore.ts가 providerFallbackCandidates source bytes를 content-free manifest에 결속하는 경우만 설명하며 fallback exports 조회 또는 model dispatch를 숨기지 않는다.",
+    "runtime source closure는 Linux checkout 내부 node_modules resolution을 external dependency로 제외하면서 등록된 workspace source와 @/* alias source를 계속 local closure에 포함하고 실제 next-auth/next resolution 경로와 미등록 @tomverse/* 거부를 테스트한다.",
+    "protected-table writer allowlist는 20260918130000 migration의 AdminAuditLog read-only FK/guard reference, promptRefinerStageAdmission.ts의 constant ModelRegistryEntry lock 및 report-unswept-tables의 Prompt Refiner retention 문구로 인한 정적 count를 exact path/count로 설명하며 실제 protected table write를 허용하지 않는다.",
+    "관련 focused tests, full unit suite, PostgreSQL accounts integration lane, TypeScript, ESLint, strict encoding 및 diff whitespace 검사가 통과한다.",
+    "변경은 CI 정합성으로 한정되고 Prompt Refiner product/provider/network/credential/stage seed/flag/rollout/spending 경계를 바꾸지 않는다.",
+    "Claude verdict는 package digest와 결속하며 finding마다 location, severity, basis와 reproduction을 제공한다. 최초 검토와 최대 두 번의 수정 검토 후 actionable finding이 남으면 on_hold다."
+  ],
+  "baseCommit": "29d7f98a4986ae8d1226854a43ed785b5086fd9f",
+  "writableScope": [
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.authorization.md",
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-ci-fix-v1.task.json",
+    "scripts/check-protected-table-writers-core.mjs",
+    "tests/automaticFallbackBoundary.test.mjs",
+    "tests/integration/admin-audit-chain-writer.db.test.ts",
+    "tests/integration/marketing-automation-schema.db.test.ts",
+    "tests/integration/prompt-refiner-reservation-admission.db.test.ts",
+    "tests/promptRefinerRuntimeSourceClosure.test.mjs"
+  ],
+  "generatedPaths": []
+}
diff --git a/scripts/check-protected-table-writers-core.mjs b/scripts/check-protected-table-writers-core.mjs
index af6f8854..f73d6b41 100644
--- a/scripts/check-protected-table-writers-core.mjs
+++ b/scripts/check-protected-table-writers-core.mjs
@@ -291,13 +291,21 @@ export const RAW_SQL_ALLOWLIST = [
     reason:
       "The append-only and chain-head triggers themselves: they name UPDATE, DELETE and INSERT to refuse or constrain them, and write nothing.",
   },
+  {
+    path: "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+    table: "AdminAuditLog",
+    tableMentions: 2,
+    writeVerbs: 14,
+    reason:
+      "The stage-admission migration adds a restrictive foreign key to AdminAuditLog and reads the linked authorization row from its insert guard. Its write verbs create or constrain the Prompt Refiner stage and reservation tables; it never writes AdminAuditLog.",
+  },
   {
     path: "scripts/report-unswept-tables-core.mjs",
     table: "MarketingReport",
     tableMentions: 1,
-    writeVerbs: 2,
+    writeVerbs: 4,
     reason:
-      "The retention registry's prose: one entry says an AI visibility run has the same shape as MarketingReport's, and other entries in the file use the words delete and update. A report; it opens no database connection.",
+      "The retention registry's prose: the Prompt Refiner stage entry contributes update/delete, and two other entries describe deletes. MarketingReport is named by an AI-visibility shape comparison. This is a report; it opens no database connection.",
   },
   {
     path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
@@ -368,6 +376,12 @@ export const RUNTIME_SQL_ALLOWLIST = [
     count: 1,
     reason: "LOCK TABLE \"ModelRegistryEntry\" IN SHARE MODE, a constant string.",
   },
+  {
+    path: "lib/promptRefinerStageAdmission.ts",
+    count: 1,
+    reason:
+      "LOCK TABLE \"ModelRegistryEntry\" IN SHARE MODE before validating the pinned model row; the SQL is a constant and names no protected table.",
+  },
   {
     path: "scripts/audit-image-backfill.mjs",
     count: 7,
diff --git a/tests/automaticFallbackBoundary.test.mjs b/tests/automaticFallbackBoundary.test.mjs
index f0676445..84f0e4a1 100644
--- a/tests/automaticFallbackBoundary.test.mjs
+++ b/tests/automaticFallbackBoundary.test.mjs
@@ -174,6 +174,8 @@ test("only the surfaces that offer a choice import the fallback table", () => {
       "names models still reachable in a provider-budget refusal, before any stream exists",
     "components/chat/ProviderStatusBanner.tsx":
       "renders those candidates for the user to pick from",
+    "lib/promptRefinerStageAdmissionCore.ts":
+      "binds the fallback table's source bytes into a content-free runtime manifest; it does not read the table's exports or dispatch a model",
   };
 
   // The allowlist keys are POSIX-shaped literals, so the separator is
diff --git a/tests/integration/admin-audit-chain-writer.db.test.ts b/tests/integration/admin-audit-chain-writer.db.test.ts
index 2784d0f8..a7c8c6cc 100644
--- a/tests/integration/admin-audit-chain-writer.db.test.ts
+++ b/tests/integration/admin-audit-chain-writer.db.test.ts
@@ -23,7 +23,13 @@ import { prisma } from "@/lib/prisma";
 const SECRET = "admin-audit-chain-writer-db-secret-0032";
 
 const reset = () =>
-  prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY`);
+  prisma.$executeRawUnsafe(`
+    TRUNCATE TABLE
+      "PromptRefinerReservation",
+      "PromptRefinerReservationStage",
+      "AdminAuditLog"
+    RESTART IDENTITY
+  `);
 
 const session = {
   user: { id: "admin-chain-writer", email: "owner@example.test" },
diff --git a/tests/integration/marketing-automation-schema.db.test.ts b/tests/integration/marketing-automation-schema.db.test.ts
index d1038597..f7b0371b 100644
--- a/tests/integration/marketing-automation-schema.db.test.ts
+++ b/tests/integration/marketing-automation-schema.db.test.ts
@@ -294,7 +294,13 @@ beforeEach(async () => {
   previousAuditKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
   process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_SECRET;
   await reset();
-  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY`);
+  await prisma.$executeRawUnsafe(`
+    TRUNCATE TABLE
+      "PromptRefinerReservation",
+      "PromptRefinerReservationStage",
+      "AdminAuditLog"
+    RESTART IDENTITY
+  `);
 });
 
 after(async () => {
diff --git a/tests/integration/prompt-refiner-reservation-admission.db.test.ts b/tests/integration/prompt-refiner-reservation-admission.db.test.ts
index 7f98c406..7d0c5f8f 100644
--- a/tests/integration/prompt-refiner-reservation-admission.db.test.ts
+++ b/tests/integration/prompt-refiner-reservation-admission.db.test.ts
@@ -54,7 +54,7 @@ const request = () =>
 const reset = async () => {
   await prisma.$executeRawUnsafe(`
     TRUNCATE TABLE "PromptRefinerReservation", "PromptRefinerReservationStage", "AdminAuditLog"
-    RESTART IDENTITY CASCADE
+    RESTART IDENTITY
   `);
 };
 
diff --git a/tests/promptRefinerRuntimeSourceClosure.test.mjs b/tests/promptRefinerRuntimeSourceClosure.test.mjs
index 58fdb3cd..db0da501 100644
--- a/tests/promptRefinerRuntimeSourceClosure.test.mjs
+++ b/tests/promptRefinerRuntimeSourceClosure.test.mjs
@@ -203,8 +203,16 @@ const compilerAliasCouldBeLocal = (specifier) =>
       : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
   });
 
+const isInstalledDependencyResolution = (path) =>
+  path.replaceAll("\\", "/").split("/").includes("node_modules");
+
 const resolveLocalRuntimeImport = (fromPath, specifier) => {
   const workspace = workspaceForSpecifier(specifier);
+  assert.equal(
+    specifier.startsWith("@tomverse/") && workspace === null,
+    false,
+    `unrecognized local workspace import: ${specifier} from ${fromPath}`
+  );
   const resolution = ts.resolveModuleName(
     specifier,
     join(repositoryRoot, fromPath),
@@ -214,6 +222,11 @@ const resolveLocalRuntimeImport = (fromPath, specifier) => {
   if (resolution) {
     const resolvedReal = realpathSync.native(resolution.resolvedFileName);
     const path = relative(repositoryRootReal, resolvedReal);
+    // npm installs external packages below node_modules inside the checkout on
+    // Linux, while a Windows junction may resolve outside the checkout. Treat
+    // both layouts alike. Workspace links realpath back to packages/* and are
+    // still included by the local-runtime branch below.
+    if (workspace === null && isInstalledDependencyResolution(path)) return null;
     const inside = path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../") && !isAbsolute(path);
     if (inside) {
       assert.equal(
@@ -1139,6 +1152,17 @@ test("closure parser binds aliases and every supported runtime module loading fo
   }
 });
 
+test("installed dependency declarations are external but workspace sources remain local", () => {
+  assert.equal(isInstalledDependencyResolution("node_modules/next-auth/next.d.ts"), true);
+  assert.equal(isInstalledDependencyResolution("packages/example/node_modules/dependency/index.d.ts"), true);
+  assert.equal(isInstalledDependencyResolution("packages/chat-core/src/index.ts"), false);
+  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "next-auth/next"), null);
+  assert.throws(
+    () => resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/not-a-workspace"),
+    /unrecognized local workspace import/
+  );
+});
+
 test("TypeScript options and workspace metadata control local resolution", () => {
   assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@/lib/adminAudit"), "lib/adminAudit.ts");
   assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/chat-core"), "packages/chat-core/src/index.ts");

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/automaticFallbackBoundary.test.mjs tests/promptRefinerRuntimeSourceClosure.test.mjs tests/protectedTableWriters.test.mjs` (5945ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 5849.2609

## Guard results (run by the control program)

- PASS `npm run check:protected-table-writers` (3084ms)
  ected table writer check passed: 2019 source file(s) analysed; no direct AdminAuditLog write found outside lib/adminAudit.ts; no direct MarketingChannel write found outside lib/marketingStore.ts; no direct MarketingPost write found outside lib/marketingStore.ts; no direct MarketingReport write found outside lib/marketingStore.ts; no direct AiVisibilityRun write found outside lib/marketingStore.ts.
- PASS `npm run typecheck` (41472ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npx eslint scripts/check-protected-table-writers-core.mjs tests/automaticFallbackBoundary.test.mjs tests/integration/admin-audit-chain-writer.db.test.ts tests/integration/marketing-automation-schema.db.test.ts tests/integration/prompt-refiner-reservation-admission.db.test.ts tests/promptRefinerRuntimeSourceClosure.test.mjs` (3165ms)
- PASS `npm run check:doc-references` (1430ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 898 referenced path(s) across 116 instruction document(s), and 1009 path(s) named by comments across 3025 source file(s), all present.
- PASS `npm run check:encoding:strict` (1364ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check 29d7f98a4986ae8d1226854a43ed785b5086fd9f HEAD -- .` (60ms)

## Findings from the previous round (check each was addressed)

- [nit/evidence] scripts/check-protected-table-writers-core.mjs:303-308: The diff also recalibrates a third allowlist entry (scripts/report-unswept-tables-core.mjs, MarketingReport writeVerbs 2 -> 4), which the completion criterion's "only the 20260918130000 migration and promptRefinerStageAdmission.ts" wording does not mention, and the entry's reason text does not name the Prompt Refiner prose that accounts for the two added verbs.
- [nit/judgement] tests/promptRefinerRuntimeSourceClosure.test.mjs:224: The `workspace === null` gate closes round 0's finding for recognised workspace packages, but a `@tomverse/*` specifier that is not a workspace name (workspaceForSpecifier returns null) and resolves under node_modules is still classified external without reaching the `local workspace import resolved outside repository` assertion at line 234.

## Author's account (read last; a claim, not a finding)

Summary: Round 1's two nits are closed. The static MarketingReport allowlist now names exactly why Prompt Refiner retention prose adds update/delete to the two existing delete verbs, and the task criterion covers that exact count. The runtime closure rejects any unregistered @tomverse/* specifier before resolution, while registered workspaces remain local and ordinary node_modules dependencies remain external; a direct rejection test pins this boundary. Focused tests pass 34/34, protected-table writer and lint pass. Prior PostgreSQL evidence remains 124 migrations plus admission suite 15/15, accounts lane green, and full unit suite green. No product database, provider, Railway management API, credential lookup, stage mutation, flag activation, or paid call occurred.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-durable-stage-writer-ci-fix-v1",
  "round": 2,
  "reviewedDigest": "sha256:00a6ce12d2fde96f12440d8905faa48fea7effeb8bac75649d60b8e8b99a192f",
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
