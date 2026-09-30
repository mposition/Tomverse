# Independent review — task prompt-refiner-durable-stage-writer-v1, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Prompt Refiner의 과거 provider-free evidence와 admission proposal을 현재 staging 배포의 exact source 및 실행 계약에 다시 결속하고, 명시적 관리자 비용 승인을 immutable stage 행과 tamper-evident audit 행으로 원자적으로 기록하는 durable stage writer를 독립 검토한다. 검토 대상 구현 source는 58d3e1617940c0c8c6ecffd5be993a0396460bdb이고 exact base는 c49d5a3606f259356612ddc5872f29f5fe465158이다. 최종 runtime closure는 정확히 186개 파일(도달 가능한 TypeScript/JavaScript 177개 + 고정 metadata/config/migration 9개)이며, stage는 default-off이고 이 변경에는 제품 caller, 제품 provider/model 호출, external API 또는 Railway 관리 API 호출, 실제 지출 경로가 없다. 독립 검토에 사용하는 Claude Max CLI의 인증·검토 네트워크는 이 제품 실행 경계에 포함하지 않는다. author는 codex, reviewer는 claude이며 사용자가 승인한 --skip-preflight 예외 아래 Claude Code Max 구독 CLI를 Read·Grep·Glob only 및 strict MCP로 사용한다.

## Completion criteria

- 최종 runtime source closure가 정확히 186개 파일(도달 가능한 TypeScript/JavaScript 177개와 고정 metadata/config/migration 9개)로 결속되고, exact raw bytes·full commit SHA·staging deployment id·bounded size·canonical digest 및 보수적 loader/capability 검사가 drift를 fail-closed한다.
- owner 전용 GET preview는 no-store·content-free·read-only이고, POST create-only writer는 strict body, recent authentication, CSRF, DB rate limit, fixed confirmation과 서버가 재계산한 proposal/runtime/execution/preview binding을 요구한다. stale preview, deployment/source/contract drift와 immutable fact mismatch는 쓰기 전에 거부된다.
- stage insert와 tamper-evident audit insert는 하나의 transaction에서 함께 commit 또는 rollback하며, exact replay만 idempotent하다. linked audit HMAC·signed metadata·previousHash predecessor를 공용 helper로 재검증하고 forged audit/stage, provenance 수정·삭제와 만료 후 reserve/consume을 fail-closed한다.
- stage는 seed 없이 default-off 상태를 유지하고 executionAdmitted=false 및 productAdapterReady=false다. provider adapter, provider/model call, external API 또는 Railway 관리 API, credential lookup, 제품 caller, flag/rollout, receipt/reservation 실행과 실제 지출은 0이며 이 변경이 이를 승인하거나 연결하지 않는다.
- fresh PostgreSQL 17 검증에서 124개 migration이 적용되고 drift가 없으며, 관련 DB integration 35개, admin audit chain 19개, shadow-stage route contract 6개가 모두 통과한다.
- runtime source closure test는 최종 186개 파일이 도달 가능한 TypeScript/JavaScript 177개와 고정 metadata/config/migration 9개로 정확히 구성됨을 검증한다. focused Prompt Refiner verifier와 typecheck, 변경 파일 lint, Prisma validate, model-pricing, enum constraints, data-domain registry, unswept-table registry, 문서·정책 참조, strict encoding 및 diff whitespace guard가 각각 통과한다.
- Claude reviewer는 요구사항과 base-to-implementation 전체 diff를 먼저 읽고 작성자 요약과 검사 기록을 뒤에 읽는다. verdict는 package digest를 정확히 명시하고 finding마다 location·severity·basis·재현 절차를 제공하며, 최초 검토와 최대 2회 수정 검토 뒤 actionable finding이 남으면 on_hold다.
- Claude 독립 검토는 Claude Code Max의 저장된 claude.ai 로그인만 사용하고 --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config로 실행한다. 사용자가 승인한 --skip-preflight만 기록된 skip으로 허용하며 --review-despite-check-failures, API-key fallback, 모델 override, 추가 MCP/shell/write 도구, provider 호출, push·merge·deploy 또는 유료 실행은 금지한다.
- 이 task와 authorization은 새 exchange이며 supersedes가 없고 generatedPaths는 비어 있다. 현재 base-to-HEAD 검토 diff는 구현 변경 30개와 이 task/authorization 2개, 총 32개 exact path다. multi-round replay가 round 0의 migration rename source를 동일 provenance로 검증할 수 있도록 이전 migration path 1개를 historical-only로 유지하여 writableScope union은 총 33개 exact path이며, 검토 diff에서 source나 기록을 제외하지 않는다.

## Change under review — digest sha256:61d4dfbbdf9450b08e268d123a6968ee6a6170acebb009a9a84f22f39621a0ce, commit 36361085a65e60e451ac392a98afef17db4b4905

```diff
diff --git a/.github/workflows/credit-finance-db-integration.yml b/.github/workflows/credit-finance-db-integration.yml
index 8e0a135a..66938e61 100644
--- a/.github/workflows/credit-finance-db-integration.yml
+++ b/.github/workflows/credit-finance-db-integration.yml
@@ -10,6 +10,16 @@ on:
       - "lib/stripe*.ts"
       - "lib/promptRefinerReservation*.ts"
       - "lib/promptRefinerExecutionContract.ts"
+      - "lib/promptRefinerShadowAdmissionCore.ts"
+      - "lib/promptRefinerStageAdmission*.ts"
+      - "app/api/admin/prompt-refiner/**"
+      - "docs/policy/prompt-refiner-observability.md"
+      - "docs/policy/prompt-refiner-durable-stage-writer-threat-model.md"
+      - "docs/ops/prompt-refiner-durable-stage-writer-*.md"
+      - "docs/policy/tomverse-chat-data-domain-registry.yaml"
+      - "lib/accountDataExportDomains.ts"
+      - "scripts/check-data-domain-registry.mjs"
+      - "scripts/report-unswept-tables-core.mjs"
       - "lib/adminUsers.ts"
       - "lib/userTimeZone.ts"
       - "app/api/billing/**"
diff --git a/app/api/admin/prompt-refiner/shadow-stage/route.ts b/app/api/admin/prompt-refiner/shadow-stage/route.ts
new file mode 100644
index 00000000..d6b75fd7
--- /dev/null
+++ b/app/api/admin/prompt-refiner/shadow-stage/route.ts
@@ -0,0 +1,142 @@
+export const dynamic = "force-dynamic";
+
+import { getServerSession } from "next-auth/next";
+import { NextResponse } from "next/server";
+import { z } from "zod";
+
+import { authOptions } from "@/lib/auth";
+import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
+import {
+  assertRecentAdminAuthentication,
+  isAdminReauthenticationError,
+} from "@/lib/adminReauthentication";
+import {
+  apiSecurityResponse,
+  consumeApiRateLimit,
+  readLimitedJson,
+} from "@/lib/apiSecurity";
+import {
+  PROMPT_REFINER_STAGE_CONFIRMATION,
+} from "@/lib/promptRefinerStageAdmissionCore";
+import {
+  createPromptRefinerReservationStage,
+  promptRefinerStageAdmissionErrorResponse,
+  promptRefinerStagePreview,
+} from "@/lib/promptRefinerStageAdmission";
+
+const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
+const createSchema = z
+  .object({
+    proposalDigest: digest,
+    runtimeSourceManifestDigest: digest,
+    executionManifestDigest: digest,
+    previewBindingDigest: digest,
+    confirmation: z.literal(PROMPT_REFINER_STAGE_CONFIRMATION),
+  })
+  .strict();
+
+const noStoreHeaders = {
+  "Cache-Control": "private, no-store, max-age=0",
+};
+
+const withNoStore = (response: Response) => {
+  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
+  return response;
+};
+
+const requireOwner = async () => {
+  const session = await getServerSession(authOptions);
+  if (!session?.user?.id || !isAdminSession(session)) {
+    return { response: NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders }) } as const;
+  }
+  if (getAdminRole(session) !== "owner") {
+    return { response: NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders }) } as const;
+  }
+  try {
+    await assertRecentAdminAuthentication(session);
+  } catch (error) {
+    if (isAdminReauthenticationError(error)) {
+      return {
+        response: NextResponse.json(
+          { error: "Recent administrator authentication is required.", code: "ADMIN_REAUTHENTICATION_REQUIRED" },
+          { status: 428, headers: noStoreHeaders }
+        ),
+      } as const;
+    }
+    throw error;
+  }
+  return { session } as const;
+};
+
+export async function GET() {
+  try {
+    const auth = await requireOwner();
+    if ("response" in auth) return auth.response;
+    const preview = await promptRefinerStagePreview();
+    return NextResponse.json({ preview }, { headers: noStoreHeaders });
+  } catch (error) {
+    const admission = promptRefinerStageAdmissionErrorResponse(error);
+    if (admission) return withNoStore(admission);
+    console.error("Failed to preview Prompt Refiner shadow stage:", error);
+    return NextResponse.json(
+      { error: "Failed to preview Prompt Refiner shadow stage." },
+      { status: 500, headers: noStoreHeaders }
+    );
+  }
+}
+
+export async function POST(request: Request) {
+  try {
+    const auth = await requireOwner();
+    if ("response" in auth) return auth.response;
+    await consumeApiRateLimit(
+      request,
+      auth.session.user.id,
+      "admin-prompt-refiner-stage-activate",
+      { minute: 2, day: 10 }
+    );
+    const body = await readLimitedJson(request, 4 * 1024, createSchema);
+    const result = await createPromptRefinerReservationStage({
+      session: auth.session,
+      request,
+      expected: {
+        proposalDigest: body.proposalDigest,
+        runtimeSourceManifestDigest: body.runtimeSourceManifestDigest,
+        executionManifestDigest: body.executionManifestDigest,
+        previewBindingDigest: body.previewBindingDigest,
+      },
+    });
+    return NextResponse.json(
+      {
+        stage: {
+          id: result.stage.id,
+          status: result.stage.status,
+          proposalDigest: result.stage.proposalDigest,
+          runtimeSourceManifestDigest: result.stage.runtimeSourceManifestDigest,
+          executionManifestDigest: result.stage.executionManifestDigest,
+          environment: result.stage.runtimeEnvironment,
+          deploymentId: result.stage.runtimeDeploymentId,
+          commitSha: result.stage.runtimeCommitSha,
+          approvedAt: result.stage.approvedAt.toISOString(),
+          approvalExpiresAt: result.stage.approvalExpiresAt.toISOString(),
+          authorizationAuditLogId: result.stage.authorizationAuditLogId,
+          executionAdmitted: false,
+          productAdapterReady: false,
+        },
+        created: result.created,
+        replayed: result.replayed,
+      },
+      { status: result.created ? 201 : 200, headers: noStoreHeaders }
+    );
+  } catch (error) {
+    const admission = promptRefinerStageAdmissionErrorResponse(error);
+    if (admission) return withNoStore(admission);
+    const security = apiSecurityResponse(error);
+    if (security) return withNoStore(security);
+    console.error("Failed to create Prompt Refiner shadow stage:", error);
+    return NextResponse.json(
+      { error: "Failed to create Prompt Refiner shadow stage." },
+      { status: 500, headers: noStoreHeaders }
+    );
+  }
+}
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.authorization.md b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.authorization.md
new file mode 100644
index 00000000..0bb34c0f
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.authorization.md
@@ -0,0 +1,66 @@
+# Prompt Refiner durable stage writer Claude 독립 검토 제한 승인
+
+Codex가 현재 대화의 사용자 승인을 기록한다. 사용자 메시지의 시각은 기록하거나
+추정하지 않는다. 이 문서는 전자서명, 검토 통과, 구현 승인, 커밋·푸시·병합·배포
+또는 유료 실행 승인이 아니다.
+
+## 승인 문구와 적용 범위
+
+현재 대화에서 사용자는 다음과 같이 지시했다.
+
+> 네 권장 순서로 자동으로 진행해주세요. 단, 독립 검토 필요시에는 꼭 Claude에 요청해주세요. --skip-preflight 예외 또한 승인합니다.
+
+이 승인은
+[검토 task](prompt-refiner-durable-stage-writer-v1.task.json)에 정의된 새 exchange의
+Claude 읽기 전용 독립 검토에만 적용한다. author는 Codex, reviewer는 Claude이고
+supersedes는 없다. exact base는
+`c49d5a3606f259356612ddc5872f29f5fe465158`, 독립 검토에 제출할 구현 source는
+`58d3e1617940c0c8c6ecffd5be993a0396460bdb`다. writable scope는 base 대비 구현
+변경 30개와 이 task/authorization 2개를 합친 현재 검토 diff exact 32개 경로에,
+round 0 migration rename source
+`prisma/migrations/20260917190000_prompt_refiner_stage_admission/migration.sql` 1개를
+multi-round replay provenance 보존용 historical-only 경로로 유지한 exact 33개
+union이다. 이 추가는 현재 writable source나 검토 diff를 넓히지 않으며
+`generatedPaths`는 비어 있다.
+
+Round 0 reviewed digest
+`sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc`의
+판정은 `request_changes`였다. 이 수정은 원래 사용자 승인 문구와
+`--skip-preflight` 예외를 바꾸지 않고 구현 source와 rename된 migration exact
+scope만 round 1 대기 source에 다시 결속한다. round 1 검토 통과나 완료를 주장하지
+않는다.
+
+승인 범위의 목표는 final runtime closure 186개가 TypeScript/JavaScript 177개와
+고정 metadata/config/migration 9개로 정확히 구성되는지, fresh PostgreSQL 17에서
+124 migrations·drift 0·DB integration 35개·audit contract 19개·route contract
+6개가 통과하는지, stage가 default-off이며 제품 caller, provider/model 호출,
+external API 또는 Railway 관리 API 호출과 실제 지출 경로가 없는지 독립적으로
+검토하는 것이다. 독립 검토에 사용하는 Claude Max CLI의 인증·검토 네트워크는
+이 제품 실행 경계에 포함하지 않는다. 이 수치는 검토 요구사항이지 이 문서가
+그 결과를 인증한다는 뜻이 아니다.
+
+## 유지되는 경계
+
+- Claude는 저장된 Claude Max `claude.ai` 로그인으로
+  `claude --print --safe-mode --output-format json --tools Read,Grep,Glob
+  --allowedTools Read,Grep,Glob --strict-mcp-config`를 사용한다. 모델 override,
+  shell·write 도구 또는 추가 MCP 접근은 허용하지 않는다.
+- review child 환경 복사본에서 모든 대소문자 표기의 `ANTHROPIC_API_KEY`와
+  `ANTHROPIC_AUTH_TOKEN`을 제거하고 sanitized `claude auth status`가
+  `authMethod=claude.ai`, `subscriptionType=max`임을 확인한다. 확인 실패 시 API
+  key 방식으로 전환하지 않고 중단하며 parent 환경과 영구 설정은 바꾸지 않는다.
+- `--skip-preflight`만 허용한다. 이는 쓰기 거부 probe를 실행하지 않은 사실을
+  skip으로 기록하는 예외이며 preflight 통과나 쓰기 불가능성의 증거가 아니다.
+  `--review-despite-check-failures`와 테스트·CI 우회는 금지한다.
+- 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토만 허용한다.
+  상한에서 지적이 남으면 `on_hold`로 종결하고 새 exchange, supersedes 또는
+  override로 revision 상한을 우회하지 않는다.
+- 패키지와 guard가 모두 통과한 exact base-to-source diff만 검토한다. 30개 구현
+  경로 또는 두 승인 기록을 diff에서 제외하지 않으며 package digest와 구현 source
+  SHA가 일치하지 않으면 검토를 실행하지 않는다.
+- provider/model 호출, external API 또는 Railway 관리 API 호출, credential 조회,
+  제품 caller·flag·rollout 연결, 실제 reservation/receipt/dispatch, 유료 실행과
+  실제 지출은 승인하지 않는다. stage는 `executionAdmitted=false` 및
+  `productAdapterReady=false`인 default-off 상태를 유지한다.
+- push·merge·deploy와 production/staging mutation은 승인하지 않는다. 이 두 기록의
+  작성·검증·커밋은 독립 검토 실행이나 검토 결과를 뜻하지 않는다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.task.json
new file mode 100644
index 00000000..7a18fd1a
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.task.json
@@ -0,0 +1,53 @@
+{
+  "taskId": "prompt-refiner-durable-stage-writer-v1",
+  "requirement": "Prompt Refiner의 과거 provider-free evidence와 admission proposal을 현재 staging 배포의 exact source 및 실행 계약에 다시 결속하고, 명시적 관리자 비용 승인을 immutable stage 행과 tamper-evident audit 행으로 원자적으로 기록하는 durable stage writer를 독립 검토한다. 검토 대상 구현 source는 58d3e1617940c0c8c6ecffd5be993a0396460bdb이고 exact base는 c49d5a3606f259356612ddc5872f29f5fe465158이다. 최종 runtime closure는 정확히 186개 파일(도달 가능한 TypeScript/JavaScript 177개 + 고정 metadata/config/migration 9개)이며, stage는 default-off이고 이 변경에는 제품 caller, 제품 provider/model 호출, external API 또는 Railway 관리 API 호출, 실제 지출 경로가 없다. 독립 검토에 사용하는 Claude Max CLI의 인증·검토 네트워크는 이 제품 실행 경계에 포함하지 않는다. author는 codex, reviewer는 claude이며 사용자가 승인한 --skip-preflight 예외 아래 Claude Code Max 구독 CLI를 Read·Grep·Glob only 및 strict MCP로 사용한다.",
+  "revisionNote": "Round 0 reviewed digest sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc concluded request_changes. The original user authorization, including the --skip-preflight exception, is unchanged; this revision rebinds the implementation source and renamed migration path for the pending round 1 review.",
+  "completionCriteria": [
+    "최종 runtime source closure가 정확히 186개 파일(도달 가능한 TypeScript/JavaScript 177개와 고정 metadata/config/migration 9개)로 결속되고, exact raw bytes·full commit SHA·staging deployment id·bounded size·canonical digest 및 보수적 loader/capability 검사가 drift를 fail-closed한다.",
+    "owner 전용 GET preview는 no-store·content-free·read-only이고, POST create-only writer는 strict body, recent authentication, CSRF, DB rate limit, fixed confirmation과 서버가 재계산한 proposal/runtime/execution/preview binding을 요구한다. stale preview, deployment/source/contract drift와 immutable fact mismatch는 쓰기 전에 거부된다.",
+    "stage insert와 tamper-evident audit insert는 하나의 transaction에서 함께 commit 또는 rollback하며, exact replay만 idempotent하다. linked audit HMAC·signed metadata·previousHash predecessor를 공용 helper로 재검증하고 forged audit/stage, provenance 수정·삭제와 만료 후 reserve/consume을 fail-closed한다.",
+    "stage는 seed 없이 default-off 상태를 유지하고 executionAdmitted=false 및 productAdapterReady=false다. provider adapter, provider/model call, external API 또는 Railway 관리 API, credential lookup, 제품 caller, flag/rollout, receipt/reservation 실행과 실제 지출은 0이며 이 변경이 이를 승인하거나 연결하지 않는다.",
+    "fresh PostgreSQL 17 검증에서 124개 migration이 적용되고 drift가 없으며, 관련 DB integration 35개, admin audit chain 19개, shadow-stage route contract 6개가 모두 통과한다.",
+    "runtime source closure test는 최종 186개 파일이 도달 가능한 TypeScript/JavaScript 177개와 고정 metadata/config/migration 9개로 정확히 구성됨을 검증한다. focused Prompt Refiner verifier와 typecheck, 변경 파일 lint, Prisma validate, model-pricing, enum constraints, data-domain registry, unswept-table registry, 문서·정책 참조, strict encoding 및 diff whitespace guard가 각각 통과한다.",
+    "Claude reviewer는 요구사항과 base-to-implementation 전체 diff를 먼저 읽고 작성자 요약과 검사 기록을 뒤에 읽는다. verdict는 package digest를 정확히 명시하고 finding마다 location·severity·basis·재현 절차를 제공하며, 최초 검토와 최대 2회 수정 검토 뒤 actionable finding이 남으면 on_hold다.",
+    "Claude 독립 검토는 Claude Code Max의 저장된 claude.ai 로그인만 사용하고 --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config로 실행한다. 사용자가 승인한 --skip-preflight만 기록된 skip으로 허용하며 --review-despite-check-failures, API-key fallback, 모델 override, 추가 MCP/shell/write 도구, provider 호출, push·merge·deploy 또는 유료 실행은 금지한다.",
+    "이 task와 authorization은 새 exchange이며 supersedes가 없고 generatedPaths는 비어 있다. 현재 base-to-HEAD 검토 diff는 구현 변경 30개와 이 task/authorization 2개, 총 32개 exact path다. multi-round replay가 round 0의 migration rename source를 동일 provenance로 검증할 수 있도록 이전 migration path 1개를 historical-only로 유지하여 writableScope union은 총 33개 exact path이며, 검토 diff에서 source나 기록을 제외하지 않는다."
+  ],
+  "baseCommit": "c49d5a3606f259356612ddc5872f29f5fe465158",
+  "writableScope": [
+    ".github/workflows/credit-finance-db-integration.yml",
+    "app/api/admin/prompt-refiner/shadow-stage/route.ts",
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.authorization.md",
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.task.json",
+    "docs/ops/prompt-refiner-durable-stage-writer-contract.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-task.md",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-durable-stage-writer-threat-model.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "docs/policy/tomverse-chat-data-domain-registry.yaml",
+    "lib/accountDataExportDomains.ts",
+    "lib/adminAudit.ts",
+    "lib/adminAuditSystemActors.ts",
+    "lib/promptRefinerReservationAuthority.ts",
+    "lib/promptRefinerReservationCore.ts",
+    "lib/promptRefinerStageAdmission.ts",
+    "lib/promptRefinerStageAdmissionCore.ts",
+    "prisma/migrations/20260917190000_prompt_refiner_stage_admission/migration.sql",
+    "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+    "prisma/schema.prisma",
+    "scripts/check-data-domain-registry.mjs",
+    "scripts/report-unswept-tables-core.mjs",
+    "scripts/run-db-integration-tests.mjs",
+    "tests/fixtures/prompt-refiner-non-utc-writer-child.ts",
+    "tests/integration/prompt-refiner-reservation-admission.db.test.ts",
+    "tests/integration/prompt-refiner-reservation.db.test.ts",
+    "tests/promptRefinerReservationCore.test.mjs",
+    "tests/promptRefinerRuntimeSourceClosure.test.mjs",
+    "tests/promptRefinerShadowAdmissionCore.test.mjs",
+    "tests/promptRefinerStageAdmissionCore.test.mjs",
+    "tests/promptRefinerStageAdmissionReader.test.mjs",
+    "tests/server-contract/admin-audit-chain-writer.test.ts",
+    "tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/prompt-refiner-durable-stage-writer-contract.md b/docs/ops/prompt-refiner-durable-stage-writer-contract.md
new file mode 100644
index 00000000..bc440a94
--- /dev/null
+++ b/docs/ops/prompt-refiner-durable-stage-writer-contract.md
@@ -0,0 +1,169 @@
+# Prompt Refiner durable stage writer 운영 계약
+
+## 1. 불변 식별자
+
+- stage: `prompt-refiner-shadow-v1`
+- admission: `prompt-refiner-stage-admission-v1`
+- approval TTL: 정확히 60분
+- environment: `staging`만
+- confirmation: `APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES`
+- 감사 reason은 클라이언트 입력이 아니라 서버 내부 상수 `bounded_staging_shadow_cost_approval`로만 기록한다.
+
+과거 proposal/evidence/corpus/source digest와 reservation/execution contract의 실제 값은
+코드와 migration CHECK에 함께 고정된다. 운영자는 값을 request로 교체할 수 없다.
+
+## 2. GET preview
+
+`GET /api/admin/prompt-refiner/shadow-stage`
+
+인증된 owner와 최근 인증을 요구한다. DB mutation, rate-limit 소비, stage/audit 생성은 없다.
+서버가 과거 evidence를 replay하고 현재 deployment의 186개 고정 source 파일 raw bytes를 읽어
+proposal/runtime-source/execution digest, commit, deployment, 고정 비용·slot·TTL과
+`executionAdmitted:false`, `productAdapterReady:false`를 반환한다. 또한 environment,
+deployment id, commit SHA, 세 digest, 비용·capacity·TTL 전체의 canonical JSON을 결속한
+`previewBindingDigest`를 반환한다. 응답은 `no-store`다.
+
+## 3. POST create-only
+
+`POST /api/admin/prompt-refiner/shadow-stage`
+
+body는 4 KiB 이하 strict JSON이고 다음 다섯 필드만 허용한다.
+
+```json
+{
+  "proposalDigest": "sha256:<64 hex>",
+  "runtimeSourceManifestDigest": "sha256:<64 hex>",
+  "executionManifestDigest": "sha256:<64 hex>",
+  "previewBindingDigest": "sha256:<64 hex>",
+  "confirmation": "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES"
+}
+```
+
+POST는 owner, recent authentication, 전역 CSRF origin 검사와 DB atomic rate limit
+(분당 2, 일 10)을 모두 통과해야 한다. 서버는 GET 결과를 신뢰하지 않고 source/evidence를
+다시 검증하고 preview binding을 서버에서 재계산한다. 같은 commit/source라도 deployment id,
+비용, capacity 또는 TTL이 달라진 오래된 preview는 transaction 진입 전에 409로 거부한다.
+
+## 4. transaction과 idempotency
+
+전용 transaction 순서는 다음과 같다.
+
+1. 고정 advisory transaction lock
+2. model registry SHARE lock과 모델/가격 계약 재검증
+3. DB clock 취득
+4. 기존 stage 조회
+5. 없으면 tamper-evident audit insert
+6. audit id를 FK로 가진 stage insert
+7. 같은 공용 helper로 linked audit HMAC·metadata 결속을 검증하고 성공해야 commit
+
+동일 actor가 같은 deployment/source/execution facts를 approval TTL 안에서 replay하면 기존
+stage를 200으로 반환하며 audit을 추가하지 않는다. actor 또는 immutable facts가 다르거나
+행이 만료된 뒤 replay하면 409다. 최초 생성은 201이다. audit 또는 stage 쓰기가 실패하면
+둘 다 rollback한다.
+
+## 5. 저장 manifest
+
+runtime source manifest v2는 schema version, full commit SHA, 정렬된 고정 경로 각각의 byte
+size와 SHA-256 및 검증된 총 byte 수만 담는다. 8 MiB/file과 16 MiB/closure를 모두
+fail-closed로 적용한다. execution manifest는 고정 reservation/execution contract,
+cost/capacity와 두 false readiness boolean만 담는다. 두 JSON 모두 strict canonical digest로
+결속된다. prompt, refined prompt, output, user/conversation/session id, credential, provider
+error/body는 담지 않는다.
+
+## 6. DB 강제 계약
+
+- migration은 기존 stage가 있으면 중단하고 seed/backfill하지 않는다.
+- writer가 UTC로 정규화한 한 DB clock snapshot으로 승인·만료 시각을 audit metadata와 stage 양쪽에
+  기록하고, INSERT trigger는 두 값이 정확히 일치하지 않으면 거부한다.
+- DB CHECK는 186개 경로의 순서·exact key set·개별/총 크기·lowercase SHA-256 shape와 두 canonical
+  digest를 다시 계산하고 execution manifest의 canonical digest도 다시 계산한다.
+- 186개 중 177개 TypeScript/JavaScript source는 8개 실행 root에서 현재 parser가 지원하는
+  static import/re-export, literal dynamic import, literal `require`, require alias,
+  `module.require`와 `createRequire` 호출로 도달하는 local runtime 폐쇄와 같아야 한다.
+  `node:module`과 `module`은 같은 builtin으로 취급하고 named·default·namespace import의
+  `createRequire`는 추적한다. runtime re-export와 dynamic builtin namespace,
+  `createRequire` 외 module namespace surface는 정적으로 안전성을 증명하지 않고 거부한다.
+  `require("node:module")` 또는 `module.require("module")`의 반환값에서 곧바로
+  `createRequire`/`_load` 등을 호출하는 체인도 별칭 추적을 우회할 수 있으므로 거부한다.
+  type-only import는 제외하고, 해석할 수 없는 local 또는 non-literal runtime import도
+  테스트에서 거부한다. 나머지 9개는 root/workspace package metadata와
+  TypeScript/Prisma/migration 형식을 결속하는 고정 파일이다. 경로 해석은 checked-in
+  `tsconfig` compiler option과 workspace package exports를 사용한다. closure 검사는 현재
+  실행 폐쇄에서 사용하는 `process.env`, 직접 `process.cwd()`, 고정 operational state용
+  `globalThis.__tomverseOperationalState`, `lib/prisma.ts`의 정확한
+  `globalForPrisma.prisma` singleton 필드, 검증된 `Reflect.apply` 캡처만 명시적 safe form으로
+  인정한다. Node `global`의 다른 직접·별칭 사용은 거부한다. operational state는 현재
+  초기화 형태와 두 Map의 `get`/`set`만 허용한다.
+  `constructor`/`__proto__`/임의 `prototype` 체인, `Reflect.get(module, "require")`,
+  `process.mainModule.require`, eval/Function의 `.call`·`Reflect.apply` 및 그 밖의 정적으로
+  증명할 수 없는 loader 사용은 거부한다. 이는 열거한 JavaScript loader/capability 형태를
+  보수적으로 차단하는 구조 검사이며 임의 JavaScript reflection 전체에 대한 의미론적 증명은
+  아니다. 특히 non-static element access(`value[key]`)는 parser의 기본 경로에서 전부 거부한다.
+  현재 실행 폐쇄에 이미 존재하는 데이터 인덱싱만 path·line·column·정확한 source text의 정렬된
+  SHA-256 snapshot으로 동결해 허용한다. 접근 하나가 추가되거나 위치·표현이 바뀌어도 gate가
+  fail-closed하며, snapshot 갱신은 그 접근이 loader/capability escape를 열지 않는지 별도 검토한
+  뒤에만 가능하다. 이 snapshot은 검토된 예외의 완전한 구조 목록이지 임의 JavaScript 의미론에
+  대한 증명이 아니다. 특히 snapshot 안의 `value[key]`를 그대로 둔 채 다른 위치의 `key`
+  binding 의미만 바꾸는 경우는 이 AST gate 단독으로 검출하지 못한다. 그 residual은 승인된 exact
+  source-file bytes, full commit SHA와 deployment ID의 결속 및 독립 source review가 담당한다.
+  새 safe form 또는 동적 capability는 closure 계약과 negative fixture를 함께 검토하기 전에는
+  허용하지 않는다.
+- tamper-evident audit의 actor/action/target와 metadata 전체(digest, cost/capacity,
+  승인 시각·만료 시각·TTL, environment/deployment/commit, 서버 고정 reason)가 stage와
+  정확히 일치해야 한다.
+- DB trigger는 공개 구조와 결속만 검증한다. HMAC key를 소유하지 않으므로 `entryHash`의
+  진위를 주장하지 않는다. application writer create/replay와 reserve/consume은 같은 helper로
+  stage-linked audit 행의 signed payload를 현재·과거 integrity key와 현재·legacy canonical
+  형식으로 재검증한다. linked entry의 signed metadata도 stage와 다시 비교한다.
+  따라서 app-role이 exact metadata와 임의 64-hex hash로 audit/stage를 직접 삽입해도
+  `stage_authorization_invalid`로 실행 권한을 얻지 못한다.
+- HMAC 입력에 포함된 `previousHash`가 null이 아니면 그 exact `entryHash`의 선행 audit 행이
+  존재해야 한다. 이 검증은 stage-linked 행과 그 선행 hash 최대 2행만 읽고 global chain
+  scan/table SHARE lock을 하지 않으므로 unrelated audit write를 정체시키지 않는다. writer는
+  새 stage를 commit하기 전 같은 helper를 실행해 생성됐지만 사용할 수 없는 stage를 rollback한다.
+- stage provenance, actor, audit linkage와 생성 시각은 UPDATE할 수 없다.
+- 허용된 status 변경은 `approved -> closed`뿐이며 DELETE는 금지다.
+- reservation insert와 consume trigger는 stage expiry를 DB clock으로 검사한다.
+- slot/cost accounting은 영구 reservation tombstone 합계와 같아야 한다.
+
+## 7. reserve/consume 경계
+
+application authority도 매 reserve와 consume 전에 stage-linked audit 행의 HMAC과 결속을 검증하고,
+현재 environment/deployment/commit/source manifest와 execution contract를 다시 계산해 저장
+stage와 비교한다. audit 위조, 불일치 또는 만료면 fail-closed한다. release와 expiry 정리는
+이미 발생한 tombstone의 안전한 종료이므로 새 provider 실행 권한으로 취급하지 않는다.
+같은 `requestId`의 active reservation replay도 예외가 아니다. stage 승인·expiry, runtime
+source/deployment/execution, model/pricing이 모두 현재일 때만 기존 reservation을 idempotent하게
+반환하며, drift 뒤 replay는 과거 reservation을 새 실행 권한으로 되살리지 않는다.
+
+이 회차에는 stage를 소비하는 actual provider admission/caller가 없다. stage가 생겨도 제품
+요청, credential lookup, network, provider call, receipt 또는 flag mutation은 발생하지 않는다.
+
+## 8. 오류와 운영 판단
+
+- 404: admin surface 은닉
+- 403: admin이지만 owner 아님
+- 428: recent authentication 필요
+- 400/413: strict JSON 또는 4 KiB 위반
+- 409: stale preview, 환경/source/contract drift, 기존 immutable stage mismatch
+- 429: DB-backed rate limit
+- 503: runtime identity/source 또는 audit signing key 없음
+
+409는 retry 신호가 아니다. 새 GET으로 facts를 다시 확인하거나 이미 존재하는 immutable
+행을 조사한다. migration의 기존-row abort도 삭제/우회하지 말고 provenance를 사람이
+판정해야 한다.
+
+## 9. 검증 경로
+
+- pure core: manifest canonicalization, content-free fields, environment/digest/TTL refusal,
+  preview binding 결정성·필드별 tamper 감지
+- server contract: auth, GET no-write, strict body, no-network, fixed forwarding, CSRF coverage,
+  같은 commit/source의 deployment 변경 stale-preview no-write 거부
+- finance DB integration: no seed, concurrent one-row/one-audit, mismatch, rollback, direct SQL,
+  expiry 및 consume 거부
+- 기존 proposal/reservation/execution/Refiner/injection/PLANNER-03 회귀
+
+독립 Claude round 0 package digest는
+`sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc`이고
+판정은 `request_changes`다. 지적 수정과 검증 뒤 round 1 제출 대기이며, 이 기록은
+독립 검토 통과나 구현 완료를 뜻하지 않는다.
diff --git a/docs/ops/prompt-refiner-durable-stage-writer-task.md b/docs/ops/prompt-refiner-durable-stage-writer-task.md
new file mode 100644
index 00000000..93d31e21
--- /dev/null
+++ b/docs/ops/prompt-refiner-durable-stage-writer-task.md
@@ -0,0 +1,65 @@
+# Prompt Refiner durable stage writer 작업 정의
+
+## 1. 목표
+
+과거 provider-free evidence와 admission proposal을 현재 staging 배포의 exact source 및
+실행 계약에 다시 결속하고, 명시적 관리자 비용 승인을 하나의 immutable DB 행과 하나의
+tamper-evident audit 행으로 원자적으로 기록한다.
+
+이 작업의 완료는 **실행 승인이나 제품 활성화가 아니다**. 새 stage의 execution manifest는
+항상 `executionAdmitted=false`, `productAdapterReady=false`이고, provider adapter·제품 caller·
+flag·credential·receipt writer를 연결하지 않는다.
+
+## 2. 범위
+
+- 기존 `PromptRefinerReservationStage`의 additive migration
+- 승인 시점의 DB-owned 시각과 고정 60분 TTL
+- staging 환경, runtime commit, Railway deployment id, 186-file/16 MiB bounded exact-byte
+  runtime import-closure source manifest
+- 과거 proposal/evidence/corpus/source identity와 현재 execution manifest의 immutable 결속
+- owner 전용 관리자 GET preview와 POST create-only writer
+- advisory lock, DB rate limit, fixed confirmation, 최근 인증, 전역 CSRF
+- audit 성공 행과 stage insert의 단일 transaction
+- reserve 및 consume 시 DB clock 기준 expiry와 현재 runtime source 재검증
+- data-domain/export/retention/unswept/CI 계약과 테스트
+
+## 3. 범위 밖
+
+- stage seed 또는 자동 생성
+- provider/API/Railway 관리 API/credential 조회
+- 실제 모델 호출, receipt, reservation 생성, 제품 adapter, UI, rollout flag 변경
+- 기존 v1 proposal의 `executionAdmitted:false` 변경
+- caller가 승인자·시각·환경·비용·모델·capacity를 정하는 입력
+- prompt, refined prompt, output, 사용자/대화 식별자, provider 오류의 저장
+
+## 4. 완료 기준
+
+1. 예상하지 못한 기존 stage 행이 있으면 migration이 backfill하지 않고 실패한다.
+2. GET은 DB를 변경하지 않는 content-free preview만 반환한다.
+3. POST는 서버가 다시 계산한 세 digest, environment/deployment/commit과 고정
+   비용·capacity·TTL을 모두 결속한 `previewBindingDigest`, 고정 확인문이 일치할 때만 진행한다.
+4. 동시 동일 요청은 stage/audit을 각각 한 행만 만들고, exact replay만 성공한다.
+5. 다른 actor·deployment·source·manifest의 재요청은 409다.
+6. stage와 audit은 함께 commit하거나 함께 rollback한다.
+7. DB trigger는 audit의 공개 shape만 검증하며 HMAC 진위를 주장하지 않는다. writer의
+   create/replay와 reserve/consume은 같은 helper로 stage-linked audit 행의 HMAC·signed
+   metadata 결속과 non-null `previousHash`의 실제 선행 행 존재를 재검증하고, raw forged
+   audit+stage는 `stage_authorization_invalid`로 거부한다. global chain scan/table SHARE
+   lock은 하지 않는다.
+8. SQL 우회로 provenance 수정·삭제, 만료 후 reserve·consume을 할 수 없다.
+9. 모든 기존 Prompt Refiner, injection, PLANNER-03 회귀가 유지된다.
+10. 독립 Claude round 0 package digest는
+    `sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc`이고
+    판정은 `request_changes`다. 지적 수정과 검증 뒤 round 1 제출 대기이며, 이
+    기록은 독립 검토 통과나 구현 완료를 뜻하지 않는다.
+11. closure 검사는 현재 정상 source의 명시적 safe form만 허용한다. 열거된 Reflect/process/
+    module/globalThis/eval/Function loader 형태와 constructor/prototype chain은 fail-closed하며,
+    임의 JavaScript reflection 전체를 증명한다고 주장하지 않는다. 새 capability는 계약과
+    negative fixture를 함께 확장하기 전에는 거부한다.
+
+## 5. 운영 승인과 비용 경계
+
+이 writer가 기록하는 것은 “정확한 staging 배포가 고정된 최악 비용 한도 안에서 shadow
+reservation stage를 60분간 보유해도 된다”는 승인뿐이다. 실제 유료 shadow를 실행하려면
+별도 실행 harness 연결, 별도 비용 승인, 독립 검토가 필요하다. 이 행이 존재해도 현재
+제품과 provider에 도달하는 새 호출 경로는 없다.
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index a5171468..07502490 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -1168,3 +1168,46 @@ events와 최종 `exchange.json`의 감사 기록은 수정하지 않았다. 검
 3. 승인된 실제 evidence가 gate를 통과할 때만 suggestion adapter와 UI를 연결한다.
 4. 사용자 선택 증거가 쌓인 뒤 Refiner→Router 결합과 full-catalog 선택 품질 최적화를
    별도 실험으로 진행한다.
+
+## 2026-09-17 Prompt Refiner durable stage writer 회차 (round 0 request_changes, 수정 검증·round 1 대기)
+
+앞 회차의 다음 순서 ①을 구현했다. 과거 admission proposal/evidence/corpus/source
+identity와 승인 시점 staging deployment의 full commit, exact 186-file runtime import-closure source manifest,
+고정 execution manifest를 하나의 immutable stage에 결속한다. 승인 시각과 60분 expiry는
+DB clock이 소유하며, owner 전용 POST는 advisory lock 아래 tamper-evident success audit과
+stage insert를 한 transaction으로 처리한다. 동일 actor·동일 runtime의 exact replay만
+idempotent하고 다른 facts는 409다. migration은 기존 stage를 backfill/seed하지 않으며
+예상하지 못한 행이 있으면 중단한다.
+
+writer create/replay와 reserve/consume은 같은 helper로 stage-linked audit 행의 HMAC·signed
+metadata 결속, non-null `previousHash`의 실제 선행 행 존재와 현재 runtime source/execution
+manifest, expiry를 DB clock 기준으로 다시 검증한다. global audit chain scan/table SHARE lock은
+하지 않는다. DB trigger는 공개 shape만 검사하고 HMAC 진위를 주장하지 않는다. 직접 SQL 경계에도 만료 검사를 추가했다. 단 이 회차는
+provider/API/Railway 관리 API/credential/receipt/제품 caller/flag를 연결하지 않고,
+execution/product readiness 두 boolean은 계속 false다. 따라서 stage writer가 존재해도 actual
+provider admission은 열리지 않는다.
+
+### 한눈에 보는 전체 Chat 진척 (임시)
+
+| 항목 | 이번 판단 |
+| --- | --- |
+| 전체 웹 Chat | **약 67%** (주관적 범위 **57–77%**) |
+| 이 회차 증분 | **제품·공개 +0%p / 검증·운영 기반 +3%p** — 유료 실행은 열지 않고 승인 provenance와 expiry 경계를 구현했다. |
+| C19–C20 Refiner·Planner·품질 평가 | **약 51%** (직전 약 47%, durable 승인/감사/runtime 재검증 반영) |
+| 구현 | additive no-seed migration, content-free exact-byte manifest, owner-only preview/create, 원자 audit+stage, same-runtime idempotency, create/replay/reserve/consume 공용 stage-linked audit HMAC 검증과 runtime source·execution 재검증 |
+| 내부 검증 | 독립 verifier 기준 focused Prompt Refiner **96/96**, admin audit chain **19/19**, shadow-stage route·CSRF **6/6**, data/privacy **81/81**, security regression **190/190**. PostgreSQL **17.10** fresh DB에서 전체 **124 migration**, Prisma diff **0**, 관련 DB **35/35**. typecheck·대상 lint·문서·정책·encoding·data-domain·prompt-injection·DB coverage·API cache·enum 검사 **PASS** |
+| 독립 검토·통합 CI | round 0 package digest는 `sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc`, 판정은 `request_changes`다. 지적 수정과 검증 뒤 round 1 제출 대기이며 통과·완료로 간주하지 않는다. |
+| 공개 상태 | provider/API/Railway/유료 호출 0, stage seed 0, 제품 caller·flag·성공 admission 없음 |
+
+범위 밖 관찰: 별도 전체 검사에서 확인된 Brisbane chat-concurrency 기존 실패는 이 기능의
+검증 수치에 포함하지 않았으며, 이 회차의 성공 근거나 feature blocker로도 사용하지 않았다.
+
+### 이 Cycle 다음 권장 순서
+
+1. 이 source를 Claude Code Max로 읽기 전용 독립 검토하고 Linux 통합 CI를 통과시킨다.
+2. writer 계약이 승인된 뒤에도 별도 명시적 비용 승인 전에는 stage를 만들거나 paid shadow를
+   실행하지 않는다.
+3. 별도 승인된 bounded shadow를 정확히 1회 실행해 의미 보존·행동상 주입 저항·비용·지연을
+   측정한다.
+4. 실제 evidence가 gate를 통과할 때만 suggestion adapter/UI를 연결하고, 이후
+   Refiner→Router와 full-catalog 선택 품질을 별도 실험한다.
diff --git a/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md b/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md
new file mode 100644
index 00000000..b9123bc8
--- /dev/null
+++ b/docs/policy/prompt-refiner-durable-stage-writer-threat-model.md
@@ -0,0 +1,60 @@
+# Prompt Refiner durable stage writer 위협 모델
+
+## 1. 보호 자산
+
+- 승인된 과거 evidence/proposal/corpus/source snapshot의 정확한 identity
+- 승인 시점 staging 배포의 commit, deployment id와 exact source bytes
+- 고정 모델·가격·output cap·retry·timeout·slot·최악 비용 계약
+- 승인자와 tamper-evident audit chain
+- stage 및 reservation의 slot/cost accounting과 만료 시각
+- 고객 content와 provider credential이 이 저장소에 유입되지 않는 경계
+
+## 2. 신뢰 경계
+
+브라우저 request body는 불신 입력이다. 승인자, 승인 시각, 환경, deployment, 모델, 가격,
+capacity, TTL과 boolean은 request에서 받지 않는다. 서버 process environment도 사실 선언으로
+바로 신뢰하지 않고 `staging`·full commit SHA·deployment id shape를 검사한다. checked-out
+파일은 realpath containment, regular-file, size cap 뒤 raw bytes로 읽는다. 최종 시각과
+만료는 PostgreSQL `clock_timestamp() AT TIME ZONE 'UTC'`가 소유한다.
+
+과거 evidence도 체크인되었다는 이유만으로 신뢰하지 않는다. strict manifest와 raw digest,
+journal/witness replay, corpus/source identity를 기존 proposal core로 다시 검증한다.
+
+## 3. 위협과 통제
+
+| 위협 | 통제 |
+| --- | --- |
+| caller가 승인자·시간·비용·모델·capacity·reason을 위조 | strict 4 KiB body는 세 digest, 서버가 산출한 preview binding digest와 고정 confirmation만 허용; reason을 포함한 나머지는 서버 상수·session·DB clock |
+| GET preview와 POST 사이 배포/source/비용 계약 변경 | POST가 exact bytes를 다시 읽고 environment, deployment id, commit SHA, 세 digest, 비용·capacity·TTL의 canonical binding digest를 재계산; 같은 commit/source라도 deployment가 다르거나 caller binding이 다르면 transaction 전 409 |
+| production 또는 미식별 배포 승인 | `RAILWAY_ENVIRONMENT_NAME=staging`, full commit SHA, deployment id가 없으면 fail-closed |
+| 두 운영자가 동시 승인해 stage/audit 중복 | transaction advisory lock 뒤 existing row 재검사; exact same actor/runtime replay만 idempotent |
+| generic admin helper의 audit/stage 원자성 분리 | 전용 짧은 transaction 안에서 audit write와 stage insert를 함께 수행 |
+| audit만 남거나 stage만 남음 | stage FK + 같은 transaction; 어느 insert든 실패하면 전체 rollback |
+| SQL로 provenance 변경·삭제 | BEFORE trigger가 provenance와 DB-owned 시각을 immutable하게 하고 DELETE를 거부 |
+| app-role이 exact public metadata와 임의 64-hex `entryHash`로 audit+stage 직접 INSERT | DB는 구조만 검사한다. writer create/replay와 reserve/consume authority가 같은 helper로 linked audit의 signed payload HMAC, signed metadata↔stage 결속, non-null `previousHash`의 실제 선행 행 존재를 재검증하며 실패는 `stage_authorization_invalid` |
+| 거대한 audit chain으로 reserve/consume memory·lock 시간을 무한 증가 또는 unrelated audit writer를 정체 | authority는 stage-linked 행과 그 행이 가리키는 선행 hash 최대 2행만 읽고 global chain scan/table SHARE lock을 하지 않는다 |
+| migration이 출처 불명 기존 행을 추측 backfill | 컬럼 추가 전 기존 stage 한 행이라도 있으면 migration abort; seed 없음 |
+| 만료된 승인을 서비스가 재사용 | reserve/consume이 DB clock, exact runtime facts, stage expiry를 재검증 |
+| 서비스 검사 우회 직접 reservation/consume | DB trigger가 stage approval expiry와 고정 contract를 다시 검사. application reserve/consume은 audit HMAC을 별도로 재검증해 위조 stage가 provider 경계로 진행하지 못하게 한다 |
+| model registry 또는 pricing drift | transaction에서 registry SHARE lock 후 exact execution contract 재검증 |
+| symlink/path traversal 또는 거대 파일 | import-closure로 검증되는 186개 고정 path allowlist, fd open/fstat, symlink component 거부, bounded read/post-fstat, 파일당 8 MiB 및 전체 16 MiB cap |
+| 보안 의존성 source drift 누락 | admin route/reservation/shadow execution/proxy root의 local runtime import 폐쇄를 TypeScript 실제 module resolution과 workspace exports로 재계산하고 TS↔SQL ordered path equality를 강제; type-only만 제외하며 aliased require/module.require/createRequire를 추적한다. `node:module`/`module`의 named·default·namespace `createRequire`는 지원하되 runtime re-export, dynamic namespace, 반환 namespace 직접 체이닝과 다른 module namespace surface는 거부한다. 현재 폐쇄에서 필요한 `process.env`, 직접 `process.cwd()`, 고정 operational state의 정확한 초기화와 Map `get`/`set`, `lib/prisma.ts`의 정확한 `globalForPrisma.prisma` singleton 필드, 검증된 `Reflect.apply` 캡처만 safe form으로 인정한다. Node `global`의 다른 직접·별칭 사용과 constructor/`__proto__`/임의 `prototype` chain, 열거된 Reflect/module/process/globalThis/eval/Function non-literal·간접 loader, unresolved local import를 거부한다. non-static element access는 기본 거부하고 현재 실행 폐쇄의 검토된 데이터 인덱싱만 path·line·column·정확한 source text의 정렬된 SHA-256 snapshot으로 동결한다. 접근의 추가·이동·표현 변경은 snapshot 불일치로 fail-closed하며, 갱신 전 loader/capability escape 여부를 별도 검토하고 negative fixture를 보강한다. 이 snapshot은 검토된 예외의 완전한 구조 목록이지 임의 JavaScript reflection 의미론의 증명이 아니다. snapshot 안의 `value[key]`를 유지한 채 다른 위치의 `key` binding 의미만 바꾸는 residual은 승인된 exact source-file bytes, full commit SHA와 deployment ID의 결속 및 독립 source review로 통제한다. |
+| prompt/credential/provider error가 provenance에 유입 | manifest schema는 path/size/hash와 고정 실행 숫자만 허용; audit reason은 request가 아니라 서버 내부 상수 |
+| 승인 endpoint 탐색·CSRF·탈취 session | 비관리자 404, owner-only, recent authentication, global origin guard, DB atomic rate limit |
+| stage 행 존재가 provider 실행으로 오인 | execution manifest 및 response에서 두 readiness boolean이 false; 새 adapter/caller 없음 |
+
+## 4. 잔여 위험
+
+- DB trigger 자체는 HMAC secret을 알지 못하므로 hash shape만 검사한다. cryptographic
+  authorization owner는 application writer create/replay와 reserve/consume의 공용 helper다.
+- DB superuser는 trigger를 비활성화하거나 application secret을 탈취할 수 있다. DB integration은
+  trigger 비활성화를 오직 expiry fixture를 만드는 데 쓰며, production 운영 권한 분리는 별도
+  인프라 통제다.
+- exact checkout bytes는 build artifact와 application source의 동일성을 보여 주지만,
+  설치된 `node_modules`, package registry 응답, container image attestation까지 증명하지 않는다.
+- Railway 환경 변수는 플랫폼 control plane의 진실성에 의존한다. 이 회차는 Railway API를
+  호출하거나 deployment attestation을 별도로 검증하지 않는다.
+- 승인 행의 보존 기간은 보안·법무 확정 전 `TBD-security-retention-schedule`이다. 권한 TTL
+  60분과 감사 증거 retention은 서로 다른 개념이다.
+- 이 writer는 actual dispatch를 열지 않으므로 provider 실패, 품질, 의미 보존과 행동상
+  injection resistance에 대한 새 증거를 만들지 않는다.
diff --git a/docs/policy/prompt-refiner-observability.md b/docs/policy/prompt-refiner-observability.md
index da7a6399..f776d339 100644
--- a/docs/policy/prompt-refiner-observability.md
+++ b/docs/policy/prompt-refiner-observability.md
@@ -293,3 +293,48 @@ mutation, seed, runtime receipt 또는 제품 호출 효과도 없다. 따라서
 새 durable row에 함께 결속하는 migration과 운영 계약이 독립 검토된 뒤에만
 추가한다. 그 writer 전까지 현재 v1 admission의 fail-closed 결과와 default-off 제품 상태를
 유지한다.
+
+## 11. durable staging approval provenance
+
+후속 `prompt-refiner-stage-admission-v1`은 과거 proposal을 현재 staging 배포에 다시
+결속하는 create-only 관리자 writer다. 과거 evidence는 매 preview/승인에서 strict core로
+다시 replay하고, 현재 runtime은 full commit SHA, Railway deployment id와 고정 186개 source
+파일의 exact bytes(개별/총 size와 SHA-256)를 canonical manifest로 만든다. 177개 source는
+admin/admission/reservation/shadow execution/proxy root의 local runtime import 폐쇄이며 9개는
+root/workspace resolution metadata를 포함한 고정 형식 파일이다. 파일당 8 MiB와 전체 16 MiB를
+넘으면 거부한다. 별도 execution manifest는
+고정 모델·가격·output cap·retry·timeout·최악 비용·100 slot 계약을 담되
+`executionAdmitted=false`, `productAdapterReady=false`를 유지한다.
+
+승인 시각과 정확히 60분인 expiry는 PostgreSQL clock이 소유한다. stage insert와
+tamper-evident success audit은 advisory lock 아래 같은 transaction에서 commit하며, exact
+same actor/runtime replay만 audit 추가 없이 idempotent하다. 다른 immutable facts 또는 만료된
+행의 replay는 409다. migration은 기존 stage를 추측 backfill하거나 seed하지 않고 예상하지
+못한 행이 하나라도 있으면 실패한다. DB trigger가 provenance 수정·삭제 및 만료 후 새
+reservation/consume을 거부하되 HMAC secret은 소유하지 않으므로 hash shape만 검사한다.
+application writer create/replay와 reserve/consume이 같은 검증 helper로 stage-linked audit
+행의 signed payload HMAC을 현재·과거 integrity key와 현재·legacy canonical 형식으로
+검증하고, signed metadata를 stage에 다시 결속한 뒤 current source/execution manifest를
+다시 읽어 저장 행과 비교한다. HMAC에 포함된 `previousHash`가 null이 아니면 그 exact hash의
+선행 audit 행도 존재해야 한다. 위조 audit/stage는 `stage_authorization_invalid`다. global
+audit chain scan이나 table SHARE lock은 하지 않으므로 unrelated audit write가 모든
+reserve/consume과 경합하지 않는다.
+
+`requestId`가 이미 active reservation을 가리키더라도 replay 전에 같은 stage expiry,
+runtime source/deployment/execution 및 model/pricing 검증을 다시 수행한다. idempotency는 현재
+권한 안에서 같은 reservation을 재사용한다는 뜻이며, 만료되거나 drift한 권한을 우회하지 않는다.
+
+manifest와 API는 content-free다. prompt/refined prompt/output, 사용자·대화·session id,
+credential, provider error/body는 저장하지 않는다. `approvedBy`는 운영자 식별자라 data-domain
+registry의 actor row로 retain되며 manual PrivacyRequest 경로를 따른다. customer data export에는
+포함되지 않는다. 권한 TTL 60분은 감사 evidence retention 기간을 뜻하지 않는다.
+
+GET preview는 no-write이고 POST body는 세 digest, preview binding digest와 고정
+confirmation만 받는다. reason은 caller 입력이 아니라 서버 고정 상수다.
+owner-only, recent auth, 전역 CSRF, 4 KiB strict JSON, DB rate limit을 적용한다. 이 endpoint와
+stage 행은 provider/network/credential/receipt/reservation/product/flag를 실행하지 않으며,
+실제 paid shadow는 별도 독립 검토와 비용 승인 없이는 열리지 않는다. 세부 계약은
+[`prompt-refiner-durable-stage-writer-contract.md`](../ops/prompt-refiner-durable-stage-writer-contract.md),
+위협 모델은
+[`prompt-refiner-durable-stage-writer-threat-model.md`](prompt-refiner-durable-stage-writer-threat-model.md)에
+있다.
diff --git a/docs/policy/tomverse-chat-data-domain-registry.yaml b/docs/policy/tomverse-chat-data-domain-registry.yaml
index cf9c7a16..06d2d208 100644
--- a/docs/policy/tomverse-chat-data-domain-registry.yaml
+++ b/docs/policy/tomverse-chat-data-domain-registry.yaml
@@ -1037,6 +1037,39 @@ domains:
       operator and can name third parties, so it is routed to the manual
       PrivacyRequest path rather than the unified export.
 
+  - domain: promptRefinerReservationStage
+    prismaModel: PromptRefinerReservationStage
+    userLinkageRole: actor
+    owner: backend-ai
+    deletionAction: retain
+    retentionPolicy: statutory
+    implementationStatus: implemented
+    retention:
+      retentionPolicyRef: "TBD-security-retention-schedule"
+      legalBasis: >-
+        Immutable evidence that a named administrator approved a bounded,
+        content-free staging allocation against an exact source and deployment
+        manifest. Retention supports security investigation, spending-control
+        audit, and defence of related legal claims under GDPR Article 17(3)(b)
+        and (e), subject to legal confirmation of the final schedule.
+      retentionStartsFrom: "approvedAt"
+      retentionPeriod: "TBD-pending-security-and-legal-approval"
+      owner: security-privacy
+      legalHoldOverridesPurge: true
+      nextReviewAt: "2026-12-17"
+    subjectReference:
+      kind: none
+    inUnifiedExport: excluded
+    note: >-
+      approvedBy is the operator id and intentionally has no User foreign key:
+      account deletion must not rewrite immutable approval evidence. The row is
+      content-free and cannot describe a customer: no customer id, prompt,
+      output, credential, provider error, or response is permitted. Operator
+      requests are therefore handled through the manual PrivacyRequest path,
+      together with the linked tamper-evident AdminAuditLog entry. The stage is
+      create-only, globally bounded, and expires after exactly 60 minutes; its
+      retention decision is separate from its authority expiry.
+
   - domain: adminNote
     prismaModel: AdminNote
     userLinkageRole: actor
diff --git a/lib/accountDataExportDomains.ts b/lib/accountDataExportDomains.ts
index 5e121ac7..c788fa3b 100644
--- a/lib/accountDataExportDomains.ts
+++ b/lib/accountDataExportDomains.ts
@@ -341,6 +341,14 @@ export const EXPORT_DOMAIN_DECLARATIONS: ExportDomainDeclaration[] = [
     exclusionReason:
       "A tamper-evident record of administrator action. Each entry names the operator and carries their address, IP and the internal action metadata, and entries can name third parties. A subject access request plausibly reaches entries about the requester, but automating that would publish the operator's identity, so it is answered through the manual PrivacyRequest path instead. Retained rather than deleted: the entry recording an account's suspension or deletion is the one most worth auditing.",
   },
+  {
+    domain: "promptRefinerReservationStage",
+    publicName: "prompt_refiner_stage_approvals",
+    prismaModel: "PromptRefinerReservationStage",
+    state: "excluded",
+    exclusionReason:
+      "Content-free, immutable staging approval evidence. It contains only deployment/source digests, bounded cost and capacity, expiry, and the approving operator id; it never contains a customer id, prompt, output, credential, provider error, or model response. Operator access requests are handled through the manual PrivacyRequest path because the linked audit record is tamper-evident and retained.",
+  },
   {
     domain: "adminNote",
     publicName: "admin_notes",
diff --git a/lib/adminAudit.ts b/lib/adminAudit.ts
index 1fee6ee4..27b1bf79 100644
--- a/lib/adminAudit.ts
+++ b/lib/adminAudit.ts
@@ -81,7 +81,10 @@ async function appendAuditChainEntry(
 ): Promise<string> {
   await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`;
   const timestampRows = await client.$queryRaw<Array<{ createdAt: Date }>>`
-    SELECT clock_timestamp() AS "createdAt"
+    -- AdminAuditLog.createdAt is a naive timestamp. Always materialize the
+    -- UTC wall clock explicitly so a non-UTC database session cannot shift
+    -- the stored instant or the HMAC payload derived from it.
+    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "createdAt"
   `;
   const databaseNow = timestampRows[0]?.createdAt || new Date();
   const previous = integritySecret
diff --git a/lib/adminAuditSystemActors.ts b/lib/adminAuditSystemActors.ts
index 1ead7fea..ac0fdefc 100644
--- a/lib/adminAuditSystemActors.ts
+++ b/lib/adminAuditSystemActors.ts
@@ -41,7 +41,7 @@ export const metadataClaimsSystemActor = (metadata: unknown): boolean =>
   metadata !== null &&
   typeof metadata === "object" &&
   !Array.isArray(metadata) &&
-  Object.prototype.hasOwnProperty.call(metadata, SYSTEM_AUDIT_ACTOR_METADATA_KEY);
+  Object.hasOwn(metadata, SYSTEM_AUDIT_ACTOR_METADATA_KEY);
 
 type AuditRowActorFields = {
   actorUserId: string | null;
diff --git a/lib/promptRefinerReservationAuthority.ts b/lib/promptRefinerReservationAuthority.ts
index 12dccfb2..1f1f102f 100644
--- a/lib/promptRefinerReservationAuthority.ts
+++ b/lib/promptRefinerReservationAuthority.ts
@@ -21,6 +21,12 @@ import {
     type PromptRefinerReservationBinding,
     type PromptRefinerReservationRefusal,
 } from "@/lib/promptRefinerReservationCore";
+import {
+    loadPromptRefinerStageAdmissionFacts,
+    PromptRefinerStageAdmissionError,
+    promptRefinerStageAuthorizationIsValid,
+    promptRefinerStoredStageMatchesRuntime,
+} from "@/lib/promptRefinerStageAdmission";
 
 type ReservationFacts = PromptRefinerReservationBinding & {
     status: "reserved" | "consumed" | "released" | "expired";
@@ -41,6 +47,16 @@ const refuse = <T>(reason: PromptRefinerReservationRefusal): AuthorityResult<T>
     reason,
 });
 
+const refuseRuntimeFacts = <T>(error: unknown): AuthorityResult<T> => {
+    if (
+        error instanceof PromptRefinerStageAdmissionError &&
+        error.code === "PROMPT_REFINER_STAGE_EXECUTION_DRIFT"
+    ) {
+        return refuse("runtime_contract_mismatch");
+    }
+    return refuse("runtime_source_mismatch");
+};
+
 const dbClock = async (tx: Prisma.TransactionClient) => {
     const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
         SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
@@ -132,12 +148,34 @@ export const reservePromptRefinerExecution = async (input: {
         return refuse("invalid_binding");
     }
 
+    let runtimeFacts: Awaited<ReturnType<typeof loadPromptRefinerStageAdmissionFacts>>;
+    try {
+        runtimeFacts = await loadPromptRefinerStageAdmissionFacts();
+    } catch (error) {
+        return refuseRuntimeFacts(error);
+    }
+
     return prisma.$transaction(async (tx) => {
         // Global lock order: stage -> model registry -> reservation.
         const stage = await lockStage(tx, stageId);
         if (!stage) return refuse("stage_not_found");
+        if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
+            return refuse("stage_authorization_invalid");
+        }
         await lockModelRegistry(tx);
-
+        const now = await dbClock(tx);
+        // Idempotency never revives stale authority. A requestId replay may
+        // reuse its active reservation only while the same stage, deployment,
+        // source, execution contract, model and pricing remain authorized.
+        if (
+            promptRefinerReservationStageProblems(stage).length > 0 ||
+            !promptRefinerStoredStageMatchesRuntime(stage, runtimeFacts, now)
+        ) {
+            return refuse("stage_contract_mismatch");
+        }
+        if (!(await lockedRuntimeContractIsCurrent(tx))) {
+            return refuse("runtime_contract_mismatch");
+        }
         const existingId = await tx.$queryRaw<Array<{ id: string }>>`
             SELECT "id"
             FROM "PromptRefinerReservation"
@@ -161,7 +199,6 @@ export const reservePromptRefinerExecution = async (input: {
                     reservation: facts(existing),
                 };
             }
-            const now = await dbClock(tx);
             if (existing.expiresAt.getTime() <= now.getTime()) {
                 const expired = await tx.promptRefinerReservation.update({
                     where: { id: existing.id },
@@ -180,19 +217,11 @@ export const reservePromptRefinerExecution = async (input: {
             };
         }
 
-        if (promptRefinerReservationStageProblems(stage).length > 0) {
-            return refuse("stage_contract_mismatch");
-        }
-        if (!(await lockedRuntimeContractIsCurrent(tx))) {
-            return refuse("runtime_contract_mismatch");
-        }
-
         if (stage.reservationCount >= stage.maxReservations) {
             return refuse("stage_capacity_exhausted");
         }
         const requestCost = BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD);
 
-        const now = await dbClock(tx);
         const reservation = await tx.promptRefinerReservation.create({
             data: {
                 id: randomUUID(),
@@ -227,14 +256,37 @@ const transitionReservation = async (input: {
         return refuse("invalid_binding");
     }
 
+    let runtimeFacts: Awaited<ReturnType<typeof loadPromptRefinerStageAdmissionFacts>> | undefined;
+    if (input.transition === "consume") {
+        try {
+            runtimeFacts = await loadPromptRefinerStageAdmissionFacts();
+        } catch (error) {
+            return refuseRuntimeFacts(error);
+        }
+    }
+
     return prisma.$transaction(async (tx) => {
         const stage = await lockStage(tx, input.binding.stageId);
         if (!stage) return refuse("stage_not_found");
+        if (
+            input.transition === "consume" &&
+            !(await promptRefinerStageAuthorizationIsValid(tx, stage))
+        ) {
+            return refuse("stage_authorization_invalid");
+        }
         await lockModelRegistry(tx);
+        const now = await dbClock(tx);
         if (
             promptRefinerReservationStageProblems(stage, {
                 requireApproved: input.transition === "consume",
-            }).length > 0
+            }).length > 0 ||
+            (input.transition === "consume" &&
+                (!runtimeFacts ||
+                    !promptRefinerStoredStageMatchesRuntime(
+                        stage,
+                        runtimeFacts,
+                        now
+                    )))
         ) {
             return refuse("stage_contract_mismatch");
         }
@@ -263,7 +315,6 @@ const transitionReservation = async (input: {
         }
         if (current.status !== "reserved") return refuse("reservation_not_active");
 
-        const now = await dbClock(tx);
         if (current.expiresAt.getTime() <= now.getTime()) {
             await tx.promptRefinerReservation.update({
                 where: { id: current.id },
diff --git a/lib/promptRefinerReservationCore.ts b/lib/promptRefinerReservationCore.ts
index d9c14c6d..a357fe3b 100644
--- a/lib/promptRefinerReservationCore.ts
+++ b/lib/promptRefinerReservationCore.ts
@@ -73,8 +73,10 @@ if (computedReservationContractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DI
 export const PROMPT_REFINER_RESERVATION_REFUSALS = Object.freeze([
     "invalid_binding",
     "stage_not_found",
+    "stage_authorization_invalid",
     "stage_contract_mismatch",
     "runtime_contract_mismatch",
+    "runtime_source_mismatch",
     "request_binding_mismatch",
     "request_already_terminal",
     "reservation_not_found",
@@ -95,6 +97,8 @@ export type PromptRefinerReservationStageFacts = {
     costCeilingMicroUsd: bigint;
     reservationCount: number;
     allocatedCostMicroUsd: bigint;
+    approvedAt: Date;
+    approvalExpiresAt: Date;
 };
 
 export const promptRefinerReservationStageProblems = (
@@ -145,6 +149,12 @@ export const promptRefinerReservationStageProblems = (
     if (stage.allocatedCostMicroUsd > stage.costCeilingMicroUsd) {
         problems.push("stage_cost_exceeded");
     }
+    if (
+        stage.approvalExpiresAt.getTime() - stage.approvedAt.getTime() !==
+        60 * 60 * 1_000
+    ) {
+        problems.push("approval_window_invalid");
+    }
     return problems;
 };
 
diff --git a/lib/promptRefinerStageAdmission.ts b/lib/promptRefinerStageAdmission.ts
new file mode 100644
index 00000000..a03f481e
--- /dev/null
+++ b/lib/promptRefinerStageAdmission.ts
@@ -0,0 +1,626 @@
+import "server-only";
+
+import { constants, type BigIntStats } from "node:fs";
+import { lstat, open, realpath } from "node:fs/promises";
+import { resolve, sep } from "node:path";
+import type { Session } from "next-auth";
+import { Prisma, type ModelRegistryEntry } from "@prisma/client";
+
+import { writeAdminAuditLog } from "@/lib/adminAudit";
+import {
+  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
+  adminAuditEntryHashVariants,
+  adminAuditIntegrityKeys,
+} from "@/lib/adminAuditIntegrityCore";
+import { getModelPricingProfile } from "@/lib/modelPricing";
+import { registryRowToModel } from "@/lib/modelRegistry";
+import { prisma } from "@/lib/prisma";
+import {
+  PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+  PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+  PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+  PROMPT_REFINER_EXECUTION_MODEL_PIN,
+  promptRefinerExecutionContractProblems,
+} from "@/lib/promptRefinerExecutionContract";
+import {
+  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+  PROMPT_REFINER_RESERVATION_STAGE_ID,
+} from "@/lib/promptRefinerReservationCore";
+import {
+  PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
+  PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
+  PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
+  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
+  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
+  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
+  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
+  proposePromptRefinerShadowStage,
+} from "@/lib/promptRefinerShadowAdmissionCore";
+import {
+  PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
+  PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
+  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
+  PROMPT_REFINER_STAGE_ADMISSION_VERSION,
+  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
+  PROMPT_REFINER_STAGE_CONFIRMATION,
+  PROMPT_REFINER_STAGE_ENVIRONMENT,
+  PROMPT_REFINER_STAGE_REASON,
+  buildPromptRefinerStagePreviewBinding,
+  buildPromptRefinerRuntimeSourceManifest,
+  buildPromptRefinerStageAdmissionFacts,
+  prefixedPromptRefinerDigest,
+  promptRefinerExecutionManifest,
+  promptRefinerStageAdmissionProblems,
+  promptRefinerStagePreviewBindingDigest,
+  type PromptRefinerStageAdmissionFacts,
+} from "@/lib/promptRefinerStageAdmissionCore";
+import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
+
+const EVIDENCE_ROOT = "docs/ops/prompt-refiner-shadow/evidence";
+const CORPUS_PATH = "docs/ops/prompt-refiner-shadow/corpus-v1.json";
+const PROMPT_REFINER_STAGE_AUDIT_ACTION = "prompt_refiner.shadow_stage.activated";
+const PROMPT_REFINER_STAGE_AUDIT_TARGET = "PromptRefinerReservationStage";
+const PROMPT_REFINER_STAGE_AUDIT_SUMMARY =
+  "Approved the bounded Prompt Refiner staging shadow stage.";
+
+export class PromptRefinerStageAdmissionError extends Error {
+  constructor(
+    public readonly status: number,
+    public readonly code: string,
+    message: string
+  ) {
+    super(message);
+  }
+}
+
+const refuse = (status: number, code: string, message: string): never => {
+  throw new PromptRefinerStageAdmissionError(status, code, message);
+};
+
+const serverRuntimeIdentity = (): {
+  environment: typeof PROMPT_REFINER_STAGE_ENVIRONMENT;
+  commitSha: string;
+  deploymentId: string;
+} => {
+  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim();
+  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
+  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
+  if (environment !== PROMPT_REFINER_STAGE_ENVIRONMENT) {
+    refuse(409, "PROMPT_REFINER_STAGE_NOT_STAGING", "The stage can only be approved on staging.");
+  }
+  if (!commitSha || !deploymentId) {
+    refuse(503, "PROMPT_REFINER_STAGE_RUNTIME_IDENTITY_UNAVAILABLE", "Runtime deployment identity is unavailable.");
+  }
+  return {
+    environment: PROMPT_REFINER_STAGE_ENVIRONMENT,
+    commitSha: commitSha!,
+    deploymentId: deploymentId!,
+  };
+};
+
+type SourceReadHooks = {
+  afterInitialSnapshot?: () => void | Promise<void>;
+  beforePostSnapshot?: () => void | Promise<void>;
+};
+
+const sameFileSnapshot = (
+  left: BigIntStats,
+  right: BigIntStats
+) =>
+  left.dev === right.dev &&
+  left.ino === right.ino &&
+  left.size === right.size &&
+  left.mtimeMs === right.mtimeMs &&
+  left.ctimeMs === right.ctimeMs;
+
+const assertNoSymlinkComponents = async (rootReal: string, path: string) => {
+  let cursor = rootReal;
+  for (const part of path.split("/")) {
+    cursor = resolve(cursor, part);
+    if ((await lstat(cursor)).isSymbolicLink()) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR", "Runtime source crosses a symbolic link.");
+    }
+  }
+};
+
+/** Opens the named path once and hashes only a stable regular-file snapshot. */
+export const readExactCheckoutFile = async (
+  root: string,
+  path: string,
+  options: { maxBytes?: number; hooks?: SourceReadHooks } = {}
+): Promise<Uint8Array> => {
+  const rootReal = await realpath(root);
+  const candidate = resolve(rootReal, ...path.split("/"));
+  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${sep}`)) {
+    refuse(503, "PROMPT_REFINER_STAGE_SOURCE_BOUNDARY", "Runtime source boundary validation failed.");
+  }
+  const maxBytes = options.maxBytes ?? PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES;
+  let handle;
+  try {
+    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
+    const initial = await handle.stat({ bigint: true });
+    await assertNoSymlinkComponents(rootReal, path);
+    const namedInitial = await lstat(candidate, { bigint: true });
+    if (
+      !initial.isFile() ||
+      !namedInitial.isFile() ||
+      namedInitial.isSymbolicLink() ||
+      !sameFileSnapshot(initial, namedInitial)
+    ) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR", "Runtime source is not a stable regular file.");
+    }
+    const candidateReal = await realpath(candidate);
+    if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${sep}`)) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_BOUNDARY", "Runtime source boundary validation failed.");
+    }
+    if (initial.size <= BigInt(0) || initial.size > BigInt(maxBytes)) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_SIZE", "Runtime source size is outside the contract.");
+    }
+    await options.hooks?.afterInitialSnapshot?.();
+    const size = Number(initial.size);
+    const bytes = Buffer.allocUnsafe(size);
+    let offset = 0;
+    while (offset < size) {
+      const read = await handle.read(bytes, offset, size - offset, offset);
+      if (read.bytesRead === 0) {
+        refuse(503, "PROMPT_REFINER_STAGE_SOURCE_CHANGED", "Runtime source changed while it was read.");
+      }
+      offset += read.bytesRead;
+    }
+    const extra = Buffer.allocUnsafe(1);
+    if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_CHANGED", "Runtime source changed while it was read.");
+    }
+    await options.hooks?.beforePostSnapshot?.();
+    const post = await handle.stat({ bigint: true });
+    const namedPost = await lstat(candidate, { bigint: true });
+    if (
+      namedPost.isSymbolicLink() ||
+      !namedPost.isFile() ||
+      !sameFileSnapshot(initial, post) ||
+      !sameFileSnapshot(post, namedPost)
+    ) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_CHANGED", "Runtime source changed while it was read.");
+    }
+    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
+  } catch (error) {
+    if (error instanceof PromptRefinerStageAdmissionError) throw error;
+    refuse(503, "PROMPT_REFINER_STAGE_SOURCE_UNAVAILABLE", "Runtime source could not be read safely.");
+  } finally {
+    await handle?.close().catch(() => undefined);
+  }
+  throw new Error("prompt_refiner_stage_source_reader_unreachable");
+};
+
+const validateHistoricalEvidence = async (root: string) => {
+  const [manifestBytes, reportBytes, journalBytes, witnessBytes, corpusBytes] = await Promise.all([
+    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.manifest.json`),
+    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.report.json`),
+    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.journal.jsonl`),
+    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.journal.jsonl.witness.jsonl`),
+    readExactCheckoutFile(root, CORPUS_PATH),
+  ]);
+  const proposal = proposePromptRefinerShadowStage({
+    manifestBytes,
+    reportBytes,
+    journalBytes,
+    witnessBytes,
+    corpusBytes,
+  });
+  if (
+    proposal.executionAdmitted !== false ||
+    proposal.currentCheckoutValidated !== false ||
+    proposal.runtimeSourceRevalidationRequired !== true
+  ) {
+    refuse(503, "PROMPT_REFINER_STAGE_PROPOSAL_BOUNDARY", "Historical proposal boundary validation failed.");
+  }
+};
+
+/** Reads the fixed runtime closure without allocating past the aggregate cap. */
+export const readPromptRefinerRuntimeSourceFiles = async (
+  root: string
+): Promise<ReadonlyMap<string, Uint8Array>> => {
+  const files = new Map<string, Uint8Array>();
+  let totalSizeBytes = 0;
+  for (const path of PROMPT_REFINER_RUNTIME_SOURCE_PATHS) {
+    const remaining = PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES - totalSizeBytes;
+    if (remaining <= 0) {
+      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_SIZE", "Runtime source total size is outside the contract.");
+    }
+    const bytes = await readExactCheckoutFile(root, path, {
+      maxBytes: Math.min(PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES, remaining),
+    });
+    totalSizeBytes += bytes.byteLength;
+    files.set(path, bytes);
+  }
+  return files;
+};
+
+/** Reads only server-owned deployment identity and exact checked-in bytes. */
+export const loadPromptRefinerStageAdmissionFacts = async (): Promise<PromptRefinerStageAdmissionFacts> => {
+  const runtime = serverRuntimeIdentity();
+  const root = process.cwd();
+  await validateHistoricalEvidence(root);
+  const files = await readPromptRefinerRuntimeSourceFiles(root);
+  const source = buildPromptRefinerRuntimeSourceManifest({
+    commitSha: runtime.commitSha,
+    files,
+  });
+  const facts = buildPromptRefinerStageAdmissionFacts({
+    runtimeCommitSha: runtime.commitSha,
+    runtimeDeploymentId: runtime.deploymentId,
+    runtimeEnvironment: runtime.environment,
+    runtimeSourceManifest: source.manifest,
+    runtimeSourceIdentityDigest: source.sourceIdentityDigest,
+    runtimeSourceManifestDigest: source.manifestDigest,
+  });
+  if (promptRefinerStageAdmissionProblems(facts).length > 0) {
+    refuse(409, "PROMPT_REFINER_STAGE_RUNTIME_DRIFT", "Runtime source or execution contract drifted.");
+  }
+  if (promptRefinerExecutionContractProblems().length > 0) {
+    refuse(409, "PROMPT_REFINER_STAGE_EXECUTION_DRIFT", "Runtime execution contract drifted.");
+  }
+  return facts;
+};
+
+type StoredStage = {
+  id: string;
+  contractVersion: string;
+  contractDigest: string;
+  status: string;
+  perRequestCostMicroUsd: bigint;
+  maxReservations: number;
+  costCeilingMicroUsd: bigint;
+  reservationCount: number;
+  allocatedCostMicroUsd: bigint;
+  admissionVersion: string;
+  proposalVersion: string;
+  proposalDigest: string;
+  evidenceBundleDigest: string;
+  evidenceManifestSha256: string;
+  historicalSourceRef: string;
+  historicalSourceIdentityDigest: string;
+  corpusDigest: string;
+  runtimeCommitSha: string;
+  runtimeSourceIdentityDigest: string;
+  runtimeSourceManifest: unknown;
+  runtimeSourceManifestDigest: string;
+  runtimeEnvironment: string;
+  runtimeDeploymentId: string;
+  executionManifest: unknown;
+  executionManifestDigest: string;
+  approvedBy: string;
+  approvedAt: Date;
+  approvalExpiresAt: Date;
+  authorizationAuditLogId: string;
+};
+
+const promptRefinerStageAuditMetadata = (stage: StoredStage) => ({
+  admissionVersion: stage.admissionVersion,
+  proposalDigest: stage.proposalDigest,
+  evidenceBundleDigest: stage.evidenceBundleDigest,
+  runtimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
+  executionManifestDigest: stage.executionManifestDigest,
+  environment: stage.runtimeEnvironment,
+  deploymentId: stage.runtimeDeploymentId,
+  commitSha: stage.runtimeCommitSha,
+  perRequestCostMicroUsd: Number(stage.perRequestCostMicroUsd),
+  maxReservations: stage.maxReservations,
+  costCeilingMicroUsd: Number(stage.costCeilingMicroUsd),
+  approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
+  approvedAt: stage.approvedAt.toISOString(),
+  approvalExpiresAt: stage.approvalExpiresAt.toISOString(),
+  reason: PROMPT_REFINER_STAGE_REASON,
+});
+
+type StageAuthorizationAudit = {
+  actorUserId: string | null;
+  actorEmail: string | null;
+  action: string;
+  targetType: string;
+  targetId: string | null;
+  summary: string;
+  metadata: unknown;
+  ipAddress: string | null;
+  userAgent: string | null;
+  previousHash: string | null;
+  entryHash: string | null;
+  createdAt: Date;
+};
+
+/** Verifies the exact immutable stage binding and the linked row's own HMAC. */
+export const promptRefinerStageAuthorizationAuditEntryIsValid = (
+  stage: StoredStage,
+  linked: StageAuthorizationAudit,
+  keys: readonly string[]
+): boolean => {
+  if (
+    keys.length === 0 ||
+    !linked.entryHash ||
+    linked.actorUserId !== stage.approvedBy ||
+    linked.action !== PROMPT_REFINER_STAGE_AUDIT_ACTION ||
+    linked.targetType !== PROMPT_REFINER_STAGE_AUDIT_TARGET ||
+    linked.targetId !== stage.id ||
+    linked.summary !== PROMPT_REFINER_STAGE_AUDIT_SUMMARY ||
+    canonicalBenchmarkJson(linked.metadata ?? null) !==
+      canonicalBenchmarkJson(promptRefinerStageAuditMetadata(stage))
+  ) {
+    return false;
+  }
+
+  const hashInput = {
+    previousHash: linked.previousHash,
+    actorUserId: linked.actorUserId,
+    actorEmail: linked.actorEmail,
+    action: linked.action,
+    targetType: linked.targetType,
+    targetId: linked.targetId,
+    summary: linked.summary,
+    metadata: linked.metadata ?? null,
+    ipAddress: linked.ipAddress,
+    userAgent: linked.userAgent,
+    createdAt: linked.createdAt.toISOString(),
+  };
+  return keys.some((key) => {
+    const variants = adminAuditEntryHashVariants(hashInput, key);
+    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some(
+      (order) => variants[order] === linked.entryHash
+    );
+  });
+};
+
+/**
+ * Verifies the stage-linked authorization as a real HMAC audit attestation.
+ *
+ * The migration deliberately validates only public structure: PostgreSQL does
+ * not own the HMAC key. Therefore an app-role direct insert can create rows
+ * that are structurally exact but cannot authorize reserve or consume. This
+ * check verifies the linked row's signed payload and exact immutable stage
+ * metadata. Its `previousHash` is itself covered by that HMAC; when non-null,
+ * the referenced predecessor must also exist. It does not scan or lock the
+ * global chain, so an unrelated audit write cannot contend with every reserve.
+ */
+export const promptRefinerStageAuthorizationIsValid = async (
+  tx: Prisma.TransactionClient,
+  stage: StoredStage
+): Promise<boolean> => {
+  const keys = adminAuditIntegrityKeys(process.env);
+  if (keys.length === 0 || !stage.authorizationAuditLogId) return false;
+
+  const linked = await tx.adminAuditLog.findUnique({
+    where: { id: stage.authorizationAuditLogId },
+  });
+  if (!linked || !promptRefinerStageAuthorizationAuditEntryIsValid(stage, linked, keys)) {
+    return false;
+  }
+  if (!linked.previousHash) return true;
+  const predecessor = await tx.adminAuditLog.findUnique({
+    where: { entryHash: linked.previousHash },
+    select: { entryHash: true },
+  });
+  return predecessor?.entryHash === linked.previousHash;
+};
+
+export const promptRefinerStoredStageMatchesRuntime = (
+  stage: StoredStage,
+  facts: PromptRefinerStageAdmissionFacts,
+  now: Date,
+  options: { requireApproved?: boolean } = {}
+): boolean =>
+  stage.id === PROMPT_REFINER_RESERVATION_STAGE_ID &&
+  stage.contractVersion === PROMPT_REFINER_EXECUTION_CONTRACT_VERSION &&
+  stage.contractDigest === PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST &&
+  (options.requireApproved === false ? ["approved", "closed"].includes(stage.status) : stage.status === "approved") &&
+  stage.perRequestCostMicroUsd === BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD) &&
+  stage.maxReservations === PROMPT_REFINER_SHADOW_MAX_DISPATCHES &&
+  stage.costCeilingMicroUsd === BigInt(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD) &&
+  stage.admissionVersion === facts.admissionVersion &&
+  stage.proposalVersion === facts.proposalVersion &&
+  stage.proposalDigest === facts.proposalDigest &&
+  stage.evidenceBundleDigest === facts.evidenceBundleDigest &&
+  stage.evidenceManifestSha256 === facts.evidenceManifestSha256 &&
+  stage.historicalSourceRef === facts.historicalSourceRef &&
+  stage.historicalSourceIdentityDigest === facts.historicalSourceIdentityDigest &&
+  stage.corpusDigest === facts.corpusDigest &&
+  stage.runtimeCommitSha === facts.runtimeCommitSha &&
+  stage.runtimeSourceIdentityDigest === facts.runtimeSourceIdentityDigest &&
+  canonicalBenchmarkJson(stage.runtimeSourceManifest) === canonicalBenchmarkJson(facts.runtimeSourceManifest) &&
+  stage.runtimeSourceManifestDigest === facts.runtimeSourceManifestDigest &&
+  stage.runtimeEnvironment === facts.runtimeEnvironment &&
+  stage.runtimeDeploymentId === facts.runtimeDeploymentId &&
+  canonicalBenchmarkJson(stage.executionManifest) === canonicalBenchmarkJson(facts.executionManifest) &&
+  stage.executionManifestDigest === facts.executionManifestDigest &&
+  stage.approvalExpiresAt.getTime() - stage.approvedAt.getTime() === PROMPT_REFINER_STAGE_APPROVAL_TTL_MS &&
+  stage.approvedAt.getTime() <= now.getTime() &&
+  stage.approvalExpiresAt.getTime() > now.getTime() &&
+  stage.authorizationAuditLogId.length > 0;
+
+const lockAndValidateRegistry = async (tx: Prisma.TransactionClient) => {
+  await tx.$executeRawUnsafe('LOCK TABLE "ModelRegistryEntry" IN SHARE MODE');
+  const row = await tx.modelRegistryEntry.findUnique({
+    where: { id: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId },
+  });
+  if (!row) refuse(409, "PROMPT_REFINER_STAGE_MODEL_MISSING", "Pinned model registry row is missing.");
+  let model;
+  try {
+    model = registryRowToModel(row as ModelRegistryEntry);
+  } catch {
+    refuse(409, "PROMPT_REFINER_STAGE_MODEL_INVALID", "Pinned model registry row is invalid.");
+  }
+  const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+  if (promptRefinerExecutionContractProblems({ model, pricing }).length > 0) {
+    refuse(409, "PROMPT_REFINER_STAGE_EXECUTION_DRIFT", "Pinned model or pricing contract drifted.");
+  }
+};
+
+const dbClock = async (tx: Prisma.TransactionClient): Promise<Date> => {
+  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
+    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+  `;
+  if (!rows[0]) throw new Error("prompt_refiner_stage_db_clock_unavailable");
+  return rows[0].now;
+};
+
+export const promptRefinerStagePreview = async () => {
+  const facts = await loadPromptRefinerStageAdmissionFacts();
+  const existing = await prisma.promptRefinerReservationStage.findUnique({
+    where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+  });
+  const previewBindingDigest = promptRefinerStagePreviewBindingDigest(
+    buildPromptRefinerStagePreviewBinding(facts)
+  );
+  return {
+    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+    status: existing ? "already_exists" : "ready_for_explicit_cost_approval",
+    proposalDigest: facts.proposalDigest,
+    runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+    executionManifestDigest: facts.executionManifestDigest,
+    environment: facts.runtimeEnvironment,
+    deploymentId: facts.runtimeDeploymentId,
+    commitSha: facts.runtimeCommitSha,
+    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+    approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
+    previewBindingDigest,
+    confirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
+    executionAdmitted: false as const,
+    productAdapterReady: false as const,
+  };
+};
+
+export const createPromptRefinerReservationStage = async (input: {
+  session: Session;
+  request: Request;
+  expected: {
+    proposalDigest: string;
+    runtimeSourceManifestDigest: string;
+    executionManifestDigest: string;
+    previewBindingDigest: string;
+  };
+}) => {
+  if (!input.session.user?.id) refuse(403, "PROMPT_REFINER_STAGE_ACTOR_REQUIRED", "Administrator identity is required.");
+  if (adminAuditIntegrityKeys(process.env).length === 0) {
+    refuse(503, "PROMPT_REFINER_STAGE_AUDIT_KEY_REQUIRED", "Audit integrity signing is not configured.");
+  }
+  const facts = await loadPromptRefinerStageAdmissionFacts();
+  const currentPreviewBindingDigest = promptRefinerStagePreviewBindingDigest(
+    buildPromptRefinerStagePreviewBinding(facts)
+  );
+  if (
+    input.expected.proposalDigest !== facts.proposalDigest ||
+    input.expected.runtimeSourceManifestDigest !== facts.runtimeSourceManifestDigest ||
+    input.expected.executionManifestDigest !== facts.executionManifestDigest ||
+    input.expected.previewBindingDigest !== currentPreviewBindingDigest
+  ) {
+    refuse(409, "PROMPT_REFINER_STAGE_PREVIEW_STALE", "Approval preview no longer matches this deployment.");
+  }
+
+  return prisma.$transaction(async (tx) => {
+    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('prompt-refiner-shadow-stage-v1'))`;
+    await lockAndValidateRegistry(tx);
+    const now = await dbClock(tx);
+    const existing = await tx.promptRefinerReservationStage.findUnique({
+      where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    if (existing) {
+      if (
+        existing.approvedBy === input.session.user!.id &&
+        (await promptRefinerStageAuthorizationIsValid(tx, existing)) &&
+        promptRefinerStoredStageMatchesRuntime(existing as StoredStage, facts, now)
+      ) {
+        return { created: false, replayed: true, stage: existing };
+      }
+      refuse(409, "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH", "A different immutable stage already exists.");
+    }
+
+    const auditId = await writeAdminAuditLog({
+      session: input.session,
+      request: input.request,
+      action: PROMPT_REFINER_STAGE_AUDIT_ACTION,
+      targetType: PROMPT_REFINER_STAGE_AUDIT_TARGET,
+      targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+      summary: PROMPT_REFINER_STAGE_AUDIT_SUMMARY,
+      metadata: {
+        admissionVersion: facts.admissionVersion,
+        proposalDigest: facts.proposalDigest,
+        evidenceBundleDigest: facts.evidenceBundleDigest,
+        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+        executionManifestDigest: facts.executionManifestDigest,
+        environment: facts.runtimeEnvironment,
+        deploymentId: facts.runtimeDeploymentId,
+        commitSha: facts.runtimeCommitSha,
+        perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+        maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+        costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+        approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
+        approvedAt: now.toISOString(),
+        approvalExpiresAt: new Date(now.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS).toISOString(),
+        reason: PROMPT_REFINER_STAGE_REASON,
+      },
+      tx,
+    });
+    const stage = await tx.promptRefinerReservationStage.create({
+      data: {
+        id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+        status: "approved",
+        perRequestCostMicroUsd: BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD),
+        maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+        costCeilingMicroUsd: BigInt(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD),
+        reservationCount: 0,
+        allocatedCostMicroUsd: BigInt(0),
+        admissionVersion: facts.admissionVersion,
+        proposalVersion: facts.proposalVersion,
+        proposalDigest: facts.proposalDigest,
+        evidenceBundleDigest: facts.evidenceBundleDigest,
+        evidenceManifestSha256: facts.evidenceManifestSha256,
+        historicalSourceRef: facts.historicalSourceRef,
+        historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
+        corpusDigest: facts.corpusDigest,
+        runtimeCommitSha: facts.runtimeCommitSha,
+        runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
+        runtimeSourceManifest: facts.runtimeSourceManifest as unknown as Prisma.InputJsonValue,
+        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+        runtimeEnvironment: facts.runtimeEnvironment,
+        runtimeDeploymentId: facts.runtimeDeploymentId,
+        executionManifest: facts.executionManifest as unknown as Prisma.InputJsonValue,
+        executionManifestDigest: facts.executionManifestDigest,
+        approvedBy: input.session.user!.id,
+        approvedAt: now,
+        approvalExpiresAt: new Date(now.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS),
+        authorizationAuditLogId: auditId,
+        createdAt: now,
+      },
+    });
+    if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
+      refuse(
+        503,
+        "PROMPT_REFINER_STAGE_AUTHORIZATION_INVALID",
+        "The durable stage authorization could not be verified."
+      );
+    }
+    return { created: true, replayed: false, stage };
+  });
+};
+
+export const promptRefinerStageAdmissionErrorResponse = (error: unknown) => {
+  if (!(error instanceof PromptRefinerStageAdmissionError)) return null;
+  return Response.json({ error: error.message, code: error.code }, { status: error.status });
+};
+
+export const PROMPT_REFINER_STAGE_FIXED_BINDINGS = Object.freeze({
+  admissionVersion: PROMPT_REFINER_STAGE_ADMISSION_VERSION,
+  proposalVersion: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
+  proposalDigest: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
+  evidenceBundleDigest: PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
+  evidenceManifestSha256: PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
+  historicalSourceRef: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
+  historicalSourceIdentityDigest: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
+  corpusDigest: PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
+  executionManifestDigest: prefixedPromptRefinerDigest(
+    promptRefinerExecutionManifest()
+  ),
+});
diff --git a/lib/promptRefinerStageAdmissionCore.ts b/lib/promptRefinerStageAdmissionCore.ts
new file mode 100644
index 00000000..39861bc2
--- /dev/null
+++ b/lib/promptRefinerStageAdmissionCore.ts
@@ -0,0 +1,552 @@
+import { createHash } from "node:crypto";
+
+import {
+  PROMPT_REFINER_EXECUTION_CONTRACT,
+  PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+  PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+  PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+} from "@/lib/promptRefinerExecutionContract";
+import {
+  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+  PROMPT_REFINER_RESERVATION_STAGE_ID,
+} from "@/lib/promptRefinerReservationCore";
+import {
+  PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
+  PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
+  PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
+  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
+  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
+  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
+  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
+} from "@/lib/promptRefinerShadowAdmissionCore";
+import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
+
+/**
+ * Content-free durable approval contract. This module performs no I/O and
+ * cannot create a stage, reserve a slot, call a provider, or enable a flag.
+ */
+export const PROMPT_REFINER_STAGE_ADMISSION_VERSION =
+  "prompt-refiner-stage-admission-v1" as const;
+export const PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION =
+  "prompt-refiner-runtime-source-manifest-v2" as const;
+export const PROMPT_REFINER_EXECUTION_MANIFEST_VERSION =
+  "prompt-refiner-shadow-execution-manifest-v1" as const;
+export const PROMPT_REFINER_STAGE_APPROVAL_TTL_MS = 60 * 60 * 1_000;
+export const PROMPT_REFINER_STAGE_ENVIRONMENT = "staging" as const;
+export const PROMPT_REFINER_STAGE_CONFIRMATION =
+  "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES" as const;
+export const PROMPT_REFINER_STAGE_REASON =
+  "bounded_staging_shadow_cost_approval" as const;
+export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT = 186 as const;
+export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES = 8 * 1024 * 1024;
+export const PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
+
+// These are the executable entrypoints whose complete local runtime import
+// closure is bound into every durable stage. Keep the closure test in sync: a
+// newly introduced local runtime import must fail closed until both this list
+// and the database constraint are reviewed together.
+export const PROMPT_REFINER_RUNTIME_IMPORT_ROOTS = Object.freeze([
+  "app/api/admin/prompt-refiner/shadow-stage/route.ts",
+  "lib/promptRefinerReservationAuthority.ts",
+  "lib/promptRefinerShadowHarness.ts",
+  "lib/promptRefinerShadowJournal.ts",
+  "lib/promptRefinerShadowSource.ts",
+  "lib/providerUsageCost.ts",
+  "lib/promptRefinerSuggestion.ts",
+  "proxy.ts",
+] as const);
+
+export const PROMPT_REFINER_RUNTIME_SOURCE_PATHS = Object.freeze([
+  ".gitattributes",
+  "package.json",
+  "package-lock.json",
+  "tsconfig.json",
+  "prisma/schema.prisma",
+  "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+  "apps/mobile/package.json",
+  "packages/chat-core/package.json",
+  "packages/ui-tokens/package.json",
+  "app/api/admin/prompt-refiner/shadow-stage/route.ts",
+  "lib/accountEmails.ts",
+  "lib/activeAiModel.ts",
+  "lib/adminAudit.ts",
+  "lib/adminAuditIntegrityCore.ts",
+  "lib/adminAuditSystemActors.ts",
+  "lib/adminAuth.ts",
+  "lib/adminAuthCore.ts",
+  "lib/adminReauthentication.ts",
+  "lib/adminReauthenticationCore.ts",
+  "lib/anthropicPromptCaching.ts",
+  "lib/apiCacheControlPolicy.ts",
+  "lib/apiSecurity.ts",
+  "lib/appDefaults.ts",
+  "lib/appSettings.ts",
+  "lib/assistantKnowledgeGuide.ts",
+  "lib/assistantPackageImportAccess.ts",
+  "lib/assistantProfileAccess.ts",
+  "lib/auth.ts",
+  "lib/billingEmails.ts",
+  "lib/billingPlanDefaults.ts",
+  "lib/chatAdmissionCore.ts",
+  "lib/chatAttemptCostLedger.ts",
+  "lib/chatConcurrencyCore.ts",
+  "lib/chatCostGuardrails.ts",
+  "lib/chatCostSafetyCore.ts",
+  "lib/chatCreditAllocation.ts",
+  "lib/chatInputLimits.ts",
+  "lib/chatLimitDecisionCore.ts",
+  "lib/chatLimitDecisions.ts",
+  "lib/chatMultiAttemptSettlement.ts",
+  "lib/chatProviderHolds.ts",
+  "lib/chatRateLimitCore.ts",
+  "lib/chatRequestLease.ts",
+  "lib/chatSecurity.ts",
+  "lib/chatStarterAccess.ts",
+  "lib/chatTokenEstimate.ts",
+  "lib/chatTokenQuotaCore.ts",
+  "lib/chatUsageBucketCount.ts",
+  "lib/chatUsageKey.ts",
+  "lib/clientIp.ts",
+  "lib/credentialEmailLane.ts",
+  "lib/creditDebt.ts",
+  "lib/creditLedger.ts",
+  "lib/csp.ts",
+  "lib/databaseError.ts",
+  "lib/deepResearchSettlementHandoff.ts",
+  "lib/deepseekUsageAdapter.ts",
+  "lib/deepseekUsageAdapterCore.ts",
+  "lib/documentLanguage.ts",
+  "lib/e2eTestMode.ts",
+  "lib/email.ts",
+  "lib/emailAuditHash.ts",
+  "lib/emailConsentToken.ts",
+  "lib/emailFeatureFlags.ts",
+  "lib/emailJurisdictionCore.ts",
+  "lib/emailLogin.ts",
+  "lib/emailLoginEmails.ts",
+  "lib/emailPreferenceCore.ts",
+  "lib/emailPreferences.ts",
+  "lib/emailProviderPort.ts",
+  "lib/emailProviderPortCore.ts",
+  "lib/emailSendLock.ts",
+  "lib/emailSendLockCore.ts",
+  "lib/emailSendRetryCore.ts",
+  "lib/emailSendingIdentity.ts",
+  "lib/emailSendingIdentityCore.ts",
+  "lib/emailSentIdentityCore.ts",
+  "lib/emailSuppression.ts",
+  "lib/emailSuppressionAuthority.ts",
+  "lib/emailSuppressionAuthorityCore.ts",
+  "lib/emailSuppressionCauses.ts",
+  "lib/emailSuppressionCore.ts",
+  "lib/emailTemplateDefinitions.ts",
+  "lib/emailTemplateMetadataCore.ts",
+  "lib/emailTemplateRegistry.ts",
+  "lib/emailTypography.ts",
+  "lib/externalContinuationAccess.ts",
+  "lib/externalImportAccess.ts",
+  "lib/foundingTesterPassCore.ts",
+  "lib/imageGenerationAccess.ts",
+  "lib/language.ts",
+  "lib/managedSlack.ts",
+  "lib/marketingConsentConfirmationEmail.ts",
+  "lib/marketingEmailLayout.ts",
+  "lib/marketingRoutes.ts",
+  "lib/memoryAccess.ts",
+  "lib/mobileAccessToken.ts",
+  "lib/mobileAccessTokenCore.ts",
+  "lib/mobileAuthContract.ts",
+  "lib/mobileAuthKeyring.ts",
+  "lib/mobileAuthService.ts",
+  "lib/mobileDeploymentBinding.ts",
+  "lib/mobileRefreshRotationCore.ts",
+  "lib/mobileRefreshToken.ts",
+  "lib/mobileRevocationFreshnessCore.ts",
+  "lib/mobileSessionAuthorization.ts",
+  "lib/mobileSessionSnapshotCache.ts",
+  "lib/modelGenerationCompatibility.ts",
+  "lib/modelLaunchEmail.ts",
+  "lib/modelLifecycleDailyEmail.ts",
+  "lib/modelLifecycleDailyReportCore.ts",
+  "lib/modelPricing.ts",
+  "lib/modelRegistry.ts",
+  "lib/modelRegistryShared.ts",
+  "lib/models.ts",
+  "lib/nativeAppCors.ts",
+  "lib/nativeBearerGate.ts",
+  "lib/oauthTokenCrypto.ts",
+  "lib/operationalMonitoring.ts",
+  "lib/operationalMonitoringCore.ts",
+  "lib/operatorAlertProbeCore.ts",
+  "lib/originProtection.ts",
+  "lib/perplexityResponseCore.ts",
+  "lib/perplexityResponseEvents.ts",
+  "lib/perplexitySearchMetadataCore.ts",
+  "lib/perplexityUsageCapture.ts",
+  "lib/perplexityUsageCore.ts",
+  "lib/postgresConnectionConfigCore.mjs",
+  "lib/prisma.ts",
+  "lib/productAnnouncementEmail.ts",
+  "lib/promptInjectionAudit.ts",
+  "lib/promptRefinerAccess.ts",
+  "lib/promptRefinerExecutionContract.ts",
+  "lib/promptRefinerModelPrompt.ts",
+  "lib/promptRefinerReservationAuthority.ts",
+  "lib/promptRefinerReservationCore.ts",
+  "lib/promptRefinerShadowAdmissionCore.ts",
+  "lib/promptRefinerShadowHarness.ts",
+  "lib/promptRefinerShadowJournal.ts",
+  "lib/promptRefinerShadowSource.ts",
+  "lib/promptRefinerStageAdmission.ts",
+  "lib/promptRefinerStageAdmissionCore.ts",
+  "lib/promptRefinerSuggestion.ts",
+  "lib/providerBalanceCore.ts",
+  "lib/providerBilling.ts",
+  "lib/providerCostBudget.ts",
+  "lib/providerCreditAlertsCore.ts",
+  "lib/providerCredits.ts",
+  "lib/providerErrorClassification.ts",
+  "lib/providerFallbackCandidates.ts",
+  "lib/providerHealthPolicyCore.ts",
+  "lib/providerMonitoring.ts",
+  "lib/providerProbe.ts",
+  "lib/providerPublicStatusCore.ts",
+  "lib/providerUsageAccounting.ts",
+  "lib/providerUsageCost.ts",
+  "lib/providerVerification.ts",
+  "lib/publicSnapshotCache.ts",
+  "lib/publicUrl.ts",
+  "lib/requestOrigin.ts",
+  "lib/routerDevelopmentBenchmark.ts",
+  "lib/routingAttemptStore.ts",
+  "lib/searchProviderBudget.ts",
+  "lib/securityAudit.ts",
+  "lib/sessionRevocationCore.ts",
+  "lib/sessionSecurity.ts",
+  "lib/slackMessageTemplateCore.ts",
+  "lib/staticMarketingCsp.ts",
+  "lib/svixSignature.ts",
+  "lib/theme.ts",
+  "lib/tokenEstimateShadow.ts",
+  "lib/tokenEstimateShadowRecorder.ts",
+  "lib/turnstile.ts",
+  "lib/userDailyUsage.ts",
+  "lib/userOperationalSecurity.ts",
+  "lib/userTimeZone.ts",
+  "lib/voiceInputAccess.ts",
+  "lib/webSearchBackendPricing.ts",
+  "lib/webSearchBackendRuntime.ts",
+  "lib/webSearchBackends.ts",
+  "lib/webSearchCapability.ts",
+  "lib/webSearchCeilingBreachStore.ts",
+  "lib/webSearchCitations.ts",
+  "lib/webSearchCredits.ts",
+  "lib/webSearchNativeCostReservation.ts",
+  "proxy.ts",
+] as const);
+
+export type PromptRefinerRuntimeSourceFile = Readonly<{
+  path: (typeof PROMPT_REFINER_RUNTIME_SOURCE_PATHS)[number];
+  sizeBytes: number;
+  sha256: string;
+}>;
+
+export type PromptRefinerRuntimeSourceManifest = Readonly<{
+  schemaVersion: typeof PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION;
+  commitSha: string;
+  totalSizeBytes: number;
+  files: readonly PromptRefinerRuntimeSourceFile[];
+}>;
+
+export type PromptRefinerExecutionManifest = Readonly<{
+  schemaVersion: typeof PROMPT_REFINER_EXECUTION_MANIFEST_VERSION;
+  stageId: typeof PROMPT_REFINER_RESERVATION_STAGE_ID;
+  reservationContractDigest: typeof PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST;
+  runtimeSource: Readonly<{
+    fileCount: typeof PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT;
+    maxFileBytes: typeof PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES;
+    maxTotalBytes: typeof PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES;
+  }>;
+  executionContractVersion: typeof PROMPT_REFINER_EXECUTION_CONTRACT_VERSION;
+  executionContract: typeof PROMPT_REFINER_EXECUTION_CONTRACT;
+  perRequestCostMicroUsd: typeof PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD;
+  maxReservations: typeof PROMPT_REFINER_SHADOW_MAX_DISPATCHES;
+  costCeilingMicroUsd: typeof PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD;
+  executionAdmitted: false;
+  productAdapterReady: false;
+}>;
+
+export type PromptRefinerStageAdmissionFacts = Readonly<{
+  admissionVersion: typeof PROMPT_REFINER_STAGE_ADMISSION_VERSION;
+  proposalVersion: typeof PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION;
+  proposalDigest: typeof PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST;
+  evidenceBundleDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST;
+  evidenceManifestSha256: typeof PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256;
+  historicalSourceRef: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF;
+  historicalSourceIdentityDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST;
+  corpusDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST;
+  runtimeCommitSha: string;
+  runtimeSourceIdentityDigest: string;
+  runtimeSourceManifest: PromptRefinerRuntimeSourceManifest;
+  runtimeSourceManifestDigest: string;
+  runtimeEnvironment: typeof PROMPT_REFINER_STAGE_ENVIRONMENT;
+  runtimeDeploymentId: string;
+  executionManifest: PromptRefinerExecutionManifest;
+  executionManifestDigest: string;
+}>;
+
+export type PromptRefinerStagePreviewBinding = Readonly<{
+  environment: typeof PROMPT_REFINER_STAGE_ENVIRONMENT;
+  deploymentId: string;
+  commitSha: string;
+  proposalDigest: string;
+  runtimeSourceManifestDigest: string;
+  executionManifestDigest: string;
+  perRequestCostMicroUsd: number;
+  maxReservations: number;
+  costCeilingMicroUsd: number;
+  approvalTtlMinutes: number;
+}>;
+
+const sha256 = (bytes: string | Uint8Array): string =>
+  createHash("sha256").update(bytes).digest("hex");
+
+export const prefixedPromptRefinerDigest = (value: unknown): string =>
+  `sha256:${sha256(canonicalBenchmarkJson(value))}`;
+
+/**
+ * Binds an operator preview to the exact deployment and every server-owned
+ * cost, capacity, and expiry fact that the subsequent write will use.
+ */
+export const promptRefinerStagePreviewBindingDigest = (
+  binding: PromptRefinerStagePreviewBinding
+): string => prefixedPromptRefinerDigest(binding);
+
+export const buildPromptRefinerStagePreviewBinding = (
+  facts: Pick<
+    PromptRefinerStageAdmissionFacts,
+    | "runtimeEnvironment"
+    | "runtimeDeploymentId"
+    | "runtimeCommitSha"
+    | "proposalDigest"
+    | "runtimeSourceManifestDigest"
+    | "executionManifestDigest"
+  >
+): PromptRefinerStagePreviewBinding =>
+  Object.freeze({
+    environment: facts.runtimeEnvironment,
+    deploymentId: facts.runtimeDeploymentId,
+    commitSha: facts.runtimeCommitSha,
+    proposalDigest: facts.proposalDigest,
+    runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+    executionManifestDigest: facts.executionManifestDigest,
+    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+    approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
+  });
+
+const FULL_SHA = /^[a-f0-9]{40}$/;
+const DIGEST = /^sha256:[a-f0-9]{64}$/;
+const HEX_DIGEST = /^[a-f0-9]{64}$/;
+const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
+
+const runtimeSourceManifestProblems = (
+  manifest: PromptRefinerRuntimeSourceManifest
+): string[] => {
+  const problems: string[] = [];
+  const expected = [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS];
+  if (
+    manifest.schemaVersion !== PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION ||
+    manifest.files.length !== expected.length ||
+    manifest.files.some((entry, index) => entry.path !== expected[index])
+  ) {
+    problems.push("runtime_source_paths");
+  }
+  const totalSizeBytes = manifest.files.reduce((sum, entry) => {
+    if (
+      !Number.isSafeInteger(entry.sizeBytes) ||
+      entry.sizeBytes <= 0 ||
+      entry.sizeBytes > PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES ||
+      !/^[a-f0-9]{64}$/.test(entry.sha256)
+    ) {
+      problems.push("runtime_source_file");
+    }
+    return sum + entry.sizeBytes;
+  }, 0);
+  if (
+    !Number.isSafeInteger(manifest.totalSizeBytes) ||
+    manifest.totalSizeBytes !== totalSizeBytes ||
+    totalSizeBytes <= 0 ||
+    totalSizeBytes > PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES
+  ) {
+    problems.push("runtime_source_total_size");
+  }
+  return [...new Set(problems)];
+};
+
+export const buildPromptRefinerRuntimeSourceManifest = (input: {
+  commitSha: string;
+  files: ReadonlyMap<string, Uint8Array>;
+}): {
+  manifest: PromptRefinerRuntimeSourceManifest;
+  sourceIdentityDigest: string;
+  manifestDigest: string;
+} => {
+  if (!FULL_SHA.test(input.commitSha)) {
+    throw new Error("prompt_refiner_stage_runtime_commit_invalid");
+  }
+  const expected = [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS];
+  if (
+    input.files.size !== expected.length ||
+    expected.some((path) => !input.files.has(path)) ||
+    [...input.files.keys()].some((path) => !expected.includes(path as never))
+  ) {
+    throw new Error("prompt_refiner_stage_runtime_source_path_allowlist");
+  }
+  let totalSizeBytes = 0;
+  const files = expected.map((path) => {
+    const bytes = input.files.get(path);
+    if (
+      !(bytes instanceof Uint8Array) ||
+      bytes.byteLength === 0 ||
+      bytes.byteLength > PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES
+    ) {
+      throw new Error("prompt_refiner_stage_runtime_source_file_invalid");
+    }
+    totalSizeBytes += bytes.byteLength;
+    if (totalSizeBytes > PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES) {
+      throw new Error("prompt_refiner_stage_runtime_source_total_size");
+    }
+    return Object.freeze({ path, sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
+  });
+  const manifest = Object.freeze({
+    schemaVersion: PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION,
+    commitSha: input.commitSha,
+    totalSizeBytes,
+    files: Object.freeze(files),
+  });
+  const sourceIdentityDigest = prefixedPromptRefinerDigest({ files });
+  return Object.freeze({
+    manifest,
+    sourceIdentityDigest,
+    manifestDigest: prefixedPromptRefinerDigest(manifest),
+  });
+};
+
+export const promptRefinerExecutionManifest = (): PromptRefinerExecutionManifest =>
+  Object.freeze({
+    schemaVersion: PROMPT_REFINER_EXECUTION_MANIFEST_VERSION,
+    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+    reservationContractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    runtimeSource: Object.freeze({
+      fileCount: PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
+      maxFileBytes: PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
+      maxTotalBytes: PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
+    }),
+    executionContractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    executionContract: PROMPT_REFINER_EXECUTION_CONTRACT,
+    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+    executionAdmitted: false,
+    productAdapterReady: false,
+  });
+
+export const buildPromptRefinerStageAdmissionFacts = (input: {
+  runtimeCommitSha: string;
+  runtimeDeploymentId: string;
+  runtimeEnvironment: string;
+  runtimeSourceManifest: PromptRefinerRuntimeSourceManifest;
+  runtimeSourceIdentityDigest: string;
+  runtimeSourceManifestDigest: string;
+}): PromptRefinerStageAdmissionFacts => {
+  if (input.runtimeEnvironment !== PROMPT_REFINER_STAGE_ENVIRONMENT) {
+    throw new Error("prompt_refiner_stage_environment_not_staging");
+  }
+  if (!FULL_SHA.test(input.runtimeCommitSha) || input.runtimeSourceManifest.commitSha !== input.runtimeCommitSha) {
+    throw new Error("prompt_refiner_stage_runtime_commit_invalid");
+  }
+  if (!DEPLOYMENT_ID.test(input.runtimeDeploymentId)) {
+    throw new Error("prompt_refiner_stage_deployment_id_invalid");
+  }
+  if (runtimeSourceManifestProblems(input.runtimeSourceManifest).length > 0) {
+    throw new Error("prompt_refiner_stage_runtime_manifest_invalid");
+  }
+  if (!DIGEST.test(input.runtimeSourceIdentityDigest) || !DIGEST.test(input.runtimeSourceManifestDigest)) {
+    throw new Error("prompt_refiner_stage_runtime_digest_invalid");
+  }
+  if (prefixedPromptRefinerDigest(input.runtimeSourceManifest) !== input.runtimeSourceManifestDigest) {
+    throw new Error("prompt_refiner_stage_runtime_manifest_digest_mismatch");
+  }
+  if (prefixedPromptRefinerDigest({ files: input.runtimeSourceManifest.files }) !== input.runtimeSourceIdentityDigest) {
+    throw new Error("prompt_refiner_stage_runtime_source_identity_mismatch");
+  }
+  const executionManifest = promptRefinerExecutionManifest();
+  return Object.freeze({
+    admissionVersion: PROMPT_REFINER_STAGE_ADMISSION_VERSION,
+    proposalVersion: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
+    proposalDigest: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
+    evidenceBundleDigest: PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
+    evidenceManifestSha256: PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
+    historicalSourceRef: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
+    historicalSourceIdentityDigest: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
+    corpusDigest: PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
+    runtimeCommitSha: input.runtimeCommitSha,
+    runtimeSourceIdentityDigest: input.runtimeSourceIdentityDigest,
+    runtimeSourceManifest: input.runtimeSourceManifest,
+    runtimeSourceManifestDigest: input.runtimeSourceManifestDigest,
+    runtimeEnvironment: PROMPT_REFINER_STAGE_ENVIRONMENT,
+    runtimeDeploymentId: input.runtimeDeploymentId,
+    executionManifest,
+    executionManifestDigest: prefixedPromptRefinerDigest(executionManifest),
+  });
+};
+
+export const promptRefinerStageAdmissionProblems = (
+  value: PromptRefinerStageAdmissionFacts
+): string[] => {
+  const problems: string[] = [];
+  if (value.admissionVersion !== PROMPT_REFINER_STAGE_ADMISSION_VERSION) problems.push("admission_version");
+  if (value.proposalVersion !== PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION) problems.push("proposal_version");
+  if (value.proposalDigest !== PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST) problems.push("proposal_digest");
+  if (value.evidenceBundleDigest !== PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST) problems.push("evidence_bundle_digest");
+  if (value.evidenceManifestSha256 !== PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256) problems.push("evidence_manifest_sha256");
+  if (value.historicalSourceRef !== PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF) problems.push("historical_source_ref");
+  if (value.historicalSourceIdentityDigest !== PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST) problems.push("historical_source_identity_digest");
+  if (value.corpusDigest !== PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST) problems.push("corpus_digest");
+  if (
+    !FULL_SHA.test(value.runtimeCommitSha) ||
+    value.runtimeSourceManifest.commitSha !== value.runtimeCommitSha
+  ) {
+    problems.push("runtime_commit_sha");
+  }
+  problems.push(...runtimeSourceManifestProblems(value.runtimeSourceManifest));
+  if (
+    !DIGEST.test(value.runtimeSourceIdentityDigest) ||
+    prefixedPromptRefinerDigest({ files: value.runtimeSourceManifest.files }) !==
+      value.runtimeSourceIdentityDigest
+  ) {
+    problems.push("runtime_source_identity_digest");
+  }
+  if (!DIGEST.test(value.runtimeSourceManifestDigest) || prefixedPromptRefinerDigest(value.runtimeSourceManifest) !== value.runtimeSourceManifestDigest) problems.push("runtime_source_manifest_digest");
+  if (value.runtimeEnvironment !== PROMPT_REFINER_STAGE_ENVIRONMENT) problems.push("runtime_environment");
+  if (!DEPLOYMENT_ID.test(value.runtimeDeploymentId)) problems.push("runtime_deployment_id");
+  if (!DIGEST.test(value.executionManifestDigest) || prefixedPromptRefinerDigest(value.executionManifest) !== value.executionManifestDigest) problems.push("execution_manifest_digest");
+  if (canonicalBenchmarkJson(value.executionManifest) !== canonicalBenchmarkJson(promptRefinerExecutionManifest())) problems.push("execution_manifest");
+  if (!HEX_DIGEST.test(value.evidenceManifestSha256) || !HEX_DIGEST.test(value.historicalSourceIdentityDigest) || !HEX_DIGEST.test(value.corpusDigest)) problems.push("historical_digest_shape");
+  return problems;
+};
+
+export const promptRefinerStageApprovalWindowProblems = (input: {
+  approvedAt: Date;
+  approvalExpiresAt: Date;
+  now: Date;
+}): string[] => {
+  const problems: string[] = [];
+  if (input.approvalExpiresAt.getTime() - input.approvedAt.getTime() !== PROMPT_REFINER_STAGE_APPROVAL_TTL_MS) problems.push("approval_ttl");
+  if (input.approvedAt.getTime() > input.now.getTime()) problems.push("approval_from_future");
+  if (input.approvalExpiresAt.getTime() <= input.now.getTime()) problems.push("approval_expired");
+  return problems;
+};
diff --git a/prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql b/prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql
new file mode 100644
index 00000000..0b4d6804
--- /dev/null
+++ b/prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql
@@ -0,0 +1,618 @@
+-- Durable Prompt Refiner staging approval provenance.
+--
+-- This migration creates no stage and authorizes no execution. The predecessor
+-- migration deliberately had no seed; if any stage nevertheless exists, its
+-- provenance cannot be reconstructed safely, so deployment stops instead of
+-- backfilling guesses.
+
+DO $$
+BEGIN
+    IF EXISTS (SELECT 1 FROM "PromptRefinerReservationStage") THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage contains an unexpected pre-admission row';
+    END IF;
+END;
+$$;
+
+ALTER TABLE "PromptRefinerReservationStage"
+    ADD COLUMN "admissionVersion" TEXT NOT NULL,
+    ADD COLUMN "proposalVersion" TEXT NOT NULL,
+    ADD COLUMN "proposalDigest" TEXT NOT NULL,
+    ADD COLUMN "evidenceBundleDigest" TEXT NOT NULL,
+    ADD COLUMN "evidenceManifestSha256" TEXT NOT NULL,
+    ADD COLUMN "historicalSourceRef" TEXT NOT NULL,
+    ADD COLUMN "historicalSourceIdentityDigest" TEXT NOT NULL,
+    ADD COLUMN "corpusDigest" TEXT NOT NULL,
+    ADD COLUMN "runtimeCommitSha" TEXT NOT NULL,
+    ADD COLUMN "runtimeSourceIdentityDigest" TEXT NOT NULL,
+    ADD COLUMN "runtimeSourceManifest" JSONB NOT NULL,
+    ADD COLUMN "runtimeSourceManifestDigest" TEXT NOT NULL,
+    ADD COLUMN "runtimeEnvironment" TEXT NOT NULL,
+    ADD COLUMN "runtimeDeploymentId" TEXT NOT NULL,
+    ADD COLUMN "executionManifest" JSONB NOT NULL,
+    ADD COLUMN "executionManifestDigest" TEXT NOT NULL,
+    ADD COLUMN "approvalExpiresAt" TIMESTAMP(3) NOT NULL,
+    ADD COLUMN "authorizationAuditLogId" TEXT NOT NULL;
+
+-- The application canonicalizer sorts object keys and preserves array order.
+-- Keep the DB-side digest check independent from any caller-supplied boolean.
+CREATE FUNCTION "prompt_refiner_canonical_json"(value JSONB)
+RETURNS TEXT
+LANGUAGE plpgsql
+IMMUTABLE
+STRICT
+PARALLEL SAFE
+AS $$
+DECLARE
+    rendered TEXT;
+BEGIN
+    CASE jsonb_typeof(value)
+        WHEN 'object' THEN
+            SELECT '{' || COALESCE(string_agg(to_jsonb(item.key)::TEXT || ':' || "prompt_refiner_canonical_json"(item.value), ',' ORDER BY item.key COLLATE "C"), '') || '}'
+            INTO rendered FROM jsonb_each(value) AS item;
+        WHEN 'array' THEN
+            SELECT '[' || COALESCE(string_agg("prompt_refiner_canonical_json"(item.value), ',' ORDER BY item.ordinality), '') || ']'
+            INTO rendered FROM jsonb_array_elements(value) WITH ORDINALITY AS item(value, ordinality);
+        ELSE rendered := value::TEXT;
+    END CASE;
+    RETURN rendered;
+END;
+$$;
+
+CREATE FUNCTION "prompt_refiner_sha256_json"(value JSONB)
+RETURNS TEXT
+LANGUAGE sql
+IMMUTABLE
+STRICT
+PARALLEL SAFE
+AS $$
+    SELECT 'sha256:' || encode(sha256(convert_to("prompt_refiner_canonical_json"($1), 'UTF8')), 'hex')
+$$;
+
+CREATE FUNCTION "prompt_refiner_runtime_manifest_valid"(
+    manifest JSONB,
+    commit_sha TEXT,
+    source_identity_digest TEXT,
+    manifest_digest TEXT
+)
+RETURNS BOOLEAN
+LANGUAGE plpgsql
+IMMUTABLE
+STRICT
+PARALLEL SAFE
+AS $$
+DECLARE
+    expected_file_count CONSTANT INTEGER := 186;
+    maximum_total_size_bytes CONSTANT NUMERIC := 16777216;
+    expected_paths CONSTANT TEXT[] := ARRAY[
+        '.gitattributes',
+        'package.json',
+        'package-lock.json',
+        'tsconfig.json',
+        'prisma/schema.prisma',
+        'prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql',
+        'apps/mobile/package.json',
+        'packages/chat-core/package.json',
+        'packages/ui-tokens/package.json',
+        'app/api/admin/prompt-refiner/shadow-stage/route.ts',
+        'lib/accountEmails.ts',
+        'lib/activeAiModel.ts',
+        'lib/adminAudit.ts',
+        'lib/adminAuditIntegrityCore.ts',
+        'lib/adminAuditSystemActors.ts',
+        'lib/adminAuth.ts',
+        'lib/adminAuthCore.ts',
+        'lib/adminReauthentication.ts',
+        'lib/adminReauthenticationCore.ts',
+        'lib/anthropicPromptCaching.ts',
+        'lib/apiCacheControlPolicy.ts',
+        'lib/apiSecurity.ts',
+        'lib/appDefaults.ts',
+        'lib/appSettings.ts',
+        'lib/assistantKnowledgeGuide.ts',
+        'lib/assistantPackageImportAccess.ts',
+        'lib/assistantProfileAccess.ts',
+        'lib/auth.ts',
+        'lib/billingEmails.ts',
+        'lib/billingPlanDefaults.ts',
+        'lib/chatAdmissionCore.ts',
+        'lib/chatAttemptCostLedger.ts',
+        'lib/chatConcurrencyCore.ts',
+        'lib/chatCostGuardrails.ts',
+        'lib/chatCostSafetyCore.ts',
+        'lib/chatCreditAllocation.ts',
+        'lib/chatInputLimits.ts',
+        'lib/chatLimitDecisionCore.ts',
+        'lib/chatLimitDecisions.ts',
+        'lib/chatMultiAttemptSettlement.ts',
+        'lib/chatProviderHolds.ts',
+        'lib/chatRateLimitCore.ts',
+        'lib/chatRequestLease.ts',
+        'lib/chatSecurity.ts',
+        'lib/chatStarterAccess.ts',
+        'lib/chatTokenEstimate.ts',
+        'lib/chatTokenQuotaCore.ts',
+        'lib/chatUsageBucketCount.ts',
+        'lib/chatUsageKey.ts',
+        'lib/clientIp.ts',
+        'lib/credentialEmailLane.ts',
+        'lib/creditDebt.ts',
+        'lib/creditLedger.ts',
+        'lib/csp.ts',
+        'lib/databaseError.ts',
+        'lib/deepResearchSettlementHandoff.ts',
+        'lib/deepseekUsageAdapter.ts',
+        'lib/deepseekUsageAdapterCore.ts',
+        'lib/documentLanguage.ts',
+        'lib/e2eTestMode.ts',
+        'lib/email.ts',
+        'lib/emailAuditHash.ts',
+        'lib/emailConsentToken.ts',
+        'lib/emailFeatureFlags.ts',
+        'lib/emailJurisdictionCore.ts',
+        'lib/emailLogin.ts',
+        'lib/emailLoginEmails.ts',
+        'lib/emailPreferenceCore.ts',
+        'lib/emailPreferences.ts',
+        'lib/emailProviderPort.ts',
+        'lib/emailProviderPortCore.ts',
+        'lib/emailSendLock.ts',
+        'lib/emailSendLockCore.ts',
+        'lib/emailSendRetryCore.ts',
+        'lib/emailSendingIdentity.ts',
+        'lib/emailSendingIdentityCore.ts',
+        'lib/emailSentIdentityCore.ts',
+        'lib/emailSuppression.ts',
+        'lib/emailSuppressionAuthority.ts',
+        'lib/emailSuppressionAuthorityCore.ts',
+        'lib/emailSuppressionCauses.ts',
+        'lib/emailSuppressionCore.ts',
+        'lib/emailTemplateDefinitions.ts',
+        'lib/emailTemplateMetadataCore.ts',
+        'lib/emailTemplateRegistry.ts',
+        'lib/emailTypography.ts',
+        'lib/externalContinuationAccess.ts',
+        'lib/externalImportAccess.ts',
+        'lib/foundingTesterPassCore.ts',
+        'lib/imageGenerationAccess.ts',
+        'lib/language.ts',
+        'lib/managedSlack.ts',
+        'lib/marketingConsentConfirmationEmail.ts',
+        'lib/marketingEmailLayout.ts',
+        'lib/marketingRoutes.ts',
+        'lib/memoryAccess.ts',
+        'lib/mobileAccessToken.ts',
+        'lib/mobileAccessTokenCore.ts',
+        'lib/mobileAuthContract.ts',
+        'lib/mobileAuthKeyring.ts',
+        'lib/mobileAuthService.ts',
+        'lib/mobileDeploymentBinding.ts',
+        'lib/mobileRefreshRotationCore.ts',
+        'lib/mobileRefreshToken.ts',
+        'lib/mobileRevocationFreshnessCore.ts',
+        'lib/mobileSessionAuthorization.ts',
+        'lib/mobileSessionSnapshotCache.ts',
+        'lib/modelGenerationCompatibility.ts',
+        'lib/modelLaunchEmail.ts',
+        'lib/modelLifecycleDailyEmail.ts',
+        'lib/modelLifecycleDailyReportCore.ts',
+        'lib/modelPricing.ts',
+        'lib/modelRegistry.ts',
+        'lib/modelRegistryShared.ts',
+        'lib/models.ts',
+        'lib/nativeAppCors.ts',
+        'lib/nativeBearerGate.ts',
+        'lib/oauthTokenCrypto.ts',
+        'lib/operationalMonitoring.ts',
+        'lib/operationalMonitoringCore.ts',
+        'lib/operatorAlertProbeCore.ts',
+        'lib/originProtection.ts',
+        'lib/perplexityResponseCore.ts',
+        'lib/perplexityResponseEvents.ts',
+        'lib/perplexitySearchMetadataCore.ts',
+        'lib/perplexityUsageCapture.ts',
+        'lib/perplexityUsageCore.ts',
+        'lib/postgresConnectionConfigCore.mjs',
+        'lib/prisma.ts',
+        'lib/productAnnouncementEmail.ts',
+        'lib/promptInjectionAudit.ts',
+        'lib/promptRefinerAccess.ts',
+        'lib/promptRefinerExecutionContract.ts',
+        'lib/promptRefinerModelPrompt.ts',
+        'lib/promptRefinerReservationAuthority.ts',
+        'lib/promptRefinerReservationCore.ts',
+        'lib/promptRefinerShadowAdmissionCore.ts',
+        'lib/promptRefinerShadowHarness.ts',
+        'lib/promptRefinerShadowJournal.ts',
+        'lib/promptRefinerShadowSource.ts',
+        'lib/promptRefinerStageAdmission.ts',
+        'lib/promptRefinerStageAdmissionCore.ts',
+        'lib/promptRefinerSuggestion.ts',
+        'lib/providerBalanceCore.ts',
+        'lib/providerBilling.ts',
+        'lib/providerCostBudget.ts',
+        'lib/providerCreditAlertsCore.ts',
+        'lib/providerCredits.ts',
+        'lib/providerErrorClassification.ts',
+        'lib/providerFallbackCandidates.ts',
+        'lib/providerHealthPolicyCore.ts',
+        'lib/providerMonitoring.ts',
+        'lib/providerProbe.ts',
+        'lib/providerPublicStatusCore.ts',
+        'lib/providerUsageAccounting.ts',
+        'lib/providerUsageCost.ts',
+        'lib/providerVerification.ts',
+        'lib/publicSnapshotCache.ts',
+        'lib/publicUrl.ts',
+        'lib/requestOrigin.ts',
+        'lib/routerDevelopmentBenchmark.ts',
+        'lib/routingAttemptStore.ts',
+        'lib/searchProviderBudget.ts',
+        'lib/securityAudit.ts',
+        'lib/sessionRevocationCore.ts',
+        'lib/sessionSecurity.ts',
+        'lib/slackMessageTemplateCore.ts',
+        'lib/staticMarketingCsp.ts',
+        'lib/svixSignature.ts',
+        'lib/theme.ts',
+        'lib/tokenEstimateShadow.ts',
+        'lib/tokenEstimateShadowRecorder.ts',
+        'lib/turnstile.ts',
+        'lib/userDailyUsage.ts',
+        'lib/userOperationalSecurity.ts',
+        'lib/userTimeZone.ts',
+        'lib/voiceInputAccess.ts',
+        'lib/webSearchBackendPricing.ts',
+        'lib/webSearchBackendRuntime.ts',
+        'lib/webSearchBackends.ts',
+        'lib/webSearchCapability.ts',
+        'lib/webSearchCeilingBreachStore.ts',
+        'lib/webSearchCitations.ts',
+        'lib/webSearchCredits.ts',
+        'lib/webSearchNativeCostReservation.ts',
+        'proxy.ts'
+    ];
+    files JSONB;
+    entry JSONB;
+    index INTEGER;
+    actual_total_size_bytes NUMERIC := 0;
+BEGIN
+    IF jsonb_typeof(manifest) <> 'object'
+       OR manifest <> jsonb_build_object(
+            'schemaVersion', 'prompt-refiner-runtime-source-manifest-v2',
+            'commitSha', commit_sha,
+            'totalSizeBytes', manifest->'totalSizeBytes',
+            'files', manifest->'files'
+       )
+       OR manifest->>'commitSha' <> commit_sha
+       OR jsonb_typeof(manifest->'totalSizeBytes') <> 'number'
+       OR manifest->>'totalSizeBytes' !~ '^[1-9][0-9]*$'
+       OR (manifest->>'totalSizeBytes')::NUMERIC > maximum_total_size_bytes
+       OR jsonb_typeof(manifest->'files') <> 'array'
+       OR array_length(expected_paths, 1) <> expected_file_count
+       OR jsonb_array_length(manifest->'files') <> expected_file_count THEN
+        RETURN FALSE;
+    END IF;
+    files := manifest->'files';
+    FOR index IN 1..array_length(expected_paths, 1) LOOP
+        entry := files->(index - 1);
+        IF jsonb_typeof(entry) <> 'object'
+           OR entry <> jsonb_build_object(
+                'path', expected_paths[index],
+                'sizeBytes', entry->'sizeBytes',
+                'sha256', entry->'sha256'
+           )
+           OR entry->>'path' <> expected_paths[index]
+           OR jsonb_typeof(entry->'sizeBytes') <> 'number'
+           OR entry->>'sizeBytes' !~ '^[1-9][0-9]*$'
+           OR (entry->>'sizeBytes')::NUMERIC > 8388608
+           OR jsonb_typeof(entry->'sha256') <> 'string'
+           OR entry->>'sha256' !~ '^[a-f0-9]{64}$' THEN
+            RETURN FALSE;
+        END IF;
+        actual_total_size_bytes := actual_total_size_bytes + (entry->>'sizeBytes')::NUMERIC;
+    END LOOP;
+    RETURN actual_total_size_bytes = (manifest->>'totalSizeBytes')::NUMERIC
+       AND actual_total_size_bytes <= maximum_total_size_bytes
+       AND source_identity_digest = "prompt_refiner_sha256_json"(jsonb_build_object('files', files))
+       AND manifest_digest = "prompt_refiner_sha256_json"(manifest);
+EXCEPTION WHEN OTHERS THEN
+    RETURN FALSE;
+END;
+$$;
+
+CREATE UNIQUE INDEX "PromptRefinerReservationStage_authorizationAuditLogId_key"
+    ON "PromptRefinerReservationStage"("authorizationAuditLogId");
+
+ALTER TABLE "PromptRefinerReservationStage"
+    ADD CONSTRAINT "PromptRefinerReservationStage_authorizationAuditLogId_fkey"
+    FOREIGN KEY ("authorizationAuditLogId") REFERENCES "AdminAuditLog"("id")
+    ON DELETE RESTRICT ON UPDATE RESTRICT,
+    ADD CONSTRAINT "PromptRefinerReservationStage_admission_identity_check"
+    CHECK (
+        "admissionVersion" = 'prompt-refiner-stage-admission-v1'
+        AND "proposalVersion" = 'prompt-refiner-shadow-stage-proposal-v1'
+        AND "proposalDigest" = 'sha256:75198565b0bcc1e481c89c6ac8946d11793d28b7afbd96e18d36a03a27f06cc2'
+        AND "evidenceBundleDigest" = 'sha256:61d66909a0d493c9b0bfae5faaa3e79ad827a6cba8598f39167ecf506176a159'
+        AND "evidenceManifestSha256" = '9e15f6413083dd980fbd9003d9396d2c8519cacedba20fcb4bb951a796a7b73d'
+        AND "historicalSourceRef" = 'f1e1b0c23fd93cfa9dbaa0a68abe603d989c3830'
+        AND "historicalSourceIdentityDigest" = 'ac1813483dc62e44bb34fdc681be908611d72493567ba437322012a6e3438f39'
+        AND "corpusDigest" = 'bcb2709f74aa4983595a7121ad27c3abd80946a6e28d36442cf440f6dcf22958'
+    ),
+    ADD CONSTRAINT "PromptRefinerReservationStage_runtime_identity_check"
+    CHECK (
+        "runtimeEnvironment" = 'staging'
+        AND "runtimeCommitSha" ~ '^[a-f0-9]{40}$'
+        AND "runtimeDeploymentId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
+        AND "runtimeSourceIdentityDigest" ~ '^sha256:[a-f0-9]{64}$'
+        AND "runtimeSourceManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
+        AND "prompt_refiner_runtime_manifest_valid"(
+            "runtimeSourceManifest",
+            "runtimeCommitSha",
+            "runtimeSourceIdentityDigest",
+            "runtimeSourceManifestDigest"
+        )
+    ),
+    ADD CONSTRAINT "PromptRefinerReservationStage_execution_manifest_check"
+    CHECK (
+        "executionManifestDigest" ~ '^sha256:[a-f0-9]{64}$'
+        AND jsonb_typeof("executionManifest") = 'object'
+        AND "executionManifestDigest" = "prompt_refiner_sha256_json"("executionManifest")
+        AND "executionManifest" = '{
+          "schemaVersion":"prompt-refiner-shadow-execution-manifest-v1",
+          "stageId":"prompt-refiner-shadow-v1",
+          "reservationContractDigest":"sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f",
+          "runtimeSource":{"fileCount":186,"maxFileBytes":8388608,"maxTotalBytes":16777216},
+          "executionContractVersion":"prompt-refiner-execution-contract-v1",
+          "executionContract":{
+            "contractVersion":"prompt-refiner-execution-contract-v1",
+            "refinerVersion":"suggest-v1",
+            "mode":"shadow",
+            "userVisible":false,
+            "model":{"provider":"openai","modelId":"gpt-5-6-luna","apiModelId":"gpt-5.6-luna","pricingVersion":"openai-gpt-5.6-luna-2026-08-01","pricingEffectiveDate":"2026-08-01","routing":"direct_provider_api","processingTier":"standard","reasoningEffort":"medium","contextWindowTokens":1050000,"reasoningTokenBilling":"billed_as_output","inputUsdPerMillionTokens":0.2,"outputUsdPerMillionTokens":1.2},
+            "request":{"maxSourceChars":16000,"maxSourceBytes":32768,"maxInputTokens":100000,"maxOutputTokens":4096,"timeoutMs":15000,"retryCount":0,"promptCaching":"disabled","tools":"none","perRequestCostCeilingMicroUsd":24916},
+            "stage":{"maxDispatches":100,"costCeilingMicroUsd":2491600,"requiresSeparateApproval":true,"reservationAuthority":"unavailable"}
+          },
+          "perRequestCostMicroUsd":24916,
+          "maxReservations":100,
+          "costCeilingMicroUsd":2491600,
+          "executionAdmitted":false,
+          "productAdapterReady":false
+        }'::jsonb
+    ),
+    ADD CONSTRAINT "PromptRefinerReservationStage_approval_window_check"
+    CHECK ("approvalExpiresAt" = "approvedAt" + INTERVAL '60 minutes');
+
+DROP TRIGGER "prompt_refiner_stage_guard_trigger" ON "PromptRefinerReservationStage";
+DROP FUNCTION "prompt_refiner_stage_guard"();
+
+CREATE FUNCTION "prompt_refiner_stage_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    actual_count INTEGER;
+    actual_cost BIGINT;
+    observed_at TIMESTAMP(3);
+    audit_actor TEXT;
+    audit_action TEXT;
+    audit_target_type TEXT;
+    audit_target_id TEXT;
+    audit_metadata JSONB;
+    audit_entry_hash TEXT;
+    audit_created_at TIMESTAMP(3);
+    audit_observed_at TIMESTAMP(3);
+    audit_approved_at TIMESTAMP(3);
+    audit_expires_at TIMESTAMP(3);
+BEGIN
+    IF TG_OP = 'DELETE' THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % cannot be deleted', OLD."id";
+    END IF;
+    IF TG_OP = 'INSERT' THEN
+        IF NEW."reservationCount" <> 0 OR NEW."allocatedCostMicroUsd" <> 0 THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage must start with zero accounting';
+        END IF;
+        audit_observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        IF NEW."status" <> 'approved' THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage must start approved';
+        END IF;
+        SELECT "actorUserId", "action", "targetType", "targetId", "metadata", "entryHash", "createdAt"
+        INTO audit_actor, audit_action, audit_target_type, audit_target_id,
+             audit_metadata, audit_entry_hash, audit_created_at
+        FROM "AdminAuditLog"
+        WHERE "id" = NEW."authorizationAuditLogId";
+        audit_approved_at := ((audit_metadata->>'approvedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        audit_expires_at := ((audit_metadata->>'approvalExpiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);
+        IF NOT FOUND
+           OR audit_actor IS DISTINCT FROM NEW."approvedBy"
+           OR audit_action IS DISTINCT FROM 'prompt_refiner.shadow_stage.activated'
+           OR audit_target_type IS DISTINCT FROM 'PromptRefinerReservationStage'
+           OR audit_target_id IS DISTINCT FROM 'prompt-refiner-shadow-v1'
+           OR audit_entry_hash IS NULL
+           OR audit_entry_hash !~ '^[a-f0-9]{64}$'
+           OR audit_created_at < audit_observed_at - INTERVAL '1 minute'
+           OR audit_created_at > audit_observed_at + INTERVAL '1 minute'
+           OR audit_metadata IS DISTINCT FROM jsonb_build_object(
+                'admissionVersion', NEW."admissionVersion",
+                'proposalDigest', NEW."proposalDigest",
+                'evidenceBundleDigest', NEW."evidenceBundleDigest",
+                'runtimeSourceManifestDigest', NEW."runtimeSourceManifestDigest",
+                'executionManifestDigest', NEW."executionManifestDigest",
+                'environment', NEW."runtimeEnvironment",
+                'deploymentId', NEW."runtimeDeploymentId",
+                'commitSha', NEW."runtimeCommitSha",
+                'perRequestCostMicroUsd', NEW."perRequestCostMicroUsd",
+                'maxReservations', NEW."maxReservations",
+                'costCeilingMicroUsd', NEW."costCeilingMicroUsd",
+                'approvalTtlMinutes', 60,
+                'approvedAt', audit_metadata->'approvedAt',
+                'approvalExpiresAt', audit_metadata->'approvalExpiresAt',
+                'reason', 'bounded_staging_shadow_cost_approval'
+           )
+           OR jsonb_typeof(audit_metadata->'approvedAt') <> 'string'
+           OR jsonb_typeof(audit_metadata->'approvalExpiresAt') <> 'string'
+           OR audit_approved_at < observed_at - INTERVAL '1 minute'
+           OR audit_approved_at > observed_at
+           OR audit_expires_at <> audit_approved_at + INTERVAL '60 minutes'
+           OR NEW."approvedAt" IS DISTINCT FROM audit_approved_at
+           OR NEW."approvalExpiresAt" IS DISTINCT FROM audit_expires_at THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage authorization audit binding is invalid';
+        END IF;
+        NEW."approvedAt" := audit_approved_at;
+        NEW."approvalExpiresAt" := audit_expires_at;
+        NEW."createdAt" := observed_at;
+        NEW."updatedAt" := observed_at;
+        RETURN NEW;
+    END IF;
+    IF NEW."id" IS DISTINCT FROM OLD."id"
+       OR NEW."contractVersion" IS DISTINCT FROM OLD."contractVersion"
+       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
+       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
+       OR NEW."maxReservations" IS DISTINCT FROM OLD."maxReservations"
+       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
+       OR NEW."admissionVersion" IS DISTINCT FROM OLD."admissionVersion"
+       OR NEW."proposalVersion" IS DISTINCT FROM OLD."proposalVersion"
+       OR NEW."proposalDigest" IS DISTINCT FROM OLD."proposalDigest"
+       OR NEW."evidenceBundleDigest" IS DISTINCT FROM OLD."evidenceBundleDigest"
+       OR NEW."evidenceManifestSha256" IS DISTINCT FROM OLD."evidenceManifestSha256"
+       OR NEW."historicalSourceRef" IS DISTINCT FROM OLD."historicalSourceRef"
+       OR NEW."historicalSourceIdentityDigest" IS DISTINCT FROM OLD."historicalSourceIdentityDigest"
+       OR NEW."corpusDigest" IS DISTINCT FROM OLD."corpusDigest"
+       OR NEW."runtimeCommitSha" IS DISTINCT FROM OLD."runtimeCommitSha"
+       OR NEW."runtimeSourceIdentityDigest" IS DISTINCT FROM OLD."runtimeSourceIdentityDigest"
+       OR NEW."runtimeSourceManifest" IS DISTINCT FROM OLD."runtimeSourceManifest"
+       OR NEW."runtimeSourceManifestDigest" IS DISTINCT FROM OLD."runtimeSourceManifestDigest"
+       OR NEW."runtimeEnvironment" IS DISTINCT FROM OLD."runtimeEnvironment"
+       OR NEW."runtimeDeploymentId" IS DISTINCT FROM OLD."runtimeDeploymentId"
+       OR NEW."executionManifest" IS DISTINCT FROM OLD."executionManifest"
+       OR NEW."executionManifestDigest" IS DISTINCT FROM OLD."executionManifestDigest"
+       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
+       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
+       OR NEW."approvalExpiresAt" IS DISTINCT FROM OLD."approvalExpiresAt"
+       OR NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId"
+       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % contract is immutable', OLD."id";
+    END IF;
+    IF NEW."status" IS DISTINCT FROM OLD."status"
+       AND NOT (OLD."status" = 'approved' AND NEW."status" = 'closed') THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % status transition is invalid', OLD."id";
+    END IF;
+    IF NEW."reservationCount" = OLD."reservationCount"
+       AND NEW."allocatedCostMicroUsd" = OLD."allocatedCostMicroUsd" THEN
+        RETURN NEW;
+    END IF;
+
+    SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
+    INTO actual_count, actual_cost
+    FROM "PromptRefinerReservation"
+    WHERE "stageId" = OLD."id";
+    IF NEW."reservationCount" <> actual_count
+       OR NEW."allocatedCostMicroUsd" <> actual_cost THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % accounting must equal durable tombstones', OLD."id";
+    END IF;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE TRIGGER "prompt_refiner_stage_guard_trigger"
+BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerReservationStage"
+FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_stage_guard"();
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_insert_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    stage "PromptRefinerReservationStage"%ROWTYPE;
+    observed_at TIMESTAMP(3);
+BEGIN
+    IF NEW."status" <> 'reserved'
+       OR NEW."consumedAt" IS NOT NULL
+       OR NEW."releasedAt" IS NOT NULL
+       OR NEW."expiredAt" IS NOT NULL THEN
+        RAISE EXCEPTION 'PromptRefinerReservation must start reserved';
+    END IF;
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    IF NEW."stageId" <> 'prompt-refiner-shadow-v1'
+       OR NEW."contractDigest" <> 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
+       OR NEW."reservedCostMicroUsd" <> 24916
+       OR NEW."expiresAt" <> NEW."createdAt" + INTERVAL '5 minutes'
+       OR NEW."createdAt" > observed_at
+       OR NEW."expiresAt" <= observed_at
+       OR NEW."expiresAt" > observed_at + INTERVAL '5 minutes' THEN
+        RAISE EXCEPTION 'PromptRefinerReservation contract binding is invalid';
+    END IF;
+
+    SELECT * INTO stage
+    FROM "PromptRefinerReservationStage"
+    WHERE "id" = 'prompt-refiner-shadow-v1'
+    FOR UPDATE;
+    IF NOT FOUND THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
+    END IF;
+    IF stage."status" <> 'approved'
+       OR stage."approvalExpiresAt" <= observed_at
+       OR stage."runtimeEnvironment" <> 'staging'
+       OR stage."contractVersion" <> 'prompt-refiner-execution-contract-v1'
+       OR stage."contractDigest" <> NEW."contractDigest"
+       OR stage."perRequestCostMicroUsd" <> 24916
+       OR stage."maxReservations" <> 100
+       OR stage."costCeilingMicroUsd" <> 2491600 THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage contract is not approved';
+    END IF;
+    IF stage."reservationCount" >= 100
+       OR stage."allocatedCostMicroUsd" + 24916 > 2491600 THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
+    END IF;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE OR REPLACE FUNCTION "prompt_refiner_reservation_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    observed_at TIMESTAMP(3);
+    stage_expires_at TIMESTAMP(3);
+BEGIN
+    IF TG_OP = 'DELETE' THEN
+        RAISE EXCEPTION 'PromptRefinerReservation % cannot be deleted', OLD."id";
+    END IF;
+    IF NEW."id" IS DISTINCT FROM OLD."id"
+       OR NEW."stageId" IS DISTINCT FROM OLD."stageId"
+       OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
+       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
+       OR NEW."reservedCostMicroUsd" IS DISTINCT FROM OLD."reservedCostMicroUsd"
+       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
+       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
+        RAISE EXCEPTION 'PromptRefinerReservation % binding is immutable', OLD."id";
+    END IF;
+    IF OLD."status" <> 'reserved' THEN
+        RAISE EXCEPTION 'PromptRefinerReservation % is already terminal', OLD."id";
+    END IF;
+    IF NEW."consumedAt" IS NOT NULL
+       OR NEW."releasedAt" IS NOT NULL
+       OR NEW."expiredAt" IS NOT NULL THEN
+        RAISE EXCEPTION 'PromptRefinerReservation % terminal timestamp is database-owned', OLD."id";
+    END IF;
+    IF NEW."status" NOT IN ('consumed', 'released', 'expired') THEN
+        RAISE EXCEPTION 'PromptRefinerReservation % transition is invalid', OLD."id";
+    END IF;
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
+    SELECT "approvalExpiresAt" INTO stage_expires_at
+    FROM "PromptRefinerReservationStage"
+    WHERE "id" = OLD."stageId"
+    FOR UPDATE;
+    IF NEW."status" = 'consumed' AND (stage_expires_at IS NULL OR observed_at >= stage_expires_at) THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage approval expired before consume';
+    END IF;
+    IF NEW."status" = 'expired' AND observed_at < OLD."expiresAt" THEN
+        RAISE EXCEPTION 'PromptRefinerReservation % cannot expire before its deadline', OLD."id";
+    END IF;
+    IF observed_at >= OLD."expiresAt" THEN
+        NEW."status" := 'expired';
+        NEW."expiredAt" := observed_at;
+    ELSIF NEW."status" = 'consumed' THEN
+        NEW."consumedAt" := observed_at;
+    ELSE
+        NEW."releasedAt" := observed_at;
+    END IF;
+    NEW."updatedAt" := observed_at;
+    RETURN NEW;
+END;
+$$ LANGUAGE plpgsql;
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index d0ad8836..16885db0 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -2220,7 +2220,9 @@ model AdminAuditLog {
   entryHash    String?  @unique
   createdAt    DateTime @default(now())
 
-  /// No relation on purpose: see
+  promptRefinerReservationStage PromptRefinerReservationStage?
+
+  /// No actor relation on purpose: see
   /// migrations/20260826070000_admin_audit_actor_not_a_foreign_key.
   /// `actorUserId` is part of this row's HMAC input, so a foreign-key action
   /// rewriting it makes an audit entry indistinguishable from a forged one --
@@ -5504,21 +5506,42 @@ model MobileAuthEvent {
 // are content-free tombstones and are never deleted or reused.
 
 model PromptRefinerReservationStage {
-  id                     String   @id
-  contractVersion        String
-  contractDigest         String   @unique
-  status                 String
-  perRequestCostMicroUsd BigInt
-  maxReservations        Int
-  costCeilingMicroUsd    BigInt
-  reservationCount       Int      @default(0)
-  allocatedCostMicroUsd  BigInt   @default(0)
-  approvedBy             String
-  approvedAt             DateTime
-  createdAt              DateTime @default(now())
-  updatedAt              DateTime @updatedAt
-
-  reservations PromptRefinerReservation[]
+  id                             String   @id
+  contractVersion                String
+  contractDigest                 String   @unique
+  status                         String
+  perRequestCostMicroUsd         BigInt
+  maxReservations                Int
+  costCeilingMicroUsd            BigInt
+  reservationCount               Int      @default(0)
+  allocatedCostMicroUsd          BigInt   @default(0)
+  admissionVersion               String
+  proposalVersion                String
+  proposalDigest                 String
+  evidenceBundleDigest           String
+  evidenceManifestSha256         String
+  historicalSourceRef            String
+  historicalSourceIdentityDigest String
+  corpusDigest                   String
+  runtimeCommitSha               String
+  runtimeSourceIdentityDigest    String
+  /// Content-free v2 manifest for the exact 186-file runtime import closure;
+  /// the database validates ordered paths plus 8 MiB/file and 16 MiB total.
+  runtimeSourceManifest          Json
+  runtimeSourceManifestDigest    String
+  runtimeEnvironment             String
+  runtimeDeploymentId            String
+  executionManifest              Json
+  executionManifestDigest        String
+  approvedBy                     String
+  approvedAt                     DateTime
+  approvalExpiresAt              DateTime
+  authorizationAuditLogId        String   @unique
+  createdAt                      DateTime @default(now())
+  updatedAt                      DateTime @updatedAt
+
+  reservations          PromptRefinerReservation[]
+  authorizationAuditLog AdminAuditLog              @relation(fields: [authorizationAuditLogId], references: [id], onDelete: Restrict, onUpdate: Restrict)
 }
 
 model PromptRefinerReservation {
diff --git a/scripts/check-data-domain-registry.mjs b/scripts/check-data-domain-registry.mjs
index 93cd2360..f8b8e587 100644
--- a/scripts/check-data-domain-registry.mjs
+++ b/scripts/check-data-domain-registry.mjs
@@ -162,7 +162,12 @@ const userLinked = new Set(models.filter(({ body }) => USER_LINK.test(body)).map
 // that no script can derive, so widening it would have failed the build on a
 // governance question. Both are registered now as `unverified` on both axes,
 // which records the outstanding decision without letting the table escape.
-const USER_COLUMN = /^\s{2}\w*[Uu]serId\s+String\b/m;
+// `approvedBy` is also a durable operator identifier. The Prompt Refiner stage
+// deliberately has no User relation: deleting an operator must not rewrite the
+// immutable approval evidence. Treat that exact column as user data so future
+// approval tables cannot escape the registry merely by choosing a different
+// name for the actor id.
+const USER_COLUMN = /^\s{2}(?:\w*[Uu]serId|approvedBy)\s+String\b/m;
 const holdsUserData = new Set(
   models
     .filter(({ body }) => USER_LINK.test(body) || USER_COLUMN.test(body))
diff --git a/scripts/report-unswept-tables-core.mjs b/scripts/report-unswept-tables-core.mjs
index 3e506ef9..63cd1e84 100644
--- a/scripts/report-unswept-tables-core.mjs
+++ b/scripts/report-unswept-tables-core.mjs
@@ -49,7 +49,7 @@ export const BOUNDED_TABLES = {
     ProviderDailyUsage:
         "one row per (provider, model, source, day); the day makes it grow, but at a rate set by the catalogue rather than by traffic",
     PromptRefinerReservationStage:
-        "one fixed preregistered shadow stage; the application has no seed or writer that can create further stages",
+        "one fixed create-only staging shadow stage; immutable content-free provenance, DB-clock approval expiry and its authorization audit are retained, with no seed or update/delete path",
     PromptRefinerReservation:
         "at most 100 permanent tombstones under the fixed stage; released and expired rows consume their slot and cannot be deleted or reused",
     MarketingChannel:
diff --git a/scripts/run-db-integration-tests.mjs b/scripts/run-db-integration-tests.mjs
index 1dca102b..ca1b95ac 100644
--- a/scripts/run-db-integration-tests.mjs
+++ b/scripts/run-db-integration-tests.mjs
@@ -203,6 +203,9 @@ run(
     // Prompt Refiner authority: stage-first locking, runtime price drift,
     // one-time consume and the permanent 100-slot/cost ceiling.
     "tests/integration/prompt-refiner-reservation.db.test.ts",
+    // The staging-only create-once writer: exact historical/current provenance,
+    // audit atomicity, immutable approval and DB-clock expiry.
+    "tests/integration/prompt-refiner-reservation-admission.db.test.ts",
     "tests/integration/admin-security.db.test.ts",
     "tests/integration/admin-users.db.test.ts",
     "tests/integration/login-methods.db.test.ts",
diff --git a/tests/fixtures/prompt-refiner-non-utc-writer-child.ts b/tests/fixtures/prompt-refiner-non-utc-writer-child.ts
new file mode 100644
index 00000000..e6fc7b9b
--- /dev/null
+++ b/tests/fixtures/prompt-refiner-non-utc-writer-child.ts
@@ -0,0 +1,53 @@
+import assert from "node:assert/strict";
+import type { Session } from "next-auth";
+
+import { prisma } from "@/lib/prisma";
+import {
+  createPromptRefinerReservationStage,
+  loadPromptRefinerStageAdmissionFacts,
+} from "@/lib/promptRefinerStageAdmission";
+import {
+  buildPromptRefinerStagePreviewBinding,
+  promptRefinerStagePreviewBindingDigest,
+} from "@/lib/promptRefinerStageAdmissionCore";
+
+const main = async () => {
+  const [sessionClock] = await prisma.$queryRaw<Array<{ timeZone: string }>>`
+    SELECT current_setting('TimeZone') AS "timeZone"
+  `;
+  assert.equal(sessionClock?.timeZone, "Australia/Brisbane");
+
+  const facts = await loadPromptRefinerStageAdmissionFacts();
+  const result = await createPromptRefinerReservationStage({
+    session: {
+      user: {
+        id: "mposition",
+        email: "owner@example.com",
+        authenticatedAt: new Date().toISOString(),
+      },
+    } as Session,
+    request: new Request(
+      "http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-stage",
+      { method: "POST", headers: { "user-agent": "non-utc-db-integration" } }
+    ),
+    expected: {
+      proposalDigest: facts.proposalDigest,
+      runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+      executionManifestDigest: facts.executionManifestDigest,
+      previewBindingDigest: promptRefinerStagePreviewBindingDigest(
+        buildPromptRefinerStagePreviewBinding(facts)
+      ),
+    },
+  });
+  assert.equal(result.created, true);
+  process.stdout.write(
+    `${JSON.stringify({ timeZone: sessionClock.timeZone, stageId: result.stage.id })}\n`
+  );
+};
+
+main()
+  .finally(() => prisma.$disconnect())
+  .catch((error) => {
+    console.error(error);
+    process.exitCode = 1;
+  });
diff --git a/tests/integration/prompt-refiner-reservation-admission.db.test.ts b/tests/integration/prompt-refiner-reservation-admission.db.test.ts
new file mode 100644
index 00000000..7f98c406
--- /dev/null
+++ b/tests/integration/prompt-refiner-reservation-admission.db.test.ts
@@ -0,0 +1,691 @@
+import assert from "node:assert/strict";
+import { spawnSync } from "node:child_process";
+import { randomUUID } from "node:crypto";
+import { readFileSync } from "node:fs";
+import { before, beforeEach, test } from "node:test";
+import type { Session } from "next-auth";
+
+import { prisma } from "@/lib/prisma";
+import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
+import {
+  PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+  PROMPT_REFINER_EXECUTION_MODEL_PIN,
+} from "@/lib/promptRefinerExecutionContract";
+import {
+  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+  PROMPT_REFINER_RESERVATION_STAGE_ID,
+  PROMPT_REFINER_RESERVATION_TTL_MS,
+} from "@/lib/promptRefinerReservationCore";
+import {
+  consumePromptRefinerReservation,
+  reservePromptRefinerExecution,
+} from "@/lib/promptRefinerReservationAuthority";
+import {
+  createPromptRefinerReservationStage,
+  loadPromptRefinerStageAdmissionFacts,
+} from "@/lib/promptRefinerStageAdmission";
+import {
+  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
+  PROMPT_REFINER_STAGE_REASON,
+  buildPromptRefinerStagePreviewBinding,
+  promptRefinerStagePreviewBindingDigest,
+} from "@/lib/promptRefinerStageAdmissionCore";
+
+process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
+process.env.RAILWAY_GIT_COMMIT_SHA = "b".repeat(40);
+process.env.RAILWAY_DEPLOYMENT_ID = "prompt-refiner-admission-db-test";
+const AUDIT_FIXTURE_KEY = "prompt-refiner-reservation-strong-fixture-key";
+process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_FIXTURE_KEY;
+
+const session = {
+  user: {
+    id: "mposition",
+    email: "owner@example.com",
+    authenticatedAt: new Date().toISOString(),
+  },
+} as Session;
+
+const request = () =>
+  new Request("http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-stage", {
+    method: "POST",
+    headers: { "user-agent": "db-integration" },
+  });
+
+const reset = async () => {
+  await prisma.$executeRawUnsafe(`
+    TRUNCATE TABLE "PromptRefinerReservation", "PromptRefinerReservationStage", "AdminAuditLog"
+    RESTART IDENTITY CASCADE
+  `);
+};
+
+const ensureRuntimeModel = async () => {
+  const row = staticModelRegistrySeedRows().find(
+    (candidate) => candidate.id === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId
+  );
+  assert.ok(row);
+  await prisma.modelRegistryEntry.upsert({
+    where: { id: row.id },
+    create: row,
+    update: row,
+  });
+};
+
+const expected = async () => {
+  const facts = await loadPromptRefinerStageAdmissionFacts();
+  return {
+    proposalDigest: facts.proposalDigest,
+    runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+    executionManifestDigest: facts.executionManifestDigest,
+    previewBindingDigest: promptRefinerStagePreviewBindingDigest(
+      buildPromptRefinerStagePreviewBinding(facts)
+    ),
+  };
+};
+
+const create = async () =>
+  createPromptRefinerReservationStage({
+    session,
+    request: request(),
+    expected: await expected(),
+  });
+
+const seedFutureAuditHead = async (offsetMs: number) => {
+  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+  `;
+  assert.ok(clock);
+  const createdAt = new Date(clock.now.getTime() + offsetMs);
+  const entryHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
+  await prisma.adminAuditLog.create({
+    data: {
+      action: "test.audit_head.seeded",
+      targetType: "PromptRefinerReservationStageTest",
+      summary: "Seeded a deterministic audit-chain head for stage timestamp coverage.",
+      previousHash: null,
+      entryHash,
+      createdAt,
+    },
+  });
+  return { createdAt, entryHash };
+};
+
+before(async () => {
+  await ensureRuntimeModel();
+});
+
+beforeEach(async () => {
+  process.env.RAILWAY_DEPLOYMENT_ID = "prompt-refiner-admission-db-test";
+  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_FIXTURE_KEY;
+  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
+  await reset();
+});
+
+test("migration has no seed and the writer atomically binds provenance to one audit", async () => {
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
+  const migration = readFileSync(
+    "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+    "utf8"
+  );
+  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"PromptRefinerReservationStage"/i);
+  assert.match(
+    migration,
+    /IF EXISTS \(SELECT 1 FROM "PromptRefinerReservationStage"\)[\s\S]*RAISE EXCEPTION 'PromptRefinerReservationStage contains an unexpected pre-admission row'/
+  );
+
+  const created = await create();
+  assert.equal(created.created, true);
+  assert.equal(created.replayed, false);
+  assert.equal(created.stage.reservationCount, 0);
+  assert.equal(created.stage.allocatedCostMicroUsd, BigInt(0));
+  assert.equal(created.stage.runtimeEnvironment, "staging");
+  assert.equal(created.stage.approvalExpiresAt.getTime() - created.stage.approvedAt.getTime(), 60 * 60 * 1_000);
+  assert.equal(await prisma.promptRefinerReservation.count(), 0);
+  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
+    where: { id: created.stage.authorizationAuditLogId },
+  });
+  assert.equal(audit.actorUserId, "mposition");
+  assert.equal(audit.action, "prompt_refiner.shadow_stage.activated");
+  assert.equal(audit.entryHash?.length, 64);
+  await assert.rejects(
+    prisma.$executeRawUnsafe(`
+      DO $$
+      BEGIN
+        IF EXISTS (SELECT 1 FROM "PromptRefinerReservationStage") THEN
+          RAISE EXCEPTION 'PromptRefinerReservationStage contains an unexpected pre-admission row';
+        END IF;
+      END;
+      $$;
+    `),
+    /unexpected pre-admission row/i
+  );
+});
+
+test("stage audit freshness uses UTC under a non-UTC database session", async () => {
+  const facts = await loadPromptRefinerStageAdmissionFacts();
+  const auditId = randomUUID();
+
+  await prisma.$transaction(async (tx) => {
+    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Australia/Brisbane'`);
+    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
+      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    assert.ok(clock);
+    const approvedAt = clock.now;
+    const approvalExpiresAt = new Date(
+      approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
+    );
+    await tx.adminAuditLog.create({
+      data: {
+        id: auditId,
+        actorUserId: "mposition",
+        actorEmail: "owner@example.com",
+        action: "prompt_refiner.shadow_stage.activated",
+        targetType: "PromptRefinerReservationStage",
+        targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        summary: "Approved the bounded Prompt Refiner staging shadow stage.",
+        metadata: {
+          admissionVersion: facts.admissionVersion,
+          proposalDigest: facts.proposalDigest,
+          evidenceBundleDigest: facts.evidenceBundleDigest,
+          runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+          executionManifestDigest: facts.executionManifestDigest,
+          environment: facts.runtimeEnvironment,
+          deploymentId: facts.runtimeDeploymentId,
+          commitSha: facts.runtimeCommitSha,
+          perRequestCostMicroUsd: 24_916,
+          maxReservations: 100,
+          costCeilingMicroUsd: 2_491_600,
+          approvalTtlMinutes: 60,
+          approvedAt: approvedAt.toISOString(),
+          approvalExpiresAt: approvalExpiresAt.toISOString(),
+          reason: PROMPT_REFINER_STAGE_REASON,
+        },
+        previousHash: null,
+        entryHash: "e".repeat(64),
+        createdAt: approvedAt,
+      },
+    });
+    await tx.promptRefinerReservationStage.create({
+      data: {
+        id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+        status: "approved",
+        perRequestCostMicroUsd: BigInt(24_916),
+        maxReservations: 100,
+        costCeilingMicroUsd: BigInt(2_491_600),
+        reservationCount: 0,
+        allocatedCostMicroUsd: BigInt(0),
+        admissionVersion: facts.admissionVersion,
+        proposalVersion: facts.proposalVersion,
+        proposalDigest: facts.proposalDigest,
+        evidenceBundleDigest: facts.evidenceBundleDigest,
+        evidenceManifestSha256: facts.evidenceManifestSha256,
+        historicalSourceRef: facts.historicalSourceRef,
+        historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
+        corpusDigest: facts.corpusDigest,
+        runtimeCommitSha: facts.runtimeCommitSha,
+        runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
+        runtimeSourceManifest: facts.runtimeSourceManifest,
+        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+        runtimeEnvironment: facts.runtimeEnvironment,
+        runtimeDeploymentId: facts.runtimeDeploymentId,
+        executionManifest: facts.executionManifest,
+        executionManifestDigest: facts.executionManifestDigest,
+        approvedBy: "mposition",
+        approvedAt,
+        approvalExpiresAt,
+        authorizationAuditLogId: auditId,
+        createdAt: approvedAt,
+      },
+    });
+  });
+
+  const stored = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+    where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+  });
+  assert.ok(stored.createdAt.getTime() >= stored.approvedAt.getTime());
+  assert.ok(stored.createdAt.getTime() - stored.approvedAt.getTime() < 1_000);
+  assert.equal(
+    stored.approvalExpiresAt.getTime() - stored.approvedAt.getTime(),
+    PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
+  );
+});
+
+test("the shared audit writer's monotonic +1ms timestamp remains stage-admissible", async () => {
+  const binding = await expected();
+  const head = await seedFutureAuditHead(30_000);
+
+  const created = await createPromptRefinerReservationStage({
+    session,
+    request: request(),
+    expected: binding,
+  });
+  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
+    where: { id: created.stage.authorizationAuditLogId },
+  });
+  assert.equal(audit.previousHash, head.entryHash);
+  assert.equal(audit.createdAt.getTime(), head.createdAt.getTime() + 1);
+  assert.equal(
+    created.stage.approvalExpiresAt.getTime() - created.stage.approvedAt.getTime(),
+    PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
+  );
+  assert.equal(
+    (await reservePromptRefinerExecution({ requestId: "monotonic_audit_stage_reserve" })).ok,
+    true
+  );
+});
+
+test("the stage trigger rejects a shared-writer audit more than one minute in the future", async () => {
+  const binding = await expected();
+  const head = await seedFutureAuditHead(120_000);
+
+  await assert.rejects(
+    createPromptRefinerReservationStage({
+      session,
+      request: request(),
+      expected: binding,
+    }),
+    /authorization audit binding is invalid/i
+  );
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
+  assert.equal(await prisma.adminAuditLog.count(), 1);
+  assert.equal(
+    await prisma.adminAuditLog.count({ where: { entryHash: head.entryHash } }),
+    1
+  );
+});
+
+test("the actual writer creates a verifiable stage when the database session default is non-UTC", async () => {
+  const databaseUrl = new URL(process.env.DATABASE_URL!);
+  databaseUrl.searchParams.set("options", "-c timezone=Australia/Brisbane");
+  const child = spawnSync(
+    process.execPath,
+    [
+      "--conditions=react-server",
+      "--import",
+      "tsx",
+      "tests/fixtures/prompt-refiner-non-utc-writer-child.ts",
+    ],
+    {
+      cwd: process.cwd(),
+      encoding: "utf8",
+      env: {
+        ...process.env,
+        DATABASE_URL: databaseUrl.toString(),
+        DIRECT_DATABASE_URL: databaseUrl.toString(),
+      },
+    }
+  );
+  assert.equal(child.status, 0, child.stderr || child.stdout);
+  assert.match(child.stdout, /"timeZone":"Australia\/Brisbane"/);
+
+  const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+    where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+  });
+  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
+    where: { id: stage.authorizationAuditLogId },
+  });
+  assert.ok(audit.createdAt.getTime() >= stage.approvedAt.getTime());
+  assert.ok(audit.createdAt.getTime() - stage.approvedAt.getTime() < 1_000);
+  const reserved = await reservePromptRefinerExecution({
+    requestId: "non_utc_writer_reserve",
+  });
+  assert.equal(reserved.ok, true);
+  if (reserved.ok) assert.equal(reserved.value.created, true);
+});
+
+test("direct service callers cannot override the fixed audit reason", async () => {
+  const result = await createPromptRefinerReservationStage({
+    session,
+    request: request(),
+    expected: await expected(),
+    reason: "caller_controlled_reason",
+  } as Parameters<typeof createPromptRefinerReservationStage>[0] & { reason: string });
+  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
+    where: { id: result.stage.authorizationAuditLogId },
+  });
+  assert.equal(
+    (audit.metadata as { reason?: unknown } | null)?.reason,
+    "bounded_staging_shadow_cost_approval"
+  );
+});
+
+test("stage authorization accepts its audit after an integrity-key rotation", async () => {
+  await create();
+  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "rotated-prompt-refiner-audit-key";
+  process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS = AUDIT_FIXTURE_KEY;
+
+  const reserved = await reservePromptRefinerExecution({
+    requestId: "previous_audit_key_reserve",
+  });
+  assert.equal(reserved.ok, true);
+});
+
+test("a structurally exact but forged audit and stage cannot reserve or consume", async () => {
+  const facts = await loadPromptRefinerStageAdmissionFacts();
+  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+  `;
+  assert.ok(clock);
+  const approvedAt = clock.now;
+  const approvalExpiresAt = new Date(
+    approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS
+  );
+  const previous = await prisma.adminAuditLog.findFirst({
+    where: { entryHash: { not: null } },
+    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
+    select: { entryHash: true },
+  });
+  const auditId = randomUUID();
+  await prisma.adminAuditLog.create({
+    data: {
+      id: auditId,
+      actorUserId: "mposition",
+      actorEmail: "owner@example.com",
+      action: "prompt_refiner.shadow_stage.activated",
+      targetType: "PromptRefinerReservationStage",
+      targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+      summary: "Approved the bounded Prompt Refiner staging shadow stage.",
+      metadata: {
+        admissionVersion: facts.admissionVersion,
+        proposalDigest: facts.proposalDigest,
+        evidenceBundleDigest: facts.evidenceBundleDigest,
+        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+        executionManifestDigest: facts.executionManifestDigest,
+        environment: facts.runtimeEnvironment,
+        deploymentId: facts.runtimeDeploymentId,
+        commitSha: facts.runtimeCommitSha,
+        perRequestCostMicroUsd: 24_916,
+        maxReservations: 100,
+        costCeilingMicroUsd: 2_491_600,
+        approvalTtlMinutes: 60,
+        approvedAt: approvedAt.toISOString(),
+        approvalExpiresAt: approvalExpiresAt.toISOString(),
+        reason: PROMPT_REFINER_STAGE_REASON,
+      },
+      previousHash: previous?.entryHash ?? null,
+      entryHash: "f".repeat(64),
+      createdAt: approvedAt,
+    },
+  });
+  await prisma.promptRefinerReservationStage.create({
+    data: {
+      id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+      contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+      contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+      status: "approved",
+      perRequestCostMicroUsd: BigInt(24_916),
+      maxReservations: 100,
+      costCeilingMicroUsd: BigInt(2_491_600),
+      reservationCount: 0,
+      allocatedCostMicroUsd: BigInt(0),
+      admissionVersion: facts.admissionVersion,
+      proposalVersion: facts.proposalVersion,
+      proposalDigest: facts.proposalDigest,
+      evidenceBundleDigest: facts.evidenceBundleDigest,
+      evidenceManifestSha256: facts.evidenceManifestSha256,
+      historicalSourceRef: facts.historicalSourceRef,
+      historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
+      corpusDigest: facts.corpusDigest,
+      runtimeCommitSha: facts.runtimeCommitSha,
+      runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
+      runtimeSourceManifest: facts.runtimeSourceManifest,
+      runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+      runtimeEnvironment: facts.runtimeEnvironment,
+      runtimeDeploymentId: facts.runtimeDeploymentId,
+      executionManifest: facts.executionManifest,
+      executionManifestDigest: facts.executionManifestDigest,
+      approvedBy: "mposition",
+      approvedAt,
+      approvalExpiresAt,
+      authorizationAuditLogId: auditId,
+      createdAt: approvedAt,
+    },
+  });
+
+  assert.deepEqual(
+    await reservePromptRefinerExecution({ requestId: "forged_stage_reserve" }),
+    { ok: false, reason: "stage_authorization_invalid" }
+  );
+  await assert.rejects(
+    create(),
+    (error: unknown) =>
+      Boolean(
+        error &&
+          typeof error === "object" &&
+          "code" in error &&
+          error.code === "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH"
+      )
+  );
+
+  const reservationId = randomUUID();
+  await prisma.promptRefinerReservation.create({
+    data: {
+      id: reservationId,
+      stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+      requestId: "forged_stage_consume",
+      contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+      status: "reserved",
+      reservedCostMicroUsd: BigInt(24_916),
+      createdAt: approvedAt,
+      expiresAt: new Date(approvedAt.getTime() + PROMPT_REFINER_RESERVATION_TTL_MS),
+    },
+  });
+  assert.deepEqual(
+    await consumePromptRefinerReservation({
+      reservationId,
+      requestId: "forged_stage_consume",
+      stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+      contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    }),
+    { ok: false, reason: "stage_authorization_invalid" }
+  );
+});
+
+test("concurrent exact writes leave one immutable stage and one success audit", async () => {
+  const results = await Promise.all(Array.from({ length: 8 }, () => create()));
+  assert.equal(results.filter((result) => result.created).length, 1);
+  assert.equal(results.filter((result) => result.replayed).length, 7);
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
+  assert.equal(
+    await prisma.adminAuditLog.count({
+      where: { action: "prompt_refiner.shadow_stage.activated" },
+    }),
+    1
+  );
+});
+
+test("deployment mismatch is a 409 conflict and cannot add an audit", async () => {
+  await create();
+  process.env.RAILWAY_DEPLOYMENT_ID = "different-deployment";
+  await assert.rejects(
+    create(),
+    (error: unknown) =>
+      Boolean(
+        error &&
+          typeof error === "object" &&
+          "code" in error &&
+          error.code === "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH"
+      )
+  );
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
+  assert.equal(
+    await prisma.adminAuditLog.count({ where: { action: "prompt_refiner.shadow_stage.activated" } }),
+    1
+  );
+});
+
+test("an exact replay by another actor is a 409 conflict and cannot add an audit", async () => {
+  await create();
+  const otherActor = {
+    user: {
+      id: "different-owner",
+      email: "different-owner@example.com",
+      authenticatedAt: new Date().toISOString(),
+    },
+  } as Session;
+  await assert.rejects(
+    createPromptRefinerReservationStage({
+      session: otherActor,
+      request: request(),
+      expected: await expected(),
+    }),
+    (error: unknown) =>
+      Boolean(
+        error &&
+          typeof error === "object" &&
+          "code" in error &&
+          error.code === "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH"
+      )
+  );
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
+  assert.equal(
+    await prisma.adminAuditLog.count({
+      where: { action: "prompt_refiner.shadow_stage.activated" },
+    }),
+    1
+  );
+});
+
+test("a preview from the same commit and source but another deployment is stale before transaction writes", async () => {
+  const staleExpected = await expected();
+  process.env.RAILWAY_DEPLOYMENT_ID = "prompt-refiner-admission-db-test-next";
+  await assert.rejects(
+    createPromptRefinerReservationStage({
+      session,
+      request: request(),
+      expected: staleExpected,
+    }),
+    (error: unknown) =>
+      Boolean(
+        error &&
+          typeof error === "object" &&
+          "code" in error &&
+          error.code === "PROMPT_REFINER_STAGE_PREVIEW_STALE"
+      )
+  );
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
+  assert.equal(
+    await prisma.adminAuditLog.count({
+      where: { action: "prompt_refiner.shadow_stage.activated" },
+    }),
+    0
+  );
+});
+
+test("audit failure rolls back the stage and direct SQL cannot alter or delete provenance", async () => {
+  await prisma.$executeRawUnsafe(`
+    CREATE FUNCTION "prompt_refiner_test_reject_activation_audit"()
+    RETURNS TRIGGER AS $$
+    BEGIN
+      IF NEW."action" = 'prompt_refiner.shadow_stage.activated' THEN
+        RAISE EXCEPTION 'forced activation audit failure';
+      END IF;
+      RETURN NEW;
+    END;
+    $$ LANGUAGE plpgsql;
+    CREATE TRIGGER "prompt_refiner_test_reject_activation_audit_trigger"
+    BEFORE INSERT ON "AdminAuditLog"
+    FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_reject_activation_audit"();
+  `);
+  try {
+    await assert.rejects(create(), /forced activation audit failure/i);
+  } finally {
+    await prisma.$executeRawUnsafe(`
+      DROP TRIGGER IF EXISTS "prompt_refiner_test_reject_activation_audit_trigger" ON "AdminAuditLog";
+      DROP FUNCTION IF EXISTS "prompt_refiner_test_reject_activation_audit"();
+    `);
+  }
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
+  assert.equal(await prisma.adminAuditLog.count({ where: { action: "prompt_refiner.shadow_stage.activated" } }), 0);
+
+  const created = await create();
+  await assert.rejects(
+    prisma.$executeRaw`
+      UPDATE "PromptRefinerReservationStage"
+      SET "runtimeDeploymentId" = 'forged'
+      WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
+    `,
+    /immutable/i
+  );
+  await assert.rejects(
+    prisma.$executeRaw`
+      DELETE FROM "PromptRefinerReservationStage"
+      WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
+    `,
+    /cannot be deleted/i
+  );
+  assert.equal(created.stage.id, PROMPT_REFINER_RESERVATION_STAGE_ID);
+});
+
+test("stage insert failure rolls the already-written activation audit back", async () => {
+  await prisma.$executeRawUnsafe(`
+    CREATE FUNCTION "prompt_refiner_test_reject_stage_insert"()
+    RETURNS TRIGGER AS $$
+    BEGIN
+      RAISE EXCEPTION 'forced stage insert failure';
+    END;
+    $$ LANGUAGE plpgsql;
+    CREATE TRIGGER "prompt_refiner_test_reject_stage_insert_trigger"
+    BEFORE INSERT ON "PromptRefinerReservationStage"
+    FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_reject_stage_insert"();
+  `);
+  try {
+    await assert.rejects(create(), /forced stage insert failure/i);
+  } finally {
+    await prisma.$executeRawUnsafe(`
+      DROP TRIGGER IF EXISTS "prompt_refiner_test_reject_stage_insert_trigger" ON "PromptRefinerReservationStage";
+      DROP FUNCTION IF EXISTS "prompt_refiner_test_reject_stage_insert"();
+    `);
+  }
+  assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
+  assert.equal(
+    await prisma.adminAuditLog.count({
+      where: { action: "prompt_refiner.shadow_stage.activated" },
+    }),
+    0
+  );
+});
+
+test("expired stage refuses reserve and consume at both service and DB boundaries", async () => {
+  await create();
+  const reserved = await reservePromptRefinerExecution({ requestId: "before_stage_expiry" });
+  assert.equal(reserved.ok, true);
+  if (!reserved.ok) return;
+
+  await prisma.$executeRawUnsafe('ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"');
+  try {
+    await prisma.$executeRaw`
+      UPDATE "PromptRefinerReservationStage"
+      SET "approvedAt" = "approvedAt" - INTERVAL '2 hours',
+          "approvalExpiresAt" = "approvalExpiresAt" - INTERVAL '2 hours'
+      WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
+    `;
+  } finally {
+    await prisma.$executeRawUnsafe('ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"');
+  }
+
+  assert.deepEqual(
+    await reservePromptRefinerExecution({ requestId: "after_stage_expiry" }),
+    { ok: false, reason: "stage_authorization_invalid" }
+  );
+  const binding = {
+    reservationId: reserved.value.reservation.reservationId,
+    requestId: reserved.value.reservation.requestId,
+    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+    contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+  };
+  assert.deepEqual(await consumePromptRefinerReservation(binding), {
+    ok: false,
+    reason: "stage_authorization_invalid",
+  });
+  await assert.rejects(
+    prisma.$executeRaw`
+      UPDATE "PromptRefinerReservation"
+      SET "status" = 'consumed'
+      WHERE "id" = ${binding.reservationId}
+    `,
+    /approval expired before consume/i
+  );
+});
diff --git a/tests/integration/prompt-refiner-reservation.db.test.ts b/tests/integration/prompt-refiner-reservation.db.test.ts
index 587c8693..160a4754 100644
--- a/tests/integration/prompt-refiner-reservation.db.test.ts
+++ b/tests/integration/prompt-refiner-reservation.db.test.ts
@@ -1,7 +1,9 @@
 import assert from "node:assert/strict";
 import { randomUUID } from "node:crypto";
 import { before, beforeEach, test } from "node:test";
+import type { Session } from "next-auth";
 
+import { writeAdminAuditLog } from "@/lib/adminAudit";
 import { prisma } from "@/lib/prisma";
 import {
     consumePromptRefinerReservation,
@@ -17,9 +19,26 @@ import {
     PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
     PROMPT_REFINER_RESERVATION_STAGE_ID,
 } from "@/lib/promptRefinerReservationCore";
+import { loadPromptRefinerStageAdmissionFacts } from "@/lib/promptRefinerStageAdmission";
+import {
+    PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
+    PROMPT_REFINER_STAGE_REASON,
+    prefixedPromptRefinerDigest,
+} from "@/lib/promptRefinerStageAdmissionCore";
 import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
 
 const INPUT_PRICE_ENV = "CHAT_MODEL_GPT_5_6_LUNA_INPUT_USD_PER_MILLION";
+const FIXTURE_COMMIT_SHA = "a".repeat(40);
+const FIXTURE_DEPLOYMENT_ID = "prompt-refiner-db-test";
+process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
+process.env.RAILWAY_GIT_COMMIT_SHA = FIXTURE_COMMIT_SHA;
+process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
+process.env.ADMIN_AUDIT_INTEGRITY_KEY = "prompt-refiner-reservation-strong-fixture-key";
+
+const fixtureSession = { user: { id: "mposition", email: "owner@example.com" } } as Session;
+const fixtureRequest = new Request("http://127.0.0.1:3100/db-fixture", {
+    headers: { "user-agent": "prompt-refiner-db-integration" },
+});
 
 const reset = async () => {
     await prisma.$executeRawUnsafe(`
@@ -42,22 +61,119 @@ const ensureRuntimeModel = async () => {
     });
 };
 
-const createStage = async (input: { status?: "approved" | "closed" } = {}) => {
-    return prisma.promptRefinerReservationStage.create({
-        data: {
-            id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+const stageCreateData = async (input: {
+    id?: string;
+    status?: "approved" | "closed";
+    reservationCount?: number;
+    allocatedCostMicroUsd?: bigint;
+} = {}) => {
+    const facts = await loadPromptRefinerStageAdmissionFacts();
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const approvedAt = clock!.now;
+    const approvalExpiresAt = new Date(approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS);
+    const auditId = await writeAdminAuditLog({
+        session: fixtureSession,
+        request: fixtureRequest,
+        action: "prompt_refiner.shadow_stage.activated",
+        targetType: "PromptRefinerReservationStage",
+        targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        summary: "Approved the bounded Prompt Refiner staging shadow stage.",
+        metadata: {
+            admissionVersion: facts.admissionVersion,
+            proposalDigest: facts.proposalDigest,
+            evidenceBundleDigest: facts.evidenceBundleDigest,
+            runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+            executionManifestDigest: facts.executionManifestDigest,
+            environment: facts.runtimeEnvironment,
+            deploymentId: facts.runtimeDeploymentId,
+            commitSha: facts.runtimeCommitSha,
+            perRequestCostMicroUsd: 24_916,
+            maxReservations: 100,
+            costCeilingMicroUsd: 2_491_600,
+            approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
+            approvedAt: approvedAt.toISOString(),
+            approvalExpiresAt: approvalExpiresAt.toISOString(),
+            reason: PROMPT_REFINER_STAGE_REASON,
+        },
+    });
+    return {
+            id: input.id ?? PROMPT_REFINER_RESERVATION_STAGE_ID,
             contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
             contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
             status: input.status ?? "approved",
             perRequestCostMicroUsd: BigInt(24_916),
             maxReservations: 100,
             costCeilingMicroUsd: BigInt(2_491_600),
-            reservationCount: 0,
-            allocatedCostMicroUsd: BigInt(0),
+            reservationCount: input.reservationCount ?? 0,
+            allocatedCostMicroUsd: input.allocatedCostMicroUsd ?? BigInt(0),
+            admissionVersion: facts.admissionVersion,
+            proposalVersion: facts.proposalVersion,
+            proposalDigest: facts.proposalDigest,
+            evidenceBundleDigest: facts.evidenceBundleDigest,
+            evidenceManifestSha256: facts.evidenceManifestSha256,
+            historicalSourceRef: facts.historicalSourceRef,
+            historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
+            corpusDigest: facts.corpusDigest,
+            runtimeCommitSha: facts.runtimeCommitSha,
+            runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
+            runtimeSourceManifest: facts.runtimeSourceManifest,
+            runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
+            runtimeEnvironment: facts.runtimeEnvironment,
+            runtimeDeploymentId: facts.runtimeDeploymentId,
+            executionManifest: facts.executionManifest,
+            executionManifestDigest: facts.executionManifestDigest,
             approvedBy: "mposition",
-            approvedAt: new Date(),
+            approvedAt,
+            approvalExpiresAt,
+            authorizationAuditLogId: auditId,
+    };
+};
+
+const rebindStageAudit = async (data: Awaited<ReturnType<typeof stageCreateData>>) => {
+    data.authorizationAuditLogId = await writeAdminAuditLog({
+        session: fixtureSession,
+        request: fixtureRequest,
+        action: "prompt_refiner.shadow_stage.activated",
+        targetType: "PromptRefinerReservationStage",
+        targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        summary: "Approved the bounded Prompt Refiner staging shadow stage.",
+        metadata: {
+            admissionVersion: data.admissionVersion,
+            proposalDigest: data.proposalDigest,
+            evidenceBundleDigest: data.evidenceBundleDigest,
+            runtimeSourceManifestDigest: data.runtimeSourceManifestDigest,
+            executionManifestDigest: data.executionManifestDigest,
+            environment: data.runtimeEnvironment,
+            deploymentId: data.runtimeDeploymentId,
+            commitSha: data.runtimeCommitSha,
+            perRequestCostMicroUsd: Number(data.perRequestCostMicroUsd),
+            maxReservations: data.maxReservations,
+            costCeilingMicroUsd: Number(data.costCeilingMicroUsd),
+            approvalTtlMinutes: 60,
+            approvedAt: data.approvedAt.toISOString(),
+            approvalExpiresAt: data.approvalExpiresAt.toISOString(),
+            reason: PROMPT_REFINER_STAGE_REASON,
         },
     });
+    return data;
+};
+
+const recomputeRuntimeManifestDigests = (data: Awaited<ReturnType<typeof stageCreateData>>) => {
+    const manifest = data.runtimeSourceManifest as unknown as { files: Array<Record<string, unknown>> };
+    data.runtimeSourceIdentityDigest = prefixedPromptRefinerDigest({ files: manifest.files });
+    data.runtimeSourceManifestDigest = prefixedPromptRefinerDigest(data.runtimeSourceManifest);
+};
+
+const createStage = async (input: { status?: "approved" | "closed" } = {}) => {
+    const stage = await prisma.promptRefinerReservationStage.create({
+        data: await stageCreateData({ ...input, status: "approved" }),
+    });
+    if (input.status === "closed") {
+        return prisma.promptRefinerReservationStage.update({ where: { id: stage.id }, data: { status: "closed" } });
+    }
+    return stage;
 };
 
 const bindingOf = (reservation: {
@@ -111,6 +227,8 @@ before(async () => {
 
 beforeEach(async () => {
     delete process.env[INPUT_PRICE_ENV];
+    process.env.RAILWAY_GIT_COMMIT_SHA = FIXTURE_COMMIT_SHA;
+    process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
     await reset();
 });
 
@@ -138,19 +256,10 @@ test("reserve uses the DB clock and atomically binds one exact permanent slot",
 test("a stage must start at zero and direct counter updates cannot mint slots", async () => {
     await assert.rejects(
         prisma.promptRefinerReservationStage.create({
-            data: {
-                id: PROMPT_REFINER_RESERVATION_STAGE_ID,
-                contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
-                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
-                status: "approved",
-                perRequestCostMicroUsd: BigInt(24_916),
-                maxReservations: 100,
-                costCeilingMicroUsd: BigInt(2_491_600),
+            data: await stageCreateData({
                 reservationCount: 1,
                 allocatedCostMicroUsd: BigInt(24_916),
-                approvedBy: "mposition",
-                approvedAt: new Date(),
-            },
+            }),
         }),
         /must start with zero accounting/i
     );
@@ -223,13 +332,7 @@ test("a repeated request is idempotent and never consumes a second slot", async
     const first = await reservePromptRefinerExecution({ requestId: "request_same" });
     assert.equal(first.ok, true);
     if (!first.ok) return;
-    await prisma.promptRefinerReservationStage.update({
-        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
-        data: { status: "closed" },
-    });
-    process.env[INPUT_PRICE_ENV] = "99";
     const second = await reservePromptRefinerExecution({ requestId: "request_same" });
-    delete process.env[INPUT_PRICE_ENV];
     assert.equal(second.ok, true);
     if (!second.ok) return;
     assert.equal(first.value.created, true);
@@ -250,6 +353,64 @@ test("a repeated request is idempotent and never consumes a second slot", async
     assert.equal(stage.reservationCount, 1);
 });
 
+test("an active requestId replay is refused after the stage approval expires", async () => {
+    await createStage();
+    const first = await reservePromptRefinerExecution({ requestId: "request_expired_replay" });
+    assert.equal(first.ok, true);
+    if (!first.ok) return;
+    await prisma.$executeRawUnsafe(
+        'ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
+    );
+    try {
+        await prisma.$executeRaw`
+            UPDATE "PromptRefinerReservationStage"
+            SET "approvedAt" = "approvedAt" - INTERVAL '2 hours',
+                "approvalExpiresAt" = "approvalExpiresAt" - INTERVAL '2 hours'
+            WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
+        `;
+    } finally {
+        await prisma.$executeRawUnsafe(
+            'ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
+        );
+    }
+    const replay = await reservePromptRefinerExecution({ requestId: "request_expired_replay" });
+    assert.equal(replay.ok, false);
+    assert.equal(await prisma.promptRefinerReservation.count(), 1);
+});
+
+test("an active requestId replay is refused after deployment or source identity drift", async () => {
+    await createStage();
+    const first = await reservePromptRefinerExecution({ requestId: "request_source_drift_replay" });
+    assert.equal(first.ok, true);
+    if (!first.ok) return;
+
+    process.env.RAILWAY_DEPLOYMENT_ID = "different-deployment";
+    const deploymentReplay = await reservePromptRefinerExecution({
+        requestId: "request_source_drift_replay",
+    });
+    assert.deepEqual(deploymentReplay, { ok: false, reason: "stage_contract_mismatch" });
+
+    process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
+    process.env.RAILWAY_GIT_COMMIT_SHA = "c".repeat(40);
+    const sourceReplay = await reservePromptRefinerExecution({
+        requestId: "request_source_drift_replay",
+    });
+    assert.deepEqual(sourceReplay, { ok: false, reason: "stage_contract_mismatch" });
+    assert.equal(await prisma.promptRefinerReservation.count(), 1);
+});
+
+test("an active requestId replay is refused after model pricing drift", async () => {
+    await createStage();
+    const first = await reservePromptRefinerExecution({ requestId: "request_pricing_drift_replay" });
+    assert.equal(first.ok, true);
+    if (!first.ok) return;
+
+    process.env[INPUT_PRICE_ENV] = "99";
+    const replay = await reservePromptRefinerExecution({ requestId: "request_pricing_drift_replay" });
+    assert.deepEqual(replay, { ok: false, reason: "runtime_contract_mismatch" });
+    assert.equal(await prisma.promptRefinerReservation.count(), 1);
+});
+
 test("every exact direct insert consumes budget and forged or 101st inserts fail closed", async () => {
     await createStage();
     const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
@@ -895,19 +1056,97 @@ test("stage-row locking admits only the remaining five slots under concurrency",
 });
 
 test("database constraints reject malformed state and triggers prevent deletion or reuse", async () => {
+    const wrongPath = await stageCreateData();
+    wrongPath.runtimeSourceManifest = structuredClone(wrongPath.runtimeSourceManifest) as typeof wrongPath.runtimeSourceManifest;
+    (wrongPath.runtimeSourceManifest as unknown as { files: Array<{ path: string }> }).files[0]!.path = "lib/not-allowed.ts";
+    recomputeRuntimeManifestDigests(wrongPath);
+    await rebindStageAudit(wrongPath);
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: wrongPath }),
+        /runtime_identity_check|check constraint/i
+    );
+
+    const extraEntryKey = await stageCreateData();
+    extraEntryKey.runtimeSourceManifest = structuredClone(extraEntryKey.runtimeSourceManifest) as typeof extraEntryKey.runtimeSourceManifest;
+    (extraEntryKey.runtimeSourceManifest as unknown as { files: Array<Record<string, unknown>> }).files[0]!.unexpected = true;
+    recomputeRuntimeManifestDigests(extraEntryKey);
+    await rebindStageAudit(extraEntryKey);
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: extraEntryKey }),
+        /runtime_identity_check|check constraint/i
+    );
+
+    const malformedHash = await stageCreateData();
+    malformedHash.runtimeSourceManifest = structuredClone(malformedHash.runtimeSourceManifest) as typeof malformedHash.runtimeSourceManifest;
+    (malformedHash.runtimeSourceManifest as unknown as { files: Array<{ sha256: string }> }).files[0]!.sha256 = "A".repeat(64);
+    recomputeRuntimeManifestDigests(malformedHash);
+    await rebindStageAudit(malformedHash);
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: malformedHash }),
+        /runtime_identity_check|check constraint/i
+    );
+
+    const oversizedEntry = await stageCreateData();
+    oversizedEntry.runtimeSourceManifest = structuredClone(oversizedEntry.runtimeSourceManifest) as typeof oversizedEntry.runtimeSourceManifest;
+    (oversizedEntry.runtimeSourceManifest as unknown as { files: Array<{ sizeBytes: number }> }).files[0]!.sizeBytes = 8 * 1024 * 1024 + 1;
+    recomputeRuntimeManifestDigests(oversizedEntry);
+    await rebindStageAudit(oversizedEntry);
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: oversizedEntry }),
+        /runtime_identity_check|check constraint/i
+    );
+
+    const oversizedClosure = await stageCreateData();
+    oversizedClosure.runtimeSourceManifest = structuredClone(oversizedClosure.runtimeSourceManifest) as typeof oversizedClosure.runtimeSourceManifest;
+    const oversizedClosureManifest = oversizedClosure.runtimeSourceManifest as unknown as {
+        totalSizeBytes: number;
+        files: Array<{ sizeBytes: number }>;
+    };
+    for (const index of [0, 1, 2]) {
+        oversizedClosureManifest.files[index]!.sizeBytes = 6 * 1024 * 1024;
+    }
+    oversizedClosureManifest.totalSizeBytes = oversizedClosureManifest.files.reduce(
+        (total, entry) => total + entry.sizeBytes,
+        0
+    );
+    recomputeRuntimeManifestDigests(oversizedClosure);
+    await rebindStageAudit(oversizedClosure);
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: oversizedClosure }),
+        /runtime_identity_check|check constraint/i
+    );
+
+    const executionSourcePolicyDrift = await stageCreateData();
+    executionSourcePolicyDrift.executionManifest = structuredClone(executionSourcePolicyDrift.executionManifest) as typeof executionSourcePolicyDrift.executionManifest;
+    (executionSourcePolicyDrift.executionManifest as unknown as {
+        runtimeSource: { maxTotalBytes: number };
+    }).runtimeSource.maxTotalBytes += 1;
+    executionSourcePolicyDrift.executionManifestDigest = prefixedPromptRefinerDigest(
+        executionSourcePolicyDrift.executionManifest
+    );
+    await rebindStageAudit(executionSourcePolicyDrift);
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: executionSourcePolicyDrift }),
+        /execution_manifest_check|check constraint/i
+    );
+
+    const auditMismatch = await stageCreateData();
+    auditMismatch.runtimeDeploymentId = "other-valid-deployment";
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: auditMismatch }),
+        /authorization audit binding is invalid/i
+    );
+
+    const actorMismatch = await stageCreateData();
+    actorMismatch.approvedBy = "another-actor";
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({ data: actorMismatch }),
+        /authorization audit binding is invalid/i
+    );
+
     await assert.rejects(
         prisma.promptRefinerReservationStage.create({
-            data: {
-                id: "another_stage",
-                contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
-                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
-                status: "approved",
-                perRequestCostMicroUsd: BigInt(24_916),
-                maxReservations: 100,
-                costCeilingMicroUsd: BigInt(2_491_600),
-                approvedBy: "mposition",
-                approvedAt: new Date(),
-            },
+            data: await stageCreateData({ id: "another_stage" }),
         })
     );
     await createStage();
diff --git a/tests/promptRefinerReservationCore.test.mjs b/tests/promptRefinerReservationCore.test.mjs
index 0cf01699..1452bae1 100644
--- a/tests/promptRefinerReservationCore.test.mjs
+++ b/tests/promptRefinerReservationCore.test.mjs
@@ -37,6 +37,8 @@ const validStage = (overrides = {}) => ({
     costCeilingMicroUsd: 2_491_600n,
     reservationCount: 0,
     allocatedCostMicroUsd: 0n,
+    approvedAt: new Date("2026-09-17T00:00:00.000Z"),
+    approvalExpiresAt: new Date("2026-09-17T01:00:00.000Z"),
     ...overrides,
 });
 
@@ -82,6 +84,7 @@ test("stage validation rejects every mutable bound and broken accounting", () =>
         ["costCeilingMicroUsd", 2_491_599n, "stage_cost_mismatch"],
         ["reservationCount", 101, "reservation_count_invalid"],
         ["allocatedCostMicroUsd", 1n, "allocated_cost_invalid"],
+        ["approvalExpiresAt", new Date("2026-09-17T00:59:59.999Z"), "approval_window_invalid"],
     ];
     for (const [field, value, expected] of cases) {
         assert.ok(
diff --git a/tests/promptRefinerRuntimeSourceClosure.test.mjs b/tests/promptRefinerRuntimeSourceClosure.test.mjs
new file mode 100644
index 00000000..b530b6cf
--- /dev/null
+++ b/tests/promptRefinerRuntimeSourceClosure.test.mjs
@@ -0,0 +1,1168 @@
+import assert from "node:assert/strict";
+import { createHash } from "node:crypto";
+import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
+import { isAbsolute, join, relative, resolve } from "node:path";
+import test from "node:test";
+import ts from "typescript";
+
+import {
+  PROMPT_REFINER_RUNTIME_IMPORT_ROOTS,
+  PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
+  PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
+  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
+} from "../lib/promptRefinerStageAdmissionCore.ts";
+
+const repositoryRoot = resolve(import.meta.dirname, "..");
+const repositoryRootReal = realpathSync.native(repositoryRoot);
+const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
+assert.ok(Array.isArray(rootPackage.workspaces), "package.json workspaces must be an array");
+
+const repositoryPath = (absolute) => {
+  const real = realpathSync.native(absolute);
+  const path = relative(repositoryRootReal, real).replaceAll("\\", "/");
+  assert.equal(
+    path === ".." || path.startsWith("../") || isAbsolute(path),
+    false,
+    `resolved local runtime import escaped repository: ${real}`
+  );
+  return path;
+};
+
+const workspacePackageDirectories = rootPackage.workspaces.flatMap((pattern) => {
+  assert.match(pattern, /^[^*]+\*$/, `unsupported workspace pattern ${pattern}`);
+  const parent = join(repositoryRoot, pattern.slice(0, -1));
+  return readdirSync(parent, { withFileTypes: true })
+    .filter((entry) => entry.isDirectory())
+    .map((entry) => join(parent, entry.name))
+    .filter((directory) => existsSync(join(directory, "package.json")));
+});
+
+const workspacePackages = new Map(
+  workspacePackageDirectories.map((directory) => {
+    const manifestPath = join(directory, "package.json");
+    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
+    assert.equal(typeof manifest.name, "string", `workspace has no name: ${manifestPath}`);
+    return [manifest.name, { directory, manifest }];
+  })
+);
+assert.equal(workspacePackages.size, workspacePackageDirectories.length, "workspace names must be unique");
+
+const configFile = ts.readConfigFile(join(repositoryRoot, "tsconfig.json"), ts.sys.readFile);
+assert.equal(configFile.error, undefined);
+const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot);
+assert.deepEqual(parsedConfig.errors, []);
+const compilerOptions = parsedConfig.options;
+
+// JavaScript permits every object to become a capability source through a
+// computed property such as `value[key]`, where `key` later resolves to
+// `constructor`.  Trying to enumerate every spelling is not fail-closed.  The
+// existing runtime closure therefore gets one deliberately narrow exception:
+// its already-reviewed data-indexing expressions are frozen as an exact
+// path/position/text snapshot.  Any new or moved non-static element access must
+// be reviewed and must update this digest before the closure gate can pass.
+const REVIEWED_DYNAMIC_ELEMENT_ACCESS_COUNT = 221;
+const REVIEWED_DYNAMIC_ELEMENT_ACCESS_SHA256 =
+  "e0c6cf0868ee77ebc821fed2f96dc9317509f0236d463e22f2a0893db89f71d3";
+
+const unwrapStaticExpression = (node) => {
+  let current = node;
+  while (
+    ts.isParenthesizedExpression(current) ||
+    ts.isAsExpression(current) ||
+    ts.isTypeAssertionExpression(current) ||
+    ts.isNonNullExpression(current)
+  ) {
+    current = current.expression;
+  }
+  return current;
+};
+
+const staticComputedPropertyValue = (node) => {
+  const current = unwrapStaticExpression(node);
+  if (
+    ts.isStringLiteral(current) ||
+    ts.isNoSubstitutionTemplateLiteral(current) ||
+    ts.isNumericLiteral(current)
+  ) {
+    return current.text;
+  }
+  if (
+    ts.isPrefixUnaryExpression(current) &&
+    ts.isNumericLiteral(current.operand) &&
+    (current.operator === ts.SyntaxKind.PlusToken ||
+      current.operator === ts.SyntaxKind.MinusToken)
+  ) {
+    return current.getText();
+  }
+  if (
+    ts.isBinaryExpression(current) &&
+    current.operatorToken.kind === ts.SyntaxKind.PlusToken
+  ) {
+    const left = staticComputedPropertyValue(current.left);
+    const right = staticComputedPropertyValue(current.right);
+    return left === null || right === null ? null : left + right;
+  }
+  return null;
+};
+
+const dynamicElementAccessSnapshot = () => {
+  const entries = [];
+  for (const path of PROMPT_REFINER_RUNTIME_SOURCE_PATHS) {
+    if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
+    const source = ts.createSourceFile(
+      path,
+      readFileSync(join(repositoryRoot, path), "utf8"),
+      ts.ScriptTarget.Latest,
+      true
+    );
+    const visit = (node) => {
+      if (
+        ts.isElementAccessExpression(node) &&
+        node.argumentExpression &&
+        staticComputedPropertyValue(node.argumentExpression) === null
+      ) {
+        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
+        entries.push(
+          `${path}:${location.line + 1}:${location.character + 1}:${node.getText(source)}`
+        );
+      }
+      ts.forEachChild(node, visit);
+    };
+    visit(source);
+  }
+  entries.sort();
+  return {
+    entries,
+    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
+  };
+};
+
+const resolutionOptionsSnapshot = (config) => ({
+  baseUrl: config.baseUrl ?? null,
+  rootDirs: config.rootDirs ?? null,
+  moduleSuffixes: config.moduleSuffixes ?? null,
+  paths: config.paths ?? null,
+});
+const expectedResolutionOptions = Object.freeze({
+  baseUrl: null,
+  rootDirs: null,
+  moduleSuffixes: null,
+  paths: {
+    "@/*": ["./*"],
+    "@tomverse/chat-core": ["./packages/chat-core/src/index.ts"],
+  },
+});
+const assertResolutionOptions = (options) =>
+  assert.deepEqual(
+    resolutionOptionsSnapshot(options),
+    expectedResolutionOptions,
+    "resolution-affecting tsconfig options changed; review and recompute the durable closure"
+  );
+assertResolutionOptions(compilerOptions);
+
+const fixedNonImportPaths = Object.freeze([
+  ".gitattributes",
+  "package.json",
+  "package-lock.json",
+  "tsconfig.json",
+  "prisma/schema.prisma",
+  "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
+  ...workspacePackageDirectories.map((directory) => repositoryPath(join(directory, "package.json"))).sort(),
+]);
+
+const workspaceForSpecifier = (specifier) =>
+  [...workspacePackages.entries()]
+    .sort(([left], [right]) => right.length - left.length)
+    .find(([name]) => specifier === name || specifier.startsWith(`${name}/`)) ?? null;
+
+const exportedWorkspaceTarget = (specifier, workspace) => {
+  const [name, value] = workspace;
+  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
+  const exports = value.manifest.exports;
+  let target = typeof exports === "string" && subpath === "." ? exports : exports?.[subpath];
+  if (target && typeof target === "object") {
+    target = target.import ?? target.default ?? target.node ?? null;
+  }
+  assert.equal(
+    typeof target,
+    "string",
+    `unresolved local workspace import ${specifier}; ${name} does not export ${subpath}`
+  );
+  const absolute = join(value.directory, target);
+  assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `workspace export is not a file: ${specifier}`);
+  return repositoryPath(absolute);
+};
+
+const compilerAliasCouldBeLocal = (specifier) =>
+  Object.keys(compilerOptions.paths ?? {}).some((pattern) => {
+    const star = pattern.indexOf("*");
+    return star === -1
+      ? specifier === pattern
+      : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
+  });
+
+const resolveLocalRuntimeImport = (fromPath, specifier) => {
+  const workspace = workspaceForSpecifier(specifier);
+  const resolution = ts.resolveModuleName(
+    specifier,
+    join(repositoryRoot, fromPath),
+    compilerOptions,
+    ts.sys
+  ).resolvedModule;
+  if (resolution) {
+    const resolvedReal = realpathSync.native(resolution.resolvedFileName);
+    const path = relative(repositoryRootReal, resolvedReal);
+    const inside = path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../") && !isAbsolute(path);
+    if (inside) {
+      assert.equal(
+        resolvedReal.endsWith(".d.ts"),
+        false,
+        `local runtime import resolved only to a declaration: ${specifier} from ${fromPath}`
+      );
+      return repositoryPath(resolvedReal);
+    }
+    assert.equal(
+      workspace !== null || specifier.startsWith("@tomverse/"),
+      false,
+      `local workspace import resolved outside repository: ${specifier} from ${fromPath}`
+    );
+    return null;
+  }
+  if (workspace) return exportedWorkspaceTarget(specifier, workspace);
+  assert.equal(
+    specifier.startsWith(".") || compilerAliasCouldBeLocal(specifier) || specifier.startsWith("@tomverse/"),
+    false,
+    `unresolved or misclassified local runtime import ${specifier} from ${fromPath}`
+  );
+  return null;
+};
+
+const importDeclarationHasRuntimeValue = (node) => {
+  if (!node.importClause) return true;
+  if (node.importClause.isTypeOnly) return false;
+  if (node.importClause.name) return true;
+  const bindings = node.importClause.namedBindings;
+  if (ts.isNamespaceImport(bindings)) return true;
+  return ts.isNamedImports(bindings) && bindings.elements.some((element) => !element.isTypeOnly);
+};
+
+const runtimeImportSpecifiers = (
+  path,
+  text,
+  { allowReviewedDynamicElementAccesses = false } = {}
+) => {
+  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
+  const specifiers = [];
+  const isNodeModuleSpecifier = (value) =>
+    value === "node:module" || value === "module";
+  const loaderIdentifiers = new Set(["require"]);
+  const createRequireFactories = new Set();
+  const moduleNamespaces = new Set();
+  const moduleObjectIdentifiers = new Set(["module"]);
+  const reflectApplyIdentifiers = new Set();
+  const globalStateAliases = new Set();
+  const nodeGlobalAliases = new Set();
+  const allNodes = [];
+  const collect = (node) => {
+    allNodes.push(node);
+    if (
+      ts.isImportDeclaration(node) &&
+      node.importClause &&
+      !node.importClause.isTypeOnly &&
+      ts.isStringLiteral(node.moduleSpecifier) &&
+      isNodeModuleSpecifier(node.moduleSpecifier.text)
+    ) {
+      if (node.importClause.name) {
+        moduleNamespaces.add(node.importClause.name.text);
+      }
+      const bindings = node.importClause.namedBindings;
+      if (bindings && ts.isNamedImports(bindings)) {
+        for (const element of bindings.elements) {
+          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "createRequire") {
+            createRequireFactories.add(element.name.text);
+          }
+        }
+      }
+      if (bindings && ts.isNamespaceImport(bindings)) {
+        moduleNamespaces.add(bindings.name.text);
+      }
+    } else if (
+      ts.isImportEqualsDeclaration(node) &&
+      !node.isTypeOnly &&
+      ts.isExternalModuleReference(node.moduleReference) &&
+      node.moduleReference.expression &&
+      ts.isStringLiteral(node.moduleReference.expression) &&
+      isNodeModuleSpecifier(node.moduleReference.expression.text)
+    ) {
+      moduleNamespaces.add(node.name.text);
+    } else if (
+      ts.isExportDeclaration(node) &&
+      !node.isTypeOnly &&
+      node.moduleSpecifier &&
+      ts.isStringLiteral(node.moduleSpecifier) &&
+      isNodeModuleSpecifier(node.moduleSpecifier.text) &&
+      (!node.exportClause ||
+        !ts.isNamedExports(node.exportClause) ||
+        node.exportClause.elements.some((element) => !element.isTypeOnly))
+    ) {
+      assert.fail(`node:module runtime re-export cannot be resolved safely in ${path}`);
+    }
+    ts.forEachChild(node, collect);
+  };
+  collect(source);
+
+  const staticStringValue = (node) => {
+    const current = unwrapTransparentExpression(node);
+    if (
+      ts.isStringLiteral(current) ||
+      ts.isNoSubstitutionTemplateLiteral(current)
+    ) {
+      return current.text;
+    }
+    if (
+      ts.isBinaryExpression(current) &&
+      current.operatorToken.kind === ts.SyntaxKind.PlusToken
+    ) {
+      const left = staticStringValue(current.left);
+      const right = staticStringValue(current.right);
+      return left === null || right === null ? null : left + right;
+    }
+    return null;
+  };
+  const staticPropertyName = (node) => {
+    if (ts.isPropertyAccessExpression(node)) return node.name.text;
+    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
+      return staticStringValue(node.argumentExpression);
+    }
+    return null;
+  };
+  const unwrapTransparentExpression = (node) => {
+    let current = node;
+    while (
+      ts.isParenthesizedExpression(current) ||
+      ts.isAsExpression(current) ||
+      ts.isTypeAssertionExpression(current) ||
+      ts.isNonNullExpression(current)
+    ) {
+      current = current.expression;
+    }
+    return current;
+  };
+  const isInTypePosition = (node) => {
+    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
+      if (ts.isTypeNode(current)) return true;
+    }
+    return false;
+  };
+  const isReflectApplyReference = (node) =>
+    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
+    ts.isIdentifier(node.expression) &&
+    node.expression.text === "Reflect" &&
+    staticPropertyName(node) === "apply";
+  const isProcessGetBuiltinModule = (node) =>
+    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
+    ts.isIdentifier(node.expression) &&
+    node.expression.text === "process" &&
+    staticPropertyName(node) === "getBuiltinModule";
+  const isDynamicCodeReference = (node) =>
+    (ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function")) ||
+    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
+      ts.isIdentifier(node.expression) &&
+      node.expression.text === "globalThis" &&
+      (staticPropertyName(node) === "eval" || staticPropertyName(node) === "Function"));
+  const DANGEROUS_REFLECTION_PROPERTIES = new Set([
+    "constructor",
+    "__proto__",
+    "prototype",
+  ]);
+  const SAFE_INTRINSIC_PROTOTYPE_MEMBERS = new Map([
+    ["Object", new Set()],
+    ["RegExp", new Set(["exec"])],
+    ["Uint8Array", new Set(["set"])],
+    ["TextDecoder", new Set(["decode"])],
+  ]);
+  const isAllowedIntrinsicPrototypeReference = (node) => {
+    if (
+      !ts.isPropertyAccessExpression(node) ||
+      !ts.isIdentifier(node.expression) ||
+      node.name.text !== "prototype" ||
+      !SAFE_INTRINSIC_PROTOTYPE_MEMBERS.has(node.expression.text)
+    ) {
+      return false;
+    }
+    if (
+      node.expression.text === "Object" &&
+      ts.isArrayLiteralExpression(node.parent)
+    ) {
+      return true;
+    }
+    if (
+      (ts.isPropertyAccessExpression(node.parent) ||
+        ts.isElementAccessExpression(node.parent)) &&
+      node.parent.expression === node
+    ) {
+      return SAFE_INTRINSIC_PROTOTYPE_MEMBERS.get(node.expression.text).has(
+        staticPropertyName(node.parent)
+      );
+    }
+    return (
+      ts.isCallExpression(node.parent) &&
+      node.parent.arguments.includes(node) &&
+      ts.isPropertyAccessExpression(node.parent.expression) &&
+      ts.isIdentifier(node.parent.expression.expression) &&
+      node.parent.expression.expression.text === "Object" &&
+      node.parent.expression.name.text === "getPrototypeOf"
+    );
+  };
+  const containsDynamicCodeReference = (node) => {
+    if (isDynamicCodeReference(node)) return true;
+    if (
+      ts.isParenthesizedExpression(node) ||
+      ts.isAsExpression(node) ||
+      ts.isTypeAssertionExpression(node) ||
+      ts.isNonNullExpression(node)
+    ) {
+      return containsDynamicCodeReference(node.expression);
+    }
+    if (ts.isBinaryExpression(node)) {
+      return (
+        containsDynamicCodeReference(node.left) ||
+        containsDynamicCodeReference(node.right)
+      );
+    }
+    if (ts.isConditionalExpression(node)) {
+      return (
+        containsDynamicCodeReference(node.whenTrue) ||
+        containsDynamicCodeReference(node.whenFalse)
+      );
+    }
+    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
+      return containsDynamicCodeReference(node.expression);
+    }
+    return false;
+  };
+
+  for (const node of allNodes) {
+    if (
+      ts.isElementAccessExpression(node) &&
+      node.argumentExpression &&
+      staticComputedPropertyValue(node.argumentExpression) === null &&
+      !allowReviewedDynamicElementAccesses
+    ) {
+      assert.fail(`non-static element access cannot be resolved safely in ${path}`);
+    }
+    if (
+      ts.isCallExpression(node) &&
+      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
+      node.arguments.length === 1 &&
+      (ts.isStringLiteral(node.arguments[0]) ||
+        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
+      isNodeModuleSpecifier(node.arguments[0].text)
+    ) {
+      assert.fail(`dynamic node:module namespace cannot be resolved safely in ${path}`);
+    }
+    if (
+      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
+      DANGEROUS_REFLECTION_PROPERTIES.has(staticPropertyName(node)) &&
+      !isAllowedIntrinsicPrototypeReference(node)
+    ) {
+      assert.fail(`dynamic constructor or prototype capability cannot be resolved safely in ${path}`);
+    }
+    if (isProcessGetBuiltinModule(node)) {
+      assert.fail(`process.getBuiltinModule cannot be resolved safely in ${path}`);
+    }
+    if (
+      ts.isElementAccessExpression(node) &&
+      (staticPropertyName(node) === "require" || staticPropertyName(node) === "createRequire")
+    ) {
+      assert.fail(`computed runtime loader cannot be resolved safely in ${path}`);
+    }
+    if (
+      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
+      containsDynamicCodeReference(node.expression)
+    ) {
+      assert.fail(`eval or Function cannot be resolved safely in ${path}`);
+    }
+    if (
+      ts.isVariableDeclaration(node) &&
+      node.initializer &&
+      containsDynamicCodeReference(node.initializer)
+    ) {
+      assert.fail(`indirect eval or Function cannot be resolved safely in ${path}`);
+    }
+  }
+
+  const isModuleRequire = (node) =>
+    ts.isPropertyAccessExpression(node) &&
+    ts.isIdentifier(node.expression) &&
+    node.expression.text === "module" &&
+    node.name.text === "require";
+  const isCreateRequireReference = (node) =>
+    (ts.isIdentifier(node) && createRequireFactories.has(node.text)) ||
+    (ts.isPropertyAccessExpression(node) &&
+      ts.isIdentifier(node.expression) &&
+      moduleNamespaces.has(node.expression.text) &&
+      node.name.text === "createRequire");
+  const isCreateRequireCall = (node) =>
+    ts.isCallExpression(node) &&
+    isCreateRequireReference(node.expression);
+  const isLoaderExpression = (node) =>
+    (ts.isIdentifier(node) && loaderIdentifiers.has(node.text)) ||
+    isModuleRequire(node) ||
+    isCreateRequireCall(node);
+  const isNodeModuleNamespaceLoadCall = (node) => {
+    const current = unwrapTransparentExpression(node);
+    return (
+      ts.isCallExpression(current) &&
+      isLoaderExpression(current.expression) &&
+      current.arguments.length === 1 &&
+      (ts.isStringLiteral(current.arguments[0]) ||
+        ts.isNoSubstitutionTemplateLiteral(current.arguments[0])) &&
+      isNodeModuleSpecifier(current.arguments[0].text)
+    );
+  };
+
+  let changed = true;
+  while (changed) {
+    changed = false;
+    for (const node of allNodes) {
+      if (!ts.isVariableDeclaration(node) || !node.initializer) continue;
+      const unwrappedInitializer = unwrapTransparentExpression(node.initializer);
+      if (
+        ts.isIdentifier(unwrappedInitializer) &&
+        (unwrappedInitializer.text === "process" ||
+          unwrappedInitializer.text === "module" ||
+          unwrappedInitializer.text === "Reflect")
+      ) {
+        assert.fail(`indirect runtime capability cannot be resolved safely in ${path}`);
+      }
+      if (
+        ts.isIdentifier(node.name) &&
+        ts.isIdentifier(unwrappedInitializer) &&
+        unwrappedInitializer.text === "globalThis" &&
+        !globalStateAliases.has(node.name.text)
+      ) {
+        globalStateAliases.add(node.name.text);
+        changed = true;
+      }
+      if (
+        path === "lib/prisma.ts" &&
+        ts.isIdentifier(node.name) &&
+        node.name.text === "globalForPrisma" &&
+        ts.isIdentifier(unwrappedInitializer) &&
+        unwrappedInitializer.text === "global" &&
+        !nodeGlobalAliases.has(node.name.text)
+      ) {
+        // This is the one reviewed use of Node's legacy `global` alias in the
+        // runtime closure.  Bind the exact path, local name, and field below;
+        // every other `global` alias remains fail-closed.
+        nodeGlobalAliases.add(node.name.text);
+        changed = true;
+      }
+      if (
+        (ts.isIdentifier(node.name) || ts.isObjectBindingPattern(node.name)) &&
+        ts.isIdentifier(node.initializer) &&
+        moduleObjectIdentifiers.has(node.initializer.text)
+      ) {
+        assert.fail(`indirect module loader cannot be resolved safely in ${path}`);
+      }
+      if (
+        ts.isObjectBindingPattern(node.name) &&
+        ts.isCallExpression(node.initializer) &&
+        isLoaderExpression(node.initializer.expression) &&
+        node.initializer.arguments.length === 1 &&
+        ts.isStringLiteral(node.initializer.arguments[0]) &&
+        isNodeModuleSpecifier(node.initializer.arguments[0].text)
+      ) {
+        assert.ok(
+          node.name.elements.every(
+            (element) =>
+              ts.isIdentifier(element.name) &&
+              (element.propertyName?.getText(source) ?? element.name.text) ===
+                "createRequire"
+          ),
+          `node:module namespace destructuring cannot be resolved safely in ${path}`
+        );
+        for (const element of node.name.elements) {
+          if (
+            ts.isIdentifier(element.name) &&
+            (element.propertyName?.getText(source) ?? element.name.text) === "createRequire" &&
+            !createRequireFactories.has(element.name.text)
+          ) {
+            createRequireFactories.add(element.name.text);
+            changed = true;
+          }
+        }
+        continue;
+      }
+      if (!ts.isIdentifier(node.name)) continue;
+      if (
+        isReflectApplyReference(node.initializer) ||
+        (ts.isIdentifier(node.initializer) && reflectApplyIdentifiers.has(node.initializer.text))
+      ) {
+        if (!reflectApplyIdentifiers.has(node.name.text)) {
+          reflectApplyIdentifiers.add(node.name.text);
+          changed = true;
+        }
+      } else if (isCreateRequireReference(node.initializer)) {
+        if (!createRequireFactories.has(node.name.text)) {
+          createRequireFactories.add(node.name.text);
+          changed = true;
+        }
+      } else if (ts.isIdentifier(node.initializer) && moduleNamespaces.has(node.initializer.text)) {
+        if (!moduleNamespaces.has(node.name.text)) {
+          moduleNamespaces.add(node.name.text);
+          changed = true;
+        }
+      } else if (
+        ts.isCallExpression(node.initializer) &&
+        isLoaderExpression(node.initializer.expression) &&
+        node.initializer.arguments.length === 1 &&
+        ts.isStringLiteral(node.initializer.arguments[0]) &&
+        isNodeModuleSpecifier(node.initializer.arguments[0].text)
+      ) {
+        if (!moduleNamespaces.has(node.name.text)) {
+          moduleNamespaces.add(node.name.text);
+          changed = true;
+        }
+      } else if (isLoaderExpression(node.initializer) && !loaderIdentifiers.has(node.name.text)) {
+        loaderIdentifiers.add(node.name.text);
+        changed = true;
+      }
+    }
+  }
+
+  // A module namespace returned by require/module.require is a capability in
+  // exactly the same way as an imported namespace.  Do not let a direct chain
+  // bypass the namespace tracking above: `require("node:module").createRequire`
+  // and `require("module")._load` would otherwise record only the builtin and
+  // silently omit the local module loaded by the chained call.
+  for (const node of allNodes) {
+    if (
+      (ts.isPropertyAccessExpression(node) ||
+        ts.isElementAccessExpression(node)) &&
+      isNodeModuleNamespaceLoadCall(node.expression)
+    ) {
+      assert.fail(`direct node:module namespace surface cannot be resolved safely in ${path}`);
+    }
+  }
+
+  for (const node of allNodes) {
+    if (
+      (ts.isPropertyAccessExpression(node) ||
+        ts.isElementAccessExpression(node)) &&
+      ts.isIdentifier(node.expression) &&
+      moduleNamespaces.has(node.expression.text)
+    ) {
+      assert.ok(
+        ts.isPropertyAccessExpression(node) &&
+          staticPropertyName(node) === "createRequire",
+        `node:module namespace surface cannot be resolved safely in ${path}`
+      );
+    }
+  }
+
+  const SAFE_GLOBAL_STATE_PROPERTIES = new Set(["__tomverseOperationalState"]);
+  const SAFE_OPERATIONAL_STATE_FIELDS = new Set([
+    "lastNotifiedAt",
+    "dependencies",
+  ]);
+  const SAFE_OPERATIONAL_STATE_METHODS = new Set(["get", "set"]);
+  const operationalStateAliases = new Set();
+  const allowedGlobalStateAccesses = new Set();
+  const isSafeGlobalStateAccess = (node) =>
+    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
+    ts.isIdentifier(unwrapTransparentExpression(node.expression)) &&
+    (unwrapTransparentExpression(node.expression).text === "globalThis" ||
+      globalStateAliases.has(unwrapTransparentExpression(node.expression).text)) &&
+    SAFE_GLOBAL_STATE_PROPERTIES.has(staticPropertyName(node));
+  for (const node of allNodes) {
+    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
+      continue;
+    }
+    const initializer = unwrapTransparentExpression(node.initializer);
+    if (
+      !ts.isBinaryExpression(initializer) ||
+      initializer.operatorToken.kind !== ts.SyntaxKind.BarBarToken
+    ) {
+      continue;
+    }
+    const read = unwrapTransparentExpression(initializer.left);
+    const assignment = unwrapTransparentExpression(initializer.right);
+    if (
+      !isSafeGlobalStateAccess(read) ||
+      !ts.isBinaryExpression(assignment) ||
+      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
+    ) {
+      continue;
+    }
+    const write = unwrapTransparentExpression(assignment.left);
+    const initialValue = unwrapTransparentExpression(assignment.right);
+    if (
+      !isSafeGlobalStateAccess(write) ||
+      staticPropertyName(read) !== staticPropertyName(write) ||
+      !ts.isObjectLiteralExpression(initialValue)
+    ) {
+      continue;
+    }
+    operationalStateAliases.add(node.name.text);
+    allowedGlobalStateAccesses.add(read);
+    allowedGlobalStateAccesses.add(write);
+  }
+  const isTransparentAliasInitializer = (node, aliases) => {
+    let current = node;
+    while (
+      current.parent &&
+      (ts.isParenthesizedExpression(current.parent) ||
+        ts.isAsExpression(current.parent) ||
+        ts.isTypeAssertionExpression(current.parent) ||
+        ts.isNonNullExpression(current.parent)) &&
+      current.parent.expression === current
+    ) {
+      current = current.parent;
+    }
+    return (
+      ts.isVariableDeclaration(current.parent) &&
+      current.parent.initializer === current &&
+      ts.isIdentifier(current.parent.name) &&
+      aliases.has(current.parent.name.text)
+    );
+  };
+
+  for (const node of allNodes) {
+    if (isInTypePosition(node)) continue;
+
+    if (isSafeGlobalStateAccess(node)) {
+      assert.ok(
+        path === "lib/operationalMonitoring.ts" &&
+          allowedGlobalStateAccesses.has(node),
+        `global state capability cannot be resolved safely in ${path}`
+      );
+    }
+
+    if (
+      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
+      ts.isIdentifier(unwrapTransparentExpression(node.expression)) &&
+      operationalStateAliases.has(unwrapTransparentExpression(node.expression).text)
+    ) {
+      const field = staticPropertyName(node);
+      const methodAccess = node.parent;
+      assert.ok(
+        SAFE_OPERATIONAL_STATE_FIELDS.has(field) &&
+          (ts.isPropertyAccessExpression(methodAccess) ||
+            ts.isElementAccessExpression(methodAccess)) &&
+          methodAccess.expression === node &&
+          SAFE_OPERATIONAL_STATE_METHODS.has(staticPropertyName(methodAccess)) &&
+          ts.isCallExpression(methodAccess.parent) &&
+          methodAccess.parent.expression === methodAccess,
+        `operational state capability cannot be resolved safely in ${path}`
+      );
+    }
+
+    if (isReflectApplyReference(node)) {
+      const parent = node.parent;
+      assert.ok(
+        (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
+          (ts.isCallExpression(parent) && parent.expression === node),
+        `indirect Reflect.apply cannot be resolved safely in ${path}`
+      );
+    }
+
+    if (ts.isCallExpression(node)) {
+      const isReflectApply =
+        isReflectApplyReference(node.expression) ||
+        (ts.isIdentifier(node.expression) && reflectApplyIdentifiers.has(node.expression.text));
+      if (isReflectApply) {
+        assert.equal(node.arguments.length, 3, `ambiguous Reflect.apply call in ${path}`);
+      }
+    }
+
+    if (!ts.isIdentifier(node)) continue;
+    const parent = node.parent;
+    if (node.text === "eval" || node.text === "Function") {
+      assert.fail(`eval or Function cannot be resolved safely in ${path}`);
+    }
+    if (node.text === "global") {
+      // Node's `global` is an alias for globalThis.  Only Prisma's exact,
+      // field-constrained development singleton alias is reviewed.  Static
+      // element access such as global["eval"] and every new alias remain
+      // fail-closed.
+      assert.ok(
+        isTransparentAliasInitializer(node, nodeGlobalAliases),
+        `global capability cannot be resolved safely in ${path}`
+      );
+    }
+    if (node.text === "module") {
+      assert.ok(
+        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
+          parent.expression === node &&
+          staticPropertyName(parent) === "require",
+        `module capability cannot be resolved safely in ${path}`
+      );
+    }
+    if (node.text === "process") {
+      const isPropertyReceiver =
+        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
+        parent.expression === node;
+      const property = isPropertyReceiver ? staticPropertyName(parent) : null;
+      const isEnvRead = property === "env";
+      const isDirectCwdCall =
+        property === "cwd" &&
+        ts.isCallExpression(parent.parent) &&
+        parent.parent.expression === parent;
+      assert.ok(
+        isEnvRead || isDirectCwdCall,
+        `process capability cannot be resolved safely in ${path}`
+      );
+    }
+    if (node.text === "globalThis") {
+      const isSafeProperty =
+        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
+        parent.expression === node &&
+        SAFE_GLOBAL_STATE_PROPERTIES.has(staticPropertyName(parent));
+      assert.ok(
+        isSafeProperty || isTransparentAliasInitializer(node, globalStateAliases),
+        `globalThis capability cannot be resolved safely in ${path}`
+      );
+    }
+    if (node.text === "Reflect") {
+      assert.ok(
+        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
+          parent.expression === node &&
+          staticPropertyName(parent) === "apply",
+        `Reflect capability cannot be resolved safely in ${path}`
+      );
+    }
+    if (globalStateAliases.has(node.text)) {
+      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
+      const isSafeProperty =
+        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
+        parent.expression === node &&
+        SAFE_GLOBAL_STATE_PROPERTIES.has(staticPropertyName(parent));
+      assert.ok(
+        isDeclaration || isSafeProperty,
+        `globalThis alias cannot be resolved safely in ${path}`
+      );
+    }
+    if (nodeGlobalAliases.has(node.text)) {
+      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
+      const isPrismaField =
+        ts.isPropertyAccessExpression(parent) &&
+        parent.expression === node &&
+        parent.name.text === "prisma";
+      assert.ok(
+        path === "lib/prisma.ts" && (isDeclaration || isPrismaField),
+        `global alias cannot be resolved safely in ${path}`
+      );
+    }
+    if (operationalStateAliases.has(node.text)) {
+      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
+      const isSafeField =
+        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
+        parent.expression === node &&
+        SAFE_OPERATIONAL_STATE_FIELDS.has(staticPropertyName(parent));
+      assert.ok(
+        isDeclaration || isSafeField,
+        `operational state alias cannot be resolved safely in ${path}`
+      );
+    }
+    if (reflectApplyIdentifiers.has(node.text)) {
+      const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
+      const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
+      assert.ok(
+        isDeclaration || isDirectCall,
+        `indirect Reflect.apply cannot be resolved safely in ${path}`
+      );
+    }
+    if (moduleNamespaces.has(node.text)) {
+      const isVariableDeclaration =
+        ts.isVariableDeclaration(parent) && parent.name === node;
+      const isNamespaceAliasSource =
+        ts.isVariableDeclaration(parent) &&
+        parent.initializer === node &&
+        ts.isIdentifier(parent.name) &&
+        moduleNamespaces.has(parent.name.text);
+      const isDefaultImport =
+        ts.isImportClause(parent) && parent.name === node;
+      const isNamespaceImport =
+        ts.isNamespaceImport(parent) && parent.name === node;
+      const isImportEquals =
+        ts.isImportEqualsDeclaration(parent) && parent.name === node;
+      const isCreateRequireReceiver =
+        ts.isPropertyAccessExpression(parent) &&
+        parent.expression === node &&
+        parent.name.text === "createRequire";
+      assert.ok(
+        isVariableDeclaration ||
+          isNamespaceAliasSource ||
+          isDefaultImport ||
+          isNamespaceImport ||
+          isImportEquals ||
+          isCreateRequireReceiver,
+        `indirect node:module namespace use cannot be resolved safely in ${path}`
+      );
+    }
+  }
+
+  for (const node of allNodes) {
+    if (
+      ts.isElementAccessExpression(node) &&
+      ts.isIdentifier(node.expression) &&
+      (moduleObjectIdentifiers.has(node.expression.text) ||
+        moduleNamespaces.has(node.expression.text) ||
+        loaderIdentifiers.has(node.expression.text))
+    ) {
+      assert.fail(`computed runtime loader cannot be resolved safely in ${path}`);
+    }
+  }
+
+  const addLiteralSpecifier = (node) => {
+    assert.ok(node && ts.isStringLiteral(node), `non-literal runtime import in ${path}`);
+    specifiers.push(node.text);
+  };
+  const visit = (node) => {
+    if (
+      ts.isImportDeclaration(node) &&
+      ts.isStringLiteral(node.moduleSpecifier) &&
+      importDeclarationHasRuntimeValue(node)
+    ) {
+      specifiers.push(node.moduleSpecifier.text);
+    } else if (
+      ts.isExportDeclaration(node) &&
+      !node.isTypeOnly &&
+      node.moduleSpecifier &&
+      ts.isStringLiteral(node.moduleSpecifier) &&
+      (!node.exportClause ||
+        !ts.isNamedExports(node.exportClause) ||
+        node.exportClause.elements.some((element) => !element.isTypeOnly))
+    ) {
+      specifiers.push(node.moduleSpecifier.text);
+    } else if (
+      ts.isImportEqualsDeclaration(node) &&
+      !node.isTypeOnly &&
+      ts.isExternalModuleReference(node.moduleReference) &&
+      node.moduleReference.expression &&
+      ts.isStringLiteral(node.moduleReference.expression)
+    ) {
+      specifiers.push(node.moduleReference.expression.text);
+    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
+      addLiteralSpecifier(node.arguments[0]);
+    } else if (ts.isCallExpression(node) && isLoaderExpression(node.expression)) {
+      assert.equal(node.arguments.length, 1, `ambiguous runtime loader call in ${path}`);
+      addLiteralSpecifier(node.arguments[0]);
+    }
+    ts.forEachChild(node, visit);
+  };
+  visit(source);
+
+  for (const node of allNodes) {
+    if (isCreateRequireCall(node)) {
+      const parent = node.parent;
+      assert.ok(
+        (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
+          (ts.isCallExpression(parent) && parent.expression === node),
+        `indirect createRequire result cannot be resolved safely in ${path}`
+      );
+    }
+    const isLoaderIdentifier = ts.isIdentifier(node) && loaderIdentifiers.has(node.text);
+    const isFactoryReference = isCreateRequireReference(node);
+    if (!isLoaderIdentifier && !isFactoryReference && !isModuleRequire(node)) continue;
+    const parent = node.parent;
+    const isCalled = ts.isCallExpression(parent) && parent.expression === node;
+    const isAliased = ts.isVariableDeclaration(parent) && parent.initializer === node;
+    const isDeclared = ts.isVariableDeclaration(parent) && parent.name === node;
+    const isBindingDeclared = ts.isBindingElement(parent) && parent.name === node;
+    const isImportedFactory =
+      isFactoryReference &&
+      ((ts.isImportSpecifier(parent) && parent.name === node) ||
+        (ts.isNamespaceImport(parent) && parent.name === node));
+    const isPropertyPart = isModuleRequire(parent) && (parent.expression === node || parent.name === node);
+    assert.ok(
+      isCalled || isAliased || isDeclared || isBindingDeclared || isImportedFactory || isPropertyPart || isCreateRequireReference(parent),
+      `indirect runtime loader use cannot be resolved safely in ${path}: ${node.getText(source)}`
+    );
+  }
+  return specifiers;
+};
+
+const localRuntimeImports = (path) => {
+  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return [];
+  return runtimeImportSpecifiers(path, readFileSync(join(repositoryRoot, path), "utf8"), {
+    allowReviewedDynamicElementAccesses: true,
+  })
+    .map((specifier) => resolveLocalRuntimeImport(path, specifier))
+    .filter((candidate) => candidate !== null);
+};
+
+const runtimeImportClosure = () => {
+  const pending = [...PROMPT_REFINER_RUNTIME_IMPORT_ROOTS];
+  const closure = new Set();
+  while (pending.length > 0) {
+    const path = pending.shift();
+    if (closure.has(path)) continue;
+    assert.ok(existsSync(join(repositoryRoot, path)), `missing runtime import root ${path}`);
+    closure.add(path);
+    for (const imported of localRuntimeImports(path)) {
+      if (!closure.has(imported)) pending.push(imported);
+    }
+  }
+  return [...closure].sort();
+};
+
+test("runtime source allowlist is exactly the deterministic local runtime import closure", () => {
+  const dynamicAccesses = dynamicElementAccessSnapshot();
+  assert.equal(
+    dynamicAccesses.entries.length,
+    REVIEWED_DYNAMIC_ELEMENT_ACCESS_COUNT,
+    "non-static element access inventory changed; review every new or moved access"
+  );
+  assert.equal(
+    dynamicAccesses.digest,
+    REVIEWED_DYNAMIC_ELEMENT_ACCESS_SHA256,
+    "non-static element access snapshot changed; unreviewed computed access is fail-closed"
+  );
+  const expected = [...fixedNonImportPaths, ...runtimeImportClosure()];
+  assert.equal(expected.length, PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT);
+  assert.deepEqual([...PROMPT_REFINER_RUNTIME_SOURCE_PATHS], expected);
+  const actualBytes = expected.reduce((total, path) => total + statSync(join(repositoryRoot, path)).size, 0);
+  assert.ok(actualBytes > 0);
+  assert.ok(actualBytes < PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES);
+});
+
+test("closure parser binds aliases and every supported runtime module loading form", () => {
+  assert.deepEqual(
+    runtimeImportSpecifiers(
+      "fixture.ts",
+      [
+        'import type { TypeOnly } from "./type-only";',
+        'import { type NamedTypeOnly } from "./named-type-only";',
+        'export type { ExportTypeOnly } from "./export-type-only";',
+        'import "./side-effect";',
+        'import { type MixedType, runtimeValue } from "./mixed";',
+        'export { type ExportType, runtimeExport } from "./re-export";',
+        'void import("./dynamic");',
+        'require("./required");',
+        'const load = require; load("./aliased-required");',
+        'module.require("./module-required");',
+        'import requiredEquals = require("./import-equals");',
+        'import { createRequire as makeRequire } from "node:module";',
+        'const localRequire = makeRequire(import.meta.url); localRequire("./created-required");',
+        'makeRequire(import.meta.url)("./direct-created-required");',
+        'import * as ModuleApi from "node:module"; ModuleApi.createRequire(import.meta.url)("./namespace-created-required");',
+        'import ModuleDefault from "node:module"; ModuleDefault.createRequire(import.meta.url)("./default-created-required");',
+        'import { createRequire as bareMakeRequire } from "module"; bareMakeRequire(import.meta.url)("./bare-created-required");',
+        'const ModuleCjs = require("node:module"); ModuleCjs.createRequire(import.meta.url)("./cjs-created-required");',
+        'const { createRequire: cjsCreateRequire } = require("node:module"); cjsCreateRequire(import.meta.url)("./destructured-created-required");',
+      ].join("\n")
+    ),
+    [
+      "./side-effect",
+      "./mixed",
+      "./re-export",
+      "./dynamic",
+      "./required",
+      "./aliased-required",
+      "./module-required",
+      "./import-equals",
+      "node:module",
+      "./created-required",
+      "./direct-created-required",
+      "node:module",
+      "./namespace-created-required",
+      "node:module",
+      "./default-created-required",
+      "module",
+      "./bare-created-required",
+      "node:module",
+      "./cjs-created-required",
+      "node:module",
+      "./destructured-created-required",
+    ]
+  );
+  for (const unsafe of [
+    "void import(runtimePath);",
+    "const load = require; load(runtimePath);",
+    "const load = require; consume(load);",
+    "const load = module.require; consume(load);",
+    'module["require"]("./computed-module-require");',
+    'const moduleAlias = module; moduleAlias["require"]("./aliased-computed-module-require");',
+    'const moduleAlias = module; moduleAlias.require("./aliased-module-require");',
+    'const loaderName = "require"; module[loaderName]("./dynamic-computed-module-require");',
+    'import * as ModuleApi from "node:module"; const factoryName = "createRequire"; ModuleApi[factoryName](import.meta.url)("./dynamic-computed-create-require");',
+    'import * as ModuleApi from "node:module"; ModuleApi._load("./hidden");',
+    'import ModuleDefault from "node:module"; ModuleDefault._load("./hidden");',
+    'const ModuleCjs = require("module"); ModuleCjs._load("./hidden");',
+    'const { createRequire, Module } = require("node:module"); createRequire(import.meta.url)("./visible"); Module._load("./hidden");',
+    'require("node:module").createRequire(import.meta.url)("./hidden-direct-create-require");',
+    'require("module")._load("./hidden-direct-module-load", null, false);',
+    'module.require("node:module").createRequire(import.meta.url)("./hidden-module-require-create-require");',
+    'const builtinLoader = require; builtinLoader("node:module").createRequire(import.meta.url)("./hidden-aliased-builtin-create-require");',
+    'void import("node:module");',
+    'export { createRequire as make } from "node:module";',
+    'export { createRequire as make } from "module";',
+    'process.getBuiltinModule("module").createRequire(import.meta.url)("./builtin-created-require");',
+    'process["getBuiltinModule"]("module").createRequire(import.meta.url)("./computed-builtin-created-require");',
+    'const processAlias = process; processAlias.getBuiltinModule("module").createRequire(import.meta.url)("./aliased-builtin-created-require");',
+    'eval("require(\\"./hidden\\")");',
+    '(0, eval)("require(\\"./hidden\\")");',
+    'const execute = eval; execute("require(\\"./hidden\\")");',
+    'Function("return require(\\"./hidden\\")")();',
+    'new Function("return require(\\"./hidden\\")")();',
+    'globalThis.eval("require(\\"./hidden\\")");',
+    'globalThis["Function"]("return require(\\"./hidden\\")")();',
+    'global["process"]["getBuiltinModule"]("module").createRequire(import.meta.url)("./hidden-global-process");',
+    'global["eval"]("require(\\"./hidden-global-eval\\")");',
+    'global["Function"]("return require(\\"./hidden-global-function\\")")();',
+    'const nodeGlobal = global; nodeGlobal.eval("require(\\"./hidden-global-alias\\")");',
+    'const globalForPrisma = global as unknown as { prisma: unknown }; void globalForPrisma.prisma;',
+    'globalThis.__tomverseOperationalState?.constructor.constructor("return require(\\"./hidden\\")")();',
+    'const g = globalThis as any; g.__tomverseOperationalState?.loader("./hidden");',
+    '({}).constructor.constructor("return require(\\"./hidden\\")")();',
+    '({})["con" + "structor"].constructor("return require(\\"./hidden\\")")();',
+    'const key = "constructor"; ({} as any)[key][key]("return require(\\"./hidden\\")")();',
+    'const key = `con${"structor"}`; ({} as any)[key][key]("return require(\\"./hidden\\")")();',
+    'const parts = ["con", "structor"]; ({} as any)[parts.join("")][parts.join("")]("return require(\\"./hidden\\")")();',
+    'Reflect.get(module, "require")("./hidden");',
+    'process.mainModule.require("./hidden");',
+    'Reflect.apply(eval, globalThis, ["require(\\"./hidden\\")"]);',
+    'eval.call(globalThis, "require(\\"./hidden\\")");',
+    'Function.call(null, "return require(\\"./hidden\\")")();',
+    'import { createRequire } from "node:module"; consume(createRequire(import.meta.url));',
+  ]) {
+    assert.throws(
+      () => runtimeImportSpecifiers("fixture.ts", unsafe),
+      /non-literal|cannot be resolved safely/,
+      unsafe
+    );
+  }
+});
+
+test("TypeScript options and workspace metadata control local resolution", () => {
+  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@/lib/adminAudit"), "lib/adminAudit.ts");
+  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/chat-core"), "packages/chat-core/src/index.ts");
+  assert.equal(resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/ui-tokens/tokens.css"), "packages/ui-tokens/src/tokens.css");
+  assert.throws(
+    () => resolveLocalRuntimeImport("lib/promptRefinerStageAdmission.ts", "@tomverse/ui-tokens"),
+    /unresolved local workspace import/
+  );
+  for (const changed of [
+    { ...compilerOptions, paths: { ...compilerOptions.paths, "@/*": ["./shadow/*"] } },
+    { ...compilerOptions, baseUrl: join(repositoryRoot, "lib") },
+    { ...compilerOptions, rootDirs: [repositoryRoot, join(repositoryRoot, "shadow")] },
+    { ...compilerOptions, moduleSuffixes: [".native", ""] },
+  ]) {
+    assert.throws(() => assertResolutionOptions(changed), /resolution-affecting tsconfig options changed/);
+  }
+});
+
+test("TypeScript and PostgreSQL enforce the identical ordered runtime source paths", () => {
+  const migration = readFileSync(
+    join(repositoryRoot, "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql"),
+    "utf8"
+  );
+  const block = migration.match(/expected_paths CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n\s*\];/);
+  assert.ok(block, "migration expected_paths block is missing");
+  const sqlPaths = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
+  assert.equal(sqlPaths.length, PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT);
+  assert.deepEqual(sqlPaths, [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS]);
+});
diff --git a/tests/promptRefinerShadowAdmissionCore.test.mjs b/tests/promptRefinerShadowAdmissionCore.test.mjs
index bec0c6db..5d06dc87 100644
--- a/tests/promptRefinerShadowAdmissionCore.test.mjs
+++ b/tests/promptRefinerShadowAdmissionCore.test.mjs
@@ -1012,7 +1012,7 @@ const allFiles = (directory) =>
         return statSync(path).isDirectory() ? allFiles(path) : [path];
     });
 
-test("proposal core has no product, provider, credential, writer, or stage-seed caller", () => {
+test("proposal core stays pure and only the dedicated server admission boundary may call it", () => {
     const core = readFileSync(
         join(root, "lib", "promptRefinerShadowAdmissionCore.ts"),
         "utf8"
@@ -1040,11 +1040,15 @@ test("proposal core has no product, provider, credential, writer, or stage-seed
                 continue;
             }
             const content = readFileSync(path, "utf8");
+            const isDedicatedAdmissionBoundary = [
+                join("lib", "promptRefinerStageAdmission.ts"),
+                join("lib", "promptRefinerStageAdmissionCore.ts"),
+            ].some((suffix) => path.endsWith(suffix));
             assert.equal(
                 /promptRefinerShadowAdmissionCore|proposePromptRefinerShadowStage/.test(
                     content
                 ),
-                false,
+                isDedicatedAdmissionBoundary,
                 path
             );
         }
diff --git a/tests/promptRefinerStageAdmissionCore.test.mjs b/tests/promptRefinerStageAdmissionCore.test.mjs
new file mode 100644
index 00000000..fa2d16b8
--- /dev/null
+++ b/tests/promptRefinerStageAdmissionCore.test.mjs
@@ -0,0 +1,219 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+
+import {
+  PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
+  PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
+  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
+  PROMPT_REFINER_STAGE_ADMISSION_VERSION,
+  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
+  PROMPT_REFINER_STAGE_CONFIRMATION,
+  buildPromptRefinerStagePreviewBinding,
+  buildPromptRefinerRuntimeSourceManifest,
+  buildPromptRefinerStageAdmissionFacts,
+  prefixedPromptRefinerDigest,
+  promptRefinerStageAdmissionProblems,
+  promptRefinerStageApprovalWindowProblems,
+  promptRefinerStagePreviewBindingDigest,
+} from "../lib/promptRefinerStageAdmissionCore.ts";
+
+const commitSha = "a".repeat(40);
+
+const sourceFiles = () =>
+  new Map(
+    PROMPT_REFINER_RUNTIME_SOURCE_PATHS.map((path, index) => [
+      path,
+      new TextEncoder().encode(`${index}:${path}\n`),
+    ])
+  );
+
+const admissionFacts = () => {
+  const source = buildPromptRefinerRuntimeSourceManifest({
+    commitSha,
+    files: sourceFiles(),
+  });
+  return buildPromptRefinerStageAdmissionFacts({
+    runtimeCommitSha: commitSha,
+    runtimeDeploymentId: "deployment-test-1",
+    runtimeEnvironment: "staging",
+    runtimeSourceManifest: source.manifest,
+    runtimeSourceIdentityDigest: source.sourceIdentityDigest,
+    runtimeSourceManifestDigest: source.manifestDigest,
+  });
+};
+
+test("durable admission facts are deterministic, content-free, and never admit execution", () => {
+  const left = admissionFacts();
+  const right = admissionFacts();
+  assert.deepEqual(left, right);
+  assert.equal(left.admissionVersion, PROMPT_REFINER_STAGE_ADMISSION_VERSION);
+  assert.equal(left.executionManifest.executionAdmitted, false);
+  assert.equal(left.executionManifest.productAdapterReady, false);
+  assert.deepEqual(promptRefinerStageAdmissionProblems(left), []);
+  assert.equal(PROMPT_REFINER_STAGE_APPROVAL_TTL_MS, 60 * 60 * 1_000);
+  assert.match(PROMPT_REFINER_STAGE_CONFIRMATION, /60 MINUTES$/);
+  const objectKeys = [];
+  const visitKeys = (value) => {
+    if (!value || typeof value !== "object") return;
+    for (const [key, nested] of Object.entries(value)) {
+      objectKeys.push(key);
+      visitKeys(nested);
+    }
+  };
+  visitKeys(left);
+  for (const forbidden of ["promptText", "refinedText", "conversationId", "userId", "apiKey", "providerError"]) {
+    assert.equal(objectKeys.includes(forbidden), false);
+  }
+});
+
+test("runtime source manifest binds exact bytes, sizes, paths, and commit", () => {
+  const first = buildPromptRefinerRuntimeSourceManifest({ commitSha, files: sourceFiles() });
+  for (const path of [
+    "lib/adminAuditIntegrityCore.ts",
+    "lib/promptRefinerShadowAdmissionCore.ts",
+    "lib/routerDevelopmentBenchmark.ts",
+    "lib/auth.ts",
+    "lib/originProtection.ts",
+  ]) {
+    const changedFiles = sourceFiles();
+    const original = changedFiles.get(path);
+    changedFiles.set(path, Uint8Array.from([...original, 0x21]));
+    const changed = buildPromptRefinerRuntimeSourceManifest({ commitSha, files: changedFiles });
+    assert.notEqual(first.sourceIdentityDigest, changed.sourceIdentityDigest, path);
+    assert.notEqual(first.manifestDigest, changed.manifestDigest, path);
+  }
+  assert.equal(first.manifest.files.length, PROMPT_REFINER_RUNTIME_SOURCE_PATHS.length);
+  assert.equal(
+    first.manifest.totalSizeBytes,
+    [...sourceFiles().values()].reduce((total, bytes) => total + bytes.byteLength, 0)
+  );
+  assert.deepEqual(first.manifest.files.map((entry) => entry.path), [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS]);
+  assert.throws(
+    () => buildPromptRefinerRuntimeSourceManifest({ commitSha, files: new Map([...sourceFiles()].slice(1)) }),
+    /source_path_allowlist/
+  );
+  assert.throws(
+    () => buildPromptRefinerRuntimeSourceManifest({ commitSha: "not-a-commit", files: sourceFiles() }),
+    /runtime_commit_invalid/
+  );
+  const oversized = sourceFiles();
+  oversized.set(PROMPT_REFINER_RUNTIME_SOURCE_PATHS[0], new Uint8Array(6 * 1024 * 1024));
+  oversized.set(PROMPT_REFINER_RUNTIME_SOURCE_PATHS[1], new Uint8Array(6 * 1024 * 1024));
+  oversized.set(PROMPT_REFINER_RUNTIME_SOURCE_PATHS[2], new Uint8Array(6 * 1024 * 1024));
+  assert.throws(
+    () => buildPromptRefinerRuntimeSourceManifest({ commitSha, files: oversized }),
+    /runtime_source_total_size/
+  );
+  assert.equal(PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES, 8 * 1024 * 1024);
+  assert.equal(PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES, 16 * 1024 * 1024);
+});
+
+test("caller-controlled environment, deployment, and manifest drift fail closed", () => {
+  const source = buildPromptRefinerRuntimeSourceManifest({ commitSha, files: sourceFiles() });
+  const base = {
+    runtimeCommitSha: commitSha,
+    runtimeDeploymentId: "deployment-test-1",
+    runtimeEnvironment: "staging",
+    runtimeSourceManifest: source.manifest,
+    runtimeSourceIdentityDigest: source.sourceIdentityDigest,
+    runtimeSourceManifestDigest: source.manifestDigest,
+  };
+  assert.throws(() => buildPromptRefinerStageAdmissionFacts({ ...base, runtimeEnvironment: "production" }), /not_staging/);
+  assert.throws(() => buildPromptRefinerStageAdmissionFacts({ ...base, runtimeDeploymentId: "" }), /deployment_id_invalid/);
+  assert.throws(() => buildPromptRefinerStageAdmissionFacts({ ...base, runtimeSourceManifestDigest: `sha256:${"0".repeat(64)}` }), /manifest_digest_mismatch/);
+});
+
+test("preview binding digest is canonical and every deployment or budget fact is bound", () => {
+  const facts = admissionFacts();
+  const binding = buildPromptRefinerStagePreviewBinding(facts);
+  const digest = promptRefinerStagePreviewBindingDigest(binding);
+  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
+  assert.equal(
+    digest,
+    promptRefinerStagePreviewBindingDigest({
+      approvalTtlMinutes: binding.approvalTtlMinutes,
+      costCeilingMicroUsd: binding.costCeilingMicroUsd,
+      maxReservations: binding.maxReservations,
+      perRequestCostMicroUsd: binding.perRequestCostMicroUsd,
+      executionManifestDigest: binding.executionManifestDigest,
+      runtimeSourceManifestDigest: binding.runtimeSourceManifestDigest,
+      proposalDigest: binding.proposalDigest,
+      commitSha: binding.commitSha,
+      deploymentId: binding.deploymentId,
+      environment: binding.environment,
+    })
+  );
+
+  for (const changed of [
+    { environment: "staging-other" },
+    { deploymentId: "deployment-test-2" },
+    { commitSha: "b".repeat(40) },
+    { proposalDigest: `sha256:${"4".repeat(64)}` },
+    { runtimeSourceManifestDigest: `sha256:${"5".repeat(64)}` },
+    { executionManifestDigest: `sha256:${"6".repeat(64)}` },
+    { perRequestCostMicroUsd: binding.perRequestCostMicroUsd + 1 },
+    { maxReservations: binding.maxReservations + 1 },
+    { costCeilingMicroUsd: binding.costCeilingMicroUsd + 1 },
+    { approvalTtlMinutes: binding.approvalTtlMinutes + 1 },
+  ]) {
+    assert.notEqual(
+      promptRefinerStagePreviewBindingDigest({ ...binding, ...changed }),
+      digest,
+      Object.keys(changed)[0]
+    );
+  }
+});
+
+test("validation rejects fabricated runtime commit and source identity facts", () => {
+  const facts = admissionFacts();
+  assert.ok(
+    promptRefinerStageAdmissionProblems({
+      ...facts,
+      runtimeCommitSha: "b".repeat(40),
+    }).includes("runtime_commit_sha")
+  );
+
+  const fabricatedManifest = {
+    ...facts.runtimeSourceManifest,
+    commitSha: "b".repeat(40),
+  };
+  assert.ok(
+    promptRefinerStageAdmissionProblems({
+      ...facts,
+      runtimeSourceManifest: fabricatedManifest,
+      runtimeSourceManifestDigest: prefixedPromptRefinerDigest(fabricatedManifest),
+    }).includes("runtime_commit_sha")
+  );
+
+  const fabricatedFiles = facts.runtimeSourceManifest.files.map((entry, index) =>
+    index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry
+  );
+  const fabricatedSource = {
+    ...facts.runtimeSourceManifest,
+    files: fabricatedFiles,
+  };
+  assert.ok(
+    promptRefinerStageAdmissionProblems({
+      ...facts,
+      runtimeSourceManifest: fabricatedSource,
+      runtimeSourceManifestDigest: prefixedPromptRefinerDigest(fabricatedSource),
+    }).includes("runtime_source_identity_digest")
+  );
+});
+
+test("approval window is exactly 60 minutes and uses an observed clock", () => {
+  const approvedAt = new Date("2026-09-17T00:00:00.000Z");
+  const approvalExpiresAt = new Date(approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS);
+  assert.deepEqual(
+    promptRefinerStageApprovalWindowProblems({ approvedAt, approvalExpiresAt, now: new Date(approvedAt.getTime() + 1) }),
+    []
+  );
+  assert.deepEqual(
+    promptRefinerStageApprovalWindowProblems({ approvedAt, approvalExpiresAt, now: approvalExpiresAt }),
+    ["approval_expired"]
+  );
+  assert.deepEqual(
+    promptRefinerStageApprovalWindowProblems({ approvedAt, approvalExpiresAt: new Date(approvalExpiresAt.getTime() + 1), now: approvedAt }),
+    ["approval_ttl"]
+  );
+});
diff --git a/tests/promptRefinerStageAdmissionReader.test.mjs b/tests/promptRefinerStageAdmissionReader.test.mjs
new file mode 100644
index 00000000..2c47ef71
--- /dev/null
+++ b/tests/promptRefinerStageAdmissionReader.test.mjs
@@ -0,0 +1,201 @@
+import assert from "node:assert/strict";
+import { adminAuditEntryHashVariants } from "../lib/adminAuditIntegrityCore.ts";
+import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { afterEach, test } from "node:test";
+
+import {
+  PROMPT_REFINER_STAGE_FIXED_BINDINGS,
+  promptRefinerStageAuthorizationAuditEntryIsValid,
+  readExactCheckoutFile,
+  readPromptRefinerRuntimeSourceFiles,
+} from "../lib/promptRefinerStageAdmission.ts";
+import {
+  prefixedPromptRefinerDigest,
+  promptRefinerExecutionManifest,
+} from "../lib/promptRefinerStageAdmissionCore.ts";
+
+const roots = [];
+const fixture = async () => {
+  const root = await mkdtemp(join(tmpdir(), "prompt-refiner-source-"));
+  roots.push(root);
+  await writeFile(join(root, "source.txt"), "stable bytes\n");
+  return root;
+};
+
+afterEach(async () => {
+  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
+});
+
+test("fixed execution digest is derived from the single execution manifest source", () => {
+  assert.equal(
+    PROMPT_REFINER_STAGE_FIXED_BINDINGS.executionManifestDigest,
+    prefixedPromptRefinerDigest(promptRefinerExecutionManifest())
+  );
+});
+
+test("stage authorization accepts current and legacy canonical HMAC formats across key rotation", () => {
+  const oldKey = "old-audit-integrity-key";
+  const currentKey = "current-audit-integrity-key";
+  const approvedAt = new Date("2026-09-17T02:00:00.000Z");
+  const stage = {
+    id: "prompt-refiner-shadow-v1",
+    approvedBy: "mposition",
+    admissionVersion: "prompt-refiner-stage-admission-v1",
+    proposalDigest: `sha256:${"1".repeat(64)}`,
+    evidenceBundleDigest: `sha256:${"2".repeat(64)}`,
+    runtimeSourceManifestDigest: `sha256:${"3".repeat(64)}`,
+    executionManifestDigest: `sha256:${"4".repeat(64)}`,
+    runtimeEnvironment: "staging",
+    runtimeDeploymentId: "deployment-1",
+    runtimeCommitSha: "a".repeat(40),
+    perRequestCostMicroUsd: 24_916n,
+    maxReservations: 100,
+    costCeilingMicroUsd: 2_491_600n,
+    approvedAt,
+    approvalExpiresAt: new Date(approvedAt.getTime() + 60 * 60 * 1_000),
+  };
+  const metadata = {
+    admissionVersion: stage.admissionVersion,
+    proposalDigest: stage.proposalDigest,
+    evidenceBundleDigest: stage.evidenceBundleDigest,
+    runtimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
+    executionManifestDigest: stage.executionManifestDigest,
+    environment: stage.runtimeEnvironment,
+    deploymentId: stage.runtimeDeploymentId,
+    commitSha: stage.runtimeCommitSha,
+    perRequestCostMicroUsd: 24_916,
+    maxReservations: 100,
+    costCeilingMicroUsd: 2_491_600,
+    approvalTtlMinutes: 60,
+    approvedAt: stage.approvedAt.toISOString(),
+    approvalExpiresAt: stage.approvalExpiresAt.toISOString(),
+    reason: "bounded_staging_shadow_cost_approval",
+  };
+  const unsigned = {
+    actorUserId: "mposition",
+    actorEmail: "owner@example.com",
+    action: "prompt_refiner.shadow_stage.activated",
+    targetType: "PromptRefinerReservationStage",
+    targetId: stage.id,
+    summary: "Approved the bounded Prompt Refiner staging shadow stage.",
+    metadata,
+    ipAddress: null,
+    userAgent: "unit-test",
+    previousHash: "5".repeat(64),
+    entryHash: null,
+    createdAt: approvedAt,
+  };
+  const hashInput = {
+    previousHash: unsigned.previousHash,
+    actorUserId: unsigned.actorUserId,
+    actorEmail: unsigned.actorEmail,
+    action: unsigned.action,
+    targetType: unsigned.targetType,
+    targetId: unsigned.targetId,
+    summary: unsigned.summary,
+    metadata: unsigned.metadata,
+    ipAddress: unsigned.ipAddress,
+    userAgent: unsigned.userAgent,
+    createdAt: unsigned.createdAt.toISOString(),
+  };
+  const currentVariants = adminAuditEntryHashVariants(hashInput, currentKey);
+  const oldVariants = adminAuditEntryHashVariants(hashInput, oldKey);
+  const current = {
+    ...unsigned,
+    entryHash: currentVariants.codepoint,
+  };
+  const legacyPrevious = {
+    ...unsigned,
+    entryHash: oldVariants.locale,
+  };
+
+  assert.equal(
+    promptRefinerStageAuthorizationAuditEntryIsValid(stage, current, [currentKey, oldKey]),
+    true
+  );
+  assert.equal(
+    promptRefinerStageAuthorizationAuditEntryIsValid(stage, legacyPrevious, [currentKey, oldKey]),
+    true
+  );
+  assert.equal(
+    promptRefinerStageAuthorizationAuditEntryIsValid(stage, legacyPrevious, [currentKey]),
+    false
+  );
+  assert.equal(
+    promptRefinerStageAuthorizationAuditEntryIsValid(
+      { ...stage, runtimeDeploymentId: "different" },
+      current,
+      [currentKey, oldKey]
+    ),
+    false
+  );
+});
+
+test("runtime source reader returns one stable fd snapshot", async () => {
+  const root = await fixture();
+  const bytes = await readExactCheckoutFile(root, "source.txt");
+  assert.equal(Buffer.from(bytes).toString("utf8"), "stable bytes\n");
+});
+
+test("runtime source reader rejects a symlink component even when its target is inside the root", async () => {
+  const root = await fixture();
+  await mkdir(join(root, "target"));
+  await writeFile(join(root, "target", "nested.txt"), "nested\n");
+  await symlink(join(root, "target"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
+  await assert.rejects(
+    readExactCheckoutFile(root, "link/nested.txt"),
+    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR"
+  );
+});
+
+test("runtime source reader rejects a file one byte over the exact cap", async () => {
+  const root = await fixture();
+  await writeFile(join(root, "source.txt"), Buffer.alloc(65));
+  await assert.rejects(
+    readExactCheckoutFile(root, "source.txt", { maxBytes: 64 }),
+    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_SIZE"
+  );
+});
+
+test("runtime closure reader refuses before allocating past the aggregate cap", async () => {
+  const root = await mkdtemp(join(tmpdir(), "prompt-refiner-total-source-"));
+  roots.push(root);
+  await writeFile(join(root, ".gitattributes"), Buffer.alloc(8 * 1024 * 1024, 1));
+  await writeFile(join(root, "package.json"), Buffer.alloc(8 * 1024 * 1024, 2));
+  await assert.rejects(
+    readPromptRefinerRuntimeSourceFiles(root),
+    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_SIZE"
+  );
+});
+
+test("runtime source reader rejects a path swap after the fd snapshot", async () => {
+  const root = await fixture();
+  await writeFile(join(root, "replacement.txt"), "replacement\n");
+  await assert.rejects(
+    readExactCheckoutFile(root, "source.txt", {
+      hooks: {
+        afterInitialSnapshot: async () => {
+          await rename(join(root, "source.txt"), join(root, "original.txt"));
+          await rename(join(root, "replacement.txt"), join(root, "source.txt"));
+        },
+      },
+    }),
+    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_CHANGED"
+  );
+});
+
+test("runtime source reader rejects in-place size drift before the post-fstat", async () => {
+  const root = await fixture();
+  await assert.rejects(
+    readExactCheckoutFile(root, "source.txt", {
+      hooks: {
+        beforePostSnapshot: async () => {
+          await writeFile(join(root, "source.txt"), "stable bytes with mutation\n");
+        },
+      },
+    }),
+    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_CHANGED"
+  );
+});
diff --git a/tests/server-contract/admin-audit-chain-writer.test.ts b/tests/server-contract/admin-audit-chain-writer.test.ts
index 33c44874..a25d4a2b 100644
--- a/tests/server-contract/admin-audit-chain-writer.test.ts
+++ b/tests/server-contract/admin-audit-chain-writer.test.ts
@@ -91,6 +91,11 @@ let writer: typeof import("../../lib/adminAudit.ts").writeAdminAuditLog;
 
 const SECRET = "admin-audit-chain-writer-test-secret-32";
 const DATABASE_NOW = new Date("2026-09-17T01:02:03.456Z");
+const DATABASE_CLOCK_SQL =
+  "-- AdminAuditLog.createdAt is a naive timestamp. Always materialize the " +
+  "-- UTC wall clock explicitly so a non-UTC database session cannot shift " +
+  "-- the stored instant or the HMAC payload derived from it. " +
+  `SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "createdAt"`;
 
 beforeEach(async () => {
   world = {
@@ -166,7 +171,7 @@ test("inside a caller's transaction: lock, database clock, previous hash, insert
   assert.deepEqual(lock.kind === "executeRaw" && lock.values, []);
   assert.equal(
     clock.kind === "queryRaw" && clock.sql,
-    'SELECT clock_timestamp() AS "createdAt"'
+    DATABASE_CLOCK_SQL
   );
   assert.deepEqual(previous.kind === "findFirst" && previous.args, {
     where: { entryHash: { not: null } },
@@ -464,7 +469,7 @@ test("a system entry takes the same lock, clock and previous hash on the caller'
   );
   assert.equal(
     clock.kind === "queryRaw" && clock.sql,
-    'SELECT clock_timestamp() AS "createdAt"'
+    DATABASE_CLOCK_SQL
   );
 
   const metadata = { purgedCount: 1, systemActor: "marketing-retention" };
diff --git a/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts b/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
new file mode 100644
index 00000000..f62a248d
--- /dev/null
+++ b/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
@@ -0,0 +1,293 @@
+import assert from "node:assert/strict";
+import test, { mock } from "node:test";
+import { resolve } from "node:path";
+import { pathToFileURL } from "node:url";
+
+import {
+  PROMPT_REFINER_STAGE_CONFIRMATION,
+  promptRefinerStagePreviewBindingDigest,
+} from "../../lib/promptRefinerStageAdmissionCore.ts";
+import { requiresMutationOriginCheck } from "../../lib/requestOrigin.ts";
+
+const ROOT = resolve(import.meta.dirname, "..", "..");
+const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
+
+process.env.E2E_DISABLE_DATABASE = "true";
+process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
+process.env.NEXTAUTH_SECRET ||= "prompt-refiner-route-test";
+process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
+
+type World = {
+  authenticated: boolean;
+  role: string;
+  recent: boolean;
+  rateLimitCalls: number;
+  previewCalls: number;
+  createCalls: number;
+  auditWrites: number;
+  stageWrites: number;
+  lastCreate: unknown;
+  runtimeDeploymentId: string;
+};
+
+const fresh = (): World => ({
+  authenticated: true,
+  role: "owner",
+  recent: true,
+  rateLimitCalls: 0,
+  previewCalls: 0,
+  createCalls: 0,
+  auditWrites: 0,
+  stageWrites: 0,
+  lastCreate: null,
+  runtimeDeploymentId: "deployment-1",
+});
+let world = fresh();
+let installed = false;
+
+const previewFacts = {
+  stageId: "prompt-refiner-shadow-v1",
+  status: "ready_for_explicit_cost_approval",
+  proposalDigest: `sha256:${"1".repeat(64)}`,
+  runtimeSourceManifestDigest: `sha256:${"2".repeat(64)}`,
+  executionManifestDigest: `sha256:${"3".repeat(64)}`,
+  environment: "staging",
+  deploymentId: "deployment-1",
+  commitSha: "a".repeat(40),
+  perRequestCostMicroUsd: 24916,
+  maxReservations: 100,
+  costCeilingMicroUsd: 2491600,
+  approvalTtlMinutes: 60,
+} as const;
+
+const preview = {
+  ...previewFacts,
+  previewBindingDigest: promptRefinerStagePreviewBindingDigest({
+    environment: previewFacts.environment,
+    deploymentId: previewFacts.deploymentId,
+    commitSha: previewFacts.commitSha,
+    proposalDigest: previewFacts.proposalDigest,
+    runtimeSourceManifestDigest: previewFacts.runtimeSourceManifestDigest,
+    executionManifestDigest: previewFacts.executionManifestDigest,
+    perRequestCostMicroUsd: previewFacts.perRequestCostMicroUsd,
+    maxReservations: previewFacts.maxReservations,
+    costCeilingMicroUsd: previewFacts.costCeilingMicroUsd,
+    approvalTtlMinutes: previewFacts.approvalTtlMinutes,
+  }),
+  confirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
+  executionAdmitted: false,
+  productAdapterReady: false,
+};
+
+const fakeStage = {
+  id: preview.stageId,
+  status: "approved",
+  proposalDigest: preview.proposalDigest,
+  runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
+  executionManifestDigest: preview.executionManifestDigest,
+  runtimeEnvironment: "staging",
+  runtimeDeploymentId: "deployment-1",
+  runtimeCommitSha: "a".repeat(40),
+  approvedAt: new Date("2026-09-17T00:00:00.000Z"),
+  approvalExpiresAt: new Date("2026-09-17T01:00:00.000Z"),
+  authorizationAuditLogId: "audit-1",
+};
+
+async function loadRoute() {
+  if (!installed) {
+    installed = true;
+    mock.module(mod("node_modules/next-auth/next/index.js"), {
+      namedExports: {
+        getServerSession: async () =>
+          world.authenticated
+            ? { user: { id: "owner-1", email: "owner@example.com", authenticatedAt: new Date().toISOString() } }
+            : null,
+      },
+    });
+    mock.module(mod("lib/adminAuth.ts"), {
+      namedExports: {
+        isAdminSession: () => world.authenticated,
+        getAdminRole: () => world.role,
+      },
+    });
+    mock.module(mod("lib/adminReauthentication.ts"), {
+      namedExports: {
+        assertRecentAdminAuthentication: async () => {
+          if (!world.recent) throw new Error("reauth");
+        },
+        isAdminReauthenticationError: (error: unknown) =>
+          error instanceof Error && error.message === "reauth",
+      },
+    });
+    const { createRequire } = await import("node:module");
+    const require = createRequire(import.meta.url);
+    const realSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
+    mock.module(mod("lib/apiSecurity.ts"), {
+      namedExports: {
+        ...realSecurity,
+        consumeApiRateLimit: async () => {
+          world.rateLimitCalls += 1;
+        },
+      },
+    });
+    mock.module(mod("lib/promptRefinerStageAdmission.ts"), {
+      namedExports: {
+        promptRefinerStagePreview: async () => {
+          world.previewCalls += 1;
+          return preview;
+        },
+        createPromptRefinerReservationStage: async (input: unknown) => {
+          world.createCalls += 1;
+          world.lastCreate = input;
+          const expected = (input as { expected: { previewBindingDigest: string } }).expected;
+          const currentBindingDigest = promptRefinerStagePreviewBindingDigest({
+            environment: preview.environment,
+            deploymentId: world.runtimeDeploymentId,
+            commitSha: preview.commitSha,
+            proposalDigest: preview.proposalDigest,
+            runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
+            executionManifestDigest: preview.executionManifestDigest,
+            perRequestCostMicroUsd: preview.perRequestCostMicroUsd,
+            maxReservations: preview.maxReservations,
+            costCeilingMicroUsd: preview.costCeilingMicroUsd,
+            approvalTtlMinutes: preview.approvalTtlMinutes,
+          });
+          if (expected.previewBindingDigest !== currentBindingDigest) {
+            throw Object.assign(new Error("Approval preview no longer matches this deployment."), {
+              status: 409,
+              code: "PROMPT_REFINER_STAGE_PREVIEW_STALE",
+            });
+          }
+          world.auditWrites += 1;
+          world.stageWrites += 1;
+          return { created: true, replayed: false, stage: fakeStage };
+        },
+        promptRefinerStageAdmissionErrorResponse: (error: unknown) => {
+          if (
+            !error ||
+            typeof error !== "object" ||
+            !("status" in error) ||
+            !("code" in error) ||
+            !(error instanceof Error)
+          ) {
+            return null;
+          }
+          return Response.json(
+            { error: error.message, code: error.code },
+            { status: Number(error.status) }
+          );
+        },
+      },
+    });
+  }
+  return import(`${mod("app/api/admin/prompt-refiner/shadow-stage/route.ts")}?cached`);
+}
+
+const post = (body: unknown) =>
+  new Request("http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-stage", {
+    method: "POST",
+    headers: { "Content-Type": "application/json" },
+    body: JSON.stringify(body),
+  });
+
+const validBody = () => ({
+  proposalDigest: preview.proposalDigest,
+  runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
+  executionManifestDigest: preview.executionManifestDigest,
+  previewBindingDigest: preview.previewBindingDigest,
+  confirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
+});
+
+test.beforeEach(() => {
+  world = fresh();
+});
+
+test("the global origin guard covers the POST while GET remains read-only", () => {
+  const path = "/api/admin/prompt-refiner/shadow-stage";
+  assert.equal(requiresMutationOriginCheck("POST", path), true);
+  assert.equal(requiresMutationOriginCheck("GET", path), false);
+});
+
+test("admin surface stays hidden and owner-only with recent authentication", async () => {
+  const route = await loadRoute();
+  world.authenticated = false;
+  assert.equal((await route.GET()).status, 404);
+  world.authenticated = true;
+  world.role = "ops";
+  assert.equal((await route.GET()).status, 403);
+  world.role = "owner";
+  world.recent = false;
+  assert.equal((await route.GET()).status, 428);
+  assert.equal(world.previewCalls, 0);
+});
+
+test("GET is a no-write content-free preview", async () => {
+  const route = await loadRoute();
+  const response = await route.GET();
+  assert.equal(response.status, 200);
+  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
+  assert.equal(world.rateLimitCalls, 0);
+  assert.equal(world.createCalls, 0);
+  assert.equal(world.auditWrites, 0);
+  assert.equal(world.stageWrites, 0);
+  assert.deepEqual(await response.json(), { preview });
+});
+
+test("POST requires the fixed confirmation and strict 4 KiB schema", async () => {
+  const route = await loadRoute();
+  const wrong = await route.POST(post({ ...validBody(), confirmation: "yes" }));
+  assert.equal(wrong.status, 400);
+  const extra = await route.POST(post({ ...validBody(), approvedBy: "attacker" }));
+  assert.equal(extra.status, 400);
+  const callerReason = await route.POST(post({ ...validBody(), reason: "caller-controlled" }));
+  assert.equal(callerReason.status, 400);
+  const missingBinding = { ...validBody() };
+  delete (missingBinding as { previewBindingDigest?: string }).previewBindingDigest;
+  assert.equal((await route.POST(post(missingBinding))).status, 400);
+  const oversized = await route.POST(post({ ...validBody(), confirmation: "x".repeat(5000) }));
+  assert.equal(oversized.status, 413);
+  assert.equal(world.createCalls, 0);
+});
+
+test("POST forwards only frozen digests and server session to the dedicated writer", async () => {
+  const route = await loadRoute();
+  const oldFetch = globalThis.fetch;
+  globalThis.fetch = async () => {
+    throw new Error("network must not be called");
+  };
+  try {
+    const response = await route.POST(post(validBody()));
+    assert.equal(response.status, 201);
+    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
+    assert.equal(world.rateLimitCalls, 1);
+    assert.equal(world.createCalls, 1);
+    const forwarded = world.lastCreate as Record<string, unknown>;
+    assert.deepEqual(forwarded.expected, {
+      proposalDigest: preview.proposalDigest,
+      runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
+      executionManifestDigest: preview.executionManifestDigest,
+      previewBindingDigest: preview.previewBindingDigest,
+    });
+    assert.equal("approvedBy" in forwarded, false);
+    assert.equal("approvedAt" in forwarded, false);
+    const body = await response.json();
+    assert.equal(body.stage.executionAdmitted, false);
+    assert.equal(body.stage.productAdapterReady, false);
+  } finally {
+    globalThis.fetch = oldFetch;
+  }
+});
+
+test("same commit and source from a different deployment rejects the stale preview before writes", async () => {
+  const route = await loadRoute();
+  world.runtimeDeploymentId = "deployment-2";
+  const response = await route.POST(post(validBody()));
+  assert.equal(response.status, 409);
+  assert.deepEqual(await response.json(), {
+    error: "Approval preview no longer matches this deployment.",
+    code: "PROMPT_REFINER_STAGE_PREVIEW_STALE",
+  });
+  assert.equal(world.createCalls, 1);
+  assert.equal(world.auditWrites, 0);
+  assert.equal(world.stageWrites, 0);
+});

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/promptInjectionAudit.test.mjs tests/promptRefinerAccess.test.mjs tests/promptRefinerExecutionContract.test.mjs tests/promptRefinerReceiptCore.test.mjs tests/promptRefinerReservationCore.test.mjs tests/promptRefinerRuntimeSourceClosure.test.mjs tests/promptRefinerShadowAdmissionCore.test.mjs tests/promptRefinerStageAdmissionCore.test.mjs tests/promptRefinerStageAdmissionReader.test.mjs tests/promptRefinerSuggestion.test.mjs` (7323ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 7231.7192

## Guard results (run by the control program)

- PASS `npm run test:prompt-refiner-shadow` (28375ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 27821.2531
- PASS `node --conditions=react-server --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-reporter=spec tests/server-contract/admin-audit-chain-writer.test.ts tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts` (3518ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 3427.3735
- PASS `npm run typecheck -- --pretty false` (42481ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false --pretty false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npx eslint $(git diff --name-only c49d5a3606f259356612ddc5872f29f5fe465158 HEAD -- '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx') --max-warnings=0` (3821ms)
- PASS `npx prisma validate` (2051ms)
  The schema at prisma\schema.prisma is valid 🚀
- PASS `npm run security:regression` (636ms)
  > ai-chat-hub@0.1.0 security:regression
  > node scripts/security-regression-check.mjs
  
  Security regression checks passed (190 checks).
- PASS `npm run check:model-pricing` (778ms)
  > ai-chat-hub@0.1.0 check:model-pricing
  > node --import tsx scripts/check-model-pricing.mjs
  
  
  Model pricing check passed: 36 explicit profiles, 0 model(s) on a conservative fallback, 0 unpriced premium models, 0 register warning(s), 0 expired pending prices.
- PASS `npm run check:enum-constraints` (1076ms)
  > ai-chat-hub@0.1.0 check:enum-constraints
  > node --conditions=react-server --import tsx scripts/check-enum-constraints.mjs
  
  Enum constraint check passed: 115 closed list(s) in the schema — 59 compared against an application list, 22 held only as a TypeScript union, 34 written down only in the database.
- PASS `npm run check:db-integration-coverage` (547ms)
  > ai-chat-hub@0.1.0 check:db-integration-coverage
  > node scripts/check-db-integration-coverage.mjs
  
  DB integration coverage check passed: 132 suite(s) in tests/integration/, all 132 named by the runner.
- PASS `npm run check:doc-references` (1481ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 898 referenced path(s) across 116 instruction document(s), and 1009 path(s) named by comments across 3025 source file(s), all present.
- PASS `npm run check:policy-section-references` (1192ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4547 citation(s) against 38 policy document(s). 2980 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1334 and 233 predate this change).
- PASS `npm run check:encoding:strict` (1398ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `npm run check:data-domain-registry` (775ms)
  y\tomverse-chat-data-domain-registry.yaml: 66 data domains, all user-linked models registered.
     Deletion action: 49 delete, 9 anonymise, 2 unverified, 6 retain.
     Retention policy: 56 immediate, 2 unverified, 2 ttl, 3 statutory, 3 legal_hold.
     2 domain(s) have an unverified deletion path and 2 an unverified export state; PRIVACY-01/02 stay blocked until each is traced or recorded as retained.
- PASS `npm run check:prompt-injection` (778ms)
  adversarial_retrieved_content_instruction_precedence_violations = 0
  18 adversarial payload(s) through memory (18), attachment (18), attachment-filename (18), profile-knowledge (18), prompt-refiner (18)
  not exercised: project (ConversationProject has a name and no instruction text, so no prompt path exists)
  Untrusted content stayed data at every fenced and role-separated boundary.
- PASS `npm run check:api-cache-control` (721ms)
  > ai-chat-hub@0.1.0 check:api-cache-control
  > node --conditions=react-server --import tsx scripts/check-api-cache-control.mjs
  
  API cache-control check passed: 212 route(s), 5 choosing their own caching, every one of them listed.
- PASS `node --test tests/unsweptTables.test.mjs` (174ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 82.5912
- PASS `git diff --check c49d5a3606f259356612ddc5872f29f5fe465158 HEAD -- .` (101ms)
- PASS `git diff --quiet ce10fb4ba70d69e72d80745cc4960fa0bf83bbd4 HEAD -- lib/crossReviewCore.ts lib/crossReviewExecutors.ts scripts/cross-review.mjs docs/ops/cross-review/README.md docs/ops/cross-review/packages ':(exclude)docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.task.json' ':(exclude)docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-v1.authorization.md'` (57ms)

## Findings from the previous round (check each was addressed)

- [warning/evidence] docs/ops/tomverse-chat-progress.md:1198: The only committed record of this round's fresh-database verification states "전체 121 migration" and "관련 DB 31/31", but the submitted source contains 124 migrations and 35 prompt-refiner DB integration tests, so the recorded run either misreports its numbers or was executed against an earlier source than 738e029e (which added the monotonic-audit-liveness tests), leaving the submitted source without a matching recorded PostgreSQL 17 verification.
- [nit/evidence] docs/ops/tomverse-chat-progress.md:1200 and docs/ops/prompt-refiner-durable-stage-writer-contract.md §9: Three committed documents state the independent review package has not been created yet, while the same delivery commits that package.
- [nit/evidence] prisma/migrations/20260917190000_prompt_refiner_stage_admission/migration.sql: The new migration's timestamp sorts before three migrations already present on the base commit, so the fresh-database order that was verified is not the order an already-deployed database will apply it in.

## Author's account (read last; a claim, not a finding)

Summary: Round 1 addresses all three reproduced round-0 findings while preserving the default-off product boundary. The PostgreSQL 17 author-evidence record now names the submitted source counts (124 migrations, drift 0, 35/35 related DB integration, admin audit 19/19, route contract 6/6); the three stale package-not-yet-created statements now bind to round-0 digest sha256:989e42217bfe82d3ff36de280b383d4563f0ab6475ffa2fb51b4b4fae74f5cdc and request_changes; and the stage migration is renamed after the base migrations to 20260918130000 with its exact runtime-closure references updated. The implementation source is 58d3e1617940c0c8c6ecffd5be993a0396460bdb; HEAD 36361085a65e60e451ac392a98afef17db4b4905 rebinds the current task and authorization and retains the round-0 migration source path as historical-only scope so controller replay covers the rename. The current reviewed diff remains exactly 32 files, writableScope union is 33 exact paths with one absent historical-only path, generatedPaths is empty, and no diff is excluded. Package checks are provider-free and credential-free; fresh database results remain cited author evidence rather than a package guard. No product caller, provider/model call, external or Railway API call, credential lookup, rollout, deployment, reservation/receipt execution, actual spending, Claude invocation, push, merge, or deploy occurs.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-durable-stage-writer-v1",
  "round": 1,
  "reviewedDigest": "sha256:61d4dfbbdf9450b08e268d123a6968ee6a6170acebb009a9a84f22f39621a0ce",
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
