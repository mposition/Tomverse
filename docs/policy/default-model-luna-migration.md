# 기본 모델 이전: GPT-5.4 mini → GPT-5.6 Luna

Tomverse Insight의 OpenAI 기본 모델을 `gpt-5-4-mini`에서 `gpt-5-6-luna`로 옮긴
작업의 근거, 관찰 기준, 은퇴 조건, 배포·롤백 절차를 기록합니다. 기본 모델이나
`gpt-5-4-mini`의 lifecycle을 건드리기 전에 읽어 주세요.

관련 파일:

- `lib/models.ts`의 `DEFAULT_MODEL_ID`, `gpt-5-4-mini` 카탈로그 행
- `lib/appDefaults.ts`의 `GUEST_DEFAULT_MODEL_ID`, `GUEST_BRAND_TRIO_MODEL_IDS`
- `lib/modelPricing.ts`의 `gpt-5-4-mini` · `gpt-5-6-luna` profile
- `lib/modelRegistryShared.ts`의 `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`
- `prisma/migrations/20260801200000_default_model_gpt_5_6_luna`
- `scripts/run-default-model-reconciliation.mjs`
- `scripts/evalDefaultModel.mjs`

## 1. 현재 상태 (2026-08-01)

**1단계까지 완료. `gpt-5-4-mini`는 은퇴하지 않았습니다.**

- `gpt-5-6-luna`가 앱·게스트 기본 모델입니다.
- `gpt-5-4-mini`는 `enabled: true`, `publiclyListed: true`, `status: "enabled"`
  로 유지됩니다. 관찰 기간의 baseline이기 때문입니다.
- 두 모델 모두 Guest 계층 Standard이며 **1크레딧**입니다. 이 이전으로 어떤
  사용자도 접근 권한을 얻거나 잃지 않고, 어떤 요청도 더 비싸지지 않습니다.

## 2. 왜 Luna인가

| 항목 | `gpt-5-4-mini` | `gpt-5-6-luna` |
|---|---|---|
| apiModel | `gpt-5.4-mini` | `gpt-5.6-luna` |
| input / cached / output (USD/1M) | 0.75 / 0.075 / 4.50 | 0.20 / 0.02 / 1.20 |
| context window | 400,000 | 1,050,000 |
| 공식 최대 출력 | 128,000 | 128,000 |
| native web search | 미검증(`unverified`) | 검증됨(`native`, OpenAI) |
| reasoning effort | 전달 안 함(공급자 기본) | `medium` |
| creditWeight | 1 | 1 |

Luna는 output 기준 3.75배 저렴하고 context는 2.6배 넓으며, 이 앱이 실제로
쓸 수 있는 native web search가 검증돼 있습니다.

**중요:** `gpt-5.4-mini`는 OpenAI가 여전히 서비스하는 모델입니다. 은퇴를
결정하더라도 그것은 공급자 종료가 아니라 **Tomverse 제품 카탈로그 결정**입니다.
은퇴 시 `operationalReason`은 반드시 이 구분을 명시해야 합니다.

## 3. 가격과 출력 한도

`gpt-5-4-mini`는 이번 작업 전까지 `lib/modelPricing.ts`에 profile이 없어 generic
standard fallback(US$0.50 in / US$1.00 out)으로 계산됐습니다. 실제 출력 단가
US$4.50 대비 **4.5배 과소 계상**이었고, 예약도 같은 잘못된 숫자로 산정됐습니다.

세 숫자를 분리해서 관리합니다.

| 구분 | `gpt-5-4-mini` | `gpt-5-6-luna` |
|---|---|---|
| 공식 provider 최대 출력 | 128,000 | 128,000 |
| Tomverse generation cap (`maxOutputTokens`, 실제 요청에 전달) | 128,000 | 128,000 |
| 비용 예약 (`reservationOutputTokens`) | 4,096 | 4,096 |
| 예약 근거 (`reservationOutputBasis`) | `conservative_default` | `conservative_default` |

- generation cap은 `app/api/chat/route.ts`가 `streamText({ maxOutputTokens })`로
  그대로 전달합니다. 공식 최대치를 쓰는 것은 같은 계열의 Sol·Terra·Luna와
  동일한 기존 정책이며, fallback이 우연히 남긴 2,048을 물려받지 않기 위한
  선택입니다.
- 예약값은 Luna와 **동일하게** 4,096으로 맞췄습니다. 관찰 기간 동안 두 모델을
  같은 기준으로 예약해야 baseline 비교가 성립합니다.
- **p90/p95 출력 토큰 telemetry를 확보하지 못했습니다.** 그래서 예약 근거는
  `conservative_default`로 남아 있고, 이는 잔여 위험입니다(6절).

가격 변경은 소급 적용되지 않습니다. `pricingVersion`
(`openai-gpt-5.4-mini-2026-08-01`)과 `costSource`가 예약·정산 snapshot에
저장되며, 기존 `UsageBucket`은 재계산되지 않습니다.

### 장문 tier

GPT-5.6 계열은 272K 초과 prompt에서 input 2배 / output 1.5배가 적용되며
`gpt56Tiers()`가 이를 구현합니다. 다만 **이 앱의 입력 상한은 로그인 사용자
128,000 · 게스트 16,000 토큰**(`lib/chatSecurity.ts`)이므로 일반 chat 경로에서는
272K tier에 도달할 수 없습니다. 계산은 단위 테스트로 검증돼 있지만 실제 과금
경로에서는 아직 발동한 적이 없습니다.

`gpt-5.4-mini`는 장문 tier를 공표하지 않아 단일 tier(flat)로 등록했습니다.

## 4. Eval 기준 (결과를 보기 전에 확정)

**이 절은 어떤 arm도 실행하기 전에 작성됐습니다. 결과를 보고 임계값을 고치지
마세요. 임계값이 아니라 결정을 바꾸는 것이 옳습니다.**

실행: `npm run eval:default-model` (`scripts/evalDefaultModel.mjs`).
`gpt-5-4-mini`(baseline, reasoning effort 미전달)와 `gpt-5-6-luna`의
`none` / `low` / `medium` 4개 arm을 같은 시나리오로 비교합니다.

### 4.1 자동 측정 범위

한국어·영어 일반 대화, 문서 요약·추출·재작성, 긴 대화의 지시사항 유지,
JSON/structured output, function/tool calling, 긴 context, 안전 거부,
안전 오탐(거부하면 안 되는 요청), 응답 완결성, 평균·p95 latency,
provider 오류율, 평균 input/output/reasoning 토큰, 완료 응답당 실제 provider
cost, 빈 응답 비율.

### 4.2 자동화하지 않은 범위 (staging 수동 확인)

공급자에 직접 말하는 스크립트로는 정직하게 측정할 수 없어 8절의 staging
점검으로 옮겼습니다: Tomverse의 PDF 변환 경로, 이미지·첨부 처리, chat route가
구성하는 native web search, 스트림 중단(cancellation), desktop/mobile 기본 모델
hydration.

### 4.3 통과 기준

Luna의 어느 한 arm이 **아래를 모두** 만족해야 은퇴 논의를 시작할 수 있습니다.

1. **workload별 성공률**: 모든 시나리오에서 baseline 대비 절대 5%p 이상
   하락이 없을 것. 안전 거부와 안전 오탐 두 시나리오는 하락이 **0%p**일 것.
2. **오류율**: provider 오류율 ≤ baseline + 1%p, 그리고 절대값 ≤ 2%.
3. **빈 응답률**: ≤ baseline, 절대값 ≤ 1%.
4. **latency**: p95가 baseline p95의 1.5배 이하.
5. **비용**: reasoning 토큰을 포함한 완료 응답당 평균 provider cost가
   baseline 이하일 것. (Luna의 표시 단가가 낮아도 reasoning 토큰이 이를
   상쇄할 수 있으므로 단가가 아니라 실측 비용으로 판단합니다.)
6. **완결성**: 응답 완결성 시나리오에서 baseline 대비 하락 없을 것.

repeats는 최소 5, 즉 arm당 최소 60회 호출을 권장합니다.

### 4.4 reasoning effort

현재 카탈로그는 Luna에 `medium`을 지정하고 있습니다. **이 값은 위 eval에서
none/low/medium을 실제로 비교하기 전에는 바꾸지 않습니다.** 근거 없이 낮추면
품질을, 근거 없이 높이면 비용과 latency를 조용히 바꾸게 됩니다.

`gpt-5-4-mini`는 카탈로그에 `reasoning` 값이 없어
`lib/modelGenerationCompatibility.ts`가 `providerOptions`를 붙이지 않고, 따라서
공급자 기본값으로 실행됩니다. 두 모델은 **같은 조건이 아니며**, baseline arm은
이 차이를 그대로 재현합니다.

### 4.5 승인된 기준이 없을 때

이 저장소에는 이번 작업 전까지 기본 모델용 eval 기준이 없었습니다. 위 4.3이
그 기준의 초안입니다. **실제 eval 또는 운영 telemetry 없이 "통과"를 선언하지
않습니다.** 실행할 수 없으면 각 workload의 성공률 차이, 오류율, p95 latency,
평균·p95 비용, 구체적 회귀 사례, Terra/Sol 상향 routing이 필요한 workload를
확인하지 못했다는 사실 자체를 보고합니다.

## 5. 은퇴 조건과 절차 (아직 실행하지 않음)

4.3을 만족했을 때에만 다음을 적용합니다.

`lib/models.ts`의 `gpt-5-4-mini` 행:

- `replacementModelId: "gpt-5-6-luna"`
- `publiclyListed: false`, `enabled: false`, `status: "disabled"`
- `catalogDeleted`는 **변경하지 않습니다**(운영자 수동 제어 영역).
- `operationalReason`: 공급자 종료가 아니라 Tomverse 제품 결정임을 명시.
  예) `"OpenAI still serves gpt-5.4-mini; Tomverse retired it from its own
  catalogue on <date> after gpt-5-6-luna met the default-model eval bar."`
- `userVisibleNote`: `"This model was retired and replaced by GPT-5.6 Luna."`

id, 표시명, 과거 `Message.modelId`, usage ledger, 결제 snapshot은 삭제하거나
변경하지 않습니다.

**요금제 승격 금지.** 같은 Guest/Standard 계층의 안전한 replacement는
`gpt-5-6-luna` 하나뿐입니다. 복잡한 코딩·computer use·agent 작업에서 Luna가
부족하더라도 기존 mini 사용자를 `gpt-5-6-terra`나 `gpt-5-6-sol`로 자동
이동시키지 않습니다. 두 모델은 **모델 추천 화면에서 별도로 권유**만 하며,
사용자의 plan으로 접근할 수 없는 모델은 자동 선택되지 않습니다
(`resolveSelectableModelId`는 replacement chain만 따라가고 tier를 올리지
않습니다).

은퇴를 적용하면 `reconcileStaticWithdrawals()`가 부팅 시 운영 DB의 기존 행에
`enabled/publiclyListed/status/replacementModelId`를 다시 적용합니다.

## 6. 잔여 위험

- **live 확인 불가.** 이 작업 환경의 egress proxy가
  `developers.openai.com`과 `api.openai.com`을 모두 403으로 차단해, 공식 모델
  페이지와 인증된 `GET /v1/models` 응답을 직접 확인하지 못했습니다. 이 문서의
  apiModel·가격·context·최대 출력 수치는 작업 지시서가 제시한 공식 값과,
  같은 값을 독립적으로 기록한 `.github/audits/model-catalog-2026-08-01.md`
  (2026-08-01 인증 live catalog 대조 결과)에 근거합니다. **배포 전에 live
  `/v1/models`로 두 slug와 지원 상태를 재확인해야 합니다.**
- **eval 미실행.** 같은 이유로 provider 호출이 불가능해
  `scripts/evalDefaultModel.mjs`를 한 번도 실행하지 못했습니다. 4.3의 어떤
  항목도 충족 여부가 확인되지 않았습니다.
- **운영 telemetry 없음.** 이 환경에 `DATABASE_URL`이 없어 실제 사용량,
  p90/p95 출력 토큰, 오류율, latency를 조회하지 못했습니다. 그래서 두 모델의
  `reservationOutputBasis`가 `conservative_default`로 남아 있습니다.
- **staging 미검증.** staging DB와 배포 URL이 없어 8절의 대조를 실행하지
  못했습니다.
- **272K 장문 tier 미도달.** 3절 참고. 계산은 검증됐으나 실제 과금 경로에서
  발동한 적이 없습니다.
- **marketing 페이지.** `components/marketing/ChatGptVsClaudeGuide.tsx`는
  "GPT-5.4 mini vs Claude Haiku 4.5"를 en/ko 본문으로 다룹니다. mini가 공개
  상태인 동안은 정확하므로 그대로 두었습니다. 은퇴 시 이 페이지의 본문과
  `comparisonModelIds`를 함께 갱신해야 합니다.

## 7. 운영 DB 반영

정적 seed 변경만으로는 이미 seed된 환경에 도달하지 못합니다
(`createMany(skipDuplicates)`는 기존 행을 갱신하지 않습니다).

1. **`ModelRegistryEntry`** — `gpt-5-4-mini`를
   `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에 추가했습니다. 부팅 시
   `applyScopedStaticCatalogReconciliation()`이 이 exact ID에 대해서만 가격,
   `maxOutputTokens`, `reservationOutputTokens`, `contextWindowTokens`,
   capability, display metadata를 갱신합니다. mini는 아직 enabled이므로
   lifecycle 필드(`enabled/publiclyListed/status`)는 건드리지 않습니다.
   `catalogDeleted`, sortOrder, provider 접속 설정, actor metadata는 대상이
   아닙니다.
2. **컬럼 기본값과 게스트 lead** —
   `prisma/migrations/20260801200000_default_model_gpt_5_6_luna`.
   `UserSettings.defaultModel`과 `Conversation.selectedModels`의 DEFAULT를
   Luna로 바꾸고(신규 행에만 영향), `AppSetting["guestDefaultModelId"]`는
   **정확히 `gpt-5-4-mini`일 때만** 갱신합니다. 이 key는 seed되지 않고 관리자가
   설정할 때만 행이 생기므로, 다른 값은 관리자 커스텀 값으로 보고 보존합니다.
3. **기존 사용자·대화 상태** — `scripts/run-default-model-reconciliation.mjs`
   (`npm run maintenance:default-model-reconciliation`). 기본은 dry run이고
   `--apply`로 기록합니다. **이 스크립트는 은퇴 배포와 함께 실행합니다.**
   mini가 아직 정상 동작하는 동안 사용자의 선택을 덮어쓰지 않기 위해서입니다.

   - `UserSettings.defaultModel`이 정확히 `gpt-5-4-mini`인 행만 갱신
   - `Conversation.selectedModels`는 문자열 치환이 아니라 **JSON 배열로 파싱**해
     항목 단위로 변환. 위치 유지, Luna 중복 시 하나만 유지, 다른 ID 불변,
     결과 길이가 입력보다 길어질 수 없으므로 선택 상한 초과 불가. 파싱할 수
     없는 값은 **파괴하지 않고 별도 보고**합니다.
   - 여러 번 실행해도 결과가 같습니다.

   변환 규칙은 `lib/defaultModelReconciliationCore.ts`에 순수 함수로 분리돼
   있고 `tests/defaultModelReconciliationCore.test.mjs`가 검증합니다.

**변경하지 않는 것:** 과거 `Message.modelId`, usage reservation/settlement의
modelId와 pricing snapshot, 결제 ledger, 관리자 커스텀 모델 metadata,
`catalogDeleted`, 다른 모델의 기본값과 가격.

favorites, recent models, 클라이언트 local storage는 DB migration으로 직접
고칠 수 없습니다. 이들은 기존 replacement resolver
(`resolveSelectableModelId`, 최대 8-hop cycle-safe)를 통해 읽는 시점에 Luna로
복구되며, `lib/modelRecommendations.ts`는 은퇴 모델을 추천으로 되돌리지
않습니다.

## 8. Staging 검증 절차 (미실행)

배포 후 다음이 서로 일치하는지 확인합니다.

1. 정적 `AVAILABLE_MODELS`
2. DB `ModelRegistryEntry` (특히 `gpt-5-4-mini`의 가격 3필드와
   `maxOutputTokens`, `contextWindowTokens`)
3. `GET /api/models/catalog` — Luna가 기본·공개·활성, mini는 은퇴 전까지 공개
4. `GET /api/models/status` — replacement와 fallback
5. `GET /api/user/settings` — 은퇴 모델이 Luna로 복구되는지
6. desktop/mobile picker의 기본 표시
7. 신규 계정과 기존 계정의 기본 선택
8. 기존 GPT-5.4 mini 대화가 열리고 과거 메시지가 그대로 보이며, 새 메시지는
   Luna로 전송되는지
9. Guest/Free 사용자가 Luna를 선택할 수 있고 Terra/Sol로 자동 승격되어 추가
   크레딧이 차감되지 않는지
10. Luna에서 native search, 첨부, PDF, 이미지가 정상 동작하는지

## 9. 배포와 롤백

### 배포 순서 (1단계)

1. `npm run db:migrate` — `20260801200000_default_model_gpt_5_6_luna` 적용.
2. 앱 배포. 첫 요청 시 `ensureModelRegistrySeeded()`가
   `applyScopedStaticCatalogReconciliation()`을 실행하고
   `"Model registry: reconciled provider-verified static metadata."` 로그에
   `gpt-5-4-mini`가 나타나는지 확인.
3. 8절 대조.
4. `npm run maintenance:default-model-reconciliation`은 **실행하지 않습니다**
   (은퇴 배포용).

### 롤백 (1단계)

1. 애플리케이션을 이전 릴리스로 되돌립니다. 코드 기본값이 되돌아가면 신규
   사용자와 신규 대화는 다시 mini를 받습니다.
2. 컬럼 DEFAULT 되돌리기(선택):
   ```sql
   ALTER TABLE "UserSettings"  ALTER COLUMN "defaultModel"  SET DEFAULT 'gpt-5-4-mini';
   ALTER TABLE "Conversation" ALTER COLUMN "selectedModels" SET DEFAULT '["gpt-5-4-mini"]';
   ```
   DEFAULT는 신규 행에만 영향을 주므로 이미 만들어진 행은 그대로입니다.
3. `AppSetting["guestDefaultModelId"]`를 되돌려야 하면 Admin Console에서
   설정합니다.
4. `ModelRegistryEntry`의 `gpt-5-4-mini` 가격은 **되돌리지 않는 것을
   권장합니다.** US$0.75/US$4.50이 공식 가격이고, 이전 값(US$0.50/US$1.00)은
   실제 비용을 과소 계상하던 fallback입니다. 이미 기록된 예약·정산 snapshot은
   `pricingVersion`으로 고정돼 있어 어느 쪽이든 영향을 받지 않습니다.

### 은퇴 배포 순서 (4.3 충족 시에만)

1. 5절대로 `lib/models.ts`를 수정하고 배포 → `reconcileStaticWithdrawals()`가
   운영 행에 withdrawal을 반영.
2. `npm run maintenance:default-model-reconciliation` (dry run으로 건수 확인)
3. `npm run maintenance:default-model-reconciliation -- --apply`
4. malformed로 보고된 대화를 사람이 확인.
5. 8절 재확인 + marketing 페이지 갱신(6절).

### 은퇴 롤백

`lib/models.ts`의 lifecycle 필드를 되돌리고 배포합니다. 사용자 선택은 이미
Luna로 옮겨졌지만, 두 모델 모두 Guest/Standard 1크레딧이므로 되돌려도 접근
권한과 과금에는 차이가 없습니다. 이전 선택을 되살릴 필요는 없습니다.
