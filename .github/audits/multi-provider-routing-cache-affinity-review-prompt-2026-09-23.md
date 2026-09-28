# 독립 검토 요청 — cache affinity (C-6)

- 대상 commit: `1693ceb96` (`feat(routing): cache affinity as two observations, added dark`)
- 검토 worktree: `H:\Project\tv-routing-review-20260922`
- 앞선 검토: capacity state와 availability observation(C-4·C-5),
  `.github/audits/multi-provider-routing-capacity-and-observation-review-prompt-2026-09-23.md`

## 무엇을 만들었는가

멀티 프로바이더 라우팅 ADR은 `P(cache_hit | session, deployment)`를 계산해
effective cost 안에 접어 넣으라고 요구합니다. 이 커밋은 **그것을 하지 않고**,
대신 관측 가능한 두 사실만 기록합니다.

1. `ModelDeployment`에 붙은 다섯 컬럼 — 이 배치의 prompt cache가 **검증된 결과로**
   무엇을 하는지. 기본값 `unproven`, 그 옆의 수치는 전부 NULL.
2. `DeploymentCacheAffinity` — conversation + logical model 당 한 행, 마지막으로
   어느 deployment가 서빙했는지와 언제인지.

`cacheWindowState()`가 둘을 합쳐 "마지막 서빙이 검증된 window 안인가"를
답합니다.

둘 다 dark입니다. `npm run check:dark-tables`가 강제합니다.

## 검토해 주셨으면 하는 것

### 1. 주장이 코드보다 크지 않은가

이 작업에서 반복된 결함은 **주석이 강제되지 않는 성질을 주장하는 것**이었습니다.
지난 다섯 라운드에서 네 번 걸렸습니다 — trigger 없는 "append-only", 부모 FK만
검사하면서 "재할당 불가"라고 적은 테스트, 사실이 아닌 "idempotent projection".

이번 커밋에서 같은 것을 찾아 주십시오. 특히:

- `cacheWindowState()`의 doc comment가 **"hit prediction이 아니다"**라고 적습니다.
  함수가 실제로 그 이상을 주장하지 않습니까? 반환값 이름(`within_ttl`)이
  읽는 사람에게 hit을 암시하지 않습니까?
- migration 주석이 "prefix digest는 여기 없고 앞으로도 없다"고 적습니다.
  테스트가 그것을 실제로 막습니까, 아니면 네 개의 이름만 문자열로 찾습니까?
- `promptCacheSupport`의 네 값이 **각각 서로 다른 판정을 실제로 만들어 냅니까**,
  아니면 `verified_automatic`/`verified_explicit`가 어디에서도 다르게 취급되지
  않아 지금은 같은 값입니까? 후자라면 그 사실을 적어야 합니까?

### 2. 목적함수를 건드리지 않았는가

이 작업의 고정 제약입니다 — 목적함수는 lexicographic이고, 가중합으로 바꾸는
변경은 착수 금지입니다(`ROUTER_TIE_BREAK_ORDER`, `lib/routerScorePolicy.ts`).

- 이 커밋의 어떤 부분이든 ranking·tie-break·비용 계산에 도달합니까?
- 도달하지 않는다면, **나중에 도달시키는 가장 쉬운 잘못된 방법**은 무엇입니까?
  그것을 막는 것이 있습니까?

### 3. content-free 경계

routing telemetry에 사용자 콘텐츠가 들어가지 않는다는 규칙입니다
(`ComparisonReviewRun`의 `contentFreeViolations()`가 같은 규칙을 다른 테이블에
강제합니다).

- `conversationId`·`logicalModelId`·`lastServedAt`이 콘텐츠입니까? 아니라면
  왜 아닙니까?
- prefix digest를 거부한 이유로 "추측을 확인해 준다"를 들었습니다. 이 논거가
  `conversationId`에는 적용되지 않습니까?
- 삭제 경로: 양쪽 FK가 `ON DELETE CASCADE`입니다. `RoutingRun`은 같은 이유로
  Cascade를 선택했고 이유를 적어 뒀습니다. 이 테이블에서 Cascade가 틀린
  선택이 되는 경우가 있습니까?

### 4. cache marker 결정의 이중화

`lib/anthropicPromptCaching.ts`가 어떤 호출 경로에 `cache_control`을 붙일지
정합니다. 판정은 registry의 provider identity이고, 이유는 `createAnthropic()`이
MiniMax 클라이언트도 만들기 때문입니다.

- 새 `promptCacheSupport` 컬럼이 **그 결정의 두 번째 답**이 될 수 있습니까?
- 테스트가 `providerOptions` 부재만 확인합니다. 충분합니까?
- `docs/policy/anthropic-prompt-caching.md`의 계약(5분 캐싱, write premium을
  provider budget에만 예약, `usage.inputTokens`가 총합)과 충돌하는 부분이
  있습니까?

### 5. `check:dark-tables`의 관계 필드 변경

이 커밋이 `scripts/check-dark-tables.mjs`를 함께 고쳤습니다. 이전에는 delegate
이름에 `s`를 붙여 관계 필드를 찾았고, 그래서 `cacheAffinities`를 놓쳤습니다.
이제 schema에서 읽되 **dark가 아닌 모델에 선언된 필드만** 담습니다.

- 그 좁히기가 실제 구멍을 만듭니까? dark 부모에 선언된 관계 필드는 부모의
  delegate 패턴이 잡는다는 논거가 모든 경우에 성립합니까?
- 첫 시도는 모든 필드를 담았고 `approvals:`·`scope:`를 쓰는 무관한 파일 여섯
  개를 오검출했습니다. 지금 버전이 그 반대 방향으로 지나치게 느슨합니까?
- schema 파싱이 `model X {`와 `}`만으로 블록을 나눕니다. 깨지는 입력이
  있습니까?

### 6. 제약이 실제로 막는가

`ModelDeployment_prompt_cache_evidence_check`가 세 갈래 OR입니다. 통과해서는
안 되는 행이 통과합니까? 특히:

- `verified_absent`에 `promptCacheMinPrefixTokens`만 있는 행
- `verified_automatic`에 `promptCacheMinPrefixTokens`가 있는 행 (의도적으로 허용)
- 공백만 담긴 `promptCacheEvidenceRef`

TypeScript 검증기와 DB CHECK가 **같은 집합**을 거부합니까? 어긋나는 입력이
있으면 그 입력을 대 주십시오.

## 판정 형식

`approve` / `approve_with_changes` / `reject` 중 하나와, 발견마다
`blocker` / `major` / `minor` 등급. 사실 오류라고 판단한 것은 **파일과 줄**을
대 주십시오 — 지난 라운드에 검토 쪽의 사실 주장 하나가 틀렸고
(`check:enum-constraints`가 기계적으로 비교하지 않는다고 했으나 비교합니다),
근거를 대면 그런 것을 양쪽 다 빨리 확인할 수 있습니다.
