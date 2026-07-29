# `/ko` root language — locale-aware root layout (A안) 구현 기록

> 2026-07-29 · base `20fb3ec` (`origin/develop`)
> 승인 범위: **A안을 localized 45페이지에 한정해 Go-Live 전 수행**.
> C안(현행 유지)은 최종안으로 미승인, B안(dynamic 전환)은 제외.
> 빌드 후 HTML 후처리는 **수행하지 않음** — 근거는 §6.

---

## 1. 무엇이 문제였나

`/ko`, `/ko/<intent>` 등 45개 localized marketing 페이지는 한국어·중국어·
프랑스어 본문을 prerender하면서 root가 `<html lang="en">`이었습니다.

`<html lang>`을 쓸 수 있는 것은 root layout뿐인데, root layout이 `[locale]`
segment **위**에 있어 그 param을 볼 수 없었기 때문입니다. Next 16에서
`unstable_rootParams`는 제거되었으므로 우회로도 없습니다.

콘텐츠 wrapper의 `lang="ko"` 덕분에 `:lang()` font routing과 보조기술의 언어
판별은 이미 정상이었고, 남은 격차는 **문서 수준 선언**(WCAG 3.1.1, 브라우저
번역 판단)이었습니다.

## 2. 구현

Next가 문서화한 i18n 패턴대로 `[locale]`을 최상위 segment로 올리고 자체 root
layout을 부여했습니다. **핵심은 범위 제한입니다.**

```
app/
  (site)/                     ← root layout #1  (marketing + application)
    (marketing)/…             /pricing, /terms, …   (force-static)
    (application)/…           /chat, /auth/signin,  (force-dynamic)
  [locale]/                   ← root layout #2  (localized 45페이지)
    page.tsx  [intent]/page.tsx
```

`app/layout.tsx`는 제거했습니다(Next는 root layout이 둘 이상이면 최상위
`layout.tsx`를 허용하지 않습니다). **`(site)` route group이 승인 조건을
지키는 장치**입니다: route group은 URL에 나타나지 않으므로 `/pricing`과
`/chat`은 경로가 그대로이고 **여전히 하나의 root를 공유**합니다. 즉 둘 사이
이동은 지금까지처럼 client navigation이고, full reload 경계는 **`/{locale}` 
하나**만 새로 생깁니다.

중복을 만들지 않기 위해 공통부를 분리했습니다.

| 파일 | 역할 |
|---|---|
| `components/DocumentShell.tsx` | `<html>`/`<body>`, font 변수, theme bootstrap |
| `lib/rootMetadata.ts` | metadataBase·title template·OG/Twitter·verification |
| `components/marketing/MarketingShell.tsx` | structured data + marketing provider stack |
| `lib/marketingLocale.ts` | `/{locale}` segment → 언어 (`kr`→`ko`, `cn`→`zh` alias 포함) |

alias를 공유 모듈로 뺀 이유: root layout이 이제 같은 매핑을 필요로 하는데,
layout이 모르는 alias가 있으면 redirect가 발동하기 전까지 한국어 본문이
`lang="en"`으로 렌더됩니다.

## 3. 검증

### 3.1 prerender된 root lang (빌드 산출물 직접 확인)

| 파일 | `<html lang>` |
|---|---|
| `.next/server/app/ko.html` | **`ko`** |
| `.next/server/app/zh.html` | **`zh`** |
| `.next/server/app/de.html` | **`de`** |
| `.next/server/app/ko/compare-ai-models.html` | **`ko`** |
| `.next/server/app/fr/chatgpt-vs-claude.html` | **`fr`** |
| `.next/server/app/index.html`, `pricing.html`, `terms.html` | `en` (변경 없음) |
| `/kr`, `/cn` | 307 → `/ko`, `/zh` (변경 없음) |

- localized HTML **45개 전부 그대로 prerender**됩니다(`● SSG`). 경로도 동일하므로
  `lib/staticMarketingCsp.ts`의 빌드 HTML 해시 경로가 유지됩니다.
- 영어 정적 marketing route는 `○ Static` 유지.

### 3.2 자동화

`tests/e2e/ssr-root-language.spec.ts`를 확장해 `/ko`·`/zh`·`/fr/<intent>`·`/en`의
**raw 첫 응답** root lang과 alias redirect를 고정했습니다. → **19/19 통과**

| Suite | 결과 |
|---|---|
| Unit | **536 / 536** |
| Security regression | **113 / 113** |
| Accent tokens | 10 files / 10 roles |
| Text encoding | pass |
| Lint (`--max-warnings=0`) | 0 warnings |
| Typecheck | pass |
| Production build | pass, localized 45페이지 prerender 유지 |
| `@ui-risk` E2E | **247 passed / 0 failed / 45 skipped** |
| Font preload | 66 route, preload 수 {0,1} |

### 3.3 보안 규칙 갱신 (완화 아님)

root layout이 하나가 아니게 되어 `scripts/security-regression-check.mjs`의
규칙을 **두 root 모두에 대해** 검사하도록 다시 썼습니다.

- `(site)` root: request-time read는 `DOCUMENT_LANGUAGE_HEADER` **정확히 1건**
- `[locale]` root: request-time read **0건**, `next/headers` 미사용, `force-static`
  유지 — 헤더를 읽는 순간 45개 SEO 페이지가 prerender에서 빠지고 CSP 해시가
  깨지기 때문
- 두 root 모두 `cookies()` / `getServerSession` / `prisma` 금지

## 4. cross-root 전환 시간 실측 (승인 조건)

같은 브라우저·같은 빌드에서 CTA 클릭 → 도착 화면 가시까지, 5회 median.

| 전환 | 종류 | median | 이전 대비 |
|---|---|---:|---|
| `/` → `/chat` | same root (client nav) | **321ms** | 변화 없음 |
| `/ko` → `/chat` | **cross root (document load)** | **1173ms** | **+852ms (3.7×)** |
| `/` → `/pricing` | same root (client nav) | **203ms** | 변화 없음 |
| `/ko` → `/pricing` | **cross root (document load)** | **469ms** | **+266ms (2.3×)** |
| `/` → `/ko` (헤더 언어 선택) | **cross root (document load)** | **2060ms** | 이전에는 client `router.push` |

### 읽는 법 — 두 가지 단서를 함께 봐야 합니다

- **localhost 측정이라 하한값입니다.** 네트워크 RTT가 0이고 CDN도 없습니다.
  실제 모바일 네트워크에서는 document 왕복이 더해집니다. 반대로 JS 번들은
  대부분 캐시에 남아 있으므로 실사용 격차가 5배로 벌어지지는 않습니다.
- **예상하지 못했던 항목이 하나 있습니다.** 헤더의 언어 선택기는 `/`에서
  `/ko`로 `router.push`를 하는데, 이제 그 경로가 root 경계를 넘으므로
  **client navigation이 document navigation으로 바뀌었습니다(2060ms)**. 이번
  변경에서 가장 큰 전환 비용이며, 승인 시점에 논의된 "localized 페이지의 CTA"가
  아니라 **영어 페이지에서 한국어로 바꾸는 동작**입니다.

### 수용 여부 판단에 필요한 것

- `/ko` → `/chat` (localized 페이지의 주 CTA): +852ms
- `/` → `/ko` (언어 전환): 2060ms ← **새로 발견된 항목, 별도 판단 필요**

완화가 필요하다면 선택지는 두 가지입니다.
1. localized landing에 목적지 document `prefetch`/speculation rules 추가 —
   CSP가 inline script를 해시로 통제하므로 추가 작업이 따릅니다.
2. 언어 전환을 `/ko`로 이동시키지 않고 현재 경로에 머무르게 변경 — SEO 정책
   (localized canonical URL)과 충돌하므로 별도 결정이 필요합니다.

두 안 모두 이번 범위 밖이라 구현하지 않았습니다.

## 5. 부수 수정 — `korean-typography.spec.ts`

이 spec은 `/`에서 언어 선택기로 한국어를 고른 뒤 줄바꿈을 측정합니다. root
분리로 그 동작이 document navigation이 되면서, 헬퍼가 (a) 파괴된 실행
컨텍스트를 건드리거나 (b) 아직 이전 문서를 측정하는 문제가 드러났습니다.

헬퍼가 **URL 전환을 먼저 기다린 뒤 `document.fonts.ready`까지** 기다리도록
고쳤습니다. 후자는 원래부터 빠져 있던 것으로, typography contract가 명시한
측정 방법(“measurements are taken after `document.fonts.ready`”)과 어긋나 있었고
`Noto Sans KR`은 `preload: false`라 병렬 실행에서 fallback face의 metric을
측정하는 일이 실제로 발생했습니다. 단정 자체는 약화하지 않았습니다.

## 6. 하지 않은 것 — 빌드 후 HTML 후처리

`.next/server/app/**/*.html`의 `<html lang>`을 후처리로 바꾸는 안은 채택하지
않았습니다. CSP 해시는 inline script만 대상이라 직접 깨지지는 않지만,

- prerender HTML만 고치고 `.rsc` / `.segments` payload는 그대로 남아 **client
  navigation으로 `/ko`에 진입하면 후처리되지 않은 트리가 렌더**되고,
- Next 내부 build 산출물 포맷에 의존하며,
- source / preview / production 간 동작이 갈립니다.

정식 해결은 locale-aware root layout에서 수행한다는 판단에 따라 §2를
구현했습니다.

## 7. 남은 것

`/ko` root lang 항목은 이로써 **PASS**입니다(code / local test / build 산출물).
CI·staging 판정은 별도이며, 같은 시점의 canonical visual gate 상태는
`.github/audits/ui-go-live-remediation-2026-07-29.md`와 아래를 참조하세요.

- cross-root 전환 시간 수용 여부: **미결 — §4의 두 수치로 판단 필요**
- `?lang=` query locale(예: `/pricing?lang=ko`)의 정적 route hydration flash:
  승인대로 **별도 i18n route migration으로 분리**, 이번 범위 밖
