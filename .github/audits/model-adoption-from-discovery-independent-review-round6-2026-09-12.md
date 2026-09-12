# 발견 큐 → 레지스트리 채택 기능 독립 재검토 (Round 6)

- 검토일: 2026-09-12
- 검토 기준: `git show 50c60a42`, `git show e4e97d11`, 현재 소스 트리
  `e4e97d11`
- 이전 지적: `codex-review-round5.md`의 P1-A6, P1-A7, P1-A8
- 판정: **수정 후 재검토 필요**

결론부터 말하면 **P1-A7과 P1-A8은 닫혔지만 P1-A6은 아직 완전히 닫히지
않았다.** `e4e97d11`이 최초 draft ID에 profile이 바로 매칭되는 경로의 Save 차단은
해결했다. 그러나 Registry ID는 편집 가능한데 `profilePrice`는 draft를 처음 읽을 때의
ID로 한 번만 계산된다. provider API ID와 canonical profile ID가 다른 모델은 운영자가
ID를 canonical 값으로 고쳐도 UI가 새 profile을 보지 못해 계속 Save를 막는다.

새 결함은 **P2 1건**이다. profile 상속으로 저장할 수 있게 된 화면이 동시에 가격을
직접 입력하라고 안내하고, 이미 반영한 long-context tier를 계산에서 제외했다고
설명한다. 안내대로 숫자를 입력하면 `NULL` 상속이 관리자 override로 바뀐다.

## 판정 요약

| 항목 | 판정 | 핵심 근거 |
|---|---|---|
| P1-A7 advisory lock key의 NUL | **해결** | `50c60a42`가 실제 NUL을 `::`로 교체했고 현재 소스의 NUL은 0개 |
| P1-A8 profile fallback의 env/schedule 누락 | **해결** | `e4e97d11`이 runtime과 같은 `resolveModelPricing()`으로 현재 revision, prompt tier, env override를 해석 |
| P1-A6 profile 상속 채택의 UI Save 차단 | **부분 해결 / 미종결** | 최초 draft ID가 profile ID와 같으면 해결. ID를 canonical profile ID로 편집하는 alias 모델에서는 `profilePrice`가 갱신되지 않아 계속 차단 |
| 새 P2-A9 profile 상속 안내 불일치 | **미해결** | 실제로는 profile을 상속하면서도 가격 직접 입력과 long-context tier 미반영을 안내해 영구 override를 유도 |

## 남은 결함

### P1-A6. 편집한 Registry ID의 profile을 UI가 다시 해석하지 않아 Save가 계속 차단됨

`e4e97d11`의 정상 경로 자체는 맞다. adoption-draft API가 만든
`draft.fields.id`에 profile이 있으면 runtime 유효가격을 응답하고, panel은 빈 가격과
빈 output cap에 그 값을 fallback으로 써 floor를 만든다. 따라서 **처음부터 draft ID와
profile ID가 같은 모델**은 빈 가격 컬럼을 유지한 채 Save할 수 있다.

하지만 profile 조회는 GET 시점의 `draftModelId`로 한 번만 한다. panel은 그 결과를
`profilePrice` state로 저장하며, 이후 편집 가능한 `form.id`가 바뀌어도 새 ID의
profile을 조회하거나 기존 값이 어느 ID의 것인지 검사하지 않는다. 반면 POST server는
현재 `body.id`로 profile을 다시 해석한다. UI와 server가 서로 다른 ID를 가격 기준으로
삼는 셈이다.

**재현 입력 → 잘못된 출력:** registry에 충돌 row가 없는 새 Anthropic discovery가
API model `claude-haiku-4-5-20251001`을 관측했고, code profile의 canonical ID는
`claude-haiku-4-5`인 상태에서 adoption draft를 연다. draft ID는
`claude-haiku-4-5-20251001`로 생성되어 profile 조회가 `null`이 된다. 운영자가
Registry ID를 `claude-haiku-4-5`로 고치고 입력·출력 가격과 max output을 비워
profile 상속을 선택한 뒤 Advanced/4 credits와 유효한 사유를 입력한다 → server
preflight는 US$1/US$5, max output 64,000인 canonical profile을 찾아 `null`
refusal, 즉 저장 가능으로 판정하지만, UI는 최초의 `profilePrice=null`을 계속 사용해
`price_unknown`을 만들고 Save 버튼을 비활성화한다. 기대 출력은 현재 `form.id`의
profile로 floor를 다시 계산해 Save를 허용하는 것이다.

같은 문제가 특수한 한 모델에만 있는 것은 아니다. 현재 `MODEL_PRICING` 36개를
`registryIdFromApiModel(profile.apiModelId)`와 대조하면 **20개**가 profile의
`modelId`와 다르다. 예를 들어 `gemini-3-1-pro` /
`gemini-3.1-pro-preview`, `claude-opus-4-8` / `claude-opus-5`,
`perplexity/sonar` / `sonar`가 같은 naming shape이다.

- draft ID를 API model에서 생성: `lib/modelAdoptionDraft.ts:253-276`
- 실제 alias profile 예시: `lib/modelPricing.ts:1142-1155`
- 최초 draft ID로만 profile 가격을 계산: `app/api/admin/model-lifecycle/adoption-draft/route.ts:121-152`
- 응답의 profile 가격을 한 번 state에 저장: `components/admin/AdminModelRegistryPanel.tsx:241-270`
- Registry ID는 새 row에서 편집 가능: `components/admin/AdminModelRegistryPanel.tsx:730-735`
- floor는 `form.id`와 결속되지 않은 `profilePrice`를 사용: `components/admin/AdminModelRegistryPanel.tsx:313-338`
- `price_unknown`이면 Save 차단: `components/admin/AdminModelRegistryPanel.tsx:787-795`
- server는 저장 시 현재 `body.id`로 다시 해석: `app/api/admin/models/route.ts:110-129`,
  `app/api/admin/models/route.ts:184-195`

### P2-A9. 상속 가격을 쓰면서도 가격 직접 입력을 요구하고 tier 미반영이라고 안내함

`e4e97d11` 전에는 가격이 비어 있으면 floor를 만들 수 없었으므로 “가격을
입력합니다”라는 unknown 문구가 실제 동작과 일치했다. 이제 profile이 있으면 빈 가격을
유지하는 것이 올바른 상속 경로인데도 문구는 그대로이고, panel은 이를 “아직 사람이
정해야 하는 값” 아래 표시한다. 같은 floor 설명은 `resolveModelPricing()`이 worst-case
prompt의 long-context tier를 이미 고른 뒤에도 long-context tier가 figure에 없다고
말한다.

**재현 입력 → 잘못된 출력:** draft ID와 profile ID가 같은 새 모델의 adoption
draft를 열어 profile 상속 floor가 정상 표시되게 한다 → 같은 화면은 입력·출력 단가를
공급자 가격표에서 확인해 직접 입력하라고 말하고, 계산에 long-context tier가 없다고
말한다. 운영자가 첫 지시대로 profile 숫자를 입력하면 form 숫자가 fallback보다
우선하고 DB에도 숫자가 저장되어 `costSource="model_registry_override"`가 되며 현재
tier와 향후 schedule revision 상속이 평탄화된다. 기대 출력은 profile 상속 중임을
명시하고 가격을 미결정 목록에서 빼며, 실제 floor에 반영한 tier 범위를 정확히
설명하는 것이다.

- profile 여부와 무관하게 가격을 unknown으로 추가: `lib/modelAdoptionDraft.ts:317-325`
- unknown을 “아직 사람이 정해야 하는 값”으로 표시: `components/admin/AdminModelRegistryPanel.tsx:669-678`
- form 숫자가 profile fallback보다 우선: `components/admin/AdminModelRegistryPanel.tsx:313-320`
- long-context tier가 없다고 안내: `components/admin/AdminModelRegistryPanel.tsx:690-711`
- 숫자를 DB override로 저장: `lib/modelRegistryAdmin.ts:191-195`
- DB 숫자가 runtime profile보다 우선: `lib/modelPricing.ts:1669-1674`,
  `lib/modelPricing.ts:1712-1728`

## 닫힌 항목

### P1-A7. advisory lock key의 실제 NUL — 해결

**재현 입력 → 잘못된 출력(수정 전):** open discovery item에 exact observed pair와
유효한 disabled/unlisted body, 충분한 credit와 사유를 넣어 work-item adoption POST를
보낸다 → `4f8a98cd`에서는 transaction 첫 advisory-lock parameter에 실제 U+0000이
들어 PostgreSQL `text` 변환이 실패하고 정상 201 대신 generic 500이 반환됐다.

**현재 출력:** `50c60a42`는 lock text를
`${provider}::${apiModel}`로 만든다. provider는 colon이 없는 닫힌 enum이므로 첫 `::`가
항상 pair 경계이고, API model의 나머지 문자열과 모호해지지 않는다. 현재 route 파일의
NUL byte는 0개이며 repository 전체 control-character 검사도 통과했다. 따라서 이
원인의 500은 제거됐고 P1-A7은 닫을 수 있다.

- 당시 실제 NUL parameter: `4f8a98cd:app/api/admin/models/route.ts:281-283`
- 현재 PostgreSQL-safe key와 lock: `app/api/admin/models/route.ts:300-305`
- colon이 없는 provider enum: `lib/modelRegistryShared.ts:9-22`
- repository 전체 raw control-character 검사: `tests/textEncodingCheckCore.test.mjs:192-201`

실제 PostgreSQL transaction은 `DATABASE_URL`과 `DIRECT_URL`이 없어 실행하지 못했다.
다만 `$executeRaw SELECT pg_advisory_xact_lock(...)`은 저장소의 여러 기존 경로가 같은
형태로 쓰고 있고, 이번 결함의 원인이었던 parameter byte는 정적으로 제거됐음을
확인했다.

### P1-A8. profile fallback이 env override와 schedule revision을 무시 — 해결

**재현 입력 → 잘못된 출력(수정 전):** `claude-haiku-4-5`의 body 가격/output cap을
`null`, `creditWeight=4`, worst input 128,000으로 두고
`CHAT_MODEL_CLAUDE_HAIKU_4_5_INPUT_USD_PER_MILLION=100`,
`CHAT_MODEL_CLAUDE_HAIKU_4_5_OUTPUT_USD_PER_MILLION=100`을 설정한다 → 이전 코드는
원본 profile US$1/US$5만 읽어 480,000 micro-USD와 4 credits로 승인했지만 실제
runtime은 US$100/US$100, 22,400,000 micro-USD여서 어떤 class도 덮지 못했다.

**현재 출력:** `e4e97d11`은 profile 존재를 확인한 뒤
`resolveModelPricing({ estimatedPromptTokens: worstCaseInputTokens })`을 호출한다. 위
재현은 `costSource="registry_env_override"`, US$100/US$100, max output 64,000으로
해석되어 US$22.400 `above_every_class` 409를 반환했다. 같은 resolver가 현재
`priceSchedule` revision과 worst-input prompt tier도 선택한다. body에 직접 입력한
숫자는 이후 floor의 왼쪽 `??` 값으로 계속 우선하므로 관리자 override 의미도
보존된다. P1-A8은 닫을 수 있다.

- adoption의 runtime 유효가격 helper: `app/api/admin/models/route.ts:97-129`
- helper 결과를 preflight context에 전달: `app/api/admin/models/route.ts:184-195`
- current revision과 prompt tier 선택: `lib/modelPricing.ts:1646-1657`
- env 가격/output-cap override 적용: `lib/modelPricing.ts:1659-1674`,
  `lib/modelPricing.ts:1693-1709`
- body 숫자 우선/profile fallback: `lib/modelAdoptionDraft.ts:541-558`

## 검증과 한계

- `git diff 50c60a42^ 50c60a42 --check` — 통과
- `git diff e4e97d11^ e4e97d11 --check` — 통과
- `npm run typecheck` — 통과
- 관련 7개 파일 ESLint — 통과
- `npm run check:model-pricing` — 통과: explicit profile 36, fallback/unpriced/register
  warning 0
- `tests/model-adoption-draft.test.ts` + `tests/modelRegistryPricingInheritance.test.ts` +
  `tests/modelPricing.test.mjs` — 79/79 통과
- `tests/textEncodingCheckCore.test.mjs` — 17/17 통과, repository raw control-character
  검사 포함
- `npm run check:encoding:strict`은
  `components/admin/AdminModelRegistryPanel.tsx:243`의 정상 URL query
  `adoption-draft?workItemId`를 question-mark-run으로 오인해 실패했다. 해당 문자열은
  `e4e97d11` 이전에도 동일하게 존재하므로 이번 두 커밋의 회귀로 판정하지 않았다.
- 실제 PostgreSQL advisory lock 및 두 connection 경쟁은 DB 자격증명이 없어
  실행하지 않았다.

현재 테스트는 순수 preflight의 profile fallback만 고정한다. adoption-draft route가
현재 effective price를 반환하는지, Registry ID 편집 후 profile price가 다시 계산되는지,
상속 상태에서 Save가 활성화되는지를 실행하는 route/client 회귀 테스트는 없다. 이
빈칸 때문에 P1-A6의 alias-ID 경로와 P2-A9의 안내 불일치가 green test 밖에 남아 있다.
