# Independent review — task prompt-refiner-reservation-authority-v1, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Prompt Refiner를 제품에서 활성화하거나 provider를 호출하지 않은 채 첫 shadow 실행을 위한 durable reservation authority를 구현한다. 데이터베이스가 유일한 slot·최악비용 accounting owner여야 하며, 고정 stage 한 개에서 최대 100개의 영구 tombstone과 총 2491600 microUSD만 허용한다. requestId·stageId·canonical contract digest·server-minted reservationId를 정확히 결속하고, stage row→ModelRegistryEntry table SHARE→reservation row 잠금 순서와 잠금 뒤 DB clock을 사용해 runtime model/pricing drift, 5분 TTL, terminal 전이, 1회 consume을 fail-closed한다. 실제 tombstone 집계와 stage counter를 원자적으로 결속하고 direct·batch·unique-conflict·동시 insert가 100-slot/비용 상한을 우회하지 못하게 한다. 기존 Prompt Refiner v1은 admitted:false와 reservation_authority_unavailable을 유지하며 stage seed/admin writer, 제품/API/script runtime caller, provider adapter/model 호출, flag 활성화, Router 결합, 유료 실행은 포함하지 않는다. author는 codex, reviewer는 claude이며 사용자가 승인한 --skip-preflight 예외 아래 Claude Code Max 구독 CLI의 Read·Grep·Glob만 사용한다.

## Completion criteria

- 고정 stage는 prompt-refiner-shadow-v1 한 행뿐이고 0/0 accounting으로 시작한다. 요청당 24916 microUSD, 최대 100개, 총 2491600 microUSD와 approved/closed lifecycle이 DB constraint·trigger·canonical digest에 정확히 고정된다.
- reservation BEFORE INSERT는 정확한 초기 상태·request/stage/digest/cost·5분 TTL을 검증하고 stage를 잠그되 성공 전 accounting을 만들지 않는다. AFTER INSERT statement trigger만 이미 보이는 durable tombstone의 count/sum으로 stage accounting을 갱신하며 direct counter UPDATE, unique conflict, ON CONFLICT DO NOTHING, 다중 insert와 101번째 insert가 phantom slot 또는 초과 지출을 만들지 않는다.
- authority mutation의 잠금 순서는 stage row→ModelRegistryEntry table SHARE→reservation row다. pinned registry row가 없거나 INSERT/UPDATE/DELETE가 경합하는 경우도 runtime model·effective pricing 검증과 consume 사이에 drift가 끼어들 수 없고 실패한 transaction은 reservation과 accounting을 함께 rollback한다.
- requestId·stageId·canonical contract digest·server-minted reservationId 네 identity가 모두 맞아야 한다. 같은 active request는 새 slot 없이 같은 fact를 반환하고 terminal request는 non-success이며 released/expired/consumed tombstone은 삭제·환급·재사용되지 않는다.
- DB trigger가 terminal timestamp를 소유한다. 잠금 뒤 clock_timestamp() 기준으로 조기 expire와 timestamp 위조를 거부하고, deadline을 넘긴 consume/release는 expired tombstone으로 저장하며 consume race에서는 정확히 한 번만 성공한다.
- authority table·반환값은 prompt/content/user/conversation/provider 오류를 저장하지 않는다. migration에는 stage seed가 없고 제품/API/script import, runtime writer, provider/model/API 호출, AppSetting·flag 활성화가 없으며 기존 v1에는 admitted:true 경로가 없다.
- Prisma schema diff는 PromptRefinerReservationStage와 PromptRefinerReservation 신규 model 44줄뿐이고 enum·DB integration lane·bounded retention registry가 migration과 일치한다. 최신 develop의 MemoryExtractionChunk skipped 상태와 다른 기존 계약을 보존한다.
- focused Prompt Refiner 42개, 전체 typecheck, 변경 파일 lint, Prisma validate, model-pricing, enum constraint, DB integration coverage, 문서·정책 참조, strict encoding과 diff whitespace guard가 모두 통과한다. 별도 로컬 PostgreSQL 17에서 최신 112 migrations·drift 0·authority DB 15/15가 확인됐고, full finance 비교의 17개 실패는 base에도 동일한 기존 실패이며 신규 authority 실패는 0이다.
- Claude reviewer는 요구사항과 실제 diff를 먼저 읽고 검사 기록과 작성자 요약을 뒤에 읽는다. verdict는 package digest를 정확히 명시하고 finding마다 location·severity·basis·재현 절차를 제공한다. 최초 검토와 최대 2회 수정 검토만 허용하며 actionable finding이 남으면 on_hold다.
- Claude 독립 검토는 사용자가 이번 작업에 승인한 --skip-preflight 예외만 사용한다. 같은 프로세스에서 ANTHROPIC_API_KEY와 ANTHROPIC_AUTH_TOKEN을 제거하고 claude auth status가 authMethod=claude.ai, subscriptionType=max임을 확인한 뒤 Claude Code Max 구독 CLI를 Read·Grep·Glob only로 실행한다. Anthropic API key fallback, provider 호출, 과금 benchmark, push·merge·deploy는 승인하지 않는다.
- Multi-round 감사기록을 보존하기 위해 docs/ops/cross-review/packages/ parent를 control-program writable scope로 선언한다. 이는 기능 writable source 확대가 아니며 own output directory는 매 round --diff-exclude되고 generatedPaths에는 넣지 않는다. Round 1의 filesChanged tree scope는 source 16개와 커밋된 round 0 audit record 7개를 합친 23개일 수 있지만, reviewed diff와 changeDigest는 source 16개만 포함해야 한다.

## Change under review — digest sha256:a5f0919eaae5f83bbb3cda4bdbaf7d6c09c756fecac9c467e85bbc4864af30a7, commit 73043d0ba46fa3225a9c0a63e9a5393c9359bdd8

```diff
diff --git a/.github/workflows/credit-finance-db-integration.yml b/.github/workflows/credit-finance-db-integration.yml
index 529763ed..9c34a9b9 100644
--- a/.github/workflows/credit-finance-db-integration.yml
+++ b/.github/workflows/credit-finance-db-integration.yml
@@ -8,6 +8,8 @@ on:
       - "lib/credit*.ts"
       - "lib/billing*.ts"
       - "lib/stripe*.ts"
+      - "lib/promptRefinerReservation*.ts"
+      - "lib/promptRefinerExecutionContract.ts"
       - "lib/adminUsers.ts"
       - "lib/userTimeZone.ts"
       - "app/api/billing/**"
diff --git a/AGENTS.md b/AGENTS.md
index 64602562..57d286c1 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1344,14 +1344,32 @@ Non-negotiable requirements:
   output cap must be at least 4,096; a larger capability is allowed but never
   replaces the Refiner request's exact 4,096 cap. Caching is disabled, and the
   generic model reservation-output setting must not reduce this contract's
-  4,096-token worst-case reservation. A future authority must pass its runtime
-  model row through this gate in the same critical path before reservation and
-  dispatch. No reservation authority exists today, so
-  admission always refuses before dispatch with
-  `reservation_authority_unavailable` after earlier checks pass. A caller-made
-  lease or atomic boolean is never proof. Only a future authority with atomic
-  requestId binding, expiry and one-time consume may introduce `admitted: true`
-  under a new contract version. Product mode remains unadmitted.
+  4,096-token worst-case reservation. The standalone server-only authority
+  passes its runtime model row through this gate inside both reserve and
+  consume. Its global order is fixed stage row, model-registry table SHARE,
+  then reservation row, covering both an existing registry row and an
+  absent-row insert. The reservation BEFORE INSERT trigger validates and locks;
+  only the AFTER INSERT trigger may bind counters to the exact aggregate of
+  already-visible tombstones. A stage must start at zero, and a direct stage
+  counter update therefore cannot mint a slot. Direct inserts, unique conflicts
+  and the 101st row cannot bypass or split accounting. The database also owns
+  terminal timestamps and turns a late consume/release into expiry. It binds
+  requestId + stage + canonical
+  contract digest + server-minted reservation id. Naive DB timestamp columns
+  compare and store only `clock_timestamp() AT TIME ZONE 'UTC'`; expiry sweeps
+  filter and order in SQL and apply their caller limit before `FOR UPDATE`, so
+  the limit bounds both mutation count and lock footprint. One-time consume and
+  permanent terminal tombstones remain DB-enforced.
+  A repeated request returns the existing active fact before stage/runtime
+  revalidation; a terminal fact is a discriminated non-success and is never a
+  reusable lease. A future dispatch must use the exact digest returned by
+  consume together with the checked-in execution/reservation contract constants,
+  and must not reload/reinterpret the registry after that boundary. It has no stage
+  seed/admin writer, product caller or provider path. Existing v1 admission
+  therefore still refuses before dispatch with
+  `reservation_authority_unavailable`; a caller-made lease or atomic boolean is
+  never proof. Only a separately approved new contract may connect an
+  authority consumed fact to `admitted: true`. Product mode remains unadmitted.
 - The current server gate folds the default-off AppSetting, environment kill
   switch and adapter readiness into one mode. The only active mode is the
   loopback E2E fixture; a stored flag alone must never expose an inert product
diff --git a/docs/ops/cross-review/packages/prompt-refiner-reservation-authority-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-reservation-authority-v1.task.json
new file mode 100644
index 00000000..12749300
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-reservation-authority-v1.task.json
@@ -0,0 +1,37 @@
+{
+  "taskId": "prompt-refiner-reservation-authority-v1",
+  "requirement": "Prompt Refiner를 제품에서 활성화하거나 provider를 호출하지 않은 채 첫 shadow 실행을 위한 durable reservation authority를 구현한다. 데이터베이스가 유일한 slot·최악비용 accounting owner여야 하며, 고정 stage 한 개에서 최대 100개의 영구 tombstone과 총 2491600 microUSD만 허용한다. requestId·stageId·canonical contract digest·server-minted reservationId를 정확히 결속하고, stage row→ModelRegistryEntry table SHARE→reservation row 잠금 순서와 잠금 뒤 DB clock을 사용해 runtime model/pricing drift, 5분 TTL, terminal 전이, 1회 consume을 fail-closed한다. 실제 tombstone 집계와 stage counter를 원자적으로 결속하고 direct·batch·unique-conflict·동시 insert가 100-slot/비용 상한을 우회하지 못하게 한다. 기존 Prompt Refiner v1은 admitted:false와 reservation_authority_unavailable을 유지하며 stage seed/admin writer, 제품/API/script runtime caller, provider adapter/model 호출, flag 활성화, Router 결합, 유료 실행은 포함하지 않는다. author는 codex, reviewer는 claude이며 사용자가 승인한 --skip-preflight 예외 아래 Claude Code Max 구독 CLI의 Read·Grep·Glob만 사용한다.",
+  "completionCriteria": [
+    "고정 stage는 prompt-refiner-shadow-v1 한 행뿐이고 0/0 accounting으로 시작한다. 요청당 24916 microUSD, 최대 100개, 총 2491600 microUSD와 approved/closed lifecycle이 DB constraint·trigger·canonical digest에 정확히 고정된다.",
+    "reservation BEFORE INSERT는 정확한 초기 상태·request/stage/digest/cost·5분 TTL을 검증하고 stage를 잠그되 성공 전 accounting을 만들지 않는다. AFTER INSERT statement trigger만 이미 보이는 durable tombstone의 count/sum으로 stage accounting을 갱신하며 direct counter UPDATE, unique conflict, ON CONFLICT DO NOTHING, 다중 insert와 101번째 insert가 phantom slot 또는 초과 지출을 만들지 않는다.",
+    "authority mutation의 잠금 순서는 stage row→ModelRegistryEntry table SHARE→reservation row다. pinned registry row가 없거나 INSERT/UPDATE/DELETE가 경합하는 경우도 runtime model·effective pricing 검증과 consume 사이에 drift가 끼어들 수 없고 실패한 transaction은 reservation과 accounting을 함께 rollback한다.",
+    "requestId·stageId·canonical contract digest·server-minted reservationId 네 identity가 모두 맞아야 한다. 같은 active request는 새 slot 없이 같은 fact를 반환하고 terminal request는 non-success이며 released/expired/consumed tombstone은 삭제·환급·재사용되지 않는다.",
+    "DB trigger가 terminal timestamp를 소유한다. 잠금 뒤 clock_timestamp() 기준으로 조기 expire와 timestamp 위조를 거부하고, deadline을 넘긴 consume/release는 expired tombstone으로 저장하며 consume race에서는 정확히 한 번만 성공한다.",
+    "authority table·반환값은 prompt/content/user/conversation/provider 오류를 저장하지 않는다. migration에는 stage seed가 없고 제품/API/script import, runtime writer, provider/model/API 호출, AppSetting·flag 활성화가 없으며 기존 v1에는 admitted:true 경로가 없다.",
+    "Prisma schema diff는 PromptRefinerReservationStage와 PromptRefinerReservation 신규 model 44줄뿐이고 enum·DB integration lane·bounded retention registry가 migration과 일치한다. 최신 develop의 MemoryExtractionChunk skipped 상태와 다른 기존 계약을 보존한다.",
+    "focused Prompt Refiner 42개, 전체 typecheck, 변경 파일 lint, Prisma validate, model-pricing, enum constraint, DB integration coverage, 문서·정책 참조, strict encoding과 diff whitespace guard가 모두 통과한다. 별도 로컬 PostgreSQL 17에서 최신 112 migrations·drift 0·authority DB 15/15가 확인됐고, full finance 비교의 17개 실패는 base에도 동일한 기존 실패이며 신규 authority 실패는 0이다.",
+    "Claude reviewer는 요구사항과 실제 diff를 먼저 읽고 검사 기록과 작성자 요약을 뒤에 읽는다. verdict는 package digest를 정확히 명시하고 finding마다 location·severity·basis·재현 절차를 제공한다. 최초 검토와 최대 2회 수정 검토만 허용하며 actionable finding이 남으면 on_hold다.",
+    "Claude 독립 검토는 사용자가 이번 작업에 승인한 --skip-preflight 예외만 사용한다. 같은 프로세스에서 ANTHROPIC_API_KEY와 ANTHROPIC_AUTH_TOKEN을 제거하고 claude auth status가 authMethod=claude.ai, subscriptionType=max임을 확인한 뒤 Claude Code Max 구독 CLI를 Read·Grep·Glob only로 실행한다. Anthropic API key fallback, provider 호출, 과금 benchmark, push·merge·deploy는 승인하지 않는다.",
+    "Multi-round 감사기록을 보존하기 위해 docs/ops/cross-review/packages/ parent를 control-program writable scope로 선언한다. 이는 기능 writable source 확대가 아니며 own output directory는 매 round --diff-exclude되고 generatedPaths에는 넣지 않는다. Round 1의 filesChanged tree scope는 source 16개와 커밋된 round 0 audit record 7개를 합친 23개일 수 있지만, reviewed diff와 changeDigest는 source 16개만 포함해야 한다."
+  ],
+  "baseCommit": "5b4b6c6daead506ffd77a25888abe3a5e932f57c",
+  "writableScope": [
+    ".github/workflows/credit-finance-db-integration.yml",
+    "AGENTS.md",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "docs/ui-contracts/prompt-refiner-suggestion.md",
+    "lib/promptRefinerReservationAuthority.ts",
+    "lib/promptRefinerReservationCore.ts",
+    "prisma/migrations/20260916120000_prompt_refiner_reservation_authority/migration.sql",
+    "prisma/schema.prisma",
+    "scripts/check-enum-constraints.mjs",
+    "scripts/db-integration-groups.mjs",
+    "scripts/report-unswept-tables-core.mjs",
+    "scripts/run-db-integration-tests.mjs",
+    "tests/integration/prompt-refiner-reservation.db.test.ts",
+    "tests/promptRefinerReservationCore.test.mjs",
+    "docs/ops/cross-review/packages/"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 9dbaa542..7e4318bd 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -980,3 +980,60 @@ provider adapter/API/model 호출, product mode, Router 배선, AppSetting write
    비용·지연을 측정한다.
 4. 승인된 증거가 있을 때만 제안형 UI를 연결하고, 그 뒤 Refiner 결과의 Router 결합과
    전체 카탈로그 선택 품질을 별도 측정한다.
+
+## 2026-09-16 Prompt Refiner durable reservation authority 회차
+
+앞 회차의 다음 순서 ①을 provider 호출 없이 구현했다. append-only migration은 고정
+stage 한 행과 최대 100개의 content-free reservation tombstone만 허용한다. stage는
+요청당 24,916 microUSD, 최대 100개, 총 2,491,600 microUSD를 DB constraint와
+transaction 양쪽에서 강제하며 migration에는 seed가 없다. reservation `BEFORE INSERT`
+trigger는 검증·stage 잠금만 수행하고, 성공한 tombstone이 보이는 `AFTER INSERT` trigger만
+stage counter를 실제 행 집계에 맞춘다. stage는 0/0에서만 생성되며 direct counter UPDATE로
+slot을 만들 수 없다. direct insert도 예산을 쓰고 unique 충돌·위조·101번째 insert는 행과
+accounting을 함께 rollback한다. terminal timestamp도 DB trigger가 소유하고 만료 뒤 direct
+consume/release는 expired tombstone이 된다. authority는 stage row→
+model registry table `SHARE`→reservation row 순서로 잠근 뒤 requestId·stage·canonical
+contract digest·server-minted reservationId를 결속한다. digest에는 stage와 reservation
+lifecycle 상태 집합이 모두 포함된다. naive DB timestamp에는 명시적
+`clock_timestamp() AT TIME ZONE 'UTC'`를 사용하고, expiry sweep은 DB에서 만료 필터·
+정렬·limit을 `FOR UPDATE` 전에 적용해 lock footprint도 limit 이하로 묶는다. 잠금 뒤 DB clock 기반
+5분 만료와 1회 CAS consume을 사용하며
+consumed/released/expired 행을 삭제·환급·재사용하지 않는다.
+
+reserve와 consume의 같은 critical path에서 runtime model registry row와 effective
+pricing을 실행 계약에 다시 대조하므로 환경 가격 override나 registry drift가 있으면
+슬롯 생성 또는 사용 전에 fail-closed한다. existing request는 stage/runtime 재검증보다
+먼저 같은 active fact 또는 terminal non-success fact를 돌려주며 새 슬롯으로 재사용하지
+않는다. 미래 dispatch는 consume이 반환한 exact digest와 checked-in execution/reservation
+contract constants를 쓰고 registry를
+다시 읽지 않는다. authority는 prompt/content/user/
+conversation/provider 오류를 저장하지 않고 reserve/consume/release/expire의 제한된
+사실만 반환한다. 제품/API/script caller, provider adapter/model 호출, stage admin writer,
+flag 활성화는 추가하지 않았다. 기존 v1의 `admitted: false`와
+`reservation_authority_unavailable`도 그대로이므로 이 회차만으로 실행 경로가 열리지
+않는다.
+
+### 한눈에 보는 전체 Chat 진척
+
+| 항목 | 이번 판단 |
+| --- | --- |
+| 전체 웹 Chat | **약 67%** (주관적 범위 **57–77%**) |
+| 직전 의미 있는 회차 대비 | **약 0%p** — 안전한 예약 기반은 생겼지만 제품 호출·공개 범위는 그대로 |
+| C19–C20 Refiner·Planner·품질 평가 | **약 41%** (직전 약 38%, durable authority 구현 반영) |
+| 구현 | 성공한 INSERT와 실제 tombstone 집계에 결속된 DB accounting·stage/reservation lifecycle 포함 고정 digest·stage→registry→reservation 잠금·명시적 UTC DB-owned terminal clock·SQL limit으로 제한된 expiry lock footprint·원자 slot/cost·active/terminal idempotency·1회 consume·영구 tombstone 구현 |
+| 로컬 검증 | Prompt Refiner focused 42/42, 신규 DB integration 17/17, 최신 `origin/develop` 동기화 뒤 전용 로컬 PostgreSQL fresh migration 112개·drift 0, typecheck·대상 lint·enum/DB coverage 통과. 같은 Prisma formatter를 pristine `origin/develop`에 적용해도 기존 구간 54행씩 바뀌는 baseline drift를 확인했으며, 이 변경은 그 unrelated churn을 포함하지 않고 신규 model block만 canonical style로 유지 |
+| 전체 finance lane | 직전 trigger 설계에서 203개 중 186 pass·17 fail이었고 당시 authority 13개는 모두 통과했다. 이번 최종 DB 경계 보강 뒤에는 전용 15개 suite를 fresh DB에서 통과시켰으며 full lane 재실행은 통합 CI 몫이다. 기존 실패 17개는 변경 범위 밖 chat concurrency/rate/image concurrency 항목이었다. |
+| 독립 검토·통합 CI | 대기 — 구현 완료 뒤 Claude 읽기 전용 검토와 Linux CI 필요 |
+| 병합·배포·공개 | 미수행. provider/API/model 호출 0, stage seed/writer 0, v1 admission·flag 변경 0 |
+
+### 이 Cycle 다음 권장 순서
+
+1. Claude 읽기 전용 독립 검토와 Linux 통합 CI에서 transaction/race/rollback 및 migration
+   경계를 다시 검증한다.
+2. provider 호출 없이 동결 corpus·output parser·append-only journal·중단 규칙을 갖춘
+   shadow harness를 구현하되 아직 authority를 dispatch에 연결하지 않는다.
+3. harness와 authority를 잇는 새 admission 계약, stage 생성/admin writer, 비용 승인을
+   별도 설계·검토한다. 기존 v1은 수정하지 않는다.
+4. 그 새 계약이 승인된 뒤 bounded shadow를 정확히 한 번 유료 실행한다.
+5. 의미 보존·주입 저항·비용·지연 증거가 통과할 때만 writer와 제안형 제품 adapter를
+   연결하고, 이후 Refiner 결과의 Router 결합과 전체 카탈로그 선택 품질을 별도 실험한다.
diff --git a/docs/policy/prompt-refiner-observability.md b/docs/policy/prompt-refiner-observability.md
index cce82b1c..b4d5db3a 100644
--- a/docs/policy/prompt-refiner-observability.md
+++ b/docs/policy/prompt-refiner-observability.md
@@ -1,11 +1,11 @@
 # Prompt Refiner receipt와 관측 계약
 
-상태: **provider-independent 데이터·실행 사전등록 계약 구현, 제품 수집 미연결**.
+상태: **provider-independent 데이터·실행 사전등록·예약 authority 구현, 제품 수집 미연결**.
 
 이 문서는 Prompt Refiner 한 요청에서 무엇을 관측하고 어떤 분모로 읽는지를
 정한다. 현재 구현은 strict schema, 결속 검사, 순수 집계와 오프라인 report까지다.
-provider adapter, API route, Prisma table, browser event writer, 비용 예약·정산,
-Router 결합과 rollout 활성화는 없다. `lib/promptRefinerExecutionContract.ts`는 정확한
+provider adapter, API route, browser event writer, 제품 caller, Router 결합과 rollout
+활성화는 없다. `lib/promptRefinerExecutionContract.ts`는 정확한
 model/catalog/pricing identity와 4,096 output tokens, 15초 timeout, retry 0,
 요청당 24,916 microUSD, 최대 100 dispatch의 단계 2,491,600 microUSD를 동결하지만
 그 자체로 실행을 승인하거나 비용을 예약하지 않는다. 정적 pricing profile만
@@ -25,13 +25,48 @@ cached-input multiplier는 prompt caching이 disabled라 이 계약의 비용을
 generic `reservationOutputTokens`는 Refiner authority가 사용할 예약량이 아니다. 미래
 authority는 이 계약의 4,096-token worst case를 예약해야 하며 generic reservation
 cap으로 낮춰 잡을 수 없다.
-현재는 원자 예약 authority가 없으므로 모든 다른 조건이 맞아도
-`reservation_authority_unavailable`로 dispatch 전에 거절한다. caller가 전달한 lease나
-atomic 여부 boolean을 성공 증거로 받는 입력과 `admitted: true` 경로는 없다. 후속
-authority가 requestId 결속·만료·1회 consume·비용과 stage slot의 원자 예약을 실제로
-구현한 뒤에만 새 계약 버전으로 성공 admission을 추가할 수 있다. 그 authority는
-runtime model row를 이 gate에 전달하고 원자 예약·dispatch 전에 같은 critical path에서
-통과시켜야 한다. 정적 profile 검사 결과를 과거에 캐시한 값으로 대신할 수 없다.
+server-only 원자 예약 authority는 별도 구현됐지만 stage seed/admin writer와 제품
+caller가 없고 기존 v1 admission은 의도적으로 그대로다. 따라서 모든 다른 조건이
+맞아도 v1은 `reservation_authority_unavailable`로 dispatch 전에 거절하며
+`admitted: true` 경로가 없다. 이 authority는 DB transaction 안에서 고정 stage row,
+model registry table `SHARE`, reservation row 순서로 잠근다. 따라서 pinned row가 없던
+경우를 포함해 admin INSERT/UPDATE/DELETE가 runtime 검증과 consume 사이에 끼어들 수
+없다. runtime model row와 effective pricing은 reserve와 consume 모두에서 다시
+검증한다. requestId·고정 stage·canonical contract digest·server-minted reservationId를
+결속하고 naive timestamp에는 `clock_timestamp() AT TIME ZONE 'UTC'`만 사용하는 만료·
+1회 CAS consume·영구 terminal tombstone을
+강제한다. 정적
+profile 검사 결과를 과거에 캐시한 값이나 caller가 전달한 lease/atomic boolean은 성공
+증거가 아니다. 새로 승인된 후속 계약만 authority의 consumed fact를 성공 admission에
+연결할 수 있다.
+
+## 0. Durable reservation authority 경계
+
+- stage는 `prompt-refiner-shadow-v1` 한 행으로 제한되며 요청당 24,916 microUSD,
+  최대 100개, 총 2,491,600 microUSD를 DB constraint와 transaction에서 함께 지킨다.
+- reservation `BEFORE INSERT` trigger는 stage를 잠그고 정확한 계약·초기 상태·5분 TTL을
+  검증만 한다. 성공한 행이 보이는 `AFTER INSERT` trigger만 실제 tombstone 집계와 stage
+  counter를 결속한다. stage 최초 counter는 0/0이어야 하고 direct stage counter UPDATE는
+  집계와 맞을 수 없어 거부된다. direct insert도 같은 예산을 소비하고 101번째·위조
+  insert·unique 충돌은 행과 accounting을 함께 rollback한다. terminal timestamp도 DB
+  trigger가 단 한 번의 clock으로 쓰며 만료 뒤 consume/release는 expired로 저장한다.
+- expiry sweep은 DB clock 만료 조건과 `expiresAt, id` 순서를 SQL에서 적용하고 caller
+  `limit`을 `FOR UPDATE`보다 먼저 적용한다. 따라서 limit은 update 수뿐 아니라 lock
+  footprint도 제한한다.
+- 계약 identity는 stage lifecycle(`approved`, `closed`)과 reservation lifecycle을 모두
+  포함한 정렬 canonical JSON의 SHA-256 digest로 결속한다. reserve와
+  consume은 runtime registry/pricing drift가 있으면 슬롯을 만들거나 사용하지 않는다.
+- 동일 requestId 재요청은 stage와 registry 잠금 뒤 stage 상태/runtime 재검증보다 먼저
+  기존 사실을 읽는다. active lease만 성공 fact이며 terminal 행은 명시적 non-success
+  결과다. 어떤 경우에도 같은 requestId로 슬롯을 더 만들거나 재사용하지 않는다.
+  released/expired/consumed 행도 100개 상한에 남고 삭제·재사용·환급하지 않는다.
+- authority table과 반환값에는 prompt, content, user, conversation, provider 오류를
+  저장하지 않는다. reserve/consume/release/expire의 content-free fact만 반환한다.
+- migration은 stage를 seed하지 않는다. 제품/API/script import도 없으므로 이 구현만
+  배포해도 provider/model 호출이나 비용 지출을 만들 수 없다.
+- 미래 dispatch는 consume이 검증하고 반환한 reservation의 정확한 contract digest와
+  checked-in execution/reservation contract constants를 그대로 사용해야 한다. consume 뒤 registry를
+  다시 읽어 모델·가격·cap을 재해석하면 TOCTOU 보호를 무효화하므로 금지한다.
 
 ## 1. 하나의 변경 가능한 행 대신 두 개의 불변 사실
 
diff --git a/docs/ui-contracts/prompt-refiner-suggestion.md b/docs/ui-contracts/prompt-refiner-suggestion.md
index 8385f0c3..a2a3bb91 100644
--- a/docs/ui-contracts/prompt-refiner-suggestion.md
+++ b/docs/ui-contracts/prompt-refiner-suggestion.md
@@ -117,13 +117,25 @@ accepted+kept-original을 각각 분모로 쓴다. 서로 다른 분모를 한 c
 provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필요하다.
 
 1. 비용이 고정된 Refiner 모델·출력 cap·timeout·재시도 0 계약
-   (provider-independent 사전등록은 구현됨. 예약 authority가 없으므로 admission은
-   항상 dispatch 전에 거절하며 실제 adapter·비용 예약·dispatch 권한은 없음.
+   (provider-independent 사전등록과 server-only 원자 예약 authority는 구현됨. 단,
+   stage seed/admin writer·제품 caller가 없고 v1 admission은 변경하지 않아 항상
+   `reservation_authority_unavailable`로 dispatch 전에 거절하며 실제 adapter·dispatch
+   권한은 없음. authority는 stage→model registry table `SHARE`→reservation 순서로
+   잠그고 requestId·stage·canonical contract digest·server reservationId를 결속하며
+   잠금 뒤 DB clock 만료·1회 consume·영구 tombstone을 강제함. BEFORE INSERT는 검증·잠금만,
+   AFTER INSERT는 성공한 tombstone 집계와 counter 결속만 맡으며 stage는 반드시 0/0에서
+   시작함. direct stage counter UPDATE, direct/unique/101번째 insert 우회는 거부 또는 함께
+   rollback됨. naive timestamp의 clock은 명시적 UTC이며 terminal timestamp도 DB가
+   소유하고 늦은 consume/release는 expired가 됨. expiry sweep의 SQL limit은 update와
+   row-lock footprint를 함께 제한함.
+   기존 request는 active와 terminal을 구분하며 terminal은 usable lease가 아님.
    정적 profile과 `resolveModelPricing()`의 effective input/output rate가 모두 exact
    pin과 일치하고 effective output cap은 4,096 이상이어야 함. 더 큰 capability에도
    adapter는 계약 cap 4,096을 명시하며 generic cached/reservation 설정을 이 계약의
-   비용·예약량으로 바꾸지 않음. 미래 authority도 runtime row를 전달해
-   예약·dispatch 전에 이 gate를 다시 통과해야 함)
+   비용·예약량으로 바꾸지 않음. reserve와 consume은 모두 runtime row를 전달해
+   critical path 안에서 이 gate를 다시 통과함. 미래 dispatch는 consume 결과의 exact
+   digest와 checked-in execution/reservation contract constants를 사용하고 registry를 다시
+   읽어 재해석하지 않음)
 2. request/receipt와 사용자 선택률·stale·실패·지연 계측 (provider-independent
    schema와 오프라인 집계는 구현됨; writer·저장소·제품 수집은 미구현)
 3. 원문 대비 제안문 주입·의미 보존 평가
diff --git a/lib/promptRefinerReservationAuthority.ts b/lib/promptRefinerReservationAuthority.ts
new file mode 100644
index 00000000..12dccfb2
--- /dev/null
+++ b/lib/promptRefinerReservationAuthority.ts
@@ -0,0 +1,348 @@
+import "server-only";
+
+import { randomUUID } from "node:crypto";
+import { Prisma, type ModelRegistryEntry } from "@prisma/client";
+
+import { getModelPricingProfile } from "@/lib/modelPricing";
+import { registryRowToModel } from "@/lib/modelRegistry";
+import { prisma } from "@/lib/prisma";
+import {
+    PROMPT_REFINER_EXECUTION_MODEL_PIN,
+    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    promptRefinerExecutionContractProblems,
+} from "@/lib/promptRefinerExecutionContract";
+import {
+    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    PROMPT_REFINER_RESERVATION_STAGE_ID,
+    PROMPT_REFINER_RESERVATION_TTL_MS,
+    promptRefinerReservationBindingMatches,
+    promptRefinerReservationIdentifiersAreValid,
+    promptRefinerReservationStageProblems,
+    type PromptRefinerReservationBinding,
+    type PromptRefinerReservationRefusal,
+} from "@/lib/promptRefinerReservationCore";
+
+type ReservationFacts = PromptRefinerReservationBinding & {
+    status: "reserved" | "consumed" | "released" | "expired";
+    reservedCostMicroUsd: bigint;
+    expiresAt: Date;
+    createdAt: Date;
+    consumedAt: Date | null;
+    releasedAt: Date | null;
+    expiredAt: Date | null;
+};
+
+type AuthorityResult<T> =
+    | { ok: true; value: T }
+    | { ok: false; reason: PromptRefinerReservationRefusal };
+
+const refuse = <T>(reason: PromptRefinerReservationRefusal): AuthorityResult<T> => ({
+    ok: false,
+    reason,
+});
+
+const dbClock = async (tx: Prisma.TransactionClient) => {
+    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    if (!clock) throw new Error("PostgreSQL did not return its transaction clock");
+    return clock.now;
+};
+
+// Global lock order for every authority mutation:
+//   fixed stage row -> model registry table -> reservation row(s).
+// SHARE covers both the pinned row and the absent-row case, so an admin
+// INSERT/UPDATE/DELETE cannot change the runtime contract after validation.
+const lockModelRegistry = async (tx: Prisma.TransactionClient) => {
+    await tx.$executeRawUnsafe('LOCK TABLE "ModelRegistryEntry" IN SHARE MODE');
+};
+
+const lockStage = async (tx: Prisma.TransactionClient, stageId: string) => {
+    const locked = await tx.$queryRaw<Array<{ id: string }>>`
+        SELECT "id"
+        FROM "PromptRefinerReservationStage"
+        WHERE "id" = ${stageId}
+        FOR UPDATE
+    `;
+    if (locked.length !== 1) return null;
+    return tx.promptRefinerReservationStage.findUnique({ where: { id: stageId } });
+};
+
+const lockedRuntimeContractIsCurrent = async (tx: Prisma.TransactionClient) => {
+    const row = await tx.modelRegistryEntry.findUnique({
+        where: { id: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId },
+    });
+    if (!row) return false;
+    let model;
+    try {
+        model = registryRowToModel(row as ModelRegistryEntry);
+    } catch {
+        return false;
+    }
+    const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    return promptRefinerExecutionContractProblems({ model, pricing }).length === 0;
+};
+
+const facts = (row: {
+    id: string;
+    requestId: string;
+    stageId: string;
+    contractDigest: string;
+    status: string;
+    reservedCostMicroUsd: bigint;
+    expiresAt: Date;
+    createdAt: Date;
+    consumedAt: Date | null;
+    releasedAt: Date | null;
+    expiredAt: Date | null;
+}): ReservationFacts => ({
+    reservationId: row.id,
+    requestId: row.requestId,
+    stageId: row.stageId,
+    contractDigest: row.contractDigest,
+    status: row.status as ReservationFacts["status"],
+    reservedCostMicroUsd: row.reservedCostMicroUsd,
+    expiresAt: row.expiresAt,
+    createdAt: row.createdAt,
+    consumedAt: row.consumedAt,
+    releasedAt: row.releasedAt,
+    expiredAt: row.expiredAt,
+});
+
+/**
+ * Atomically consumes one of the stage's permanent slots and its worst-case
+ * cost. Expired and released rows remain tombstones and never refund either.
+ */
+export const reservePromptRefinerExecution = async (input: {
+    requestId: string;
+    stageId?: string;
+}): Promise<
+    | AuthorityResult<{ kind: "active"; created: boolean; reservation: ReservationFacts }>
+    | {
+          ok: false;
+          reason: "request_already_terminal";
+          reservation: ReservationFacts;
+      }
+> => {
+    const stageId = input.stageId ?? PROMPT_REFINER_RESERVATION_STAGE_ID;
+    if (
+        stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
+        !promptRefinerReservationIdentifiersAreValid({ requestId: input.requestId })
+    ) {
+        return refuse("invalid_binding");
+    }
+
+    return prisma.$transaction(async (tx) => {
+        // Global lock order: stage -> model registry -> reservation.
+        const stage = await lockStage(tx, stageId);
+        if (!stage) return refuse("stage_not_found");
+        await lockModelRegistry(tx);
+
+        const existingId = await tx.$queryRaw<Array<{ id: string }>>`
+            SELECT "id"
+            FROM "PromptRefinerReservation"
+            WHERE "requestId" = ${input.requestId}
+            FOR UPDATE
+        `;
+        if (existingId.length === 1) {
+            const existing = await tx.promptRefinerReservation.findUniqueOrThrow({
+                where: { id: existingId[0]!.id },
+            });
+            if (
+                existing.stageId !== stageId ||
+                existing.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST
+            ) {
+                return refuse("request_binding_mismatch");
+            }
+            if (existing.status !== "reserved") {
+                return {
+                    ok: false,
+                    reason: "request_already_terminal",
+                    reservation: facts(existing),
+                };
+            }
+            const now = await dbClock(tx);
+            if (existing.expiresAt.getTime() <= now.getTime()) {
+                const expired = await tx.promptRefinerReservation.update({
+                    where: { id: existing.id },
+                    // The database trigger owns the terminal timestamp.
+                    data: { status: "expired" },
+                });
+                return {
+                    ok: false,
+                    reason: "request_already_terminal",
+                    reservation: facts(expired),
+                };
+            }
+            return {
+                ok: true,
+                value: { kind: "active", created: false, reservation: facts(existing) },
+            };
+        }
+
+        if (promptRefinerReservationStageProblems(stage).length > 0) {
+            return refuse("stage_contract_mismatch");
+        }
+        if (!(await lockedRuntimeContractIsCurrent(tx))) {
+            return refuse("runtime_contract_mismatch");
+        }
+
+        if (stage.reservationCount >= stage.maxReservations) {
+            return refuse("stage_capacity_exhausted");
+        }
+        const requestCost = BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD);
+
+        const now = await dbClock(tx);
+        const reservation = await tx.promptRefinerReservation.create({
+            data: {
+                id: randomUUID(),
+                requestId: input.requestId,
+                stageId,
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "reserved",
+                reservedCostMicroUsd: requestCost,
+                expiresAt: new Date(now.getTime() + PROMPT_REFINER_RESERVATION_TTL_MS),
+                createdAt: now,
+            },
+        });
+        return {
+            ok: true,
+            value: { kind: "active", created: true, reservation: facts(reservation) },
+        };
+    });
+};
+
+const transitionReservation = async (input: {
+    binding: PromptRefinerReservationBinding;
+    transition: "consume" | "release";
+}): Promise<AuthorityResult<ReservationFacts>> => {
+    if (
+        input.binding.stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
+        input.binding.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST ||
+        !promptRefinerReservationIdentifiersAreValid({
+            requestId: input.binding.requestId,
+            reservationId: input.binding.reservationId,
+        })
+    ) {
+        return refuse("invalid_binding");
+    }
+
+    return prisma.$transaction(async (tx) => {
+        const stage = await lockStage(tx, input.binding.stageId);
+        if (!stage) return refuse("stage_not_found");
+        await lockModelRegistry(tx);
+        if (
+            promptRefinerReservationStageProblems(stage, {
+                requireApproved: input.transition === "consume",
+            }).length > 0
+        ) {
+            return refuse("stage_contract_mismatch");
+        }
+        if (input.transition === "consume" && !(await lockedRuntimeContractIsCurrent(tx))) {
+            return refuse("runtime_contract_mismatch");
+        }
+
+        const locked = await tx.$queryRaw<Array<{ id: string }>>`
+            SELECT "id"
+            FROM "PromptRefinerReservation"
+            WHERE "id" = ${input.binding.reservationId}
+            FOR UPDATE
+        `;
+        if (locked.length !== 1) return refuse("reservation_not_found");
+        const current = await tx.promptRefinerReservation.findUnique({
+            where: { id: input.binding.reservationId },
+        });
+        if (!current) return refuse("reservation_not_found");
+        if (!promptRefinerReservationBindingMatches(input.binding, {
+            reservationId: current.id,
+            requestId: current.requestId,
+            stageId: current.stageId,
+            contractDigest: current.contractDigest,
+        })) {
+            return refuse("request_binding_mismatch");
+        }
+        if (current.status !== "reserved") return refuse("reservation_not_active");
+
+        const now = await dbClock(tx);
+        if (current.expiresAt.getTime() <= now.getTime()) {
+            await tx.promptRefinerReservation.update({
+                where: { id: current.id },
+                data: { status: "expired" },
+            });
+            return refuse("reservation_expired");
+        }
+
+        const updated = await tx.promptRefinerReservation.updateMany({
+            where: { id: current.id, status: "reserved" },
+            data:
+                input.transition === "consume"
+                    ? { status: "consumed" }
+                    : { status: "released" },
+        });
+        if (updated.count !== 1) return refuse("reservation_not_active");
+        const terminal = await tx.promptRefinerReservation.findUniqueOrThrow({
+            where: { id: current.id },
+        });
+        // The database samples its own clock in the transition trigger. If the
+        // deadline crossed after our locked read, it atomically stores an
+        // expired tombstone instead of accepting a late consume/release.
+        if (terminal.status === "expired") return refuse("reservation_expired");
+        return { ok: true, value: facts(terminal) };
+    });
+};
+
+export const consumePromptRefinerReservation = (
+    binding: PromptRefinerReservationBinding
+) => transitionReservation({ binding, transition: "consume" });
+
+export const releasePromptRefinerReservation = (
+    binding: PromptRefinerReservationBinding
+) => transitionReservation({ binding, transition: "release" });
+
+/** Expires active rows in bounded batches; slots and cost remain allocated. */
+export const expirePromptRefinerReservations = async (input?: {
+    stageId?: string;
+    limit?: number;
+}): Promise<AuthorityResult<{ expiredCount: number; observedAt: Date }>> => {
+    const stageId = input?.stageId ?? PROMPT_REFINER_RESERVATION_STAGE_ID;
+    const limit = input?.limit ?? 100;
+    if (
+        stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
+        !Number.isSafeInteger(limit) ||
+        limit < 1 ||
+        limit > 100
+    ) {
+        return refuse("invalid_binding");
+    }
+    return prisma.$transaction(async (tx) => {
+        const stage = await lockStage(tx, stageId);
+        if (!stage) return refuse("stage_not_found");
+        await lockModelRegistry(tx);
+        if (
+            promptRefinerReservationStageProblems(stage, {
+                requireApproved: false,
+            }).length > 0
+        ) {
+            return refuse("stage_contract_mismatch");
+        }
+        const lockedRows = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>(Prisma.sql`
+            SELECT "id", "expiresAt"
+            FROM "PromptRefinerReservation"
+            WHERE "stageId" = ${stageId}
+              AND "status" = 'reserved'
+              AND "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
+            ORDER BY "expiresAt", "id"
+            LIMIT ${limit}
+            FOR UPDATE
+        `);
+        const now = await dbClock(tx);
+        const rows = lockedRows;
+        if (rows.length > 0) {
+            await tx.promptRefinerReservation.updateMany({
+                where: { id: { in: rows.map((row) => row.id) }, status: "reserved" },
+                data: { status: "expired" },
+            });
+        }
+        return { ok: true, value: { expiredCount: rows.length, observedAt: now } };
+    });
+};
diff --git a/lib/promptRefinerReservationCore.ts b/lib/promptRefinerReservationCore.ts
new file mode 100644
index 00000000..d9c14c6d
--- /dev/null
+++ b/lib/promptRefinerReservationCore.ts
@@ -0,0 +1,179 @@
+import { createHash } from "node:crypto";
+
+import {
+    PROMPT_REFINER_EXECUTION_CONTRACT,
+    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+    PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+} from "@/lib/promptRefinerExecutionContract";
+
+/**
+ * Content-free, provider-free authority contract for the first Refiner shadow.
+ * This module decides shapes and state only; it does not read or write a DB.
+ */
+export const PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION =
+    "prompt-refiner-reservation-authority-v1" as const;
+export const PROMPT_REFINER_RESERVATION_STAGE_ID =
+    "prompt-refiner-shadow-v1" as const;
+export const PROMPT_REFINER_RESERVATION_TTL_MS = 5 * 60 * 1_000;
+
+export const PROMPT_REFINER_RESERVATION_STAGE_STATUSES = Object.freeze([
+    "approved",
+    "closed",
+] as const);
+export type PromptRefinerReservationStageStatus =
+    (typeof PROMPT_REFINER_RESERVATION_STAGE_STATUSES)[number];
+
+export const PROMPT_REFINER_RESERVATION_STATUSES = Object.freeze([
+    "reserved",
+    "consumed",
+    "released",
+    "expired",
+] as const);
+export type PromptRefinerReservationStatus =
+    (typeof PROMPT_REFINER_RESERVATION_STATUSES)[number];
+
+const canonicalJson = (value: unknown): string => {
+    if (value === null || typeof value !== "object") return JSON.stringify(value);
+    if (Array.isArray(value)) {
+        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
+    }
+    const object = value as Record<string, unknown>;
+    return `{${Object.keys(object)
+        .sort()
+        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
+        .join(",")}}`;
+};
+
+export const PROMPT_REFINER_RESERVATION_CONTRACT = Object.freeze({
+    authorityVersion: PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
+    executionContract: PROMPT_REFINER_EXECUTION_CONTRACT,
+    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+    perRequestCostMicroUsd:
+        PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+    reservationTtlMs: PROMPT_REFINER_RESERVATION_TTL_MS,
+    stageStates: PROMPT_REFINER_RESERVATION_STAGE_STATUSES,
+    reservationStates: PROMPT_REFINER_RESERVATION_STATUSES,
+} as const);
+
+const computedReservationContractDigest = `sha256:${createHash("sha256")
+    .update(canonicalJson(PROMPT_REFINER_RESERVATION_CONTRACT), "utf8")
+    .digest("hex")}`;
+
+export const PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST =
+    "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f" as const;
+
+if (computedReservationContractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST) {
+    throw new Error("Prompt Refiner reservation contract digest drifted");
+}
+
+export const PROMPT_REFINER_RESERVATION_REFUSALS = Object.freeze([
+    "invalid_binding",
+    "stage_not_found",
+    "stage_contract_mismatch",
+    "runtime_contract_mismatch",
+    "request_binding_mismatch",
+    "request_already_terminal",
+    "reservation_not_found",
+    "reservation_not_active",
+    "reservation_expired",
+    "stage_capacity_exhausted",
+] as const);
+export type PromptRefinerReservationRefusal =
+    (typeof PROMPT_REFINER_RESERVATION_REFUSALS)[number];
+
+export type PromptRefinerReservationStageFacts = {
+    id: string;
+    contractVersion: string;
+    contractDigest: string;
+    status: string;
+    perRequestCostMicroUsd: bigint;
+    maxReservations: number;
+    costCeilingMicroUsd: bigint;
+    reservationCount: number;
+    allocatedCostMicroUsd: bigint;
+};
+
+export const promptRefinerReservationStageProblems = (
+    stage: PromptRefinerReservationStageFacts,
+    options: { requireApproved?: boolean } = {}
+): string[] => {
+    const problems: string[] = [];
+    if (stage.id !== PROMPT_REFINER_RESERVATION_STAGE_ID) problems.push("stage_id_mismatch");
+    if (stage.contractVersion !== PROMPT_REFINER_EXECUTION_CONTRACT_VERSION) {
+        problems.push("contract_version_mismatch");
+    }
+    if (stage.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST) {
+        problems.push("contract_digest_mismatch");
+    }
+    if (!(PROMPT_REFINER_RESERVATION_STAGE_STATUSES as readonly string[]).includes(stage.status)) {
+        problems.push("stage_status_invalid");
+    } else if (options.requireApproved !== false && stage.status !== "approved") {
+        problems.push("stage_not_approved");
+    }
+    if (
+        stage.perRequestCostMicroUsd !==
+        BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD)
+    ) {
+        problems.push("request_cost_mismatch");
+    }
+    if (stage.maxReservations !== PROMPT_REFINER_SHADOW_MAX_DISPATCHES) {
+        problems.push("reservation_limit_mismatch");
+    }
+    if (
+        stage.costCeilingMicroUsd !==
+        BigInt(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD)
+    ) {
+        problems.push("stage_cost_mismatch");
+    }
+    if (
+        !Number.isSafeInteger(stage.reservationCount) ||
+        stage.reservationCount < 0 ||
+        stage.reservationCount > stage.maxReservations
+    ) {
+        problems.push("reservation_count_invalid");
+    }
+    if (
+        stage.allocatedCostMicroUsd !==
+        BigInt(stage.reservationCount) * stage.perRequestCostMicroUsd
+    ) {
+        problems.push("allocated_cost_invalid");
+    }
+    if (stage.allocatedCostMicroUsd > stage.costCeilingMicroUsd) {
+        problems.push("stage_cost_exceeded");
+    }
+    return problems;
+};
+
+export const promptRefinerReservationIdentifiersAreValid = (input: {
+    requestId: string;
+    reservationId?: string;
+}): boolean => {
+    const bounded = (value: string, maximum: number) =>
+        value.length >= 1 &&
+        value.length <= maximum &&
+        /^[A-Za-z0-9:_-]+$/.test(value);
+    return (
+        bounded(input.requestId, 128) &&
+        (input.reservationId === undefined || bounded(input.reservationId, 128))
+    );
+};
+
+export type PromptRefinerReservationBinding = {
+    reservationId: string;
+    requestId: string;
+    stageId: string;
+    contractDigest: string;
+};
+
+export const promptRefinerReservationBindingMatches = (
+    expected: PromptRefinerReservationBinding,
+    actual: PromptRefinerReservationBinding
+): boolean =>
+    expected.reservationId === actual.reservationId &&
+    expected.requestId === actual.requestId &&
+    expected.stageId === actual.stageId &&
+    expected.contractDigest === actual.contractDigest;
diff --git a/prisma/migrations/20260916120000_prompt_refiner_reservation_authority/migration.sql b/prisma/migrations/20260916120000_prompt_refiner_reservation_authority/migration.sql
new file mode 100644
index 00000000..41635f7e
--- /dev/null
+++ b/prisma/migrations/20260916120000_prompt_refiner_reservation_authority/migration.sql
@@ -0,0 +1,290 @@
+-- Prompt Refiner reservation authority.
+--
+-- Deliberately no seed: deploying this migration authorizes no execution. A
+-- separately approved future harness must create the one exact stage row.
+-- Both tables are content-free and retain terminal rows as permanent slots.
+
+CREATE TABLE "PromptRefinerReservationStage" (
+    "id" TEXT NOT NULL,
+    "contractVersion" TEXT NOT NULL,
+    "contractDigest" TEXT NOT NULL,
+    "status" TEXT NOT NULL,
+    "perRequestCostMicroUsd" BIGINT NOT NULL,
+    "maxReservations" INTEGER NOT NULL,
+    "costCeilingMicroUsd" BIGINT NOT NULL,
+    "reservationCount" INTEGER NOT NULL DEFAULT 0,
+    "allocatedCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
+    "approvedBy" TEXT NOT NULL,
+    "approvedAt" TIMESTAMP(3) NOT NULL,
+    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+    "updatedAt" TIMESTAMP(3) NOT NULL,
+
+    CONSTRAINT "PromptRefinerReservationStage_pkey" PRIMARY KEY ("id"),
+    CONSTRAINT "PromptRefinerReservationStage_id_check"
+        CHECK ("id" = 'prompt-refiner-shadow-v1'),
+    CONSTRAINT "PromptRefinerReservationStage_status_check"
+        CHECK ("status" IN ('approved', 'closed')),
+    CONSTRAINT "PromptRefinerReservationStage_contract_check"
+        CHECK (
+            "contractVersion" = 'prompt-refiner-execution-contract-v1'
+            AND "contractDigest" = 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
+        ),
+    CONSTRAINT "PromptRefinerReservationStage_constants_check"
+        CHECK (
+            "perRequestCostMicroUsd" = 24916
+            AND "maxReservations" = 100
+            AND "costCeilingMicroUsd" = 2491600
+        ),
+    CONSTRAINT "PromptRefinerReservationStage_counters_check"
+        CHECK (
+            "reservationCount" >= 0
+            AND "reservationCount" <= "maxReservations"
+            AND "allocatedCostMicroUsd" = "reservationCount"::BIGINT * "perRequestCostMicroUsd"
+            AND "allocatedCostMicroUsd" <= "costCeilingMicroUsd"
+        ),
+    CONSTRAINT "PromptRefinerReservationStage_approvedBy_check"
+        CHECK (length("approvedBy") BETWEEN 1 AND 128)
+);
+
+CREATE UNIQUE INDEX "PromptRefinerReservationStage_contractDigest_key"
+    ON "PromptRefinerReservationStage"("contractDigest");
+
+CREATE TABLE "PromptRefinerReservation" (
+    "id" TEXT NOT NULL,
+    "stageId" TEXT NOT NULL,
+    "requestId" TEXT NOT NULL,
+    "contractDigest" TEXT NOT NULL,
+    "status" TEXT NOT NULL DEFAULT 'reserved',
+    "reservedCostMicroUsd" BIGINT NOT NULL,
+    "expiresAt" TIMESTAMP(3) NOT NULL,
+    "consumedAt" TIMESTAMP(3),
+    "releasedAt" TIMESTAMP(3),
+    "expiredAt" TIMESTAMP(3),
+    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
+    "updatedAt" TIMESTAMP(3) NOT NULL,
+
+    CONSTRAINT "PromptRefinerReservation_pkey" PRIMARY KEY ("id"),
+    CONSTRAINT "PromptRefinerReservation_status_check"
+        CHECK ("status" IN ('reserved', 'consumed', 'released', 'expired')),
+    CONSTRAINT "PromptRefinerReservation_cost_check"
+        CHECK ("reservedCostMicroUsd" = 24916),
+    CONSTRAINT "PromptRefinerReservation_lifetime_check"
+        CHECK ("expiresAt" = "createdAt" + INTERVAL '5 minutes'),
+    CONSTRAINT "PromptRefinerReservation_terminal_check"
+        CHECK (
+            ("status" = 'reserved' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL)
+            OR ("status" = 'consumed' AND "consumedAt" IS NOT NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL)
+            OR ("status" = 'released' AND "consumedAt" IS NULL AND "releasedAt" IS NOT NULL AND "expiredAt" IS NULL)
+            OR ("status" = 'expired' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "expiredAt" IS NOT NULL)
+        ),
+    CONSTRAINT "PromptRefinerReservation_requestId_check"
+        CHECK (length("requestId") BETWEEN 1 AND 128 AND "requestId" ~ '^[A-Za-z0-9:_-]+$'),
+    CONSTRAINT "PromptRefinerReservation_id_check"
+        CHECK (length("id") BETWEEN 1 AND 128 AND "id" ~ '^[A-Za-z0-9:_-]+$')
+);
+
+CREATE UNIQUE INDEX "PromptRefinerReservation_requestId_key"
+    ON "PromptRefinerReservation"("requestId");
+CREATE INDEX "PromptRefinerReservation_stageId_status_expiresAt_idx"
+    ON "PromptRefinerReservation"("stageId", "status", "expiresAt");
+
+ALTER TABLE "PromptRefinerReservation"
+    ADD CONSTRAINT "PromptRefinerReservation_stageId_fkey"
+    FOREIGN KEY ("stageId") REFERENCES "PromptRefinerReservationStage"("id")
+    ON DELETE RESTRICT ON UPDATE RESTRICT;
+
+-- A stage's bounds and approval provenance are immutable. A new stage always
+-- starts at zero. Thereafter counters may only move to the exact aggregate of
+-- already-visible reservation tombstones; a direct counter UPDATE therefore
+-- has no value it can change to, while an AFTER INSERT trigger can bind a
+-- successfully inserted row (or batch) to the counters.
+CREATE FUNCTION "prompt_refiner_stage_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    actual_count INTEGER;
+    actual_cost BIGINT;
+BEGIN
+    IF TG_OP = 'DELETE' THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage % cannot be deleted', OLD."id";
+    END IF;
+    IF TG_OP = 'INSERT' THEN
+        IF NEW."reservationCount" <> 0 OR NEW."allocatedCostMicroUsd" <> 0 THEN
+            RAISE EXCEPTION 'PromptRefinerReservationStage must start with zero accounting';
+        END IF;
+        RETURN NEW;
+    END IF;
+    IF NEW."id" IS DISTINCT FROM OLD."id"
+       OR NEW."contractVersion" IS DISTINCT FROM OLD."contractVersion"
+       OR NEW."contractDigest" IS DISTINCT FROM OLD."contractDigest"
+       OR NEW."perRequestCostMicroUsd" IS DISTINCT FROM OLD."perRequestCostMicroUsd"
+       OR NEW."maxReservations" IS DISTINCT FROM OLD."maxReservations"
+       OR NEW."costCeilingMicroUsd" IS DISTINCT FROM OLD."costCeilingMicroUsd"
+       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
+       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
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
+-- The BEFORE trigger validates the candidate and serialises it on the fixed
+-- stage, but deliberately does not account it before the row exists.
+CREATE FUNCTION "prompt_refiner_reservation_insert_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    stage "PromptRefinerReservationStage"%ROWTYPE;
+BEGIN
+    IF NEW."status" <> 'reserved'
+       OR NEW."consumedAt" IS NOT NULL
+       OR NEW."releasedAt" IS NOT NULL
+       OR NEW."expiredAt" IS NOT NULL THEN
+        RAISE EXCEPTION 'PromptRefinerReservation must start reserved';
+    END IF;
+    IF NEW."stageId" <> 'prompt-refiner-shadow-v1'
+       OR NEW."contractDigest" <> 'sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f'
+       OR NEW."reservedCostMicroUsd" <> 24916
+       OR NEW."expiresAt" <> NEW."createdAt" + INTERVAL '5 minutes'
+       OR NEW."createdAt" > (clock_timestamp() AT TIME ZONE 'UTC')
+       OR NEW."expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
+       OR NEW."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '5 minutes' THEN
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
+CREATE TRIGGER "prompt_refiner_reservation_insert_guard_trigger"
+BEFORE INSERT ON "PromptRefinerReservation"
+FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_reservation_insert_guard"();
+
+-- Accounting happens only after PostgreSQL has made the successful INSERT
+-- visible. A statement-level transition table also handles createMany as one
+-- exact aggregate. Unique failures never reach this trigger, and any later
+-- statement/transaction failure rolls both the row and accounting back.
+CREATE FUNCTION "prompt_refiner_reservation_account_insert"()
+RETURNS TRIGGER AS $$
+DECLARE
+    actual_count INTEGER;
+    actual_cost BIGINT;
+    changed INTEGER;
+BEGIN
+    IF NOT EXISTS (SELECT 1 FROM inserted_reservations) THEN
+        RETURN NULL;
+    END IF;
+    SELECT COUNT(*)::INTEGER, COALESCE(SUM("reservedCostMicroUsd"), 0)::BIGINT
+    INTO actual_count, actual_cost
+    FROM "PromptRefinerReservation"
+    WHERE "stageId" = 'prompt-refiner-shadow-v1';
+    IF actual_count > 100 OR actual_cost > 2491600 THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage capacity is exhausted';
+    END IF;
+    UPDATE "PromptRefinerReservationStage"
+    SET "reservationCount" = actual_count,
+        "allocatedCostMicroUsd" = actual_cost,
+        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
+    WHERE "id" = 'prompt-refiner-shadow-v1';
+    GET DIAGNOSTICS changed = ROW_COUNT;
+    IF changed <> 1 THEN
+        RAISE EXCEPTION 'PromptRefinerReservationStage is missing';
+    END IF;
+    RETURN NULL;
+END;
+$$ LANGUAGE plpgsql;
+
+CREATE TRIGGER "prompt_refiner_reservation_account_insert_trigger"
+AFTER INSERT ON "PromptRefinerReservation"
+REFERENCING NEW TABLE AS inserted_reservations
+FOR EACH STATEMENT EXECUTE FUNCTION "prompt_refiner_reservation_account_insert"();
+
+-- Reservation identity and cost never change. A reserved row may transition
+-- exactly once to a terminal tombstone and can never be deleted or recycled.
+CREATE FUNCTION "prompt_refiner_reservation_guard"()
+RETURNS TRIGGER AS $$
+DECLARE
+    observed_at TIMESTAMP(3);
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
+    observed_at := (clock_timestamp() AT TIME ZONE 'UTC');
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
+
+CREATE TRIGGER "prompt_refiner_reservation_guard_trigger"
+BEFORE UPDATE OR DELETE ON "PromptRefinerReservation"
+FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_reservation_guard"();
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index f0883d9c..d534bc93 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -5291,3 +5291,47 @@ model MobileAuthEvent {
   @@index([event, occurredAt])
   @@index([occurredAt])
 }
+
+// --- Prompt Refiner shadow reservation authority --------------------------
+//
+// These rows authorize no provider call on their own. The stage is deliberately
+// not seeded: a future separately approved harness must create the exact stage
+// record before the server-only authority can reserve anything. Reservations
+// are content-free tombstones and are never deleted or reused.
+
+model PromptRefinerReservationStage {
+  id                     String   @id
+  contractVersion        String
+  contractDigest         String   @unique
+  status                 String
+  perRequestCostMicroUsd BigInt
+  maxReservations        Int
+  costCeilingMicroUsd    BigInt
+  reservationCount       Int      @default(0)
+  allocatedCostMicroUsd  BigInt   @default(0)
+  approvedBy             String
+  approvedAt             DateTime
+  createdAt              DateTime @default(now())
+  updatedAt              DateTime @updatedAt
+
+  reservations PromptRefinerReservation[]
+}
+
+model PromptRefinerReservation {
+  id                   String    @id
+  stageId              String
+  requestId            String    @unique
+  contractDigest       String
+  status               String    @default("reserved")
+  reservedCostMicroUsd BigInt
+  expiresAt            DateTime
+  consumedAt           DateTime?
+  releasedAt           DateTime?
+  expiredAt            DateTime?
+  createdAt            DateTime  @default(now())
+  updatedAt            DateTime  @updatedAt
+
+  stage PromptRefinerReservationStage @relation(fields: [stageId], references: [id], onDelete: Restrict, onUpdate: Restrict)
+
+  @@index([stageId, status, expiresAt])
+}
diff --git a/scripts/check-enum-constraints.mjs b/scripts/check-enum-constraints.mjs
index 21c9d56e..bc2f9e1c 100644
--- a/scripts/check-enum-constraints.mjs
+++ b/scripts/check-enum-constraints.mjs
@@ -436,6 +436,20 @@ const REGISTRY = {
     reason:
       "The reservation lifecycle, written by the credit paths as literals inside the transactions that move it.",
   },
+  PromptRefinerReservationStage_status_check: {
+    owner: "list",
+    module: "lib/promptRefinerReservationCore.ts",
+    list: "PROMPT_REFINER_RESERVATION_STAGE_STATUSES",
+    reason:
+      "The separately approved shadow stage is either open for exact reservations or permanently closed. The authority validates the same list before every state transition.",
+  },
+  PromptRefinerReservation_status_check: {
+    owner: "list",
+    module: "lib/promptRefinerReservationCore.ts",
+    list: "PROMPT_REFINER_RESERVATION_STATUSES",
+    reason:
+      "The one-way reservation lifecycle. Terminal rows remain tombstones and the server-only authority branches on these exact values.",
+  },
   AccountDataExportRequest_status_check: {
     owner: "database",
     reason:
diff --git a/scripts/db-integration-groups.mjs b/scripts/db-integration-groups.mjs
index 421dde83..ea0bb86a 100644
--- a/scripts/db-integration-groups.mjs
+++ b/scripts/db-integration-groups.mjs
@@ -70,7 +70,7 @@ const LANE_RULES = [
   // decide whether a paid turn starts at all.
   [
     "finance",
-    /^(credit-finance|chat-concurrency|chat-rate-limit|chat-token-quota|fallback-pricing|chat-attempt-usage|model-registry|subscription-sync-ordering|plan-change-|image-generation|refund-decision-route|stripe-webhook-route|webhook-reprocess-route|perplexity-deep-research-route|readiness-route)/,
+    /^(credit-finance|chat-concurrency|chat-rate-limit|chat-token-quota|fallback-pricing|chat-attempt-usage|model-registry|prompt-refiner-reservation|subscription-sync-ordering|plan-change-|image-generation|refund-decision-route|stripe-webhook-route|webhook-reprocess-route|perplexity-deep-research-route|readiness-route)/,
   ],
 ];
 
diff --git a/scripts/report-unswept-tables-core.mjs b/scripts/report-unswept-tables-core.mjs
index a94f7b25..5ecef3bd 100644
--- a/scripts/report-unswept-tables-core.mjs
+++ b/scripts/report-unswept-tables-core.mjs
@@ -48,6 +48,10 @@ export const BOUNDED_TABLES = {
         "one row per template key, and the keys are written in lib/emailTemplateDefinitions.ts",
     ProviderDailyUsage:
         "one row per (provider, model, source, day); the day makes it grow, but at a rate set by the catalogue rather than by traffic",
+    PromptRefinerReservationStage:
+        "one fixed preregistered shadow stage; the application has no seed or writer that can create further stages",
+    PromptRefinerReservation:
+        "at most 100 permanent tombstones under the fixed stage; released and expired rows consume their slot and cannot be deleted or reused",
 };
 
 /**
diff --git a/scripts/run-db-integration-tests.mjs b/scripts/run-db-integration-tests.mjs
index b1a7bccc..94715943 100644
--- a/scripts/run-db-integration-tests.mjs
+++ b/scripts/run-db-integration-tests.mjs
@@ -200,6 +200,9 @@ run(
     "tests/integration/chat-attempt-usage.db.test.ts",
     "tests/integration/routing-attempt-sweep.db.test.ts",
     "tests/integration/model-registry.db.test.ts",
+    // Prompt Refiner authority: stage-first locking, runtime price drift,
+    // one-time consume and the permanent 100-slot/cost ceiling.
+    "tests/integration/prompt-refiner-reservation.db.test.ts",
     "tests/integration/admin-security.db.test.ts",
     "tests/integration/admin-users.db.test.ts",
     "tests/integration/login-methods.db.test.ts",
diff --git a/tests/integration/prompt-refiner-reservation.db.test.ts b/tests/integration/prompt-refiner-reservation.db.test.ts
new file mode 100644
index 00000000..587c8693
--- /dev/null
+++ b/tests/integration/prompt-refiner-reservation.db.test.ts
@@ -0,0 +1,948 @@
+import assert from "node:assert/strict";
+import { randomUUID } from "node:crypto";
+import { before, beforeEach, test } from "node:test";
+
+import { prisma } from "@/lib/prisma";
+import {
+    consumePromptRefinerReservation,
+    expirePromptRefinerReservations,
+    releasePromptRefinerReservation,
+    reservePromptRefinerExecution,
+} from "@/lib/promptRefinerReservationAuthority";
+import {
+    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    PROMPT_REFINER_EXECUTION_MODEL_PIN,
+} from "@/lib/promptRefinerExecutionContract";
+import {
+    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    PROMPT_REFINER_RESERVATION_STAGE_ID,
+} from "@/lib/promptRefinerReservationCore";
+import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";
+
+const INPUT_PRICE_ENV = "CHAT_MODEL_GPT_5_6_LUNA_INPUT_USD_PER_MILLION";
+
+const reset = async () => {
+    await prisma.$executeRawUnsafe(`
+        TRUNCATE TABLE
+          "PromptRefinerReservation",
+          "PromptRefinerReservationStage"
+        RESTART IDENTITY CASCADE
+    `);
+};
+
+const ensureRuntimeModel = async () => {
+    const row = staticModelRegistrySeedRows().find(
+        (candidate) => candidate.id === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId
+    );
+    assert.ok(row);
+    await prisma.modelRegistryEntry.upsert({
+        where: { id: row.id },
+        create: row,
+        update: row,
+    });
+};
+
+const createStage = async (input: { status?: "approved" | "closed" } = {}) => {
+    return prisma.promptRefinerReservationStage.create({
+        data: {
+            id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: input.status ?? "approved",
+            perRequestCostMicroUsd: BigInt(24_916),
+            maxReservations: 100,
+            costCeilingMicroUsd: BigInt(2_491_600),
+            reservationCount: 0,
+            allocatedCostMicroUsd: BigInt(0),
+            approvedBy: "mposition",
+            approvedAt: new Date(),
+        },
+    });
+};
+
+const bindingOf = (reservation: {
+    reservationId: string;
+    requestId: string;
+    stageId: string;
+    contractDigest: string;
+}) => ({
+    reservationId: reservation.reservationId,
+    requestId: reservation.requestId,
+    stageId: reservation.stageId,
+    contractDigest: reservation.contractDigest,
+});
+
+const wait = (milliseconds: number) =>
+    new Promise((resolve) => setTimeout(resolve, milliseconds));
+
+const holdStageLock = async () => {
+    let signalLocked!: () => void;
+    let release!: () => void;
+    const locked = new Promise<void>((resolve) => {
+        signalLocked = resolve;
+    });
+    const gate = new Promise<void>((resolve) => {
+        release = resolve;
+    });
+    const transaction = prisma.$transaction(
+        async (tx) => {
+            await tx.$queryRaw`
+                SELECT "id"
+                FROM "PromptRefinerReservationStage"
+                WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
+                FOR UPDATE
+            `;
+            signalLocked();
+            await gate;
+            const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
+                SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+            `;
+            return clock!.now;
+        },
+        { timeout: 15_000 }
+    );
+    await locked;
+    return { release, transaction };
+};
+
+before(async () => {
+    await ensureRuntimeModel();
+});
+
+beforeEach(async () => {
+    delete process.env[INPUT_PRICE_ENV];
+    await reset();
+});
+
+test("reserve uses the DB clock and atomically binds one exact permanent slot", async () => {
+    await createStage();
+    const reserved = await reservePromptRefinerExecution({ requestId: "request_db_1" });
+    assert.equal(reserved.ok, true);
+    if (!reserved.ok) return;
+    assert.equal(reserved.value.created, true);
+    assert.equal(reserved.value.reservation.status, "reserved");
+    assert.equal(reserved.value.reservation.reservedCostMicroUsd, BigInt(24_916));
+    assert.equal(
+        reserved.value.reservation.expiresAt.getTime() -
+            reserved.value.reservation.createdAt.getTime(),
+        300_000
+    );
+
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 1);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(24_916));
+});
+
+test("a stage must start at zero and direct counter updates cannot mint slots", async () => {
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({
+            data: {
+                id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "approved",
+                perRequestCostMicroUsd: BigInt(24_916),
+                maxReservations: 100,
+                costCeilingMicroUsd: BigInt(2_491_600),
+                reservationCount: 1,
+                allocatedCostMicroUsd: BigInt(24_916),
+                approvedBy: "mposition",
+                approvedAt: new Date(),
+            },
+        }),
+        /must start with zero accounting/i
+    );
+    await createStage();
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.update({
+            where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+            data: {
+                reservationCount: { increment: 1 },
+                allocatedCostMicroUsd: { increment: BigInt(24_916) },
+            },
+        }),
+        /accounting must equal durable tombstones/i
+    );
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 0);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
+    assert.equal(await prisma.promptRefinerReservation.count(), 0);
+});
+
+test("reserve takes its DB clock after stage-lock contention and preserves the exact TTL", async () => {
+    await createStage();
+    const blocker = await holdStageLock();
+    const reservationPromise = reservePromptRefinerExecution({ requestId: "request_waited" });
+    await wait(350);
+    blocker.release();
+    const releasedAt = await blocker.transaction;
+    const reserved = await reservationPromise;
+    assert.equal(reserved.ok, true);
+    if (!reserved.ok) return;
+    assert.ok(reserved.value.reservation.createdAt.getTime() >= releasedAt.getTime());
+    assert.equal(
+        reserved.value.reservation.expiresAt.getTime() -
+            reserved.value.reservation.createdAt.getTime(),
+        300_000
+    );
+});
+
+test("structural, missing-stage, closed-stage and missing-reservation refusals are reachable", async () => {
+    assert.deepEqual(
+        await reservePromptRefinerExecution({ requestId: "not a machine id" }),
+        { ok: false, reason: "invalid_binding" }
+    );
+    assert.deepEqual(
+        await reservePromptRefinerExecution({ requestId: "missing_stage" }),
+        { ok: false, reason: "stage_not_found" }
+    );
+    await createStage({ status: "closed" });
+    assert.deepEqual(
+        await reservePromptRefinerExecution({ requestId: "closed_stage" }),
+        { ok: false, reason: "stage_contract_mismatch" }
+    );
+    await reset();
+    await createStage();
+    assert.deepEqual(
+        await consumePromptRefinerReservation({
+            reservationId: "missing_reservation",
+            requestId: "missing_request",
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+        }),
+        { ok: false, reason: "reservation_not_found" }
+    );
+});
+
+test("a repeated request is idempotent and never consumes a second slot", async () => {
+    await createStage();
+    const first = await reservePromptRefinerExecution({ requestId: "request_same" });
+    assert.equal(first.ok, true);
+    if (!first.ok) return;
+    await prisma.promptRefinerReservationStage.update({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+        data: { status: "closed" },
+    });
+    process.env[INPUT_PRICE_ENV] = "99";
+    const second = await reservePromptRefinerExecution({ requestId: "request_same" });
+    delete process.env[INPUT_PRICE_ENV];
+    assert.equal(second.ok, true);
+    if (!second.ok) return;
+    assert.equal(first.value.created, true);
+    assert.equal(second.value.created, false);
+    assert.equal(second.value.kind, "active");
+    assert.equal(second.value.reservation.reservationId, first.value.reservation.reservationId);
+    assert.equal(await prisma.promptRefinerReservation.count(), 1);
+    const released = await releasePromptRefinerReservation(bindingOf(first.value.reservation));
+    assert.equal(released.ok, true);
+    const terminal = await reservePromptRefinerExecution({ requestId: "request_same" });
+    assert.equal(terminal.ok, false);
+    if (terminal.ok) return;
+    assert.equal(terminal.reason, "request_already_terminal");
+    assert.equal("reservation" in terminal && terminal.reservation.status, "released");
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 1);
+});
+
+test("every exact direct insert consumes budget and forged or 101st inserts fail closed", async () => {
+    await createStage();
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const createdAt = clock!.now;
+    const firstId = randomUUID();
+    await prisma.promptRefinerReservation.create({
+        data: {
+            id: firstId,
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId: "direct_request_0",
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt,
+            expiresAt: new Date(createdAt.getTime() + 300_000),
+        },
+    });
+    let stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 1);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(24_916));
+
+    const consumed = await consumePromptRefinerReservation({
+        reservationId: firstId,
+        requestId: "direct_request_0",
+        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    });
+    assert.equal(consumed.ok, true, consumed.ok ? undefined : consumed.reason);
+
+    await assert.rejects(
+        prisma.promptRefinerReservation.create({
+            data: {
+                id: randomUUID(),
+                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                requestId: "direct_request_0",
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "reserved",
+                reservedCostMicroUsd: BigInt(24_916),
+                createdAt,
+                expiresAt: new Date(createdAt.getTime() + 300_000),
+            },
+        })
+    );
+    await assert.rejects(
+        prisma.promptRefinerReservation.create({
+            data: {
+                id: randomUUID(),
+                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                requestId: "forged_ttl",
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "reserved",
+                reservedCostMicroUsd: BigInt(24_916),
+                createdAt,
+                expiresAt: new Date(createdAt.getTime() + 300_001),
+            },
+        })
+    );
+    stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 1, "unique failure must roll trigger accounting back");
+
+    await assert.rejects(
+        prisma.promptRefinerReservation.create({
+            data: {
+                id: randomUUID(),
+                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                requestId: "forged_cost",
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "reserved",
+                reservedCostMicroUsd: BigInt(1),
+                createdAt,
+                expiresAt: new Date(createdAt.getTime() + 300_000),
+            },
+        })
+    );
+    stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 1);
+
+    await prisma.promptRefinerReservation.createMany({
+        data: Array.from({ length: 99 }, (_, index) => ({
+            id: `direct_${index + 1}`,
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId: `direct_request_${index + 1}`,
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt,
+            expiresAt: new Date(createdAt.getTime() + 300_000),
+        })),
+    });
+    await assert.rejects(
+        prisma.promptRefinerReservation.create({
+            data: {
+                id: "direct_101",
+                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                requestId: "direct_request_101",
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "reserved",
+                reservedCostMicroUsd: BigInt(24_916),
+                createdAt,
+                expiresAt: new Date(createdAt.getTime() + 300_000),
+            },
+        })
+    );
+    stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 100);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(2_491_600));
+    assert.equal(await prisma.promptRefinerReservation.count(), 100);
+});
+
+test("consume requires the four-part binding and succeeds exactly once under race", async () => {
+    await createStage();
+    const reserved = await reservePromptRefinerExecution({ requestId: "request_consume" });
+    assert.equal(reserved.ok, true);
+    if (!reserved.ok) return;
+    const binding = bindingOf(reserved.value.reservation);
+    assert.deepEqual(
+        await consumePromptRefinerReservation({ ...binding, requestId: "wrong_request" }),
+        { ok: false, reason: "request_binding_mismatch" }
+    );
+
+    const outcomes = await Promise.all([
+        consumePromptRefinerReservation(binding),
+        consumePromptRefinerReservation(binding),
+    ]);
+    assert.equal(outcomes.filter((result) => result.ok).length, 1);
+    assert.equal(
+        outcomes.filter((result) => !result.ok && result.reason === "reservation_not_active").length,
+        1
+    );
+    const row = await prisma.promptRefinerReservation.findUniqueOrThrow({
+        where: { id: binding.reservationId },
+    });
+    assert.equal(row.status, "consumed");
+    assert.ok(row.consumedAt);
+});
+
+test("the database owns terminal clocks and turns every late direct transition into expiry", async () => {
+    await createStage();
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const nearExpiryCreatedAt = new Date(clock!.now.getTime() - 298_800);
+    await prisma.promptRefinerReservation.createMany({
+        data: ["late_consume", "late_release"].map((requestId) => ({
+            id: requestId,
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId,
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt: nearExpiryCreatedAt,
+            expiresAt: new Date(nearExpiryCreatedAt.getTime() + 300_000),
+        })),
+    });
+    await prisma.$executeRawUnsafe(`
+        CREATE FUNCTION "prompt_refiner_a_test_delay_transition"()
+        RETURNS TRIGGER AS $$
+        BEGIN
+            PERFORM pg_sleep(1.5);
+            RETURN NEW;
+        END;
+        $$ LANGUAGE plpgsql;
+        CREATE TRIGGER "prompt_refiner_a_test_delay_transition_trigger"
+        BEFORE UPDATE ON "PromptRefinerReservation"
+        FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_a_test_delay_transition"();
+    `);
+    try {
+        assert.deepEqual(
+            await consumePromptRefinerReservation({
+                reservationId: "late_consume",
+                requestId: "late_consume",
+                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            }),
+            { ok: false, reason: "reservation_expired" }
+        );
+    } finally {
+        await prisma.$executeRawUnsafe(`
+            DROP TRIGGER IF EXISTS "prompt_refiner_a_test_delay_transition_trigger"
+                ON "PromptRefinerReservation";
+            DROP FUNCTION IF EXISTS "prompt_refiner_a_test_delay_transition"();
+        `);
+    }
+    await prisma.$executeRaw`
+        UPDATE "PromptRefinerReservation"
+        SET "status" = 'released'
+        WHERE "id" = 'late_release'
+    `;
+    const lateRows = await prisma.promptRefinerReservation.findMany({
+        where: { id: { in: ["late_consume", "late_release"] } },
+        orderBy: { id: "asc" },
+    });
+    assert.deepEqual(
+        lateRows.map((row) => row.status),
+        ["expired", "expired"]
+    );
+    assert.equal(lateRows.every((row) => row.expiredAt !== null), true);
+    assert.equal(lateRows.every((row) => row.consumedAt === null && row.releasedAt === null), true);
+
+    const active = await reservePromptRefinerExecution({ requestId: "db_owned_clock" });
+    assert.equal(active.ok, true);
+    if (!active.ok) return;
+    const before = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const forged = new Date(0);
+    await assert.rejects(
+        prisma.$executeRaw`
+            UPDATE "PromptRefinerReservation"
+            SET "status" = 'consumed', "consumedAt" = ${forged}
+            WHERE "id" = ${active.value.reservation.reservationId}
+        `,
+        /terminal timestamp is database-owned/i
+    );
+    await assert.rejects(
+        prisma.$executeRaw`
+            UPDATE "PromptRefinerReservation"
+            SET "status" = 'expired'
+            WHERE "id" = ${active.value.reservation.reservationId}
+        `,
+        /cannot expire before its deadline/i
+    );
+    await prisma.$executeRaw`
+        UPDATE "PromptRefinerReservation"
+        SET "status" = 'consumed'
+        WHERE "id" = ${active.value.reservation.reservationId}
+    `;
+    const after = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const consumed = await prisma.promptRefinerReservation.findUniqueOrThrow({
+        where: { id: active.value.reservation.reservationId },
+    });
+    assert.equal(consumed.status, "consumed");
+    assert.ok(consumed.consumedAt);
+    assert.ok(consumed.consumedAt.getTime() >= before[0]!.now.getTime());
+    assert.ok(consumed.consumedAt.getTime() <= after[0]!.now.getTime());
+    assert.equal(consumed.releasedAt, null);
+    assert.equal(consumed.expiredAt, null);
+});
+
+test("naive reservation timestamps remain UTC under non-UTC database sessions", async () => {
+    await createStage();
+    const [databaseZone] = await prisma.$queryRaw<Array<{ zone: string }>>`
+        SELECT current_setting('TimeZone') AS "zone"
+    `;
+    for (const [zone, requestedStatus] of [
+        ["America/New_York", "consumed"],
+        ["Asia/Seoul", "released"],
+    ] as const) {
+        await assert.rejects(
+            prisma.$transaction(async (tx) => {
+                await tx.$queryRaw`
+                    SELECT set_config('TimeZone', ${zone}, true)
+                `;
+                const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
+                    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+                `;
+                const exactId = `timezone_exact_${requestedStatus}`;
+                await tx.promptRefinerReservation.create({
+                    data: {
+                        id: exactId,
+                        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                        requestId: exactId,
+                        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                        status: "reserved",
+                        reservedCostMicroUsd: BigInt(24_916),
+                        createdAt: clock!.now,
+                        expiresAt: new Date(clock!.now.getTime() + 300_000),
+                    },
+                });
+                const exact = await tx.promptRefinerReservation.findUniqueOrThrow({
+                    where: { id: exactId },
+                });
+                assert.equal(exact.expiresAt.getTime() - exact.createdAt.getTime(), 300_000);
+
+                const lateId = `timezone_late_${requestedStatus}`;
+                const lateCreatedAt = new Date(clock!.now.getTime() - 299_700);
+                await tx.promptRefinerReservation.create({
+                    data: {
+                        id: lateId,
+                        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                        requestId: lateId,
+                        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                        status: "reserved",
+                        reservedCostMicroUsd: BigInt(24_916),
+                        createdAt: lateCreatedAt,
+                        expiresAt: new Date(lateCreatedAt.getTime() + 300_000),
+                    },
+                });
+                await wait(400);
+                await tx.$executeRaw`
+                    UPDATE "PromptRefinerReservation"
+                    SET "status" = ${requestedStatus}
+                    WHERE "id" = ${lateId}
+                `;
+                const late = await tx.promptRefinerReservation.findUniqueOrThrow({
+                    where: { id: lateId },
+                });
+                assert.equal(late.status, "expired");
+                assert.ok(late.expiredAt);
+                assert.equal(late.consumedAt, null);
+                assert.equal(late.releasedAt, null);
+                throw new Error(`rollback-${zone}`);
+            }),
+            new RegExp(`rollback-${zone.replace(/[/.]/g, "\\$&")}`)
+        );
+        assert.equal(await prisma.promptRefinerReservation.count(), 0);
+        const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+            where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+        });
+        assert.equal(stage.reservationCount, 0);
+        assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
+    }
+    const [after] = await prisma.$queryRaw<Array<{ zone: string }>>`
+        SELECT current_setting('TimeZone') AS "zone"
+    `;
+    assert.equal(after!.zone, databaseZone!.zone, "SET LOCAL must not leak past rollback");
+});
+
+test("consume observes expiry after stage-lock contention and commits the expired tombstone", async () => {
+    await createStage();
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const createdAt = new Date(clock!.now.getTime() - 300_000 + 1_000);
+    const expiresAt = new Date(createdAt.getTime() + 300_000);
+    const reservationId = randomUUID();
+    await prisma.promptRefinerReservation.create({
+        data: {
+            id: reservationId,
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId: "request_crosses_expiry",
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt,
+            expiresAt,
+        },
+    });
+    const blocker = await holdStageLock();
+    const consumePromise = consumePromptRefinerReservation({
+        reservationId,
+        requestId: "request_crosses_expiry",
+        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    });
+    await wait(Math.max(0, expiresAt.getTime() - clock!.now.getTime()) + 250);
+    blocker.release();
+    await blocker.transaction;
+    assert.deepEqual(await consumePromise, { ok: false, reason: "reservation_expired" });
+    const expired = await prisma.promptRefinerReservation.findUniqueOrThrow({
+        where: { id: reservationId },
+    });
+    assert.equal(expired.status, "expired");
+    assert.ok(expired.expiredAt);
+});
+
+test("release and expiry leave tombstones and do not refund stage bounds", async () => {
+    await createStage();
+    const releasedReservation = await reservePromptRefinerExecution({ requestId: "request_release" });
+    assert.equal(releasedReservation.ok, true);
+    if (!releasedReservation.ok) return;
+    const released = await releasePromptRefinerReservation(
+        bindingOf(releasedReservation.value.reservation)
+    );
+    assert.equal(released.ok, true);
+
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const oldCreated = new Date(clock!.now.getTime() - 300_000 + 200);
+    await prisma.promptRefinerReservation.create({
+        data: {
+            id: randomUUID(),
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId: "request_expire",
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt: oldCreated,
+            expiresAt: new Date(oldCreated.getTime() + 300_000),
+        },
+    });
+    await wait(300);
+    const expired = await expirePromptRefinerReservations();
+    assert.equal(expired.ok, true);
+    if (!expired.ok) return;
+    assert.equal(expired.value.expiredCount, 1);
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 2);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(49_832));
+    const groups = await prisma.promptRefinerReservation.groupBy({
+        by: ["status"],
+        _count: true,
+    });
+    assert.equal(
+        groups.some((group) => group.status === "released" && group._count === 1),
+        true
+    );
+    assert.equal(
+        groups.some((group) => group.status === "expired" && group._count === 1),
+        true
+    );
+});
+
+test("expiry limit orders and updates only the bounded SQL selection", async () => {
+    await createStage();
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const earlier = new Date(clock!.now.getTime() - 299_850);
+    const later = new Date(clock!.now.getTime() - 299_750);
+    await prisma.promptRefinerReservation.createMany({
+        data: [
+            { id: "expiry_limit_first", createdAt: earlier },
+            { id: "expiry_limit_second", createdAt: later },
+        ].map(({ id, createdAt }) => ({
+            id,
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId: id,
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt,
+            expiresAt: new Date(createdAt.getTime() + 300_000),
+        })),
+    });
+    await wait(350);
+    const firstSweep = await expirePromptRefinerReservations({ limit: 1 });
+    assert.equal(firstSweep.ok, true);
+    if (!firstSweep.ok) return;
+    assert.equal(firstSweep.value.expiredCount, 1);
+    const afterFirst = await prisma.promptRefinerReservation.findMany({
+        orderBy: { id: "asc" },
+    });
+    assert.deepEqual(
+        afterFirst.map((row) => [row.id, row.status]),
+        [
+            ["expiry_limit_first", "expired"],
+            ["expiry_limit_second", "reserved"],
+        ]
+    );
+    const secondSweep = await expirePromptRefinerReservations({ limit: 1 });
+    assert.equal(secondSweep.ok, true);
+    if (!secondSweep.ok) return;
+    assert.equal(secondSweep.value.expiredCount, 1);
+    assert.equal(
+        await prisma.promptRefinerReservation.count({ where: { status: "expired" } }),
+        2
+    );
+});
+
+test("runtime pricing drift rolls back without consuming a stage slot", async () => {
+    await createStage();
+    process.env[INPUT_PRICE_ENV] = "99";
+    try {
+        assert.deepEqual(
+            await reservePromptRefinerExecution({ requestId: "request_drift" }),
+            { ok: false, reason: "runtime_contract_mismatch" }
+        );
+    } finally {
+        delete process.env[INPUT_PRICE_ENV];
+    }
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 0);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
+    assert.equal(await prisma.promptRefinerReservation.count(), 0);
+
+    const reserved = await reservePromptRefinerExecution({ requestId: "request_consume_drift" });
+    assert.equal(reserved.ok, true);
+    if (!reserved.ok) return;
+    process.env[INPUT_PRICE_ENV] = "99";
+    try {
+        assert.deepEqual(
+            await consumePromptRefinerReservation(bindingOf(reserved.value.reservation)),
+            { ok: false, reason: "runtime_contract_mismatch" }
+        );
+    } finally {
+        delete process.env[INPUT_PRICE_ENV];
+    }
+    const stillReserved = await prisma.promptRefinerReservation.findUniqueOrThrow({
+        where: { id: reserved.value.reservation.reservationId },
+    });
+    assert.equal(stillReserved.status, "reserved");
+    assert.equal(
+        (await consumePromptRefinerReservation(bindingOf(reserved.value.reservation))).ok,
+        true
+    );
+});
+
+test("a registry admin update cannot slip between consume validation and reservation CAS", async () => {
+    await createStage();
+    const reserved = await reservePromptRefinerExecution({ requestId: "request_registry_lock" });
+    assert.equal(reserved.ok, true);
+    if (!reserved.ok) return;
+
+    let signalReservationLocked!: () => void;
+    let releaseReservation!: () => void;
+    const reservationLocked = new Promise<void>((resolve) => {
+        signalReservationLocked = resolve;
+    });
+    const reservationGate = new Promise<void>((resolve) => {
+        releaseReservation = resolve;
+    });
+    const reservationBlocker = prisma.$transaction(
+        async (tx) => {
+            await tx.$queryRaw`
+                SELECT "id"
+                FROM "PromptRefinerReservation"
+                WHERE "id" = ${reserved.value.reservation.reservationId}
+                FOR UPDATE
+            `;
+            signalReservationLocked();
+            await reservationGate;
+        },
+        { timeout: 15_000 }
+    );
+    await reservationLocked;
+
+    const consumePromise = consumePromptRefinerReservation(
+        bindingOf(reserved.value.reservation)
+    );
+    let registryShareLockSeen = false;
+    for (let attempt = 0; attempt < 100; attempt += 1) {
+        const [lock] = await prisma.$queryRaw<Array<{ count: number }>>`
+            SELECT COUNT(*)::INTEGER AS "count"
+            FROM pg_locks AS locks
+            JOIN pg_class AS relation ON relation.oid = locks.relation
+            WHERE relation.relname = 'ModelRegistryEntry'
+              AND locks.mode = 'ShareLock'
+              AND locks.granted
+        `;
+        if ((lock?.count ?? 0) > 0) {
+            registryShareLockSeen = true;
+            break;
+        }
+        await wait(20);
+    }
+    assert.equal(registryShareLockSeen, true);
+    try {
+        await assert.rejects(
+            prisma.$transaction(async (tx) => {
+                await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
+                await tx.$executeRaw`
+                    UPDATE "ModelRegistryEntry"
+                    SET "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
+                    WHERE "id" = ${PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId}
+                `;
+            }),
+            (error: unknown) => {
+                assert.match(String(error), /lock timeout|55P03/i);
+                return true;
+            }
+        );
+    } finally {
+        releaseReservation();
+        await reservationBlocker;
+    }
+    assert.equal((await consumePromise).ok, true);
+});
+
+test("a failure after reservation insert rolls the row and stage accounting back together", async () => {
+    await createStage();
+    await prisma.$executeRawUnsafe(`
+        CREATE FUNCTION "prompt_refiner_test_reject_stage_update"()
+        RETURNS TRIGGER AS $$
+        BEGIN
+            RAISE EXCEPTION 'forced stage update failure';
+        END;
+        $$ LANGUAGE plpgsql;
+        CREATE TRIGGER "prompt_refiner_test_reject_stage_update_trigger"
+        BEFORE UPDATE ON "PromptRefinerReservationStage"
+        FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_reject_stage_update"();
+    `);
+    try {
+        await assert.rejects(
+            reservePromptRefinerExecution({ requestId: "request_forced_rollback" })
+        );
+    } finally {
+        await prisma.$executeRawUnsafe(`
+            DROP TRIGGER IF EXISTS "prompt_refiner_test_reject_stage_update_trigger"
+                ON "PromptRefinerReservationStage";
+            DROP FUNCTION IF EXISTS "prompt_refiner_test_reject_stage_update"();
+        `);
+    }
+    assert.equal(await prisma.promptRefinerReservation.count(), 0);
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 0);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
+});
+
+test("stage-row locking admits only the remaining five slots under concurrency", async () => {
+    await createStage();
+    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
+        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
+    `;
+    const oldCreated = new Date(clock!.now.getTime());
+    await prisma.promptRefinerReservation.createMany({
+        data: Array.from({ length: 95 }, (_, index) => ({
+            id: `historic_${index}`,
+            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+            requestId: `historic_request_${index}`,
+            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+            status: "reserved",
+            reservedCostMicroUsd: BigInt(24_916),
+            createdAt: oldCreated,
+            expiresAt: new Date(oldCreated.getTime() + 300_000),
+        })),
+    });
+    const results = await Promise.all(
+        Array.from({ length: 10 }, (_, index) =>
+            reservePromptRefinerExecution({ requestId: `race_request_${index}` })
+        )
+    );
+    assert.equal(results.filter((result) => result.ok).length, 5);
+    assert.equal(
+        results.filter((result) => !result.ok && result.reason === "stage_capacity_exhausted").length,
+        5
+    );
+    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
+        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+    });
+    assert.equal(stage.reservationCount, 100);
+    assert.equal(stage.allocatedCostMicroUsd, BigInt(2_491_600));
+    assert.equal(await prisma.promptRefinerReservation.count(), 100);
+});
+
+test("database constraints reject malformed state and triggers prevent deletion or reuse", async () => {
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.create({
+            data: {
+                id: "another_stage",
+                contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "approved",
+                perRequestCostMicroUsd: BigInt(24_916),
+                maxReservations: 100,
+                costCeilingMicroUsd: BigInt(2_491_600),
+                approvedBy: "mposition",
+                approvedAt: new Date(),
+            },
+        })
+    );
+    await createStage();
+    await assert.rejects(
+        prisma.promptRefinerReservation.create({
+            data: {
+                id: "bad_state",
+                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+                requestId: "bad_state_request",
+                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+                status: "consumed",
+                reservedCostMicroUsd: BigInt(24_916),
+                expiresAt: new Date(Date.now() + 300_000),
+            },
+        })
+    );
+    const reserved = await reservePromptRefinerExecution({ requestId: "request_no_delete" });
+    assert.equal(reserved.ok, true);
+    if (!reserved.ok) return;
+    const consumed = await consumePromptRefinerReservation(bindingOf(reserved.value.reservation));
+    assert.equal(consumed.ok, true);
+    await assert.rejects(
+        prisma.promptRefinerReservation.delete({
+            where: { id: reserved.value.reservation.reservationId },
+        })
+    );
+    await assert.rejects(
+        prisma.promptRefinerReservation.update({
+            where: { id: reserved.value.reservation.reservationId },
+            data: { status: "reserved", consumedAt: null },
+        })
+    );
+    await assert.rejects(
+        prisma.promptRefinerReservationStage.delete({
+            where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
+        })
+    );
+});
diff --git a/tests/promptRefinerReservationCore.test.mjs b/tests/promptRefinerReservationCore.test.mjs
new file mode 100644
index 00000000..0cf01699
--- /dev/null
+++ b/tests/promptRefinerReservationCore.test.mjs
@@ -0,0 +1,222 @@
+import assert from "node:assert/strict";
+import { readFileSync } from "node:fs";
+import test from "node:test";
+
+import {
+    PROMPT_REFINER_EXECUTION_CONTRACT,
+    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    PROMPT_REFINER_EXECUTION_MODEL_PIN,
+    PROMPT_REFINER_MAX_INPUT_TOKENS,
+    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+    PROMPT_REFINER_RETRY_COUNT,
+    PROMPT_REFINER_TIMEOUT_MS,
+    admitPromptRefinerExecution,
+} from "../lib/promptRefinerExecutionContract.ts";
+import {
+    PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
+    PROMPT_REFINER_RESERVATION_CONTRACT,
+    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    PROMPT_REFINER_RESERVATION_REFUSALS,
+    PROMPT_REFINER_RESERVATION_STAGE_ID,
+    PROMPT_REFINER_RESERVATION_STAGE_STATUSES,
+    PROMPT_REFINER_RESERVATION_STATUSES,
+    PROMPT_REFINER_RESERVATION_TTL_MS,
+    promptRefinerReservationBindingMatches,
+    promptRefinerReservationIdentifiersAreValid,
+    promptRefinerReservationStageProblems,
+} from "../lib/promptRefinerReservationCore.ts";
+import { PROMPT_REFINER_VERSION } from "../lib/promptRefinerSuggestion.ts";
+
+const validStage = (overrides = {}) => ({
+    id: PROMPT_REFINER_RESERVATION_STAGE_ID,
+    contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    status: "approved",
+    perRequestCostMicroUsd: 24_916n,
+    maxReservations: 100,
+    costCeilingMicroUsd: 2_491_600n,
+    reservationCount: 0,
+    allocatedCostMicroUsd: 0n,
+    ...overrides,
+});
+
+test("reservation contract freezes one bounded, content-free authority", () => {
+    assert.equal(
+        PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
+        "prompt-refiner-reservation-authority-v1"
+    );
+    assert.equal(PROMPT_REFINER_RESERVATION_STAGE_ID, "prompt-refiner-shadow-v1");
+    assert.equal(PROMPT_REFINER_RESERVATION_TTL_MS, 300_000);
+    assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.perRequestCostMicroUsd, 24_916);
+    assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.maxReservations, 100);
+    assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.costCeilingMicroUsd, 2_491_600);
+    assert.equal(
+        PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+        "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f"
+    );
+    assert.deepEqual([...PROMPT_REFINER_RESERVATION_STAGE_STATUSES], [
+        "approved",
+        "closed",
+    ]);
+    assert.deepEqual(
+        [...PROMPT_REFINER_RESERVATION_CONTRACT.stageStates],
+        [...PROMPT_REFINER_RESERVATION_STAGE_STATUSES]
+    );
+    assert.deepEqual([...PROMPT_REFINER_RESERVATION_STATUSES], [
+        "reserved",
+        "consumed",
+        "released",
+        "expired",
+    ]);
+});
+
+test("stage validation rejects every mutable bound and broken accounting", () => {
+    assert.deepEqual(promptRefinerReservationStageProblems(validStage()), []);
+    const cases = [
+        ["id", "other", "stage_id_mismatch"],
+        ["contractVersion", "other", "contract_version_mismatch"],
+        ["contractDigest", "sha256:bad", "contract_digest_mismatch"],
+        ["status", "closed", "stage_not_approved"],
+        ["perRequestCostMicroUsd", 24_915n, "request_cost_mismatch"],
+        ["maxReservations", 99, "reservation_limit_mismatch"],
+        ["costCeilingMicroUsd", 2_491_599n, "stage_cost_mismatch"],
+        ["reservationCount", 101, "reservation_count_invalid"],
+        ["allocatedCostMicroUsd", 1n, "allocated_cost_invalid"],
+    ];
+    for (const [field, value, expected] of cases) {
+        assert.ok(
+            promptRefinerReservationStageProblems(
+                validStage({ [field]: value })
+            ).includes(expected),
+            field
+        );
+    }
+    assert.deepEqual(
+        promptRefinerReservationStageProblems(validStage({ status: "closed" }), {
+            requireApproved: false,
+        }),
+        []
+    );
+});
+
+test("request and reservation identifiers are bounded machine ids", () => {
+    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "request_01:a-b" }), true);
+    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "" }), false);
+    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "x".repeat(129) }), false);
+    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "prompt text" }), false);
+    assert.equal(
+        promptRefinerReservationIdentifiersAreValid({
+            requestId: "request_1",
+            reservationId: "reservation_1",
+        }),
+        true
+    );
+});
+
+test("consume binding requires all four exact identities", () => {
+    const binding = {
+        reservationId: "reservation_1",
+        requestId: "request_1",
+        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
+        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
+    };
+    assert.equal(promptRefinerReservationBindingMatches(binding, binding), true);
+    for (const field of ["reservationId", "requestId", "stageId", "contractDigest"]) {
+        assert.equal(
+            promptRefinerReservationBindingMatches(binding, {
+                ...binding,
+                [field]: `${binding[field]}_other`,
+            }),
+            false,
+            field
+        );
+    }
+});
+
+test("v1 admission remains fail-closed despite the standalone authority", () => {
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.stage.reservationAuthority, "unavailable");
+    assert.deepEqual(
+        admitPromptRefinerExecution({
+            mode: "shadow",
+            eligible: true,
+            stageApproved: true,
+            adapterReady: true,
+            contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+            refinerVersion: PROMPT_REFINER_VERSION,
+            model: { ...PROMPT_REFINER_EXECUTION_MODEL_PIN },
+            maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+            timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
+            retryCount: PROMPT_REFINER_RETRY_COUNT,
+            promptCaching: "disabled",
+            tools: "none",
+            inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS,
+        }),
+        { admitted: false, reason: "reservation_authority_unavailable" }
+    );
+});
+
+test("authority source stores no prompt/content identity and calls no provider", () => {
+    const source = readFileSync(
+        new URL("../lib/promptRefinerReservationAuthority.ts", import.meta.url),
+        "utf8"
+    );
+    for (const forbidden of [
+        "sourceText",
+        "executionPrompt",
+        "conversationId",
+        "userId",
+        "providerError",
+        "streamText(",
+        "generateText(",
+        "fetch(",
+    ]) {
+        assert.equal(source.includes(forbidden), false, forbidden);
+    }
+
+    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
+    const tables = schema.slice(schema.indexOf("model PromptRefinerReservationStage"));
+    for (const forbiddenColumn of [
+        "prompt ",
+        "content ",
+        "userId ",
+        "conversationId ",
+        "providerError ",
+    ]) {
+        assert.equal(tables.includes(forbiddenColumn), false, forbiddenColumn);
+    }
+
+    const producers = new Set(
+        [...source.matchAll(/refuse\("([a-z_]+)"\)/g)].map((match) => match[1])
+    );
+    producers.add("request_already_terminal");
+    assert.deepEqual(
+        [...producers].sort(),
+        [...PROMPT_REFINER_RESERVATION_REFUSALS].sort(),
+        "the refusal taxonomy must have an explicit producer and no dead reason"
+    );
+
+    for (const functionName of [
+        "reservePromptRefinerExecution",
+        "transitionReservation",
+        "expirePromptRefinerReservations",
+    ]) {
+        const start = source.indexOf(`const ${functionName}`);
+        const end = source.indexOf("\n};", start);
+        const body = source.slice(start, end);
+        const stageLock = body.indexOf("await lockStage");
+        const registryLock = body.indexOf("await lockModelRegistry");
+        const reservationLock = body.indexOf('FROM "PromptRefinerReservation"');
+        assert.ok(stageLock >= 0, `${functionName}: stage lock`);
+        assert.ok(registryLock > stageLock, `${functionName}: registry lock order`);
+        assert.ok(reservationLock > registryLock, `${functionName}: reservation lock order`);
+    }
+
+    const expireStart = source.indexOf("const expirePromptRefinerReservations");
+    const expireEnd = source.indexOf("\n};", expireStart);
+    const expireBody = source.slice(expireStart, expireEnd);
+    assert.match(
+        expireBody,
+        /"expiresAt" <= \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)[\s\S]*ORDER BY "expiresAt", "id"[\s\S]*LIMIT \$\{limit\}[\s\S]*FOR UPDATE/,
+        "the caller limit must bound the ordered DB lock footprint"
+    );
+});

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test tests/promptRefinerAccess.test.mjs tests/promptRefinerExecutionContract.test.mjs tests/promptRefinerReceiptCore.test.mjs tests/promptRefinerReservationCore.test.mjs tests/promptRefinerSuggestion.test.mjs` (1264ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 1180.6125

## Guard results (run by the control program)

- PASS `npm run typecheck -- --pretty false` (43377ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false --pretty false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npx eslint lib/promptRefinerReservationAuthority.ts lib/promptRefinerReservationCore.ts scripts/check-enum-constraints.mjs scripts/db-integration-groups.mjs scripts/report-unswept-tables-core.mjs scripts/run-db-integration-tests.mjs tests/integration/prompt-refiner-reservation.db.test.ts tests/promptRefinerReservationCore.test.mjs` (3470ms)
- PASS `npx prisma validate` (2249ms)
  The schema at prisma\schema.prisma is valid 🚀
- PASS `npm run check:model-pricing` (893ms)
  > ai-chat-hub@0.1.0 check:model-pricing
  > node --import tsx scripts/check-model-pricing.mjs
  
  
  Model pricing check passed: 36 explicit profiles, 0 model(s) on a conservative fallback, 0 unpriced premium models, 0 register warning(s), 0 expired pending prices.
- PASS `npm run check:enum-constraints` (1183ms)
  > ai-chat-hub@0.1.0 check:enum-constraints
  > node --conditions=react-server --import tsx scripts/check-enum-constraints.mjs
  
  Enum constraint check passed: 93 closed list(s) in the schema — 43 compared against an application list, 16 held only as a TypeScript union, 34 written down only in the database.
- PASS `npm run check:db-integration-coverage` (556ms)
  > ai-chat-hub@0.1.0 check:db-integration-coverage
  > node scripts/check-db-integration-coverage.mjs
  
  DB integration coverage check passed: 118 suite(s) in tests/integration/, all 118 named by the runner.
- PASS `npm run check:doc-references` (1547ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 868 referenced path(s) across 109 instruction document(s), and 968 path(s) named by comments across 2922 source file(s), all present.
- PASS `npm run check:policy-section-references` (1135ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4468 citation(s) against 36 policy document(s). 2890 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1351 and 227 predate this change).
- PASS `npm run check:encoding:strict` (1421ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `npm run check:data-domain-registry` (797ms)
  y\tomverse-chat-data-domain-registry.yaml: 64 data domains, all user-linked models registered.
     Deletion action: 48 delete, 9 anonymise, 2 unverified, 5 retain.
     Retention policy: 55 immediate, 2 unverified, 2 ttl, 2 statutory, 3 legal_hold.
     2 domain(s) have an unverified deletion path and 2 an unverified export state; PRIVACY-01/02 stay blocked until each is traced or recorded as retained.
- PASS `node --test tests/unsweptTables.test.mjs` (159ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 79.5439
- PASS `git diff --check 5b4b6c6daead506ffd77a25888abe3a5e932f57c HEAD -- . ':(exclude)docs/ops/cross-review/packages/prompt-refiner-reservation-authority-v1'` (59ms)

## Findings from the previous round (check each was addressed)

- [warning/evidence] prisma/migrations/20260916120000_prompt_refiner_reservation_authority/migration.sql:169-171, :226, :246, :271-275: Every DB-clock comparison mixes `clock_timestamp()` (timestamptz) with `TIMESTAMP(3)` (without time zone) columns/variables, so the whole TTL, expiry-ownership and late-consume-becomes-expired contract silently depends on the server's `TimeZone` GUC being UTC: on a non-UTC database inserts always fail closed, and if the GUC has a negative offset the guard accepts a post-deadline consume for |offset| hours instead of writing the required expired tombstone.
- [nit/judgement] lib/promptRefinerReservationAuthority.ts:328-339: The doc comment says "Expires active rows in bounded batches", but the `SELECT ... FOR UPDATE` has no `LIMIT`: it locks every `reserved` row for the stage and `limit` is only applied by `.slice()` after the client-side filter, so `limit` bounds the writes but not the lock footprint.

## Author's account (read last; a claim, not a finding)

Summary: Round 0의 두 finding을 수정했다. migration의 모든 authority DB-clock 비교와 terminal timestamp를 naive UTC column contract에 맞춰 clock_timestamp() AT TIME ZONE 'UTC'로 고정해 session TimeZone 의존을 제거했고, expiry sweep은 stage→registry SHARE lock 뒤 DB에서 expiry predicate·ORDER BY·FOR UPDATE SKIP LOCKED·LIMIT을 적용해 limit만큼만 reservation row를 잠근다. 독립 verifier가 non-UTC insert/late terminal과 lock-footprint 경계를 PASS했다. provider/product 활성화, stage seed/admin writer, runtime caller, provider/model/API 호출 없이 v1 admitted:false를 유지한다. 최신 origin/develop 기준 schema diff는 Prompt Refiner +44/-0다. focused 42와 기존 12 package guard를 이번 source commit에서 재실행한다. 별도 worktree-local PostgreSQL 17에서 fresh 112 migrations, drift 0, authority DB 17/17을 확인했고 timezone/lock-footprint 독립 검증도 통과했으나, package 생성에서는 DB를 재호출하지 않는다. full finance 비교의 실패 17개는 base에도 동일한 기존 chat concurrency/rate/image 실패였고 신규 authority 실패는 0이었다. Multi-round control scope의 filesChanged에는 source 16개와 committed round 0 audit record 7개, 총 23개가 보일 수 있지만 own output은 diff-exclude되어 reviewed diff와 changeDigest는 source 16개만 포함한다.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-reservation-authority-v1",
  "round": 1,
  "reviewedDigest": "sha256:a5f0919eaae5f83bbb3cda4bdbaf7d6c09c756fecac9c467e85bbc4864af30a7",
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
