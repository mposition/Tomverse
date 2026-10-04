# 가격 검증 — gpt-5-6-sol (드리프트 관측)

공식 문서만 근거로 씁니다. 검색 요약, 블로그, 3자 집계는 근거로 쓰지 않았고,
provider API를 호출하지도 않았습니다.

| | |
|---|---|
| 대상 | `gpt-5-6-sol` (provider API ID `gpt-5.6-sol`) |
| 관측 시각 | 2026-08-27 |
| 근거 | `https://developers.openai.com/api/docs/models/gpt-5.6-sol` |
| 관측 주체 | mposition이 위 공식 문서를 직접 조회 |
| 승인·기록 | mposition |
| 계기 | ROUTE-01 judge calibration 설계 중 후보 모델 단가를 대조하다 발견 |

**이 문서를 작성한 에이전트는 위 URL을 직접 확인하지 못했습니다.** 실행 환경의
egress 프록시가 해당 호스트를 막습니다. 따라서 공식 값은 mposition의 조회 결과를
그대로 옮긴 것이고, 이 문서는 그 관측을 기록·보존하는 역할입니다. 재확인은 아래
§4의 lifecycle 항목이 담당합니다.

## 1. 대조

| 항목 | 공식 문서 (2026-08-27 관측) | 현행 profile | 결과 |
|---|---|---|---|
| provider apiModel | `gpt-5.6-sol` | `apiModelId: "gpt-5.6-sol"` | 일치 |
| input | `$4 / MTok` (프로모션) | `gpt56Tiers(5, …)` → `$5` | **불일치** |
| output | `$20 / MTok` (프로모션) | `gpt56Tiers(…, 30)` → `$30` | **불일치** |
| cached input | `$0.40 / MTok` | `cachedInputPriceMultiplier: 0.1` → `$0.50` | 배수는 일치, 기준가만 다름 |
| 프로모션 종료 | 최소 2026-11-21까지 유효 | 표현할 필드 없음 | §3 |
| pricingVersion | — | `openai-gpt-5.6-sol-2026-08-01` | 변경 없음 |
| priceSource | — | `openai_gpt_5_6_sol_model_page` | 변경 없음 |

cached input의 0.1배 관계는 어느 기준가를 쓰든 성립합니다($4의 10%가 $0.40).
드리프트는 tier의 기준 단가 두 개에만 있습니다.

## 2. 이번에 profile을 바꾸지 않는 이유

현행 `$5/$30`은 공식 프로모션가보다 **높습니다**. 즉 이 저장소는 실제보다 비싸게
추정하고 있고, 예산·한도·사전 승인 관점에서 안전한 방향입니다. 반대 방향이었다면
즉시 고쳐야 할 사안입니다.

낮은 프로모션가를 등록하는 쪽이 위험합니다. `ModelPricingProfile`에는
`effectiveDate`가 있고 **종료일을 표현할 필드가 없습니다.** 프로모션가를 넣으면
종료 후 누군가 알아차리고 새 `pricingVersion`을 배포할 때까지 실제의 절반 가까이로
과소 청구 추정을 하게 되고, 그것을 잡아낼 장치가 저장소에 없습니다.

같은 이유로 이미 내린 판단이 있습니다 — `lib/modelPricing.ts:559`의
`gemini-3-7-flash` 주석이 도입가 대신 정가를 등록한 근거를 그대로 적어 두었고,
`.github/audits/model-lifecycle-triage-2026-08-22.md` §5.1도 같은 결론입니다.

## 3. 프로모션가를 실제로 적용하려면

이 문서의 범위 밖이고, 별도 PR이 필요합니다. 최소한:

- `ModelPricingProfile`에 기한 필드(예: `reviewAfter`)와 그것을 강제하는 검사
- 새 `pricingVersion`
- `priceSource`를 기한이 드러나는 문자열로 (선례: `claude-sonnet-5`의
  `anthropic_claude_sonnet_5_introductory_price_to_2026_08_31`)

## 4. 재확인 일정

프로모션이 최소 2026-11-21까지이므로 그 직전에 다시 봅니다. `ModelLifecycleWorkItem`
행 하나를 만들어야 합니다:

```
provider:            "openai"
apiModel:            "gpt-5.6-sol"
modelId:             "gpt-5-6-sol"
action:              "monitor"
dueAt:               2026-11-20
pendingValidations:  ["pricing"]
```

**이 행은 아직 만들어지지 않았습니다.** `ModelLifecycleWorkItem`은 DB 행이고
`lib/modelLifecycleWorkItems.ts`의 코드 경로(탐색 스캔, 자동 비활성화)를 통해서만
생성됩니다. 손으로 만드는 선언적 경로가 없어, 이 문서는 만들 값을 확정할 뿐
행을 만들지는 않습니다. 생성은 DB 접근이 있는 환경에서 사람이 수행합니다.
