## 1) 판정: `approve`

Round-2의 N1–N4는 모두 코드에서 해소됐습니다. 추가된 “포함 판정”도 기존 보장을 약화하지 않으며, 지정 범위에서 새 결함은 발견하지 못했습니다.

## 2) 항목별 확인

| 항목 | 해소 여부 | 근거 |
|---|---|---|
| N1 ready 캐시 freshness | 해소 | build-info와 ready 모두 `status === 200`이며 `Age`가 없거나 정확히 0인 경우만 인정합니다. 비정상·음수·분수·중복 값도 거부합니다. [feedbackAutoFixDeploymentObservation.ts:177](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:177), [feedbackAutoFixDeploymentProbe.ts:152](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:152), [feedbackAutoFixDeploymentProbe.ts:173](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:173). 캐시된 ready 200과 redirect 회귀 테스트도 있습니다. [feedbackAutoFixDeploymentProbe.test.ts:87](H:/Project/tomverse-support-trace-review-20260915/tests/feedbackAutoFixDeploymentProbe.test.ts:87), [feedbackAutoFixDeploymentProbe.test.ts:106](H:/Project/tomverse-support-trace-review-20260915/tests/feedbackAutoFixDeploymentProbe.test.ts:106) |
| N2 fix callback fencing | 해소 | claim마다 서버가 UUID를 발급하고 저장합니다. heartbeat와 모든 result CAS가 `caseId + state + fixAttemptId`를 요구하며, PR 완료·실패·lease 회수 시 ID를 제거합니다. [feedbackAutoFixSync.ts:103](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:103), [feedbackAutoFixSync.ts:123](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:123), [feedbackAutoFixSync.ts:139](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:139), [feedbackAutoFixSync.ts:254](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:254), [feedbackAutoFixSync.ts:309](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:309). API와 workflow도 ID를 전달합니다. [heartbeat/route.ts:10](H:/Project/tomverse-support-trace-review-20260915/app/api/internal/feedback-autofix/heartbeat/route.ts:10), [result/route.ts:34](H:/Project/tomverse-support-trace-review-20260915/app/api/internal/feedback-autofix/result/route.ts:34), [feedback-autofix.yml:102](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix.yml:102). A 회수 → B 재claim → A callback 거부 테스트가 있습니다. [feedback-autofix-sync.test.ts:487](H:/Project/tomverse-support-trace-review-20260915/tests/server-contract/feedback-autofix-sync.test.ts:487) |
| N3 Railway live 의미 | 해소 | 실측 fixture에는 WAITING·SKIPPED, 단일 SUCCESS, 과거 REMOVED가 함께 기록되어 있습니다. [railwayDeploymentsStaging.json:3](H:/Project/tomverse-support-trace-review-20260915/tests/fixtures/railwayDeploymentsStaging.json:3). serving 후보는 `SUCCESS`, `DEPLOYING`, `REMOVING`, `SLEEPING`뿐이고, 정확히 하나이면서 최종 상태가 SUCCESS여야 합니다. 따라서 전환·drain 중인 deployment가 함께 있으면 fail-closed로 멈춥니다. [feedbackAutoFixDeploymentObservation.ts:48](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:48), [feedbackAutoFixDeploymentObservation.ts:102](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:102). fixture 및 draining 공존 테스트도 고정돼 있습니다. [feedbackAutoFixDeploymentObservation.test.ts:70](H:/Project/tomverse-support-trace-review-20260915/tests/feedbackAutoFixDeploymentObservation.test.ts:70), [feedbackAutoFixDeploymentObservation.test.ts:106](H:/Project/tomverse-support-trace-review-20260915/tests/feedbackAutoFixDeploymentObservation.test.ts:106) |
| N4 merged promotion PR 재실행 | 해소 | PR 생성 전에 동일 head/base의 merged PR을 조회하고, 발견하면 새 PR을 열지 않고 종료합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:188](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:188), [.github/workflows/feedback-autofix-promotion-pr.yml:200](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:200) |
| 포함 판정 | 안전하게 해소 | 동일 SHA는 즉시 인정하고, 아니면 GitHub compare를 `expected...deployed` 방향으로 호출해 expected가 deployed의 ancestor인지 확인합니다. `ahead` 또는 `identical`만 true입니다. [feedbackAutoFixPromotion.ts:360](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:360), [feedbackAutoFixGitHub.ts:203](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixGitHub.ts:203). 다른 계보의 deployment는 false, compare 실패·예상 밖 응답은 `null → containment_unknown`으로 거부됩니다. [feedbackAutoFixPromotion.ts:365](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:365), [feedbackAutoFixDeploymentObservation.ts:139](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:139). build-info 표본도 control-plane deployment의 실제 commit과 정확히 일치해야 하므로, fix를 포함하지 않는 deployment를 다른 응답으로 대신 통과시킬 수 없습니다. [feedbackAutoFixDeploymentObservation.ts:147](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:147). descendant·다른 계보 사례가 테스트돼 있습니다. [feedback-autofix-promotion.test.ts:478](H:/Project/tomverse-support-trace-review-20260915/tests/server-contract/feedback-autofix-promotion.test.ts:478) |

## 3) 새 결함

없습니다.

“포함”으로 완화된 것은 배포 SHA의 정확한 동등성뿐입니다. 다음 조건은 그대로 유지됩니다.

- 기대 commit이 실제 배포 commit의 조상이어야 함
- 정확히 하나의 serving deployment만 존재
- 그 deployment가 SUCCESS여야 함
- 모든 build-info 표본이 동일 deployment ID와 동일 배포 SHA를 보고해야 함
- production ready 표본이 모두 fresh 200이어야 함
- 동일 deployment가 10분 안정화 창을 통과해야 함

GitHub compare 장애나 다른 계보는 통과가 아니라 관측 실패로 처리되므로 보장을 약화하지 않습니다.

검증은 지정 4개 파일의 테스트 32개를 올바른 server 조건과 module-mock 플래그로 실행했고 모두 통과했습니다. 파일은 수정하지 않았습니다.