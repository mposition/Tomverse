# Tomverse Insight 홈페이지 콘텐츠 ↔ 실제 제품 기능 대조 감사

- 작성일: 2026-07-30
- 대상: 홈페이지(랜딩) `/` 및 `/[locale]` — `components/marketing/LandingPageContent.tsx`, `components/marketing/ProductProofSection.tsx`, `components/marketing/MarketingChrome.tsx`, `lib/seo.ts`, `app/opengraph-image.tsx`
- 기준 커밋: `b400a55` (branch `claude/tomverse-insight-homepage-audit-t00poa`)
- 성격: **조사·보고 전용.** 이번 단계에서는 제품 코드나 홈페이지 문구를 수정하지 않았습니다.

## 0. 검증 방법과 근거 등급

| 방법 | 수행 여부 | 비고 |
|---|---|---|
| 로컬 실행(dev server)에서 홈페이지 렌더 결과 확보 | 수행 | `next dev` (`E2E_AUTH_BYPASS=true`, `E2E_DISABLE_DATABASE=true`) 로 `/`, `/ko` HTML 전체 수집 후 가시 텍스트 추출 |
| 헤드리스 브라우저로 hero DOM·CTA·섹션 id 확인 | 수행 | Chromium(Playwright) 로 `landing-hero-title`, `landing-primary-cta`, `section[id]` 확인 |
| 데모 영상 자산 실측 | 수행 | `ffmpeg` 로 `Duration 00:00:21.88`, `1280x720`, `vp8` 확인. 포스터 PNG 육안 확인 |
| 로그인·크레딧·플랜 조건 확인 | 수행 | 서버 라우트·`lib/*` 게이팅 코드 직접 확인 |
| 실제 채팅 런타임 동작(게스트 대화 전송, AI Review 실행) | **미수행** | 로컬에 DB가 없어 `/chat`이 hydration 되지 않음. 해당 항목은 코드 + 기존 E2E 스펙을 근거로 판정하고 등급을 명시함 |
| 운영 DB의 실제 플랜/가격 값 | **미수행** | 접근 불가. `lib/billingConfig.ts` 의 `DEFAULT_PLANS` 기준으로만 판정 → 해당 항목은 `Unverified` 로 표기 |

근거 등급 표기: **확정**(코드/실행으로 직접 확인) / **추론**(코드 근거는 있으나 런타임 미확인) / **확인 불가**.

---

## 1. Executive Summary

### 전체 일치도

홈페이지가 말하는 정체성 — *"한 번 질문하고 여러 AI 답변을 비교한 뒤 AI Review로 차이와 누락을 찾는다"* — 은 실제 제품의 핵심 사용 목적과 **정확히 일치합니다.** 존재하지 않는 기능을 지어낸 문구도, 실제로 없는 모델 공급자를 나열한 문구도 없습니다. `AI Review compares only the supplied answers...` 같은 한계 고지가 히어로 바로 아래 섹션에 배치돼 있고, 30일 지표는 임계값·내림 처리까지 공개하는 등 **정직성 수준은 평균 이상**입니다.

문제는 "거짓"이 아니라 **조건 누락과 정보 구조 붕괴**입니다. 두 축으로 정리됩니다.

1. **홈페이지는 "무가입"과 "AI Review"를 같은 화면에서 나란히 약속하지만, AI Review는 로그인 전용이고 Free 플랜 월 3회 제한 + 약 8크레딧짜리 기능입니다.** 홈페이지 어디에도 이 조건이 없습니다.
2. **홈페이지 코드에는 파일·프로젝트·공유·잠금·모델 카탈로그·상태 페이지·모델 추천을 설명하는 7개 로케일 완역 문구가 존재하지만, 렌더 함수가 그 문구를 단 한 줄도 출력하지 않습니다.** 즉 홈페이지는 지금 "비교 + AI Review" 외에는 아무 기능도 소개하지 않는 상태입니다.

### 가장 심각한 문제 5개

| # | 문제 | 심각도 |
|---|---|---|
| F-01 | 무가입 히어로와 AI Review 약속이 붙어 있는데, AI Review는 로그인 전용·Free 월 3회·약 8크레딧 (조건 표기 0건) | P1 |
| F-02 | "How it works" 3단계가 제품의 표준 흐름으로 제시되지만, 1단계의 "파일 첨부"와 3단계의 "AI Review"가 모두 게스트에게 잠겨 있음 | P1 |
| F-03 | 홈페이지 copy 객체의 약 40%(steps / supportItems / trustItems / modelCatalogue / status / safetyCta / modelFinder)가 렌더되지 않는 죽은 문구 | P1 |
| F-04 | Deep Research·Web Search·항목별 웹 검증이 홈페이지에 **전혀** 등장하지 않음 (Insight의 "근거·최신성" 축이 통째로 비어 있음) | P1 |
| F-05 | 제품 워크스루 영상/포스터가 현행 UI가 아님: `4 credits used`(현재 셀프 가격 8), `Review confidence: medium`(현재 명칭 `Source grounding`). 영상은 "Real product UI" 로 명시 표기 | P2 |

### 가장 중요한 누락 기능 5개

| # | 기능 | 실제 상태 | 왜 중요한가 |
|---|---|---|---|
| M-01 | Deep Research (Perplexity Sonar Deep Research) | Gated (Pro 이상, 30크레딧) | Pro 업그레이드의 가장 강한 이유인데 홈페이지에 없음 |
| M-02 | Web Search (모델 네이티브 검색, off/auto/always) | Gated (모델별 지원, always 시 +8크레딧) | "최신성" 우려를 해소하는 유일한 기능 |
| M-03 | Quick difference summary (빠른 차이 요약, 1크레딧 / 게스트 1일 1회) | Available | **게스트가 실제로 쓸 수 있는 유일한 비교 분석 기능**인데 홈페이지가 대신 잠긴 AI Review를 홍보함 |
| M-04 | Source grounding (인용 일치율 %, 인용문 검증) | Available (로그인, AI Review 내) | "Insight" 이름값을 만드는 근거 지표. 경쟁 서비스 대비 가장 차별적 |
| M-05 | 항목별 "웹 검색으로 확인" 검증 | Gated (로그인, 별도 과금) | 홈페이지는 오히려 "웹 검색을 하지 않는다"고만 적어 반대로 읽힘 |

### 현재 홈페이지가 가장 잘 설명하는 부분

- **핵심 가치 명제**: `Ask once. / Compare multiple AI answers.` 는 5초 내 이해 가능하고 실제 제품과 일치합니다.
- **한계 고지의 정직성**: `reviewBoundary` (AI Review는 웹 검색·사실 판정·승자 선정을 하지 않음), `videoDisclosure` (데모 데이터, 공급자 보증 아님), `metricDisclosure` (임계값 초과분만, 10단위 내림) 모두 구현과 일치합니다. 특히 지표는 `PUBLIC_COUNT_THRESHOLD = 20`, `Math.floor(count/10)*10` 로 문구 그대로 구현돼 있습니다.
- **모델 공급자 목록**: FAQ가 나열한 10개 공급자는 모두 `lib/models.ts` 에 실재합니다.
- **로케일 지원 등급 고지**: `LocaleSupportNotice` 가 zh/fr/de/es/pt 방문자에게 "제한 지원 / 미리보기" 를 상단 배너로 알립니다. 이건 매우 잘 된 부분입니다.

### 방문자가 형성할 가능성이 높은 잘못된 기대

1. "가입 없이 3개 모델을 비교하고 **AI Review까지** 써볼 수 있다" → AI Review 버튼은 게스트에게 자물쇠 상태입니다.
2. "가입 없이 PDF를 올려 분석시킬 수 있다" → 첨부는 로그인 전용입니다 (`canAttach={!isGuestMode}`).
3. "무료로 계속 쓸 수 있다" → 게스트는 **일 20크레딧 / 월 100크레딧**. 3모델 비교 1회 = 최소 3크레딧이므로 하루 약 6질문입니다.
4. "AI Review는 무료 기능이다" → Free 플랜 **월 3회**, 회당 약 8크레딧.
5. "Insight는 출처/최신성까지 확인해준다" → Deep Research·Web Search가 홈페이지에 없어 이 기대는 아예 형성되지 않고, 대신 `웹 검색을 하지 않습니다` 문구만 남아 **역방향 오해**(못 한다)를 만듭니다.

### 콘텐츠 개편의 가장 중요한 방향

> **"무가입으로 할 수 있는 것"과 "계정/플랜이 필요한 것"을 홈페이지가 스스로 구분해서 말하게 만드는 것.**

지금 홈페이지는 제품의 최고 기능들(AI Review, Deep Research, 파일 분석)을 무가입 약속과 같은 화면에 섞어 놓고 조건을 아무 데도 적지 않았습니다. 개편 방향은 기능을 빼는 것이 아니라, ① 게스트 체험 경로를 정확히 서술하고(3모델 비교 + Quick difference summary), ② 계정/플랜이 여는 것을 별도 섹션으로 세우고(AI Review·파일·프로젝트·공유), ③ Deep Research/Web Search/Source grounding을 "Insight" 이름값에 맞는 근거 축으로 신설하는 것입니다. 죽은 copy(F-03)에 이미 ②의 원문이 7개 로케일로 준비돼 있으므로 ②는 신규 카피 작성이 아니라 **복구 작업**에 가깝습니다.

---

## 2. 홈페이지 주장 대 실제 기능 매트릭스

일치 여부 표기: ✅ 일치 / ⚠️ 조건부·부분 일치 / ❌ 불일치

| ID | 홈페이지 위치 | 현재 문구/주장 | 실제 기능 상태 | 일치 여부 | 제약 조건 | 문제 유형 | 심각도 | 근거 |
|---|---|---|---|---|---|---|---|---|
| C-01 | 히어로 badge | `Tomverse Insight · Multi-AI Comparison & Review` | Available | ✅ | — | — | — | 확정. 제품 정체성과 일치 |
| C-02 | 히어로 brandNote | `Tomverse Insight is the multi-AI comparison and review experience from Tomverse.` | Available | ✅ | — | — | — | 확정 |
| C-03 | 히어로 h1 | `Ask once.\nCompare multiple AI answers.` | Available | ✅ | 게스트 일 20크레딧 | Missing constraint | P2 | `lib/chatSecurity.ts:313-320` |
| C-04 | 히어로 서브헤드 | `Compare GPT, Claude, and Gemini side by side, then use AI Review to find differences and missing points.` | 비교=Available / **AI Review=Gated** | ⚠️ | AI Review 로그인 필수 · Free 월 3회 · 약 8크레딧 | Missing constraint / Journey gap | **P1** | `ComparisonActionRail.tsx:386-400`, `comparison-reviews/route.ts:262-265`, `comparisonReviewQuota.ts:11-14`, `ComparisonActionRail.tsx:41` |
| C-05 | 히어로 note | `No sign-up required—start with three models.` | Available | ✅ | Turnstile 인증 필요 · 일 20크레딧 | Missing constraint | P2 | `lib/appDefaults.ts:20,66-70`, `lib/turnstile.ts`, `tests/e2e/guest-turnstile-verification.spec.ts` |
| C-06 | 히어로 guestNote | `No sign-up required—compare GPT, Claude, and Gemini side by side.` | Available | ✅ | 실제 모델은 `gpt-5-4-mini` / `claude-haiku-4-5` / `gemini-2-5-flash`(표시명 Gemini 3.1 Flash-Lite) — 각 브랜드의 경량 모델 | Ambiguous copy | P3 | `lib/appDefaults.ts:20`, `lib/models.ts:172` |
| C-07 | 히어로 프리뷰 카드 | `GPT / Claude / Gemini` 3패널 + `Tomverse AI Review` 패널(`Common ground / Contradiction / Missing point / Verify next`) | 3패널 Available / AI Review 패널 **Gated** | ⚠️ | 상동 | Journey gap | **P1** | 렌더 HTML 확정 + `ComparisonActionRail.tsx:386` |
| C-08 | 히어로 CTA | `Start chatting free` → `/chat?lang=en&entry=guest-preview` | Available | ✅ | — | — | — | 확정(Chromium `href` 실측) |
| C-09 | How it works 제목 | `See the full workflow—not another feature list.` | — | ⚠️ | 실제로는 3단계만 소개하며 제품 기능의 다수가 미언급 | Overclaim | P3 | 렌더 HTML 확정 |
| C-10 | How it works 설명 | `...one controlled task through the real Tomverse interface... uses demo data rather than customer content.` | — | ⚠️ | 영상이 현행 UI와 불일치(C-14) | Outdated content | P2 | 포스터 실측 |
| C-11 | 영상 제목/라벨 | `From one question to a clearer review in about 20 seconds`, `20–25 sec` | — | ✅ | — | — | — | 확정: `Duration 00:00:21.88` (ffmpeg) |
| C-12 | 영상 본문 | `...see AI Review group their common ground, contradictions, missing points, and verification needs before a follow-up or share action.` | Gated | ⚠️ | AI Review·공유 모두 로그인 전용 | Missing constraint | P2 | `share/route.ts` (`getServerSession` + `allowSharing`) |
| C-13 | 영상 고지 | `Real product UI · controlled demo data · no customer content · no provider endorsement` | — | ⚠️ | "Real product UI" 이나 현행 UI 아님 | Outdated content | P2 | 아래 C-14 |
| C-14 | 영상 포스터 | 포스터 내 `4 credits used`, `Review confidence: medium` | 현재 셀프 가격 `AI_REVIEW_CREDITS = 8`(이중 리뷰어), 현재 명칭 `Source grounding` | ❌ | — | Outdated content / Terminology mismatch | **P2** | 자산 커밋 `8491c47`(2026-07-27) < 가격 정정 커밋 `440e65a`(2026-07-29, "stop understating cross-review cost"). 명칭은 `lib/sourceGrounding.ts` 주석 + `locales/en.ts:359-369` |
| C-15 | 단계 1 | `Choose up to three models and send one prompt or supported file.` | 모델 선택 Available / **파일 첨부 Gated(로그인)** | ❌ | 게스트 첨부 불가 | False claim (게스트 경로) | **P1** | `DesktopChatShell.tsx:733`, `MobileChatShell.tsx:829` (`canAttach={!isGuestMode}`), `locales/en.ts` `loginToAttach` |
| C-16 | 단계 2 | `Read different strengths side by side without copying between tabs.` | Available | ✅ | — | — | — | 확정 |
| C-17 | 단계 3 | `Run AI Review — Structure agreements, conflicts, omissions, and what to verify next.` | Gated | ❌ | 로그인 필수 · Free 월 3회 · 약 8크레딧 | Missing constraint | **P1** | C-04과 동일 |
| C-18 | 30일 지표 | `consented multi-model comparisons` / `consented file workflows` / `Only privacy-safe counts above the public threshold are shown, rounded down to the nearest ten.` | Available | ✅ | 임계값 20, 미만이면 미표시 | — | — | 확정: `app/api/public/proof-metrics/route.ts:6,12` |
| C-19 | 사례 1 | `Cross-review a decision` / `Outcome: agreements, conflicts, missing risks, and verification tasks in one view.` | Gated | ⚠️ | 로그인 필수 | Missing constraint | P2 | C-04 |
| C-20 | 사례 2 | `Turn an 18-page readiness brief into a source-linked checklist.` / `Outcome: decisions, owners, dates, and unresolved items separated for review.` | Partial | ⚠️ | 첨부는 로그인 전용. "source-linked"에 해당하는 제품 기능 없음(PDF 추출 시 `[Page N]` 마커만 삽입되며 모델 답변에 링크가 보장되지 않음). "decisions/owners/dates 분리"는 프롬프트 결과이지 기능이 아님 | Overclaim / Ambiguous copy | **P2** | `lib/mediaSecurity.ts:187` |
| C-21 | 사례 3 | `Review code or a plan` / `Outcome: an implementation plan that still makes clear what must be tested.` | Available(일반 채팅 결과) | ⚠️ | 제품 기능이 아니라 사용 예시 | Ambiguous copy | P3 | — |
| C-22 | 경계 고지 | `AI Review compares only the supplied answers. It does not browse the web, prove facts, or declare a correct winner.` | 생성 단계 기준 정확 / **항목별 웹 검증 기능은 존재** | ⚠️ | 검증은 opt-in·별도 과금 | Understatement | **P2** | `comparison-reviews/verify-item/route.ts:44-51`, `locales/en.ts:377` (`Check with web search`) |
| C-23 | 가격 제목 | `Start free. Upgrade when the work grows.` | Available | ✅ | — | — | — | — |
| C-24 | 가격 설명 | `The homepage shows only the essentials. Model weights, credit examples, annual billing, add-on credits, and Fair Use details are explained on the pricing page.` | Available | ✅ | 언급된 4개 항목 모두 `/pricing` 및 약관에 실재 | — | — | `lib/creditPacks.ts`, `lib/billingConfig.ts`(annual), `marketingInfoContent.ts` (Fair use) |
| C-25 | Free 카드 | `$0` + `300 monthly AI credits for light everyday use and trying advanced models.` | Unverified | ⚠️ | 가격은 API 실시간, 크레딧 수치는 **하드코딩**. 일 30크레딧 가드레일 미표기 | Missing constraint / Evidence gap | P2 | `LandingPageContent.tsx:101,565`, `lib/billingConfig.ts:63-64` |
| C-26 | Pro 카드 | `$15` + `3,000 monthly AI credits for regular multi-model comparison.` | Unverified | ⚠️ | 일 300크레딧 가드레일 미표기 | Missing constraint | P3 | `lib/billingConfig.ts:80-81` |
| C-27 | Max 카드 | `$25` + `10,000 monthly AI credits for advanced models and long documents.` | Unverified | ⚠️ | `dailyMessageLimit: 0`(일일 제한 없음)이 오히려 강점인데 미표기 | Understatement | P3 | `lib/billingConfig.ts:100-101` |
| C-28 | FAQ 1 | `Yes. Without signing in, you can already compare 3 AI models side by side... A Free account unlocks a broader model catalogue, higher usage limits, saved conversations, and other signed-in workflows within the plan limits.` | Available | ✅ | 4가지 항목 모두 실제와 일치 | — | — | 확정: 게스트 카탈로그는 Guest·Standard 한정(`appDefaults.ts:33-40`), 한도 20/100 → 30/300 |
| C-29 | FAQ 2 | 공급자 10개 나열 + `the live status page is the source of current service state` | Available | ✅ | 실제로는 `zhipu` 포함 11개 공급자. `등의/such as` 표현이므로 허위 아님 | Understatement | P3 | `lib/models.ts` |
| C-30 | FAQ 3 | `Tomverse applies attachment limits, locked-chat controls, and read-only share snapshots.` | 3개 모두 실재하나 **모두 로그인 전용** | ⚠️ | 무가입 방문자에게는 해당 없음 | Missing constraint | P3 | `lib/conversationLock.ts`, `share/route.ts` |
| C-31 | 최종 CTA | `One clearer view starts with one question.` / `Compare several AI answers, then use AI Review to decide what deserves a closer look.` | ⚠️ | C-04과 동일 | Missing constraint | P2 | C-04 |
| C-32 | 헤더 nav | `Features / Models / Pricing / FAQ` | 4개 목적지 모두 실재 | ⚠️ | `/ko` 에서도 href가 `/#how-it-works`, `/models` 등 비로케일 경로 → 한국어 방문자가 영어 canonical URL로 이탈 | Localization mismatch / CTA mismatch | P2 | `MarketingChrome.tsx:65-68, 291` (푸터 resourceLinks는 `localizedPath` 사용: `:457`) |
| C-33 | 푸터 | `Terms / Refund / Privacy / Support / Status` + 4개 리소스 링크 | 전부 실재 | ✅ | — | — | — | 라우트 목록 확정 |
| C-34 | SEO title | `Compare AI Answers and Cross-Review What They Missed` | ✅ | — | — | — | 확정(렌더 `<title>`) |
| C-35 | SEO description | `Ask multiple AI models once, compare their answers, and use AI Review to organize agreements, contradictions, omissions, and verification needs.` | ⚠️ | AI Review 조건 미표기(검색 스니펫 특성상 허용 범위) | Missing constraint | P3 | `lib/seo.ts:139-178` |
| C-36 | OG title/description | `Tomverse Insight by Tomverse \| Multi-AI Comparison & Review` / `Compare GPT, Claude, and Gemini side by side, then use AI Review to identify differences, omissions, and points that need verification.` | ✅ | — | — | — | 확정 |
| C-37 | OG 이미지 | `Tomverse Insight · Multi-AI Comparison & Review` / `Compare GPT, Claude, and Gemini side by side, then use AI Review to catch what's missing` | ✅ | — | — | — | `app/opengraph-image.tsx:52-56` |
| C-38 | OG locale | 영어 루트가 `en_AU` 선언 | ⚠️ | 운영 주체가 호주 기준일 수 있으나 문서화된 근거 없음 | Evidence gap | P3 | `lib/seo.ts` `openGraphLocaleByLanguage` |

---

## 3. 누락 기능 매트릭스

| 기능 | 실제 상태 | 사용자 가치 | 현재 홈페이지 노출 | 누락 영향 | 권장 노출 위치 | 우선순위 | 근거 |
|---|---|---|---|---|---|---|---|
| **Deep Research** (Perplexity Sonar Deep Research, standard/deep 심도 선택, 장시간 비동기 잡) | Gated — Pro 이상, 30크레딧, 명시적 확인 필요 | "여러 출처를 훑는 리서치"라는 Insight의 핵심 축. Pro 전환의 최대 근거 | **없음** | 유료 전환 동기 상실. Pro 페이지에 도달해야만 존재를 앎 | 신설 "근거·리서치" 섹션 + 가격 섹션 Pro 카드 | **P1** | `lib/models.ts:203`, `lib/models.ts:50`, `ChatInput.tsx:2685-2710`, `DeepResearchSetupSheet.tsx`, `tests/e2e/chat-tools.spec.ts:165,182` |
| **Web Search** (off / auto / always, 공급자 네이티브 검색 + 인용) | Gated — 모델별 지원(`native`/`search-model`/`unsupported`), `always` 시 모델당 +8크레딧, 미실행 시 환불 | "AI가 최신 정보를 모른다"는 최대 반론을 정면으로 해소 | **없음** | 최신성 우려 미해소. 오히려 C-22가 반대 인상을 줌 | "근거·리서치" 섹션 | **P1** | `lib/webSearchCapability.ts`, `lib/webSearchCredits.ts`, `lib/models.ts:57`, `tests/e2e/native-web-search.spec.ts`, `tests/e2e/web-search-composer-state.spec.ts` |
| **Quick difference summary** (빠른 차이 요약) | Available — 로그인 1크레딧 / **게스트 1일 1회 무료** | 무가입 방문자가 "AI가 답변을 비교해준다"를 실제로 체험할 수 있는 유일한 경로 | **없음** | 게스트 경로의 유일한 분석 기능을 홍보하지 않고, 대신 잠긴 AI Review를 홍보 중 | 히어로 하단 "지금 바로 해볼 수 있는 것" | **P1** | `ComparisonActionRail.tsx:28,356`, `app/api/chat/compare-summary/route.ts:115-117,168`, `lib/chatSecurity.ts:543-565` |
| **Source grounding** (인용 일치율 %, `x/y quotes matched`, 인용문 개별 검증 뱃지) | Available — 로그인, AI Review/요약 내 | 다른 AI 채팅에는 없는 "이 리뷰의 인용이 원문과 몇 % 일치하는가" 지표. 제품명 Insight의 실체 | **없음** | 최대 차별점이 홈페이지에서 완전 소실 | 신설 "근거" 섹션 + AI Review 설명 안 | **P1** | `lib/sourceGrounding.ts`, `components/chat/SourceGroundingBadge.tsx`, `locales/en.ts:359-369`, `ComparisonReviewDialog.tsx:655` |
| **이중 리뷰어 교차검토** (서로 다른 공급자 2개가 독립 리뷰 후 일치/불일치 표시) | Available — 로그인, 가용 시 자동, 비용 2배 | "AI가 AI를 검토"의 신뢰도를 한 단계 올리는 구조. 경쟁 서비스 대비 명확한 차별 | **없음** | AI Review가 단순 요약처럼 보임 | AI Review 설명 안 | P2 | `comparison-reviews/route.ts:200-221`, `locales/en.ts:371-375` |
| **항목별 "웹 검색으로 확인"** | Gated — 로그인, `perplexity/sonar` 별도 과금 | AI Review가 표시한 "검증 필요" 항목을 한 번에 웹으로 확인 | **없음** (반대로 "웹 검색 안 함"만 표기) | 이름값(Insight = 근거)이 약해짐 | AI Review 설명 안 + C-22 문구 보정 | **P2** | `comparison-reviews/verify-item/route.ts:44-51` |
| **파일 첨부·분석** (이미지/PDF/Office/텍스트, 최대 5개, Google Drive 연동) | Gated — 로그인 | "18페이지 PDF" 사례의 실제 기반 | 사례 카드 안에서만 암시. 기능 소개 섹션 없음 (죽은 copy에 원문 존재) | 사례를 읽고도 무엇이 필요한지 모름 | "계정이 여는 것" 섹션 | **P1** | `ChatInput.tsx:105,176-184`, `DesktopChatShell.tsx:733` |
| **프로젝트 정리 / 대화 저장 / 대화 검색** | Gated — 로그인 | 비교를 1회성이 아니라 자산으로 만듦 | **없음** (죽은 copy에 원문 존재) | "탭 오가지 않아도 된다"의 후반부가 증발 | "계정이 여는 것" 섹션 | P2 | `app/api/projects/route.ts`, `app/api/conversations/search/route.ts`, `ChatSidebar.tsx:47,110-118` |
| **읽기 전용 공유 / .txt 다운로드 / 전체 내보내기** | Gated — 로그인, `allowSharing`·`allowDownloads`, 공유 링크 기본 30일 TTL | 결과를 팀에 전달하는 마지막 단계 | **없음** (죽은 copy + 영상 문구에서만 "share" 언급) | 워크플로가 "결과를 봤다"에서 끝남 | "계정이 여는 것" 섹션 | P2 | `share/route.ts:29-33`, `export/route.ts`, `conversations/export-all/route.ts` |
| **대화 잠금(locked chat)** | Gated — 로그인 | 민감 대화 보호. FAQ 3에서 단어만 등장 | FAQ 안 1개 단어 | 신뢰 요소가 약하게만 전달 | 신뢰 섹션 | P3 | `lib/conversationLock.ts` |
| **Model Finder** (작업/우선순위 2문항 → 모델 조합 추천, 작성 중 문맥 기반 추천 포함) | Gated — 로그인 | "어떤 AI를 골라야 하나" 진입 장벽 해소 | **없음** (죽은 copy에 원문 존재) | 모델 선택 부담이 그대로 남음 | 히어로 보조 링크 | P2 | `app/api/user/model-finder/route.ts`, `lib/modelFinder.ts`, `ChatInput.tsx:1079,2002-2047`, `tests/e2e/model-finder.spec.ts` |
| **모델 패널 일시정지(타깃 후속 질문)** | Available | 비교 결과를 잃지 않고 한 모델만 이어서 파고들기 | **없음** (죽은 copy에 원문 존재) | 비교 이후 흐름이 안 보임 | "비교 이후" 섹션 | P2 | `locales/en.ts:269,280-281`, `lib/comparisonReadiness.ts:33-35` |
| **게스트 대화 가져오기** (가입 시 게스트 대화 계정으로 이관) | Available | "체험한 게 사라지지 않는다"는 가입 장벽 제거 | **없음** | 가입 전환 손실 | 가입 CTA 근처 | P2 | `app/api/conversations/import-guest/route.ts`, `components/chat/GuestImportModal.tsx` |
| **실시간 서비스 상태 페이지 / 공급자 장애 배너** | Available (공개) | 신뢰 요소. FAQ에서 언급되나 링크는 푸터에만 | 푸터 링크만 (죽은 copy에 `Live service status` 원문 존재) | 신뢰 신호 저평가 | 신뢰 섹션 | P3 | `app/(site)/(application)/status`, `components/chat/ProviderStatusBanner.tsx`, `tests/e2e/status-page.spec.ts` |
| **전체 모델 카탈로그 페이지** | Available (공개, `/models`) | "어떤 모델이 있나"는 최다 질문 | 헤더 nav 한 줄 (죽은 copy에 `Explore all models` 원문 존재) | 카탈로그의 폭이 전달 안 됨 | 모델 스트립 + 링크 | P2 | `app/(site)/(marketing)/models/page.tsx`, `components/marketing/ModelsPageContent.tsx` |
| **추가 크레딧 팩** (500 / 1,500 / 4,000, 유효기간 365일) | Gated — 결제 | 한도 초과 시 이탈 대신 구매 경로 제공 | 가격 설명 안에서 "add-on credits" 한 단어 | 크레딧 소진 시 막다른 길처럼 보임 | 가격 섹션 각주 | P3 | `lib/creditPacks.ts:24-70` |

> 제외한 것: 관리자 콘솔(`app/api/admin/**`), 운영 모니터링, 감사 무결성, 공급자 잔액 동기화 등 **Internal** 기능은 일반 사용자 가치가 없어 누락 매트릭스에 포함하지 않았습니다.

---

## 4. 상세 발견 사항

### [P1][Missing constraint] 무가입 약속과 AI Review 약속이 같은 화면에서 조건 없이 병치됨

- **홈페이지 위치**: 히어로 서브헤드(`LandingPageContent.tsx:62-63`, ko `:125`), 히어로 프리뷰 카드(`:542-551`), 최종 CTA(`:114`, ko `:173`)
- **현재 문구**:
  - `Compare GPT, Claude, and Gemini side by side,\nthen use AI Review to find differences and missing points.`
  - ko: `GPT, Claude, Gemini의 답변을 한 화면에서 비교하고,\nAI Review로 차이와 놓친 부분을 확인하세요.`
  - 바로 위: `No sign-up required—start with three models.` / `회원가입 없이 3개 모델로 바로 시작할 수 있습니다.`
  - 프리뷰 카드에는 `Tomverse AI Review` 패널과 `Common ground / Contradiction / Missing point / Verify next` 칩이 그려짐
- **실제 제품 동작**:
  1. 게스트에게 AI Review 버튼은 렌더되지 않고, 자물쇠 아이콘 + `Log in to use AI cross-review` 버튼으로 치환됩니다.
  2. 로그인해도 `POST /api/conversations/{id}/comparison-reviews` 는 세션이 없으면 401 `AUTH_REQUIRED` 입니다.
  3. Free 플랜은 **월 3회** 제한(`COMPARISON_REVIEW_FREE_PER_MONTH`, 기본 3)이며 초과 시 429 `COMPARISON_REVIEW_MONTHLY_LIMIT`.
  4. 셀프 가격은 **약 8크레딧**(독립 리뷰어 2개 실행). Free 월 300크레딧 중 회당 8.
  5. 저장된 대화가 있어야 하고, 완료 답변이 2개 이상이어야 합니다.
- **문제**: 홈페이지에서 AI Review 조건을 알리는 문구가 **0건**입니다. 무가입 문구가 바로 위에 있고, 프리뷰 목업이 AI Review 결과를 시각적으로 보여주므로, 방문자가 "가입 없이 AI Review까지 된다"고 읽는 것이 가장 자연스러운 해석입니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: CTA를 눌러 들어간 게스트가 3개 답변을 받은 직후 마주하는 것은 잠긴 버튼입니다. 홈페이지가 약속한 가치의 후반부가 첫 세션에서 실행 불가입니다. 가입 후에도 Free 사용자는 월 3회에서 막힙니다.
- **근거**:
  - `components/chat/ComparisonActionRail.tsx:386-400` — `isGuestMode ? <button data-testid="ai-review-guest-locked" ...>` (확정)
  - `components/chat/ComparisonActionRail.tsx:41` — `export const AI_REVIEW_CREDITS = 8;` 및 그 위 주석("rail advertised 4 while 8 was charged") (확정)
  - `app/api/conversations/[conversationId]/comparison-reviews/route.ts:262-265` — `if (!session?.user?.id) return jsonError("Authentication required.", "AUTH_REQUIRED", 401)` (확정)
  - `.../route.ts:341-344` — `if (billingPlan.tier === "Free") freeQuota = await reserveFreeComparisonReview(...)` (확정)
  - `lib/comparisonReviewQuota.ts:11-14, 35-40` — 기본 3회/월, 초과 시 429 (확정)
  - **테스트**: `tests/e2e/comparison-action-rail.spec.ts:247`, `:737-747` — 게스트에게 `ai-review-guest-locked` 가시 (확정)
- **권장 조치**: 히어로 서브헤드에서 AI Review 언급을 유지하되, ① 게스트가 지금 할 수 있는 것(3모델 비교 + Quick difference summary)과 ② 계정이 필요한 것(AI Review)을 문장 단위로 분리. 프리뷰 카드의 AI Review 패널에는 계정 필요 라벨을 붙일 것.
- **제안 문구** (en / ko, 현행 톤 유지, 새로운 수치·품질 주장 없음):
  - en 히어로 note: `No sign-up required—compare three models and get a quick difference summary. AI Review needs a free account.`
  - ko 히어로 note: `회원가입 없이 3개 모델 비교와 빠른 차이 요약까지 이용할 수 있습니다. AI Review는 무료 계정이 필요합니다.`
  - en 프리뷰 카드 AI Review 배지: `Account required`
  - ko 프리뷰 카드 AI Review 배지: `계정 필요`
- **확신 수준**: High

---

### [P1][False claim] "How it works" 3단계가 게스트 경로에서 성립하지 않음

- **홈페이지 위치**: `components/marketing/ProductProofSection.tsx:52-56` (ko `:83-87`)
- **현재 문구**:
  - `1. Ask once — Choose up to three models and send one prompt or supported file.` / ko `1. 한 번 질문 — 최대 3개 모델을 선택하고 질문 또는 지원되는 파일을 보냅니다.`
  - `3. Run AI Review — Structure agreements, conflicts, omissions, and what to verify next.` / ko `3. AI Review — 합의, 충돌, 누락과 다음 검증 항목을 구조화합니다.`
- **실제 제품 동작**: 게스트 모드에서 첨부 버튼은 비활성이며 드롭 영역 문구가 `Log in to attach` 로 바뀝니다. Google Drive 첨부도 동일 조건입니다. 3단계 AI Review도 위 발견 사항대로 잠겨 있습니다.
- **문제**: 이 섹션은 "제품의 전체 작업 흐름"을 표방하고(`See the full workflow—not another feature list.`) 히어로의 무가입 약속 바로 아래에 옵니다. 3단계 중 2단계가 로그인 전용인데 그 사실이 섹션 전체에 한 번도 나오지 않습니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: PDF 분석을 목적으로 방문한 사용자가 무가입으로 들어가 첨부를 시도했다가 차단됩니다. 이 사용자는 홈페이지가 약속한 3단계 중 1단계에서 막힙니다.
- **근거**:
  - `components/chat/DesktopChatShell.tsx:733`, `components/chat/MobileChatShell.tsx:829` — `canAttach={!isGuestMode}` (확정)
  - `components/chat/ChatInput.tsx:1927` — `{canAttach ? t("chat.dropFilesHere") : t("chat.loginToAttach")}` (확정)
  - `components/chat/ChatInput.tsx:2631, 2648` — 첨부/Drive 버튼 `disabled={!canAttach || ...}` (확정)
  - `locales/en.ts:413` — `guestLimitReachedBody: "Log in to continue with saved chats, sharing, downloads, and attachments."` (확정)
- **권장 조치**: 3단계 각각에 조건 라벨을 추가하거나, 단계 목록 하단에 한 줄 조건 문구를 배치.
- **제안 문구**:
  - en 단계 하단: `Steps 1–2 work without an account. File attachments and AI Review need a free account; AI Review uses credits.`
  - ko 단계 하단: `1~2단계는 계정 없이 이용할 수 있습니다. 파일 첨부와 AI Review는 무료 계정이 필요하며, AI Review는 크레딧을 사용합니다.`
- **확신 수준**: High

---

### [P1][Missing feature] 홈페이지 copy의 상당 부분이 렌더되지 않는 죽은 문구

- **홈페이지 위치**: `components/marketing/LandingPageContent.tsx` 전역
- **현재 문구**: `LandingCopy` 타입에 정의되고 7개 로케일 전부 번역돼 있으나 `LandingPageContent()` (`:468-583`) 가 **한 번도 참조하지 않는** 키:

  | 키 | 영어 원문(요지) | 대응 실제 기능 | 상태 |
  |---|---|---|---|
  | `steps` (`:71`) | `Choose up to three models / Ask once or attach a file / Compare, review, follow up, or share` | 비교·첨부·후속·공유 | Available/Gated |
  | `supportItems` (`:83-88`) | `Files and real context` / `Targeted follow-up` / `Projects and records` / `Share the outcome` | 첨부·패널 일시정지·프로젝트·공유 | 전부 실재 |
  | `trustItems` (`:92-95`) | `Locked conversations` / `Read-only sharing` | 대화 잠금·공유 스냅샷 | 전부 실재 |
  | `supportTitle/Description` (`:80-82`), `trustTitle/Description` (`:89-91`) | 섹션 리드 | — | — |
  | `modelStripLabel`, `modelCatalogue` (`:77-78`) | `Compare models across leading providers` / `Explore all models` | `/models` | Available |
  | `status` (`:79`) | `Live service status` | `/status` | Available |
  | `safetyCta` (`:96`) | `Read the safety and security overview` | `/safety` | Available |
  | `modelFinderLead/Cta` (`:69-70`) | `Not sure which AI fits your work? / Get a one-minute recommendation after sign-up.` | Model Finder | Gated |
  | `app` (`:58`), `pricingCta` (`:68`), `previewCount` 외 일부 | 헤더/보조 CTA | — | — |

- **실제 제품 동작**: 위 표의 "대응 실제 기능"은 모두 구현·노출돼 있습니다. 즉 **문구가 틀린 게 아니라 화면에 나오지 않습니다.**
- **문제**: 결과적으로 렌더되는 홈페이지 본문은 히어로 → 워크스루/사례 → 가격 → FAQ → CTA 뿐이며, 제품의 기능 소개 섹션과 신뢰 섹션이 통째로 없습니다. 방문자는 Insight를 "비교 + AI Review만 하는 서비스"로 인식합니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: 파일 분석·프로젝트·공유·잠금·모델 카탈로그를 찾는 사용자가 홈페이지에서 근거를 찾지 못하고 이탈합니다. 기능 발견성 손실이 가장 큽니다.
- **근거**:
  - `grep -c "content.<key>" components/marketing/LandingPageContent.tsx` → `steps`, `supportItems`, `trustItems`, `modelStripLabel`, `modelCatalogue`, `safetyCta`, `modelFinderLead`, `modelFinderCta`, `content.status`, `content.app` 전부 **0** (확정)
  - 로컬 dev 서버 렌더 HTML 가시 텍스트 전문에 위 문구 미출현 (확정)
  - `git log -S "supportItems.map"` 결과 없음 → 렌더된 이력 자체가 없거나 다른 형태에서 리팩터 중 소실 (확인 불가: 원인)
- **권장 조치**: 신규 카피 작성이 아니라 **복구**. 7개 로케일 원문이 이미 준비돼 있으므로, 8절 권장 정보 구조에 맞춰 `supportItems`/`trustItems` 섹션을 히어로와 가격 사이에 복원하고, 각 항목에 계정/플랜 조건 라벨만 추가하면 됩니다. 사용하지 않기로 결정한 키는 타입에서 제거해 재발을 막아야 합니다.
- **제안 문구**: 기존 원문 그대로 사용 + 조건 라벨 추가
  - en `supportItems[0]` 라벨: `Free account`
  - ko `supportItems[0]` 라벨: `무료 계정 필요`
- **확신 수준**: High

---

### [P1][Missing feature] Deep Research·Web Search·근거 지표가 홈페이지에 전혀 없음

- **홈페이지 위치**: 해당 없음(미노출)
- **현재 문구**: 없음. 오히려 `reviewBoundary` 가 `It does not browse the web` 를 강조
- **실제 제품 동작**:
  1. **Web Search**: 대화 단위 모드 `off` / `auto` / `always`. `always` 는 공급자 네이티브 검색 도구(OpenAI `web_search`, Anthropic `web_search_20250305`, Google Search Grounding)를 활성화하고 인용을 반환합니다. 모델당 +8크레딧 예약, 실제 검색이 실행되지 않으면 정산 시 환불. `auto` 는 검색을 실행하지 않고 제안만 표시합니다.
  2. **Deep Research**: `perplexity/sonar-deep-research`, `minimumPlan: "Pro"`, 30크레딧, standard/deep 심도 선택, 명시적 확인 시트 후 시작하는 장시간 비동기 잡.
  3. **Perplexity 검색 모델**: `sonar`·`sonar-pro`(Free 이상, 20크레딧), `sonar-reasoning-pro`(Pro 이상).
  4. **Source grounding**: AI Review 결과에 `Overall source grounding · N% · x/y quotes matched` 뱃지. 인용문 단위로 원문 일치 여부 표시.
  5. **항목별 웹 검증**: "검증 필요" 항목에 `Check with web search` → `perplexity/sonar` 로 supported/unsupported/inconclusive 판정.
- **문제**: "Insight"라는 제품명이 약속하는 **근거·출처·최신성** 축이 홈페이지 정보 구조에서 통째로 빠져 있습니다. 그 결과 홈페이지는 Insight를 "여러 모델을 한 화면에 띄워주는 서비스"로만 설명하며, ChatGPT 같은 일반 AI 채팅과의 차별점을 "여러 개를 동시에"라는 수량 논리로만 제시합니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: ① Pro 플랜을 살 이유가 홈페이지에 없습니다(가격 카드는 크레딧 수량 차이만 말함). ② "AI는 최신 정보를 모른다"는 반론이 해소되지 않습니다. ③ 경쟁 서비스 대비 가장 방어하기 좋은 차별점(인용 일치율, 이중 리뷰어)이 노출되지 않습니다.
- **근거**:
  - `lib/models.ts:203` — `sonar-deep-research ... minimumPlan: "Pro", usageClass: "deep-research"` (확정)
  - `lib/models.ts:50, 57` — `deepResearch: 30`, `webSearchSurcharge: 8` (확정)
  - `lib/appDefaults.ts:74-78` — `WEB_SEARCH_MODES = ["off","auto","always"]`, 대화 단위, `auto` 는 제안만 (확정)
  - `lib/webSearchCapability.ts:19-77` — 모델별 native/search-model/unsupported/unverified 매트릭스 (확정)
  - `lib/webSearchCredits.ts:22-33` — native 만 서차지 대상 (확정)
  - `components/chat/ChatInput.tsx:2685-2710` — Deep Research 잠금(게스트=로그인 필요, Free=업그레이드 필요) (확정)
  - `lib/sourceGrounding.ts`, `locales/en.ts:359-369` (확정)
  - `app/api/conversations/[conversationId]/comparison-reviews/verify-item/route.ts:44-51` (확정)
  - **테스트**: `tests/e2e/chat-tools.spec.ts:165` (게스트 Deep Research 차단), `:182` (Pro 사용자 확인 시트), `tests/e2e/native-web-search.spec.ts`, `tests/e2e/source-grounding.spec.ts` (확정)
- **권장 조치**: 히어로 다음, 워크스루 앞에 **"근거와 최신성" 섹션**을 신설. Web Search / Deep Research / Source grounding 3개 카드로 구성하고 각 카드에 플랜·크레딧 조건을 함께 표기.
- **제안 문구**:
  - en 섹션 제목: `Answers you can check, not just compare.`
  - ko 섹션 제목: `비교에서 끝내지 않고, 근거까지 확인하세요.`
  - en Web Search 카드: `Web search — Turn on web search for a conversation so supported models answer with current sources and citations. Signed-in accounts; uses extra credits when a search runs.`
  - ko Web Search 카드: `웹 검색 — 대화 단위로 웹 검색을 켜면 지원 모델이 최신 출처와 인용을 함께 답변합니다. 로그인 필요, 검색이 실행되면 크레딧이 추가로 사용됩니다.`
  - en Deep Research 카드: `Deep Research — Run an extended, multi-source research job on one question. Pro plan and above; uses credits.`
  - ko Deep Research 카드: `Deep Research — 하나의 질문에 대해 여러 출처를 훑는 확장 리서치를 실행합니다. Pro 플랜 이상, 크레딧을 사용합니다.`
  - en Source grounding 카드: `Source grounding — Every AI Review quote is checked against the answer it came from, and the match rate is shown. It measures quote matching, not factual accuracy.`
  - ko Source grounding 카드: `근거 일치율 — AI Review의 모든 인용문을 원본 답변과 대조해 일치율을 보여줍니다. 사실 정확도가 아니라 인용 일치 여부를 측정합니다.`
- **확신 수준**: High

---

### [P1][Missing feature] 게스트가 실제로 쓸 수 있는 분석 기능(Quick difference summary)이 미노출

- **홈페이지 위치**: 해당 없음(미노출)
- **현재 문구**: 없음
- **실제 제품 동작**: 비교 액션 레일에 `Quick difference summary` (모바일 `Differences`) 버튼이 있습니다. 게스트도 사용 가능하며 **1일 1회** 무료(`CHAT_GUEST_QUICK_SUMMARY_PER_DAY`, 기본 1), 전용 라우트 `POST /api/chat/compare-summary` 는 게스트 세션 전용입니다(로그인 사용자는 `/api/conversations/{id}/compare-summary`, 약 1크레딧). 저비용 리뷰어 풀(`gpt-5-4-mini`, `gemini-2-5-flash`, `claude-haiku-4-5`, `mistral-small-4`, `llama-3-3`)을 사용합니다.
- **문제**: 홈페이지가 "무가입으로 비교 가치를 체험하라"고 유도하면서, 무가입으로 체험 가능한 유일한 AI 분석 기능은 소개하지 않고 잠긴 AI Review만 보여줍니다. 게스트 전환 퍼널이 홈페이지에서부터 잘못 설계돼 있습니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: 게스트가 "AI가 답변을 정리해주는" 경험을 하지 못한 채 잠긴 버튼만 보고 이탈합니다. 가입 전환의 가장 좋은 훅을 낭비하고 있습니다.
- **근거**:
  - `components/chat/ComparisonActionRail.tsx:28` — `QUICK_SUMMARY_CREDITS = 1` (확정)
  - `components/chat/ComparisonActionRail.tsx:356` — `data-testid="quick-comparison-button"` 이 게스트 분기 밖에 위치 (확정)
  - `app/api/chat/compare-summary/route.ts:115-117` — `if (access.kind !== "guest") ... "This endpoint is for guest sessions only."` (확정)
  - `app/api/chat/compare-summary/route.ts:168` + `lib/chatSecurity.ts:543-565` — 게스트 1일 1회 (확정)
  - **테스트**: `tests/e2e/comparison-action-rail.spec.ts:157` — 게스트 화면에 `quick-comparison-button` 과 `ai-review-guest-locked` 가 함께 존재 (확정)
- **권장 조치**: 히어로 하단 guestNote를 "무가입으로 가능한 것" 목록으로 승격.
- **제안 문구**:
  - en: `Without an account: compare three models on one question, and run one quick difference summary a day.`
  - ko: `계정 없이: 하나의 질문으로 3개 모델을 비교하고, 하루 한 번 빠른 차이 요약을 실행할 수 있습니다.`
- **확신 수준**: High

---

### [P2][Outdated content] 제품 워크스루 영상/포스터가 현행 UI가 아님

- **홈페이지 위치**: `components/marketing/ProductProofSection.tsx:274-292`, 자산 `public/marketing-proof/tomverse-review-workflow.webm`, `...-poster.png`
- **현재 문구**: `Real product UI · controlled demo data · no customer content · no provider endorsement` (ko `실제 제품 UI · 통제된 데모 데이터 · 고객 콘텐츠 없음 · 공급자 보증 아님`)
- **실제 제품 동작 대비 차이**:
  1. 포스터에 `4 credits used` 표시 → 현재 AI Review는 **독립 리뷰어 2개**를 실행하며 셀프 가격은 `AI_REVIEW_CREDITS = 8` 입니다. 이 상수 위 주석이 명시적으로 "예전에는 단일 리뷰어 무게를 담고 있어서 레일이 4를 광고하면서 8을 청구했다"고 기록합니다.
  2. 포스터에 `Review confidence: medium` 표시 → 현재 제품 명칭은 **Source grounding** 입니다. `lib/sourceGrounding.ts` 상단 주석이 "`confidence` 라는 저장 필드명은 이 값이 측정하는 것과 한 번도 일치한 적이 없다"고 설명하며, 이 모듈 위쪽 전체가 *source grounding* 으로 말하도록 경계를 그었습니다. 현재 라벨은 `Overall source grounding`, `{matched}/{total} quotes matched` 입니다.
  3. 포스터에 이중 리뷰어 표기(`Reviewer 1 / Reviewer 2`, `Two independent reviewers run for this comparison.`)와 Source grounding 뱃지가 없습니다.
  4. 반면 섹션 제목(`1. Consensus` ~ `5. Verification needed`)과 모델 표시명(`GPT-5.4 mini`, `Claude Haiku 4.5`, `Gemini 3.1 Flash-Lite`)은 **현행과 일치**합니다.
- **문제**: 영상은 "실제 제품 UI"라고 명시 표기돼 있으므로, 표시된 가격과 지표 명칭이 현행과 다르면 그 표기 자체가 부정확해집니다. 특히 **가격을 절반으로 보여주는 것**은 크레딧 소진 속도에 대한 오해로 이어집니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: AI Review 1회 비용을 4크레딧으로 인식 → Free 월 300크레딧으로 75회 가능하다고 오판(실제로는 크레딧 이전에 월 3회 제한). 또한 제품에 들어가서 `Review confidence` 를 찾다가 못 찾습니다.
- **근거**:
  - 자산 커밋: `git log -- public/marketing-proof/` → `8491c47` (2026-07-27) 단일 커밋 (확정)
  - 가격 정정 커밋: `git log -S "AI_REVIEW_CREDITS = 8"` → `440e65a` (2026-07-29) *"Make the approval retry possible and stop understating cross-review cost"* — **영상 촬영 이후** (확정)
  - 명칭 변경: `git log -S "aiReviewSourceGroundingOverall" -- locales/en.ts` → `1214ead` / `1bc4e96` (2026-07-27) (확정)
  - 포스터 이미지 육안 확인: `4 credits used`, `Review confidence: medium` (확정)
  - 영상 실측: `Duration 00:00:21.88`, `1280x720`, `vp8` — `20–25 sec` 라벨은 정확 (확정)
  - 영상 본편의 프레임 내용은 코덱 제약으로 추출하지 못함 → 본편 내 다른 불일치 여부는 **확인 불가**
- **권장 조치**: (a) 워크스루를 현행 UI로 재촬영하거나, (b) 재촬영 전까지 고지 문구에 캡처 시점을 명시. 가격이 표시되는 프레임은 재촬영이 안전합니다.
- **제안 문구** (임시 조치용):
  - en: `Real product UI · captured July 2026 · controlled demo data · no customer content · no provider endorsement`
  - ko: `실제 제품 UI · 2026년 7월 촬영 · 통제된 데모 데이터 · 고객 콘텐츠 없음 · 공급자 보증 아님`
- **확신 수준**: High (포스터), Medium (영상 본편 — 프레임 미추출)

---

### [P2][Understatement] "웹 검색을 하지 않습니다"가 실제 검증 기능을 가림

- **홈페이지 위치**: `components/marketing/ProductProofSection.tsx:69-70` (ko `:99`)
- **현재 문구**: `AI Review compares only the supplied answers. It does not browse the web, prove facts, or declare a correct winner.` / ko `AI Review는 제공된 답변끼리만 비교합니다. 웹 검색, 사실 판정 또는 정답 선택을 하지 않습니다.`
- **실제 제품 동작**: 문장의 주장 자체는 **AI Review 생성 단계에 대해 정확합니다.** 그러나 AI Review 결과 화면에서 "검증 필요" 항목마다 `Check with web search` (ko `웹 검색으로 확인`) 버튼이 제공되고, `perplexity/sonar` 라이브 검색 모델로 `supported` / `unsupported` / `inconclusive` 판정을 받습니다. 라우트 주석이 "자동이 아니라 opt-in으로 분리했고 별도 과금한다"고 명시합니다.
- **문제**: 홈페이지에는 이 후속 검증 기능이 어디에도 없고 부정문만 있습니다. 결과적으로 "Tomverse는 검증을 못 한다"로 읽히며, 실제로 존재하는 차별 기능이 감춰집니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: 사실 검증을 원하는 사용자가 경쟁 제품으로 이탈합니다. 제품명 Insight가 약속하는 근거 축이 스스로 부정됩니다.
- **근거**:
  - `app/api/conversations/[conversationId]/comparison-reviews/verify-item/route.ts:44-51` — opt-in·별도 과금 명시 주석, `VERIFY_ITEM_MODEL_ID = "perplexity/sonar"` (확정)
  - `locales/en.ts:377-382` — `Check with web search` / `Supported` / `Unsupported` / `Inconclusive` (확정)
- **권장 조치**: 부정문을 유지하되 뒤에 실제 경로를 덧붙임.
- **제안 문구**:
  - en: `AI Review compares only the supplied answers—it does not browse the web, prove facts, or declare a correct winner. When an item needs checking, you can run a separate web check on it from the review. Important claims still need current primary sources, testing, or qualified professional review.`
  - ko: `AI Review는 제공된 답변끼리만 비교하며, 웹 검색·사실 판정·정답 선택을 하지 않습니다. 확인이 필요한 항목은 검토 결과에서 웹 검색 확인을 따로 실행할 수 있습니다. 중요한 주장은 최신 1차 출처, 테스트 또는 자격 있는 전문가를 통해 확인해야 합니다.`
- **확신 수준**: High

---

### [P2][Overclaim] "source-linked checklist" 에 대응하는 제품 기능이 없음

- **홈페이지 위치**: `components/marketing/ProductProofSection.tsx:66` (ko `:96`)
- **현재 문구**: `Turn an 18-page readiness brief into a source-linked checklist.` / ko `18페이지 준비 문서를 근거와 연결된 체크리스트로 바꿉니다.` + `Outcome: decisions, owners, dates, and unresolved items separated for review.`
- **실제 제품 동작**: PDF는 `pdfjs-dist` 로 텍스트 추출되며 페이지마다 `[Page N]` 마커가 삽입됩니다. 즉 모델이 페이지를 인용할 재료는 있지만, **"출처 연결"을 보장하는 제품 기능(페이지 링크, 인용 하이라이트, 원문 점프)은 존재하지 않습니다.** "결정/담당자/날짜/미해결 항목 분리"도 구조화 추출 기능이 아니라 프롬프트 결과입니다. 첨부 자체도 로그인 전용입니다.
- **문제**: 기능 문장처럼 읽히는 결과 서술입니다. 제품이 보장하는 동작과 모델이 잘 하면 나오는 결과가 구분되지 않습니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: PDF를 올리면 자동으로 출처 링크가 달린 체크리스트가 생성될 것으로 기대했다가, 일반 채팅 답변을 받고 기대 불일치를 겪습니다.
- **근거**:
  - `lib/mediaSecurity.ts:173-187` — 페이지 루프 및 `"[Page " + pageNumber + "]"` 마커 (확정)
  - `lib/sourceGrounding.ts` — 인용 일치율은 **AI Review의 답변 간 인용**에 한정되며 첨부 파일에는 적용되지 않음 (확정)
  - 첨부 게이팅: `DesktopChatShell.tsx:733` (확정)
- **권장 조치**: 보장되지 않는 "source-linked"를 제거하고, 실제로 보장되는 것(원문을 붙여 물어본다 / 페이지 표시가 유지된다)만 표현.
- **제안 문구**:
  - en: `Ask several models about the same 18-page brief instead of pasting excerpts.` / result: `Outcome: each model's reading of the same document, side by side. Free account required for attachments.`
  - ko: `발췌를 붙여넣는 대신 같은 18페이지 문서를 여러 모델에 함께 물어보세요.` / result: `결과: 같은 문서에 대한 모델별 해석을 나란히 확인합니다. 파일 첨부는 무료 계정이 필요합니다.`
- **확신 수준**: Medium (기능 부재는 확정, 문구 의도는 추론)

---

### [P2][Missing constraint] 게스트 사용 한도(일 20 / 월 100 크레딧)와 Turnstile 인증 미표기

- **홈페이지 위치**: 히어로 note (`LandingPageContent.tsx:66-67`, ko `:128-129`), FAQ 1 (`:109`, ko `:168`)
- **현재 문구**: `No sign-up required—start with three models.` / `Yes. Without signing in, you can already compare 3 AI models side by side on the same question.`
- **실제 제품 동작**: 게스트는 분당 5, **일 20크레딧, 월 100크레딧** 입니다. 3개 Standard 모델 비교 1회 = 3크레딧이므로 **하루 약 6질문, 월 약 33질문** 입니다. 또한 첫 메시지 전 Cloudflare Turnstile 검증이 필요하며, 게스트 입력 토큰 상한은 16,000(로그인 128,000)입니다.
- **문제**: "무가입으로 시작"만 있고 어느 정도까지 되는지가 없습니다. 다른 무료 체험 대비 관대한 편인데도, 한도를 밝히지 않아 오히려 소진 시점에 배신감을 만듭니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: 무제한 체험으로 오해 → 6질문 후 차단 → "무료라더니" 인식.
- **근거**:
  - `lib/chatSecurity.ts:313-320` — `CHAT_GUEST_PER_MINUTE 5` / `CHAT_GUEST_PER_DAY 20` / `CHAT_GUEST_PER_MONTH 100` (확정)
  - `lib/chatSecurity.ts:1294-1300` — 일/월 버킷은 `budget.usageCredits` 단위로 차감(=크레딧) (확정)
  - `lib/chatSecurity.ts:278-281` — 게스트 입력 토큰 상한 16,000 (확정)
  - `lib/appDefaults.ts:70` — `maxGuestMessages: 20` (확정)
  - `lib/turnstile.ts`, `app/api/chat/route.ts:762-763` — 게스트 Turnstile 검증 (확정)
  - **테스트**: `tests/e2e/guest-turnstile-verification.spec.ts` (확정)
- **권장 조치**: FAQ 1에 한도 한 줄 추가. 히어로에는 숫자 대신 방향만.
- **제안 문구**:
  - en FAQ 1 말미: `Guest use has its own daily and monthly limits, and a quick verification step before the first message.`
  - ko FAQ 1 말미: `비회원 이용에는 자체 일간·월간 한도가 있으며, 첫 메시지 전 간단한 확인 절차를 거칩니다.`
- **확신 수준**: High

---

### [P2][Localization mismatch / CTA mismatch] `/ko` 에서 헤더·브랜드 링크가 영어 canonical URL로 보냄

- **홈페이지 위치**: `components/marketing/MarketingChrome.tsx:65-68`(topMenu 정의), `:262`(브랜드 링크), `:291`(nav 렌더), `:358`(모바일 메뉴)
- **현재 문구/동작**: `/ko` 에서도 `기능` → `/#how-it-works`, `모델` → `/models`, 브랜드 로고 → `/`
- **실제 동작**: `/` 는 영어 SEO 메타데이터(`og:locale = en_AU`, canonical `https://tomverse.app`)를 가진 라우트입니다. 본문 언어는 `localStorage` 에 저장된 `ko` 로 유지되지만(`LanguageProvider`), **URL과 메타데이터는 영어로 바뀝니다.** 반면 푸터 리소스 링크는 `localizedPath(lang, ...)` 를 써서 `/ko/compare-ai-models` 로 정확히 이동합니다 — 같은 파일 안에서 두 정책이 공존합니다.
- **문제**: 한국어 방문자가 헤더를 한 번 클릭하면 로케일 URL을 잃습니다. 공유·북마크·검색 유입 시 언어가 재현되지 않고, hreflang 구조도 흐트러집니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: 언어가 유지되는지 방문자가 신뢰하지 못하며, 한국어 URL을 공유해도 상대는 상황에 따라 영어를 볼 수 있습니다.
- **근거**:
  - `/ko` 렌더 HTML의 `href` 집합: `/`, `/#how-it-works`, `/models`, `/pricing`, `/faq`, `/terms` 등 비로케일 + `/ko/ai-answer-review` 등 로케일 혼재 (확정, dev 서버 실측)
  - `MarketingChrome.tsx:291` `href={item.href}` vs `:457` `href={localizedPath(lang, item.path)}` (확정)
  - `lib/seo.ts` `LOCALIZED_SEO_PATHS` — `/models`, `/pricing`, `/faq` 는 로케일 라우트가 없으므로 이들은 현행이 정상. **문제는 로케일 라우트가 존재하는 `/`(=`/#how-it-works`)와 브랜드 링크뿐** (확정)
- **권장 조치**: 브랜드 링크와 `Features` 앵커에 `localizedPath` 적용(`/ko`, `/ko#how-it-works`). 로케일 라우트가 없는 목적지는 현행 유지.
- **제안 문구**: 문구 변경 없음(링크 대상만 수정)
- **확신 수준**: High

---

### [P2][Evidence gap] 플랜 크레딧 수치가 하드코딩이라 실시간 가격과 어긋날 수 있음

- **홈페이지 위치**: `LandingPageContent.tsx:100-104`(en), `:159-163`(ko), 렌더 `:564-567`
- **현재 문구**: `Free $0 / 300 monthly AI credits`, `Pro $15 / 3,000`, `Max $25 / 10,000`
- **실제 제품 동작**: **가격**은 `usePublicBilling()` → `/api/billing/config` 로 시장별 통화까지 반영해 실시간 표시되고, 실패 시에만 `fallbackPrice` 를 씁니다. 그러나 **크레딧 수량은 문구 문자열에 하드코딩**돼 있습니다. `/pricing` 페이지는 같은 값을 `monthlyMessageLimit` 실시간 값 + `fallbackCredits` 조합으로 처리합니다(`PricingPageContent.tsx:840-846`). 즉 홈페이지만 정적입니다.
- **문제**: 관리자가 `BillingPlan.monthlyMessageLimit` 을 바꾸면 홈페이지는 **실시간 가격 옆에 옛 크레딧 수량**을 표시합니다. 가격·수량이 한 카드 안에서 서로 다른 신선도를 가집니다.
- **사용자에게 발생할 수 있는 오해 또는 손실**: 결제 직전 페이지와 홈페이지가 다른 수량을 말할 수 있습니다. 결제 관련 표시 불일치는 신뢰·분쟁 리스크입니다.
- **근거**:
  - `components/marketing/LandingPageContent.tsx:565` — `billing.formatPlanPrice(plan.id) || plan.fallbackPrice` (가격은 동적) (확정)
  - `components/marketing/LandingPageContent.tsx:101-103` — 크레딧 수량은 `description` 문자열 (확정)
  - `components/marketing/PricingPageContent.tsx:840-846` — `fallbackCredits` + `monthlyMessageLimit` (확정)
  - `lib/billingConfig.ts:63-64, 80-81, 100-101` — 기본값 300 / 3,000 / 10,000 (확정)
  - 운영 DB 실제 값 — **확인 불가**
- **권장 조치**: 홈페이지 플랜 카드도 `/api/billing/config` 의 `monthlyMessageLimit` 을 사용하고 문구는 `{credits}` 치환형으로 전환. 또는 홈페이지에서 수량을 빼고 "플랜별 월 크레딧은 요금 페이지에서 확인" 으로 축약.
- **제안 문구**:
  - en: `{credits} monthly AI credits for light everyday use and trying advanced models.`
  - ko: `가벼운 일상 사용과 고급 모델 체험을 위한 월 {credits} AI 크레딧.`
- **확신 수준**: High (구조), Unverified (현재 실제 불일치 여부)

---

### [P3][Missing constraint] 일일 크레딧 가드레일과 Max의 "일일 제한 없음"이 모두 미표기

- **홈페이지 위치**: 가격 섹션 플랜 카드
- **현재 문구**: 월 크레딧만 표기
- **실제 제품 동작**: Free 일 30, Pro 일 300, **Max 일일 제한 없음**(`dailyMessageLimit: 0`). 일일 가드레일은 플랜 크레딧에만 적용되고 구매 크레딧은 그 이후에도 사용 가능합니다.
- **문제**: 하방 조건(Free 일 30)이 빠져 있고, 상방 강점(Max 일일 무제한)도 빠져 있어 양방향 손해입니다.
- **근거**: `lib/billingConfig.ts:63,80,100`, `lib/chatSecurity.ts:339-346`, `lib/chatCreditAllocation.ts:12-17` (확정)
- **권장 조치**: 가격 섹션 하단 각주 한 줄.
- **제안 문구**: en `Monthly credits also have a daily pacing limit on Free and Pro. See the pricing page.` / ko `Free와 Pro는 월 크레딧에 더해 일일 사용 속도 제한이 있습니다. 요금 페이지에서 확인하세요.`
- **확신 수준**: High

---

### [P3][Terminology mismatch] 홈페이지의 `AI Review` 와 제품 UI의 `AI answer cross-review`

- **홈페이지 위치**: 히어로 서브헤드, 프리뷰 카드(`Tomverse AI Review`), 단계 3, 사례 1, 경계 고지, SEO/OG 전부
- **실제 제품 UI**: 버튼 `AI answer cross-review` / 축약 `AI review`, 다이얼로그 eyebrow `Manual AI review`, 게스트 잠금 문구 `Log in to use AI cross-review`. 한국어 마케팅 링크는 `AI 답변 교차검토`.
- **문제**: 홈페이지는 `AI Review`, 제품은 `AI answer cross-review`, 푸터 링크는 `AI 답변 교차검토` 로 세 갈래입니다. 브랜드 용어로서 `AI Review` 를 유지하는 것 자체는 합리적이나, 제품 내 버튼과 정확히 같은 라벨이 아니라 첫 사용 시 매칭 비용이 생깁니다.
- **근거**: `locales/en.ts:333-337`, `MarketingChrome.tsx:17,23` (확정)
- **권장 조치**: 홈페이지 최초 등장 시 1회만 병기.
- **제안 문구**: en `AI Review (shown in the app as "AI answer cross-review")` / ko `AI Review(앱에서는 "AI 답변 교차검토")`
- **확신 수준**: High

---

### [P3][Localization mismatch] 영상 카드 라벨이 번역되지 않음

- **홈페이지 위치**: `ProductProofSection.tsx:271-272`
- **현재 문구**: `Tomverse product walkthrough`, `20–25 sec` — 하드코딩 영어. `/ko` 렌더 결과에서도 영어로 확인됨.
- **문제**: 브랜드명 외 일반 명사구가 번역되지 않아 한국어 페이지 안에서 튑니다. `20–25 sec` 은 단위 표기도 현지화되지 않습니다.
- **근거**: `/ko` 렌더 HTML 가시 텍스트에 `Tomverse product walkthrough`, `20–25 sec` 출현 (확정)
- **권장 조치**: `ProofCopy` 에 두 키 추가 후 7개 로케일 번역.
- **제안 문구**: ko `Tomverse 제품 워크스루`, `20~25초`
- **확신 수준**: High

---

### [P3][Evidence gap] 영상이 WebM(VP8) 단일 소스 — 대체 포맷 없음

- **홈페이지 위치**: `ProductProofSection.tsx:275`
- **실제 상태**: `tomverse-review-workflow.webm` (VP8, 1280x720, 21.88s, 1.19MB) 하나만 제공. MP4/H.264 대체 소스 없음. 재생 불가 환경에서는 `poster` PNG와 `<video>` 내부 폴백 텍스트(`content.videoTitle`)만 남습니다.
- **문제**: 재생 실패 시 워크스루의 정보가 포스터 1장으로 축소됩니다. 다만 영상 옆 본문(`videoBody`)이 같은 내용을 텍스트로 담고 있어 정보 손실은 제한적입니다. 또한 `autoPlay` + 1.19MB 이므로 모바일 데이터 환경에서 즉시 다운로드됩니다.
- **근거**: ffmpeg 실측 및 `ls -la public/marketing-proof/` (확정)
- **권장 조치**: MP4 소스 추가 또는 모바일에서 `preload="none"` + 클릭 재생.
- **확신 수준**: High (사실), Medium (영향도)

---

### [P3][Understatement] 실제 공급자는 11곳인데 FAQ는 10곳만 나열

- **홈페이지 위치**: `LandingPageContent.tsx:110` (ko `:169`)
- **현재 문구**: `OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba, and Perplexity`
- **실제 상태**: 위 10곳 + `zhipu`(GLM). `such as` / `등의` 표현이므로 허위는 아니나 축소 표현입니다. 또한 공급자 이름과 실제 카탈로그 ID의 매핑(`qwen` → Alibaba)이 문구에만 존재합니다.
- **근거**: `lib/models.ts` provider 값 집계 (확정)
- **권장 조치**: `/models` 링크를 FAQ 답변에 추가하여 최신 목록으로 유도.
- **확신 수준**: High

---

## 5. 기능별 콘텐츠 커버리지

평가: ● 충분 / ◐ 부분 / ○ 없음

| 기능 | 언급 여부 | 설명 정확성 | 가치 전달 | 제약 전달 | CTA 연결 | 종합 평가 |
|---|---|---|---|---|---|---|
| 멀티모델 비교(최대 3) | ● | ● 정확 | ● 명확 | ◐ 게스트 한도 없음 | ● `/chat` | **양호** — 홈페이지의 유일한 완성 영역 |
| AI Review (교차검토) | ● | ◐ 동작은 정확, 조건 전무 | ● 명확 | ○ 로그인·월 3회·8크레딧 전부 없음 | ◐ CTA는 `/chat` 이나 게스트는 실행 불가 | **위험** — P1 |
| Quick difference summary | ○ | — | ○ | ○ | ○ | **누락** — 게스트 훅 상실, P1 |
| Deep Research | ○ | — | ○ | ○ | ○ | **누락** — Pro 전환 근거 상실, P1 |
| Web Search | ○ | — | ○ | ○ | ○ | **누락** — 최신성 반론 미해소, P1 |
| Source grounding / 인용 검증 | ○ | — | ○ | ○ | ○ | **누락** — 최대 차별점 상실, P1 |
| 항목별 웹 검증 | ○(부정 언급) | ✕ 역방향 인상 | ○ | ○ | ○ | **역효과** — P2 |
| 파일 첨부·분석 | ◐ 사례 카드에서만 | ◐ "source-linked" 과장 | ◐ | ○ 로그인 필요 미표기 | ● `/ai-for-file-analysis` | **부분** — P1(조건) + P2(과장) |
| 프로젝트 / 저장 / 검색 | ○ (죽은 copy 존재) | — | ○ | ○ | ○ | **누락** — P2 |
| 공유 / 다운로드 | ◐ 영상 문구 `share` 1회 | ● | ○ | ○ | ○ | **누락** — P2 |
| 대화 잠금 | ◐ FAQ 3 단어 | ● | ○ | ○ | ○ | **미약** — P3 |
| 모델 패널 일시정지(타깃 후속) | ○ (죽은 copy 존재) | — | ○ | ○ | ○ | **누락** — P2 |
| Model Finder | ○ (죽은 copy 존재) | — | ○ | ○ | ○ | **누락** — P2 |
| 게스트 대화 가져오기 | ○ | — | ○ | ○ | ○ | **누락** — P2 |
| 모델 카탈로그 | ◐ 헤더 nav만 | ● | ○ | — | ● `/models` | **미약** — P2 |
| 상태 페이지 | ◐ FAQ + 푸터 | ● | ◐ | — | ● `/status` | **부분** — P3 |
| 플랜·크레딧 | ● | ◐ 하드코딩 | ● | ◐ 일일 한도 없음 | ● `/pricing` | **부분** — P2/P3 |
| 추가 크레딧 팩 | ◐ 문장 내 1단어 | ● | ○ | — | ● `/pricing` | **미약** — P3 |
| 안전·보안 | ◐ FAQ 3 | ● | ◐ | ● 공급자 전송 명시 | ○ (`safetyCta` 죽은 copy) | **부분** — P3 |
| 30일 이용 지표 | ● | ● 정확 | ◐ | ● 임계값·내림 명시 | — | **양호** |

---

## 6. 사용자 여정 검수

### 6-1. 첫 방문 → 제품 이해

- **홈페이지 기대**: `Ask once. / Compare multiple AI answers.` + GPT/Claude/Gemini 3패널 목업 → 5초 내 이해 **가능**.
- **실제**: 일치.
- **차이**: 일반 AI 채팅과의 차별점이 "동시에 여러 개"라는 수량 논리에만 의존합니다. Insight의 질적 차별점(근거 일치율, 이중 리뷰어, 웹 검증)은 홈페이지에 없습니다.
- **판정**: ✅ 이해는 성립 / ⚠️ 차별화는 미달 (P1: F-04, M-04)

### 6-2. 홈페이지 → 가입 또는 로그인

- **홈페이지 기대**: 히어로 CTA와 최종 CTA 모두 `/chat?...&entry=guest-preview` — **가입 유도 CTA가 홈페이지에 하나도 없습니다.**
- **실제**: 가입은 `/auth/signin` 이며 홈페이지 어디에서도 직접 링크되지 않습니다(헤더 CTA도 `/chat`). `/pricing` 의 Free 카드 CTA만 `/auth/signin?callbackUrl=%2Fchat` 입니다.
- **차이**: "무가입 우선" 전략으로는 합리적이나, AI Review·파일 등 계정 필요 기능을 소개할 경우 그 자리에 가입 경로가 필요합니다. 또한 게스트 대화가 가입 시 이관된다는 사실(`import-guest`)을 알리면 전환 저항이 낮아지는데 미고지입니다.
- **판정**: ⚠️ Journey gap (P2)

### 6-3. 홈페이지 CTA → 새 대화 시작

- **홈페이지 기대**: `Start chatting free` → 즉시 3모델 대화.
- **실제**: `/chat?lang=en&entry=guest-preview` 로 이동(실측 확인). 게스트 기본 선택은 `gpt-5-4-mini` / `claude-haiku-4-5` / `gemini-2-5-flash` 3개로 SSR·hydration 간 동일하게 계산됩니다. 첫 메시지 전 Turnstile 검증, 온보딩 안내(`Start using Tomverse`)가 있습니다.
- **차이**: 홈페이지가 언급하지 않은 온보딩 단계와 검증 단계가 존재합니다. 경미합니다.
- **판정**: ✅ 대체로 일치 / ⚠️ 인증 단계 미고지 (P3)

### 6-4. 질문 입력 → 모델 답변 생성

- **홈페이지 기대**: `Read different strengths side by side without copying between tabs.`
- **실제**: 일치. 3패널 병렬 스트리밍.
- **차이**: 게스트 입력 토큰 상한 16,000(로그인 128,000)이라 긴 문서를 붙여넣는 시나리오는 게스트에서 실패할 수 있습니다.
- **판정**: ✅ 일치 / ⚠️ 긴 입력 제약 미고지 (P3)

### 6-5. 여러 답변 → 비교 또는 검토

- **홈페이지 기대**: `then use AI Review to find differences and missing points.`
- **실제**:
  - 답변 2개 이상 완료 시 비교 액션 레일 노출.
  - 게스트: `Quick difference summary`(1일 1회) + `Log in to use AI cross-review`(자물쇠).
  - Free 로그인: AI Review 실행 가능, 월 3회, 약 8크레딧, 3가지 리뷰 모드(balanced/evidence/action) 선택.
- **차이**: **이 여정이 가장 크게 어긋납니다.** 홈페이지가 약속한 정확히 그 지점에서 게스트는 잠금을 만납니다.
- **판정**: ❌ 불일치 (P1: F-01)

### 6-6. Web Search 또는 Deep Research 실행

- **홈페이지 기대**: **없음.** 홈페이지는 이 여정을 아예 약속하지 않습니다.
- **실제**: 두 기능 모두 존재하며 Deep Research는 Pro 이상, Web Search는 모델별 지원 + 크레딧 서차지.
- **차이**: 기대가 형성되지 않으므로 "기대 불일치"는 없으나, **발견성 0**입니다. 사용자는 제품 안에 들어가 `+` 메뉴를 열어야만 존재를 알게 됩니다.
- **판정**: ❌ 누락 (P1: F-04)

### 6-7. 크레딧 부족 또는 플랜 제한 상황

- **홈페이지 기대**: 가격 섹션이 월 크레딧만 제시하고 소진 시 무슨 일이 일어나는지는 `/pricing` 으로 위임.
- **실제**: 상황별로 서로 다른 UI가 있습니다 — `UsageLimitModal`, 비교 레일의 `Not enough credits: {required} needed, {available} available`, 크레딧 세부 시트(`CreditBreakdownSheet`), Free의 AI Review 월 3회 초과 시 429, 게스트 한도 초과 시 로그인 유도.
- **차이**: 홈페이지는 "한도에 닿았을 때 무엇을 할 수 있는지"(추가 크레딧 팩, 업그레이드)를 거의 말하지 않습니다.
- **판정**: ⚠️ 부분 (P3)

### 6-8. 결과 확인 → 후속 행동

- **홈페이지 기대**: 영상 문구의 `before a follow-up or share action` 과 죽은 copy의 `Compare, review, follow up, or share`.
- **실제**: 후속 질문(패널 일시정지로 특정 모델만), 읽기 전용 공유(로그인, 기본 30일), `.txt` 다운로드, 전체 내보내기, 프로젝트 정리 — 전부 실재하나 **전부 로그인 전용**이며 홈페이지 본문에 소개 섹션이 없습니다.
- **판정**: ❌ 누락 (P1: F-03 / P2)

---

## 7. 언어·반응형·메타데이터 검수

### 7-1. locale별 의미 차이

- `LandingCopy` 는 `{ en } & Partial<Record<Language, LandingCopy>>` 로, 각 로케일이 `...englishCopy` 스프레드 위에 부분 재정의합니다. 렌더되는 키 기준으로 **의미가 달라지는 로케일은 없습니다.** en/ko/zh/fr/de/es/pt 모두 히어로·가격·FAQ·CTA가 동일한 약속을 합니다. (확정: `/` 와 `/ko` 렌더 텍스트 대조)
- 렌더되는 키 중 영어로 폴백되는 것은 zh/fr/de/es/pt의 `reviewTitle`(= `Tomverse AI Review`) 뿐이며, 브랜드 문자열이므로 문제 없습니다.
- `ProductProofSection` 의 `proofCopy` 는 `Record<Language, ProofCopy>` 로 7개 로케일 전부 정의돼 있습니다.
- ko는 en과 정확히 같은 조건 누락을 공유합니다 — 즉 **한국어 시장에도 동일한 P1이 그대로 적용**됩니다.

### 7-2. 번역 누락 및 fallback

| 항목 | 상태 |
|---|---|
| `Tomverse product walkthrough` / `20–25 sec` | ❌ 하드코딩 영어, 7개 로케일 전부 (P3) |
| `Tomverse AI Review`(프리뷰 카드) | ⚠️ zh/fr/de/es/pt 영어 폴백 — 브랜드명이므로 허용 |
| `/faq`, `/terms` 등 정보 페이지 | ⚠️ en/ko/zh만 번역, fr/de/es/pt 영어 — 단, `LocaleSupportNotice` 의 `englishFallbackNotice` 가 상단 배너로 고지 (양호) |
| 로케일 등급 배너 | ✅ `zh`=제한 지원, `fr/de/es/pt`=미리보기 로 정확히 고지 (`lib/localeLaunchPolicy.ts`) |
| 유료 마케팅 대상 로케일 | `en`, `ko` 만 (`PAID_MARKETING_LOCALES`) — 홈페이지 문구와 충돌 없음 |

### 7-3. 모바일에서 누락되는 핵심 메시지

렌더 코드 검토 결과 **핵심 메시지 중 모바일에서 사라지는 것은 없습니다.**

| 요소 | 모바일 동작 | 판정 |
|---|---|---|
| 헤더 nav (`Features/Models/Pricing/FAQ`) | `hidden lg:flex` → 햄버거 메뉴로 이동 | ✅ 접근 가능 |
| 헤더 `Chat` CTA | `hidden sm:inline-flex` → 640px 미만에서는 햄버거 안에만 | ⚠️ 한 단계 추가, 다만 히어로 CTA가 즉시 보임 |
| 브랜드 텍스트 | `max-[240px]:sr-only` (320px·200% 확대 상황) | ✅ 접근성 이름 유지 |
| 히어로 프리뷰 3패널 | `sm:grid-cols-3` → 세로 적층 | ✅ 전부 표시 |
| AI Review 칩 4개 | `grid-cols-2 sm:grid-cols-4` | ✅ 전부 표시 |
| 워크스루 영상 + 3단계 | `lg:grid-cols-[1.3fr_0.7fr]` → 적층 | ✅ 전부 표시 |
| 사례 카드 3개, 플랜 카드 3개, FAQ 3개 | 적층 | ✅ 전부 표시 |
| `reviewBoundary` 경고 박스 | 항상 표시 | ✅ |
| 히어로 signup/guest note | `status !== "authenticated"` 조건 — CLS 대책으로 loading 중에도 렌더 | ✅ (의도된 설계, 코드 주석에 근거 기록) |

- 별도 관찰: 영상이 `autoPlay muted loop` 로 1.19MB를 모바일에서 즉시 로드합니다. 콘텐츠 정확성 문제는 아니나 데이터 비용 관점의 개선 여지가 있습니다.

### 7-4. CTA 명칭 차이

| 위치 | en | ko | 목적지 | 판정 |
|---|---|---|---|---|
| 헤더 | `Chat` | `채팅하기` | `/chat?lang=..` | ✅ |
| 히어로(비로그인) | `Start chatting free` | `무료로 채팅 시작하기` | `/chat?lang=..&entry=guest-preview` | ✅ |
| 히어로(로그인) | `Continue chatting` | `채팅 계속하기` | `/chat?lang=..` | ✅ |
| 가격 하단 | `Compare plans and credit usage` | `플랜과 크레딧 사용량 비교` | `/pricing` | ✅ |
| 최종 CTA | 히어로와 동일 | 동일 | 동일 | ✅ |
| 사례 카드 3개 | `See AI answer review` 등 | `AI 답변 교차검토 보기` 등 | `/{locale}/ai-answer-review` 등 | ✅ 로케일 적용됨 |
| 헤더 `Features` | — | `기능` | **`/#how-it-works` (비로케일)** | ❌ P2 (§4 참조) |

- CTA 문구와 목적지의 불일치는 없습니다. 다만 **가입 CTA가 홈페이지에 0건**이라는 구조적 공백이 있습니다(§6-2).

### 7-5. SEO title / description 정확성

- title `Compare AI Answers and Cross-Review What They Missed | Tomverse Insight` — 제품 핵심과 정확히 일치. ✅
- description — AI Review의 7개 섹션 구조(합의/차이/모순/누락/검증)를 정확히 반영. 조건(로그인·크레딧)은 미표기이나 검색 스니펫 특성상 허용 범위. ⚠️ P3
- 7개 로케일 전부 `homeSeoCopy` 에 정의돼 있고 `generateStaticParams` 로 `kr`/`cn` 별칭까지 처리, 별칭은 정식 로케일로 `redirect`. ✅
- `alternates.languages` 로 hreflang 7개 + `x-default` 정확 생성. ✅

### 7-6. OG 콘텐츠의 최신성

- `og:title` / `og:description` — 현재 제품과 일치. ✅
- `og:image` (`app/opengraph-image.tsx`) — `Tomverse Insight · Multi-AI Comparison & Review` + `Compare GPT, Claude, and Gemini side by side, then use AI Review to catch what's missing`. 현재 제품과 일치하며 죽은 문구를 참조하지 않음. ✅
- `og:image:alt`, `twitter:image:alt` 동일 문구. ✅
- ⚠️ 영어 루트의 `og:locale = en_AU`. 운영 주체 기준일 수 있으나 근거 문서 없음 → **확인 불가**, P3.
- ⚠️ OG 자산은 AI Review를 전면에 세우는데, 그것이 로그인 전용이라는 점은 어디에도 없습니다. 공유 링크를 통한 유입자도 §6-5의 불일치를 그대로 겪습니다.

### 7-7. 접근성 때문에 사용자에게 전달되지 않는 문구

- `max-[240px]:sr-only` 브랜드 — 의도된 것이며 링크 접근성 이름은 유지됩니다. ✅
- `<video>` 내부 폴백 텍스트(`content.videoTitle`)는 영상 재생 실패 시에만 노출됩니다. 같은 문구가 바로 아래 `<h3>` 로도 표시되므로 손실 없음. ✅
- `Sparkles`, `Bot`, `ArrowRight` 등 장식 아이콘은 `aria-hidden` 처리되어 있고, 영상에는 `aria-label` 이 있습니다. ✅
- 히어로 프리뷰 카드의 답변 스켈레톤(`h-2 w-4/5 rounded-full bg-zinc-700`)은 텍스트 없는 순수 장식으로, 스크린리더 사용자에게는 "3개 모델이 병렬로 답한다"는 시각적 은유가 전달되지 않습니다. `previewAnswers` 텍스트가 남아 있어 치명적이지는 않으나, 목업 카드 전체에 설명 텍스트를 부여하면 개선됩니다. ⚠️ P3

---

## 8. 권장 콘텐츠 정보 구조

현재 순서: 히어로 → 워크스루+사례 → 가격 → FAQ → CTA (5개 블록)
권장 순서: **8개 블록.** 신규 카피가 필요한 것은 3·6뿐이고, 4·5는 죽은 copy 복구입니다.

### 1. 히어로 (유지 + 조건 분리)
- **섹션 목적**: 5초 내 제품 정체성 전달 + 무가입 진입
- **핵심 메시지**: 한 번 질문 → 여러 AI 답변 비교 → 차이와 누락 확인
- **포함할 실제 기능**: 최대 3모델 동시 비교(게스트 GPT/Claude/Gemini 경량 3종)
- **필요한 제약**: "계정 없이 가능한 것 / 계정이 필요한 것"을 문장 단위로 분리. 프리뷰 카드 AI Review 패널에 `계정 필요` 배지
- **CTA**: `무료로 채팅 시작하기` → `/chat?...&entry=guest-preview`

### 2. 지금 바로 해볼 수 있는 것 (신설·소형)
- **섹션 목적**: 무가입 체험 범위를 정확히 고지해 기대 관리
- **핵심 메시지**: 계정 없이도 3모델 비교와 하루 1회 빠른 차이 요약까지 가능
- **포함할 실제 기능**: 멀티모델 비교, **Quick difference summary(게스트 1일 1회)**
- **필요한 제약**: 일간·월간 한도 존재, 첫 메시지 전 확인 절차
- **CTA**: 히어로 CTA 재사용(중복 버튼 불필요, 문장으로)

### 3. 근거와 최신성 (신설) — **최우선 신규 섹션**
- **섹션 목적**: "Insight" 이름값 확보 + 일반 AI 채팅과의 질적 차별화 + Pro 전환 근거
- **핵심 메시지**: 비교에서 끝내지 않고 근거까지 확인한다
- **포함할 실제 기능**: Web Search(off/auto/always, 인용 반환), Deep Research(다출처 확장 리서치), Source grounding(인용 일치율), 항목별 웹 검증
- **필요한 제약**: Web Search=로그인+검색 실행 시 크레딧 추가 / Deep Research=**Pro 이상**+크레딧 / 검증=로그인+별도 과금 / 일치율은 **인용 일치이지 사실 정확도가 아님**
- **CTA**: `요금 보기` → `/pricing`

### 4. AI Review 자세히 (죽은 copy 일부 복구 + 확장)
- **섹션 목적**: 대표 기능의 실제 산출물과 조건을 정확히 전달
- **핵심 메시지**: 합의·차이·모순·누락·검증 항목을 구조화하고, 서로 다른 공급자 2개가 독립 검토한다
- **포함할 실제 기능**: 7개 섹션 결과, 3가지 리뷰 모드(balanced/evidence/action), 이중 리뷰어, Source grounding 뱃지, 항목별 웹 검증
- **필요한 제약**: **로그인 필수 · Free 월 3회 · 회당 약 8크레딧 · 완료 답변 2개 이상 필요** + 기존 `reviewBoundary` 유지(§4의 보정 문구 적용)
- **CTA**: `AI 답변 교차검토 보기` → `/{locale}/ai-answer-review`

### 5. 비교 이후의 작업 (죽은 `supportItems` 복구)
- **섹션 목적**: 비교를 1회성 체험이 아닌 업무 흐름으로 연결
- **핵심 메시지**: 맥락을 유지한 채 문서·후속 질문·기록으로 이어간다
- **포함할 실제 기능**: 파일 첨부(이미지/PDF/Office/텍스트 최대 5개 + Google Drive), 특정 모델 후속 질문(패널 일시정지), 프로젝트·대화 저장·검색, 읽기 전용 공유·`.txt` 다운로드, Model Finder, 게스트 대화 가져오기
- **필요한 제약**: 항목별 `무료 계정 필요` 라벨. 공유 링크 기본 유효기간 있음
- **CTA**: `무료 계정 만들기` → `/auth/signin?callbackUrl=%2Fchat` (**현재 홈페이지에 없는 가입 CTA 신설**)

### 6. 모델 카탈로그 (죽은 `modelStripLabel`/`modelCatalogue` 복구)
- **섹션 목적**: 카탈로그의 폭을 보여주고 모델 선택 부담을 낮춤
- **핵심 메시지**: 주요 공급자의 모델을 한곳에서 비교
- **포함할 실제 기능**: 11개 공급자 카탈로그, 플랜별 접근 범위, Model Finder 추천
- **필요한 제약**: 게스트/Free/Pro별 접근 모델이 다름. 제공 상태는 변동 가능
- **CTA**: `전체 모델 보기` → `/models`, 보조로 `실시간 서비스 상태` → `/status`

### 7. 신뢰와 제어 (죽은 `trustItems` 복구)
- **섹션 목적**: 민감 자료를 다루는 사용자의 마지막 저항 제거
- **핵심 메시지**: 저장·잠금·공유 동작이 보이고, 공급자에게 무엇이 전송되는지 명시
- **포함할 실제 기능**: 대화 잠금, 읽기 전용 스냅샷 공유, 첨부 제한, 30일 이용 지표(현행 유지)
- **필요한 제약**: **선택한 AI 공급자는 답변 생성에 필요한 요청 내용을 처리함**(현행 문구 유지)
- **CTA**: `안전 및 보안 개요 보기` → `/safety`

### 8. 가격 + FAQ + 최종 CTA (유지 + 보완)
- **섹션 목적**: 결제 조건 이해 및 전환
- **핵심 메시지**: 무료로 시작, 작업이 커지면 업그레이드
- **포함할 실제 기능**: Free/Pro/Max, 추가 크레딧 팩, 연간 결제
- **필요한 제약**: 월 크레딧은 **실시간 값 연동**. 일일 사용 속도 제한(Free/Pro) 각주. Deep Research는 Pro 이상이라는 점을 Pro 카드에 명시
- **CTA**: `플랜과 크레딧 사용량 비교` → `/pricing`, 최종 `무료로 채팅 시작하기`

> 섹션 3·4를 워크스루보다 **앞**에 두는 것이 핵심 변경입니다. 현재는 "어떻게 쓰는가"(워크스루)가 "왜 이걸 쓰는가"(근거·차별점)보다 먼저 나와, 방문자가 차별점을 만나기 전에 사용법부터 읽습니다.

---

## 9. 수정 백로그

### Quick win (문구·링크만, 구조 변경 없음)

| 순서 | 작업 | 대상 파일/영역 | 기대 효과 | 난이도 | 선행 조건 |
|---|---|---|---|---|---|
| 1 | 히어로 note·guestNote를 "무가입 가능 범위 + AI Review는 계정 필요"로 분리 | `LandingPageContent.tsx` `heroSignupNote`/`guestNote` ×7 로케일 | **P1 F-01 완화.** 최대 오해 제거 | 하 | 없음 |
| 2 | "How it works" 3단계 하단에 조건 한 줄 추가 | `ProductProofSection.tsx` `steps` 인접, 신규 키 ×7 | **P1 F-02 해소** | 하 | 없음 |
| 3 | `reviewBoundary` 에 "항목별 웹 검증 가능" 문장 추가 | `ProductProofSection.tsx:69-70` ×7 | **P2** 역효과 제거 + 실기능 노출 | 하 | 없음 |
| 4 | 사례 2 문구에서 `source-linked` 제거, 첨부 조건 명시 | `ProductProofSection.tsx` `cases[1]` ×7 | **P2** 과장 제거 | 하 | 없음 |
| 5 | FAQ 1에 게스트 한도·확인 절차 한 줄, FAQ 2에 `/models` 링크 | `LandingPageContent.tsx` `faqs` ×7 | **P2/P3** 기대 관리 | 하 | 없음 |
| 6 | 헤더 브랜드 링크·`Features` 앵커에 `localizedPath` 적용 | `MarketingChrome.tsx:262, 291, 358` | **P2** 로케일 URL 유지 | 하 | 없음 |
| 7 | 영상 카드 라벨 2건 로케일화 | `ProductProofSection.tsx:271-272` + `ProofCopy` 키 추가 ×7 | **P3** 번역 일관성 | 하 | 없음 |
| 8 | 가격 섹션 각주에 일일 사용 속도 제한 1줄 | `LandingPageContent.tsx` `pricingDescription` ×7 | **P3** 조건 고지 | 하 | 없음 |
| 9 | 프리뷰 카드 AI Review 패널에 `계정 필요` 배지 | `LandingPageContent.tsx:542-551` | **P1 F-01 보강** | 하 | 1번 |

### 구조 개편

| 순서 | 작업 | 대상 파일/영역 | 기대 효과 | 난이도 | 선행 조건 |
|---|---|---|---|---|---|
| 10 | 워크스루 영상 재촬영(현행 UI: 8크레딧 표기, Source grounding 뱃지, 이중 리뷰어) — 그 전까지 고지 문구에 촬영 시점 명시 | `public/marketing-proof/*`, `videoDisclosure` ×7 | **P2 F-05 해소** | 중 | 촬영 환경 |
| 11 | "근거와 최신성" 섹션 신설 (Web Search / Deep Research / Source grounding) | 신규 컴포넌트 + `LandingPageContent` 조립 | **P1 F-04 해소.** 차별화·Pro 전환 | 중 | 8절 §3 확정 |
| 12 | 죽은 copy 복구: `supportItems` → "비교 이후의 작업" 섹션 | `LandingPageContent.tsx:80-88` 렌더 추가 | **P1 F-03 부분 해소.** 기능 발견성 | 중 | 조건 라벨 정책 |
| 13 | 죽은 copy 복구: `trustItems` + `safetyCta` → "신뢰와 제어" 섹션 | `LandingPageContent.tsx:89-96` 렌더 추가 | **P1 F-03 부분 해소** | 중 | 12번과 동시 |
| 14 | 죽은 copy 복구: `modelStripLabel`/`modelCatalogue`/`status` → 모델 카탈로그 섹션 | `LandingPageContent.tsx:77-79` 렌더 추가 | **P2** 카탈로그 발견성 | 중 | 12번과 동시 |
| 15 | 가입 CTA 신설(`/auth/signin?callbackUrl=%2Fchat`) + 게스트 대화 이관 고지 | 12번 섹션 하단 | **P2** 전환 경로 확보 | 중 | 12번 |
| 16 | 플랜 크레딧 수치를 `/api/billing/config` 연동으로 전환 | `LandingPageContent.tsx:100-104, 564-567`, `usePublicBilling` | **P2** 결제 표시 정합성 | 중 | `monthlyMessageLimit` 노출 확인 |
| 17 | Model Finder 진입 링크 노출 (`modelFinderLead`/`modelFinderCta` 복구) | `LandingPageContent.tsx:69-70` | **P2** 모델 선택 장벽 완화 | 중 | 14번 |
| 18 | 섹션 순서 재배치(8절 권장 IS) | `LandingPageContent.tsx` 조립부 | 차별점을 사용법보다 앞에 | 중 | 11~14번 |
| 19 | 사용하지 않기로 확정한 copy 키를 `LandingCopy` 타입에서 제거 | `LandingPageContent.tsx:17-55` | 죽은 copy 재발 방지 | 하 | 12~14, 17번 결정 후 |
| 20 | 랜딩 콘텐츠 계약 E2E 스펙 신설(핵심 문구·CTA·조건 라벨 존재 검증) | `tests/e2e/` 신규 | 회귀 방지 | 중 | 1~18번 |

> 현재 `tests/e2e/` 70개 스펙 중 **랜딩 페이지 콘텐츠 자체를 검증하는 스펙은 없습니다**(`marketing-*` 3종은 언어 전환·상태 링크·동의 배너 배치만 검증). 20번이 없으면 이번 개편도 다시 조용히 썩습니다.

---

## 10. 확인이 필요한 질문

코드와 문서만으로 확정할 수 없어 제품/사업 결정이 필요한 항목입니다. 이 질문들 때문에 위 감사를 중단하지 않았으며, 확인 가능한 범위는 모두 판정했습니다.

1. **AI Review의 게스트 개방 여부** — 홈페이지의 최대 약속이 로그인 전용인 상태를 (a) 문구로 조건을 밝혀 해결할지, (b) 게스트에게 월 1회 등 제한적으로 개방해 홈페이지 약속을 코드가 따라가게 할지. 두 방향의 비용/효과가 다릅니다. 이 감사는 (a)를 전제로 제안 문구를 작성했습니다.
2. **운영 DB의 실제 플랜 값** — `BillingPlan` 테이블의 `monthlyPriceCents` / `monthlyMessageLimit` 가 `DEFAULT_PLANS`(0/1500/2500, 300/3000/10000)와 일치하는지. 홈페이지 하드코딩 수치의 현재 정확성은 이 확인 없이는 `Unverified` 입니다.
3. **`COMPARISON_REVIEW_FREE_PER_MONTH` 운영 설정값** — 기본 3이지만 환경 변수로 조정 가능합니다. 홈페이지에 회수를 명시할지, "월 몇 회"라는 표현만 쓸지 결정이 필요합니다.
4. **Deep Research의 홈페이지 노출 정책** — Pro 전용 기능을 무료 진입 랜딩에 어느 강도로 노출할지. 전환 상승과 "결국 유료" 인상 사이의 트레이드오프는 제품 결정입니다.
5. **워크스루 영상 재촬영 일정** — 재촬영 전까지 `Real product UI` 표기를 유지할지, 촬영 시점을 병기할지, 영상을 잠시 내릴지.
6. **`en_AU` OG 로케일의 근거** — 운영 법인/주요 시장이 호주 기준인지. 아니라면 `en_US` 또는 `en` 이 맞습니다.
7. **죽은 copy의 원인** — 리팩터 중 섹션이 소실된 것인지, 의도적으로 비활성화한 것인지. `git log -S` 로는 렌더 이력이 검출되지 않아 **확인 불가**입니다. 의도적 비활성이라면 그 결정 근거를 문서화해야 하며, 아니라면 12~14번은 버그 수정입니다.
8. **홈페이지에서 가입 CTA를 제외한 것이 전략인지** — 현재 모든 CTA가 게스트 체험으로 향합니다. 의도된 "체험 우선" 전략이라면 §6-2의 지적은 완화되지만, 계정 필요 기능을 소개하는 순간 가입 경로가 필요해집니다.
9. **`zhipu`(GLM) 공급자를 공개 문구에 포함할지** — 실재하지만 FAQ 목록에서 빠져 있습니다. 의도적 제외인지 누락인지.
10. **공유 링크 유효기간(`SHARE_LINK_TTL_DAYS`, 기본 30일)의 공개 고지 수준** — 공유 기능을 홈페이지에 복구할 경우, 만료가 있다는 사실을 홈페이지에서 밝힐지 `/pricing`·도움말로 위임할지.

---

## 최종 자체 점검

| 점검 항목 | 결과 |
|---|---|
| 홈페이지의 주요 문구를 빠짐없이 조사했는가? | ✅ dev 서버 렌더 HTML에서 가시 텍스트 **전문**을 en/ko로 추출해 38개 주장(C-01~C-38)으로 분해. 메타데이터·OG 이미지·푸터·헤더 포함 |
| 실제 기능의 존재뿐 아니라 일반 사용자 접근 가능성을 확인했는가? | ✅ 모든 기능을 Available/Gated/Partial 등으로 분류하고, 게이팅 지점(세션 검사·플랜 검사·크레딧 예약)을 라우트 단위로 지목 |
| 기능 제한과 플랜·크레딧 조건을 확인했는가? | ✅ 게스트 20/100크레딧, Free 30/300·AI Review 월 3회, Deep Research Pro 이상 30크레딧, Web Search 서차지 8, AI Review 셀프 8 확인 |
| 중요한 누락 기능을 사용자 가치 기준으로 선별했는가? | ✅ 16개 선별. 관리자·내부 기능은 명시적으로 제외 |
| 모든 중대한 판단에 파일 또는 실행 근거가 있는가? | ✅ P1·P2 전 항목에 파일:줄 또는 실행 결과(렌더 HTML / ffmpeg / git log / 포스터 이미지) 첨부 |
| 사실과 추론을 구분했는가? | ✅ 확정/추론/확인 불가 3단계로 표기. 운영 DB 값과 영상 본편 프레임은 `Unverified`·`확인 불가`로 명시 |
| 단순 취향이 아니라 정확성·기대 관리·발견성 관점으로 평가했는가? | ✅ 디자인·톤 평가는 배제. 문제 유형을 지정된 13종 안에서만 사용 |
| 코드 변경 없이 감사 보고서만 작성했는가? | ✅ 제품 코드·문구 미변경. `git status` 클린 상태에서 이 보고서 파일만 추가 |
