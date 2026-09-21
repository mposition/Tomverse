# Q12 — 개인정보처리방침의 이메일 처리 고지 (초안)

계약: `docs/policy/email-notifications.md` §21 Q6·Q11·Q12, §10.2, §13.2, §13.3.
대상 파일: `components/legal/PrivacyPolicy.tsx`, `locales/{en,ko,zh,de,es,fr,pt}.ts`.

> **승인되어 반영됐습니다 (2026-09-14).** 승인자 `mposition`, 효력일 2026-09-14.
> `components/legal/PrivacyPolicy.tsx`에 section이 추가됐고, 7개 locale 전부에
> 문구가 들어갔으며, `retention` 문구의 예외 구절과 방침 시행일도 함께 옮겼습니다.
> **이 문서는 그 결정의 근거 기록으로 남습니다** — 특히 §5(일부러 쓰지 않은 셋)는
> 아직 유효하고, Q6·Q11·Q1이 풀릴 때 다시 읽을 목록입니다.

이 문서는 반영 전 초안으로 쓰였습니다. 방침 개정은 효력일이 바뀌는 대외 문서이므로
승인 뒤에 옮긴다는 것이 그 전제였고, 실제로 그렇게 했습니다.

---

## 1. 지금 고지되지 않은 것

`components/legal/PrivacyPolicy.tsx`의 14개 section에 이메일이 **한 번도 나오지
않습니다.** 확인은 파일 전체 grep이고, `providers`·`retention`·`rights` 어디에도
없습니다.

**이것은 marketing만의 문제가 아닙니다.** 아래는 지금 이 순간 일어나고 있는
처리이고, marketing flag와 무관합니다.

| 처리 | 어디에 | 근거 |
|---|---|---|
| 수신 설정 6종의 on/off, 켠 시점, 켠 경로 | `EmailPreference` | `prisma/schema.prisma` |
| 동의·철회 이력(append-only), 관할권과 그 판정 근거, 정책 버전, 화면 식별자, 문구 해시 | `ConsentRecord` | 같음 |
| **IP·User-Agent의 salted hash** (원본 아님) | `ConsentRecord.ipHash`·`userAgentHash` | `lib/emailPreferences.ts` |
| 발송 시점의 주소·언어·관할권·템플릿 버전·전달 상태 | `EmailDelivery` | `prisma/schema.prisma` |
| **계정 삭제 후에도 남는 수신거부 기록** | `SuppressionCause`(주소 기준) | ADR §13.2 |
| 발송 대행자에게 주소와 본문 전달 | Resend | Q11 검토 기록 |

마지막 두 줄이 특히 그렇습니다. **계정을 지워도 남는 데이터가 있다는 것**은
지금 고지되어야 하는 사실이고, `retention` section은 "standard chats … 계정
데이터 삭제 시 제거"라고만 적어 그 반대를 암시합니다.

## 2. Q11이 같은 곳을 고칩니다

Q11의 남은 조치에 "subprocessor·미국 저장·보관기간의 개인정보처리방침 반영"이
있습니다(ADR §21 Q11). Q12와 **같은 section**에 들어가므로 한 번에 씁니다 —
따로 쓰면 같은 문단을 두 번 고치고 효력일이 두 번 바뀝니다.

## 3. 제안 문구

### 3.1 English (`locales/en.ts`)

```
emailTitle: "Email we send you",
email: "Tomverse sends you email at the address on your account: sign-in
codes and security notices, billing receipts, service status notices, and --
only if you ask for them -- product updates, newsletters and promotions. The
first three are part of providing the service and cannot be switched off; the
last three are sent only after you turn them on, and you can turn them off at
any time in your email settings or with the one-click unsubscribe link in any
such message, without signing in. To do this, Tomverse stores which settings
you have chosen and when, an append-only record of each time you turned one on
or off -- including which wording you were shown and which country's rules
applied -- and a record of each message sent to you, holding the address,
language and delivery outcome. The record of a consent keeps a one-way,
salted hash of the IP address and browser identifier at that moment rather
than the values themselves. Messages are delivered by Resend, and open and
click tracking is switched off for both of the sending domains Tomverse uses.
If you unsubscribe, or a message to you is rejected as undeliverable, that
address is recorded as suppressed and stays suppressed after your account is
deleted -- the record exists so that deleting an account cannot start the
mail again, and it holds the address and the reason and nothing else.",
```

### 3.2 한국어 (`locales/ko.ts`)

```
emailTitle: "보내 드리는 이메일",
email: "Tomverse는 계정에 등록된 주소로 로그인 코드와 보안 알림, 결제 영수증,
서비스 상태 안내를 보내고, 신청하신 경우에만 제품 소식·뉴스레터·프로모션을
보냅니다. 앞의 셋은 서비스 제공에 속해 끌 수 없으며, 뒤의 셋은 켜신 뒤에만
발송되고 이메일 설정에서 또는 해당 메일의 수신거부 링크를 눌러 로그인 없이
언제든 끄실 수 있습니다. 이를 위해 어떤 설정을 언제 선택하셨는지, 켜고 끄신
내역(보신 문구와 적용된 국가 규칙을 포함하며 덮어쓰지 않고 쌓입니다), 그리고
보내 드린 각 메일의 주소·언어·전달 결과를 보관합니다. 동의 기록에는 그 시점의
IP 주소와 브라우저 식별자를 값 그대로가 아니라 되돌릴 수 없는 salted hash로
저장합니다. 발송은 Resend가 대행하며, Tomverse가 쓰는 두 발송 도메인 모두
열람·클릭 추적이 꺼져 있습니다. 수신을 거부하시거나 보낸 메일이 수신 불가로
반송되면 그 주소는 발송 제외로 기록되고, 이 기록은 **계정을 삭제하신 뒤에도
남습니다** — 계정 삭제가 발송을 다시 시작시키지 않게 하기 위한 것이며, 주소와
사유 외에는 담지 않습니다.",
```

### 3.3 나머지 다섯 locale

**반영 완료 (2026-09-14).** `zh`·`de`·`es`·`fr`·`pt`에도 같은 두 key가
들어갔습니다 — `tests/localeParity.test.mjs`가 누락을 실패로 만듭니다. 승인된
문구가 확정된 뒤에 번역한다는 원래 계획대로 했습니다.

## 4. 문장별로 무엇에 달려 있는가

| 문장 | 의존 | 지금 쓸 수 있는가 |
|---|---|---|
| 발송하는 메일의 종류와 끌 수 있는 것/없는 것 | `LOCKED_EMAIL_PURPOSES`, `CONSENT_REQUIRED_PURPOSES` | **예.** 코드가 이미 그렇습니다 |
| "신청하신 경우에만" (동의 기반) | **Q2** | 현재 구현 기준으로는 예. Q2가 B·C로 결정되면 이 문장이 바뀝니다 |
| 로그인 없이 한 번에 수신거부 | RFC 8058 구현, ADR §11.3 | 예 |
| 보관하는 항목 | schema | 예 |
| IP·UA를 hash로만 보관 | `lib/emailPreferences.ts` | 예 |
| Resend 대행, 추적 꺼짐 | **Q11** 검토 기록(화면 확인 완료) | 예 |
| 수신 국가·저장 위치 | **Q11** 잔여(미국 저장, subprocessor) | **아니오** — 아래 5절 |
| 계정 삭제 후 suppression 잔존 | **Q6**(적법성·보관기간 미확정) | 사실 고지는 예. **기간은 아니오** |

## 5. 일부러 쓰지 않은 것

- **보관 기간을 숫자로 쓰지 않았습니다.** Q6이 `ConsentRecord`·`SuppressionCause`
  의 보관기간을 아직 정하지 않았습니다. 숫자를 지어 쓰면 지키지 못할 약속이
  되고, 방침이 지키지 못할 약속을 적는 것은 고지가 아니라 그 반대입니다.
- **국가 이름과 subprocessor 목록을 쓰지 않았습니다.** Q11의 잔여 항목이며,
  음성 입력 section이 OpenAI에 대해 한 것처럼 **여덟 항목을 열거해야** 합니다
  (PIPA 제28조의8제2항). 그 여덟을 채울 사실이 아직 모이지 않았습니다.
- **marketing의 법적 근거를 관할권별로 쓰지 않았습니다.** Q1의 §7 선행조건이
  남아 있고, EEA·스위스 profile이 확정되기 전에 방침이 근거를 선언하면 방침이
  코드보다 앞서게 됩니다.

## 6. 승인 뒤에 한 것

1. `components/legal/PrivacyPolicy.tsx`의 `sections`에 `["emailTitle", "email", Mail]`
   한 줄 추가. 위치는 `analytics` 앞 — 수신 설정은 처리 목적이지 분석이 아닙니다.
2. 7개 locale에 key 두 개씩. 번역은 기존 section들과 같은 존댓말·문장 길이를
   따릅니다.
3. `retention` section의 "계정 데이터 삭제 시 제거"에 예외 한 구절 추가 —
   지금은 반대를 암시합니다.
4. `effective` 날짜를 **2026-09-14**로 갱신(7개 언어). 이 날짜는 제가 정하지
   않았습니다 — 승인자가 지정한 효력일입니다.
5. `npm run test:unit`(locale parity 포함)과 `npm run check:encoding`.

## 7. 기록하는 곳

| 위치 | 고칠 것 |
|---|---|
| `docs/policy/email-notifications.md` §21 Q12 행 | 해소 표시, 반영일, 반영된 section 이름 |
| 같은 문서 §21 Q11 행 | `/privacy` 반영 항목 중 끝난 것 표시 |
| 같은 문서 §15.2 flag 행 | 활성화 조건에서 Q12 제거 |
| 같은 문서 개정 이력 | 새 버전 항목 |
