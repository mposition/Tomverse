# 고객 지원 Trace 검토·승인·배포 흐름 설계 (2026-09-15, v3)

상태: **v3 — round 0·1(설계) reject, round 2(구현) reject 반영 후 확인 검토 `approve`(2026-09-15)**.
구현 계약의 원본은 `docs/policy/trace-feedback-automation.md` §9.3이다. 이 문서의
§3–§5는 v2 설계 기록이며, v3에서 바뀐 결정은 §2a가 우선한다.
기준 commit: `origin/develop@fd7af39c`. 운영자 요청(2026-09-15)으로 작성.
정책 원본: `docs/policy/trace-feedback-automation.md`(이하 "정책"),
`docs/ui-contracts/admin-console-ia.md`, `docs/policy/email-notifications.md`.

## 0. 운영자 요청 (원문 요약)

1. Trace ID가 들어온 신고는 자동으로 "검토중"으로 바꾸고 운영자에게 이메일.
2. Trace로 원인·해결책이 나오면 수정한 뒤 운영자에게 검토 요청 이메일.
3. Admin 콘솔에서 문제점과 해결책을 볼 수 있는 화면.
4. 검토 승인 버튼. 승인하면 staging과 production으로 배포.
5. 배포 모니터링 후 production 배포가 정상이면, 사용자 답변 초안을 "해결됨"
   화면에 넣고 운영자가 버튼으로 보낼 수 있게 함.
6. 상태 변경 후 고객 지원 수신함을 반드시 새로고침.

## 1. 현재 사실

코드 사실은 `origin/develop@fd7af39c` 기준입니다.

- `Feedback.status`는 **애플리케이션 경계에서** `open|reviewing|resolved|closed`로
  제한됩니다(`lib/feedbackLifecycleCore.ts`, PATCH Zod). DB 컬럼은 CHECK 없는 String입니다.
- 신고 저장 transaction(`app/api/feedback/route.ts`)은 case 생성, lifecycle
  `received`, `NotificationDelivery(support_feedback)`를 함께 씁니다.
- Phase 3 workflow는 `pr_open`까지만 보고합니다. `merged`/`staging_verified` callback은
  보고 주체가 없고, 서버의 GitHub 사실 재조회도 없습니다.
- 수신함 panel은 `useState(rows)`로 첫 props만 복사합니다. 그래서 셸의 새로고침도
  목록에 반영되지 않고, PATCH 후 badge도 낡습니다.
- 서버에는 GitHub 자격증명이 없습니다.
- GitHub 서버 상태는 2026-09-15 12:40Z에 `gh api`로 조회했으며 저장소 파일이 아닙니다.
  - main·develop: 필수 체크 2개, 승인 리뷰 1건, `enforce_admins=false`, ruleset 없음.
- staging은 Cloudflare Access 뒤에 있지만 `/api/build-info`는 bypass입니다.
  staging `/api/ready`는 bypass가 아니므로 외부에서 관측할 수 없습니다.

## 2. v1에서 바뀐 것 (round 0 발견 대응)

| 발견 | v2 결정 |
|---|---|
| F1 `--admin` 우회 | **병합은 전부 사람이 GitHub에서** 합니다. 자동화는 어떤 PR도 병합하지 않고, branch protection도 우회하지 않습니다. |
| F2 승인 내용 ≠ production 내용 | 승인 시 **변경 내용 digest**를 서버가 GitHub에서 읽어 고정합니다. develop 병합 시 head SHA가 같아야 하고, main 승격 PR의 digest도 같아야 합니다. 어긋나면 승격 실패로 봅니다. |
| F3 workflow 자기 보고 | 모든 GitHub 사실(병합 여부·head SHA·merge SHA·PR base·파일 digest)은 **서버가 읽기 전용 토큰으로 직접 조회**합니다. workflow callback은 "확인 요청"일 뿐입니다. |
| F4 stale callback | 남은 callback은 main 승격 PR 번호 보고 하나입니다. 서버가 GitHub에서 재검증하고, 값이 비어 있을 때만 씁니다(write-once). lease 기반 claim이 없으므로 generation 경합이 없습니다. |
| F5 legacy 우회 간선 | `pr_open→merged`, `merged→staging_verified`, `staging_verified→closed`와 result endpoint의 `merged`·`staging_verified` outcome을 **제거**합니다. 운영에서 한 번도 활성화되지 않았습니다(§9.2 N/V). |
| F6 lease 만료 실패 | 자동 병합 lease 자체가 없어졌습니다. 병합 여부는 매 관측 pass가 GitHub에서 다시 읽습니다. |
| F7 build-info 1회 | **안정화 창**을 둡니다. 서로 다른 두 관측 pass(≥10분 간격)에서 같은 commit·같은 deploymentId·`success`여야 합니다. production은 공개 `/api/ready` 200도 요구합니다. staging ready는 관측 불가로 명시합니다(N/V). timeout은 실패 상태가 아니라 화면의 "관측 지연" 표시입니다. |
| F8 서버 Actions-write 토큰 | **서버에 쓰기 토큰이 없습니다.** 읽기 전용 fine-grained PAT(Contents·Pull requests·Commit statuses: read)만 둡니다. 유출되면 소스 읽기가 노출되며, runbook에 회전 절차를 둡니다. |
| F9 사용자 자동 메일 | 요청 1은 사용자에게 메일을 보내지 않습니다. reviewing lifecycle 행은 actor 없이 기록합니다. |
| F10 운영자 메일 중복 | 새 kind를 만들지 않습니다. `support_feedback` 하나를 쓰고, 불변 필드(`errorReportVerification`)로 변형만 렌더링합니다. |
| F11 back-merge 경합 | main 승격 PR은 사람이 병합하므로 back-merge와 같은 시점에 자동 병합되지 않습니다. 승격 PR 생성 시 cherry-pick 충돌이나 digest 불일치가 있으면 PR을 만들지 않고 운영자에게 보고합니다. back-merge 결과 관측은 범위 밖(N/V)으로 둡니다. |

## 2a. v3에서 바뀐 것 (round 1 발견 대응)

| 발견 | v3 결정 (구현 위치) |
|---|---|
| N1 줄 digest가 위치 미인증 | **파일 단위 change manifest**: 경로별 merge-base blob과 head blob. main은 모든 경로에서 승인 before blob을 그대로 가져야 받고, 승격 PR은 manifest가 완전히 같아야 인정 (`lib/feedbackAutoFixChangeManifest.ts`, 실제 git으로 검증하는 `tests/feedbackAutoFixPromotionManifestScript.test.ts`) |
| N2 rolling replica | Railway control plane에서 서비스·환경의 live deployment가 **정확히 하나**, SUCCESS, 기대 commit. build-info 5표본 모두 같은 deployment, production은 ready 5표본 모두 200. 창은 두 pass ≥10분 (`lib/feedbackAutoFixDeploymentObservation.ts`) |
| N3 trigger 신뢰 경계 | workflow job `if`에서 head repo == 이 저장소, case id 형식 검사. 서버는 base/head repository·base ref·head ref·PR 번호·head SHA 모두 검증 (`pullRequestIdentityProblem`) |
| N4 write-once PR 번호 | callback 없음. 서버 observer가 결정적 브랜치로 PR을 찾고, open/merged PR이 정확히 하나일 때만 기록. workflow 재실행은 기존 브랜치·PR 재사용 |
| N5 실패 callback | 승격 실패 callback 없음. `prepare`는 read-only. fix run의 `fix_failed`는 `fix_attempting`·`red_green_proven`에서만 적용 |
| N6 public URL freshness | 표본마다 고유 query, `no-store`, redirect 거부, `Age>0` 거부. control plane 결합으로 replica 불일치 차단 |
| N7 읽기 PAT 노출 | 저장소 한정·read-only·만료 ≤90일, 유출 시 revoke 절차를 정책 §9.3에 명시. GitHub App 전환은 후속 |
| N8 back-merge | workflow가 `origin/main`이 `origin/develop` ancestor가 아니면 승격 PR을 만들지 않음. main이 승인 base를 잃었으면 manifest 검사가 거부 |
| I1 badge | `support` = open 신고 + 운영자 조치 대기 case(`pr_open`·`production_verified`·`promotion_failed`) + privacy |
| I2 pause 중 탭 복귀 | pause 중 도래한 새로고침을 owed로 기록, pause 해제 시 1회 실행 |
| I3 테스트 범위 | verification 전 값 table test + route 테스트에 forged·mismatch status 단언 |

## 2b. round 2(구현 검토) 발견 대응

| 발견 | 조치 (구현 위치) |
|---|---|
| N1 ready 캐시 freshness | build-info와 ready가 같은 `isFreshResponse()`(200 + `Age` 없음/0만)를 씀. probe 단위 테스트로 캐시·redirect 고정 (`tests/feedbackAutoFixDeploymentProbe.test.ts`) |
| N2 fix callback fencing | claim이 `fixAttemptId` 발급, heartbeat·result CAS에 포함, 회수·종료 시 제거. 만료 실행 A → 재claim B → A 늦은 callback 거부 테스트 |
| N3 Railway live 의미 | 실제 staging control plane 실측: 교체된 deployment는 REMOVED, SUCCESS 하나, WAITING·SKIPPED 공존. serving 집합을 SUCCESS·DEPLOYING·REMOVING·SLEEPING으로 좁히고 fixture로 고정 |
| (실측 중 추가 발견) | 바쁜 branch에서 정확한 병합 commit이 10분간 live이기를 요구하면 영원히 관측되지 않음 → 배포 commit이 병합 commit을 **포함**(GitHub compare)하면 인정 |
| N4 병합된 승격 PR 재실행 | PR 생성 전 merged PR 조회, 있으면 종료 |

## 3. 상태 그래프 (v2)

```
awaiting_human_review → fix_attempting → red_green_proven → pr_open   (기존)
pr_open ──(owner 콘솔 승인: headSha·patchDigest 고정)──> approved
approved ──(서버 관측: develop PR merged && PR head == approvedHeadSha)──> merged
approved ──(서버 관측: head 변경 / closed-unmerged / 다른 head로 병합)──> promotion_failed
merged ──(서버 관측: staging 안정화 창 통과)──> staging_verified
staging_verified ──(서버 관측: main 승격 PR merged, digest 일치)──> production_merged
production_merged ──(서버 관측: production 안정화 창 + /api/ready 200)──> production_verified
production_verified ──(운영자: 답변 보내고 해결됨)──> closed
pr_open|approved ──> fix_failed|promotion_failed ──> closed
```

- 승인은 `pr_open`에서만 할 수 있습니다. 운영자가 승인 없이 GitHub에서 develop PR을
  병합하면 case는 `pr_open`에 머뭅니다. 화면은 "승인 없이 병합됨 — 자동 승격 대상 아님"을
  표시하고 승격 PR을 만들지 않습니다.
- main 승격 PR 정보(`productionPrNumber` 등)는 상태가 아니라 컬럼입니다. `merged` 이후
  언제든 검증된 값이 한 번만 기록됩니다.

## 4. 요청별 설계 (v2)

### 4.1 요청 1 — 구현 완료(검토 대상)

- token `verified` + traceId가 있으면 `status=reviewing`으로 생성합니다
  (`lib/feedbackTraceAutoReview.ts`).
- lifecycle 행은 `received`(open)와 `reviewing`(open→reviewing, actor 없음) 두 개입니다.
- 사용자 메일은 보내지 않고, 운영자 메일은 `support_feedback` 1통입니다.
  - 제목·본문에 "검증된 Trace라 자동으로 검토중" 문장이 들어갑니다.

### 4.2 요청 2 — 원인·해결책과 검토 요청 메일

- workflow LLM step이 `fix-report.json`을 씁니다: `rootCause` ≤1000, `fixSummary` ≤1000,
  `testSummary` ≤500자. 입력은 기존 `EVIDENCE_JSON`뿐입니다.
- `pr_open` 결과에 `fixReport`를 싣습니다. 서버는 Zod로 검증하고 제어문자를 제거한 뒤
  저장합니다.
- PR 번호는 서버가 GitHub에서 조회해 확인합니다: base `develop`, head ref
  `feedback-autofix/<caseId>`, open 여부. 읽기 토큰이 없으면 fail-closed로
  `applied:false, reason: github_read_unavailable`을 돌려주고, workflow는 실패로 보고합니다.
- 서버가 `fixHeadSha`와 `fixPatchDigest`를 저장합니다.
- 같은 transaction에서 `NotificationDelivery(kind=autofix_review_requested, referenceId=caseId)`를
  enqueue합니다. 수신자는 `supportNotificationRecipient()`이고, 내용은 오류 코드·원인·해결·
  변경 파일·PR/콘솔 링크입니다.

### 4.3 요청 3 — 화면

- `/admin/support?tab=fixes` 새 section을 둡니다. 서버가 `searchParams`로 이 section만
  로드합니다. nav entry와 route segment는 추가하지 않으므로 redirect 영향이 없습니다.
- 카드 구성:
  - 문제: 진단 요약
  - 원인·해결: `fixReport`
  - 변경 파일과 Red→Green 증명
  - PR 링크
  - 진행 타임라인: 승인, develop 병합, staging, main PR, production, 관측 지연 경과
  - 조치 버튼
- 표시 상한 N을 화면에 명시합니다.
- 문구는 ko/en `lib/adminMessages/`에 둡니다.

### 4.4 요청 4 — 승인과 배포 (사람이 GitHub에서 병합)

**승인 API** `POST /api/admin/feedback-autofix/[caseId]/approve`

- 조건: admin, owner, 최근 인증(거절 시 step-up CTA), rate limit.
- body: 화면이 본 `headSha`.
- 서버는 GitHub에서 PR을 다시 읽어 확인합니다: open, base develop, head ref 일치,
  head SHA가 body와 stored `fixHeadSha` 둘 다와 같음, 파일 digest가 저장값과 같음.
- 모두 맞으면 CAS `pr_open→approved`로 바꾸고 `approvedAt/By/HeadSha/PatchDigest`를 기록하며
  audit log를 씁니다.
- 응답: "GitHub에서 develop PR을 병합하세요" 링크.

**승격 PR workflow** `feedback-autofix-promotion-pr.yml`

- 트리거: `pull_request: types [closed]`, base `develop`, head `feedback-autofix/**`, `merged == true`.
- dispatch 토큰도 schedule도 필요 없습니다.
- 흐름:
  1. curl step(sync secret만): `/api/internal/feedback-autofix/promotion/prepare {caseId, prNumber}`.
     서버가 GitHub를 읽어 병합과 승인 head를 검증합니다. 통과하면 `merged`로 전이하고
     `approvedPatchDigest`와 `mergeSha`를 반환합니다. 승인 전 병합이면 `{eligible:false}`로 종료합니다.
  2. git step(PAT만): `origin/main`에서 `feedback-autofix-main/<caseId>`를 만들고 merge SHA를
     cherry-pick합니다.
     - 충돌이면 실패입니다.
     - digest(`scripts/feedback-autofix-patch-digest.mjs`, 서버와 같은 순수 함수)가
       다르면 실패입니다.
  3. push 후 `gh pr create --base main`을 실행합니다. **병합하지 않습니다.**
  4. curl step: `/promotion/result {caseId, productionPrNumber}` 또는 `{caseId, failed, reason}`.
     서버가 GitHub에서 base main, head ref, digest를 재검증한 뒤 write-once로 저장합니다.
- 실패 보고는 `promotion_failed` + 운영자 메일 `autofix_promotion_failed`입니다.

**patch digest**

- GitHub PR files API의 (filename, status, patch)에서 **추가·삭제 줄만**
  (hunk header와 context 제외) 파일명 순으로 정렬해 sha256을 계산합니다.
- base가 달라도 같은 변경이면 같은 값이 되고, 다른 변경은 fail-closed로 거부됩니다.
- GitHub가 patch를 생략하는 대용량·바이너리 파일이 있으면 digest를 만들지 않고 거부합니다.
  change policy 상한(5파일/300줄) 안에서는 생략되지 않습니다.

**서버 관측 worker** (maintenance pass 편승, 읽기 전용)

- `approved`: develop PR을 조회합니다. merged이고 head가 같으면 `merged`, head 변경이나
  closed-unmerged이면 `promotion_failed`입니다. prepare 호출이 먼저 처리했으면 CAS no-op입니다.
- `merged`: staging `/api/build-info`를 봅니다. `commitSha==mergeSha && success`이면
  (commit, deploymentId, firstSeenAt)을 기록하고, ≥10분 뒤 pass에서 같은 값이면
  `staging_verified`입니다.
- `staging_verified`: `productionPrNumber`가 있으면 PR을 조회합니다. merged이고 PR head가
  기록된 head와 같고 digest가 같으면 `production_merged`(`productionMergeSha`)입니다.
- `production_merged`: production `/api/build-info`(공개 URL, 서버가 외부 요청)와
  `/api/ready` 200을 확인해 staging과 같은 안정화 창을 적용합니다.
  통과하면 `production_verified` + 운영자 메일 `autofix_production_verified`입니다.
- GitHub 조회 실패는 상태를 바꾸지 않고 다음 pass에 다시 시도합니다.

**kill switch**

- 승인 API와 관측 worker는 `FEEDBACK_AUTOFIX_ENABLED`와
  `FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN`이 모두 있어야 동작합니다. 둘 중 하나라도 없으면
  버튼은 사유와 함께 비활성입니다.

### 4.5 요청 5 — 답변 초안과 해결됨

- `production_verified` case의 신고에 결정적 템플릿 초안을 둡니다
  (`lib/feedbackAutoFixReplyDraft.ts`). 신고 언어가 ko면 한국어, 그 외는 영어입니다.
  기술 식별자와 사용자 본문은 넣지 않습니다.
- 해결됨 dialog는 outcome `fixed`와 초안을 미리 채우고 "답변 보내고 해결됨으로 표시"
  버튼을 둡니다.
- PATCH는 같은 transaction에서 case를 CAS `production_verified→closed`로 닫습니다.
- 사용자 메일은 기존 `feedback_user_completed`(동의 시)만 씁니다.

### 4.6 요청 6 — 구현 완료(검토 대상)

- `useServerSyncedRows`: 서버 rows가 바뀌면 local state를 교체합니다.
- `useSupportInboxRefresh`: 변경 성공 후 `router.refresh()`, 화면이 보이는 동안 60초 주기,
  탭 복귀 시 새로고침합니다. dialog가 열렸거나 요청 중이면 멈춥니다.
- badge `support` = open 신고 + privacy + 운영자 조치 대기 case
  (`pr_open`, `production_verified`, `promotion_failed`).

## 5. 데이터 변경 (migration 1개, 추가 컬럼만)

`FeedbackAutoFixCase`에 다음 컬럼을 추가합니다.

- 수정: `fixHeadSha`, `fixPatchDigest`, `fixReport Json`
- 승인: `approvedAt`, `approvedByUserId`, `approvedHeadSha`, `approvedPatchDigest`
- staging: `stagingObservedDeploymentId`, `stagingFirstSeenAt`, `stagingVerifiedAt`
- production PR: `productionBranch`, `productionPrNumber`, `productionPrUrl`,
  `productionPrHeadSha`, `productionMergeSha`
- production 관측: `productionObservedDeploymentId`, `productionFirstSeenAt`, `productionVerifiedAt`

## 6. 작업 순서

1. ✅ 요청 6·1 구현(테스트 통과)
2. v2 설계 → **Codex round 1**
3. 상태 그래프 v2 + migration + 순수 모듈(digest, 관측 판정, 답변 초안) + 단위 테스트
4. 요청 2(fixReport·PR 재검증·검토 요청 메일)
5. 요청 3 화면 + 요청 5 dialog
6. 요청 4(승인 API, 승격 PR workflow, prepare/result endpoint, 관측 worker)
7. 정책·AGENTS.md 개정, 전체 gate → **Codex 구현 검토** → develop PR → main worktree PR

## 7. 되돌릴 수 없는 것

- **production 배포:** 이 설계에서 자동화는 병합하지 않습니다. 사람이 GitHub에서 필수 체크와
  함께 병합합니다. 차단 항목은 digest·head 결속입니다. 틀린 승격 PR이 "승인됨"으로 보이면
  사람이 믿고 병합하기 때문입니다.
- **사용자 메일:** 운영자 버튼으로만 보냅니다.
