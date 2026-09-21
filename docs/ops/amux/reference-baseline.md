# AMUX Frozen Reference Baseline

상태: `FROZEN_COMPLETE`

이 문서는 Tomverse에 productize한 AMUX 구현이 어떤 검증 완료 reference를
기준으로 삼았는지 보존한다. Full source의 복사본이나 새 upstream 저장소가
아니며, Tomverse의 AMUX source integration 및 activation을 승인하는 문서도
아니다.

## Source provenance

| 항목 | 값 |
|---|---|
| 원본 remote | `https://github.com/mixpeek/amux.git` |
| upstream base | `6ec38c7875260e0bbcae173e811c341e35217e4f` (`origin/main`) |
| frozen local path | `~/TomverseAMUX-global-priority-forwardport-6ec38c78` |
| frozen branch | `feat/global-priority-scheduler-mainline-6ec38c78` |
| validated HEAD | `83835d5209b110a9497d81246c07f284372ee61c` |
| local commits above upstream base | 27 |
| validated release artifact SHA-256 | `84406dd5e68155d7b2ed28e9f9e7a6294d6a4689642c8f5f55cb94f38a3c7de0` |

Validated HEAD의 마지막 변경은 canonical dispatch predicate builder를 따르도록
routing 경로를 정렬한 수정이다. Reference branch와 그 27개 local commit은
`mixpeek/amux`에 push하지 않았고, Tomverse 개발을 위해 upstream history를
변경하지 않는다.

## Validation baseline

Global Priority Scheduler와 Worker Router의 regression suite를 검증했다. 마지막
누락 regression은 실제 integration-test target에서 다음과 같이 통과했다.

```text
fan_out_keeps_dependency_chain_local_and_retries_independent_assignment

running 1 test
... ok

1 passed
0 failed
```

이 regression은 fan-out 뒤에도 dependency chain이 worker-local 상태를
유지하며, 독립 assignment의 retry가 그 chain을 침범하지 않는다는 reference
semantics를 고정한다. 검증 시 reference worktree는 clean이었고
`git diff --check`도 통과했다.

## Repository authority

- Frozen local reference는 semantic comparison과 provenance 확인에만 사용한다.
- Reference directory는 일반 개발 branch처럼 수정하거나 삭제하지 않는다.
- Upstream full source와 전체 Git history를 Tomverse root에 합치지 않는다.
- Productized AMUX의 authoritative development repository는
  `mposition/Tomverse`다.
- Tomverse의 실제 구현 위치는 `crates/amux-core`,
  `apps/tomverse-orchestrator`, `lib/amux`, `app/api/internal/amux`다.
- Source integration, staging activation, production activation은 각각 별도
  결정이다. 이 baseline은 feature flag를 켜거나 배포를 승인하지 않는다.
