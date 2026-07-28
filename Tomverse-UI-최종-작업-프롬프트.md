# Tomverse Insight UI 최종 수정·검증 작업 프롬프트

> 이 문서 하나만 읽고 작업을 시작할 수 있습니다. 상태: **실행 가능**
> 근거 추적: `Tomverse-UI-상호검토-합의정리.md` · 원 Review 명령서 `UI 검사.txt`
> 조정 시점 배포 SHA `21a94db510e8a7a88541bc7bad1771f1c1772b06`

---

## 1. 역할과 단일 목표

당신은 Tomverse Insight의 **Senior Frontend Engineer 겸 Accessibility·Visual Regression Engineer**입니다.

**이번 작업은 보고서 작성이 아니라 구현·수정·검증 작업입니다.** 아래 확정된 결함을 실제 코드에서 고치고, 재현 가능한 증거로 검증하고, 회귀 테스트를 남기는 것까지가 범위입니다. 조사만 하고 "수정이 필요합니다"로 끝내지 마십시오.

**달성해야 할 최종 상태**

1. 요금 페이지가 150–200% 확대에서 가로로 넘치지 않는다.
2. 로그인 화면에서 분석 설정 버튼이 계정 선택 CTA를 어떤 동의 상태에서도 가리거나 탭을 가로채지 않는다.
3. 한국어·영어 페이지의 root 문서 언어가 첫 HTTP 응답부터 본문 언어와 일치한다.
4. 상태 golden 63장이 CI에 등록된 workflow에서 전수 green으로 실행된다.
5. 비문서 PR에서 `@ui-risk`가 실제로 실행되어 green이다.
6. 위 변경이 기존에 통과하던 항목을 하나도 깨뜨리지 않는다.

---

## 2. Source of Truth

충돌 시 **아래 순서대로** 우선합니다.

1. **저장소 `AGENTS.md`** 및 그것이 지정하는 `docs/ui-contracts/*.md` — 여기에 적힌 release blocker는 어떤 이유로도 완화·생략하지 않습니다.
2. **동일 배포 SHA에서 재현 가능한 실제 렌더링·측정 결과**
3. **실제 제품 컴포넌트를 렌더링하는 deterministic fixture와 자동화 테스트**
4. **관련 소스 구현과 CI 설정**
5. **원 Review 명령서 `UI 검사.txt`의 완료 조건**
6. **`Tomverse-UI-상호검토-합의정리.md`에서 확정된 범위**
7. 설명·해석·미입증 주장 (최하위)

**Next.js 주의**: 이 저장소의 Next.js는 일반적인 Next.js와 다릅니다. 코드를 작성하기 전에 반드시 `node_modules/next/dist/docs/`의 해당 가이드를 먼저 읽으십시오. `AGENTS.md` 첫 줄이 이를 명시합니다.

**소통 언어**: 사용자와의 모든 대화는 한국어. 단 code identifier, 파일명, `data-testid`, test 제목, 소스 주석, commit message는 기존 영어 관례를 따릅니다.

---

## 3. 확정 작업 범위

### 3-1. 반드시 수정 — P1-a. 요금 페이지 확대 가로 overflow

**현재 문제 (원인 2개, 서로 다른 요소입니다. 하나만 고치면 실패가 남습니다.)**

| # | 위치 | 조건 | 관측 |
|---|---|---|---|
| A | `components/marketing/PricingPageContent.tsx:1064` — `<span className="text-5xl font-black">{salePrice}</span>` | promotion 활성 (스테이징 현재 상태) | layout viewport 160px에서 ko **128px**, en **66px** 초과. 260px(390@150%)에서도 ko 28px 초과 |
| B | `p.text-xs font-bold uppercase tracking-[0.18em]` 계열 plan eyebrow (예: 동일 파일 987행) | promotion **유무 무관** | CI 측정 `promotion=4px baseline=4px`, offender right=164 @ viewport 160px |

같은 파일 **1024행의 일반 가격은 이미 `text-[clamp(1.5rem,10vw,2.25rem)]`로 수정되어 있습니다.** 할인가만 fluid type이 누락됐습니다.

**원하는 결과**: 요금 페이지가 좁은 layout viewport에서 세로 스크롤만으로 읽히며, 가격 강조와 promotion 인지성은 유지됩니다.

**완료 조건**
- ko·en × layout viewport **160 / 195 / 213 / 260px**에서 `documentElement.scrollWidth - documentElement.clientWidth ≤ 1`
- promotion **활성·비활성 양쪽** 모두 충족
- `npx playwright test tests/e2e/pricing-promotion-reflow.spec.ts` 가 `desktop-chromium`·`mobile-chromium` 두 project에서 green
- 1440×900 및 390×844 100%에서 가격 계층(할인가 > 정가 취소선 > 기간)이 시각적으로 유지

**측정 방법 주의**: 브라우저 확대 UI가 아니라 **layout viewport를 직접 축소**해야 재현됩니다(320÷2=160). mobile emulation(meta viewport)을 켜면 Chromium이 layout viewport를 넓혀 결함이 숨습니다. `tests/e2e/pricing-promotion-reflow.spec.ts:146-152`가 올바른 기법을 씁니다.

---

### 3-2. 반드시 수정 — P1-b. 로그인 post-consent 설정 pill이 계정 CTA 침범

**현재 문제**

`components/analytics/AnalyticsProvider.tsx`의 분석 설정 버튼(`data-testid="analytics-settings-button"`)은 동의가 `unset`일 때는 나타나지 않지만, **`accepted` 또는 `declined`로 결정된 뒤** `position: fixed`로 우하단에 나타납니다. 320×568 로그인 화면에서 이 버튼이 OAuth 계정 선택 버튼과 겹칩니다.

| 측정 | 값 |
|---|---|
| pill | `fixed`, 69.6×44, 우하단 (right/bottom = `max(0.5rem, env(safe-area-inset-*))`) |
| 겹침 | Microsoft 계정 버튼과 **1142.5px²** (다른 환경 측정: Google 628.4px² / Microsoft 171.4px²) |
| **실제 탭 탈취** | Microsoft 버튼 표본 45점 중 **ko 4점(9%) / en 6점(22%)** 이 pill로 귀결 |
| 390×844 | 겹침 **0** — 320px 한정 결함 |

이는 원 Review 명령 `UI-P1-02`의 완료 조건 "notice가 … **계정 선택을 가리지 않습니다**"와 "notice를 **닫거나 선택한 뒤** 레이아웃이 튀거나 빈 공간이 남지 않습니다"를 직접 위반합니다.

**원하는 결과**: 로그인 화면에서 분석 설정 진입점이 계정 선택 CTA·약관·링크와 겹치지 않는 위치(문서 흐름 내 slot 또는 전용 행)에 있고, 동의 재설정 경로와 opt-out은 그대로 유지됩니다.

**참고**: 같은 파일이 이미 `/chat`·`/auth/signin`·marketing 세 route에 **inline slot portal 방식**을 구현해 두었습니다(`chatConsentSlot`, `authConsentSlot`, `marketingConsentSlot`). notice 본체는 이 방식으로 44개 조합에서 교차 0px²를 달성했습니다. 설정 버튼에도 같은 원칙을 적용하는 것이 자연스럽습니다.

**완료 조건**
- **320 / 360 / 390px** × **ko / en** × 동의 상태 **`unset` / `accepted` / `declined`** 전 조합에서
  - 설정 버튼과 계정 선택 버튼·약관 링크·개인정보 링크의 교차 면적 **0px²**
  - 계정 버튼 표면 격자 hit-test(가로 9 × 세로 5)에서 pill로 귀결되는 점 **0개**
- 설정 버튼 자체의 hit-area **≥44×44** 유지
- 개인정보 처리방침 링크와 opt-out 경로 유지
- safe-area inset 침범 없음, 버튼 노출/제거 시 레이아웃 점프 없음
- 신규 회귀 test가 **persisted consent 상태**(`accepted`/`declined`)를 포함

---

### 3-3. 반드시 수정 — P1-c. 상태 golden 회귀 감지망 복구

**현재 문제**

`.github/workflows/nightly-visual-regression.yml`은 `develop`에만 존재하고 기본 branch `main`에는 없습니다. GitHub은 **기본 branch에서 workflow를 등록**하므로 이 workflow는 활성 목록(현재 9개)에 없고 **한 번도 실행된 적이 없습니다**. `e2e.yml`(전체 chromium 회귀)도 `push: main` 전용입니다.

→ **63장 golden과 전체 chromium 회귀가 이번 UI 작업에 대해 CI에서 0회 실행되었습니다.**

**완료 조건**
- workflow가 GitHub 활성 목록에 등장
- 63장 전수 green, `--retries=0`, **snapshot 갱신 플래그 없음**
- report와 actual/expected/diff artifact 보존

**금지**: golden을 갱신해서 통과시키지 마십시오. `nightly-visual-regression.yml` 자체가 "Goldens are never refreshed here, and this workflow must never commit"을 명시합니다.

---

### 3-4. 반드시 수정 — P1-d. 비문서 PR에서 `@ui-risk` 실제 실행

**현재 문제**

`pr-fast-gate.yml`의 `Determine whether this PR touches anything but documentation` 단계가 문서 전용 PR을 감지하면 build·smoke·`@ui-risk`가 **전부 skipped**되고, 그럼에도 필수 check `Security, unit, build, and Chromium smoke tests`는 **success**가 됩니다(run `30360601168` step-level 확인). 문서 PR의 green을 제품 검증 통과로 해석하면 안 됩니다.

또한 배포된 `791fef1`의 원 PR(run `30355658889`)은 step 12 `Run high-risk UI regression checks`가 **failure**, 필수 aggregator도 **failure**인 상태로 merge되었습니다.

**완료 조건**
- P1-a·P1-b 수정을 담은 **코드 PR**에서 `Run high-risk UI regression checks`가 **`skipped`가 아니라 `success`**
- run URL을 **step-level 결과와 함께** 제출
- 필수 aggregator green

---

### 3-5. 반드시 수정 — P2-a. SSR root 문서 언어

**현재 문제**

`app/layout.tsx:74-78`이 root를 `lang="en"`으로 하드코딩합니다.

```
<html
  lang="en"
  suppressHydrationWarning
  className={`${fontVariables} h-full antialiased`}
>
```

`/auth/signin?lang=ko`의 첫 HTTP 응답은 한국어 본문과 약관을 담고 있으면서 root는 `lang="en"`이고, 해당 문서에는 `lang="ko"`가 **0회** 등장합니다. `/ko`는 `app/(marketing)/[locale]/page.tsx:80`의 `<div lang={normalizedLocale}>` wrapper로 subtree만 부분 보정됩니다. 클라이언트 `LanguageProvider`가 hydration 후 `document.documentElement.lang`을 교체합니다.

**계약 충돌**: `docs/ui-contracts/typography.md`는 "Locale families are selected by `:lang()` over the whole subtree, **never by per-glyph fallback**"을 요구하고 위반을 **release blocker**로 규정합니다. root가 `en`인 첫 페인트에서는 한국어 본문이 Latin face로 시작해 per-glyph fallback 상태가 됩니다.

**원하는 결과**: 서버가 결정한 locale이 root 문서까지 전달되어 첫 byte부터 `lang`과 본문이 일치합니다.

**완료 조건**
- `curl "https://<host>/ko"`, `curl "https://<host>/auth/signin?lang=ko"`의 **첫 응답**이 `<html lang="ko">`
- en 경로는 `<html lang="en">`
- hydration 전후 `documentElement.lang` 불일치 0
- `tests/e2e/font-system.spec.ts`와 `tests/typographyPolicy.test.mjs` 유지
- SSR 응답을 직접 검사하는 회귀 test 추가

**구현 주의**: root layout에서 locale을 얻으려면 서버 측 locale 결정 경로가 필요합니다. 저장소에 `proxy.ts`와 `lib/language.ts`가 있고 `?lang=` 쿼리는 이미 서버에서 해석됩니다(VAL-003). 기존 경로를 재사용하고 새 메커니즘을 만들지 마십시오. **구현 방식은 지정하지 않습니다 — 저장소 구조를 먼저 확인하고 결정하십시오.**

---

### 3-6. 수정 없이 재검증할 항목

수정 대상이 아니며, 위 변경이 이들을 깨뜨리지 않았음을 확인하는 것이 목적입니다.

| ID | 대상 | 완료 조건 | 검증 |
|---|---|---|---|
| V-1 | `UI-P1-01` 대화 후 조작 — AI Review, retry, stop, mobile model-tab remove | 320·390 **touch 조건**에서 ≥44×44, 중앙·4모서리 hit-test 자기 명중, 인접 오명중 0 | `tests/e2e/touch-targets.spec.ts` + 상태 fixture |
| V-2 | `UI-P2-01` 한국어 display heading | 어절 분절 0, 320px 랜딩 H1 ≤4줄, 모바일 환영 문구 ≤2줄, 영어 H1 계층 유지 | `tests/e2e/korean-typography.spec.ts` |
| V-3 | `UI-P2-04` 보조 text floor | 11px 미만 0건, 100/125/150/200%에서 겹침·잘림·overflow 0 | `tests/e2e/ui-state-contrast.spec.ts` sub-11px 검사 |
| V-4 | contrast AA | 오류·복구·상태 표면이 light·dark 모두 합성 픽셀 기준 AA 통과 | `tests/e2e/ui-state-contrast.spec.ts` |
| V-5 | `UI-P3-01` accent 역할 token | 위반 0 | `npm run check:accent-tokens` |
| V-6 | `UI-P2-03` Bottom Sheet 390 단계화 | 검색·선택 요약·실제 후보 ≥2·고급 필터 접힘·`필터 N` 활성 표시·완료 접근 | `tests/e2e/model-picker-responsive.spec.ts`, `model-picker.spec.ts` |
| V-7 | PC 3열 구조 | 1280·1366·1440·1920에서 3열 균등 폭·높이, 모델별 독립 composer, 공통 composer 위치 유지 | `tests/e2e/model-comparison-layout.spec.ts`, `comparison-action-rail.spec.ts` |
| V-8 | 모바일 composer 계약 | textarea 전용 전체 폭 행 유지, 도구·칩이 입력 행을 침범하지 않음 | `tests/e2e/mobile-composer-contract.spec.ts` |

---

### 3-7. 명시적 비범위 — 수행하지 마십시오

| 항목 | 사유 |
|---|---|
| **desktop 조작을 44×44로 확대** | 44px 미달 주장은 **fine pointer 오측정**입니다. `touchTarget = isMobileShell \|\| hasCoarsePointer`(`ModelCatalogue.tsx:127`, `ModelPickerPanel.tsx:174`)가 `h-11`↔`h-9`/`h-8`/`py-2`로 분기하는 **의도된 설계**이며, `tests/e2e/touch-targets.spec.ts`의 `assertBelowMinTouchTarget()`이 desktop이 44 미만임을 명시적으로 검증합니다. |
| `touch-targets.spec.ts`의 desktop assertion 완화·삭제 | 위 결정을 지키는 회귀 방지선입니다. |
| 1280px breakpoint 변경 | "1280에서 단일 패널" 주장은 sidebar 3상태 × 1280·1366 = 6/6 모두 3열로 재현되지 않았습니다. |
| **태블릿 768–1024px 빈 대화 구조 변경** | **디자인 결정 대기 중입니다**(§3-8). 결정 전에 구현하지 마십시오. |
| 점수 재산정 | 수정·검증 완료 후 별도 수행합니다. |
| golden 이미지 갱신 | 회귀를 숨깁니다. |
| 무관한 리팩터링·자동 포맷 | 범위 밖입니다. |
| Google 아이콘 로컬화 / sheet 제목 `break-keep` / composer `focus-within` / 320px sheet 안내 문구 축약 | 출시 후 후속 항목입니다. |

---

### 3-8. 사용자 결정 대기 항목 (구현 금지, 보고만)

**태블릿 768–1024px 빈 대화에서 3모델 중 1개만 노출**

`components/chat/DesktopChatShell.tsx:383`의 `{!isConversationEmpty && useTabsLayout && (탭 바)}` 조건 때문에, `useTabsLayout`이 true인 폭(모델당 폭 < `MIN_PANEL_WIDTH` 310px)에서 **빈 대화일 때만** 탭 바가 렌더되지 않습니다. 결과적으로 768·834·1024px에서 패널 폭이 `[N, 0, 0]`이 되고 나머지 두 모델에 도달할 수단이 없습니다. composer는 "3 개 모델"이라고 표시합니다.

선택지 ① 빈 대화에서도 탭 바 노출 ② 빈 상태에서 패널 영역 숨김 ③ 현 상태 명시적 risk accept

**디자인 승인 전까지 구현하지 말고, 작업 보고서에 현재 동작과 세 선택지를 그대로 제시하십시오.**

---

## 4. 구현 원칙

1. **증상이 아니라 원인을 고칩니다.** 특정 viewport 전용 하드코딩, 매직 넘버, `!important` 땜질을 쓰지 마십시오. 공통 token·primitive·실제 제품 컴포넌트에서 해결합니다.
2. **하나의 viewport만 통과시키는 수정 금지.** 320px를 고치다 1440px를 깨지 않는지 반드시 확인합니다.
3. **locale · theme · responsive · accessibility · 상태 변형을 함께 고려합니다.** ko/en, light/dark, 각 상태(empty·loading·streaming·success·partial failure·error·retry·insufficient credits)를 동시에 생각하십시오.
4. **현재 작업 트리의 사용자 변경을 보존합니다.** 시작 전 `git status`로 기존 변경을 확인하고 건드리지 마십시오.
5. **관련 없는 리팩터링·포맷 변경 금지.** diff를 작업 범위로 한정합니다.
6. **파일 경로와 컴포넌트 구조를 실제로 확인한 뒤 수정합니다.** 이 문서의 행 번호는 조정 시점 기준이므로 반드시 현재 파일에서 재확인하십시오.
7. **테스트 전용 가짜 UI로 결함을 우회하지 않습니다.** 테스트는 실제 제품 컴포넌트를 렌더링해야 합니다.
8. **보호해야 할 제품 정체성**: 최대 3모델이라는 통제된 비교 구조, 같은 질문을 같은 높이·구조로 보여주는 공정한 인상, 질문 → 3모델 답변 → AI Review 서사, AI Review의 차이·누락·검증 중심 메시지, 모델 선택 전 비용 노출, Guest가 로그인 없이 핵심 가치에 도달하는 흐름, 밝고 차분한 배경과 절제된 파랑, 균일한 radius와 안정적 패널 경계, 상태를 아이콘·문구·색으로 중복 표현하는 접근성, PC 3열 독립 스크롤과 공통 composer, selected/locked/available 구분.
9. **44px 확보나 badge 정리 때문에 UI가 성기고 둔해지지 않도록** 아이콘 크기는 유지하고 hit-area만 확장합니다.

---

## 5. 저장소 필수 invariant

아래 계약은 **release blocker**입니다. 완화·생략할 수 없습니다. 해당 영역을 건드리기 전에 지정된 문서를 먼저 읽으십시오.

### 5-1. Typography and font system invariant — **이번 작업과 직접 관련(P1-a, P2-a)**

선행 확인: `docs/ui-contracts/typography.md`

- 모든 `font-family`는 `--font-ui` 또는 `--font-code`를 통해 해석됩니다. 하드코딩 금지.
- **Locale families are selected by `:lang()` over the whole subtree, never by per-glyph fallback**: 기본 `Geist`, `:lang(ko)`는 `Noto Sans KR`, `:lang(zh)`는 `Noto Sans SC`. — **P2-a가 정면으로 관련됩니다.**
- Latin UI face만 preload. `Geist_Mono`·`Noto_Sans_KR`·`Noto_Sans_SC`는 `preload: false` 유지. 빌드 후 `node scripts/report-font-preload.mjs`로 확인.
- 웹폰트는 `next/font`로 self-host. 브라우저가 Google 서버를 요청해서는 안 됩니다.
- 고객 대상 텍스트는 11px 미만 금지. 본문·주요 컨트롤은 14px부터. 모바일 텍스트 입력은 16px 유지.
- `font-black`(900)은 18px 이상 헤드라인과 짧은 브랜드 표현에 한정. 작은 버튼·칩·배지·라벨은 500–700. — **P1-a에서 할인가를 fluid로 바꿀 때 최소 크기가 이 규칙과 충돌하지 않는지 확인하십시오.**
- Monospace는 코드·모델 ID·빌드 메타데이터·인증 코드·서식 보존 입력에만.
- 이메일은 `lib/emailTypography.ts`의 단일 web-safe stack 사용, 웹폰트 금지.
- **필수 회귀**: `tests/typographyPolicy.test.mjs`, `tests/e2e/font-system.spec.ts` 통과 + 모바일 composer 계약 spec 재실행.

### 5-2. Mobile chat composer invariant — **키보드 검증(§7-5) 수행 시 관련**

선행 확인: `docs/ui-contracts/mobile-chat-composer.md`

- 모바일 textarea는 항상 전용 전체 폭 행을 가지며 최소 한 줄이 온전히 보여야 합니다.
- 도구·웹검색·Deep Research·첨부·결제·모델 상태 컨트롤이 textarea의 가로 행을 잠식하거나 겹치거나 그 위에 떠서는 안 됩니다.
- `ChatMessageList` 높이 증가가 textarea를 잔여 가로 공간으로 축소시켜서는 안 됩니다.
- 컨트롤을 textarea 옆·위에 놓기 위해 absolute positioning, 음수 margin, transform, 공유 grid cell을 쓰지 마십시오.
- 모바일 composer 레이아웃을 변경하면 bounding-box, overlap, 가로 overflow, 한국어 IME, 320px 폭, 200% 텍스트 확대 회귀 커버리지를 포함해야 합니다.
- **필수 회귀**: `tests/e2e/mobile-composer-contract.spec.ts`

### 5-3. Comparison action rail invariant — **PC 3열 재검증(V-7) 시 관련**

선행 확인: `docs/ui-contracts/comparison-action-rail.md`

- 데스크톱과 모바일은 동일한 상태 기반 노출 정책을 사용합니다. 판단은 `lib/comparisonReadiness.ts`의 `shouldShowVisualStatus()`로 하며 `layout === "mobile"`이나 media query 같은 shell 형태 조건으로 하지 않습니다.
- 정상·전체 완료·실행 가능 상태에서 상태 문장("Comparing N completed answers")은 양쪽 shell에서 시각적으로 숨겨지며, 행 높이나 하단 여백을 남기지 않습니다.
- 시각적으로 숨김은 `sr-only`를 뜻합니다. 문장은 DOM과 접근성 트리에 남고, 각 액션은 자신의 `aria-describedby`에 비교 대상 개수를 유지합니다.
- 생성 중·답변 부족·제외됨·분석 실행 중·액션별 크레딧 부족 상태는 화면에 보여야 하며, 각 액션은 자신의 가격과 자신의 사유만 설명합니다.
- **필수 회귀**: `tests/comparisonReadiness.test.mjs`, `tests/e2e/comparison-action-rail.spec.ts`

---

## 6. 안전 및 권한 경계

- **로컬 구현과 검증은 수행합니다.**
- **사용자가 별도로 요청하지 않는 한 commit, push, PR 생성, 배포를 하지 마십시오.** 변경 사항은 작업 트리에 남기고 보고하십시오.
- 실제 결제, 외부 메시지 전송, 복구하기 어려운 데이터 변경 금지.
- **실제 provider를 사용하는 3모델 전송, 장시간 streaming, 실제 모델 비용이 발생하는 검사 금지.** (과거 감사에서 이 검사가 도구를 강제 종료시켰습니다.)
- 상태 검증은 Playwright route interception, deterministic fixture, mock API, 또는 저장소의 승인된 테스트 상태만 사용하십시오. 저장소에 `tests/e2e/support/chat-state-fixtures.ts`와 route mock 기반 상태 63종이 이미 있습니다.
- fixture가 존재한다는 사실만으로 통과 처리하지 말고 **실제로 렌더링하고 결과를 눈으로 확인**하십시오.
- 불안정한 검사는 안전한 대체 방법을 쓰고, 대체 불가능하면 **`NOT VERIFIED`로 기록**하십시오. 추정으로 채우지 마십시오.
- 기존 코드·문서·설정·snapshot 중 작업 범위 밖의 것을 수정하지 마십시오.

---

## 7. 작업 순서

### 7-1. 사전 확인과 기준선 기록

- `git status`로 기존 사용자 변경 확인 및 보존
- 현재 branch, local HEAD, `origin/develop` SHA 기록
- staging `/api/build-info`로 배포 SHA 확인 및 로컬과의 차이 기록
- `npm install` 후 `npm run build` 성공 확인

### 7-2. 계약·구현·테스트 확인

- `AGENTS.md` → `docs/ui-contracts/typography.md` (P1-a·P2-a 전 필수)
- `node_modules/next/dist/docs/` 중 layout·metadata·i18n 관련 가이드 (P2-a 전 필수)
- 대상 파일의 **현재** 구조와 행 번호 재확인:
  `components/marketing/PricingPageContent.tsx`, `components/analytics/AnalyticsProvider.tsx`, `app/layout.tsx`, `.github/workflows/nightly-visual-regression.yml`, `.github/workflows/pr-fast-gate.yml`
- 관련 기존 test 확인: `pricing-promotion-reflow.spec.ts`, `analytics-consent.spec.ts`, `analytics-consent-signin.spec.ts`, `analytics-settings-target.spec.ts`, `font-system.spec.ts`

### 7-3. 구현 순서 (의존성 반영)

1. **P1-a 요금 reflow** — 독립 수행 가능. 원인 A·B **둘 다** 처리
2. **P1-b 로그인 pill 재배치** — 독립 수행 가능
3. **P2-a SSR root lang** — 독립 수행 가능. typography 계약 확인 후
4. **P1-c workflow 등록** — 독립 수행 가능
5. **P1-d 비문서 PR gate green** — 1·2 완료 후에만 의미 있음

### 7-4. 항목별 단위·통합·E2E 검증

각 수정 직후 해당 spec을 먼저 돌리고, 마지막에 전체를 돌립니다.

```
npm run check:accent-tokens
npm test                                   # 단위·정책 테스트
npx playwright test --project=desktop-chromium --project=mobile-chromium \
  tests/e2e/pricing-promotion-reflow.spec.ts \
  tests/e2e/analytics-consent.spec.ts \
  tests/e2e/analytics-consent-signin.spec.ts \
  tests/e2e/analytics-settings-target.spec.ts \
  tests/e2e/font-system.spec.ts
npm run test:e2e:ui-risk                   # merge-blocking tier
npm run test:e2e:visual                    # golden 63장
```

**주의**: 이 컨테이너의 Chromium build가 저장소가 pin한 build와 다르면 golden이 글꼴 안티앨리어싱 차이로 대량 실패할 수 있습니다. 그 경우 **layout 이동이 있는지 diff 이미지를 직접 확인**하고, 픽셀 동등성은 `NOT VERIFIED`로 기록한 뒤 pinned build에서의 실행을 별도 요청하십시오. **golden을 갱신해 통과시키지 마십시오.**

### 7-5. 실제 렌더링과 시각 QA

- 수정한 화면을 실제로 렌더링해 스크린샷을 남깁니다(요금·로그인 필수).
- 각 스크린샷에 **viewport / locale / theme / zoom / SHA / 캡처 시각 / 관련 finding ID**를 기록합니다.
- 가능하면 수정 전후 동일 조건 비교를 만듭니다.
- 애니메이션·타임스탬프·동적 콘텐츠로 인한 노이즈를 실제 결함과 구분합니다.

### 7-6. 회귀 탐색

기존 항목 통과 확인에서 멈추지 말고 새로 생긴 문제를 찾습니다.

- 요금 글자 크기 축소가 가격 계층이나 promotion 인지성을 훼손하지 않았는지
- 설정 버튼 이동이 다른 route(landing·chat·pricing)의 배치나 safe area를 깨지 않았는지
- root `lang` 변경이 폰트 로딩·preload·metadata·SEO·hydration 경고에 영향을 주지 않았는지
- 200% 확대에서 고정 요소가 콘텐츠를 가리지 않는지
- 새 발견은 `UI-REG-P0-01` 형식으로 별도 기록

### 7-7. 완료 조건 대조

§3의 각 완료 조건을 **하나씩** `PASS / PARTIAL / FAIL / NOT VERIFIED`로 대조합니다.

### 7-8. 결과 보고

§10 형식으로 보고합니다.

---

## 8. 필수 검증 매트릭스

**전 조합을 기계적으로 곱하지 마십시오.** 아래는 각 결함의 실제 위험을 검증하는 조합입니다.

### 8-1. 전수 필수 (반드시 모든 조합)

| 대상 | 조합 | 측정 |
|---|---|---|
| **요금 reflow (P1-a)** | ko·en × layout viewport 160·195·213·260px × promotion 활성·비활성 = **16조합** | `scrollWidth - clientWidth ≤ 1`, offender 요소 기록 |
| **로그인 pill (P1-b)** | 320·360·390 × ko·en × consent `unset`·`accepted`·`declined` = **18조합** | 교차 면적 0px², 격자 hit-test(9×5) 탈취 0점, pill ≥44×44 |
| **SSR lang (P2-a)** | `/ko`, `/en`, `/auth/signin?lang=ko`, `/auth/signin?lang=en`, `/chat` = **5경로** | 첫 HTTP 응답의 `<html lang>` |
| **상태 golden (P1-c)** | 승인된 63장 전부 | 전수 green, retries 0 |

### 8-2. 대표 조합 (회귀 확인용)

| 대상 | 대표 조합 |
|---|---|
| 요금 시각 계층 | 1440×900 light·dark, 390×844 light — ko·en |
| 로그인 시각 | 320×568 · 1440×900 × ko·en × light·dark |
| 확대 reflow(요금 외) | 랜딩·chat·로그인 × 320·390·1440 × 100/125/150/200% |
| PC 3열 (V-7) | 1280×720, 1366×768, 1440×900, 1920×1080 |
| 태블릿 (보고만) | 768×1024, 1024×768 |
| 한국어 typography (V-2) | 320×568 · 390×844 · 1440×900 ko, 320×568 en |
| 보조 text floor (V-3) | 랜딩·chat·요금·로그인·모델 sheet·카탈로그 × 100/125/150/200% |
| contrast (V-4) | 오류·부분 실패·상태 chrome·sidebar·모델 패널 × light·dark |
| 상태 디자인 | empty·loading·streaming·success·partial failure·error·retry·insufficient credits·locked × PC/mobile × light/dark, 320px dark 포함 |
| 첨부·Deep Research·AI Review | 각 상태 golden 확인 |
| keyboard·focus | 모델 sheet focus trap·복귀, composer tab 순서, visible focus ring |
| virtual keyboard·safe area | 390×844(키보드 336px), 320×568(키보드 216px) — `visualViewport.height` 축소 fixture |

### 8-3. 측정 도구

- **bounding-box**: `getBoundingClientRect()`
- **hit-test**: `document.elementFromPoint()` — 중앙 + 4모서리(중심에서 ±21.5px), 겹침 검사는 격자 9×5
- **overlap**: 두 rect의 교차 면적(px²)
- **overflow**: `documentElement.scrollWidth - documentElement.clientWidth`, 자체 scroller 내부 요소는 제외
- **contrast**: 합성 픽셀 기준 WCAG 2.2 AA
- **터치 조건**: 모바일 측정은 반드시 `isMobile: true, hasTouch: true`. fine pointer로 측정하면 잘못된 결과가 나옵니다.
- **확대 모사**: layout viewport 직접 축소. mobile emulation과 병용 금지.

---

## 9. 완료 판정

- §3의 각 완료 조건을 `PASS / PARTIAL / FAIL / NOT VERIFIED`로 개별 판정합니다.
- **실제 렌더링 또는 테스트 실행 증거 없이 완료를 주장하지 마십시오.** "코드상 가능해 보임"과 "실제 렌더링 통과"는 다릅니다. class가 존재한다는 사실을 시각 통과 근거로 쓰지 마십시오.
- 다음 셋을 **분리해서** 보고하십시오.
  1. 코드 구현 완료 여부
  2. 로컬 테스트 통과 여부
  3. **스테이징 반영 여부** — 로컬만 완료된 것을 스테이징 완료로 표현하지 마십시오.
- **P1 또는 release blocker가 하나라도 남아 있으면 "완료" 또는 "Go-Live Ready"로 보고하지 마십시오.**
- 미검증 항목은 만점·통과로 계산하지 말고 `NOT VERIFIED`로 남기십시오.
- 태블릿 항목(§3-8)은 구현하지 않았음을 명시하고 결정 요청으로 보고하십시오.

---

## 10. 최종 산출물

작업 종료 시 다음을 한국어로 보고하십시오.

1. **변경 파일과 변경 이유** — 파일별로 무엇을 왜 바꿨는지
2. **실행한 테스트와 결과** — 명령, 통과/실패/생략 수, 실패가 있으면 실패 spec과 원인
3. **실제 렌더링 증거** — 스크린샷 경로 + viewport/locale/theme/zoom/SHA/캡처 시각/finding ID
4. **완료 조건별 판정표** — §3의 각 조건에 `PASS / PARTIAL / FAIL / NOT VERIFIED`
5. **남은 위험과 미검증 항목** — 특히 pinned browser golden 동등성, 실기기 keyboard/safe area
6. **새로 발견한 회귀** — `UI-REG-*` 형식. 없으면 "새로운 출시 차단 회귀 없음"이라고 명시
7. **태블릿 결정 요청** — 현재 동작 + 세 선택지
8. **배포가 필요한 경우 다음 단계** — 무엇을 누가 승인해야 스테이징에 반영되는지
9. **한 문장 최종 상태** — 경영진과 개발팀이 즉시 의사결정할 수 있는 형태

---

## 부록 — 빠른 재현 명령

```bash
# 배포 SHA
curl -sS https://staging.tomverse.app/api/build-info

# SSR 문서 언어 (hydration 이전)
curl -sS "https://staging.tomverse.app/auth/signin?lang=ko" | grep -o '<html[^>]*>'
curl -sS "https://staging.tomverse.app/ko" | grep -o '<html[^>]*>'

# 요금 reflow (merge-blocking)
npx playwright test --project=desktop-chromium --project=mobile-chromium \
  tests/e2e/pricing-promotion-reflow.spec.ts

# merge-blocking UI tier
npm run test:e2e:ui-risk

# 상태 golden 63장 (갱신 플래그 절대 금지)
npm run test:e2e:visual -- --retries=0

# accent 역할 token
npm run check:accent-tokens

# 폰트 preload 정책 (build 이후)
node scripts/report-font-preload.mjs
```

**모바일 터치 타깃 측정 시 필수 설정**

```js
// 올바름 — 실기기 조건 (44px 분기 활성)
browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true })

// 잘못됨 — fine pointer. desktop 크기(36/32px)가 나오며 결함으로 오인하게 됩니다.
browser.newContext({ viewport: { width: 320, height: 568 } })
```
