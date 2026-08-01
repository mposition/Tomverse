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

**온라인 플랜 변경은 아직 지원하지 않습니다.** 제품에는 구독 *변경* 흐름이 없고
신규 Checkout과 기간 말 해지만 있습니다. 그래서:

- 서버는 동일 플랜 재구매와 다운그레이드를 `PLAN_CHANGE_NOT_SUPPORTED`로,
  활성 구독 상태의 상위 플랜 요청을 `ACTIVE_SUBSCRIPTION_EXISTS`로 각각 409
  차단합니다. **이 차단을 UI보다 먼저 풀지 않습니다.** 풀면 한 계정이 두 플랜을
  동시에 결제합니다.
- UI는 변경을 결제로 안내하지 않습니다. `resolvePlanCtaState()`가 이 상태를
  `manage_plan`으로 판정하고, CTA는 고객지원 문의로 연결하며, 온라인 변경이
  아직 지원되지 않는다는 사실을 문구로 명시합니다.
- `resolvePlanCtaState()`의 `manage_plan` 분기 교체는 구현의 **마지막** 단계입니다.
  크레딧 경제성 결정 → 서버 상태기계 → Stripe 결제·예약 → 웹훅 재동기화가 모두
  끝난 뒤에 바꿉니다. 먼저 바꾸면 동작하지 않는 CTA가 다시 생깁니다.

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
