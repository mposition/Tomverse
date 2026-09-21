# Development Agent Orchestration

## Scope

Tomverse의 개발 Agent 팀은 `tomverse-orchestrator`를 통해 실행한다.

## Authority

Tomverse 애플리케이션이 작업 상태의 최종 authority다.

Agent worker는 production 데이터베이스를 직접 수정하지 않는다.
모든 작업 claim, 상태 전환, 승인, 감사 기록은
`/api/internal/amux/*` 경계를 통한다.

## Scheduling

Global Priority Scheduler는 opt-in 방식으로 운용한다.

Priority ordering은 최소 다음 원칙을 보존한다.

- explicit priority
- starvation prevention through task age
- deterministic tie breaking
- dependency-aware critical-path prioritisation
- human overrides where available

Worker-local pickup 정책과 global scheduling 정책은 별도로 유지한다.

## Concurrency

Task ownership 변경은 compare-and-set 형태여야 한다.

이미 다른 actor가 task ownership 또는 lifecycle state를 변경했다면
router는 해당 변경을 덮어쓰지 않는다.

## Execution boundary

Scheduler의 task 선택은 실행 시작과 분리한다.

선택 자체가 다음 동작을 자동으로 의미하지 않는다.

- task status transition
- lease creation
- attempt creation
- irreversible operation
- external delivery

## Approval

외부 시스템 변경, 배포, 이메일 발송 등 irreversible/high-risk action은
사람의 승인을 통과해야 한다.

Agent 승인은 2인 승인(`AdminActionApproval`)을 쓰지 않는다.
2인 승인은 "관리자 두 사람이 한 action에 동의한다"를 표현하며,
"사람 한 명이 시스템이 만든 초안을 승인한다"를 표현하지 못한다.
Agent 승인은 별도 계약이고, sole-approver 예외 목록은 건드리지 않는다.

그 별도 계약은 아직 없다.
계약이 승인되고 구현되기 전까지 AMUX의 어떤 경로도
승인을 받았다고 기록하지 않으며, 승인이 필요한 action을 수행하지 않는다.

## Audit

Scheduler, claim, refusal, approval 결과는 measured/verdict를 포함한
구조화된 audit event로 남긴다.
