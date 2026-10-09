---
record: staging-verification
checklist: docs/ops/email-signup-consent-staging-checklist.md
templateRevision: 2026-10-02a
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
| template revision | 2026-10-02a |
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
| SHA가 `3e3a7d30` 이후 | | |
| 두 flag가 `true` | | |
| 접속 국가가 marketing 허용 국가 | | |
| 새 주소·새 OAuth 계정 | | |

## A. 가입 화면의 세 선택 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| A-1 거부(E1): `notice_shown`+`objected`, `relationship_started` 없음 | | |
| A-2 동의(G, 증명): 세 항목 즉시 `granted`, 확인 메일 없음, 결과 알림 1통 | | |
| A-3 동의(M, Microsoft 증명): 세 항목 즉시 `granted`, 확인 메일 없음, 결과 알림 1통 | | |

## B. 기존 계정은 아무것도 소비하지 않는다 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| B-1 가입 화면에서 G 재로그인: 안내 1회, 새 사건·동의·메일 없음 | | |
| B-2 로그인 화면에서 G: 장치 없음, 새 attempt 없음 | | |

## C. 로그인 화면의 "계정 없음"은 증명 뒤 가입 단계로 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| C-2 새 Google로 로그인 화면: 인증 뒤 가입 화면, `User`·`Account` 없음 | | |
| C-1 E2 코드: 가입 단계, 그 시점 `User` 없음, 같은 코드로 가입, 거부 기록 | | |
| C-3 E3 링크(새 탭): 가입 단계, 그 시점 `User` 없음, `notice_shown`만 | | |

## D. 제품 내 안내의 거부 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| D-1 flag 끈 동안 E4 가입, 켠 뒤 안내와 `notice_shown` | | flag를 쓴 두 시각을 적습니다 |
| D-2 "받지 않겠습니다" → `objected` | | |
| D-3 새로고침·재로그인 뒤 다시 뜨지 않음 | | |

## E. 제품 내 안내의 나머지·처리 결과 알림 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| E-1 "나중에"(E5): `notice_shown`만, 다시 뜨지 않음 | | |
| E-2 "네"(E6, 증명): 세 항목 즉시 `granted`, 확인 메일 없음, 결과 알림 1통 | | |
| E-3 `consent_result_notice` 도착과 내용 | | |
| E-4 모두 끔 → `withdrawn` + `unsubscribe_result_notice` | | |

## F. 화면과 문구 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| F-1 문구 버전 2026-09-30 (ko·en) | | |
| F-2 320px에서 잘림·겹침 없음, 44px | | |
| F-3 두 화면의 상호 링크, 약관 한 줄 | | |

## 발견

| # | 구획 | 무엇을 보았는가 | 차단인가 |
|---|---|---|---|

## 판정

**사람이 씁니다. 에이전트는 비워 둡니다.**

- 결과: 통과 / 조건부 / 실패
- 건너뛴 구획과 그 이유:
- 서명:
- 날짜 (UTC):
