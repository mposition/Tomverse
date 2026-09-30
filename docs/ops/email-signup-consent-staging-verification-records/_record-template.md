---
record: staging-verification
checklist: docs/ops/email-signup-consent-staging-checklist.md
templateRevision: 2026-09-30a
environment:
deploySha:
startedAtUtc:
completedAtUtc:
executor:
approver:
result:
frozen: false
digest:
---

# 가입 동의·제품 내 안내 staging 검증 실행 — <날짜> / <deploy SHA>

체크리스트의 **A–F 구획**을 이 파일로 복사해 실행 결과를 채웁니다. 주소와
user id는 적지 않고 계정을 역할 이름(E1, G, M, E2…)으로만 부릅니다.

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging |
| 배포 SHA (전체 40자리) | |
| SHA를 읽은 방법 | `GET /api/build-info` |
| SHA를 읽은 시각 (UTC) | |
| template revision | 2026-09-30a |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| 접속 국가 (IP 추정) | |
| 브라우저 | |

## 이 회차가 가정한 배포 상태

| flag | 값 | 어디서 읽었는가 |
|---|---|---|
| `feature.emailSignupConsentEnabled` | | |
| `feature.emailConsentConfirmationEnabled` | | |

## 사전 조건

| 항목 | 확인 | 값·비고 |
|---|---|---|
| staging 서빙 SHA 확보 | | |
| SHA가 `37c2cce2` 이후 | | |
| 두 flag가 `true` | | |
| 접속 국가가 marketing 허용 국가 | | |
| 새 주소·새 OAuth 계정 | | |

## A. 가입 화면의 세 선택 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| A-1 거부(E1): `notice_shown`+`objected`, `relationship_started` 없음 | | |
| A-2 동의(G): 확인 메일 → `granted` + 결과 알림 | | |
| A-3 무선택(M): `notice_shown`만, `objected`·`relationship_started` 없음 | | |

## B. 기존 계정은 아무것도 소비하지 않는다 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| B-1 G 재로그인: 새 사건·동의·메일 없음 | | |

## C. 제품 내 안내의 거부 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| C-1 E2에 안내가 뜨고 `notice_shown` | | |
| C-2 "받지 않겠습니다" → `objected` | | |
| C-3 새로고침·재로그인 뒤 다시 뜨지 않음 | | |

## D. 제품 내 안내의 나머지 선택 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| D-1 "나중에"(E3): 아무 행도 더해지지 않음 | | |
| D-2 "네"(E4): 확인 메일 3통, 클릭 전 `granted` 없음 | | |

## E. 처리 결과 알림과 수신 설정 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| E-1 `consent_result_notice` 도착과 내용 | | |
| E-2 모두 끔 → `withdrawn` + `unsubscribe_result_notice` | | |

## F. 화면과 문구 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| F-1 320px에서 잘림·겹침 없음, 44px | | |
| F-2 ko·en 문구가 승인 문안과 같음 | | |

## 발견

| # | 구획 | 무엇을 보았는가 | 차단인가 |
|---|---|---|---|

## 판정

**사람이 씁니다. 에이전트는 비워 둡니다.**

- 결과: 통과 / 조건부 / 실패
- 건너뛴 구획과 그 이유:
- 서명:
- 날짜 (UTC):
