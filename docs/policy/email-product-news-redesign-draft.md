# 제품 소식 이메일: 수집 경로 만들기 (초안 v6)

> **이 문서의 지위: 초안입니다. 승인되지 않았고, 코드는 하나도 없습니다.**
> 여기 적힌 D1~D5는 제안이며, §8의 승인 항목이 처리되기 전에는 어떤 것도
> 구현하지 않습니다. 이 문서가 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

## 0. 개정 이력

### v6 (2026-09-16) — 독립 검토 5회차 반영 (판정: approve-with-changes)

5회차가 조건부 승인을 냈고, 조건으로 붙은 것을 전부 문서에 넣었습니다.

- **OAuth 결속을 쿠키에서 로그인 후 finalize로 바꿨습니다.** 쿠키 하나로는
  다른 브라우저 재생, 같은 브라우저 동시 가입 두 개의 덮어쓰기, 하위 도메인
  cookie tossing을 막지 못합니다. `sessionStorage`의 `attemptId`와 **인증된
  세션**을 함께 요구하는 쪽으로 옮겼습니다.
- **소비와 확인 메일 생성을 한 transaction으로 묶었습니다.** 따로 두면 선택은
  소비됐는데 메일이 없는 상태가 남습니다.
- **국가를 뒤로 옮긴 결과를 끝까지 적었습니다** — 요청 기록은 미확정으로 남고,
  **grant 시점의 활성 정책**이 화면과 기록을 정하며, 한국이면 그 화면이 곧
  동의 행위이므로 `광고성 정보 수신동의`·발신자·목적·철회 방법·국가와 정책
  버전을 보여 주고 그 문구의 해시를 evidence에 남깁니다.
- **한국 처리결과 통지(시행령 제62조의2, 14일)를 S3에 넣었습니다.** 확인 메일은
  grant 전에 나가므로 그 통지가 아닙니다.
- **판정 입력을 버전 id에서 enqueue 시점 판정 snapshot으로** 바꿨습니다. id만
  보고는 그때 그 국가의 map·profile이 있었는지 알 수 없습니다.
- **DB 오류는 백오프를 그대로 써서 재시도**합니다. 즉시 재claim하면 hot loop와
  incident 폭주가 됩니다.
- **S0의 범위를 넓혔습니다.** 분류표만이 아니라 국가 확인 시점·미확정 관할권의
  의미·grant 시점 정책·한국 처리결과 통지까지 함께 승인받아야 합니다.
- **윤일과 F4 증거 기준을 "테스트한다"에서 "정한다"로** 바꿨습니다.

### v5 (2026-09-16) — 독립 검토 4회차 반영

네 번째 검토가 남은 구멍을 좁게 지목했고, 전부 문서의 빈칸이었습니다.

- **OAuth 이음매를 실제로 적었습니다.** NextAuth의 `state`는 우리가 값을 정할
  수 없으므로 결속 수단이 아닙니다 → `signIn()` 전에 행을 만들고 nonce를
  httpOnly 쿠키에 두었다가 callback에서 찾습니다. 상태 전이는 네 줄의 표로
  고정했습니다.
- **국가 handoff가 없었습니다.** `requestConsentConfirmation()`이 국가를
  필수로 받는데 가입 시점에는 없습니다 → 국가 질문을 **확인 화면으로**
  옮겼습니다. 가입 화면에서 국가는 사라집니다.
- **dry-run 계약이 상위 문서와 충돌했습니다.** 기존 campaign dry-run은 일부러
  skipped 행을 만듭니다 → 그 계약은 그대로 두고 release notes용으로 행을 쓰지
  않는 `estimateReleaseNotesAudience()`를 따로 둡니다.
- **저수준 writer 이름이 틀렸습니다.** `enqueueStandardEmail()`이 아니라
  `createStandardDeliveryRows()`입니다.
- **판정에 이력 입력을 넣었습니다.** "한 번 허용됐다가 지금 아니다"와 "애초에
  허용된 적이 없다"를 구분하려면 enqueue 당시 버전이 필요합니다. 그리고 DB를
  읽지 못한 것은 skip이 아니라 **재시도와 incident**입니다.
- **외부 CTA를 닫았습니다.** 승인 시점 해석도 SSRF 표면이라 시점만 옮깁니다.
- **F4 기한을 배포가 아니라 고지 도달로 바꿨습니다.** 시행령이 요구하는 것은
  2년이 되는 날 전까지 확인 안내가 가 있는 것이고, 예정일은 Asia/Seoul 달력
  기준입니다.

### v4 (2026-09-16) — 독립 검토 3회차 반영: 두 계약을 채웠습니다

3회차는 범위 축소를 인정하면서 **"전면 재검토는 불필요하고 두 계약과 기한
하나를 채우면 된다"**고 했습니다. 그 셋을 채웠습니다.

1. **가입 동의의 상태 기계(D3).** 서명 토큰만으로는 재사용을 막지 못하고,
   OAuth 버튼은 이메일을 알기 전에 시작하며, NextAuth의 `createUser`에는
   provider·state가 오지 않습니다 → `SignupConsentAttempt` 행과 compare-and-set
   소비, 채널별 결속, 기존 사용자 로그인 배제, 재시도 supersede를 적었습니다.
2. **현재 정책 재판정의 입력(D5).** `permission_revoked`가 무엇을 뜻하는지
   비어 있었습니다 → 판정 함수의 입력 목록과 skip 사유의 경계를 적었습니다.
3. **F4 기한.** 한국 2년 고지 배치를 무기한 보류로 두지 않고, 최초 예정일
   저장·backfill 방법과 "첫 대상자의 예정일 전 배포"라는 릴리스 조건을
   적었습니다.

함께 고친 것: 상위 계약 개정을 **S0으로 복원**(분류표가 아직 기능 업데이트를
`service(동의 기반)`로 적고 있어 코드가 먼저 들어가면 승인된 정책과 모순),
flag 검사 범위에 `expandEmailEvent()` 같은 **직접 writer 포함**, 링크 규칙을
**발송 중 redirect 추적이 아니라 고정 목적지 표**로, `lib/appSettings.ts`를
변경 범위에 추가.

### v3 (2026-09-16) — 독립 검토 2회차 반영: 범위를 줄였습니다

v2는 1회차의 blocker 셋(분류 오류, 한국 라벨 우회, 저신뢰 IP 확장)을 고쳤고
검토도 그것을 인정했습니다. 그런데 2회차가 더 아픈 지적을 했습니다.

> **모든 프로파일이 `express_consent`라면, 네 가지 근거와 국가별 필드와 새
> 장부는 발송 결과를 하나도 바꾸지 않습니다.** 당장 생기는 효과는 "가입 시
> 명시적 동의를 수집할 수 있게 됨" 하나뿐이고, 나머지는 승인되지 않은 미래
> 완화를 위한 선투자입니다.

맞는 지적입니다. v3은 **지금 효과가 있는 것만** 남깁니다.

| v2에 있던 것 | v3 |
|---|---|
| `permissionBasis` 4값 추상화 | **뺍니다.** 근거는 명시적 동의 하나 |
| `releaseNotesBasis` 프로파일 컬럼 | **뺍니다.** 완화를 승인할 때 만듭니다 |
| `EmailPermissionEvidence` 장부 | **뺍니다.** soft opt-in 적격성 증거는 완화할 때 필요합니다 |
| `account_feature_change` service 템플릿 | **뺍니다.** 별도 후속 과제(§9 F1) |
| 호주 발신자 overlay | **뺍니다.** release_notes만의 문제가 아니라 이메일 시스템 전체의 과제(§9 F2) |
| release_notes 전용 국가 allowlist | **뺍니다.** 기존 10개국 allowlist를 그대로 씁니다 |
| 가입 시 고지·거부 기록 | **명시적 동의 요청으로 바뀝니다.** 거부 기록은 완화용이라 지금은 불필요 |

남은 것은 다섯입니다 — 전용 flag, purpose 하나, 가입 시 동의 수집, 템플릿과
문안 규칙, audience와 dry-run.

### v2 (2026-09-16) — 독립 검토 1회차 반영

세 축 분리, marketing 분류 유지, 전 관할권 `express_consent`, IP 비확장.
v3이 그 결론을 이어받되 구현 범위를 줄였습니다.

### v1 (2026-09-16)

최초 초안. 독립 검토에서 reject. 기록으로만 남깁니다.

---

## 1. 무엇이 문제이고, 무엇이 아닌가

기능 안내 메일이 한 통도 나가지 못하는 이유는 분류가 아니라 **동의를 물어볼
자리가 제품에 없다는 것**입니다. 설정 화면이 유일한 경로이고, 거기까지 스스로
찾아온 사람은 0명입니다(2026-09-15 `GET /api/admin/marketing-reach`).

**분류를 바꾸는 것은 답이 아닙니다.** 조사 결과 기능 안내는 대부분의 법역에서
direct marketing이고, 이름을 바꾸면 라벨과 안전장치만 잃습니다(§2).

**따라서 이 설계가 하는 일은 하나입니다 — 가입하는 사람에게 물어보고, 답을
증거와 함께 남기고, 동의한 사람에게 보낼 수 있게 하는 것.**

## 2. 왜 분류를 낮추지 않는가

이 저장소에서 `classification === "marketing"` 하나가 다음을 켭니다.

- `lib/emailSendingIdentityCore.ts:40` — marketing 발송 스트림
- `lib/emailFeatureFlags.ts:113` — marketing kill switch
- `lib/emailJurisdictionComposition.ts:94` — `(광고)`·`<ADV>` 접두어
- `lib/emailTemplateDefinitions.ts:414` — unsubscribe 강제
- 관할권 footer 불완전 시 fail-closed

`service`로 낮추면 **한국 사용자가 동의를 마치고 받은 메일에 `(광고)`가 붙지
않습니다.** 라벨은 동의 여부가 아니라 메시지의 성격에서 나오는 의무입니다.

법적 근거도 낮출 수 없습니다. 한국 KISA 안내서는 거래관계 예외가 **"금전적인
대가를 지불한 거래관계"** 를 요구하고 **"회원가입"을 이름 대어 배제**합니다.
ePrivacy 제13조(2)의 soft opt-in은 "원래 광고인 메일"을 조건부로 허용하는
예외이지 분류를 바꾸는 규정이 아니며, CJEU C-654/23은 그 문을 좁게 열었습니다
— 무료 tier의 비용이 유료 구독가에 내재된 **구체적 상품 구조**가 근거였고,
스위스 FDPIC는 계정 개설만으로는 부족하다고 명시합니다.

그리고 **기존 계정은 소급으로 적격이 되지 않습니다.** soft opt-in 계열 예외는
전부 "수집 시점의 거부 기회"를 요건으로 하고, 그 시점은 이미 지나갔습니다.

---

## 3. D1 — `release_notes` purpose 하나

| | 값 |
|---|---|
| purpose | `release_notes` |
| classification | **`marketing`** |
| 기본값 | **꺼짐**. 동의로만 켜짐 |
| 동의 방식 | 기존 double opt-in 그대로 |
| unsubscribe | 필수 |
| 스트림 | marketing |

`product_updates`와 나누는 이유는 **수신자가 따로 끄고 켤 수 있게** 하기
위해서입니다. "새 기능은 받고 프로모션은 안 받겠다"가 성립합니다.

경계:

- `release_notes` — 무엇이 생겼고 무엇이 바뀌었는지, 그 기능으로 가는 링크
- `product_updates` — 특정 기능을 써 보라는 캠페인, 재참여
- `promotions` / `newsletter` — 가격·할인, 정기 소식지

### 함께 고치는 결함

`withdrawAllMarketing()`이 `recordsConsent(purpose)`로 대상을 고릅니다
(`lib/emailPreferences.ts:460`). purpose와 classification의 관계가 데이터에
없어서, 앞으로 동의 기반이 아닌 marketing purpose가 생기면 "모든 마케팅
중단"이 그것을 빠뜨립니다. **purpose 표에 classification을 두고 템플릿 정의와
일치하는지 정적 검사**합니다.

---

## 4. D2 — 전용 kill switch를 가장 먼저 만듭니다

`feature.emailReleaseNotesEnabled` (기본 `false`)를 **1단계에서** 만듭니다.

- **행을 만드는 실제 자리와 drain 양쪽**에서 검사합니다. 하나만 막으면 이미
  큐에 있는 것이 나갑니다. 저수준 writer는 `enqueueStandardEmail()`이 아니라
  **`createStandardDeliveryRows()`**(`lib/standardEmailLane.ts`)이며, 이미
  `lib/emailConsentConfirmation.ts`가 직접 부릅니다. 캠페인 쪽은
  `lib/emailAudienceExpansion.ts`의 `expandEmailEvent()`가 따로 만듭니다.
  **두 자리 모두에서 template key로 판정**합니다 — lane만 고치면 flag가 꺼진
  동안 행이 쌓였다가 켜는 순간 한꺼번에 나갑니다.
- 막힌 자리는 전용 사유 `release_notes_disabled`로 남깁니다. 아무것도 안 하고
  조용히 건너뛰면 왜 안 나갔는지 물었을 때 답할 수 없습니다.
- **기존 campaign dry-run은 그대로 둡니다.** 상위 계약과 현재 구현은 dry-run이
  `EmailDelivery(status="skipped", skipReason="dry_run")` 행을 **일부러**
  만듭니다([이메일 알림](email-notifications.md) §20). 그 계약을 이 설계가 바꾸지 않습니다 — 대신 release notes에는
  행을 하나도 쓰지 않는 **`estimateReleaseNotesAudience()`** 를 따로 두고, 같은
  판정 함수를 부르되 `EmailEvent`·`EmailDelivery`·`EmailCampaignRecipient`에
  아무것도 쓰지 않습니다.
- 기존 `feature.emailMarketingEnabled`와 **AND**입니다. 마케팅 전체가 꺼져
  있으면 이것이 켜져도 나가지 않습니다.
- 순서가 중요합니다 — **템플릿보다 flag가 먼저 존재해야** 합니다. 반대로 하면
  전용 게이트 없이 enqueue될 수 있는 템플릿이 잠시 존재합니다.

---

## 5. D3 — 가입할 때 물어봅니다

### 무엇을 묻는가

가입 화면에 **체크되지 않은 동의 요청 하나**를 둡니다.

- 한국어 화면은 **"광고성 정보 수신동의"** 라고 적습니다. "마케팅 동의"라는
  라벨은 KISA 안내서가 무효로 지목한 표현입니다.
- 약관 동의와 **묶지 않습니다.** 별도 항목이고 선택입니다.
- 체크하면 계정 생성 후 기존 DOI 흐름이 시작됩니다 — 확인 메일이 가고, 링크를
  눌러야 켜집니다.
- 체크하지 않으면 아무 일도 없습니다. **거부를 기록하지 않습니다** — 거부
  기록은 soft opt-in 적격성을 위한 것이고, 그 경로는 이 설계에 없습니다.

### 경로가 하나가 아닙니다

- OAuth: NextAuth adapter가 callback 중 생성 (`lib/auth.ts:237`)
- 이메일 코드: `resolveUserForVerifiedEmail()` (`lib/emailLogin.ts:321`)

화면의 체크 값이 이 경로들을 건너 계정 생성까지 도달해야 합니다.

**서명만으로는 부족합니다.** 서명은 위변조를 막을 뿐 재사용을 막지 못하고,
OAuth 버튼은 이메일을 알기 전에 `signIn()`을 시작하므로 발급 시점에 주소에
묶을 수 없으며, NextAuth v4의 `Adapter.createUser(user)`에는 provider·state·
가입 시도가 전달되지 않습니다. 따라서 **짧은 수명의 상태 행**을 둡니다.

`SignupConsentAttempt`

| 필드 | 뜻 |
|---|---|
| `nonceHash` | 클라이언트가 가진 값의 해시. 원본은 저장하지 않습니다 |
| `channel` | `oauth` \| `email_code` |
| `binding` | oauth는 provider + state, email_code는 `EmailLoginAttempt` id와 정규화된 주소 |
| `wantsReleaseNotes` | 체크 여부 |
| `expiresAt` | 짧은 만료 |
| `consumedAt` / `supersededAt` / `userId` | 소비 결과 |

규칙입니다.

- **소비와 그 결과는 한 transaction입니다.** CAS만 성공하고 확인 메일 생성이
  별도 transaction에서 실패하면 선택은 사라지고 메일은 없습니다. 그래서 ①
  만료·channel·binding까지 포함한 CAS ② 확인 요청 생성 ③ transactional
  delivery 행 생성 ④ `consumedAt`·`userId` 확정을 **하나로 묶습니다.** 이를
  위해 `requestConsentConfirmation(tx, …)` 형태의 transaction-aware seam이
  필요하며, 그것이 S3 범위입니다.
- CAS는 `consumedAt IS NULL`인 행만 갱신하므로 두 번째 시도는 실패하고 아무것도
  하지 않습니다.
- **email_code**: 그 `EmailLoginAttempt`와 정규화된 주소가 일치하고, 그 호출이
  **신규 사용자를 만드는 경우**에만 소비합니다.
- **oauth**: OAuth 흐름 자체에는 결속하지 않습니다. NextAuth의 `state`는 값을
  정할 수 없고, 쿠키 하나로 버티면 (a) 원본을 다른 브라우저로 복사해 재생할 수
  있고 (b) 같은 브라우저의 동시 가입 두 개가 같은 이름의 쿠키를 덮어써 첫 탭의
  선택이 두 번째 callback에 붙을 수 있으며 (c) 하위 도메인이 같은 이름의 쿠키를
  심는 길이 남습니다.

  대신 **로그인이 끝난 뒤에 마무리**합니다. 가입 화면이 `attemptId`를
  **`sessionStorage`**(탭마다 별개이고 쿠키가 아닙니다)에 두고, OAuth가 돌아와
  세션이 생긴 뒤 클라이언트가 그 값을 finalize 엔드포인트로 보냅니다. 서버는
  **인증된 세션의 user**를 신뢰하고, 그 계정이 **이 흐름에서 방금 만들어진
  것**일 때만 소비합니다.

  이렇게 하면 쿠키 사양 논쟁이 사라지고(쿠키가 없습니다), 탭이 섞이지 않으며
  (`sessionStorage`는 탭 범위), 훔친 `attemptId`만으로는 아무것도 못 합니다 —
  그 계정의 세션이 함께 있어야 합니다.

  주소는 **"adapter가 돌려준 계정 주소"** 라고 씁니다. Google·Azure provider
  mapper가 모든 경로에서 `email_verified`를 강제하지는 않으므로 "provider가
  확인한 주소"는 코드보다 강한 표현이고, **사서함 증명은 DOI가 합니다.**
- 탭을 닫아 finalize가 오지 않으면 **동의는 없던 일이 됩니다.** 계정은
  만들어졌고, 설정에서 언제든 켤 수 있습니다. 잃어버린 동의를 나중에 주워
  담지 않습니다.
- **기존 사용자의 로그인은 절대 소비하지 않습니다.** 동의는 가입 순간의
  결정이고, 로그인은 가입이 아닙니다.
- **체크 해제 후 재시도는 이전 행을 무효화**합니다. 무효화와 새 행 발급은 **한
  transaction**이고, 살아 있는 행은 브라우저당 하나입니다(`nonceHash` unique).
  경합은 `UPDATE ... WHERE consumedAt IS NULL AND supersededAt IS NULL`이
  한 행만 이기는 것으로 정리됩니다.

상태 전이는 이 넷뿐입니다.

| 지금 | 사건 | 다음 |
|---|---|---|
| `pending` | 소비 성공 | `consumed` (userId 기록) |
| `pending` | 같은 브라우저가 새로 발급 | `superseded` |
| `pending` | 만료 | `expired` (삭제 대상) |
| `consumed`·`superseded`·`expired` | 무엇이든 | 변하지 않음 |
- 만료·supersede·소비 실패 어느 경우에도 **계정 생성은 성공**합니다. 동의를
  못 받은 것이지 가입을 막을 일이 아닙니다. 실패는 구조화 이벤트로 남깁니다.

`createUser`에 요청 맥락이 없으므로, **계정 확정을 소유하는 경계를
account-finalization 서비스 하나로 정하고 두 경로가 그것을 부릅니다.** adapter
wrapper가 그 경계를 대신하려면 request-scoped attempt context를 넘기는 구체적
계약이 먼저 필요하며, 그 계약 없이 `createUser`에 기대지 않습니다.

이 행은 **인증 절차의 일회성 상태**이지 장기 증거 장부가 아닙니다. 만료된
행은 지웁니다.

### 소비 뒤에 무엇이 일어나는가 — 국가 없이 동의를 시작합니다

지금 `requestConsentConfirmation()`은 `confirmedCountry`를 **필수**로 받습니다
(`lib/emailConsentConfirmation.ts:108`). 가입 시점에는 확정된 국가가 없습니다.
그래서 국가를 가입 화면으로 끌어오지 않고, **확인 화면으로 넘깁니다.**

- 소비 성공 → 확인 메일을 보냅니다. 이 시점에는 **국가가 없어도 됩니다** —
  아직 아무것도 켜지지 않았고, 확인 메일 자체는 transactional입니다.
- 확인 링크를 누른 화면에서, 확정된 국가가 없으면 **거기서 한 번 묻습니다.**
  IP·언어·시간대로 기본값을 채우되 사용자가 확인해야 `self_declared`입니다.
- 국가가 정해진 뒤에야 preference가 켜집니다. 즉 **국가 질문은 가입에서
  사라지고 확인 클릭 한 번 뒤로 옮겨갑니다.**

**어느 정책이 그 화면을 정하는가.** 요청 시점에는 국가가 없으므로
`confirmation_requested`는 `ZZ`/미확정으로 기록하고, **국가를 고른 시점의 활성
정책**이 화면 문구와 `granted` 기록을 함께 정합니다. 요청 시점 정책과 현재
정책이 다를 수 있고, 둘 중 하나를 고르지 않으면 기록과 실제로 보여 준 문구가
어긋납니다.

**최종 POST는 `token + confirmedCountry`를 함께 받습니다.** 국가 저장,
preference 켜기, `ConsentRecord(granted)`, 한국이면 다음 고지 예정일 계산까지
**지금의 `setPreference()` transaction 안에서** 일어납니다.

### 한국에서는 이 화면이 곧 동의 행위입니다

국가를 뒤로 옮겼으므로, 법적으로 의미 있는 동의는 가입 화면의 체크가 아니라
**국가를 고른 뒤 누르는 최종 확인**입니다. 확정된 국가가 KR이면 그 클릭 전에
다음이 화면에 있어야 하고, 그 **렌더된 문구의 해시를 `ConsentRecord(granted)`
의 evidence에 남깁니다.**

- **광고성 정보 수신동의** — KISA 안내가 무효로 지목한 "혜택 알림"·"정보 제공"
  같은 표현을 쓰지 않습니다
- 발신자
- 목적과 내용
- 철회 방법
- 확인된 국가와 적용된 정책 버전

UI 언어가 영어여도 관할권이 KR이면 한국 표시를 함께 냅니다. 언어는 사용자의
선택이고 관할권은 법의 문제라 서로 다른 축입니다.

### 한국의 처리결과 통지 (시행령 제62조의2)

동의 또는 철회 뒤 **14일 이내**에 발신자, 처리 사실과 날짜, 처리결과를 알려야
합니다. **현재 확인 메일은 이것이 아닙니다** — grant 이전에 나가기 때문입니다.
첫 한국 동의를 받는 순간부터 의무가 생기므로 **F4가 아니라 S3 범위**이고,
결과 영수증 화면 또는 별도 transactional 메일과 그 감사 증거를 함께 만듭니다.

따라서 `requestConsentConfirmation()`은 국가가 아직 없는 요청을 받을 수 있어야
하고, 확인 route는 국가를 함께 받을 수 있어야 합니다. 이 두 계약 변경이 S3의
범위입니다.

### 국가는 어떻게 되는가

DOI 흐름이 이미 국가를 묻습니다(현재 구현). 그 화면의 **기본값을 IP·언어·
시간대로 채우되**, 사용자가 확인해야 `self_declared`가 됩니다.

**추정은 발송 권한을 넓히지 않습니다.** 확인되지 않은 국가는 보류이고, 신호가
충돌하면 보류입니다. 이는 2회차 검토가 종결로 판정한 결론을 그대로 유지하는
것입니다 — 프로파일 사이에 전순서가 없어서 "더 엄격한 쪽"은 `(광고)`와
`<ADV>` 중 무엇을 붙일지조차 정하지 못합니다.

---

## 6. D4 — 템플릿과 문안 규칙

`release_notes` 템플릿은 **구조화된 payload**를 받습니다. 자유 HTML이
아닙니다.

```
{ headline, items: [{ title, body, link? }], footerNote? }
```

- `link`는 **제품 경로 id**입니다. 자유 URL이 아니라 고정된 목적지 표에서
  고르며, 가격·결제·업그레이드 경로는 표에 없습니다.
- **외부 목적지는 이 범위에서 허용하지 않습니다.** 승인 시점에 한 번
  해석하더라도 그 fetch 자체가 SSRF와 DNS rebinding 표면이고, 시점을 옮길 뿐
  없애지 못합니다. 외부 CTA가 필요해지면 사람이 검토해 등록한 목적지 표를
  먼저 만듭니다. 발송 경로는 어떤 경우에도 네트워크를 따라가지 않습니다.
- CTA는 타입이 있는 필드이고 자유 문구가 아닙니다.
- 금칙어 검사(가격·할인·한정 기간 표현)는 **보조 guard**로만 둡니다. 2회차
  검토가 지적한 대로 문자열 검사는 법적 분류기가 아니며, 링크 대상과 전체
  인상을 잡지 못하고 정상 문구를 오탐할 수 있습니다.
- 발송 전 **미리보기 승인**이 사람의 단계로 남습니다.

7개 언어 문안은 `tests/releaseNotesContentRules.test.mjs`가 함께 검사합니다.

---

## 7. D5 — audience와 dry-run

현재 cohort는 `marketing_consent` + `purpose: "product_updates"`로 고정돼
있습니다(`lib/emailAudienceExpansionCore.ts:116`). 그대로 두면 release_notes
캠페인의 수신자 집합이 존재하지 않습니다.

- cohort spec에 purpose를 받게 하고, **발송 시점 판정과 같은 순수 함수**를
  audience·dry-run·enqueue가 공유합니다. 세 곳이 다른 답을 내면 승인 화면의
  숫자가 거짓이 됩니다.
- dry-run은 **제외 사유별 인원 수**를 보여 줍니다 — 동의 없음, 미확인, 국가
  미지원, suppression, 관할권 미확정.
- 캠페인 수신자 행에 **판정에 쓰인 정책 버전**을 기록합니다.

### 큐에 고정된 정책과 현재 권한

`EmailDelivery`는 enqueue 시점의 정책을 고정합니다. 렌더링 재현에는 맞지만
권한 판정에는 맞지 않습니다.

- **렌더링·감사**: 고정된 정책 버전
- **권한**: provider 호출 직전에 **현재 활성 정책**으로 재판정
- 현재 정책이나 프로파일을 읽지 못하면 **fail closed**

판정 함수의 입력을 여기서 정합니다. 문서가 이것을 적지 않으면 구현자가 무엇을
읽어야 하는지 알 수 없고, `permission_revoked`는 도달할 수 없는 사유가 됩니다.

```
releaseNotesAuthorizationVerdict({
  preference,          // 지금의 enabled·confirmedAt
  jurisdiction,        // 지금 확정된 관할권 (추정은 통과하지 못함)
  activePolicyVersion, // 지금 활성인 EmailPolicyVersion
  countryMapEntry,     // 그 버전이 이 국가를 매핑하는가
  profile,             // 그 버전에 이 profile 행이 있는가
  enqueuedSnapshot,    // 이 행이 만들어질 때의 판정: 정책 버전, 확정 국가,
                       // 그 국가의 map·profile 존재 여부, 허용/거부와 사유
  marketingEnabled,    // feature.emailMarketingEnabled
  releaseNotesEnabled, // feature.emailReleaseNotesEnabled
  suppression,
}) -> { allowed: true } | { allowed: false, skipReason }
```

snapshot이 **버전 id 하나가 아닌 이유**는, 순수 함수가 "그때 그 국가의
map과 profile이 있었는가"를 id만 보고는 알 수 없기 때문입니다. 그래서 enqueue
시점에 판정 결과 자체를 적어 둡니다.

그 위에서 두 사건이 갈립니다 — **"한 번은 허용됐다가 지금은 아니다"** 가
`permission_revoked`이고, **"enqueue 시점에도 허용되지 않았다"** 가
`marketing_country_not_allowed`입니다. "어느 정책에서도 허용된 적 없다"는 두
시점만으로 증명할 수 없으므로 그렇게 주장하지 않습니다.

skip 사유의 경계입니다.

| 사유 | 무엇이 일어났나 |
|---|---|
| `consent_withdrawn` | 사용자가 껐거나 확인을 취소했다 |
| `permission_revoked` | **정책 쪽이 바뀌었다** — 활성 버전이 이 국가의 매핑이나 profile을 더 이상 갖지 않는다 |
| `no_consent` | 애초에 켜진 적이 없다 |
| `release_notes_disabled` | 전용 flag가 꺼져 있다 |
| `marketing_country_not_allowed` | 어느 정책에서도 지원된 적이 없는 국가다 |
| 기존 사유 | suppression, 관할권 미확정 |

**활성 정책을 읽지 못하는 것은 skip이 아닙니다.** DB 오류로 판정할 수 없으면
행을 영구 skip으로 만들지 말고 claim을 풀어 **기존 재시도 일정의
`nextAttemptAt`을 설정**하고 incident를 올립니다. 즉시 다시 claim되면 hot
loop와 incident 폭주가 되므로 백오프를 그대로 씁니다. 읽지 못한 것과 허용되지
않은 것은 다른 사실이고, 앞의 것을 뒤의 것으로 기록하면 복구 가능한 장애가
조용한 데이터 손실이 됩니다.

사용자가 한 일과 우리가 한 일은 다른 사건이고, 지원 문의에 답하려면 둘을
구분해야 합니다.

---

## 8. 승인이 필요한 항목

| # | 무엇 | 왜 사람이 정해야 하나 |
|---|---|---|
| A | **가입 화면에 동의 요청을 넣는 것** | 가입 전환율에 영향을 줍니다 |
| B | **도달이 당장 늘지 않는다는 것** | 이 설계가 만드는 것은 동의를 모으는 자리입니다. 오늘 보낼 수 있는 사람은 0명에서 시작합니다 |
| C | **`release_notes`를 marketing 스트림으로 보내는 것** | 발송 도메인 평판에 영향을 줍니다(R2) |

**C8(soft opt-in 미사용) 개정은 v3에서 필요하지 않습니다.** 근거가 명시적
동의 하나이므로 기존 결정과 충돌하지 않습니다.

---

## 9. 이 설계 밖으로 옮긴 것

| # | 무엇 | 왜 별도인가 |
|---|---|---|
| F1 | `account_feature_change` (계약상 필요한 통지) | 2회차 검토: "이미 쓰는 기능의 변경"은 service 분류 근거로 너무 넓습니다. 한국 예외는 계약·안전·보안 통지에 초점이 있고, 범위를 **법률 검토로 좁힌 allowlist**로 정의해야 합니다. 별도 purpose·기본값·철회 동작·DB CHECK가 함께 필요합니다 |
| F2 | 호주 발신자 overlay | Spam Act는 발신 조직의 중앙관리가 호주에 있으면 **수신자 국가와 무관하게** 적용됩니다. 이는 release_notes만의 문제가 아니라 우리가 보내는 모든 상업 메일의 문제이고, 이메일 시스템 전체의 개선으로 다뤄야 합니다 |
| F3 | 관할권별 근거 완화 (soft opt-in, 추론 동의) | R1 외부 자문이 선행합니다. 그때 `releaseNotesBasis`·취득 증거 장부·국가별 allowlist를 만듭니다 |
| F4 | 한국 2년 재확인 고지 배치 | 한국 동의자가 생기는 순간부터 타이머가 돕니다. **기한이 있는 보류입니다.** 시행령 제62조의3은 동의일부터 2년이 되는 날 **전까지 수신자에게 확인 안내가 가 있을 것**을 요구하므로, 릴리스 조건은 "배치를 배포했다"가 아니라 **"첫 대상자의 기한 전에 고지가 실제로 나갔다"** 입니다. **증거 기준은 법률 검토로 하나를 고릅니다** — provider 접수(accepted)인지 실제 전달 이벤트(delivered)인지. `ConsentRecord(confirmation_notice_sent)`는 그 사건 **뒤에만 멱등 생성**하고 `EmailDelivery` id·provider message id와 연결합니다. enqueue 시점에 기록하면 worker가 멈추거나 provider가 실패해도 조건이 충족된 것처럼 보입니다. 배포만 하고 worker가 꺼져 있거나 첫 실행이 늦으면 의무는 충족되지 않습니다. 예정일은 **Asia/Seoul 달력 기준**으로 계산하며(`confirmedAt + 24개월`의 같은 UTC instant는 "같은 날 전까지"보다 늦을 수 있습니다), 윤일은 테스트가 아니라 결정입니다 — 2월 29일 동의자의 비윤년 기한을 법률 검토로 확정하거나, **보수적으로 하루 앞선 날짜**를 씁니다. 이 결정은 S3이 `nextConfirmationNoticeAt`을 처음 저장하기 전에 필요합니다. backfill은 활성 동의의 최신 `granted`·`reconfirmed` 기록에 **같은 계산 함수**를 씁니다 |

---

## 10. 변경 범위

### 데이터

| 대상 | 변경 |
|---|---|
| `EmailPreference.purpose` CHECK | `release_notes` 추가 |
| `EmailTemplate.purpose` CHECK | 동일 |
| `EmailDelivery.skipReason` CHECK | `permission_revoked`, `consent_withdrawn`, `release_notes_disabled` 추가 |
| `EmailCampaignRecipient` | `policyVersionId` — 어느 정책으로 판정했는지. 제외 사유 CHECK도 함께 갱신 |
| purpose 표 | `classification` 컬럼(코드 상수 + 정적 검사) |
| `SignupConsentAttempt` | 신규 테이블. 인증 절차의 일회성 상태이며 만료 행은 삭제 |

### 코드

새로: `lib/emailReleaseNotes.ts`(판정),
`lib/releaseNotesContentRules.ts`(payload·링크 규칙),
`lib/emailSignupConsentAttempt.ts`(가입 동의 시도 행과 그 상태 전이).

고침: `lib/appSettings.ts`(전용 flag reader — 값이 없거나 읽을 수 없으면 항상 `false`),
`lib/emailPreferenceCore.ts`(purpose 표에 classification),
`lib/emailPreferences.ts`(`withdrawAllMarketing` 범위),
`lib/emailTemplateDefinitions.ts`, `lib/emailFeatureFlags.ts`,
`lib/standardEmailLane.ts`(전용 flag·현재 정책 재판정),
`lib/emailAudienceExpansionCore.ts`·`lib/emailAudienceExpansion.ts`(purpose),
`lib/auth.ts`·`lib/emailLogin.ts`(intent 소비),
가입 화면, `components/email/EmailNotificationSettings.tsx`,
`locales/*.ts` 7개.

---

## 11. 구현 순서

| # | 단계 | 왜 이 순서인가 | 검증 |
|---|---|---|---|
| S0 | **상위 계약 개정과 승인.** 분류표만이 아닙니다 — 승인된 문서들이 국가를 "marketing opt-in 시점"에 확정하고 국가와 동의 기록을 같은 transaction에 남긴다고 정해 두었는데, 이 설계는 그 시점을 확인 화면으로 옮깁니다. 함께 개정·승인할 것: ① §3 분류표 ② 국가 확인 시점 ③ `confirmation_requested`의 미확정 관할권 의미 ④ grant 시점 정책과 evidence ⑤ 한국 처리결과 통지. 그리고 §8의 A·B·C 승인 | 사람. **S1·S2 전에 승인** |
| S1 | `feature.emailReleaseNotesEnabled` (기본 false) + **실제 writer**(`createStandardDeliveryRows`, `expandEmailEvent`)와 drain 검사, 전용 skip 사유 | **게이트가 물건보다 먼저.** 반대로 하면 전용 게이트 없는 템플릿이 잠시 존재합니다 | unit + 통합. flag 부재·손상 시 `false` |
| S2 | purpose 표(+classification) · DB CHECK · `withdrawAllMarketing` 범위 | 가입 화면이 켤 대상이 존재해야 합니다 | unit + enum-constraints + DB 통합 |
| S3 | `SignupConsentAttempt` + 로그인 후 finalize + 한 transaction 소비 + 확인 화면의 국가·한국 표시·처리결과 통지 + 최초 고지 예정일 | 여기서 처음으로 동의가 쌓입니다. **착수 전에 닫아야 하는 것**: 윤일 규칙(2월 29일 동의자의 비윤년 기한)을 보수적 조기 발송으로 확정, F4 증거 기준(§9) | 상태 전이표 unit + e2e(OAuth 취소·재시도·다중 탭·기존 사용자 로그인·탭 닫힘) + DB 통합. **Codex 검토** |
| S4 | 템플릿 + 구조화 payload + 링크 allowlist + 7개 언어 | 보낼 물건은 마지막에서 두 번째 | unit + locale |
| S5 | audience + **행을 쓰지 않는** `estimateReleaseNotesAudience()` + admin 표시 + 현재 정책 재판정 | 발송 전에 누가 받는지 셀 수 있어야 합니다. 기존 campaign dry-run 계약은 건드리지 않습니다 | 통합 + 미리보기가 행을 0개 쓰는지 검증. **Codex 검토** |
| S6 | 구현 기록과 새 정책 버전 초안 | 분류 개정은 S0에서 끝났으므로 여기 남는 것은 기록입니다 | 정적 검사 |

**활성화 순서는 고정입니다** — 정책 버전 활성화 → `/api/ready` 확인 →
`feature.emailReleaseNotesEnabled` 켜기. 어느 단계도 그 자체로 발송을 열지
않습니다.

---

## 12. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | 우리 freemium 구조가 ePrivacy 제13조(2)의 "판매 맥락"에 해당하는가 — 외부 자문 | F3(관할권별 완화) |
| R2 | release_notes를 marketing 스트림으로 보내는 것의 평판 영향 | 발송 도메인 |
| R3 | 싱가포르 Second Schedule para 2(2)의 "수신거부 요청을 보낼 이메일 주소"를 현재 footer가 충족하는가 | SG 발송 |
| R4 | 한국 국내대리인(제32조의5) 지정 의무가 적용되는가 | 이 설계와 무관한 현재 상태 |

---

## 13. 출처

- ePrivacy 지침 2002/58/EC 제13조 — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- CJEU C-654/23 Inteligo Media (2025-11-13) — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62023CJ0654)
- ICO, PECR 전자우편 마케팅 규칙 — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/)
- ICO, direct marketing과 service message — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-and-regulatory-communications/)
- CNIL, 전자적 수단의 고객·잠재고객 커뮤니케이션 (2026-06-10) — [cnil.fr](https://www.cnil.fr/fr/communication-electronique-quelles-regles)
- 스위스 FDPIC, 광고·마케팅 — [edoeb.admin.ch](https://www.edoeb.admin.ch/de/werbung-marketing)
- 독일 UWG 제7조 — [gesetze-im-internet.de](https://www.gesetze-im-internet.de/uwg_2004/__7.html)
- 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」 KISA-GD-2025-0037 (2025.12) — [kisa.or.kr](https://www.kisa.or.kr/401/form?postSeq=3608&lang_type=KO)
- KISA 불법스팸 대응센터, 광고성 정보 예외 — [spam.kisa.or.kr](https://spam.kisa.or.kr/spam/na/ntt/selectNttInfo.do?bbsId=1003&mi=1037&nttSn=1367)
- 호주 Spam Act 2003 — [legislation.gov.au](https://www.legislation.gov.au/C2004A01214/latest/text)
- ACMA, 스팸 발송 회피 안내 — [acma.gov.au](https://www.acma.gov.au/avoid-sending-spam)
- 싱가포르 Spam Control Act 2007 — [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/SCA2007)
- CAN-SPAM 15 U.S.C. 7702조 — [Cornell LII](https://www.law.cornell.edu/uscode/text/15/7702)
