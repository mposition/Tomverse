# 마케팅 댓글 모니터링·GA4 User-ID — DPIA 초안 체크리스트

상태: **초안 (2026-11-03, Claude 작성).** 법적 판단이 아니라, 판단을 내릴 사람이 묻고 답해야 할 질문과 지금 코드가 하는 사실을 모은 것입니다.
**lawful basis, DPIA의 위험 평가, DPA·하위처리자 확인, 국외 이전 판단은 운영자·법무의 일입니다.** 이 문서는 어느 것도 대신 결론 내리지 않습니다.

대상 두 가지:

1. **댓글 모니터링** — [마케팅 자동화 정책](marketing-automation.md)(`docs/policy/marketing-automation.md`) §12.1 (S4).
2. **GA4 User-ID** — 같은 정책 §10.2 (S6).

공개 문구는 `locales/*.ts`의 `privacyPolicy.comments*`와 `privacyPolicy.analyticsUserId*`(7개 locale: en, ko, zh, fr, de, es, pt)이고,
`components/legal/PrivacyPolicy.tsx`가 그리며, 둘 다 **기본 꺼짐** 스위치 뒤에 있습니다. 문구를 게시하는 것과 기능을 켜는 것은 다른 결정입니다.
**공개 범위가 다릅니다.** User-ID 절은 이 PR이 병합되면 공개됩니다(자리표시 없음). 댓글 절은 확인 필요 항목이 남아 있어서 `COMMENTS_PRIVACY_NOTICE_CONFIRMED`(`lib/privacyNoticeStatus.ts`)가 `false`인 동안 페이지가 그리지 않습니다. 자리표시를 모두 채운 뒤 그 상수를 `true`로 바꿔야 공개되고, 자리표시가 남은 채 `true`로 바꾸면 `tests/marketingPrivacyNotice.test.mjs`가 실패합니다.

읽는 법: 각 표의 "현재 사실"은 코드로 확인한 것(근거 경로 표기)이고, "남은 판단"은 사람이 정할 것입니다. `[운영자 확인 필요]`는 공개 문구에 자리표시가 들어간 항목입니다.

## 0. 먼저 알아야 할 것

| 항목 | 내용 |
|---|---|
| 지금 켜져 있는가 | 둘 다 꺼져 있습니다. 댓글은 `MARKETING_COMMENTS_MONITOR_ENABLED=true`(앱과 모니터 서비스 둘 다)가 있어야 돌고, User-ID는 `NEXT_PUBLIC_GA4_USER_ID_ENABLED=true`(빌드 시점 값, 재배포 필요)가 있어야 합니다. 이 PR은 어느 쪽 스위치도 건드리지 않습니다. |
| 이 PR이 바꾸는 코드 | `GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED`를 `true`로 바꿨습니다(`lib/ga4UserIdPolicy.ts`). 스위치가 꺼져 있으면 여전히 아무것도 만들지도 보내지도 않는다는 것을 `tests/ga4UserIdConsentGate.test.mjs`가 확인합니다. 로그인 후 분석 거절 시 철회 요청(`DELETE /api/analytics/user-id`)은 이제 스위치와 무관하게 호출되지만, 저장된 값이 없으면 GA4에도 DB에도 아무것도 하지 않습니다(`tests/server-contract/analytics-user-id-route.test.ts`). |
| `/privacy` 승인과의 관계 | 이미 대기 중인 `/privacy` 승인(위치·기억 문안, `document_not_amended`로 닫혀 있음, [제품 소식 재설계](email-product-news-redesign-draft.md) "남은 운영 조건" 1항)과 **같은 페이지·같은 시행일(2026-11-16)** 입니다. 이 PR이 페이지를 한 번 더 바꿔 관측 digest(`AMENDED_DOCUMENT_EVIDENCE`)만 갱신했고, 승인된 digest 목록(`APPROVED_AMENDED_DIGESTS`)은 건드리지 않았습니다. 소유자가 변경된 페이지를 한 번 승인할 때 이 두 고지도 함께 읽고 승인하는 것이 가장 적은 절차입니다. 이 문서의 어떤 내용도 그 승인, 발송, 릴리스 노트 게이트를 열지 않습니다. |
| 시행일·동의 재요청 | 페이지의 시행일은 2026-11-16 하나로 유지했습니다. 게이트가 두 문서(`/privacy`, `/terms`)의 날짜가 같아야 통과하기 때문입니다(`effective_dates_differ`). 로그인 화면의 동의는 문장 하나이고 정책 버전에 묶여 있지 않습니다. 개정 때 약관·방침 동의를 다시 받는 장치는 저장소에서 찾지 못했습니다. |

## 1. 댓글 모니터링 (정책 §12.1)

### 1.1 처리 흐름 (코드로 확인)

1. 본 앱이 게시 도구 Zernio의 `GET /v1/inbox/comments/{postId}`로 **최근 14일 안에 게시한 우리 글**의 댓글을 읽습니다(`lib/zernioCommentsQuery.ts`, `lib/marketingCommentsMonitor.ts`).
   작성자 객체는 읽지 않고, 본문과 시각만 메모리로 가져옵니다. 본문은 앞 1,000자로 자릅니다(`MARKETING_COMMENT_BODY_MAX_CHARS`).
2. 본 앱의 `POST /api/internal/marketing-comments-monitor` `collect`가 서로 다른 본문을 본문 SHA-256 id와 함께 댓글 모니터 서비스(Railway)에 응답으로 넘깁니다. 서비스는 인증은 되지만 신뢰하지 않는 쪽이고, 본문은 그 프로세스 메모리에만 있습니다(`lib/marketingCommentsClassifierCore.ts`). 본문·핸들·댓글 URL을 로그에 남기지 않습니다(스크립트의 로그 줄에는 상태와 건수뿐).
3. 서비스가 본문 50개씩 OpenAI(`api.openai.com`)에 보냅니다. 엄격한 구조화 출력, 닫힌 위험 코드 6개(`legal_threat`, `abuse_or_harassment`, `self_harm_or_safety`, `privacy_or_data_request`, `refund_or_billing_complaint`, `misleading_claim_dispute`), `store: false`, 재시도 없음(`lib/marketingLlmClientCore.ts`). 호출마다 마케팅 LLM 비용 원장(`MarketingLlmCall`)에 예약·정산되는데, 거기에는 토큰·모델·목적·**무작위** requestKey만 있고 본문이나 본문에서 파생한 값은 없습니다.
4. 서비스가 판정만 돌려주고, 본 앱이 댓글을 다시 읽어 알림을 엽니다. 판정은 알림을 열 수만 있고 닫거나 계정을 정상으로 판정할 수 없습니다.
5. 저장되는 것: `comment_alerts` 보고서 한 건 — 내부 게시물 id, 건수, 위험 코드, 최초 감지 시각, **게시물 URL의 host** — 과 시스템 감사 한 줄(`marketing_comment_alert.recorded`: 건수와 위험 코드). 작성자·본문·댓글 링크는 저장하지 않습니다. 보고서는 `retentionUntil`로 90일 뒤 일일 정리(`lib/marketingRetention.ts`)가 지웁니다.
6. 이 모니터링은 댓글에 답하거나 숨기거나 삭제하지 않습니다(`lib/marketingCommentsMonitor.ts`는 읽기와 알림뿐). 열린 알림을 24시간 안에 사람이 확인하지 않으면 해당 **우리 계정의 게시가 정지**됩니다(§8.3). 댓글 작성자에게 미치는 효과는 없습니다.

### 1.2 질문표

| # | 질문 | 현재 사실 | 남은 판단 (사람) |
|---|---|---|---|
| C1 | 목적과 필요성: 왜 읽는가, 덜 침해적인 방법이 없는가 | 목적은 사람이 봐야 할 댓글(법적 위협, 괴롭힘, 안전, 개인정보 요청, 환불·결제 불만, 주장 이의)을 24시간 안에 찾는 것입니다. 호주 ACCC 안내가 자기 페이지의 제3자 댓글 책임을 묻는 점이 근거입니다(§13). 본문만 보내고 작성자는 보내지 않으며 본문은 저장하지 않습니다. | 필요성·비례성 판단. 게시물 단위 키워드 알림 같은 덜 침해적 방법과의 비교를 DPIA에 적을지. |
| C2 | lawful basis (GDPR 6조, 한국 PIPA, 호주 APP 3·6) | 공개 문구는 `[운영자 확인 필요]` 자리표시입니다(`commentsTransfer6`). 코드는 어떤 근거도 가정하지 않습니다. | **법무 결정.** 정당한 이익을 택한다면 이익 형량 기록(LIA)이 필요합니다. |
| C3 | 특수범주·민감 정보 가능성 | `self_harm_or_safety`·`privacy_or_data_request` 분류는 건강 정보, 정치·종교 의견 등을 담은 댓글을 본문 그대로 OpenAI에 보낼 수 있다는 뜻입니다. 코드가 거르지 않습니다. 저장은 하지 않습니다. | 특수범주 처리의 추가 근거(GDPR 9조)가 필요한지. 필요하면 어떤 완화(예: 해당 분류 제거)를 할지. |
| C4 | 미성년자 | 댓글 작성자의 나이를 알 수 없습니다. 정책 §13은 16세 이상만 겨냥하고 10대 겨냥 표현을 금지합니다. 모니터링은 연령을 구분하지 않습니다. | 아동 개인정보 관점의 DPIA 항목(호주 Children's Online Privacy Code 등록 예정, §13)을 어떻게 다룰지. |
| C5 | 처리자 지위: Zernio | 공개 문구에는 법인·국가가 자리표시입니다(`commentsTransfer3`). 코드는 `https://zernio.com/api`만 압니다. 정책 §12.1은 "처리자 지위·DPA·하위처리자·데이터 위치"를 선행 조건으로 둡니다. | **운영자 확인**: Zernio 법인명·소재국, DPA 체결 여부와 일자, 하위처리자 목록, 데이터 저장 위치, 댓글 데이터를 Zernio가 보관하는지와 기간(`commentsTransfer7`). |
| C6 | 처리자 지위: OpenAI | 공개 문구는 OpenAI OpCo, LLC(미국)로 적었습니다. 마케팅 LLM 키는 채팅 키와 **같은 조직인지 코드로 알 수 없습니다.** 채팅용 OpenAI의 사실(학습 안 함, 악용 모니터링 30일 등)은 `lib/providerDataDestinations.ts`에 있지만 이 키에 같은 약정이 적용되는지는 확인되지 않았습니다. | **운영자 확인**: 이 키의 조직, DPA 적용, 학습·보관 설정, 악용 모니터링 보관 기간. 공개 문구의 "OpenAI가 본문을 보관하는 기간"은 이 확인 뒤에 채웁니다. |
| C7 | 국외 이전 | 한국(PIPA 28-8), EU(GDPR 5장), 호주(APP 8)별로 이전 사실이 다릅니다. 공개 문구는 이전받는 자·방법·목적·시점을 나열했고 국가는 OpenAI(미국)만 적었습니다. Zernio 국가는 자리표시입니다. | 이전 근거(표준계약조항, 적정성, 동의 등)와 호주 APP 8.1에 따른 해외 수령자의 책임 확보 방법. 한국 이용자 댓글이 있을 때 PIPA의 고지 항목이 모두 채워지는지. |
| C8 | 작성자에 대한 고지 (GDPR 14조, 간접 수집) | 작성자에게 개별 고지를 보낼 수단이 없습니다. 개인정보처리방침 `privacyPolicy.comments`가 유일한 고지입니다. 게시물에 방침 링크를 붙이는 장치는 없습니다. | 14조 5항(b)의 "불균형한 노력" 예외를 쓸지, 각 SNS 프로필 소개에 방침 링크를 두는 등 보완을 할지. |
| C9 | 정보주체 권리 | 작성자를 식별하는 정보를 보관하지 않으므로 조회·정정 대상이 없습니다(GDPR 11조). 공개 문구는 SNS에서 직접 삭제하거나 `support@tomverse.app`에 문의하라고 안내합니다. 개인정보 요청 Admin 흐름(`app/api/admin/privacy-requests/route.ts`)은 계정 중심이라 댓글 작성자 요청을 받는 별도 절차는 없습니다. | 비계정 작성자의 문의가 들어올 때 누가 어떻게 답하는지. |
| C10 | 보유 | 알림 90일, 시스템 감사 한 줄은 감사 체인 정책을 따릅니다(이 문서는 감사 보유 기간을 정하지 않습니다). 정리 작업은 매일 한 번, 표마다 한 묶음씩 돌고, 마케팅 kill switch가 켜져 있는 동안 멈추고 풀리면 이어집니다(`lib/marketingRetention.ts`). 공개 문구도 "매일 도는 정리 작업이 90일 뒤 삭제하며 멈추면 다시 시작될 때까지 미뤄진다"고 적었습니다. | 감사 기록의 보유 기간이 "개인정보 없음"으로 충분한지. 90일의 근거. |
| C11 | 자동화된 결정 (GDPR 22조) | 모델은 알림만 열 수 있고 사람이 결정합니다. 작성자에게 법적·유사한 효과가 없습니다. 다만 24시간 미확인 시 **우리** 계정이 자동 정지됩니다. | 22조 비해당 판단 기록. |
| C12 | 보안 | 서비스 호출은 생성기 secret으로 인증하고 DB·게시 도구 자격이 없는 서비스에 본문이 전달됩니다. 본문은 프로세스 메모리에만 있고 응답에 담겨 내부 HTTPS로 이동합니다. kill switch(`MARKETING_AUTOMATION_KILL_SWITCH`)는 앱이 지킵니다. | 서비스 간 구간 암호화·접근 통제가 DPIA 기준에 충분한지. 프롬프트 주입은 판정이 알림 개설만 가능하도록 제한해 완화했습니다. |
| C13 | 실제 응답과의 대조 | `lib/zernioCommentsQuery.ts`는 필드 이름을 벤더 문서에서 읽었고 **실제 응답으로 대조한 적이 없다**고 명시합니다. | 스위치를 켜기 전 한 번, 실제 응답에 작성자·링크 외에 보관되는 값이 없는지 사람이 대조. |

## 2. GA4 User-ID (정책 §10.2)

### 2.1 처리 흐름 (코드로 확인)

- 값: 계정과 무관한 128비트 무작위(`newAnalyticsUserId`), `Ga4UserId` 표에 계정당 최대 한 행으로 저장(`lib/ga4UserId.ts`). 계정 id·이메일에서 계산하지 않습니다.
- 만드는 조건(모두 충족해야 함, `lib/ga4UserIdPolicy.ts`): 고지 상수 `true` · `NEXT_PUBLIC_GA4_USER_ID_ENABLED=true` · 분석 **명시 동의**(`accepted`; 선택 없는 지역의 미결정 제외) · 로그인 · GA4 측정 id. 서버는 고지·스위치·로그인과 요청 본문의 동의 진술이 맞을 때만 만듭니다.
- 전송: 브라우저의 gtag `user_id`로만. 서버 Measurement Protocol에는 붙이지 않습니다.
- 로그아웃: 태그에서 `user_id`를 `null`로 해제. **DB 행은 남고** 다음에 같은 값을 다시 씁니다.
- 철회: 로그인 상태에서 분석을 거절하면 GA4 Admin API `submitUserDeletion`을 한 번 요청한 뒤 행을 지웁니다. 요청이 실패해도 행은 지우고(운영 incident 기록, 재시도 없음), 이후 다시 동의하면 연결 없는 새 값을 만듭니다. 로그아웃 상태의 거절은 그 브라우저에만 적용되고 계정 값은 지우지 않습니다.
- 계정 삭제: 삭제 트랜잭션에서 값을 읽고 행을 cascade로 지운 뒤 커밋 후 GA4 삭제를 한 번 요청합니다(`lib/accountDeletion.ts`).

### 2.2 질문표

| # | 질문 | 현재 사실 | 남은 판단 (사람) |
|---|---|---|---|
| G1 | lawful basis | 설계는 **명시 동의**입니다(미결정은 제외). 공개 문구도 "명시적으로 동의한 경우에만"이라고 적었습니다. | 동의가 GDPR 7조·ePrivacy 5조 3항의 "구체적이고 정보에 입각한" 요건을 충족하는지. |
| G2 | **고지 이전에 받은 `accepted`를 어떻게 볼 것인가** | 분석 동의는 브라우저 `localStorage`에 `accepted`/`declined` 문자열 하나로 저장되고 **버전이나 시각이 없습니다**(`lib/productAnalyticsClient.ts` `setAnalyticsConsent`). 스위치를 켜면 이 PR 이전에 분석에 동의한 로그인 사용자도 다음 접속에서 User-ID를 받습니다. 그 동의는 교차 기기 식별자를 설명하지 않던 문안을 보고 한 것입니다. | **스위치를 켜기 전에 결정해야 하는 가장 중요한 항목입니다.** 선택지: (a) 기존 동의를 인정, (b) 동의 저장에 버전을 도입해 이전 동의로는 User-ID를 만들지 않고 다시 묻기. (b)는 별도 코드 변경입니다. 이 PR은 하지 않았습니다. |
| G3 | Google의 지위 | 공개 문구는 "Google Analytics의 일부로 Google이 처리"라고만 적었습니다. | Google Analytics 데이터 처리 약관 체결·적용 여부, 독립 컨트롤러 여부, 하위처리자. |
| G4 | 국외 이전 | 공개 문구는 "이용자의 국가 밖일 수 있음"까지만 말합니다(기존 분석 문단과 같은 수준). | 이전 근거. 호주 APP 8과 한국 PIPA 28-8 고지를 이 수준으로 충분하다고 볼지. |
| G5 | Google 쪽 보유 | 공개 문구는 "Tomverse의 GA 설정에 정한 기간"이라고만 적었습니다. 그 설정값은 코드에 없습니다. | **운영자 확인**: GA4 속성의 이벤트·사용자 단위 데이터 보관 기간 설정. 숫자를 문구에 넣을지. |
| G6 | 삭제 요청의 실효 | `submitUserDeletion`은 요청이고 완료 보장이 아닙니다. 요청 실패·자격증명 누락은 운영 incident로 남고 재시도하지 않습니다(`lib/ga4UserDeletion.ts`). Tomverse 쪽 값은 어느 경우에도 지웁니다. 문구도 그렇게 적었습니다. | 서비스 계정(`GA4_USER_DELETION_SERVICE_ACCOUNT_JSON`)과 `GA4_PROPERTY_ID`가 운영에 설정됐는지, Editor 역할인지 — **운영자 확인**. 자격증명 없이 켜면 철회가 GA4에 닿지 않습니다. |
| G7 | 계정 삭제·철회 시 이미 보낸 데이터 | 삭제 요청 후에도 Google이 처리를 끝낼 때까지 시간이 걸릴 수 있습니다. | 이용자에게 약속할 수 있는 시점 표현이 맞는지(현재 문구는 "삭제를 요청"). |
| G8 | 아동 | 연령을 구분하지 않습니다. 정책 §13은 User-ID·실험 설계를 Children's Online Privacy Code 재확인 항목으로 둡니다. | 재확인 결과. |
| G9 | 모바일 앱 | `AnalyticsProvider`는 웹 컴포넌트입니다. Capacitor 앱 WebView에서 같은 경로가 도는지 이 PR은 확인하지 않았습니다. | 앱에서도 같은 고지·동의 흐름이 적용되는지. |
| G10 | 이용자 선택 | 공개 문구: 분석 설정에서 언제든 바꾸고, 로그인 상태의 거절이 철회입니다. 로그아웃 상태의 거절은 철회가 아닙니다(문구에 적음). | 로그아웃 상태 거절이 계정 값을 남기는 것이 수용 가능한지. |

## 3. 공개 문구의 `[운영자 확인 필요]` 목록

`tests/marketingPrivacyNotice.test.mjs`의 `PENDING_CONFIRMATIONS`가 같은 목록을 7개 locale에서 확인합니다. 해결하면 문구에 사실을 쓰고 그 목록에서 지웁니다.

| 키 | 자리표시 내용 | 필요한 확인 |
|---|---|---|
| `commentsTransfer3` | Zernio 법인과 국가 | C5 |
| `commentsTransfer6` | 댓글을 읽는 처리 근거 | C2 |
| `commentsTransfer7` | Zernio와 OpenAI가 본문을 보관하는 기간 | C5, C6 |

자리표시가 남아 있는 동안 댓글 절은 공개 페이지에 그려지지 않습니다(위 상수). 자리표시를 지우는 변경은 **같은 PR에서 상수를 `true`로** 바꾸고, 7개 locale에 같은 사실을 넣어야 합니다. 그 변경도 외부 공개 문구이므로 소유자 승인 대상입니다.

## 4. 병합과 활성화 순서 (제안)

추천이지 승인이 아닙니다.

1. 법무: C2(근거), C3(특수범주), C7·G4(국외 이전), C8(작성자 고지), G1·G2(동의의 구체성)를 결정합니다.
2. 운영자: C5·C6·G3·G5·G6의 사실을 확인하고 자리표시를 채웁니다. 채운 문구는 7개 locale에 같은 사실로 옮기고 `COMMENTS_PRIVACY_NOTICE_CONFIRMED`를 `true`로 바꿉니다(후속 PR).
3. 소유자: 변경된 `/privacy`(위치·기억·댓글·User-ID)를 한 번 승인합니다. 승인하면 그 digest를 `APPROVED_AMENDED_DIGESTS`에 적는 후속 변경이 필요합니다(이 PR은 적지 않았습니다).
4. 이 PR 병합(외부 공개). 병합 시점의 `/privacy`가 공개 고지입니다: User-ID 절은 공개되고 댓글 절은 위 상수가 `true`가 될 때까지 숨겨져 있습니다.
5. G2 결정에 따라 필요하면 동의 버전 도입을 먼저 구현합니다.
6. 스위치를 하나씩 켭니다. 댓글: C13 실제 응답 대조 후 `MARKETING_COMMENTS_MONITOR_ENABLED`(앱과 서비스). User-ID: G6 자격증명 확인 후 `NEXT_PUBLIC_GA4_USER_ID_ENABLED`와 재배포.
7. 켠 뒤 첫 주에 댓글 알림 건수와, GA4 삭제 요청이 거절·미확정으로 끝난 운영 incident가 있는지 봅니다.

기존 이용자에게 개정을 이메일로 알릴지(이메일 개정의 `policy_change_notice`는 이메일 문안 개정용이며 이 두 고지를 담지 않습니다)는 소유자가 정할 항목입니다.
