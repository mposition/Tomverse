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
| D-1 | Gemini Flash 세대 이동 | `gemini-3.7-flash` | upgrade · **선례 있음** |
| D-2 | Zhipu GLM 세대 이동 | `glm-5.3` | upgrade |
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
| `gemini-3.7-flash` | Google | 08-14 | 8일 | **upgrade** | 높음 | awaiting_decision | 가격 확인 |
| `glm-5.3` | Zhipu | 08-16 | 6일 | **upgrade** | 높음 | awaiting_decision | 가격 확인 |
| `qwen3.7-flash` | Qwen | 07-25 | **28일** | **upgrade** | 중간 | awaiting_decision | 가격 확인 · 세대 정합성 |
| `grok-4.6` | xAI | 08-13 | 9일 | **upgrade** | 중간 | awaiting_decision | **premium 가격 gate** · replacement 연쇄 |
| `qwen3.8-max` | Qwen | 08-04 | 18일 | **평가 필요** | 낮음 | evaluation_required | **premium 가격 gate** · 3.7-max와의 관계 |
| `qwen3.8-2.4t-a95b` | Qwen | 08-14 | 8일 | **monitor** | 낮음 | deferred(D-5 종속) | 제품 결정 부재 |
| `qwen3.8-27b` | Qwen | 08-20 | 2일 | **monitor** | 낮음 | deferred(D-5 종속) | 제품 결정 부재 |

**착수 순서 권고: D-1 → D-2 → D-3 → D-4 → D-5.**
가격 gate가 없는 것부터, 그리고 선례가 있는 것부터입니다.

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

## 5. 한 번에 구해야 할 provider 사실

7건이 기다리는 것은 결국 같은 종류의 자료입니다. 흩어서 찾지 말고 한 번에
모읍니다. **전부 `[확인 불가]`이며 provider 공식 가격표·모델 문서가 출처입니다.
`GET /v1/models`는 가격 출처가 아닙니다**(`lib/modelPricing.ts:402`).

| 모델 | 필요한 것 |
|---|---|
| `gemini-3.7-flash` | 입·출력 단가, cache read 단가, 컨텍스트, 출력 상한 |
| `glm-5.3` | 입·출력 단가, 컨텍스트, 5.2 대비 변화 |
| `qwen3.7-flash` | 입·출력 단가(길이 tier 여부), 컨텍스트 |
| `grok-4.6` | 입·출력 단가, 컨텍스트, reasoning 등급, 출력 상한 |
| `qwen3.8-max` | 입·출력 단가(길이 tier), 3.7-max와의 관계 |
| `qwen3.8-*b` | 서빙 형태(API tier인지 open-weight인지) |

Qwen은 **입력 길이별 계단 가격**을 쓰므로(`qwen3.7-plus` profile의
`maxPromptTokens: 256_000` 분기) 단일 단가로 받아 적으면 장문 요청에서
과소청구됩니다. 3.7-plus/3.7-max profile의 형태를 그대로 따릅니다.

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

