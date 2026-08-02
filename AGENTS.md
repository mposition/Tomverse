<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 소통 언어

이 저장소에서 작업할 때는 **사용자와의 모든 대화를 한국어로** 진행합니다.
설명, 계획, 작업 결과 보고, 질문, 확인 요청 모두 해당됩니다. 사용자가 영어로
질문하더라도 별도 요청이 없으면 한국어로 답합니다.

한국어로 쓰지 않는 것 — 저장소에 이미 자리 잡은 관례를 따릅니다.

- code identifier, 파일명, `data-testid`, test 제목
- 소스 코드 주석
- commit message, PR 제목과 본문
- 사용자에게 보이는 제품 문구(`locales/*.ts`가 언어별로 관리)

즉, **사람에게 말할 때는 한국어, 저장소에 남기는 코드·이력은 기존 영어 관례**
입니다. `.github/audits/` 아래 감사·작업 보고서처럼 이미 한국어로 작성된
문서는 계속 한국어로 씁니다.

# Accent colour roles

UI-012에서 승인된 정책(B안)입니다. accent 색은 **hue가 아니라 역할로** 지정합니다.
`app/globals.css`에 역할별 token이 정의돼 있고, `npm run check:accent-tokens`가
아래 규칙을 강제합니다. PR Fast Gate의 static 단계에서 실행됩니다.

## 역할과 token

| 역할 | token 접두사 | 현재 palette |
|---|---|---|
| AI Review | `accent-ai-review-start\|mid\|end-*`, `tomverse-accent-*`, `tomverse-review-*` | cyan → blue → purple |
| Deep Research | `accent-deep-research-*` | violet |
| Web Search | `accent-web-search-*` | sky |
| Model Catalogue | `accent-model-catalogue-*` | purple |
| Max plan | `accent-plan-max-*` | purple |
| Promotion | `accent-promotion-*` | emerald |
| Account identity | `accent-account-*` | teal |
| 성공·검증 상태 | `status-success-*` | emerald |

## 규칙

1. **`cyan → blue → purple` gradient 전체 조합은 AI Review 전용으로 예약**합니다.
   다른 기능은 이 조합을 쓰지 않습니다. `accent-ai-review-*` token을 AI Review
   외 component에서 쓰면 검사에서 실패합니다.
2. **역할이 다르면 값이 같아도 token을 분리**합니다. `accent-promotion`과
   `status-success`는 오늘 둘 다 emerald지만 별개 결정이며, 한쪽을 바꿔도
   다른 쪽이 따라 움직여서는 안 됩니다. `accent-model-catalogue`와
   `accent-plan-max`(둘 다 purple)도 같습니다.
3. **guarded 파일 안에서는 raw accent utility 금지.** `bg-violet-500`,
   `text-emerald-600` 같은 직접 지정 대신 역할 token을 씁니다. 대상 hue는
   `cyan`, `emerald`, `fuchsia`, `purple`, `sky`, `teal`, `violet`입니다.
   `blue`·`zinc`(기본 인상)와 `red`·`amber`(오류·크레딧 상태)는 대상이 아닙니다.
4. **신규 역할은 token부터.** `app/globals.css`에 역할 namespace를 추가하고
   `scripts/check-accent-tokens.mjs`의 `KNOWN_ROLES`에 등록한 뒤 사용합니다.
   token 없는 역할 utility는 검사에서 실패합니다.
5. **guarded 목록은 역할을 token으로 옮긴 파일만** 포함합니다
   (`scripts/check-accent-tokens.mjs`의 `GUARDED_FILES`). admin console과
   일반 status 색은 아직 대상이 아니며, design decision 없이 범위를 넓히지
   않습니다.

예외가 필요하면 이 문서에 근거를 적고 나서 추가합니다.

# Credit entitlement vs operational guardrail

크레딧·비용 한도를 건드리기 전에 읽습니다.

- `docs/policy/credit-and-cost-limits.md`

절대 조건:

- **사용자 entitlement는 크레딧입니다.** 플랜 크레딧과 구매 크레딧이 사용
  권한을 정하며, 그 위에 숨은 USD 한도를 두지 않습니다.
- **operational guardrail은 별개 층입니다.** 이름(`CHAT_COST_GUARDRAIL_*`),
  오류 코드(`OPERATIONAL_COST_GUARDRAIL_TRIGGERED`, `PROVIDER_BUDGET_EXHAUSTED`),
  버킷(`op-cost-*`), 지표를 entitlement와 섞지 않습니다.
- guardrail 한도는 플랜 크레딧에서 유도하며, 환경변수 override는 유도값
  아래로 내려갈 수 없습니다(`lib/chatCostGuardrails.ts`가 강제).
- 모든 enabled premium 모델은 `lib/modelPricing.ts`에 명시적 가격 profile을
  가져야 합니다. `npm run check:model-pricing`이 PR Fast Gate에서 fail-closed로
  검사합니다.
- **`ModelRegistryEntry`의 가격 컬럼이 `NULL`이면 코드 profile을 상속하고,
  숫자면 관리자 override입니다.** seed는 항상 `NULL`을 쓰고 reconciliation은 이
  세 컬럼을 아예 쓰지 않습니다. 해석된 가격을 행에 다시 넣으면 장문 tier가
  사라지고 `costSource`가 전부 override로 보고돼 fallback 지표가 0%가 됩니다.
  확인은 `npm run check:model-pricing-db`.
- **처리 tier를 요청에 넣지 않습니다.** 모든 profile이 Standard 가격이며, 이는
  아무 요청도 `service_tier`를 지정하지 않는 동안에만 참입니다(생략 시 OpenAI
  기본값은 `auto`). `npm run check:model-pricing`이 request-side tier 지정을
  fail-closed로 막습니다.
- **`GET /v1/models`는 가격 출처가 아닙니다.** 계정별 모델 가시성만 확인합니다
  (`npm run check:openai-model-access`).
- cache write 가격은 감사용으로 기록만 하고 과금하지 않습니다 — cache write
  토큰을 보고하는 usage adapter가 없습니다.
- 가격이 아직 검증되지 않은 premium 모델은 `PENDING_VERIFIED_PRICE_REGISTER`에
  담당자·검증 티켓·등록일·기한·production 승인과 함께 등록합니다. 기한(최대
  90일)이 지나면 같은 검사가 경고에서 실패로 바뀝니다. fallback 사용 비율과
  예약 대비 정산 비율은 `GET /api/admin/fallback-pricing`에서 봅니다.
- **provider 예산은 production에서 반드시 명시합니다.** production 기본값은
  없고, 활성 provider에 `CHAT_PROVIDER_*_COST_MICROUSD_PER_DAY`/`_PER_MONTH`가
  없으면 `/api/ready`가 실패합니다. 단일 계정의 plan guardrail보다 낮은 값은
  바닥으로 올려 강제하고 보고합니다. 환경변수를 **먼저** 배포하고 코드를
  나중에 배포합니다. 현황은 `GET /api/admin/provider-budgets`에서 봅니다.
- 가격 변경은 소급 적용하지 않습니다. `pricingVersion`과 `costSource`를
  reservation·settlement snapshot에 저장합니다.
- 사용자 응답에 원시 내부 USD를 노출하지 않습니다. `internal*` 진단 필드는
  `publicChatErrorDetails()`가 제거하고, Admin Console과 구조화 로그에만
  남깁니다.
- 모든 오류 응답의 `resetAt`은 생성 시점보다 미래여야 합니다.
- 이 계약을 어기는 변경은 릴리스 차단 사유입니다.

# Plan change (Pro <-> Max)

플랜 변경 CTA나 `/api/billing/checkout`의 차단 분기를 건드리기 전에 읽습니다.

- `docs/policy/plan-change.md`

**Pro↔Max 온라인 변경은 전용 엔드포인트로만 합니다.** `/api/billing/checkout`은
변경을 수행하지 않으며 앞으로도 하지 않습니다.

- 서버는 동일 플랜 재구매와 다운그레이드를 `PLAN_CHANGE_NOT_SUPPORTED`로,
  활성 구독 상태의 상위 플랜 요청을 `ACTIVE_SUBSCRIPTION_EXISTS`로 각각 409
  차단합니다. **이 세 분기는 그대로 둡니다.** 풀면 신규 구독 Checkout으로 변경을
  우회할 수 있게 되고, 한 계정이 두 플랜을 동시에 결제합니다.
- 변경은 `app/api/billing/plan-change/**`(preview · confirm · 조회 · 예약 취소)가
  수행하고, 판정은 `lib/planChangeStateMachine.ts`(순수), Stripe 실행은
  `lib/planChangeService.ts`가 맡습니다. 이 분담을 섞지 않습니다.
- **결제 전에 권한을 올리지 않습니다.** 업그레이드는
  `proration_behavior=always_invoice` + `payment_behavior=pending_if_incomplete`로
  보내고, 계정의 plan은 오직 `syncSubscription()`이 Stripe에서 다시 읽은 구독으로
  옮깁니다.
- **다운그레이드는 Subscription Schedule을 직접 관리합니다.** Customer Portal은
  같은 interval의 Price 여러 개를 한 Product에 두지 못하므로 이 변경을 담지
  못합니다. Portal을 실행 경로로 되돌리지 않습니다.
- **`cancel_at_period_end`를 자동으로 해제하지 않습니다.** 별도 opt-in(별도 label을
  가진 별도 control)에서 온 `resumeRenewal`이 있을 때만 해제합니다.
- **같은 interval끼리만 허용합니다.** 월간↔연간 변경은 아직 없습니다. 구독
  interval을 모르는 계정은 CTA가 `manage_plan`(고객지원)으로 남습니다.
- 크레딧 산식은 `lib/planChangeCredits.ts`에 있습니다. 플랜 변경은 월 사용량을
  초기화하지도, 추가 지급하지도, 이미 쓴 크레딧을 회수하지도 않습니다.
  업그레이드와 다운그레이드가 같은 함수를 씁니다.

# Default model (GPT-5.6 Luna)

`DEFAULT_MODEL_ID`, 게스트 기본값, `gpt-5-4-mini`의 lifecycle을 건드리기 전에
읽습니다.

- `docs/policy/default-model-luna-migration.md`

- **"기본 모델"은 두 개의 다른 결정입니다.** 게스트 첫 대화는 DB의
  `AppSetting["guestDefaultModelId"]`이고 brand trio 중 **선두만** 정합니다.
  신규 로그인 계정은 `DEFAULT_MODEL_ID` → `APP_DEFAULTS.defaultModelId` →
  `UserSettings.defaultModel` 컬럼 기본값 → `app/api/user/settings/route.ts`가
  만드는 행입니다. 둘을 섞지 않습니다. `npm run check:default-models`가 양쪽을
  함께 읽고 PR Fast Gate에서 검사합니다.
- **trio 밖의 모델은 `guestDefaultModelId`로 저장할 수 없습니다.** resolver가
  무시하므로 저장은 되고 효과는 없는 설정이 됩니다. `guestDefaultLeadRejection()`
  이 거부합니다.
- **기본 모델은 `gpt-5-6-luna`입니다.** `lib/models.ts`의 `DEFAULT_MODEL_ID`,
  `lib/appDefaults.ts`의 `GUEST_DEFAULT_MODEL_ID`와 `GUEST_BRAND_TRIO_MODEL_IDS`,
  Prisma 컬럼 기본값이 함께 움직입니다. 한쪽만 바꾸지 않습니다.
- **`gpt-5-4-mini`는 은퇴하지 않았습니다.** enabled·publiclyListed 상태를
  유지하는 것은 의도된 관찰 기간입니다.
- **수치 eval 통과는 은퇴의 필요조건이지 충분조건이 아닙니다.** 정책 문서
  4.3(수치)과 4.6(사용량·고정 사용자 비율, 도구 호환성, support·공유 링크,
  안내·유예기간, staging 검증)을 **모두** 충족해야 은퇴할 수 있습니다.
- **eval 표본 하한은 규칙마다 다릅니다.** 합산 규칙(오류율·빈 응답률)은 arm당
  ≥300(권장 500), **시나리오별 5%p 규칙은 시나리오당 ≥100**입니다 —
  `--repeats=25`면 시나리오당 25회라 해상도가 4%p여서 5%p 기준을 판정할 수
  없습니다. 판정은 점추정이 아니라 Wilson 95% 구간 경계로 합니다.
- **`--repeats=25`를 돌렸다는 사실만으로 decision-grade가 아닙니다.** 정책 문서
  4.5.1의 절차 — 사전 점검, 네 arm 동일 commit·동일 실행, `--json` 증거 보존
  (manifest·원본 기록·블라인드 검토 세트), 블라인드 정성 검토, 다른 시간대
  독립 재실행, staging 수동 검증 — 을 모두 묶어야 인용할 수 있습니다.
  `scripts/evalDefaultModel.mjs`가 `SMOKE RUN`·`PARTIAL RUN`·`UNDERPOWERED`·
  dirty tree를 경고로 출력합니다.
- **긴급 운영 비활성화는 품질 eval과 분리합니다.** 공급자 장애·폐기·보안 사유는
  4.3·4.6을 기다리지 않고 운영 lifecycle로 즉시 내릴 수 있으며, 이는 이 문서의
  은퇴가 아닙니다(4.7). `operationalReason`이 제품 은퇴와 운영 중단을 구분해야
  합니다.
- OpenAI는 `gpt-5.4-mini`를 계속 서비스합니다. 은퇴하더라도 공급자 종료가
  아니라 **Tomverse 제품 카탈로그 결정**입니다.
- **은퇴는 마케팅 갱신과 한 변경으로 배포합니다.** 공개 마케팅이 지목하는 모델
  ID는 `lib/marketingModelReferences.ts` 하나뿐이고
  `tests/marketingModelReferences.test.mjs`가 이를 강제합니다. 문구·CTA·배지·결과
  라벨·ko/en·SEO metadata·deep link·캡처 fixture는 사람이 함께 옮깁니다. mini로
  생성된 예시 답변은 이름만 바꾸지 말고 재생성하거나 과거 결과임을 유지합니다.
- **`reservationOutputBasis`를 p90으로 바꾸려면 정책 문서 3.1의 9개 조건**
  (모델별 독립 산출, 기간·표본 수, workload 분리, 정산된 출력·과금 reasoning
  토큰, 중단·부분 응답 포함, 동질 표본, 감사 보관, 안전 여유·floor, drift 감시)
  을 충족하고 새 `pricingVersion`으로 구분합니다. 그 전까지는
  `conservative_default`를 유지합니다.
- 두 모델 모두 Guest 계층 Standard **1크레딧**입니다. 은퇴 평가 중에 크레딧을
  임의로 바꾸지 않고, 기존 mini 사용자를 Terra·Sol 같은 상위 유료 모델로
  자동 이동시키지 않습니다.
- 사용자 선택 상태(`UserSettings.defaultModel`,
  `Conversation.selectedModels`)의 일괄 이전은
  `scripts/run-default-model-reconciliation.mjs`가 담당하며 **은퇴 배포와 함께**
  실행합니다. dry run은 자유롭지만 **쓰기에는 `--approved-retirement`·티켓·
  실행자·대상/대체 모델이 모두 필요하고, CI와 build/start/deploy/migrate
  lifecycle에서는 어떤 승인으로도 쓰지 않습니다.** `Conversation.selectedModels`는 문자열 치환이 아니라 JSON 배열로
  파싱해 변환하고, malformed 값은 파괴하지 않고 보고합니다.
- 과거 `Message.modelId`, usage reservation/settlement의 modelId와 pricing
  snapshot, 결제 ledger, `catalogDeleted`는 소급 변경하지 않습니다.

<!-- BEGIN:mobile-chat-composer-invariant -->
## Mobile chat composer invariant

Before changing `ChatInput.tsx`, `MobileChatShell.tsx`, composer styles, tool chips, or mobile bottom-dock layout, read:

- `docs/ui-contracts/mobile-chat-composer.md`

Non-negotiable requirements:

- The mobile textarea must always own a dedicated full-width row with at least one complete visible input line.
- Tool, web-search, deep-research, attachment, billing, and model-status controls must never consume the textarea's horizontal row, overlap it, or float above it.
- Increasing ChatMessageList height must never reduce the textarea to residual horizontal space.
- Do not use absolute positioning, negative margins, transforms, or shared grid cells to place controls beside or over the textarea.
- Any mobile composer layout change must include bounding-box, overlap, horizontal-overflow, Korean IME, 320px-width, and 200% text-scaling regression coverage.
- A change that violates this contract is a release blocker.
<!-- END:mobile-chat-composer-invariant -->

<!-- BEGIN:mobile-sidebar-drawer-invariant -->
## Mobile sidebar drawer invariant

Before changing the drawer in `MobileChatShell.tsx`, `ChatSidebar.tsx`'s
`isMobileDrawer` layout, `useVisualViewport.ts`, or the account footer inside the
drawer, read:

- `docs/ui-contracts/mobile-sidebar-drawer.md`

Non-negotiable requirements:

- Every drawer control must be visible or reachable by one vertical scroll on any
  supported viewport, including one shortened by browser chrome, rotation or the
  on-screen keyboard.
- Reachable is measured from the control's centre point with
  `elementFromPoint`, not with `toBeAttached()` or a programmatic `.click()`.
- Exactly one scroll owner at a time: when the drawer scrolls, the conversation
  list must not also be a scroller, and the owner must contain every control.
- The short/tall switch reads the visible viewport (`useShortViewport()`), never
  `window.innerHeight`, a CSS `max-height` query, a device name or a UA string.
- No control may be hidden, demoted behind a "more" affordance, or have its touch
  target, text size, accessible name or focus ring reduced to make room.
- Safe-area insets, modal semantics, focus trapping and focus return are
  preserved, and the page behind the drawer never scrolls in its place.
- Any related change must keep `tests/e2e/mobile-short-viewport-drawer.spec.ts`
  passing across its full viewport/state matrix.
- A change that violates this contract is a release blocker.
<!-- END:mobile-sidebar-drawer-invariant -->

<!-- BEGIN:comparison-action-rail-invariant -->
## Comparison action rail invariant

Before changing `ComparisonActionRail.tsx`, `lib/comparisonReadiness.ts`, the bottom workflow dock in either shell, or the rail's copy, read:

- `docs/ui-contracts/comparison-action-rail.md`

Non-negotiable requirements:

- Desktop and mobile must use the same state-driven disclosure policy: decide with `shouldShowVisualStatus()` in `lib/comparisonReadiness.ts`, never with `layout === "mobile"`, a media query, or any other shell-shaped condition.
- In the normal, all-complete, runnable state the status sentence ("Comparing N completed answers") is visually hidden in both shells, and leaves no row height or bottom gap behind.
- Visually hidden means `sr-only`: the sentence stays in the DOM and in the accessibility tree, and each action keeps the comparison target count in its own `aria-describedby`.
- Generating, too-few-answers, excluded, analysis-running and per-action credit-shortfall states must be visible on screen, with each action describing only its own price and its own reason.
- Any related change must include the desktop *and* mobile state matrix tests (`tests/comparisonReadiness.test.mjs`, `tests/e2e/comparison-action-rail.spec.ts`).
- A change that violates this contract is a release blocker.
<!-- END:comparison-action-rail-invariant -->

<!-- BEGIN:typography-invariant -->
## Typography and font system invariant

Before changing `lib/fonts.ts`, the font tokens or `@utility type-*` roles in `app/globals.css`, `app/layout.tsx`'s font wiring, or `lib/emailTypography.ts`, read:

- `docs/ui-contracts/typography.md`

Non-negotiable requirements:

- Every `font-family` resolves through `--font-ui` or `--font-code`. Never hard-code a family, and never register a font variable that the rendered UI does not actually use.
- Locale families are selected by `:lang()` over the whole subtree, never by per-glyph fallback: `Geist` by default, `Noto Sans KR` for `:lang(ko)`, `Noto Sans SC` for `:lang(zh)`.
- Only the Latin UI face is preloaded. `Geist_Mono`, `Noto_Sans_KR` and `Noto_Sans_SC` stay `preload: false`; verify with `node scripts/report-font-preload.mjs` after a build.
- Webfonts are self-hosted through `next/font`. The browser must never request Google's servers.
- Customer text is never below 11px; body copy and primary controls start at 14px; mobile text inputs stay at 16px.
- `font-black` (900) is limited to headline-sized text (≥18px) and short brand expressions; small buttons, chips, badges and labels use 500–700.
- Monospace is only for code, model IDs, build metadata, verification codes and preserved-formatting input.
- Emails use the single web-safe stack in `lib/emailTypography.ts` and never load a webfont.
- Any related change must keep `tests/typographyPolicy.test.mjs` and `tests/e2e/font-system.spec.ts` passing, and must re-run the mobile composer contract specs.
- A change that violates this contract is a release blocker.
<!-- END:typography-invariant -->
