---
record: staging-verification
checklist: docs/ops/mobile-auth-key-rotation-checklist.md
templateRevision: 2026-09-03a
checklistSourceSha:
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

# 모바일 인증 키 회전 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | production / staging / 로컬(검사만) |
| 배포 SHA (전체 40자리) | |
| **checklist source SHA** | |
| template revision | 2026-09-03a |
| 기계 | 로컬 PC / 기타 |
| 셸과 판본 | 예: Windows PowerShell 5.1.19041.6456 |
| 저장소 위치 | 예: clone 경로(사용자명 없이) |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| 회전 여부 | 회전 수행 / 검사만 |
| `rotationId` | 회전 회차만 |
| Railway deployment ID | 회전 회차만 |

## 실행한 명령

**인수까지 적되 비밀값은 적지 않습니다.** 링·pepper·token·`secretDigest`와
`MOBILE_AUTH_*`의 원문 값은 어느 칸에도 넣지 않습니다. 프롬프트로 받은 값은 애초에
명령에 없습니다.

| # | 명령 (비밀값 제외) | 종료 코드 | 비고 |
|---|---|---|---|
| 1 | | | |

## 관측

**본 것만 적습니다.** 판정은 아래 "판정" 칸이고, 그 둘을 같은 줄에 쓰지 않습니다.

### 링 상태 (§2.1 출력)

| ring | key id | 상태 | 남은 초 |
|---|---|---|---|
| signing | | | |
| pepper | | | |

### 배포 후 검증 (§3의 6번)

| 사례 | 결과 |
|---|---|
| `signing kid` | |
| `signing key material` | |
| `pepper kid` | |
| `pepper material` | |
| `iss` · `aud` | |
| `evidence is fresh` | |
| 은퇴 선언(미래 시각) | |
| 종료 코드 / 모드 | |

### 이전 세대 (§3의 7번)

| 시료 | 유효한가 | 결과 | 감사 `event` · `reason` |
|---|---|---|---|
| access token | | | |
| refresh token | | | |

## 항목별 결과

체크리스트의 A–D 구획을 그대로 옮기고, 각 항목에 다음 중 하나를 적습니다.

- `pass` — 확인함. 증거 참조를 함께 적습니다.
- `fail` — 확인했고 실패했습니다. 후속 티켓을 적습니다.
- `n/a` — 이 실행에서 해당하지 않습니다. 이유를 적습니다.
- `미기록` — 실행하지 않았거나 기록이 없습니다. **나중에 채우지 않습니다.**

| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |
|---|---|---|---|---|
| A | | | | |

증거는 검사기 출력의 발췌, 감사 행의 `event`·`reason`, deployment ID처럼 **다시 확인할
수 있는 것**을 적습니다. 발췌에 비밀값이 없는지 붙이기 전에 봅니다 — 두 wrapper는
길이만 출력하므로 그대로 붙여도 안전합니다.

## 판정

| 항목 | 값 |
|---|---|
| 결과 (통과 / 조건부 / 실패 / 미판정) | |
| 미판정이라면 무엇이 판정되지 않았는가 | |
| 조건부일 때의 조건 | |
| 발견 사항 | |
| 후속 티켓 | |

**승격했는가는 판정입니다.** §3의 8번에서 미판정으로 끝난 회차는 `미판정`이고, 그것을
`통과`로 적지 않습니다.

## 정리 의무

| 항목 | 값 |
|---|---|
| 증거 수집용 exchange 세션 폐기 (UTC) | |
| 로컬 파일·환경변수 정리 (UTC) / 확인자 | |

## 서명

| 항목 | 값 |
|---|---|
| 실행자 서명 | |
| 실행 완료일 (ISO 8601) | |
| 승인자 서명 | |
| 승인일 (ISO 8601) | |
