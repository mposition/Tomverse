# 방침·약관 개정 초안 (S10) — 승인 대기

**상태: 초안.** 이 문서의 문안은 소유자 승인 전입니다. 승인되면 페이지에 게시하고,
게시된 버전의 digest를 `APPROVED_AMENDED_DIGESTS`에, 변경 고지의 template
version `contentHash`를 `CHANGE_NOTICE_APPROVED_CONTENT_HASHES`에 적습니다
(`lib/emailPolicyPublication.ts`). 그 두 목록이 비어 있는 동안 release notes
게이트는 닫혀 있습니다.

근거: [제품 소식 재설계](email-product-news-redesign-draft.md) §10·§12(S10),
[동의 문안](email-consent-copy-draft.md) §5·§6(승인됨, 2026-09-23)·§9.1(결정 B).

## 1. 무엇을 고치는가

현행 `/privacy`는 **"신청하신 경우에만 제품 소식·뉴스레터·프로모션을 보냅니다"**
라고 약속합니다. 이미 승인된 두 결정이 이 약속과 어긋납니다.

- **결정 F**(2026-09-16): 기존 계정에 `risk_accepted`로, 동의 없이 제품 소식을
  보냅니다(재설계 §5.6).
- **호주 추론 동의**(재설계 §4.4, R4 결정 2026-09-29): 호주에서 계정을 이용 중인
  분에게는 사전 동의 없이 보낼 수 있습니다.

승인된 §6의 두 문장은 그 약속을 그대로 둡니다. 그래서 이 초안은 약속 문장
자체를 고칩니다. 뉴스레터와 프로모션은 지금처럼 **신청한 경우에만**이고, 바뀌는
것은 **제품 소식**뿐입니다.

## 2. `/privacy` — 이메일 조항 첫 두 문장의 대체안

**현행 (ko)**

> Tomverse는 계정에 등록된 주소로 로그인 코드와 보안 알림, 결제 영수증, 서비스
> 상태 안내를 보내고, 신청하신 경우에만 제품 소식·뉴스레터·프로모션을 보냅니다.
> 앞의 셋은 서비스 제공에 속해 끌 수 없으며, 뒤의 셋은 켜신 뒤에만 발송되고
> 이메일 설정에서 또는 해당 메일의 수신거부 링크를 눌러 로그인 없이 언제든 끄실
> 수 있습니다.

**개정안 (ko)**

> Tomverse는 계정에 등록된 주소로 로그인 코드와 보안 알림, 결제 영수증, 서비스
> 상태 안내를 보냅니다. 이 셋은 서비스 제공에 속해 끌 수 없습니다. 뉴스레터와
> 프로모션은 신청하신 경우에만 보냅니다. 이용 중인 기능에 관한 제품 소식은
> 신청하신 경우에 보내며, 신청하지 않으셨더라도 거주지 법이 사전 동의 없이
> 허용하는 경우 — 호주에서 계정을 이용 중이신 경우와, 이 개정 전에 만드신 계정 —
> 에는 보내 드릴 수 있습니다. 로그인 코드·영수증·서비스 안내가 아닌 메일은 모두
> 이메일 설정에서 또는 해당 메일의 수신거부 링크를 눌러 로그인 없이 언제든 끄실
> 수 있습니다.

**개정안 (en)**

> Tomverse sends you email at the address on your account: sign-in codes and
> security notices, billing receipts and service status notices. These three
> are part of providing the service and cannot be switched off. Newsletters and
> promotions are sent only if you ask for them. Product updates about features
> you use are sent if you ask for them, and may also be sent without your asking
> where the law where you live allows it -- if you use your account in
> Australia, and for accounts created before this change. Everything other than
> sign-in codes, receipts and service notices can be turned off at any time in
> your email settings or with the one-click unsubscribe link in any such
> message, without signing in.

이어서 승인된 §6의 두 문장(동의는 철회 시까지 유효, 한국 2년 고지)을 붙입니다.
나머지 문장은 그대로 둡니다. 다른 다섯 언어는 게시 때 같은 뜻으로 옮기며, 그
번역도 이 절의 승인 대상입니다.

**쓰지 않은 것**: `risk_accepted`라는 말. 독자에게 의미가 없는 내부 이름입니다.
"이 개정 전에 만드신 계정"이 그 범위를 독자의 말로 적은 것입니다.

## 3. `/terms` — 추가 조항

[동의 문안](email-consent-copy-draft.md) §5의 조항을 그대로 씁니다(승인됨,
2026-09-23). `/terms`는 en·ko·zh 세 언어이고, zh는 게시 때 같은 뜻으로 옮깁니다.
게시하면 "최종 업데이트" 날짜가 시행일로 바뀝니다.

## 4. 변경 고지 — `policy_change_notice`

`legal` 분류, purpose 없음, 수신거부 링크 없음. 수신거부한 분에게도 갑니다
([이메일 알림](email-notifications.md) §3.1의 5번 유형). 문안은
`lib/policyChangeNoticeEmail.ts`에 7개 언어로 있습니다. 영어 본문은 이렇습니다.

> We are updating the Tomverse Privacy Policy and Terms and Conditions. The
> changes take effect on {{effectiveDate}}.
>
> Tomverse may email you product updates about features of the service you use,
> where the law where you live allows it without asking first. You can turn
> these off at any time in your email settings or with the unsubscribe link in
> any such message, without signing in. Sign-in codes, receipts and service
> notices are not affected.
>
> A marketing email consent stays in effect until you withdraw it. If you
> receive marketing email in Korea, we will remind you of that consent every two
> years.
>
> Read the updated documents: /privacy, /terms
>
> You are receiving this because it is a notice about the terms of your account.
> It is sent whatever your email settings are.

**고지 발송은 사람이 합니다.** 전 계정에 가는 되돌릴 수 없는 외부 발송이므로
자동화하지 않습니다. 시행일 **30달력일 전까지** 대상 계정 전원의 메일함에 도착해야
게이트가 인정합니다(`delivered`·`complained`, `deliveredAt` 기준).

## 5. 시행일

**미정 — 소유자 결정.** 게시일로부터 30일보다 늦어야 합니다. 두 문서가 같은 날을
보여야 하며, 다르면 게이트가 `effective_dates_differ`로 거절합니다.

## 6. 개정하지 않는 것 (소유자 결정 2026-09-29)

- **로그인 화면 동의 문장** — 이메일 동의를 묶지 않습니다. 이메일은 가입 흐름의
  별도 opt-in 장치입니다(재설계 §5.1, L2). 문장은 그대로입니다.
- **동의 장치 문안** — 결정 B에 따라 "요청하지 않으면 보내지 않는다"는 약속을
  유지합니다. 그 안내는 override가 실제로 메일을 보내는 사람에게는 보이지 않으므로
  약속은 보는 사람 모두에게 참입니다. 포르투갈어 수정은 새 버전
  `2026-09-29`로 반영했습니다(동의 문안 §11).

## 7. 승인란

| 절 | 내용 | 승인 |
|---|---|---|
| §2 | `/privacy` 이메일 조항 개정안 (7개 언어) | 대기 |
| §4 | 변경 고지 문안 (7개 언어) | 대기 |
| §5 | 시행일 | 대기 |
