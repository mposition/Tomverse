# 이메일 동의 문안 (S2)

- 상태: **승인됨.** 아래 문안은 이 시점의 바이트로 동결되며, 이후 수정은
  **새 버전이고 새 해시**입니다(§10).
- 승인자: **mposition**
- 승인일: **2026-09-23**
- 승인 범위: §1부터 §6까지 전부. §2의 선택(동의 장치 4개는 7개 언어,
  `/privacy`·`/terms` 본문은 기존 영어 fallback 유지)을 포함합니다.
- 상위 계약: `docs/policy/email-notifications.md` (정본),
  그리고 docs/policy/email-product-news-redesign-draft.md §5.1, §5.4, §7.7, §12의 S2 행
- 절 번호를 적을 때는 **어느 문서의 절인지 경로로 함께 적습니다.** 두 상위
  계약의 번호가 겹치므로, 번호만 적으면 어느 쪽인지 문장으로만 구분됩니다
- 이 문서가 만드는 것: **문안 자체**. 화면·route·locale 키 배선은 S2b이며,
  **승인 전에는 어디에도 붙이지 않습니다.**

---

## 0. 승인하실 때 보시는 것

이 문서는 세 가지를 한 번에 확정합니다.

1. **R5 결정의 문장화** — 동의의 유효 기간(§1).
2. **동의 장치 네 개의 정확한 문안** — 7개 언어(§3). 이 문안의 해시가
   `EmailPermissionEvent.evidence.candidates[].copyHash`로 영구 보존되므로,
   승인 이후 바꾸면 그것은 **새 문안이고 새 해시**입니다.
3. **§7.7이 요구하는 통지 세 건의 문안**(§4).

각 문안 아래에 **그것이 충족하는 계약 조항**과, 쓰지 않은 표현이 있으면
**왜 쓰지 않았는지**를 적었습니다. 승인은 문장 단위로 하셔도 됩니다.

---

## 1. R5 — 동의의 유효 기간

**소유자 결정(2026-09-23): 철회하실 때까지. 별도의 만료 기간을 두지 않습니다.**

ACMA는 숫자를 주지 않고, **약관에 적은 것이 기준**이 됩니다(docs/policy/email-product-news-redesign-draft.md §13의 R5).
그러므로 이 결정은 `/terms`에 적히는 순간 효력을 가집니다.

이 결정이 **바꾸지 않는 것**을 같이 적어 둡니다. 세 가지가 흔히 혼동됩니다.

- **한국의 2년 고지는 그대로입니다**(§7.7). 그것은 유효기간이 아니라 **주기적
  확인 의무**입니다. 동의는 만료되지 않지만, 2년마다 "수신동의 사실"을 알립니다.
- **수신거부는 즉시 유효합니다.** 무기한이라는 것은 우리가 계속 보내도 된다는
  뜻이 아니라, **철회가 없는 동안** 유효하다는 뜻입니다.
- **`risk_accepted` cohort는 이 결정과 무관합니다.** 그분들은 동의한 적이
  없으므로 만료시킬 동의도 없습니다(docs/policy/email-product-news-redesign-draft.md §5.5).

---

## 2. 몇 개 언어인가 — 승인된 선택

docs/policy/email-product-news-redesign-draft.md §12의 S2 행은 "7개 언어"라고 적지만, 저장소의 `lib/localeLaunchPolicy.ts`는
**`PAID_MARKETING_LOCALES = ["en", "ko"]`** 이고 `zh`·`de`·`es`·`fr`·`pt`는
`marketTier: "limited"`로 **의도적으로 영어로 대체**됩니다. 두 사실이 그대로
충돌합니다.

**이 초안이 택한 것**: **동의 장치 네 개(§3)는 7개 언어 전부**, **긴 법률 문서
(`/privacy`·`/terms`) 본문은 기존 fallback 동작 유지**.

근거는 둘이 다른 종류의 글이라는 것입니다. **동의는 이해한 사람만 할 수
있습니다.** 독일어로 제품을 쓰는 분에게 영어 동의 문구를 보여 주고 받은 체크는,
GDPR·ePrivacy에서 "informed"인지 다투게 됩니다 — 그리고 대체 대상 다섯 중
`de`·`es`·`fr`·`pt` 넷이 EEA 언어입니다. 반면 `/privacy`·`/terms` 전문은 이미
영어로 대체되고 있고, 그 전체를 번역하는 것은 이메일 결정이 아니라 **법률 표면
전체에 대한 별개 결정**입니다.

**소유자 승인(2026-09-23)으로 이 선택이 확정됐습니다.** 동의 장치 4개는 7개
언어 전부를 가지고, `/privacy`·`/terms` 본문은 기존 fallback을 유지합니다.
`lib/localeLaunchPolicy.ts`의 `limited` 표시는 그대로이며, 이 문서가 그것을
바꾸지 않습니다 — **제품 표면의 대체 정책과 동의 문안의 언어 범위는 별개**이고,
이 승인이 정한 것은 뒤쪽 하나입니다.

---

## 3. 동의 장치

docs/policy/email-product-news-redesign-draft.md §5.1, §5.4가 요구하는 네 장치입니다.

### 3.0 네 장치가 무엇이고 왜 넷인가

| # | 장치 | 어디에 | 무엇을 기록하는가 |
|---|---|---|---|
| A | opt-in 체크박스 (미체크 상태) | 가입 흐름 | **동의** → DOI |
| B | 고지 문장 | 가입 흐름, A 옆 | `notice_shown` |
| C | 독립 거부 수단 | 가입 흐름, A와 **별개** | `objected` |
| D | 제품 내 일회성 안내 | 기존 계정의 다음 접속 | A·B·C와 같은 세 상태 |

**세 상태는 서로 독립입니다.** 미체크는 거부가 아니고, 안내를 닫은 것도 거부가
아닙니다. C가 A와 별개로 존재하는 이유가 이것입니다 — 체크박스 하나만 두면
"거부"를 표현할 방법이 없어, 안 누른 사람과 거부한 사람이 같은 행이 됩니다.

### 3.A opt-in 체크박스 라벨

| 언어 | 문안 |
|---|---|
| ko | **이메일 광고성 정보 수신동의 (선택)** |
| en | Send me product news and offers by email (optional) |
| de | Produktneuigkeiten und Angebote per E-Mail erhalten (optional) |
| es | Quiero recibir novedades y ofertas por correo electrónico (opcional) |
| fr | Recevoir les actualités produit et les offres par e-mail (facultatif) |
| pt | Quero receber novidades e ofertas por e-mail (opcional) |
| zh | 接收产品资讯和优惠邮件（可选） |

**한국어는 docs/policy/email-product-news-redesign-draft.md §5.1이 지정한 문구 그대로입니다** — 채널("이메일")과
선택성("선택")을 둘 다 명시합니다. 다른 언어도 같은 두 가지를 담았습니다.

**쓰지 않은 것**: "최신 소식", "놓치지 마세요" 같은 권유. 체크박스 라벨은
**무엇에 동의하는지**를 적는 자리이지 설득하는 자리가 아닙니다. 기본값은
**미체크**이며, 미리 체크된 상태로 제공하지 않습니다.

### 3.B 고지 문장

| 언어 | 문안 |
|---|---|
| ko | 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 결제 영수증, 서비스 공지는 이 설정과 무관하게 발송됩니다. 언제든 로그인 없이 끄실 수 있습니다. |
| en | If you turn this on, Tomverse sends product updates, newsletters and promotions to the address on your account. Sign-in codes, billing receipts and service notices are sent whether or not you turn this on. You can turn it off at any time, without signing in. |
| de | Wenn Sie dies aktivieren, sendet Tomverse Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Rechnungsbelege und Servicehinweise werden unabhängig davon gesendet. Sie können es jederzeit ohne Anmeldung deaktivieren. |
| es | Si lo activas, Tomverse enviará novedades del producto, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos de facturación y los avisos de servicio se envían igualmente. Puedes desactivarlo en cualquier momento, sin iniciar sesión. |
| fr | Si vous l'activez, Tomverse envoie les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus de facturation et les avis de service sont envoyés dans tous les cas. Vous pouvez le désactiver à tout moment, sans vous connecter. |
| pt | Se você ativar, a Tomverse envia novidades do produto, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos de cobrança e avisos de serviço são enviados de qualquer forma. Você pode desativar a qualquer momento, sem fazer login. |
| zh | 开启后，Tomverse 会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、账单收据和服务通知无论是否开启都会发送。您可以随时关闭，无需登录。 |

**충족하는 것**: docs/policy/email-product-news-redesign-draft.md §5.1의 "무엇을 보내는지
적고". 그리고 docs/policy/email-notifications.md §3의 분류 경계(로그인
코드·영수증·서비스 공지는 동의 대상이 아님). 그리고 한국 안내서와
docs/policy/email-notifications.md §11.3의 "수신거부에 로그인을
요구하지 않는다".

**쓰지 않은 것**: "스팸을 보내지 않습니다". 지키겠다는 약속이 아니라 **평가**이고,
그 문장이 무엇을 금지하는지 아무도 말할 수 없습니다.

### 3.C 독립 거부 수단 라벨

| 언어 | 문안 |
|---|---|
| ko | 광고성 이메일을 받지 않겠습니다 |
| en | I do not want marketing email |
| de | Ich möchte keine Werbe-E-Mails erhalten |
| es | No quiero recibir correos de marketing |
| fr | Je ne souhaite pas recevoir d'e-mails marketing |
| pt | Não quero receber e-mails de marketing |
| zh | 我不想接收营销邮件 |

**A와 물리적으로 분리된 컨트롤입니다.** 체크박스를 비워 두는 것과 이것을 누르는
것은 저장되는 행이 다릅니다(`noticeShown` vs `objected`).

### 3.D 제품 내 일회성 안내 (기존 계정)

**제목**

| 언어 | 문안 |
|---|---|
| ko | 제품 소식을 이메일로 받아보시겠습니까? |
| en | Would you like product news by email? |
| de | Möchten Sie Produktneuigkeiten per E-Mail erhalten? |
| es | ¿Quieres recibir novedades del producto por correo? |
| fr | Souhaitez-vous recevoir les actualités produit par e-mail ? |
| pt | Quer receber novidades do produto por e-mail? |
| zh | 是否希望通过邮件接收产品动态？ |

**본문**

| 언어 | 문안 |
|---|---|
| ko | Tomverse는 지금까지 제품 소식을 보내드린 적이 없고, 요청하지 않으시면 앞으로도 보내지 않습니다. 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다. 언제든 로그인 없이 끄실 수 있습니다. |
| en | Tomverse has not sent you product news, and will not unless you ask. Turning this on sends product updates, newsletters and promotions to the address on your account. Sign-in codes, receipts and service notices are unaffected. You can turn it off at any time, without signing in. |
| de | Tomverse hat Ihnen bisher keine Produktneuigkeiten gesendet und wird dies ohne Ihre Zustimmung auch nicht tun. Wenn Sie dies aktivieren, senden wir Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Belege und Servicehinweise bleiben unberührt. Sie können es jederzeit ohne Anmeldung deaktivieren. |
| es | Tomverse no te ha enviado novedades del producto y no lo hará a menos que lo pidas. Si lo activas, enviaremos novedades, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos y los avisos de servicio no cambian. Puedes desactivarlo en cualquier momento, sin iniciar sesión. |
| fr | Tomverse ne vous a pas envoyé d'actualités produit et ne le fera pas sans votre demande. Si vous l'activez, nous enverrons les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus et les avis de service ne changent pas. Vous pouvez le désactiver à tout moment, sans vous connecter. |
| pt | A Tomverse não enviou novidades do produto e não enviará a menos que você peça. Se ativar, enviaremos novidades, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos e avisos de serviço não mudam. Você pode desativar a qualquer momento, sem fazer login. |
| zh | Tomverse 尚未向您发送过产品动态，未经您同意也不会发送。开启后，我们会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、收据和服务通知不受影响。您可以随时关闭，无需登录。 |

**첫 문장이 중요합니다.** 기존 계정은 **어느 법역에서도 근거가 없습니다**
(docs/policy/email-product-news-redesign-draft.md §5.5). "지금까지 보낸 적이 없다"는 사실을 먼저 적는 것은, 이 안내가
**이미 하고 있던 일을 통지하는 것이 아니라 처음 여쭙는 것**임을 분명히 하기
위해서입니다. 방침 변경 고지처럼 읽히면 그것이 소급 적격화로 오인됩니다.

**세 버튼**

| 역할 | ko | en | de | es | fr | pt | zh |
|---|---|---|---|---|---|---|---|
| 동의 | 네, 받겠습니다 | Yes, send them | Ja, senden | Sí, quiero recibirlas | Oui, envoyez-les | Sim, pode enviar | 好，请发送 |
| 거부 | 받지 않겠습니다 | No, thank you | Nein, danke | No, gracias | Non, merci | Não, obrigado | 不用了 |
| 닫기 | 나중에 | Not now | Später | Ahora no | Plus tard | Agora não | 以后再说 |

**"나중에"와 "받지 않겠습니다"가 다른 버튼인 것이 이 화면의 핵심입니다.**
닫기는 `notice_shown`만 남기고 **동의도 거부도 아닙니다**. 닫기를 거부로
기록하면, 하던 일을 하러 가느라 창을 닫은 사람에게 결정을 지어내는 것입니다 —
추론된 동의와 같은 잘못이고 방향만 안전해 보일 뿐입니다.

**닫기 버튼을 회색으로 흐리거나 작게 만들지 않습니다.** 세 버튼은 같은 크기와
같은 대비를 가집니다. 한 번 닫으면 다시 뜨지 않습니다.

---

## 4. §7.7이 요구하는 통지

### 4.1 수신동의 처리결과 통지 (`consent_result_notice`)

14일 이내. DOI **확인 링크 클릭이 성공한 transaction**에서 함께 enqueue됩니다 —
확인 요청 메일은 동의 **전에** 나가므로 통지가 될 수 없습니다(C28).

**제목**

| 언어 | 문안 |
|---|---|
| ko | 광고성 정보 수신동의 처리 결과 |
| en | Your marketing email preference has been turned on |

**본문 (ko)**

> 전송자: Tomverse Pty Ltd
> 처리 내용: 이메일 광고성 정보 수신동의
> 처리 결과: 동의 처리 완료
> 동의일: {{consentDate}}
>
> 이 동의는 철회하실 때까지 유효합니다. 언제든 이메일 설정이나 광고성 메일의
> 수신거부 링크에서 로그인 없이 철회하실 수 있습니다.

**본문 (en)**

> Sender: Tomverse Pty Ltd
> Request: consent to receive marketing email
> Outcome: turned on
> Date: {{consentDate}}
>
> This consent stays in effect until you withdraw it. You can withdraw it at any
> time in your email settings or with the unsubscribe link in any marketing
> message, without signing in.

**충족하는 것**: 정보통신망법 제50조제7항·시행령 제62조의2(전송자 명칭, 처리
사실과 날짜, 처리 결과). R5(§1)가 "철회 시까지"이므로 **만료일을 적지 않습니다** —
적으면 그것이 기준이 됩니다.

### 4.2 수신거부·철회 처리결과 통지 (`unsubscribe_result_notice`)

**수신거부한 주소로도 나가는 transactional 메일입니다.** 이것은 광고가 아니라
처리 결과이고, 정본 §3의 분류에서 동의가 아니라 **주소로 판정**합니다.

**제목**

| 언어 | 문안 |
|---|---|
| ko | 광고성 정보 수신거부 처리 결과 |
| en | Your marketing email has been turned off |

**본문 (ko)**

> 전송자: Tomverse Pty Ltd
> 처리 내용: 이메일 광고성 정보 수신거부
> 처리 결과: 수신거부 처리 완료
> 처리일: {{processedDate}}
>
> 이 주소로 광고성 이메일을 더 보내지 않습니다. 로그인 코드, 결제 영수증,
> 서비스 공지는 계속 발송됩니다.

**본문 (en)**

> Sender: Tomverse Pty Ltd
> Request: stop marketing email
> Outcome: turned off
> Date: {{processedDate}}
>
> We will not send marketing email to this address again. Sign-in codes, billing
> receipts and service notices continue.

**마지막 문장이 필요한 이유**: 이 통지를 받은 분이 "이제 아무 메일도 안 오는구나"
라고 읽으면, 다음에 도착하는 로그인 코드가 위반으로 보입니다. 무엇이 멈추고
무엇이 계속되는지 적는 것이 §3의 분류 경계를 사용자 쪽에서 지키는 방법입니다.

### 4.3 2년 수신동의 사실 고지 (`biennial_consent_notice`)

**상태: 연기(deferred).** 첫 기한은 2028년입니다. 문안만 지금 확정합니다.

**제목**

| 언어 | 문안 |
|---|---|
| ko | 광고성 정보 수신동의 사실 안내 |
| en | A note about your marketing email preference |

**본문 (ko)**

> Tomverse Pty Ltd는 아래와 같이 귀하의 광고성 정보 수신동의를 보유하고 있음을
> 알려 드립니다.
>
> 수신 주소: {{emailAddress}}
> 2년 고지 기준일: {{anchorLabel}}({{anchorDate}})
> 수신 중인 항목: {{purposeList}}
>
> 계속 받기를 원하시면 아무 조치도 필요하지 않습니다. 원하지 않으시면 아래
> 수신거부 링크에서 로그인 없이 바로 처리하실 수 있습니다.

**`{{anchorLabel}}`은 두 값만 가집니다.**

| 대상 | anchorLabel (ko) | anchorLabel (en) |
|---|---|---|
| 실제로 동의한 분 | 수신동의일 | consent date |
| `risk_accepted` cohort | **가입일** | **sign-up date** |

**cohort에게 "수신동의일"이라고 쓰지 않습니다** — 동의하지 않은 날을 동의일로
적는 것이기 때문입니다. **"가입일부터 수신 중"도 쓰지 않습니다** — 실제 수신
시작일(첫 발송)과 다릅니다. 초안 §7.7이 지정한 표현("기준일이 가입일이라는
사실만 적는다")을 그대로 따릅니다.

---

## 5. `/terms` — 동의 유효 기간 조항 (R5)

| 언어 | 문안 |
|---|---|
| ko | **광고성 이메일 수신동의.** 수신동의는 철회하실 때까지 유효하며 별도의 만료 기간을 두지 않습니다. 이메일 설정 또는 광고성 메일에 포함된 수신거부 링크에서 **로그인 없이** 언제든 철회하실 수 있습니다. 철회하셔도 로그인 코드, 결제 영수증, 서비스 공지는 계속 발송됩니다. |
| en | **Marketing email consent.** Your consent stays in effect until you withdraw it. There is no fixed expiry. You can withdraw it at any time in your email settings or with the unsubscribe link in any marketing message, **without signing in**. Withdrawing does not stop sign-in codes, billing receipts or service notices. |

**이 두 문장이 R5를 법적으로 성립시킵니다.** ACMA가 숫자를 주지 않으므로,
여기 적힌 것이 기준입니다.

---

## 6. `/privacy` — 이미 있는 조항의 개정 여부

`locales/*.ts`의 `privacyPolicy.email`은 **이미 존재하고 상당히 완성돼
있습니다** — 무엇을 보내는지, 무엇이 끌 수 있고 무엇이 없는지, 어떤 기록을
남기는지(동의 시점 IP·브라우저 식별자의 단방향 해시 포함), Resend가 배달하고
추적이 꺼져 있다는 사실, suppression이 계정 삭제 후에도 남는다는 사실까지
적혀 있습니다.

**이 초안은 그 조항에 두 문장만 더합니다.**

| 언어 | 추가 문안 |
|---|---|
| ko | 수신동의는 철회하실 때까지 유효하며 만료되지 않습니다. 한국에서 수신 중이신 경우, 2년마다 수신동의 사실을 알려 드립니다. |
| en | A marketing consent stays in effect until you withdraw it and does not expire. If you receive marketing email in Korea, we tell you about that consent every two years. |

나머지는 그대로 둡니다. **이미 정확한 문장을 다시 쓰는 것은 개정이 아니라
위험입니다** — 현행 문장은 승인돼 배포돼 있고, 재작성은 승인받은 적 없는
표현을 끌고 들어옵니다.

---

## 7. 승인 이후 (S2b, 이 문서의 범위 아님)

1. `locales/*.ts`에 키 추가 — 동의 장치 4개, 통지 3건, `/terms` 조항,
   `/privacy` 추가 2문장.
2. **불변 artifact와 해시** — docs/policy/email-product-news-redesign-draft.md §5.1이 요구하는 "정확한 문안과 선택 상태의 보존".
   해시는 S8의 `recordNoticeShown({ candidates: [{ copyHash }] })`가 받는
   값이며, `EmailPermissionEvent.evidence`에 영구 보존됩니다.
3. 가입 흐름에 A·B·C 배치, 제품 내 안내에 D 배치.
4. `consent_result_notice`·`unsubscribe_result_notice` 템플릿 등록.

**2번이 1번보다 중요합니다.** locale 키는 고치면 되지만, 해시가 가리키는 문안이
바뀌면 **이미 저장된 동의 증거가 무엇을 보여 준 증거인지 알 수 없게 됩니다.**
승인된 문안은 그 시점의 바이트로 동결하고, 이후 수정은 새 버전·새 해시입니다.

---

## 8. 승인란

각 절을 개별적으로 승인하거나 반려하실 수 있습니다.

| 절 | 내용 | 승인 |
|---|---|---|
| §1 | R5 — 철회 시까지 | **mposition, 2026-09-23** |
| §2 | 동의 장치는 7개 언어, 법률 문서는 fallback 유지 | **mposition, 2026-09-23** |
| §3.A–D | 동의 장치 4개의 문안 | **mposition, 2026-09-23** |
| §4.1–4.3 | 통지 3건의 문안 | **mposition, 2026-09-23** |
| §5 | `/terms` 조항 | **mposition, 2026-09-23** |
| §6 | `/privacy` 추가 2문장 | **mposition, 2026-09-23** |

§7이 착수 가능해졌습니다.

**승인된 문안의 digest**(버전 `2026-09-23`, §3의 장치 4개 × 7개 언어 전체):

`sha256:d31346bd26d8c1ff32bf7ff7bc34978918908c48e21562f8758bb7ec9a149854`

코드의 문안이 이 값과 다르면 테스트가 실패합니다. 이 줄을 고치는 것은 승인된
기록을 고치는 것이고, §10이 금지하는 편집입니다 — 문안을 바꾸려면 새 버전과 새
승인을 추가합니다.

## 9. 승인 이후 발견된 것 — 9.1 결정됨(B), 9.2 결정됨(§11), 9.3 결정됨(누락)

독립 검토(2026-09-23, Cursor/Grok 4.7 xHigh)가 승인 **이후** 두 가지를 찾았습니다.
문안은 승인됐으므로 **고치지 않았습니다.** 9.1은 소유자가 B로 결정했고, 9.2는
결정을 기다립니다. 두 건 모두 아직 어떤
화면도 이 문안을 렌더링하지 않아 저장된 증거가 없습니다 — 그래서 지금이 고치기
가장 싼 시점이고, **싸다는 것이 제가 정해도 된다는 뜻은 아닙니다**(§10).

### 9.1 제품 내 안내의 약속과 `risk_accepted` 발송이 양립하지 않습니다

**승인된 문안**(§3.D 본문, 7개 언어 전부)은 이렇게 시작합니다.

> Tomverse는 지금까지 제품 소식을 보내드린 적이 없고, 요청하지 않으시면
> 앞으로도 보내지 않습니다.

**승인된 다른 결정**(docs/policy/email-product-news-redesign-draft.md §5.6, 소유자 2026-09-16)은 기존 78계정에게 **동의 없이**
`risk_accepted`로 보내는 것입니다.

한 통이라도 나가면 "요청하지 않으면 보내지 않는다"가 거짓이 되고, 그 뒤에 이
안내를 보여 주면 "보낸 적이 없다"까지 거짓입니다. 그리고 그 화면의 `copyHash`는
**우리가 이미 깬 약속을 보여 줬다는 증거**로 영구 보존됩니다.
docs/policy/email-product-news-redesign-draft.md §5.5가 인용한 FTC Section 5
위험이 바로 이 모양입니다.

**소유자 결정(2026-09-23): B.** `risk_accepted` cohort는 이 안내를 보지
않습니다. override는 78계정 전부에 그대로 유지되고, 문안은 **그것이 참인
사람에게만** 보여집니다.

| # | 결정 | 결과 | |
|---|---|---|---|
| A | 안내를 본 주소는 override 대상에서 빠짐 | 발송 대상이 줄어듦 | |
| **B** | **cohort는 이 안내를 보지 않음** | **override는 78계정 전부 유지** | **선택됨** |
| C | 약속하지 않는 새 문안 버전 승인 | docs/policy/email-product-news-redesign-draft.md §5.5의 "처음 여쭙는다"는 인상이 약해짐 | |

**구현(S8a)**: 아래에 적은
함수(`noticeStateForUser()`, `overrideWouldSend()`, `overrideBlockers()`)는 이
문서와 같은 트리에 없습니다. 이 트리에는 안내를 렌더하는 화면도 없습니다.
**안내는 S8a가 병합된 뒤에만 렌더해야 합니다** — 그 전에 렌더하면 거절이
동작하지 않아 cohort도 이 약속을 봅니다.

`noticeStateForUser()`는 멤버십만으로 거절하지 않습니다. **override가
그 사람에게 실제로 메일을 보낼 때만** `covered_by_approval`로 거절합니다 — 활성
정책 버전, 봉인, 승인 철회 없음, 현재 주소 digest 일치, `marketingJurisdictionVerdict()`
허용, purpose 범위, 그리고 그 purpose가 철회되지 않았을 것. 첫 구현은 멤버십만
봤고, 그러면 주소를 바꾼 멤버나 허용 국가 밖의 멤버가 **메일도 안내도 받지 못하고
동의할 자리도 없는** 상태가 되어 고쳤습니다. 이 문안의 약속은 그것이 참인 사람에게만
가야 하고, 그 기준은 멤버십이 아니라 발송입니다.

또 안내를 한 번 보여 준 계정에는 **이후 override가 적용되지 않습니다**
(`overrideBlockers()`의 `promised_no_unrequested_send`). 주소를 바꿨다가 되돌리면
digest가 다시 일치하는데, 그때 override가 돌아오면 기록된 약속이 깨집니다.

**그 사람이 스스로 한 결정이 우리 범위 결정보다 앞섭니다.** cohort 안에 있어도
동의했거나 거부했거나 주소가 suppression되었다면 그 사실로 거절합니다. cohort는
*묻지 않는 이유*이지, 답한 사람의 답을 덮는 것이 아닙니다.

**기존 문안 수정은 선택지가 아니었습니다**(§10).

### 9.1.1 결정 B가 정하지 않은 것 — 동의를 가정해 기록하지 않습니다

결정 B는 **누구에게 안내를 보일지**를 정했습니다. 그것이 **동의 기록을 만드는
근거가 되지는 않습니다.**

docs/policy/email-product-news-redesign-draft.md §5.6 규칙 1(소유자 승인 2026-09-16)은 한 문장입니다.

> **동의를 지어내지 않습니다.** `ConsentRecord(granted)`를 쓰지 않습니다.

이 절의 첫 판(2026-09-23)은 이 규칙의 결과를 **실제보다 단순하게** 적었습니다 —
"결과는 같고 원장이 사실을 말하느냐만 다르다", "어떤 조회도 구별하지 못한다",
"`risk_accepted`가 이미 하는 일이다". 독립 검토가 셋 다 틀렸다고 지적했고, 맞는
지적입니다. 아래가 고친 내용입니다. 결과는 같지 않고, 구별은 되고, 발송 경로는
아직 없습니다.

**먼저 "필드"가 둘입니다.** 발송이 동의를 판정하는 것은 `ConsentRecord`가
아니라 **`EmailPreference`**의 `enabled`와 `confirmedAt`입니다
(`consentGateVerdict()`, `lib/standardEmailLane.ts`). `ConsentRecord`는 그
판정의 증거 원장입니다. 정상 경로(`setPreference()`)는 둘을 같은 트랜잭션에서
씁니다.

**`EmailPreference`만 채우면** — 발송은 그 계정을 **동의한 사람으로 판정**합니다.
원장에는 부여 기록이 없으므로 **판정과 원장이 서로 반대 사실을 말하는** 상태가
됩니다. 판정의 근거를 물으면 가리킬 동의가 없습니다.

**`ConsentRecord(granted)`까지 쓰면** — 행을 넣는 순간에는 **메일도 통지도
나가지 않습니다.** 지금의 발송 판정은 `EmailPreference`만 읽고, 14일 처리결과
통지(`consent_result_notice`)는 이 트리에 아직 없습니다 — 초안 §7.7(단계 S6)이
그것을 확인 링크를 누르는 트랜잭션에 붙이도록 설계했을 뿐이고, 그 설계에서도
부여 행이 있다는 사실만으로는 생기지 않습니다. 바뀌는 것은 기록이고, 그 기록을
앞으로 만들 경로가 읽습니다.

- **발송이 동의에 의한 것으로 기록됩니다(S9 이후).** 설계된 발송은 동의가 있으면
  override를 쓰지 않습니다(docs/policy/email-product-news-redesign-draft.md §5.6 규칙 4). 동의가 없으면 규칙 2대로
  `legalAllowed: false`와 `overrideApplied`가 함께 남는데, 부여 행이 있으면 같은
  발송이 **명시적 동의에 의한 발송으로** 남습니다. 그 원장은 규칙 1이 금지한 것이고,
  규칙 3(admin 화면에 override를 그대로 보인다)이 지키려는 구분 — 다음 사람이
  override 발송을 동의로 읽지 않게 하는 것 — 이 원장 쪽에서 무너집니다. 규칙 4는 아직 발송 경로에 연결되어
  있지 않습니다.
- **한국 2년 고지의 기준일이 가짜 동의일이 됩니다(그 배치가 만들어진 뒤).** 초안
  §7.7은 기준일을 `실제 동의일 ?? noticeAnchorAt`으로 정했습니다. 2년 고지 배치와
  그 선택기는 아직 없으므로 행을 넣는 순간에는 아무것도 바뀌지 않습니다. 그러나
  배치가 §7.7대로 만들어지면 부여 행의 날짜가 **동의하지 않은 날을 동의일로**
  적습니다. 초안 §7.7과 L12가 `ConsentRecord(granted)`를 쓰지 말라고 한 이유가
  이것입니다.
- **법정 통지를 하지 않은 동의로 남습니다.** 한국 법은 수신동의 처리 결과를 14일
  안에 알리라고 요구합니다(§4.1). 부여 행만 넣으면 그 통지는 나가지 않으므로,
  원장은 "동의를 받고 처리 결과를 알리지 않았다"는 기록이 됩니다. 통지를 따로
  보내면 동의한 적 없는 사람에게 "동의 처리 완료"를 알리게 됩니다.
- **채널을 지어내야 합니다.** `capturedVia`는 필수이고 CHECK가 여섯 값만
  허용합니다(`signup_form`·`preference_center`·`unsubscribe_page`·`import`·
  `admin`·`provider_complaint`). "가정"은 그중에 없습니다. `admin`이나 `import`가
  가장 가깝지만, 둘 다 **그 채널에서 동의를 받았다고** 적는 값입니다.

**구별은 됩니다 — 확인 증거로 구별됩니다.** 발송 경로(`consentGateVerdict()`)는
동의 여부만 보므로 그 경로에서는 구분이 없고, S8a 설계의 안내 경로도 같습니다
(이 트리에는 그 화면이 없습니다). 이 절의 둘째 판은 비어 있는 IP 해시와 문안 해시가
조작을 드러낸다고 적었는데, 틀렸습니다. 실제 부여 행도 둘 다 비어 있을 수
있습니다 — 부여 행을 쓰는 유일한 경로(`confirmConsent()` → `setPreference()`)는
문안을 넘기지 않아 문안 해시가 생기지 않고, IP 해시는 IP와 `NEXTAUTH_SECRET`(해시의
HMAC 키)이 **둘 다 있을 때만** 생깁니다 — 둘 중 하나라도 없으면 비어 있습니다.
production의 확인 라우트는 엣지가 보증한 IP가 없으면 아무것도 넘기지 않으므로
그때 비어 있고, 그것이 유일한 경우는 아닙니다: `confirmConsent({ ip })`는 넘어온
IP를 그대로 쓰고, production 밖에서는 `x-real-ip`도 씁니다. 동의 토큰 키링
(`EMAIL_CONSENT_KEYS`)은 이 HMAC 키와 별개의 비밀입니다. 실제 동의를 가르는 것은 `evidence` 안의
`confirmedVia: "link"`·`tokenVersion`·`requestId`·`requestedAt`입니다. 가정으로
넣은 행에는 이것이 없고, 채우려면 **받은 적 없는 확인 링크 클릭**을 지어내야
합니다. 입증 책임은 발신자에게 있으므로(ACMA, GDPR), 조사에서 전자는 동의의
증거가 되지 못하고 후자는 지어낸 기록의 증거가 됩니다. 동의 기록이 없고
`risk_accepted`가 사실대로 적혀 있는 편이 **실질적으로 더 안전합니다.**

**되돌릴 수 없습니다.** `ConsentRecord`는 append-only입니다. 한 번 넣으면
"가정이었다"를 적을 칸이 없고 지울 수도 없습니다.

**수신거부 가능성은 이 선택지들을 구분하지 않습니다.** 어느 경로로 보내든 수신거부는
로그인 없이 됩니다. 그것은 동의를 유효하게 만드는 조건이 아닙니다.

**"이미 하는 일"은 아닙니다 — 설계됐고, 경로는 이제 있습니다.** 78계정에게
`risk_accepted`로 보내는 발송 경로는 S9에서 들어왔습니다: `product_updates`는 일반
동의 게이트 대신 release notes 판정(`releaseNotesSendAuthorization()`)을 거치고, 그
판정이 봉인된 승인의 멤버에게 override를 적용합니다. 그 경로는 전용 flag와 게시
게이트 뒤에 있고, marketing flag는 기본값이 off입니다. **production의 flag 값과 승인 봉인 여부는 이 문서가
말할 수 있는 사실이 아닙니다** — 저장소가 아니라 운영 DB가 가진 값이고, 보내기
전에 확인해야 하는 것입니다. 원장과
봉인 장치(S3)는 develop에 있고, cohort 판정(S8a)은 아직 병합되지 않았으며, 발송은
S9입니다. `EmailPreference`까지 채우면 S9를 기다리지 않고 보낼 수 있다는 점은
사실입니다 — 그 대가가 위의 목록입니다.

이 절은 그 판단을 기록해 둔 것이지 결정을 막는 것이 아닙니다. 다르게 정하시면
그때 기록하겠습니다.

### 9.2 포르투갈어 안내 첫 절에 수신자가 없습니다

`A Tomverse não enviou novidades do produto` — 다른 다섯 대명사 언어는 수신자를
적습니다(en `sent you`, de `Ihnen`, es `te ha enviado`, fr `vous a pas envoyé`,
zh `向您发送`). 한국어는 `보내드린`의 경어로 표시하므로 해당 없습니다.

두 번째 절에는 `a menos que você peça`로 수신자가 있습니다. 그래서 선택이 아니라
**누락**으로 읽힙니다. 글자 그대로는 "Tomverse는 제품 소식을 보낸 적이 없다"는
전역 주장이고, 지킬 수 있는 문장이 아닙니다.

권장 수정(승인 대상): `A Tomverse não lhe enviou novidades do produto`.

`tests/emailConsentCopy.test.mjs`가 현재 문장을 고정하고 있어, 버전을 추가하지
않고 조용히 고치면 실패합니다.

---

### 9.3 §4.3의 2년 고지에 영어 본문이 없습니다

§4.1과 §4.2는 한국어 본문과 영어 본문을 둘 다 가집니다. §4.3은 **영어 제목**과
`{{anchorLabel}}`의 영어 값(`consent date` / `sign-up date`)은 있는데 **본문은
한국어 하나**입니다. 승인표는 §4.1–4.3을 한 행으로 승인했고, 이것이 의도인지
누락인지 적힌 곳이 없습니다.

두 읽기가 모두 가능합니다.

- **의도.** 2년 고지는 정보통신망법 제50조제8항의 의무이고, 그 의무를 지는 대상은
  한국 수신자입니다. 한국 수신자에게 한국어로 보내는 것이면 영어 본문은 필요
  없습니다.
- **누락.** §4.1·§4.2가 둘 다 갖고 있고, §4.3도 **제목과 anchorLabel은** 영어를
  갖고 있습니다. 본문만 빠진 것은 표를 채우다 만 모양에 가깝습니다.

**구현은 이 결정을 기다립니다.** 문안을 지어내지 않습니다 — 승인된 문안을
채워 넣는 것은 승인이 아니라 작문입니다. 그리고 §10에 따라, 지금 이 상태로
동결된 뒤에 영어 본문을 넣는 것은 편집이 아니라 **새 버전**입니다. 그래서 이
질문은 S9가 2년 고지를 실제로 보내기 전이 아니라 **이 문서를 동결하기 전에**
답해야 유리합니다.

기한은 2028년이므로 급하지 않지만, 늦게 답하면 비용이 새 버전 하나로 올라갑니다.

**결정됨(소유자, 2026-09-29): 누락.** 영어 본문 초안은
[방침·약관 개정 초안](email-policy-amendment-draft.md) §8에 있고 승인을 기다립니다.
독립 검토(18차, Cursor)가 찾았습니다.

## 10. 승인 이후 이 문서를 고치는 법

**문안을 고치는 것은 편집이 아닙니다.** 위 표의 해시가
`EmailPermissionEvent.evidence.candidates[].copyHash`로 영구 보존되므로,
승인된 바이트가 바뀌면 이미 저장된 동의 증거가 **무엇을 보여 준 증거인지 알 수
없게** 됩니다.

그러므로 문안 변경은 다음 순서입니다.

1. 이 문서에 **새 절**을 추가합니다. 기존 절을 고쳐 쓰지 않습니다.
2. 새 절은 자기 버전 번호와 자기 승인자·승인일을 가집니다.
3. 코드의 문안 레지스트리에 **새 버전을 추가**하고, 기존 버전은 남깁니다.
   지난 `copyHash`가 가리키는 문안이 계속 조회 가능해야 합니다.
4. 오타 수정도 같습니다. "같은 문장의 더 나은 표기"라는 것은 증거 쪽에서 보면
   **다른 문장**입니다.

### 10.1 새 버전이 실제로 요구하는 것

위 네 항목은 원칙이고, 아래가 그 원칙을 만족시키기 위해 실제로 바뀌는 것들입니다.
독립 검토가 이 목록이 없다는 점을 지적했고, 맞는 지적입니다 — 절차가 절반만 적혀
있으면 나머지 절반은 다음 사람이 테스트 실패로 알게 됩니다.

**이 문서에서**

1. 새 `## <번호>.` 절. 그 안에 장치 요약 `###` 하나와 장치별 `###`들 — 모두 그
   `##`의 형제여야 하고, 더 깊은 단계로 내리면 검사가 찾지 못합니다. 요약 절에는
   표가 **정확히 하나**입니다.
2. 그 절의 승인표: 승인한 절과 그 내용, 승인자와 승인일.
3. `버전 <id>`를 적은 문단, 그 **바로 다음 노드**로 그 버전의 digest만 담은 문단.
   사이에 표·목록·인용문이 들어가면 두 개의 별개 주장이 됩니다. 그 문단에는
   **inline code가 정확히 하나**이고 그 값이 버전 id 그대로여야 합니다 — 검사는
   그 값을 문자 그대로 비교합니다. 이전 두 번은 토큰 경계를 세는 방식이었고,
   그때마다 경계의 정의가 논점이 됐습니다.

**`lib/emailConsentCopy.ts`에서**

4. 새 `ConsentCopyTable` 상수와 `CONSENT_COPY_VERSIONS` 항목. 항목은
   `version`·`approvedBy`·`approvedAt`·`recordSection`·`approvedSections`·
   `recordDigest`·`approvedBodyDigest`·`deviceCells`·`deviceSummary`·`copy`를
   모두 가집니다. 승인 범위의 **절 목록은 항목에 적지 않습니다** —
   `approvedSections`에서 유도합니다(§10.1의 8번).
   **배열 끝에 넣습니다** — 새 render가 쓰는 버전은 마지막 항목이므로, 가운데에
   끼워 넣으면 모든 검사가 통과하는 채로 제품은 계속 이전 문안을 씁니다.
   `approvedSections`에는 **그 버전의 문안이 실제로 있는 절**이 들어가야 합니다.
5. `PROMISE_NO_UNREQUESTED_SEND_VERSIONS`와 `MAKES_NO_SEND_PROMISE_VERSIONS`
   **둘 중 정확히 하나**에 그 버전을 넣습니다. 이 분류는 §9.1의 override 판정에
   쓰이므로 기본값으로 남겨 두지 않습니다.

**`lib/emailConsentCopyDigests.ts`에서**

6. 그 버전의 8개 key × 7개 언어 = 56개 pin. 그리고 그 버전의 문안 digest는
   **기존 어느 버전과도 달라야** 합니다 — 같으면 §8류 기록이 어느 승인을 가리키는지
   말하지 못하고, 아무것도 바뀌지 않은 버전은 존재할 이유가 없습니다.

**`tests/emailConsentCopy.test.mjs`에서**

7. 문서 전체 digest(`APPROVED_DOCUMENT_DIGEST`)를 다시 적습니다. 새 버전의
   `recordDigest`와 `approvedBodyDigest`는 그 버전의 절에서 계산한 값이고,
   **기존 버전들의 두 digest는 건드리지 않습니다.** 전체 digest는 버전을 추가할
   때 반드시 움직이므로, 그 움직임 하나로는 같은 commit이 §1–§6의 승인된 본문을
   고치는 것을 구분하지 못합니다. 버전별 `approvedBodyDigest`가 그 본문과 그
   버전의 승인란을 함께 고정하고, 버전 추가는 그것을 건드리지 않습니다 —
   독립 검토(13차)가 이 구멍을 찾았습니다.
8. `approvedBodyDigest`가 덮는 절 목록은 **적는 것이 아니라 유도됩니다.**
   `approvedSections`의 각 행에서 절 번호를 읽어 문서 순서로 놓은 것이 그
   목록이고, digest는 각 부분의 길이를 앞에 붙인 형태로 계산합니다 — 목록
   순서나 구분자가 결과를 바꿀 수 없어야 합니다. 검사가 보증하는 것은 **절
   번호의 연결**이며, 번호 옆의 설명은 코드에 적힌 값과 대조할 뿐 유도하지
   않습니다.

   목록을 항목에 적었던 첫 판은 독립 검토(14차)가 지적한 우회를 허용했습니다 —
   목록에서 `"4."`를 빼고, 승인표에서 §4 행을 빼고, 두 digest를 다시 적으면
   §4의 승인된 문안을 고칠 수 있었습니다. 목록이 승인표의 내용이 된 뒤에는
   범위를 줄이는 것이 곧 **소유자가 서명한 표를 고치는 것**입니다.
9. 문서 전체 digest와 `UNVERSIONED_SECTIONS`는 `lib/emailConsentCopyDocumentPins.ts`에
   있으며 **in-tree 정합성 pin**입니다. base 비교는 이들을 읽지 않습니다 — 문서를
   절 단위로 직접 대조하므로 여기 적힌 digest는 그쪽에 아무것도 증명하지 않습니다.
   (이전 설계에서는 base가 이 파일을 읽었고 이 항목도 그렇게 적혀 있었습니다.
   설계가 바뀌었으므로 설명도 바꿉니다.)

   그래도 유지하는 이유는 셋입니다. base revision 없이도 **로컬에서** 문서 변경을
   즉시 잡고, 의도한 변경을 **기록된 행위**로 만들며(다시 적는 것이 diff의 한 줄로
   남습니다), 단위 테스트가 이 pin이 덮는 조각들로 문서를 **재조립해 원본과
   대조**하므로 base 비교가 쓰는 것과 같은 파티션이 정직하게 유지됩니다.

   `UNVERSIONED_SECTIONS`는 **어느 버전도 소유하지 않는 절**의 목록입니다.
   새 버전의 절과 승인란은 그 버전의 두 digest가 덮으므로 여기에 들어가지
   않고, 그래서 버전을 추가해도 `UNVERSIONED_SECTIONS_DIGEST`는 움직이지
   않습니다. 새 절을 만들고 어느 버전에도 등록하지 않으면 유도된 목록이 기록된
   목록과 어긋나 실패합니다.

   이것이 있는 이유: 문서 전체 digest는 버전을 추가할 때 반드시 움직이고, 그
   움직임은 §0·§7·§9·§10과 상단 상태 블록의 편집도 함께 덮어 줍니다. 14차
   검토가 그 세 줄을 표로 만들어 보였습니다.
10. **기존 버전의 승인된 바이트는 base와 같아야 합니다.** in-tree digest는 편집을
   **보이게** 만들지 편집을 막지는 못합니다 — 같은 commit이 값과 pin을 함께
   고칠 수 있기 때문입니다. `npm run check:consent-copy-immutability`가 PR
   base에서 `lib/emailConsentCopy.ts`와 이 문서를 읽어 대조하고 **추가만**
   허용합니다.

   대조 대상은 **digest가 아니라 바이트**입니다. 기존 버전의 56개 문안 문자열
   전부(`copy`가 이름 댄 표를 값으로 풀어서), 기록(버전·승인자·승인일·승인란·
   승인표·장치 위치·copy 표 이름), 그리고 이 문서의 **모든 절**입니다. 주석과
   서식은 대상이 아닙니다.

   **면제 목록이 없습니다.** 네 차례의 독립 검토가 metadata 비교 밑에서 같은
   모양의 구멍을 반복해 찾았고, 마지막이 가장 분명했습니다 — 재계산 면제를
   digest 두 field로 좁혀도, `copy`가 가리키는 상수의 내용을 바꾸고 문서 pin을
   다시 적고 두 digest 전환을 면제 목록에 넣으면 통과했습니다. digest는 아무도
   비교하지 않는 바이트에 대한 증거일 뿐이었습니다. 이제 바이트가 같으면 digest가
   무엇이든 통과하고, 바이트가 다르면 어떤 항목으로도 면제되지 않습니다.

   문서는 절 단위로 비교합니다. **§9·§10만 개정 가능**이며 그 변경은 거절이 아니라
   `NOTE`로 보고합니다. 상단 상태 블록·§0·§7과 승인된 문안 절은 움직일 수 없고,
   새 절 추가는 새 버전이 가져오는 것이므로 허용입니다.

   파서는 **TypeScript AST**입니다. 문자열 검색판은 한 자리에서 세 번 뚫렸고
   (주석 안의 옛 배열, 계산식 위 주석의 옛 값, literal 뒤의 spread), 그 다음 판은
   이름만 맞으면 어느 선언이든 믿었습니다(지역 선언 + `export { actual as … }`
   decoy). 이제 **최상위 `export const` 하나**만 읽고, 그 이름을 다시 export 하는
   절이 있으면 거절합니다. 읽을 수 없는 형태(spread·computed key·중복 key·
   literal이 아닌 값·선언 둘)는 "변경 없음"이 아니라 **거절**입니다.

   base에 그 파일이 아직 없는 **최초 landing**에는 baseline 파일이 대조
   대상이었습니다. 같은 commit 안의 두 파일 대조이므로 더 약한 주장이었고,
   출력도 그렇게 적었습니다. **그 landing은 끝났고 baseline은 지웠습니다** —
   `lib/emailConsentCopy.ts`가 develop에 있으므로 이제 대조 대상은 base이고,
   그것이 이 검사가 원래 하려던 주장입니다.

   bootstrap 분기 자체는 script에 남습니다. 지우면 "base에 소스도 없고 baseline도
   없는" 경우가 명확한 실패가 아니라 crash가 되기 때문입니다. 그 경우는 지금도
   실패이고, baseline이 비었거나 버전 수가 다르거나 문서 절이 트리와 다르면
   **통과가 아니라 실패**입니다.

11. **새 문안이 의미를 바꾸는 경우에만** 해당합니다. 지금 현재 버전만 보는 검사는
   한국어 opt-in 문구, 세 종류 메일, 로그인 없는 철회, "보낸 적이 없다"는 시작
   문장, 독자 지칭, 닫기와 거부의 구분, 그리고 판촉성 표현 금지입니다. 이들은
   기본 인자로 현재 버전을 읽으므로, 예컨대 포르투갈어 누락만 고친 새 버전은
   그대로 통과합니다. 의미를 바꾸는 버전이라면 기존 기대는 그 버전에 묶고 새
   기대를 따로 적으며, 그것은 테스트 수정이 아니라 **승인 대상의 변경**이므로
   여기 §10을 다시 읽습니다.

## 11. 버전 2026-09-29 — 동의 장치

§9.2의 결정(소유자, 2026-09-29)을 반영한 버전입니다. **바뀐 곳은 §11.D 본문의
포르투갈어 첫 절 하나**입니다 — `A Tomverse não enviou`가
`A Tomverse não lhe enviou`가 되어, 다른 대명사 언어들처럼 독자를 지칭합니다.
나머지 문안은 버전 `2026-09-23`과 같습니다. §10에 따라 `2026-09-23`의 절은
고치지 않았고, 그 버전에 저장된 `copyHash`는 계속 그 문안을 가리킵니다.

### 11.0 네 장치

| # | 장치 | 어디에 | 무엇을 기록하는가 |
|---|---|---|---|
| A | opt-in 체크박스 (미체크 상태) | 가입 흐름 | **동의** → DOI |
| B | 고지 문장 | 가입 흐름, A 옆 | `notice_shown` |
| C | 독립 거부 수단 | 가입 흐름, A와 **별개** | `objected` |
| D | 제품 내 일회성 안내 | 기존 계정의 다음 접속 | A·B·C와 같은 세 상태 |

### 11.A opt-in 체크박스 라벨

| 언어 | 문안 |
|---|---|
| ko | **이메일 광고성 정보 수신동의 (선택)** |
| en | Send me product news and offers by email (optional) |
| de | Produktneuigkeiten und Angebote per E-Mail erhalten (optional) |
| es | Quiero recibir novedades y ofertas por correo electrónico (opcional) |
| fr | Recevoir les actualités produit et les offres par e-mail (facultatif) |
| pt | Quero receber novidades e ofertas por e-mail (opcional) |
| zh | 接收产品资讯和优惠邮件（可选） |

### 11.B 고지 문장

| 언어 | 문안 |
|---|---|
| ko | 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 결제 영수증, 서비스 공지는 이 설정과 무관하게 발송됩니다. 언제든 로그인 없이 끄실 수 있습니다. |
| en | If you turn this on, Tomverse sends product updates, newsletters and promotions to the address on your account. Sign-in codes, billing receipts and service notices are sent whether or not you turn this on. You can turn it off at any time, without signing in. |
| de | Wenn Sie dies aktivieren, sendet Tomverse Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Rechnungsbelege und Servicehinweise werden unabhängig davon gesendet. Sie können es jederzeit ohne Anmeldung deaktivieren. |
| es | Si lo activas, Tomverse enviará novedades del producto, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos de facturación y los avisos de servicio se envían igualmente. Puedes desactivarlo en cualquier momento, sin iniciar sesión. |
| fr | Si vous l'activez, Tomverse envoie les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus de facturation et les avis de service sont envoyés dans tous les cas. Vous pouvez le désactiver à tout moment, sans vous connecter. |
| pt | Se você ativar, a Tomverse envia novidades do produto, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos de cobrança e avisos de serviço são enviados de qualquer forma. Você pode desativar a qualquer momento, sem fazer login. |
| zh | 开启后，Tomverse 会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、账单收据和服务通知无论是否开启都会发送。您可以随时关闭，无需登录。 |

### 11.C 독립 거부 수단 라벨

| 언어 | 문안 |
|---|---|
| ko | 광고성 이메일을 받지 않겠습니다 |
| en | I do not want marketing email |
| de | Ich möchte keine Werbe-E-Mails erhalten |
| es | No quiero recibir correos de marketing |
| fr | Je ne souhaite pas recevoir d'e-mails marketing |
| pt | Não quero receber e-mails de marketing |
| zh | 我不想接收营销邮件 |

### 11.D 제품 내 일회성 안내 (기존 계정)

**제목**

| 언어 | 문안 |
|---|---|
| ko | 제품 소식을 이메일로 받아보시겠습니까? |
| en | Would you like product news by email? |
| de | Möchten Sie Produktneuigkeiten per E-Mail erhalten? |
| es | ¿Quieres recibir novedades del producto por correo? |
| fr | Souhaitez-vous recevoir les actualités produit par e-mail ? |
| pt | Quer receber novidades do produto por e-mail? |
| zh | 是否希望通过邮件接收产品动态？ |

**본문**

| 언어 | 문안 |
|---|---|
| ko | Tomverse는 지금까지 제품 소식을 보내드린 적이 없고, 요청하지 않으시면 앞으로도 보내지 않습니다. 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다. 언제든 로그인 없이 끄실 수 있습니다. |
| en | Tomverse has not sent you product news, and will not unless you ask. Turning this on sends product updates, newsletters and promotions to the address on your account. Sign-in codes, receipts and service notices are unaffected. You can turn it off at any time, without signing in. |
| de | Tomverse hat Ihnen bisher keine Produktneuigkeiten gesendet und wird dies ohne Ihre Zustimmung auch nicht tun. Wenn Sie dies aktivieren, senden wir Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Belege und Servicehinweise bleiben unberührt. Sie können es jederzeit ohne Anmeldung deaktivieren. |
| es | Tomverse no te ha enviado novedades del producto y no lo hará a menos que lo pidas. Si lo activas, enviaremos novedades, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos y los avisos de servicio no cambian. Puedes desactivarlo en cualquier momento, sin iniciar sesión. |
| fr | Tomverse ne vous a pas envoyé d'actualités produit et ne le fera pas sans votre demande. Si vous l'activez, nous enverrons les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus et les avis de service ne changent pas. Vous pouvez le désactiver à tout moment, sans vous connecter. |
| pt | A Tomverse não lhe enviou novidades do produto e não enviará a menos que você peça. Se ativar, enviaremos novidades, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos e avisos de serviço não mudam. Você pode desativar a qualquer momento, sem fazer login. |
| zh | Tomverse 尚未向您发送过产品动态，未经您同意也不会发送。开启后，我们会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、收据和服务通知不受影响。您可以随时关闭，无需登录。 |

**세 버튼**

| 역할 | ko | en | de | es | fr | pt | zh |
|---|---|---|---|---|---|---|---|
| 동의 | 네, 받겠습니다 | Yes, send them | Ja, senden | Sí, quiero recibirlas | Oui, envoyez-les | Sim, pode enviar | 好，请发送 |
| 거부 | 받지 않겠습니다 | No, thank you | Nein, danke | No, gracias | Non, merci | Não, obrigado | 不用了 |
| 닫기 | 나중에 | Not now | Später | Ahora no | Plus tard | Agora não | 以后再说 |

## 12. 버전 2026-09-29 승인란

| 절 | 내용 | 승인 |
|---|---|---|
| §11 | 동의 장치 4개의 문안 — §9.2 포르투갈어 첫 절 수정 | **mposition, 2026-09-29** |

**승인된 문안의 digest**(버전 `2026-09-29`, §11의 장치 4개 × 7개 언어 전체):

`sha256:5715eda191c074d0f81006fd1297d5620f2bd06f503fdb9bb4f7abc2fa2176fc`

코드의 문안이 이 값과 다르면 테스트가 실패합니다. 이 줄을 고치는 것은 승인된
기록을 고치는 것이고, §10이 금지하는 편집입니다.
