# Tomverse Insight → Tomverse Review 명명 전환

제품 경계 결정 기록 v1.2 결정 1의 실행 기록입니다. **이 전환은 이름만 바꿉니다** —
기능·대화·URL의 의미는 아직 아무것도 바뀌지 않았고, `/chat`은 계속 Review 호환
경로입니다.

> **먼저 §7을 읽으십시오 (2026-08-24).** 이 전환의 **범위**가 정정됐습니다.
> `Insight → Review`는 **제품 명칭** 변경이며, 상위 브랜드와 공용 서비스는
> `Tomverse`로 유지합니다. 아래 §1·§2는 그 구분 없이 쓰였고, 그래서 §2의 치환이
> 플랫폼 공용 표면까지 덮었습니다. §7이 정정 사항과 현재 코드 대조를 담습니다.

## 1. 왜 이름을 옮기는가

> **§7.8에서 정정됨** — 이 절은 Review를 넷 중 하나로 세우면서, 상위 브랜드가
> `Tomverse`로 남는다는 것을 적지 않았습니다.

Chat·Review·Studio·Code는 전부 **사용자가 하는 일**인데 Insight만 **나오는 결과**
였습니다. Branded House의 제품명은 "여기서 무슨 일을 하는가"에 답해야 하고,
"여기서 무엇을 얻는가"는 그 아래 층의 말입니다.

Insight는 폐기가 아니라 **이동**입니다. "Review Insight", "검토 결과"처럼 Review의
산출물을 가리키는 말로 계속 씁니다. 그래서 정적 검사는 두 단어 브랜드만 잡고
`Insight`라는 단어 자체는 잡지 않습니다.

이 변경은 UI 계약 §3의 금지어 규칙(better·best·optimal·smartest와 번역)에 걸리지
않습니다. **Review는 서술이지 우월성 주장이 아닙니다.**

## 2. 이번 변경이 실제로 바꾼 것

> **§7.8에서 정정됨** — 아래 대상 표는 이메일·결제·SEO를 통째로 올려두었고,
> 그 결과 계정·결제 같은 **플랫폼 공용** 표면까지 제품명으로 덮였습니다.
> 표는 실제로 바뀐 것의 기록으로 그대로 두고, 무엇이 잘못된 층위인지는 §7.6이
> 표면별로 판정합니다.

사용자 노출면과 그것을 만들어 내는 코드입니다.

| 구획 | 대상 |
|---|---|
| locale 7종 | `locales/{de,en,es,fr,ko,pt,zh}.ts` — 앱 title, 결제 완료 문구 |
| 앱 chrome | `ChatSidebar.tsx`, `MobileChatShell.tsx`, `ChatPageClient.tsx`, `MarketingChrome.tsx` |
| 로그인·인증 | `SignInPageContent.tsx`, `auth/email/verify/page.tsx` |
| 이메일 | `lib/accountEmails.ts`, `lib/billingEmails.ts`, `lib/emailSendingIdentityCore.ts`, `app/api/admin/test-email/route.ts` |
| 결제 | `app/api/billing/checkout/route.ts` (Stripe line item 이름) |
| 공유·export | `SharedConversationView.tsx`, `share/[shareToken]/page.tsx`, `lib/exportConversation.ts`, `app/api/conversations/export-all/route.ts`, `lib/memorySharingNotice.ts` |
| 생성 파일 metadata | `lib/generatedArtifactXlsx.ts`, `lib/generatedArtifactXml.ts` (`dc:creator`) |
| SEO·OG | `lib/seo.ts`(`SITE_NAME` 포함), `lib/rootMetadata.ts`, `app/(site)/opengraph-image/route.tsx` |
| 마케팅·도움말·정책 | `landingContent.ts`, `marketingInfoContent.ts`, `ChatWorkspaceGuide.tsx`, `UpgradeInterestButton.tsx`, `EvidenceSection.tsx`, `(marketing)/{about,faq,refund,safety,terms,support/help-centre}` |
| 모델 카탈로그 | `lib/models.ts` — `codestral`의 `userVisibleNote`·`operationalReason` |
| 활성 문서 | `docs/policy/default-model-luna-migration.md`, `docs/policy/email-notifications.md`, `.github/ACCESSIBILITY_QA_MATRIX.md` |

독일어 `Tomverse-Insight-Familie`처럼 **하이픈으로 붙은 합성어**가 있었습니다.
공백만 찾는 치환은 이것을 그대로 지나갑니다 — 정적 검사가 하이픈과 non-breaking
space까지 잡는 이유이고, `tests/retiredProductName.test.mjs`가 그 경우를 고정합니다.

## 3. 바꾸지 않은 것

과거를 기록한 문서는 그 시점의 이름을 유지합니다. 7월에 작성된 감사가 8월의 이름을
말하면, 그 발견이 존재하지 않던 이름에 날짜를 붙이는 것이 됩니다.

- `.github/audits/**` — 감사 보고서
- `docs/release-gates/evidence/**` — 승인된 릴리스 증거 (`check:release-records`가
  commit SHA와 CI run URL을 검증합니다)
- `docs/ops/email-sending-domains.md` §3.5.1·§3.5.4 — staging 실측 검증 기록.
  수신자가 판정한 헤더이지 우리가 다시 쓸 수 있는 설정값이 아닙니다
  (`check:staging-verification-records`가 읽습니다)
- 루트의 완료된 UX 감사 보고서 4건 — 파일명 자체가 기록의 일부입니다

목록과 각 항목의 사유는 `scripts/check-retired-product-name-core.mjs`의
`HISTORICAL_ALLOWLIST`에 있고, `tests/retiredProductName.test.mjs`가 **모든 항목이
사유를 갖는지**를 검사합니다.

## 4. 정적 검사

```
npm run check:retired-product-name
```

PR Fast Gate의 static 단계에서 실행됩니다. 선례는 `check:push-scope`입니다 —
"없어야 할 것이 없는지"를 검사하고, `tests/pushScope.test.mjs`가 오탐까지
고정합니다. **오탐 고정이 없으면 누군가 검사를 꺼버립니다.**

잡는 것: `Tomverse Insight`, `Tomverse-Insight`, non-breaking space 형태.
잡지 않는 것: 단독 `Insight`(Cloudflare Browser Insights, `queryInsights()`,
"Review Insight"), 소문자, 다른 Tomverse 제품명.

## 5. 사람이 해야 하는 남은 항목

이 저장소가 답할 수 없는 사실들입니다. **§5.1만 수행됐고(2026-08-23), 나머지
넷은 아직입니다.**

### 5.1 Search Console 기준값 — 확보됨 (2026-08-23)

배포 **전에** Search Console에서 최근 **28일**과 **90일**의 `Tomverse Insight`
검색 노출·클릭·진입 페이지를 저장합니다. 이 데이터가 정하는 것은 **전환 문구를
얼마나 오래 유지할 것인가** 하나입니다.

**2026-08-23에 추출됐습니다.** Domain property `tomverse.app`, export 2건:

| # | 기간 | 필터 |
|---|---|---|
| 1 | 지난 3개월 | 검색 유형 웹 |
| 2 | 지난 28일 (2026-07-25 ~ 08-21) | 검색 유형 웹, 페이지 `+https://tomverse.app` |

관측된 것은 하나입니다. **두 export의 어느 질의 행에도 `insight`·`review`·
`tomverse` 계열이 없습니다.** 브랜드 오타 `toomverse`가 90일 export에 노출 2로
한 번 나오는 것이 전부이고, `insight` 필터를 직접 걸면 결과가 비어 있다는 것도
운영자가 확인했습니다.

질의 표는 노출 내림차순이고 마지막 행들이 노출 1이므로, 표에서 잘린 질의가 있어도
**상한이 노출 1**입니다. 즉 "관측되지 않았다"는 표가 짧아서가 아닙니다.

> **실적 숫자는 이 문서에 옮기지 않습니다.** 기록 README 8번과 같은 이유입니다.
> 여기 남기는 것은 **무엇이 관측되지 않았는가**와 **어디를 보면 되는가**뿐입니다.

**export 원본 보관 위치는 운영자가 채웁니다** — 이 저장소에 두지 않습니다.

읽을 때 걸린 함정 두 가지를 남겨 둡니다. 다음 회차에 같은 것을 다시 밟지
않기 위해서입니다.

1. **페이지 필터를 걸면 노출이 URL별로 세어집니다.** 필터가 없으면 property
   기준 1회입니다. 그래서 export 2의 노출이 같은 날짜에도 export 1보다 크고,
   **두 export의 노출 수를 서로 빼거나 나누면 안 됩니다.**
2. **export 2에서 표끼리 값이 갈렸습니다.** 차트·페이지가 한 무리, 검색어·기기·
   국가가 다른 무리로 서로 다른 합계를 냅니다. `필터.csv`에는 그 차이를 설명할
   항목이 없습니다. 원인을 특정하지 못했으므로, **클릭 관련 판단은 차트·페이지
   쪽만** 쓰는 것으로 처리했습니다.

#### 배포 후에도 읽을 수 있습니다 — 이 항목이 선행인 진짜 이유

이 문서와 staging 체크리스트는 한동안 "배포 후에는 영영 못 찍는다"고 적고
있었습니다. 그건 과장이었습니다. Search Console 성능 데이터는 **16개월 보존**
이고, 이름을 바꿔도 과거 질의 행은 그대로 조회됩니다. URL도 바뀌지 않으므로
페이지 데이터도 남습니다.

정말로 복구 불가인 경우는 하나입니다 — **property가 검증돼 있지 않은 경우.**
Search Console은 검증 이전 기간을 소급 수집하지 않습니다. 이 property는 검증돼
있었고, 그래서 이 항목은 회수 불가가 아니라 **깨끗한 시점에 찍어 두는 순서의
문제**였습니다.

### 5.2 "formerly Tomverse Insight" 유지 기간 — SEO 근거는 0, 최종 결정은 사람

§5.1이 확보됐습니다. 그 결과 이 질문의 절반은 답이 나왔습니다.

**검색에서 잃을 것이 없습니다.** `Tomverse Insight`로 찾아오는 인구가 관측되지
않습니다. 실제 유입 질의는 `ai document analysis` 계열, 즉 **제품명과 무관한 일반
질의**입니다. 병기 문구를 유지할 **SEO 근거는 0**입니다.

남은 변수는 하나입니다. 병기 문구는 검색 유입자만이 아니라 **이미 쓰던 사람**
에게도 걸립니다. Search Console은 그 인구에 대해 아무것도 말하지 않습니다 — 그건
데이터베이스 질문이고, §5.3과 같은 질문입니다.

따라서:

- **기본값은 병기하지 않는 것입니다.** SEO를 근거로 병기를 넣지 마십시오.
- 병기를 넣는다면 근거는 **기존 사용자 수**여야 하고, 그 숫자와 함께 §5.3의
  안내 발송과 묶어서 정합니다.
- **정해지면 이 문서에 날짜와 근거를 적고 나서 문구를 넣습니다.** 결정과 서명은
  사람이 씁니다.

### 5.3 기존 사용자 1회성 안내 — 미발송

> "Tomverse Insight의 이름이 Tomverse Review로 바뀌었습니다.
> 기존 대화와 기능은 그대로입니다."

발송 경로와 시점은 §5.1·§5.2가 끝난 뒤 결정합니다.

### 5.4 production 환경변수 표시 이름 — 미변경

`TRANSACTIONAL_EMAIL_FROM`의 표시 이름이 production에서 아직
`Tomverse Insight <hello@mail.tomverse.app>`입니다. 코드의 하드코딩 fallback
(`lib/emailSendingIdentityCore.ts`의 `TRANSACTIONAL_FROM_FALLBACK`)은 이번에
바뀌었지만, **환경변수가 있으면 환경변수가 이깁니다** — 즉 이 변경만으로는
발송 표시 이름이 바뀌지 않습니다.

절차는 `docs/ops/email-sending-domains.md` §17.3입니다. From 주소의 표시 이름이
바뀌는 것도 사용자가 만들어 둔 필터에 영향을 줄 수 있으므로, §5.3의 안내와 함께
처리합니다. `MARKETING_EMAIL_FROM`도 설정돼 있다면 같이 확인합니다.

### 5.5 시각 회귀 golden 재기록

`tests/e2e/chat-state-visual-regression.spec.ts`와
`tests/e2e/marketing-consent-hero.spec.ts`의 golden 스크린샷에 옛 이름이 렌더돼
있습니다. `visual-baseline/**` 브랜치는 자동 PR 대상이 아니며 **사람이 diff를 보고
병합**합니다(AGENTS.md).

## 6. 이 전환이 아직 하지 않는 것

- URL은 그대로입니다. `/chat`은 계속 Review 호환 경로이고, `/review` alias와
  legacy deep link 이동은 이후 작업입니다.
- 이미지 대화의 제품 라벨(Tomverse Studio)은 이후 작업입니다.
- `Conversation.productKey`, Auto 제품 경계, 제품 스위처는 전부 별개 작업입니다.
- **Tomverse Chat은 여전히 사용자에게 노출되지 않습니다.**

## 7. 브랜드 계층과 이메일 책임 범위 — 2026-08-24 결정

§1·§2가 쓰인 뒤에 드러난 것이 있습니다. **`Insight → Review`는 제품 명칭 변경인데,
§2의 치환은 앱 전체 이름 자리를 그대로 덮었습니다.** 그 둘의 차이를 여기서 정의하고,
현재 코드가 어느 층위에 있는지 대조합니다.

**이 절은 기록입니다. 이번 작업에서 코드·이메일·locale·테스트·검사 스크립트는 하나도
바꾸지 않았습니다.** 아래 "권장 브랜드 계층"은 이후 결정과 구현을 위한 분석이며,
실제 문구 변경은 별도 작업입니다.

계기는 staging 회차의 C-2였습니다. Stripe Checkout이 `Tomverse Pro`를 보여주는데
결제 메일은 `Welcome to Tomverse Review Pro`라고 말합니다 — **같은 결제 한 건에서
두 이름이 나옵니다.**

### 7.1 브랜드 구조는 Branded House입니다

```
Tomverse
├─ Tomverse Chat      자동으로 모델을 선택해 답변
├─ Tomverse Review    여러 AI 답변 비교·교차검토
├─ Tomverse Studio    이미지·비디오 제작
└─ Tomverse Code      코딩·에이전트 작업
```

**`Tomverse`는 상위 브랜드이자 공용 플랫폼이고, Chat·Review·Studio·Code는 그 아래의
제품입니다.** 계정·크레딧·결제는 플랫폼의 것이고 제품이 공유합니다.

### 7.2 `Insight → Review`가 아닌 것

이 변경은 **기존 Insight가 "여러 AI 답변 비교·교차검토" 제품을 가리키던 사용자
표면에만** 적용됩니다. 다음으로 해석해서는 안 됩니다.

- 상위 브랜드 `Tomverse`를 `Tomverse Review`로 변경
- 공용 계정을 `Tomverse Review Account`로 변경
- 공용 크레딧과 결제를 Review 전용 체계로 변경
- 모든 이메일과 발신자를 `Tomverse Review`로 일괄 변경

§1이 Review를 넷 중 하나로 세워놓고 상위 브랜드가 무엇으로 남는지 적지 않았기 때문에,
§2가 네 번째 해석으로 실행됐습니다.

### 7.3 이메일은 기능이 아니라 **브랜드 책임 범위**로 분류합니다

**플랫폼 공용 — 기본 브랜드는 `Tomverse`**

- 로그인·OTP·magic link
- 계정 생성·삭제·복구
- 보안 알림
- 공용 크레딧
- 결제·구독·환불·영수증
- 개인정보 export·삭제 요청

**제품 전용 — 해당 제품명**

| 대상 | 브랜드 |
|---|---|
| Review 대화 비교·교차검토·Review export | `Tomverse Review` |
| Chat 자동 모델 선택·Chat 대화 알림 | `Tomverse Chat` |
| Studio 생성 작업 알림 | `Tomverse Studio` |
| Code 에이전트 작업 알림 | `Tomverse Code` |

분류 기준은 **"이 메일이 무엇에 대해 책임지는가"**이지 어느 화면에서 발생했는가가
아닙니다. 결제는 Review 화면에서 시작해도 계정에 대한 것입니다.

### 7.4 공유 계정의 환영 메일

하나의 Tomverse Account가 모든 제품에서 공유되므로, **계정 생성 메일의 제목과 브랜드
셸은 `Tomverse`가 적합합니다.** 가입 진입점이 특정 제품이라면 **본문 CTA에서만** 그
제품을 안내할 수 있습니다.

```
제목    : Tomverse에 오신 것을 환영합니다
본문 CTA: Tomverse Review에서 여러 AI 답변을 비교해 보세요
```

`"Tomverse Review 계정이 생성되었습니다"`는 공유 계정 구조와 충돌합니다 — 계정은
Review의 것이 아닙니다.

### 7.5 검증 조건 정정

**잘못된 검증**

- 모든 이메일이 `Tomverse Review`로 변경되었는가

**올바른 검증**

1. 활성 사용자 표면에 이전 제품명 `Tomverse Insight`가 남아 있지 않은가
2. 플랫폼 공용 이메일이 상위 브랜드 `Tomverse`를 사용하는가
3. 제품 전용 이메일만 해당 제품명을 사용하는가
4. 동일 이메일 안에서 **발신자·제목·헤더·본문의 브랜드 계층이 모순되지 않는가**

**`Tomverse Review` 포함 여부만 검색해 성공·실패를 판정하지 않습니다.** 이메일의 책임
범위를 먼저 분류해야 합니다. 1번만 자동화돼 있고(§4), 2~4번은 아직 사람이 봅니다.

### 7.6 현재 코드 상태 — 읽기 전용 대조

`develop` 기준. **아무것도 수정하지 않았습니다.**

> **이 표는 2026-08-24 대조 시점의 상태입니다.** 여기서 **범위 불일치**로 판정된
> 표면은 그 뒤 일괄 전환에서 `Tomverse`로 정리됐습니다. 표는 *무엇이 어떻게
> 어긋나 있었는가*의 기록으로 남기고 고치지 않습니다 — 지금 상태를 물으려면
> 코드를 보십시오.
>
> 전환 범위는 **당시 존재하던 활성 표면**까지입니다. `/chat` 리라우팅, 4개
> 제품군 랜딩, Studio·Code 제품 표면 신설은 포함하지 않았습니다. `/chat`은 실제
> 동작이 Review 워크스페이스이므로 이름도 `Tomverse Review`로 남았고, 아직
> 출시되지 않은 제품은 랜딩에 올리지 않았습니다.

| 표면 | 현재 표시 이름 | 책임 범위 | 권장 브랜드 계층 | 판정 | 근거 |
|---|---|---|---|---|---|
| 로그인 코드·매직링크 | `Tomverse` | 플랫폼 공용 | `Tomverse` | 정합 | `lib/emailLoginEmails.ts:42,45` |
| 로그인 수단 추가·제거 알림 | `Tomverse` | 플랫폼 공용 | `Tomverse` | 정합 | `lib/emailLoginEmails.ts:164,165` |
| 계정 삭제 예정 | `Tomverse` | 플랫폼 공용 | `Tomverse` | 정합 | `lib/accountEmails.ts:40,49` |
| 계정 복구 | `Tomverse` | 플랫폼 공용 | `Tomverse` | 정합 | `lib/accountEmails.ts:131,132` |
| 지원·피드백 응답 | `Tomverse` | 플랫폼 공용 | `Tomverse` | 정합 | `lib/feedbackLifecycleEmails.ts:102,108,168` |
| **계정 환영(가입)** | `Tomverse Review` | 플랫폼 공용 | `Tomverse` | **범위 불일치** | `lib/accountEmails.ts:216,217,223,235` |
| **결제·구독 메일 전반** | `Tomverse Review` | 플랫폼 공용 | `Tomverse` | **범위 불일치** | `lib/billingEmails.ts:93,96,104,105,111,112,119,125` |
| **기본 발신자 표시 이름(fallback)** | `Tomverse Review` | 플랫폼 공용 | `Tomverse` | **범위 불일치** | `lib/emailSendingIdentityCore.ts:105` |
| **실제 발신자(환경변수)** | `Tomverse Insight` | 플랫폼 공용 | `Tomverse` | **폐기명 잔존** | §5.4, 2026-08-24 staging 관측 |
| **다국어 결제 완료 문구** | `Tomverse Review` | 플랫폼 공용 | `Tomverse` | **범위 불일치** | `locales/ko.ts:796`, `locales/en.ts:794` |
| **Stripe line item(코드 fallback)** | `Tomverse Review {plan}` | 플랫폼 공용 | `Tomverse {plan}` | **범위 불일치** | `app/api/billing/checkout/route.ts:322,348` |
| Stripe line item(실제 표시) | `Tomverse Pro` | 플랫폼 공용 | `Tomverse` | 정합 | 2026-08-24 staging 관측 |
| 단일 대화 export 헤더 | `Tomverse Review Export` | Review 전용 | `Tomverse Review` | 정합 | `lib/exportConversation.ts:54` |
| **전체 대화 export 헤더** | `Tomverse Review Export` | 플랫폼 공용 | `Tomverse` | **범위 불일치** | `app/api/conversations/export-all/route.ts:85,93` |
| 앱 타이틀(locale) | `Tomverse Review` | 플랫폼/사이트 | **미결정** | 보류 | `locales/en.ts:14`, `locales/ko.ts:18` |

읽으면서 나온 사실 넷을 남겨 둡니다.

1. **`lib/accountEmails.ts`는 파일 안에서 이미 갈려 있습니다.** 삭제·복구 메일은
   `Tomverse`인데 환영 메일만 `Tomverse Review`입니다. 같은 책임 범위인데 다릅니다.
2. **이 불일치는 이번 전환이 만든 것이 아닙니다.** 전환 이전 같은 줄이
   `"Tomverse Insight"`였습니다. 그때는 앱 전체 이름이었으므로 환영 메일에 그것이
   오는 게 맞았습니다. **v1.2가 그 자리를 제품명으로 바꾸면서 같은 문자열이 틀린 말이
   됐습니다.** 치환은 충실했고, 틀린 것은 치환의 범위입니다.
3. **`lib/emailLoginEmails.ts`에는 `Tomverse Review`가 0곳입니다.** 플랫폼 공용
   메일이 어떤 모습이어야 하는지 이미 이 파일이 보여줍니다.
4. **Stripe 대시보드는 이미 맞습니다.** `stripeProductId`가 설정돼 있으면 코드의
   fallback 이름은 쓰이지 않고 대시보드의 `Tomverse Pro`가 표시됩니다
   (`app/api/billing/checkout/route.ts:318-322`). 결제 화면과 결제 메일이 서로 다른
   이름을 말하는 이유가 이것입니다.

**앱 타이틀(locale)은 이번 결정 범위 밖이라 `미결정`으로 둡니다.** 사이트와 앱 셸의
이름이 상위 브랜드인지 제품인지는 §7.3이 정한 이메일 분류와 별개 질문이며,
`lib/seo.ts`의 `SITE_NAME`·OG·마케팅 페이지가 함께 걸립니다.

### 7.7 결론

> **모든 이메일을 `Tomverse Review`로 변경하는 것은 이번 브랜드 구조의 목표가
> 아닙니다.** `Insight → Review` 변경은 제품 명칭 정리이고, 상위 브랜드와 공유
> 서비스는 `Tomverse`로 유지합니다. 따라서 기존의 "모든 이메일 Review 변경" 검증은
> **구현 누락이 아니라 검증 요구사항의 범위 오류**로 분류합니다.

승격 차단 여부는 별개입니다. `AGENTS.md`의 기준으로 이것은 **차단이 아닙니다** —
이름 층위가 어긋난 메일을 받은 사람이 잃는 것이 없습니다. 다만 **메일은 회수되지
않으므로**, 고치는 비용은 production 승격 전이 0이고 그 뒤로는 "이미 나간 메일"이
남습니다.

### 7.8 정정 사항

| 위치 | 정정된 문구 | 왜 잘못됐는가 |
|---|---|---|
| §1 | "Chat·Review·Studio·Code는 전부 사용자가 하는 일인데 Insight만 나오는 결과였습니다" | 문장 자체는 유효합니다. **빠진 것**이 문제입니다 — Review를 넷 중 하나로 세우면서 상위 브랜드가 `Tomverse`로 남는다는 것을 적지 않았고, 그래서 §2가 "앱 이름을 바꾸라"로 읽혔습니다. |
| §2 | 대상 표의 `이메일`·`결제`·`SEO·OG` 행 | 이 세 행은 표면을 **책임 범위로 나누지 않고** 통째로 올렸습니다. 그 결과 계정 환영·결제·발신자처럼 플랫폼 공용인 표면이 제품명으로 덮였습니다. 표는 **실제로 바뀐 것의 기록**이므로 그대로 두고, 층위 판정은 §7.6이 표면별로 합니다. |
| §4 | "잡는 것: `Tomverse Insight` …" | 검사는 설계대로 동작합니다. **한계를 적지 않은 것**이 문제입니다 — 폐기된 이름은 잡지만, **맞게 적힌 새 이름이 틀린 층위에 있는 것은 잡지 못합니다.** §7.5의 2~4번은 자동화돼 있지 않습니다. |

같은 한계가 `docs/ops/product-boundary-v1-2-staging-checklist.md`의 C 구획에도
있습니다. C는 "폐기된 이름이 없는가"만 묻고 "새 이름이 맞는 층위에 있는가"는 묻지
않습니다. **그 문서는 이번 작업에서 수정하지 않았습니다.**
