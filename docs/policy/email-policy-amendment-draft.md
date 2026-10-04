# 방침·약관 개정 (S10) — 승인됨 2026-10-03

**상태: 승인됨 (mposition, 2026-10-03), 시행일 2026-11-16.** §2·§2.1·§3.1·§4·§5·§8을 승인했습니다. 아래는 승인 전의 설명을 그대로 둔 것입니다. 이 문서의 문안은 소유자 승인 전이었습니다. 승인되면 페이지에 게시하고,
게시된 버전의 digest를 `APPROVED_AMENDED_DIGESTS`에, 변경 고지의 template
version `contentHash`를 `POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES`에 적습니다
(`lib/emailPolicyPublication.ts`, `lib/policyChangeNoticeEmail.ts`). 그 두 목록이
비어 있는 동안 release notes 게이트는 닫혀 있고, 변경 고지 template으로 캠페인을
만들 수도 없습니다.

근거: [제품 소식 재설계](email-product-news-redesign-draft.md) §4.4·§5.6·§10·§12(S10),
[동의 문안](email-consent-copy-draft.md) §5·§6(승인됨, 2026-09-23)·§9.1(결정 B).

## 1. 무엇을 고치는가

현행 `/privacy`는 **"신청하신 경우에만 제품 소식·뉴스레터·프로모션을 보냅니다"**
라고 약속합니다. 이미 승인된 두 결정이 이 약속과 어긋납니다.

- **결정 F**(2026-09-16): 기존 계정에 `risk_accepted`로, 동의 없이 제품 소식을
  보냅니다(docs/policy/email-product-news-redesign-draft.md §5.6). 대상은 승인 때 봉인한 **계정과 주소의 목록**이며, 주소를
  바꾼 계정은 빠집니다. 법이 허용해서가 아니라 기록된 사업 결정입니다.
승인된 §6의 두 문장은 그 약속을 그대로 둡니다. 그래서 이 초안은 약속 문장
자체를 고칩니다. 뉴스레터와 프로모션은 지금처럼 **신청한 경우에만**이고, 바뀌는
것은 **제품 소식**뿐입니다.

**"보낼 수 있다"로 씁니다.** 봉인 목록은 기존 계정의 일부이고 안내를 본 계정·주소를
바꾼 계정은 빠지므로, 안내 전 가입 계정 모두가 받는 것은 아닙니다. 정책이 허락하는
범위를 적는 문장이지, 누가 받는지를 단정하는 문장이 아닙니다. 그리고 **닫는 문장을
씁니다**("그 밖에는 신청하신 경우에만") — 없으면 이 문장은 다른 경로를 배제하지
않습니다.

**"안내 전"의 경계는 봉인 시각입니다.** 발송 함수는 안내 시각을 모르고, 봉인은
`approvedAt`보다 늦게 만들어진 계정을 넣지 않습니다(`lib/emailSendApprovalCohort.ts`).
그러므로 봉인은 **고지를 보내기 전에**, 결정 F의 `approvedAt`으로 합니다. 고지 뒤에
더 늦은 `approvedAt`으로 봉인하면 그 사이 가입한 계정이 이 문장 밖에서 받게 됩니다.

**호주 추론 동의는 이 개정의 문장에 들어가지 않습니다.** 관계(docs/policy/email-product-news-redesign-draft.md §4.4, R4 결정
2026-09-29)는 가입 화면의 고지가 시작 사건인데, 승인된 가입 고지(동의 문안 3.B·11.B)는
"켜시면 보내 드립니다"이고 결정 B(2026-09-29)가 그 약속을 유지했습니다. 그 화면을 본
사람에게 관계로 보내면 화면과 모순되므로, S5b는 **관계 발송을 고지한 가입 문안
버전**을 본 계정에만 관계를 기록합니다(그 버전 목록은 S5b가 두며, 오늘 0개). 그리고 관계는 가입지가 아니라 발송 시점의 수신자 rule과 겹쳐 판정되므로
"호주나 미국에서 가입한 계정"으로 적을 수도 없습니다. 추론 동의를 쓰려면 소유자가
(1) 관계 발송을 알리는 가입 고지 문안과 (2) 그 범위를 적은 `/privacy` 문장을 함께
승인해야 하며, 그것은 이 개정 뒤의 별도 개정입니다. 관련 콘텐츠 범위(docs/policy/email-product-news-redesign-draft.md §4.4)는 Tomverse
서비스 자체의 소식이며, 별개 제품군의 교차판매는 제품 소식에 들어가지 않습니다.
수신자별 기능 필터는 없으므로 그 범위는 사람이 캠페인을 승인할 때 내용으로 지킵니다.

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
> 프로모션은 신청하신 경우에만 보냅니다. 제품 소식(Tomverse 서비스 소식)도
> 신청하신 분께 보내며, 이 개정이 안내되기 전에 가입한 계정에는 신청하지
> 않으셨어도 보낼 수 있습니다. 그 밖에는 신청하신 경우에만 보냅니다. 로그인
> 코드·영수증·서비스 안내가 아닌
> 메일은 모두 이메일 설정에서 또는 해당 메일의 수신거부 링크를 눌러 로그인 없이
> 언제든 끄실 수 있습니다.

**개정안 (en)**

> Tomverse sends you email at the address on your account: sign-in codes and
> security notices, billing receipts and service status notices. These three
> are part of providing the service and cannot be switched off. Newsletters and
> promotions are sent only if you ask for them. Product updates (news about the
> Tomverse service) are sent if you ask for them, and may be sent without your
> asking to accounts that were registered before this change was announced.
> Otherwise they are sent only if you ask for them. Everything other than sign-in
> codes, receipts and service notices can be turned off at any time in your
> email settings or with the one-click unsubscribe link in any such message,
> without signing in.

이어서 승인된 §6의 두 문장(동의는 철회 시까지 유효, 한국 2년 고지)을 붙입니다.
나머지 문장은 그대로 둡니다. 다른 다섯 언어는 게시 때 같은 뜻으로 옮기며, 그
번역도 이 절의 승인 대상입니다.

### 2.1 7개 언어 전문 — 승인 대상 (2026-10-03 작성)

각 언어의 `privacyPolicy.email`에서 **첫 두 문장을 "대체 문장"으로 바꾸고**, 셋째
문장("이를 위해…" / "To do this…")부터 끝까지는 현행 그대로 둔 뒤, 맨 끝에 "추가
문장"을 붙입니다. ko·en은 위 §2와 [동의 문안](email-consent-copy-draft.md) §6의 문장 그대로이고,
zh·de·es·fr·pt는 같은 뜻으로 옮긴 번역입니다. 승인되면 이 표의 바이트가 게시되는
문안이며, 게시 후 digest가 `APPROVED_AMENDED_DIGESTS`에 들어갑니다.

| 언어 | 대체 문장 (현행 첫 두 문장 대신) | 추가 문장 (조항 끝에) |
|---|---|---|
| ko | Tomverse는 계정에 등록된 주소로 로그인 코드와 보안 알림, 결제 영수증, 서비스 상태 안내를 보냅니다. 이 셋은 서비스 제공에 속해 끌 수 없습니다. 뉴스레터와 프로모션은 신청하신 경우에만 보냅니다. 제품 소식(Tomverse 서비스 소식)도 신청하신 분께 보내며, 이 개정이 안내되기 전에 가입한 계정에는 신청하지 않으셨어도 보낼 수 있습니다. 그 밖에는 신청하신 경우에만 보냅니다. 로그인 코드·영수증·서비스 안내가 아닌 메일은 모두 이메일 설정에서 또는 해당 메일의 수신거부 링크를 눌러 로그인 없이 언제든 끄실 수 있습니다. | 수신동의는 철회하실 때까지 유효하며 만료되지 않습니다. 한국에서 수신 중이신 경우, 2년마다 수신동의 사실을 알려 드립니다. |
| en | Tomverse sends you email at the address on your account: sign-in codes and security notices, billing receipts and service status notices. These three are part of providing the service and cannot be switched off. Newsletters and promotions are sent only if you ask for them. Product updates (news about the Tomverse service) are sent if you ask for them, and may be sent without your asking to accounts that were registered before this change was announced. Otherwise they are sent only if you ask for them. Everything other than sign-in codes, receipts and service notices can be turned off at any time in your email settings or with the one-click unsubscribe link in any such message, without signing in. | A marketing consent stays in effect until you withdraw it and does not expire. If you receive marketing email in Korea, we tell you about that consent every two years. |
| zh | Tomverse 会向您账号登记的地址发送邮件：登录验证码与安全通知、账单收据和服务状态通知。这三类属于服务提供的一部分，无法关闭。新闻通讯和促销信息仅在您主动订阅后发送。产品动态（关于 Tomverse 服务的消息）会在您订阅后发送；对于在本次变更公布之前注册的账号，即使您未订阅也可能发送。除此之外，仅在您订阅后发送。除登录验证码、收据和服务通知以外的所有邮件，您都可以随时在邮件设置中关闭，或点击该类邮件中的一键退订链接关闭，无需登录。 | 营销邮件同意在您撤回之前一直有效，不会过期。如果您在韩国接收营销邮件，我们会每两年告知您一次该同意的事实。 |
| de | Tomverse sendet Ihnen E-Mails an die in Ihrem Konto hinterlegte Adresse: Anmeldecodes und Sicherheitshinweise, Rechnungsbelege und Hinweise zum Servicestatus. Diese drei gehören zur Bereitstellung des Dienstes und lassen sich nicht abschalten. Newsletter und Werbeaktionen werden nur versendet, wenn Sie darum bitten. Produktneuigkeiten (Neuigkeiten zum Tomverse-Dienst) werden versendet, wenn Sie darum bitten, und können ohne Ihre Anfrage an Konten gesendet werden, die vor der Ankündigung dieser Änderung registriert wurden. Ansonsten werden sie nur versendet, wenn Sie darum bitten. Alles außer Anmeldecodes, Belegen und Servicehinweisen können Sie jederzeit in Ihren E-Mail-Einstellungen oder über den Ein-Klick-Abmeldelink in einer solchen Nachricht abschalten, ohne sich anzumelden. | Eine Einwilligung in Werbe-E-Mails gilt, bis Sie sie widerrufen, und läuft nicht ab. Wenn Sie Werbe-E-Mails in Korea erhalten, informieren wir Sie alle zwei Jahre über diese Einwilligung. |
| es | Tomverse le envía correos a la dirección de su cuenta: códigos de inicio de sesión y avisos de seguridad, recibos de facturación y avisos sobre el estado del servicio. Estos tres forman parte de la prestación del servicio y no pueden desactivarse. Los boletines y las promociones solo se envían si los solicita. Las novedades de producto (noticias sobre el servicio Tomverse) se envían si las solicita y pueden enviarse sin que lo haya pedido a las cuentas registradas antes de que se anunciara este cambio. En los demás casos, solo se envían si las solicita. Todo lo que no sean códigos de inicio de sesión, recibos y avisos del servicio puede desactivarse en cualquier momento en sus ajustes de correo o con el enlace de baja de un clic incluido en ese tipo de mensajes, sin iniciar sesión. | El consentimiento para recibir correos de marketing sigue vigente hasta que lo retire y no caduca. Si recibe correos de marketing en Corea, le recordaremos ese consentimiento cada dos años. |
| fr | Tomverse vous envoie des e-mails à l'adresse enregistrée sur votre compte : codes de connexion et avis de sécurité, reçus de facturation et avis d'état du service. Ces trois types font partie de la fourniture du service et ne peuvent pas être désactivés. Les infolettres et les promotions ne sont envoyées que si vous les demandez. Les actualités produit (nouvelles concernant le service Tomverse) sont envoyées si vous les demandez et peuvent être envoyées sans demande de votre part aux comptes créés avant l'annonce de cette modification. Dans les autres cas, elles ne sont envoyées que si vous les demandez. Tout ce qui n'est pas un code de connexion, un reçu ou un avis de service peut être désactivé à tout moment dans vos paramètres d'e-mail ou via le lien de désabonnement en un clic présent dans ce type de message, sans vous connecter. | Un consentement aux e-mails marketing reste valable jusqu'à ce que vous le retiriez et n'expire pas. Si vous recevez des e-mails marketing en Corée, nous vous rappelons ce consentement tous les deux ans. |
| pt | A Tomverse envia e-mails para o endereço registrado na sua conta: códigos de acesso e avisos de segurança, recibos de cobrança e avisos sobre o estado do serviço. Esses três fazem parte da prestação do serviço e não podem ser desativados. Newsletters e promoções são enviadas somente se você solicitar. Novidades do produto (notícias sobre o serviço Tomverse) são enviadas se você solicitar e podem ser enviadas sem solicitação para contas registradas antes do anúncio desta alteração. Nos demais casos, são enviadas somente se você solicitar. Tudo o que não for código de acesso, recibo ou aviso do serviço pode ser desativado a qualquer momento nas configurações de e-mail ou pelo link de cancelamento em um clique presente nessas mensagens, sem precisar entrar na conta. | O consentimento para e-mails de marketing permanece válido até que você o retire e não expira. Se você recebe e-mails de marketing na Coreia, lembraremos você desse consentimento a cada dois anos. |

**쓰지 않은 것**: `risk_accepted`라는 말, 그리고 "법이 허용하는 경우"라는 설명.
앞의 것은 독자에게 의미 없는 내부 이름이고, 뒤의 것은 사실이 아닙니다 — 기존
계정에는 어느 법역에서도 근거가 없고(docs/policy/email-product-news-redesign-draft.md §5.5), 그 발송은 기록된 결정입니다.

## 3. `/terms` — 추가 조항

[동의 문안](email-consent-copy-draft.md) §5의 조항을 그대로 씁니다(승인됨,
2026-09-23). `/terms`는 en·ko·zh 세 언어이고, zh는 게시 때 같은 뜻으로 옮깁니다.
게시하면 "최종 업데이트" 날짜가 시행일로 바뀝니다.

### 3.1 zh 번역 — 승인 대상 (2026-10-03 작성)

> **营销邮件同意。** 您的同意在您撤回之前一直有效，没有固定的到期时间。您可以随时在邮件设置中，或通过任何营销邮件中的退订链接撤回同意，**无需登录**。撤回同意不会停止登录验证码、账单收据或服务通知的发送。

## 4. 변경 고지 — `policy_change_notice`

`legal` 분류, purpose 없음, 수신거부 링크 없음. 수신거부한 분에게도 갑니다
([이메일 알림](email-notifications.md) §3.1의 5번 유형). 문안은
`lib/emailTemplateDefinitions.ts`의 amendment notice 절에 7개 언어로 있고(Prompt
Refiner의 봉인된 closure를 늘리지 않으려고 그 파일에 둡니다), 승인 목록과 승인 판정은
`lib/policyChangeNoticeEmail.ts`에 있습니다. 영어 본문은 이렇습니다.

> We are updating the Tomverse Privacy Policy and Terms and Conditions. The
> changes take effect on {{effectiveDate}}.
>
> Tomverse may send product update emails (news about the Tomverse service)
> without your asking to accounts that were registered before this change was
> announced. Otherwise we send them only if you ask. You can turn them off at any time in
> your email settings or with the unsubscribe link in any such message, without
> signing in. Sign-in codes, receipts and service notices are not affected.
>
> A marketing email consent stays in effect until you withdraw it. If you
> receive marketing email in Korea, we will remind you of that consent every two
> years.
>
> Read the updated documents: /privacy, /terms
>
> You are receiving this because it is a notice about the terms of your account.
> It is sent whatever your email settings are.

**승인하는 것은 보내질 바이트 그대로입니다.** 고지에는 payload가 없고, 시행일은
`POLICY_CHANGE_NOTICE_EFFECTIVE_DATE`로 코드에 있습니다. 그래서 template version의
`contentHash`가 곧 수신자가 받는 고지 본문이고(발송 때 관할 footer의 사업자 식별이 덧붙습니다), 캠페인 초안·승인, 모든 단건 enqueue와
테스트 발송, 캠페인 fan-out, 그리고 drain이 발송 직전에 그 문안이 승인된 것인지
다시 확인합니다. 배포로 문안이 바뀌면 큐는 새 문안을 옛 승인으로 보내지 않고
멈춥니다(`notice_wording_unapproved`). hash는 링크까지 포함하므로 production이
계산한 값을 승인합니다.

**고지 발송은 사람이 합니다.** 전 계정에 가는 되돌릴 수 없는 외부 발송이므로
자동화하지 않습니다. 시행일 **30달력일 전까지** 대상 계정 전원의 메일함에 도착해야
게이트가 인정합니다(`delivered`·`complained`, `deliveredAt` 기준).

## 5. 시행일

**2026-11-16 (월) — 소유자 결정 2026-10-03.** 게시일로부터 30일보다 늦어야 합니다.

이 날을 고른 이유: 승인 → 게시 release → 결정 F의 봉인 → 고지 발송까지
일주일 안팎을 잡고도, 고지가 시행일 30달력일 전(`noticeDeadline`: 2026-10-18 00:00 UTC 이전
도착)에 닿을 여유가 남는 날입니다. 이보다 이르면 게시·발송 일정이 하루만 밀려도 게이트가
`notice_period_too_short`로 남습니다. 두 문서가 같은 날을
보여야 하며, 다르면 게이트가 `effective_dates_differ`로 거절합니다. 고지의
`POLICY_CHANGE_NOTICE_EFFECTIVE_DATE`도 같은 날이어야 하고, 테스트가 셋을 묶습니다.

## 6. 개정하지 않는 것 (소유자 결정 2026-09-29)

- **로그인 화면 동의 문장** — 이메일 동의를 묶지 않습니다. 이메일은 가입 흐름의
  별도 opt-in 장치입니다(docs/policy/email-product-news-redesign-draft.md §5.1, L2). 문장은 그대로입니다.
- **동의 장치 문안** — 결정 B에 따라 "요청하지 않으면 보내지 않는다"는 약속을
  유지합니다(docs/policy/email-consent-copy-draft.md §9.1). 그 안내는 override가 실제로 메일을 보내는 사람에게는 보이지 않으므로
  약속은 보는 사람 모두에게 참입니다. 포르투갈어 수정은 새 버전
  `2026-09-29`로 반영했습니다(docs/policy/email-consent-copy-draft.md §11).

## 7. 승인란

| 절 | 내용 | 승인 |
|---|---|---|
| §2 | `/privacy` 이메일 조항 개정안 (7개 언어, §2.1) | **mposition, 2026-10-03** |
| §3.1 | `/terms` 조항 zh 번역 | **mposition, 2026-10-03** |
| §4 | 변경 고지 문안 (7개 언어) | **mposition, 2026-10-03** |
| §5 | 시행일 **2026-11-16** | **mposition, 2026-10-03** |
| §8 | 2년 고지 영어 본문 | **mposition, 2026-10-03** |

## 8. 2년 고지의 영어 본문 — 초안

[동의 문안](email-consent-copy-draft.md) §9.3의 결정(소유자, 2026-09-29): **누락**.
docs/policy/email-consent-copy-draft.md §4.1·§4.2처럼 §4.3도 영어 본문을 가집니다. 아래는 승인된 한국어 본문을 그대로
옮긴 것입니다. 첫 발송 기한이 2028년이므로 그 전에 승인하면 됩니다.

> Tomverse Pty Ltd holds your consent to receive marketing email, as follows.
>
> Address: {{emailAddress}}
> Two-yearly notice reference date: {{anchorLabel}} ({{anchorDate}})
> What you receive: {{purposeList}}
>
> If you want to keep receiving it, you do not need to do anything. If you do
> not, use the unsubscribe link below; it works straight away, without signing
> in.

**승인 전에 보실 점**: 첫 문장은 "수신동의를 보유하고 있다"고 말하는데, 이 고지는
`risk_accepted` 계정에도 가고 그 계정에는 동의가 없습니다(docs/policy/email-product-news-redesign-draft.md §7.7 — 그래서
기준일 라벨이 "가입일"입니다). 승인된 한국어 본문도 같은 문장입니다. 둘을 함께
고칠지, cohort용 첫 문장을 따로 둘지 정해 주셔야 합니다. 한국어를 바꾸는 것은
docs/policy/email-consent-copy-draft.md §10에 따라 새 버전입니다.
