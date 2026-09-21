# AMUX staging 검증 체크리스트

AMUX orchestration을 production에서 활성화하기 전에 staging에서 실행하는
canonical checklist다.

이 문서는 template이며 실행 결과를 직접 기록하지 않는다.

- **template revision**: `2026-09-21`
- 실행 기록:
  `docs/ops/amux/staging-verification-records/`
- 기록 template:
  `docs/ops/amux/staging-verification-records/_record-template.md`

실제 실행 1회는 staging이 실제로 서빙하는 전체 40자리 deploy SHA 하나와
대응한다.

## 사전 조건

- staging이 실제로 서빙하는 전체 40자리 deploy SHA를 확보한다.
- deploy SHA는 현재 로컬 `HEAD`를 추측해서 쓰지 않는다.
- 배포 artifact의 source identity를 다시 확인할 수 있어야 한다.
- staging verification 시작 시 AMUX activation은 off다.
- 검증 과정에서 production DB를 직접 수정하지 않는다.
- secret/token 값은 기록에 복사하지 않는다.

## A. Source identity와 feature-off

- [ ] staging이 보고하는 deploy SHA가 기록의 40자리 `deploySha`와 정확히 같다.
- [ ] `TOMVERSE_AMUX_ENABLED`가 unset 또는 `1` 이외 값인 상태를 관측한다.
- [ ] `TOMVERSE_AMUX_EXECUTE`가 unset 또는 `1` 이외 값이다.
- [ ] `TOMVERSE_AMUX_EXECUTION_API_ENABLED`가 unset 또는 `1` 이외 값이다.
- [ ] worker catalog와 executor command 설정이 activation 없이 주입되지 않았다.
- [ ] server routing 응답의 lifecycle gate가 `execution_ready=false`다.

## B. 완전 비활성 상태

AMUX orchestrator가 완전히 꺼진 상태를 먼저 검증한다.

- [ ] `TOMVERSE_AMUX_ENABLED`가 off일 때 orchestrator는 성공적으로 종료하며
      internal URL 또는 AMUX sync secret을 요구하지 않는다.
- [ ] off 상태에서 worker runtime registration이 발생하지 않는다.
- [ ] off 상태에서 task claim이 발생하지 않는다.
- [ ] off 상태에서 execution attempt가 새로 시작되지 않는다.
- [ ] off 상태에서 durable delivery가 새로 생성되지 않는다.

## C. Selection-only 상태

이 구획은 scheduler만 관측하기 위한 staging 단계다.

`TOMVERSE_AMUX_ENABLED=1`, `TOMVERSE_AMUX_EXECUTE` off 상태를 사용한다.

- [ ] scheduler가 queue를 읽고 global-priority selection을 계산할 수 있다.
- [ ] selection log가 선택과 실행을 분리해 표시한다.
- [ ] selection-only 동안 task owner/revision이 selection 자체 때문에 변하지 않는다.
- [ ] execution attempt가 생성되지 않는다.
- [ ] durable delivery가 생성되지 않는다.
- [ ] executor configuration이 없어도 selection-only service가 실행된다.

## D. Fencing과 durable execution contract

이 구획은 execution activation 전 staging evidence를 확인하는 항목이다.
실행을 허용하지 않은 deployment에서는 `n/a`로 기록하고 이유를 적는다.

- [ ] worker runtime identity가 instance id + generation으로 fenced된다.
- [ ] stale/replacement generation은 heartbeat/settlement 권한을 잃는다.
- [ ] execution start와 durable delivery가 하나의 atomic commit이다.
- [ ] live delivery receipt retry는 같은 receipt를 유지한다.
- [ ] receipt lease 만료 뒤 pull은 새 receipt를 발급한다.
- [ ] 만료되거나 교체된 receipt의 ACK는 거절된다.
- [ ] worker fence loss 뒤 executor가 취소되고 stale settlement가 전송되지 않는다.
- [ ] fenced/ambiguous worker는 같은 process에서 자동 재등록되지 않는다.

## E. Audit와 recovery

- [ ] claim decision에는 scheduler와 worker-router evidence가 함께 남는다.
- [ ] execution start/settle/recovery가 canonical admin audit chain에 연결된다.
- [ ] expired current execution recovery만 Todo로 반환되고 stale attempt는 변경하지
      못한다.
- [ ] expired owner reservation recovery가 기존 routing evidence를 삭제하지 않는다.
- [ ] audit integrity verification이 staging evidence 범위에서 정상이다.

## F. Advanced planning guard와 자동 증거

자동 캡처는 1회, 유료 model turn은 0회다. 실제 worker 실행을 별도로 검증하면 그
turn의 비용·판별 목적을 실행 기록에 먼저 적는다. 캡처 자체는 DB를 변경하지 않는다.

- [ ] incident freeze 중 새 claim/start는 거절되고, freeze 전에 만들어진 durable
      delivery와 heartbeat/settle/recovery는 계속 동작한다.
- [ ] invalid 또는 ambiguous due는 `invalid`로 저장되며 dispatch되지 않는다.
- [ ] project/team WIP와 cost guard는 같은 resource lock 아래 admission을 거절한다.
- [ ] stale/unknown quota는 0으로 바뀌지 않고, fresh high-confidence exhaustion만
      worker hard gate가 된다.
- [ ] retry budget 소진, worker blocked, required review는 열린 human escalation을
      하나만 만든다.
- [ ] 현행 정책에 별도 Agent 승인 계약이 없으므로 escalation resolve 요청은
      `AMUX_AGENT_APPROVAL_UNAVAILABLE`로 거절된다. `blocked` task의 자동
      `todo` 복귀를 기대하지 않으며, 승인 계약이 생길 때까지 해당 작업은 수동
      판정 대기로 기록한다.
- [ ] task sync는 `doing`과 상태에 관계없이 이미 owner가 지정된 작업의
      project/team identity를 바꾸지 않아 WIP slot을 우회하지 않는다.
- [ ] Admin Routing 화면과 capture 어디에도 delivery prompt가 노출되지 않는다.
- [ ] 캡처 프로세스의 deploy SHA 대조값이 true이고 기대한 전체 40자리 SHA와 같다.
- [ ] 자동 캡처의 `human_judgement.result`와 `signature`가 null이다.
- [ ] 관측 artifact digest와 stable state digest를 실행 기록에 옮겨 적고 파일을
      immutable artifact로 보관한다.

## G. Rollback

- [ ] `TOMVERSE_AMUX_EXECUTE`를 off로 되돌리면 새 execution이 시작되지 않는다.
- [ ] `TOMVERSE_AMUX_EXECUTION_API_ENABLED`를 off로 되돌리면 execution mutation
      endpoint가 fail-closed다.
- [ ] 필요 시 `TOMVERSE_AMUX_ENABLED`를 off로 내려 orchestrator 전체를 중단할 수
      있다.
- [ ] rollback은 기존 execution/delivery row를 수동 DB UPDATE/DELETE하지 않는다.
- [ ] recovery는 canonical AMUX API/lease recovery 경로만 사용한다.
- [ ] production activation은 이 staging run의 별도 사람 판정과 승인 전에는
      수행하지 않는다.

## 실행 기록

결과는 이 파일에 적지 않는다.

`docs/ops/amux/staging-verification-records/README.md`를 따른다.
