# marketing 동의의 확인 단계 (double opt-in) — 설계안

> **상태: 초안. 승인 전.** 승인되면 `docs/policy/email-notifications.md`의 v5
> 개정으로 들어가고 §15.2의 "만들되 끄는 것" 목록에 항목이 하나 늘어납니다.
>
> - 발단: 21절 **Q1**(EU 회원국별 국내법) 조사, 2026-09-14
> - 관련 계약: §5.1 C1·C8, §10.2 `ConsentRecord`, §11.3, §6.3
> - 구현 지점: `lib/emailPreferences.ts`, `lib/emailPreferenceCore.ts`,
>   `app/api/user/email-preferences/route.ts`

---

## 1. 왜 이 문서가 생겼는가

독일 UWG §7(2)(2)는 사전 명시 동의 없는 이메일 광고를 금지하고, 독일 연방대법원은
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
1. preference center에서 marketing purpose를 켬 (+ 국가 확인, §6.3 규칙 2)
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

## 7. 이미 켜 둔 사람 — 백필이 필요 없습니다

marketing은 한 번도 발송된 적이 없지만 **preference center는 살아 있으므로 토글을
켜 둔 계정이 있을 수 있습니다.** 그 행들은 `confirmedAt`이 `NULL`이므로 §6의
gate가 자동으로 미확인 취급합니다. **별도 migration이 필요 없습니다.**

`enabled=true`인 채로 미확인이 되는 것이 어색해 보이지만, 이것이 정확한 기록입니다
— 그 사람은 실제로 켰고, 확인은 하지 않았습니다. 첫 캠페인 전에 확인 메일을 한 번
돌리면 됩니다.

먼저 수를 봅니다.

```sql
SELECT purpose,
       count(*) FILTER (WHERE enabled) AS enabled_rows
FROM "EmailPreference"
WHERE purpose IN ('product_updates','newsletter','promotions')
GROUP BY purpose ORDER BY purpose;
```

0이면 이 절은 전부 무의미해집니다 — **그리고 그것이 지금 넣는 것이 싼 이유입니다.**

## 8. 경계와 남용

| 항목 | 규칙 |
|---|---|
| 만료 | 72시간. 만료된 토큰은 "다시 보내기" 화면으로 보냅니다 |
| 재발송 | `confirmationRequestedAt` 기준 rate limit. 기존 `consumeApiRateLimit` 패턴 |
| suppression | 확인 메일도 transactional 규칙을 따릅니다 — hard bounce된 주소에는 나가지 않습니다 |
| 취소 후 재구독 | 다시 확인합니다. `confirmedAt`은 `enabled=false`로 갈 때 `NULL`로 되돌립니다 |
| 국가 미확정 | 확인 메일은 동의 *전에* 나가므로 §6.3의 "marketing 보류"에 걸리지 않습니다. transactional이기 때문입니다 |
| footer | 확인 메일은 marketing이 아니므로 관할권 footer가 없어도 발송됩니다(degraded 경고만) |

## 9. 관할권별로 켤 것인가 — 아니오

`JurisdictionProfile`에 `requiresConfirmedOptIn`을 두는 안이 자연스러워 보입니다.
**권고하지 않습니다.**

- 관할권 판정이 틀리면 **증거 표준이 틀립니다.** 관할권을 틀려도 안전한 것이 C1을
  전역으로 둔 이유였고, 같은 논리가 여기에 그대로 적용됩니다.
- 확인 메일은 동의 **전에** 나가는데, 그 시점에는 관할권이 미확정일 수 있습니다
  (§6.3이 그래서 opt-in 시점에 국가를 필수로 받습니다). 미확정 상태에서 "확인이
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
| 5 | `lib/emailPreferences.ts` | `requestConsentConfirmation()`, `confirmConsent()`. `setPreference`의 `token_cannot_enable`은 **그대로** |
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

## 12. 승인이 필요한 것

1. **Q1 회신** — 인증된 세션의 동의로 독일 기준이 충족되는가. "충족"이면 이 설계는
   폐기 가능합니다.
2. **도입 시점** — marketing 활성화 **전**을 권합니다(§1, §7).
3. **§9의 전역 적용** — 관할권별 분기를 두지 않는다는 결정.
