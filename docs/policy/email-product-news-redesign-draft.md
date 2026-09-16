# 제품 소식 이메일: 권한과 기계 (초안 v21)

> **이 문서의 지위: 초안입니다.** 승인되지 않았습니다. **S1a는 구현·병합됐습니다**(#1492,
> [이메일 알림](email-notifications.md) v15).
> **S0와 S1b는 착수할 수 있습니다**(12절) — G는 EEA·영국 soft opt-in만 막습니다.
> 그 밖의 단계는 12절의 선행 결정이 닫힌 뒤입니다. 이 문서가
> 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

## 0. 개정 이력

### v21 (2026-09-16) — 독립 검토 16회차 반영

16회차(v20 대상)는 C69·C70·C72·C73을 닫고, 결정이 필요한 5건과 구현 세부 3건을
남겼습니다. 결정 5건 중 둘(C75·C76)은 v20이 **한 배포 안에서** 이전 build와 새 build의
공존을 해결하려 한 데서 생겼습니다. v21은 그것을 **세 번의 배포로 나눠** 공존 문제
자체를 없앱니다.

| # | 지적 | v21 |
|---|---|---|
| **C75** | 요약 재계산이 이전 build의 entry 변경을 덮어씀, gate가 존재만 검사 | **3단계 배포(A shadow → B 원인 권위 → C entry 쓰기 중단)**. A·B는 entry를 **지금의 병합 규칙 그대로** 계속 쓰고 요약으로 덮지 않음. C의 gate는 효과·만료·provenance 동등성(7.4) |
| **C76** | 여러 원인을 한 entry로 투영하는 규칙 없음 | 투영하지 않음 — A·B의 entry 쓰기는 **사건마다 지금의 `recordSuppression()` 병합**이고, 공존하는 이전 build는 지금과 같은 보장만 받음(7.4) |
| **C77** | 같은 시각의 delivered와 bounce가 처리 순서에 좌우 | **같은 시각이면 bounce가 이깁니다** — 원인·delivery 상태·연속 횟수 모두 `(occurredAt, bounce > delivered)` 순서(7.4) |
| **C78** | 10번째 lease 만료 뒤 늦은 worker가 abandon된 행을 processed로 만듦 | 완료 write는 `abandonedAt IS NULL`, abandon write는 `processedAt IS NULL AND lease 만료`를 요구하고 lease를 비움 — **먼저 커밋한 쪽이 승자**(7.4) |
| **C79** | `providerMessageId` 기록 전에 온 webhook이 unmatched로 확정됨 | unmatched 사건은 **15분 `awaiting_delivery`** 로 남고 sweeper가 재결속, 지나면 주소 기준 효과로 확정(7.4) |
| C80 (구현) | delivery 없는 soft bounce 키 | `webhook:<ProviderWebhookEvent.id>` fallback |
| C81 (구현) | 계정·delivery 결속이 S1b-2에 있음 | **S1b-1로 이동** |
| C82 (구현) | 상위 계약(이메일 알림) 9.6·10.2·13.3·13.5·14.4절 동기화 누락 | S0 목록에 추가 |

### v20 (2026-09-16) — 독립 검토 15회차 반영

15회차(v19 대상)는 C65·C66·C67을 닫고 7건을 남겼습니다. S1b-3은 "자체 계약은 착수
가능"으로 판정됐습니다. 모두 기술 결정입니다.

| # | 지적 | v20 |
|---|---|---|
| **C68** | 배포 중 이전 build가 entry를 만들고·고치고·지우면 원인만 읽는 새 build가 놓침 | **dual-read를 계약으로** — 새 build는 활성 원인 **∪** entry를 읽고, entry를 요약으로 계속 씀. 이전 build의 삭제는 원인을 남겨 **막는 쪽으로** 틀림. entry 읽기 제거는 이전 build가 남지 않은 뒤 별도 contract 단계(7.4) |
| **C69** | sole-admin 감사 id가 사전 권한 근거인지 해제 감사인지 모호 | **`authorizationAuditLogId`(사전)와 `releaseAuditLogId`(해제 transaction 안)를 따로**, 증거는 둘 다 저장. `writeAdminAuditLog()`는 이미 transaction을 받으므로 바꿀 것은 id 반환뿐(7.4) |
| **C70** | complaint 철회를 현재 `ConsentRecord`·preference CHECK로 표현 불가 | `capturedVia`·preference `source`·전이 `source`에 **`provider_complaint`** 추가, 정책·관할권은 **originating delivery가 고정한 값**(7.4) |
| **C71** | 늦은 delivered가 먼저 처리된 뒤 오래된 bounce가 오면 결과가 수신 순서에 좌우 | **provider 사건 시각의 단조 규칙** — 더 늦은 delivered가 이미 있으면 그보다 오래된 bounce는 원인·상태·연속 횟수에 반영하지 않음. 양쪽 순서 replay가 같은 결과(7.4) |
| **C72** | delivery 조회에 계정 구분이 없음 | **`EmailDelivery.providerAccount`를 발송 시 고정**, `(providerAccount, providerMessageId)`로 조회·unique. 기존 행은 분류에서 backfill(7.4) |
| **C73** | 원인에 판정용 provenance 컬럼이 빠짐 | `sourceStream`·`sourceDomain`·`sourceClassification`·`providerAccount`·`evidence`를 **명시 컬럼으로**, 기존 entry에서 전부 backfill. unmatched webhook의 stream은 검증된 계정에서(7.4) |
| **C74** | 10번째 처리 여부와 실패 후 lease가 모호 | **`attempts < 10`일 때만 claim → 증가 → 실행**, 실패의 fenced write가 lease를 즉시 비우고 **10번째 실패에서만** abandon. 전이 표(7.4) |

### v19 (2026-09-16) — 독립 검토 14회차 반영

14회차(v18 대상)는 C53·C55·C59·C60을 닫고 7건을 남겼습니다(10 → 7). 모두 기술
결정이고, S1b-3은 "자체 계약에 남은 결정은 없고 S1b-1 위에 선다"는 판정이었습니다.

| # | 지적 | v19 |
|---|---|---|
| **C61** | 기존 `SuppressionEntry`를 원인으로 옮기는 migration 없음 | 같은 migration에서 **행마다 원인 하나로 backfill**(`legacy:suppression:<entryId>`), 건수 대조가 다르면 migration 실패. 코드 배포 전에 끝남(7.4) |
| **C62** | 관리자 1명 해제의 감사 id를 원자적으로 얻을 경로 없음 | **감사 행과 원인 해제를 한 transaction**에서 씀. `writeAdminAuditLog`가 transaction과 id 반환을 지원. 세 해제 종류 모두 같은 방식(7.4) |
| **C63** | "preference 전이 기록" 모델이 없음 | append-only **`EmailPreferenceTransition`** 을 추가, 모든 켜기·끄기가 같은 transaction에서 씀(7.4) |
| **C64** | 늦게 처리된 오래된 delivered가 이후 bounce 원인을 지움 | **`occurredAt`이 delivered보다 엄격히 이른 soft bounce 원인만** 해제 — 같으면 해제하지 않음(7.4) |
| **C65** | complaint가 어느 사용자의 preference를 바꾸는지 없음 | **originating delivery의 `userId`**, User 행 잠금 후 현재 주소가 같을 때만. 다르거나 없으면 주소 기준 원인만(7.4) |
| **C66** | 만료를 누가 기록하는지 없음 | 발송 판정·관리자 화면은 **원인을 직접 읽어 만료를 제외**하고, 15분 runner가 만료 원인에 해제를 기록하고 요약을 수선(7.4) |
| **C67** | 계정별 침묵 판정의 발송 증거 source 없음 | **`EmailDelivery.sentAt`으로 좁힘**, 제외 경로를 이름으로 적고 시계는 DB `now()` 하나(7.4) |

### v18 (2026-09-16) — 독립 검토 13회차 반영

13회차(v17 대상)는 C47·C49·C50을 닫힘으로 보고 reject였습니다. 모두 기술 결정이며,
코드와 기존 계약(이메일 알림 v15)에서 확인한 사실 셋이 결정을 바꿨습니다 — 1인
관리자 승인 경로는 승인 행을 만들지 않고, `maintenance:cleanup`은 하루 한 번이며,
v15는 soft bounce를 "성공 시 해제"한다고 적습니다.

| # | 지적 | v18 |
|---|---|---|
| **C51** | "가장 강한 해제 요건"은 원인별 조건과 양립 불가 | **해제 행위 × 원인 행렬.** 행위는 자기가 풀 수 있는 원인만 풀고 나머지는 남음(7.4) |
| **C52** | 1인 관리자 경로에는 승인 행이 없음 | **일반화된 해제 증거** — `dual_approval(approvalId)` 또는 `sole_admin(auditLogId)`. 승인 callback이 승인 문맥을 받도록 API 변경(7.4) |
| **C53** | `marketing:*`의 저장 표현 미정 | **새 scope `classification`**, `purposeKey`는 분류 이름. CHECK·조회·표시·해제 규칙, 7.6 입력 갱신(7.4, 7.6) |
| **C54** | `(sourceMessageId, reason)` unique는 멱등성을 보장 못 함 | **writer별 `sourceEventKey`** 와 `(address, scope, purposeKey, reason, sourceEventKey)` unique(7.4) |
| **C55** | 15분 maintenance cron이 없음 | 15분 주기로 이미 도는 **`maintenance:credit-reservations` runner의 알림 drain 단계**에 sweep을 붙임. batch·시간 예산(7.4) |
| **C56** | 계정이 둘인데 webhook은 secret 하나, 계정 식별 없음 | **stream별 endpoint·secret**, `ProviderWebhookEvent.providerAccount`, silence는 같은 계정끼리(7.4) |
| **C57** | v15 "성공 시 해제"와 충돌 | v15 유지 — **delivered 사건이 그 주소의 활성 soft bounce 원인만 해제**(7.4) |
| **C58** | complaint의 목적 opt-out이 빠짐 | originating version의 purpose가 있으면 **같은 효과 처리에서 preference 끄기 + `ConsentRecord(withdrawn)`**(7.4) |
| **C59** | User 행 잠금과 주소 잠금 순서가 경로마다 다름 | **총잠금 순서 하나** — User 행 → 주소 전역 → classification → purpose → EmailPreference 행. 주소만 아는 writer는 사전 조회 후 재검증(7.4) |
| **C60** | S1b 요약에 폐기된 "이유 우선순위"가 남음 | 교체(12) |

### v17 (2026-09-16) — 독립 검토 12회차 반영

12회차(v16 대상)는 C35·C41·C42를 닫힘으로 보고, S1b 세 PR 모두에 남은 결정을 짚어
reject였습니다. 핵심은 **suppression 한 행이 여러 원인을 담지 못한다**는 것이었고,
v17은 원인을 따로 보존하는 구조로 바꿉니다. 모두 기술 결정입니다.

| # | 지적 | v17 |
|---|---|---|
| **C44** | 순위 하나로 차단 강도와 해제 요건을 함께 표현할 수 없음 | **원인을 append-only로 따로 보존**(`SuppressionCause`). 차단은 활성 원인들의 합, 해제 요건은 가장 강한 원인의 것(7.4) |
| **C45** | 두 번째 관리자 승인 필요 여부를 잠금 밖에서 판정 | **잠금 안에서** 활성 원인으로 요건을 계산하고, 승인이 **그 원인 id 집합**에 묶여 있어야 삭제. 다르면 `approval_required`(7.4) |
| **C46** | 삭제 접수 시 "모든 marketing purpose"의 source가 S3에야 생김 | purpose 열거 대신 **`marketing:*` wildcard suppression** — 발송 시 version의 classification이 marketing이면 purpose와 무관하게 막음. 기존 철회도 같은 transaction(7.4) |
| **C47** | lease 완료·실패 write에 fencing 없음 | claim마다 **`processingLeaseId`** 발급, 성공·실패 갱신은 그 id와 `processedAt IS NULL` 조건부(7.4) |
| **C48** | provider 재전송 8회로는 10회 종료 조건에 못 닿음 | **내부 sweeper**가 만료된 미처리 행을 claim, 10회에서 `abandonedAt`+incident. 미처리 1시간·webhook 24시간 무수신 incident(7.4) |
| **C49** | 추가·제거 안내의 template 계약 없음 | **`login_method_linked`·`login_method_unlinked` 두 template**, version은 transaction 전에 확정(7.4) |
| **C50** | 사건 시각 기준 없음 | 검증된 provider `created_at`, 없으면 최초 `receivedAt`. 원인이 append-only라 덮어쓰기 자체가 없어짐(7.4) |

### v16 (2026-09-16) — 독립 검토 11회차 반영: S1b 선행 결정

11회차(v15 대상)는 **S1a 착수 가능, S1b 착수 불가**였고 S1b에 빠진 결정 다섯과
나머지 지적을 짚었습니다. S1a는 그 사이 구현·독립 코드 검토 3회를 거쳐 병합됐습니다.
v16은 **S1b를 착수 가능하게 만드는 결정**을 적습니다. 다섯 모두 소유자 결정이 아닌
기술 결정입니다.

| # | 지적 | v16 |
|---|---|---|
| **C35** | 관리자 테스트 메일이 sender 목록에 없음 | **운영자 진단 경로로 allowlist.** 수신자가 로그인한 관리자 자신이고, 목적이 provider 설정 확인이라 suppression이 끼면 시험이 거짓말을 합니다(7.4) |
| **C36** | 로그인 방법 변경 안내에는 claim·backoff가 없음 | **standard lane으로 옮깁니다.** 요청 transaction 안에서 enqueue, 이후는 standard lane 규칙(7.4) |
| **C37** | 실패한 webhook 재전송이 `duplicate`로 끝나 재처리되지 않음 | `processedAt IS NULL` 행을 **lease로 claim**해 재처리하는 상태기계(7.4) |
| **C38** | 삭제 요청 접수 시 `withdrawAllMarketing()`은 `risk_accepted` cohort를 막지 못함 | 접수 transaction에서 **모든 marketing purpose에 `privacy_request` purpose suppression**. override는 suppression을 넘지 못합니다(7.4) |
| **C39** | `privacy_request`가 다른 이유로 덮어써져 provenance가 사라짐 | **이유 우선순위**를 정하고 `privacy_request`는 어떤 이유로도 덮어쓰지 않음(7.4) |
| **C40** | 제거 경로가 잠금·이유 확인을 거치지 않음 | 제거도 같은 잠금 순서와 잠금 안 재조회. preference 재활성화는 **자기가 만든 이유의 행만** 지움(7.4) |
| **C41** | 알림 큐 한 파일에 운영자·고객 kind가 섞여 파일 단위 정적 검사가 우회됨 | 운영자 발송을 **별도 module로 분리**, 알림 큐 파일은 allowlist에서 뺌(7.4) |
| **C42** | 판정 출력의 `pinnedVersion`·`requiredVersion`이 정의되지 않음 | `pinnedDisplayContractHash`·`requiredDisplayContractHash`·`satisfied`로 통일(7.6) |
| **C43** | legal hold 해제 후 suppression 규칙 없음 | **결과 상태가 `completed && !legalHold`가 될 때마다** 멱등으로 보장(7.4) |

### v15 (2026-09-16) — 독립 검토 10회차 반영

10회차(v14 대상)는 **S1a 착수 가능**으로 보고, S1b와 나머지에 남은 것을 짚어
reject였습니다. 코드에서 직접 확인한 사실 셋이 설계를 넓혔습니다 — 로그인 방법
변경·환불 메일은 suppression을 보지 않고, admin suppression route는 이유를 항상
`manual`로 쓰며, privacy request workflow는 suppression을 만들지 않습니다.

| # | 지적 | v15 |
|---|---|---|
| **C28** | DOI 확인 요청 메일은 동의가 일어나기 전에 나가므로 처리결과 통지가 될 수 없음 | **클릭이 성공한 transaction에서** 별도 `consent_result_notice`를 enqueue, 반복 클릭은 한 번(7.7) |
| **C29** | 고객 대상 sender 목록이 불완전 | 고객 대상 sender 전체를 적고 **공용 잠금 helper**로 모음. 운영자 알림만 예외. 직접 provider 호출을 막는 정적 검사(7.4) |
| **C30** | `privacy_request` suppression을 만드는 곳이 실제로 없음 | **삭제 요청 접수 시 marketing 전체 철회, 완료 시 전역 suppression** — 같은 transaction, request id provenance(7.4) |
| **C31** | provider·transaction·lock timeout 수치 없음 | 수치와 timeout 시 상태를 확정. credential은 3초 예산 안에서 잠금 대기를 빼고 남은 시간으로 provider timeout 계산(7.4) |
| **C32** | 가입일 anchor의 source 필드·member 불변성·기한 감시·문구 | `noticeAnchorSource` 불변 필드, 승인과 member를 한 transaction으로 seal, 감시는 수신자별 `실제 동의일 ?? noticeAnchorAt`, 문구는 기준일과 수신 시작일을 구분(7.7) |
| **C33** | `requiredDisplayVersion` 정의 없음 | **`displayContractHash`** 를 정의하고 delivery에 고정, idempotency key는 root + generation + hash 앞 16자(7.6) |
| **C34** | 의무가 적용되지 않는 후보의 의미 | 의무 key별로 **적용 후보만** 합성, 비적용은 중립(5.3) |

### v14 (2026-09-16) — 독립 검토 9회차 반영

9회차(v13 대상)는 L12·C19·C20을 닫힘으로 보고 reject였습니다. 새 법률 오류는
없었고, 남은 것은 **발송 시점까지 이어지는 증거**였습니다. 그 사이 소유자 결정
하나가 들어왔습니다 — `risk_accepted` cohort의 2년 고지 기준일은 **가입일로
간주**합니다(7.7).

| # | 지적 | v14 |
|---|---|---|
| **C21** | 추정 국가 후보가 attempt·사건·delivery에 하나만 남음. 후보들의 표시 의무 합성 규칙 없음 | 후보별 `{country, signal, ruleVersion, copyHash}` 목록을 attempt → 사건 → 두 snapshot까지 전달. 표시 의무는 **합집합**, 충돌하면 fail-closed. `self_declared`는 후보 목록을 대체(5.3, 7.6) |
| **C22** | cohort 쌍을 검증할 입력이 없음. enqueue 뒤 주소 변경 | 판정 입력에 `userId`·pinned delivery 주소·**send 시점 현재 계정 주소**. 세 digest가 active member와 일치해야 하고 삭제·주소 없음·불일치는 blocker(5.6, 7.6) |
| **C23** | credential lane 제외 근거가 사실과 다름(로그인 코드는 임의 주소로 시작 가능), privacy request 경합 누락 | **제외를 철회**. credential lane도 provider 시도마다 전역 잠금 안에서 재검사. 잠금은 짧은 `lock_timeout`, 실패하면 그 시도는 실패로 처리(7.4) |
| **C24** | `immutable` 원장에 `revokedAt` 갱신. waiver 검증 규칙 없음 | 승인 본문은 불변, 철회는 append-only `EmailSendApprovalRevocation`. override와 waiver는 **active·유형·범위 정확 일치**를 검증하고, 실패하면 미결과 같이 차단(6, 7.8) |
| **C25** | canary는 복호화만 보므로 end-to-end가 아님 | 7.5를 **keyring canary readiness**로 이름을 좁히고 불변식 10과 분리. 불변식 10은 활성화 전 단계로 이동(7.5, 12) |
| **C26** | 재enqueue의 원자성·중복·계보 없음 | skip과 replacement 생성은 한 transaction, `supersedesDeliveryId` unique, 결정적 idempotency key(7.6) |
| **C27** | v12 이력의 차단 조건 설명이 7.8과 다름 | 세 조건을 모두 적음 |

### v13 (2026-09-16) — 독립 검토 8회차(v11 대상) 반영

8회차는 v11을 검토했고 reject였습니다. 호주 floor·싱가포르·canary 방향은
맞다고 봤고, 남은 것은 **`risk_accepted`를 판정 모델에 어떻게 싣는가**와
**S1이 혼자 설 수 없다**는 것이었습니다. v12의 결정(IP 추정 국가, 의무별 상태)
위에서 닫았습니다.

| # | 지적 | v13 |
|---|---|---|
| **L12** | 동의 없는 수신자에게 2년 고지 일정을 만들면 가짜 동의일이 생김 | **소유자 결정: 가입일을 기준일로 간주합니다.** `ConsentRecord`는 쓰지 않고 cohort 행의 `noticeAnchorAt`(= 가입일)로 2년 주기를 돌립니다(7.7) |
| **C13** | "전부 통과"와 `risk_accepted` 발송이 한 출력에 공존 불가. 승인의 source가 발송 판정일 수 없음 | **`EmailSendApproval` 원장**(6) + 판정 출력에 `legalAllowed`와 `overrideApplied`를 분리. authority 판정은 거부 그대로 보존(7.6) |
| **C14** | 78계정을 고정하는 데이터 없음, 주소 변경, 기존 계정의 국가 | 승인 시점의 `userId + 주소 digest` cohort 고정, 주소가 바뀌면 제외, 기존 계정도 5.3의 IP 추정으로 국가 기록, **국가 미확정은 override로도 안 보냄**(5.6) |
| **C15** | S1이 S3·S5·S8에 의존 | S1을 **S1a(독립) / S1b(잠금) / S9(판정)** 로 나눔. 불변식 5→S3, 9→S6, 7은 강제 지점을 정함(12) |
| **C16** | 렌더 시점 이후 표시 의무가 바뀌면 옛 footer로 통과 | send 판정이 pinned 표시 metadata와 **현재 의무 계약**을 비교, 불충족이면 skip 후 재enqueue(7.6) |
| **C17** | credential lane과 suppression writer 전체 목록 없음 | writer 네 곳·sender 두 곳을 이름으로 적고, credential lane은 **범위 밖임과 그 이유**를 명시(7.4) |
| **C18** | 인증 전 선택과 인증 후 화면 중 무엇이 최종인가 | v12에서 인증 후 화면이 없어짐. **인증 전 가입 흐름의 추정 국가·rule·문안 해시가 attempt 행에 들어가고** finalize가 한 transaction으로 소비(5.2) |
| **C19** | AT·IE가 EEA 행과 별도 행에 중복 | 행을 나눔(4.3) |
| **C20** | 기존 `TemplateVersion` backfill 출처 | 당시의 `EmailTemplate` 값을 역사값으로 복사, 코드와의 차이는 감사 출력, 현재 코드 metadata는 새 version(7.2) |

### v12 (2026-09-16) — 한국 의무의 무게를 나누고, 국가는 IP 추정으로

v11은 한국 법정 의무를 **하나라도 빠지면 한국 발송 전체를 끄는** 장치로
묶었습니다. 법의 문언만 보고 peer 관행보다 엄격하게 잡은 것이었고, 그 장치가
원래 막으려던 것은 **아무도 모르게 빠지는 사고**이지 면제 결정 자체가
아닙니다. 그리고 v11의 "로그인 직후 국가 확정 화면"은 앞서 정한 **IP 추정 +
사용자 정정** 방향과 어긋났습니다.

**소유자 결정(2026-09-16)**

1. **14일 처리결과 통지 — 구현합니다.**
2. **2년 수신동의 고지 — 구현 시점만 뒤로 둡니다.** 첫 기한이 2028년이므로
   그 전까지 만들면 됩니다. 기한 감시는 지금 둡니다(7.7).
3. **`(광고)` 표기 — 면제합니다.** 기록된 결정으로 남깁니다(7.7, 7.8).
4. **국가는 IP로 추정해 기록하고, 사용자가 언제든 정정합니다**(5.3). 강제
   확인 화면은 두지 않습니다.

구조도 바꿨습니다. 의무마다 **`implemented` · `deferred`(기한) · `waived`(승인
기록)** 중 하나로 정해져 있어야 합니다. 코드는 **정해지지 않은 의무**, **readiness
check가 실패한 `implemented`**, **기한이 지난 `deferred`** 가 있을 때 막습니다(7.8).

### v11 (2026-09-16) — 독립 검토 7회차 반영과 소유자 결정

7회차는 **제가 앞서 말한 것 두 가지를 뒤집었습니다.**

1. **미국 opt-out은 우리에게 열려 있지 않습니다.** 우리는 호주 법인이라 보내는
   **모든** 상업 메일에 Australian link가 붙고(Spam Act s 7(b)(ii), 중앙관리·
   통제가 호주), s 16은 명시적 또는 추론 동의를 요구합니다. 수신자가 미국이어도
   마찬가지입니다. **호주 규칙이 전 세계 발송의 바닥입니다**(4.2).
2. **싱가포르는 opt-out이 아닙니다.** Spam Control Act만 봤는데, PDPA가 개인정보를
   direct marketing에 쓸 때 명시적 opt-in을 요구하고, PDPC는 고지로 간주된 동의를
   마케팅에 쓸 수 없다고 명시합니다(4.3).

그리고 **기존 사용자에 대한 판단이 넓어졌습니다.** 우리 방침이 "신청하신 경우에만
보냅니다"라고 약속해 왔으므로, 호주 추론 동의의 "합리적 예상"을 우리 문서가
부정하고, 미국에서는 소급 완화가 FTC Section 5 위험입니다. 따라서 기존 78계정은
**어느 법역이든 근거가 없습니다.**

**소유자 결정(2026-09-16)**

- 기존 78계정은 **전원 발송, `risk_accepted`로 기록**(5.6). 동의 기록은 지어내지
  않습니다.
- 한국은 **보냅니다 — 법정 의무 전부 구현**(7.7). 14일 처리결과 통지, 2년 고지,
  footer 전화번호, 한·영 수신거부 안내. v7의 "보류"를 거둡니다.
- **G는 EEA·영국 soft opt-in만 막습니다.** S1 착수 허용.

코드 계약도 닫았습니다 — 미체크 사용자의 국가 확정 경로(5.3), 발송 판정의 전체
입출력과 두 시점 snapshot(7.6), 주소 전역 suppression 잠금(7.4), 템플릿 메타데이터
저장 방식 결정(7.2), 30일 키 보존의 canary 토큰(7.5).

### v10 (2026-09-16) — 승인 반영과 기존 사용자 처리

소유자 승인: A·B·C·E 승인, D는 방향 변경(한국도 동의 체크박스), F는 범위
한정 승인, G는 미결.

그리고 **기존 78계정의 처리 방법이 정해졌습니다.** 개별 연락은 비현실적이므로
**제품 안에서 한 번 묻습니다**(5.4) — 이메일이 아니라 로그인 후 화면이라 EEA의
"동의를 구하는 이메일도 광고" 문제와 한국의 "전송" 정의를 함께 피합니다.
응답하지 않은 분들은 법역별로 나뉘고(5.5), 사전 동의가 필요한 법역에 보내기로
한 결정은 **동의가 아니라 `risk_accepted`로 기록**합니다(5.6).

현재 위험 판단의 근거도 문서에 적었습니다 — 계정 78개, 전원 지인 경로,
순수 유입 0. **"법이 허용한다"가 아니라 "적발 가능성이 낮다"** 이며 그 구분을
남깁니다.

### v9 (2026-09-16) — 독립 검토 6회차 반영

v8은 순서(기계 → 기록 → 근거 → 분류)와 방향은 인정받았고, **중심 계약 여섯
개가 닫히지 않아 반려**됐습니다. v9가 그것을 닫습니다.

| 지적 | v9의 처리 |
|---|---|
| **L1** EU 근거를 자문 전에 확정 | EEA·영국은 **`express_consent`로 시작**하고, soft opt-in은 회원국별 해제 게이트로 둡니다 |
| **L2** 체크박스 하나에 동의와 이의 없음을 동시에 부여 | **두 장치로 분리** — opt-in 체크박스와 고지·독립 거부 수단은 다른 것입니다 |
| **L3** 호주 추론 동의의 관계 판정이 미정 | **관계 lifecycle 모델**을 설계에 넣고, 그 전에는 AU도 닫습니다 |
| **L4** 기존 사용자 처리 부재 | **신규/기존 × 국가 × 근거 전환표**. 소급 backfill 금지 |
| **L5** "제품 내"의 경계가 넓음 | 인증된 화면에서 사용자가 열었을 때만. 푸시·알림·백그라운드 제외 |
| **L6** Lululemon 사실 오류 | 2026년 3월, **오분류로 수신거부 수단이 아예 없던 사건**으로 정정 |
| **C1** 템플릿 메타데이터 drift | DB와 코드가 다르면 **fail-closed**. 저장된 `requiresUnsubscribe=false`를 신뢰하지 않음 |
| **C2** 철회와 발송의 경합 | (주소, purpose) **직렬화 키**와 잠금 안의 최종 재검사 |
| **C4** 증거 장부가 답을 완결하지 못함 | `ConsentRecord`(동의) + `EmailPermissionEvent`(고지·관계) + `EmailPermissionDecision`(발송별 판정) 세 층 |
| **C5** basis를 profile에 두면 AT·IE를 표현 못 함 | 국가 단위 **`ReleaseNotesCountryRule`** 로 분리. allowlist는 그 rule의 status |
| **C6** v7의 계약이 압축되며 사라짐 | 5절·7절에 **복원**했습니다 |
| **C7** 순서의 두 구멍 | 수집 표면에 별도 게이트, 법적 문안 승인을 S3 앞으로 |

### v8 이전

v1 service 분류(reject) → v2 세 축 분리 → v3 범위 축소 → v4~v6 계약 보완 →
v7 한국 세 층 → v8 기계 우선·근거 축 복원. 각 회차의 지적과 대응은 git
이력에 있습니다.

---

## 1. 무엇이 문제인가

기능 안내 메일이 한 통도 나가지 못합니다. 원인은 둘입니다.

1. **동의를 물어볼 자리가 제품에 없습니다.** 설정 화면이 유일한 경로이고, 거기
   까지 스스로 찾아온 사람은 0명입니다(2026-09-15 `GET /api/admin/marketing-reach`).
2. **우리 정책이 peer보다 보수적입니다.**
   [이메일 알림](email-notifications.md) §5.1 C1(전역 opt-in)과
   [같은 문서](email-notifications.md) §5.6 C8(soft opt-in 미사용)은 법이 아니라
   우리가 고른 것이고, 그 문서가 스스로 "사업적 결정"이라 적었습니다.

---

## 2. 조사 결과 (요약)

### 2.1 판정 기준은 법역마다 다릅니다

| 법역 | 기준 | 숨은 목적이 분류를 바꾸는가 |
|---|---|---|
| EU/EEA · 영국 · 한국 | 목적 | **예** |
| 호주 · 싱가포르 | 목적이되 판단 자료가 메시지와 링크로 한정 | 아니오 |
| 미국 | 내용 | **아니오** — FTC가 발신자 의도 기준을 명시적으로 거부 |

### 2.2 EEA는 열릴 수 있지만 아직 아닙니다

CJEU C-654/23(2025-11-13)은 무료 계정도 "서비스 판매의 맥락"에 **해당할 수
있다**고 했고, 근거는 그 사건의 **구체적 상품 구조**(유료 구독이 무료 이용을
간접 재정 지원)였습니다. CNIL 2026 지침도 "certains cas"로 한정하며, **구매 없는
일반 전자상거래 계정은 반대 사례**로 듭니다.

**따라서 프랑스 예시를 EEA 전체에 적용할 수 없습니다.** 회원국별 국내법 구현도
다릅니다(독일 UWG는 더 엄격할 수 있고 미조사).

### 2.3 peer 여덟 곳의 flow

가입 시 문장 한 줄(Anthropic), 방침의 opt-out만(OpenAI·US SaaS·7-Eleven),
근거 불명(DeepSeek). **아무도 "정보성이라 예외"를 주장하지 않습니다.**

### 2.4 한국 — 적용되지만 집행되지 않고, 대안이 있습니다

제5조의2가 국외행위에 적용되고 무료 회원가입은 거래관계 예외에서 명문 배제.
집행 사례는 없음. **KISA가 "접속해서 보게 된 것은 전송이 아니다"라고 적습니다.**
**D 결정으로 한국은 동의를 받아 이메일로 보냅니다.** 법정 의무는 의무별로
구현·연기·면제를 기록합니다(7.7).

### 2.5 호주 — 전 세계 발송의 바닥입니다

Spam Act s 7의 Australian link는 **선택적 요건 목록**이고, 어느 하나만 걸려도
적용됩니다. 수신자 측 limb(s 7(c)(d))도 있지만, **우리에게 결정적인 것은 발신자
측 limb**입니다 — s 7(b)(ii) "중앙관리·통제가 호주에 있는 조직".

**Tomverse는 호주 법인이므로 우리가 보내는 모든 상업 메일에 호주법이 붙습니다.**
수신자가 미국이든 한국이든 마찬가지이고, s 16은 **명시적 또는 추론 동의**를
요구합니다. 그래서 미국의 CAN-SPAM opt-out은 **수신자 측 요건을 충족할 뿐** 우리
발송의 근거가 되지 못합니다.

ACMA는 계정 관계를 추론 동의 근거로 인정하되 **관계가 끝나면 안 되고** 수신자가
마케팅을 **합리적으로 예상**할 수 있어야 한다고 봅니다. 입증책임은 발신자(s 16(5)).

### 2.6 집행 기록이 말하는 것

2020년 이후 ACMA 스팸 집행 약 27건의 사유 — 수신거부 부재·미작동 ~20, 무동의
~19, 철회 후 발송 ~14, **오분류 7**, 발신자 정보 6, 수신거부에 로그인 요구 1.

**정정(v8의 오류)**: Lululemon A$702,900은 **2026년 3월** 발표이고, 서비스
메일에 판촉을 섞어 **오분류한 결과 수신거부 수단이 아예 없던** 사건입니다.
"수신거부 미작동 하나"가 아니라 **분류 불변식과 수신거부 불변식을 함께**
보여 주는 사례입니다.

---

## 3. D1 — 분류는 marketing, purpose는 분리

`release_notes` purpose를 만들고 **`classification`은 `marketing`으로 둡니다.**
`classification === "marketing"` 하나가 발송 스트림·kill switch·`(광고)`·`<ADV>`
접두어(7.8의 의무 상태에 따라)·unsubscribe 강제·관할권 fail-closed를 켭니다. 낮추면 한국 사용자가
동의를 마치고 받은 메일에 라벨이 붙지 않습니다.

`withdrawAllMarketing()`이 `recordsConsent(purpose)`로 대상을 고르므로
(`lib/emailPreferences.ts`), **purpose 표에 classification을 두고 그것을 철회의
단일 source로 씁니다.** 정적 검사가 템플릿 정의와의 일치를 강제합니다.

---

## 4. D2 — 권한: 국가 rule과 이중 authority

### 4.1 저장 위치를 나눕니다 (C5)

- **`JurisdictionProfile`** — 표시·footer·라벨. 지금 그대로.
- **`ReleaseNotesCountryRule(policyVersionId, countryCode, basis, status, conditions)`**
  — **권한**. 국가 단위이므로 EU profile 아래의 AT·IE가 다른 값을 가질 수
  있습니다. **allowlist는 별도 상수가 아니라 이 rule의 `status`** 입니다(drift 제거).

### 4.2 판정은 authority별로 남기고, 전부 통과해야 보냅니다

수신자 관할권 authority와 **호주 발신자 authority**를 각각 평가합니다.
**최종 허용은 모든 authority가 허용할 때만** 성립합니다. 미국 수신자라면
CAN-SPAM(수신자 authority)을 통과하고 **동시에** 호주 동의(발신자 authority)가
있어야 합니다.

**`risk_accepted`는 authority 판정을 바꾸지 않습니다.** authority는 거부 그대로
남고, 판정 출력이 `legalAllowed: false`와 `overrideApplied`를 따로 담습니다(7.6).

하나의 근거가 양쪽을 충족하면(예: 명시적 동의) 그 사실도 기록합니다. 판정
함수의 전체 입출력은 7.6입니다. **이 함수 하나를 estimate·audience expansion·
writer·drain이 공유합니다.**

### 4.3 출발 값

아래는 **수신자 authority**의 값입니다. 모든 행 위에 **호주 발신자 authority**
(명시적 또는 추론 동의)가 함께 걸립니다.

| 국가 | 수신자 authority 출발 값 | 해제 조건 |
|---|---|---|
| **US** | `opt_out` | 수신자 측은 이것으로 충분. **발송 가능 여부는 호주 authority가 정합니다** |
| **AU** | 4.4의 관계가 서면 `inferred_consent` | 4.4의 여섯 항목 |
| **SG** | **`express_consent`** | PDPA가 direct marketing에 opt-in 요구. SCA의 `<ADV>`·수신거부 이메일 요건은 별도 표시 의무로 유지 |
| **KR** | `express_consent` | 가입 화면 동의 + DOI. 법정 의무는 7.7의 의무별 상태 |
| **EEA(AT·IE 제외)·GB** | `express_consent` | **G(R1 외부 자문)** 가 회원국별로 확인하면 soft opt-in |
| **AT** | `express_consent` | ECG-Liste 대조 없이는 해제 없음. 이번 범위에서 soft opt-in 대상 아님 |
| **IE** | `express_consent` | 12개월 창·형사범. 이번 범위에서 soft opt-in 대상 아님 |
| **CH·CA** | `express_consent` | CH는 FDPIC, CA는 CASL. 해제 없음 |
| **ZZ** | 발송 안 함 | — |

**신규 가입자의 호주 추론 동의**는 E(방침 개정)가 시행된 뒤, 5.1의 고지를 본
계정에만 성립합니다. 그 전에 가입한 계정은 5.5·5.6입니다.

`risk_accepted`는 이 표의 값이 아닙니다 — 국가 rule은 그대로 두고, 그 위에서
내린 결정으로 5.6에 따라 기록됩니다.

### 4.4 호주 관계 lifecycle (L3)

추론 동의를 주장하려면 **관계를 추론하는 함수가 아니라 사건을 저장하는 모델**이
필요합니다.

| 항목 | 정의 |
|---|---|
| 시작 사건 | 계정 생성 시 주소를 **본인이 직접 입력**했고, 그 시점 고지가 있었을 것 |
| 유지 조건 | 계정이 살아 있고 최근 활동이 있을 것(기준값은 S4에서 정하고 문서에 적음) |
| 종료 사건 | 계정 삭제·해지, 휴면 기준 초과, 수신거부 |
| 휴면·무료 계정 | 휴면은 종료로 취급. 무료 계정도 관계는 성립하되 **콘텐츠 관련성**을 더 좁게 |
| 관련 콘텐츠 범위 | 그 사람이 쓰는 제품의 기능. 별개 제품군 교차판매는 제외 |
| 종료 시 즉시 전환 | 종료 사건이 기록되면 그 순간부터 발송 불가. suppression과 동일 층 |

---

## 5. D3 — 수집: 두 장치를 분리합니다 (L2)

**하나의 체크박스가 동의와 이의 없음을 동시에 뜻할 수 없습니다.** "제품 소식을
받겠습니다"를 체크하지 않은 행동은 합리적으로 **거절**로 읽힙니다.

### 5.1 가입 흐름에 두 가지를 둡니다

1. **opt-in 체크박스** (체크되지 않은 상태) — **동의**입니다. 체크하면 DOI로
   이어집니다. 미체크를 다른 의미로 재해석하지 않습니다. 한국어 문구는
   **"이메일 광고성 정보 수신동의 (선택)"** — 채널과 선택성을 명시합니다.
2. **고지 문장과 독립 거부 수단** — 무엇을 보내는지 적고, 체크박스와 별개인
   거부 링크를 둡니다.

세 상태는 **서로 독립**으로 저장합니다 — `expressOptInRequested`, `noticeShown`,
`objected`. 하나에서 다른 하나를 추론하지 않습니다.

두 장치의 **정확한 문안과 선택 상태를 불변 artifact로 보존**합니다.

### 5.2 계정 확정 경계 (C6, v7에서 복원)

OAuth는 NextAuth adapter가 callback 중 계정을 만들고(`lib/auth.ts`), 이메일
코드는 `resolveUserForVerifiedEmail()`이 만듭니다(`lib/emailLogin.ts`).
`createUser`에는 provider·state가 오지 않습니다.

**`SignupConsentAttempt`**

| 필드 | 뜻 |
|---|---|
| `nonceHash` | 클라이언트가 가진 값의 해시. 원본 미저장 |
| `channel` | `oauth` \| `email_code` |
| `binding` | oauth는 provider, email_code는 **`EmailLoginAttempt` id와 정규화된 주소** |
| `expressOptInRequested` · `noticeShown` · `objected` | 두 장치의 결과(5.1, 서로 독립) |
| `countryCandidates` | **그 선택을 할 때 적용한 것** — 후보마다 `{country, signal, ruleVersion, copyHash}`. 후보가 하나면 목록 길이 1(5.3) |
| `expiresAt` · `consumedAt` · `supersededAt` · `userId` | 소비 결과 |

- `attemptId`는 **탭 범위 `sessionStorage`**. 쿠키를 쓰지 않습니다.
- **로그인이 끝난 뒤 finalize** — 인증된 세션을 신뢰하고, 그 계정이 **이
  흐름에서 방금 만들어진 것**일 때만 소비합니다.
- 소비는 **`consumedAt IS NULL AND supersededAt IS NULL AND expiresAt > now()`
  조건의 compare-and-set 한 번**.
- **소비·권한 사건 기록·확인 메일 생성은 한 transaction**입니다. 따로 두면 선택은
  소비됐는데 메일이 없는 상태가 남습니다. 사건에는 attempt 행의 국가·rule·문안
  해시(후보 목록 전체)가 그대로 옮겨집니다 — **인증 후에 다시 보여 주는 화면은 없으므로 이것이
  유일한 최종 선택입니다.**
- **"이 흐름에서 방금 만들어진 계정"의 증명** — 계정 생성 시각이 attempt 발급
  이후이고, binding이 일치하며(oauth는 그 provider의 첫 `Account` 행, email_code는
  그 `EmailLoginAttempt`가 만든 사용자), 그 사용자에게 소비된 attempt가 아직
  없을 때(`userId` unique)만 소비합니다.
- **기존 사용자의 로그인은 절대 소비하지 않습니다.**
- 체크 해제 후 재시도는 이전 행을 `supersededAt`으로 무효화하고, 무효화와 새 행
  발급은 한 transaction입니다.
- 소비 실패·만료·탭 닫힘에도 **계정 생성은 성공**합니다.

| 지금 | 사건 | 다음 |
|---|---|---|
| `pending` | 소비 성공 | `consumed` |
| `pending` | 같은 브라우저가 새로 발급 | `superseded` |
| `pending` | 만료 | `expired` |
| 그 밖 | 무엇이든 | 변하지 않음 |

### 5.3 국가는 IP로 추정해 기록하고, 사용자가 언제든 정정합니다 (C8)

v9는 국가를 DOI 확인 화면에서만 받아, **체크하지 않은 사용자는 국가가 정해지지
않고** 어떤 rule 아래서 고지를 봤는지 증명할 수 없었습니다(C8). v11은 강제
확인 화면으로 막았지만, 그것은 앞서 정한 방향(가입 때 국가를 고르게 하지 않음)과
어긋났습니다. v12는 **화면 없이** 같은 구멍을 막습니다.

1. **가입 흐름 안에서 추정 국가를 바로 기록합니다.** 신호는 IP 국가
   (`cf-ipcountry`)이고, 언어·시간대는 교차 확인에 씁니다. source는
   `ip_estimated`입니다.
2. **그 국가의 rule에 맞는 장치를 가입 흐름에서 보여 주고**, `notice_shown`
   사건에 **적용된 국가·source·rule 버전·렌더된 문구 해시**를 함께 남깁니다.
   체크하지 않은 사용자도 이 기록을 갖습니다.
3. **사용자는 설정에서 언제든 국가를 바꿉니다.** 바꾸면 source는
   `self_declared`이고 추정보다 우선합니다. 바뀐 국가의 rule이 더 엄격하면(예:
   express 필요) 기존 근거는 그 rule로 다시 판정되며, 필요한 동의가 없으면 보내지
   않습니다.
4. **추정이 불확실하면 두 후보를 모두 authority로 평가합니다.** IP 국가와
   언어·시간대가 가리키는 국가가 다르면 둘 다 판정에 넣고, **둘 다 허용할 때만**
   보냅니다(4.2의 "전부 통과" 규칙을 그대로 씁니다). 한국일 수도 있는 사용자는
   한국 rule도 통과해야 합니다.
   - **후보 목록은 영속됩니다.** attempt → `notice_shown` 사건 → enqueue·send
     snapshot까지 후보마다 `{country, signal, ruleVersion, copyHash}`가 따라갑니다.
     가입 흐름의 장치는 **후보 rule들 중 가장 엄격한 장치**를 보여 주고 그 문안
     해시를 후보마다 남깁니다.
   - **표시 의무는 후보들의 합집합**입니다 — footer block, 수신거부 안내, 제목
     접두어를 모두 붙입니다.
   - **합성은 의무 key별로 적용 후보만** 봅니다. 그 의무가 없는 rule(예: KR+US 후보에서
     US에 `(광고)` 의무는 없음)은 **중립**입니다. 적용 rule 중 하나라도 상태가 빠져
     있으면 미결 blocker, **적용 rule이 모두 `waived`일 때만** 생략, 그 밖에는 붙입니다.
   - **합성할 수 없으면 fail-closed** — 서로 다른 제목 접두어 두 개가 둘 다 필요한
     경우처럼 한 메일이 두 후보를 동시에 충족할 수 없으면 `display_unsatisfiable`로
     보내지 않습니다.
   - **`self_declared`는 후보 목록을 대체**합니다. 사용자가 국가를 정정하면 목록은
     그 국가 하나가 됩니다.
5. 신호가 전혀 없으면 `ZZ` — 보내지 않습니다.
6. **기존 계정도 같은 방식입니다.** 다음 로그인 때 IP 추정 국가를 기록하고, 설정에서
   정정할 수 있습니다. 로그인하지 않아 국가가 없는 계정은 받지 않습니다.

**호주 발신자 authority는 국가와 무관하게 모든 발송에 걸리므로**(2.5), 추정
국가가 판정을 바꾸는 경우는 한국·EEA·싱가포르처럼 추가 요건이 있는 나라뿐입니다.
추정이 틀렸을 때의 영향이 그만큼 좁습니다.

**상위 계약 개정이 필요합니다(S0).**
[이메일 알림](email-notifications.md) §6.1은 IP를 6순위 "단독 확정 금지"로, 6.2의 6단계는 "판정에 쓰지 않음"으로
적고 있고, `AGENTS.md`도 "IP만으로 관할권을 정하지 않습니다"라고 적습니다.
현재 `marketingJurisdictionVerdict()`는 high confidence가 아니면 거부합니다.
S0에서 이 셋을 **"IP 추정은 기록·판정에 쓰되, 청구 국가·자기 신고가 있으면
그것이 우선하고, 추정 후보가 둘이면 둘 다 통과해야 한다"** 로 개정합니다.

DOI 확인 화면은 동의한 사람의 **주소 확인**만 담당합니다. 최종 POST는
`token`을 받아 `setPreference()` transaction 안에서 처리합니다.

### 5.4 기존 사용자 — 제품 안에서 한 번 묻습니다

**소급으로 적격이 되지 않습니다.** 방침 변경 고지는 과거 수집 시점의 거부
기회를 만들지 않고, **evidence도 consent도 만들지 않습니다.**

그런데 기존 사용자는 전부 **로그인해서 제품을 쓰는 분들**입니다. 그래서 개별
연락 없이 **실제 동의를 받을 수 있습니다** — 다음 접속 때 **일회성 안내를
화면에 띄웁니다.**

- **이메일이 아니므로 ePrivacy 제13조의 대상이 아닙니다.** "동의를 구하는
  이메일" 자체가 EEA에서 direct marketing이라 보낼 수 없는 문제를 피합니다.
- **한국에서도 "전송"이 아닙니다**(KISA 안내서, 9절).
- 부품은 5.1의 opt-in 체크박스와 같고 배치만 다릅니다.
- 누르지 않아도 불이익이 없고, 한 번 닫으면 다시 뜨지 않습니다. 닫은 사실은
  `notice_shown`으로 남되 **동의도 거부도 아닙니다.**

이렇게 동의한 주소는 법역과 무관하게 `express_consent` 위에 섭니다.

### 5.5 기존 사용자에게는 근거가 없습니다

우리 방침은 지금까지 **"신청하신 경우에만 보냅니다"** 라고 약속했습니다.

- 호주 추론 동의의 **"합리적 예상"을 우리 문서가 부정**합니다.
- 미국에서 기존 데이터에 대한 개인정보 약속을 **소급해 완화하면 FTC Section 5
  위험**입니다(Gateway Learning, 2004).
- 방침 변경 고지는 **기존 사용자에게 새 권한을 만들지 않습니다.**

**그래서 기존 78계정은 어느 법역에서도 5.4의 제품 내 동의 없이는 근거가
없습니다.** 제품 내 안내로 동의한 분은 `express_consent` 위에 섭니다.

### 5.6 `risk_accepted` — 근거가 아니라 기록된 결정

**이것은 법적 근거가 아닙니다.** 근거 없이 보내기로 한 **사업 결정**이고, 그
사실을 있는 그대로 남기는 이름입니다.

**소유자 결정(2026-09-16)**: 기존 78계정 **전원에게 발송**, `risk_accepted`로
기록. 판단 근거는 계정 78개·전원 지인 경로·순수 유입 0이며, **"법이 허용한다"가
아니라 "적발 가능성이 낮다"** 입니다. 범위는 **전 법역**이고, 미국에서는 방침
약속 위반(FTC) 위험까지 포함합니다.

**승인은 발송보다 먼저 존재합니다** — `EmailSendApproval`(6절)에 한 번 쓰고
바꾸지 않습니다. 발송 판정은 그 승인을 **참조**할 뿐 source가 아닙니다.

**cohort를 고정합니다.**

- 승인 시점의 정확한 계정 목록을 `userId`와 **정규화 주소 digest** 쌍으로
  승인에 묶습니다(`EmailSendApprovalMember`). "78명"은 설명이고, 목록이 범위입니다.
- **현재 주소의 digest가 목록과 다르면 제외**합니다. 주소를 바꾼 계정의 새 주소는
  승인 대상이 아닙니다.
- **검사는 enqueue와 send 양쪽에서** 합니다. `userId`, delivery에 고정된 주소,
  **send 시점의 현재 계정 주소** — 세 digest가 active member의 쌍과 모두 일치해야
  override가 적용됩니다. enqueue 뒤 주소를 바꾸면 옛 주소로 고정된 delivery도
  나가지 않습니다. 계정 삭제·주소 없음·불일치는 blocker입니다.
- 승인 이후 가입한 계정은 어떤 경로로도 들어가지 않습니다.

**override가 할 수 있는 것과 없는 것**

| override가 넘는 것 | override가 넘지 못하는 것 |
|---|---|
| authority의 근거 부족(동의·관계 없음) | 철회·거부(`objected`)·purpose 또는 주소 전역 suppression |
| | **국가 미확정**(`ZZ`) — 표시 의무를 정할 수 없으므로 |
| | 의무 상태가 정해지지 않은 rule(7.8) |
| | kill switch·send flag·readiness |

쓰는 규칙입니다.

1. **동의를 지어내지 않습니다.** `ConsentRecord(granted)`를 쓰지 않습니다.
2. **판정은 거부 그대로 남깁니다.** 발송별 판정에는 `legalAllowed: false`와
   `overrideApplied: { approvalId, type: "risk_accepted" }`가 함께 남습니다(7.6).
3. **admin 화면에 그대로 보입니다.** 숨기면 다음 사람이 동의로 읽습니다.
4. **동의가 들어오면 덮입니다.** 그 주소가 5.4의 안내나 설정에서 동의하면
   `legalAllowed: true`가 되고 override는 더 이상 쓰이지 않습니다.
5. **표시 의무는 7.7의 기록을 따릅니다.** 2년 고지는 **가입일을 기준일로 간주**해
   돌리고(`noticeAnchorAt`), 동의 결과 통지는 해당하지 않으며, 수신거부 결과 통지는
   해당합니다.
6. **재검토 시점을 적습니다.** 순수 유입이 생기거나, 수신거부·불만이 들어오면 다시
   판단합니다. 승인을 거두면 **`EmailSendApprovalRevocation` 사건을 추가**하고, 이후
   판정은 override 없이 합니다. 승인 행 자체는 고치지 않습니다.

## 6. D4 — 기록: 세 층 (C4)

| 장부 | 담는 것 |
|---|---|
| **`ConsentRecord`** (기존) | **명시적 동의**의 생애 — 요청·부여·철회·재확인 |
| **`EmailPermissionEvent`** (신규, append-only) | 고지와 관계의 사실 — `notice_shown`, `objected`, `relationship_started`, `relationship_ended`, `basis_ended` |
| **`EmailPermissionDecision`** (신규) | **발송별 판정** — 어떤 authority를 어떤 evidence로 통과했는지 |
| **`EmailSendApproval`** (신규, 본문 불변) | **사람의 결정** — `risk_accepted` override(5.6)와 의무 `waived`(7.8). 승인자·일시·유형·**범위(policy version·rule·country·obligation key 또는 cohort)**·사유·재검토 조건. cohort는 `EmailSendApprovalMember`(`userId`, 주소 digest, `noticeAnchorAt`, `noticeAnchorSource`). **승인 행과 member 전체는 한 transaction에서 쓰고 `sealedAt`으로 닫으며, 이후 둘 다 갱신·추가·삭제하지 않습니다**(DB trigger로 강제). **철회는 append-only `EmailSendApprovalRevocation`** |

**두 장부가 같은 사실의 경쟁 source가 되지 않습니다.** 동의는 `ConsentRecord`
하나가 말하고, 나머지 사실은 `EmailPermissionEvent`가 말합니다.

`EmailPermissionDecision`이 담는 것 — `deliveryId`, 적용 authority 목록과 각
결과, 참조한 evidence id들, `policyVersionId`와 `ruleVersion`, **발송 직전
suppression 판정 시각**, **provider 제출 시각**, `legalAllowed`, 그리고 override를
썼다면 **`EmailSendApproval` id**(5.6). 승인 내용을 복사하지 않고 참조합니다.

**판정 snapshot은 두 개입니다** — enqueue 시점의 판정과 **provider 제출 직전의 현재
판정**. 한 개의 `policyVersionId`로 두 시점을 표현할 수 없으므로 각각 버전을
담습니다(7.6).

그 밖에 필요한 것 — `purpose`와 권한 범위, `copyHash`가 가리키는 **실제 불변
문안 artifact**, 주소 정규화 규칙, 보존 기간, 그리고 반대 사건의 발생 시각.

**위탁해도 우리 기록입니다**(ACMA Statement of Expectations).

---

## 7. D5 — 기계: 벌금이 실제로 나오는 곳

### 7.1 불변식

| # | 불변식 | 현재 상태 |
|---|---|---|
| 1 | **marketing 분류에는 예외 없이 수신거부** | **있음(S1a)** — metadata를 version에 고정, drain이 불일치를 거부(7.2) |
| 2 | 로그인·개인정보 없는 one-click | **있음.** rate limit은 S1a에서 유효 token을 출처로 막지 않게 조정(7.3) |
| 3 | **철회 후 발송 0건** | **없음** — 경합 구간(7.4) |
| 4 | 수신거부 주소가 발송 후 30일 이상 유효 — 계약은 이전 key 1년 보존 | **있음(S1a)** — keyring canary readiness, 보존 1년(7.5) |
| 5 | 전체 수신거부 선택지 | **부분 구현** — `withdrawAllMarketing()` 범위. **S3**의 purpose classification 표로 닫음 |
| 6 | suppression이 **고객 대상 sender 전체**(7.4의 목록, 운영자 알림 제외)의 모든 발송보다 우선 | **부분** — 경합이 있고, **환불·로그인 방법 변경 안내는 검사하지 않습니다**(7.4) |
| 7 | 재구독 권유 금지 — **수신거부한 주소에 재구독을 요청하는 메일을 보내지 않음**. 수신거부 확인 페이지의 즉시 "되돌리기"는 본인 조작이라 허용 | **suppression이 이미 강제.** 추가로 S3의 purpose 표에 재구독 요청용 purpose를 두지 않음을 정적 검사 |
| 8 | 관계 종료 시 중단 | **없음** — 4.4 선행 |
| 9 | **법적 발신자 정보가 없으면 marketing은 fail-closed** — 한국은 별표 6의 명칭·**전자우편주소·전화번호**·주소 | **부분** — 한국 footer에 **전화번호 block이 없습니다. S6** |
| 12 | **의무마다 상태가 정해져 있어야 발송** — `implemented`·`deferred`·`waived` 중 하나가 없으면 그 국가 rule은 막힘(7.8) | **없음** |
| 10 | end-to-end synthetic 점검 — unsubscribe endpoint·rate limit·preference write까지 | **없음.** 7.5의 keyring canary와 별개. S10a |
| 11 | **발송 판정 조회 오류는 영구 실패가 아니라 재시도** | **없음** — 현재 drain은 예상 밖 오류를 영구 `failed`로 만듭니다(7.6) |

### 7.2 템플릿 메타데이터 drift (C1) — 저장 방식을 정했습니다

`ensureTemplateVersion()`이 기존 `EmailTemplate`에 `update: {}`를 씁니다
(`lib/emailTemplateRegistry.ts`). 코드에서 분류를 바꿔도 DB의 `classification`과
`requiresUnsubscribe`는 옛 값으로 남고, 발송기는 **분류는 코드에서, 수신거부
여부는 DB 행에서** 읽습니다. **재분류된 템플릿이 수신거부 없이 나갑니다** —
Luxottica·Lululemon의 형태입니다.

**결정: classification·purpose·requiresUnsubscribe를 immutable `TemplateVersion`
메타데이터로 둡니다.** "새 template key" 대안은 채택하지 않습니다(감사 이력이
key마다 끊깁니다).

- 새 `TemplateVersion`을 만들 때 그 셋을 함께 저장하고 이후 바꾸지 않습니다.
- **registry와 drain 모두** 코드 정의와 **정확히** 비교하고, 다르면 fail-closed.
- marketing 분류면 저장된 `requiresUnsubscribe=false`를 **신뢰하지 않고** 강제합니다.
- **기존 version의 backfill** — 그 version이 쓰이던 당시의 `EmailTemplate` 행 값을
  **역사값으로** 복사합니다. 현재 코드 정의를 복사하면 과거를 고쳐 쓰게 됩니다.
  코드와 다른 행은 **감사 출력으로 목록화**하고 고치지 않습니다.
- **현재 코드 metadata가 역사값과 다르면 본문이 같아도 새 version**을 만듭니다.
  registry lookup은 `contentHash`와 **세 metadata 필드**를 함께 조건으로 씁니다.
- `EmailTemplate` 행의 세 필드는 이후 판정에 쓰지 않습니다.

### 7.3 수신거부 rate limit

`/api/unsubscribe`의 IP 기준 20회/분·200회/일 제한은 기업 NAT나 메일 사업자의
one-click 요청을 429로 만들 수 있습니다. **유효 토큰은 본질적으로 해지밖에
못 하므로 유효 요청은 처리하고, 제한은 invalid token 남용에 겁니다.**

### 7.4 철회와 발송의 경합 (C2, C10)

suppression은 `lib/standardEmailLane.ts`에서 확인한 뒤 여러 DB 조회·렌더링·지연
처리를 거쳐 provider를 호출합니다. 그 사이에 커밋된 것은 잡지 못합니다.

경합은 **두 종류**입니다.

- **purpose 철회** — 사용자가 특정 purpose를 끔.
- **주소 전역 suppression** — hard bounce, complaint, privacy request. **모든
  purpose에 걸립니다.**

그래서 잠금도 둘입니다.

1. **`(normalizedAddress, *)`** — 주소 전역 suppression writer와 모든 고객 발송이
   잡습니다.
2. **`(normalizedAddress, purpose)`** — purpose 철회와 그 purpose 발송이 잡습니다.

**획득 순서는 1 → 2로 고정**합니다(교착 방지). sender는 **두 잠금 안에서 최종
suppression을 재검사한 뒤 provider 제출까지** 마칩니다. 철회가 먼저 이기면
sender가 관측하고 중단하고, sender가 먼저 이기면 철회 응답은 제출이 끝난 뒤
완료됩니다.

**잠금을 잡는 곳 — 전체 목록**

| 쪽 | 코드 | 잡는 잠금 |
|---|---|---|
| writer | `setPreference()`의 purpose 철회 (`lib/emailPreferences.ts`) | 전역 → purpose |
| writer | hard bounce·complaint (`lib/emailWebhookProcessing.ts`) | 전역 |
| writer | soft bounce 임계 (`recordSoftBounce()`, `lib/emailSuppression.ts`) | 전역 |
| writer | admin 수동 (`app/api/admin/email-suppressions/route.ts`) — **이유는 항상 `manual`** | 전역 (purpose 지정 시 → purpose) |
| writer | **privacy request** (`app/api/admin/privacy-requests/route.ts`) — **신규**, 아래 | 전역, 접수 시 purpose |
| **remover** | `removeSuppression()` (`lib/emailSuppression.ts`) | 전역 (purpose 행이면 → purpose) |
| **remover** | preference 재활성화 (`setPreference()`의 켜기) | 전역 → purpose |
| sender | standard lane (`lib/standardEmailLane.ts`) | 전역 → purpose |
| sender | credential lane (`lib/credentialEmailLane.ts`) | 전역 |
| sender | 알림 큐의 고객 대상 kind — `feedback_user_*`, 환불 안내 (`lib/notificationDeliveries.ts`) | 전역 |
| sender | 로그인 방법 변경 안내 — **standard lane으로 이동**(아래) | standard lane과 같음 |

**고객 대상 sender는 하나의 helper를 지납니다(C29).** `sendWithAddressLock()`이
전역(→ purpose) 잠금 → suppression 재조회 → provider 제출을 한 범위에서 합니다.

- 환불 안내는 지금 **suppression을 보지 않습니다.** transactional 판정(hard bounce·
  manual·privacy request에서 막음, complaint로는 막지 않음 —
  [이메일 알림](email-notifications.md) §13.3)을 받습니다.

**로그인 방법 변경 안내는 standard lane으로 옮깁니다(C36, C49).** 지금은 요청이 끝난
뒤 직접 보내고 실패하면 incident만 남기므로, 잠금을 못 얻거나 provider가 늦으면 **보안
안내가 조용히 사라집니다.**

- **template은 둘입니다** — `login_method_linked`, `login_method_unlinked`. 추가와
  제거는 제목·본문이 다르고, registry는 `placeholderPayload` 한 갈래만 해시하므로 한
  template 안의 분기로는 실제 문안과 `TemplateVersion` artifact가 어긋납니다.
- 둘 다 `transactional`, senderRole `security`, purpose 없음.
- **version은 로그인 방법을 바꾸는 transaction 전에 확정**하고(`ensureTemplateVersion`),
  **변경과 delivery enqueue는 같은 transaction**입니다. 변경이 rollback되면 안내도
  없고, 변경이 commit되면 안내는 반드시 큐에 있습니다.
- 이후 claim·backoff·잠금·시간 예산은 standard lane 규칙입니다.
- credential lane이 아닌 이유 — 이것은 자격증명이 아니고, 몇 분 늦어도 의미가
  사라지지 않습니다.

**운영자 발송은 모듈로 갈라 둡니다(C41).** 알림 큐 한 파일에 운영자 kind와 고객 kind가
섞여 있어, 파일 단위 allowlist에 그 파일을 넣으면 같은 파일의 고객 발송이 helper를
우회해도 검사가 잡지 못합니다.

- 운영자 kind의 raw 발송을 **별도 module**로 옮기고, 그 module만 allowlist에 넣습니다.
- `lib/notificationDeliveries.ts`는 allowlist에 **넣지 않습니다** — 고객 kind는 helper,
  운영자 kind는 분리된 module을 부릅니다.
- **allowlist(raw provider 발송 허용)** — helper 자신, `lib/operationalMonitoring.ts`,
  `lib/providerMonitoring.ts`, 분리된 운영자 발송 module, **관리자 테스트 메일**
  (`app/api/admin/test-email/route.ts`, 아래).
- **정적 검사** — `deliverEmailOnce`·`sendTransactionalEmail`·`emailProvider().send`
  를 import하는 파일은 위 allowlist뿐이어야 합니다.

**관리자 테스트 메일은 운영자 진단 경로입니다(C35).** 수신자는 **로그인한 관리자
자신의 주소**이고, 목적은 provider와 `TRANSACTIONAL_EMAIL_FROM`이 동작하는지 확인하는
것입니다. suppression을 끼우면 그 주소가 막혔을 때 "설정은 정상"을 "발송 실패"로
보고하게 되어, 시험이 자기가 재려는 것을 잴 수 없습니다. 고객에게 가는 경로가 아니고
관리자 권한·rate limit·감사 기록을 이미 거칩니다.

**privacy request가 만드는 suppression(C30, C38, C43)** — 지금은 아무 곳도 만들지
않습니다.

| 요청 유형 | 시점 | 기록 |
|---|---|---|
| `deletion` | **접수(생성) transaction 안** | **classification scope `marketing` suppression**(원인 `privacy_request`, `sourceEventKey` `privacy:<requestId>:intake`) **그리고** 기존 marketing 철회(preference 끄기, 실제 동의가 있으면 `ConsentRecord(withdrawn)`). 잠금은 아래 총잠금 순서를 따르고, 모두 한 transaction. 철회만으로는 부족합니다 — 이미 꺼진 preference는 행을 만들지 않고, `risk_accepted` cohort에는 철회할 동의가 없어 override가 계속 적용됩니다. suppression은 override가 넘지 못하는 blocker입니다(5.6) |
| `deletion` | **결과 상태가 `completed && !legalHold`가 되는 모든 갱신** | 전역 `privacy_request` suppression, **같은 transaction**, `sourceEventKey` `privacy:<requestId>:completed`. 멱등 — unique로 두 번째는 no-op |
| `access`·`export`·`correction` | — | suppression 없음 |

- **legal hold(C43)** — `completed` 상태에서 hold만 해제되는 갱신도 위 조건을
  만족하므로 그때 suppression이 생깁니다. 조건을 "`completed`로 바뀌는 순간"이 아니라
  **"갱신 후 상태"** 로 판정하는 이유입니다.
- `rejected`로 끝난 삭제 요청은 접수 시의 purpose suppression을 남깁니다. 삭제를
  요청한 사람을 marketing에 되돌리는 것은 보수적인 방향이 아닙니다.
- `privacy_request` suppression은 기존대로 해제할 수 없는 이유입니다.
- **classification scope는 purpose가 아니라 분류에 걸립니다.** 발송 판정은 delivery가 고정한
  `TemplateVersion.classification`이 `marketing`이면 이 행을 적용합니다. 그래서 S3의
  purpose 표를 기다리지 않고, 나중에 생기는 `release_notes` 같은 purpose도 자동으로
  막힙니다. `withdrawAllMarketing()`이 purpose마다 따로 transaction을 여는 지금 구조는
  호출자의 transaction을 받도록 바꿉니다.

**원인을 따로 보존합니다(C39, C44, C50).** suppression 행은 `(address, scope,
purposeKey)`마다 하나라서 이후 사건이 같은 행을 갱신합니다. 한 행으로는 두 가지를
함께 표현할 수 없습니다 — **발송을 얼마나 막는가**와 **누가 무엇으로 풀 수 있는가**.

- **`SuppressionCause`(append-only)** — 원인 하나마다 한 행: `emailAddress`, `scope`,
  `purposeKey`, `reason`, `source`, **`sourceEventKey`**, `occurredAt`, `expiresAt`, 그리고
  **판정용 provenance를 명시 컬럼으로(C73)** — `sourceStream`, `sourceDomain`,
  `sourceClassification`, `sourceDeliveryId`, `sourceMessageId`, `providerAccount`,
  `sourceRequestId`, `evidence`(JSON). 지금 판정은 complaint의 `sourceStream`으로
  transactional 경보를 가르므로, delivery id만 남기면 정리된 delivery의 출처를 잃습니다.
  unmatched webhook의 `sourceStream`은 **서명이 검증된 endpoint의 계정**에서 정합니다.
  해제 기록은 `releasedAt`·`releaseKind`·`releaseEvidence`이고, 갱신은 그 한 번뿐입니다.
- **`SuppressionEntry`는 활성 원인의 요약**이고 원인을 쓰거나 해제하는 같은 잠금
  안에서 다시 계산합니다. **발송 판정과 관리자 화면은 요약이 아니라 원인을 직접
  읽고**, 활성의 정의는 하나입니다 — `releasedAt IS NULL AND (expiresAt IS NULL OR
  expiresAt > now())`. 지금의 `suppressionVerdict()`가 이미 목록을 받는 모양입니다.
- **기존 행의 이전(C61)** — 원인 테이블을 만드는 **같은 migration**에서 기존
  `SuppressionEntry` 행마다 원인 하나를 만듭니다: reason·source·위 provenance 컬럼 전부·
  `evidence`·`occurredAt`·`expiresAt`을 그대로, `sourceEventKey`는
  `legacy:suppression:<entryId>`. migration 끝에서 **원인 건수와 entry 건수가 다르면
  예외로 실패**합니다(`DO` 블록).
- **배포 중 공존은 세 번의 배포로 없앱니다(C68, C75, C76).** 한 배포 안에서 이전
  build와 새 build가 서로 다른 읽기·쓰기 규칙으로 공존하면, 요약 재계산이 이전 build의
  변경을 덮거나 여러 원인을 한 행으로 투영해야 합니다. 그래서 권위를 **한 배포에
  하나씩만** 옮깁니다.

  | 배포 | 판정이 읽는 것 | entry 쓰기 | 원인 쓰기 | 공존하는 이전 build |
  |---|---|---|---|---|
  | **A (shadow)** | entry — 지금과 같음 | **지금의 병합 규칙 그대로** | 모든 writer가 같은 transaction에서 **함께** 씀 | 지금 build. 둘 다 entry를 읽으므로 차이 없음 |
  | **B (원인 권위)** | 활성 원인 | 여전히 **지금의 병합 규칙 그대로**(요약 재계산 아님) | 계속 | A. A도 원인을 쓰므로 B가 A의 쓰기를 모두 봄. A는 entry를 읽고 B도 entry를 지금 규칙으로 쓰므로 A는 **지금과 같은 보장**을 받음 |
  | **C (정리)** | 활성 원인 | **중단**, entry는 읽지도 쓰지도 않음 | 계속 | B. B는 원인을 읽으므로 C의 쓰기를 봄 |

  - A의 migration이 기존 entry를 원인으로 backfill하고(위), A 이후 모든 entry 쓰기는
    원인 쓰기와 한 transaction이므로 **B 시점에 원인은 entry의 상위 집합**입니다.
  - **entry를 요약으로 재계산하지 않습니다.** 투영 규칙이 필요 없고, 이전 build의
    변경을 덮을 일도 없습니다. entry는 A·B 동안 **지금과 똑같은 의미**를 유지하는
    호환 기록이고, 해제 권한이나 관리자 판정에 쓰지 않습니다.
  - **B로 넘어가는 gate** — A가 전부 배포되었고, 원인 없는 entry와 entry 없는 원인
    쌍을 대조해 **발송 효과(분류별 허용·차단)·만료·provenance가 같다**는 보고가 0건
    불일치일 때. **C로 넘어가는 gate** — B가 전부 배포되었을 때.
  - 이전 build의 entry 삭제(관리자 해제)는 A에서 원인도 함께 해제하므로 어긋나지
    않습니다. A 이전 build의 삭제는 A와 공존하는 몇 분뿐이고 그때 판정은 entry이므로
    결과가 지금과 같습니다.

- **만료의 기록(C66)** — 판정은 위 활성 정의로 만료를 즉시 제외하므로 기다리지
  않습니다. **15분 runner**가 만료된 활성 원인에 `releasedAt`·`releaseKind: expired`·
  `releaseEvidence: { kind: "expiry" }`를 쓰고 요약을 수선합니다. 오래 발송이 없는
  주소도 이 sweep이 처리하므로 요약이 영원히 낡지 않습니다.
- **차단 효과는 활성 원인들의 합**입니다. hard bounce 뒤에 complaint가 와도
  transactional은 계속 막힙니다.

**scope는 셋입니다(C53).**

| scope | `purposeKey` | 걸리는 발송 |
|---|---|---|
| `global` | `*` (기존 값) | 모든 발송(원인별 차단 규칙에 따라) |
| `classification` | 분류 이름. **지금 허용값은 `marketing`뿐** | delivery가 고정한 `TemplateVersion.classification`이 그 값인 발송 |
| `purpose` | purpose 이름 | 그 purpose의 발송 |

- DB CHECK: `scope IN ('global','classification','purpose')`, `scope = 'classification'`
  이면 `purposeKey IN ('marketing')`, `scope = 'global'`이면 `purposeKey = '*'`.
  classification 이름과 purpose 이름은 scope가 달라 충돌하지 않습니다.
- 조회는 한 주소에 대해 global 행 + 그 분류의 classification 행 + 그 purpose 행입니다.
- 관리자 화면은 classification 행을 **"모든 광고성 메일"** 로 표시합니다.

**해제는 행위 × 원인 행렬입니다(C51, C57).** 해제 요건은 강약 순서가 아니라 서로
다른 행위 조건입니다. **한 행위는 자기가 풀 수 있는 원인만 풀고, 나머지 원인은 활성으로
남습니다.** 응답은 남은 원인을 알려 줍니다.

| 원인 | 관리자 1명 | 관리자 승인(이중 또는 1인 예외) | preference 재활성화 | delivered 사건 | 만료 |
|---|---|---|---|---|---|
| `privacy_request` | — | — | — | — | — |
| `hard_bounce` | — | **해제** | — | — | — |
| `complaint` | — | **해제** | — | — | — |
| `manual` | **해제** | **해제** | — | — | — |
| `unsubscribe` (purpose) | — | — | **해제** | — | — |
| `soft_bounce` | **해제** | **해제** | — | **해제** | **해제** |

- **delivered 사건(C57, C64)** — v15 계약대로 성공 시 해제합니다. 그 주소로 provider가
  delivered를 보고하면 **같은 주소의 활성 `soft_bounce` 원인 중 `occurredAt`이
  delivered 사건의 `occurredAt`보다 엄격히 이른 것만** 잠금 안에서 해제하고 요약을 다시
  계산합니다. **같은 시각이면 해제하지 않습니다.**
- **사건 시각의 단조 규칙(C71, C77)** — 처리 순서와 무관하게 같은 결과여야 합니다.
  사건의 순서 키는 **`(occurredAt, 종류 순위)`** 이고 **같은 시각이면 bounce가
  delivered보다 뒤**입니다(막힌 쪽이 이김, C64와 같은 방향).
  - delivery마다 `lastProviderEvent`(시각과 종류)를 두고, 상태 전이는 사건의 순서 키가
    이 값보다 **뒤일 때만** 적용합니다. 같은 시각의 bounce는 delivered 뒤이므로
    적용되고, 같은 시각의 delivered는 bounce 뒤가 아니므로 적용되지 않습니다.
  - 주소 단위로는 soft bounce 원인을 만들기 전에 그 주소의 가장 늦은 delivered 사건
    시각을 보고, bounce가 그보다 **엄격히 이르면** 만들지 않습니다(같으면 만듦).
  - delivered의 해제는 **엄격히 이른** soft bounce 원인만 합니다(같으면 두지 않음).
  - 연속 bounce 횟수는 수신 순서가 아니라 위 순서 키로 셉니다.
  - 시험: 같은 시각 포함, delivered-먼저·bounce-먼저 replay가 같은 원인·상태·횟수로 끝남.

- preference 재활성화는 그 purpose의 `unsubscribe` 원인만 풀고, 같은 purpose·그
  분류·전역에 다른 활성 원인이 남아 있으면 **켜기 자체를 거절**합니다.

**해제 증거와 승인 문맥(C45, C52).** 지금 `runWithAdminApproval()`은 operation에 승인
id를 넘기지 않고, 1인 관리자 경로(`soleApproverAllowed`)는 승인 행을 만들지 않습니다.
1인 조직에서 1인 경로를 금지하면 hard bounce는 영영 풀 수 없으므로 금지하지 않습니다.

- **`releaseEvidence`** — 권한 근거와 해제 기록을 **따로** 담습니다(C69):
  - `{ kind: "dual_approval", approvalId, releaseAuditLogId }`
  - `{ kind: "sole_admin", authorizationAuditLogId, releaseAuditLogId }` —
    `authorizationAuditLogId`는 1인 경로가 operation **전에** 별도 transaction으로 남기는
    `execution_started` 감사 행이고, `releaseAuditLogId`는 해제 transaction **안에서**
    만드는 `email_suppression.removed` 행입니다.
  - `{ kind: "admin", releaseAuditLogId }`
  - `{ kind: "preference", transitionId }`, `{ kind: "delivered", webhookEventId }`,
    `{ kind: "expiry" }`
- **감사 행과 해제는 한 transaction입니다(C62).** 지금은 해제 뒤에 감사 로그를 쓰고
  `writeAdminAuditLog()`가 id를 돌려주지 않아 증거를 원자적으로 만들 수 없습니다.
  `writeAdminAuditLog()`는 **이미 transaction client를 받으므로 id만 반환**하도록 바꾸고, 관리자
  해제 세 종류 모두 **잠금 → 재검증 → 감사 행 생성 → 원인 해제(그 id) → 요약 재계산**
  을 한 transaction에서 합니다. rollback되면 감사 행도 없습니다 — 일어나지 않은 해제를
  기록하지 않습니다. 해제 시도 자체의 기록이 필요하면 transaction 밖의 기존
  `*_started` 감사 사건을 씁니다.
- **승인 callback이 승인 문맥을 받습니다** — `runWithAdminApproval()`이 operation에
  `{ approvalId | null, authorizationAuditLogId | null, approvedPayload }`를 넘기도록
  바꿉니다. 승인 요청 payload에는 **요청 당시 활성 원인 id 집합**이 들어갑니다.
- **재검증 시점은 operation 안, 잠금 획득 직후**입니다. 활성 원인 id 집합이 payload의
  집합과 다르면 `approval_required`로 거절하고 새 승인 요청을 시작합니다.

**멱등 키(C54).** 원인 행의 unique는 `(emailAddress, scope, purposeKey, reason,
sourceEventKey)`이고 `sourceEventKey`는 NOT NULL입니다.

| writer | `sourceEventKey` |
|---|---|
| webhook 사건 | `webhook:<ProviderWebhookEvent.id>` |
| soft bounce 임계 | `softbounce:<deliveryId>`, delivery가 없으면 `softbounce:webhook:<ProviderWebhookEvent.id>` |
| privacy request | `privacy:<requestId>:intake` · `privacy:<requestId>:completed` |
| preference 끄기 | `preference:<EmailPreferenceTransition.id>` |
| 관리자 수동 | `admin:<요청 idempotency key>` — 클라이언트가 요청마다 생성해 보냄 |

- **사건 시각(C50)** — provider 사건은 payload의 `created_at`(ISO 8601, 수신 시각보다
  5분 넘게 미래가 아닐 때)을, 아니면 그 사건이 처음 저장된 `receivedAt`을 씁니다.
  요약이 "최근 원인"을 보여 줄 때는 `occurredAt` 내림차순, 같으면 원인 id 순입니다.

**preference 전이 기록(C63).** `service_status`처럼 동의가 필요 없는 purpose의 철회는
`ConsentRecord`를 만들지 않으므로, 원인의 키로 쓸 영속 id가 없습니다.

- append-only **`EmailPreferenceTransition`** — `id`, `userId`, `purpose`,
  `fromEnabled`, `toEnabled`, `source`, `occurredAt`, 그리고 동의 기록이 있으면
  `consentRecordId`. `source` 허용값(CHECK): `signup`, `preference_center`,
  `unsubscribe_link`, `admin`, `system_default`, `consent_confirmation`,
  `privacy_request`, `provider_complaint`.
- `setPreference()`가 **값이 실제로 바뀔 때만** 같은 transaction에서 씁니다. 같은 요청의
  재시도는 `already_set`으로 끝나 전이도 원인도 새로 만들지 않으므로, 첫 시도의 원인이
  그대로 멱등 결과입니다.
- 보존은 `EmailPreference`와 같습니다 — 계정 삭제 시 함께 지웁니다. 원인 행의
  `sourceEventKey` 문자열은 주소 기준 suppression과 함께 남습니다.

**complaint는 목적 opt-out도 함께입니다(C58).** v15 목록 위생 계약은 complaint에
영구 suppression과 **그 목적의 opt-out**을 요구합니다. webhook 효과 처리에서:

- **사용자 귀속(C65)** — preference와 동의는 사용자 기준입니다. 대상은 **originating
  delivery의 `userId`** 하나입니다. User 행을 잠근 뒤 그 사용자가 존재하고 **현재
  주소(정규화)가 delivery의 주소와 같을 때만** preference·동의를 바꿉니다. 사용자가
  없거나(계정 삭제) 주소가 바뀌었거나(재사용 포함) `userId`가 없으면 **사용자 기록은
  건드리지 않고** 주소 기준 원인만 씁니다 — purpose scope 원인도 주소 기준이므로 그
  purpose의 발송은 여전히 막힙니다.
- originating delivery의 `TemplateVersion.purpose`가 있고 위 조건이 맞으면 **같은
  transaction**에서 그 purpose의 preference를 끄고(`source: provider_complaint`), 실제
  동의가 있었으면 `ConsentRecord(withdrawn)`를 남기고, purpose scope `unsubscribe` 원인
  (`sourceEventKey` `webhook:<id>:purpose`)을 추가합니다. 나중에 관리자가 complaint
  원인을 풀어도 preference는 꺼진 채입니다.
- **표현 계약(C70)** — `ConsentRecord.capturedVia` CHECK와 `EmailPreference.source`
  CHECK에 **`provider_complaint`** 를 추가합니다. 철회 기록의 `policyVersionId`·
  `jurisdiction`은 **originating delivery가 고정한 `policyVersionId`·`jurisdictionCountry`**
  이고 `jurisdictionSource`는 `delivery_pinned`입니다 — 그 메일이 나간 조건에 대한
  반응이기 때문입니다.
- purpose가 없는 transactional complaint는 전역 complaint 원인만 추가하고(transactional을
  막지 않음), 기존 incident를 올립니다.

**총잠금 순서(C59).** 지금 `setPreference()`는 User 행 → EmailPreference 행을 잠근 뒤
`recordSuppression()`을 부르고, privacy intake는 주소 잠금부터 잡으려 합니다. 순서가
경로마다 다르면 교착합니다. **모든 경로가 한 순서를 따릅니다.**

1. **User 행**(`lockUserEmail`, 사용자를 아는 경로만)
2. **주소 전역** advisory 잠금
3. **classification** advisory 잠금(해당될 때)
4. **purpose** advisory 잠금(해당될 때)
5. **EmailPreference 행**

- 필요 없는 단계는 건너뛰되 **순서를 거스르지 않습니다.**
- **주소만 아는 writer**(webhook, 관리자 수동)는 잠금 전에 주소로 사용자를 **사전
  조회**하고, 사용자가 있으면 1부터 잡은 뒤 **User 행의 주소가 여전히 그 주소인지**
  재검증합니다. 달라졌으면 사용자 없이 2부터 진행합니다(suppression은 주소 기준).
- **sender**는 사용자 행을 잠그지 않습니다 — 2 → 3 → 4만 잡습니다. writer가 1을
  쥔 채 2를 기다려도 sender는 1을 기다리지 않으므로 순환이 없습니다.

**webhook 재처리 상태기계(C37, C47, C48)** — 지금은 원본 사건을 먼저 저장하고 적용에
실패하면 `processingError`만 남깁니다. provider가 재전송하면 unique 충돌이
`duplicate`로 끝나 **적용을 다시 시도하지 않습니다.**

| 받은 사건의 행 상태 | 처리 |
|---|---|
| 없음 | 새로 만들고 **claim한 상태로** 적용 |
| `processedAt` 또는 `abandonedAt` 있음 | `duplicate` — 200, 아무것도 안 함 |
| 미처리, claim 없음 또는 lease 만료 | **조건부 UPDATE로 claim** 후 재적용 |
| 미처리, lease 유효 | 다른 처리가 진행 중 — **409**. sweeper가 뒤를 받칩니다 |

- **fencing(C47)** — claim은 새 `processingLeaseId`(무작위)·`processingStartedAt`을
  쓰고 `processingAttempts`를 올리는 조건부 UPDATE 하나입니다. **성공·실패 기록은
  `WHERE processingLeaseId = 내 id AND processedAt IS NULL`** 조건부이고, 0행이면 그
  worker의 결과는 버립니다. lease가 만료된 뒤 늦게 끝난 worker는 새 claim을 건드릴 수
  없습니다.
- lease는 **60초**(writer 잠금 대기 20초 + 여유).
- 적용은 멱등이어야 합니다 — 원인은 `sourceEventKey` unique(위)로 중복을 막고,
  delivery 상태 갱신은 이미 같은 상태면 no-op입니다.
- **sweeper(C48, C55)** — provider 재전송은 유한합니다(Resend는 즉시 시도 포함 8회).
  하루 한 번인 `maintenance:cleanup`으로는 부족하므로, **15분마다 이미 도는
  `maintenance:credit-reservations` runner의 알림 drain 단계**
  (`lib/notificationDeliveryJob.ts`)에 sweep을 붙입니다. 조건은
  `processedAt IS NULL AND abandonedAt IS NULL AND (lease 없음 OR 만료)`, 같은 조건부
  claim, **한 번에 50행, 20초 예산**, 오래된 수신 순서.
- **시도와 종료(C74)** — claim은 **`processingAttempts < 10`인 행만** 가져가며, claim이
  시도 횟수를 올린 뒤 실행합니다. 실패의 fenced write는 **lease를 즉시 비우고**, 그
  실패가 **10번째 시도**였으면 같은 write에서 `abandonedAt`을 쓰고 incident를 올립니다.
  이후 재전송은 200으로 흡수합니다.

  | claim 전 시도 | 결과 | 다음 상태 |
  |---|---|---|
  | 0–8 | 실패 | 시도 1–9, lease 없음 — 재claim 가능 |
  | 9 | 실패 | 시도 10, `abandonedAt`, incident |
  | 0–9 | 성공 | `processedAt`, lease 없음 |
  | 0–9 | lease 만료(결과 미기록) | 시도는 이미 증가, 만료 후 재claim 가능 — 9에서 만료되면 10이 되어 더 claim하지 않으므로 sweeper가 `abandonedAt`만 기록 |

  **끝 상태의 경합(C78)** — 10번째 lease가 만료된 뒤 늦게 끝난 worker와 sweeper가
  겹칠 수 있습니다. 두 write의 조건으로 **먼저 커밋한 쪽만** 이깁니다.

  - worker 완료·실패 write: `processingLeaseId = 내 id AND processedAt IS NULL AND
    abandonedAt IS NULL`.
  - sweeper abandon write: `processedAt IS NULL AND abandonedAt IS NULL AND
    processingAttempts >= 10 AND (lease 없음 OR 만료)`이고, 같은 write에서
    `processingLeaseId`를 비웁니다.
  - 한 행이 processed와 abandoned를 함께 갖는 일은 없습니다. DB CHECK로도
    `processedAt IS NULL OR abandonedAt IS NULL`.
- **계정이 둘입니다(C56).** A18로 transactional과 marketing은 Resend 계정이 다른데
  webhook은 secret 하나(`RESEND_WEBHOOK_SECRET`)이고 사건 행에 계정 표시가 없습니다.
  - **stream별 endpoint** — 경로에 stream을 둡니다(`transactional`·`marketing`).
    각각 자기 secret으로 검증합니다: transactional은 `RESEND_WEBHOOK_SECRET`,
    marketing은 `MARKETING_RESEND_WEBHOOK_SECRET`.
  - `ProviderWebhookEvent.providerAccount`에 그 stream을 남기고, unique는
    `(provider, providerAccount, providerEventId)`입니다.
  - **delivery와의 결속(C72)** — 지금 조회는 계정 구분 없이
    `findFirst({ providerMessageId })`이고 그 컬럼은 unique가 아닙니다.
    **`EmailDelivery.providerAccount`를 발송 시 고정**하고, 조회와 partial unique를
    `(providerAccount, providerMessageId)`로 합니다. 기존 행은 고정된
    `TemplateVersion.classification`의 stream으로 backfill합니다(A18 이전 발송은 모두
    transactional).
  - **아직 결속되지 않은 사건(C79)** — `providerMessageId`는 provider 응답 뒤에 기록되므로
    그 사이 webhook이 먼저 올 수 있습니다. 그런 사건은 곧바로 unmatched로 확정하지
    않습니다.
    - delivery를 찾지 못하면 사건은 **`awaiting_delivery`** 로 남고(`processedAt` 없음,
      lease 없음), sweeper가 매 회 결속을 다시 시도합니다.
    - **수신 후 15분**이 지나도 찾지 못하면 **주소 기준 효과만으로 확정**합니다 —
      사용자 귀속·purpose opt-out·delivery 고정 정책은 적용하지 않습니다. 알림 큐처럼
      delivery가 영원히 없는 발송도 이 길로 15분 뒤 처리됩니다.
    - 대기는 시도 횟수를 쓰지 않습니다. 15분 경계는 `receivedAt`과 DB `now()`로 판정합니다.
- **incident 두 가지를 더 둡니다** — 수신 후 **1시간** 넘게 미처리인 행이 있을 때, 그리고
  **계정별 침묵**(provider가 endpoint를 자동 비활성화했을 가능성).
  - **발송 증거는 `EmailDelivery.sentAt`뿐입니다(C67).** stream은 delivery가 고정한
    `TemplateVersion.classification`에서 유도합니다. standard·credential lane이 여기에
    들어갑니다.
  - **제외 경로**(delivery 행이 없음): 알림 큐(`lib/notificationDeliveries.ts`), 운영자
    알림, 관리자 테스트 메일. 이들만 발송된 날은 침묵을 판정하지 않습니다.
  - **창과 시계** — DB `now()` 하나를 기준으로 `[now() − 24시간, now())`. 발송은
    `sentAt`, webhook은 `ProviderWebhookEvent.receivedAt`으로 셉니다.
  - **조건** — 그 계정의 발송이 창 안에 **5건 이상**이고 그 계정의 webhook이 **0건**.
    소량일 때의 우연을 경보로 만들지 않기 위한 하한입니다.
  - 평가는 API key와 webhook secret이 **둘 다 설정된 계정만** 합니다.

**시간 예산(C31)**

| 항목 | standard lane·알림 큐·로그인 방법 변경 | credential lane |
|---|---|---|
| 잠금 대기(`lock_timeout`) | **2초** | **300ms**, 3초 요청 예산(`CREDENTIAL_SEND_BUDGET_MS`) 안에 포함 |
| provider 호출 timeout | **10초** — 지금 standard lane은 `timeoutMs`를 넘기지 않으므로 명시 | **남은 예산 − 100ms**, 상한 `CREDENTIAL_ATTEMPT_TIMEOUT_MS`(2.5초) |
| transaction timeout | **15초** | 남은 예산 |
| 잠금을 못 얻으면 | claim 해제, **기존 backoff로 재시도**, 시도 횟수는 올리지 않음 | 그 시도는 재시도 가능한 실패, 예산 안에서 다음 시도 |
| provider timeout | 기존 retryable 오류 처리(같은 idempotency key로 재시도) | 기존 처리 |
| writer 쪽 잠금 대기 | **20초**. 넘으면 오류 — webhook은 5xx로 provider 재전송, 사용자 요청은 재시도 안내 | 같음 |

- sender는 **provider 시도마다** 잠금을 잡고 **retry 대기는 잠금 밖**입니다.
- 잠금은 모든 writer가 `recordSuppression()`을 거치므로 **그 함수 안에서** 잡습니다.

**credential lane이 범위 안인 이유(C23)** — 로그인 코드 요청은 인증 없이 **임의
주소**로 시작할 수 있고, 이 lane이 존중하는 suppression에는 hard bounce뿐 아니라
**manual·privacy request**가 있습니다. 지금은 첫 시도 전에 한 번만 검사하므로
재시도가 그 사이 커밋된 privacy request를 넘습니다.

보장 문구는 관측 가능한 사건으로 적습니다 — **"고객 대상 lane에서 철회 또는 suppression 커밋
이후 시작된 provider 제출 0건"**, 그리고 두 시각을 `EmailPermissionDecision`에
남깁니다.

### 7.5 수신거부 링크 유효 — keyring canary readiness (C12, C25, S1a 구현)

토큰은 만료되지 않지만 **과거 키가 환경변수에 남아 있는 동안만** 해독됩니다
(`lib/unsubscribeToken.ts`). 토큰은 random IV로 만들어지고 실제 발송 토큰을
보관하지 않으므로, **"가장 오래된 실제 토큰"은 시험 대상이 될 수 없습니다.**

- **key version마다 inert canary 토큰**을 발급해 보관합니다. 이 검사는 **복호화만**
  확인합니다 — endpoint를 호출하지 않으므로 rate limit·preference write·고객
  데이터에 닿지 않습니다.
- **delivery에 key version을 기록**합니다.
- readiness 계약: **그 key version으로 마지막 발송한 뒤 1년(구현 당시 30일에서 계약에 맞춰 정정)이 지나기 전에는 그
  키를 제거할 수 없습니다.** readiness가 모든 보존 대상 key version의 canary를
  복호화해 확인합니다.
- **이것은 불변식 10(end-to-end synthetic)이 아닙니다.** 불변식 10은 endpoint·
  rate limit·preference write까지 지나는 점검이고, 전용 synthetic 계정·호출 경로·
  예상 응답·고객 데이터 무변경 조건을 **활성화 전 단계(12절 S10a)** 에서 정합니다.

### 7.6 발송 판정의 전체 계약 (C9, C13, C16)

```
releaseNotesAuthorizationVerdict({
  userId, purpose,
  deliveryAddress,                   // enqueue 때 delivery에 고정된 주소
  currentAccountAddress,             // send 시점의 계정 주소(enqueue에서는 같은 값)
  countryCandidates,                 // 영속된 후보 목록 [{country, signal, ruleVersion, copyHash}] (5.3). 비면 ZZ
  rules,                             // 후보 국가마다 ReleaseNotesCountryRule(버전 포함)
  obligations,                       // rule의 의무 상태(7.8)
  auSenderAuthority,                 // 호주 발신자 authority 입력
  consentRecords, permissionEvents,
  approvals,                         // 유효한(철회 없는) EmailSendApproval과 member 쌍
  suppression,                       // 활성 원인: 전역 + classification + purpose (7.4)
  flags,                             // marketing, releaseNotes, collection
  pinnedDisplay,                     // enqueue 때 고정한 TemplateVersion과 표시 metadata
  phase,                             // "enqueue" | "send"
}) -> {
  authorities: [{ authority, basis, evidenceIds, verdict, reason }],
  legalAllowed,                      // 모든 authority가 허용
  overrideApplied,                   // null | { approvalId, type: "risk_accepted" }
  blockers,                          // suppression, objected, ZZ, 의무 미정, flag, display
  displayContract: { pinnedDisplayContractHash, requiredDisplayContractHash, satisfied },
  allowed,                           // (legalAllowed || overrideApplied) && blockers가 비어 있음
  ruleVersions, policyVersionId, evaluatedAt,
}
```

- **authority 판정은 override의 영향을 받지 않습니다.** override는 `allowed`
  계산에만 들어가고, `blockers`는 override가 넘지 못합니다(5.6의 표).
- **렌더링 정책과 권한 판정을 나눕니다.** 렌더링은 enqueue 시점에 고정,
  권한은 **provider 제출 직전의 현재 값**으로 다시 판정합니다.
- **표시 계약도 send 시점에 비교합니다(C16).** pinned 표시 metadata가 **현재
  의무 상태가 요구하는 표시**(footer block, 제목 접두어, 수신거부 안내)를 충족하지
  못하면 `display_contract_changed`로 skip하고 **현재 version으로 재enqueue**합니다.
  - **skip과 replacement 생성은 한 transaction**입니다.
  - replacement는 `supersedesDeliveryId`를 갖고 그 컬럼은 **unique** — 한 delivery의
    replacement는 최대 하나입니다.
  - **`displayContractHash`** — 표시 계약의 canonical JSON(키 정렬) SHA-256입니다.
    판정 출력과 두 snapshot은 모두 **`pinnedDisplayContractHash`(enqueue 때 고정한 값)·
    `requiredDisplayContractHash`(send 때 다시 계산한 값)·`satisfied`** 라는 같은 이름을
    씁니다.
    담는 것: 후보별 `ruleVersion`(정렬), 표시 의무 key마다 합성된 상태와 값,
    **유효한 waiver 승인 id**(정렬), 제목 접두어, footer block id 목록, 수신거부 안내
    metadata, `TemplateVersion` id. enqueue 때 delivery에 고정하고, send 때 현재 값으로
    다시 계산해 다르면 `display_contract_changed`입니다.
  - idempotency key는 **`rootDeliveryId + ":g" + generation + ":" + hash 앞 16자`** 로
    결정적이고 provider 한도(256자) 안입니다. crash 후 재처리해도 같은 key라 두 번째가
    생기지 않습니다. replacement는 **현재 `TemplateVersion`과 현재 계약**으로 렌더합니다.
  - 현재 `(event, recipient)` unique를 넘기 위해 delivery에 `generation`을 두고
    unique를 `(event, recipient, generation)`으로 바꿉니다.
  - 두 snapshot은 `supersedesDeliveryId`로 이어집니다.
- **표시 계약은 후보 국가 전체의 합집합**으로 계산합니다(5.3). 합성할 수 없으면
  `display_unsatisfiable` blocker입니다.
- **cohort 검증**(5.6): `userId`·`deliveryAddress`·`currentAccountAddress`의 digest가
  active member와 모두 일치하지 않으면 override는 적용되지 않고, override가
  필요한 발송이면 `approval_member_mismatch` blocker입니다.
- **snapshot을 둘 남깁니다** — `phase: enqueue`와 `phase: send`. 각 snapshot에
  rule·표시 계약의 양쪽 버전과 비교 결과가 들어갑니다. send가 거부하면
  `permission_revoked` 또는 `consent_withdrawn`으로 skip합니다.
- **판정에 필요한 DB 조회가 실패하면 skip도 failed도 아닙니다.** claim을 풀고
  **기존 backoff로 `nextAttemptAt`을 설정**하며 incident를 올립니다. **현재 drain은
  예상 밖 오류를 영구 `failed`로 만들므로**(`lib/standardEmailLane.ts`) 이 분기를
  따로 둡니다.

### 7.7 한국 법정 의무 — 의무별로 정합니다

**소유자 결정(2026-09-16)**: 한국에 이메일을 보냅니다. 의무는 무게가 같지
않으므로 **의무마다** 구현·연기·면제를 정합니다.

| 의무 | 근거 | 상태 | 내용 |
|---|---|---|---|
| 본문 명시사항 — 명칭·**전자우편주소·전화번호**·주소 | 별표 6 | **implemented** | `contact_phone` footer block 추가. 없으면 fail-closed(불변식 9) |
| 한·영 수신거부 안내와 간편한 기술적 조치 | 별표 6 | **implemented** | footer 문구 병기. one-click은 이미 있음 |
| 수신거부에 로그인 요구 금지 | 안내서 | **implemented** | 이미 있음 |
| **14일 이내 처리결과 통지** — 수신동의·수신거부·철회 | 제50조제7항, 시행령 제62조의2 | **implemented** | 아래 |
| **2년마다 수신동의 사실 고지** | 제50조제8항, 시행령 제62조의3 | **deferred** — 첫 기한 전까지 | 아래 |
| 제목 `(광고)` 표기 | 제50조제4항, 별표 6 | **waived** | 아래 |

**`risk_accepted` 수신자의 2년 고지 기준일 — 가입일로 간주합니다(L12, 소유자 결정
2026-09-16).** 실제 동의한 사람은 동의일이 기준이고, `risk_accepted` cohort는
**가입일**이 기준입니다.

- 기준일은 **`EmailSendApprovalMember.noticeAnchorAt`** 에 둡니다. 값은 계정의
  `createdAt`이고 출처는 불변 필드 **`noticeAnchorSource = signup_date_deemed`** 입니다. **`ConsentRecord(granted)`는
  여전히 쓰지 않습니다** — 동의 장부에는 실제 동의만 남고, 간주는 승인 원장에
  승인의 일부로 남습니다.
- 기존 78계정의 가입일은 전부 2026년이므로 첫 기한은 2028년입니다. 기한 감시는
  **수신자별 `실제 동의일 ?? noticeAnchorAt` + 2년**의 최솟값을 씁니다(아래 2년 고지).
- 고지 문안(S2)은 이 기준일을 적되, 문구는 승인 대상입니다. 권장은 **"2년 고지
  기준일: 가입일(YYYY-MM-DD)"** 처럼 기준일이 가입일이라는 사실만 적는 표현입니다.
  "수신동의일"도, "가입일부터 수신 중"도 쓰지 않습니다 — 앞은 동의하지 않은 날을
  동의일로 적고, 뒤는 실제 수신 시작일(첫 발송)과 다릅니다.
- 동의 결과 통지(동의 시점)는 이 cohort에 해당하지 않습니다. 수신거부 결과 통지와
  표시 항목은 동의 여부와 무관하게 적용됩니다.
- cohort 계정이 실제로 동의하면 **그 `ConsentRecord`의 동의일이 기준일로 우선**합니다.
  member 행의 `noticeAnchorAt`은 고치지 않습니다.

**14일 통지 — 구현합니다.**

- **수신동의** — DOI 확인 **요청** 메일은 동의가 일어나기 전에 나가므로 통지가 될 수
  없습니다(C28). **확인 링크 클릭이 성공한 transaction**에서, 방금 쓴
  `ConsentRecord(granted)`를 참조하는 별도 transactional delivery
  `consent_result_notice`를 함께 enqueue합니다. 내용은 전송자 명칭·동의 사실과
  날짜·처리 결과입니다. 반복 클릭은 `(consentRecordId)` idempotency key로 한 번만
  생깁니다.
- 수신거부·철회는 **짧은 transactional 확인 메일**을 보냅니다(수신거부한 주소에도
나가는 service 메일입니다). `risk_accepted`로 받던 사람이 수신거부해도 같습니다.

**2년 고지 — 연기합니다.** 가장 이른 동의가 들어오는 날부터 첫 기한은 2028년입니다.
지금 만들지 않되, **잊지 않는 장치는 지금 둡니다** — readiness가 한국 수신자마다
**`실제 동의일 ?? noticeAnchorAt` + 2년**을 계산하고, 그 최솟값 − 60일을 넘기면
경고, 최솟값을 넘기면 한국 rule을 막습니다.
구현할 때의 증거 기준은 v11과 같습니다(provider 접수 이후에만
`ConsentRecord(confirmation_notice_sent)`, Asia/Seoul 달력, 2월 29일 동의는 2월 28일).

**`(광고)` — 면제합니다.** 판단 근거는 peer 관행(한국 법인 없는 해외 SaaS는
대체로 표기하지 않음), 표기가 주는 스팸 인상, 지인 경로 수신자라는 낮은 신고
가능성입니다. **"법이 요구하지 않는다"가 아니라 "요구하지만 표기하지 않기로
했다"** 이고, 신고가 들어오면 가장 먼저 지적될 항목이라는 점을 함께 적습니다.
구현은 KR 프로필의 `subjectPrefix`를 비우는 것이 아니라 **면제 기록을 읽어
생략**합니다 — 시드 값을 지우면 결정이 코드에서 사라집니다.

### 7.8 의무 상태 기록 — 끄는 장치가 아니라 빠뜨리지 않는 장치

v11은 "하나라도 빠지면 한국 rule disabled"였습니다. 그 장치가 막으려던 것은
**아무도 모르게 빠지는 사고**이고, 소유자의 면제 결정까지 막을 이유는 없습니다.

`ReleaseNotesCountryRule`에 의무 목록과 각 상태를 둡니다.

| 상태 | 뜻 | 필수 기록 |
|---|---|---|
| `implemented` | 코드가 수행하고 readiness가 확인 | 확인하는 check 이름 |
| `deferred` | 아직 없지만 기한 전에 만듦 | `dueBy`, 경고 시점 |
| `waived` | 하지 않기로 결정 | **`EmailSendApproval` id**(유형 `obligation_waiver`) — 승인자·날짜·사유·재검토 조건은 그 원장에 |

- **상태가 없는 의무가 하나라도 있으면** 그 rule은 막힙니다. 새 의무가 생기면
  누군가 정할 때까지 보내지 않습니다.
- `implemented`인데 readiness check가 실패하면 막힙니다(불변식 9와 같은 방식).
- `deferred`는 `dueBy`가 지나면 막힙니다.
- `waived`는 **연결된 승인이 유효할 때만** 보냅니다 — 철회 사건이 없고, 유형이
  `obligation_waiver`이며, 범위의 policy version·rule·country·obligation key가
  **정확히** 일치해야 합니다. 하나라도 어긋나면 **미결과 같이 차단**합니다. `(광고)`
  면제를 철회하면 다음 판정부터 표기가 다시 요구됩니다. **admin 화면에 그대로 보입니다.**
- `risk_accepted` override도 같은 검증(active·유형·cohort 일치)을 거칩니다(5.6).
- 이 구조는 한국 전용이 아닙니다. 싱가포르 `<ADV>`, 미국 CAN-SPAM 우편 주소도
  같은 목록에 들어가고, 그 둘은 `implemented`입니다.

## 8. D6 — 문안 규칙

`release_notes` 템플릿은 **구조화된 payload**를 받습니다.

```
{ headline, items: [{ title, body, link? }], footerNote? }
```

- `link`는 **제품 경로 id**입니다. 고정 표에서 고르며 가격·결제·업그레이드
  경로는 표에 없습니다.
- **발송 시점에 redirect를 따라가지 않습니다.** 외부 목적지는 이 범위에서
  허용하지 않습니다.
- 금칙어 검사는 보조 guard입니다.

ACMA(Lululemon, 2026-03): "marketing messages must have an unsubscribe option and
**the simplest way to comply is to keep transactional or service messages
separate from sales content and links.**"

---

## 9. 제품 내 안내 — 선택지이며 이메일의 대체물이 아닙니다

**D 결정(11.1)에 따라 한국 사용자도 동의를 받아 이메일로 보냅니다.** 이 절은
동의하지 않은 사용자에게 같은 내용을 제품 안에서 보여 주는 **선택지**이며,
이번 범위의 필수 단계가 아닙니다.

KISA 안내서는 접속해서 보게 된 광고 정보를 "전송"과 구분합니다. 다만 **"제품
안"의 경계를 명시합니다.**

**포함** — 사용자가 직접 연 **인증된 웹·앱 화면 안에서 요청 시 렌더링되는
콘텐츠**만.

**제외** — 이메일, SMS, 앱·브라우저 push, OS 알림, service worker, 백그라운드
badge·toast.

**그리고** — 제품 내 표시를 이유로 한국 사용자의 이메일 suppression이나
preference를 바꾸지 않습니다. 보안·청구·서비스 이메일은 자체 분류로 계속
가능하되 **그 안에 `release_notes` 내용을 섞지 않습니다.** 한국에서 이메일은
주소별 express consent가 있을 때만입니다.

---

## 10. 문서 검토 — 근거는 문서 위에 섭니다

**지금 우리 방침이 새 설계와 정면으로 어긋납니다.**

> 현재 `/privacy`: "…**신청하신 경우에만** 제품 소식·뉴스레터·프로모션을
> 보냅니다. … 뒤의 셋은 **켜신 뒤에만** 발송되고…"

법이 opt-out을 허용해도 우리가 안 한다고 적어 두었으면 그 약속이 기준입니다.

| 대상 | 무엇을 |
|---|---|
| `/privacy` | 국가 rule별 근거, 거부 방법(로그인 불필요), 보존 기간 |
| `/terms` | 이메일 조항 유무 확인, 동의의 유효 기간(R5) |
| 가입 화면 2개 장치 문안 | 근거별로 다른 문안. 7개 언어 |
| 로그인 화면 동의 문장 | 이메일을 묶을지 별도로 둘지 |

**절차** — 방침·약관 변경은 [이메일 알림](email-notifications.md) §3.1 표의
5번 유형(service/legal)이라 **수신 거부자에게도 보내야 하는 통지**입니다. 전체
사용자에게 변경 고지가 나가고 시행일을 정해야 합니다.

**법적 문안은 제가 초안을 만들고 승인을 받습니다. 그리고 S3보다 먼저입니다** —
승인되지 않은 문안을 구현하고 해시할 수는 없습니다.

---

## 11. 승인 현황 (2026-09-16)

| # | 무엇 | 상태 |
|---|---|---|
| A | **C1·C8 개정** — 국가 rule로 대체 | **승인** |
| B | **가입 흐름에 두 장치** | **승인** |
| C | **호주에서 추론 동의** | **승인.** 4.4의 관계 모델과 E 시행 뒤 발효 |
| D | **한국** | **승인 — 동의 체크박스 + 의무별 결정**(7.7): 명시사항·수신거부 안내·14일 통지 구현, 2년 고지 연기, `(광고)` 면제 |
| E | **방침·약관 개정과 전체 변경 고지** | **승인** |
| F | **기존 78계정** | **승인 — 전원 발송, `risk_accepted`로 기록**(5.6) |
| G | **R1 외부 자문** | **미결. EEA·영국 soft opt-in만 막습니다.** S0·S1a는 착수 가능 |

### 11.1 D — 한국은 동의를 받아서 이메일로 보냅니다

제품 내 안내를 이메일의 대체물로 쓰지 않습니다. 한국 사용자는 5.3의 화면에서
**"이메일 광고성 정보 수신동의 (선택)"** 으로 동의하고 DOI를 지나 이메일을
받습니다. 그 메일에는 **7.7에 기록된 상태대로** 의무가 붙습니다. 9절의 제품 내 안내는
동의하지 않은 사용자를 위한 선택지로 남습니다.

### 11.2 F — 기존 78계정

5.5가 적었듯 **기존 계정에는 어느 법역에서도 근거가 없습니다.** 소유자는 이를
알고 **전원 발송**을 결정했고, 그 결정은 `risk_accepted`로 기록됩니다(5.6).

- 5.4의 **제품 내 동의 안내는 그대로 띄웁니다.** 동의한 분은 `express_consent`로
  옮겨가고 `risk_accepted`가 덮입니다.
- **동의 기록을 지어내지 않습니다.**
- **범위는 승인 시점의 계정·주소 목록입니다**(5.6). 주소를 바꾸거나 국가가 없는
  계정은 받지 않습니다.
- **표시 의무는 7.7의 기록을 따릅니다** — 기존 계정이라고 따로 면제하지 않습니다.
- 수신거부는 즉시·영구이며 7절의 불변식 전부를 지납니다.

### 11.3 G — 외부 자문 의뢰 범위

EEA·영국을 여는 선행 게이트입니다.

**물어야 할 것**

1. Tomverse의 무료 이용과 유료 구독 사이에 CJEU C-654/23이 말한 **간접 보상
   관계**가 성립하는가. 성립한다면 그 근거는 무엇인가.
2. `release_notes`가 제13조(2)의 **"자사의 유사한 상품·서비스"** 에 해당하는가.
3. 5절의 **두 장치**가 "수집 시점의 거부 기회" 요건을 충족하는가. 문안 초안을
   함께 검토받습니다.
4. **회원국별 국내법 구현** — 최소 프랑스(CPCE L.34-5), 독일(UWG 제7조제3항의
   네 요건), 그리고 발송 예정국. 오스트리아(ECG-Liste)와 아일랜드(12개월·형사범)를
   이번 범위에서 제외해도 되는지 확인합니다.
5. **영국** — ICO가 freemium에 입장이 없는 상태에서 PECR reg 22(3)의
   "negotiations for the sale"에 우리 무료 계정이 들어가는가.
6. **기존 사용자** — 소급 불가라는 이 문서의 판단이 맞는가.

**건네야 할 자료** — 가입·과금 흐름, 무료/유료 기능 경계와 한도, 가격 구조,
`release_notes` 문안 예시, 두 장치의 문안 초안, 현재 방침·약관, 이 문서.

**받아야 할 형태** — 국가별로 "열림 / 조건부 / 닫힘"과 그 조건. 조건은
`ReleaseNotesCountryRule.conditions`에 그대로 들어갑니다.

---

## 12. 구현 순서

| # | 단계 | 선행 결정 | 비고 |
|---|---|---|---|
| S0 | 상위 계약 개정 — 분류표, **IP 추정 국가(이메일 알림 6.1·6.2와 `AGENTS.md`)**, 기록 세 층, 4.3의 표, 7.7·7.8, **webhook·suppression 절 동기화(이메일 알림 9.6, 10.2, 13.3, 13.5, 14.4 — 중복 webhook 즉시 200, 사건·delivery·entry 단일 transaction, 이유 병합을 7.4의 lease·원인 모델로)** | — | 문서 |
| S1a | **독립 기계** — 7.2 TemplateVersion metadata와 backfill, 7.3 rate limit, 7.5 keyring canary·key version·보존 readiness | **닫힘** | **완료** — #1492 병합. Codex 코드 검토 3회. 보존 기간은 계약대로 1년 |
| S1b | **잠금** — 7.4의 writer·remover·sender 목록 전체, 원인별 멱등 insert·활성 원인 효과 합성·요약 재계산, 총잠금 순서, `sendWithAddressLock()` helper, 운영자 발송 module 분리와 정적 검사, 로그인 방법 변경 안내의 standard lane 이동, 시간 예산, privacy request suppression(접수·완료·legal hold), webhook 재처리 상태기계 | **닫힘**(7.4, v18) | **착수 가능.** 규모가 커서 PR을 나눕니다(아래). **Codex 검토** |
| S2 | **법적 문안 초안과 승인** — `/privacy`·`/terms`·가입 두 장치·한국 동의 화면·7.7의 통지 문안, 7개 언어 | R5 동의 유효 기간 | 해시할 문안이 먼저 |
| S3 | `EmailPermissionEvent`·`Decision`·**`EmailSendApproval`(+Member)** + purpose classification 표 + DB CHECK. 불변식 5·7 | — | **Codex 검토** |
| S4 | `SignupConsentAttempt` + 두 가입 경로 finalize + **IP 추정 국가 기록과 설정의 국가 정정**(5.3). 별도 `collectionEnabled` 게이트 | S0의 관할권 계약 개정 | **Codex 검토** |
| S5 | `ReleaseNotesCountryRule` + 이중 authority + 호주 관계 lifecycle | **R4** 유지·휴면 기준, OAuth 주소가 "직접 제공"을 충족하는 방법 | |
| S6 | 의무 상태 기록(7.8) + 한국 `implemented` 항목 — `contact_phone`(불변식 9), 한·영 안내, 14일 통지(`consent_result_notice` 포함) + 2년 고지 수신자별 기한 경고 | S3(승인 원장) | 2년 배치는 기한 전 별도 |
| S7 | 템플릿 + 구조화 payload + 링크 표 | — | |
| S8 | 기존 사용자 제품 내 동의 안내(5.4) + 기존 계정 IP 추정 국가 기록(5.3) + 제품 내 안내 화면(9절) + 78계정 승인·cohort 기록과 admin 표시 | S3 | |
| S9 | **7.6 판정 함수와 두 snapshot**, 표시 계약 비교·재enqueue, DB 오류 재시도(불변식 11), 전용 flag를 `createStandardDeliveryRows`·`expandEmailEvent`·drain에서 검사, audience·estimate·drain 공유, 행 없는 미리보기 | S3·S5·S8 | **Codex 검토** |
| S10a | 불변식 10 end-to-end synthetic — 전용 계정·경로·예상 응답·데이터 무변경 조건 | S9 | 활성화 전 |
| S10 | 방침·약관 게시, 전체 변경 고지, 시행일, 새 정책 버전 | — | 마지막 |

**S1b의 PR 분할** — 한 PR에 담기에는 경로가 많습니다.

1. **S1b-1** `SuppressionCause`와 기존 행 backfill, 요약 재계산과 만료 sweep, scope 셋(classification 포함)과 CHECK,
   해제 행위 × 원인 행렬, 해제 증거와 `runWithAdminApproval()` 승인 문맥, 원인별
   `sourceEventKey`와 `EmailPreferenceTransition`, 감사 행과 해제의 단일 transaction,
   총잠금 순서, preference 재활성화 제한, privacy request
   suppression(접수·완료·legal hold), `withdrawAllMarketing()`의 transaction 수용,
   complaint의 목적 opt-out과 `provider_complaint` 표현, delivered·bounce 사건 시각의 단조
   규칙, provider 사건 시각, 원인 provenance 컬럼, **3단계 배포의 A(shadow)**,
   **`EmailDelivery.providerAccount`와 `(providerAccount, providerMessageId)` 결속**
   (C81 — complaint 귀속과 단조 규칙이 필요로 함). B·C는 각 gate 뒤 별도 PR.
2. **S1b-2** webhook 재처리 — stream별 endpoint·secret·`ProviderWebhookEvent.providerAccount`,
   lease·fencing과 시도 전이·끝 상태 경합, `awaiting_delivery` 재결속,
   15분 runner의 sweep, 종료와 incident 세 가지.
3. **S1b-3** `sendWithAddressLock()`, standard·credential lane과 알림 큐 고객 kind 전환,
   시간 예산, 운영자 발송 module 분리와 정적 검사, `login_method_linked`·
   `login_method_unlinked` template과 standard lane 이동. S1b-1의 잠금 API 위에 섭니다.

**활성화 전에 닫아야 하는 것** — R3(싱가포르 수신거부 이메일 주소), R2(발송 도메인
평판). **EEA·영국 soft opt-in 전에** — G.

**활성화 순서** — 문서 시행 → 정책 버전 활성화 → readiness 확인 → send flag.

## 13. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | freemium이 ePrivacy 13(2)의 "판매 맥락"인가 — **회원국별** 외부 자문 | EEA·영국 해제 |
| R2 | marketing 스트림 발송의 평판 영향 | 발송 도메인 |
| R3 | 싱가포르 "수신거부 요청을 보낼 이메일 주소"를 현재 footer가 충족하는가 | **SG 활성화 전 필수** |
| R4 | 호주 관계의 유지·휴면 기준값 | 4.4에서 정하고 문서에 적음 |
| R5 | 동의의 유효 기간 — ACMA는 숫자를 주지 않고 **약관에 적으면 그 기간이 기준** | 문서 문구 |

**한국 의무** — 14일 통지는 구현, 2년 고지는 기한 전 구현으로 연기, `(광고)`는
면제입니다(7.7). 연기와 면제는 7.8의 기록으로 남습니다.

**참고**: 불변식 5(전체 수신거부)는 법정 최소요건이 아니라 **보수적인 제품
정책**입니다. TAB 사건의 핵심은 거부한 채널로 계속 보낸 것입니다.

---

## 14. 출처

- ePrivacy 지침 2002/58/EC 제13조 — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- CJEU C-654/23 Inteligo Media (2025-11-13) — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62023CJ0654)
- CNIL, 전자적 수단의 고객·잠재고객 커뮤니케이션 (2026-06-10) — [cnil.fr](https://www.cnil.fr/fr/communication-electronique-quelles-regles)
- ICO, direct marketing 식별 — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/identify-direct-marketing/)
- 스위스 FDPIC, 광고·마케팅 — [edoeb.admin.ch](https://www.edoeb.admin.ch/de/werbung-marketing)
- 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」 KISA-GD-2025-0037 (2025.12) — [kisa.or.kr](https://www.kisa.or.kr/401/form?postSeq=3608&lang_type=KO)
- 호주 Spam Act 2003 — [legislation.gov.au](https://www.legislation.gov.au/C2004A01214/latest/text)
- ACMA 침해통지 등록부 — [acma.gov.au](https://www.acma.gov.au/infringement-notices)
- ACMA, 동의에 관한 Statement of Expectations (2024) — [acma.gov.au](https://www.acma.gov.au/publications/2024-07/guide/consumer-consent-expectations-businesses-conducting-telemarketing-and-e-marketing)
- ACMA, Lululemon 처분 (2026-03) — [acma.gov.au](https://www.acma.gov.au/articles/2026-03/lululemon-penalised-702k-spam-breaches)
- OAIC, APP Guidelines Chapter 7 — [oaic.gov.au](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-7-app-7-direct-marketing)
- 싱가포르 Spam Control Act 2007 — [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/SCA2007)
- CAN-SPAM 15 U.S.C. 7702조 — [Cornell LII](https://www.law.cornell.edu/uscode/text/15/7702)
- FTC, CAN-SPAM 최종규칙 제정이유 70 Fed. Reg. 3110 (2005-01-19) — [federalregister.gov](https://www.federalregister.gov/documents/2005/01/19/05-974/definitions-and-implementation-under-the-can-spam-act)
- 중국 「互联网电子邮件服务管理办法」 — [moj.gov.cn](https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/200606/t20060606_144140.html)
