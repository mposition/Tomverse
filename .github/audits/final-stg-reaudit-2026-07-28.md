# Tomverse Insight — FINAL/STG staging 재감사 보고서

> 이 문서는 **감사 보고서**입니다. 이번 작업에서 제품 코드·테스트·snapshot은
> 일절 변경하지 않았고, 배포·재배포·환경변수 변경·실제 Provider 호출도
> 수행하지 않았습니다.

**표기 규칙**

- `[코드]` 리포지토리 소스에서 직접 확인
- `[테스트]` 자동화 테스트 실행 결과
- `[브라우저]` staging 실브라우저 계측 결과
- `[운영]` Railway / staging API / 공개 상태 페이지 실측
- `[미검증]` 이번 감사에서 근거를 확보하지 못함

---

## 1. Executive summary

| 항목 | 값 |
|---|---|
| 재감사 시작 | 2026-07-28 00:29:29 UTC (컨테이너 로컬 TZ = UTC, 동일) |
| 재감사 종료 | 2026-07-28 01:34 UTC |
| 최종 점수 | **78 / 100** (직전 81 → 78) |
| 최종 판정 | **No-Go** (동시에 `Needs operational verification`) |
| 검증 branch | `develop` |
| local HEAD SHA | `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6` |
| origin/develop SHA | `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6` |
| staging SHA | `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6` |
| deployment ID | `2351b283-29a3-4b98-8ada-038da7324c6d` (SUCCESS) |
| 실제 Provider 호출 | **수행하지 않음** (승인 없음) |
| Verified fixed | 5 (FINAL-F001, F003, F004, F005, F006) |
| Partially fixed | 1 (FINAL-F002) |
| Regressed | 0 |
| 신규 발견점 | 6 (`REAUDIT-F001`–`F006`) |
| 출시 blocker | 3 (REAUDIT-F001, REAUDIT-F002, FINAL-F002 미검증) |

### 요약

직전 감사에서 지적된 6건 중 **5건은 staging 실배포물에서 근본 원인까지 해결된 것으로
독립 확인**되었습니다. 특히 FINAL-F001은 "overlay를 줄인" 수준이 아니라 notice를
in-flow slot으로 옮긴 구조적 수정이고, FINAL-F003은 ref 우회나 lint 억제 없이
dependency array 한 줄로 근본 원인을 닫았음을 소스와 런타임 양쪽에서 확인했습니다.

그럼에도 **No-Go**인 이유는 세 가지입니다.

1. 공개 상태 페이지가 Perplexity를 **영구적으로 Incident로 표시**하고 있으며, 그 근거인
   "202회 연속 프로브 실패"는 더 이상 수집되지 않는 과거 값입니다. 같은 시각
   `/api/models/status`는 동일 Provider의 4개 모델을 모두 `available`로 보고합니다
   (REAUDIT-F001).
2. 카탈로그가 은퇴를 확인한 groq `llama-4-scout`가 여전히 공개 API에서 `available`로
   노출되어 사용자가 선택할 수 있습니다. 실제 호출은 HTTP 404입니다 (REAUDIT-F002).
3. 승인된 실제 Provider 호출이 없어 기본 3-model 경로와 AI Review의 **상용 가용성은
   여전히 `Not verified`** 입니다. 감사 원칙 4에 따라 mock 검증으로 대체할 수 없습니다.

---

## 2. Deployment baseline

| 기준 | 값 | 일치 여부 |
|---|---|---|
| Local HEAD | `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6` | ✅ |
| origin/develop | `8d02fc1d35f988d5c9d61ab9463fea01a3f0b3b6` | ✅ |
| Staging `/api/build-info` | `8d02fc1d…`, env `staging`, builtAt `2026-07-28T00:25:05.699Z` | ✅ |
| Railway deployment | `2351b283-29a3-4b98-8ada-038da7324c6d`, `SUCCESS`, branch `develop`, commit `8d02fc1d…` | ✅ |

- deploymentStartedAt `2026-07-28T00:22:51.738Z` / deployedAt `2026-07-28T00:26:56.007Z`
  — Railway `createdAt` / `updatedAt`과 초 단위까지 일치 `[운영]`.
- **네 기준이 모두 일치**하므로 이번 감사는 "staging에 실제로 떠 있는 커밋"을 대상으로
  판정했습니다. SHA 불일치로 인한 QA blocker는 없습니다.

### 감사 시작 시점의 저장소 상태 (기록)

- 감사 시작 시 local branch `claude/tomverse-final-stg-reaudit-xk7qvf`의 HEAD는
  `bd73e1d9…`였고, 이는 `origin/develop`의 조상이 **아니며** 139 커밋 뒤처진
  분기점이었습니다.
- working tree는 완전히 clean(수정/untracked 0건, stash 0건)이었으므로 사용자 변경을
  잃을 위험 없이 `git checkout -B … origin/develop`로 staging SHA에 정렬한 뒤 감사를
  진행했습니다. **사용자 작업물은 삭제·변경되지 않았습니다.**
- 과거 감사 기준 SHA `73bda8fd…`("Complete Native Web Search credit and cost
  accounting")는 현재 develop보다 44 커밋 뒤이며, 과거 deployment
  `83489687-77cb-4402-ac42-8f7c05e51549`는 현재 활성 배포가 아닙니다. 두 값 모두
  현재 검증 대상으로 사용하지 않았습니다.

### Staging smoke `[운영]`

| Route | HTTP | 비고 |
|---|---:|---|
| `/` | 200 | redirect 없음 |
| `/pricing` | 200 | |
| `/privacy` | 200 | |
| `/chat?entry=guest-preview` | 200 | |
| `/status` | 200 | 공개 Provider 상태 페이지 |
| `/api/build-info` | 200 | |
| `/providers` | 404 | 해당 경로는 존재하지 않음(상태 페이지는 `/status`) |

6개 viewport × 4개 route = 24개 조합에서 **console error 0건, hydration error 0건,
horizontal overflow 0px** `[브라우저]`. 관측된 `requestfailed`는 전부 Next.js RSC
prefetch와 `/api/models/status`의 `ERR_ABORTED`(페이지 전환 시 정상 취소)로, 실제
오류가 아닙니다.

---

## 3. FINAL-F001 – F006

| ID | 과거 심각도 | 판정 | Staging 증거 | Test 증거 | 남은 위험 |
|---|---|---|---|---|---|
| FINAL-F001 | P1 | **Verified fixed** | 24개 조합 실측 + hit-test | `marketing-consent-hero.spec.ts` 통과 | 없음 |
| FINAL-F002 | P1 | **Partially fixed / 실호출 Not verified** | 상태 페이지·API 실측 | 해당 없음(mock 불가) | **출시 blocker** |
| FINAL-F003 | P1 | **Verified fixed** | mock 런타임 독립 재현 | 회귀 테스트 **부재** | REAUDIT-F006 |
| FINAL-F004 | P2 | **Verified fixed** | 320–430px + 640/320 CSS px | `marketing-consent-hero.spec.ts` 통과 | 없음 |
| FINAL-F005 | P2 | **Verified fixed** | 3rd-party 요청 0건 | `security:regression` 113건 통과 | 없음 |
| FINAL-F006 | P3 | **Verified fixed** | en/ko/de/fr 렌더 텍스트 | `pricingFormat.test.mjs` 통과 | 없음 |

---

### FINAL-F001 — 320px consent notice가 Hero/CTA를 가림 → **Verified fixed**

**근본 원인 해결 여부: 해결됨.** screenshot만 통과시킨 수정이 아닙니다. marketing route에
`MarketingConsentSlot`이 sticky header 아래 **정상 문서 흐름**으로 추가되었고, notice가
그 slot으로 portal됩니다 `[코드]` (`components/marketing/MarketingChrome.tsx:353`,
`components/analytics/AnalyticsProvider.tsx:558`). 즉 겹칠 수 있는 fixed overlay 자체가
marketing route에서 사라졌습니다.

**Fresh context 실측 `[브라우저]`** (cookie/storage/consent 없음, cache 영향 최소화):

| 항목 | 320×568 `/` | 390×844 `/` | 320×568 guest chat |
|---|---|---|---|
| `position` | `static` | `static` | `static` |
| notice bounding box | (25, 80) 270×64 | (25, 80) 340×48 | (41, 395.6) 238×80 |
| notice body content width | **141.5px** | 211.5px | 109.5px |
| H1 bounding box | (16, 313) 288×151.2 | (16, 282) 358×113.4 | — |
| **배너 ∩ H1** | **0 px²** | **0 px²** | 0 px² |
| **배너 ∩ primary CTA** | **0 px²** | **0 px²** | 0 px² |
| Decline 크기 | 61.1 × 44 ✅ | 61.1 × 44 ✅ | 61.1 × 44 ✅ |
| Accept 크기 | 51.3 × 44 ✅ | 51.3 × 44 ✅ | 51.3 × 44 ✅ |
| document scrollWidth | 320 (overflow 0) | 390 (overflow 0) | 320 (overflow 0) |

**Hit-test (결정적 증거)** — `#landing-hero-primary`의 실제 중심점에서
`document.elementFromPoint()`:

| Viewport | notice가 slot 내부인가 | CTA 겹침 | H1 겹침 | CTA 중심 hit-test | 최상위 요소가 notice인가 |
|---|---|---|---|---|---|
| 320×568 | ✅ | ❌ 없음 | ❌ 없음 | ✅ CTA 도달 | ❌ 아님 |
| 360×640 | ✅ | ❌ | ❌ | ✅ | ❌ |
| 375×667 | ✅ | ❌ | ❌ | ✅ | ❌ |
| 390×844 | ✅ | ❌ | ❌ | ✅ | ❌ |
| 430×932 | ✅ | ❌ | ❌ | ✅ | ❌ |
| 844×390 (landscape) | ✅ | ❌ | ❌ | ✅ | ❌ |

**Keyboard / 접근성 `[브라우저]`**

- `/`: Tab 4회에 Decline, 5회에 Accept 도달 — **Decline이 Accept보다 먼저**(거부 우선,
  동등한 시각 위계).
- guest chat: Tab 8회 / 9회 도달.
- 두 버튼 모두 `aria-label`이 전체 문장(`Decline` / `Allow analytics`), 좁은 컨테이너에서만
  가시 텍스트가 축약되며 그 축약형은 accessible name의 부분 문자열입니다 `[코드]`
  (WCAG 2.5.3 Label in Name 충족).
- 컨테이너 쿼리(`@container/notice`)로 폭을 판정하므로 viewport가 아닌 실제 slot 폭에
  반응합니다 — sign-in card / chat composer slot / marketing 전폭에서 동일 마크업이
  올바르게 동작하는 근거 `[코드]`.
- consent를 거부해도 핵심 서비스 접근은 차단되지 않았습니다(거부 후 `/pricing` 정상
  탐색, 아래 §10 참조) `[브라우저]`.

**회귀 교차검사**: chat composer의 STG-F001은 되돌아가지 않았습니다 — guest chat 320px에서
notice는 composer 위 예약된 slot(높이 80px)에 있고 composer 컨트롤과 겹치지 않으며,
`Estimated 3 credits` / `Send · 3 credits` 컨트롤이 모두 44×44 이상으로 조작 가능합니다.

**잔여 미세 지적(발견점 아님)**: notice 본문 안의 `Privacy policy` 인라인 링크는
138.2×28px (chat에서는 74×12px)로 44×44 미만입니다. WCAG 2.5.8은 문장 내 인라인 링크를
예외로 두므로 위반은 아니지만, 모바일 정확도 측면에서 개선 여지가 있습니다.

---

### FINAL-F002 — 기본 Provider 경로 / 3-model 상용 가용성 → **Partially fixed, 실호출 Not verified**

**공개 상태 실측** — 두 시점 모두 이번 감사에서 새로 수집했습니다. 과거의 "71회 실패"
숫자는 재사용하지 않았습니다.

관측 1 `2026-07-28 00:33Z`, 관측 2 `2026-07-28 00:54Z` `[운영]`:

| Provider | 공개 상태 (00:54Z) | Last known good | Last real-traffic | Last automated check | 근거 유형 |
|---|---|---|---|---|---|
| OpenAI | Operational | 2026-07-27 10:19 UTC | 2026-07-27 10:19 UTC | 2026-07-28 00:50 UTC | synthetic probe |
| Anthropic | Operational | 2026-07-27 10:19 UTC | 2026-07-27 10:19 UTC | 2026-07-28 00:50 UTC | synthetic probe |
| Google Gemini | Operational (00:33Z에는 **Incident**, 5회 연속 실패) | 2026-07-27 10:19 UTC | 2026-07-27 10:19 UTC | 2026-07-28 00:50 UTC | synthetic probe |
| Groq | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| xAI | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| DeepSeek | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| Mistral | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| Moonshot Kimi | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| Qwen | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| Zhipu GLM | Operational | Not recorded | Never | 2026-07-28 00:50 UTC | synthetic probe |
| **Perplexity** | **Incident** | Not recorded | Never | **2026-07-27 23:30 UTC** | **정지된 과거 프로브 실패 202회** |

**상태 정직성 — 개선된 점 `[코드]` `[운영]`**

- `evaluatePublicProviderStatus()`가 단일 판단 함수이고 공개 페이지와 admin 패널이 모두
  `provider.publicStatus`를 그대로 읽으므로 두 화면이 모순될 수 없습니다.
- 성공 기록이 없으면 절대 Operational이 되지 않습니다 — "no incident ≠ operational"
  원칙이 코드 주석과 구현 양쪽에 명시.
- `unknown`은 초록이 아닌 중립(zinc)으로 렌더 — "근거 없음"이 건강 신호로 보이지 않음.
- probe 증거와 real-traffic 증거가 **별도 필드**(`lastProbeSuccessAt` 등)로 분리되어
  서로 덮어쓰지 않습니다.
- UI가 근거 유형을 문장으로 명시합니다: *"(from an automated synthetic check, not real
  user traffic)"*. 이는 이번 감사가 요구한 "구체적 timestamp 또는 근거 제공"을 충족합니다.
- probe 스케줄러 지연은 **provider 문제로 접히지 않고** 별도 page-level 공지로 분리됩니다.

**상태 정직성 — 남은 문제**

- OpenAI/Anthropic/Google의 **실제 사용자 트래픽 성공은 2026-07-27 10:19 UTC**로,
  감사 시점 기준 약 14.5시간 전입니다. 즉 현재의 Operational은 전부 **synthetic probe
  근거**입니다. UI가 이를 정직하게 밝히고 있으므로 허위 표시는 아니지만, **상용 트래픽
  경로가 살아 있다는 증거는 아닙니다.**
- Perplexity 항목은 REAUDIT-F001로 별도 등록했습니다.
- 상태 페이지와 `/api/models/status`가 서로 모순됩니다(같은 REAUDIT-F001).

**원인 분류** (read-only 근거 범위)

| 후보 원인 | 판정 |
|---|---|
| 외부 Provider 장애 | Google의 00:33Z Incident는 실제 간헐 장애(직전 감사 문서의 TIMEOUT 기록과 정합). 00:54Z 자동 회복 |
| API credential / scope | **기각** — 11개 중 10개가 매 사이클 성공 |
| endpoint / model identifier | groq `llama-4-scout` 은퇴 건에 해당 (REAUDIT-F002) |
| rate limit / quota | 근거 없음 |
| DNS / TLS / egress | 근거 없음 |
| synthetic probe 구현 | Perplexity는 probe-safe 모델이 없어 `no_probe_model`로 스킵됨 `[코드]` |
| freshness 집계 | Perplexity의 `consecutiveProbeFailures`가 리셋되지 않음 (REAUDIT-F001) |
| 실 트래픽 경로 ↔ probe 경로 불일치 | **확인됨** — 현재 Operational 판정은 전부 probe 근거 |

**기본 3-model 구성 — 현재 값 재확인** (과거 모델명을 가정하지 않고 재조회)

`[코드]` `lib/appDefaults.ts:19` `GUEST_BRAND_TRIO_MODEL_IDS`:

| 순번 | 모델 ID | Provider | usage class | 예상 credit | 현재 공개 상태 |
|---|---|---|---|---:|---|
| 1 | `gpt-5-4-mini` | OpenAI | Standard | 1 | available |
| 2 | `claude-haiku-4-5` | Anthropic | Standard | 1 | available |
| 3 | `gemini-2-5-flash` | Google | Standard | 1 | available |
| | | | **합계** | **3** | |

- Provider 다양성 확보(OpenAI/Anthropic/Google 3사) ✅
- 첫 paint에서 모델 수 3, 표시 credit 3 — composer의 `Estimated 3 credits, view
  breakdown` / `Send · 3 credits` aria-label과 일치 `[브라우저]`
- 삼총사 중 하나가 비활성화되면 `GUEST_FALLBACK_MODEL_IDS`에서 보충해 항상 3개를
  유지하며, 서버 렌더와 클라이언트 첫 렌더가 **같은 순수 함수**를 호출하므로 hydration
  전후 모델 수·credit이 달라지지 않습니다 `[코드]` — STG-F006 회귀 방지 설계.
- 감사 시점에 기본 3-model 중 incident 상태인 Provider는 없었습니다. 다만 00:33Z에는
  Google이 Incident였고, 그 순간에도 `/api/models/status`는 gemini 모델을 `available`로
  보고했습니다 → 사용자 경고 부재 (REAUDIT-F001의 두 번째 측면).

**승인된 실제 검증**: 수행하지 않았습니다. 사용자 승인이 없었고, 감사 원칙 4에 따라
mock 결과를 상용 가용성 근거로 승격하지 않습니다. 따라서 아래 항목은 전부
**`Not verified`** 입니다 — 3-model 비교 3회 실행, panel별 완료, latency, expected/actual
credit 일치, partial failure recovery, AI Review 실행 및 과금, 실패 요청 환불.

승인 요청안은 §14 뒤 「부록 A」에 제시했습니다.

---

### FINAL-F003 — comparison preflight가 stale `off` 전송 → **Verified fixed**

**근본 원인 해결 여부: 해결됨. 우회 아님.**

`[코드]` 수정 커밋 `f360ee3` — 변경량은 `app/(application)/chat/ChatPageClient.tsx`
**1줄**:

```
- }, [effectiveDisabledPanels, isGuestMode, selectedModels, showToast, t]);
+ }, [effectiveDisabledPanels, isGuestMode, selectedModels, showToast, t, webSearchMode]);
```

감사가 요구한 4개 확인 항목:

| 확인 항목 | 결과 |
|---|---|
| callback dependency가 최신 상태를 반영하는가 | ✅ `webSearchMode`가 dependency array에 포함 (`ChatPageClient.tsx:1058`) |
| lint 경고 억제로 문제를 숨겼는가 | ❌ 없음 — `eslint-disable` 없음, `npx eslint . --max-warnings=0` 통과 |
| 임의 ref로 React state 계약을 우회했는가 | ❌ 없음 — 호출자 `handleGlobalSubmit`은 `useCallback`이 아닌 매 렌더 재생성 함수라 항상 최신 클로저 |
| UI·preflight·chat이 단일 의미 계약을 쓰는가 | ✅ 셋 다 `lib/webSearchCredits.ts`의 `getWebSearchSurchargeCredits()` + `lib/webSearchCapability.ts` 사용 |
| server guard 유지 | ✅ `app/api/chat/preflight/route.ts:54` `z.enum(WEB_SEARCH_MODES)`, `:253` 서버가 capability를 재조회해 surcharge 재계산 |

**독립 런타임 재현 `[테스트]`** — 감사자가 직접 작성한 스펙(리포지토리 테스트 파생 아님)을
mock authenticated 환경(`E2E_DISABLE_DATABASE=true`, 외부 네트워크 차단)에서 실행. 실제
Provider 호출·credit 소비 없음. 선택 모델은 기본 3종 (`gpt-5-4-mini`,
`claude-haiku-4-5`, `gemini-2-5-flash`).

| 상태 전이 | UI 모드 | `/api/chat/preflight` body | `/api/chat` body ×3 | 일치 |
|---|---|---|---|---|
| 1. 기본 `off` | off | `webSearchMode: "off"` | 필드 없음 ×3 | ✅ |
| 2. `off → always` | always | `webSearchMode: "always"` | `"always"` ×3 | ✅ |
| 3. `always → off` | off | `webSearchMode: "off"` | 필드 없음 ×3 | ✅ |
| 4. mode 변경 직후 즉시 submit | always | `webSearchMode: "always"` | `"always"` ×3 | ✅ |
| 5. 빠른 연속 전환(`always→off→always`) 후 submit | always | `webSearchMode: "always"` | `"always"` ×3 | ✅ |

**stale `off` 0건, stale `always` 0건.** preflight의 `modelIds`도 3개 전부 정확히
전달되었습니다.

**Credit matrix** — 8-credit reservation 정책이 현재도 유효함을 코드에서 재확인
(`lib/models.ts:58` `webSearchSurcharge: 8`) 후 실제 capability로 산출 `[코드]`:

| Native-capable 모델 수 | 기대 search surcharge | 근거 |
|---:|---:|---|
| 0 | 0 | `modelEligibleForWebSearchSurcharge`가 `native`만 통과 |
| 1 | 8 | |
| 2 | 16 | |
| 3 | 24 | |
| 혼합 (예: native 1 + unsupported 2) | 8 | 미지원 모델에 비용이 붙지 않음 ✅ |
| `search-model` (Perplexity sonar 계열) | 0 | base weight에 이미 반영 ✅ |
| mode `off` / `auto` | 0 | 모든 모델 |

기본 3-model 실측 capability `[코드]`: `gpt-5-4-mini` = `unverified`(0),
`claude-haiku-4-5` = `native`(8), `gemini-2-5-flash` = `unverified`(0) →
기본 조합에서 `always` 시 surcharge는 **8**. `unverified`는 공식 문서로 확인되지 않은
모델을 보수적으로 분류한 것으로, 비용을 과다 청구하지 않는 안전한 방향입니다.

**남은 위험**: 이 계약을 잠그는 회귀 테스트가 없습니다 → REAUDIT-F006.

---

### FINAL-F004 — marketing brand가 `T.`로 축약 → **Verified fixed**

`[코드]` brand는 `shrink-0`, 언어 스위처가 shrink를 흡수. 부분 단어 truncation이
불가능하도록 **두 개의 완전한 단어 변형**을 `display:none`으로 토글합니다
(`<span class="sm:hidden">Tomverse</span>` / `<span class="hidden sm:inline">Tomverse Insight</span>`).

`[브라우저]` 실측:

| Viewport | visible text | scrollWidth | clientWidth | truncated | header overflow |
|---|---|---:|---:|---|---:|
| 320px | `Tomverse` | 109 | 109 | ❌ | 0 |
| 360px | `Tomverse` | 109 | 109 | ❌ | 0 |
| 375px | `Tomverse` | 109 | 109 | ❌ | 0 |
| 390px | `Tomverse` | 109 | 109 | ❌ | 0 |
| 430px | `Tomverse` | 109 | 109 | ❌ | 0 |
| 640 CSS px (=1280@200%) | `Tomverse Insight` | — | — | ❌ | 0 |
| 320 CSS px (=1280@400%) | `Tomverse` | — | — | ❌ | 0 |

- `T.`류 의미 손실 truncation **0건**.
- accessible name = 가시 텍스트. 숨은 변형이 `display:none`이므로 접근성 트리에서
  제외되어 이름이 중복되지 않습니다 `[코드]`. 로고 `<img>`는 `alt=""`(장식).
- 200% zoom에서 핵심 brand 유지 ✅.
- **RTL representative locale은 미검증** — 앱이 지원하는 7개 locale(en/ko/zh/fr/de/es/pt)에
  RTL 언어가 없어 재현 조건 자체가 존재하지 않습니다 `[미검증]`.
- 긴 locale(de/fr) 기준 header overflow 0 ✅.

---

### FINAL-F005 — Cloudflare Browser Insights beacon이 CSP에 차단 → **Verified fixed**

**정책 확인**: 이 프로젝트는 Browser Insights를 **사용하지 않는** 정책이며, 그 근거가
`lib/csp.ts:14-20`에 명시적으로 문서화되어 있습니다 — *"Deliberately absent:
static.cloudflareinsights.com … The agreed resolution is to disable Browser Insights in
Cloudflare rather than loosen this policy."* `[코드]`

따라서 판정 기준은 **"beacon 요청 자체가 없어야 함 + CSP를 완화하지 않아야 함"** 입니다.

`[브라우저]` fresh context, cache 제거, `/`·`/pricing`·`/privacy` × 6 viewport:

| 검사 항목 | 결과 |
|---|---|
| console error | **0건** (24개 조합 전부) |
| CSP violation | **0건** |
| `cloudflareinsights.com` 요청 | **0건** |
| injected 3rd-party script | **0건** |
| marketing route의 외부 host | **없음** (빈 배열) |
| chat route의 외부 host | `challenges.cloudflare.com` 만 (Turnstile, CSP에 명시 허용) |

**보안 회귀 점검 `[운영]`** (실제 응답 헤더):

| 항목 | marketing (`/`, `/pricing`, `/privacy`) | app (`/chat`) |
|---|---|---|
| `script-src` | `'self'` + sha384 해시 목록 + 구글/Turnstile 호스트 | `'self' 'nonce-…' 'strict-dynamic'` + 동일 호스트 |
| `unsafe-inline` | **없음** | **없음** |
| `unsafe-eval` | **없음** | **없음** |
| 광범위 wildcard | 없음 (`img-src https:`, `connect-src *.google-analytics.com` 등 한정적) | 동일 |
| `object-src` | `'none'` | `'none'` |
| `frame-ancestors` | `'none'` | `'none'` |
| `report-uri` / `report-to` | ✅ `/api/security/csp-report` | ✅ |
| `Cache-Control` | `public, s-maxage=3600` (PII 없음) | **`private, no-cache, no-store, must-revalidate`** ✅ |
| HSTS | `max-age=31536000; includeSubDomains` | 동일 |
| `X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` / `Permissions-Policy` | 모두 존재 | 모두 존재 |

console error를 필터링하거나 숨긴 흔적은 없습니다 — 애초에 요청이 발생하지 않습니다.
`security:regression` 113개 검사 통과 `[테스트]`.

---

### FINAL-F006 — 영어 pricing 문법 오류 → **Verified fixed**

`[코드]` `lib/pricingFormat.ts`가 신설되어 CLDR `Intl.PluralRules` 기반으로 단복수를
결정하고, 기간 결합을 한 곳에서 처리합니다. 호출부마다 다른 규칙을 쓰던 구조가
제거되었습니다.

`[브라우저]` 실제 렌더 텍스트 스캔 (en/ko/de/fr, 390×844):

| 결함 패턴 | 검출 건수 |
|---|---:|
| `1 credits` | **0** |
| `/ per ` | **0** |
| 중복 slash `/ /` | **0** |
| `per month per month` | **0** |

관측된 실제 문자열: `1 credit`, `4 credits`, `8 credits`, `13 credits`,
`300 monthly AI credits`, `500 credits`, `1,500 credits`, `4,000 credits`,
`10,000 monthly AI credits`, `per month`.

- 0/1/2/큰 수, monthly/annual, 무료 plan, credit pack 전 구간에서 단복수 정확 ✅
- 가격 **계산**은 변경되지 않았습니다 — `f360ee3`/`d46bc0d` 어느 쪽도 가격 산출 로직을
  건드리지 않고 표시 helper만 추가 `[코드]`
- ko/zh는 문법적 단복수 구분이 없어 두 슬롯에 같은 문자열을 넣는 구조라 영향 없음 ✅
- `pricingFormat.test.mjs` 82줄 신규 테스트 통과 `[테스트]`
- 다만 hydration 시 가격 문자열 변화는 **표시가 아니라 레이아웃 측면에서 문제**가
  있습니다 → REAUDIT-F003

---

## 4. STG-F001 – F010 회귀 matrix

| ID | 판정 | 검증 방법 | 증거 | 비고 |
|---|---|---|---|---|
| STG-F001 Chat analytics notice | **Pass** | `[브라우저]` 320×568 guest preview | notice가 composer 위 예약 slot(80px), composer 컨트롤과 겹침 0, overflow 0, `Estimated 3 credits`/`Send · 3 credits` 모두 44×44↑ | |
| STG-F002 768–1024 comparison layout | **Pass** | `[테스트]` | `model-comparison-layout.spec.ts` 767/768/820/912/1024/1180px 전부 통과, 모델명 컨트롤 ≥120px 단언 포함. `MIN_PANEL_WIDTH = 310` 주석이 120px 근거 명시 | staging 실제 3-panel 비교는 실호출 필요 → 코드/테스트 근거만 |
| STG-F003 IME 및 Enter 정책 | **Pass (조건부)** | `[코드]` + `[테스트]` | `lib/chatKeyboardPolicy.ts`: `isComposing` **및** `keyCode === 229` 병행, PC Enter 전송·Shift+Enter 줄바꿈, 모바일 Enter 줄바꿈·Ctrl/Cmd+Enter 전송 | 관련 E2E가 **간헐 실패** → REAUDIT-F005. **실제 물리 키보드·IME 미검증** |
| STG-F004 근거 기반 Provider status | **Partially pass** | `[코드]` + `[운영]` | 성공 근거 없으면 Operational 불가, freshness 30분, probe/traffic 분리, Unknown 중립 렌더 — 모두 확인 | Perplexity 사례가 원칙을 깨뜨림 → REAUDIT-F001 |
| STG-F005 Touch target | **Pass** | `[브라우저]` + `[테스트]` | consent Decline 61.1×44 / Accept 51.3×44, chat `More actions` 44×44, `Choose AI models` 88.3×44, credit breakdown 51×44, Send 44×44. `touch-targets.spec.ts` 통과 | 인접 target 충돌 없음 |
| STG-F006 First-paint credit | **Pass** | `[브라우저]` + `[코드]` | fresh 320px guest 첫 paint에서 모델 3 / credit 3 일치, hydration flicker 없음. 서버·클라이언트가 동일 순수 함수(`resolveGuestDefaultSelectedModels`) 사용 | `guest-initial-cost-hydration.spec.ts` 통과 |
| STG-F007 Source grounding | **Pass** | `[코드]` + `[테스트]` | label `"Source grounding"`. 설명문에 *"It does not measure factual accuracy, source reliability, or model confidence."* 명시. `aiReviewSourceGroundingInfoLabel`로 keyboard 접근 가능한 info 버튼 제공 | `source-grounding.spec.ts` 통과 |
| STG-F008 Model picker progressive disclosure | **Pass** | `[코드]` + `[테스트]` | 2단 구조(추천 화면 → `All models`), `MAX_MODEL_RECOMMENDATIONS = 8`, provider/task/search/usage 필터 존재, 30개 초과 카탈로그 탐색 가능 | `model-picker*.spec.ts` 4개 파일 통과 |
| STG-F009 Mobile model summary | **Pass** | `[브라우저]` | 320/390px 헤더에 `GPT-5.4 mini +2` 표시(대표 모델명 + `+2`), composer의 `3 AIs`/credit 3과 일치, 컨트롤 244×44 / 314×44 | `mobile-header-model-summary.spec.ts` 통과 |
| STG-F010 Build information | **Pass** | `[운영]` | environment/full SHA/short SHA/builtAt/deploymentId/startedAt/deployedAt/status 8개 필드 전부 존재, Railway 실배포와 초 단위 일치, 민감정보 없음 | §2 참조 |

---

## 5. 신규 발견점

### REAUDIT-F001 — 공개 상태 페이지가 프로브하지 않는 Provider를 영구 Incident로 표시하고, 상태 API와 모순됨

- **심각도**: **P1 (출시 blocker)**
- **분류**: Trust / 상태 정직성 / 데이터 정합성
- **대상 사용자**: `/status`를 보는 모든 방문자, Perplexity 모델을 선택하는 모든 사용자
- **과업**: 공개 상태 페이지에서 Provider 가용성을 확인한다
- **기대**: 상태는 현재 수집 중인 근거를 반영하고, 같은 시점의 상태 API와 일치한다
- **실제**:
  - `/status` (2026-07-28 00:54Z): **Perplexity = Incident**, 사유 *"202 consecutive
    automated probes have failed with no fresh real-traffic success to contradict them."*
  - 그러나 Perplexity의 `Last automated check`는 **2026-07-27 23:30 UTC**로, 나머지 10개
    Provider(00:50 UTC)보다 **80분 이상 정지**되어 있습니다.
  - `[코드]` 원인: `lib/providerProbe.ts`의 `PROBE_EXCLUDED_USAGE_CLASSES`가
    `research`/`deep-research`를 제외하는데, Perplexity는 **모든 모델이 검색 기반**이라
    `getProbeModelFor("perplexity")`가 `undefined`를 반환합니다. 라우트는 이를
    `no_probe_model`로 보고 *"neither recorded as probe evidence nor logged as an
    attempt"* 처리합니다 (`app/api/internal/provider-probe/check/route.ts:123-128`).
  - 결과적으로 성공도 실패도 더 이상 기록되지 않으므로 **`consecutiveProbeFailures = 202`가
    영원히 리셋되지 않습니다.** `evaluatePublicProviderStatus()`는 이 값이 임계치(3) 이상이고
    fresh success가 없으므로 계속 `incident`를 반환합니다.
  - 동시에 `/api/models/status`(같은 00:54Z)는 `perplexity/sonar`,
    `sonar-pro`, `sonar-reasoning-pro`, `sonar-deep-research` **4개 모두 `available`,
    `fallbackModelIds: []`** 로 보고합니다.
  - 부수 확인: 00:33Z에 Google이 Incident였을 때에도 `/api/models/status`는
    `gemini-2-5-flash`(기본 3-model 중 하나)를 `available`로 보고했습니다. 두 소스가
    다른 필드(`publicStatus` vs 내부 `status`)를 읽기 때문입니다
    (`app/api/models/status/route.ts:88-91`은 `provider?.status === "outage"`만 봄).
- **영향**: (a) 정상일 가능성이 높은 Provider에 대해 **영구적인 허위 장애 공시**,
  (b) 상태 페이지를 믿고 회피한 사용자에게 불필요한 이탈, (c) 반대로 채팅 UI는
  아무 경고 없이 해당 모델을 제공 — **공개 약속과 제품 동작의 정면 모순**,
  (d) 이 상태가 production에 그대로 나가면 상태 페이지 신뢰도 전체가 훼손됩니다.
- **재현**: `curl https://staging.tomverse.app/status` 와
  `curl https://staging.tomverse.app/api/models/status` 를 같은 시각에 비교
- **source evidence**: `lib/providerProbe.ts:126-168`,
  `app/api/internal/provider-probe/check/route.ts:118-131`,
  `lib/providerPublicStatusCore.ts` (probe 분기),
  `app/api/models/status/route.ts:86-92`
- **staging evidence**: `logs/status-text-2.txt`, `/api/models/status` 응답 (00:54:55Z)
- **권장**:
  1. `no_probe_model`은 단순 스킵이 아니라 **probe 증거를 무효화**해야 합니다 —
     해당 Provider의 `consecutiveProbeFailures`를 0으로 만들고 상태를 `unknown`(중립)으로
     보내야 "근거 없음"이 "장애"로 둔갑하지 않습니다.
  2. 이미 쌓인 Perplexity의 202 카운터를 1회성으로 정리.
  3. 공개 상태 페이지와 `/api/models/status`가 **동일한 `publicStatus`** 를 읽도록 통일하거나,
     최소한 `incident` Provider의 모델에 사용자 경고/대체 경로를 붙일 것.
- **완료 조건**: 임의 시각에 `/status`와 `/api/models/status`를 동시 조회했을 때 Provider별
  판정이 모순되지 않고, 프로브 대상이 아닌 Provider가 `incident`로 표시되지 않을 것.

---

### REAUDIT-F002 — 은퇴가 확인된 groq `llama-4-scout`가 여전히 `available`로 노출되어 선택 가능

- **심각도**: **P1 (출시 blocker)**
- **분류**: Core task success / 모델 레지스트리 정합성
- **대상 사용자**: 모델 선택기에서 groq 모델을 고르는 모든 사용자
- **과업**: 모델을 선택하고 메시지를 보낸다
- **기대**: `available`로 표시된 모델은 실제로 호출 가능하다
- **실제**: `/api/models/status` (2026-07-28 00:54:55Z)가
  `llama-4-scout: available`, `fallbackModelIds: []`로 보고합니다. 그러나 리포지토리
  자체 기록에 따르면 이 모델은 카탈로그 스캔에서 **7회 연속 누락**되어
  `likely_deprecated`로 승격되었고 `missingSinceAt = 2026-07-21T03:40:12.564Z`,
  실제 호출은 **HTTP 404**입니다 `[코드]`
  (`.github/audits/provider-probe-staging-reaudit.md` §2.3).
  커밋 `8a59091`의 메시지가 이 상태를 명시합니다 — *"groq's llama-4-scout sat at seven
  consecutive misses for six days while staying enabled and user-selectable, failing
  every call with HTTP 404"*, 그리고 자동 비활성화는 *"on the next catalog run"* 에
  적용된다고 밝히고 있습니다.
- **영향**: 사용자가 이 모델을 포함해 비교를 실행하면 해당 panel이 404로 실패합니다.
  3-model 비교에서 1개 panel이 죽으면 partial failure 경로와 환불 경로가 동시에
  트리거되므로, credit 정합성까지 함께 위험해집니다.
- **재현**: `curl https://staging.tomverse.app/api/models/status | grep llama-4-scout`
- **source evidence**: `lib/providerModelCatalogReconciliation.ts`(수정은 배포됨),
  커밋 `8a59091` 메시지, `.github/audits/provider-probe-staging-reaudit.md`
- **staging evidence**: `/api/models/status` 응답 (00:54:55Z), 배포
  `b48105ed-f851-4048-8a64-ae9ecb602578`(Provider Model Catalog, SUCCESS, 00:26:25Z)
- **권장**: 카탈로그 크론을 1회 수동 실행해 reconciliation이 실제로 이 항목을
  `enabled:false`로 내리는지 확인하고, 그 결과를 `/api/models/status`에서 재검증.
  자동 실행만 기다리는 것은 배포 판정 근거가 되지 못합니다.
- **완료 조건**: `/api/models/status`에서 `llama-4-scout`가 사라지거나 `unavailable` +
  `fallbackModelIds`가 채워질 것.

---

### REAUDIT-F003 — `/pricing` 첫 로드에서 재현 가능한 0.173 CLS

- **심각도**: P2
- **분류**: 성능 / 레이아웃 안정성
- **대상 사용자**: 모바일에서 요금제를 처음 보는 모든 방문자
- **기대**: CLS ≤ 0.1 (Core Web Vitals "good")
- **실제**: 390×844 cold cache 3회 반복 — **median CLS 0.173, max 0.259**.
  추가 2회 반복에서도 **매번 정확히 0.1734**, 발생 시각 ~1541ms / ~1551ms로 결정적.
  단일 shift가 전체를 차지하며 원인 노드는 요금제 카드
  `ARTICLE.relative flex min-h-full flex-col rounded-[1.75rem] border …`
  (텍스트 `"For starting outFree300 monthly AI credi…"`) 입니다. 통화 확정 가격이
  클라이언트에서 늦게 도착하면서 카드 높이가 재계산되는 것으로 보입니다
  (페이지에 `Loading current credit-pack pricing…` placeholder 존재).
- **직전 감사 대비**: 과거 단일 표본 0.109 → 이번 median 0.173. **명백한 악화**이므로
  Phase 10 지침에 따라 신규 발견점으로 등록합니다. 반대로 LCP는 2.552s → median 888ms로
  크게 개선되었고, 360px chat CLS는 0.108 → **0.000** 으로 해소되었습니다.
- **권장**: 가격 라인에 통화 확정 전 고정 높이(또는 skeleton)를 예약해 카드 높이가
  변하지 않게 할 것.
- **완료 조건**: `/pricing` 390px cold cache 3회 median CLS ≤ 0.1.

---

### REAUDIT-F004 — mobile 프로젝트에서 100% 재현되는 E2E 실패 (stale expectation)

- **심각도**: P2
- **분류**: QA traceability / 테스트 무결성
- **기대**: 전체 suite에 설명되지 않은 실패가 없다
- **실제**: `tests/e2e/chat-tools.spec.ts:114` *"web search mode selection does not repeat
  across a new chat"* 가 `mobile-chromium`에서 **5/5 실패**(결정적), `desktop-chromium`과
  `desktop-compact`에서는 통과.
- **원인 규명**: 제품 결함이 **아닙니다**. 모바일 헤더의 새 채팅 버튼은
  `{!isActiveConversationEmpty && …}` 조건부 렌더입니다
  `[코드]` (`components/chat/MobileChatShell.tsx:542-551`). 테스트는 메시지를 보내지 않은
  빈 대화 상태에서 `New chat` 버튼을 찾으므로, 버튼이 의도적으로 숨겨져 있어 30초
  타임아웃이 납니다. 데스크톱 사이드바에는 항상 있으므로 통과합니다.
- **영향**: (a) 전체 suite가 상시 red라 진짜 회귀를 가립니다. (b) 더 중요하게,
  **"웹 검색 모드가 새 채팅으로 이월되지 않는다"는 계약이 모바일에서 전혀 검증되지
  않고 있습니다** — FINAL-F003과 인접한 상태 관리 영역입니다.
- **권장**: 테스트를 데스크톱 프로젝트로 한정하거나, 모바일에서는 메시지를 1회 보낸 뒤
  헤더 버튼을 사용하도록 경로를 수정할 것. 어느 쪽이든 모바일 계약 검증을 남길 것.
- **완료 조건**: 3개 chromium 프로젝트 전체 suite가 실패 0으로 종료.

---

### REAUDIT-F005 — `chat-keyboard-policy` 모바일 스펙의 미해결 flake (STG-F003 근거 약화)

- **심각도**: P2
- **분류**: Flake / race
- **실제**: 동일 스펙을 5회 반복 실행한 결과 — 반복 1: `:226` 실패, 반복 2: 실패 없음,
  반복 3: `:214` 실패, 반복 4: `:238` 실패, 반복 5: `:214`,`:226`,`:238` +
  `desktop-compact :79` 실패. **매번 다른 테스트가 실패**하고 CPU 부하가 높을수록
  실패 수가 늘어나는 전형적 타이밍 flake입니다.
- **영향**: 이들은 **STG-F003(IME/Enter 정책)을 지키는 바로 그 테스트**입니다. 즉
  STG-F003의 자동화 근거가 신뢰할 수 없는 상태이며, 로컬 `retries: 0`과 달리 CI는
  `retries: 2`이므로 CI에서는 이 불안정성이 가려집니다.
- **권장**: 단독 재실행 1회 통과로 종결하지 말 것. 공유 상태·타이머·focus race를
  조사하고, timeout 증량이 아닌 원인 수정을 요구합니다.
- **완료 조건**: 해당 스펙 5회 연속 실패 0.

---

### REAUDIT-F006 — FINAL-F003 회귀를 잠그는 테스트 부재

- **심각도**: P3
- **분류**: 유지보수성 / 회귀 방지
- **실제**: 수정 커밋 `f360ee3`는 소스 1줄만 변경했고 테스트를 추가하지 않았습니다.
  현재 `/api/chat/preflight` body의 `webSearchMode`를 단언하는 테스트는 **한 건도
  없습니다** — `tests/e2e/upgrade-discovery.spec.ts`만 이 엔드포인트를 가로채지만
  credit 게이팅 시나리오용이고, 공용 fixture
  (`tests/e2e/support/app-fixtures.ts:334-345`)는 body에서 `comparisonId`와 `modelIds`만
  읽습니다. `native-web-search.spec.ts`는 `/api/chat` body만 검사합니다.
- **영향**: 정확히 같은 형태의 dependency-array 누락이 재발해도 CI가 잡지 못합니다.
  이 결함은 이미 한 번 프로덕션 경로까지 갔던 유형입니다.
- **권장**: 본 보고서 §3 FINAL-F003 표의 5개 전이를 그대로 스펙화할 것
  (감사자가 사용한 검증 스펙을 증거 아카이브에 포함했습니다).
- **완료 조건**: preflight body의 `webSearchMode`를 최소 `off→always`, `always→off`,
  빠른 연속 전환 3케이스에 대해 단언하는 테스트 존재.

---

## 6. 테스트 결과

| Suite | Command | Pass | Fail | Skip | 최초/재실행 | 분류 |
|---|---|---:|---:|---:|---|---|
| Typecheck | `npm run typecheck` | ✔ | 0 | — | 최초 | 통과 |
| Lint (source-scoped) | `npx eslint . --max-warnings=0` | ✔ | 0 | — | 최초 | 통과 (경고 0) |
| Security regression | `npm run security:regression` | 113 | 0 | 0 | 최초 | 통과 |
| Text encoding | `npm run check:encoding` | ✔ | 0 | — | 최초 | 통과 |
| Unit | `npm run test:unit` | **499** | **0** | **0** | 최초 | 통과 |
| Production build | `npm run build` | ✔ | 0 | — | 최초 | 통과 |
| E2E (chromium ×3 project) | `playwright test --project=desktop-chromium --project=desktop-compact --project=mobile-chromium` | **829** | **4** | 511 | 최초 (13.9m) | 아래 분류 |
| E2E 재실행 ×5 (실패 스펙 격리) | 동일 3 spec | — | 1–5 | 14 | 재실행 5회 | 아래 분류 |
| 감사자 검증 스펙 (FINAL-F003) | 별도 config, mock 환경 | 1 | 0 | 0 | 2회 | 통과 |

### 실패 분류

| 실패 | 분류 | 근거 |
|---|---|---|
| `chat-tools.spec.ts:114` (mobile-chromium) | **Stale expectation** (제품 결함 아님) | 5/5 결정적 재현, desktop 2개 프로젝트 통과. 모바일 새 채팅 버튼이 빈 대화에서 의도적으로 숨겨짐 → REAUDIT-F004 |
| `chat-keyboard-policy.spec.ts:214/226/238` (mobile-chromium) | **Flake / race** | 5회 반복에서 매번 다른 테스트가 실패, 부하 상승 시 악화 → REAUDIT-F005 |
| `chat-keyboard-policy.spec.ts:79` (desktop-compact) | **Flake / race** | 반복 5회 중 1회만 발생 |
| `signin-localization.spec.ts:151` (desktop-compact, mobile-chromium) | **Flake / race** | 전체 suite 병렬 실행에서만 실패, 격리 반복 5/5 통과. `page.route()` 설치와 NextAuth 백그라운드 세션 폴링 사이의 경합 |

### 테스트 무결성 점검

- 의미 있는 assertion 삭제 흔적: **없음**. `d46bc0d`는 `marketing-consent-hero.spec.ts`
  214줄과 `pricingFormat.test.mjs` 82줄을 **추가**했습니다.
- skip 증가: 511 skip은 대부분 `test.skip(testInfo.project.name !== …)` 형태의
  프로젝트 스코핑으로, 각 테스트가 1개 프로젝트에서 1회만 도는 정상 패턴입니다.
- timeout 과도 증가: 없음 (기본 30s 유지).
- golden 무검토 갱신: 없음. 다만 `chat-state-visual-regression.spec.ts`(골든)가
  커밋 `8d02fc1`에서 **PR 게이트에서 nightly로 이동**되었습니다. 커버리지 자체는
  유지되지만 골든 파손이 merge를 막지 않고 최대 하루 늦게 드러납니다 — 의도된
  트레이드오프로 커밋에 문서화되어 있으나, 출시 직전 창구에서는 리스크로 인지해야 합니다.
- mock이 실제 회귀를 가리는지: FINAL-F003 관련해서 **그렇습니다** — 공용 fixture가
  preflight body의 `webSearchMode`를 무시합니다 (REAUDIT-F006).

---

## 7. 접근성

| 항목 | 판정 | 자동 | Keyboard | 실기기 | 비고 |
|---|---|---|---|---|---|
| Consent focus order | Pass | ✔ | ✔ Tab 4/5 (`/`), 8/9 (chat) | ✗ | Decline이 Accept보다 선행 |
| Accept/Reject 동등성 | Pass | ✔ | ✔ | ✗ | 둘 다 44×44↑, 동일 스타일 클래스, 동일 위계 |
| Marketing CTA | Pass | ✔ | ✔ | ✗ | hit-test 6 viewport 통과 |
| Brand link | Pass | ✔ | — | ✗ | accessible name = 가시 텍스트 |
| Composer controls | Pass | ✔ | — | ✗ | 4개 컨트롤 전부 44×44↑ |
| Touch target | Pass | ✔ | — | ✗ | `touch-targets.spec.ts` 통과 |
| Modal / bottom sheet | Pass | ✔ | — | ✗ | `model-picker-responsive.spec.ts` 통과 |
| Model picker | Pass | ✔ | — | ✗ | back/done 버튼 hit-area 단언 포함 |
| Source grounding tooltip | Pass | ✔ | — | ✗ | info 버튼에 accessible label 존재 |
| Pricing accessible text | Pass | ✔ | — | ✗ | 단복수 정확 → 스크린리더 낭독 자연스러움 |
| Provider status semantics | Partially pass | ✔ | — | ✗ | Unknown 중립 렌더 ✔ / REAUDIT-F001 |
| Comparison action | Pass | ✔ | — | ✗ | `comparison-action-rail.spec.ts` 통과 |
| Error / retry flows | Not verified | — | — | ✗ | 실호출 필요 |
| 320px reflow (WCAG 1.4.10) | Pass | ✔ | — | ✗ | **320 CSS px(=1280@400%)에서 4개 route 모두 overflow 0** |
| 640 CSS px (=1280@200%) reflow | Pass | ✔ | — | ✗ | overflow 0 |
| 200% text-only zoom (WCAG 1.4.4) | **Not verified** | — | — | ✗ | CSP `style-src`가 주입 스타일을 차단해 계측 불가 — 보안이 올바르게 동작한 결과 |
| forced-colors | **Not verified** | — | — | ✗ | 이번 감사 미수행 |
| prefers-reduced-motion | **Not verified** | — | — | ✗ | 이번 감사 미수행 |
| dark / light | Partially verified | ✔ | — | ✗ | dark 기준 계측, light 별도 미수행 |
| ko / en / 긴 locale (de, fr) | Pass | ✔ | — | ✗ | header overflow 0, 문법 결함 0 |
| RTL representative locale | **N/A** | — | — | — | 지원 7개 locale에 RTL 없음 |

### 명시적 `Not verified`

VoiceOver, TalkBack, NVDA/JAWS, 삼성 키보드, Gboard, iOS 한국어 키보드, 물리적 모바일
기기, 모바일 외부 keyboard — **전부 이번 감사에서 검증하지 않았습니다.**
자동 계측만으로 WCAG 전체 통과를 주장하지 않습니다. 특히 STG-F003(IME) 판정은 코드 및
합성 이벤트 근거일 뿐, 실제 한국어 IME 조합 동작을 확인한 것이 아닙니다.

---

## 8. 운영 상태

기준 시각 **2026-07-28 00:54 UTC** (컨테이너 TZ = UTC).

| Provider | 공개 상태 | Probe freshness | Traffic success | 연속 실패 | 실제 호출 | 판정 |
|---|---|---|---|---:|---|---|
| OpenAI | Operational | 00:50Z (fresh, 4분) | 2026-07-27 10:19Z (**14.5h 경과, stale**) | 0 | 없음 | probe 근거만 |
| Anthropic | Operational | 00:50Z (fresh) | 2026-07-27 10:19Z (stale) | 0 | 없음 | probe 근거만 |
| Google Gemini | Operational | 00:50Z (fresh) | 2026-07-27 10:19Z (stale) | 0 (00:33Z에는 5) | 없음 | 간헐 장애 이력 |
| Groq | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 · REAUDIT-F002 |
| xAI | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 |
| DeepSeek | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 |
| Mistral | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 |
| Moonshot Kimi | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 |
| Qwen | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 |
| Zhipu GLM | Operational | 00:50Z (fresh) | 기록 없음 | 0 | 없음 | probe 근거만 |
| **Perplexity** | **Incident** | **23:30Z (80분 정지)** | 기록 없음 | **202 (동결)** | 없음 | **REAUDIT-F001** |

- freshness window: 30분 (`DEFAULT_PUBLIC_STATUS_FRESHNESS_MINUTES`)
- **freshness window 밖의 success가 Operational 근거로 쓰인 사례는 없습니다** ✅ — 현재
  Operational은 전부 window 안의 probe 성공에 근거합니다.
- 성공 기록이 없는 Provider가 Operational로 표시되지 않는 원칙도 지켜집니다 ✅ —
  `Last known good: Not recorded`인 Provider들은 probe 성공을 근거로 삼습니다.
- Provider-level과 model-level incident는 코드상 분리되어 있습니다
  (`modelIncidents`, `hasActiveModelIncident`) ✅.
- **API key / token / cookie / session identifier는 본 보고서 어디에도 기록하지
  않았습니다.** Provider 장애 원인을 key·egress·외부 장애로 단정하지 않았고, 근거가
  부족한 항목은 `Unknown cause`로 남겼습니다.

---

## 9. Credit 및 web-search matrix

기본 3-model 기준 (`gpt-5-4-mini` / `claude-haiku-4-5` / `gemini-2-5-flash`),
mock authenticated 환경 실측 `[테스트]` + 코드 산출 `[코드]`:

| Mode | 모델 수 | native 지원 수 | UI | Preflight body | Chat body ×3 | 기대 base credit | 기대 surcharge | Provider calls |
|---|---:|---:|---|---|---|---:|---:|---:|
| off (기본) | 3 | 1 | chip 없음 | `"off"` | 필드 생략 | 3 | 0 | 0 (mock) |
| off → always | 3 | 1 | always | `"always"` | `"always"` ×3 | 3 | 8 | 0 (mock) |
| always → off | 3 | 1 | off | `"off"` | 필드 생략 | 3 | 0 | 0 (mock) |
| 변경 직후 즉시 submit | 3 | 1 | always | `"always"` | `"always"` ×3 | 3 | 8 | 0 (mock) |
| 빠른 연속 전환 후 submit | 3 | 1 | always | `"always"` | `"always"` ×3 | 3 | 8 | 0 (mock) |

Native 지원 수별 surcharge (코드 산출):

| Native-capable 모델 수 | 기대 search surcharge |
|---:|---:|
| 0 | 0 |
| 1 | 8 |
| 2 | 16 |
| 3 | 24 |

- 미지원(`unsupported`/`unverified`) 모델에 비용이 잘못 추가되지 않음 ✅
- `search-model`(Perplexity)에 중복 surcharge 없음 ✅
- **부족한 credit에서 provider request가 0인지**: `[미검증]` — 실제 credit 잔액 조작이
  필요하며 승인된 실호출 범위 밖입니다. 서버 측 가드 자체는 코드로 확인했습니다
  (`preflightChatComparisonAccess`, 그리고 `/api/chat`이 모든 요청에서 model·소유권·plan·
  credit·cost limit을 **재검증**한다는 주석과 구현).
- **expected/actual credit 일치, 환불 동작**: `[미검증]` — `lib/creditLedger.ts:194-225`에
  reservation 대비 미사용분을 `refund` 원장으로 되돌리는 로직이 존재하나, 실제 소비·환불은
  실호출 없이 확인할 수 없습니다.

---

## 10. Security / privacy

| 항목 | 결과 |
|---|---|
| CSP (marketing) | `'self'` + sha384 해시. `unsafe-inline`/`unsafe-eval`/wildcard **없음** |
| CSP (application) | `'self' 'nonce-…' 'strict-dynamic'`. 동일하게 완화 없음 |
| CSP 광범위 완화 | **없음** — Cloudflare Insights 호스트를 추가하지 않고 기능을 끄는 방향으로 해결 |
| Cloudflare / third-party scripts | marketing route 외부 요청 **0건**. chat은 `challenges.cloudflare.com`(Turnstile)만, CSP에 명시 허용 |
| analytics consent (동의 전) | GA/GTM 요청 **0건** ✅ |
| analytics consent (거부 후) | GA/GTM 요청 **0건** ✅ — 거부 후 `/pricing` 재탐색에서도 0건 |
| analytics consent (수락 후) | `www.googletagmanager.com` 2건 — 동의 후에만 실행 ✅ |
| 동의 거부 시 서비스 접근 | 차단되지 않음 ✅ |
| `no-store` | `/chat` 응답에 `private, no-cache, no-store, max-age=0, must-revalidate` ✅ |
| HSTS | `max-age=31536000; includeSubDomains` ✅ |
| 기타 보안 헤더 | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`(camera/mic/geo/payment/usb/browsing-topics 전부 차단) ✅ |
| CSP 리포팅 | `report-uri /api/security/csp-report` + `report-to` 그룹 구성 ✅ |
| security regression suite | 113개 검사 통과 ✅ |
| build-info 민감정보 | 노출 없음 (환경명·SHA·타임스탬프·배포 ID만) ✅ |

**발견된 예외**: 없습니다. 보안·개인정보 영역은 이번 재감사에서 **회귀 0건**이며,
동의 이전 비승인 추적도 실측으로 부정되었습니다.

부수 관찰: 200% text-only zoom 계측이 실패한 원인이 CSP의 `style-src` 적용이었습니다.
계측 관점에서는 제약이지만 **보안 관점에서는 정책이 실제로 강제되고 있다는 긍정적 증거**입니다.

---

## 11. 성능 관찰

- 반복 횟수: route당 **3회**, cold cache(매회 새 browser context)
- 환경: 감사 컨테이너 → TLS 종단 프록시 경유 → staging. 절대값은 실사용자 네트워크와
  다르므로 **상대 비교와 재현성 위주로 해석**해야 합니다.
- 디바이스: `isMobile: true`, `hasTouch: true`

| Route @ viewport | median LCP | max LCP | median CLS | max CLS | median TTFB |
|---|---:|---:|---:|---:|---:|
| `/pricing` @390×844 | 888 ms | 976 ms | **0.173** | **0.259** | 688 ms |
| `/` @390×844 | 896 ms | 900 ms | 0.034 | 0.182 | 678 ms |
| `/chat?entry=guest-preview` @360×640 | 1224 ms | 1312 ms | **0.000** | 0.000 | 782 ms |

**직전 감사 단일 표본과의 비교** (과거 값을 현재 값으로 재사용하지 않고 새로 측정):

| 지표 | 과거 단일 표본 | 이번 median (n=3) | 변화 |
|---|---:|---:|---|
| 360px chat CLS | 0.108 | **0.000** | 해소 ✅ |
| pricing LCP | 2.552 s | **0.888 s** | 대폭 개선 ✅ |
| pricing CLS | 0.109 | **0.173** | **악화** → REAUDIT-F003 |

**측정 한계**: 표본 3개(shift 원인 규명은 추가 2회)로 통계적 신뢰구간을 주장하지
않습니다. 다만 `/pricing`의 CLS는 5회 모두 동일한 단일 shift(0.1734)로 관측되어
결정적 재현성이 확보되었습니다. 네트워크 프로파일은 조절하지 않았습니다.

---

## 12. 증거 목록

모두 리포지토리 파일을 덮어쓰지 않는 임시 위치(`<scratchpad>/audit/`)에 보관했고,
민감정보는 포함되어 있지 않습니다.

| 종류 | 위치 / 식별자 |
|---|---|
| Screenshot | `shots/` — 24개 조합 pass1, 24개 pass2, zoom200 3개, overflow 진단 5개, pricing locale 4개 |
| DOM / bounding-box 측정 | `logs/staging-measure.json` (50 KB), `logs/staging-pass2.json` (62 KB) |
| Hit-test 결과 | `logs/staging-pass3.json` (`heroCta` 섹션, 6 viewport) |
| Reflow / overflow 계측 | `logs/staging-reflow.json` (7 케이스 × 4 route) |
| Console / network logs | `staging-measure.json`의 `consoleErrors`·`failedRequests`·`thirdPartyRequests` 필드 |
| API body (preflight / chat) | §3 FINAL-F003 표, 감사자 검증 스펙 stdout |
| Credit breakdown | §9, `credit-matrix.mts` 출력 |
| Provider status 원문 | `logs/status-text.txt` (00:33Z), `logs/status-text-2.txt` (00:54Z) |
| Pricing 렌더 텍스트 | `logs/pricing-text.txt`, `logs/staging-pass2.json`의 `locale` 섹션 |
| build-info | §2 (staging 응답 + Railway deployment 메타) |
| 성능 표본 | `logs/staging-perf.json` |
| Test artifacts | `logs/e2e-report.json`, `test-results/`, `verify-results/` |
| 감사자 검증 스펙 | `verify/final-f003.spec.ts` (FINAL-F003 재현용, 제품 코드 아님) |
| Playwright 감사용 config | `pw.audit.config.ts`, `pw.verify.config.ts` — 리포지토리 config를 import하고 **브라우저 바이너리 경로와 webServer cwd만** 지정. 테스트·단언·timeout·retry·project 정의는 일절 변경하지 않음 |

**감사 환경 제약(투명성 고지)**: 감사 컨테이너의 Playwright 브라우저(1194)가 리포지토리가
고정한 버전(@playwright/test 1.62)과 달라 `/opt/pw-browsers/chromium`을 지정했고,
TLS 종단 프록시가 TLS 1.3 handshake를 리셋해 브라우저 계측 시 `--ssl-version-max=tls1.2`를
사용했습니다. **인증서 검증은 비활성화하지 않았습니다**(프록시 CA는 시스템 신뢰
저장소에서 정상 검증됨). 이 설정은 전송 계층에만 영향을 주며 DOM·레이아웃·CSP·요청 본문
계측 결과에는 영향이 없습니다. 다만 **TLS 버전 의존 동작은 브라우저 경로로 관측되지
않았습니다**(`curl` 경로는 TLS 1.3으로 정상 동작 확인).

---

## 13. 미검증 범위

| 항목 | 사유 |
|---|---|
| 기본 3-model 실제 비교 3회 | 사용자 승인 없음 (감사 원칙 4) |
| 각 panel completion / latency / response status | 동일 |
| AI Review 실제 실행 및 과금 | 동일 |
| expected vs actual credit 일치 | 동일 |
| 실패 요청의 실제 환불 | 동일 |
| partial failure recovery 실동작 | 동일 |
| 부족한 credit에서 provider request 0건 | credit 잔액 조작 필요, 승인 범위 밖 |
| Provider 응답 내용 정확도 | 가용성 검사와 분리했고 이번 범위 아님 |
| staging DB 직접 조회 (`ProviderProbeResult` 등) | DB 접근 권한 없음 — 공개 API·상태 페이지·Railway 메타로 대체 |
| VoiceOver / TalkBack / NVDA / JAWS | 실기기·스크린리더 미보유 |
| 삼성 키보드 / Gboard / iOS 한국어 키보드 | 동일 |
| 물리적 모바일 기기, 모바일 외부 keyboard | 동일 |
| forced-colors, prefers-reduced-motion | 이번 감사 미수행 |
| 200% text-only zoom (WCAG 1.4.4) | CSP `style-src`가 계측용 스타일 주입을 차단 |
| light 테마 전수 계측 | dark 기준으로만 수행 |
| RTL locale | 지원 locale에 RTL 없음 (N/A) |
| webkit / mobile-safari E2E project | 감사 컨테이너에 webkit 브라우저 미설치 |
| staging 3-panel 비교 레이아웃 실관측 (768–1024) | 실호출 없이 panel 생성 불가 — 코드·E2E 근거로 대체 |
| TLS 1.3 경로의 브라우저 동작 | 감사 프록시 제약 (curl 경로로는 정상 확인) |

---

## 14. Top recommendations

| # | 권장 | 영역 | 완료 조건 |
|---|---|---|---|
| 1 | `no_probe_model` Provider의 probe 실패 카운터를 무효화하고 상태를 `unknown`으로 보낼 것. Perplexity의 202 카운터를 1회성 정리 | Provider monitoring | `/status`에서 프로브 대상이 아닌 Provider가 `incident`로 표시되지 않음 |
| 2 | `/status`와 `/api/models/status`가 동일한 `publicStatus`를 읽도록 통일하거나, incident Provider의 모델에 사용자 경고·대체 경로를 부여 | Provider monitoring / Chat UI | 임의 시각 동시 조회 시 두 소스가 모순되지 않음 |
| 3 | 카탈로그 reconciliation 크론을 1회 수동 실행해 `llama-4-scout` 비활성화를 확인 | Model registry / Ops | `/api/models/status`에서 해당 모델이 사라지거나 `unavailable` + fallback 제공 |
| 4 | 승인 하에 기본 3-model 비교 3회 + AI Review 1회를 staging에서 실행하고 credit 정합성·환불을 실측 | Ops / Billing | §9의 `[미검증]` 행이 실측값으로 채워짐 |
| 5 | `chat-tools.spec.ts:114`를 데스크톱 한정으로 조정하거나 모바일 경로를 수정 | QA | 3개 chromium project 전체 suite 실패 0 |
| 6 | `chat-keyboard-policy` 모바일 flake의 원인(공유 상태·타이머·focus race)을 수정. timeout 증량 금지 | QA | 해당 스펙 5회 연속 실패 0 |
| 7 | preflight body의 `webSearchMode`를 잠그는 회귀 테스트 추가 (§3의 5개 전이) | Chat / QA | 3개 이상 전이 케이스 단언 존재 |
| 8 | `/pricing` 요금제 카드의 가격 라인에 고정 높이/skeleton을 예약해 CLS 해소 | Marketing / Perf | 390px cold cache 3회 median CLS ≤ 0.1 |
| 9 | 실제 트래픽 성공 근거가 14시간 이상 stale인 상태를 상태 페이지에서 더 명시적으로 구분 표기 | Trust | Operational 배지 옆에 real-traffic 근거 경과 시간 노출 |
| 10 | 골든 스위트가 nightly로 이동한 만큼, 출시 직전에는 `chat-state-visual-regression`을 수동 1회 실행 | QA / Release | 출시 체크리스트에 항목 추가 |

---

## 부록 A — 실제 Provider 호출 승인 요청안

감사 원칙 4에 따라, 아래 내용을 승인해 주시면 FINAL-F002를 `Not verified`에서
확정 판정으로 옮길 수 있습니다.

| 항목 | 제안 |
|---|---|
| 호출 환경 | `https://staging.tomverse.app` (production 아님) |
| 계정 유형 | staging 전용 테스트 계정 1개 (Guest 경로 1회 + 인증 계정 경로 2회) |
| 모델 수 | 기본 3-model (`gpt-5-4-mini`, `claude-haiku-4-5`, `gemini-2-5-flash`) |
| 요청 횟수 | 비교 요청 **3회** + AI Review **1회** (총 provider 호출 최대 10회) |
| 예상 최대 credit | 비교 3회 × 3 credit = 9, AI Review 1회 ≈ 4–8 → **최대 약 17 credit** (web search는 `off`로 고정해 8-credit surcharge 미발생) |
| 전송할 prompt | `"In one sentence, what is the capital city of France?"` (짧고 무해, 개인정보 없음) |
| 기록할 증거 | panel별 완료 여부, HTTP status, latency, expected/actual credit, 환불 원장 반영, redaction된 trace ID |
| 실패 시 중단 조건 | 첫 비교에서 2개 이상 panel 실패, 또는 실제 차감 credit이 예상치를 초과하면 **즉시 중단**하고 잔여 회차 미실행 |
| 부작용 | staging credit 소비만 발생. production 데이터·과금·환경변수·배포에는 영향 없음 |

---

## 점수 산정

| 항목 | 배점 | 점수 | 감점 이유 | 근거 | 출시 영향 |
|---|---:|---:|---|---|---|
| Core task success | 20 | **14** | 기본 3-model 경로의 실제 가용성 미검증(−4), 은퇴 모델이 선택 가능(−2) | §3 F002, REAUDIT-F002 | 높음 |
| Responsive / mobile UX | 15 | **14** | 320 CSS px reflow·overflow 전부 통과. `/pricing` 레이아웃 이동만 감점(−1) | §3 F001/F004, §11 | 낮음 |
| Accessibility | 15 | **12** | 자동·키보드 근거는 양호하나 실기기·스크린리더 전무(−2), forced-colors·reduced-motion·text-zoom 미검증(−1) | §7 | 중간 |
| Trust, status, credit transparency | 15 | **9** | 영구 허위 Incident(−3), 상태 UI ↔ API 모순(−2), Operational이 전부 probe 근거이며 real traffic 14.5h stale(−1) | §8, REAUDIT-F001 | **높음** |
| Security & privacy | 15 | **15** | 감점 없음. CSP 완화 0, 동의 전 추적 0, no-store·HSTS 유지, 113개 보안 검사 통과 | §10 | 없음 |
| Operational readiness | 10 | **6** | 승인된 실호출 부재(−3), 카탈로그 reconciliation 실효 미확인(−1) | §8, §13 | 높음 |
| Internationalization / content quality | 5 | **5** | 감점 없음. en/ko/de/fr 문법·통화 표기 정확 | §3 F006 | 없음 |
| QA traceability & automation reliability | 5 | **3** | 결정적 실패 1건 상시 red(−1), 미해결 flake(−0.5), FINAL-F003 회귀 테스트 부재(−0.5) | §6, REAUDIT-F004/005/006 | 중간 |
| **합계** | **100** | **78** | | | |

자동화 테스트 **수**만으로 점수를 부여하지 않았습니다. 829개 E2E 통과는 그 자체로
가점 요소가 아니며, 위 감점은 전부 개별 근거에 연결되어 있습니다.

---

## 최종 판정

### **No-Go** (동시에 `Needs operational verification`)

**No-Go 트리거 (감사 기준 대조)**

- ✅ *"공개 Provider 상태가 실제 근거와 일치"* 위반 — REAUDIT-F001
- ✅ *"기본 Provider 경로에 근거 없는 정상 표시"* 위반 — REAUDIT-F002
  (`llama-4-scout`가 근거 없이 `available`)
- ✅ *"UI·코드·mock 검사는 통과했지만 실제 3-model 및 AI Review 호출 승인이 없음"* —
  FINAL-F002

**No-Go에 해당하지 않는 항목 (명시)**

- ❌ FINAL-F001이 staging에서 재현됨 → **재현되지 않음**
- ❌ staging SHA 불일치 → **네 기준 모두 일치**
- ❌ CSP 광범위 완화 → **없음**
- ❌ 개인정보 동의 이전 비승인 추적 → **없음** (실측으로 부정)
- ❌ 설명되지 않은 critical automation failure → 실패 4건 모두 원인 규명 완료
- ❌ credit atomicity 결함 → 결함 근거 없음(다만 실측 미검증)

**공정한 평가**: 직전 감사의 6개 발견점 중 5개는 근본 원인까지 해결되었고, 특히 보안·
개인정보 영역은 감점 없이 통과했습니다. 남은 blocker 3건은 모두 **Provider 상태 정합성과
실호출 검증**이라는 좁은 영역에 몰려 있습니다. REAUDIT-F001·F002를 수정하고 §부록 A의
실호출 검증이 통과하면 **Conditional Go**로 전환 가능한 상태입니다.
