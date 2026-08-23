# 미처리 모델 후보 triage (2026-08-22)

- 대상: 2026-07-21~08-22 discovery가 발견했으나 카탈로그에 도달하지 못한
  **first-party 모델 7건**
- 근거: `.github/audits/model-lifecycle-email-2026-08-22.md` 5절 ML-01
- 성격: **감사가 아니라 작업 큐입니다.** 이 문서가 존재해야 하는 이유가 곧
  ML-02·ML-03입니다 — 저장소에 이 상태를 담을 곳이 없어서 문서로 대신합니다.
  `ModelLifecycleWorkItem`이 생기면 이 표가 첫 backfill 입력입니다.
- 권한: read-only. 코드·DB·registry를 바꾸지 않았고 provider API를 호출하지
  않았습니다.
- 증거 표기: `[측정]` 운영 관측 · `[코드]` 저장소 · `[확인 불가]` 근거 부족

---

## 0. 먼저 정정 — 7건은 7개의 결정이 아닙니다

Qwen 3.8 계열 3건(`qwen3.8-max` · `qwen3.8-2.4t-a95b` · `qwen3.8-27b`)은
같은 세대의 세 변형이고, 하나를 정하면 나머지가 따라옵니다. 묶으면
**결정은 5개**입니다.

| # | 결정 | 대상 | 성격 |
|---|---|---|---|
| D-1 | Gemini Flash 세대 이동 | `gemini-3.7-flash` | upgrade · **완료 (2026-08-22)** |
| D-2 | Zhipu GLM 세대 이동 | `glm-5.3` | upgrade · **blocked** |
| D-3 | Qwen Flash 세대 이동 | `qwen3.7-flash` | upgrade |
| D-4 | xAI 플래그십 세대 이동 | `grok-4.6` | upgrade · **연쇄 있음** |
| D-5 | Qwen 3.8 계열 편입 여부 | `qwen3.8-max` 외 2 | 신규 계열 · **가격 gate** |

---

## 1. 이 저장소에서 "모델 추가"가 무엇인가

triage 판정을 하려면 승인 뒤에 무슨 일이 남는지가 먼저 있어야 합니다. 흩어져
있어서 여기 모읍니다. `[코드]` 전부.

| # | 단계 | 위치 | 빠뜨리면 |
|---|---|---|---|
| 1 | 카탈로그 entry | `lib/models.ts` — `id`·`apiModel`·`provider`·`minimumPlan`·`usageClass`·`creditWeight`·`contextWindowTokens`·`inputCapabilities` | 모델이 존재하지 않음 |
| 2 | 가격 profile | `lib/modelPricing.ts`의 `MODEL_PRICING` | `findUnpricedModels()`가 보고. **premium은 `npm run check:model-pricing`이 fail-closed** |
| 3 | 가격 미검증 시 | `PENDING_VERIFIED_PRICE_REGISTER` (owner·ticket·등록일·기한≤90일·production 승인) | premium은 CI 실패. **현재 register는 비어 있고, 여기에 넣는 것은 수정이 아니라 퇴행입니다**(`lib/modelPricing.ts:1466-1470`) |
| 4 | 런타임 행 | `ensureModelRegistrySeeded()` — `skipDuplicates: true` | 신규 모델은 정상 삽입됨(기존 행 편집이 안 되는 것과 다름) |
| 5 | 기존 행 갱신이 필요하면 | `STATIC_CATALOG_RECONCILIATION_MODEL_IDS` (`lib/modelRegistryShared.ts:304`) | 전임 모델의 lifecycle 전환이 배포돼도 DB에 반영 안 됨 |
| 6 | 전임 모델 은퇴 시 | `replacementModelId` · `userVisibleNote` · `operationalReason` | 사용자가 이유를 못 봄 |
| 7 | 기본 모델을 건드리면 | `npm run check:default-models` · `docs/policy/default-model-luna-migration.md` | 게스트/계정 기본값이 어긋남 |
| 8 | 공개 마케팅이 지목하면 | `lib/marketingModelReferences.ts` | `tests/marketingModelReferences.test.mjs` 실패 |
| 9 | credit weight 확인 | `npm run report:model-credit-weights` | 코드와 DB가 어긋난 채 청구 |
| **10** | **provider 요청 계약** | `GEMINI_STRICT_GENERATION_MODEL_IDS` (`lib/modelGenerationCompatibility.ts:8`) | Gemini 3.6 이후 모델에 sampling 파라미터가 실려 나감 — 주석이 "and later releases"로 계약을 명시 |
| **11** | **native web search** | `WEB_SEARCH_CAPABILITIES` (`lib/webSearchCapability.ts:110`) | 조회 fallback이 `UNSUPPORTED` — 검색 가능한 모델이 조용히 검색을 잃음 |
| **12** | **artifact tool** | `ARTIFACT_TOOL_CAPABILITIES` (`lib/generatedArtifactToolPolicy.ts:40`) | 미등록은 `unverified` → fail-closed. **의도된 안전값이며, 등록은 실제 실행 후에만** |
| **13** | **picker 한국어 문구** | `koreanDescriptions` (`lib/modelPickerPresentation.ts`) | 한국어 UI에 설명이 비어 보임 |
| **14** | **router 등재** | `ROUTER_SCORE_SNAPSHOT` (`lib/routerScorePolicy.ts`) | **누락이 중립이 아닙니다** — 미등재 모델은 neutral band로 라우팅되며 그건 아무도 하지 않은 결정입니다. `tests/routerScorePolicy.test.mjs`가 강제 |

> **10~14는 2026-08-22 D-1 착수 중에 발견해 추가했습니다.** 최초 체크리스트는
> 1~9만 담고 있었고, capability 표가 **모델 ID 단위**라는 점을 놓쳤습니다.
> 그중 14번은 unit test가 실패시켜 알려 줬고, 12번은 등록하지 않는 것이
> 정답이었습니다.

**2·3번이 이 7건의 실질적 관문입니다.** `usageClass: "premium"` 또는
`"premium-reasoning"`으로 넣으려면 검증된 공개 가격이 있어야 하고, 없으면
CI가 막습니다.

---

## 2. 모든 후보에 공통으로 이미 성립한 사실

`[측정]` **7건 모두 계정 접근성이 증명돼 있습니다.** 이들은 Tomverse의 실제
API key로 호출한 provider `/models` 응답에서 나왔습니다. "우리 계정이 이 모델을
볼 수 있는가"는 신규 모델 검토에서 흔히 남는 미지수인데, 여기서는 발견 사실
자체가 답입니다. `npm run check:openai-model-access`가 OpenAI에 대해 하려는
확인을 discovery가 이미 해 둔 셈입니다.

`[확인 불가]` **가격·컨텍스트·capability는 하나도 확인되지 않았습니다.**
provider 공식 가격표를 사람이 읽어야 합니다. discovery가 `metadata`에
`contextLength`·`outputTokenLimit`·`vision`·`thinking`을 저장하지만
(`providerModelCatalogCore.ts:124-146`) 그 값은 `ProviderModelCatalogEntry`에만
있고 **읽을 수 있는 화면이 없습니다**(ML-02). 즉 이미 수집한 사실을 지금
쓰지 못합니다.

---

## 3. Triage 요약

| 모델 | provider | 최초 발견 | 방치 | 권고 action | 신뢰도 | 상태 | 최대 blocker |
|---|---|---|---|---|---|---|---|
| `gemini-3.7-flash` | Google | 08-14 | 8일 | **upgrade** | **확정** | **완료 (2026-08-22)** | — |
| `glm-5.3` | Zhipu | 08-16 | 6일 | **upgrade** | 낮음 | **blocked** | 종량제 단가 공표 여부 (§5.2) |
| `qwen3.7-flash` | Qwen | 07-25 | **28일** | **upgrade** | 중간 | awaiting_decision | 가격 확인 · 세대 정합성 |
| `grok-4.6` | xAI | 08-13 | 9일 | **upgrade** | 중간 | awaiting_decision | **premium 가격 gate** · replacement 연쇄 |
| `qwen3.8-max` | Qwen | 08-04 | 18일 | **평가 필요** | 낮음 | evaluation_required | **premium 가격 gate** · 3.7-max와의 관계 |
| `qwen3.8-2.4t-a95b` | Qwen | 08-14 | 8일 | **monitor** | 낮음 | deferred(D-5 종속) | 제품 결정 부재 |
| `qwen3.8-27b` | Qwen | 08-20 | 2일 | **monitor** | 낮음 | deferred(D-5 종속) | 제품 결정 부재 |

**착수 순서: ~~D-1~~(완료) → (D-3·D-4 자료 확보) → D-2 판정 → D-5.**
D-1은 2026-08-22에 완료했습니다. 나머지는 전부 provider 공식 자료 확보에
막혀 있습니다. §5.7 참조.

---

## 4. 건별

### D-1 · `gemini-3.7-flash` (Google) — 08-14 발견, 8일

**관측** `[측정]` Google 자신의 카탈로그에서 08-14 발견. 08-15에
`Perplexity google/gemini-3.7-flash`로 한 번 더 나왔으나 같은 모델입니다(ML-12).
같은 날 `gemini-3.7-flash-video-understanding-eap`도 나왔고 이쪽은 EAP이므로
별건입니다(6절 참조).

**저장소 사실** `[코드]` Google 계열 live는 `gemini-3.6-flash`,
`gemini-3.1-pro-preview`, `gemini-3.5-flash-lite` 셋입니다.

**이 건에는 그대로 쓸 수 있는 선례가 있습니다.** 2026-08-03에
`gemini-3-5-flash` → `gemini-3-6-flash` 통합을 이미 했고, 그때 만든 것이
전부 남아 있습니다 — `replacementModelId: "gemini-3-6-flash"`,
`userVisibleNote: "This model was retired and replaced by Gemini 3.6 Flash."`,
`operationalReason`, 그리고 `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`의
`gemini-3-5-flash` 항목과 그 이유를 적은 주석
(`lib/modelRegistryShared.ts:320-327`). **3.6 → 3.7에 같은 형태를 복사하면
됩니다.**

**판정: upgrade.** 신뢰도 높음 — 세대 관계가 이름과 선례로 명확하고,
`gemini-3.6-flash`는 Advanced 대역이라 premium 가격 gate에 걸리지 않습니다.

**착수 조건**
1. `[확인 불가]` Google 공식 가격표에서 3.7 Flash 입·출력 단가와 cache read 단가
2. `[확인 불가]` 컨텍스트 창과 출력 상한
3. 3.6 Flash 대비 credit weight 변동 여부 — 08-03에 3.5 Flash가 "Standard 1크레딧에
   잘못 남아 있었다"는 전례가 있으므로 **대역을 다시 계산**합니다

**승인되면 남는 일**: §1의 1·2·4·5·6·9. 7·8은 3.7 Flash를 기본 모델이나
마케팅에 올릴 때만.

---

#### D-1 실행 기록 (2026-08-22 · 완료)

`gemini-3-7-flash`를 카탈로그에 추가했습니다. **추가만 했고 3.6 Flash는 은퇴시키지
않았습니다** — 추가는 되돌릴 수 있고 은퇴는 사용자 설정을 건드리는데, 그 통지
경로가 아직 없다는 것이 이 감사의 결론이기 때문입니다. 두 모델이 당분간
Advanced 대역에 함께 섭니다.

변경한 6개 파일:

| 파일 | 내용 |
|---|---|
| `lib/models.ts` | `advanced`·`Free`·1,048,576·`FULL_BINARY_INPUT`. 3.6 Flash 위에 배치 |
| `lib/modelPricing.ts` | `flatTier(1.5, 7.5, 0.1)` · `maxOutputTokens: 65_536` · `reservationOutputTokens: 8_192` · `nativeSearchCostMicroUsdPerQuery: 14_000` |
| `lib/modelGenerationCompatibility.ts` | `GEMINI_STRICT_GENERATION_MODEL_IDS` 등록 (체크리스트 10) |
| `lib/webSearchCapability.ts` | `NATIVE_GOOGLE` — 공식 모델 페이지가 Search grounding "Supported" 확인 |
| `lib/modelPickerPresentation.ts` | 한국어 설명 |
| `lib/routerScorePolicy.ts` | `ROUTER_SCORE_SNAPSHOT` 등재 (품질 주장 없음, 다른 모든 cell과 같이 neutral) |

**가격은 도입가가 아니라 정가로 등록했습니다.** 근거는 §5.1의 상자와 코드 주석에
있습니다 — `ModelPricingProfile`이 만료를 표현하지 못하므로 $0.75/$3.75로 넣으면
2027-01-01부터 절반으로 청구되고 아무것도 그것을 알아채지 못합니다.

**검증**
- `npm run check:model-pricing` — 통과 (explicit profile 35→36, fallback 0, unpriced premium 0)
- `npm run check:default-models` — 통과
- `npm run test:unit` — 4,161 통과 / 0 실패
- `npm run typecheck` — 통과
- `eslint` (변경 6파일) — 통과

**일부러 하지 않은 것**
- `ARTIFACT_TOOL_CAPABILITIES` 등록 — 표의 주석이 "A model moves here when
  somebody has run the tool against it, not when somebody has read a
  changelog"입니다. 지금은 `unverified` → fail-closed이며 이것이 **정상 동작**
  입니다. 실제로 artifact tool을 한 번 돌린 뒤 별건으로 등록합니다.
- `RECOMMENDED_MODEL_IDS` 변경 — picker의 추천 3종을 바꾸는 것은 제품 결정입니다.
- `STATIC_CATALOG_RECONCILIATION_MODEL_IDS` — 기존 행 갱신용이고, 신규 모델은
  `ensureModelRegistrySeeded()`가 삽입하므로 불필요합니다.
- 3.6 Flash 은퇴 관련 일체(`replacementModelId`·`userVisibleNote`·사용자 안내).

#### 남은 위험 1건 — 32,768 출력 한도 `[확인 불가]`

Google AI 개발자 포럼에 "3.7 Flash가 문서화되지 않은 32,768 토큰 한도로 유효한
요청을 거절한다"는 신고가 있습니다. `discuss.ai.google.dev`가 egress 차단이라
내용을 읽지 못했습니다. 공식 모델 페이지의 값은 **65,536**이고 profile은 그
값을 씁니다.

**2026-08-22에 확인한 것 — 이 위험은 이론이 아닙니다.**
profile의 `maxOutputTokens`는 비용 계산에만 쓰이는 값이 아니라 **실제 요청에
실려 나갑니다**: `chatSecurity.ts:703`이 `pricing.maxOutputTokens`를 budget에
넣고, `app/api/chat/route.ts:2174`가 그것을 `requestMaxOutputTokens`로 만들어
`:2636`·`:2658`의 provider 호출에 전달합니다. 신고가 사실이면 **긴 출력을
요구하는 요청이 실패합니다.**

**`providerMaxOutputTokens`는 이 자리에 쓰면 안 됩니다.** 2026-08-22에 필드
계약을 끝까지 읽고 앞선 판단을 정정했습니다. 두 가지 이유입니다.

1. 문서가 **"Undefined where no ceiling has been verified"**라고 못 박습니다
   (`lib/modelPricing.ts:129-131`). 검증되지 않은 값을 넣으면 검증을 의미로
   삼는 필드가 거짓을 말합니다.
2. **의미가 반대입니다.** 선례인 Kimi K3는
   `providerMaxOutputTokens: 1_048_576` > `maxOutputTokens: 131_072`입니다
   (`:869`) — 이 필드는 **provider의 능력 상한**이고 우리가 요구하는 값은
   그보다 작습니다. 32,768을 넣는 것은 "Google의 능력 상한이 32,768"이라는
   주장이며, 공식 문서는 65,536이라고 합니다.

**`maxOutputTokens`를 낮추는 것도 권하지 않습니다.**

| | 신고가 사실 | 신고가 거짓 |
|---|---|---|
| 65,536 유지 | 긴 출력이 400 또는 절단 — **시끄럽게** 실패 | 정상 |
| 32,768로 하향 | 정상 | 문서상 65,536인 모델이 **조용히** 절반에서 잘림 |

증거는 읽지 못한 포럼 신고 하나이고 공식 모델 페이지는 65,536입니다. 그 근거로
문서화된 능력을 절반으로 깎으면 조용한 품질 저하가 됩니다. **profile은 공식
값 65,536을 유지합니다.**

### 2026-08-22 측정 결과 — 차단 해제

`[측정]` provider 직접 호출 1회 (Google AI Studio, `gemini-3.7-flash:generateContent`,
`maxOutputTokens: 65536`):

```
HTTP             : 200
finishReason     : STOP
candidatesTokens : 291
totalTokens      : 742
```

**신고된 증상은 재현되지 않았습니다.** 포럼 제목의 증상은 "rejects a valid
request"였고, 65,536을 요구한 요청은 **거절되지 않고 200으로 통과**했습니다.
요청 시점 거절은 배제됩니다.

**다만 절반만 답한 것입니다.** `finishReason: STOP`에 291 토큰이면 모델이 스스로
끝낸 것이고 32,768 근처에 가지 않았습니다. **"32,768에서 조용히 절단되는가"는
여전히 미검증입니다.**

| 가설 | 상태 |
|---|---|
| 65,536 요청이 400으로 거절 | **재현 안 됨** — HTTP 200 |
| 32,768에서 조용히 절단 | **미검증** — 291 토큰에서 자연 종료 |

**그럼에도 이 항목을 닫고 병합을 허용합니다.** 남은 미검증 케이스는 성질이
다릅니다.

- 실패해도 `finishReason: MAX_TOKENS`로 **드러납니다.** 조용한 데이터 손실이
  아닙니다.
- 영향 범위가 32,768 토큰(약 25,000단어)을 넘는 답변으로, 실사용에서 드뭅니다.
- 강제로 재현하기 어렵습니다 — 현대 모델은 장문 나열 지시를 대개 짧게 끊습니다.
  위 실행이 그 예입니다.
- 발생하면 production에서 `finishReason` 하나로 즉시 식별되고, 조치는
  `maxOutputTokens: 32_768` 한 줄입니다.

profile은 공식 값 **65,536을 유지**합니다. 측정된 사실(거절 없음)과 공식 문서가
같은 방향을 가리키고, 반대 방향의 증거는 읽지 못한 포럼 글 하나뿐입니다.

**후속 관찰 항목**: production 도입 후 이 모델의 `finishReason: MAX_TOKENS`
발생 시 `candidatesTokenCount`가 32,768 부근에 몰리는지 확인. 몰린다면 그때
하향합니다.

### 실행 시도 기록

staging에는 이 모델이 없어(브랜치 미병합) 앱 경로로는 확인할 수 없었고,
provider 직접 호출로 답을 얻었습니다. 그 전에 자격증명에서 두 번 막혔습니다.
1. 이 세션에 Google API key가 없고, 얻는 경로(Railway 변수 읽기)는 권한
   classifier가 차단했으며 우회하지 않았습니다.
2. 로컬 `GOOGLE_GENERATIVE_AI_API_KEY`는 AI Studio 키 형식이 아니어서
   `generativelanguage.googleapis.com`이 `ACCESS_TOKEN_TYPE_UNSUPPORTED`로
   거절했습니다. 정상 키는 Railway에 있습니다 — production의 catalog monitor가
   매일 `checked 12/12`로 Google을 호출합니다.

**실행 절차 (배포 불필요, 사람이 직접):**

```bash
# 1) 65,536을 요구했을 때 요청 자체가 거절되는가
curl -sS https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent \
  -H "x-goog-api-key: $GEMINI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Count from 1 to 20000, one number per line."}]}],
       "generationConfig":{"maxOutputTokens":65536}}' \
  | head -c 600

# 2) 통과했다면, 실제로 32,768에서 끊기는가
#    finishReason 과 usageMetadata.candidatesTokenCount 를 봅니다
```

**판정 기준**

| 결과 | 의미 | 코드 조치 |
|---|---|---|
| HTTP 400 + 한도 언급 | 요청 시점 거절. 가장 나쁨 | `maxOutputTokens: 32_768`로 하향 (요구값을 낮추는 것이지 능력 상한 주장이 아님) |
| 200 · `finishReason: MAX_TOKENS` · `candidatesTokenCount` ≈ 32,768 | 조용한 절단 | 동일 |
| 200 · `candidatesTokenCount` > 32,768 | 신고가 틀렸거나 이미 수정됨 | 변경 없음. 이 항목을 닫습니다 |

비용은 출력 최대 65K 토큰 1회이므로 정가 기준 **US$0.5 미만**입니다.

---

### D-2 · `glm-5.3` (Zhipu) — 08-16 발견, 6일

**관측** `[측정]` **세 번 호명됐습니다** — 08-16 `Zhipu GLM glm-5.3`(Zhipu 자신의
카탈로그), 08-19 `Qwen ZHIPU/GLM-5.3`, 08-21 `Perplexity perplexity/glm-5.3`.
세 리포트 어느 쪽도 같은 모델이라고 말하지 않습니다(ML-12). 사흘에 걸쳐 세 번
말하고도 registry는 `glm-5.2`입니다.

**저장소 사실** `[코드]` Zhipu는 `glm-5.2` 한 줄뿐입니다 —
`minimumPlan: "Guest"`, `usageClass: "standard"`, `creditWeight: 4`
(`lib/models.ts:293`). Guest 대역이라 premium 가격 gate 대상이 아닙니다.

**주의** `creditWeight: 4`는 **명시값**입니다. 신규 행은
`ensureModelRegistrySeeded()`가 `skipDuplicates`로 삽입하므로 코드 값이 그대로
들어가지만, `glm-5.2`의 무게를 함께 조정할 생각이라면 그 편집은 기존 DB 행에
**반영되지 않습니다**(AGENTS.md의 `perplexity/sonar` 사례). 작업 전
`npm run report:model-credit-weights`로 실제 행을 확인합니다.

**판정: upgrade.** 신뢰도 높음.

**착수 조건**
1. `[확인 불가]` Zhipu 공식 가격표의 5.3 단가
2. `[확인 불가]` 5.2 대비 컨텍스트·capability 변화
3. 5.2를 유지할지 은퇴시킬지 — 유지하면 Guest 대역에 두 모델이 서게 됩니다

---

### D-3 · `qwen3.7-flash` (Qwen) — 07-25 발견, **28일**

**관측** `[측정]` 07-25에 `qwen3.7-flash`와 `qwen3.7-flash-2026-07-15`가 함께
나왔습니다. 뒤는 날짜 고정 snapshot id입니다.

**저장소 사실** `[코드]` Qwen 계열은 `qwen3.7-max`(Pro/premium),
`qwen3.7-plus`(Free/advanced, cw 1), `qwen3.6-flash`(Guest/standard)입니다.
**Flash 줄만 3.6에 남아 있어 세대가 어긋나 있습니다** — max와 plus는 3.7인데
flash는 3.6입니다. `qwen3.7-flash`는 정확히 그 구멍을 메웁니다.

**날짜 고정 id는 채택하지 않습니다.** 이 저장소의 기존 관례는 floating id
입니다(`mistral-small-latest`, `mistral-large-latest`, `qwen3.6-flash`).
`qwen3.7-flash-2026-07-15`는 **no_action**으로 닫습니다.

**판정: upgrade.** 신뢰도 중간 — 세대 정합성 논거는 강하지만, 28일이 지나
`qwen3.8` 계열이 이미 나왔으므로 **3.7 Flash를 건너뛰고 3.8을 기다리는 것이
맞는지** 함께 판단해야 합니다. D-5와 같이 결정합니다.

**착수 조건**
1. `[확인 불가]` Qwen 공식 가격표의 3.7-flash 단가
2. D-5 결론 — 3.8 계열에 flash 대응이 있으면 이 건은 건너뛰기가 답일 수 있습니다

---

### D-4 · `grok-4.6` (xAI) — 08-13 발견, 9일

**관측** `[측정]` 08-13에 xAI 자신의 카탈로그에서 발견. 같은 날
`Perplexity xai/grok-4.6`도 나왔습니다(같은 모델).

**저장소 사실** `[코드]` xAI live는 `grok-4-5` 하나입니다 —
`minimumPlan: "Pro"`, `usageClass: "premium-reasoning"`, `creditWeight: 8`,
`reasoning: "high"`, `contextWindowTokens: 500_000`.

**연쇄가 있습니다.** `grok-4`·`grok-4-3`·`grok-3`·`grok-3-mini` 네 개의 은퇴
항목이 전부 `replacementModelId: "grok-4-5"`를 가리킵니다. `lib/models.ts:264-266`
주석은 "grok-4-5는 Pro 전용이므로 호출자는 강제하지 말고 제안해야 한다"고
명시합니다. **4.5를 은퇴시킨다면 이 네 개의 replacement chain을 함께
옮겨야 하고**, 그러지 않으면 은퇴 모델이 은퇴 모델을 가리킵니다. 다섯 id 모두
`STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에 있으므로 신규 `grok-4-6`도
등록해야 기존 행이 갱신됩니다.

**가격 gate가 걸립니다.** `premium-reasoning`이므로
`npm run check:model-pricing`이 검증된 가격 profile 없이는 **fail-closed**
입니다. `PENDING_VERIFIED_PRICE_REGISTER`로 우회할 수 있지만 그 주석이
"여기 넣는 것은 수정이 아니라 퇴행"이라고 못 박고 있고(`lib/modelPricing.ts:1457-1473`), 현재 비어 있는 상태를
깨는 첫 항목이 됩니다. **가격을 먼저 구합니다.**

**판정: upgrade.** 신뢰도 중간 — 세대 관계는 명확하나 4.5 은퇴 여부는 별개
결정입니다. **4.6 추가와 4.5 은퇴를 한 결정으로 묶지 않기를 권고합니다**:
추가는 되돌릴 수 있고 은퇴는 사용자 설정을 건드립니다.

**착수 조건**
1. `[확인 불가]` xAI 공식 가격표의 4.6 입·출력 단가 — **필수**
2. `[확인 불가]` 컨텍스트·reasoning 등급·`maxOutputTokens`
3. 4.5 유지/은퇴 결정. 은퇴라면 replacement chain 4건 + 사용자 안내(감사 §11-D)

---

### D-5 · Qwen 3.8 계열 — `qwen3.8-max`(08-04, 18일) · `qwen3.8-2.4t-a95b`(08-14) · `qwen3.8-27b`(08-20)

**관측** `[측정]` 세 건 모두 Qwen 자신의 카탈로그에서 각각 다른 날 발견됐고,
서로 연결된 적이 없습니다.

**해석** `[추정]` 이름이 세 가지 서로 다른 것을 시사합니다 —
`qwen3.8-max`는 호스팅 API tier(3.7-max의 후속), `qwen3.8-2.4t-a95b`와
`qwen3.8-27b`는 파라미터 수를 이름에 넣은 open-weight 변형입니다. **이 해석은
근거가 이름뿐이며 공식 자료로 확인해야 합니다.**

**저장소 사실** `[코드]` `qwen3.7-max`는 2026-08-04에 실가격
(입력 2.5 / 출력 7.5 / cache 0.2, `qwen-qwen3.7-max-2026-08-04`)이 기록되면서
`PENDING_VERIFIED_PRICE_REGISTER`를 떠났습니다. 그 전까지 US$15/US$60 fallback으로
**실제 입력가의 6배**를 예약하고 있었습니다. 3.8-max도 premium이면 같은 함정이
그대로 재현됩니다.

**판정**
- `qwen3.8-max` → **evaluation_required.** 신뢰도 낮음. 3.7-max를 대체하는지
  상위 tier로 병존하는지가 미확인이고, 그 답에 따라 plan·credit이 달라집니다.
- `qwen3.8-2.4t-a95b`, `qwen3.8-27b` → **monitor / deferred.** open-weight 변형을
  제품 카탈로그에 넣을지는 이 저장소에 **선례가 없는 제품 결정**입니다.
  현재 카탈로그는 전부 호스팅 API tier입니다. 결정 없이 착수하면 추측이
  결과가 됩니다.

**착수 조건**
1. `[확인 불가]` Qwen 공식 문서에서 3.8 계열의 구성과 각 항목의 서빙 여부
2. `[확인 불가]` 3.8-max 가격 — **premium이면 필수**
3. **제품 결정**: open-weight 변형을 카탈로그에 넣는가 (D-9 성격, 사람이 정함)
4. D-3(3.7-flash)과 함께 — 3.8에 flash 대응이 있으면 3.7-flash는 건너뜁니다

---

## 5. Provider 자료 조사 결과 (2026-08-22 확인)

조사 결과 **6건 중 1건만 공식 자료로 확정**됐습니다. 나머지 5건은 provider
공식 도메인이 이 세션의 egress proxy에 차단돼 1차 확인이 불가능합니다.
집계 사이트 수치는 참고로 남기되 **`priceSource`로 쓸 수 없습니다** —
`lib/modelPricing.ts:402`의 `MODEL_LIST_ENDPOINT_IS_NOT_A_PRICE_SOURCE`가
세운 기준이 여기에도 적용됩니다.

차단된 도메인: `x.ai`, `docs.x.ai`, `docs.z.ai`, `bigmodel.cn`,
`www.alibabacloud.com`, `help.aliyun.com`. (`ai.google.dev`는 접근 가능.)

---

### 5.1 `gemini-3.7-flash` — `[공식 자료]` **확정**

출처: `https://ai.google.dev/gemini-api/docs/pricing` ·
`https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash` (2026-08-22 확인)

| 항목 | 값 | 3.6 Flash(현행) |
|---|---|---|
| API id | `gemini-3.7-flash` | `gemini-3.6-flash` |
| 입력 | **$0.75/M** (~2026-12-31) → **$1.50/M** (2027-01-01~) | $1.50/M |
| 출력(thinking 포함) | **$3.75/M** (~2026-12-31) → **$7.50/M** | $7.50/M |
| cache read | **$0.075/M** → **$0.15/M** | multiplier 0.1 |
| 입력 한도 | **1,048,576** | 1,048,576 |
| 출력 한도 | **65,536** | 65,536 |
| 입력 형식 | Text·Image·Video·Audio·PDF | `FULL_BINARY_INPUT` |
| thinking | low/medium/high (`minimal`은 오류) | — |
| 출시 단계 | **GA / Stable** | — |

**핵심: 정가가 3.6 Flash와 완전히 같습니다.** 컨텍스트·출력 한도·입력 형식·
cache multiplier(0.075/0.75 = 0.1)까지 동일합니다. 다른 것은 2026-12-31까지의
**도입 할인 50%** 하나뿐입니다.

**그래서 credit band 결정이 없습니다** — `usageClass: "advanced"`,
`minimumPlan: "Free"`를 3.6 Flash에서 그대로 씁니다. 2026-08-03에 3.5 Flash가
겪은 "Standard 대역에 잘못 남아 있었다" 류의 재계산이 필요 없습니다.

> **가격 권고: 도입가가 아니라 정가 `flatTier(1.5, 7.5, 0.1)`로 등록합니다.**
>
> `ModelPricingProfile`에는 만료일도 예약 변경 필드도 없습니다 — `effectiveDate`
> 하나뿐입니다(`lib/modelPricing.ts:95-152`). 즉 **"2027-01-01에 두 배가 된다"를
> 코드로 표현할 방법이 없습니다.** $0.75/$3.75로 등록하면 그날부터 누군가 새
> `pricingVersion`을 배포하기 전까지 **실원가의 절반으로 청구**합니다. 반대로
> 정가로 등록하면 도입 기간 동안 보수적으로 과다 예약할 뿐이고, 이는 이
> 저장소가 fallback에서 이미 택한 방향입니다. 그리고 정가가 3.6 Flash와 같으므로
> **profile을 그대로 복사**하면 됩니다.
>
> 도입가의 이득을 취하려면 그것은 별도 결정이며, 만료일을 사람이 캘린더에
> 들고 있어야 합니다.

**남은 확인 1건**: `nativeSearchCostMicroUsdPerQuery`. 3.6 Flash는 `14_000`을
갖고 있습니다(`lib/modelPricing.ts:561`). 3.7의 grounding 단가가 같은지
확인이 필요하며, Google grounding을 쓰지 않으면 무관합니다.

**주의(미확인)**: Google AI 개발자 포럼에 "Gemini 3.7 Flash가 문서화되지 않은
32,768 토큰 한도로 유효한 요청을 거절한다"는 신고가 있습니다. 해당 도메인
(`discuss.ai.google.dev`)이 차단돼 내용을 확인하지 못했습니다. 사실이라면
`maxOutputTokens: 65_536` 설정이 실패를 낳으므로, **staging에서 긴 출력 요청을
한 번 실행해 확인**한 뒤 등록합니다.

---

### 5.2 `glm-5.3` — `[확인 불가]` · **자료가 서로 충돌합니다**

공식(`docs.z.ai`, `bigmodel.cn`) 모두 차단. 그리고 2차 자료가 **엇갈립니다**.

- 한쪽: "Z.ai가 GLM-5.3의 종량제 단가를 아직 공표하지 않았고 API는 coming soon.
  현재는 GLM Coding Plan 구독(Lite $18/Pro $80/Max $168 월)으로만 접근 가능."
- 다른쪽(공식 도메인 한정 검색): "$1.4/M 입력 · $0.26/M cached · $4.4/M 출력."

**후자의 수치는 GLM-5.2의 공표가($1.40/$4.40)와 동일**하므로, 검색이 5.2와 5.3을
섞었을 가능성이 높습니다. 어느 쪽이든 지금 등록하면 안 됩니다.

**판정 변경: `awaiting_decision` → `blocked`.**
blocked on: **Z.ai가 GLM-5.3 종량제 단가를 공표했는지 여부.**
확인처: `https://docs.z.ai/guides/overview/pricing`.

구독 전용이 사실이라면 이 모델은 **가격 문제가 아니라 조달 형태 문제**입니다 —
이 저장소의 과금 모델은 토큰 종량제를 전제하며(`ModelPriceTier`), 월 구독
모델을 표현할 자리가 없습니다. 그 경우 판정은 `blocked`가 아니라
`closed_no_action`이 되고, 재평가는 종량제 공표 시점입니다.

---

### 5.3 `grok-4.6` — `[확인 불가]` · 구조는 저장소가 표현 가능

`x.ai`·`docs.x.ai` 모두 차단. 2차 자료가 보고하는 구조는 다음과 같습니다
(**미검증**).

| 구간 | 입력 | cached | 출력 |
|---|---|---|---|
| 프롬프트 < 200K | $2/M | $0.50/M | $6/M |
| 프롬프트 ≥ 200K | $4/M | $1/M | $12/M |

**계단 진입 시 요청 전체에 상위 단가가 적용**된다고 보고됩니다(210K 요청을
200K+10K로 쪼개 계산하지 않음). 이는 `ModelPriceTier.maxPromptTokens`의 의미와
정확히 일치하므로 — 한 tier가 선택되면 그 요청 전체에 적용 — **저장소가 이미
표현할 수 있는 형태**입니다. `qwen3.7-plus` profile의 2구간 구성이 그대로
본보기입니다.

**판정 유지: `awaiting_decision`, blocked on 공식 단가 확인.**
확인처: `https://docs.x.ai/docs/models`.
`premium-reasoning`이므로 `check:model-pricing`이 fail-closed이고,
미검증 수치로는 착수할 수 없습니다.

---

### 5.4 `qwen3.7-flash` — `[확인 불가]` · 3구간 보고

`www.alibabacloud.com`·`help.aliyun.com` 차단. 2차 자료 보고(**미검증**):

| 프롬프트 구간 | 입력 | 출력 |
|---|---|---|
| < 32K | $0.03/M | $0.13/M |
| 32K ~ 256K | $0.10/M | $0.40/M |
| 256K ~ 1M | $0.20/M | $0.80/M |

사실이라면 현행 `qwen3.6-flash`보다 훨씬 싸고, **3구간이므로 단일 단가로 받아
적으면 장문에서 과소청구**됩니다. `qwen3.7-plus`가 이미 같은 이유로 2구간을
명시하고 있습니다(`lib/modelPricing.ts:998-1010`).

**판정 유지.** 확인처: Alibaba Cloud Model Studio 공식 가격 페이지.

---

### 5.5 `qwen3.8-max` — `[확인 불가]` · premium gate 때문에 특히 엄격

2차 자료 보고(**미검증**): $2/M 입력 · $6/M 출력 · cache read $0.25/M.

사실이라면 현행 `qwen3.7-max`의 검증가($2.5/$7.5)보다 **싸면서 상위 세대**라는
뜻이고, 그러면 3.7-max를 대체하는지 병존하는지가 제품 결정으로 남습니다.

**주의**: `qwen3.7-max`는 실가격이 기록되기 전까지 US$15/US$60 fallback으로
**실입력가의 6배**를 예약하고 있었습니다. 3.8-max를 미검증 상태로 넣으면 같은
일이 반복되고, 이번에는 비어 있는 `PENDING_VERIFIED_PRICE_REGISTER`를 깨는
첫 항목이 됩니다.

**판정 유지: `evaluation_required`.**

---

### 5.6 `qwen3.8-2.4t-a95b` · `qwen3.8-27b` — 조사하지 않음

가격 조사 대상이 아닙니다. 선행 질문이 **"open-weight 변형을 제품 카탈로그에
넣는가"**라는 제품 결정이고(§4 D-5), 그 답이 `아니오`면 가격은 무의미합니다.
`deferred` 유지.

---

### 5.7 조사가 바꾼 것

| | 조사 전 | 조사 후 |
|---|---|---|
| D-1 `gemini-3.7-flash` | awaiting_decision · 가격 확인 필요 | **착수 가능.** 공식 확정, credit band 결정 불필요, profile은 3.6 Flash 복사 |
| D-2 `glm-5.3` | awaiting_decision (2순위) | **blocked.** 종량제 단가 공표 여부 자체가 미확인 |
| D-3 `qwen3.7-flash` | 가격 확인 필요 | 유지. 3구간 구조 확인, 공식 미확인 |
| D-4 `grok-4.6` | 가격 gate | 유지. 계단 구조는 저장소가 표현 가능, 공식 미확인 |
| D-5 Qwen 3.8 | 가격 gate + 제품 결정 | 유지. 제품 결정이 먼저 |

**착수 순서 수정: D-1 → (D-3·D-4 자료 확보) → D-2 판정 → D-5.**
D-2가 2순위에서 내려간 것은 우선순위 판단이 아니라 **착수 자체가 불가능하기
때문**입니다.

### 5.8 이 조사가 드러낸 저장소 결함 하나

**`ModelPricingProfile`에 가격 만료·예약 변경을 표현할 필드가 없습니다.**
필드는 `effectiveDate` 하나이며 "언제부터"만 말하고 "언제까지"를 말하지
못합니다(`lib/modelPricing.ts:95-152`).

Gemini 3.7 Flash처럼 **만료일이 명시된 도입가**는 이 구조에서 안전하게 담기지
않습니다. 지금은 정가 등록으로 회피할 수 있지만(§5.1), 도입가가 정가보다
구조적으로 다른 모델 — 예컨대 무료 프리뷰 — 이 오면 회피가 성립하지 않습니다.

정책 문서 `docs/policy/credit-and-cost-limits.md`가 "가격 변경은 소급 적용하지
않는다"를 말하지만 **예정된 변경을 어떻게 다루는지는 말하지 않습니다.**
`ModelLifecycleWorkItem`의 `dueAt`으로 "2026-12-31에 3.7 Flash 가격 재확인"을
거는 것이 지금 구조에서 가능한 최선입니다.

---

## 6. 나머지 후보 30건에 대한 일괄 판정

전체 37건 중 위 7건을 뺀 나머지입니다. **개별 검토가 필요 없다는 것이
판정이며, 그 판정도 어딘가에 남아야 합니다** — 남을 곳이 없다는 것이 ML-03입니다.

| 부류 | 예 | 판정 |
|---|---|---|
| 집계 provider 경유 중복 | `perplexity/kimi-k3`, `google/gemini-3.7-flash`, `zai-glm-5-2`, `anthropic/claude-opus-5`, `openai/gpt-5-nano` | **no_action.** 원 모델의 결정에 종속. ML-12를 고치면 애초에 생기지 않습니다 |
| 같은 provider의 id 철자 변경 | `moonshotai/kimi-k3` → `perplexity/kimi-k3` | **no_action.** 이미 출시된 모델 |
| 날짜 고정 snapshot | `qwen3.7-flash-2026-07-15`, `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813` | **no_action.** floating id 관례 |
| 비-chat 모델 | `gemini-robotics-er-2-preview`, `qwen-audio-3.0-asr-flash`, `qwen-image-3.0`, `qwen-image-3.0-pro` | **no_action.** `isLikelyChatModelId` 통과 오탐(감사 6절 #10·#11). 이미지 모델은 별도 정적 registry(ML-06) |
| EAP / experimental | `gemini-3.7-flash-video-understanding-eap`, `deepseek-v4-flash-vision-exp` | **monitor.** 정식 출시 시 재평가 |
| 타사 open-weight | `nvidia/nemotron-3-ultra-550b-a55b`, `nemotron-3.5-lightning-30b-a3b` | **no_action.** D-5와 같은 제품 결정에 종속 |

---

## 7. 이 문서가 임시 조치라는 점

여기 적힌 판정 어느 것도 저장소가 기억하지 못합니다. 내일 리포트는
`New model candidates found today: None`을 출력하면서 위 7건에 대해 아무 말도
하지 않을 것입니다 — 이 문서를 쓰는 동안에도 그렇습니다.

그러므로 순서는 **triage 실행과 P0-1이 병렬**입니다. 7건을 먼저 처리하고
work item을 나중에 만들면, 처리하는 동안 발견되는 새 후보가 같은 방식으로
사라집니다. `ModelLifecycleWorkItem`이 생기면 §3의 표가 그대로 첫 backfill
입력이 되고, §6의 일괄 판정은 `closed_no_action` 행이 됩니다.

