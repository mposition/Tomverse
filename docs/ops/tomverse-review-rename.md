# Tomverse Insight → Tomverse Review 명명 전환

제품 경계 결정 기록 v1.2 결정 1의 실행 기록입니다. **이 전환은 이름만 바꿉니다** —
기능·대화·URL의 의미는 아직 아무것도 바뀌지 않았고, `/chat`은 계속 Review 호환
경로입니다.

## 1. 왜 이름을 옮기는가

Chat·Review·Studio·Code는 전부 **사용자가 하는 일**인데 Insight만 **나오는 결과**
였습니다. Branded House의 제품명은 "여기서 무슨 일을 하는가"에 답해야 하고,
"여기서 무엇을 얻는가"는 그 아래 층의 말입니다.

Insight는 폐기가 아니라 **이동**입니다. "Review Insight", "검토 결과"처럼 Review의
산출물을 가리키는 말로 계속 씁니다. 그래서 정적 검사는 두 단어 브랜드만 잡고
`Insight`라는 단어 자체는 잡지 않습니다.

이 변경은 UI 계약 §3의 금지어 규칙(better·best·optimal·smartest와 번역)에 걸리지
않습니다. **Review는 서술이지 우월성 주장이 아닙니다.**

## 2. 이번 변경이 실제로 바꾼 것

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
