# 독립 검토 요청 — allocation 축(D-1)과 router-core package(E)

- 대상 commit 둘:
  - `7e666b803` `feat(routing): the allocation axis as its own column, added dark`
  - `4b0fefb02` `refactor(routing): move the ranking construction into @tomverse/router-core`
- 검토 worktree: `H:\Project\tv-routing-review-20260922`
- 직전 라운드: cache affinity(C-6),
  `.github/audits/multi-provider-routing-cache-affinity-review-prompt-2026-09-23.md`.
  그 라운드의 발견 네 건(major)은 `c6bd41749`에서 닫았습니다.

## A. allocation 축 (`7e666b803`)

`RoutingRun`에 nullable 컬럼 둘을 더했습니다 — `allocationMode`,
`allocationSeedGrain`. 기존 `mode`는 건드리지 않았습니다.

고정 제약: **`RoutingRun.mode`를 재사용하지 않는다.** `mode`는 "결정이
실행됐는가"이고 오늘 값은 `shadow` 하나입니다. 할당 축은 "순위 1위를 골랐는가"
입니다.

검토해 주셨으면 하는 것:

1. **두 축이 정말 독립입니까?** `shadow_explore` 같은 합성값이 필요해지는
   경우가 있습니까? 반대로, 두 컬럼이 사실은 같은 것을 두 번 적고 있습니까?
2. **`explore_bounded`인데 seed grain이 없는 행을 DB가 정말 막습니까?**
   `RoutingRun_allocation_axis_check`와 `lib/routingAllocation.ts`의
   `routingAllocationProblems()`가 **같은 집합**을 거절합니까? 지난 라운드에서
   `btrim` vs `trim()` 때문에 두 집합이 어긋나 있었습니다. 같은 종류의 어긋남을
   찾아 주십시오.
3. **닫힌 목록을 `check:enum-constraints`가 실제로 비교합니까?** 첫 시도는
   목록을 3분기 OR 안에 접어 넣었고, 발견기가 못 읽어 registry 항목이 stale로
   보고됐습니다. 지금은 목록 CHECK 둘 + shape CHECK 하나입니다. 이 분리가
   맞습니까, 아니면 세 제약이 서로 모순될 수 있습니까?
4. **dark column 검사**(`scripts/check-dark-tables.mjs`의 `DARK_COLUMNS`).
   `RoutingRun`은 live table이라 테이블 규칙이 컬럼을 덮지 못합니다. 식별자
   이름으로 스캔하고 vocabulary 모듈 하나만 면제합니다.
   - 이 방식이 놓치는 접근 경로가 있습니까? (`select: { allocationMode: true }`,
     raw SQL, `Object.keys`, 문자열 조립)
   - 면제가 `break`로 구현돼 있습니다. 올바릅니까?
5. **`mayBreakCacheAffinity()`**가 `null`·`false`·`true`를 돌려줍니다. 이름이
   실제보다 큰 주장을 합니까? 주석은 "could have moved it, not that it did"
   라고 적습니다. 함수가 그 범위를 지킵니까?

## B. router-core package (`4b0fefb02`)

순위 정련 구성을 `packages/router-core`로 옮기고, 제품 결정은 앱에 남겼습니다.
`docs/policy/shared-packages.md` §7의 절차를 따랐습니다.

검토해 주셨으면 하는 것:

1. **경계가 맞습니까?** package에 남은 것 중 제품 결정인 것이 있습니까?
   앱에 남은 것 중 재사용 가능한 것이 있습니까? 특히
   `partitionByQuality`·`partitionByDegraded`가 앱에 남은 것이 옳습니까?
2. **행동이 보존됐습니까?** 이것이 가장 중요합니다. `partitionByMetric`의
   tie key가 `entry.modelId` 하드코딩에서 주입으로 바뀌었고, `decidedBy`가
   null을 돌려줄 수 있게 됐습니다. **같은 입력에 같은 순위가 나옵니까?**
   달라지는 입력이 있으면 그 입력을 대 주십시오.
3. **`decidedBy`의 null 처리.** package는 null을 주고 앱이
   `ROUTER_TIE_BREAK_ORDER[length-1]`로 접습니다. 이 접기가 틀린 답을 주는
   경우가 있습니까? (원래 코드는 `"model_id"` 리터럴이었습니다.)
4. **`refineToRanking`의 `partitionerFor` 호출 위치.** 그룹마다
   `partitionerFor(criterion)`을 다시 부릅니다. 원래 코드는
   `partitionFor(criterion, group, signals)` 한 번이었습니다. 성능 외에
   의미가 달라지는 지점이 있습니까?
5. **framework 순수성.** `npm run check:shared-packages`가 통과하지만, 그
   검사가 보지 않는 위반이 있습니까? `packages/router-core/tsconfig.json`은
   `chat-core`의 것을 복사했습니다 — 이 package에 맞지 않는 항목이
   있습니까?(`"jsx": "react-jsx"`는 TSX가 없는데 남아 있습니다.)
6. **PACKAGE-01.** commit message가 "이 승인은 세 번째 package를 덮지
   않는다"고 적습니다. 그 진술이 정확합니까? registry(`docs/release-gates/`)나
   증거 파일에 제가 놓친 조건이 있습니까?

## C. 양쪽 공통

- 주석·commit message가 코드보다 큰 주장을 하는 곳.
- 테스트 이름이 테스트하지 않는 것을 말하는 곳.
- 기존 계약(`docs/policy/`, `docs/ui-contracts/`, AGENTS.md)과 충돌하는 곳.

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
