---
record: staging-verification
checklist: docs/ops/external-import-staging-checklist.md
templateRevision: 2026-08-15
environment:
deploySha:
appliedMigrations:
migrationsCompletedAtUtc:
startedAtUtc:
completedAtUtc:
executor:
approver:
result:
frozen: false
digest:
---

# Staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| **적용된 migration 식별자** | |
| **migration 완료 (UTC)** | |
| **migration이 앱 배포보다 먼저 적용됨** | 예 / 아니오 |
| template revision | 2026-08-15 |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| flag 상태 (시작 시점) | |

**세 칸이 함께 있어야 의미가 있습니다.** 식별자만으로는 무엇이 적용됐는지는
알아도 언제인지 모르고, 시각만으로는 앱 배포와의 선후를 말하지 못합니다.
순서가 계약인 이유는 A2에서 드러났습니다 — provider CHECK 확장 같은 migration은
넓히는 방향이라 기존 코드와 역호환이지만, **앱이 먼저 배포되면 migration이
적용되기 전의 요청이 제약에서 실패합니다.** 그 실패는 배포 직후 몇 분에만
나타나고 로그에서 원인을 되짚기 어렵습니다.

"아니오"가 실패를 뜻하지는 않습니다. 그 순서로 배포됐다면 그 창에서 무엇이
일어났는지 확인한 사실을 발견 사항에 적습니다.

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

## 판정

| 항목 | 값 |
|---|---|
| 결과 (통과 / 조건부 / 실패) | |
| 조건부일 때의 조건 | |
| 발견 사항 | |
| 후속 티켓 | |

## 서명

| 항목 | 값 |
|---|---|
| 실행자 서명 | |
| 실행 완료일 (ISO 8601) | |
| 승인자 서명 | |
| 승인일 (ISO 8601) | |
