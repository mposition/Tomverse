---
record: staging-verification
checklist: docs/ops/assistant-knowledge-staging-checklist.md
templateRevision: 2026-08-23a
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

# Assistant knowledge staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| production SHA와 동일한가 | |
| 다르다면 knowledge 표면 diff 결과 | |
| template revision | 2026-08-22d |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| `assistantProfilesEnabled` (시작 시점) | |
| `assistantKnowledgeEnabled` (시작 시점) | |
| `memoryInjectionEnabled` (시작 시점) | |
| staging R2 bucket이 production과 분리됨 | |

## 실행 전 파일 배치

**실행 전에** 어느 계정의 어느 profile에 어떤 파일을 두었는지 적습니다. 파일
내용은 적지 않고 이름과 크기만 적습니다 — 판별 대상은 경계이지 내용이
아닙니다.

§C만 한다면 한 줄이면 됩니다. §D-1을 한다면 계정이 둘 필요합니다.

| 계정 | profile | 파일 (이름 · byte) | `processingStatus` |
|---|---|---|---|
| 1 | | | |

## 항목별 결과

체크리스트의 A–D 구획을 그대로 옮기고, 각 항목에 다음 중 하나를 적습니다.

- `pass` — 확인함. 증거 참조를 함께 적습니다.
- `fail` — 확인했고 실패했습니다. 후속 티켓을 적습니다.
- `n/a` — 이 실행에서 해당하지 않습니다. 이유를 적습니다.
- `미기록` — 실행하지 않았거나 기록이 없습니다. **나중에 채우지 않습니다.**

| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |
|---|---|---|---|---|
| A | | | | |

증거는 스크린샷 경로, 로그 발췌 위치, admin 응답 캡처처럼 **다시 확인할 수
있는 것**을 적습니다. **파일 원문과 chunk 내용은 증거로 저장소에 넣지
않습니다** — "계정 2의 파일명이 답에 나타나지 않음"처럼 관측만 적고, 원본이
필요한 자료는 제한된 운영 저장소에 두고 참조만 남깁니다.

## 사용한 크레딧

업로드·추출·삭제·sweep은 0크레딧입니다. 유료는 §C-2 한 턴이고, §D-1을 하면 한 턴 더입니다.

| 구획 | 모델 | turn 수 | 크레딧 |
|---|---|---|---|
| C-2 | | | |
| D-1 (선택) | | | |
| 합계 | | | |

## 판정

| 항목 | 값 |
|---|---|
| 결과 (통과 / 조건부 / 실패) | |
| 조건부일 때의 조건 | |
| 건너뛴 구획과 그 이유 | |
| 발견 사항 | |
| 후속 티켓 | |

## 정리 의무

staging 계정에 이 회차가 만든 파일·profile·대화가 남고, **R2 object도
남습니다.** 지운 뒤 시각을 적습니다. tombstone이 sweep까지 끝났는지 확인하고
적습니다 — 여기서만은 "지워졌어야 할 것이 남았는가"를 봅니다.

| 항목 | 값 |
|---|---|
| staging 파일·profile·대화 삭제 (UTC) | |
| cleanup queue 소진 확인 (UTC) / 잔여 tombstone 수 | |
| 로컬 파일 정리 (UTC) / 확인자 | |

## 서명

| 항목 | 값 |
|---|---|
| 실행자 서명 | |
| 실행 완료일 (ISO 8601) | |
| 승인자 서명 | |
| 승인일 (ISO 8601) | |
