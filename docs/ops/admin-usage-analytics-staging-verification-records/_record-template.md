---
record: staging-verification
checklist: docs/ops/admin-usage-analytics-staging-checklist.md
templateRevision: 2026-09-17a
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

# Admin 사용 현황 탭 staging 검증 실행 — <날짜> / <deploy SHA>

체크리스트의 **A–D 구획**을 이 파일로 복사해 실행 결과를 채웁니다.

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging |
| 배포 SHA (전체 40자리) | |
| SHA를 읽은 방법 | `GET /api/build-info` |
| SHA를 읽은 시각 (UTC) | |
| template revision | 2026-09-17a |
| 실행자 | |

## A. 권한 — 차단

| 항목 | 결과 | 관측 |
|---|---|---|
| B1 비관리자·비로그인 차단 | | 두 경우를 각각 적습니다 |

## B. 화면 동작 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| O1 첫 탭과 기본 기간 | | |
| O2 기간 전환 | | |
| O3 로딩 시간 | | |
| O4 제품 분석 탭 | | |

## C. 집계 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| O5 계정 집계 | | 보낸 모델 수와 전후 숫자를 적습니다 |
| O6 게스트 집계 | | |
| O7 히트맵 시간 | | |

## D. 표시 품질 — 비차단

| 항목 | 결과 | 관측 |
|---|---|---|
| O8 한국어 | | |
| O9 모바일 가로 넘침 | | |

## 발견

| # | 구획 | 무엇을 보았는가 | 차단인가 |
|---|---|---|---|

## 판정

**사람이 씁니다. 에이전트는 비워 둡니다.**

- 결과: 통과 / 조건부 / 실패
- 건너뛴 구획과 그 이유:
- 서명:
- 날짜 (UTC):
