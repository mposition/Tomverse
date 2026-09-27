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
- Agent 작업 검토는 별도 `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED` flag가 off다.
  flag를 켜는 회차에만 전용 GitHub read-only token, AMUX sync secret,
  `NEXTAUTH_URL`을 먼저 주입한다. 비밀값은 기록에 남기지 않는다.
- 공개 origin이 identity-aware proxy 뒤에 있으면 같은 process의 loopback
  origin을 `TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN`에 설정한다. readiness는 명시적
  port가 Railway의 `PORT`와 같고 hostname이 `127.0.0.1` 또는 같은 app service의
  `RAILWAY_PRIVATE_DOMAIN`과 정확히 같지 않으면 fail-closed다.
- 검증 과정에서 production DB를 직접 수정하지 않는다.
- secret/token 값은 기록에 복사하지 않는다.
- execution(Stage 2)으로 갈 회차라면 `docs/ops/amux/executor-protocol.md`의
  **lane 자격증명 표**가 채워져 있다. 표 없이 lane을 켜지 않는다 — 표가 없으면
  어느 lane이 무엇을 들고 도는지 확인할 방법이 없다.

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
- [ ] 별도 Agent 승인 flag가 off이면 escalation resolve 요청은
      `AMUX_AGENT_APPROVAL_UNAVAILABLE`로 거절된다. flag on 검증은 아래 G 구획을
      별도 회차에서 수행하며, 이 구획만으로 승인 경로를 활성화하지 않는다.
- [ ] task sync는 `doing`과 상태에 관계없이 이미 owner가 지정된 작업의
      project/team identity를 바꾸지 않아 WIP slot을 우회하지 않는다.
- [ ] Admin Routing 화면과 capture 어디에도 delivery prompt가 노출되지 않는다.
- [ ] 캡처 프로세스의 deploy SHA 대조값이 true이고 기대한 전체 40자리 SHA와 같다.
- [ ] 자동 캡처의 `human_judgement.result`와 `signature`가 null이다.
- [ ] 관측 artifact digest와 stable state digest를 실행 기록에 옮겨 적고 파일을
      immutable artifact로 보관한다.

## G. Agent 작업 검토 승인 (별도 flag-on 회차)

이 구획은 승인 계약·migration·CI DB 검증이 끝난 staging deploy에서만 수행한다.
검토·차단·재큐 자체는 유료 model turn 0회다. 실제 다음 claim/worker 실행은
별도 비용과 목적을 기록하고 사람이 승인한다. PR 병합·배포 승인은 이 구획에 없다.

- [ ] `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED=true`일 때만 보호 검토를 열 수 있고,
      `ops:write`·최근 재인증 없는 호출은 거절된다.
- [ ] `AMUX_REVIEW_GITHUB_READ_TOKEN`은 `mposition/Tomverse`의 Pull requests와
      Contents 읽기 전용이며, 값 자체는 화면·로그·기록에 나오지 않는다.
- [ ] flag on에서 token·sync secret·`NEXTAUTH_URL` 중 하나가 빠지면 `/api/ready`의
      `amuxReviewApproval`이 false이고, 모두 준비된 뒤에만 true다.
- [ ] private review origin을 쓰는 경우 현재 app service의
      loopback 또는 `RAILWAY_PRIVATE_DOMAIN` 및 실제 `PORT`와 정확히 결속되고,
      다른 port·internal/public host는 readiness와 proxy 양쪽에서 거절된다.
- [ ] 결정 mutation 전에 protected review detail을 한 번 열어 private origin의
      실제 도달성을 확인한다. readiness는 형식 결속만 증명하며 네트워크 도달성을
      대신하지 않는다.
- [ ] settle된 `review` 작업은 owner/claim이 해제되고, 이후 snapshot sync로
      `review_pr_number`를 부여해도 해당 terminal attempt가 승인 대상이다.
- [ ] `approve` 화면은 PR base SHA·head SHA·전체 diff와 그 SHA-256을 보이며,
      base/head/diff가 바뀐 이전 제안은 거절된다.
- [ ] timeout·전송 실패 시 화면은 결과 미확인으로 잠기고, 발급된 결정 ID와
      대상 digest로 조회해 commit 확인 전에는 다시 제출하지 않는다.
- [ ] 이미 blocked인 task의 `block`은 불변 결정을 남기고 후속 escalation을 연다.
      5회 소진은 기존 task를 재큐하지 않고 새 task 발행 계약을 따른다.
- [ ] `retry`는 교정된 canonical due, 이전 attempt/delivery fence, 5회 상한,
      현재 project/team 비용 상한을 확인한다. 다음 claim도 admission을 다시 한다.
- [ ] 설명이 표시 한도를 넘으면 잘림을 보이고 `approve`·`retry`를 숨긴다.
- [ ] 원문 조회·결정·거절의 Admin 감사 해시 체인을 확인하고, 원문·token이
      원장·일반 GET·증거 파일에 저장되지 않았음을 확인한다.

## H. Rollback

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
