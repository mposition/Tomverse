# AMUX Architecture

## Repository authority

AMUX의 현재·미래 개발 source of truth는 `mposition/Tomverse`다. 검증된
upstream reference는 `reference-baseline.md`가 고정한 identity와 로컬 frozen
worktree로만 보존한다. Upstream 전체 Git history나 source snapshot을 Tomverse에
다시 복제하지 않는다.

## Source layout

| 경계 | 위치 | 책임 |
|---|---|---|
| pure core | `crates/amux-core` | scheduler, router, state machine, contracts; Tomverse DB와 network I/O 없음 |
| runtime | `apps/tomverse-orchestrator` | board driving, worker protocol, execution, Tomverse API client |
| product integration | `lib/amux` | DB, approval, audit, policy, delivery, execution lifecycle |
| worker API | `app/api/internal/amux` | authenticated worker-facing register, claim, heartbeat, delivery, settle 경계 |
| policy | `docs/policy/development-agent-orchestration.md` | authority, scheduling, approval, audit 원칙 |
| operations | `docs/ops/amux` | reference, staging, recovery, verification evidence |

초기 목표안은 pure core를 `packages/amux-core`로 표기했지만 Tomverse의
`packages/*`는 npm workspace이자 browser-compatible shared package 경계다.
Rust-only crate를 그 namespace에 두면 npm manifest와 Vite export contract를
가짜로 추가하거나 PACKAGE-01을 약화해야 한다. 그래서 역할은 그대로 두고 Rust
workspace의 canonical namespace인 `crates/amux-core`를 사용한다.

## Authority and data flow

```text
Tomverse DB / approval / audit
            ^
            | internal API
            v
tomverse-orchestrator ---> worker protocol ---> configured providers
            |
            v
       amux-core decisions
```

- Tomverse가 task state와 approval의 최종 authority다.
- Core는 결정 규칙을 제공하지만 DB를 직접 변경하지 않는다.
- Orchestrator는 selection과 execution을 분리한다.
- Worker는 Tomverse DB를 직접 수정하지 않고 internal API를 사용한다.
- External/high-risk action은 approval과 audit 경계를 우회하지 않는다.

## Reference relationship

Frozen reference는 구현의 upstream provenance와 검증된 semantics를 비교하는
기준선이다. Tomverse 구현은 reference의 코드를 실행 경로로 import하거나 그
worktree를 build input으로 사용하지 않는다. Reference 이후의 변경, schema,
approval, audit, provider adapter는 모두 Tomverse history에서 진화한다.
