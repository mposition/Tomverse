# 소비되지 않는 응답 본문 inventory (2026-08-13)

> **상태: 조사 완료, 수정은 하지 않았습니다.** 이 문서는 목록이지 판정이
> 아닙니다. 각 항목이 실제 결함인지, 얼마나 비싼지는 사람이 정합니다.

기준 commit: `origin/develop` `f76ff97` 위의 branch
`claude/pr-379-conflict-fix-b7wt9h`.
도구: `npm run report:unconsumed-response-bodies`
(`scripts/report-unconsumed-response-bodies*.mjs`,
`tests/unconsumedResponseBodies.test.mjs` 20건).

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

## 6. 다음 단계 (착수하지 않음)

1. **공통 helper.** 지금은 `ChatPageClient.tsx`의 module-local
   `discardResponseBody` 하나뿐입니다. 32개 파일이 쓰려면 공유 위치로 옮겨야
   합니다.
2. **200/500 · 성공/실패 분기 회귀 테스트.** 현재 증거는
   `tests/e2e/guest-flow.spec.ts` 하나이고 `/api/user/guest-usage`의 500 한
   경로만 덮습니다.
3. **우선순위.** 폴링·재시도 경로를 먼저 재고, 한 번 열고 마는 화면은 뒤로
   미루는 것이 5장의 미지수를 가장 빨리 줄입니다.
4. **`escapes` 24건 검토.** 판정을 미룬 것이지 안전하다고 판정한 것이 아닙니다.
5. **server runtime 25건**은 undici 기준으로 따로 판단해야 하며, 이 문서의
   측정을 근거로 삼을 수 없습니다.

이 보고서는 gate가 아닙니다. 어떤 결과에서도 exit 0이며 registry나 소스에
쓰지 않습니다.
