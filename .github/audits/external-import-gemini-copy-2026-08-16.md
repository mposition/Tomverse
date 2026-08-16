# 외부 대화 Import — Gemini 반영 여부 문구 감사 (2026-08-16)

Tomverse Insight의 공개 homepage와 사용자 노출 콘텐츠가 외부 대화 Import의
canonical provider 집합과 어긋나 있는지 확인하고, 확실한 누락만 고쳤습니다.

**이 감사는 production 활성화를 승인하지 않으며, flag·운영 설정·정책 승인
상태를 건드리지 않았습니다.** 활성화는 A2 §10의 별도 승인 사항으로 남아
있습니다.

| | |
|---|---|
| 감사 시각 | 2026-08-16 |
| 대상 branch | `claude/external-import-gemini-audit-knwg1s` |
| 수정 커밋 | `4eebe08c362c492ed981268266172f9e3680a43a` |
| 정본 | `lib/externalImportProviders.ts`의 `EXTERNAL_IMPORT_PROVIDERS` = `chatgpt`, `claude`, `gemini` |
| 상위 정책 | `docs/policy/external-conversation-import-and-memory.md` |
| 설계 | `docs/policy/external-import-gemini-a2.md` |
| production 활성화 | **금지 유지** (A2 §10 — staging 증거 + 별도 승인 대기) |

## 1. 전제 — "코드가 지원한다"와 "지금 쓸 수 있다"

A2 §10의 층위표가 이 감사의 판단 기준입니다.

| 층 | 상태 |
|---|---|
| Gemini parser (클라이언트) | 완료 (2026-08-14) |
| 서버 provider 지원 | 완료 (2026-08-15) |
| DB CHECK | 완료 |
| **production 활성화** | **금지** |

`feature.externalConversationImportEnabled`는 provider별이 아니라 **세 provider를
한 번에 켜는 전역 flag**입니다(`lib/externalImportAccess.ts`). 따라서 이 감사는
두 가지를 다르게 다룹니다.

- **로그인 사용자·운영자 화면의 사실 기술**은 지금 고칩니다. 코드가 이미
  지원하는 것을 좁게 적어 둔 것이고, 활성화 여부와 무관하게 틀린 문장입니다.
  개인정보 처리방침이 특히 그렇습니다 — 처리 대상 서비스를 실제보다 좁게
  적는 것은 문구 문제가 아닙니다.
- **공개 marketing·SEO의 이용 가능성 주장**은 만들지 않습니다. 활성화 승인
  전에 "지금 세 서비스에서 가져올 수 있다"고 적으면 그 문장은 배포된 순간
  거짓입니다.

## 2. 검색 결과 분류

검색어: `ChatGPT or Claude`, `ChatGPT 또는 Claude`, 각 locale에서 ChatGPT와
Claude가 함께 나오는 문구, `external import`, `conversation import`,
`대화 가져오기`, `Gemini`, `Google Takeout`.

범위: `app/(site)/**`, `app/[locale]/**`, `components/marketing/**`,
`components/imports/**`, `components/legal/**`, `lib/rootMetadata.ts`,
`lib/seo.ts`, `locales/*.ts`, OG·structured data, 관련 테스트.

### 2.1 분류 1 — 외부 Import provider 목록 (Gemini 누락 → 수정)

| 위치 | 현재 의미 | 조치 |
|---|---|---|
| `externalImport.dataTabDescription` ×7 | 설정 Data 탭 진입점 설명 | 수정 |
| `externalImport.pageDescription` ×7 | `/settings/imports/new` 페이지 설명 | 수정 |
| `externalImport.selectFileHint` ×7 | 파일 선택 단계의 허용 형식·provider 안내 | 수정 |
| `externalImport.guideFormats` ×7 | "ZIP·JSON 모두 지원" | 수정 (§3.2) |
| `privacyPolicy.externalImport` ×7 | 처리 대상 서비스 열거 | 수정 |
| `components/admin/PlatformSettingsPanel.tsx` | flag 설명 "ChatGPT and Claude" | 수정 |

### 2.2 이미 정확해 손대지 않은 곳

| 위치 | 상태 |
|---|---|
| `ProviderGuideStep.tsx`의 `PROVIDER_CARDS` | Gemini 카드 존재 |
| `externalImport.guideGemini{Title,Step1..3}` ×7 | 존재. My Activity → Gemini Apps·JSON 지목 |
| `externalImport.parseFailedHtmlExport` ×7 | 존재 (A2 §6) |
| `components/imports/importFormatting.ts`의 `PROVIDER_LABELS` | `gemini: "Gemini"` 존재 |
| `tests/integration/external-import-provider-canon.db.test.ts` | DB CHECK를 정본에 결속 |

### 2.3 분류 2 — 모델 비교·카탈로그 (변경하지 않음)

Import와 무관하며 GPT·Claude·Gemini를 이미 정확히 언급합니다.

- `components/marketing/landingContent.ts` — 7 locale의 `description`·`guestNote`
- `lib/rootMetadata.ts`, `lib/seo.ts`, `app/(site)/opengraph-image/route.tsx`
- `components/marketing/LandingHeroAiReviewDemo.tsx`, `ComparisonBasicsSection.tsx`
- `components/marketing/ChatGptVsClaudeGuide.tsx`, `searchIntentContent.ts`,
  `MarketingChrome.tsx` — ChatGPT vs Claude 비교 페이지. Gemini Import 작업을
  이유로 건드리지 않았습니다.
- `landingContent.ts`의 "비회원 대화 가져오기" — guest→계정 대화 이전이며
  외부 provider도 memory도 없는 **별개 기능**입니다(정책 §21).

### 2.4 분류 3 — 정책·감사·설계 기록 (소급 수정하지 않음)

- `docs/policy/external-import-gemini-a2.md`
- `docs/policy/external-conversation-import-and-memory.md`
- `docs/ops/staging-verification-records/2026-08-04__8c43430b….md`
- `lib/externalImportAdapters/**`의 설계 주석

### 2.5 분류 4 — public marketing·SEO 주장

**외부 대화 Import를 언급하는 공개 문구가 저장소에 하나도 없습니다.**

- homepage·landing·feature·FAQ·SEO metadata·OG·structured data 전부 해당 없음
- `lib/marketingMemoryClaims.ts`가 정의한 `marketingMemory` locale namespace가
  **아직 존재하지 않습니다** — 즉 §17이 허용하는 5개 claim 중 어느 것도
  번역되어 있지 않고, 어떤 페이지도 Import·memory를 주장하지 않습니다.

이것이 현재로선 올바른 상태이므로 **아무것도 추가하지 않았습니다.** SEO
keyword를 늘리려고 무관한 위치에 Gemini를 넣지도 않았습니다.

## 3. 수정한 것

### 3.1 provider 열거 (7 locale × 4 key)

`ko`·`en`·`zh`·`fr`·`de`·`es`·`pt` 전부를 함께 고쳤습니다. 런타임 문자열
연결로 이름을 붙이지 않고 각 언어에서 자연스러운 완성 문장으로 썼습니다.

한국어 예시:

| key | 변경 후 |
|---|---|
| `dataTabDescription` | ChatGPT·Claude·Gemini(Google Takeout) 내보내기 파일의 과거 대화를 Tomverse 계정에 저장합니다. … |
| `pageDescription` | ChatGPT, Claude, Gemini의 공식 데이터 내보내기 파일을 올리고, … |
| `selectFileHint` | ChatGPT·Claude·Gemini 데이터 내보내기(.zip 또는 .json), 최대 1GB. Gemini는 Google Takeout에서 내 활동 → Gemini 앱을 JSON으로 내보낸 파일이어야 합니다. … |
| `privacyPolicy.externalImport` | 사용자는 ChatGPT, Claude, Gemini(Google Takeout) 등 다른 AI 서비스에서 내려받은 … |

`Google Takeout`을 어디에 두는지도 결정 사항입니다. 진입점 설명·파일 선택
힌트·guide card 제목에는 두고, `pageDescription`에는 두지 않았습니다 —
그 문장 바로 아래에 Takeout을 지목하는 guide card가 이미 있고, §5의 이유가
하나 더 있습니다.

### 3.2 허용 파일 형식 — "ZIP·JSON이면 다 된다"를 끊음

`guideFormats`는 "ZIP 파일과 JSON 파일을 모두 지원합니다."였습니다. Gemini가
들어오면서 이 문장 하나만으로는 틀립니다 — My Activity는 JSON과 HTML 중
선택이고 HTML은 거절합니다(A2 §6). 지원 형식이라고 읽힌 뒤 picker에서
거절당하면 사용자에게는 버그로 보입니다.

> ZIP 파일과 JSON 파일을 모두 지원합니다. Gemini 내보내기는 JSON 형식이어야
> 하며 HTML은 읽을 수 없습니다.

주어를 Gemini로 한정한 것은 의도적입니다. ChatGPT export는 `chat.html`을 늘
함께 담고, `html_export_unsupported` 판정은 *읽을 대화 데이터가 하나도 없을
때*에만 적용됩니다.

**파일 선택기가 `.html`을 고를 수 있어야 한다는 A2 §6의 요구는 그대로
둡니다.** 이 문구는 무엇이 읽히는지를 말할 뿐이고, 고를 수조차 없으면
사용자는 안내 화면에 도달하지 못합니다.

### 3.3 admin flag 설명

`PlatformSettingsPanel.tsx`가 "ChatGPT and Claude export files"라고 적고 있었고,
그 아래 스위치는 세 provider를 한 번에 켭니다. 운영자가 읽고 Gemini가 함께
켜진다는 것을 알 수 없는 상태였습니다. provider 세 개를 적고 **per-provider
flag가 없다**는 사실을 명시했습니다.

### 3.4 `PROVIDER_LABELS` export

`components/imports/importFormatting.ts`의 provider 표시명 map을 export했습니다.
아래 §6의 테스트가 이것을 읽습니다. 테스트가 자기 목록을 따로 들면 그 목록이
정본에서 멀어지며, 그것이 이번에 잡은 결함과 같은 모양입니다.

## 4. 수정하지 않기로 한 것

| 대상 | 이유 |
|---|---|
| homepage·SEO에 Import 소개 신설 | 활성화 미승인. 지원 구현과 현재 이용 가능성을 혼동하게 됨 |
| `marketingMemory` namespace 신설 | 같음. §17은 claim id 등록이 선행 |
| ChatGPT vs Claude 비교 페이지 | Import와 무관 |
| landing의 "비회원 대화 가져오기" | 별개 기능 (정책 §21) |
| A2 설계 문서·staging 기록 | 역사적 사실 |
| `EXTERNAL_IMPORT_DIGEST_VERSION`, parser version | 문구 변경이므로 해당 없음 |

## 5. 문구 작성 중 발견 — `providerEndorsement` 가드 충돌

초안의 한국어 `pageDescription`은 다음이었습니다.

> ChatGPT, Claude, Gemini(Google Takeout)**의 공식** 데이터 내보내기 파일을 …

`tests/marketingMemoryClaims.test.mjs`가 실패했습니다.

```
providerEndorsement — "Google Takeout)의 공식"
```

`lib/marketingMemoryClaims.ts`의 `/(OpenAI|Anthropic|Google)[^.\n]{0,20}(공식|제휴|파트너|인증|보증)/`
가 걸린 것입니다. 의도는 "내보내기 파일이 공식 산출물"이었지만, 문장이
"Google … 공식"으로 읽히는 것도 사실입니다. 그것이 §17이 막으려는 허위 제휴
주장의 모양입니다.

**가드가 아니라 문구를 고쳤습니다.** `pageDescription`은 브랜드명 세 개만 쓰고
`Google Takeout`은 다른 세 자리로 옮겼습니다. 정규식에 예외를 추가하는 쪽은
가드를 약하게 만들 뿐이고, 다음에 진짜 제휴 주장이 들어와도 통과합니다.

## 6. 회귀 방지

`tests/externalImportUiCopy.test.mjs`에 네 건을 추가하고
`tests/externalImportPrivacyCopy.test.mjs`의 하드코딩을 정본 파생으로
바꿨습니다. locale 문법을 강제로 동일하게 만들지는 않고, provider를
**열거하는 것으로 분류된 key**에만 브랜드명 존재를 확인합니다.

| 테스트 | 막는 상황 |
|---|---|
| `the brand-name map covers the canonical provider set` | 정본에 provider가 늘었는데 표시명이 없음 |
| `every locale's general import copy names every provider` | canonical set은 늘었는데 7 locale의 일반 문구가 예전 목록에 머무름 |
| `every provider has a guide card in every locale` | guide card에는 있고 일반 문구에는 없는 상태(및 그 반대) |
| `no locale offers HTML as an accepted file` | HTML을 정상 지원 형식처럼 홍보 |
| privacy의 서비스 열거를 `PROVIDER_LABELS` 파생으로 | 개인정보 처리방침만 뒤처짐 |

`PROVIDER_LABELS`의 키는 `Record<ExternalImportProvider, string>`이라 정본에
provider가 추가되면 **컴파일 단계에서 먼저** 걸립니다. 위 테스트들은 그 다음
단계, 즉 표시명은 정했는데 문구를 안 고친 상태를 잡습니다.

의도한 회귀를 실제로 잡는지 확인했습니다 — `en.pageDescription`에서 Gemini를
제거하고 실행해 `en.externalImport.pageDescription must name Gemini`로 실패하는
것을 확인한 뒤 복구했습니다.

## 7. 검증

| 검사 | 결과 |
|---|---|
| `npm run test:unit` | 3551 pass / 0 fail / 1 skip |
| locale parity·translation·launch policy | pass |
| `marketingMemoryClaims`, `marketingModelReferences` | pass |
| `externalImportUiCopy`, `externalImportPrivacyCopy`, `externalImportWizard` | pass |
| `npx tsc --noEmit` | 변경 파일 오류 0 |
| `npx eslint` (변경 파일 전체) | clean |
| `npm run build` | 성공 |
| E2E `external-import-settings.spec.ts` (desktop-chromium) | 28 pass |
| E2E `settings-information-architecture` + `memory-privacy-copy` (desktop + mobile) | 24 pass |

`tsc`에 남은 26건은 `.next/types` 미생성으로 인한 기존 `PageProps`·`RouteContext`
오류이며 이번 변경과 무관합니다.

### 7.1 시각 확인

실제 `/settings/imports/new`를 한국어로 렌더해 desktop 1280px와 320px에서
확인했습니다.

| 항목 | 1280px | 320px |
|---|---|---|
| `documentElement.scrollWidth - clientWidth` (guide 단계) | 0 | 0 |
| 같은 값 (파일 선택 단계) | 0 | 0 |
| 제목·설명·5단계 표시기 | 정상 | 정상 (표시기 2행 wrap — 기존 설계) |
| provider card 3장 | 정상 | 정상 |

첨부 화면과 같은 경로에서 한국어 문구가 다음과 같이 렌더되는 것을
확인했습니다.

> ChatGPT, Claude, Gemini의 공식 데이터 내보내기 파일을 올리고, 내용을 확인한
> 뒤 Tomverse 계정에 보관할 대화를 선택하세요.

## 8. 활성화 승인과 동시에 반영해야 할 문구

**아직 만들지 않았습니다.** 활성화가 승인되는 변경과 한 묶음으로 배포해야
합니다.

1. `marketingMemory` locale namespace 신설 — `ALLOWED_MEMORY_CLAIMS` 중 실제로
   쓸 claim의 번역. **claim id 등록이 선행**이며, 등록되지 않은 문장은 어떤
   locale에도 번역으로 들어갈 수 없습니다(§17 구조 규칙).
2. `MEMORY_MARKETING_DISCLOSURE`(`modelDifferenceNotice`)를 그 claim과 **함께**
   배치. 없이 claim만 내보내면 다른 서비스의 답변을 재현한다는 무조건부 약속이
   됩니다.
3. 그 namespace를 쓰는 landing 영역과 SEO metadata. 7 locale 동시.
4. 공개 문구를 넣는 순간 `tests/marketingMemoryClaims.test.mjs`의 disclosure
   규칙이 그 파일에 적용됩니다.

## 9. 사람이 정해야 하는 것

1. **production 활성화.** `docs/ops/external-import-staging-checklist.md`의 H·H2절을
   실제 Takeout으로 실행하고 `docs/ops/staging-verification-records/`에 기록한 뒤,
   그 기록을 근거로 승인합니다. 저장소의 fixture는 합성이므로 테스트 통과는
   staging 증거가 아닙니다(A2 §10). 2026-08-04 기록은 A2를 덮지 않습니다 —
   Gemini import가 존재하기 전의 실행입니다.
2. **활성화 시 공개 마케팅을 낼지, 낸다면 어떤 claim으로.** §8의 1번은 문구
   작업이 아니라 registry 등록 결정입니다.
3. 이 감사는 위 어느 것도 승인하지 않았고, flag·운영 설정·migration·정책
   승인 필드를 변경하지 않았습니다.
