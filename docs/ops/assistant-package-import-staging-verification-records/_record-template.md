---
record: staging-verification
checklist: docs/ops/assistant-package-import-staging-checklist.md
templateRevision: 2026-08-24g
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

# 외부 assistant package 가져오기 staging 검증 실행 — <날짜> / <deploy SHA>

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | staging / production / 기타 |
| 배포 SHA (전체 40자리) | |
| production SHA와 동일한가 | |
| 다르다면 가져오기 표면 diff 결과 | |
| template revision | 2026-08-24g |
| 시작 (UTC) | |
| 종료 (UTC) | |
| 실행자 | |
| `assistantPackageImportEnabled` (시작 시점) | |
| `assistantProfilesEnabled` / `assistantKnowledgeEnabled` | |
| `20260823090000_assistant_package_import` 적용됨 | |
| staging R2 bucket이 production과 분리됨 | |

## 시료

**실행 전에** `npm run make:assistant-package-staging-fixtures`를 돌리고 그
`MANIFEST.md`의 SHA-256을 여기에 옮깁니다. 같은 이름의 다른 바이트로 실행된
회차와 구분되지 않으면 나중에 "무엇을 판정한 것인가"에 답할 수 없습니다.

| package | SHA-256 | 정답지 관측이 기대와 일치했는가 |
|---|---|---|
| `P1-skill-with-script.zip` | | |
| `P2-planted-credentials.zip` | | |
| `P3-lying-size.zip` | | |
| `P4-symlink.zip` | | |
| `P5-too-many-entries.zip` | | |
| `P6-no-licence.zip` | | |

마지막 칸이 하나라도 "아니오"이면 **검증을 시작하기 전에 보고합니다.** 정답지가
낡았거나 코드가 퇴행한 것이고, 그 상태로 실행한 회차는 무엇을 측정한 것인지 알
수 없습니다.

## 항목별 결과

체크리스트의 A–I 구획을 그대로 옮기고, 각 항목에 다음 중 하나를 적습니다.

- `pass` — 확인함. 증거 참조를 함께 적습니다.
- `fail` — 확인했고 실패했습니다. 후속 티켓을 적습니다.
- `n/a` — 이 실행에서 해당하지 않습니다. 이유를 적습니다.
- `미기록` — 실행하지 않았거나 기록이 없습니다. **나중에 채우지 않습니다.**

| 구획 | 항목 | 결과 | 증거 | 후속 티켓 |
|---|---|---|---|---|
| A | | | | |

증거는 오류 코드, 스크린샷 경로, 응답 상태처럼 **다시 확인할 수 있는 것**을
적습니다. **package 내용과 자격증명 문자열은 증거로 저장소에 넣지 않습니다** —
"`aws-access-key-id` 포함 4건 발견, 원문은 화면에 없었음", "로그에 해당 문자열
없음"처럼 관측만 적습니다(기록 README 6번).

## C 구획: 서버 로그를 직접 열었는가

§C-6은 화면이 아니라 **로그**를 보는 항목입니다. 무엇을 어디서 어떻게 봤는지
적지 않으면 이 항목은 실행되지 않은 것과 같습니다.

| 항목 | 값 |
|---|---|
| 어떤 로그를 열었는가 (서비스 · 시간 범위) | |
| 검색어 (규칙 id 기준, 원문 아님) | |
| 결과 | |

## E 구획: 취소가 무엇을 지웠는가

취소가 남의 파일을 지우면 되돌릴 수 없습니다. 실행 전 배치를 먼저 적습니다.

| 항목 | 값 |
|---|---|
| 대상 profile (merge) 의 기존 knowledge 파일 수 (실행 전) | |
| 이 import가 올린 파일 수 | |
| 취소 후 대상 profile의 파일 수 | |
| 취소 후 대상 profile의 current revision | |

가운데 두 값의 차이가 마지막 값과 맞지 않으면 §E-4는 `fail`입니다.

## 사용한 크레딧

**차단 항목(A–G)은 전부 0크레딧입니다.** 가져오기는 모델을 부르지 않습니다.

| 구획 | 모델 | turn 수 | 크레딧 |
|---|---|---|---|
| H-1 (선택) | | | |
| H-2 (선택) | | | |
| 합계 | | | |

## 판정

| 항목 | 값 |
|---|---|
| 결과 (통과 / 조건부 / 실패) | |
| 조건부일 때의 조건 | |
| 건너뛴 구획과 그 이유 | |
| 발견 사항 | |
| 후속 티켓 | |

**A · B · C · D · E · G-3 중 하나라도 `fail`이면 결과는 실패입니다.** 체크리스트의
"무엇이 flag를 막고, 무엇이 막지 않는가"가 그 이유를 적어 두었습니다. F·G-2·H·I는
`미기록`으로 두고 서명해도 되며, 그때는 건너뛴 이유를 위 칸에 적습니다.

**§G-1은 이 회차의 차단이 아니라 production 활성화의 차단입니다.** 여기서
`n/a`인 것은 면제가 아니라 판정 시점이 옮겨진 것이며, 그 조건은
`docs/policy/assistant-package-import.md` §12.2.1에 있습니다.

## 정리 의무

이 회차는 staging 계정에 profile·knowledge 행을 남기고, **R2 object도
남깁니다.** 취소한 import가 지웠어야 할 것이 실제로 사라졌는지도 여기에
적힙니다 — 그것이 §E-3·E-4의 사후 증거입니다.

| 항목 | 값 |
|---|---|
| 취소한 import의 파일이 사라진 것을 확인 (UTC) | |
| staging profile·knowledge 삭제 (UTC) | |
| 그다음 정각 sweep 이후 bytes 확인 (UTC) | |
| 로컬 `.tmp/` 시료 정리 (UTC) / 확인자 | |

## 서명

| 항목 | 값 |
|---|---|
| 실행자 서명 | |
| 실행 완료일 (ISO 8601) | |
| 승인자 서명 | |
| 승인일 (ISO 8601) | |
