# Tomverse Insight — FINAL/STG 독립 재감사 보고서

> 이 문서는 **재감사 기록**입니다. 감사 중 제품 코드, 테스트, snapshot/golden은
> 일절 변경하지 않았습니다. 유일한 저장소 변경은 이 보고서 파일 추가와, 로컬
> 체크아웃을 staging과 동일한 SHA로 fast-forward 한 것뿐입니다.

---

## 1. Executive summary

| 항목 | 값 |
|---|---|
| 재감사 일시 | 2026-07-28 11:21–12:41 UTC (컨테이너 TZ = UTC, 현지시각 동일) |
| 최종 점수 | **69 / 100** |
| 최종 판정 | **Conditional No-Go — Needs operational verification** |
| 검증한 branch | `develop` (작업 branch `claude/tomverse-reaudit-final-stg-r8glem`) |
| local SHA (최종) | `791fef1d0468388f54d8e6d8bfddca55534766c0` |
| origin/develop SHA (최종) | `791fef1d0468388f54d8e6d8bfddca55534766c0` |
| staging SHA (최종) | `791fef1d0468388f54d8e6d8bfddca55534766c0` |
| deployment ID | `55db26e2-5854-4470-83a5-0f89f7e8c2fe` |
| deployment status / time | `success` / started 11:40:27.535Z, deployed 11:45:15.569Z, built 11:43:10.384Z |
| 실제 Provider 호출 수행 | **승인받았으나 미달성** — Turnstile이 자동화 클라이언트를 403으로 차단, Provider 도달 0회 |
| Verified fixed | **5** (FINAL-F001, F003, F004, F005, F006) |
| Partially fixed / Regressed | Partially 1 (FINAL-F002), Regressed 0 |
| 신규 발견점 | **9** (`REAUDIT-F001`–`F009`) |
| 출시 blocker | **1** (운영 경로 미검증 — FINAL-F002) + 선결 권고 P2 5건 |

### 핵심 결론

1. **FINAL-F001·F004·F005·F006은 실제 staging에서 근본 원인까지 해결되었습니다.**
   동의 배너는 `position: static` 정상 흐름으로 바뀌어 Hero/CTA와 교차 면적이
   0이며, 12개 viewport×locale 조합 전부에서 CTA 중심 hit-test가 자기 자신을
   맞췄습니다. 브랜드는 모든 폭에서 `scrollWidth == clientWidth`로 잘리지
   않습니다. Cloudflare beacon 요청은 0건이고 CSP는 완화되지 않았습니다. 영문
   가격 문법과 접근성 문자열도 정확합니다.

2. **FINAL-F002(상용 경로)는 여전히 미검증이며 이번 판정의 단일 최대 blocker입니다.**
   승인을 받아 실제 호출을 시도했으나 `POST /api/chat`가 3건 모두
   `403 TURNSTILE_REQUIRED`로 차단되어 Provider 도달 0회였습니다. 다만 이
   차단 자체가 **credit atomicity의 긍정적 증거**입니다: 차단된 요청에서
   guest 사용량은 `0/20`, credit 추정치는 `3`으로 전혀 변하지 않았습니다.

3. **감사 도중 배포 기준선이 이동했습니다.** 감사 시작 시점 staging은
   `174a62bd`였고, 11:45 UTC에 `791fef1d`로 재배포되었습니다. 이 재배포는
   제가 `174a62bd`에서 **독립적으로 실측한 `/pricing` 320px reflow 결함**
   (overflow 29px, 200% 확대 시 291px)을 고치는 커밋
   (`1454f8c Restore the pricing page's 320px/200% reflow after the font change`)을
   포함했습니다. 즉 이전 감사 이후 font system 변경이 실제로 reflow를
   깨뜨렸고, 재감사 중 수정본이 배포된 것입니다.

4. **그러나 그 수정은 미국 locale에서만 완결됩니다.** `/pricing`은 확대
   상태에서 **브라우저 locale에 따라** 최대 147px 가로 overflow가 재현됩니다
   (`REAUDIT-F001`). 팀이 이 결함을 막으려고 새로 추가한 guard
   `pricing-promotion-reflow.spec.ts`는 브라우저 locale을 전혀 변화시키지
   않기 때문에 동일 조합에서 0px를 보고하며 결함을 통과시킵니다.

5. **접근성에 신규 P2가 다수 있습니다.** desktop 채팅 패널의 모델 전환
   `<select>` 3개가 **접근 가능한 이름이 전혀 없고**(axe `select-name`,
   critical), `/pricing` 요금 비교 표는 436px를 숨긴 채 키보드로 스크롤할 수
   없으며, `/status`는 색 대비 위반이 70건입니다.

---

## 2. Deployment baseline

감사 중 기준선이 한 번 이동했으므로 두 시점을 모두 기록합니다.

### 2.1 감사 시작 시점 (11:21 UTC)

| 기준 | 값 | 일치 여부 |
|---|---|---|
| Local HEAD | `174a62bd67f2f7f2b85e546cd3730c3622542b35` | ✅ |
| origin/develop | `174a62bd67f2f7f2b85e546cd3730c3622542b35` | ✅ 일치 |
| Staging `/api/build-info` | `174a62bd…` / `174a62b` | ✅ 일치 |
| Railway deployment | `4f294a26-638f-4974-a380-e571f134b55e` · `success` | built 08:51:30.654Z · started 08:48:55.922Z · deployed 08:53:21.997Z |

### 2.2 감사 종료 시점 (12:41 UTC) — **현재 검증 대상**

| 기준 | 값 | 일치 여부 |
|---|---|---|
| Local HEAD | `791fef1d0468388f54d8e6d8bfddca55534766c0` | ✅ (fast-forward) |
| origin/develop | `791fef1d0468388f54d8e6d8bfddca55534766c0` | ✅ 일치 |
| Staging `/api/build-info` | `791fef1d…` / `791fef1` | ✅ 일치 |
| Railway deployment | `55db26e2-5854-4470-83a5-0f89f7e8c2fe` · `success` | built 11:43:10.384Z · started 11:40:27.535Z · deployed 11:45:15.569Z |
| environment | `staging` | — |

과거 감사 기준(`73bda8fd…` / deployment `83489687-…`, 그리고 직전 보고서의
`8d02fc1d…`·`e062da86…`)은 **현재 배포물과 무관**하며 검증 대상으로 사용하지
않았습니다.

> **QA traceability 주의**: 감사 실행 중 `origin/develop`와 staging이 동시에
> 이동했습니다. 종료 시점에는 local = origin = staging이 일치하므로 SHA 불일치
> blocker는 **해소**되었으나, 재감사 창(window) 중 배포가 이루어지면 초기
> 측정치와 최종 측정치가 서로 다른 artifact를 가리키게 됩니다. §5
> `REAUDIT-F009` 참조.

---

## 3. FINAL-F001–F006 판정

| ID | 과거 심각도(재구성) | 판정 | Staging 증거 | Test 증거 | 남은 위험 |
|---|---|---|---|---|---|
| FINAL-F001 | P1 | **Verified fixed** | 배너 `position: static`, H1/CTA 교차 0, CTA hit-test 12/12 자기명중 | `marketing-consent-hero.spec.ts` 통과 | 없음 (본문 11px는 정책 하한) |
| FINAL-F002 | P1 (출시 blocker) | **Not verified** (일부 Partially) | `POST /api/chat` ×3 → `403 TURNSTILE_REQUIRED`, Provider 도달 0 | mock E2E 통과 | **출시 blocker 유지** |
| FINAL-F003 | P1 | **Verified fixed** | (staging 인증 경로 미도달) | 소스 dependency 정상 + web-search spec 11건 통과 | staging 실트래픽 미확인 |
| FINAL-F004 | P2 | **Verified fixed** | 전 viewport `scrollWidth==clientWidth`, 가시 텍스트 `Tomverse` | `font-system.spec.ts` 통과 | 없음 |
| FINAL-F005 | P2 | **Verified fixed** | beacon 요청 0건, 동의 전 외부요청 0건, CSP 미완화 | `security:regression` 113건 통과 | 없음 |
| FINAL-F006 | P2 | **Verified fixed** | sr 문자열 `USD 7.50 per month` 정상 | `pricingFormat.test.mjs`, `pricing-accessible-price.spec.ts` 통과 | 통화 표기가 `REAUDIT-F001` 유발 |

### FINAL-F001 — 320px 동의 배너가 Hero/CTA를 가림

**판정: Verified fixed.**

배너는 `data-testid="marketing-consent-slot"` 안에서 `position: static`,
`z-index: auto`로 렌더링됩니다. 즉 overlay가 아니라 문서 흐름의 한 블록입니다.

| viewport | notice rect | H1 y | 배너×H1 교차 | 배너×CTA 교차 | CTA hit-test | overflow |
|---|---|---|---|---|---|---|
| 320×568 `/` | x0 y65 w320 h94 | 313 | 0 | 0 | 1/1 자기명중 | 0 |
| 360×640 `/` | x0 y65 w360 h78 | 297 | 0 | 0 | 1/1 | 0 |
| 375×667 `/` | — | 282 | 0 | 0 | 1/1 | 0 |
| 390×844 `/` | x0 y65 w390 h74 | 278 | 0 | 0 | 1/1 | 0 |
| 430×932 `/` | — | 278 | 0 | 0 | 1/1 | 0 |
| 667×375 landscape | — | 324 | 0 | 0 | 1/1 | 0 |
| 320×568 guest chat | x32 y435.5 w256 h94 | — | — | — | 3/3 | 0 |

en/ko 양쪽 24개 조합 전부 동일했습니다.

- **동의 action 크기**: en `Decline` 58.8×44, `Allow analytics` 48.2×44 /
  ko `거부` 44×44, `분석 허용` 44×44 → 전부 44×44 충족.
- **본문 판독 폭**: 320px marketing에서 최장 라인 **147.8px, 3줄, 11px**;
  guest chat notice는 **119px, 4줄, 11px**. 직전 보고서가 다투었던
  116.8px 수치는 사실상 재현되나, 3–4줄로 정상 절단되어 판독 가능하므로
  판정 기준은 통과합니다. 다만 11px는 프로젝트 자체 타이포그래피 계약의
  **하한선**이라 여유가 없습니다.
- **키보드**: `/`에서 Tab 4회에 `analytics-consent-decline`, 5회에
  `analytics-consent-accept` 도달. guest chat에서는 각각 10·11회. Enter로
  활성화되고 배너가 닫히며 `analytics-settings-button` 재설정 수단이 남습니다.
  Decline이 Accept보다 먼저 오고 두 버튼의 크기·형태가 동등해 dark pattern이
  아닙니다. focus indicator는 `box-shadow` ring으로 존재합니다.
- **회귀 교차검사**: marketing 배너 수정이 chat composer(STG-F001)를 되돌리지
  않았습니다 — §4 참조.

### FINAL-F002 — 기본 Provider 경로 / 3-model 상용 가용성

**판정: Not verified (운영), 근거 일부는 Partially verified.**

**승인된 실제 검증 시도 결과** (2026-07-28 12:09 UTC, guest, 390×844):

```
POST /api/chat  ×3  →  403  {"error":"Guest verification is required.","code":"TURNSTILE_REQUIRED"}
Provider 도달: 0회 · 소비 credit: 0 · guest usage: 0/20 (변화 없음)
```

클라이언트는 모델당 1건씩 정확히 3건을 팬아웃했고, 서버 가드가 세 건 모두를
Provider 이전 단계에서 차단했습니다. **미소비 요청에 과금이 발생하지 않는다는
점은 확인**되었으나, 이는 성공 경로의 credit 정산·환불을 증명하지 않습니다.

**공개 Provider 상태 실측 (2026-07-28 12:29 UTC, `/status` + `/api/models/status`)**

| Provider | 공개 상태 | 근거 유형 | Last known good | Last real-traffic | Last automated check | 연속 실패 |
|---|---|---|---|---|---|---:|
| OpenAI | Operational | synthetic probe | 07-28 06:48 UTC | 07-28 06:48 UTC | 07-28 12:20 UTC | 0 |
| Anthropic | Operational | synthetic probe | 07-28 04:59 UTC | 07-28 04:59 UTC | 07-28 12:20 UTC | 0 |
| Google Gemini | **Incident** | synthetic probe | 07-28 05:02 UTC | 07-28 05:02 UTC | 07-28 12:20 UTC | 4 |
| Groq | Degraded | real traffic | Not recorded | 07-28 04:59 UTC | 07-28 12:20 UTC | — |
| xAI | Operational | synthetic probe | Not recorded | **Never** | 07-28 12:20 UTC | 0 |
| DeepSeek | Operational | synthetic probe | Not recorded | **Never** | 07-28 12:20 UTC | 0 |
| Mistral | Degraded | real traffic | 07-28 04:59 UTC | 07-28 05:02 UTC | 07-28 12:20 UTC | — |
| Moonshot Kimi | Operational | synthetic probe | Not recorded | **Never** | 07-28 12:20 UTC | 0 |
| Qwen | Operational | synthetic probe | Not recorded | **Never** | 07-28 12:21 UTC | 0 |
| Zhipu GLM | Operational | synthetic probe | Not recorded | **Never** | 07-28 12:20 UTC | 0 |
| Perplexity | **Incident** | synthetic probe | Not recorded | **Never** | **07-27 23:30 UTC** | **202** |

과거 보고서의 `71회 실패` 수치는 재사용하지 않았습니다. 현재 Perplexity 카운터는
**202**입니다.

**상태의 정직성 — 양호한 점**

- `/status` 첫 문단이 명시적으로 선언합니다: *"A provider only shows Operational
  when a successful request was recently recorded for it — the absence of a
  detected incident is not, by itself, evidence that a provider is working."*
- 모든 항목이 synthetic probe인지 real traffic인지 괄호로 구분합니다.
- freshness window(30분) 밖의 성공이 Operational 근거로 쓰이지 않습니다.
- **상태 API와 채팅 UI가 일치**합니다. 이전 감사의 UX-002(모델 가용성 API가
  내부 enum을 읽어 `/status`와 모순)는 소스에서 `provider.publicStatus`를 읽도록
  수정되었고, staging에서 Perplexity 4개 모델이 `unavailable`인 것과 채팅 배너의
  `4 unavailable`이 정확히 일치했습니다.
- Google이 감사 중 `operational`(11:22) → `degraded`(12:06) → `incident`(12:29)로
  실제 전이했습니다. 카운터가 동결되어 있지 않다는 강한 증거입니다.

**기본 3-model 구성 (staging 실측)**

`GUEST_BRAND_TRIO_MODEL_IDS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"]`

| 모델 | Provider | 현재 status | creditWeight |
|---|---|---|---:|
| GPT-5.4 mini | openai | available | 1 |
| Claude Haiku 4.5 | anthropic | available | 1 |
| Gemini 3.1 Flash-Lite (`gemini-2-5-flash`) | google | **unavailable (incident)** | 1 |

첫 paint 모델 수 3, 예상 credit 3으로 UI 전반이 일치합니다. 기본 3종 중 하나가
**현재 incident 상태**이지만, 앱은 이를 침묵으로 대체하지 않고
`provider-outage-banner`로 고지하고 사용자 선택형 교체를 제안합니다 —
자동·무고지 교체는 관측되지 않았습니다. 다만 그 제안 자체에 문제가 있습니다
(`REAUDIT-F006`).

**Pass 조건 대비**: OpenAI/Anthropic은 freshness window 내 성공 근거 확보,
상태와 관측 결과의 모순 없음, incident 고지 존재 — 여기까지는 충족. 그러나
**승인된 실제 3-model 요청 3회 성공·AI Review 성공·expected/actual credit 일치는
전혀 확인하지 못했으므로 `Not verified`**이며, 전체 판정은 규정대로 최소
`Needs operational verification`으로 유지합니다.

### FINAL-F003 — comparison preflight가 stale `off`를 전송

**판정: Verified fixed (소스 + 자동화 근거). staging 실트래픽은 미확인.**

- `app/(application)/chat/ChatPageClient.tsx:1054` — preflight callback의
  dependency 배열에 `webSearchMode`가 **포함**되어 있어 stale closure가
  성립하지 않습니다.
- `:682` — credit 추정 callback도 동일하게 `webSearchMode`를 의존합니다.
- **lint 억제로 숨기지 않았습니다**: 저장소 전체 `react-hooks/exhaustive-deps`
  억제는 5곳뿐이고(`ChatPageClient.tsx:1656/1670/1737`,
  `SignInPageContent.tsx:115`, `AuthButton.tsx:269`) 전부 guest-import 및 초기
  대화 부트스트랩 관련으로, `webSearchMode`와 무관합니다.
- **임의 ref로 React 상태 계약을 우회하지 않았습니다.** `webSearchMode`는
  `useState`로만 읽히며 관련 ref가 없습니다.
- `npx eslint . --max-warnings=0` → **통과 (경고 0)**.
- 단일 의미 계약: `lib/webSearchCredits.ts`가 UI 추정·preflight·서버 예약의
  단일 출처이며, `lib/webSearchComposerState.ts`가 chip/예외행/surcharge를
  같은 입력에서 파생시킵니다.

**Credit matrix** — `WEB_SEARCH_SURCHARGE_CREDITS = 8`(`lib/models.ts:58`)이
현재도 유효하며 **native 지원 모델에만** 적용됩니다
(`modelEligibleForWebSearchSurcharge`: `support === "native"`).

| Native-capable 모델 수 | 기대 search surcharge | 자동화 확인 |
|---:|---:|---|
| 0 | +0 | `web-search-composer-state.spec.ts` "no capable model blocks…" 통과 |
| 1 | +8 | 단위테스트 통과 |
| 2 | +16 | `native-web-search.spec.ts:451` — base 12 + 2×8 = **28** 검증 통과 |
| 3 | +24 | 단위테스트 통과 |
| 혼합(2 native + 1 미지원) | +16 | "mixed supported/unsupported…" 통과 |

미지원 모델에 비용이 잘못 가산되지 않음이 spec으로 고정되어 있습니다.

**한계**: staging 인증 세션에 도달하지 못해 `/api/chat/preflight`와 `/api/chat`의
**실제 request body를 staging에서 캡처하지는 못했습니다.** 8개 상태 전이의
런타임 캡처는 로컬 mock 환경 근거에 의존합니다.

### FINAL-F004 — 320px 브랜드가 `T.`로 축약

**판정: Verified fixed.**

| viewport | 가시 텍스트 | sr-only | link w | scrollWidth/clientWidth | 잘림 |
|---|---|---|---:|---|---|
| 320 / 360 / 375 / 390 / 430 / 667 (en) | `Tomverse` | `Tomverse Insight` | 110.1 | 110 / 110 | ❌ 없음 |
| 320 (ko) | `Tomverse` | `Tomverse Insight` | 110.8 | 111 / 111 | ❌ 없음 |
| 320 @200% | `Tomverse` | `Tomverse Insight` | — | 동일 | ❌ 없음 |

- `T.` 같은 의미 손실 절단은 어느 조합에서도 재현되지 않았습니다.
- 가시명 `Tomverse`가 접근명 `Tomverse Insight`의 부분 문자열이므로 WCAG 2.5.3
  (Label in Name) 의미 일치 요건을 충족합니다.
- header overflow 0, navigation·핵심 action 조작 가능.
- 스크린샷 증거: `shots/320x568__pricing_en-AU_z1.png`에서 `Tomverse` 전체 표기가
  육안으로 확인됩니다.

### FINAL-F005 — Cloudflare Browser Insights beacon CSP 위반

**판정: Verified fixed. 정책 = "Browser Insights를 사용하지 않는다".**

`lib/csp.ts` 주석이 정책을 명문화합니다: beacon 호스트를 허용하지 않고
Cloudflare 쪽에서 Browser Insights를 끄는 것이 합의된 해법.

**실측 (fresh context, cache 없음, 24개 route×viewport 조합)**

- `cloudflareinsights` / `beacon.min.js` 요청: **0건**
- 주입된 third-party script: **0건**
- 설명되지 않은 console error: **0건**
- 동의 이전 외부 요청: **0건** (`/`, guest chat 모두)
- `Decline` 이후 외부 요청: **0건**
- `Accept` 이후: `www.googletagmanager.com/gtag/js` **만** 로드 → 동의 게이트 정상

**보안 회귀 점검 (staging 실제 응답 헤더)**

| 항목 | marketing (`/`, `/pricing`, `/privacy`) | app (`/chat`) |
|---|---|---|
| script-src | `'self'` + sha384 해시 8개 + 명시 origin 4개 | `'self' 'nonce-…' 'strict-dynamic'` + 명시 origin |
| `'unsafe-inline'` (script) | ❌ 없음 | ❌ 없음 |
| `'unsafe-eval'` | ❌ 없음 | ❌ 없음 |
| wildcard script origin | ❌ 없음 | ❌ 없음 |
| `object-src` / `base-uri` / `frame-ancestors` | `none` / `self` / `none` | 동일 |
| `Cache-Control` | `public, s-maxage=3600` (공개 마케팅) | `private, no-cache, no-store, must-revalidate` ✅ |
| HSTS | `max-age=31536000; includeSubDomains` | 동일 |
| `X-Frame-Options` / `X-Content-Type-Options` / COOP | `DENY` / `nosniff` / 설정됨 | 동일 |
| CSP report | `report-uri /api/security/csp-report` + `report-to` | 동일 |

`style-src-attr 'unsafe-inline'`은 속성 스타일에 한정된 기존 설계이며 이번에
확대되지 않았습니다. console error를 필터링해 숨긴 흔적은 없습니다.

### FINAL-F006 — 영문 요금제 문법 (`1 credits`, `/ per month`)

**판정: Verified fixed.**

`lib/pricingFormat.ts`가 CLDR `Intl.PluralRules` 기반 단수/복수와 언어별 기간
연결자를 단일 지점에서 결정합니다(en/fr/de/es/pt는 공백, ko/zh는 ` / `).

**staging 실측 접근성 문자열 (en, 320px)**

| plan | sr-only 문자열 | 판정 |
|---|---|---|
| Free | `USD 0.00 per month` | ✅ 중복 slash 없음 |
| Pro | `USD 7.50 per month. Regular: USD 15.00 per month.` | ✅ `/ per month` 없음, `$15per month` 없음 |
| Max | `USD 12.50 per month. Regular: USD 25.00 per month.` | ✅ |

- 가시 표기는 `USD 7.50` + 별도 span `per month`이며, 그 쌍은 `aria-hidden`,
  음성 표현은 sr-only span이 한 번만 제공 → 직전 감사가 지적한 `$15per month`
  결합 결함이 **해소**되었습니다.
- 복수형: `300 monthly AI credits`, `3,000 …`, `10,000 …` 정상. 신용 팩은
  `credits`. 단수 `1 credit` 경로는 `tests/pricingFormat.test.mjs`가 고정합니다.
- ko: `3개 모델`, `US$7.50` 등 정상. hydration 전후 가격 문자열 변화 없음.
- 가격 계산 자체는 변경되지 않았습니다(`formatBillingAmount`는 표기만 담당).

**단, 통화 표기 방식이 `REAUDIT-F001`의 직접 원인입니다** — §5 참조.

---

## 4. STG-F001–F010 회귀 matrix

| ID | 판정 | 검증 방법 | 증거 | 비고 |
|---|---|---|---|---|
| STG-F001 chat 동의 notice | **Pass** | staging 브라우저 실측 | notice `static`, composer 5개 control 전부 `coveredByNotice=false`·자기명중, overflow 0 | 320/360/390 |
| STG-F002 768–1024 comparison | **Partially verified** | staging 실측 | 4개 폭 전부 overflow 0, sidebar rail 64px 자동 축소, desktop shell | 실제 비교 패널은 Turnstile로 미도달 |
| STG-F003 IME/Enter 정책 | **Not verified (실기기)** | 자동화만 | `chat-keyboard-policy.spec.ts` 통과 | 물리 키보드·모바일 IME 미검증 |
| STG-F004 근거 기반 상태 | **Pass** | staging `/status` + API | probe/traffic 구분 명시, freshness 30분, Unknown 0, incident 근거 서술 | `REAUDIT-F007/F008` 단서 |
| STG-F005 Touch target | **Pass (관찰 1건)** | staging 실측 | 모든 composer 버튼 ≥44×44 | `chat-textarea` 높이 36px (폭 258–328px) |
| STG-F006 First-paint credit | **Pass** | 0/100/500/1500/3000ms 샘플링 | 0–100ms 미표시 → 500ms부터 `3 credits / 3 AIs / 3 models` 고정 | 잘못된 값으로의 flicker 없음 |
| STG-F007 Source grounding | **Not verified** | — | guest 빈 상태에 라벨 미노출, 비교 결과 도달 불가 | `source-grounding.spec.ts` 통과 |
| STG-F008 Model picker | **Pass** | staging 실측 | `model-recommendations`/`model-picker-open-all`/`open-filters`/`model-search-input` 존재, 카탈로그 32행 | 320px에서 완전 가시 행 1개(팀 기준 최소 1 충족) |
| STG-F009 Mobile model summary | **Pass** | staging 실측 | 접근명 `GPT-5.4 mini and 2 more models selected. 3 active models total.` / ko 동일 | 가시 라벨은 의도적으로 `3 models` |
| STG-F010 Build information | **Pass** | `/api/build-info` | environment·full/short SHA·builtAt·deploymentId·startedAt·deployedAt·status 전부 존재 | 실제 배포와 일치, 민감정보 없음 |

### 회귀 없음 확인

`STG-F001`–`F010` 중 **Regressed 판정은 0건**입니다. 미검증 3건
(`STG-F003` 실기기, `STG-F007`, `STG-F002` 일부)은 전부 Turnstile/실기기 부재라는
환경 제약이며 결함 징후가 관측된 것이 아닙니다.

---

## 5. 신규 발견점

### REAUDIT-F001 — `/pricing` 확대 시 브라우저 locale에 따라 가로 overflow

- **심각도**: P2 (High)
- **분류**: 반응형 / 국제화 / 접근성(WCAG 1.4.10 Reflow)
- **대상 사용자**: 125–150% 확대에서는 **미국 외 locale 사용자만**(ko-KR 포함),
  200% 확대에서는 **en-US·de-DE를 포함한 전 locale**
- **과업**: 요금제 비교 후 결제 플랜 선택
- **기대**: 320/390px 기준 125–200% 확대에서도 가로 스크롤 0
- **실제**: locale에 따라 28–147px overflow. 통화 표기가 길수록 커집니다
  (`USD 7.50` > `US$7.50` > `7,50 $` ≈ `$7.50`)

| 브라우저 locale | 가격 표기 | 320@100% | 320@125% | 320@200% | 390@150% |
|---|---|---:|---:|---:|---:|
| en-US | `$7.50` | 0 | 0 | 66 | 0 |
| **en-AU** | `USD 7.50` | 0 | **51** | **147** | **47** |
| **en-GB** | `US$7.50` | 0 | **39** | **135** | **35** |
| **ko-KR** | `US$7.50` | 0 | **32** | **128** | **28** |
| de-DE | `7,50 $` | 0 | 0 | 77 | 0 |

- **영향**: 전환 페이지에서 확대 사용자(저시력 포함)가 가격·CTA 일부를 잃습니다.
  `document`가 `overflow-x` 스크롤을 제공하지 않아 잘린 부분에 **도달할 수
  없습니다**(`maxScrollLeft = 0`).
- **재현**: Chromium, viewport 256×675(=320@125%), `locale: "en-AU"`,
  `https://staging.tomverse.app/pricing` → `documentElement.scrollWidth - clientWidth = 51`
- **source evidence**: `lib/billingMarkets.ts:59` —
  `new Intl.NumberFormat(locale, { style: "currency", currency })`가
  `components/marketing/PricingPageContent.tsx:882`에서 **`locale: undefined`**로
  호출됩니다. 따라서 통화 표기는 서버 설정이 아니라 **뷰어의 브라우저 locale**이
  결정하며, 비-US locale에서 `USD 7.50`/`US$7.50`처럼 3–4자 길어진 문자열이
  `span.text-5xl.font-black`에 들어가 카드 min-content를 밀어냅니다.
- **staging evidence**: 위 표 (2026-07-28 12:20 UTC, `791fef1d`)
- **테스트 무결성 관점 (중요)**: 이 결함을 막기 위해 방금 추가된 guard
  `tests/e2e/pricing-promotion-reflow.spec.ts`는 `lang` 쿼리(UI 카피)만
  바꾸고 **브라우저 locale을 고정**하므로 동일 조합에서 `promotion=0px
  baseline=0px offender=null`을 출력하며 통과합니다. 로컬 16개 중 15개 통과 —
  **guard가 배포물을 보호하지 못합니다.**
- **권장**: `formatBillingAmount` 호출부에 표시 locale을 명시 전달하거나
  `currencyDisplay: "narrowSymbol"`을 사용하고, guard에 `browser locale` 축을
  추가.
- **완료 조건**: en-US/en-AU/en-GB/ko-KR/de-DE × {320,390} × {100,125,150,200}%
  40개 조합 전부 overflow ≤1px, 그리고 그 조합이 CI에서 실행될 것.

### REAUDIT-F002 — `/pricing` 요금 비교 표를 키보드로 스크롤할 수 없음

- **심각도**: P2 · **분류**: 접근성 (WCAG 2.1.1 Keyboard, A)
- **기대**: 가로 스크롤 영역에 키보드 도달 수단 제공
- **실제**: 390px에서 스크롤러가 `scrollWidth 760 / clientWidth 324`로
  **436px를 숨기면서** `tabIndex: -1`, `role` 없음, `aria-label` 없음,
  **내부 포커스 가능 요소 0개**
- **영향**: 키보드·스위치 사용자는 Pro/Max 열 비교가 **불가능**합니다. 이 표는
  페이지 overflow를 막아주는 정상 설계이지만, 그 대가로 키보드 사용자에게
  콘텐츠가 사라집니다.
- **staging evidence**: `div.mt-8.overflow-x-auto`, axe
  `scrollable-region-focusable` (serious)
- **권장**: 스크롤러에 `tabindex="0"` + `role="region"` + 접근명 부여.
- **완료 조건**: 키보드만으로 Max 열 도달, axe `scrollable-region-focusable` 0.

### REAUDIT-F003 — desktop 채팅 모델 전환 `<select>`에 접근 가능한 이름이 없음

- **심각도**: P2 · **분류**: 접근성 (WCAG 4.1.2 Name/Role/Value, A) · axe **critical**
- **실제**: 1280px 채팅 화면의 모델 패널 3개 각각에 `<select>`가 있으나
  `id`+`<label>`, `aria-label`, `aria-labelledby`, `title`이 **전부 없음**
- **영향**: 스크린리더는 "combo box"만 읽어, 어느 패널의 모델을 바꾸는지
  구분할 수 없습니다. 잘못된 패널의 모델을 바꾸면 credit이 소비됩니다.
- **staging evidence**: axe `select-name` critical ×3,
  `aria-prohibited-attr` serious ×3 (`div[data-model-id="gpt-5-4-mini"]` 내
  `span`에 role 없이 `aria-label`)
- **완료 조건**: 각 select가 패널 모델명을 포함한 고유 접근명을 갖고 axe 0.

### REAUDIT-F004 — 색 대비 위반 (`/status` 70건, `/pricing` 27건, `/` 4건)

- **심각도**: P2 · **분류**: 접근성 (WCAG 1.4.3, AA)
- **실제**:
  - `/status`: `#71717b` 계열 라벨 대비 **3.87** (70개 노드, mobile·desktop 동일)
  - `/pricing`: 강조 플랜 카드의 `#ffffff` 텍스트 대비 **2.47** (27개 노드)
  - `/`: `#71717b` 대비 **4.12** (4개 노드)
- **영향**: 상태 페이지는 신뢰 커뮤니케이션의 핵심인데 위반 밀도가 가장 높습니다.
- **완료 조건**: 대비 ≥4.5:1 (대형 텍스트 ≥3:1), axe `color-contrast` 0.

### REAUDIT-F005 — marketing 언어 선택 `select`에 가시적 포커스 표시가 없음

- **심각도**: P3 · **분류**: 접근성 (WCAG 2.4.7 Focus Visible, AA)
- **실제**: `document.activeElement`가 해당 select인 상태에서
  `outline: none 0px`, `box-shadow: none` — 포커스 전후 스크린샷이 동일
  (`shots/focus-00-none.png` vs `shots/focus-01-langselect.png`)
- **비고**: 같은 헤더의 브랜드 링크·CTA·동의 버튼은 정상적으로 표시됩니다.
  이 컨트롤만 예외입니다. 접근명 `Language`는 정상.

### REAUDIT-F006 — 불가용 모델의 대체 추천이 degraded provider로 유도됨

- **심각도**: P2 · **분류**: 신뢰 / 운영
- **기대**: 복구 경로는 최소한 현재 건강한 provider를 우선 제시
- **실제**: incident 상태 `gemini-2-5-flash`의 배너가
  `Try: Mistral Small 4, Llama 3.1` / `Switch Gemini 3.1 Flash-Lite for Mistral Small 4`를
  제시하지만, **Mistral·Groq 모두 Degraded**이며 그 사실을 알리지 않습니다.
- **source evidence**: `/api/models/status`의
  `fallbackModelIds: ["gpt-5-4-mini","mistral-small-4","llama-3-1"]`은 모델
  레지스트리의 **정적** 목록이며 실시간 provider 건강도로 필터·정렬되지 않습니다.
  유일한 operational 대안(`gpt-5-4-mini`)은 이미 선택되어 있어 제외되고, 남은
  제안이 전부 degraded가 됩니다.
- **영향**: incident에서 벗어나려는 사용자를 또 다른 실패 확률이 높은 경로로
  보내고, 실패 시 부분 비교와 재시도로 이어집니다.
- **완료 조건**: fallback 후보를 `publicStatus`로 필터/정렬하고, 남은 후보가
  degraded뿐이면 그 사실을 표기.

### REAUDIT-F007 — `Last known good: Not recorded`와 `Operational`이 동시에 표시됨

- **심각도**: P3 · **분류**: 신뢰 / 상태 투명성
- **실제**: xAI·DeepSeek·Moonshot·Qwen·Zhipu 5개 provider가
  `Last known good: Not recorded` + `Last real-traffic check: Never`이면서
  동시에 `Operational` + "probe가 30분 내 성공했다"를 표시합니다.
- **영향**: 같은 카드 안에서 "성공 기록 없음"과 "최근 성공"이 충돌해 독자가
  근거를 신뢰하기 어렵습니다. 11개 중 5개가 **실 트래픽을 한 번도 처리한 적이
  없다**는 사실도 상용 준비도 관점에서 별도 위험입니다.
- **권장**: `Last known good`이 실트래픽만 반영한다면 라벨을
  `Last real-traffic success`로 바꾸거나, probe 성공 시각을 함께 표기.

### REAUDIT-F008 — Perplexity probe가 약 13시간 정지했는데 Incident를 계속 단정

- **심각도**: P3 · **분류**: 운영 / 상태 정직성
- **실제**: 다른 10개 provider는 12:20–12:21 UTC에 점검되었으나 Perplexity는
  `Last automated check: 2026-07-27 23:30 UTC` — **약 13시간 정지**. 그럼에도
  `202 consecutive automated probes have failed`를 근거로 Incident를 단정합니다.
- **영향**: freshness 정책이 비대칭입니다. 낡은 성공은 Operational 근거로
  쓰지 않으면서, 낡은 실패는 Incident 근거로 계속 사용합니다. 또한 4개
  Perplexity 모델이 계속 `unavailable`로 잠깁니다.
- **권장**: probe 정지 자체를 감지해 `Unknown` + "점검 중단" 사유로 표기하고,
  probe 스케줄러 정지 원인을 조사.

### REAUDIT-F009 — 재감사 창 중 배포 기준선 이동 (QA traceability)

- **심각도**: P3 · **분류**: 프로세스 / QA 추적성
- **실제**: 감사 시작 11:21 UTC에 `174a62bd`였던 staging이 11:45 UTC에
  `791fef1d`로 재배포되었습니다. 초기 Phase 1 측정(24개 조합)은 이전
  artifact를 대상으로 수행되어 전량 재실행이 필요했습니다.
- **영향**: 감사 산출물과 배포물의 연결이 일시적으로 끊어졌습니다. 종료 시점에
  local = origin = staging이 일치하므로 blocker는 아니지만, 재감사 창에는
  staging 배포를 동결하는 절차가 필요합니다.
- **부수 관측**: 이 이동 덕분에 `174a62bd`의 `/pricing` 320px reflow 결함
  (overflow 29px / 200% 확대 291px)을 실측할 수 있었고, 이는 같은 창에 배포된
  수정 커밋 `1454f8c`의 문제 인식과 정확히 일치했습니다.

### 별도 관측 (발견점 미등록)

- `gemini-2-5-flash`의 표시명이 `Gemini 3.1 Flash-Lite`로, 모델 ID와 노출명이
  세대까지 어긋납니다. 장애 대응·지원 문의 시 혼동 위험이 있습니다.
- guest chat 동의 본문과 marketing 동의 본문이 **11px**로, 프로젝트 자체
  타이포그래피 계약의 하한선에 정확히 걸쳐 있습니다.

---

## 6. 테스트 결과

| Suite | Command | Pass | Fail | Skip | 최초/재실행 | 분류 |
|---|---|---:|---:|---:|---|---|
| Typecheck | `npm run typecheck` | ✅ | 0 | — | 최초 | — |
| Lint (zero-warning) | `npx eslint . --max-warnings=0` | ✅ | 0 | — | 최초 | — |
| Unit | `npm run test:unit` | **523** | 0 | 0 | 최초 | — |
| Security regression | `npm run security:regression` | **113** | 0 | — | 최초 | — |
| Text encoding | `npm run check:encoding` | ✅ | 0 | — | 최초 | — |
| Accent tokens | `npm run check:accent-tokens` | ✅ (10 files/10 roles) | 0 | — | 최초 | — |
| Production build | `npm run build` | ✅ | 0 | — | 최초 | — |
| E2E desktop | `playwright test --project=desktop-chromium` | **518** | **53** | 73 | 최초 | 아래 분류 |
| E2E mobile+compact | `--project=mobile-chromium --project=desktop-compact` | **573** | **4** | 711 | 최초 | 아래 분류 |
| Pricing reflow (격리) | `pricing-promotion-reflow.spec.ts` | 15 | 1 | — | 격리 1회 | Confirmed (부분) |
| Model picker 320 (격리) | `model-picker-limit-state.spec.ts` | 0 | 1 | — | **격리 3회 반복** | Environment |
| Signin analytics target (격리) | `analytics-settings-target.spec.ts` | 3 | 0 | — | **격리 3회 반복** | **Flake — 미해결** |

### 실패 분류

| 실패군 | 건수 | 분류 | 근거 |
|---|---:|---|---|
| `chat-state-visual-regression.spec.ts` golden 불일치 | 52 | **Environment problem** | golden은 Playwright chromium **v1234 (Chromium 151)** 기준. 이 환경은 v1194 (**Chromium 141**)만 설치되어 있고 `cdn.playwright.dev`가 egress 정책상 **403 host not permitted**로 차단되어 정본 브라우저 설치 불가. 차이는 전체 픽셀의 **1–4%**이며 대부분 `-ko` (한글 글리프) 스냅샷에 집중 — 레이아웃 파손이 아닌 래스터화 차이 패턴 |
| `pricing-promotion-reflow` 320@200%(en) | 3 (프로젝트 3종) | **Confirmed product regression (부분)** | 로컬 4px. 동일 결함군이 staging에서 locale별 32–147px로 훨씬 크게 재현 → `REAUDIT-F001` |
| `model-picker-limit-state` 320×568 | 1 | **Environment problem** | 로컬 3/3 결정적 실패이나, **실제 staging에서는 통과**: 320×568에서 완전 가시 행 **1개**(기준 ≥1), 390×844에서 **3개**(기준 ≥2). 브라우저 빌드 차이로 행 높이가 달라진 결과 |
| `analytics-settings-target` signin | 1 | **Flake / race — 미해결** | 전체 실행에서 실패, 격리 3회 전부 통과. 규정대로 **단독 통과만으로 해결을 주장하지 않습니다**. 병렬 실행 시 상태·포커스 경합 가능성 |

### 알려진 과거 flake 재확인

| 과거 flake | 이번 결과 |
|---|---|
| `mediaSecurity` 병렬 실패 | 재현 없음 (unit 523건 전량 통과) |
| multiline send 간헐 실패 | 재현 없음 |
| authenticated conversation bootstrap | 재현 없음 |
| visual-regression timing | 이번 환경에서는 브라우저 버전 차이에 가려져 **판별 불가** |

### 테스트 무결성 점검

- 의미 있는 assertion 삭제: 관측되지 않음. 오히려 `791fef1d`에서
  `pricing-promotion-reflow.spec.ts`(198줄), `signin-hydration.spec.ts`,
  `ui-state-contrast.spec.ts` 등 신규 커버리지가 추가되었습니다.
- skip 증가: E2E skip은 대부분 **project 스코프**(desktop 실행 시 mobile 전용
  테스트가 skip)에 의한 것이며 억제성 skip이 아닙니다.
- timeout 과도 증가: 관측되지 않음.
- golden 무검토 갱신: `cc34def Re-record the chat state goldens for the new font
  system`은 font system 변경에 따른 **의도적** 재기록으로 커밋 메시지에 사유가
  명시되어 있습니다.
- **mock이 실제 regression을 숨긴 사례 1건 확인**: `REAUDIT-F001` — guard가
  브라우저 locale을 고정해 staging의 실제 결함을 통과시킵니다. 이는 이번 감사에서
  가장 중요한 테스트 무결성 지적입니다.

---

## 7. 접근성

| 항목 | 판정 | 자동(axe) | Keyboard | 실기기 | 비고 |
|---|---|---|---|---|---|
| 동의 focus order | Pass | — | ✅ Tab 4–5회 도달 | ❌ | Decline 우선, 논리적 |
| Accept/Reject 동등성 | Pass | — | ✅ 둘 다 Enter 활성 | ❌ | 크기·형태 동등, dark pattern 없음 |
| marketing CTA | Pass | ✅ | ✅ 자기명중 | ❌ | 12/12 조합 |
| brand link | Pass | ✅ | ✅ outline 표시 | ❌ | 가시명 ⊂ 접근명 |
| composer controls | Pass | ✅ | ✅ | ❌ | 전부 ≥44×44 |
| Touch target | Pass (관찰) | — | — | ❌ | `chat-textarea` 높이 36px |
| model picker | Pass | ✅ | ✅ | ❌ | 320px 완전 가시 1행 |
| Source grounding tooltip | **Not verified** | — | — | ❌ | 비교 결과 미도달 |
| pricing accessible text | Pass | — | — | ❌ | sr 문자열 정확 |
| pricing 비교 표 | **Fail** | ❌ `scrollable-region-focusable` | ❌ 도달 불가 | ❌ | `REAUDIT-F002` |
| 채팅 모델 select | **Fail** | ❌ `select-name` (critical ×3) | — | ❌ | `REAUDIT-F003` |
| 색 대비 | **Fail** | ❌ 70/27/4건 | — | ❌ | `REAUDIT-F004` |
| 언어 선택 focus | **Fail** | — | ❌ 표시 없음 | ❌ | `REAUDIT-F005` |
| Provider status semantics | Pass | ✅ (대비 제외) | ✅ | ❌ | 근거 서술 명확 |

### 상태별 확인

| 상태 | 결과 |
|---|---|
| keyboard only | ✅ 동의·CTA·composer 도달. positive `tabindex` **0개** |
| 200% 확대 | ⚠️ `/`·`/privacy`·guest chat 0 overflow, **`/pricing` 실패** |
| 320px reflow | ✅ 4개 route 전부 0 (100% 배율) |
| forced-colors | ✅ 3개 route overflow 0, console error 0 |
| prefers-reduced-motion | ✅ 동일 |
| coarse pointer | ✅ `isMobile`+`hasTouch` 컨텍스트로 측정 |
| dark / light | ✅ 양쪽 overflow 0 |
| 한국어 / 영어 | ✅ 24개 조합 측정 |
| 긴 locale / RTL | **Not verified** — 대표 RTL locale 미측정 |

### 명시적 미검증 (실기기·보조기술)

**VoiceOver, TalkBack, NVDA/JAWS, 삼성 키보드, Gboard, iOS 한국어 키보드,
물리적 모바일 기기, 모바일 외부 keyboard는 이번 감사에서 일절 사용하지
않았습니다.** 자동 axe 검사만으로 WCAG 전체 통과를 주장하지 않습니다.

---

## 8. 운영 상태

기준 시각 **2026-07-28 12:29 UTC** (표기 전부 UTC).

| Provider | 공개 상태 | Probe freshness | Traffic success | 연속 실패 | 실제 호출 | 판정 |
|---|---|---|---|---:|---|---|
| OpenAI | Operational | 12:20 (9분 전) | 06:48 | 0 | ❌ 미수행 | 근거 유효 |
| Anthropic | Operational | 12:20 | 04:59 | 0 | ❌ | 근거 유효 |
| Google Gemini | **Incident** | 12:20 | 05:02 | 4 | ❌ | 기본 모델 포함 — 위험 |
| Groq | Degraded | 12:20 | 04:59 | — | ❌ | 근거 유효 |
| xAI | Operational | 12:20 | **Never** | 0 | ❌ | probe 전용 |
| DeepSeek | Operational | 12:20 | **Never** | 0 | ❌ | probe 전용 |
| Mistral | Degraded | 12:20 | 05:02 | — | ❌ | 근거 유효 |
| Moonshot Kimi | Operational | 12:20 | **Never** | 0 | ❌ | probe 전용 |
| Qwen | Operational | 12:21 | **Never** | 0 | ❌ | probe 전용 |
| Zhipu GLM | Operational | 12:20 | **Never** | 0 | ❌ | probe 전용 |
| Perplexity | **Incident** | **07-27 23:30 (약 13h 정지)** | **Never** | **202** | ❌ | `REAUDIT-F008` |

집계: Operational 7 · Degraded 2 · Incident 2 · Unknown 0.

### 원인 분류 (read-only 범위)

| 후보 원인 | 판단 |
|---|---|
| 외부 Provider 장애 | **가능** — Google 4연속·Mistral/Groq 최근 실패 |
| API credential / scope | **Unknown** — 오류 본문 접근 권한 없음 |
| endpoint / model identifier | **Unknown** |
| rate limit / quota | **Unknown** |
| DNS / TLS / egress | **판단 불가** — staging egress 관측 권한 없음 |
| synthetic probe 구현 | **Perplexity에 한해 가능성 높음** — 13시간 정지는 외부 장애보다 스케줄러 정지에 부합 |
| freshness 집계 | 대체로 정상, 단 `REAUDIT-F007/F008`의 비대칭 존재 |
| staging configuration | **Unknown** |
| 실제 traffic 경로 ↔ probe 경로 불일치 | **관측됨** — 5개 provider가 실트래픽 0 |

**근거 부족 항목은 전부 `Unknown cause`로 남깁니다.** API key·egress·외부 장애
어느 쪽으로도 단정하지 않았습니다.

---

## 9. Credit 및 web-search matrix

| Mode | 모델 수 | 지원 수 | UI | Preflight | Chat body | 기대 credit | 실제 credit | Provider calls |
|---|---:|---:|---|---|---|---:|---:|---:|
| `off` (guest 기본) | 3 | — | `3` / `3 AIs` | **미도달** | `403 TURNSTILE_REQUIRED` | 3 | **0 (차단)** | **0** |
| `off` | 3 | 0 | chip 없음 | mock 통과 | `webSearchMode` 미전송 | 3 | 3 (mock) | 3 (mock) |
| `always` | 2 | 2 | chip 표시 | mock 통과 | `always` | 12+16=**28** | 28 (mock) | 2 (mock) |
| `always` | 3 | 3 | chip 표시 | mock 통과 | `always` | base+24 | 단위테스트 | — |
| `always` | 3 | 혼합 2 | 부분지원 chip + 미지원 badge | mock 통과 | `always` | base+16 | mock | — |
| `always` | 3 | 0 | blocked tone | mock 통과 | `always` | base+0 | mock | — |

- **`8 credits / native-capable model`** 정책은 현재 코드에서 유효합니다
  (`lib/models.ts:58` `webSearchSurcharge: 8`).
- 미지원 모델에 surcharge가 가산되지 않음이 spec으로 고정되어 있습니다.
- **staging 실제 request body는 캡처하지 못했습니다** — guest는 Turnstile로,
  인증 경로는 자격증명 부재로 도달 불가. 위 표의 `mock` 표기 행은 전부 로컬
  mock 근거이며 **staging 실증이 아닙니다.**
- 부족한 credit에서 provider request 0건은 mock E2E
  (`comparison-action-rail.spec.ts` "insufficient credits name the action they
  belong to" 등)로만 확인했습니다.

---

## 10. Security / privacy

| 항목 | 결과 |
|---|---|
| CSP (marketing) | hash 기반 `script-src`, `'unsafe-inline'`/`'unsafe-eval'`/wildcard **없음** |
| CSP (app) | `'nonce-…' 'strict-dynamic'` |
| Cloudflare Browser Insights | **beacon 요청 0건** — 정책(미사용)과 실제 동작 일치 |
| 기타 third-party script | 동의 전 **0건** |
| analytics consent | 동의 전 0 · Decline 후 0 · Accept 후 GTM만 로드 |
| consent 되돌리기 | `analytics-settings-button` 제공 |
| `no-store` | `/chat` `private, no-cache, no-store, must-revalidate` ✅ |
| HSTS | `max-age=31536000; includeSubDomains` ✅ |
| X-Frame-Options / nosniff / COOP | `DENY` / `nosniff` / 설정됨 ✅ |
| CSP report endpoint | `report-uri` + `report-to` 설정 ✅ |
| security regression suite | **113개 검사 전부 통과** |
| 서버 가드 | guest 전송 3건을 Provider 이전에 403 차단, credit 미소비 ✅ |

**발견된 예외**: 없음. 보안·개인정보 정책 약화는 관측되지 않았습니다.

---

## 11. 성능 관찰

동일 환경, cold context, `networkidle` + 3.5초 후 측정, **각 3회 반복**.
환경: 컨테이너 Chromium 141, agent proxy 경유(TTFB에 프록시 지연 포함).

| Route | Viewport | LCP median | LCP max | CLS median | CLS max |
|---|---|---:|---:|---:|---:|
| `/` | 360 mobile | 1.520s | 1.976s | 0.1454 | 0.1454 |
| `/` | 1280 desktop | 1.644s | 2.092s | 0.1013 | 0.1218 |
| `/pricing` | 360 mobile | 1.492s | 3.296s | **0.2352** | **0.2352** |
| `/pricing` | 1280 desktop | 1.288s | 1.376s | 0.1647 | 0.1647 |
| `/chat?entry=guest-preview` | 360 mobile | 1.540s | 1.584s | 0.1202 | 0.1403 |
| `/chat?entry=guest-preview` | 1280 desktop | 1.500s | 1.528s | 0.0777 | 0.0777 |

**과거 단일 표본(360px chat CLS 0.108 / pricing LCP 2.552s / pricing CLS 0.109)은
현재 값으로 재사용하지 않았고, 위 수치는 전부 이번에 새로 수집했습니다.**

### 판정과 한계

- **LCP는 전 구간 양호**합니다 (median 1.29–1.64s). `/pricing` mobile의 3.296s
  단일 이상치는 동일 실행의 TTFB 2512ms와 함께 움직여 네트워크 변동으로 봅니다.
- **CLS는 전 구간 "good"(0.1) 기준을 넘습니다.** 특히 `/pricing` mobile
  **0.2352**는 3회 측정이 **완전히 동일**해 잡음이 아닌 결정적 레이아웃
  이동입니다. 과거 0.109 대비 명백한 악화이므로 **`REAUDIT-F009`와 별개의 관찰
  항목**으로 기록하며, 이번 감사의 primary blocker로는 취급하지 않습니다.
- **한계**: 프록시 경유·컨테이너 CPU·Chromium 버전 차이로 절대값을 실제 사용자
  환경에 그대로 대입할 수 없습니다. CLS는 네트워크 영향이 작아 상대적으로
  신뢰도가 높습니다.

---

## 12. 증거 목록

전부 저장소 밖 임시 위치
`/tmp/.../scratchpad/audit/` 에 보관했으며 저장소 파일을 덮어쓰지 않았습니다.

| 종류 | 파일 | 내용 |
|---|---|---|
| Bounding-box / hit-test | `deep-checks.json` | 52개 조합 (viewport×route×locale×zoom) |
| 이전 SHA 대조본 | `deep-checks-174a62b.json` | `174a62bd` 시점 측정 (reflow 결함 포함) |
| Overflow 원인 추적 | `overflow-hunt.json` | 최심 offender 요소·좌표 |
| STG 회귀 | `stg-regression.json` | 컨트롤 hit-test·credit 샘플링·비교 레이아웃 |
| axe | `axe-full.json` | 5 route × 2 viewport |
| 성능 | `perf-a11y.json` | LCP/CLS 3회 반복 |
| Provider 상태 | `models-status.json`, `models-status-2.json`, `ms3.json`, `status-page.txt` | 11:22 / 12:06 / 12:30 / 12:29 UTC 스냅샷 |
| 모델 카탈로그 | `catalog.json` | 34개 모델 |
| 승인된 실제 호출 | `live-3model.json` | API 요청·응답 (쿠키/토큰 미포함, URL redaction 적용) |
| 스크린샷 | `shots/`, `shots-174a62b/` | 320/390 marketing, 포커스 전후 |
| 테스트 로그 | `e2e-desktop.log`, `e2e-mobile.log`, `unit-sec.log`, `typecheck.log`, `build.log` | 전체 실행 기록 |
| Source 위치 | `lib/pricingFormat.ts`, `lib/csp.ts`, `lib/billingMarkets.ts:59`, `lib/models.ts:58`, `lib/appDefaults.ts:18`, `app/(application)/chat/ChatPageClient.tsx:682,1054`, `app/api/models/status/route.ts` | 판정 근거 |

**민감정보 처리**: API key·token·cookie·session identifier는 수집·출력하지
않았습니다. 사용자 prompt/응답/첨부는 감사용 무해 문장
("Name three primary colours in one sentence.") 외에 수집하지 않았습니다.

### 감사 하네스 제약 (투명성 고지)

staging을 브라우저로 계측하기 위해 다음 **클라이언트 측** 조치를 사용했으며,
제품·인증서 검증·정책 우회는 하지 않았습니다.

1. egress gateway가 Chromium의 **TLS 1.3** 핸드셰이크를 리셋하여 클라이언트를
   `--ssl-version-max=tls1.2`로 고정했습니다. 인증서 검증은 계속 활성입니다.
2. staging:443을 동일 agent proxy의 `CONNECT`로 중계하는 로컬 TCP relay를 사용해
   Chromium이 gateway와 **종단 간 TLS**를 수행하게 했습니다.
3. proxy CA 번들을 Chromium NSS 신뢰 저장소에 등록했습니다.
4. Playwright가 요구하는 chromium v1234를 `cdn.playwright.dev`가
   **403 host not permitted**로 차단해 설치하지 못했고, 사전 설치된 v1194
   (Chromium 141)로 실행했습니다. **이것이 52개 visual golden 실패의 원인입니다.**
   차단된 호스트는 재시도하지 않고 그대로 보고합니다.

---

## 13. 미검증 범위

| 항목 | 사유 |
|---|---|
| 실제 Provider 응답·성공 경로 credit 정산 | 승인은 받았으나 Turnstile이 `403 TURNSTILE_REQUIRED`로 차단, Provider 도달 0회 |
| AI Review 실제 실행·과금·환불 | 위와 동일 (비교 결과에 도달 불가) |
| partial failure 복구 / 미소비 credit 환불 | 성공 경로 미도달 |
| staging `/api/chat/preflight`·`/api/chat` 실제 request body | 인증 세션 자격증명 미보유 |
| FINAL-F003 8개 상태 전이의 **staging** 런타임 캡처 | 위와 동일 (로컬 mock 근거만 보유) |
| STG-F002 비교 패널 모델명 폭·탭 UX | 완료된 비교가 필요 |
| STG-F003 실제 물리 키보드·모바일 IME | 실기기 없음 |
| STG-F007 Source grounding 라벨·툴팁 | 비교 결과 미도달 |
| VoiceOver / TalkBack / NVDA / JAWS | 보조기술 미사용 |
| 삼성 키보드 / Gboard / iOS 한국어 키보드 | 실기기 없음 |
| RTL 대표 locale | 미측정 |
| visual regression 52건의 제품 무결성 | 정본 브라우저(Chromium 151) 설치가 egress 정책으로 차단 |
| staging DB·Railway 환경변수 | 접근 권한 없음 (읽기도 시도하지 않음) |
| production 환경 | 범위 외 |

---

## 14. Top recommendations

| # | 권고 | 소유 영역 | 검증 가능한 완료 조건 |
|---|---|---|---|
| 1 | **상용 경로 실검증 수단 확보** — Turnstile 우회가 아닌, 자동화 검증 전용 staging 계정 또는 검증 토큰 발급 절차를 만든다 | Platform / QA | 승인된 3-model 비교 3회 + AI Review 1회가 Provider에 실제 도달하고, expected/actual credit·환불이 원장으로 대조됨 |
| 2 | **`REAUDIT-F001` 수정 + guard에 브라우저 locale 축 추가** | Web / Growth | en-US·en-AU·en-GB·ko-KR·de-DE × {320,390} × {100,125,150,200}% 40개 조합 overflow ≤1px, 해당 조합이 CI에서 실행 |
| 3 | **`REAUDIT-F003` 채팅 모델 `<select>` 접근명 부여** | Chat UI | 각 select가 패널 모델명을 포함한 고유 접근명 보유, axe `select-name`·`aria-prohibited-attr` 0 |
| 4 | **`REAUDIT-F002` 비교 표 키보드 접근** | Web | `tabindex="0"` + `role="region"` + 접근명, 키보드만으로 Max 열 도달, axe `scrollable-region-focusable` 0 |
| 5 | **`REAUDIT-F006` fallback 후보를 실시간 provider 건강도로 필터·정렬** | Platform / Trust | incident 모델의 제안 후보가 operational 우선으로 정렬되고, degraded뿐이면 그 사실을 문구로 표기 |
| 6 | **`REAUDIT-F008` probe 스케줄러 정지 감지** | Platform / Ops | probe가 freshness window의 N배 이상 정지하면 `Unknown` + 정지 사유로 표기, Perplexity `Last automated check` 정상화 |
| 7 | **`REAUDIT-F004` 색 대비 정정** — `/status` 우선 | Design System | axe `color-contrast` 0 (`/status` 70건, `/pricing` 27건, `/` 4건) |
| 8 | **`/pricing` mobile CLS 회수** | Web | 3회 반복 median CLS ≤0.10 (현재 0.2352) |
| 9 | **`analytics-settings-target` flake 근본 원인 규명** | QA | 전체 suite 5회 연속 실행에서 무실패, 원인(경합 대상)이 문서화됨 — timeout 상향으로 해결 판정 금지 |
| 10 | **재감사 창 배포 동결 + Playwright 브라우저 캐시 사내 미러** | Release / DevEx | 감사 창 중 staging SHA 불변, `cdn.playwright.dev` 차단 환경에서도 정본 브라우저로 visual suite 실행 가능 |

---

## 점수 체계

| 항목 | 배점 | 점수 | 감점 이유 | 근거 | 출시 영향 |
|---|---:|---:|---|---|---|
| Core task success | 20 | **13** | 기본 3-model 성공 경로를 한 번도 실증하지 못함; 기본 3종 중 1종이 현재 incident | `403 TURNSTILE_REQUIRED` ×3, `/api/models/status` | **직접 blocker** |
| Responsive / mobile UX | 15 | **11** | `/pricing` 확대 시 locale별 32–147px overflow | 5개 locale × 4개 조합 실측 | 확대 사용자 전환 손실 |
| Accessibility | 15 | **8** | critical `select-name` ×3, 표 키보드 도달 불가, 대비 101건, 포커스 표시 누락 | axe 5 route × 2 viewport | 법적·평판 위험 |
| Trust / status / credit | 15 | **11** | degraded로 유도하는 복구 제안; `Last known good` 모순; probe 13h 정지 | `/status`, `/api/models/status`, outage 배너 | 신뢰 훼손 |
| Security & privacy | 15 | **14** | 결함 없음. 감점은 실트래픽 경로 미검증분만 | 헤더 실측 + 113개 검사 + 동의 전 요청 0 | 낮음 |
| Operational readiness | 10 | **5** | Provider 도달 0회, Google incident, Perplexity probe 정지 | §8 | **직접 blocker** |
| i18n / content quality | 5 | **4** | 문법·복수형은 정확하나 통화 표기가 레이아웃 파손을 유발 | sr 문자열 + locale 표 | 중간 |
| QA traceability & automation | 5 | **3** | guard가 배포물을 보호하지 못함; visual 52건 검증 불가; flake 1건 미해결 | §6 | 재발 위험 |
| **합계** | **100** | **69** | | | |

자동화 테스트 통과 수만으로 점수를 부여하지 않았습니다.

---

## Go-Live 판정

### No-Go 조건 대조

| 조건 | 해당 | 근거 |
|---|---|---|
| FINAL-F001이 staging에서 재현 | ❌ 아니오 | 교차 면적 0, hit-test 12/12 |
| 기본 Provider 경로에 근거 없는 정상 표시 | ❌ 아니오 | 상태 근거·타임스탬프 명시, UI와 API 일치 |
| 기본 3-model 경로가 실제로 실패 | ⚠️ **판정 불가** | Provider 도달 0회 |
| credit atomicity 결함 | ❌ 아니오 | 차단 요청에서 credit·usage 불변 |
| 미소비 요청 과금 | ❌ 아니오 | 동일 |
| staging SHA 불일치로 대상 불명확 | ❌ 해소됨 | 종료 시점 local=origin=staging |
| CSP 광범위 완화 | ❌ 아니오 | hash/nonce 기반, wildcard 없음 |
| 동의 이전 비승인 추적 | ❌ 아니오 | 외부 요청 0건 |
| 설명되지 않은 critical automation failure | ❌ 아니오 | 53+4건 전부 분류 완료 |
| P1 회귀 | ❌ 아니오 | STG/FINAL Regressed 0건 |

**→ 절대적 No-Go 조건에는 해당하지 않습니다.**

### Needs operational verification 조건 대조

| 조건 | 해당 |
|---|---|
| UI·코드·mock은 통과했으나 실제 3-model·AI Review 호출 승인 결과가 없음 | ✅ **해당** (승인은 받았으나 환경이 차단) |
| Provider freshness 근거 부족 | ⚠️ 부분 해당 (Perplexity probe 13h 정지, 5개 provider 실트래픽 0) |
| production-like credential / egress 경로 미확인 | ✅ **해당** |
| 실제 staging SHA와 검증 artifact 연결 불완전 | ❌ 해소됨 |

---

## 최종 판정

# **Conditional No-Go — Needs operational verification**

**점수 69/100.**

FINAL-F001·F003·F004·F005·F006 다섯 건은 실제 배포물에서 **근본 원인까지
해결**되었음을 독립 실측으로 확인했습니다. 특정 screenshot이나 테스트만
통과시키는 형태의 수정은 아니었습니다 — 동의 배너는 overlay 자체를 제거했고,
브랜드는 절단 로직이 아니라 폭 계약을 바꿨으며, CSP는 예외를 넣는 대신 beacon을
끄는 정책을 택했고, 가격 문법은 호출부가 아닌 단일 헬퍼에서 해결했습니다.
보안·개인정보 정책은 어느 지점에서도 약화되지 않았습니다.

출시를 막는 것은 **단 하나, FINAL-F002의 운영 미검증**입니다. 승인을 받아
실제 호출을 시도했으나 Turnstile이 자동화 클라이언트를 Provider 이전 단계에서
차단해, 상용 3-model 경로와 AI Review는 이번에도 **한 번도 실증되지
못했습니다.** 규정상 승인된 실제 호출 근거 없이는 `Go`를 부여할 수 없습니다.

여기에 더해, 출시 전에 처리하기를 권고하는 P2가 5건 있습니다: `/pricing`의
locale 의존 reflow 파손, 그것을 놓치는 guard, 채팅 모델 select의 접근명 부재,
비교 표의 키보드 도달 불가, 그리고 incident에서 degraded로 유도하는 복구 제안.

특히 `REAUDIT-F001`은 이번 감사의 가장 중요한 시사점입니다. **테스트는
초록이지만 배포물은 깨져 있습니다.** guard가 브라우저 locale을 고정하기 때문에,
같은 조합에서 CI는 0px를, 실제 staging은 최대 147px를 보고합니다. 테스트 통과와
상용 준비도를 동일시해서는 안 된다는 점을 이 한 건이 구체적으로 보여줍니다.

`Go` 전환의 최소 조건은 다음 두 가지입니다.

1. 승인된 실제 3-model 비교 3회와 AI Review 1회가 Provider에 도달해 성공하고,
   expected/actual credit과 실패분 환불이 원장으로 대조될 것.
2. 위 P2 5건이 해소되고, 각 수정에 **배포물을 실제로 보호하는** 회귀 커버리지가
   동반될 것.

---

*재감사 수행: 2026-07-28 11:21–12:41 UTC · 대상 `791fef1d0468388f54d8e6d8bfddca55534766c0`
· deployment `55db26e2-5854-4470-83a5-0f89f7e8c2fe` · 제품 코드/테스트/golden 무변경*
