# Tomverse Insight UI 감사 후속 작업 결과

> 이 문서는 `TOMVERSE_INSIGHT_UI_AUDIT_FINAL_REPORT.md` 기준 작업명령서
> (UI-001~UI-012, VAL-001~VAL-007)의 **실행 결과 기록**입니다.
> 표기: `[코드]` 소스 확인, `[테스트]` 자동화 실행 결과, `[미검증]` 근거 미확보.

## 1. 실행 baseline

| 항목 | 값 |
|---|---|
| 기준 branch | `claude/tomverse-insight-ui-audit-3m2k1c` |
| 분기점 SHA | `e062da8` (`origin/develop`) |
| 작업명령서가 지정한 기준 SHA | `8d02fc1` — 그 이후 `e062da8`(감사 보고서 커밋)만 추가되었고 제품 코드 변경은 없음 |
| 실행 환경 | Linux 컨테이너, Chromium 1194 (`/opt/pw-browsers`), Playwright 1.62 |
| 실행 project | `desktop-chromium`, `desktop-compact`, `mobile-chromium` |
| webkit (`mobile-safari`) | **[미검증]** 이 컨테이너에 webkit 빌드가 없고 proxy가 다운로드를 차단함. nightly `daily-security-audit.yml`이 chromium+webkit을 실행함 |
| 실제 provider 호출 / 결제 / DB write | **없음** (모든 상태는 route mock과 in-page fetch stub) |

## 2. 이슈별 결과

| ID | 상태 | 근거 |
|---|---|---|
| UI-001 | **Fixed (fixture 기준)** | 축소된 visual viewport에서 검색·후보·완료가 모두 도달 가능. 실기기 검증은 미수행 → 3장 참조 |
| UI-002 | **Fixed** | 320~430px 5개 폭 × 3개 route에서 44×44 + 5점 hit-test + content 교차 0px² |
| UI-003 | **Fixed** | 오류/복구/상태 text가 light·dark 모두 AA 통과 (pixel 합성 측정) |
| UI-004 | **Fixed** | golden 49 → 63장. 320 dark 복구 4종, 영어 복구 4종, AI Review 5종, Deep Research 실패 활성 1종 추가 |
| UI-005 | **Not reproducible (promotion 원인 아님)** | VAL-002 결과, 4장 참조 |
| UI-006 | **Fixed** | ko display heading 5종 × 4 viewport에서 어절 분절 0 |
| UI-007 | **Fixed** | 필수 consumer 보조 text의 9–10px 제거, 예외 3건은 명시 표시 |
| UI-008 | **Fixed** | `@ui-risk` tier가 develop PR merge-blocking으로 실행 |
| UI-009 | **Fixed** | 영어 legal 명칭 `Terms and Conditions` 단일화 |
| UI-010 | **Fixed** | 모델 sheet의 selection count 1회 노출 |
| UI-012 | **문서화만 수행** | design decision 미승인 → recolor 없음. `ui-semantic-accent-inventory.md` |

## 3. UI-001 / VAL-001 — 모바일 keyboard

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

**한계** `[미검증]`
실기기(iOS Safari / Android Chrome) 검증은 수행하지 못했습니다. fixture는
`visualViewport` 축소라는 한 가지 속성에 대해서만 충실하며 keyboard animation
타이밍이나 browser별 scroll-into-view 동작은 재현하지 않습니다. 작업명령서
기준으로 UI-001의 최종 판정은 실기기 확인 전까지 **`Partially Confirmed`**
입니다.

## 4. VAL-002 — promotion-active pricing overflow

`featuredPromotion`은 `/api/billing/config` 하나에서만 오므로 mock으로 상태를
고정하고, **같은 조합을 promotion on/off로 두 번 측정**했습니다
(`pricing-promotion-reflow.spec.ts`, 16 test 통과).

| 조합 | promotion | baseline | offender |
|---|---:|---:|---|
| 320 @125% en | 47px | 47px | `article.relative.flex.min-h-full` |
| 320 @150% en | 90px | 90px | 동일 |
| 320 @200% ko | 47px | 47px | `button.inline-flex.h-10.w-10` |
| 320 @200% en | 143px | 143px | `article...` |
| 390 @150% en | 43px | 43px | `article...` |
| 390 @200% ko | 12px | 12px | `button...` |
| 390 @200% en | 108px | 108px | `article...` |
| 나머지 9개 조합 | 0px | 0px | — |

**결론:** promotion은 overflow를 1px도 추가하지 않습니다. UI-005가 기술한
"promotion 때문에 넘친다"는 **재현되지 않습니다**.

다만 promotion과 무관하게 `/pricing`이 좁은 폭 + 확대에서 넘치는 것은
사실입니다(plan card `<article>`의 최소 너비). 이는 UI-005와 다른 신규
발견이며 승인 범위 밖이므로 **수정하지 않고 기록**합니다. 별도 ticket 필요.

## 5. VAL-003 — 로그인 SSR → hydration

`signin-hydration.spec.ts`가 같은 페이지를 JavaScript 비활성 context(=SSR
markup)와 hydration 완료 상태로 각각 읽어 비교합니다. ko/en × light/dark.

| 검사 | 결과 |
|---|---|
| React hydration console error | **0건** (4개 조합 전부) |
| heading·label·paragraph 개수 | 변화 없음 |
| legal link 목적지 (`/terms`, `/privacy`) | 변화 없음, 각 1개 |
| 영어 본문 text 완전 일치 | 일치 |
| **한국어 본문 text 완전 일치** | **불일치 — 신규 발견** |

`?lang=ko`에서 서버는 영어 문자열(`Terms and Conditions`, `Privacy Policy`)을
렌더하고 client가 hydration 후 한국어(`이용약관`, `개인정보 처리방침`)로
교체합니다. 한국어 사용자는 법적 link를 잠시 영어로 보게 됩니다.

작업명령서 지시에 따라 **즉시 수정하지 않았습니다**. 언어 해석을 서버로
옮기는 변경은 localization 경계 변경이고 승인 범위 밖입니다. 검증은 삭제하지
않고 `test.fixme`로 남겨 두었으며, 그 assertion이 곧 수용 기준입니다.

## 6. UI-003 / UI-007 — 대비와 보조 typography

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

## 7. UI-004 — golden matrix

| 구분 | 이전 | 이후 |
|---|---:|---:|
| golden PNG | 49 | 63 |
| golden suite test | 60 | 74 |
| 기존 49장 | — | 전부 보존, 전부 통과 |

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

## 8. UI-008 — CI tier

`@ui-risk` tag로 44개 test를 묶어 `test:e2e:ui-risk`
(`desktop-chromium` + `mobile-chromium`)를 PR Fast Gate의 `build-and-e2e` job에
추가했습니다. 실측 **46초**. 상세 표는 `.github/audits/ui-test-tiers.md`.

유지된 불변식: required check 이름, aggregator의 skip/failure 처리, secret
scan, smoke manifest, `--update-snapshots` 금지, main·nightly의 무필터 실행,
`chat-state-visual-regression`을 PR gate에서 이름으로 부르지 않기.
`scripts/security-regression-check.mjs`에 새 tier에 대한 assertion 3개를
추가했고 전체 113개 검사가 통과합니다.

## 9. 정량 회귀 기준선

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

## 10. 남은 항목 / 승인 필요

1. **UI-001 실기기 확인** — iOS Safari, Android Chrome 각 1회. 이후에야
   `PASS`로 승격 가능.
2. **한국어 sign-in hydration 언어 전환** (VAL-003 신규 발견) — 신규 ticket 필요.
3. **`/pricing` 좁은 폭 + 확대 overflow** (VAL-002 부수 발견, promotion 무관) —
   신규 ticket 필요.
4. **UI-012 semantic color 정책** — A/B 중 승인 필요.
   `ui-semantic-accent-inventory.md` 4장.
5. **VAL-004 (fine-pointer 좁은 화면 정책)**, **VAL-005 (Deep Research 실패 tab
   자동 활성화 여부)** — 결정 전까지 제품 동작을 바꾸지 않았습니다. golden은
   실패 tab을 명시적으로 선택하는 방식으로 캡처했습니다.
6. **VAL-007 (기준 감사 원본 screenshot)** — 확보하지 못했습니다.
   `Not Verifiable`.
7. **webkit 검증** — 이 환경에서 불가. nightly가 담당.

## 11. 전체 회귀 실행 결과

`desktop-chromium` + `desktop-compact` + `mobile-chromium` 전체 1회 실행
(14.6분): **963 passed / 6 failed / 570 skipped**.

실패 6건은 모두 이번 변경과 무관합니다.

| 실패 | 판정 | 근거 |
|---|---|---|
| `attachment-flow › PDF remains a friendly file card` (desktop-chromium) | 부하 flake | 격리 실행 시 통과 |
| `attachment-flow › selected image previews` (desktop-compact) | 부하 flake | 격리 실행 시 통과 |
| `conversation-title › composer stays fully usable…` (desktop-chromium) | 부하 flake | 격리 실행 시 통과 |
| `tab-resume › session revalidation…` (desktop-compact) | 부하 flake | 격리 실행 시 통과 |
| `chat-keyboard-policy › Cmd+Enter sends from an external keyboard` (mobile-chromium) | **사전 존재 flake** | 변경본 5회 중 2회 실패, `git stash` 후 재빌드한 baseline도 5회 중 1회 실패 |
| `chat-tools › web search mode selection does not repeat across a new chat` (mobile-chromium) | **사전 존재 실패** | baseline 재빌드에서도 동일하게 실패 |

두 사전 존재 항목은 이번 작업 범위 밖이라 수정하지 않았습니다.

정적 검사: `eslint --max-warnings=0` 통과, `tsc --noEmit` 통과,
`npm run test:unit` 499/499 통과, `npm run security:regression` 113 검사 통과,
`npm run verify:smoke-coverage` 통과 (@smoke 20개 유지),
`npm run check:encoding:strict` 통과.
