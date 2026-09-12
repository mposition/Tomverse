# 독립 검토 결과 — Provider catalogue 필드 수집 P0

검토자: codex (독립 실행)
대상: `claude/to-develop/provider-catalog-field-coverage`, base `origin/develop` d61f2075
요청서: `provider-catalog-field-coverage-independent-review-prompt-2026-09-12.md`

## 1차 라운드 — P1 1건, P2 4건

### P1-1. `active: false`가 신규 후보 진입만 막음 — 반영함

`lib/providerModelCatalogCore.ts`, `lib/providerModelCatalogMonitor.ts:311`,
`lib/modelLifecycleWorkItems.ts:690`

관측 자체는 계속 저장되고 `lifecycle === null`이므로 등록 모델은
`status: "available"`, 큐는 `availability: "current"`가 되고 기존 add work item은
열린 채 남습니다. 즉 **Groq가 꺼 버린, Tomverse가 이미 서비스 중인 모델**에 대해
운영자가 어디서도 통지를 못 받습니다.

**반영:** `lifecycleFromRecord`가 Groq의 `active === false`를 `lifecycle:
"inactive"`로 승격합니다. `lifecycle`은 observation의 `available`, 스캔의 entry
status, 일일 리포트의 lifecycle 경고, 큐의 triage 판정
(`assessModelLifecycleItem`)이 모두 지나는 통로입니다.

> **정정.** 초판에 "큐의 availability 컬럼도 lifecycle을 읽는다"고 썼는데
> **틀렸습니다.** `modelLifecycleWorkItems.ts`의 `availability`는 `lastSeenAt`이
> 최신 스캔 시각 이후인지만 봅니다 — 비활성 모델도 계속 `current`로 표시되며,
> 그것은 그 라벨의 정의("최신 API 응답에서 확인됨")상 맞습니다. lifecycle이
> 닿는 곳은 같은 함수가 별도로 넘기는 triage 판정 쪽입니다. 확인 라운드에서
> codex가 잡았습니다.

은퇴 어휘(`legacy`/`deprecated`/`retired`/`archived`/`sunset`)에 섞지 않고 자기
단어를 씁니다. Groq가 모델을 끈 것은 폐기 공지가 아니고, 리포트는 이 문자열을
그대로 출력합니다. `assessModelLifecycleItem`은 non-null lifecycle을
`no_action`으로 판정하므로 결과 문구도 정확합니다.

`shouldQueueProviderCatalogObservation`의 중복 검사는 **제거**했습니다 —
`lifecycle === null`이 이미 덮고, 두 검사가 있으면 서로 어긋날 자리가 생깁니다.
확인 라운드에서 "현재 호출 그래프에서 안전"으로 판정받았습니다.

### P2-1. Groq 전용 의미가 12개 공급자 전체에 적용됨 — 반영함

**반영:** `providerReportedInactive`가 `provider === "groq"`로 한정합니다.
다른 공급자가 `active`를 다른 뜻으로 쓰면 진짜 모델이 발견에서 조용히
빠지는데, 그것이 `openai_prefix_heuristic`이 드러내려고 존재하는 실패입니다.
`metadata.active`도 Groq 외에는 `null`로 둡니다 — 기록만 하고 아무도 안 쓰는
필드는 나중에 누군가 쓰게 되는 자리입니다.

### P2-2. 빈 배열과 필드 부재가 구분되지 않음 — 주석을 코드에 맞춤

주석이 `null`과 `[]`를 구분한다고 했으나 `modalities([])`는 `null`을 반환합니다.

**반영: 코드가 아니라 주석을 고쳤습니다.** 두 해석 중 틀렸을 때 대가가 있는
쪽은 하나뿐입니다 — `[]`를 "지원 없음"으로 읽으면 채택 초안에 공급자가 부정한
적 없는 `supportsImage: false`가 올라가고, 운영자는 아무도 주장하지 않은
capability를 승인하게 됩니다. 계약상 항상 채워지는 필드가 비어 온 것은 비정상
응답이고, 비정상 응답에서 부정 capability를 유도하지 않습니다.

### P2-3. `effortLevels`를 수집했으나 채택 초안은 반대로 안내 — 반영함

초안이 `"추론 강도 — 공급자가 thinking 지원을 알렸을 뿐 등급은 알리지 않습니다."`
를 출력하는데, Anthropic 응답은 `capabilities.effort`로 단계를 전부 알립니다.

**반영:** `AdoptionObservation.metadata.effortLevels` 추가, adoption-draft
route가 전달, 문구가 관측된 단계를 명시합니다. 레지스트리 `reasoning`으로
자동 매핑은 **하지 않습니다** — 그것은 공급자의 어휘이고, 어느 단계로 파는지는
제품 결정입니다.

### P2-4. 기존에 오염된 큐 항목은 파서 수정으로 사라지지 않음 — 반영함

파서 수정은 내일의 스캔만 지배합니다. 이미 만들어진 `ModelLifecycleWorkItem`은
열린 채 남고, backfill을 다시 돌리면 재생성됩니다.

**반영:** `scripts/close-filtered-model-lifecycle-items.mjs`가
`foreign_product_surface`를 닫기 사유로 추가합니다. 이 스크립트의 선언된 목적이
정확히 "오늘의 필터라면 안 걸었을 항목을 닫는 것"입니다. 실행은
`npm run cleanup:model-lifecycle-queue -- --apply --actor <email>`이며 기본은
dry run입니다.

이 사유만 `(provider, apiModel)`로 판정합니다 — 나머지는 모델에 대한 사실이고,
이것은 **어느 endpoint가 그 항목을 걸었는가**에 대한 사실이기 때문입니다.

## 검토자가 확인한 사항 (수정 불필요)

- boolean fallback의 `??` 체인이 기존의 명시적 `false`를 보존함
- 숫자 `||`가 `0`을 건너뛰지만 token limit은 양수 계약이라 실패 경로 없음
- 새 metadata 값이 전부 scalar 계약을 지킴
- xAI 관측 가격이 파서와 테스트 밖에 소비자가 없고, adoption route가 allowlist
  방식이라 검증 가격 경로로 새지 않음
- 현행 Sonar 모델 ID가 전부 `sonar*`이라 Perplexity 정규식이 현행 모델을 막지 않음
- `heuristicallyExcluded`에 문서화된 제품 경계를 넣지 않은 판단이 타당함

## 확인 라운드 — 해결 3, 부분해결 2

codex 복구 후 실행했습니다. P2-1·P2-2·P2-3은 **해결**, P1-1과 P2-4는
**부분해결**로 판정받았고 남은 세 결함을 고쳤습니다.

### P1-1 잔여 (a) — 비활성 모델이 자동 복구 대상이 됨

등록 모델은 lifecycle과 무관하게 `mapped`에 들어가는데, `mapped`는
`planCatalogReconciliation`이 **복구**하는 근거입니다. 부재로 자동 비활성화된
모델이 `active: false`로 다시 나타나면 **Groq가 꺼 둔 모델을 다시 켭니다.**
경고 누락이 아니라 잘못된 행동이므로 원래 결함보다 나쁩니다.

**반영:** `providerReportedUnservable(observation)`인 관측은 `mapped`에 넣지
않습니다. `missing` 판정은 별도 맵(`observedById`)을 쓰므로 영향이 없고,
등록 모델의 lifecycle 경고는 `modelId`를 달고 그대로 나갑니다.

**lifecycle 전체가 아니라 `inactive` 하나로 좁혔습니다.** `deprecated`·`legacy`
모델은 여전히 요청에 답합니다 — 공급자가 종료를 예고한 것이지 오늘 거절하는 게
아닙니다. 그것까지 복구를 막으면 일시적 카탈로그 공백으로 꺼진 **작동하는**
모델이 꺼진 채 남고, 그게 `restore`가 되돌리려고 존재하는 손해입니다.
판정은 `UNSERVABLE_LIFECYCLE` 상수 하나가 소유합니다.

### P1-1 잔여 (b) — 비활성 모델이 여전히 채택 가능

`adoptableMember`와 서버 preflight 모두 lifecycle을 안 봅니다. 패널은
`inactive`와 `조치 비권장`을 보여주면서 채택 버튼은 작동했습니다.
(이 구멍은 `deprecated` 등에 대해 **이미 있었고**, 이번 변경이 드러냈습니다.)

**반영:** `adoptionPreflightRefusal`에 `unservableEverywhere` 추가, POST 라우트가
항목의 sighting에 해당하는 카탈로그 행의 lifecycle을 읽어 넘깁니다. 서버에서
거절하는 이유는 그쪽이 결정하는 쪽이기 때문입니다.

**`every`이지 `some`이 아닙니다.** 한 공급자가 끈 모델을 다른 공급자가 계속
서비스하면 살아 있는 모델이고, Tomverse는 답하는 쪽으로 라우팅합니다. 카탈로그
행이 하나도 없는 항목은 판정하지 않습니다 — 부재는 missing 탐지의 질문이고,
그걸 "비활성"으로 읽으면 쓰인 적 없는 행을 근거로 채택을 거절하게 됩니다.

### P2-4 잔여 — 혼합 관측 항목을 잘못 닫음

cleanup이 `evidence.observedVia`를 안 읽고 항목이 **처음 filed된** 쌍만 봤습니다.
Perplexity의 Agent 목록이 만든 항목에 나중에 Anthropic의 정당한 관측이 쌓이면,
cleanup이 항목 전체를 `foreign_product_surface`로 닫고 decision key까지 남겨
**정당한 후속 발견을 계속 억제**합니다.

**반영:** 모든 sighting이 foreign surface일 때만 닫습니다. `observedPairsOf`를
`lib/modelLifecycleWorkItemCore.ts`로 옮겨 채택 preflight와 cleanup이 **같은
구현**을 읽습니다 — 같은 증거를 두 번 해석하면 한쪽이 거절하는 것을 다른 쪽이
이미 버린 상태가 됩니다.

### 확인 라운드가 확인해 준 것

- `"inactive"` 문자열은 하류를 깨뜨리지 않음. 컬럼은 enum이 아닌 `String?`이고
  스캔·리포트·UI가 문자열을 그대로 처리하며 `assessModelLifecycleItem`이 모든
  non-null lifecycle을 `no_action`으로 분류함
- `shouldQueueProviderCatalogObservation`의 중복 검사 제거는 현재 호출 그래프에서
  안전함
- P2-1·P2-2·P2-3 판단 모두 타당함

## 3차 라운드 — 위 수정 두 건이 다시 부분해결

### (a) unservable 집합이 너무 좁음 — 반영함

`inactive` 하나로 좁힌 것이 지나쳤습니다. 파서는 `archived`·`retired`·`sunset`도
lifecycle로 분류하는데, 이들은 **지금에 대한 진술**이라 서비스 불가입니다. 자동
비활성화된 모델이 `archived`로 다시 관측되면 여전히 복구됐습니다.

**반영:** `UNSERVABLE_LIFECYCLES` = { inactive, archived, retired, sunset }.
`deprecated`·`legacy`·`shutdown_scheduled`는 **미래에 대한 예고**이고 오늘은
답하므로 제외합니다 — Groq 문서도 deprecation 전환 기간에는 모델이 계속
동작한다고 적습니다.

### (b) 채택 판정을 항목 전체에 물었음 — 반영함

가장 중요한 지적입니다. `unservableEverywhere`는 모든 sighting을 합쳐 판정했지만,
**레지스트리 행은 `(provider, apiModel)` 하나를 들고 런타임은 정확히 그 쌍으로
요청을 보냅니다** — 같은 모델을 listing하는 다른 공급자로 넘어가지 않습니다
(`lib/activeAiModel.ts`). 따라서 Groq가 끄고 Anthropic이 계속 서비스하는 항목에서
운영자가 **Groq 쌍을 고르면** `every`가 false라 통과했고, 죽은 모델이 등록됩니다.

**반영:** `submittedPairUnservable`로 바꿔 **저장되는 쌍**의 카탈로그 행만
봅니다. 항목 전체에 묻는 질문은 양쪽을 다 틀립니다 — 살아 있는 쌍을 막고 죽은
쌍을 통과시킵니다. 거절 문구는 다른 쌍으로 채택하라는 길을 함께 알립니다.

행이 없으면 판정하지 않는 것은 그대로입니다.

### 3차 라운드가 확인해 준 것

- P2-4는 **해결**. `observedPairsOf` 이동이 파싱·fallback 동작을 바꾸지 않음
- 트랜잭션 안팎 preflight가 같은 `readAdoptionContext()`를 쓰고 내부 읽기도
  `tx`를 사용하므로 경계가 깨지지 않음
- `missing` 판정은 별도 `observedById`를 쓰므로 `mapped` 변경의 영향 없음
- 이번 수정들이 새로 만든 별도 회귀는 없음

## 검증

- `npm run typecheck` 통과
- `npm run check:encoding:strict` 통과
- `npm run check:model-pricing` 통과 (36 profiles, 0 unpriced)
- 변경 파일 `eslint --max-warnings=0` 통과
- `tests/provider-model-catalog-core.test.ts` 38건, `tests/model-adoption-draft.test.ts`
  49건, `tests/model-lifecycle-work-item-core.test.ts` 41건 통과 (신규 20건)
- `npm run test:unit` — 실패 1건, `H:\H:\Project\...`로 드라이브 접두사가
  중복된 `providerErrorClassification.test.mjs`의 디렉터리 walk. assertion이
  아니라 Windows 경로 문제이고 이 변경과 무관합니다(러너 exit 0).
