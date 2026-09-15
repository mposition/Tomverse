# marketing 동의의 확인 단계 (double opt-in)

> **상태: 승인됨.** 승인자 `mposition`, 승인일 2026-09-15.
> `docs/policy/email-notifications.md` v9 개정으로 들어갔고 §15.2의 "만들되 끄는
> 것" 목록에 `feature.emailConsentConfirmationEnabled`가 추가됐습니다.
>
> **구현됨, 운영 비활성 (2026-09-15).** §11의 11항목이 모두 코드에 들어갔고
> `feature.emailConsentConfirmationEnabled`는 기본 off입니다. 켜는 순서와 설계에서
> 달라진 점은 §13에 있습니다. **flag가 꺼져 있어도 규칙은 꺼지지 않습니다** —
> marketing purpose는 확인 없이 켜지지 않고, 요청 자체가 거절됩니다.
>
> - 발단: 21절 **Q1**(EU 회원국별 국내법) 조사, 2026-09-14
> - 관련 계약: docs/policy/email-notifications.md §5.1, §10.2, §11.3, §6.3
>   (C1·C8은 §5.1, `ConsentRecord`는 §10.2)
> - 구현 지점: `lib/emailConsentConfirmation.ts`, `lib/emailConsentToken.ts`,
>   `lib/emailPreferences.ts`, `lib/emailPreferenceCore.ts`,
>   `app/api/user/email-preferences/route.ts`, `app/api/consent/confirm/route.ts`

---

## 1. 왜 이 문서가 생겼는가

독일 UWG 제7조 제2항 제2호는 사전 명시 동의 없는 이메일 광고를 금지하고, 독일 연방대법원은
**동의의 입증책임을 발신자에게** 둡니다. 웹폼 등록만으로는(single opt-in)
부족하다고 보며, 실무 표준은 **확인 클릭 + 그 클릭의 로그**입니다. UWG는
부정경쟁방지법이므로 집행 주체가 규제기관만이 아닙니다 — **경쟁사와 단체가
Abmahnung(경고장 + 비용청구)** 을 보낼 수 있고, 그쪽이 더 자주 일어납니다.

**ADR에 이 항목이 없습니다.** §15.2에도 §16 Phase 2에도 double opt-in이 없고,
오늘 preference center의 토글이 곧 동의입니다.

그리고 **순서가 비용을 정합니다.** marketing을 켠 뒤에 도입하면 이미 동의한
사람 전원을 다시 받아야 하고, 그 사이 발송은 멈춥니다. 켜기 전이면 그런 사람이
아직 없습니다(§7).

## 2. 먼저 — 정말 필요한지부터

**반론을 먼저 적습니다.** double opt-in이 푸는 문제는 *주소의 소유자가 아닌
사람이 그 주소를 입력하는 것*입니다. 그런데 이 앱에서 동의는 **로그인된 세션
안에서** 수집되고, 그 주소는 이미 증명돼 있습니다 — 이메일 코드 로그인을 통과했거나
OAuth 공급자가 검증한 주소입니다. 익명 웹폼보다 강한 증거이고, `ConsentRecord`는
동의 문구 해시·`capturedVia`·정책 버전·IP/UA 해시까지 남깁니다.

그럼에도 도입을 권하는 이유 셋입니다.

1. **소유 증명이 없는 수집 경로가 이미 enum에 있습니다.** `capturedVia`의
   `import`와 `admin`이 그것입니다. 오늘 쓰이지 않는다는 것은 내일도 그렇다는
   뜻이 아닙니다.
2. **독일의 기준은 "우리가 보기에 충분한 증거"가 아니라 법원이 관행으로 받아들이는
   절차입니다.** 관행을 벗어나면 그 차이를 설명할 부담을 스스로 집니다. 상대가
   규제기관이 아니라 경쟁사일 때 그 부담은 소송 비용으로 먼저 옵니다.
3. **규칙이 하나여야 합니다.** C8이 거부한 실패 양식이 "사용자별 취득 맥락을
   저장하고 판정하는 것"인데, 확인 단계를 경로별로 켜고 끄면 **같은 판정이 증거
   표준 안으로 들어옵니다.**

**단 이것은 법률 확인 대상입니다(Q1).** "인증된 세션 + `ConsentRecord`로 충분"이라는
회신이 오면 이 설계는 폐기할 수 있고, 그 판단은 사람이 합니다. 이 문서는 **해야
한다면 어떻게 하는가**입니다.

## 3. 절대 조건

1. **확인 전에는 보내지 않습니다.** `enabled = true`는 확인 클릭 뒤에만 참이 됩니다.
2. **확인 메일에 광고를 넣지 않습니다.** 확인 메일에 홍보 문구가 섞이면 그 메일
   자체가 동의 없는 광고가 됩니다(독일 판례). 확인 메일은 확인만 합니다.
3. **확인 메일은 marketing 스트림이 아닙니다.** 분류는 `transactional`이고
   transactional 도메인·API 키로 나갑니다. marketing으로 두면 동의 없는 사람에게
   marketing이 나가고, preference gate가 자기 자신을 막습니다.
4. **`GET`은 상태를 바꾸지 않습니다.** 링크는 확인 화면을 띄우고, 바꾸는 것은
   사용자가 누르는 `POST`입니다. §11.3이 수신거부에 대해 정한 규칙과 같은 이유이며,
   여기서는 더 중요합니다 — 메일 스캐너의 링크 프리페치가 **동의를 만들어 낼** 수
   있기 때문입니다.
5. **확인되지 않은 동의는 동의가 아닙니다.** 발송 gate가 `enabled`만이 아니라
   `confirmedAt`을 함께 보고, `NULL`은 fail-closed입니다.
6. **토큰이 동의를 켤 수 있는 유일한 경로는 이 경로뿐입니다** — §4.3.

## 4. 데이터 모델

### 4.1 `EmailPreference`에 두 칸

```prisma
/// 확인 클릭 시각. 이것이 "동의했다"의 유일한 판정 근거입니다.
/// NULL이면 미확인이고, 발송 gate는 NULL을 거부합니다.
confirmedAt DateTime?

/// 마지막 확인 메일 발송 시각. 재발송 rate limit과 만료 계산의 기준.
confirmationRequestedAt DateTime?
```

상태는 세 가지이고 전부 이 두 칸에서 파생됩니다. **저장하지 않습니다.**

| 상태 | `enabled` | `confirmationRequestedAt` | `confirmedAt` |
|---|---|---|---|
| 꺼짐 | false | NULL | NULL |
| **확인 대기** | **false** | 있음 | NULL |
| 켜짐 | true | 있음 | 있음 |

`enabled`를 확인 전에 `true`로 두지 않는 것이 핵심입니다. 그렇게 하면 발송 gate를
고치는 것을 잊은 어떤 경로든 곧바로 미확인 주소로 발송합니다.

### 4.2 토큰은 무상태입니다

> **`lib/emailConsentToken.ts`가 이 형식을 구현합니다(2026-09-15).**
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES` 등록은 지웠고,
> 검사가 다시 이 경로를 감시합니다.

`lib/unsubscribeToken.ts`와 같은 형태 — `c1.<version>.<iv>.<ct>.<tag>`, AES-GCM,
버전 있는 키링. pending 행을 따로 두면 만료 정리 cron이 하나 더 생기고, 그 cron이
멈추면 만료가 조용히 늘어납니다.

payload: `{ kind: "consent", userId, purpose, requestedAt, policyVersionId }`.
**주소는 넣지 않습니다** — 토큰은 링크에 실려 나가고, 주소는 서버가 `userId`로
읽습니다.

### 4.3 키링은 따로 씁니다 — 그리고 그 이유가 설계를 정합니다

`EMAIL_CONSENT_KEYS` / `EMAIL_CONSENT_KEY_VERSION`. 형식과 생성법은
`docs/ops/email-snapshot-keyring.md` §1~2와 같습니다.

수신거부 키링을 재사용하지 않는 이유는 절약의 문제가 아닙니다. **오늘 저장소에는
"토큰은 preference를 켤 수 없다"는 계약이 있습니다** —
`preferenceChangeDecision()`이 `viaToken && enabled`를 `token_cannot_enable`로
거부합니다. 수신거부 링크가 구독을 켤 수 있으면 유출된 링크 하나가 동의를
만들어 내기 때문입니다.

확인 클릭은 정의상 preference를 켭니다. 그러니 **그 규칙을 완화하는 것이 아니라,
규칙이 닿지 않는 별도 경로를 만듭니다.**

- `setPreference({ viaToken: true, enabled: true })`는 **계속 거부됩니다.**
- 확인은 `confirmConsent(token)`이라는 **다른 함수**가 처리하고, 그 함수만이
  consent 키링으로 서명된 `kind: "consent"` 토큰을 받습니다.
- 두 키링이 다르므로 수신거부 토큰을 확인 토큰으로 재생할 수 없고, 그 반대도
  안 됩니다.

### 4.4 새 `ConsentAction` 하나

`confirmation_requested`를 추가합니다. `granted`로 적으면 **확인 메일을 보낸
사실이 동의로 기록되고**, 그것이 이 설계가 막으려는 바로 그 일입니다.

`lib/emailPreferenceCore.ts`의 `ConsentAction`, Prisma의 주석,
`scripts/check-enum-constraints.mjs`의 목록을 **함께** 고칩니다 — 검사가 어긋남을
잡습니다.

## 5. 흐름

```
1. preference center에서 marketing purpose를 켬
   (+ 국가 확인, docs/policy/email-notifications.md §6.3 규칙 2)
      ↓  enabled 는 false 그대로
2. confirmationRequestedAt = now
   ConsentRecord(action="confirmation_requested", capturedVia="preference_center")
      ↓  같은 트랜잭션
3. 확인 메일 enqueue — standard lane, classification=transactional,
   template=marketing_consent_confirmation, 광고 없음, 링크 유효 72시간
      ↓
4. GET /consent/confirm?t=...  →  확인 화면(버튼 하나). 상태 변화 없음
      ↓  사용자가 누름
5. POST → 토큰 복호화·kind·만료·purpose·userId 검증
   트랜잭션: enabled=true, confirmedAt=now, grantedAt=now
             ConsentRecord(action="granted",
                           evidence={ tokenVersion, requestedAt, confirmedVia:"link" },
                           ipHash, userAgentHash)
      ↓
6. 이후 발송 gate: enabled && confirmedAt != null
```

2번과 3번이 **한 트랜잭션**인 것은 §9.1의 enqueue 규칙 그대로입니다. 쪼개면
"요청됨인데 메일은 안 나간" 계정이 생기고, 그 사람은 영원히 확인 대기입니다.

확인 화면은 **로그인을 요구하지 않습니다.** 수신거부와 같은 이유로 — 메일을 연
기기와 로그인한 기기가 다를 수 있고, 로그인을 요구하면 확인율이 떨어집니다.
토큰이 `userId`를 들고 있으므로 소유권은 서버가 정합니다.

## 6. 발송 gate

판정은 `consentGateVerdict()`(`lib/emailPreferenceCore.ts`) 한 곳에 있고, 오늘
`storedEnabled: boolean | null` 하나만 봅니다. 입력에 칸을 하나 더 줍니다.

```ts
/** 확인 클릭 시각. 동의가 필요한 purpose에서 null 이면 미확인입니다. */
storedConfirmedAt: Date | null;
```

그리고 **행이 없을 때와 같은 방향으로 fail-closed** 합니다 — 동의가 필요한
purpose가 `storedEnabled === true`이면서 `storedConfirmedAt === null`이면 `REFUSED`.
EM-02가 "행 부재를 동의로 읽던" 결함을 고친 것과 같은 규칙이고, 여기서는 "확인
부재를 동의로 읽는" 쪽입니다.

판정이 한 함수에 있으므로 **호출부는 값을 넘겨주기만 하면 됩니다.** 이 한 곳이
§7의 기존 행 처리까지 같이 해결합니다.

## 7. 이미 켜 둔 사람 — **0명입니다 (2026-09-15 실측)**

> **이 절은 측정으로 닫혔습니다.** `GET /api/admin/marketing-reach`를
> production에서 읽은 결과, 계정 78개에서 세 marketing purpose 모두
> `enabled` **0**, `unprovable` **0**입니다(2026-09-15 03:15Z,
> `docs/ops/q2-marketing-reach-decision.md` §2.1).
>
> **확인 메일을 돌려야 할 사람이 한 명도 없습니다.** 아래는 그 수가 0이 아니었을
> 때 무엇을 해야 했는지의 기록이며, 지금은 적용 대상이 없습니다 — 그리고 그것이
> **지금 도입하는 것이 싼 이유**입니다.

marketing은 한 번도 발송된 적이 없지만 preference center는 살아 있으므로 토글을
켜 둔 계정이 있을 수 있었습니다. 그런 행은 `confirmedAt`이 `NULL`이므로 §6의
gate가 자동으로 미확인 취급합니다. **어느 쪽이든 별도 migration은 필요
없습니다.**

`enabled=true`인 채로 미확인이 되는 것이 어색해 보이지만, 이것이 정확한 기록입니다
— 그 사람은 실제로 켰고, 확인은 하지 않았습니다.

**그리고 그 사람들에게 확인 메일을 돌려서는 안 됩니다**(2026-09-14 정정,
`docs/policy/email-eea-marketing-review-2026-09-14.md` §7 조건 3). 호주 ACMA는
동의가 없는 상대에게 보내는 **동의 요청 메일 자체를 상업 전자 메시지로** 취급해
왔고, 독일에서도 요청하지 않은 사람에게 간 확인 메일이 무단 광고로 판단된 사례가
있습니다. "확인 메일이니 괜찮다"는 성립하지 않습니다.

**대신 제품 안에서 다시 받습니다** — 로그인한 사용자에게 설정 화면이나 배너로
확인을 요청하고, 확인 메일은 그 사람이 그 자리에서 요청했을 때만 나갑니다. §5의
흐름이 그대로 쓰이며, 다른 것은 시작점이 사용자의 행동이라는 점뿐입니다. **이
규칙은 대상이 0이어도 유지됩니다** — 미확인 상태는 앞으로도 생기고(요청했지만
확인하지 않은 사람), 그때 같은 금지가 적용됩니다.

수를 다시 보려면 실행합니다. 관리자로 로그인한 브라우저에서 여는 것으로 끝나며,
출력은 개수뿐입니다.

```
https://tomverse.app/api/admin/marketing-reach
```

`enabled`가 0이 아니게 된 뒤에 이 설계를 도입했다면, 그 전원이 위 제품 내 재동의
경로를 거쳐야 했습니다. 0일 때 넣는 비용이 그래서 다릅니다.

## 8. 경계와 남용

| 항목 | 규칙 |
|---|---|
| 만료 | 72시간. 만료된 토큰은 "다시 보내기" 화면으로 보냅니다 |
| 재발송 | `confirmationRequestedAt` 기준 rate limit. 기존 `consumeApiRateLimit` 패턴 |
| suppression | 확인 메일도 transactional 규칙을 따릅니다 — hard bounce된 주소에는 나가지 않습니다 |
| 취소 후 재구독 | 다시 확인합니다. `confirmedAt`은 `enabled=false`로 갈 때 `NULL`로 되돌립니다 |
| 국가 미확정 | 확인 메일은 동의 *전에* 나가므로 docs/policy/email-notifications.md §6.3의 "marketing 보류"에 걸리지 않습니다. transactional이기 때문입니다 |
| footer | 확인 메일은 marketing이 아니므로 관할권 footer가 없어도 발송됩니다(degraded 경고만) |

## 9. 관할권별로 켤 것인가 — 아니오

`JurisdictionProfile`에 `requiresConfirmedOptIn`을 두는 안이 자연스러워 보입니다.
**권고하지 않습니다.**

- 관할권 판정이 틀리면 **증거 표준이 틀립니다.** 관할권을 틀려도 안전한 것이 C1을
  전역으로 둔 이유였고, 같은 논리가 여기에 그대로 적용됩니다.
- 확인 메일은 동의 **전에** 나가는데, 그 시점에는 관할권이 미확정일 수 있습니다
  (docs/policy/email-notifications.md §6.3이 그래서 opt-in 시점에 국가를 필수로
  받습니다). 미확정 상태에서 "확인이
  필요한 나라인가"를 물으면 답이 없습니다.

**전역 적용.** 규칙이 하나입니다.

## 10. 범위 밖

- **E7 24개월 확인 고지**(`feature.emailConsentReconfirmEnabled`)와 다릅니다.
  그쪽은 이미 동의한 사람에게 *알리는* 의무이고, 이쪽은 동의를 *성립*시키는
  절차입니다. 두 개를 한 flag로 묶지 않습니다.
- **A14 자동 opt-out**과 무관합니다.
- 가입 플로우의 동의 수집(Phase 2)은 이 설계를 그대로 씁니다 — `capturedVia`만
  `signup_form`으로 바뀝니다.

## 11. 구현 체크리스트

| # | 대상 | 내용 |
|---|---|---|
| 1 | `prisma/schema.prisma` | `EmailPreference.confirmedAt`·`confirmationRequestedAt`, `ConsentAction` 주석 |
| 2 | `lib/emailPreferenceCore.ts` | `ConsentAction`에 `confirmation_requested` |
| 3 | `scripts/check-enum-constraints.mjs` | 같은 값 등록 |
| 4 | `lib/emailConsentToken.ts` (신규) | `c1.` 토큰, `EMAIL_CONSENT_KEYS` 키링 |
| 5 | `lib/emailPreferences.ts` | `requestConsentConfirmation()`, `confirmConsent()`. `setPreference`의 `token_cannot_enable`은 **그대로** (구현은 `lib/emailConsentConfirmation.ts` — §13.1 #1) |
| 6 | `lib/emailTemplateDefinitions.ts` | `marketing_consent_confirmation`, classification `transactional`, senderRole `general`, 7개 언어 |
| 7 | `app/api/user/email-preferences/route.ts` | marketing purpose 켜기 → 확인 요청으로 분기 |
| 8 | `app/(site)/(marketing)/consent/confirm` + `app/api/consent/confirm` | GET 화면 / POST 적용 |
| 9 | `lib/emailPreferenceCore.ts` | `ConsentGateInput`에 `storedConfirmedAt`, `consentGateVerdict()`가 fail-closed. 호출부는 값만 전달 |
| 10 | `/api/ready` | `MARKETING_EMAIL_FROM`이 있으면 `EMAIL_CONSENT_KEYS` 필수 (`emailUnsubscribeReadiness`와 같은 조건부) |
| 11 | preference center UI | "확인 대기" 상태와 "다시 보내기" |

### 테스트

- `GET`이 상태를 바꾸지 않는다 (스캐너 프리페치 회귀)
- 확인 전 발송 gate가 거부한다 — `enabled=true, confirmedAt=NULL`
- 수신거부 토큰으로 확인이 되지 않는다, 그 반대도 안 된다
- `setPreference({viaToken:true, enabled:true})`는 **여전히** 거부된다
- 만료 토큰, 재사용 토큰, 다른 사용자의 토큰
- 확인 메일 본문에 홍보 문구·CTA가 없다 (문자열 검사)
- 확인 메일이 marketing 스트림으로 나가지 않는다
- 요청 → 메일 → 확인의 한 트랜잭션 경계 (DB 통합 테스트)

## 12. 승인된 것과 남은 것

**승인 (2026-09-15, `mposition`).** 아래 둘이 결정됐습니다.

| | 결정 |
|---|---|
| **도입 시점** | marketing 활성화 **전**. §1과 §7의 근거대로이며, 실측(`enabled` 0)이 그 비용을 확정했습니다 |
| **§9의 전역 적용** | 관할권별 분기를 두지 않습니다 |

**승인된 것은 설계였고, 구현은 2026-09-15에 들어갔습니다(§13).** flag 활성화는
별도의 운영 행위입니다.

**남은 사실 하나.** §12 v1은 **Q1 회신**을 승인 조건으로 두면서, 인증된 세션의
동의로 독일 기준이 충족된다면 이 설계가 폐기 가능하다고 적었습니다. 그 사실은
여전히 열려 있지만 **이 승인을 막지 않습니다** — 승인은 "충족되더라도 넣는다"는
쪽을 고른 것이고, §2가 그 이유 셋을 이미 적고 있습니다(소유 증명이 없는 수집
경로가 enum에 존재, 독일의 기준은 관행이지 자기 평가가 아님, 규칙은 하나여야
함). Q1이 "충족"으로 회신되면 그때 폐기가 아니라 **재검토**의 근거가 됩니다.

## 13. 구현 기록 (2026-09-15)

§11의 11항목이 들어갔고, §11 테스트 목록에 더해 동시 클릭·정책 전환·flag off 후 링크·enqueue 실패 rollback·링크 미저장을 DB 통합 테스트로 고정했습니다. 아래는 **설계와 달라진 점**과
그 이유, 그리고 켜는 순서입니다.

### 13.1 설계에서 달라진 점

| # | 설계 | 구현 | 이유 |
|---|---|---|---|
| 1 | `requestConsentConfirmation()`·`confirmConsent()`를 `lib/emailPreferences.ts`에 | **`lib/emailConsentConfirmation.ts`** (신규) | 요청은 메일을 enqueue하므로 standard lane 전체를 끌어옵니다. `lib/emailPreferences.ts`를 import하는 수신거부 route가 발송기에 의존하지 않도록 분리했습니다 |
| 2 | payload에 주소를 넣지 않음 | 주소는 넣지 않되 **주소 digest**를 넣음 (`consentAddressDigest()`) | 토큰은 암호화되어 digest가 보이지 않습니다. 메일 발송 뒤 계정 주소가 바뀌면 그 클릭은 새 주소의 소유를 증명하지 못하므로 `address_changed`로 거부합니다 |
| 3 | 재사용 토큰 거부 | 요청마다 무작위 **`confirmationRequestId`** 를 저장하고, 토큰이 그 id를 이름 댈 때만 확인. 요청·확인·취소·철회가 모두 **같은 행 잠금**(`SELECT … FOR UPDATE`) 아래에서 읽고 씁니다 | 새 요청이 옛 링크를, 대기 중 취소가 대기 링크를 무효화합니다. timestamp 비교는 같은 밀리초의 두 요청을 둘 다 최신으로 만들고, 잠금 없는 조건부 update는 동시 두 번 클릭에 grant를 두 번 남겼습니다(독립 검토 2026-09-15) |
| 4 | flag의 의미 미정 | **off는 "동의를 아직 받을 수 없음"** | off일 때 marketing 켜기는 `CONFIRMATION_UNAVAILABLE`(409)로 거절되고 single opt-in으로 저장되지 않습니다. §3 규칙 1이 flag와 무관하게 유지됩니다 |
| 5 | 상태 셋(꺼짐·대기·켜짐) | 넷째 **`unconfirmed`** 추가 (`consentConfirmationState()`) | 이 단계 이전에 켜진 행(`enabled=true`, `confirmedAt=NULL`)을 있는 그대로 표시합니다. gate는 거부하고, 화면은 "확인 메일 보내기"를 제공합니다(§7의 제품 내 재동의) |
| 6 | 확인 시점 검사 미정 | 확인 시점에 **관할권을 다시 읽음** | 요청 뒤 결제 국가가 바뀌어 allowlist 밖이 되었거나 충돌하면, 쓸 수 없는 동의를 만들지 않습니다(`country_not_allowed`) |
| 7 | `setPreference` 계약 | 동의 기반 purpose를 켜는 모든 호출은 `confirmation` 증거가 없으면 **`confirmation_required`** | preference centre를 포함한 어떤 경로도 확인을 건너뛸 수 없습니다. 수신거부 토큰의 `token_cannot_enable`은 먼저 검사되고 그대로입니다 |
| 8 | 캠페인 대상 | `marketing_consent` cohort와 대상 추정이 **`confirmedAt IS NOT NULL`** 을 함께 요구 | lane이 어차피 거부할 사람을 원장에 수신자로 올리지 않습니다 |
| 9 | 확인 링크 저장 방식 미정 | **링크를 저장하지 않음.** delivery snapshot에는 요청의 비밀 아닌 필드만 두고, 토큰은 발송 시점에 `prepareForSend`가 만듭니다. 토큰 암호화는 **결정적**(IV = 평문의 HMAC)이라 재시도가 같은 바이트를 냅니다. 감사 hash와 제목은 토큰을 placeholder로 바꾼 뒤 기록합니다 | 링크는 72시간짜리 capability이고, 90일 snapshot에 두면 docs/policy/email-notifications.md §10.3의 자격증명 미저장 규칙에 어긋납니다 |
| 10 | 링크 형식 `?t=` | **`#t=` (URL fragment)**. 확인 페이지가 읽은 뒤 주소창에서 지웁니다 | fragment는 서버·프록시·access log·Sentry·Referer 어디에도 가지 않습니다. 페이지는 동적인 (application) 그룹에 있습니다 — 정적 marketing layout 아래서는 production CSP nonce가 없어 hydration되지 않습니다 |
| 11 | 동의 증거의 정책 버전 | 토큰에 고정된 **요청 시점의 `policyVersionId`** 를 grant 기록에 씀 | 요청과 클릭 사이에 정책이 바뀌어도, 사람이 본 정책에 동의했다고 남습니다 |
| 12 | flag와 이미 발송된 링크 | flag가 off면 **확인도 거부**(`disabled`) | "off는 동의를 받지 않음"이 발송된 링크에도 같게 적용됩니다. 72시간 안에 다시 켜면 링크가 다시 동작합니다 |
| 13 | IP 증거 | 두 route 모두 신뢰할 수 있는 edge IP만 hash해 기록, `unknown`은 NULL | 설계 §5가 열거한 `ipHash` 증거 |
| 14 | 대기 취소 UI | 대기 중인 행에 **"요청 취소"** 버튼 | 대기 행의 스위치는 꺼져 있어 누르면 새 확인을 요청하므로, 발송된 링크를 무효화할 별도 수단이 필요합니다 |
| 15 | 잠금 순서와 주소 | 요청·확인·철회는 **User 행 → EmailPreference 행** 순서로 잠그고, 주소는 잠근 User 행에서 읽어 digest를 대조·기록합니다. purpose suppression 기록·삭제도 같은 트랜잭션입니다 | 확인과 주소 변경, 확인과 수신거부가 교차해도 다른 주소의 동의나 사라진 suppression이 남지 않습니다 |
| 16 | 요청 트랜잭션 | template·정책 버전은 트랜잭션 **전에** 준비하고, 트랜잭션 안에서는 delivery 행만 씁니다(`createStandardDeliveryRows`) | 잠금을 쥔 채 전역 연결을 추가로 잡으면 동시 요청이 connection pool을 고갈시킬 수 있습니다 |
| 17 | 키 회전 | 요청 snapshot에 **`tokenKeyVersion`** 을 고정해 재시도가 같은 키로 같은 토큰을 만듭니다. 그 버전은 큐의 최장 재시도 기간 + 72시간보다 오래 `EMAIL_CONSENT_KEYS`에 남겨야 합니다. IV 파생 키는 암호 키와 분리했습니다 | 회전 사이의 재시도가 다른 본문을 같은 idempotency key로 보내지 않습니다 |
| 18 | analytics 동의 고지 | 확인 페이지에도 사이트 공통 analytics 동의 고지가 뜰 수 있습니다 | 광고가 아니라 개인정보 고지이며, 이 페이지에서만 숨기는 것은 별도의 개인정보 결정입니다 |

### 13.2 켜는 순서 (운영)

1. **`EMAIL_CONSENT_KEYS`를 staging·production에 먼저 설정합니다.** 형식과 생성은
   `docs/ops/email-snapshot-keyring.md` §1~2와 같고 변수 이름만 다릅니다.
   `MARKETING_EMAIL_FROM`이 이미 설정된 환경에서는 이 키가 없으면 **이 코드가 배포되는
   순간 `/api/ready`가 실패합니다**(§11 항목 10). 그래서 키가 코드보다 먼저입니다.
2. 코드 배포.
3. `AppSetting`의 `feature.emailConsentConfirmationEnabled`를 `"true"`로 씁니다. 이때부터
   설정 화면에서 marketing을 켜면 확인 메일이 나갑니다(transactional, `mail.` 도메인).
4. `feature.emailMarketingEnabled`는 그 **뒤**이며 docs/policy/email-notifications.md
   §15.2의 조건을 따릅니다.
