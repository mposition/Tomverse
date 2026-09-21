# AMUX Local Branch Migration Audit

검사일: 2026-09-21

이 문서는 기존 `/home/tommy/TomverseAMUX` local Git의 branch별 결과가
Tomverse 이식에서 어떻게 처리됐는지 기록한다. Branch history 자체를 Tomverse에
병합하지 않으며, 제품에 필요한 semantics와 구현만 Tomverse history에서
유지한다.

## Branch disposition

| Local branch | HEAD | 판정 |
|---|---|---|
| `feat/global-priority-scheduler-mainline-6ec38c78` | `83835d5209b110a9497d81246c07f284372ee61c` | 최종 frozen reference. Scheduler, intelligent routing, classifier, routing persistence/telemetry semantics를 Tomverse #1570에 productize함 |
| `feat/global-priority-scheduler-mainline` | `e643df010136c3f54b4341d678707b8727fd4238` | final forward-port 이전 predecessor. 별도 이식 없음 |
| `feat/global-priority-scheduler` | `d1b0170a3ba101f5a8e0b580bb77bbc05b895b16` | 이전 base의 predecessor. 별도 이식 없음 |
| `feat/intelligent-routing` | `37b99c593a339d4265210cde84d5880475e7e11e` | scheduler predecessor. Routing/classifier 범위는 final reference와 Tomverse 구현에 흡수됨 |
| `feat/devin-provider` | `54344b1d32a29c8a5ee52b1f2b5a30cdfc46b896` | Devin routing semantics는 Tomverse worker router에 반영. `devin-amux` binary/YOLO flag hard-code는 Tomverse의 operator-configured, shell-free executor 계약으로 대체함 |
| `agent/DW-1-devin-smoke-test` | `d75996fc091a2be7355e1cd3607d92e188128ed8` | 한 줄짜리 upstream smoke marker로 executable evidence가 아니므로 이식하지 않음 |
| `fix/amux-1-commit-nudge-registry` | `360c99034414888e9f0364ecf881e336630a57e2` | upstream AMUX system-job registry 전용 수정. Tomverse runtime에 해당 module이 없어 이식하지 않음 |
| `fix/amux-9-email-reachable-doc` | `71a3e8b6bee33fd247da95798864a249719f5acf` | upstream AMUX invariant 설명 전용 수정. Tomverse runtime에 해당 invariant가 없어 이식하지 않음 |

## Tomverse productized destinations

- pure scheduler/state/contracts: `crates/amux-core`
- runtime/worker protocol/orchestration: `apps/tomverse-orchestrator`
- DB/approval/audit/policy: `lib/amux`
- durable worker API: `app/api/internal/amux`
- Prisma schema and migrations: `prisma/schema.prisma`, `prisma/migrations/20260920*_amux_*`
- DB integration coverage: `tests/integration/amux-orchestration.db.test.ts`

Tomverse #1570의 merge commit은
`1c5266aacfd53fbd8fa3e16b58b54bbbd7d6b131`이다. Source 이식 이후 Railway
provider detection fix는 #1580,
`0e539a1d5b8ab48f046407e0d04d22c959d5f9a4`에서 반영됐다.

## Local cleanup boundary

Branch 삭제는 source migration 이후의 local housekeeping이다. 2026-09-21 기존
AMUX Git의 위 8개 local branch를 제거했고 `main`만 남겼다. 각 worktree는 파일을
삭제하지 않고 해당 HEAD의 detached checkout으로 전환했다. Frozen directory도
validated commit을 그대로 checkout하고 있으며 일반 개발 worktree로 재사용하지
않는다.

복구 자료:

- archive: `/home/tommy/TomverseAMUX-local-branches-before-tomverse-migration-20260921.bundle`
- SHA-256: `86cc29aa91c6948a5b109e0b2ea92d2306b5a4b362244c92399c7dafb32c7eb4`
- archive refs: `refs/tags/tomverse-migration/*`

Bundle은 `git bundle verify`를 통과했다. Archive tag는 기존 AMUX local Git에만
있으며 `mixpeek/amux`로 push하지 않는다.
