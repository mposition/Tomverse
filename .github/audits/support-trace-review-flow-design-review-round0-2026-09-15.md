## 1. 판정: `reject`

현재 설계대로는 콘솔에서 승인한 코드와 실제 production에 병합되는 코드가 동일하다는 보장이 부족하고, `--admin`이 branch protection을 명시적으로 우회합니다. 또한 promotion callback의 진위·순서·실행 세대를 상태만으로 판별해 stale workflow가 후속 실행을 실패 처리할 수 있습니다.

이는 잘못된 production 코드가 사용자 데이터를 변경할 수 있다는 설계 자체의 release-blocker 기준에 해당합니다([설계 §7](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:195)).

---

## 2. 사실 오류

### 2.1 `origin/develop` 기준으로는 맞지만 현재 작업 트리에는 이미 맞지 않는 주장

설계 §1은 `FeedbackInboxPanel`이 PATCH 후 `router.refresh()`를 하지 않는다고 합니다([설계:29](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:29)).

- 요청에서 지정한 기준인 `origin/develop`에서는 맞습니다.
- 그러나 현재 작업 트리에는 미커밋된 `components/admin/useSupportInboxRefresh.ts`가 추가됐고, `FeedbackInboxPanel`은 PATCH 성공 후 `refreshInbox()`를 호출합니다([FeedbackInboxPanel.tsx:309](H:/Project/tomverse-support-trace-review-20260915/components/admin/FeedbackInboxPanel.tsx:309)).
- 현재 checkout의 HEAD도 `origin/develop` HEAD와 다릅니다.
  - HEAD: `102006072838...`
  - `origin/develop`: `fd7af39caa39...`

따라서 이 설계의 사실 기준은 “현재 작업 트리”가 아니라 명시적으로 “`origin/develop`의 `fd7af39...`”라고 적어야 합니다.

### 2.2 `Feedback.status ∈ ...`는 애플리케이션 경계만 사실

네 상태는 `FEEDBACK_STATUSES`와 PATCH Zod schema에서 제한됩니다([feedbackLifecycleCore.ts:51](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackLifecycleCore.ts:51)). 그러나 Prisma 컬럼은 일반 `String`이고([schema.prisma:1841](H:/Project/tomverse-support-trace-review-20260915/prisma/schema.prisma:1841)), DB CHECK는 없습니다.

따라서 “애플리케이션 API가 허용하는 상태”라고 좁혀 써야 합니다. DB invariant로 읽히는 현재 표현은 부정확합니다.

### 2.3 branch protection·최근 PR 관행은 저장소만으로 검증되지 않음

설계 §1의 “필수 체크 2개, 승인 리뷰 1건, `enforce_admins=false`”와 최근 PR 네 건의 병합 사실([설계:31](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:31))은 GitHub 서버 상태입니다. 저장소 파일에는 증거 스냅샷이나 확인 시각이 없습니다.

틀렸다고 단정할 수는 없지만 독립 재현 가능한 “코드에서 확인” 사실도 아닙니다. 확인 시각, API 응답의 privacy-safe 요약, repository ruleset ID를 근거로 남겨야 합니다.

### 2.4 정책 문서 자체의 구현 상태 모순

정책 표는 Phase 2·3가 구현됐다고 하지만([정책:11](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:11)), 바로 아래는 “Phase 2·3 코드는 아직 존재하지 않는다”고 합니다([정책:15](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:15)). 실제 코드는 구현돼 있으므로 후자가 오래된 문장입니다.

설계 §1의 오류는 아니지만 정책 개정 시 반드시 정리해야 합니다.

그 밖의 핵심 §1 주장은 `origin/develop` 기준으로 대체로 확인됐습니다.

- verified bug case와 알림은 신고 저장 transaction 안에서 생성됩니다([feedback route:241](H:/Project/tomverse-support-trace-review-20260915/app/api/feedback/route.ts:241)).
- 현 workflow는 `pr_open`까지만 실제 보고합니다([workflow:302](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix.yml:302)).
- 알림은 `(kind, referenceId)` unique outbox입니다([schema.prisma:2061](H:/Project/tomverse-support-trace-review-20260915/prisma/schema.prisma:2061)).
- `/api/build-info`는 의도적으로 공개돼 있습니다([staging boundary:111](H:/Project/tomverse-support-trace-review-20260915/docs/ops/staging-access-boundary.md:111)).

---

## 3. 발견 사항

### F1 — blocker: 콘솔 승인이 branch protection 우회를 정당화할 수 없음

**근거**

설계는 `gh pr merge --admin`으로 리뷰 요구를 우회하고 콘솔 승인이 GitHub 리뷰를 대신한다고 합니다([설계:49](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:49), [설계:137](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:137)). 기존 정책은 branch protection 우회를 명시적으로 금지합니다([정책:303](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:303)).

“사람이 눌렀다”와 “보호 규칙을 우회하지 않았다”는 서로 다른 invariant입니다. 소유자 계정/PAT 탈취 또는 승인 API 결함이 생기면 CI·리뷰 보호선까지 함께 무력화됩니다.

**확인 방법**

테스트 ruleset에서 review 없이 일반 merge와 `--admin` merge를 각각 실행하고 audit log 및 적용된 bypass actor를 비교합니다.

**권장 수정**

- `--admin`을 제거합니다.
- 봇/서비스 계정이 PR을 만들고, owner의 GitHub review 또는 GitHub Environment approval을 별도 주체로 요구합니다.
- 콘솔 승인은 promotion 요청 기록으로 유지하되 GitHub 보호 규칙을 대체하지 않게 합니다.
- 1인 조직 때문에 required review를 사용할 수 없다면, 별도 배포 환경의 required reviewer와 immutable approval artifact를 사용하십시오.

### F2 — blocker: 승인한 head와 production에 들어가는 콘텐츠가 끝까지 결속되지 않음

**근거**

`--match-head-commit`은 develop PR에 승인 후 push가 생기는 것만 막습니다. 하지만 설계는 이후 develop squash merge SHA를 다른 base인 `main`에 cherry-pick합니다([설계:137](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:137), [설계:141](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:141)).

Cherry-pick 결과는 승인된 commit과 SHA가 다르고, base 차이 때문에 충돌 없이도 최종 tree/diff 문맥이 달라질 수 있습니다. production PR 또한 생성 후 head SHA를 서버에 고정하거나 승인된 patch와 비교한다는 설계가 없습니다.

**확인 방법**

승인 후 `main`과 `develop`의 인접 문맥을 다르게 만든 fixture에서 cherry-pick하고 다음을 비교합니다.

- 승인 head의 `origin/develop...approvedHeadSha` patch
- develop squash merge가 만든 patch
- production branch의 `origin/main...head` patch
- production PR merge 직전 head

**권장 수정**

서버가 승인 시 canonical patch digest와 변경 파일 blob digest를 저장해야 합니다. Promotion workflow는:

1. GitHub API로 PR repository/base/head SHA를 서버가 직접 확인
2. develop 병합 결과의 first-parent patch가 승인 digest와 같은지 확인
3. production branch 생성 후 `main...head` patch digest를 다시 확인
4. production PR head SHA를 저장
5. merge 직전 그 SHA와 required checks를 다시 확인

중 하나라도 다르면 production 병합을 거부해야 합니다.

### F3 — blocker: promotion result가 여전히 workflow 자기 보고임

**근거**

설계는 “workflow 자기 보고가 아니라 서버가 직접 관측”한다고 하지만([설계:56](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:56)), `mergedAt`, merge SHA, production PR 번호·SHA는 workflow가 `/promotion/result`로 전달합니다([설계:138](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:138), [설계:143](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:143)).

기존 sync secret은 인증만 하고([feedbackAutoFixSync.ts:36](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:36)), GitHub 사실을 서버가 재조회하지 않습니다. 기존의 “서버 재검증”은 change policy와 Red→Green payload에 한정됩니다([feedbackAutoFixSync.ts:156](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:156)).

sync secret을 가진 stale/오작동 workflow가 임의의 40-hex SHA를 보고할 수 있습니다.

**확인 방법**

테스트 환경에서 실제로 병합하지 않고 유효 형식의 임의 SHA를 result endpoint에 보내 상태가 전이되는지 확인합니다.

**권장 수정**

workflow callback은 “확인 요청”으로만 취급하십시오. 서버 또는 별도 신뢰 broker가 GitHub API에서 다음을 직접 읽고 검증해야 합니다.

- repository, PR number, base ref, head ref
- head SHA
- merged 여부, mergedAt, mergeCommit SHA
- merge actor
- required check rollup
- production PR의 diff digest

서버에 GitHub read token을 두지 않으려면 GitHub App 기반 검증 서비스나 OIDC로 제한된 broker를 두는 편이 낫습니다.

### F4 — blocker: lease generation이 없어 stale callback이 새 실행을 손상시킬 수 있음

**근거**

기존 callback fencing은 `caseId + 현재 state`뿐입니다([feedbackAutoFixSync.ts:116](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:116)). claim token, run ID, lease generation이 없습니다.

따라서 실행 A의 lease가 끝난 뒤 실행 B가 같은 state를 다시 획득하면, 늦게 도착한 A의 failure/result가 B의 state에 적용될 수 있습니다. 새 promotion 상태를 추가해도 같은 방식이면 replay와 out-of-order를 안전하게 구별하지 못합니다.

**확인 방법**

A claim → lease 만료 → B claim → A callback 순서의 단위 테스트를 작성합니다. A callback이 `applied:false`여야 합니다.

**권장 수정**

각 fix/promotion claim마다 서버 생성 `attemptId`와 단조 증가 `leaseGeneration`을 발급하십시오. 모든 heartbeat/result CAS 조건에 다음을 포함해야 합니다.

- `caseId`
- 예상 state
- `attemptId`
- `leaseGeneration`
- 가능하면 GitHub Actions run ID/attempt

### F5 — major: 기존 간선을 유지하면 새 승인·production 경로를 우회할 수 있음

**근거**

설계는 기존 `pr_open→merged`, `merged→staging_verified`, `staging_verified→closed`를 유지한다고 합니다([설계:80](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:80)). 현재 그래프에도 그 간선이 있습니다([feedbackAutoFixCore.ts:89](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixCore.ts:89)).

새 경로와 함께 유지하면:

- `pr_open→merged`가 `approved`를 우회
- `staging_verified→closed`가 production 검증을 우회
- 기존 result endpoint의 `merged` callback이 새 approval invariant를 우회할 가능성

이 생깁니다.

**확인 방법**

새 그래프의 모든 상태에서 모든 endpoint payload를 탐색하는 transition-table 테스트를 만들고 `pr_open`에서 `approved` 외 production 진행 경로가 없는지 확인합니다.

**권장 수정**

한 그래프에서 legacy와 promotion 간선을 동시에 열지 마십시오. 기존 case는 명시적 `promotionMode=legacy|owner_approved` 또는 schema version으로 분리하고, 새 case에는 우회 간선을 닫아야 합니다.

### F6 — major: 만료를 즉시 실패 처리하는 것은 이중 병합을 막지 못하고 실제 병합을 유실함

**근거**

설계는 `develop_merging` lease 만료 시 GitHub 상태를 확인하지 않고 `promotion_failed`로 끝냅니다([설계:80](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:80)).

워크플로가 GitHub 병합에 성공한 직후 callback 전에 죽으면 코드는 이미 staging으로 향하지만 case는 실패로 끝납니다. production promotion과 사용자 통지만 영구히 끊깁니다. 실패 상태 자체도 병합을 취소하지 않으므로 이중 병합 방지 근거가 되지 않습니다.

**확인 방법**

GitHub merge 성공 직후 callback을 중단하고 lease를 만료시킵니다. case와 실제 branch 상태가 불일치하는지 확인합니다.

**권장 수정**

만료 시 먼저 GitHub를 reconcile하십시오.

- 승인된 PR이 승인 SHA로 병합됨 → `merged` 복구
- 여전히 open이며 head가 동일 → 새 generation으로 재개
- head 변경/closed-unmerged/identity 불일치 → 실패
- GitHub 조회 불가 → `reconciliation_pending`, 실패로 단정하지 않음

### F7 — blocker: build-info 한 번의 일치가 배포 완료·정상을 증명하지 않음

**근거**

정책은 staging 판정에 `/api/build-info`뿐 아니라 `/api/ready` 통과를 요구합니다([정책:306](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:306)). 설계 §4.4에는 `/api/ready`가 빠져 있습니다([설계:147](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:147)).

또한:

- staging URL의 단일 응답은 rolling deployment 중 새 replica 하나만 관측할 수 있습니다.
- production의 “자기 build info”는 요청을 처리한 한 프로세스만 증명합니다.
- `deploymentStatus=success`는 Railway API의 deployment 상태이며 애플리케이션 readiness나 모든 replica 전환을 뜻하지 않습니다([buildInfo.ts:255](H:/Project/tomverse-support-trace-review-20260915/lib/buildInfo.ts:255)).
- timeline은 프로세스 수명 동안 캐시됩니다([buildInfo.ts:166](H:/Project/tomverse-support-trace-review-20260915/lib/buildInfo.ts:166)).

**확인 방법**

두 replica가 서로 다른 SHA를 제공하는 rolling-deploy fixture에서 load balancer를 통해 반복 호출합니다. 단 한 번의 새 SHA 응답만으로 verified가 되는지 확인합니다.

**권장 수정**

- `/api/build-info`와 `/api/ready`를 모두 요구합니다.
- Railway deployment ID가 terminal success임을 control plane에서 확인합니다.
- 일정 안정화 창 동안 여러 차례 관측하고 deployment ID/SHA가 일관되는지 확인합니다.
- production verification은 새 배포 프로세스가 쓰는 단일 callback보다 외부 observer가 적합합니다.
- timeout은 `promotion_failed`보다 `deployment_observation_timed_out` 같은 재조정 가능 상태로 남기는 편이 안전합니다.

### F8 — major: production 서버의 Actions-write token은 권한 범위가 생각보다 큼

**근거**

설계는 dispatch token에 “Actions: write만, 코드·병합 권한 없음”이라고 평가합니다([설계:130](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:130)). 그러나 Actions write는 고정한 promotion workflow뿐 아니라 repository 내 다른 dispatch 가능한 workflow도 시작할 수 있습니다. 해당 workflow가 더 강한 secrets/PAT를 읽으면 서버 침해가 간접 권한 상승으로 이어집니다.

`ref=main`과 workflow filename을 코드에 고정해도 탈취된 PAT 자체의 API 권한은 그 호출 코드에만 제한되지 않습니다.

**확인 방법**

fine-grained PAT로 repository의 모든 `workflow_dispatch` workflow를 나열하고 각각 dispatch 가능한지 확인합니다. 각 workflow가 읽을 수 있는 environment/repository secret도 표로 작성합니다.

**권장 수정**

GitHub App 또는 짧은 수명의 OIDC broker를 권장합니다. 최소한:

- promotion 전용 GitHub Environment
- required reviewer
- production secrets를 environment에 격리
- token rotation·폐기 runbook
- dispatch 가능한 전체 workflow 위협 모델
- 서버 token과 sync secret의 별도 회전 및 로그 redaction

이 필요합니다.

### F9 — major: 요청 1이 사용자에게 자동 메일까지 보내며 설계의 자체 원칙과 충돌

**근거**

요청 1은 운영자 이메일을 요구하지만, 설계는 동의 사용자의 `feedback_user_reviewing`도 자동 enqueue합니다([설계:93](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:93)). 반면 §7은 “사용자에게 나간 메일은 회수 불가 → 사용자 메일은 운영자 버튼으로만”이라고 합니다([설계:200](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:200)).

verified token은 오류 발생만 증명하며 사용자 서술이나 실제 수정 착수 여부를 증명하지 않습니다([정책:45](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:45)). 자동 “검토 중” 메일은 실제 운영자가 보지 않은 상태에서 사람의 검토가 시작됐다고 오해하게 할 수 있습니다.

**확인 방법**

verified 신고 제출 직후 운영자 개입 없이 생성되는 lifecycle event와 delivery kind를 검사합니다.

**권장 수정**

요청 1에서는 운영자 메일만 자동화하십시오. 사용자 `feedback_user_reviewing`은 운영자가 실제로 case를 열거나 상태 버튼을 누른 시점에만 보내야 합니다. 자동 메일을 유지하려면 문구를 “자동 진단 접수”로 별도 stage/kind로 분리하고 정책의 수동 발송 원칙을 명시적으로 개정해야 합니다.

### F10 — minor: 운영자 이메일 중복 방지는 단일 kind만으로 완전히 설명되지 않음

**근거**

`(kind, referenceId)` unique는 동일 kind의 재enqueue만 막습니다([notificationDeliveries.ts:126](H:/Project/tomverse-support-trace-review-20260915/lib/notificationDeliveries.ts:126)). `support_feedback`와 `support_trace_review_started`는 서로 다른 kind이므로 둘 다 enqueue되면 둘 다 발송됩니다.

설계는 기존 kind “대신” 새 kind를 쓴다고 하지만, 혼합 버전·별도 호출 경로를 막는 DB invariant는 없습니다.

**확인 방법**

verified 신고 한 건에 두 kind를 순서대로 enqueue하면 두 행이 생성되는지 확인합니다.

**권장 수정**

신고 생성 코드가 두 kind 중 정확히 하나를 선택한다는 테스트를 추가하십시오. 더 강하게 하려면 하나의 operator-notification semantic event를 두고 template variant만 분기하십시오.

### F11 — major: back-merge와 promotion 사이의 조정이 없음

**근거**

production main push는 즉시 back-merge workflow를 시작하고([back-merge workflow:88](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/back-merge-main-to-develop.yml:88)), 이 workflow는 `main`을 `develop`에 직접 병합하려고 합니다([back-merge workflow:144](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/back-merge-main-to-develop.yml:144)).

Promotion workflow의 concurrency group은 자기 workflow만 직렬화하므로 back-merge와는 상호 배제되지 않습니다. 승인 후 develop에 후속 변경이 들어오면 cherry-pick된 production commit과 develop tip 사이에서 충돌하거나 non-empty back-merge가 발생할 수 있습니다.

**확인 방법**

승인 후 동일 파일에 별도 develop commit을 추가한 다음 production promotion과 back-merge를 실행합니다.

**권장 수정**

- promotion과 back-merge가 공유하는 repository-level lock 또는 조정 상태를 둡니다.
- production merge 후 back-merge 결과를 관측하고, 충돌이면 별도 운영자 조치 상태로 표시합니다.
- back-merge가 끝나지 않았더라도 production 배포 판정과 혼동하지 않되, 다음 promotion은 ancestry가 회복될 때까지 막는 것이 안전합니다.

---

## 4. §8 열린 질문별 권고

### 1. owner PAT `--admin` vs 봇 계정 + owner review

**권고: `--admin` 거부. 봇 계정 + owner의 별도 승인 경계를 사용.**

콘솔 승인은 audit record로 유효하지만 branch protection을 대체해서는 안 됩니다. 1인 조직이면 GitHub Environment required reviewer가 현실적인 대안입니다. 승인 주체와 병합 자격증명의 분리가 핵심입니다.

### 2. production 서버에 Actions-write dispatch token 보관

**권고: 장기 PAT를 production 서버에 두지 않음.**

GitHub App 설치 토큰이나 OIDC 기반의 짧은 수명 broker를 사용하십시오. 부득이하게 PAT를 쓰면 모든 dispatch 가능 workflow와 secret reachability를 먼저 감사하고 promotion 전용 environment approval을 둬야 합니다.

### 3. `develop_merging` lease 만료를 실패로 종료

**권고: 거부. 먼저 GitHub reconciliation.**

병합 여부를 모른다는 이유로 실패 처리하면 DB와 실제 branch가 갈라집니다. `reconciliation_pending`을 두고 PR identity/head/mergedAt/merge SHA를 조회해 복구해야 합니다.

### 4. 단일 cherry-pick과 back-merge 충돌 가능성

**권고: 가능성이 있으며 promotion 설계에 명시적으로 포함.**

정상적인 동일 tree 상태라면 back-merge는 빈 변경으로 ancestry만 회복할 수 있지만, 승인 이후 develop이 진행되면 충돌·non-empty merge가 가능합니다. patch digest 검증, 두 workflow 간 조정, back-merge 결과 관측이 필요합니다.

### 5. 요청 1을 token `verified`로 한정

**권고: 타당하며 유지.**

Trace 문자열은 인증 수단이 아니고 사용자 입력 Trace는 자동화 적격성이 아닙니다([AGENTS.md:968](H:/Project/tomverse-support-trace-review-20260915/AGENTS.md:968)). 다만 자동화 범위는 `status=reviewing`과 운영자 알림까지로 제한하고, 사용자에게 보내는 reviewing 메일은 별도 사람 행위를 요구하는 것이 안전합니다.

---

## 5. 권장 작업 순서 변경

현재 순서에서 production promotion 구현 전에 신뢰 경계와 상태 모델을 먼저 확정해야 합니다.

1. 기준 commit을 `origin/develop@fd7af39...`로 문서에 고정하고 정책의 구현 상태 모순을 수정
2. promotion 보안 계약 결정
   - `--admin` 제거
   - 승인 artifact, patch digest, GitHub server observation
   - GitHub App/OIDC 및 environment approval
3. 상태 머신 재설계
   - legacy/new graph 분리
   - attempt ID + lease generation
   - reconciliation 상태와 timeout 의미
4. 배포 관측 계약 설계
   - build-info + ready + deployment ID + 안정화 창
   - rolling replica 테스트
5. 요청 1과 요청 6 구현
   - verified 한정 유지
   - 운영자 알림 한 건
   - 사용자 자동 메일 제거 또는 별도 정책 승인
6. migration, fix report, review-request 알림
7. Admin fixes section
8. develop promotion만 먼저 구현·검증
9. production promotion과 back-merge 조정 구현
10. 장애 주입 테스트와 독립 구현 검토 후에만 kill switch 활성화 검토

필수 release-blocker 검증은 최소 다음 네 가지입니다.

- 승인 후 PR push/force-push가 production에 절대 진입하지 않음
- 승인한 canonical patch와 production PR patch가 다르면 실패
- stale/out-of-order callback이 새 attempt를 변경하지 못함
- 일부 replica만 새 SHA인 rolling 상태에서는 production verified가 되지 않음