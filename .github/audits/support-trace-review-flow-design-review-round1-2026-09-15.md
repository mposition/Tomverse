## 1. 판정: `reject`

v2는 자동 병합과 branch-protection 우회를 제거했고, 사용자 자동 메일·legacy 우회 간선·workflow 자기 보고 문제도 대부분 바로잡았습니다.

그러나 다음 두 release blocker가 남습니다.

- 추가·삭제 줄만 사용하는 digest는 변경 위치와 hunk 구조를 인증하지 않아, 승인한 patch와 의미가 다른 production patch를 같은 digest로 인정할 수 있습니다.
- 10분 간격의 두 public-URL 응답은 rolling deployment의 모든 replica가 같은 production build라는 사실을 증명하지 않습니다.

잘못된 production PR을 승인된 변경으로 표시할 수 있고, 일부 replica가 이전 코드인 상태를 `production_verified`로 확정할 수 있습니다. 둘 다 사용자 데이터에 복구 불가능한 변경을 가할 가능성이 있으므로 AGENTS.md 기준 release blocker입니다.

## 2. Round-0 발견별 해소 여부

| Round 0 | 판정 | 근거 |
|---|---|---|
| F1 `--admin` 우회 | 해소 | 자동화가 어떤 PR도 병합하지 않고 사람이 GitHub에서 병합하도록 변경됐습니다. [설계:40](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:40), [설계:135](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:135) |
| F2 승인 내용과 production 내용 결속 | **미해소** | head SHA는 결속됐지만 patch digest가 위치·hunk 문맥을 버립니다. 같은 파일에서 같은 줄을 다른 위치에 삭제·추가하면 동일 digest가 가능합니다. [설계:142](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:142) |
| F3 workflow 자기 보고 | 대체로 해소 | callback을 확인 요청으로 낮추고 서버가 GitHub를 재조회합니다. 다만 head repository/owner 검증이 명시되지 않았습니다. [설계:127](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:127), [설계:137](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:137) |
| F4 stale callback | 부분 해소 | lease 경합은 없어졌지만 write-once 값의 “최초 기록자”를 안전하게 정하는 계약이 부족합니다. 실패 callback과 중복 workflow 실행도 fencing되지 않습니다. |
| F5 legacy 우회 간선 | 해소 | 우회 간선과 기존 result outcome을 제거하는 결정이며 현재 상태표에도 반영돼 있습니다. [설계:44](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:44), [feedbackAutoFixCore.ts:106](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixCore.ts:106) |
| F6 lease 만료 후 실제 병합 유실 | 해소 | 자동 병합 lease를 없애고 GitHub 상태를 반복 관측합니다. |
| F7 단일 build-info 관측 | **미해소** | 두 관측으로 개선됐지만 그 사이의 연속 안정성이나 전체 replica 전환을 증명하지 않습니다. staging은 `/api/ready`도 검증하지 않습니다. [설계:46](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:46), [설계:152](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:152) |
| F8 Actions-write 토큰 | 해소 | 서버의 write token을 제거했습니다. 읽기 PAT의 노출 범위는 새 위험으로 별도 관리해야 합니다. |
| F9 사용자 자동 메일 | 해소 | 자동 reviewing 행만 만들고 사용자 메일은 보내지 않습니다. 구현 테스트도 이를 확인합니다. [feedback-route.test.ts:1253](H:/Project/tomverse-support-trace-review-20260915/tests/server-contract/feedback-route.test.ts:1253) |
| F10 운영자 중복 메일 | 해소 | 새 kind 없이 `support_feedback`의 불변 verification 값으로 렌더링을 분기합니다. [notificationDeliveries.ts:223](H:/Project/tomverse-support-trace-review-20260915/lib/notificationDeliveries.ts:223) |
| F11 back-merge 경합 | **미해소** | 사람이 main PR을 병합한다는 것은 동시 자동 병합만 제거할 뿐, main push 뒤 back-merge 충돌과 다음 promotion의 ancestry 문제를 해결하지 않습니다. [설계:50](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:50) |

F11의 구체적 실패 순서는 다음과 같습니다.

1. Case A가 develop에서 승인됩니다.
2. 그 뒤 같은 파일에 별도 develop commit이 들어갑니다.
3. A의 commit만 main 승격 PR로 cherry-pick되어 사람이 병합합니다.
4. main push가 back-merge를 시작하지만 최신 develop 변경과 충돌합니다.
5. 설계는 이 결과를 관측하지 않으므로 case A는 production 검증까지 통과합니다.
6. ancestry가 갈라진 상태에서 case B promotion이 시작되어 충돌하거나, 예상하지 않은 non-empty back-merge가 뒤늦게 develop에 들어옵니다.

## 3. 새 발견

### N1 — blocker: patch digest가 변경 위치를 인증하지 않음

- 근거: [설계:140](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:140)
- 문제: filename과 추가·삭제 줄만으로는 hunk 위치, 주변 문맥, 적용 순서, `\ No newline` 의미를 보존하지 못합니다. 동일 문자열이 여러 곳에 있는 파일에서는 승인 위치와 다른 위치를 수정해도 같은 digest가 나옵니다.
- 확인 방법: 같은 파일의 동일한 두 블록 중 서로 다른 블록에서 `false→true`를 바꾸는 두 patch를 만들고 digest를 비교합니다.
- 권장 수정: canonical unified diff 전체를 digest 하십시오. 최소한 old/new path, status, hunk header, context, 추가·삭제 줄, EOF marker를 포함해야 합니다. 더 강하게는 각 변경 파일의 base blob SHA와 result blob SHA를 함께 고정하십시오.

“5파일/300줄이면 GitHub가 patch를 생략하지 않는다”는 보장도 성립하지 않습니다. binary, rename-only, GitHub API truncation은 줄 수 상한과 별개입니다. 누락은 fail-closed한다는 결정 자체는 맞습니다.

### N2 — blocker: 안정화 창이 rolling replica 완료를 증명하지 않음

- 근거: [설계:152](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:152), [설계:157](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:157)
- 문제: 두 요청이 우연히 새 replica에 라우팅되면, 구 replica가 계속 트래픽을 받아도 통과합니다. `/api/build-info`와 `/api/ready`가 서로 다른 replica에서 응답할 수도 있습니다.
- 확인 방법: old/new 두 replica를 둔 load-balancer fixture에서 두 지정 시점 요청만 new replica로 라우팅합니다.
- 권장 수정: Railway control plane의 deployment/replica 상태를 결합하거나, 안정화 구간 전체에서 여러 표본을 수집해 한 번이라도 다른 SHA/deployment ID가 나오면 창을 재시작하십시오. readiness 응답에도 commit/deployment identity를 넣어 같은 build와 결속해야 합니다.

### N3 — major: `pull_request: closed`의 신뢰 경계가 불완전함

- 근거: [설계:122](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:122)
- 문제:
  - fork PR의 `pull_request` workflow에는 repository secrets가 제공되지 않으므로 prepare 호출은 실패합니다.
  - fork 사용자가 `feedback-autofix/<caseId>`라는 branch name을 만들 수 있습니다.
  - same-repository branch라면 push 권한을 가진 다른 actor가 동일 패턴을 만들 수 있습니다.
  - 설계의 서버 검증에는 `head.repo.full_name`, PR 번호가 저장된 develop PR과 같은지, merge actor가 명시돼 있지 않습니다.
- 확인 방법: fork와 same-repository에서 각각 동일 branch name PR을 생성해 workflow 실행 및 prepare 판정을 확인합니다.
- 권장 수정: workflow `if`와 서버 양쪽에서 `head.repo.full_name == canonical repository`, `prNumber == stored fixPrNumber`, base/head SHA, case ID, merge actor를 검증하십시오. fork 이벤트는 secret step 전에 명시적으로 종료해야 합니다.

### N4 — major: write-once PR 번호가 재실행 복구와 선점에 취약함

- 근거: [설계:69](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:69), [설계:136](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:136)
- 실패 순서:
  1. workflow가 production PR을 생성합니다.
  2. result callback 전에 runner가 종료됩니다.
  3. 재실행은 이미 존재하는 branch 또는 PR 때문에 `push`/`gh pr create`에서 실패합니다.
  4. 기존 PR 번호가 영구히 기록되지 않고 case가 실패합니다.
- 별도 위험: 중복 실행이 각각 유효한 PR을 만들 수 있다면 먼저 도착한 값이 정답이 됩니다. write-once는 정합성 규칙이 아니라 도착 순서 규칙입니다.
- 확인 방법: `gh pr create` 성공 직후 callback을 중단하고 workflow를 rerun합니다.
- 권장 수정: deterministic branch를 GitHub에서 먼저 조회하고 기존 open PR을 재사용하십시오. `(caseId, approvedHeadSha, approvedPatchDigest)`에 대해 정확히 하나의 canonical PR만 허용하고, callback 대신 worker가 head branch/PR을 발견해 기록할 수 있어야 합니다.

### N5 — major: 실패 callback도 신뢰 가능한 사실로 취급될 여지가 있음

- 근거: [설계:136](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:136), [설계:138](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:138)
- 문제: 성공 결과는 GitHub 재검증한다고 명시했지만 `{failed, reason}`이 어떤 상태에서 적용 가능한지, 이미 유효한 PR이 존재할 때 무시되는지 정의돼 있지 않습니다. 늦은 실패 callback이 정상 case를 `promotion_failed`로 바꿀 수 있습니다.
- 확인 방법: 실행 A가 실패한 뒤 실행 B가 PR을 만들고, A의 실패 callback을 늦게 전달합니다.
- 권장 수정: callback은 상태 변경을 하지 않고 관측 요청/진단 로그만 남기십시오. 실패도 GitHub의 branch/PR 존재 여부를 reconcile한 뒤 서버 worker가 결정해야 합니다.

### N6 — major: public URL 관측에 freshness와 동일-replica 결속이 없음

- 근거: [설계:157](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:157)
- 문제: CDN/proxy cache 응답, 동일 서비스의 자기 자신을 향한 hairpin 경로, build-info와 ready 간 replica 불일치를 구분하지 못합니다.
- 확인 방법: build-info에 cache 가능한 응답을 주거나 두 endpoint를 서로 다른 replica로 라우팅합니다.
- 권장 수정: 고정 allowlist URL만 사용하고 redirect를 금지하며, cache-busting query와 `Cache-Control: no-store`를 요구하십시오. 두 endpoint 모두 commit SHA, deployment ID, instance ID를 반환하게 하거나 하나의 결속된 deployment-health endpoint를 사용하십시오.

### N7 — moderate: read-only PAT도 private source 전체를 노출함

- 근거: [설계:47](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:47), [설계:164](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:164)
- 문제: `Contents: read`는 쓰기 권한은 없지만 production 서버 침해 시 private source와 workflow 구성을 유출합니다. 장기 PAT의 actor 수명·만료·저장 위치도 정의되지 않았습니다.
- 확인 방법: 토큰으로 읽을 수 있는 repository/API 목록과 expiration을 실제 GitHub 설정에서 확인합니다.
- 권장 수정: repository 한정 GitHub App 설치 토큰 또는 짧은 수명 broker를 우선 사용하십시오. PAT를 유지하면 만료일, 최소 repository scope, secret-store 위치, rotation/revocation runbook을 설계의 필수 조건으로 두십시오.

### N8 — major: back-merge 상태를 범위 밖으로 둔 결정은 F11을 닫지 못함

- 근거: [설계:50](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:50)
- 확인 방법: round-0 F11의 동일 파일 변경 시퀀스를 실행합니다.
- 권장 수정: back-merge 결과를 관측하고 `backmerge_pending|conflicted|complete`를 운영 상태로 분리하십시오. 다음 promotion은 main이 develop의 ancestor이거나 직전 back-merge가 완료됐을 때만 시작해야 합니다.

## 4. 구현 발견 — 요청 1·6

### I1 — major: 요청 6의 support badge 구현이 빠짐

설계는 support badge를 “open 신고 + privacy + 운영자 조치 대기 case”로 정의하고 완료로 표시합니다. [설계:178](H:/Project/tomverse-support-trace-review-20260915/.github/audits/support-trace-review-flow-design-2026-09-15.md:178)

하지만 실제 집계는 여전히 `Feedback.status == open`만 셉니다. `pr_open`, `production_verified`, `promotion_failed` case count도 없고 reviewing 신고도 제외됩니다. [adminNavigationCounts.ts:49](H:/Project/tomverse-support-trace-review-20260915/lib/adminNavigationCounts.ts:49)

- 확인 방법: open feedback 0건, `pr_open` case 1건을 만든 뒤 support badge를 조회합니다. 현재 설계대로라면 1이어야 하지만 0입니다.
- 권장 수정: 관련 count를 같은 navigation query에 추가하고, badge 합산·부분 query 실패 의미를 정의하십시오. 중복 신고/case를 합산할지 distinct work item으로 셀지도 테스트로 고정해야 합니다.

### I2 — moderate: 탭 복귀가 pause 중이면 즉시 새로고침되지 않음

[useSupportInboxRefresh.ts:31](H:/Project/tomverse-support-trace-review-20260915/components/admin/useSupportInboxRefresh.ts:31)은 `paused`일 때 visibility listener 자체를 제거합니다.

- 실패 순서: dialog open → 탭을 숨김 → 서버 상태 변경 → 탭 복귀 → visibility event는 pause 때문에 관측되지 않음 → dialog 닫음 → 즉시 refresh 없이 최대 60초 동안 낡은 화면 유지.
- 권장 수정: visibility listener는 유지하되 pause 중 복귀 사실을 pending으로 기록하고, `paused: true→false` 전환 시 한 번 refresh하십시오.

### I3 — minor: 요청 1의 테스트 범위가 구현 규칙보다 좁음

구현 규칙은 모든 `verified + traceId` 유형을 reviewing으로 올립니다. [feedbackTraceAutoReview.ts:22](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackTraceAutoReview.ts:22) 현재 route 계약 테스트는 verified support 한 건과 token 없는 bug만 직접 확인합니다. [feedback-route.test.ts:1217](H:/Project/tomverse-support-trace-review-20260915/tests/server-contract/feedback-route.test.ts:1217)

- 권장 수정: forged, expired, payload mismatch, 빈 traceId 및 verified feature/support/bug 사례를 table test로 고정하십시오.
- 현재 구현 자체에서 사용자 자동 메일이나 중복 운영자 메일 결함은 발견하지 못했습니다.

검증 참고: 지정 server-contract 명령은 테스트 러너가 장시간 종료되지 않아 완료 전에 중단했습니다. 따라서 설계 문서의 “테스트 통과”를 이번 독립 리뷰에서 재확인한 것으로 간주하지 않았습니다. `git diff --check`는 통과했으며 파일은 수정하지 않았습니다.