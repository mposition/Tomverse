# Tomverse Insight UI 감사 후속 작업 결과

> 이 문서는 `TOMVERSE_INSIGHT_UI_AUDIT_FINAL_REPORT.md` 기준 작업명령서
> (UI-001~UI-012, VAL-001~VAL-007)의 **실행 결과 기록**입니다.
> 표기: `[코드]` 소스 확인, `[테스트]` 자동화 실행 결과,
> `[실기기]` 실기기 확인 결과, `[미검증]` 근거 미확보.

## 1. 실행 baseline

| 항목 | 값 |
|---|---|
| 기준 branch | `claude/tomverse-insight-ui-audit-3m2k1c` |
| 분기점 SHA | `39194ea` (`origin/develop`, 2차 검토 후 재정렬) |
| 최초 분기점 | `e062da8` — 검토 결과 반영 시 `39194ea`로 rebase, `MobileChatShell` 헤더 충돌 1건 해소 |
| 작업명령서가 지정한 기준 SHA | `8d02fc1` |
| 실행 환경 | Linux 컨테이너, Chromium 1194 (`/opt/pw-browsers`), Playwright 1.62 |
| 실행 project | `desktop-chromium`, `desktop-compact`, `mobile-chromium` |
| webkit (`mobile-safari`) | **[미검증]** 이 컨테이너에 webkit 빌드가 없고 proxy가 다운로드를 차단함. nightly `daily-security-audit.yml`이 chromium+webkit을 실행함 |
| UI-001 실기기 확인 | **완료** — iOS Safari / Android Chrome, 제품 담당 직접 확인 (2026-07-28). 4장 참조 |
| 실제 provider 호출 / 결제 / DB write | **없음** (모든 상태는 route mock과 in-page fetch stub) |

## 2. 완료 건수

| 구분 | 건수 | 내역 |
|---|---:|---|
| 구현 완료 | 10 | UI-001, UI-002, UI-003, UI-004, UI-005, UI-006, UI-007, UI-008, UI-009, UI-010 |
| 정책 승인 후 구현 | 1 | UI-012 (B안) |
| 검증 → 신규 결함 → 수정 | 1 | VAL-003 |
| 검증 → 진단 기각 + 결함 수정 | 1 | UI-005 / VAL-002 |
| 검증만 수행(결정 대기) | 3 | VAL-004, VAL-005, VAL-007 |
| 부수 수정 | 2 | 사전 존재 E2E 실패 2건 (13장) |

작업명령서의 Accept·Revise 이슈 10건은 전부 처리됐고, `Needs Validation`이던
UI-005는 검토 결정에 따라 `Revise`로 바뀌어 구현에 포함됐습니다.

**최종 완료 기준 14개 항목이 모두 충족됐습니다.** 마지막까지 남아 있던
UI-001 실기기 확인이 완료되어, `P1`에 `FAIL`·`PARTIAL`·`NOT VERIFIED`가
남아 있지 않습니다(기준 14). 남은 항목은 작업명령서 분류상 출시를 막지 않는
것들이며 12장에 정리했습니다.

## 3. 이슈별 결과

| ID | 상태 | 근거 |
|---|---|---|
| UI-001 | **PASS** | 정확한 visual viewport fixture 통과 + iOS Safari·Android Chrome 실기기 확인 완료. 4장 참조 |
| UI-002 | **Fixed** | 320~430px 5개 폭 × 3개 route에서 44×44 + 5점 hit-test + content 교차 0px² |
| UI-003 | **Fixed** | 오류/복구/상태 text가 light·dark 모두 AA 통과 (pixel 합성 측정) |
| UI-004 | **Fixed** | golden 49 → 63장. 320 dark 복구 4종, 영어 복구 4종, AI Review 5종, Deep Research 실패 활성 1종 추가 |
| UI-005 | **Revise → Fixed** | promotion 원인 진단은 기각. 좁은 폭+확대 overflow는 plan card intrinsic width 문제로 확정하고 수정. 5장 참조 |
| UI-006 | **Fixed** | ko display heading 5종 × 4 viewport에서 어절 분절 0 |
| UI-007 | **Fixed** | 필수 consumer 보조 text의 9–10px 제거, 예외 3건은 명시 표시 |
| UI-008 | **Fixed** | `@ui-risk` tier가 develop PR merge-blocking으로 실행 |
| UI-009 | **Fixed** | 영어 legal 명칭 `Terms and Conditions` 단일화 |
| UI-010 | **Fixed** | 모델 sheet의 selection count 1회 노출 |
| UI-012 | **B안 승인 → 구현 완료** | 역할별 token 62개, guarded 파일 10개, 색상 값 변경 0. 9장·`ui-semantic-accent-inventory.md` |
| VAL-003 | **신규 결함 → Fixed (P2)** | `?lang=` 를 서버에서 해석. `test.fixme` 제거하고 assertion 활성화. 6장 |

## 4. UI-001 / VAL-001 — 모바일 keyboard

**기존 test가 항상 참이었던 이유** `[코드]`
`model-picker-responsive.spec.ts`의 keyboard test는 검색 input에 focus한 뒤
`footer.bottom <= visualViewport.height`를 확인했습니다. headless browser에서
focus는 keyboard를 올리지 않으므로 `visualViewport.height`는 844 그대로였고,
수정 전후 모두 통과하는 assertion이었습니다.

**재현 방법** `[테스트]`
`tests/e2e/support/ui-audit.ts`의 `openOnScreenKeyboard()`가
`window.visualViewport.height`만 줄이고 layout viewport(`window.innerHeight`,
`100dvh`, fixed 요소의 containing block)는 그대로 둡니다. 이것이 iOS Safari와
Android Chrome 기본 모드가 만드는 분리 상태입니다. test는 같은 dialog 안의
sibling `position: fixed` overlay가 여전히 layout viewport 전체 높이(844)를
차지한다는 것을 함께 측정해 분리가 실제로 발생했음을 증명합니다.

| viewport | keyboard | 가시 높이 | 결과 |
|---|---:|---:|---|
| 390×844 | 336px | 508px | 통과 |
| 320×568 | 216px | 352px | 통과 |

**수정 내용** `[코드]`
1. `useCompactBottomDock.ts` → `useVisualViewport.ts`로 일반화. 기존
   `visualViewport` 구독을 그대로 재사용하고 `useKeyboardInset()` 하나만
   추가했습니다. 중복 listener·hook은 만들지 않았습니다.
2. `ChatInput.tsx`의 `#chat-input-popover`가 가려진 높이만큼 `bottom`을
   올립니다. `data-keyboard-inset`으로 반응 여부를 검증 가능하게 노출합니다.
3. 320×568에서는 sheet의 고정 chrome(header·검색·선택 chip·카탈로그 진입·
   footer)만으로 약 390px가 필요해 352px에 들어가지 않습니다. 어느 것도
   숨기지 않고, **중간 영역만** 하나의 scroll 영역이 되도록 했습니다
   (`display: contents`로 일반 높이 layout은 완전히 동일하게 유지).
   `ModelCatalogue`도 같은 mode에서 자체 scroller를 끄므로 sheet 안에
   scroller는 항상 1개입니다 (test가 이를 assert합니다).

**완료 조건 대비**

- `done.bottom <= visibleBottom` — 통과 (`expectInsideVisibleViewport`)
- 검색 결과 1건 center + 완료 center가 viewport 내 — 통과
  (`expectTappableInVisibleViewport`, `elementFromPoint`로 가림 여부까지 확인)
- pointer·keyboard 모두로 완료 — 통과 (후보 탭 → Done focus → Enter → 닫힘)
- 320/390 normal baseline·desktop dialog 회귀 — 통과 (기존 15개 test 유지)

**실기기 확인** `[실기기]`
iOS Safari와 Android Chrome에서 각 1회, **제품 담당이 직접 확인해 통과**했습니다
(2026-07-28). 이로써 UI-001의 마지막 미검증 조건이 닫히고 상태는 **`PASS`**
입니다.

이 확인이 필요했던 이유는 fixture의 범위가 좁기 때문입니다. `openOnScreenKeyboard`는
layout viewport와 visual viewport의 분리라는 **한 가지 속성**에만 충실하고,
keyboard animation 타이밍, browser별 scroll-into-view, 실기기 폰트 metric은
재현하지 않습니다. 그 셋은 실기기에서만 확인할 수 있고, 이제 확인됐습니다.

**자동화가 계속 담당하는 부분** 실기기 확인은 1회성 확증이고, 회귀를 막는 것은
fixture입니다. `@ui-risk` tier가 develop PR마다 390×844(336px keyboard)와
320×568(216px keyboard)에서 완료 button·검색·후보 도달 가능성과 sheet 안
scroller 1개 규칙을 merge-blocking으로 검사합니다. 실기기에서만 드러나는
회귀는 이 방식으로 잡히지 않으므로, keyboard 관련 layout을 크게 바꿀 때는
실기기 확인을 다시 하는 편이 안전합니다.

**이 환경의 제약(참고)** `[미검증]`
이 컨테이너 자체에서는 실기기·WebKit 검증이 불가능합니다. WebKit 빌드가 없고
proxy가 `cdn.playwright.dev`와 `playwright.download.prss.microsoft.com`을
차단합니다. 덧붙여 Playwright의 Linux WebKit은 iOS Safari가 아니고 on-screen
keyboard 자체가 없어서, 설치가 가능했더라도 위 실기기 확인을 대체하지
못했을 것입니다.

## 5. UI-005 (Revise) / VAL-002 — pricing overflow

검토 결정: promotion 원인 진단은 기각하되 overflow 자체는 유효한 `P2` 결함으로
인정하고, 신규 이슈로 분리하지 않고 **UI-005를 `Revise`로 바꿔 그 안에서**
원인을 plan card의 intrinsic/min-content width로 수정했습니다. 별도 ticket을
만들지 않았으므로 추적은 UI-005 하나로 이어집니다.

### 5-1. 원인

`[테스트]` 320px·125% 조합에서 계측한 값입니다.

- plan card는 grid item이고 `min-width: auto`가 기본이라, 224px track 안에서
  자신의 min-content인 **287px를 고집하며 track을 넘쳤습니다.**
- 그 287px를 만든 것은 네 가지였습니다: 줄바꿈되지 않는 eyebrow+badge 행,
  한 줄에 붙어 있던 가격과 기간 label, 아이콘(`shrink-0`) + 맨 text node로
  구성돼 최소 너비가 "아이콘 + 가장 긴 단어"였던 feature bullet, 그리고
  영어 display heading에 overflow 탈출구가 없던 점.
- 200% 확대에서는 marketing header도 별개로 넘쳤습니다(로고+언어 전환+메뉴
  버튼이 128px에 들어가지 않음).

### 5-2. 수정

| 위치 | 수정 |
|---|---|
| `PricingPageContent` plan card | `min-w-0` — track이 이기게 함 |
| eyebrow + badge 행 | `flex-wrap`으로 badge가 다음 줄로 내려감 |
| 가격 + 기간 label | `flex flex-wrap items-baseline`로 기간이 아래로 |
| feature bullet | label을 `min-w-0 break-words` span으로 감쌈 |
| `lib/displayHeading.ts` | `break-words`를 모든 언어에 적용(기존에는 ko 전용) |
| `MarketingChrome` 브랜드 워드마크 | 240px 미만에서 `sr-only` — 잘린 조각 대신 통째로 숨기고 접근성 이름은 유지 |

### 5-3. 결과

`pricing-promotion-reflow.spec.ts` 16 test, 조합마다 promotion on/off 두 번
측정 = **32회 계측, 전부 overflow 0px.**

| 조합 | 수정 전 | 수정 후 |
|---|---:|---:|
| 320 @125% en | 47px | 0px |
| 320 @150% en | 90px | 0px |
| 320 @200% ko | 47px | 0px |
| 320 @200% en | 143px | 0px |
| 390 @150% en | 43px | 0px |
| 390 @200% ko | 12px | 0px |
| 390 @200% en | 108px | 0px |
| 나머지 9개 조합 | 0px | 0px |

assertion은 두 가지를 각각 검사하며 둘 다 실패 가능합니다.

1. **절대값** — promotion on/off 각각에 대해 `overflowPx <= 1`.
2. **귀속** — promotion이 baseline보다 페이지를 넓히지 않을 것.

절대값 assertion이 비어 있지 않다는 근거: 같은 계측 코드가 수정 전 위 표의
47~143px를 보고했고, 그 값이면 `<= 1` 검사는 실패합니다.

이 suite는 `@ui-risk` tier에 포함해 develop PR에서 merge-blocking으로
실행됩니다.

## 6. VAL-003 — 로그인 SSR → hydration (신규 결함, 수정 완료)

검토에서 `P2 / Medium`으로 승인되어 수정했습니다.

### 6-1. 원인

`(application)/layout.tsx`가 초기 언어를 `Accept-Language`로만 정했고
`?lang=` 는 client의 `setTimeout(0)` 효과에서 처리됐습니다. 그래서
`/auth/signin?lang=ko`를 영어 선호 브라우저로 열면 서버는 영어를 렌더하고
hydration 직후 한국어로 교체됐습니다. markup은 hydration 시점에 일치했기
때문에 React는 오류를 남기지 않았고, text만 한 틱 뒤에 바뀌었습니다.

### 6-2. 수정 방향

지시대로 **서버와 클라이언트의 초기 locale을 일치**시켰습니다.
`suppressHydrationWarning`도, hydration 후 교체도 쓰지 않았습니다.

- `app/(application)/auth/signin/page.tsx`를 server component로 바꿔
  `searchParams`의 `lang`을 렌더 전에 해석하고, 유효하면
  `<LanguageProvider initialLang forceInitialLang>`으로 감쌉니다. localized
  marketing route가 이미 쓰는 방식과 같습니다.
- 기존 client 본문은 `SignInPageContent.tsx`로 옮겼습니다.
- `isLanguage`/`Language`를 `lib/language.ts`로 분리했습니다.
  `LanguageProvider`는 client module이라 server component가 그 함수를
  **호출**할 수 없기 때문입니다(빌드는 통과하고 요청 시점에 500이 납니다 —
  실제로 한 번 겪고 고쳤습니다). 언어 목록이 서버와 클라이언트에서 갈라지지
  않도록 정의는 한 곳에 둡니다.
- `?lang=` 가 없으면 아무것도 고정하지 않고 기존 localStorage/브라우저 선호
  복원 경로를 그대로 씁니다.

### 6-3. 결과

`test.fixme`를 제거하고 원래 assertion을 그대로 활성화했습니다.

| 검사 | 결과 |
|---|---|
| 한국어 본문 text 서버=클라이언트 완전 일치 | **통과** (이전 `fixme`) |
| 영어 본문 text 완전 일치 | 통과 |
| React hydration console error | 0건 (ko/en × light/dark) |
| heading·label·paragraph 개수, legal link 목적지 | 변화 없음 |

`signin-hydration` + `signin-localization` + `analytics-consent-signin`
합계 32 test 통과.

**남은 범위** `?lang=` 없이 localStorage에 저장된 언어로 들어오는 경우는 여전히
서버가 `Accept-Language`로 렌더합니다. 서버가 저장된 선호를 알려면 cookie가
필요하고, 이는 승인 범위 밖이라 손대지 않았습니다.

## 7. UI-003 / UI-007 — 대비와 보조 typography

**측정 방식** `[코드]` Tailwind v4가 `oklch()`를 내보내고 Chromium이 계산값을
CIE `lab()`으로 직렬화하므로 `rgb()` 정규식은 sample을 버리거나 검정으로
읽습니다. `measureContrastInScope()`는 foreground와 조상 background 전체를
canvas에 그려 `getImageData()`의 실제 8bit sRGB로 합성 대비를 계산합니다.
기존 감사가 보고한 값(3.81 / 2.63 / 3.84 / 2.62 / 3.83 / 2.07 / 3.09)이 이
harness에서 그대로 재현되어, 측정 방식의 타당성이 상호 확인되었습니다.

**수정 전 → 수정 후 (AA 실패 항목)**

| 위치 | 실측 전 | 수정 | 결과 |
|---|---:|---|---|
| `ChatMessageList` 다음-행동 hint | 3.81 (light) | `text-red-600/80` → `text-red-700` | 통과 |
| `ChatMessageList` 추적 ID | 2.63 / 3.84 | `text-[10px] red-500/70` → `text-[11px] red-700 / red-200` | 통과 |
| `DesktopChatShell` provider label | 2.62 (light) | `text-[10px] zinc-400` → `text-[11px] zinc-500 / dark:zinc-400` | 통과 |
| `DesktopChatShell` ON/OFF | 3.83 (dark) | 동일 패턴 | 통과 |
| `MobileChatShell` 주 모델명 | 4.12 (dark) | `text-[10px] zinc-500` → `text-[11px] zinc-500 / dark:zinc-400` | 통과 |
| `ChatSidebar` 대화 모델 요약 | 2.07 / 3.09 | `text-[10px] zinc-400` → `text-[11px] zinc-600 / dark:zinc-400` | 통과 |
| `ChatSidebar` organizer 요약 | 2.62 (light) | 동일 패턴 | 통과 |
| `AuthButton` plan·크레딧 요약 | 2.62 (light) | 동일 패턴 | 통과 |
| 계정 avatar 이니셜 | 3.67 (light) | `bg-teal-600` → `bg-teal-700` | 통과 |

**11px floor 예외 3건** (`data-allow-small-text`로 명시)

| 위치 | 근거 |
|---|---|
| `CreditCostBadge` 숫자 | `aria-hidden`, badge 자체가 `N credits`를 accessible name·title로 가짐 |
| composer 모델 수 badge | 옆의 "3 AIs" 가시 label과 button accessible name에 같은 값이 있음 |
| mobile header avatar overflow `+N` | avatar stack 전체가 `aria-hidden`, 같은 수를 요약 button이 낭독 |

**측정 범위** full error, partial failure, mobile header, composer, desktop
model panel, desktop sidebar × light/dark = 12 test. 모두 통과.

## 8. UI-004 — golden matrix

| 구분 | 이전 | 이후 |
|---|---:|---:|
| golden PNG | 49 | 63 |
| golden suite test | 60 | 74 |
| 기존 49장 | — | 전부 보존, 전부 통과 |

`develop`(`39194ea`)로 rebase한 뒤 신규 모바일 golden 6장은 upstream
`7cd1367`(모바일 헤더 압축)의 layout 변경 때문에 재생성했습니다. diff를 눈으로
확인해 색이 아니라 세로 배치만 달라진 것을 확인했고, 재생성 후 74/74가 두 번째
실행에서 통과합니다.

추가 항목:

- 320×dark×ko: `chat-error`, `chat-partial-failure`, `chat-retry`,
  `chat-insufficient-credits`
- 영어 대표: `chat-partial-failure-desktop-dark-en`,
  `chat-error-mobile-light-en`, `chat-retry-mobile-dark-en`,
  `chat-insufficient-credits-desktop-light-en`
- AI Review: `loading`, `success`, `error`(desktop light + mobile dark),
  `retry`. 오류는 실제 `POST /api/conversations/.../comparison-reviews`가 500을
  반환하도록 mock하고, 원인 문구와 재실행 button이 화면에 보이는지 확인한 뒤
  캡처합니다.
- Deep Research: `chat-deep-research-failed-active-mobile-dark-ko` — 실패한
  모델 tab을 **선택한 뒤** `role="alert"`와 복구 action이 보이는 상태.
  기존 mobile golden은 tab strip만 담고 있어 오류 카드를 보호하지 못했습니다.

부수 수정 `[코드]`: `ComparisonReviewDialog`의 오류 카드에 `role="alert"`와
`data-testid="comparison-review-error"`를 추가했습니다. 사용자가 실행을
확정한 뒤 발생하는 실패인데 조용히 나타나는 문단이었습니다.

`--update-snapshots`는 어떤 tier에서도 사용하지 않았습니다. 신규 golden은
first run에서 파일을 생성하고 **실패**한 뒤, 이미지를 눈으로 확인하고, 두 번째
run에서 통과시켰습니다.

## 9. UI-012 (B안) — 역할별 semantic accent token

승인된 B안을 구현했습니다. 상세는
`.github/audits/ui-semantic-accent-inventory.md`.

- 역할 token **62개**, guarded 파일 **10개**. 모든 token이 기존 palette step을
  `var(--color-<hue>-<step>)`로 참조하므로 **색상 값 변경 0**.
- `cyan → blue → purple` 전체 gradient는 AI Review 전용으로 예약하고, 다른
  component가 `accent-ai-review-*`를 쓰면 검사에서 실패합니다.
- 값이 같아도 역할이 다르면 분리했습니다: `accent-promotion` ≠
  `status-success`(둘 다 emerald), `accent-model-catalogue` ≠
  `accent-plan-max`(둘 다 purple).
- 규칙은 `AGENTS.md`의 "Accent colour roles", 강제는
  `scripts/check-accent-tokens.mjs`, CI는 PR Fast Gate static 단계.
- 시각 동일성 근거: chat state golden 74개 통과(AI Review·Deep Research·
  composer 포함).

## 10. UI-008 — CI tier

`@ui-risk` tag로 **76개** test를 묶어 `test:e2e:ui-risk`
(`desktop-chromium` + `mobile-chromium`)를 PR Fast Gate의 `build-and-e2e` job에
추가했습니다. 실측 **67초**. UI-005의 pricing reflow 16 test가 여기 포함됩니다.
별도로 `npm run check:accent-tokens`(UI-012)를 static 단계에 추가했습니다 —
빌드도 브라우저도 필요 없습니다. 상세 표는 `.github/audits/ui-test-tiers.md`.

유지된 불변식: required check 이름, aggregator의 skip/failure 처리, secret
scan, smoke manifest, `--update-snapshots` 금지, main·nightly의 무필터 실행,
`chat-state-visual-regression`을 PR gate에서 이름으로 부르지 않기.
`scripts/security-regression-check.mjs`에 새 tier에 대한 assertion 3개를
추가했고 전체 113개 검사가 통과합니다.

## 11. 정량 회귀 기준선

| 기준 | 목표 | 결과 |
|---|---|---|
| coarse-pointer 핵심 control 44px 미달 | 0건 | 0건 (`touch-targets`, `model-picker-responsive`, `analytics-settings-target`) |
| notice·settings·CTA와 content 교차 | 0px² | 0px² (3 route) |
| z100 reflow 가로 overflow | 0건 | `ui-zoom-reflow` 통과 |
| desktop 3패널 content 높이 편차 | 0px | `ui-contracts` 통과 |
| model picker 고급 진입점 fold 내 | 유지 | `first screen needs no scrolling` 4개 통과 |
| 기존 Chat state golden | 49 PNG / 60 통과 유지 | 63 PNG / 74 통과 (기존 49 전부 보존) |
| model picker focus trap | Tab 이탈 0 | `model-picker` 통과 |
| mobile core flow | 5/5 | 5/5 |

## 12. 남은 항목

작업명령서 기준으로 **출시를 막는 항목은 없습니다.** 최종 완료 기준 14개가
모두 충족됐고, `P1`에 `FAIL`·`PARTIAL`·`NOT VERIFIED`가 남아 있지 않습니다.
아래는 열려 있으나 작업명령서가 비차단으로 분류한 것들입니다.

| 항목 | 분류 | 상태 |
|---|---|---|
| UI-012 | `P3` | B안 구현 완료. 작업명령서 명시상 단독으로 출시를 막지 않음 |
| VAL-004 (fine-pointer 좁은 화면 정책) | 결정 대기 | `[DESIGN DECISION REQUIRED]`. 결정 전까지 제품 동작 불변 |
| VAL-005 (Deep Research 실패 tab 자동 활성화) | 결정 대기 | 동일. golden은 실패 tab을 명시적으로 선택해 캡처 |
| VAL-007 (기준 감사 원본 screenshot) | `Not Verifiable` | 원본을 확보하지 못함. 현재 DOM·render 검증으로 대체 |
| `?lang=` 없는 저장 언어의 SSR 불일치 | 범위 밖 | cookie가 필요한 별도 작업(6장) |
| `attachment-flow`·`conversation-title` flake | 사전 존재 | baseline에서 더 자주 실패함을 수치로 확인(13장). `develop` 병합 후에도 동일(13-5) |
| webkit 로컬 실행 | 환경 제약 | nightly `daily-security-audit.yml`이 chromium+webkit 담당 |

## 13. 전체 회귀 실행 결과와 사전 존재 실패 2건 수정

`desktop-chromium` + `desktop-compact` + `mobile-chromium` 전체 실행에서 처음
6건이 실패했고, 그중 4건은 부하로 인한 일시 실패(격리 실행 시 통과), 2건은
`git stash` 후 재빌드한 baseline에서도 재현되는 사전 존재 실패였습니다.
그 2건을 이번 작업에 포함해 수정했습니다. **둘 다 제품 결함이 아니라 테스트
쪽 결함**이며, 원인이 서로 다릅니다.

### 13-1. `chat-tools › web search mode selection does not repeat across a new chat`

**증상** `mobile-chromium`에서 항상 실패. `getByRole("button", { name: "New
chat" })`가 30초 타임아웃.

**원인** `[코드]` 이 테스트는 빈 대화에서 시작하는데, 모바일 shell의 header
New Chat button은 `!isActiveConversationEmpty`일 때만 렌더됩니다
(`MobileChatShell.tsx:549`). 빈 대화에서 새 대화를 시작하는 것은 아무 일도
하지 않으므로 제품이 의도적으로 노출하지 않는 것입니다. 즉 **테스트가
데스크톱 전용 진입점을 모바일에서 찾고 있었습니다.** 제품 동작은 정상입니다.

**수정** shell에 맞는 진입점을 쓰는 `startNewChat()` 헬퍼를 도입했습니다.
모바일에서는 drawer(`mobile-sidebar-open` → `sidebar-new-chat`)를 거치는데,
이는 실제 사용자가 밟는 경로이기도 하므로 커버리지가 줄지 않고 늘어납니다.

**검증** `mobile-chromium` + `desktop-chromium` × 3회 반복 = 60/60 통과.

### 13-2. `chat-keyboard-policy › Cmd+Enter sends from an external keyboard`

**증상** `mobile-chromium`에서 약 30% 확률로 사용자 메시지 개수가 1이 아닌 0.

**진단 과정** `[테스트]` 실패 시점의 상태를 계측한 결과:

- POST 순서는 성공/실패가 **완전히 동일**했습니다 —
  `/api/conversations` → `/api/conversations/qa-conversation/messages` →
  `/api/chat` → `.../generate-title`. 즉 전송은 끝까지 성공했습니다.
- 그런데 화면에는 `chat-empty-state`와 welcome 인사가 떠 있었습니다. 전송된
  메시지가 렌더되지 않은 것이 아니라 **transcript 자체가 비어 있었습니다**.
- 50ms 간격 3초 샘플링에서 메시지가 잠깐 보였다 사라진 것이 아니라 처음부터
  끝까지 0이었습니다.

**원인** `[코드]` `mockAuthenticatedApi`의 mock 두 개가 서로 모순이었습니다.
`POST /api/conversations/qa-conversation/messages`는 body를 버리고 `{}`만
반환하고, `GET /api/conversations/qa-conversation`은 언제나 최초 seed
(`options.messages`, 이 테스트에서는 빈 배열)를 되돌려줬습니다. 앱은 스트리밍
전에 사용자 turn을 pre-save하고 이후 대화를 다시 읽으므로, 그 읽기가 optimistic
append보다 늦게 도착하면 **실제 transcript가 빈 seed로 덮이면서** welcome
화면으로 되돌아갑니다. 순서에 따라 갈리므로 flaky했습니다.

실제 API는 이렇게 동작하지 않습니다. POST한 메시지는 이후 GET에 포함됩니다.
즉 mock이 실제 endpoint 쌍의 계약을 지키지 않은 것이 원인입니다.

**수정** mock이 POST된 메시지를 기억해 GET에 포함하도록 했습니다(id 기준
중복 제거). 제품 코드는 건드리지 않았고, assertion도 약화하지 않았습니다.

**검증** 수정 전 24회 중 7회 실패 → 수정 후 **24/24 통과**.
(비교를 위해 같은 24회를 baseline fixture로도 돌려 7건 실패를 확인했습니다.)

**폐기한 가설** 처음에는 `prepareGuestPage` + `mockAuthenticatedApi`를 함께
쓰는 bootstrap 경합을 의심해 인증 전용 fixture를 분리해 봤지만, 24회 중 8회
실패로 개선이 없어 되돌렸습니다. 근거 없는 shared fixture refactor를 남기지
않기 위해서입니다.

### 13-3. `develop` 재정렬 후 전체 실행

`origin/develop` `39194ea` 위로 rebase한 뒤 두 차례 실행했습니다.

**1차: 1008 passed / 3 failed / 645 skipped** (14.8분)

| 실패 | 원인 | 조치 |
|---|---|---|
| `korean-typography › no mid-word break at 320x568` | **이번 작업이 넣은 test 결함.** 요소에 `data-ko-heading`을 찍고 selector로 다시 찾는 방식이라, 그 사이 React 재렌더가 mark를 지우면 "Selector not found"로 실패 | locator의 element handle에서 직접 측정하도록 수정 |
| `korean-typography › wraps within 4 lines at 320x568` | 기존 test의 `boundingBox()`가 부하 상황에서 `null` | 사전 존재 |
| `attachment-flow › PDF … @smoke` | 부하 flake | 사전 존재 |

수정 후 `korean-typography` 4회 반복 × 2 project = **160/160 통과**.

**2차(수정 반영): 5 failed** — `attachment-flow` 3건, `conversation-title` 2건.
둘 다 사전 존재 flake이며 수치로 확인했습니다.

| spec | 이 branch | `origin/develop` 제품 코드로 되돌린 baseline |
|---|---:|---:|
| `attachment-flow` (3 project × 3 반복 = 54) | 1~2 실패 | **5 실패** |
| `conversation-title` (2 project × 5 반복 = 80) | 8 실패 | 6 실패 |

`attachment-flow`는 오히려 baseline이 더 불안정하고, `conversation-title`은
차이가 통계적으로 구분되지 않습니다. 둘 다 이번 변경과 무관하며 범위 밖이라
수정하지 않았습니다.

앞선 실행에서 남아 있던 `chat-keyboard-policy`와 `chat-tools` 실패는 13-1·13-2
수정 이후 재현되지 않습니다.

### 13-4. 정적 검사

`eslint --max-warnings=0` 통과, `tsc --noEmit` 통과,
`npm run test:unit` **505/505** 통과, `npm run security:regression` **113 검사**
통과, `npm run verify:smoke-coverage` 통과(@smoke 20개 유지, desktop-chromium
552 test 중), `npm run check:accent-tokens` 통과(guarded 10파일·10역할),
`npm run check:encoding:strict` 통과.

### 13-5. `develop` 병합(`0891ef9`) 후 재실행

rebase 기준점(`39194ea`) 이후 `develop`에 두 commit이 더 올라와 병합했습니다.
`54de734`가 mobile composer의 textarea 행을, `0891ef9`가 comparison rail의
정상 상태 문장 노출을 각각 계약 문서와 함께 재정의합니다.

**충돌 2건**

| 파일 | 성격 | 해소 |
|---|---|---|
| `AGENTS.md` | 양쪽 다 추가 | marker로 감싼 두 invariant 블록을 이 작업의 「소통 언어」·「Accent colour roles」 뒤에 배치. 생성 블록끼리 붙여 다음 추가 시 문서가 섞이지 않게 함 |
| `ChatInput.tsx` | Deep Research chip 1줄 | `develop`의 box model(`min-w-0 max-w-full`, shell별 `h-8`/`h-9`)과 이 작업의 `accent-deep-research-*` token을 함께 채택. 어느 쪽도 다른 쪽을 포함하지 않음 |

나머지는 자동 병합됐습니다. 13-1의 New Chat 경로 수정과 `develop`의 chip label
assertion 재작성(`data-placement` → `data-label-variant`)이 같은 파일의 다른
구역이고, 13-2가 만든 message 저장 mock은 `develop`의 새 composer spec들도
그대로 사용합니다.

**병합 후 전체 실행: 514 passed / 4 failed / 73 skipped** (desktop-chromium,
10.5분)

| 실패 | 원인 | 조치 |
|---|---|---|
| `chat-deep-research-mobile-dark-ko` | **`develop`이 흘린 golden.** rail markup 변경 시 desktop 4장만 갱신하고 이 mobile 장을 누락 | 재기록 |
| `chat-ai-review-error-desktop-light-ko` | 이 작업의 golden. `ComparisonReviewDialog`가 비교 대상 수 문장을 추가하면서 dialog 본문이 한 줄만큼 밀림 | 재기록 |
| `conversation-title` 1건 | 사전 존재 flake(13-3) | 없음 |
| `upgrade-discovery › pending model selection…` | 부하 flake. 단독 3회 반복 3/3 통과 | 없음 |

**golden 2장의 귀속 근거** `origin/develop`을 별도 worktree로 체크아웃·빌드해
`chat-deep-research-mobile-dark-ko`만 실행한 결과 **`develop`에서도 실패**했고,
이 branch의 render와 `develop`의 render를 픽셀 비교하면 390×844 중 **7픽셀,
최대 편차 4**("1/3 responding" 배지의 안티에일리어싱)뿐입니다. 즉 병합이
render를 옮기지 않았습니다. golden 대비 실제의 차이는 rail이 2~3px 높아진 것
하나이고 잘림·겹침은 없습니다. 두 장 모두 diff를 눈으로 확인한 뒤 재기록했고,
바뀐 snapshot이 그 2장뿐임을 `git status`로 확인했습니다.

**재기록 후** `chat-state-visual-regression` **74/74 통과**, `@ui-risk` tier
**76 passed / 14 skipped**, `mobile-composer-contract`·`chat-keyboard-policy`·
`chat-tools`·`web-search-composer-state`·`mobile-message-visibility`를 desktop·
mobile 두 project에서 **90 passed**.

**정적 검사 재실행** `eslint --max-warnings=0`, `tsc --noEmit`,
`npm run test:unit` **508/508**(`develop`이 `comparisonReadiness` test를 추가),
`npm run security:regression` **113 검사**, `npm run check:accent-tokens`,
`npm run check:encoding`, `next build` 모두 통과.

### 13-6. `develop` 추가 병합(`4073568`·`174a62b`)

`develop`이 계속 움직여 두 차례 더 병합했습니다.

**`4073568`** — guest Turnstile, chat send/render race, 서버 계약 test 등 16
commit. 충돌 3건이었고 모두 이 작업이 손댄 줄을 `develop`이 다시 손댄 경우입니다.

| 파일 | 해소 |
|---|---|
| `LanguageProvider.tsx` | `develop`의 `lookup` hoist·`t` memo화 + 이 작업의 `lib/language` import. `develop`이 남긴 지역 `isLanguage` 사본 제거 |
| `PricingPageContent.tsx` | `develop`의 `sr-only` 낭독 문장 + `aria-hidden` 시각 쌍 구조 위에 이 작업의 wrapping baseline row를 얹음 |
| `chat-tools.spec.ts` | 같은 mobile 실패를 양쪽이 각자 고침. seed 대화를 먼저 열어 두 shell을 assertion 하나로 덮는 `develop` 쪽이 나아서 그것을 택하고, 이 작업의 shell 분기 helper는 삭제 |

**`174a62b`** — font system 전면 도입(145파일). locale별 family routing,
`type-*` 역할, 11px 하한, headline 크기 이상에만 `font-black`.

충돌 **34건**이 13개 component에 걸쳐 났고, 대부분 같은 모양입니다 — `develop`이
굵기를 낮추거나 크기를 올린 바로 그 줄을 이 작업이 역할 token으로 옮겼거나 대비를
고친 줄이었습니다. 원칙은 **양쪽 유지**입니다: 이 작업의 token·dark 변형·
`displayHeadingClass()`·UI-005 줄바꿈에 `develop`의 굵기·크기 정책을 얹었습니다.
그 밖의 판단은 아래와 같습니다.

| 대상 | 판단 |
|---|---|
| model 수 badge (`ChatInput`·`MobileChatShell`) | 16px 원 안 9px → `develop`의 20px 원 + 11px. UI-007 예외(`data-allow-small-text`) 자체가 불필요해져 제거. 같은 수가 button의 accessible name에 있으므로 `aria-hidden`은 유지 |
| `AuthButton` plan chip·credit pack badge | 이 작업의 10px 대신 `develop`의 12px·11px |
| analytics 설정 button, chat 오류 trace 줄 | 이 작업 쪽 유지. `develop`도 11px로 올렸지만 44×44 target과 AA 대비 수정은 이 branch에만 있음 |

**병합 후 전체 실행: 512 passed / 59 failed / 73 skipped** — 실패를 셋으로
갈랐습니다.

**(1) 실제 회귀 1건 — 수정함.** `pricing-promotion-reflow › 320 @200% (en)`이
가로 overflow **9px**로 결정적으로 실패했습니다. 16개 조합 중 이 하나뿐입니다.
폰트가 넓어지면서 UI-005가 고쳤던 결함이 다시 난 것이고, probe로 두 원인을
측정해 확인했습니다.

- 요금 표시(`$25.00`)가 36px 고정이라 끊을 수 없는 한 덩어리 → 그 자체가 card의
  min-content이고, grid item은 그 밑으로 줄지 않음
- FAQ 제목 — `break-words`는 긴 단어의 줄바꿈을 허용할 뿐 **명세상 min-content
  폭을 낮추지 않으므로**, 30px "questions" 폭을 그대로 요구

둘 다 `clamp()`로 바꿨고, clamp가 걸리는 구간은 CSS 폭 360~375px 아래(확대한
화면)뿐이라 실제 폰 폭에서는 기존 크기 그대로입니다. 중간에 시도한 credit pack
card·credit guide 행 보강은 측정값을 움직이지 못해 되돌렸습니다.
`typographyPolicy`가 clamp 크기를 못 읽어 오탐하기에 `text-[clamp(...)]`를
파싱해 양쪽 경계를 돌려주도록 넓혔고(하한 검사는 최솟값, 굵기 검사는 최댓값),
임시 component로 8px clamp 하한과 16px에서 잘리는 `font-black` clamp가 여전히
잡히는지 확인했습니다. 이후 `pricing-promotion-reflow` **16/16**.

**(2) golden 52장 — 검토 후 재기록.** 폰트 변경이 이 화면들의 모든 문자열을
다시 그리므로, TASK-004에서 이 branch가 추가한 baseline이 더 이상 맞지
않습니다. `develop`은 자기 쪽에 있던 golden만 다시 찍었고 이들은 남겨졌습니다.
`typography.md`의 요구대로 **재기록 전에 사람이 검토**했습니다 — desktop light
비교 화면, 320px dark 부분 실패, 영어 mobile 오류 카드, AI 교차검토 dialog 네
쌍을 전/후로 나란히 놓고 확인했습니다. 차이는 전부 typographic입니다: 한국어가
system fallback 대신 Noto Sans KR로, Latin이 Geist로 그려지고 넓어진 Latin
metric 때문에 문단 몇 개가 다시 줄바꿈됩니다. 잘림·겹침·잘려나간 문구·control
이동은 없고 320px 경우도 viewport 안에 머뭅니다. 재기록 후 **74/74**.

**(3) 남은 3건 — 이번 범위 밖.**

| 실패 | 근거 |
|---|---|
| `mobile-composer-contract` golden 2장 (320px·390px) | **`174a62b`를 그대로 빌드한 기준선에서도 동일하게 실패**하고, 이 branch의 render와 `develop`의 render는 **0픽셀 차이**입니다. `develop` 쪽에서 별도 처리하기로 결정 |
| `source-grounding › the metric is scoped to the whole review` | 단독 재실행 통과. 부하 flake |
| `conversation-title` | 사전 존재 flake(13-3) |

**`comparison-action-rail` flake 진단** `4073568` 시점 전체 실행에서 1회 실패한
`steady and excluded states hide/show identically`는 약 300회 중 2회 수준이고,
기준선 단독 6/6·전체 실행 통과로 이 작업과 무관합니다. 원인은 test 쪽 race로
보입니다 — 해당 test는 `enterAuthenticatedComparison()` 직후 `getAttribute()`로
**한 번만 읽어서**, `expect().toHaveAttribute()`와 달리 재시도가 없습니다. 바로
아래 형제 test는 측정 전에 재시도 assertion으로 기다립니다. `develop`의 spec이고
범위 밖이라 고치지 않았습니다.

## 14. 최종 판정

작업명령서의 **최종 완료 기준 14개 항목이 모두 충족**됐습니다.

| 기준 | 결과 |
|---|---|
| 1. UI-001 keyboard | **충족** — fixture 통과 + 실기기 확인 완료. 기존 항상-참 test는 실효화됨 |
| 2. UI-002 settings 44×44 + 5점 hit-test + 교차 | 충족 |
| 3. UI-003 오류/복구/상태 text AA (light·dark) | 충족 |
| 4. UI-007 보조 text readable token, 320px 밀도 회귀 없음 | 충족 (예외 3건 명시) |
| 5. UI-004 320 dark·영어·AI Review error/retry·DR 실패 활성 | 충족 (golden 63장 / 74 test) |
| 6. UI-006 ko display heading 어절 분절 0 | 충족 |
| 7. UI-008 focused tier가 develop merge-blocking, heavy는 main/nightly `retries=0` | 충족 |
| 8. UI-009 canonical English legal title 1개 | 충족 |
| 9. UI-010 selection count 1회 | 충족 |
| 10. UI-012 승인된 정책·token mapping 문서화, 무단 recolor 없음 | 충족 (B안, 색상 값 변경 0) |
| 11. 정량 회귀 기준선 8개 항목 | 충족 (11장) |
| 12. VAL-003 로그인 hydration 기록 | 충족 — 기록에 그치지 않고 결함을 수정하고 assertion을 활성화 |
| 13. test 명령의 pass/fail/skip, SHA, viewport/locale/theme/zoom 기록 | 충족 (13장 및 각 장) |
| 14. `P1`에 `FAIL`·`PARTIAL`·`NOT VERIFIED` 없음 | **충족** — UI-001이 `PASS`로 확정되어 마지막 `PARTIAL`이 해소됨 |

기준 14의 차단 조건이 해소됐으므로, 이 작업 범위에서 **출시를 막는 항목은
없습니다.** 열려 있는 항목은 12장의 표대로 전부 작업명령서가 비차단으로
분류한 것들입니다(UI-012는 `P3`, VAL-004·005는 design decision 대기,
VAL-007은 `Not Verifiable`).

`Go-Live READY` 선언 자체는 이 문서의 권한이 아니라 배포 결정권자의 판정입니다.
이 문서가 제공하는 것은 그 판정에 필요한 증거이며, 위 14개 항목에 대해 그
증거가 모두 갖춰졌습니다.
