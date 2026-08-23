# 기본 모델 이전: GPT-5.4 mini → GPT-5.6 Luna

Tomverse Review의 OpenAI 기본 모델을 `gpt-5-4-mini`에서 `gpt-5-6-luna`로 옮긴
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

## 1.1 "기본 모델"은 두 개의 다른 결정입니다

계속 서로 혼동되므로 먼저 갈라 둡니다. 둘은 값이 같아도 별개이고, 한쪽을 바꾸는
것이 다른 쪽을 바꾸지 않습니다.

**A. 게스트의 첫 대화**

- DB의 `AppSetting["guestDefaultModelId"]`
- `getPublicAppSettings()`가 읽습니다
- **하는 일은 하나뿐입니다**: brand trio 3종 중 **어느 것이 선두인지**를 정합니다
  (`resolveGuestDefaultSelectedModels`). 모델을 추가하지도 제거하지도 않습니다
- 로그인 계정의 `UserSettings.defaultModel`과 **아무 관계가 없습니다**

**B. 신규 로그인 계정**

- `lib/models.ts`의 `DEFAULT_MODEL_ID`
- `lib/appDefaults.ts`의 `APP_DEFAULTS.defaultModelId`
- `prisma/schema.prisma`의 `UserSettings.defaultModel` 컬럼 기본값
- `app/api/user/settings/route.ts`가 행이 없을 때 만드는 값
- 새 conversation의 fallback

한 값의 네 가지 표기이고, **넷을 함께 읽는 코드는 없습니다.** 그래서 조용히
어긋납니다.

### 유효하지만 아무 효과가 없는 설정은 저장하지 않습니다

`guestDefaultModelId`는 trio를 재정렬할 뿐이므로, trio 밖의 모델은 resolver가
버립니다. 그런데 예전 검증은 "enabled · 게스트 접근 가능 · Standard"까지만
봤습니다. 그 셋을 통과하고 trio 밖인 모델은 **저장이 성공하고, 값이 그대로 다시
읽히고, `/api/app-settings`가 서빙하고, 게스트 화면은 하나도 바뀌지 않습니다.**
관리자 입장에서는 동작하는 설정과 동작하지 않는 설정이 똑같이 보입니다.

이제 `lib/appDefaults.ts`의 `guestDefaultLeadRejection()`이 trio 소속까지
요구하고, `lib/appSettings.ts`와 `/api/admin/billing`이 그것을 적용해 **어떤
모델이라면 되는지 말해 주는 검증 오류**로 거부합니다.

게스트에게 보이는 세 모델을 바꾸는 것은 `GUEST_BRAND_TRIO_MODEL_IDS`를 옮기는
제품 결정이고, 크레딧 추정·picker·cost hydration·E2E 기대치가 **한 변경으로**
함께 움직여야 합니다. admin 설정이 옆에서 할 수 있는 일이 아닙니다.

### `npm run check:default-models`

읽기 전용 감사입니다. 아무것도 쓰지 않습니다 — AppSetting을 건드리지 않고,
`UserSettings` 행을 만들거나 갱신하지 않으며, reconciliation을 돌리지 않습니다.
읽기 전용 `DATABASE_URL`을 주면 운영 DB의 실제 상태를 보고하고, 없으면 컴파일된
카탈로그만 감사하고 그렇다고 말합니다(그 절반이 CI가 답할 수 있는 부분이라 PR
Fast Gate의 static 단계에 있습니다).

출력: `storedGuestDefaultModelId` · `normalizedGuestDefaultModelId` ·
`effectiveGuestSelectedModelIds` · `storedSettingApplied` ·
`compiledAuthenticatedDefaultModelId` · `appDefaultsDefaultModelId` ·
`prismaUserSettingsDefaultModel` · `prismaConversationSelectedModels` ·
`userSettingsCreateDefaultModel` · 각 모델의 runtime 상태(enabled ·
publiclyListed · catalogDeleted · guest eligibility · usage class) · SSR과
hydration 후 선택. 값마다 출처(`app_setting` · `compiled_default` ·
`prisma_schema` · `runtime_catalogue`)를 함께 찍습니다.

실패 조건:

- 저장된 guest default가 유효한데 실제 선택에 반영되지 않음
  (`guest_setting_not_applied`) — **저장은 됐는데 효과가 없는 상태**
- disabled · unlisted · catalogDeleted 모델이 기본값
- 게스트가 쓸 수 없는 모델이 기본값
- Standard가 아닌 모델이 guest default
- `DEFAULT_MODEL_ID` · `APP_DEFAULTS.defaultModelId` · Prisma schema 기본값 불일치
- 신규 `UserSettings` 생성 경로가 다른 값을 저장
- hydration 전후 게스트 선택 불일치

2026-08-02 현재 `origin/develop`(`d819176`)에서 **통과**합니다. trio의 선두가
이미 `gpt-5-6-luna`이고, 컴파일된 기본값 · Prisma 기본값 · 설정 route의 생성값이
셋 다 `gpt-5-6-luna`입니다.

## 1.2 세 번째 개념: 로그인 사용자의 새 대화 기본 조합

2026-08-03에 추가된 **세 번째 독립 결정**입니다. A(게스트 선두)도 B(플랫폼·계정
대표 모델)도 대체하지 않으며, 둘 중 어느 쪽을 바꾸는 것도 이 결정을 바꾸지
않습니다.

**C. 로그인 사용자의 새 대화 기본 조합**

- `UserSettings.newConversationModelIds` (`Json?`, schema default 없음)
- 1~3개 모델 ID 배열이며, **실제 새 대화 시작 상태의 source of truth**입니다
- `NULL`(DB NULL·JSON null 모두)은 `[defaultModel]`로 해석합니다 — 기존 계정은
  backfill 없이 단일 모델 동작을 그대로 보존합니다
- 해석은 `lib/newConversationModels.ts`의 공통 resolver 하나가 담당합니다.
  route와 클라이언트가 제각각 fallback을 구현하지 않습니다

**대표 모델(`UserSettings.defaultModel`)과의 관계**

- `defaultModel`은 삭제되지도, 의미가 바뀌지도 않습니다. 단독 시작·조합 선두·
  fallback·하위 호환 값이며, 사용자 UI 명칭은 "대표 모델"입니다
- **조합이 명시적으로 저장되는 모든 쓰기 경로에서 `defaultModel`은 조합의 첫
  항목과 같은 transaction 안에서 동기화**됩니다 (Model Finder `complete`·
  `accept_default`, `/api/user/settings` POST)
- legacy client가 `defaultModel`만 보내면 기존 유효 조합의 선두를 그 모델로
  옮기고 나머지 순서를 유지합니다(중복 제거, 최대 3개, 초과 시 마지막 항목
  제거). 기존 조합이 없으면 `[defaultModel]`을 저장합니다

**stored와 effective의 구분 (2026-08-03 정책 개정)**

이전에는 `GET /api/user/settings`가 비활성 `defaultModel`을 발견하면 DB를
replacement로 **영구 갱신**했습니다. 이 동작은 폐지되었습니다:

- **읽기 경로는 어떤 경우에도 DB를 rewrite하지 않습니다.** resolver가 저장값
  (stored)과 실제 제공 가능한 값(effective)을 구분해 계산하고, 응답은 effective
  상태와 변경 reason(`modelSelectionNotice`)을 반환합니다
- 저장 모델이 delist·disable·retire되어 replacement로 해석되더라도 조용히
  축소·교체하지 않고 사용자에게 안내합니다. 같은 reason과 모델 조합에 대한
  시각적 안내는 세션당 한 번으로 제한하되, 구조화 로그는 매번 남깁니다
- **영구 변경은 두 경로뿐입니다**: 사용자의 명시적 재저장, 또는 승인된
  retirement reconciliation(§7). 이 문서가 요구하는 "은퇴 모델의 replacement
  복구"는 응답의 effective 상태로 충족되며 DB rewrite를 의미하지 않습니다
- 저장 성공 응답은 요청 echo가 아니라 **실제 DB에 저장된 정규화 값**만
  반환합니다. Model Finder의 "기본 조합으로 저장"이 첫 모델만 저장하면서 요청
  배열 전체를 저장 결과처럼 응답하던 결함(2026-08-03 수정)이 이 규칙의
  배경입니다

**비용 규칙**

- 기존 사용자에게 모델이나 비용을 자동으로 추가하지 않습니다
- Advanced·Research 모델은 반복 기본 사용 비용임을 저장 전에 명시적으로 확인
  받아야 조합에 들어갈 수 있습니다
- 크레딧 합계의 출처는 기존 클라이언트 계산 경로(runtime catalogue usage
  profile) 하나입니다. API 응답에 별도 `estimatedCredits`를 추가하지 않습니다
- resolver는 상위 플랜·고비용 모델로 자동 승격하지 않습니다

UI 계약은 `docs/ui-contracts/account-model-settings.md`가 고정하고,
`npm run check:default-models`의 **C. Signed-in new conversation combination**
섹션이 컬럼 nullable 계약·fallback·쓰기 경로 동기화·읽기 경로의 no-rewrite를
fail-closed로 검사합니다. "마지막 사용 조합" 같은 추가 시작 모드는 이 개정의
범위 밖이며, 도입하려면 별도 설계 결정이 필요합니다.

**배포 순서 (migration-first)**

additive nullable 컬럼이 "안전"한 방향은 한쪽뿐입니다: **기존 코드는 새
컬럼을 몰라도 되지만, 새 코드는 컬럼 없이 동작하지 못합니다.** 새 Prisma
Client는 `UserSettings`를 `select` 없이 읽는 모든 경로에서 이 컬럼을
조회하므로, migration보다 먼저 트래픽을 받으면 설정 조회·저장이 실패합니다.

1. nullable 컬럼 migration을 먼저 적용하고 성공을 확인합니다
2. 그 다음에 신규 코드를 배포합니다
3. readiness와 설정·새 대화 smoke test를 확인합니다
4. 문제 시 코드는 rollback하되 **nullable 컬럼은 그대로 둡니다** — 기존
   코드는 이 컬럼을 무시하므로 컬럼 제거는 필요도 없고 위험만 더합니다

migration과 코드가 한 배포에 묶여 있다면, migration 완료 후에만 신규
인스턴스가 트래픽을 받는다는 보장이 있어야 합니다.

**기존 conversation의 fallback은 이 개정의 대상이 아닙니다.** 저장값을 읽을
수 없는 기존 conversation의 표시 fallback은 `[defaultModel]` 하나이며, 계정의
새 대화 기본 조합을 적용하지 않습니다 — 적용하면 단일 모델이던 기존 대화가
여러 패널로 조용히 확장됩니다. 조합은 오직 **새** conversation의 시작
상태만 정합니다(`tests/newConversationModels.test.mjs`가 소스 수준으로
고정).

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

### 3.1 `reservationOutputBasis`를 p90으로 바꾸는 조건

지금은 두 모델 모두 `conservative_default`이고, **telemetry를 확보하기 전에는
그대로 둡니다.** "telemetry가 생기면 바꾼다"는 말은 계약이 아니므로, 바꿀 수
있는 조건을 미리 확정해 둡니다. 아래를 **모두** 충족한 산출만 채택합니다.

1. **모델별 독립 산출.** mini와 Luna를 합쳐서 계산하지 않습니다. 출력 길이
   분포가 다른 두 모델의 p90은 서로의 근거가 되지 못합니다.
2. **산출 기간과 최소 표본 수 명시.** 연속 기간(예: 최근 14일)과 모델당 최소
   완료 응답 수를 정하고, 실제 값을 기록합니다. 특정 요일·시간대에 몰린 표본은
   기간을 늘립니다.
3. **workload 분리 확인.** 한국어/영어, 일반 대화/도구 호출/웹검색을 나눠
   보고, 어느 한 workload의 p90이 전체 p90을 크게 넘으면 전체값을 그대로 쓰지
   않습니다.
4. **정산된 실제 출력 토큰을 사용.** 추정치가 아니라 정산 시점에 기록된
   출력 토큰, 그리고 **과금 대상 reasoning 토큰**을 포함합니다
   (`reasoningTokenBilling: "billed_as_output"`이면 이미 출력에 포함됩니다).
5. **부분 응답과 중단 요청 포함.** 사용자가 중단했지만 provider 비용이 발생한
   요청은 표본에 넣습니다. 예약은 그 요청에도 걸렸기 때문입니다. 반대로 비용이
   전혀 발생하지 않은 실패는 제외합니다.
6. **동질 표본만 집계.** 모델 설정과 reasoning 수준이 같은 요청만 모읍니다.
   Luna의 effort를 바꾼 적이 있으면 그 경계를 넘어 합치지 않습니다.
7. **감사 가능하게 보관.** 산출 기간, 표본 수, workload별 분포, p90/p95, 적용일,
   산출 쿼리 또는 스크립트를 남깁니다. 숫자만 남은 변경은 되돌릴 근거가 없습니다.
8. **p90 위에 안전 여유와 최소 floor.** p90을 그대로 쓰지 않고 여유(예: ×1.2)를
   더하고, 짧은 답변이 많은 모델에서 예약이 비현실적으로 작아지지 않도록 최소값을
   둡니다. 상한은 언제나 `maxOutputTokens`입니다.
9. **적용 후 drift 감시와 복귀 경로.** 적용 이후 p90/p95가 산출 시점 대비
   유의하게 커지면 경고하고, `conservative_default`로 되돌리는 경로를 유지합니다.

#### 측정 도구: `npm run report:output-token-telemetry`

읽기 전용입니다. 정산된 `ChatCreditReservation`에서 모델별 p50/p90/p95/p99와
workload별 분포를 내고, **위 아홉 조건을 하나씩 판정**해 `PASS` · `FAIL` ·
`HUMAN`으로 표시합니다.

- 조건 1(모델별 독립)은 구조로 보장합니다 — 다른 모델의 토큰은 애초에 집계에
  들어가지 않습니다.
- 조건 4·5는 데이터로 판정합니다. 정산된 provider 보고 토큰만 쓰고, 비용이
  발생한 부분·중단 응답은 포함하되 비용이 없는 실패는 제외합니다.
- 조건 7(감사 보관) · 8(안전 여유·floor) · 9(drift 감시)는 **사람만 닫을 수
  있어** 언제나 `HUMAN`입니다. 이 보고서는 보관할 artefact이지 보관 행위가
  아닙니다.

**측정 가능한 조건을 전부 만족해도 `recommendedBasis`는 항상
`conservative_default`입니다.** 이 도구는 근거를 만들 뿐 결정을 하지 않으며,
telemetry 없이 `p90_output_tokens`를 적용하는 경로는 존재하지 않습니다. 실제
적용은 별도 승인과 새 `pricingVersion`을 갖는 별도 PR입니다.

**이 변경은 최종 과금을 바꾸지 않습니다.** 정산은 실제 사용량으로 이루어지고,
예약은 그 앞단에서 과소·과다 예약을 줄이는 최적화일 뿐입니다. 다만 **같은 단가라도
예약 기준이 달라지므로**, 새 `pricingVersion`(또는 동등한 reservation profile
version)으로 구분해 이전 예약과 섞이지 않게 합니다. `reservationOutputBasis`도
`p90_output_tokens`로 함께 바꿉니다.

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

### 4.3 수치 기준 — 은퇴의 **필요조건이지 충분조건이 아닙니다**

아래를 모두 만족해도 그것만으로 은퇴가 승인되지는 않습니다. 4.6의 준비 점검을
따로 통과해야 합니다. 반대로 하나라도 불만족이면 은퇴는 즉시 보류입니다.

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

#### 표본 수와 판정 방법

**arm당 60회는 smoke eval입니다. 은퇴 판정에 쓰지 않습니다.**

60회에서는 오류 1건이 이미 1.67%입니다. "절대 2% 이하"와 "baseline +1%p 이하"를
그 표본으로 판정하면 요청 하나의 운이 결론을 뒤집습니다. 실제로 0/12에서도
빈 응답률의 95% 상한은 24.3%입니다.

| 등급 | arm당 완료 실행 수 | 용도 |
|---|---|---|
| smoke | < 300 | harness·시나리오 점검, 명백한 회귀 조기 발견 |
| decision | ≥ 300 (권장 500) | 은퇴 판정에 인용 가능 |

`scripts/evalDefaultModel.mjs`는 arm당 300회 미만이면 요약 끝에
`SMOKE RUN -- NOT a retirement decision`을 출력합니다. 시나리오가 12개이므로
decision-grade는 `--repeats=25` 이상(500회는 `--repeats=42`)입니다.

**표본 등급은 규칙마다 다릅니다.** 위 표는 시나리오를 합산하는 규칙(오류율,
빈 응답률)에 대한 것입니다. 1번의 **시나리오별 5%p 규칙은 합산되지 않으므로
arm당 표본이 아니라 시나리오당 표본이 검정력을 정합니다.**

`--repeats=25`(arm당 300회, 전체 1,200회)에서 시나리오당 표본은 25회이고,
성공률의 최소 변화 단위는 **4%p**입니다. 5%p 기준을 4%p 격자 위에서 판정하면
경계에서 무의미해집니다 — 1건 차이는 4%p라 통과하고 2건 차이는 8%p라 실패해,
그 사이를 표현할 수 없습니다.

| 규칙 | 검정력을 정하는 표본 | decision-grade 하한 |
|---|---|---|
| 오류율·빈 응답률 (2·3번) | arm당 전체 | 300 (권장 500) |
| 시나리오별 성공률 (1·6번) | **시나리오당** | 100 (`--repeats=100`) |
| 안전 거부·안전 오탐 (1번의 0%p 항목) | 시나리오당 | 하한 없음 — 1건이라도 회귀면 즉시 불합격 |

안전 두 시나리오는 허용 오차가 0%p이므로 소표본에서도 **보수적인 방향으로만**
틀립니다(회귀를 놓칠 수는 있어도 없는 회귀를 만들지는 않습니다). 따라서 표본
하한을 두지 않되, **통과했다고 해서 안전하다고 선언하지는 않습니다.**

현실적인 절충: `--repeats=25`를 먼저 돌려 합산 규칙을 판정하고, **하락이 관찰된
시나리오만** `--repeats=100` 이상으로 다시 돌립니다. harness는 시나리오별 해상도와
`UNDERPOWERED` 여부를 출력하고, baseline 대비 하락한 시나리오를 따로 나열합니다.

**판정은 점추정이 아니라 신뢰구간 경계로 합니다.** harness가 각 비율의 Wilson
95% 구간을 함께 출력합니다.

- 오류율·빈 응답률은 **상한**(`err<=`, `empty<=`)이 기준을 만족해야 합니다.
- 성공률은 **하한**(`pass>=`)이 기준을 만족해야 합니다.
- baseline 대비 비교도 두 arm의 구간이 겹치는 동안에는 "차이 없음"으로
  읽습니다. 점추정 차이만으로 우열을 선언하지 않습니다.

표본 수를 고정하기 어려우면 고정하지 말고, 위 경계가 기준을 만족할 때까지
표본을 늘리는 방식(구간 상한 판정)을 씁니다. 어느 쪽이든 **실제 실행 수와
구간을 보고서에 그대로 남깁니다.**

### 4.4 reasoning effort

현재 카탈로그는 Luna에 `medium`을 지정하고 있습니다. **이 값은 위 eval에서
none/low/medium을 실제로 비교하기 전에는 바꾸지 않습니다.** 근거 없이 낮추면
품질을, 근거 없이 높이면 비용과 latency를 조용히 바꾸게 됩니다.

`gpt-5-4-mini`는 카탈로그에 `reasoning` 값이 없어
`lib/modelGenerationCompatibility.ts`가 `providerOptions`를 붙이지 않고, 따라서
공급자 기본값으로 실행됩니다. 두 모델은 **같은 조건이 아니며**, baseline arm은
이 차이를 그대로 재현합니다.

### 4.5 승인된 기준이 없을 때

이 저장소에는 이번 작업 전까지 기본 모델용 eval 기준이 없었습니다. 4.3(수치),
4.6(준비 점검), 4.7(긴급 비활성화 분리)이 그 기준입니다. **실제 eval 또는 운영 telemetry 없이 "통과"를 선언하지
않습니다.** 실행할 수 없으면 각 workload의 성공률 차이, 오류율, p95 latency,
평균·p95 비용, 구체적 회귀 사례, Terra/Sol 상향 routing이 필요한 workload를
확인하지 못했다는 사실 자체를 보고합니다.

### 4.5.1 실행 절차 — `--repeats=25`를 돌렸다는 사실만으로 decision-grade가 되지 않습니다

표본 수는 필요조건 하나일 뿐입니다. 은퇴 판정 자료로 인용하려면 아래를 묶어야
합니다.

**1) 사전 점검 (`--repeats=2`)**

```
npm run eval:default-model -- --repeats=2 --json=artifacts/default-model-eval-preflight.json
```

확인할 것: 네 arm이 모두 **실제 모델로** 호출되는지, API 권한과 arm별 reasoning
설정이 의도대로 전달되는지, usage 필드(input/output/reasoning/cached)가 채워지는지,
JSON 산출물 3종이 생성되는지, 그리고 본 실행의 예상 호출량과 비용
(`--repeats=25` = 1,200회)입니다.

**사전 점검은 게이트입니다 (harness가 강제)**

`--repeats`가 5를 넘으면 harness가 본 실행으로 보고, `--preflight=<경로>`로
사전 점검 산출물을 요구합니다. 통과 기준은 "사전 점검을 돌렸다"가 아닙니다 —
**네 arm이 모두 있고 각각 최소 한 번은 실제로 응답했어야** 합니다. 전부 오류가
난 사전 점검은 이 게이트가 잡으려는 바로 그 상황입니다. 근거 없이 진행하려면
`--preflight-override="<사유>"`를 주며, 사유는 화면과 manifest에 남습니다.

**2) 본 실행**

```
npm run eval:default-model -- --repeats=25 \
  --preflight=artifacts/default-model-eval-preflight.json \
  --json=artifacts/default-model-eval-<timestamp>.json \
  --max-cost-usd=<한도>
```

`--max-cost-usd`는 누적 provider 비용이 한도를 넘는 순간 멈춥니다. 멈춘 실행은
`TRUNCATED BY --max-cost-usd`로 보고되고 manifest에 남습니다 — 이후 시나리오는
표본이 아예 0이므로, arm별 실행 수가 몇이든 완전한 비교가 아닙니다. 판정은 arm
경계가 아니라 repeat 경계에서 끊어 round-robin이 지키려던 균형을 깨지 않습니다.

**공급자 오류는 품질 실패가 아닙니다.** arm의 provider 오류율이 100%면 성공률이
0%로 나오는데, 이는 모델이 모든 시나리오에 실패한 것과 숫자가 같습니다. 실제로는
**묻지도 못한** 것입니다 — 이 작업 환경이 정확히 그 상태입니다(egress proxy가
`api.openai.com`을 막습니다). harness가 arm마다 `outcome`을 붙입니다.

| outcome | 뜻 |
|---|---|
| `measured` | 품질 규칙을 판정할 수 있음 |
| `inconclusive` | 절반 넘게 실패 — 살아남은 실행은 대표 표본이 아님 |
| `provider_unavailable` | 전부 실패 — **품질에 대해 아무것도 말하지 않음** |
| `not_run` | 실행 없음 |

**harness는 아무것도 은퇴시키지 않습니다.** DB에 쓰지 않고, 카탈로그를 고치지
않으며, 다른 무엇이 읽는 플래그를 세우지 않습니다. 산출물은 화면 출력과 `--json`
artefact뿐이고, manifest 자체에 그 사실이 적힙니다.

**`baseline, none, low, medium` 네 arm을 같은 commit·같은 환경·같은 실행에서**
돌립니다. harness는 일부 arm만 돌면 `PARTIAL RUN`을, 작업 트리가 dirty면 경고를
출력합니다. arm은 시나리오·repeat 단위로 **교대 실행(round-robin)**되므로 공급자
상태 변화가 특정 arm에 몰리지 않습니다.

**3) 실행 증거 보존**

`--json`을 주면 다음이 저장됩니다. **`--json` 없이 돌린 실행은 인용할 수 없습니다.**

- `<name>.json` — manifest + arm 요약 + 시나리오별 통계 + 원본 기록
  (성공·오류·빈 응답 각각, 실행 시각 포함)
- `<name>-review.json` — 블라인드 정성 검토용 (arm 코드만, 모델명 없음)
- `<name>-review-key.json` — 봉인된 arm 매핑

manifest에 담기는 것: commit SHA와 dirty 여부, 시작·종료 UTC 시각, Node 버전,
arm별 **실제 provider model slug**·reasoning 설정·`pricingVersion`·`costSource`·
`reservationOutputBasis`, repeats, 시나리오 수, 표본 하한값.

`artifacts/`는 `.gitignore` 대상입니다. 실제 과금된 응답 원문이라 저장소에
넣지 않고, **파일은 결정 기록과 함께 보관하고 manifest 요약과 판정 결과는
`.github/audits/`에 한국어 보고서로 남깁니다**(이 저장소의 기존 감사 문서 관례).

산출물에 **API 키나 자격증명은 들어가지 않습니다** — 오류 메시지는 저장 전에
마스킹됩니다. 시나리오 프롬프트는 이 파일에 고정된 자체 문구이므로 사용자 데이터가
포함되지 않습니다. region 등 manifest가 자동으로 알 수 없는 항목은 실행자가
보고서에 함께 적습니다.

**4) 정량 결과와 블라인드 정성 검토 병행**

자동 판정은 keyword, JSON 형태, 거부 표현 같은 단순 검사입니다. 수치 통과와
별개로 **모델명을 가린 상태에서** 실패 사례와 경계 응답을 사람이 읽습니다
(`-review.json`을 먼저 검토하고, 결론을 적은 뒤에 `-review-key.json`을 엽니다).
중점: 한국어 자연스러움, 안전 거부와 잘못된 거부, 장문 지시 유지, 응답 완결성,
그리고 reasoning 토큰을 포함한 실제 비용이 제대로 산정됐는지.

**5) 독립 재실행**

다른 시간대에 같은 조건으로 한 번 더 돌립니다. **결과가 임계값에 가까우면
재실행 없이 은퇴를 결정하지 않습니다.** transient 오류(rate limit·overload)가
보고되면 특정 arm에 몰렸는지부터 확인합니다.

**6) staging 수동 검증은 그대로 남습니다**

공급자를 직접 호출하는 eval은 PDF·첨부, native web search, 스트림 중단,
desktop/mobile hydration을 검증하지 못합니다. 4.2와 8절을 별도로 수행합니다.

### 4.6 은퇴 준비 점검 — 수치와 별개로 통과해야 합니다

4.3은 "Luna가 mini만큼 답을 잘 하는가"만 답합니다. 은퇴는 그보다 넓은 결정이라
아래를 별도로 확인하고, 결과를 근거와 함께 남깁니다.

1. **기존 mini 사용량과 고정 사용자 비율.** 최근 30일 mini 요청 수·대화 수와,
   mini를 **명시적으로 선택해 계속 쓰는** 사용자 비율. 기본값이라서 남아 있는
   계정과 의도적으로 고른 계정을 구분합니다. 후자가 유의미하면 유예기간과
   안내가 필요합니다.
2. **Luna 대체 시 기능·도구 호환성.** mini 사용자가 실제로 쓰던 경로에서
   확인합니다 — 첨부·PDF·이미지, tool calling, structured output, native web
   search(mini는 `unverified`, Luna는 `native`이므로 동작이 달라지는 쪽),
   comparison·AI Review 조합.
3. **Support 영향과 기존 공유 링크.** mini를 언급한 support 매크로·FAQ·도움말,
   그리고 mini로 생성된 **공개 공유 링크와 내보내기**가 은퇴 후에도 정상적으로
   열리고 모델명이 그대로 보이는지.
4. **사용자 안내 또는 유예기간 필요 여부.** 필요하다면 공지 문구, 대상, 시점,
   유예기간 길이를 먼저 확정합니다. "필요 없음"도 근거와 함께 기록합니다.
5. **staging 검증.** 기존 mini 대화 재개, 모델 교체 동작, favorites·recents
   복구, `/api/chat`의 410 + replacement 응답을 staging에서 실제로 확인
   (8절과 동일 절차).

### 4.7 긴급 운영 비활성화 — 품질 eval과 분리합니다

**공급자 장애, 모델 폐기, 보안·규제 사유로 mini를 즉시 내려야 하는 상황은
4.3·4.6을 기다리지 않습니다.** 품질 평가는 "이 모델을 카탈로그에서 은퇴시킬
것인가"라는 제품 결정이고, 운영 비활성화는 "지금 이 모델을 호출할 수 있는가"라는
가용성 사실입니다. 둘을 같은 게이트에 묶으면 장애 대응이 eval을 기다리게 됩니다.

- 즉시 조치는 **Admin Console의 운영 lifecycle**(또는 동등한 운영 스위치)로
  하고, `operationalReason`에 사유와 근거(공급자 공지, probe 결과, 사건 번호)를
  적습니다.
- `operationalReason`은 **제품 은퇴와 운영 중단을 구분해야 합니다.** 문구가
  "Tomverse retired…"인지 "provider outage / provider shutdown…"인지로 나중에
  구분됩니다.
- 긴급 비활성화는 **이 문서의 은퇴가 아닙니다.** `scripts/run-default-model-reconciliation.mjs`를
  자동으로 딸려 실행하지 않고, 마케팅 갱신도 강제하지 않습니다. 상황이 끝나면
  원상 복구하거나, 그때 정식 은퇴 절차를 따로 밟습니다.
- 공급자가 실제로 `gpt-5.4-mini` 서비스를 종료한 경우에는 4.3·4.6이 아니라
  공급자 종료를 근거로 은퇴하며, `operationalReason`이 그렇게 적혀야 합니다.

## 5. 은퇴 조건과 절차 (아직 실행하지 않음)

4.3(수치)과 4.6(준비 점검)을 **모두** 만족했을 때에만 다음을 적용합니다.
긴급 상황은 4.7을 따릅니다.

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

### 5.1 마케팅 갱신 — 은퇴 변경의 릴리스 필수 조건

마케팅은 카탈로그를 따라가지 않습니다. 모델 이름을 **손으로** 적어 두기 때문에,
은퇴하면 아무도 고를 수 없는 모델을 계속 광고하고, 준비된 비교 deep link는 페이지
설명과 다른 모델로 조용히 resolve됩니다. 그래서 은퇴와 **같은 변경**에 포함합니다.

`lib/marketingModelReferences.ts`가 공개 마케팅이 지목하는 모델 ID의 단일
출처이고, `tests/marketingModelReferences.test.mjs`가 그 ID들이 실제로
`enabled && publiclyListed`인지 검사합니다. **mini를 은퇴시키면 이 테스트가
실패합니다.** 이것이 마케팅 갱신을 잊지 못하게 하는 장치입니다. 다만 테스트는
ID만 봅니다 — 아래는 사람이 함께 옮겨야 합니다.

- **제목·본문·CTA·배지·결과 라벨**: `components/marketing/ChatGptVsClaudeGuide.tsx`의
  `ctaTitle`, 방법론 고지, `ModelBadge`, `ResultCard`, `PreviewPanel`.
- **한국어와 영어 문구 양쪽.** 한쪽만 고치면 언어에 따라 다른 모델을 광고합니다.
- **SEO·구조화 데이터·metadata**: `components/marketing/searchIntentContent.ts`의
  `metadataTitle`, `metadataDescription`, `updated` 라인(en·ko 모두).
- **모델 비교 링크와 기존 deep link**: `?models=` 파라미터. 외부에 이미 배포된
  링크는 replacement resolver가 받아 주지만, 페이지 문구와 어긋나지 않는지
  확인합니다.
- **golden 및 마케팅 캡처 fixture**: `scripts/capture-marketing-proof.mjs`,
  `scripts/capture-week1-marketing-kit.mjs`, `scripts/capture-week1-marketing-kit-en.mjs`와
  대응하는 `validate:*`. 이들은 별도 상수를 갖고 있어 위 테스트가 잡지 못합니다.

**기존 결과 예시는 이름만 바꾸면 안 됩니다.** 페이지에 실린 GPT 쪽 예시 답변이
mini로 생성된 것이라면, 둘 중 하나만 허용됩니다.

1. 같은 프롬프트와 기록된 설정으로 **Luna 결과를 다시 생성**해 교체하거나,
2. 해당 예시가 **과거 mini 비교 결과임을 문구로 유지**한다.

라벨만 Luna로 바꾸는 것은 Luna가 낸 적 없는 답변을 Luna의 것으로 제시하는
것이므로 허용하지 않습니다.

**반대 방향의 금지 사항:** 과거 대화, 사용량 ledger, 내보내기, 감사 기록의
`gpt-5-4-mini` ID는 변경하거나 일괄 치환하지 않습니다. 은퇴 후에도 기존 기록은
그대로 해석돼야 하고, 화면에는 여전히 "GPT-5.4 mini"로 보여야 합니다.

## 6. 잔여 위험

- **live 확인은 여전히 불가.** 2026-08-02 재확인 결과 이 환경의 egress proxy가
  `api.openai.com`을 여전히 막습니다(`Host not in allowlist`).
  `npm run check:openai-model-access`가 그 상태를 `forbidden`으로 분류하고
  **"모델을 볼 수 없다"가 아니라 "가시성을 확인하지 못했다"**로 보고합니다.
  운영자가 production key로 한 번 실행해야 합니다. 그 결과는 가시성 근거일 뿐
  가격 근거가 아닙니다.
- **문서 수치의 근거.** 이 작업 환경의 egress proxy가
  `developers.openai.com`과 `api.openai.com`을 모두 403으로 차단해, 공식 모델
  페이지와 인증된 `GET /v1/models` 응답을 직접 확인하지 못했습니다. 이 문서의
  apiModel·가격·context·최대 출력 수치는 작업 지시서가 제시한 공식 값과,
  같은 값을 독립적으로 기록한 `.github/audits/model-catalog-2026-08-01.md`
  (2026-08-01 인증 live catalog 대조 결과)에 근거합니다. **배포 전에 live
  `/v1/models`로 두 slug와 지원 상태를 재확인해야 합니다.**
- **eval 미실행.** 같은 이유로 provider 호출이 불가능해
  `scripts/evalDefaultModel.mjs`를 한 번도 실행하지 못했습니다(harness 자체는
  동작하며, 이 환경에서는 provider 오류율 100%로 보고합니다). 4.3의 어떤
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
   `reconcileStaticCatalogMetadata()`이 이 exact ID에 대해서만 가격,
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
   (`npm run maintenance:default-model-reconciliation`). 기본은 dry run이며
   dry run에는 아무 승인도 필요 없습니다 — 무엇이 바뀔지 보는 것은 안전한
   절반이고 한 명령 거리에 있어야 합니다. **쓰기에는 전부가 필요합니다.**

   ```
   npm run maintenance:default-model-reconciliation -- \
     --apply --approved-retirement --ticket="<url>" --actor="<이름>" \
     --from=gpt-5-4-mini --to=gpt-5-6-luna
   ```

   `--apply` 하나로는 "은퇴가 이 배포에 실려 있다"와 "누가 명령을 복사했다"를
   구분할 수 없고, 그 차이가 이 행들이 **낡은 포인터인지 살아 있는 사용자
   선택인지**를 가릅니다. 그래서 은퇴 명시 · 티켓 · 실행자 · 대상/대체 모델을
   모두 요구하고, 대상이 다르면 조용히 방향을 바꾸는 대신 거부합니다.

   **CI와 npm의 build·start·deploy·migrate·postinstall lifecycle 단계에서는
   승인이 아무리 완전해도 쓰지 않습니다.** 스스로 도는 reconciliation은 은퇴를
   결정하기도 전에 모든 계정의 저장된 모델을 옮깁니다. 판정은
   `lib/reconciliationApprovalCore.ts`(순수)에 있고
   `tests/reconciliationApprovalCore.test.ts`가 전체 matrix를 검증하며, 같은
   테스트가 **저장소 안의 어떤 스크립트·workflow·package script도 이 명령을
   스스로 실행하지 않는지** 확인합니다.

   **이 스크립트는 은퇴 배포와 함께 실행합니다.** mini가 아직 정상 동작하는
   동안 사용자의 선택을 덮어쓰지 않기 위해서입니다.

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
   `reconcileStaticCatalogMetadata()`을 실행하고
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

### 은퇴까지의 전체 순서

품질 판정, 운영 관측, 제품 결정, 적용을 이 순서로 분리합니다. 앞 단계를 건너뛴
채 뒤 단계를 시작하지 않습니다.

1. **eval 계약 보강** — 4.3의 표본 등급·구간 판정과 4.6의 준비 점검 항목을
   확정한다. (완료: 이 문서)
2. **eval 실행** — decision-grade(arm당 ≥300, 권장 500)로 baseline vs
   none/low/medium을 돌리고 구간과 함께 결과를 보관한다.
3. **telemetry 병행 수집** — 같은 기간에 4.6의 사용량·고정 사용자 비율과
   3.1의 출력 토큰 분포를 모은다. eval과 병행이지 순차가 아니다.
4. **은퇴 승인** — 4.3(수치)과 4.6(준비 점검)을 모두 충족했는지 사람이
   판단하고, 안내·유예기간 여부를 확정한다.
5. **한 변경으로 적용** — 카탈로그(5절), 마케팅 문구·SEO·링크·캡처
   fixture(5.1), 테스트를 **하나의 변경**에 담는다. 나눠서 배포하면 그 사이
   구간 동안 페이지가 고를 수 없는 모델을 광고한다.

적용 단계의 실행 순서:

1. 5절대로 `lib/models.ts`를 수정하고, 5.1의 마케팅·SEO·fixture와
   `lib/marketingModelReferences.ts`를 같은 변경에 포함해 배포 →
   `reconcileStaticWithdrawals()`가 운영 행에 withdrawal을 반영.
2. `npm run maintenance:default-model-reconciliation` (dry run으로 건수 확인)
3. `npm run maintenance:default-model-reconciliation -- --apply`
4. malformed로 보고된 대화를 사람이 확인.
5. 8절 재확인 + 공개 페이지·공유 링크·내보내기 실제 확인.

긴급 상황(공급자 장애·폐기)은 이 순서를 따르지 않습니다 — 4.7.

### 은퇴 롤백

`lib/models.ts`의 lifecycle 필드를 되돌리고 배포합니다. 사용자 선택은 이미
Luna로 옮겨졌지만, 두 모델 모두 Guest/Standard 1크레딧이므로 되돌려도 접근
권한과 과금에는 차이가 없습니다. 이전 선택을 되살릴 필요는 없습니다.
