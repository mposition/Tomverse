---
record: staging-verification
checklist: docs/ops/assistant-profile-staging-checklist.md
templateRevision: 2026-08-20
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

# Assistant profile staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| production SHA와 동일한가 | |
| 다르다면 profile 표면 diff 결과 | |
| template revision | 2026-08-20 |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| `assistantProfilesEnabled` (시작 시점) | |
| `assistantKnowledgeEnabled` (시작 시점) | |
| `memoryInjectionEnabled` (시작 시점) | |

## §B 실행 전 대화 상태

되돌릴 수 없는 값이므로 **실행 전에** 적습니다. 나중에 채우면 비교 대상이
없어집니다. 대화 ID는 소유자 자신의 것이며 계정 식별자는 적지 않습니다.

| 대화 | `selectedModels` | `disabledPanels` |
|---|---|---|
| 1 | | |
| 2 | | |

## 항목별 결과

체크리스트의 A–H 구획을 그대로 옮기고, 각 항목에 다음 중 하나를 적습니다.

- `pass` — 확인함. 증거 참조를 함께 적습니다.
- `fail` — 확인했고 실패했습니다. 후속 티켓을 적습니다.
- `n/a` — 이 실행에서 해당하지 않습니다. 이유를 적습니다.
- `미기록` — 실행하지 않았거나 기록이 없습니다. **나중에 채우지 않습니다.**

| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |
|---|---|---|---|---|
| A | | | | |

증거는 스크린샷 경로, 로그 발췌 위치, admin 응답 캡처처럼 **다시 확인할 수
있는 것**을 적습니다. 개인 데이터가 있는 자료는 저장소가 아니라 제한된 운영
저장소에 두고 여기에는 참조만 남깁니다.

## 사용한 크레딧

| 구획 | 모델 | turn 수 | 크레딧 |
|---|---|---|---|
| B | | | |
| C | | | |
| D | | | |
| E | | | |
| 합계 | | | |

## 판정

| 항목 | 값 |
|---|---|
| 결과 (통과 / 조건부 / 실패) | |
| 조건부일 때의 조건 | |
| 발견 사항 | |
| 후속 티켓 | |

## 정리 의무

staging 계정에 이 회차가 만든 profile과 대화가 남습니다. 지운 뒤 시각을 적습니다.

| 항목 | 값 |
|---|---|
| staging 데이터 삭제 (UTC) | |
| 로컬 파일 정리 (UTC) / 확인자 | |

## 서명

| 항목 | 값 |
|---|---|
| 실행자 서명 | |
| 실행 완료일 (ISO 8601) | |
| 승인자 서명 | |
| 승인일 (ISO 8601) | |
