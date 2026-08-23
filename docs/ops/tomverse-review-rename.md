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

이 저장소가 답할 수 없는 사실들입니다. **아래 항목은 아직 하나도 수행되지
않았습니다.**

### 5.1 Search Console 기준값 — 배포 전 필수, 미확보

배포 **전에** Search Console에서 최근 **28일**과 **90일**의 `Tomverse Insight`
검색 노출·클릭·진입 페이지를 저장합니다.

결정을 미루기 위한 것이 아닙니다. 결정은 이미 났습니다. 이 데이터가 정하는 것은
**전환 문구를 얼마나 오래 유지할 것인가** 하나입니다.

> **이 저장소에는 그 데이터가 없고, 추정치도 두지 않습니다.**
> 트래픽 규모를 모르는 채 유지 기간을 숫자로 적으면, 근거 없는 숫자가 이후 모든
> 논의에서 근거로 인용됩니다.

### 5.2 "formerly Tomverse Insight" 유지 기간 — 미결정

§5.1의 기준값을 확보한 뒤에 정합니다. 트래픽과 기존 사용자 규모가 유의미하면
일정 기간 `Tomverse Review — formerly Tomverse Insight`를 병기합니다.

**기간은 §5.1 없이 임의로 정하지 않습니다.** 정해지면 이 문서에 날짜와 근거를
적고 나서 문구를 넣습니다.

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
