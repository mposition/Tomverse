# Tomverse Insight — UI Go-Live 잔여 결함 수정 기록 (2026-07-29)

> 이 문서는 **구현 기록**입니다. 작업 지시서가 기준으로 삼은 SHA와 실제
> `origin/develop`·staging이 어긋난 상태에서 시작했고, 그 처리 과정을 §1에
> 먼저 적었습니다. 판정은 §7에 있습니다.

---

## 1. 기준선 이동과 재기준화

작업 지시서는 local·origin·staging이 모두 `21a94db…`로 일치한다고 명시했지만,
작업 중 확인한 실제 상태는 달랐습니다.

| 기준 | 지시서 | 작업 시작 시 실제 |
|---|---|---|
| local HEAD | `21a94db…` | `21a94db…` ✅ |
| `origin/develop` | `21a94db…` | **`1ed042c…`** ❌ |
| staging `/api/build-info` | `21a94db…` | **`1ed042c…`** / `1ed042c` ❌ |
| staging deployment | — | `23fe43b7-6344-4a66-b46a-e82191b4c61d` · `success` · deployed 2026-07-28T23:16:06Z |

`21a94db..1ed042c` 사이에 **동일 감사 결과에 대한 별도 remediation이 이미 병합**
되어 있었습니다.

```
1ed042c Record the merge and the staging redeploy it triggered
b13c3eb Merge remediation of the 11 agreed audit findings into develop
c335029 Darken the highlighted plan surface so its on-colour text reaches AA
58e0b73 Apply approved contrast, currency and canonical-baseline decisions
98818a5 Fix composer remount prompt loss, panel select naming and pricing locale reflow
```

지시서 §2.2·§2.3(“다른 SHA의 결과를 합치지 않는다 / 새 SHA를 기준으로 최소
재현을 다시 수행한다”)에 따라 **작업 branch를 `origin/develop`(`1ed042c`)로
재기준화**하고, 이미 해결된 항목은 버리고 **남은 결함만** 다시 측정해
구현했습니다. 재기준화 이전 작업은 `wip-old-baseline-checkpoint` branch에
보존되어 있으며 배포 대상이 아닙니다.

### 1.1 재기준화 후 다시 측정한 결과

`1ed042c`에서 각 finding을 다시 재현했습니다.

| Finding | `1ed042c`에서 상태 | 처리 |
|---|---|---|
| REAUDIT-F001 통화 표기 locale 의존 | **해결됨** (`billingDisplayLocale` + `currencyDisplay:"narrowSymbol"`) | 재구현하지 않음 |
| REAUDIT-F002 요금 비교 표 keyboard | **해결됨** (`role="region"` + `tabIndex=0` + focus outline) | 재구현하지 않음 |
| REAUDIT-F003 model select 접근명 | **해결됨** (`chat.panelModelSelectLabel`) | 재구현하지 않음 |
| REAUDIT-F004 색 대비 | **해결됨** (`/status`·landing·footer·pricing) | 재구현하지 않음 |
| **VAL-002 pricing intrinsic-width** | **여전히 재현** — 아래 §2 | **수정함** |
| **REAUDIT-F005 언어 선택 focus visible** | **여전히 재현** (focus 스타일 0건) | **수정함** |
| **VAL-004 SSR root language** | **여전히 재현** (`app/layout.tsx`가 `lang="en"` 고정) | **수정함** |
| **UI-P1-04 signin 분석 설정 겹침** | **여전히 재현** — 아래 §3 | **수정함** |
| **UI-P1-05 tablet 3-model 도달성** | **여전히 재현** (`!isConversationEmpty && useTabsLayout`) | **수정함** |

즉 이 작업의 산출물은 이미 병합된 remediation과 **중복이 없는 잔여 5건**입니다.

---

## 2. VAL-002 — `/pricing` 확대 시 가로 overflow (잔존분)

### 재현 (수정 전, `1ed042c` 빌드)

`tests/e2e/pricing-promotion-reflow.spec.ts`(develop이 browser-locale 축까지
추가해 둔 guard)를 그대로 실행한 결과입니다.

```
VAL-002 320 @200% (en) promotion=4px baseline=4px
offender={"selector":"p.text-xs.font-bold.uppercase","right":164}
```

- 6 failed / 55 passed
- 실패 조합: `320 @200% (en)` 및 browser locale 5종(en-US·en-AU·en-GB·ko-KR·de-DE)의 `320 @200%` — **모든 browser locale에서 동일하게 4px**

통화 표기를 고정한 뒤에도 남은 4px이므로 **통화 폭과는 다른 결함**입니다.
promotion on/off 모두 4px으로, promotion도 원인이 아닙니다.

### 원인 (실측)

layout viewport 160px에서 카드 content box는 80px입니다. 그 안에서 자기
min-content를 80px 아래로 낮추지 못하는 요소들이 남아 있었습니다.

| 요소 | min-content | 조치 |
|---|---:|---|
| plan eyebrow `p.text-xs.uppercase.tracking-[0.18em]` (“For everyday productivity”) | 123px | `min-w-0 [overflow-wrap:anywhere]` |
| `plan.badge` “Recommended” (`shrink-0`) | 119px | `shrink-0` 제거 + 동일 escape |
| 연간 블록 “Save 20%” pill이 nowrap 쌍에 묶임 | — | 행 `flex-wrap` |
| 연간 가격 `text-lg font-black` | 112px (52px 상자) | `clamp(0.875rem,4.5vw,1.125rem)` + `font-bold` |
| sale price `text-5xl` 고정 48px | — | `clamp(1.5rem,13vw,3rem)` |

eyebrow는 `tracking-[0.18em]`이 글자마다 폭을 더해 **가장 긴 단어 하나**가
카드보다 넓어진 경우입니다. 연간 가격의 weight를 900→700으로 낮춘 것은
`docs/ui-contracts/typography.md`가 `font-black`을 ≥18px로 제한하기 때문이며,
이 값은 이제 14px까지 줄어들 수 있습니다.

### 수정 후

```
VAL-002 320 @200% (en) promotion=0px baseline=0px offender=null
VAL-002 320 @200% (ko) promotion=0px baseline=0px offender=null
```

`pricing-promotion-reflow.spec.ts` **61/61 통과** (UI language 16조합 32측정 +
browser locale 5종 × 8조합).

---

## 3. UI-P1-04 — signin 분석 설정 control이 계정 CTA를 가림

### 재현 (수정 전)

`analytics-settings-button`은 viewport 고정(`fixed bottom-right z-[60]`)이라
중앙 정렬된 로그인 카드 위로 내려앉습니다. **높이가 재현 조건**입니다.

| 조건 | 교차 면적 |
|---|---:|
| 320×568 en | Google **3864px²** |
| 320×640 en | Microsoft **4048px²** |
| 320×568 ko | Microsoft **1120px²** |
| 360×568 en | Microsoft **2208px²** |
| 390×568 en | Microsoft **368px²** |
| 320×844 (모든 locale) | **0** |

과거 감사들이 628px²·1142px²·0으로 서로 다른 값을 보고한 이유가 이것입니다.
**tall viewport만 측정하면 결함을 통과시킵니다.**

### 수정

signin은 이미 로그인 카드 바로 뒤에 정상 문서 흐름 slot을 등록하고 있습니다
(`SignInPageContent`의 consent slot). 설정 control을 같은 slot으로 portal하여
겹침이 **구조적으로 불가능**하게 했습니다. notice와 설정 control은 상호
배타적(`consent === "unset"` vs 확정 상태)이라 slot이 둘을 동시에 담지
않습니다. 다른 route의 고정 pill 동작은 변경하지 않았습니다.

### 완료 조건 대비

`tests/e2e/signin-analytics-placement.spec.ts` **25/25 통과**

- 320/360/390 × ko/en × consent `unset`/`accepted`/`declined` 전수 18조합
- 설정 control ∩ (Google, Microsoft, 약관 link, 개인정보 link) = **0px²**
- OAuth CTA 표면 **9×5 = 45점** hit-test interception **0**
- 설정 control clickable box ≥44×44 CSS px, viewport 내부
- light/dark × 100/200%, keyboard open, safe-area inset에서 overlap·overflow 0
- 동의 확정 시 slot이 control 높이와 정확히 일치(빈 띠 없음)

**역방향 검증**: 수정을 되돌리고 같은 suite를 실행하면 위 표의 면적으로
10건 이상이 실패합니다. guard가 결함을 실제로 잡습니다.

---

## 4. VAL-004 — hydration 이전 SSR root language

### 재현 (수정 전)

첫 HTTP 응답의 raw HTML입니다.

| 요청 | 수정 전 | 수정 후 |
|---|---|---|
| `/chat` (Accept-Language: ko) | `lang="en"` | **`lang="ko"`** |
| `/chat?lang=ko` (browser en) | `lang="en"` | **`lang="ko"`** |
| `/chat?lang=en` (browser ko) | `lang="en"` | `lang="en"` |
| `/auth/signin?lang=ko` | `lang="en"` | **`lang="ko"`** |
| `/auth/signin` (browser ko) | `lang="en"` | **`lang="ko"`** |
| `/`, `/pricing` | `lang="en"` | `lang="en"` |
| `/ko` | `lang="en"` | `lang="en"` (§7.2 참조) |

`/chat`은 `app/(application)/layout.tsx`가 이미 `Accept-Language`로 한국어
copy를 서버 렌더링하고 있었으므로, **한국어 본문이 `lang="en"`으로 배달**되고
있었습니다. `:lang(ko)`가 매치하지 않아 첫 페인트가 Latin face로 그려진 뒤
hydration 후 다시 그려집니다.

### 구현

- `lib/documentLanguage.ts` — 순수 해석 함수. 우선순위 `?lang=` → `/{locale}`
  경로 → `Accept-Language` → `en`. 이 순서는 **서버가 실제로 렌더링하는 언어와
  일치**시키기 위한 것입니다. 렌더링하지 않은 언어를 선언하면 불일치를 다른
  불일치로 바꿀 뿐입니다.
- `proxy.ts` — query·경로·헤더를 한 번에 보는 유일한 지점이므로 여기서 해석해
  `x-tomverse-document-lang`(+ `-source`)로 전달.
- `app/layout.tsx` — `<html lang>`을 그 헤더에서 읽음.
- `app/(application)/layout.tsx` — `initialLang`을 같은 헤더에서 읽고,
  출처가 `search`일 때만 `forceInitialLang`. 이전에는 `Accept-Language`만
  읽었기 때문에 `/chat?lang=ko`를 영어 브라우저로 열면 **영어 copy를
  `lang="ko"`로 배달**하게 됐을 상황을 막습니다.

### 보안 회귀 규칙

`scripts/security-regression-check.mjs`의 “root layout은 `next/headers`를
쓰지 않는다” 규칙은 **완화하지 않고 좁혔습니다**. 허용되는 request-time read를
`DOCUMENT_LANGUAGE_HEADER` 정확히 1건으로 한정하고, `cookies()` /
`getServerSession` / `prisma`는 계속 금지합니다. marketing group의
`force-static`도 그대로이며, 빌드 결과에서 marketing route가 계속 prerender
되는 것을 확인했습니다(`/pricing` `○`, `/[locale]` `●`) — 이는
`lib/staticMarketingCsp.ts`가 빌드된 HTML을 해시하기 때문에 필요한 조건입니다.

### 검증

- `tests/documentLanguage.test.mjs` 6건 통과 (우선순위, alias, q-value 순서, 오류 입력)
- `tests/e2e/ssr-root-language.spec.ts` 14건 통과 — raw 첫 응답(`request.get`)으로
  측정하고, hydration 후 `documentElement.lang`이 바뀌지 않는 것과 hydration
  error 0, `:lang(ko)` → `Noto Sans KR` 적용까지 확인

---

## 5. UI-P1-05 — 768–1024px 빈 대화의 3-model 도달성

### 재현 (수정 전)

| 폭 | tablist | 보이는 panel | 도달 가능한 model |
|---:|---:|---|---|
| 768 | 0 | 1 (나머지 2개 `display:none` + `aria-hidden`) | **1 / 3** |
| 834 | 0 | 1 | **1 / 3** |
| 1024 | 0 | 1 | **1 / 3** |
| 1279 / 1280 | 0 | 3 | 3 / 3 |

panel 가시성은 `useTabsLayout`만으로 결정되는데 tab bar는
`!isConversationEmpty && useTabsLayout`이었습니다. 즉 메시지가 하나도 없는
상태에서 두 model은 **화면 어디에서도 이름조차 나오지 않습니다.** composer는
“3개 모델”을 표시합니다. ≥1058px에서는 3패널이 모두 렌더링되므로 같은 빈
상태에서도 문제가 없었고, 그래서 눈에 띄지 않았습니다.

### 수정

tab bar 조건을 `useTabsLayout`만으로 바꿨습니다. tab bar는 이미 선택된 모든
model을 이름으로 표시하고, WAI-ARIA roving tabindex와 model별 제거를
제공합니다. 3패널이 렌더링되는 폭에서는 아무 영향이 없습니다.

### 검증

`tests/e2e/model-panel-tablet-reachability.spec.ts` 통과

- 768 / 834 / 1024 / **1057**(breakpoint −1) × ko·en에서 3개 model 전부가
  이름·box를 가지고 `aria-hidden` 밖에 있음
- Arrow key로 3개 model 모두 도달
- **1058**(breakpoint)에서는 tab bar가 사라지고 3패널이 나란히 렌더링
- tab bar ∩ (welcome composer, chat-input, empty state) = 0px², overflow ≤1px

breakpoint 1058은 제품의 계산식(3 model × 310px + 64px sidebar + 32px chrome +
2 × 16px gap)에서 유도한 값이며 양쪽을 모두 assert합니다.

---

## 6. REAUDIT-F005 — marketing 언어 선택 focus visible

select에 `outline-none`이 있는데 대체 표시가 없어 focus 전후 렌더가
동일했습니다(WCAG 2.4.7). ring은 select가 아니라 감싸는 `<label>`에
`focus-within`으로 넣었습니다 — label이 `overflow-hidden`이라 내부에 그린
outline은 잘리지만, label 자신의 box에 그린 ring은 잘리지 않습니다.

`tests/e2e/marketing-language-focus.spec.ts` light/dark 2건 통과. 검사는 class
이름이 아니라 **렌더된 indicator를 focus 전후로 비교**하므로, 그려졌지만
잘리는 ring도 실패로 잡힙니다.

---

## 7. 검증 결과와 판정

### 7.1 실행한 명령

| Suite | 명령 | 결과 |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | ✅ 0 error |
| Lint | `npx eslint . --max-warnings=0` | ✅ 0 warning |
| Unit | `npm run test:unit` | ✅ **536 pass / 0 fail / 0 skip** |
| Accent tokens | `npm run check:accent-tokens` | ✅ 10 files / 10 roles |
| Text encoding | `npm run check:encoding` | ✅ pass |
| Security regression | `npm run security:regression` | ✅ **113 / 113** |
| Production build | `npm run build` | ✅ pass, marketing route는 계속 prerender |
| `@ui-risk` E2E | `npm run test:e2e:ui-risk` | ✅ **242 pass / 0 fail / 40 skip** |
| Font preload | `node scripts/report-font-preload.mjs` | ✅ 65 route, preload 수 {0,1}, 최대 28.6 KB |
| Visual regression | `npm run test:e2e:visual -- --retries=0` | ⚠️ 22 pass / 52 fail — **§7.3 참조: Not verified** |

`@ui-risk`의 40 skip은 억제가 아니라 project scope입니다. pricing reflow spec은
mobile device emulation에서 **의도적으로 skip**합니다 — `isMobile`의
meta-viewport 처리가 layout viewport를 다시 넓혀 실제로 overflow하는 페이지를
0px으로 보고하기 때문입니다.

### 7.2 실제 렌더링 증거

절대 경로: `/tmp/claude-0/-home-user-Tomverse/02bc19ab-457e-5ad4-97fd-4c957446cdfa/scratchpad/evidence/`
(metadata는 같은 폴더 `metadata.json`)

| 파일 | route | layout viewport | document overflow | root lang | 본문 font |
|---|---|---:|---:|---|---|
| `pricing-1440x900-en.png` | /pricing | 1440 | 0 | en | Geist |
| `pricing-1440x900-ko.png` | /pricing | 1440 | 0 | ko | Noto Sans KR |
| `pricing-390x844-en.png` | /pricing | 390 | 0 | en | Geist |
| `pricing-390x844-ko.png` | /pricing | 390 | 0 | ko | Noto Sans KR |
| `pricing-320at200-160x284-en.png` | /pricing | 160 | 0 | en | Geist |
| `pricing-320at200-160x284-ko.png` | /pricing | 160 | 0 | ko | Noto Sans KR |
| `signin-320x568-en-consent-accepted.png` | /auth/signin | 320 | 0 | en | Geist |
| `signin-320x568-en-consent-unset.png` | /auth/signin | 320 | 0 | en | Geist |
| `chat-empty-768x900-ko-tabs.png` | /chat | 768 | 0 | ko | Noto Sans KR |
| `chat-empty-1024x900-ko-tabs.png` | /chat | 1024 | 0 | ko | Noto Sans KR |
| `marketing-language-focus.png` | /pricing | 1440 | 0 | en | Geist |

ko route에서 본문 font가 `Noto Sans KR`로 확인되는 것은 root lang 수정이
`:lang()` 경로까지 실제로 도달했다는 증거입니다.

### 7.3 Visual regression — Not verified

`docs/qa/canonical-visual-baseline.md`가 정의한 canonical 환경이 이 컨테이너에
없습니다.

- 필요한 browser: Playwright 1.62.0 번들 Chromium (**v1234 / Chromium 151**)
- 이 환경에 있는 browser: **Chromium 141.0.7390.37** (`chromium-1194`)
- `npx playwright install chromium` → `403 request rejected: host not permitted`
  (`cdn.playwright.dev`가 egress 정책으로 차단)

golden을 판정하기 위해 사용 가능한 Chromium 141을 기대 경로에 연결해 실행했고,
이는 저장소 정책이 명시한 **비-canonical 실행**입니다. 결과 52 fail은 전부
픽셀의 1–4%가 **모든 text run의 글리프 가장자리**에만 분포하며, 요소가 이동한
흔적은 없습니다 — canonical baseline 문서가 기술한 Chromium 141 vs 151 서명과
정확히 일치합니다. diff 이미지를 육안 확인했습니다.

정책에 따라 이 결과는 **pass도 fail도 아닌 `Not verified`**이며, golden 재기록의
근거로 사용하지 않았습니다. expected/actual/diff artifact는 `test-results/`
아래 52개 디렉터리에 보존되어 있습니다.

**변경이 golden을 움직였는지**: 재기준화 이전 baseline에서도 동일하게 52 fail /
22 pass였고, 이번 변경분은 tabs layout(768–1057px)과 `/auth/signin`만 건드리므로
visual suite의 viewport(desktop 1280+, mobile 320/390)와 교차하지 않습니다.

### 7.4 항목별 판정

| 항목 | Code | Local test | Actual render | CI | Staging |
|---|---|---|---|---|---|
| VAL-002 pricing reflow (잔존분) | PASS | PASS | PASS | NOT VERIFIED | NOT VERIFIED |
| VAL-004 SSR root language (dynamic route) | PASS | PASS | PASS | NOT VERIFIED | NOT VERIFIED |
| VAL-004 SSR root language (`/ko` 등 static route) | **PARTIAL** | PASS(현 동작 고정) | PASS | NOT VERIFIED | NOT VERIFIED |
| UI-P1-04 signin 분석 설정 배치 | PASS | PASS | PASS | NOT VERIFIED | NOT VERIFIED |
| UI-P1-05 tablet 3-model 도달성 | PASS | PASS | PASS | NOT VERIFIED | NOT VERIFIED |
| REAUDIT-F005 언어 선택 focus | PASS | PASS | PASS | NOT VERIFIED | NOT VERIFIED |
| UI-P1-03 visual regression 63 golden | — | — | — | **NOT VERIFIED** | NOT VERIFIED |
| 실기기 keyboard / safe area | — | — | — | — | **NOT VERIFIED** |

#### `/ko` root lang이 PARTIAL인 이유

`/`, `/pricing` 등 정적 marketing route는 영어 copy를 모든 방문자에게 동일하게
서빙하므로 `lang="en"`이 **배달되는 바이트와 일치**합니다. 문제는
`/[locale]`(`/ko`, `/ko/<intent>`)입니다. 한국어 본문을 prerender하면서 root는
`en`으로 남습니다.

- 현재도 해당 route는 콘텐츠 wrapper에 `lang="ko"`를 렌더링하므로 `:lang(ko)`
  font routing과 보조기술의 언어 판별은 첫 페인트부터 정상 동작합니다.
  (`ssr-root-language.spec.ts`가 이를 고정합니다.)
- 남은 격차는 **문서 수준 `<html lang>`** 하나입니다(WCAG 3.1.1).
- root layout은 route param을 볼 수 없고, Next 16에서 `unstable_rootParams`는
  제거되었습니다. 정적 prerender를 유지한 채 이를 고치는 방법은 두 가지뿐이며
  둘 다 이번 범위를 넘습니다:
  1. `app/[lang]/…` 구조로 라우팅 전환(Next 공식 i18n 패턴, 전 route 재배치)
  2. localized landing route를 dynamic으로 전환 + `isStaticMarketingPathname`
     에서 제외해 nonce CSP 경로로 이동 — prerender와 `s-maxage=3600` CDN
     캐싱을 잃습니다

두 선택 모두 design/infra 결정이 필요하므로 근거를 남기고 `PARTIAL`로
기록합니다. 임의로 결정하지 않았습니다.

### 7.5 남은 UI 위험

- **UI-P1-03**: canonical Chromium 부재로 golden 63건이 판정 불가.
  `cdn.playwright.dev` 접근이 가능한 runner 또는 canonical image에서
  `desktop-chromium` 1회 실행이 필요합니다.
- **PR Fast Gate / nightly workflow의 active run URL**: 외부 권한이 없어
  확보하지 못했습니다. 지시서 규정대로 `UI-P1-03`은 최대 `PARTIAL`입니다.
- **실기기 keyboard / safe area**(iOS Safari, Android Chrome): 이 환경에 실기기가
  없습니다. `visualViewport` 축소 fixture만으로 PASS를 주장하지 않습니다 →
  `NOT VERIFIED`.
- **`analytics-settings-target.spec.ts` flake**: 전체 실행에서 간헐적으로 1건
  실패하고 격리 실행에서는 통과합니다. **이번 변경과 무관함을 확인**했습니다 —
  변경을 되돌린 상태에서도 같은 spec의 다른 case(`signin@390`)가 실패했고,
  변경을 적용한 상태에서는 `marketing@320`이 실패했습니다. 독립 감사가 이미
  `Flake / race — 미해결`로 기록한 것과 같은 문제이며 여전히 미해결입니다.

### 7.6 UI와 별개인 제품 위험

UI gate와 별도로 provider·credit·운영 경로의 독립적인 출시 조건을 확인해야
합니다. 이 문서는 그 항목들을 다루지 않았습니다(실제 provider 호출,
credit 정산 실증, degraded fallback 추천, probe 정지 감지 등).

---

## 8. 다음 단계 (외부 권한 필요)

1. canonical runner에서 `npm run test:e2e:visual -- --retries=0` 1회 실행 →
   `UI-P1-03` 판정
2. 실제 UI 변경을 담은 PR에서 build/smoke/`@ui-risk`가 skip 없이 green인지 확인
3. default branch의 active nightly workflow green run URL 확보
4. `/ko` root lang에 대해 §7.4의 두 선택지 중 하나를 design/infra가 결정
5. iOS Safari / Android Chrome 실기기 keyboard·safe area 검증
