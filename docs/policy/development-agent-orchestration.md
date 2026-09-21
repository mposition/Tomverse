# Development Agent Orchestration

## Scope

Tomverse의 개발 Agent 팀은 `tomverse-orchestrator`를 통해 실행한다.

이 문서는 **모든** 개발 Agent worker의 실행 제어를 정한다. 우선순위, 소유권,
선택과 실행의 분리, 실행 권한, 승인과 감사의 경계가 여기 있다.

**개별 Agent의 권한은 여기 적지 않는다.** 어떤 입력을 작업으로 인정하는지,
그 결과물이 공개 저장소와 쓰기 가능 자격증명에 어디까지 닿는지는 그 Agent의
정책 문서가 정한다. engineering Agent는 `docs/policy/engineering-agent.md`다.
한 Agent의 규칙을 여기 올리면 다른 팀의 worker가 그 규칙에 묶인다.

두 문서가 충돌하면 적용 범위가 좁은 쪽이 이긴다.

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
Tomverse approval policy를 통과해야 한다.

## Audit

Scheduler, claim, refusal, approval 결과는 measured/verdict를 포함한
구조화된 audit event로 남긴다.
