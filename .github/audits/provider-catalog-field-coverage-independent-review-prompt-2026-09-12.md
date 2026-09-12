# 독립 검토 요청 — Provider catalogue 필드 수집 P0

## 배경

Provider Model Catalogue의 일일 스캔은 12개 공급자의 모델 목록을 읽어
`ProviderModelCatalogEntry.metadata`에 기록하고, 그 metadata가 운영자의
모델 채택 초안(`lib/modelAdoptionDraft.ts`)을 미리 채웁니다. 공급자가 이미
응답에 담아 보내는 값을 파서가 읽지 않으면, 운영자는 공개된 숫자를 손으로
다시 입력하게 됩니다.

이번 변경은 그 중 **이미 제공되는데 읽지 않던 필드**만 수정합니다. 공식 문서
enrichment, 가격 schedule 제안, 출처 배지는 범위 밖입니다.

## 변경 범위

`lib/providerModelCatalogCore.ts` 한 파일과 그 테스트.

### 1. Perplexity — 후보 큐 교차 오염

`https://api.perplexity.ai/v1/models`는 **Agent API**(`POST /v1/agent`)용
목록이고, 반환값에 타사 모델이 들어 있습니다(공식 문서 예시):

    anthropic/claude-opus-4-8, openai/gpt-5.6-sol, google/gemini-3.5-flash,
    xai/grok-4.5, perplexity/glm-5.2, perplexity/kimi-k2.7-code, perplexity/sonar

Tomverse의 Perplexity 클라이언트는 Chat Completions로 Sonar를 호출합니다.
`providerModelCatalogMonitor.ts`는 **은퇴 판정** 쪽에서 이미 이 사실을 알고
`if (provider === "perplexity") continue;`로 가드하고 있었으나, **후보 큐**
쪽에는 같은 가드가 없었습니다. id 정규식이 `/`를 허용하므로 위 타사 id가
전부 provider=`perplexity` 후보로 들어갑니다.

새 `foreignProductSurfaceId(provider, id)`가 Perplexity에 한해 Sonar 계열만
통과시킵니다. `chatModelExclusion`의 새 사유 `foreign_product_surface`와
`isReviewableProviderModelId` 양쪽에 걸립니다.

**중점 검토:** 이 규칙이 Perplexity 외로 새지 않는지, 새 `sonar-*` 모델
발견을 막지 않는지, `heuristicallyExcluded`에 넣지 **않은** 판단이 타당한지
(모듈 주석의 근거: 그 목록은 OpenAI prefix *추측* 전용이고, 이것은 문서화된
제품 경계라 `non_chat_kind`와 같은 성격).

### 2. Groq

`context_window`, `max_completion_tokens`, `active`를 읽지 않고 있었습니다.
앞의 둘은 기존 `contextLength`/`outputTokenLimit`의 OR 체인에 추가했습니다.
`active === false`는 lifecycle 값이 아니라 **큐 제외**로 읽습니다
(`shouldQueueProviderCatalogObservation`).

**중점 검토:** `active`를 lifecycle로 올리지 않은 판단. lifecycle 문자열은
*등록된* 모델의 은퇴 의심을 운영자에게 알리는 신호인데, 미등록 모델을 Groq가
꺼 둔 것은 은퇴도 아니고 사람에게 채택을 물을 대상도 아닙니다. 또한
`null !== false`가 유지되어 다른 11개 공급자의 큐가 비지 않는지.

### 3. xAI

`input_modalities`/`output_modalities`, `long_context_threshold`, 그리고
가격 세 필드를 읽지 않고 있었습니다. 가격은 **공급자 단위 그대로**
(`observedPromptPriceCentsPer100MTokens` 등) 저장하고 어떤 가격 경로에도
넣지 않습니다 — docs/policy/credit-and-cost-limits.md가 가격의 출처를 정하고,
카탈로그 읽기는 검증된 가격이 아닙니다.

`aliases`는 **분석 단계에서 이미 처리되고 있음을 확인**했으므로 건드리지
않았습니다(별도 observation으로 전개, `aliasOf`).

**중점 검토:** 가격을 변환하지 않고 단위를 이름에 박은 판단. 이 값이 나중에
가격 경로로 새어 들어갈 경로가 있는지.

### 4. Moonshot/Kimi

`supports_image_in`, `supports_video_in`, `supports_reasoning`. 앞뒤 둘은
기존 `vision`/`thinking`의 `??` 체인에 추가, `supports_video_in`은 새
`videoInput`.

### 5. Anthropic

분석서는 `max_input_tokens`/`max_tokens` 누락을 주장했으나 **파서가 이미 읽고
있어 그 주장은 틀렸습니다.** 실제 누락은 중첩 capability 객체입니다 —
`capabilities.pdf_input.supported`, `capabilities.structured_outputs.supported`,
`capabilities.effort.{low,medium,high,xhigh,max}`. 새 `supportedKeys()`가
effort 레벨을 뽑되 부모 자신의 `supported` 플래그는 레벨이 아니므로 건너뜁니다.

`pdfInput`은 레지스트리에 대응 컬럼이 **없으므로** 증거로만 남습니다. 컬럼
신설은 이번 범위가 아닙니다.

## 검증 상태

- `npm run typecheck` 통과
- `npm run check:encoding:strict` 통과
- 변경 파일 `eslint --max-warnings=0` 통과
- `tests/provider-model-catalog-core.test.ts` 32건 통과(신규 9건)
- 인접 스위트 97건 통과

## 특히 봐 주셨으면 하는 것

1. `??` 체인에 추가한 fallback들이 **기존 판정을 바꾸는지**. 특히 `boolean()`이
   `null`을 반환하는 경우와 `||`(숫자)와 `??`(불리언)를 섞어 쓴 지점.
2. `metadata`는 `Record<string, string|number|boolean|null>`입니다. 새 필드가
   그 계약을 지키는지, 배열을 문자열로 접은 선택(`inputModalities`)이 나중에
   읽는 쪽에서 오해될 여지가 있는지.
3. Perplexity 규칙이 **너무 좁아** 실제 신규 모델을 놓칠 가능성.
4. 이 변경이 `providerModelCatalogMonitor.ts`의 upsert·`missing` 계산과
   `lib/modelAdoptionDraft.ts`의 prefill에 미치는 2차 영향.
