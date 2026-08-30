---
record: staging-verification
checklist: docs/ops/app-managed-web-search-staging-checklist.md
templateRevision: 2026-08-27
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

# Google 웹 검색 staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| `deploymentId` | |
| 적용된 migration | |
| template revision | 2026-08-27 |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| 검색 backend | brave |
| `SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY` | |
| `SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_MONTH` | |

## 항목별 결과

체크리스트의 A–F 구획을 그대로 옮기고, 각 항목에 다음 중 하나를 적습니다.

- `pass` — 확인함. 증거 참조를 함께 적습니다.
- `fail` — 확인했고 실패했습니다. 후속 티켓을 적습니다.
- `n/a` — 이 실행에서 해당하지 않습니다. 이유를 적습니다.
- `미기록` — 실행하지 않았거나 기록이 없습니다. **나중에 채우지 않습니다.**

| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |
|---|---|---|---|---|
| A | | | | |

증거는 응답 헤더 발췌, Admin Console 캡처, trace ID처럼 **다시 확인할 수
있는 것**을 적습니다. 검색 결과 본문과 API key는 적지 않습니다(README 7·8).

## 유료 turn 4회

| turn | 모델 | trace ID | `backendRequestCount` | `queryCount` | citation 수 | badge | 크레딧 |
|---|---|---|---|---|---|---|---|
| D-1 | Gemini 3.7 Flash | | | | | | |
| D-2 | Gemini 3.6 Flash | | | | | | |
| D-3 | Gemini 3.1 Pro | | | | | | |
| D-4 | Gemini 3.5 Flash-Lite | | | | | | |

`backendRequestCount`는 시도, `queryCount`는 성공입니다. 두 값이 다른 turn은
backend가 일부 요청을 거절했다는 뜻이고, 그것 자체는 실패가 아닙니다.

## 예산과 정산 대조

| 항목 | 값 |
|---|---|
| `search-provider:brave` / `search-cost-day` 시작 값 (µUSD) | |
| 같은 행의 종료 값 (µUSD) | |
| 증가분 (µUSD) | |
| 성공한 backend 요청 합계 | |
| 기대값 (성공 × 5,000 µUSD) | |
| 일치 여부 | |
| `provider:google` 증가분에 검색 비용이 섞이지 않았는지 | |

## 사용한 크레딧

| turn | 모델 기본 | 검색 surcharge | 환불 | 최종 차감 |
|---|---|---|---|---|
| D-1 | | | | |
| D-2 | | | | |
| D-3 | | | | |
| D-4 | | 8 | 8 | |
| 합계 | | | | |

## 판정

| 항목 | 값 |
|---|---|
| 결과 (통과 / 조건부 / 실패) | |
| 조건부일 때의 조건 | |
| 건너뛴 구획과 이유 | |
| 발견 사항 | |
| 후속 티켓 | |

## 정리 의무

| 항목 | 값 |
|---|---|
| staging 대화·생성 파일 삭제 (UTC) | |
| `/api/ready` 실패 재현용으로 뺐던 환경변수 복구 확인 (UTC) | |

## 서명

| 항목 | 값 |
|---|---|
| 실행자 서명 | |
| 실행 완료일 (ISO 8601) | |
| 승인자 서명 | |
| 승인일 (ISO 8601) | |
