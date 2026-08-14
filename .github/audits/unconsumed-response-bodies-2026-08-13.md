# 소비되지 않는 응답 본문 inventory (2026-08-13)

> **상태: 조사 완료 → browser 측 정리 완료(2026-08-14).** 아래 1~3장은 조사
> 시점의 기록으로 그대로 둡니다. 이후 조치와 현재 수치는 7장에 있습니다.
> server runtime 21건은 손대지 않았습니다.

기준 commit: `origin/develop` `f76ff97` 위의 branch
`claude/pr-379-conflict-fix-b7wt9h`.
도구: `npm run report:unconsumed-response-bodies`
(`scripts/report-unconsumed-response-bodies*.mjs`,
`tests/unconsumedResponseBodies.test.mjs`).

## 0. 왜 세는가 — 그리고 이 수치가 말하지 않는 것

`/api/*`는 proxy에서 `private, no-store`를 받습니다
(`lib/apiCacheControlPolicy.ts`). 그와 함께 **측정된** 사실은 하나입니다.

> Next 16.3.0 `next start` 빌드 + Chromium에서, 본문이 한 번도 소비되지 않은
> 응답은 `private, no-store`일 때 `requestfinished`에 도달하지 않았고,
> `private, no-cache`·`public, max-age=60`일 때는 도달했다. 상태 코드는
> 무관했다(200 = 500).

이 문장이 **아닌** 것 셋을 먼저 못박습니다.

1. **`Cache-Control` 계약이 아닙니다.** RFC 9111 §5.2.2.5는 `no-store`에
   "저장하지 말 것" 하나만 규정하고, 요청이 얼마나 오래 미완료로 남는지는
   말하지 않습니다. Fetch 표준도 캐시 갱신과 본문 종료를 별도 단계로 다룹니다.
   따라서 브라우저 하나·서버 버전 하나의 동작입니다.
2. **설명된 메커니즘이 아닙니다.** "캐시 쓰기가 본문을 배수한다"는 관측 3점에
   들어맞을 뿐 검증되지 않았습니다.
3. **`fetch()` promise가 멈추는 것이 아닙니다.** status·headers를 이미 받았으니
   promise는 resolve됐고, 남은 것은 본문 전송과 요청 자체의 완료입니다 —
   `networkidle`이 세는 대상이 그것입니다.

원인이 무엇이든 클라이언트가 져야 할 의무는 같습니다. 응답 본문은 **모든
경로에서** 소비하거나 취소해야 합니다.

## 1. 전체 수치

`app/`, `components/`, `hooks/`, `lib/`, `packages/`, `scripts/`의 소스 899개를
읽어 **fetch 호출 지점 239곳**을 분류했습니다.

| 분류 | 수 | 뜻 |
|---|---|---|
| `consumed` | 118 | 이 도구가 볼 수 있는 모든 경로가 본문을 읽습니다. |
| `leaks` | 97 | 구문상 본문을 읽지 않고 scope를 빠져나가는 경로가 **하나 이상** 있습니다. |
| `escapes` | 24 | 응답이 scope 밖으로 나가 소비자가 이 도구의 시야 밖에 있습니다. 판정하지 않습니다. |

runtime별 (`server-only` import와 `"use client"` 지시문을 소스에서 읽고,
없으면 디렉터리로 정합니다. `lib/`는 둘 다 없으면 `either`):

| runtime | consumed | leaks | escapes |
|---|---|---|---|
| browser | 110 | 69 | 13 |
| either (`lib/`) | 0 | 3 | 0 |
| server | 8 | 25 | 11 |

`leaks` 97건을 **요청 대상**으로 다시 나누면, 측정된 동작이 적용될 수 있는
범위가 드러납니다.

| runtime / 요청 대상 | 수 | 측정 범위 |
|---|---|---|
| browser / `/api/*` 기본(`private, no-store`) | 54 | **해당** |
| either(`lib/` 클라이언트 모듈) / `/api/*` 기본 | 3 | **해당** |
| browser / `/api/*` 자체 캐싱 5개 route | 7 | 비해당 — 저장 가능한 지시문이라 측정에서는 종료됐습니다 |
| browser / 해석 불가(변수·헬퍼 URL) | 8 | 미상 |
| server / 외부 provider(`cross_origin`) | 9 | 비해당 — 다른 runtime |
| server / 해석 불가 | 16 | 비해당 — 다른 runtime |

즉 **측정된 동작이 적용되는 것은 57건**(browser 54 + `lib/` 클라이언트 3)이고,
나머지 40건은 같은 코드 형태이지만 다른 층의 문제입니다.

## 2. 형태별 분포 (browser + `lib/` 클라이언트 72건)

| 형태 | 수 | 대표 |
|---|---|---|
| `return`·`throw`로 빠져나가며 본문 미소비 | 44 | `if (!res.ok) throw new Error(...)`, `if (!res.ok) { toast(); return; }` |
| 분기 밖으로 그냥 흘러 나감 | 24 | `res.ok ? res.json() : null`, `if (res.ok) { ... }` (else 없음) |
| 응답 자체를 버림 | 4 | `await fetch(url, { method: "DELETE" })` |

## 3. 파일별 목록

각 행은 **후보**입니다. 미소비 경로가 실제로 도달 가능한지, 그 비용이 얼마인지는
아직 판단하지 않았습니다.

| 파일 | 건수 | line | 형태 | 요청 대상 |
|---|---|---|---|---|
| `components/admin/AdminProviderHealthPanel.tsx` | 2 | 1317, 1345 | return·throw | 기본 |
| `components/admin/AdminRoutingShadowPanel.tsx` | 1 | 169 | return·throw | 기본 |
| `components/analytics/AnalyticsProvider.tsx` | 1 | 350 | fall-through | 기본 |
| `components/auth/AuthButton.tsx` | 5 | 362, 385, 521, 600, 687 | return·throw, fall-through | 기본 |
| `components/billing/PlanChangeDialog.tsx` | 1 | 178 | fall-through | 기본 |
| `components/chat/ChatApp.tsx` | 3 | 332, 491, 1238 | return·throw, fall-through | 기본 |
| `components/chat/ChatInput.tsx` | 8 | 1186, 1240, 1676, 1690, 1711, 1901, 1986, 2035 | return·throw, fall-through | 자체 캐싱, 기본, 해석 불가 |
| `components/chat/ChatSidebar.tsx` | 6 | 324, 437, 471, 520, 571, 590 | return·throw, fall-through | 기본 |
| `components/chat/ComparisonReviewDialog.tsx` | 1 | 565 | 응답 폐기 | 기본 |
| `components/chat/ProviderStatusBanner.tsx` | 1 | 152 | return·throw | 자체 캐싱 |
| `components/chat/useChatAvailability.ts` | 1 | 81 | fall-through | 기본 |
| `components/chat/useUserUsage.ts` | 1 | 99 | fall-through | 기본 |
| `components/images/ImageGenerationWorkspace.tsx` | 3 | 309, 351, 376 | return·throw | 기본 |
| `components/imports/ConversationLockControls.tsx` | 3 | 89, 190, 209 | return·throw, fall-through | 해석 불가 |
| `components/imports/ExternalConversationViewer.tsx` | 2 | 105, 192 | return·throw | 기본 |
| `components/imports/ExternalImportDetail.tsx` | 2 | 114, 185 | return·throw | 기본 |
| `components/imports/ExternalImportManagement.tsx` | 5 | 162, 186, 216, 268, 286 | return·throw, fall-through | 기본 |
| `components/imports/ExternalImportWizard.tsx` | 2 | 120, 278 | return·throw, 응답 폐기 | 기본 |
| `components/marketing/TrustSection.tsx` | 1 | 39 | fall-through | 자체 캐싱 |
| `components/marketing/UpgradeInterestButton.tsx` | 3 | 762, 780, 882 | return·throw, fall-through | 기본, 해석 불가 |
| `components/marketing/usePricingAccount.ts` | 1 | 98 | fall-through | 기본 |
| `components/marketing/usePublicBilling.ts` | 1 | 90 | fall-through | 해석 불가 |
| `components/memory/MemoryExtractionLauncher.tsx` | 4 | 131, 159, 182, 321 | return·throw, fall-through | 기본 |
| `components/memory/MemoryExtractionRunStatus.tsx` | 2 | 68, 106 | return·throw, 응답 폐기 | 기본 |
| `components/memory/MemoryReviewSettings.tsx` | 4 | 145, 322, 349, 571 | return·throw | 기본, 해석 불가 |
| `components/privacy/AccountDataDownload.tsx` | 2 | 73, 108 | return·throw | 기본 |
| `components/share/SharedConversationView.tsx` | 1 | 77 | fall-through | 기본 |
| `lib/chatContextBundleClient.ts` | 1 | 23 | return·throw | 기본 |
| `lib/feedbackClient.ts` | 1 | 123 | 응답 폐기 | 기본 |
| `lib/guestImport.ts` | 1 | 235 | return·throw | 기본 |
| `lib/productAnalyticsClient.ts` | 1 | 322 | fall-through | 기본 |
| `lib/useBuildInfo.ts` | 1 | 17 | fall-through | 기본 |

`app/(site)/(application)/chat/ChatPageClient.tsx`는 **26곳 중 leaks 0건**입니다.
앞선 작업에서 전수 정리했고, 남은 3건은 `escapes`(호출자가 소비하는 helper
closure)로 손으로 확인했습니다.

### server runtime (25건, 별개 층)

`lib/providerMonitoring.ts`(4), `lib/imageProviderAdapter.ts`(3),
`lib/oauthLink.ts`(2), `lib/perplexityDeepResearch.ts`(2),
`scripts/send-security-audit-report.mjs`(2),
`scripts/verify-fixture-route-gate.mjs`(2),
그 외 `lib/accountDataExport.ts`·`lib/billingPriceCatalog.ts`·
`lib/feedbackAutoFixShadow.ts`·`lib/managedSlack.ts`·
`lib/operationalMonitoring.ts`·`lib/productAnalyticsServer.ts`·
`lib/providerModelCatalogMonitor.ts`·`lib/turnstile.ts`·
`scripts/measure-google-image-thinking-cap.mjs`·
`scripts/report-issue-backlog.mjs` 각 1건.

대부분 외부 provider API 호출이며, **이 문서의 측정은 이쪽에 대해 아무 말도 하지
않습니다.** Node의 undici에서 미소비 본문이 connection pool을 점유한다는 것은
별개의 알려진 사안이고, 여기서 측정하지 않았습니다.

## 4. 손으로 확인한 것과 확인하지 않은 것

도구 출력 전체를 사람이 검토하지는 않았습니다. **8곳을 표본으로 직접 읽었고 8곳
모두 실제 미소비 경로였습니다.**

`components/chat/useUserUsage.ts:99`, `components/marketing/TrustSection.tsx:39`,
`components/analytics/AnalyticsProvider.tsx:350`,
`components/auth/AuthButton.tsx:521`, `components/chat/ChatInput.tsx:1676`,
`components/chat/ChatSidebar.tsx:571`,
`components/imports/ExternalImportManagement.tsx:268`, 같은 파일 `:286`.

조사 도중 **오탐 2종을 발견해 분류기를 고쳤습니다.** 둘 다 promise가 중간
바인딩을 거쳐 소비되는 경우였고, 지금은 `leaks`가 아니라 `escapes`로 보고합니다.

- `Promise.all([fetch(...), fetch(...)]).then(([a, b]) => ...)`
  (`components/auth/AuthButton.tsx:418`)
- 삼항으로 고른 promise를 변수에 담아 뒤에서 소비
  (`components/chat/ComparisonReviewDialog.tsx:430`)

**나머지 64건은 분류기 출력이며 사람이 읽지 않았습니다.** 특히 다음은 이 도구가
답할 수 없습니다.

- 미소비 경로가 실제로 **도달 가능한지**. `if (cancelled) return;`은 구문상
  미소비 경로이지만 실행되지 않을 수 있습니다.
- 응답이 **다른 함수·모듈로 넘어간 뒤** 소비되는지(`escapes` 24건).
- `try` 안에서만 읽는 코드에서 **`catch` 경로**가 어떻게 되는지. 현재는 `try`
  블록의 답만 보고합니다.

## 5. 비용은 아직 모릅니다

"화면당 요청 하나 정도"라는 초기 추정은 근거가 없었으므로 철회했습니다. 실제
누적량은 **호출 빈도**에 달려 있고, 이 inventory는 빈도를 재지 않았습니다.
목록 안에 폴링·재시도·사용자 반복 동작 경로가 섞여 있습니다 — 예를 들어
`ProviderStatusBanner`는 5분 주기이고, `MemoryExtractionRunStatus`는 실행 중
반복 조회하며, `ExternalImportManagement`의 삭제·목록 갱신은 사용자가 반복해서
누를 수 있습니다. 한 번 열고 마는 화면과 같은 비용이 아닙니다.

측정하려면 브라우저에서 화면별 미완료 요청 수를 시간에 대해 재야 하고, 그것은
이 작업에 포함되지 않았습니다.

## 6. 다음 단계

### 6-1. 마친 것 (2026-08-13, 이 문서 이후)

1. **공통 helper.** `lib/discardResponseBody.ts`로 옮겼습니다. 이전에는
   `ChatPageClient.tsx`의 module-local 함수여서 다른 파일이 쓸 수 없었습니다.
   `tests/discardResponseBody.test.mjs` 6건이 계약을 고정합니다 — 실제로
   소비하는지(`bodyUsed`), 200과 500에서 동일한지, 본문 없는 204·중간에 끊긴
   stream·이미 소비된 응답에서 **reject하지 않는지**. 마지막 항목이 중요한
   이유는 모든 호출부가 "어차피 무시할 응답"에 이 함수를 쓰기 때문입니다 —
   여기서 던지면 필요 없던 `catch`를 32개 파일이 달아야 합니다.
2. **200/500 · 성공/실패 분기 회귀 테스트.**
   `tests/e2e/api-response-body-completion.spec.ts` 4건(200·500 × 파싱·폐기).
   500은 mock이 아니라 실제입니다 — E2E 서버는 의도적으로 닿지 않는 DB를 쓰므로
   `/api/user/guest-usage`가 진짜로 실패합니다. `page.route` fulfilment은
   Playwright가 응답을 만들어 주는 것이라 network stack에 대해 아무것도 증명하지
   못합니다.

   **음성 사례(미소비 응답이 완료되지 *않는다*)는 일부러 단언하지 않습니다.**
   그것은 이 저장소가 소유하지 않은 상류 동작이고, Chromium이 배수하도록 바뀌면
   개선이 merge gate 적색으로 나타납니다. 그때는 위험 자체가 사라진 것이고 이
   4건은 그대로 통과합니다.

### 6-2. 아직 하지 않은 것

3. **57개 호출부 정리.** helper는 생겼지만 실제로 쓰는 파일은 아직
   `ChatPageClient.tsx` 하나입니다. 3장의 목록이 남은 대상입니다.
4. **우선순위 측정.** 폴링·재시도 경로를 먼저 재고, 한 번 열고 마는 화면은 뒤로
   미루는 것이 5장의 미지수를 가장 빨리 줄입니다.
5. **`escapes` 24건 검토.** 판정을 미룬 것이지 안전하다고 판정한 것이 아닙니다.
6. **server runtime 25건**은 undici 기준으로 따로 판단해야 하며, 이 문서의
   측정을 근거로 삼을 수 없습니다.

이 보고서는 gate가 아닙니다. 어떤 결과에서도 exit 0이며 registry나 소스에
쓰지 않습니다.

## 7. 이후 조치 — browser 측 정리 (2026-08-14)

3장의 목록을 전부 정리했습니다. **browser·`either` runtime의 `leaks`가 0이
되었습니다.**

| | 조사 시점 | 정리 후 |
|---|---|---|
| 호출 지점 | 239 | 239 |
| `consumed` | 118 | **193** |
| `leaks` | 97 | **21** (전부 server runtime) |
| `escapes` | 24 | 25 |
| browser + `either` `leaks` | 72 | **0** |

31개 파일이 `lib/discardResponseBody.ts`를 쓰도록 바뀌었습니다. 형태는 셋뿐입니다.

- `res.ok ? res.json() : null` → 다른 arm에서 `discardResponseBody(res)`
- `if (!res.ok) { … return/throw }` → 그 분기 안에서 소비
- 상태 코드 사다리(401·403·404·423 …)가 여러 갈래로 빠져나가는 경우 →
  `if (!res.ok) { await discardResponseBody(res); … }`로 한 번만 소비하고
  사다리를 그 안으로 옮김

### 7-1. 조사 자체가 틀렸던 4가지 — 분류기를 고쳤습니다

정리 도중 **도구가 잘못 지목한 형태 4종**을 발견했습니다. 손대기 전에 코드를
읽었기 때문에 드러난 것이고, 넷 다 분류기를 고쳐 `consumed`/`escapes`로
옮겼습니다. 이미 올바른 코드를 "고치는" 것은 리뷰어에게 목록을 믿지 말라고
가르치는 일입니다.

| 형태 | 예 | 고친 방식 |
|---|---|---|
| `Promise.all([fetch, fetch]).then(([a, b]) => …)` | `AuthButton.tsx:418` | promise가 scope 밖으로 나가면 `escapes` |
| 삼항으로 고른 promise를 변수에 담아 뒤에서 소비 | `ComparisonReviewDialog.tsx:430` | 위와 같음 |
| 미리 선언한 `let response`에 대입 | `feedbackClient.ts:123` | `x = await fetch(…)` 대입과 삼항 arm까지 binding으로 인식 |
| `try` 안에서 대입하고 `try` **밖에서** 소비 | 같은 파일 | 바깥 statement list까지 이어서 탐색 |
| `return { ok: true, body: await res.json() }` | `MemoryReviewSettings.tsx:145` | object·array·template literal 안의 읽기도 소비로 인정 |

server runtime `leaks`도 25 → 21로 줄었는데, **코드를 고쳐서가 아니라 오탐
4건이 사라져서**입니다.

### 7-2. browser·`either` `escapes` 14건 추적 (2026-08-14, `9b74bc2`)

`escapes`는 **판정을 미룬 것이지 안전하다고 판정한 것이 아닙니다.** browser
runtime 13건과 `either` 1건을 하나씩 읽어 소비자를 따라갔습니다. 결과는 반반이
아니었습니다 — **10건은 모든 경로에서 소비되고 있었고, 4건은 실제로 미소비**
였습니다.

미소비 4건. 전부 `discardResponseBody`로 고쳤습니다.

| 위치 | 미소비 경로 |
|---|---|
| `auth/signin/SignInPageContent.tsx:149` | **성공 경로**(`response.ok`). 거절 경로는 전부 읽고 있었고 2xx만 빠져 있었습니다 |
| `components/admin/AdminMemoryImportPanel.tsx:161` | `!importResponse.ok`일 때, 그리고 memory 쪽이 먼저 `throw`할 때 |
| `components/auth/AuthButton.tsx:425` | `cancelled`이거나 **둘 중 하나라도** `!ok`이면 조기 return |
| `components/auth/AuthButton.tsx:426` | 위와 같은 경로 |

소비되고 있던 10건: `ChatPageClient.tsx`의 `preflight`·`conversation-title`·
`compare-summary`, `AdminMemoryImportPanel.tsx:160`, `ChatApp.tsx:724`(`/api/chat`,
자체 caching이라 측정 대상 밖이기도 합니다), `ChatInput.tsx:1648`,
`ComparisonReviewDialog.tsx`의 3건, `lib/feedbackClient.ts:123`.

**7-1의 오탐 4종과는 성격이 다릅니다.** 그때는 도구가 틀렸고 코드가 옳았지만,
여기서는 도구가 "모르겠다"고 말한 것이 맞았고 그중 4건은 실제 결함이었습니다.
`escapes`를 gate에서 차단하지 않기로 한 결정(§7-3)은 그래서 "안전하다"가 아니라
"사람이 읽어야 한다"는 뜻이며, 이 절이 그 읽기입니다.

### 7-3. 여전히 하지 않은 것

- **server runtime 23건.** undici 기준으로 따로 판단해야 하며 이 문서의 측정을
  근거로 삼을 수 없습니다. 앱·라이브러리 17건과 `scripts/` 6건은 실행 환경이
  달라 따로 셉니다. (7-1 시점의 21건에서 늘어난 것은 코드가 나빠져서가 아니라
  이후 merge된 변경이 새 호출 지점을 들여왔기 때문입니다 — 정확한 수는
  `npm run report:unconsumed-response-bodies`로 그때그때 읽습니다.)
- **server·`either` 밖의 `escapes` 11건.** server runtime 몫이라 위 항목과
  함께 판단합니다.
- **빈도 측정.** 5장은 그대로 유효합니다 — 비용 크기는 여전히 모릅니다. 다만
  이제는 정리가 끝났으므로 "얼마나 비쌌는가"는 사후 관심사입니다.
- **회귀 gate.** 지금 browser leaks가 0이므로
  `npm run report:unconsumed-response-bodies`를 fail-closed 검사로 승격할 수
  있습니다. **하지 않았습니다** — 이 조사에서만 분류기 오탐 4종이 나왔고,
  heuristic 분류기를 merge 차단 gate로 올리면 무관한 PR을 막을 수 있습니다.
  승격 여부는 사람의 결정입니다.

## 8. server runtime 측정 (2026-08-14, `ea60c48`)

7-3에 "undici 기준으로 따로 판단해야 한다"고 적어 둔 항목을 실제로 쟀습니다.
brower 측정을 옮겨 쓰지 않고, Node 22.22.2 / 번들 undici 6.24.1에서 직접
측정했습니다. harness는 `scripts/report-unread-body-connection-cost.mjs`이며
`npm run report:unread-body-connection-cost`로 재현합니다 — 매 case마다 일회용
`node:http` 서버를 새 포트에 띄웁니다(포트가 곧 origin이고 origin이 곧 pool이라,
그래야 각 case가 이력 없는 pool에서 시작합니다). 제품에 라우트를 추가하지
않았습니다.

### 8-1. 임계값은 크기이며, 16 KiB와 64 KiB 사이입니다

가장 깨끗한 단일 변수 시험 — connection 1개짜리 pool에서 응답 하나를 붙들고
바로 다음 요청을 보냅니다.

| 본문 크기 | unread | drain | cancel |
|---|---|---|---|
| 64 B | 통과 | 통과 | 통과 |
| 16 KiB | 통과 | 통과 | 통과 |
| 64 KiB | **차단** | 통과 | 통과 |
| 256 KiB | **차단** | 통과 | 통과 |
| 2 MiB | **차단** | 통과 | 통과 |

undici의 수신 버퍼보다 작은 본문은 아무도 읽지 않아도 이미 소켓에서 빠져나와
있어 connection을 붙들지 않습니다. 그보다 크면 무기한 붙듭니다. **상태 코드는
무관합니다** — 200과 500이 모든 크기에서 같게 나옵니다. browser 쪽 관찰과
같은 방향이지만 **같은 사실이 아닙니다**: 저쪽은 cache 항목, 이쪽은 connection
pool이고, 임계값이라는 것 자체가 이쪽에만 있습니다.

### 8-2. production의 기본 pool에서는 교착이 아니라 소켓 낭비입니다

`globalThis.fetch`의 기본 pool은 origin당 상한이 없습니다. 동시 요청 20개는
크기·소비 방식과 무관하게 전부 완료했습니다(소켓 20개). 순차 5회에서는
차이가 드러납니다 — 64 KiB 이상에서 `unread`는 매번 새 소켓(5개)을 열고,
`drain`은 재사용합니다(2개). `cancel`은 반쯤 읽은 connection을 재사용할 수
없어 오히려 더 엽니다(6개).

즉 **오늘의 비용은 장애가 아니라 keep-alive 재사용 상실**입니다. 상한이 있는
pool(4개)로 바꾸면 64 KiB 이상 `unread`는 곧바로 굶습니다.

부수적으로 나온 사실 하나: `Promise.all([fetch, fetch, …])`로 헤더를 **전부**
받은 뒤에야 본문을 소비하는 형태는, 요청 수가 pool 상한을 넘고 본문이 버퍼보다
크면 **소비 방식과 무관하게** 굶습니다. drain도 cancel도 마찬가지입니다. 오늘
안전한 이유는 pool에 상한이 없고 해당 호출부의 본문이 작기 때문이지, 그 형태가
안전해서가 아닙니다.

### 8-3. 23건 중 실제로 이 임계값에 걸리는 것은 1건입니다

23건을 하나씩 읽어 "미소비 경로가 64 KiB 이상을 실어 나를 수 있는가"로
나눴습니다.

- **분류기 오탐 1건** — `lib/accountDataExport.ts:814`. `const fetch =
  FETCHERS[domain]`가 전역을 가리고 `await fetch(userId)`는 DB 읽기입니다.
  네트워크도 `Response`도 없습니다. 분류기를 고쳤고(오탐 5종째) 회귀 테스트
  3건으로 고정했습니다 — 한 scope의 shadowing이 다른 scope의 진짜 호출부를
  면제하지 않는다는 것까지 포함해서입니다.
- **오류·확인 응답 본문뿐 21건** — turnstile, Resend, SendGrid, Sentry, GitHub
  issues, Slack, GA4, OAuth token·userinfo, Perplexity 2건, provider catalog,
  provider monitoring 4건, FX rate, operational webhook, 그리고 `scripts/` 6건.
  전부 `!response.ok`에서 throw·return하는 형태이고, 실리는 것은 작은 JSON
  오류 본문입니다. 16 KiB 아래이므로 **측정 결과 connection 비용이 없습니다.**
  이것은 "아직 모른다"가 아니라 "재 봤고 문제 없다"입니다.
- **실제 위험 1건** — `lib/imageProviderAdapter.ts:622`. fal asset 다운로드이고
  미소비 경로가 둘인데 **둘 다 이미지 한 장 전체를 들고 있을 수 있습니다.**
  하나는 `!isFalAssetUrl(asset.url)`로, 응답이 2xx인 채 본문이 통째로 남습니다.
  다른 하나는 `content-length`가 상한을 넘어 거부하는 경로라 **크다는 이유로
  거부하면서 그 큰 본문을 붙들고 있었습니다.**

고칠 때 `discardResponseBody`를 쓰지 않았습니다. 그 helper는 본문을 *읽습니다*
— 크기 상한 경로에서 그러면 상한이 막으려던 메가바이트를 그대로 메모리에
올리게 됩니다. 8-1이 `cancel`도 connection을 놓아준다는 것을 보여주므로
`asset.body.cancel()`을 씁니다.

### 8-4. server `escapes` 11건 추적 — 호출부는 전부 옳았고, **공용 helper가 틀렸습니다**

11건을 소비자까지 따라갔습니다. **호출부 자체는 11건 모두 정상**입니다.

- **fetch wrapper 2건** — `lib/deepseekUsageAdapter.ts:54`,
  `lib/perplexityUsageCapture.ts:79`. 둘 다 `typeof fetch` 미들웨어라 응답을
  호출자(AI SDK)에게 넘깁니다. 감싸는 경우에도 새 stream의 `cancel`이 원본
  reader로 전달됩니다. 소비 책임이 이동한 것이지 미소비가 아닙니다.
- **bounded reader 경유 8건** — `lib/providerUsageSync.ts` 7건과
  `lib/infrastructureMonitoring.ts:203`. 전부 직후에
  `await readBoundedJson(response)`로 읽습니다.
- **1건은 이미 모범 사례** — `app/api/chat/route.ts:473`(Google Drive export).
  미소비 경로는 작은 오류 본문뿐이고, 성공 경로는 `lib/boundedBuffer.ts`의
  `readResponseToBuffer`를 씁니다. 이 helper는 declared length 거부와 streaming
  상한 **양쪽 모두에서 body를 cancel**합니다.

그런데 8건이 쓰는 `readBoundedJson`은 **두 벌로 복제돼 있고 둘 다** declared
length 거부 경로에서 body를 놓아주지 않은 채 throw했습니다.

```
if (declaredLength > MAX) {
  throw new Error("... exceeded the ... limit.");   // body 손도 대지 않음
}
```

streaming 상한 쪽은 `await reader.cancel()`이 있어서 옳았습니다. **틀린 것은
early exit 하나뿐**이고, 하필 그 분기는 **본문이 크다는 이유로 발동합니다** —
512 KB·1 MB 모두 8-1의 임계값을 한참 넘습니다. 즉 "너무 커서 거부한다"면서 그
큰 본문으로 connection을 붙들고 있었습니다. `providerUsageSync`는 스케줄로
돌고 재시도하므로 일회성이 아닙니다.

`lib/boundedBuffer.ts`가 같은 일을 올바르게 하고 있었다는 점이 이 건의 성격을
말해 줍니다 — 방법을 몰라서가 아니라, 같은 로직을 세 번 쓰면서 한 벌만 맞은
것입니다.

**정적 분석은 이것을 찾을 수 없습니다.** 호출부는 helper를 통해 본문을 읽으니
전부 `consumed`로 분류되고, 틀린 곳은 helper 자신의 early exit입니다. 그래서
gate가 아니라 test로 고정했습니다 — `tests/boundedResponseRelease.test.mjs`.
`readResponseToBuffer`는 동작으로(refuse 시 `cancel`이 호출되는지) 검증하고,
module-private인 두 벌은 소스 형태로 검증합니다. **후자가 더 약한 검사라는
점을 그대로 적어 둡니다**: 해제가 *쓰여* 있다는 것을 증명할 뿐 *실행된다*는
것을 증명하지 않습니다. 두 수정을 각각 되돌려 test가 실패하는 것까지 확인했습니다.

### 8-5. 하지 않은 것

- **production 관측.** 위는 전부 loopback 합성 측정입니다. 실제 provider와의
  RTT·연결 재사용률·소켓 수를 production에서 본 것이 아닙니다. 임계값은 클라이언트
  버퍼의 성질이라 옮겨 붙지만, "그래서 오늘 얼마나 비쌌는가"는 여전히 5장입니다.
- **gate 확대.** server 측을 차단 대상으로 올리지 않았습니다. 측정이 말하는
  것은 "크기가 임계값을 넘는 미소비 본문만 문제"이고, 정적 분석은 본문 크기를
  알 수 없습니다. 크기를 모르는 검사를 차단 gate로 쓰면 21건의 무해한 오류 본문
  경로가 전부 merge를 막습니다.
