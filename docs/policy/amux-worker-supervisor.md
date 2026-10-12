# AMUX Worker 감독자 정책

상태: **초안 — 미승인.** 작성 2026-10-12. 승인 전에는 어떤 단계도 구현하지 않는다(공통 기반 원칙 1).

version: (미부여) · owner: Tomverse Pty Ltd · approvedBy: (미기록) · approvedAt: (미기록)

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안. 관측과 보고만 한다. worker에게 아무것도 보내지 않고, LLM을 부르지 않으며, 외부로 나가는 것이 없다. |

`version`, `approvedBy`, `approvedAt`은 운영자가 기록한다. Agent의 몫은 초안과 독립 검토 요청까지다.

## 0. 운영자 결정 (2026-10-12)

1. AMUX 실행실 worker가 원래 목적에서 벗어나는 것을 막는 감독자를 만든다.
2. **감독 범위에 대화형 세션을 포함한다.** 운영자가 든 두 사례(AMUX v22 활성화, Chat-01)는 PC의 대화형 세션에서 일어났다.
3. **단계 선언은 PR 본문 형식이다**(§3).
4. S0 회고 실측부터 시작한다. S0는 비공개 저장소에 기록됐고 이 문서는 그 결론을 따른다(§1).
5. 바로 할 수 있는 것으로 `AGENTS.md`의 "긴 목표는 단계에 묶어 둡니다" 절을 먼저 넣는다. 이 정책은 그 절을 전제로 한다.

## 1. 무엇을 막는가

이탈은 파일 범위가 아니라 **목표 수준**에서 일어났다.

- **곁길 연쇄.** v22 활성화는 마지막으로 관측 가능한 단계 진전 뒤 약 22시간 동안 변경 다섯 건이 병합됐는데, 어느 것도 활성화의 어느 단계 일인지 선언하지 않았다. 그중 둘은 운영자의 별도 요청이었다.
- **위치 상실.** Chat-01은 17일 동안 PR 62건이었고, 40건이 어느 단계의 일인지 적지 않았다. 단계 목록은 공유 기록 어디에도 없었다.

개별 작업은 모두 "범위 안"이었으므로 변경 파일을 카드 범위와 대조하는 검사로는 둘 다 잡히지 않는다. 감독자가 보는 단위는 **세션이 아니라 목표**다.

S0의 결론 두 가지가 이 정책의 전제다. 첫째, 목표 기록의 단계마다 **관측 가능한 완료 증거**가 있어야 한다. 둘째, 모든 작업이 **자기 단계를 선언**해야 한다. 둘이 없으면 어떤 신호도 모든 작업을 곁길로 센다.

## 2. 용어

- **목표:** 여러 사이클에 걸친 큰 일. 목표 문장과 단계 체크리스트를 갖는다.
- **단계:** 목표의 체크리스트 한 줄. 단계마다 완료 증거의 종류를 정한다(§4).
- **목표 ID:** 대문자 영숫자와 하이픈(`[A-Z][A-Z0-9]*(-[A-Z0-9]+)*`, 40자 이하). 현황판 ID가 있는 목표는 그 ID를 쓴다(예: `CHAT-01`).
- **단계 ID:** 영숫자와 `.`, `_`, `-`(1~32자). `-`와 `op`는 예약어라 단계 ID가 될 수 없다.
- **감독 대상:** 이 저장소에 PR을 여는 모든 세션. AMUX worker와 대화형 세션(Claude Code, Codex 등)을 구분하지 않는다.

## 3. 단계 선언 — PR 본문 한 줄

긴 목표에 속한 일의 PR 본문에 아래 형식의 줄을 **정확히 한 줄** 넣는다.

```
Goal-Step: <목표 ID>/<단계 ID>
Goal-Step: <목표 ID>/<단계 ID> completes
Goal-Step: <목표 ID>/-
Goal-Step: <목표 ID>/op
```

| 형식 | 뜻 |
|---|---|
| `<목표>/<단계>` | 그 단계를 진행하는 작업 |
| `<목표>/<단계> completes` | 이 PR이 병합되면 그 단계가 끝난다고 세션이 선언한다(§4) |
| `<목표>/-` | 그 목표의 세션이 하는, 어느 단계에도 속하지 않는 작업(곁길) |
| `<목표>/op` | 그 목표의 세션이 운영자의 별도 요청으로 하는 작업 |

- 키 `Goal-Step:`는 대소문자를 구분하고 줄 맨 앞에서 시작한다. 앞뒤 공백은 무시한다.
- 맞는 줄이 없으면 **미선언**이다. 둘 이상이거나 문법에 맞지 않으면 **무효**이며 미선언과 같이 센다.
- 긴 목표에 속하지 않는 PR은 적지 않는다. 미선언 비율은 저장소 전체 지표로만 보고한다(§5).
- `release/**`, `hotfix/**`, back-merge PR은 선언하지 않아도 된다. 선언하면 같은 규칙으로 읽는다.
- 선언은 세션의 자기 보고다. 감독자는 선언의 진실성을 판정하지 않는다. 대신 단계 완료는 증거로만 인정하고(§4), 선언과 증거가 어긋나는 모양을 신호로 본다(§5).

## 4. 목표 기록과 단계 완료

**목표 등록은 사람이 한다.**
- 세션은 `AGENTS.md` 규칙에 따라 체크리스트 초안을 완료 보고에 적는다.
- 운영자가 Admin에서 목표와 단계를 등록·확정한다(`ops:write`와 최근 step-up).
- 확정된 목표의 단계 목록을 바꾸는 것은 새 revision이다. 이전 revision과 그 완료 기록은 지우지 않는다.

**단계 완료 증거는 두 종류이고, 단계마다 하나를 정한다.**

| 종류 | 인정 조건 |
|---|---|
| `completing_pr_merged` | `<목표>/<단계> completes`를 선언한 PR이 그 단계에 정한 base(`develop` 또는 `main`)에 병합됐다. 감독자가 GitHub에서 직접 관측한다. |
| `operator_confirmed` | 운영자가 Admin에서 완료를 확인했다. 환경 값 켜기, 첫 실행 관측처럼 PR로 끝나지 않는 단계에 쓴다. 증거 링크를 붙일 수 있다. |

- 운영자는 자동 인정된 완료를 **거절**할 수 있다. 거절은 기록으로 남고, 그 단계는 다시 미완료가 된다.
- 순서는 강제하지 않는다. 단계는 체크리스트 순서와 무관하게 끝날 수 있다.

## 5. 판정 — 결정적 신호

각 회차는 확정된 열린 목표마다 아래 값을 계산한다. LLM은 쓰지 않는다. "기준 시각"은 마지막 단계 완료 시각이고, 아직 없으면 목표 확정 시각이다.

| 신호 | 조건 | 결과 |
|---|---|---|
| `side_work_chain` | 기준 시각 뒤 병합된 `<목표>/-` PR이 N건 이상 | `drifting` |
| `step_stall` | 기준 시각 뒤 그 목표를 선언한 PR 활동(생성·병합)이 있었고, 기준 시각에서 X시간이 지났는데 끝난 단계가 없음 | `attention` |
| `step_churn` | 기준 시각 뒤 아직 끝나지 않은 같은 단계를 선언한 병합 PR이 M건 이상 | `attention` |
| `operator_displacement` | 기준 시각 뒤 병합된 `<목표>/op` PR 수 | 상태를 바꾸지 않고 보고만 |

- 목표 상태는 `drifting` > `attention` > `on_track` 순으로 가장 높은 것이다.
- GitHub를 읽지 못했거나 그 목표를 선언한 PR이 한 번도 없으면 `insufficient_evidence`다. `on_track`으로 보고하지 않는다.
- **시작값은 N=3, M=6, X=6시간이다.** S0의 표본으로는 정할 수 없어 시작값일 뿐이다. 값은 코드의 상수이고, 바꾸는 것은 이 정책의 새 버전이다.
- 저장소 전체 지표로, 최근 7일 병합 PR 중 미선언·무효 비율을 함께 보고한다(release·hotfix·back-merge·Dependabot 제외).

## 6. 보고

- Admin의 AMUX 영역에 목표 목록을 둔다. 목표마다 다음을 보인다.
  - 목표 문장
  - 완료 단계/전체
  - 마지막 단계 완료 시각
  - 기준 시각 뒤의 단계별 PR 수, 곁길 PR 수, 운영자 요청 PR 수
  - 현재 상태와 켜진 신호
  - 마지막 선언 PR
- 형식은 `AGENTS.md` "긴 목표는 단계에 묶어 둡니다"의 위치 보고와 같다.
- 운영자는 판정을 **확인함**으로 표시할 수 있다. 확인은 판정을 바꾸지 않고 기록만 남긴다.
- v1에는 외부 알림이 없다. Admin 배지는 확인되지 않은 `drifting` 판정 수만 센다(일거리만 배지).

## 7. 하지 않는 것

- worker나 세션에 아무것도 보내지 않는다(다시 맞추기 메시지, 상태 질문, 일시정지 없음). 개입은 이 정책의 다음 버전에서 AMUX worker부터 다룬다.
- LLM을 부르지 않는다. 세션 대화 기록, 터미널 로그, PR 본문의 선언 줄 밖의 텍스트, diff 내용을 읽지도 저장하지도 않는다.
- worker 파일 수정, worker 질문에 답하기(Decision Maker의 일), 승인·병합, 자기 판정 기준이나 이 정책의 수정은 하지 않는다.
- 카드·attempt·lease 같은 AMUX 실행 상태를 바꾸지 않는다.

## 8. 실행 위치와 자격증명

공통 기반 6.2a절의 형태다. 판정은 LLM도 외부 텍스트 실행도 없는 결정적 계산이다. 그래서 본 앱 내부 route에 두고, Agent별 Railway 서비스는 그 route를 부르는 트리거다.

- **트리거:** Railway cron 서비스 `amux-worker-supervisor`가 30분마다(UTC) `POST /api/internal/amux/worker-supervisor/run`을 부른다.
  - 서비스가 가진 자격증명은 그 route의 bearer secret 하나다. 제품 DB 자격증명이 없다.
  - 서비스는 마감 시각에 자기 요청을 끊고 종료한다.
  - 선언은 `Tomverse Agents` project의 IaC에 둔다. apply는 운영자만 한다.
- **route가 하는 일:**
  1. 스위치를 읽는다(§10).
  2. GitHub에서 지난 회차 뒤 갱신된 PR을 읽는다.
  3. 선언 줄만 추출한다.
  4. 관측·완료·판정을 한 트랜잭션에서 시스템 감사와 함께 쓴다.

  GitHub 호출은 트랜잭션 밖에서 하고, 회차당 호출 수에 상한을 둔다.
- **GitHub 토큰:** 앱 환경의 별도 fine-grained 토큰. `mposition/Tomverse` 한 저장소에 Metadata read와 Pull requests read만 준다. 쓰기 권한은 없다.
- **시간 상한:** route는 문장 단위 DB timeout과 앱이 유도한 트랜잭션 상한을 둔다. **늦게 끝난 회차가 성공으로 기록되지 않는 것**은 DB 시계의 마감 검사로 강제한다(공통 기반 6.2a절).

## 9. 데이터

모든 표는 append-only이거나 버전 CAS로만 바뀌고, 쓰는 곳은 store 모듈 하나다.

| 표 | 내용 | 보존 |
|---|---|---|
| `AmuxSupervisorGoal` | 목표 ID, 제목(≤120자), 목표 문장(≤1,000자), 상태(열림·닫힘), revision | 닫힘 뒤 12개월 |
| `AmuxSupervisorGoalStep` | 목표 revision, 단계 ID, 제목(≤200자), 순서, 증거 종류, base | 목표와 같음 |
| `AmuxSupervisorStepCompletion` | 단계, 증거(PR 번호와 병합 SHA, 또는 운영자 확인), 거절 여부 | 목표와 같음 |
| `AmuxSupervisorPullRequest` | PR 번호, base, head 브랜치, 생성·병합 시각, 제목(≤200자), 파싱한 선언(목표·단계·종류 또는 미선언·무효) | 180일 |
| `AmuxSupervisorRun` | 회차 키(UTC 30분 슬롯), DB 시계 시작·종료, 결과(`succeeded`·`source_unreadable`·`late`·`refused`) | 12개월 |
| `AmuxSupervisorFinding` | 회차, 목표, 신호와 값, 기준값, 정책 버전, 확인 여부 | 12개월 |

- **자유 텍스트:** 목표 제목, 목표 문장, 단계 제목만 허용한다. 운영자가 쓰는 것이며 저장 전에 secret 검사를 한다. PR 제목은 공개된 텍스트를 길이만 잘라 둔다.
- **사람 정보:** PR 작성자, GitHub 계정, 본문은 저장하지 않는다. 사람의 id는 감사 행에만 있으므로 data-domain registry에 등록하지 않는다.
- 회차 키에 유일 제약을 둔다. 같은 슬롯의 두 번째 회차는 쓰지 않는다.

## 10. 스위치

- `AppSetting`의 `feature.amuxWorkerSupervisorEnabled`(기본 꺼짐)와 환경 kill switch `AMUX_WORKER_SUPERVISOR_KILL_SWITCH`를 둔다.
- 어느 하나라도 읽지 못하면 꺼짐이다. 꺼져 있으면 route는 아무것도 쓰지 않고 거절하며, Admin은 기록 열람만 남는다.
- 자동 정지 트리거는 하나다. `source_unreadable`이 연속 3회면 회차를 멈추고 운영자 해제를 기다린다. 사람이 끈 스위치를 자동화가 다시 켜지 않는다.

## 11. 감사

- **시스템 actor:** `amux-worker-supervisor`. 닫힌 시스템 actor 목록에 추가하며, 이 추가 자체가 검토 대상이다.
  - `amux.supervisor.run_recorded`: 회차마다 한 번. 건수만 담는다.
  - `amux.supervisor.step_completed`: `completing_pr_merged` 자동 인정.
  - `amux.supervisor.run_halted`: 자동 정지.
- **사람:**
  - `amux.supervisor.goal_registered`, `amux.supervisor.goal_revised`, `amux.supervisor.goal_closed`
  - `amux.supervisor.step_confirmed`, `amux.supervisor.step_completion_rejected`
  - `amux.supervisor.finding_acknowledged`, `amux.supervisor.halt_released`
  - `amux.supervisor.switch_changed`
- 모두 상태 변경과 같은 트랜잭션에서 기존 해시 체인 writer로 쓴다. 감사 표에 직접 쓰지 않는다.

## 12. 비용과 결과 불명

- LLM 호출과 유료 호출이 없으므로 Agent 비용 namespace를 쓰지 않는다. GitHub API는 회차당 상한 안에서 읽기만 한다.
- 외부로 나가는 쓰기가 없으므로, 결과를 모르는 회차는 다음 슬롯의 새 회차가 다시 관측한다. 이것은 재실행이 아니라 재관측이다. 관측은 PR 번호와 GitHub `updatedAt`으로 멱등이다.

## 13. 오케스트레이션 정책과의 관계

v1은 AMUX의 worker 목록, adapter, bridge, 카드 상태를 바꾸지 않으므로 오케스트레이션 정책의 새 버전이 필요 없다.

AMUX worker에게 다시 맞추기 메시지를 보내거나 일시정지하는 개입은 AMUX bridge의 새 행위다. 그래서 이 정책의 다음 버전과 오케스트레이션 정책의 새 버전을 함께 승인받는다.

## 14. 구현 단계

각 단계는 독립 검토 뒤 병합한다. v1에는 되돌릴 수 없는 행위가 없다(외부 전송, worker 쓰기, 삭제 없음). 그래서 단계별 차단 기준은 "판정이 틀려도 기록만 남고 무엇도 바뀌지 않는다"를 지키는 것이다.

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| S1a | 순수 core: 선언 파서, 신호 판정, 상수 | 문법·경계·미선언·무효, 신호 세 개의 임계 전후 테스트 |
| S1b | 표·migration·store·시스템 actor·스위치 | append-only trigger, 회차 키 유일, 스위치 fail-closed 테스트 |
| S1c | 내부 route와 Railway 서비스 IaC | 늦은 회차 미기록, GitHub 실패 시 `insufficient_evidence`, 재관측 멱등 테스트 |
| S1d | Admin 화면(목표 등록·단계 확인·판정·확인함) | Admin IA 계약(`docs/ui-contracts/admin-console-ia.md`), 재인증 CTA |
| 관측 기간 | 14일. 판정을 운영자의 실제 판단과 대조 | N, M, X의 개정 여부를 다음 버전에서 결정 |

- 운영자 단계: GitHub 읽기 토큰 발급, Railway 서비스 IaC apply, 스위치 켜기.
- S1a부터 `AGENTS.md`에 이 정책을 가리키는 절을 둔다.
