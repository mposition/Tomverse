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
| production 활성화 | **금지 유지** (A2 §10). 승인에 필요한 것은 §9.1 |

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
- `lib/marketingMemoryClaims.ts`의 registry(namespace 상수·허용 claim·고지)는
  **있지만**, 그 namespace의 **locale dictionary가 7개 언어 어디에도
  없습니다**(`grep marketingMemory locales/*.ts` → 0건). 즉 §17이 허용하는
  claim 중 어느 것도 번역돼 있지 않고, 어떤 페이지도 Import·memory를
  주장하지 않습니다. 자세한 구분은 §8.1.

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
| `marketingMemory` locale dictionary 작성 | 같음. 더해서 §8.2의 고지 범위 결정이 선행 |
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

## 8. 마케팅 공개 — 누락이 아니라 의도적으로 분리된 결정

§2.5가 확인한 "공개 문구 없음"을 **해야 할 일이 밀린 상태로 읽지 않습니다.**
운영 활성화와 마케팅 론치는 별개 결정이고, 지금은 의도적으로 분리돼 있습니다.
Import를 조용히 활성화하고 homepage·SEO를 그대로 두는 선택이 가능하며, 그것이
현재 기본값입니다.

### 8.1 이미 있는 것과 없는 것

초판은 "namespace 신설과 claim id 등록이 선행"이라고 적었는데 **틀렸습니다.**
registry 쪽은 이미 갖춰져 있습니다.

| 항목 | 상태 |
|---|---|
| `MEMORY_MARKETING_NAMESPACE = "marketingMemory"` | `lib/marketingMemoryClaims.ts`에 **있음** |
| `importPastConversations` claim id | `ALLOWED_MEMORY_CLAIMS`에 **있음** |
| `MEMORY_MARKETING_DISCLOSURE` (ko/en) | **있음** |
| 7개 locale의 `marketingMemory` dictionary | **없음** |
| 그 dictionary를 쓰는 landing·SEO 콘텐츠 | **없음** |

즉 남은 것은 **번역과 콘텐츠**입니다. 새 claim id는 `importPastConversations`
보다 **범위가 넓거나 의미가 다른** 주장을 할 때만 필요합니다.

### 8.2 먼저 정해야 하는 것 — §17 고지의 범위

문구를 쓰기 전에 걸리는 문제가 있습니다.

`claimsImportOrMemory()`는 "과거 대화"·"past conversations"·provider+가져오기를
모두 잡으므로, **import만 주장하는 문구에도 §17 고지가 요구됩니다.** 그런데
현행 `MEMORY_MARKETING_DISCLOSURE`는 이렇게 시작합니다.

> 과거 대화의 맥락과 **사용자가 승인한 기억·답변 스타일**을 참고합니다. …

이것은 Release B 성격의 주장입니다. memory 추출·주입이 꺼져 있는 Release A
상태에서 import-only 문구 옆에 이 고지를 그대로 붙이면, 고지가 오히려 **하지
않는 일을 설명**하게 됩니다. §17이 막으려던 과장이 고지 쪽에서 발생합니다.

따라서 마케팅을 공개하기 전에 정합니다 — **§17을 `import-only` 주장과
`memory personalization` 주장으로 분리할지.** 분리한다면 각 주장에 맞는 고지가
따로 필요하고, 분리하지 않는다면 memory가 켜지기 전까지 마케팅을 내지
않는다는 뜻입니다.

### 8.3 공개하기로 정했다면

registry·7개 locale·landing·SEO·정적 테스트를 **한 변경으로** 적용합니다.
`tests/marketingMemoryClaims.test.mjs`의 disclosure 규칙이 문구를 넣는 순간
그 파일에 적용되므로, 절반만 반영한 상태는 CI에서 멈춥니다.

## 9. 사람이 정해야 하는 것

### 9.1 production 활성화

**H·H2만 실행한 기록으로는 승인할 수 없습니다.** flag가 하나뿐이라 그것을
켜는 것은 Gemini rollout이 아니라 **외부 import 전체의 최초 production
공개**입니다. 근거는 다음을 모두 충족해야 합니다.

- **사전 조건 + A~H/H2 전체** 실행. H는 D절 XSS 항목을 참조하므로 단독 분리
  불가입니다.
- **실제 검증 자료 여섯 종 전부** — §9.1.1
- 기록에 **대상과 절차를 함께 고정** — §9.1.2
- 실행자·승인자 **서명과 기록 동결**, `docs/ops/staging-verification-records/`에
  저장

H·H2 단독 실행은 `runType: exploratory`로 남기며 Gemini 구현 확인에는
충분하지만 production 승인 근거로 인용할 수 없고, 미실행 항목은 `미기록`으로
둡니다.

2026-08-04 기록은 A2를 덮지 않습니다 — Gemini import가 존재하기 전의
실행이고, 기록 자체가 전 항목 `미기록`이라고 적고 있습니다.

#### 9.1.1 "실제 export"는 Gemini 하나가 아닙니다

flag가 세 provider를 함께 공개하므로 검증 자료도 셋 전부입니다. 체크리스트는
**여섯 종을 각각의 목적과 함께** 열거하고, 이것을 "검증용 파일"로 뭉뚱그리는
것을 명시적으로 금지합니다 — 뭉치면 **HTML export가 실패하는 것이 결함처럼
보입니다.**

| 자료 | 목적 |
|---|---|
| ChatGPT export ZIP | 정상 import 경로 |
| `conversations.json` 단독 | 정상 import 경로 |
| Claude 실제 export | 정상 import 경로 |
| Google Takeout **JSON** | Gemini 정상 import, 분기 처리, H2 측정 |
| Google Takeout **HTML** | 정상 import가 **아니라** 미지원 형식의 안내·복구 경로(`html_export_unsupported`) |
| 합성 XSS export | viewer가 HTML을 실행하지 않는다는 안전성 경로 |

JSON과 HTML은 **같은 계정에서, 두 export 사이에 대화를 추가·수정·삭제하지 않고**
받아야 합니다. 재-import 확인은 새로 뽑지 말고 **같은 JSON 파일을 다시** 씁니다 —
새 export로 하면 ID 결정성이 아니라 "두 export가 우연히 닮았는가"를 본 것이
됩니다.

#### 9.1.2 기록은 `deploySha` 하나로 대상을 고정하지 못합니다

`_record-template.md`(`templateRevision: 2026-08-15c`)의 front matter가 스키마
이고, 최소한 다음이 함께 있어야 합니다.

| 축 | 항목 |
|---|---|
| 검증 대상 | `deploySha`(40자리) · `deploymentId` · `artifactDigest` |
| migration | `appliedMigrations` · `migrationsCompletedAtUtc` · 앱 배포보다 먼저 적용됐는지 |
| 검증 절차 | `templateRevision` · `checklistSourceSha` |
| 실행 | `runType` · `environment` · 시작·종료 UTC · `executor` · `approver` · 시작 시점 flag·런타임 설정 |
| 동결 | `frozen` · `digest` · 검증 데이터 정리 확인 |

`deploySha`만으로 부족한 이유는 template이 직접 적고 있습니다 — **같은 SHA가
같은 artifact를 보장하지 않습니다.** 의존성 해석·builder 버전·build 환경이 그
사이에 움직입니다.

**동결 후 다음 중 하나라도 달라지면 그 기록은 새 대상을 덮지 못합니다** — 활성화
대상 SHA, 적용 migration 집합, import·parser·wizard 관련 코드, 검증 결과에
영향을 주는 flag·런타임 설정, 실제 배포 artifact. 검증 도중 staging 대상이
움직였다면 기록은 무효이고 다시 실행합니다.

#### 9.1.3 체크리스트가 branch마다 다른 상태 — 미해결

2026-08-16 기준, 이 계약의 정본인 H절 서두는 **`develop`에만 있습니다**
(`cf9b1f1` "docs(ops): verify an activation candidate SHA, not a branch").
`main`의 체크리스트는 233줄판이라 이 요구가 없습니다. 그래서 §9.1은 참조가
아니라 요구 자체를 적었습니다 — main만 읽는 사람이 참조를 따라가면 없는 문단에
도달합니다.

**이 감사 문서가 main 체크리스트의 공백을 대신한다고 해석하지 않습니다.** 여기
적힌 것은 정본의 요약이며, 정식 실행의 근거는 체크리스트와 기록입니다.

합류 전에 정식 실행이 필요하다면 이렇게 합니다.

- `develop` 체크아웃의 **최신 template**으로 기록을 생성하고,
- `deploySha`에는 **실제 production 활성화 대상 SHA**를 적고,
- `checklistSourceSha`로 template 출처 commit을 함께 고정합니다.

이 어긋남 자체는 사고가 아니라 설계입니다 — template이 "checklist source SHA는
배포 SHA와 다른 것이 정상"이라고 적고 있고, 검증 *절차*의 이력을 `develop` 한
줄기로 두기 위해 그 칸이 존재합니다. 다만 **활성화 전에 체크리스트를 `main`에도
합류시키는 것이 가장 안전합니다.**

> **해결되면 이 절을 지우지 말고 아래 한 줄로 바꿉니다.**
>
> `Resolved: checklist revision <revision>이 <YYYY-MM-DD>에 <40자리 SHA>로
> main에 합류했습니다.`
>
> 당시 branch 불일치가 있었다는 사실을 지우면, 그 사이에 만들어진 기록들이 왜
> `checklistSourceSha`를 그렇게 적었는지 나중에 설명할 수 없습니다.

### 9.2 마케팅 론치

활성화와 같은 시점일 필요가 없습니다. 조용한 활성화가 기본값이며, 그 경우
세 층을 구분해 다룹니다.

| 층 | 취급 |
|---|---|
| 제품 내 Import UI·개인정보 문구 | **실제 동작에 맞게 유지.** 이번 PR이 한 일이며 활성화 승인과 무관합니다 |
| homepage·SEO 홍보 | **별도 마케팅 승인 전까지 미노출** |
| §17 분리(`import-only` / `memory personalization`) | **정책 계약 개정이므로 사람 승인 선행** — 문구 변경이 아닙니다 |

세 번째가 특히 그렇습니다. `lib/marketingMemoryClaims.ts`는 상위 정책 §17을
코드로 옮긴 단일 정본이고, 고지의 범위를 나누는 것은 그 정책이 무엇을 약속하는지를
바꾸는 일입니다. 에이전트가 registry를 먼저 고치고 정책을 따라 맞추는 순서로는
안 됩니다.

### 9.3 이 감사가 하지 않은 것

위 어느 것도 승인하지 않았고, flag·운영 설정·migration·정책 승인 필드를
변경하지 않았습니다.
