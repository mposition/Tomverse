## 1) 판정: `reject`

Round 1의 manifest·PR identity·재실행·back-merge·badge·refresh 문제는 대부분 코드로 해소됐습니다.

하지만 merge 전 blocker가 하나 남아 있습니다. production `/api/ready` 표본에는 build-info에 적용된 캐시 freshness 검사가 없습니다. 캐시된 과거 200 응답 다섯 개로 실제 새 deployment가 unhealthy인 상태를 `production_verified`로 확정할 수 있습니다. 이는 정책 §9.3의 “production `/api/ready` 표본 5개”를 신뢰 가능한 현재 관측으로 만들지 못합니다.

또한 fix workflow callback에는 여전히 attempt/generation fencing이 없어, 만료된 실행 A의 늦은 callback이 새 실행 B의 상태를 변경할 수 있습니다.

## 2) 이전 발견 해소 표

| 이전 발견 | 판정 | 코드 근거 |
|---|---|---|
| R0 F1 `--admin` 우회 | 해소 | workflow는 PR 생성만 하며 merge 명령이 없습니다. [.github/workflows/feedback-autofix-promotion-pr.yml:188](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:188). Security regression도 `--admin`·`--auto` 부재를 확인합니다. |
| R0 F2 / R1 N1 승인 변경 결속 | 해소 | manifest가 경로별 merge-base/head blob을 저장하고 동일 path/blob set을 비교합니다. [feedbackAutoFixGitHub.ts:225](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixGitHub.ts:225), [feedbackAutoFixChangeManifest.ts:138](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixChangeManifest.ts:138). |
| R0 F3 workflow 자기 보고 | 해소 | develop/main PR의 repository·ref·head·merge·manifest를 서버가 GitHub에서 다시 읽습니다. [feedbackAutoFixPromotion.ts:150](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:150), [feedbackAutoFixPromotion.ts:446](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:446). |
| R0 F4 stale callback | **부분 해소** | promotion callback은 제거됐지만 fix callback은 `caseId + state`만 CAS합니다. [feedbackAutoFixSync.ts:122](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:122), [feedbackAutoFixSync.ts:278](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:278). |
| R0 F5 legacy 우회 간선 | 해소 | observer graph는 `approved→merged→staging_verified→production_merged→production_verified`만 사용합니다. [feedbackAutoFixPromotion.ts:529](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:529). |
| R0 F6 merge lease 유실 | 해소 | promotion에 merge lease/callback이 없고 서버가 매 pass에서 GitHub를 재조회합니다. [feedbackAutoFixPromotion.ts:365](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:365). |
| R0 F7 / R1 N2 rolling deployment | **부분 해소** | control plane + 5표본 + 10분 창은 구현됐지만 ready freshness 결함이 남습니다. [feedbackAutoFixDeploymentObservation.ts:103](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:103), [feedbackAutoFixDeploymentProbe.ts:174](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:174). |
| R0 F8 서버 Actions-write 토큰 | 해소 | 서버 GitHub 모듈은 read token과 GET만 사용합니다. [feedbackAutoFixGitHub.ts:48](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixGitHub.ts:48), [feedbackAutoFixGitHub.ts:52](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixGitHub.ts:52). |
| R0 F9 사용자 자동 메일 | 해소 | support 알림은 운영자 한 건이며 auto-review 여부만 렌더링합니다. [notificationDeliveries.ts:224](H:/Project/tomverse-support-trace-review-20260915/lib/notificationDeliveries.ts:224). |
| R0 F10 운영자 중복 메일 | 해소 | 기존 `support_feedback` renderer를 사용합니다. [notificationDeliveries.ts:224](H:/Project/tomverse-support-trace-review-20260915/lib/notificationDeliveries.ts:224). |
| R0 F11 / R1 N8 back-merge | 해소 | workflow가 `origin/main`이 `origin/develop`의 ancestor가 아니면 중단합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:131](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:131). 서버 표시용 검사도 동일 방향입니다. [feedbackAutoFixPromotion.ts:562](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:562). |
| R1 N3 trigger 신뢰 경계 | 해소 | same-repository head를 secret 사용 전 job `if`에서 검사하며 서버도 base/head repository와 refs를 검증합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:48](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:48), [feedbackAutoFixPromotion.ts:87](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:87). |
| R1 N4 PR 재실행 복구 | 해소 | deterministic branch를 먼저 조회하고 기존 branch/open PR을 재사용합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:145](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:145), [.github/workflows/feedback-autofix-promotion-pr.yml:197](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:197). |
| R1 N5 실패 callback | promotion 부분 해소 | promotion 실패 callback은 없습니다. 다만 fix callback fencing 문제는 별도 발견 N2에 남습니다. |
| R1 N6 URL freshness | **부분 해소** | build-info는 redirect와 `Age>0`을 거부하지만 ready는 status만 봅니다. [feedbackAutoFixDeploymentProbe.ts:151](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:151), [feedbackAutoFixDeploymentProbe.ts:174](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:174). |
| R1 N7 read PAT 노출 | 계약상 해소 | repository 한정 read-only, 90일 만료 및 revoke 절차가 정책에 명시됐습니다. [trace-feedback-automation.md:394](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:394). 실제 GitHub 설정은 N/V입니다. |
| R1 I1 support badge | 해소 | operator-action case를 별도 집계합니다. [adminNavigationCounts.ts:52](H:/Project/tomverse-support-trace-review-20260915/lib/adminNavigationCounts.ts:52). |
| R1 I2 pause refresh | 해소 | pause 중 refresh를 owed로 기록하고 해제 시 즉시 실행합니다. [useSupportInboxRefresh.ts:35](H:/Project/tomverse-support-trace-review-20260915/components/admin/useSupportInboxRefresh.ts:35). |
| R1 I3 trace test 범위 | 해소 | verification 전 값을 순회하고 verified-without-trace도 검사합니다. [feedbackTraceAutoReview.test.ts:18](H:/Project/tomverse-support-trace-review-20260915/tests/feedbackTraceAutoReview.test.ts:18). |

Manifest 세부 사항도 의도대로 처리됩니다.

- Rename: GitHub의 `filename`과 `previous_filename`을 모두 포함합니다. [feedbackAutoFixGitHub.ts:246](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixGitHub.ts:246)
- Delete: contents API 404를 `null` blob으로 표현합니다. [feedbackAutoFixGitHub.ts:177](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixGitHub.ts:177)
- Large file: contents body를 읽지 않고 metadata의 blob SHA만 사용합니다.
- Git script: `--no-renames`로 rename을 old-delete/new-add로 정규화합니다. [feedback-autofix-promotion-manifest.mjs:62](H:/Project/tomverse-support-trace-review-20260915/scripts/feedback-autofix-promotion-manifest.mjs:62)
- Squash/merge commit: 1-parent commit은 일반 cherry-pick, merge commit은 `-m 1`을 사용한 뒤 manifest를 재검증합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:171](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:171)

## 3) 새 발견

### N1 — blocker: `/api/ready`의 캐시 freshness를 검증하지 않음

근거:

- build-info는 `Age > 0`을 거부합니다. [feedbackAutoFixDeploymentProbe.ts:157](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:157)
- ready는 동일한 query/no-cache 요청을 사용하지만 응답의 `Age`나 cache 관련 header를 전혀 검사하지 않고 status 200만 반환합니다. [feedbackAutoFixDeploymentProbe.ts:174](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:174)
- 이 boolean 다섯 개가 모두 true이면 production readiness를 통과합니다. [feedbackAutoFixDeploymentObservation.ts:123](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:123)

구체적 실패 순서:

1. 이전 deployment가 정상일 때 proxy/CDN이 `/api/ready?...` 200을 저장합니다.
2. 새 production deployment는 기대 SHA로 배포됐지만 DB/provider readiness가 실패합니다.
3. build-info는 새 deployment를 정상적으로 반환합니다.
4. ready 요청 다섯 개는 캐시된 과거 200을 반환합니다.
5. 두 observer pass가 같은 결과를 받아 case가 `production_verified`로 전이되고 운영자에게 “production live” 메일이 갑니다.

확인 방법:

- deployment probe fetch fixture에서 build-info는 fresh 응답, ready는 `status=200`, `Age: 30`을 반환합니다.
- 현재 구현은 ready를 모두 true로 기록하고 두 번째 pass에서 verified가 됩니다.

권장 수정:

- ready에도 build-info와 같은 `status===200`, redirect 거부, `Age` 검사를 적용합니다.
- `Age`는 숫자가 아니거나 음수여도 거부하는 fail-closed parser로 공통화하십시오.
- 가능하면 ready 응답에 deployment ID/commit SHA를 넣고 build-info와 동일 deployment에 결속하십시오.
- 위 캐시 응답과 redirect 사례를 deployment-probe 단위 테스트로 고정하십시오.

### N2 — major: 만료된 fix 실행의 callback이 새 실행을 변경할 수 있음

근거:

- claim과 heartbeat는 case ID와 state만 사용합니다. [feedbackAutoFixSync.ts:94](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:94)
- lease 만료 시 같은 case를 `awaiting_human_review`로 되돌립니다. [feedbackAutoFixSync.ts:278](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:278)
- result CAS에는 attempt ID, lease generation 또는 Actions run ID가 없습니다. [feedbackAutoFixSync.ts:122](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixSync.ts:122)

구체적 실패 순서:

1. 실행 A가 case를 `fix_attempting`으로 claim합니다.
2. A의 lease가 만료되어 case가 review pool로 반환됩니다.
3. 실행 B가 같은 case를 다시 claim해 `fix_attempting`이 됩니다.
4. A의 늦은 `red_green_proven` callback이 B의 state에 성공적으로 적용됩니다.
5. 또는 A의 늦은 `fix_failed`가 B를 `fix_failed`로 종료합니다.

Owner 승인 없이 production으로 직행하지는 않으므로 blocker까지는 아니지만, round-0 F4의 코드 수준 해소는 아닙니다.

확인 방법:

- A claim → expiry reclaim → B claim → A result 순서의 server-contract 테스트를 추가합니다.
- A result는 `applied:false`여야 하나 현재는 적용됩니다.

권장 수정:

- claim 시 서버 생성 `attemptId`와 증가하는 `leaseGeneration`을 저장·반환하십시오.
- heartbeat와 모든 fix result CAS에 둘을 포함하십시오.
- workflow run ID/attempt도 진단 필드로 보존하면 운영 복구가 쉬워집니다.

### N3 — major: Railway “단일 live deployment” 판정의 실제 API 의미가 검증되지 않음

근거:

- 최근 deployment 열 건 중 status가 `SUCCESS`, `DEPLOYING`, `BUILDING` 등인 행을 모두 live로 간주합니다. [feedbackAutoFixDeploymentObservation.ts:35](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentObservation.ts:35)
- query는 deployment history의 `id/status/meta`만 가져오며 실제 traffic-active 또는 latest deployment 관계를 읽지 않습니다. [feedbackAutoFixDeploymentProbe.ts:88](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixDeploymentProbe.ts:88)
- 정책도 이 GraphQL shape와 의미를 실측 전 N/V로 인정합니다. [trace-feedback-automation.md:411](H:/Project/tomverse-support-trace-review-20260915/docs/policy/trace-feedback-automation.md:411)

문제:

Railway가 과거 성공 deployment의 status를 `SUCCESS`로 유지한다면 최근 10건 중 여러 건이 영구히 “live”로 계산되어 promotion이 절대 검증되지 않습니다. 반대로 status가 success라는 사실만으로 traffic serving 여부를 뜻하지 않는다면 “정확히 하나의 live deployment”라는 안전 근거도 성립하지 않습니다.

확인 방법:

- 실제 staging Railway GraphQL 응답에서 최근 deployment 10건의 status와 현재 service instance/latest deployment를 비교해야 합니다.
- Context7 도구는 현재 세션에 제공되지 않아 공식 API 자료로 독립 확인하지 못했습니다.

권장 수정:

- 실제 응답 snapshot을 privacy-safe fixture로 남기십시오.
- Railway의 current/latest active deployment 관계를 명시적으로 조회하고, history status를 traffic-active의 대용으로 사용하지 마십시오.
- 실측 전에는 현재 N/V 상태와 kill switch를 유지해야 합니다.

### N4 — minor: existing promotion branch의 closed-unmerged PR 복구가 불완전함

근거:

- branch가 있으면 그 내용을 그대로 사용합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:167](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:167)
- open PR만 재사용하고, 없다면 동일 branch로 새 PR을 생성합니다. [.github/workflows/feedback-autofix-promotion-pr.yml:200](H:/Project/tomverse-support-trace-review-20260915/.github/workflows/feedback-autofix-promotion-pr.yml:200)
- observer는 merged PR과 새 open PR을 모두 canonical live 후보로 세어 2개면 정지합니다. [feedbackAutoFixPromotion.ts:451](H:/Project/tomverse-support-trace-review-20260915/lib/feedbackAutoFixPromotion.ts:451)

Closed-unmerged PR만 존재할 때는 정상 재개가 가능하지만, 과거 merged PR과 같은 deterministic branch를 재사용하는 비정상 운영 상태에서는 새 PR이 생기고 observer가 수동 정리를 요구할 수 있습니다. Fail-closed이므로 merge blocker는 아닙니다.

권장 수정:

- PR 생성 전 `state=all`을 조회해 merged PR이 이미 있으면 새 PR을 만들지 말고 명시적으로 종료하십시오.

## 4) Merge 전 반드시 고칠 것

- `/api/ready` 표본에 엄격한 freshness 검사와 해당 회귀 테스트를 추가하십시오.
- 실제 Railway GraphQL 응답으로 query shape와 “live deployment” 의미를 검증하고 fixture를 남기십시오. 현 방식이 traffic-active를 증명하지 못하면 current/latest deployment 조회로 교체해야 합니다.
- fix callback에 attempt/generation fencing을 추가하거나, 적어도 이 change의 활성화 전에 완료해야 합니다. 이 변경이 “최종 구현”으로 merge되는 만큼 이번 merge에서 닫는 것을 권고합니다.

후속으로 미뤄도 되는 것:

- fine-grained PAT를 GitHub App 단기 설치 토큰으로 전환.
- closed/merged promotion branch의 운영 복구 UX 개선.
- staging `/api/ready`를 Cloudflare Access service token으로 관측.
- ready/build-info를 deployment identity가 결속된 단일 health endpoint로 통합.

검증 결과:

- 지정 핵심 순수 테스트: 17개 통과.
- git 임시 저장소를 만드는 manifest script 테스트 4개: read-only sandbox의 `%TEMP%` 쓰기 거부(`EPERM`)로 미실행이며 코드 실패로 보지 않았습니다.
- `npm run security:regression`: 190 checks 통과.
- 전체 unit runner는 703개 파일을 실행하기 시작했으나 read-only sandbox를 전제로 하지 않는 기존 임시 산출물 테스트들이 실패했고 60초 제한에서 중단했습니다.
- 파일은 수정하지 않았습니다.