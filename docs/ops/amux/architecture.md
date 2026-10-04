# AMUX Architecture

## Repository authority

AMUX 제품 통합과 독립 실행 서버의 source of truth는 `mposition/Tomverse`다.
2026-10-02 운영자 `mposition`이 WSL `tomverse/cursor-provider`의 서버 소스를
`vendor/amux/`에 편입하는 소스 소유 변경을 승인했다(`approvedBy: mposition`,
`approvedAt: 2026-10-02`). 원본 Git history는 병합하지 않고, 서버와 빌드에
필요한 형제 crate 및 루트 자산의 추적된 파일만 복사한다. 검증된 과거 frozen
reference는 `reference-baseline.md`의 provenance 기준선으로 계속 보존한다.
이 결정만으로 실행 바이너리 교체, Cursor의 제품 verified-provider 등록,
worker catalog 변경 또는 제품 bridge/claim 활성화를 승인하지 않는다.

## Source layout

| 경계 | 위치 | 책임 |
|---|---|---|
| pure core | `crates/amux-core` | scheduler, router, state machine, contracts; Tomverse DB와 network I/O 없음 |
| standalone AMUX server | `vendor/amux/crates/amux-server` | Ubuntu AMUX HTTP API, 세션·보드·로컬 SQLite runtime |
| standalone server dependencies | `vendor/amux/crates/amux-core`, `vendor/amux/crates/amux-dashboard`, `vendor/amux/crates/amux-cli`, `vendor/amux/scripts` | 원본 4개 멤버를 유지한 독립 Cargo workspace의 형제 crate·빌드 자산. 제품 `crates/amux-core`와 혼합하지 않음 |
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
- 개발용 WSL runner는 버전 13의 예외이고, 버전 14가 코드 래치를 켰다. 환경 변수가 정확히 `1`이 아니면 runner는 열리지 않는다. 그 runner가 Tomverse에서 작업을 가져오고, 서버는 워크스테이션으로 접속하지 않는다. 계약은 `wsl-execution-bridge.md`다.
- Worker는 Tomverse DB를 직접 수정하지 않고 internal API를 사용한다.
- External/high-risk action은 approval과 audit 경계를 우회하지 않는다.

## Reference relationship

Frozen reference는 과거 구현의 provenance와 semantics를 비교하는 기준선이다.
`vendor/amux`는 별도 `Cargo.toml`과 `Cargo.lock`을 가진 독립 workspace이며,
Tomverse 루트 Cargo workspace의 멤버가 아니다. 제품 통합의 `crates/amux-core`와
vendored 서버의 `vendor/amux/crates/amux-core`는 서로 다른 소스다.
WSL 원본 브랜치 `8ad716bf983274a9f86733be17b5f608bdcca67b`의 Cursor 변경
3개(`0cb02264`, `c7947c20`, `8ad716bf`)를 현재 Ubuntu 서비스 기준
`9e4be636f6656c4c49391ac1fc089d2bbd6eb34f` 위로 이식했다.
초기 import의 기준은 검증한 port commit `1765cbf98f0201501388dfb2cdcb266db1d76fb8`다.
현재 vendored 소스에는 이후 Tomverse에서 적용한 보안 수정이 포함된다.
현재 Ubuntu 서비스의 실행 빌드와 vendored 소스는 별도로 대조·검증해야 하며,
PR 병합만으로 실행 바이너리가 교체되지 않는다. 제품의 verified-provider
allowlist는 기존 정책의 별도 승인 절차를 따른다.
