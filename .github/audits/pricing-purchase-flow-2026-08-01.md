# 로그인 · 요금제 업그레이드 · 추가 크레딧 구매 흐름 정비 (2026-08-01)

/ pricing 의 구매 CTA가 인증 상태와 현재 플랜을 전혀 모르던 문제를 상태 기반
흐름으로 재설계한 작업 기록입니다.

## 1. 근본 원인

세 가지 결함이 겹쳐 있었고, 셋 다 "누가 보고 있는지 모른다"는 같은 뿌리에서
나왔습니다.

### 1-1. 추가 크레딧 CTA가 링크였다

`components/marketing/PricingPageContent.tsx` 는 client component 이지만
`useSession()` 을 쓰지 않았습니다. 추가 크레딧 영역의 CTA는 인증 상태와 무관하게

```tsx
<Link href="/chat">로그인하고 크레딧 구매</Link>
```

하나만 렌더링했습니다. 구매 handler도, `CreditPackPurchaseButton` 연결도
없었습니다. 그래서 **로그인 사용자가 눌러도 구매가 시작되지 않고 `/chat` 웰컴
화면으로 이동**했고, 비로그인 사용자는 로그인 화면조차 거치지 않은 채 채팅으로
보내져 구매 의도(어떤 팩을 고르려 했는지)가 통째로 사라졌습니다.

`CreditPackPurchaseButton` 은 이미 팩 조회 · 선택 · Stripe Checkout 생성까지
갖추고 있었지만 요금 페이지에서는 한 번도 사용되지 않았습니다.

### 1-2. 플랜 CTA가 현재 플랜을 몰랐다

세 카드 모두 같은 CTA를 렌더링했습니다. 결과적으로

- Pro 구독자에게 "Pro로 업그레이드"가 다시 보였고,
- Pro 구독자가 "Max로 업그레이드"를 누르면 `/api/billing/checkout` 이
  `An active subscription already exists.` 로 **409를 반환**했습니다.
  저장소에 구독 변경(proration) 흐름이 없기 때문에 이 CTA는 구조적으로 완결될 수
  없는 dead end였습니다.
- Max 사용자에게 Pro가 "업그레이드"로 표시됐습니다.

### 1-3. 구매 의도와 복귀 위치가 서버까지 전달되지 않았다

- `UpgradeCtaLink` 는 `/pricing?lang&trigger` 만 만들고 **목표 플랜을 URL에
  담지 않았습니다.** 요금 페이지는 무엇을 눌러서 왔는지 알 수 없었습니다.
- credit-pack Checkout의 `success_url` / `cancel_url` 이 `/chat` 로 하드코딩돼
  있었습니다. 요금 페이지에서 시작해도 채팅으로 돌아왔고, `/chat` 에는
  `billing=credits-success` 를 읽는 코드가 아예 없어서 **구매 성공도 취소도
  아무 안내 없이 사라졌습니다.**

## 2. 변경 파일

### 신규

| 파일 | 역할 |
|---|---|
| `lib/purchaseIntent.ts` | 구매 의도 encode/decode, `returnTo` 화이트리스트 검증, Stripe 복귀 URL 생성, 오류 코드 분류, 플랜별 CTA 상태 결정. 순수 함수만 있어 브라우저 · route handler · 단위 테스트가 같은 규칙을 씁니다. |
| `components/billing/purchaseCopy.ts` | 구매 CTA 및 오류 코드별 7개 언어 문구. |
| `components/marketing/usePricingAccount.ts` | `useSession()` + 권위 있는 `/api/user/usage` 를 합쳐 인증 상태 · 실제 플랜 · 활성 구독 여부를 제공. |
| `tests/purchaseIntent.test.mjs` | 위 모듈의 단위 테스트 24건. |
| `tests/e2e/pricing-purchase-cta.spec.ts` | 요금 페이지 구매 funnel 전용 E2E 25건. |
| `prisma/migrations/20260801130000_add_credit_pack_purchase_funnel_events/` | analytics event 이름 CHECK 제약 동기화. |

### 수정

| 파일 | 변경 |
|---|---|
| `components/marketing/PricingPageContent.tsx` | 인증 · 플랜 기반 CTA 상태 기계, 크레딧 팩 모달 연결, 팩별 CTA, Stripe 복귀 배너, funnel analytics. |
| `components/billing/CreditPackPurchaseButton.tsx` | `initialPackId` · `returnTo` · `ctaLocation` · controlled `open` · `hideTrigger` · `onAuthenticationRequired` prop 추가, 401 구분, 오류 코드별 복구 CTA, focus trap · Escape · focus 반환, 중복 Checkout 방지. |
| `components/billing/UpgradeCtaLink.tsx` | `intent` · `target` · `ctaLocation` · `#plans` anchor 를 URL에 보존. |
| `components/marketing/MarketingChrome.tsx` | 로그인 상태에 따른 상단 CTA 문구(7개 언어). |
| `app/api/billing/credit-packs/route.ts` | `returnTo` 수용 후 **서버가** success/cancel URL 구성, 오류 `code` 부여. |
| `app/api/billing/checkout/route.ts` | 동일 플랜 · 다운그레이드 · 활성 구독 업그레이드를 각각 구분해 차단, 오류 `code` 부여, cancel URL에 플랜 · 언어 보존. |
| `app/(site)/(application)/chat/ChatPageClient.tsx` | `billing=credits-success` / `credits-cancelled` 복귀 처리(안내 + 잔액 갱신 + URL 정리). |
| `components/chat/UsageLimitModal.tsx`, `components/chat/UserUsageSummary.tsx`, `components/auth/AuthButton.tsx` | 각 호출 지점에 `returnTo` · `ctaLocation` 전달. 기존 동작은 그대로. |
| `lib/productAnalyticsShared.ts` | funnel event 6종 및 `target_plan` · `authentication_state` · 오류 코드 추가. |
| `tests/typographyPolicy.test.mjs` | import 추가로 행이 밀린 brand span allowlist 위치 갱신. |

## 3. 인증 · 플랜별 CTA 상태표

`resolvePlanCtaState()` 하나가 모든 플랜 카드를 결정합니다.

| 인증 상태 | 현재 플랜 | Free 카드 | Pro 카드 | Max 카드 | 추가 크레딧 |
|---|---|---|---|---|---|
| 확인 중 | – | 중립 loading | 중립 loading | 중립 loading | 중립 loading |
| 비로그인 | – | 무료로 시작 | 로그인하고 Pro 시작 | 로그인하고 Max 시작 | 로그인하고 크레딧 구매 |
| 로그인 | Free | **현재 플랜**(disabled, `aria-current`) | Pro로 업그레이드 | Max로 업그레이드 | 추가 크레딧 구매 |
| 로그인 | Pro (활성 구독) | CTA 없음 | **현재 플랜** | 플랜 관리 + 안내 문구 | 추가 크레딧 구매 |
| 로그인 | Max (활성 구독) | CTA 없음 | 플랜 관리 | **현재 플랜** | 추가 크레딧 구매 |
| 로그인 | Pro (구독 없음, 예: 만료된 Tester Pass) | CTA 없음 | **현재 플랜** | Max로 업그레이드 | 추가 크레딧 구매 |

- 인증 상태 확인이 끝나기 전에는 "로그인하고 구매"도 "구매"도 추측하지
  않습니다. 고정 폭의 중립 CTA를 렌더링하고, 페이지 단위 `role="status"` 하나가
  상태를 안내합니다(카드마다 status를 두면 세 번 읽힙니다).
- **session 이 authenticated 여도 `/api/user/usage` 의 플랜이 도착하기 전에는
  계속 loading 입니다.** 세션의 `plan` 값만 믿는 것이 dead CTA의 원인이었습니다.

### 플랜 변경 정책 (제품 결정 필요 사항)

저장소에는 **구독 변경 흐름이 존재하지 않습니다.** `/api/billing/*` 에는 신규
Checkout 생성과 기간 말 해지(`cancel-subscription`)만 있고, proration · 즉시
적용 · 다음 결제일에 관한 계약이 코드에도 문서에도 없습니다.

따라서 지시서의 "계약이 없으면 임의로 Stripe 구독을 변경하지 않는다" 조항에
따라 다음을 적용했습니다.

- Pro → Max: CTA를 **"플랜 관리"** 로 변경하고 계정 설정(현재는 `/chat` 의 계정
  메뉴)으로 연결. 안내 문구를 함께 표시.
- Max → Pro: 동일하게 "플랜 관리". 신규 Checkout을 만들지 않습니다.
- 동일 플랜: "현재 플랜" disabled.
- 서버도 같은 정책을 강제합니다. 동일 플랜과 다운그레이드는
  `PLAN_CHANGE_NOT_SUPPORTED`, 활성 구독 상태의 상위 플랜 요청은
  `ACTIVE_SUBSCRIPTION_EXISTS` 로 각각 409를 반환합니다. 이전에는 활성 구독이
  붙어 있을 때만 막았기 때문에, Stripe 구독 없이 플랜을 보유한 계정(Founding
  Tester Pass)이 같은 플랜을 다시 결제할 수 있었습니다.

**후속 제품 결정이 필요합니다.** in-app 플랜 변경(Pro → Max 즉시 적용 +
proration, Max → Pro 기간 말 적용)을 지원할지 결정되면 그때
`resolvePlanCtaState()` 의 `manage_plan` 분기를 실제 변경 흐름으로 바꾸면
됩니다. 결정 전까지 "작동하지 않는 업그레이드 CTA"는 존재하지 않습니다.

### 후속 (2026-08-01, 릴리스 이후)

승인된 플랜 변경 정책이 `docs/policy/plan-change.md` 로 확정됐고, AGENTS.md 에
서버 409 차단을 UI 보다 먼저 풀지 말라는 규칙을 추가했습니다. 정책 자체는 아직
구현하지 않습니다 — 크레딧 경제성 결정과 웹훅 보강이 선행 조건입니다.

이번에 함께 고친 것은 CTA 의 정직성 두 가지입니다.

- **`manage_plan` CTA 의 목적지.** `/chat?lang=..` → `/support?topic=billing&lang=..`.
  계정 설정은 구독을 *해지* 할 수 있을 뿐 *변경* 할 수 없으므로, 거기로 보내는
  것은 409 로 끝나는 결제와 같은 dead end 였습니다. 지원 폼은 실제로 플랜 변경
  요청을 처리하며, `?topic=` 으로 "결제" 분류가 미리 선택된 상태로 도착합니다.
- **문구.** "이용 중인 구독의 플랜 변경은 계정 설정에서 진행합니다" 는 할 수 있는
  일을 암시했습니다. 이제 "온라인 플랜 변경은 아직 지원하지 않습니다. 고객지원이
  대신 변경해 드립니다" 로 사실을 먼저 말합니다(7 개 언어).

## 4. Checkout 복귀 정책

| 시작 위치 | 성공 | 취소 |
|---|---|---|
| `/pricing` 추가 크레딧 | `/pricing?lang=..&pack=..&billing=credits-success#credit-packs` — 섹션 상단에 구매 완료 안내 | `/pricing?...&billing=credits-cancelled#credit-packs` — 취소 안내 + 선택했던 팩 복원 |
| 채팅 사용량 모달 · 사용량 위젯 · 계정 설정 | `/chat?lang=..&pack=..&billing=credits-success` — toast + 잔액 즉시 갱신, 대화 상태 유지 | `/chat?...&billing=credits-cancelled` — 결제되지 않았음을 안내 |
| 구독 Checkout 취소 | – | `/pricing?billing=cancelled&plan=..&lang=..#plans` — 플랜 영역에 안내 |

- 복귀 URL은 **서버가 만듭니다.** client 는 `returnTo` 를 *제안* 만 하고,
  `buildCreditPackReturnUrls()` 가 화이트리스트 검증 후 통과하지 못하면
  `/chat` 으로 대체합니다.
- 안내를 소비한 뒤 `billing` · `pack` · `plan` 파라미터는 `replaceState` 로
  제거합니다. 새로고침이나 링크 공유로 구매 완료가 다시 안내되지 않습니다.
- 복귀 URL에서는 `intent` · `target` 을 제거합니다. 구매가 끝났는데 팩 선택
  모달이 다시 열리지 않도록 하기 위해서입니다.

## 5. 보안 검증

`sanitizeReturnTo()` 가 유일한 통로이며 다음을 강제합니다.

1. 문자열, 512자 이하, `/` 로 시작.
2. `//`, `/\` 로 시작하는 protocol-relative 형태 거부.
3. 제어문자 · 공백(문자열 내부) 및 그 percent-encoded 형태 거부 — URL parser 가
   보는 문자열과 검사한 문자열이 달라지는 우회를 막습니다.
4. base origin 에 대해 파싱한 뒤 `origin` 이 바뀌면 거부.
5. pathname 이 허용 목록(`/pricing`, `/chat`)에 있어야 함.
6. query 는 허용 key 만 남기고(각 100자 이하) 나머지는 **버립니다.**
7. hash 는 알려진 anchor(`plans`, `credit-packs`)만 허용.

차단 확인 항목: `//evil.com`, `///evil.com`, `/\evil.com`, `/\/evil.com`,
`https://evil.com/pricing`, `http://evil.com`, `javascript:`, `data:`,
`/%2f%2fevil.com`, `/\t/evil.com`, `/\n//evil.com`, `/pricing/../../evil`,
`/admin/overview`, 문자열이 아닌 값. (`tests/purchaseIntent.test.mjs`)

그 밖에:

- `returnTo` 는 zod 에서 512자로 1차 제한된 뒤 서버 검증을 거칩니다. client
  문자열이 그대로 Stripe 에 전달되는 경로는 없습니다.
- 로그인 callback URL도 같은 함수를 통과합니다(`buildPurchaseSignInHref`).
- analytics 에는 이메일 · 이름 등 개인정보를 넣지 않습니다. E2E 가 전송된
  event 전체를 직렬화해 계정 이메일과 이름이 없음을 확인합니다.
- 중복 Checkout: `checkoutInFlightRef` 가 state commit 전에 잠깁니다. 성공 시
  ref 를 해제하지 않고 document 를 교체하므로, 이동 중 추가 클릭이 두 번째
  session 을 만들 수 없습니다. 서버 rate limit(분 5회 / 일 20회)은 그대로입니다.
- 오류 응답 원문은 사용자에게 노출하지 않습니다. 코드 → 문구 매핑만 표시하고
  재시도 가능 / 재로그인 필요 / Support 필요를 구분합니다.

## 6. 테스트 결과

| 항목 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npx eslint . --max-warnings=0` | 통과 |
| `node scripts/check-accent-tokens.mjs` | 통과 (guarded 15개 파일, 10개 역할) |
| `npm run check:encoding` | 통과 |
| `npm run test:unit` | 715 / 715 통과 (신규 24건 포함) |
| `npm run security:regression` | 116 / 116 통과 |
| `npm run verify:smoke-coverage` | 통과 (@smoke 21건, 14개 필수 영역) |
| `npm run build` | 통과, `/pricing` 은 여전히 `○ (Static)` |
| `pricing-purchase-cta.spec.ts` (desktop-chromium + mobile-chromium) | 통과 |
| desktop-chromium 전체 1023건 | 아래 참조 |

### desktop-chromium 전체 회귀 결과

전체 실행에서 `analytics-campaign-funnel.spec.ts` 1건이 **실제 회귀**로
실패했습니다. 비로그인 방문자가 `/pricing` 에서 바로 "Upgrade to Pro" 를 눌러
Checkout 을 시작하던 경로가, 승인된 UX 계약에 따라 "로그인하고 Pro 시작"으로
바뀌었기 때문입니다. 해당 spec 은 mock Google 로그인 이후 session 과
`/api/user/usage` 를 authenticated / Free 로 전환하도록 갱신했습니다. 검증하려던
것(첫 접점 UTM 이 consent → chat → signup → checkout 까지 유지되는지)은 그대로
유지됩니다.

`source-grounding.spec.ts` 2건은 전체 병렬 실행에서만 실패했고(사이드바의 최근
대화 목록을 찾지 못함) 대상 spec 만 다시 실행하면 통과합니다. 변경 영역과 무관한
간헐적 실패입니다.

나머지 56건은 모두 시각 golden 비교(`chat-state-visual-regression`,
`mobile-composer-contract` 의 visual record)입니다. 이 환경에는 pin 된 Chromium
빌드가 없어 사전 설치본(1194)으로 실행했고, `playwright.config.ts` 와
`docs/qa/canonical-visual-baseline.md` 가 명시하듯 이런 실행은 canonical 이
아니므로 golden 판정 근거가 될 수 없습니다. 실제로 이번 변경과 무관한
`chat-streaming-desktop-light-ko` 도 전체 픽셀의 1% 차이로 실패했습니다 —
rasterization 차이입니다.

`UsageLimitModal` 의 크레딧 구매 버튼 높이는 **의도적으로 그대로 두었습니다.**
이 버튼은 `chat-insufficient-credits-*` golden 안에 들어 있고, 이 작업의 범위는
요금 페이지 구매 CTA이며, 이 runner 에서는 baseline 재기록이 허용되지 않기
때문입니다.

수정 후 대상 spec 재실행(`pricing-purchase-cta`, `analytics-campaign-funnel`,
`source-grounding`, `upgrade-discovery`, `account-flow`, `touch-targets`,
`ui-contracts`, `smoke`, `pricing-accessible-price`): 68 / 68 통과.

E2E 커버리지는 지시서의 25개 항목을 다음과 같이 덮습니다. Free / Pro / Max /
비로그인 문구, session loading 중 잘못된 CTA 미표시, 로그인 사용자의 URL 불변 +
모달 오픈, `/chat` 이동 없음, 로그인 후 credit-pack 섹션 복귀, 자동 결제 없음,
팩별 packId 선택, GET·POST 401 재로그인, 현재 플랜 Checkout 미생성, Pro → Max
409 dead end 부재, Max 에게 Pro 업그레이드 미표시, Stripe 성공 · 취소 복귀,
locale · trigger · UTM 유지, returnTo 형태 검증, 중복 클릭 시 session 1회,
desktop + mobile, keyboard-only + 접근성 속성, 320px + 200% text scaling,
analytics 중복 방지.

Playwright browser 는 이 환경의 사전 설치본
(`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/...`)으로
실행했습니다. `docs/qa/canonical-visual-baseline.md` 기준에서 이 실행은
canonical 이 아니므로 시각 golden 판정에는 쓰지 않습니다. 이 spec 은 시각
비교를 하지 않습니다.

## 7. Stripe · Production 설정 변경 필요 여부

- **Stripe dashboard 변경 없음.** 가격 · 상품 · promotion code 구성은
  그대로이며, `success_url` / `cancel_url` 은 요청마다 API 가 생성하므로 Stripe
  측 설정 항목이 아닙니다.
- **환경변수 변경 없음.**
- **DB migration 1건 필요**: `20260801130000_add_credit_pack_purchase_funnel_events`.
  `ProductAnalyticsEvent_name_check` 제약을 새 event 6종을 포함하도록
  교체합니다. 데이터 이동이 없고 되돌릴 수 있습니다.
- GA4: 신규 custom event 6종(`credit_pack_cta_view`, `credit_pack_cta_click`,
  `credit_pack_selected`, `authentication_required`, `purchase_intent_resumed`,
  `checkout_cancelled`)이 전송됩니다. 기존 `begin_checkout` / `purchase`
  e-commerce mapping 은 변경되지 않았습니다. 대시보드에서 새 event 를 funnel 로
  묶으려면 GA4 쪽 등록이 필요하지만, 코드 배포의 선행 조건은 아닙니다.

## 8. 배포 및 rollback

### 배포 순서

1. `npm run db:migrate` — 제약 교체가 먼저 적용돼야 새 event 가 거부되지
   않습니다. 제약은 새 이름을 **추가**하는 방향이라 구버전 애플리케이션과도
   호환됩니다.
2. 애플리케이션 배포.
3. 확인: `/pricing` 에 로그인 상태로 접속 → 추가 크레딧 CTA가 "추가 크레딧
   구매"이고 클릭 시 URL이 바뀌지 않는지, Pro 계정에서 Max 카드가 "플랜 관리"인지.

### rollback

- 애플리케이션만 이전 릴리스로 되돌리면 됩니다. **migration 을 되돌릴 필요는
  없습니다.** 구버전은 새 event 이름을 보내지 않으므로 넓어진 제약이 문제를
  일으키지 않습니다.
- 굳이 제약까지 되돌려야 한다면
  `20260729120000_add_marketing_language_switched_event` 의 목록으로 다시
  `ALTER TABLE ... ADD CONSTRAINT` 하면 됩니다. 단, 그 사이 기록된 새 event 행이
  있으면 제약 추가가 실패하므로 해당 행을 먼저 삭제해야 합니다.
- 데이터 손실 위험은 없습니다. 진행 중이던 Stripe Checkout session 은 서버가
  발급한 절대 URL 을 그대로 사용하므로 rollback 후에도 복귀 가능합니다(구버전은
  `/chat` 로 복귀하며, 안내가 표시되지 않을 뿐 크레딧 적립은 webhook 이
  처리합니다).
