# 이메일 발송 도메인과 DNS

계약: `docs/policy/email-notifications.md` §5.3, §14.1, §14.2, §17.3.
현황 확인: `npm run report:email-domains`, Admin Console의 **Email policy →
Sending domains**.

이 문서는 DNS 레코드를 **사람이** 등록하는 절차입니다. 저장소의 코드는 도메인을
만들지도, 검증하지도, 지우지도 않습니다 — 계정의 대외 신원과 우리가 소유하지
않은 DNS zone을 바꾸는 일이기 때문입니다.

**다음에 무엇을 할 수 있는지는 8절에 있습니다.** 남은 세 건은 모두 시간이나
사람의 결정을 기다리는 항목이라, 각각 무엇에 막혀 있고 풀렸다는 것을 무엇으로
아는지를 적어 두었습니다. 이어서 작업할 때 여기부터 읽으면 됩니다.

---

## 1. 오늘의 상태 (2026-08-21 확인)

| 항목 | 값 |
|---|---|
| 제공자에 등록된 도메인 | `tomverse.app`, `mail.tomverse.app` |
| `mail.tomverse.app` 상태 | `verified`, sending enabled (2026-08-21 등록·검증) |
| `mail.tomverse.app` 검증된 레코드 | DKIM(TXT `resend._domainkey.mail`), SPF(MX·TXT `send.mail`) |
| region | 둘 다 `ap-northeast-1` |
| DMARC | **제공자 레코드 집합에 없음.** zone에서 따로 확인해야 합니다 |
| transactional From | `hello@mail.tomverse.app` (2026-08-21 전환) |
| 발신자 역할 | 6개, 같은 도메인 위. 3a절 |
| marketing From | `news@news.tomverse.app` (2026-09-14 설정, 1.3절) |
| DNS | Cloudflare |

제공자의 suppression은 **team(계정) 전체**에 적용되며 그 계정의 모든 도메인과
서브도메인에 걸칩니다. 따라서 marketing을 분리하려면 도메인이 아니라 **계정**을
나눠야 합니다(A18 — §4.0에서 별도 계정으로 결정). `region`은 분리 수단이 아니라
지연·데이터 소재의 문제입니다. 2026-09-14 이전 이 문단은 범위를 "같은 region의
계정 전체"로 적고 있었고, 그 표현은 SES의 성질을 옮긴 것이라 정정했습니다
(`docs/ops/a18-resend-suppression-boundary.md` §1.1).

### 1.1 확인한 것과 확인하지 못한 것

| 항목 | 상태 |
|---|---|
| DKIM·SPF 검증 | **확인함.** 제공자 API `verified`, `dig`로 값 일치 확인 |
| DMARC 레코드 2건 | **확인함.** 아래 값 그대로 응답 |
| 외부 수신지 인증 레코드 | **불필요.** 아래 근거 |
| DMARC 리포트 수신 | **미확인.** `dmarc@tomverse.app` 사서함은 2026-08-21에 만들었다고 보고받았고, 실제 수신은 리포트가 와야 압니다 |
| `mail.tomverse.app` 첫 발송 | **미관측** (2026-08-21 09:20Z 기준). 1.2 참조 |
| 다른 발송 신원 3개 | **코드는 통합함**(1.2). 실제 발신 주소는 각 환경변수 반영 여부에 달려 있습니다 |

```
_dmarc.mail.tomverse.app   "v=DMARC1; p=none; rua=mailto:dmarc@tomverse.app; fo=1"
_dmarc.tomverse.app        "v=DMARC1; p=none; sp=none; rua=mailto:dmarc@tomverse.app; fo=1"
```

**`dig`는 이 저장소의 실행 환경에서 됩니다.** egress 프록시가 DNS-over-HTTPS
호스트(`cloudflare-dns.com`, `dns.google`)를 막지만 그것은 *HTTPS 목적지* 차단이고,
평범한 DNS 조회는 컨테이너가 늘 하는 일이라 영향받지 않습니다. `dnsutils`를 설치하면
`dig TXT _dmarc.mail.tomverse.app`이 그대로 동작합니다.

**외부 수신지 인증(`_report._dmarc`)이 필요 없는 이유.** RFC 7489 §7.1은 DMARC
레코드가 발견된 **Organizational Domain**과 `rua` URI 호스트의 Organizational
Domain이 다를 때만 인증 절차를 요구합니다 — 정확한 도메인 일치가 아니라 조직
도메인 비교입니다. 여기서는 양쪽 다 `tomverse.app`이므로
`mail.tomverse.app._report._dmarc.tomverse.app`은 두지 않아도 됩니다. 확인일
2026-08-21. `rua`를 조직 밖 주소(리포트 처리 서비스 등)로 바꾸는 순간 이 레코드가
필요해지고, 없으면 **리포트가 조용히 오지 않습니다.**

### 1.2 발송 신원은 하나의 resolver로 통합했습니다

2026-08-21 전환 직후 확인했을 때는 `TRANSACTIONAL_EMAIL_FROM`을 읽는 경로가 넷 중
하나뿐이었고, 나머지 셋은 각자의 변수와 각자의 하드코딩 fallback으로 Resend API를
직접 호출하고 있었습니다. 그래서 발송 도메인을 옮겼을 때 **하나만 따라왔고 아무도
알아채지 못했습니다.**

| 경로 | 전환 전 | 지금 |
|---|---|---|
| `lib/email.ts` | `TRANSACTIONAL_EMAIL_FROM` | `fromAddressForStream()` |
| `lib/operationalMonitoring.ts` | `ADMIN_ALERT_FROM` → 하드코딩 | `resolveSendingIdentity("transactional", …)` |
| `lib/providerMonitoring.ts` | `ADMIN_ALERT_FROM` → 하드코딩 (SendGrid 분기에 두 번째 복사본) | 동일 — SendGrid 분기는 M12에서 삭제(§1.2.1) |
| `scripts/send-security-audit-report.mjs` | GitHub secret → 하드코딩 | 동일 (pure core 경유) |

판정은 `lib/emailSendingIdentityCore.ts`의 `resolveSendingIdentity()` 한 곳에
있습니다. `lib/emailSendingIdentity.ts`는 `process.env`를 읽고 던지는 얇은 wrapper일
뿐이고, GitHub Actions 스크립트는 그 wrapper가 `server-only`라서 core를 직접
씁니다 — 그래서 workflow가 `node --import tsx`로 실행합니다.

**표시 이름은 하나로 합쳤습니다.** `Tomverse Operations`와 `Tomverse Admin` 구분은
원래 있던 자리이자 메일 클라이언트가 실제로 보여 주는 자리인 **제목 prefix**에
그대로 남습니다.

**직접 발송 경로는 유지했습니다.** 두 알림 경로는 outbox에 넣지 않습니다 — 시스템이
아프다는 알림이 큐를 비우는 부분에 의존하면 안 됩니다. 채널 실패 격리도 그대로입니다:
`operationalMonitoring`은 Slack·Discord·email을 `Promise.allSettled`로 돌리고 Sentry
capture는 그보다 앞서며, `providerMonitoring`은 신원을 못 구하면 던지지 않고
`failed`로 기록하고 넘어갑니다.

#### 1.2.1 발송 경로도 하나로 합쳤습니다 (M12)

발신 **주소**를 하나로 모은 다음에도 **발송 호출 자체**는 넷이었습니다. 세 경로가
각자 `fetch("https://api.resend.com/emails")`를 직접 만들고 있었고, 같은 도메인을
쓰더라도 헤더·응답 본문 처리·오류 보고가 서로 달랐습니다. M12에서 이것을
`EmailProviderPort`로 모았습니다(정책 문서 §8.2).

| 경로 | M12 전 | 지금 |
|---|---|---|
| `lib/email.ts` | 자체 fetch **두 벌**(`deliverEmailOnce`, `sendTransactionalEmail`) | `emailProvider().send()` |
| `lib/operationalMonitoring.ts` | 자체 fetch | 동일 |
| `lib/providerMonitoring.ts` | 자체 fetch + SendGrid 분기 | 동일 (SendGrid 분기 제거) |
| webhook route | `verifySvixSignature()` 직접 호출 | `emailProvider().verifyWebhook()` |
| `scripts/send-security-audit-report.mjs` | 자체 fetch | **그대로** — GitHub Actions에서 `server-only`를 import할 수 없습니다 |

port는 **두 method뿐**입니다: `send`, `verifyWebhook`. 템플릿·연락처·세그먼트·
자동화는 port에 넣지 않습니다 — 우리 DB에 살아야 provider를 바꿀 때 옮길 것이 API
호출 스무 줄뿐이 됩니다. `npm run check:email-provider-port`가 (1) port를 우회하는
직접 발송, (2) port에 늘어난 method, (3) 선언된 surface와 상수의 불일치를 각각
실패시킵니다. 감사 리포터의 예외는 그 script 안에 이유와 함께 적혀 있습니다.

**SendGrid 분기는 삭제했습니다.** 어떤 환경 예제도 `SENDGRID_API_KEY`를 적지 않았고,
readiness 검사도 runbook도 그것을 몰랐습니다. 설정된 적 없는 두 번째 provider가
provider 장애를 알리는 경로 안에 있었던 셈입니다.

#### 1.2.2 스트림별 provider 계정 키

port는 스트림마다 다른 API 키를 읽습니다.

| 스트림 | 읽는 변수 (순서대로) |
|---|---|
| transactional | `TRANSACTIONAL_RESEND_API_KEY` → `RESEND_API_KEY` |
| marketing | `MARKETING_RESEND_API_KEY` (**fallback 없음**) |

오늘 배포에 필요한 것은 `RESEND_API_KEY` 하나뿐이며 동작은 바뀌지 않습니다.
transactional의 전용 이름은 계정을 나눌 때를 위한 자리이고, **marketing에 fallback이
없는 것이 요점**입니다. Resend의 suppression은 team(계정) 전체 범위라(정책 문서
§5.3.1) transactional 계정으로 프로모션을 보내면 그 스팸 신고와 수신 거부가 로그인
코드의 전달 여부를 정하는 목록에 얹힙니다. 도메인을 나눠도 그것은 나뉘지 않으며,
어느 계정을 쓸지는 아직 열린 결정입니다(§5.3.1 결정 2, A18). 정해지기 전까지
marketing은 빌리지 않고 거절합니다.

#### 검사가 두 곳에 있는 이유

`/api/ready`의 `emailSendingIdentity`는 **배포된 프로세스의 환경**만 봅니다. GitHub
Actions runner의 변수는 볼 수 없습니다. 그래서 같은 resolver를 두 곳에서 각각
확인합니다.

| 무엇 | 어디 |
|---|---|
| 배포 환경의 신원 | `/api/ready` |
| runner 환경의 신원 | daily-security-audit workflow의 preflight (`npm run check:sending-identity -- --env`) |
| 코드에 하드코딩된 발신자 | PR Fast Gate (`npm run check:sending-identity`) |

정적 검사는 `from:` 바로 뒤의 리터럴을 찾지 **않습니다.** 그 규칙이었다면 문제가
있던 트리에서 그대로 통과했을 것입니다 — 네 경로 모두 리터럴이 key 옆이 아니라
fallback 뒤에 있었으니까요. 대신 값의 모양을 봅니다: `"이름 <주소@도메인>"` 형태와,
`from`이 있는 줄의 자기 도메인 주소. `tests/sendingIdentity.test.mjs`가 **2026-08-21
당시의 네 줄을 그대로 넣어** 각각 잡히는지 고정합니다.

#### 남은 것: 루트 도메인은 아직 발송합니다

세 경로가 새 도메인으로 옮겨져도 루트에서 나가는 메일이 사라지는 것은 아닙니다.
purelymail(사람이 쓰는 메일함)이 계속 `tomverse.app`에서 보냅니다. §2의 "루트는
발송하지 않음"은 여전히 목표이지 현재 상태가 아닙니다.

> **전환 뒷정리로 Resend에서 `tomverse.app` 도메인을 지우지 마세요.** 세 경로가
> 옮겨지기 전까지는 그들이 DKIM을 잃습니다. 루트 SPF는 `include:_spf.purelymail.com`
> 이라 SES를 덮은 적이 없으므로, DKIM이 사라지면 DMARC가 통과할 근거가 남지
> 않습니다.

### 1.3 marketing 스트림 실측 (2026-09-14)

§4.1의 1~5가 끝났습니다. 아래는 의도 진술이 아니라 **조회 결과**입니다.

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| `news.tomverse.app` DNS 4종 | `npm run report:email-dns -- news.tomverse.app` | DKIM·SPF TXT·Return-Path MX·DMARC 모두 응답, Return-Path가 `ap-northeast-1` |
| 제공자 `verified` | marketing 계정 콘솔 (사람이 확인) | verified, sending enabled |
| production 환경변수 | Railway production 서비스의 변수 **이름** 목록 | `MARKETING_EMAIL_FROM`·`MARKETING_RESEND_API_KEY`·`EMAIL_UNSUBSCRIBE_KEYS`·`EMAIL_BUSINESS_LEGAL_NAME`·`EMAIL_BUSINESS_POSTAL_ADDRESS`·`EMAIL_BUSINESS_CONTACT_EMAIL`·`EMAIL_BUSINESS_ABN` 존재 |
| `/api/ready` | `curl https://tomverse.app/api/ready` | `emailSendingIdentity`·`emailUnsubscribeKeyring`·`emailBusinessIdentity` 모두 `true` |

읽은 것은 **변수 이름뿐이고 값이 아닙니다.** 이름이 있다는 것은 비어 있지 않다는
뜻이 아니므로, 값이 실제로 쓸 수 있는지를 말하는 것은 `/api/ready`의
`emailBusinessIdentity`입니다 — 그 검사는 세 universal block이 **공백이 아닌 값**을
가질 때만 `true`이기 때문입니다(`lib/emailBusinessIdentity.ts`).

**일부러 없는 것 둘.** `EMAIL_BUSINESS_REGISTRATION_NUMBER`와
`EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER`는 설정돼 있지 않고, 설정하지
않는 것이 맞습니다 — 발송 주체가 한국 통신판매업 신고 대상이 아니어서 값이
존재하지 않습니다(2026-09-14 확인). 한국 profile이 두 block을 더 이상 이름 대지
않도록 고치는 변경은 `claude/to-develop/email-marketing-activation`에 있습니다.

> **footer가 모든 수신자에게서 빠져 있었습니다 (2026-08-23 ~ 2026-09-15).**
> 2026-09-14에 이 자리에 적었던 진단 — "한국 profile이 이름 댄 등록번호 두 개가
> 비어서 한국 수신자의 footer가 빠진다" — 은 **틀렸습니다.** 증상은 더 넓었고
> 원인은 다른 것이었습니다.
>
> `/admin/email-policy` 확인 결과(2026-09-15), 활성 policy version은
> `2026-08-21.1`이고 **프로필 0개 · 국가 0개**였습니다. 이것은 사람이 만든 것이
> 아니라 첫 발송 때 `ensureBootstrapPolicyVersion()`
> (`lib/emailTemplateRegistry.ts`)이 자동으로 만들어 `active`로 올린 bootstrap
> version이고, 생성·활성화 시각이 둘 다 2026-08-23 11:06입니다. 그리고 목록에
> 그 version 하나뿐이었습니다 — `2026-08-21.jurisdictions.1`은 **만들어진 적이
> 없습니다.**
>
> 발송 경로는 seed 상수가 아니라 `JurisdictionProfile` 행을 읽으므로
> (`lib/standardEmailLane.ts`), 행이 없으면 `composeJurisdictionalMessage()`가
> `profile_missing`으로 갈라집니다(`lib/emailJurisdictionComposition.ts`).
> 그 갈래는 관할권을 가리지 않습니다.
>
> | | |
> |---|---|
> | transactional | **모든 수신자**에게 사업자 footer 없이 발송됩니다 |
> | marketing | `jurisdiction_profile_missing`으로 **전량 거부**됩니다 |
> | `/api/ready` | 계속 `true`. 이 검사는 환경변수 값을 보고 행을 보지 않습니다 |
> | 유일한 신호 | 발송마다 남는 `email_jurisdiction_footer_degraded` |
>
> **고치는 데 배포가 필요 없었습니다.** `main`에는 9개 profile이 이미 전부
> 올바르게 들어 있었고(KR의 수정된 blocks, CH, EU·CH의 `abn`), 빠진 것은 그
> 코드로 행을 만드는 행위 하나였습니다 — `/admin/email-policy`의 `초안 생성`과
> 활성화(§12.3 2인 승인). 이미 발송된 delivery는 렌더링 당시 version을
> 유지하므로 소급되지 않습니다.
>
> **재발 방지는 두 곳입니다.** `tests/emailJurisdictionSeed.test.mjs`가 profile
> 내용의 digest를 기록해, 내용이 바뀌었는데 version이 그대로면 실패합니다.
> 그리고 `JURISDICTION_POLICY_SEED_VERSION`의 주석이 "언제 올리고 언제 올리지
> 않는가"를 적습니다 — 행이 아직 없는 동안의 수정은 제자리 편집이 맞고, 그때
> version을 올리면 내용이 같은 version이 둘 생깁니다.
>
> **남는 공백 하나.** 행이 하나도 없는 상태를 `/api/ready`도 다른 어떤 검사도
> 보지 않습니다. 3주 동안 이것을 말해 준 것은 구조화 이벤트뿐이었고, 아무도
> 그것을 세고 있지 않았습니다.

## 2. 목표 상태

| 용도 | 도메인 | 비고 |
|---|---|---|
| transactional | `mail.tomverse.app` | `hello@tomverse.app`에서 이전 |
| marketing | `news.tomverse.app` | marketing 활성화 시점에 신설 + warm-up |
| 루트 | `tomverse.app` | 발송하지 않는 것이 목표. **오늘은 아직 발송합니다** — 1.2 |

---

## 3. transactional 도메인 이전 (§17.3 1~4단계)

**2026-08-21에 3.1~3.3과 3.5를 실행했습니다.** 절차는 아래에 그대로 남겨 둡니다 —
`news.tomverse.app`에서 다시 쓰이고, 무엇이 왜 필요한지가 기록이기 때문입니다.
실제로 밟은 순서와 남은 것은 3.0에 적습니다.

### 3.0 실행 기록 (2026-08-21)

| 단계 | 상태 |
|---|---|
| 3.1 도메인 등록 | 완료. `ap-northeast-1`, Return-Path `send`, 추적 off |
| 3.2 DMARC 레코드 | 완료. `dig`로 두 레코드 모두 확인(1.1) |
| 3.3 DKIM·SPF 검증 | 완료. 세 레코드 모두 `verified` |
| 3.4 2주 관측 | **아직 하지 않음** |
| 3.5 From 전환 | 완료. `hello@mail.tomverse.app` |
| 3.6 정책 강화 | 아직 |

**3.4와 3.5의 순서가 계약과 다릅니다.** §17.3은 2주 관측 뒤에 전환하고, 전환 전에
기존 도메인에서 안내 메일을 한 번 보내라고 합니다. 실제로는 전환이 먼저
일어났고, 발송 로그에 안내 메일은 없습니다.

이것은 승인이 아니라 기록입니다. 나중에 쓰는 문장이 미리 받지 않은 승인을 만들어
낼 수는 없습니다. 다만 이 순서가 무엇을 바꿨는지는 적어 둘 수 있습니다.

- **관측이 사전이 아니라 사후가 됐습니다.** `p=none`이므로 수신자가 메일을 버리지는
  않습니다. 대신 정렬이 깨져 있었다면 그 사실을 리포트가 아니라 **도달률 하락으로**
  먼저 알게 됩니다. 그래서 첫 리포트를 평소보다 빨리, 그리고 반드시 봐야 합니다.
- **필터를 잃은 사용자에게 예고가 없었습니다.** `hello@tomverse.app`으로 규칙을
  만들어 둔 사람은 로그인 코드가 규칙에 안 걸리는 상태를 예고 없이 만나게 됩니다.
  사후 안내라도 보낼지는 사람의 판단이고, 보낸다면 **새 도메인에서** 보내는 것이
  맞습니다 — 기존 도메인에서 보내면 이미 바뀐 사실과 어긋납니다.
- **되돌리기는 환경변수 한 줄입니다.** `TRANSACTIONAL_EMAIL_FROM`을 되돌리면 다음
  발송부터 이전 도메인으로 돌아갑니다. 새 도메인은 verified 상태로 남습니다.

### 3.1 도메인 등록

제공자 콘솔에서 `mail.tomverse.app`을 **`ap-northeast-1`에** 추가합니다.
region이 다르면 기존 suppression 목록과 분리되는데, 그것은 A18에서 결정할
사안이지 이전 작업에서 우연히 일어날 일이 아닙니다.

등록하면 제공자가 레코드 3종을 발급합니다. **값은 도메인마다 다르므로 여기에
적지 않습니다** — 콘솔이 보여 주는 값을 그대로 씁니다.

| 레코드 | 이름 | 형식 |
|---|---|---|
| DKIM | `resend._domainkey.mail` | TXT, `p=...` 공개키 |
| SPF (Return-Path) | `send.mail` | MX, `feedback-smtp.<region>.amazonses.com`, priority 10 |
| SPF | `send.mail` | TXT, `v=spf1 include:amazonses.com ~all` |

`send.*` 서브도메인이 §14.1이 요구하는 **커스텀 Return-Path**입니다. 제공자가
이미 이 형태로 발급하므로 bounce 도메인 정렬은 추가 작업이 없습니다.

**SPF의 10 DNS lookup 한도**: 위 TXT는 include가 하나뿐입니다. 다른 발송 서비스를
같은 이름에 추가할 때만 문제가 되며, 그때는 레코드를 합치지 말고 발송 서비스마다
서브도메인을 나눕니다.

### 3.2 DMARC — 제공자가 해 주지 않는 유일한 레코드

`p=none`으로 시작해 리포트만 모읍니다. 두 곳에 넣습니다.

```
_dmarc.mail.tomverse.app   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@tomverse.app; fo=1"
_dmarc.tomverse.app        TXT   "v=DMARC1; p=none; sp=none; rua=mailto:dmarc@tomverse.app; fo=1"
```

루트에도 두는 이유는 §14.1이 말하는 그대로입니다. 루트 정책이 없으면 서브도메인
정책을 나중에 조일 때 기준이 없고, `sp=`를 명시하지 않으면 서브도메인이 루트
정책을 상속합니다 — 즉 루트를 `p=reject`로 올리는 순간 아직 준비되지 않은
서브도메인까지 함께 올라갑니다.

`rua` 주소는 실제로 받을 수 있어야 합니다. 리포트는 하루에 수십 통씩 오는 XML
이므로 사람 받은편지함이 아니라 전용 주소나 리포트 처리 서비스로 보냅니다.

### 3.3 검증

```
npm run report:email-domains
```

`mail.tomverse.app`이 `verified`로 나오고 DKIM·SPF 레코드가 모두 `verified`가
될 때까지 기다립니다. 이 보고서는 **DMARC를 확인하지 않습니다** — 제공자가 그
레코드를 발급하지도, 상태를 보고하지도 않기 때문입니다. DNS 쪽은 다음으로
봅니다.

```
npm run report:email-dns
```

`*_EMAIL_FROM`에 설정된 도메인을 기본으로 보고, 아직 설정 전인 도메인은 인자로
넘깁니다(`-- news.tomverse.app`). DMARC를 포함해 네 레코드를 함께 봅니다.

### 3.4 2주 관측

`p=none` 상태로 최소 2주. 리포트에서 확인할 것:

- 우리가 보낸 메일이 SPF·DKIM 양쪽에서 **정렬(alignment)**되는가
- 우리가 모르는 발송원이 이 도메인을 쓰고 있지 않은가

**이번에는 이 관측이 실트래픽 위에서 돌아갑니다**(3.0). 전환이 먼저 일어났으므로
관측 기간에 나가는 메일이 곧 사용자에게 가는 메일입니다. 두 가지가 달라집니다.

1. **첫 리포트를 기다리지 말고 확인합니다 — 단, 시계는 첫 발송부터입니다.**
   집계 리포트는 *우리 메일을 받은 쪽*이 만듭니다. `mail.tomverse.app`에서 아직
   아무것도 안 나갔다면 보고할 것이 있는 수신자가 없으므로 리포트가 없는 것이
   정상입니다. DNS를 바꾼 시점이 아니라 **그 도메인에서 첫 메일이 나간 시점**부터
   24시간을 셉니다. (이 문장이 없던 초판은 전환 직후의 침묵을 장애로 읽게 만들었고,
   2026-08-21 09:20Z 시점에도 첫 발송은 아직 없었습니다.)

   **두 종류의 침묵은 루트 리포트로 구분됩니다.** 루트 `_dmarc.tomverse.app`은
   purelymail과 1.2의 세 경로를 이미 덮고 있으므로, 우리가 새 도메인에서 한 통도
   보내지 않아도 루트 리포트는 옵니다. 루트 리포트는 오는데 서브도메인 리포트만
   없다면 **사서함은 멀쩡하고 아직 안 보낸 것**입니다. 둘 다 안 오면 사서함이나
   `rua` 쪽을 봅니다.
2. **도달률을 함께 봅니다.** `EmailDelivery`의 bounce·complaint 비율(§14.5)이
   전환 전후로 움직이는지 봅니다. 새 도메인은 평판 이력이 없으므로 초기에 약간의
   지연이나 스팸함 분류가 있을 수 있고, 그것과 정렬 오류는 리포트로만 구분됩니다.

### 3.5 From 주소 전환 — 2026-08-21 완료

**사용자에게 미리 알립니다.** From 주소가 바뀌면 기존 도메인 주소로 만들어 둔
필터·규칙이 전부 무효가 됩니다. §17.3 3단계가 요구하는 안내 메일 1회를 **기존
도메인에서** 먼저 보냅니다.

그 다음 환경변수를 바꿉니다.

```
TRANSACTIONAL_EMAIL_FROM=Tomverse Insight <hello@mail.tomverse.app>
```

**환경변수를 먼저 배포하고 코드를 나중에** 배포하는 순서는 여기서는 해당하지
않습니다 — 코드는 이미 이 변수를 읽습니다. 바꾸는 즉시 다음 발송부터 적용됩니다.

전환 후 `/api/ready`의 `emailSendingIdentity` 경고
(`TRANSACTIONAL_ON_ROOT_DOMAIN`)가 사라집니다. 그 경고가 이 작업의 완료 신호이며,
**전환이 실제로 반영됐는지 확인하는 방법이기도 합니다** — 환경변수를 바꿨다고
믿는 것과 배포된 프로세스가 그 값을 읽는 것은 다른 사실입니다. 경고가 남아 있으면
값이 반영되지 않은 것입니다.

#### 3.5.1 staging 실측 검증 (2026-08-21 23:56Z)

`/api/admin/test-email`이 staging에서 실제로 보낸 메일의 헤더입니다. §14.1의 네
요구가 전부 실물로 확인됐습니다 — 설정값을 읽은 것이 아니라 수신자가 판정한
결과입니다.

| §14.1 요구 | 헤더 | 판정 |
|---|---|---|
| From이 발송 서브도메인 | `From: Tomverse Insight <hello@mail.tomverse.app>` | 통과 |
| DKIM | `d=mail.tomverse.app; s=resend` → `dkim=pass` | 통과, **strict 정렬** |
| Return-Path를 우리 서브도메인으로 | `<…@send.mail.tomverse.app>` | 통과 |
| SPF | `spf=pass`, `23.251.234.59` (SES ap-northeast-1) | 통과 |
| DMARC | `dmarc=pass (p=NONE sp=NONE) header.from=mail.tomverse.app` | 통과 |

**DMARC가 두 축 모두에서 정렬됩니다.** DKIM의 `d=`가 From 도메인과 정확히 같고
(strict), SPF의 MAIL FROM이 `send.mail.tomverse.app`이라 relaxed로 정렬됩니다.
한쪽에만 걸친 상태가 아니므로, 한 축이 깨져도 다른 축이 DMARC를 지탱합니다.

`p=none`은 계획대로이며 3.4의 관측 기간입니다. 이 발송이 그 시계의 기준이 되는
발송 중 하나입니다.

#### 3.5.2 `GET /domains` 401은 고장이 아닙니다

staging에서 `npm run report:email-domains`가 이렇게 답합니다.

```
  transactional  mail.tomverse.app
  marketing      not configured

  The provider answered 401 when listing domains.
```

Resend API 키에는 권한 등급이 있고, **sending 전용 키는 `POST /emails`는 되지만
`GET /domains`는 401**입니다. staging의 키가 그것입니다 — 같은 키로 위 3.5.1의
메일이 실제로 나갔으므로 발송은 정상이고, 읽지 못하는 것은 도메인 목록뿐입니다.

그래서 staging에서는 이것이 **정상 상태**입니다.

- `npm run report:email-domains`의 provider 구획이 비어 있고 findings가 없습니다.
  보고서가 도메인을 하나도 못 읽었을 때 findings를 만들지 않는 것은 의도된
  동작입니다 — 빈 목록에서 유도한 findings는 이미 있는 도메인을 다시 만들라고
  사람을 보냅니다.
- Admin의 **Sending domains** 탭도 같은 이유로 오류를 표시합니다.

**틀린 키와 sending 전용 키는 같은 401로 나옵니다.** 구분은 실제 발송뿐입니다 —
Admin → Overview → **Send test email**. 메일이 오면 sending 전용 키이고, 실패하면
키가 무효입니다.

화면과 보고서가 401일 때 이 문장을 함께 출력하므로, 매번 이 문서를 찾지 않아도
됩니다. **2026-08-24 확인: production에서 sending 전용 키로 확정**됐습니다
(테스트 발송 도착).

**어느 키를 읽는지도 2026-08-24에 통일했습니다.** 도메인 조회는
`process.env.RESEND_API_KEY`를 직접 읽고 있었고, 실제 발송은
`providerApiKeyFor()`가 `TRANSACTIONAL_RESEND_API_KEY`를 먼저 봅니다. 두 이름이
서로 다른 키를 담은 배포에서는 **보내는 키와 조회하는 키가 달라지고**, 그때의 401은
도메인에 대한 사실처럼 보입니다. 네 곳(도메인 조회, 이 보고서 script,
security environment 검사, Admin 환경 화면)이 모두 resolver를 지나도록 바꿨고,
`npm run check:sending-identity`가 직접 읽기를 정적으로 막습니다.

`/api/ready`의 `emailSendingIdentity`로는 구분되지 않습니다. **그 검사는 API 키를
아예 보지 않습니다** — 주소 문자열의 파싱과 스트림 간 도메인 분리만 판정하므로,
401 키를 가진 배포도 readiness를 통과합니다.

#### 3.5.3 운영자 알림 경로는 Admin에서 시험 발송합니다

3.5.1은 **제품 메일 경로**(`lib/email.ts`)를 확인한 것입니다. 운영자 알림 두
경로는 그것과 다른 코드이고, **진짜 장애 조건에서만** 호출됩니다 — 운영 알림은
`reportOperationalIncident` 안에서, provider 알림은 예산·잔액이 바닥날 때입니다.
그래서 오랫동안 일부러 실행시킬 방법이 없었고, **그것이 1.2의 드리프트를 아무도
보지 못한 이유입니다.** 아무것도 평소에 그 경로들을 지나가지 않았습니다.

**Admin → Alerts → Templates → "Operator alert paths"** 에서 경로별로 시험
발송합니다. 각 버튼은 그 경로의 **자기 발송 함수**를 호출하고, provider가 실제로
받아들인 From 주소와 message id를, 실패했으면 그 이유를 화면에 돌려줍니다.

| 실패 코드 | 뜻 | 조치 |
|---|---|---|
| `RECIPIENT_NOT_CONFIGURED` | 수신 주소 환경변수가 없음 | `OPS_ALERT_EMAIL`/`ADMIN_ALERT_EMAIL` 설정 |
| `PROVIDER_KEY_MISSING` | transactional 스트림용 API 키 없음 | `RESEND_API_KEY` 설정 |
| `TRANSACTIONAL_FROM_UNPARSEABLE` 등 | 발신 신원 해석 실패 | 14.1의 변수 확인 |
| `NO_RESPONSE` | provider에 닿지 못함 | 일시적일 수 있음, 재시도 |
| `HTTP_4xx`/`HTTP_5xx` | provider가 거절 | 상태 코드별로 판단 |

**통과가 무엇을 뜻하는지 화면에 적혀 있습니다.** 이 시험은 *경로가 보낼 수 있다*는
것만 보이며, *그것을 불러야 할 조건이 여전히 그것을 부른다*는 것은 보이지
않습니다. 화면이 그렇게 말하는 이유는, 확인한 것보다 많은 것을 암시하는 컨트롤이
없는 것보다 나쁘기 때문입니다.

provider 경로의 시험은 `AdminNotificationLog`에 진짜 알림과 똑같은 행을 남깁니다.
이는 부작용이 아니라 의도입니다 — 이 경로가 실패하면 그 실패는 운영자의 알림
로그와 미확인 실패 배지에 나타나야 하고, 그곳이 진짜 실패가 갔을 자리입니다.

#### 3.5.4 staging 알림 경로 실측 (2026-08-22 01:39Z)

3.5.3의 두 버튼을 눌러 실제로 도착한 메일의 헤더입니다. 이로써 **staging에서 세
발신 경로 중 둘이 확정**됐습니다.

| | ① Operational | ② Provider |
|---|---|---|
| Subject | `[Tomverse Operations] Sending path test` | `[Tomverse Admin] Sending path test` |
| From | `Tomverse Insight <hello@mail.tomverse.app>` | 동일 |
| DKIM | `d=mail.tomverse.app` pass | pass |
| SPF | `send.mail.tomverse.app` pass | pass |
| DMARC | pass | pass |

제목 prefix가 서로 다르게 찍힌 것도 계약대로입니다. M12에서 표시 이름을 하나의
transactional identity로 합치면서 "Operations"와 "Admin" 구분을 **제목 prefix로**
옮겼고(1.2), 그 결정이 실물에서 확인됩니다.

**남은 것은 ③ 보안 감사 리포트뿐입니다.** GitHub Actions runner의 변수를 쓰므로
배포 환경과 무관하며, Actions → Daily Security Audit → Run workflow로만 확인됩니다.

##### 관측된 값 하나: Outlook SCL 5

provider 알림 쪽 헤더에 `X-MS-Exchange-Organization-SCL: 5`가 찍혔습니다
(operational 쪽은 1). Outlook에서 5는 스팸 판정 구간이고, 받은편지함에 들어온 것은
수신자가 발신자를 신뢰 목록에 두고 있기 때문입니다 — 같은 헤더의 `wl:1`,
`OFR:TrustedSenderList`, `dest:I`가 그것을 말합니다.

**실패가 아니라 3.4가 관측하라고 한 신호입니다.** 새 도메인은 평판 이력이 없어
초기에 이런 점수가 나올 수 있고, 신뢰 목록에 없는 수신자에게는 정크로 갈 수
있습니다. 거의 같은 두 메일이 1과 5로 갈린 것은 특정 트리거보다 경계선상 판정으로
보이며, 2주 관측 기간에 `EmailDelivery`의 bounce·complaint 비율과 함께 지켜볼
값입니다.

**production 검증 때의 비교 기준으로 남깁니다.** production에서 같은 두 버튼을
눌렀을 때 SCL이 이보다 나쁘면 도메인 평판이 아니라 그쪽 설정을 의심할 근거가
됩니다.

#### 3.5.5 production 실측 (2026-08-22 02:45Z)

staging과 같은 절차를 production에서 반복했습니다.

**발신 주소 — 발송 없이**

```
npm run check:sending-identity -- --env
  source        TRANSACTIONAL_EMAIL_FROM
  transactional Tomverse Insight <hello@mail.tomverse.app>

npm run report:email-domains
  transactional  mail.tomverse.app
  marketing      not configured
  The provider answered 401 when listing domains.
```

`source`가 `TRANSACTIONAL_EMAIL_FROM`이라는 것은 컴파일된 fallback도 구형
`EMAIL_FROM`도 아닌 **명시적으로 설정된 변수**를 읽었다는 뜻이고,
`TRANSACTIONAL_ON_ROOT_DOMAIN` 경고가 **뜨지 않은 것**이 서브도메인 전환이 이
프로세스에 반영됐다는 증거입니다. 401은 3.5.2와 같은 sending 전용 키입니다.

**알림 두 경로 — 실제 발송**

3.5.3의 두 버튼. 둘 다 도착했고 `From: Tomverse Insight <hello@mail.tomverse.app>`,
DKIM `d=mail.tomverse.app` pass, SPF `send.mail.tomverse.app` pass, DMARC pass.
실제 발송이 성공했으므로 "sending 전용 키"와 "무효한 키"의 구분도 함께
확정됐습니다(3.5.2).

##### SCL은 설정을 가리키지 못합니다 — 3.5.4의 기준을 정정합니다

3.5.4는 "production SCL이 staging보다 나쁘면 그쪽 설정을 의심할 근거"라고
적었습니다. **틀렸습니다.** production은 둘 다 SCL 5였고(staging은 operational 1,
provider 5), 두 환경의 DKIM body hash를 대조하면 같습니다.

```
operational  bh=n8liCWDInI1YnGAUhvmdXEmO6Cwddaniwa4DnB/SlZg=   staging = production
provider     bh=vD98GoHdU+QkrnzBnDiGsKwH8t0r+39X+q5LRfToZn8=   staging = production
```

**바이트 단위로 같은 메시지가 한 번은 1, 한 번은 5를 받았습니다.** 같은 도메인,
같은 발신 주소, 같은 provider, 같은 인증 결과입니다. 그러므로 SCL은 배포나 설정의
차이를 판별하는 값이 아니라 평판과 시점에 따라 움직이는 수신자 측 판단입니다.

남는 사실은 **`mail.tomverse.app`이 아직 Outlook의 스팸 판정 구간에 걸린다**는
것이고, 네 통 모두 받은편지함에 들어온 것은 수신자의 신뢰 목록(`wl:1`,
`OFR:TrustedSenderList`) 덕분입니다. 이력 없는 새 도메인이라 3.4가 예상한
상태이며, 관측 대상은 SCL 개별 값이 아니라 실트래픽의 bounce·complaint 비율입니다.

#### 3.5.6 ③ 감사 리포트 경로는 정기 실행으로 확인합니다 (미기록)

**의도적으로 건너뛴 구획입니다.** 무엇을 왜 건너뛰었는지 적어 둡니다.

확인되지 않은 것은 "감사 script가 그 주소로 실제 발송하는가" 하나입니다. runner가
읽을 입력값은 Settings → Variables에서 그대로 보이고(발신 주소는 secret이 아니라
**variable**입니다), 그 문자열을 resolver가 어떻게 처리하는지는 같은 문자열로
staging·production 두 환경에서 확인했습니다.

**수동 dispatch를 강행하지 않았습니다.** 21:00 UTC 정기 실행이 같은 답을 비용 없이
주기 때문입니다 — 그 리포트 메일의 `From:`이 증거입니다.

그리고 이 판단을 하다가 preflight의 배치가 잘못돼 있는 것을 발견했습니다. "Check
the sending identity"가 발송 직전, 즉 **1.8시간짜리 E2E 스위트 뒤**에 있었습니다.
발송 전이라는 성질은 맞지만, "runner가 어느 주소를 해석하는가"를 한 줄 보려고
1.8시간을 기다려야 했습니다. **읽는 데 1.8시간이 드는 검사는 아무도 읽지 않습니다.**
`node_modules`만 있으면 되므로 install 바로 뒤로 옮겼고, 여전히 리포트 발송보다
앞입니다.

#### 3.5.7 첫 실제 alert가 잡은 것 — Cloudflare Email Address Obfuscation (2026-08-22 04:30Z)

3.5.3의 시험 발송은 "경로가 살아 있는가"만 답합니다. 시험이 아닌 첫 alert는
2026-08-22 04:30:36Z에 왔고, 경로가 **실제 사고에서도 동작한다**는 것과 그 사고가
무엇인지를 함께 알려 줬습니다.

메일 자체: `From: Tomverse Insight <hello@mail.tomverse.app>`, DKIM `d=mail.tomverse.app`
pass, SPF `send.mail.tomverse.app` pass, DMARC pass. 시험 발송과 같은 신원입니다.
`documentUri`가 `staging.tomverse.app`이므로 **보낸 것은 staging 배포**이고,
production 경로는 3.5.5의 실측이 별도로 증명합니다.

**메일 본문의 URL을 그대로 읽으면 안 됩니다.** 수신함에서 본 본문에는
`documentUri`·`blockedUri`가 `na01.safelinks.protection.outlook.com/?url=...`로 보였는데,
이는 **Outlook이 수신 메일의 모든 URL을 재작성한 결과**이지 보고된 값이 아닙니다.
코드상 그 값은 저장될 수 없습니다 — `isTrustedCspDocumentUri()`가 허용 host를
요구하므로 safelinks host의 report는 버려지고, `sanitizeCspReportedUrl()`은
`origin + pathname`만 남기므로 `?url=`이 붙을 수 없습니다(둘 다 `lib/cspReportCore.ts`).
실제 값은 다음과 같습니다.

| 필드 | 값 |
|---|---|
| documentUri | `https://staging.tomverse.app/auth/admin-reauthenticate` |
| blockedUri | `https://staging.tomverse.app/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js` |
| violatedDirective | `script-src-elem` |
| disposition | `enforce` |

**원인.** Cloudflare **Email Address Obfuscation**이 켜져 있었습니다. 이 기능은 HTML
안의 주소를 `[email protected]`으로 바꾸고 decode script를 edge에서 주입합니다.
주입된 tag에는 nonce가 없습니다. `/auth/admin-reauthenticate`는 로그인한 운영자의
주소를 그립니다(`app/(site)/(application)/auth/admin-reauthenticate/page.tsx`의
`email={session?.user?.email || null}` → `AdminReauthenticationCard`의
`Current account:`). Cloudflare 문서상 이 기능은 **가입 시 자동으로 켜집니다** — 누가
켠 것이 아닙니다.

**두 policy가 다르게 판정했습니다.** 이것이 이 건의 요점입니다.

| 경로 | script-src | 결과 |
|---|---|---|
| `/support` 등 marketing | `'self' 'sha384-…'` (strict-dynamic 없음) | `'self'`가 살아 있어 **허용** — 주소는 정상 복원, 보고 없음 |
| `/chat`, `/auth/**` 등 app | `'self' 'nonce-…' 'strict-dynamic'` | `strict-dynamic`이 `'self'`를 무력화 → **차단**, 화면에 `[email protected]`이 남음 |

즉 **same-origin이라는 이유로 안심할 수 없습니다.** same-origin은 두 policy 중
어느 쪽이 보고하느냐만 정하고, marketing 쪽에서는 build에 없는 script가 hash 회계
밖에서 조용히 실행되고 있었습니다.

**조치.** zone 전체에서 껐습니다(Security → Settings → Client-side abuse → Email
Address Obfuscation → Off). 코드 변경 없음 — 주입된 것은 `src=` tag라 marketing
policy의 inline `sha384` hash와 무관하고, 기능을 끄면 tag 자체가 사라집니다.

경로별 configuration rule로 좁히는 대신 zone 전체를 끈 이유는, 이 기능이 가리고
있던 주소가 두 종류뿐이기 때문입니다 — 법적 고지에 **공개하려고 적은**
`support@tomverse.app`, 그리고 인증 뒤에서 **본인에게만 보이는** 본인 이메일.
지키는 것이 없고 대가로 화면 하나가 깨집니다.

**확인 (2026-08-22 05:20Z).** 두 host 모두 `cf-cache-status: DYNAMIC`, 즉 캐시가 아닌
edge 실시간 응답입니다.

```
for h in tomverse.app staging.tomverse.app; do
  echo -n "$h: "; curl -sS "https://$h/support" | grep -c '__cf_email__'
done
```

| host | `__cf_email__` | `email-decode` | `support@tomverse.app` 원문 |
|---|---|---|---|
| `tomverse.app` | 0 | 0 | 1 |
| `staging.tomverse.app` | 0 | 0 | 1 |

**같은 계열의 두 번째입니다.** 첫 번째는 FINAL-F005(Browser Insights beacon)였고,
합의된 해법은 그때도 "CSP를 푸는 것이 아니라 Cloudflare에서 끈다"였습니다. 규칙과
두 사례의 차이는 `lib/csp.ts` 상단 주석에 적어 뒀습니다 — `/cdn-cgi/`를 allowlist에
넣고 싶어질 바로 그 자리입니다.

### 3.6 정책 강화 (Phase 2)

리포트가 깨끗하면 `p=quarantine`, 이후 `p=reject`. 각 단계 사이에 최소 2주.
루트의 `sp=`도 함께 올립니다.

**루트를 조일 때는 우리 발송만 보고 판단하면 안 됩니다.** `tomverse.app`은 자체
SPF(`v=spf1 include:_spf.purelymail.com ~all`)와 MX(`mailserver.purelymail.com`)를
가지고 있습니다 — 사람이 쓰는 메일함이 그 제공자에 있습니다. 루트의 `p=`를 올리면
그 경로로 나가는 메일도 함께 걸리므로, 리포트에서 **purelymail 경유 발송이 SPF·DKIM
정렬을 통과하는지** 먼저 확인해야 합니다. 발송 서브도메인만 보고 올리면 우리가 쓰는
메일함이 먼저 깨집니다. 서브도메인(`_dmarc.mail`)만 조이는 것은 이 제약과 무관하며,
그래서 두 레코드를 나눠 둔 것이기도 합니다.

---

## 3a. 발신자 역할과 필요한 mailbox

계약: `docs/policy/email-notifications.md` §14.1a.

한 도메인 위에 발신자가 여섯입니다. **DNS는 바뀌지 않습니다** — 역할 주소는
`TRANSACTIONAL_EMAIL_FROM`이 인증한 도메인 위에 있고, 그 도메인의 DKIM·SPF·DMARC가
이미 모든 local-part를 덮습니다. 새 서브도메인도, 새 환경변수도 없습니다.

현재 값(`TRANSACTIONAL_EMAIL_FROM=Tomverse Review <hello@mail.tomverse.app>`)
기준으로 해석되는 주소입니다.

| 역할 | From |
|---|---|
| `general` | `Tomverse Review <hello@mail.tomverse.app>` (설정값 그대로) |
| `security` | `Tomverse Security <security@mail.tomverse.app>` |
| `billing` | `Tomverse Billing <billing@mail.tomverse.app>` |
| `support` | `Tomverse Support <support@mail.tomverse.app>` |
| `operations` | `Tomverse Operations <alerts@mail.tomverse.app>` |
| `marketing` | `MARKETING_EMAIL_FROM` (미설정, 발송 거부) |

확인 명령:

```
npm run check:sending-identity -- --env
```

### 3a.1 발송 전용 주소이고 수신 사서함이 아닙니다

**이 다섯 주소로 오는 답장은 아무도 읽지 않습니다.** 저장소에도 운영 문서에도
`security@`·`billing@`·`support@`·`alerts@` **on `mail.tomverse.app`** 이 메일을
받는다는 근거가 없고, 없는 사서함을 있다고 가정하지 않습니다.

그래서 Reply-To를 씁니다. 대상은 이미 문서화된 수신 주소 하나뿐입니다.

| 변수 | 문서 | 역할 |
|---|---|---|
| `EMAIL_BUSINESS_CONTACT_EMAIL` | `docs/ops/email-business-identity.md` | footer의 연락처이자 Reply-To |

- 설정돼 있으면 `general`·`security`·`billing`·`support` 메일에 `Reply-To`가
  붙습니다.
- **설정돼 있지 않으면 헤더를 붙이지 않습니다.** 역할 도입 이전과 동일한 동작이며,
  아무도 읽지 않는 Reply-To는 없는 것보다 나쁩니다 — 답장이 접수된 뒤 사라집니다.
- `operations`와 `marketing`에는 붙지 않습니다. 운영 알림은 이미 팀이 읽는
  주소로 가고, 장애에 대한 답장이 고객지원 큐로 들어가면 아무에게도 도움이
  되지 않습니다.
- `no-reply@`는 도입하지 않습니다.

**운영자가 확인할 것.** `support@tomverse.app`은 `/support`와 모든 언어의 법적
고지가 공개하는 주소이고 `EMAIL_BUSINESS_CONTACT_EMAIL`의 문서화된 값이지만,
**production 환경변수에 실제로 설정돼 있는지는 이 저장소가 알 수 없습니다.**
설정돼 있지 않으면 footer의 `contact_email` 블록도 이미 빠져 있다는 뜻이므로
(`email_jurisdiction_footer_degraded` 경고), 그쪽부터 확인합니다.

### 3a.2 답장을 실제로 받고 싶다면

역할 주소 자체를 수신 가능하게 만드는 것은 **이 저장소 밖의 작업**이고, 지금은
필요하지 않습니다. 필요해지면 순서는 이렇습니다.

1. `mail.tomverse.app`에 MX를 두거나(현재 없음), Resend의 inbound를 켜거나,
   각 주소를 `support@tomverse.app`으로 forwarding 합니다.
2. 실제 수신을 확인합니다 — 설정했다는 것과 도착한다는 것은 다른 사실입니다.
3. 그 뒤에 `docs/policy/email-notifications.md` §14.1a의 Reply-To 대상을
   바꿉니다.

**1번을 하기 전에는 하지 않습니다.** MX 없는 도메인의 주소로 답장을 유도하면
답장이 bounce하고, bounce는 발신 도메인 평판에 얹힙니다.

## 4. marketing 도메인 (`news.tomverse.app`)

### 4.0 A18 결정 (2026-09-14)

**별도 Resend 계정을 씁니다.** 같은 계정 안에 team을 추가하는 쪽은 team 생성에
유료 플랜이 요구되어 채택하지 않았고, 대신 **로그인이 다른 두 번째 계정**을
만들었습니다. suppression 경계는 **team/계정**이므로(§5.3.1, 표현 정정은
`docs/ops/a18-resend-suppression-boundary.md` §1.1) 두 스트림의 억제 목록은
분리됩니다.

> **2026-08-26 실측, 2026-09-14 재확인**: transactional 계정에 등록된 도메인은
> `mail.tomverse.app`과 `tomverse.app` 둘뿐이고 둘 다 region `ap-northeast-1`,
> suppression 등재 0건입니다. **`news.tomverse.app`은 아직 등록돼 있지
> 않습니다** — §4.1이 미착수라는 뜻이며, 의도 진술이 아니라 조회 결과입니다.

따라오지 않는 것: §5.3.1 **결정 3**(이메일 외 로그인 수단 의무화)은 같은 계정을
유지할 때의 조건이므로 적용되지 않습니다.

계속 따라오는 것: §5.3.1 **결정 4** — **hard bounce 억제는 계속 공유합니다.**
주소가 없다는 사실은 스트림과 무관하며, 이제 provider가 그것을 대신 해 주지
않으므로 **우리 `SuppressionEntry`가 유일한 공유 지점**입니다
(`lib/emailSuppression.ts`, `GLOBAL_PURPOSE_KEY`). 어느 계정에서 난 bounce든
우리 테이블에 기록돼야 양쪽이 같이 멈춥니다.

남은 선행 조건은 **Q8** 하나입니다 — footer에 넣을 법인명·사업자등록번호·
통신판매업 신고번호·주소·ABN의 실제 값. 값이 없으면
`renderJurisdictionFooter()`가 발송을 거부하므로, 도메인만 세워 두고 warm-up을
시작할 수는 없습니다.

### 4.1 실행 순서

> **주의 — 어느 계정에서 하는지.** 저장소 세션의 Resend MCP 연결과
> `npm run report:email-domains`는 **transactional 계정**을 봅니다. 아래 1~3은
> **marketing 계정 콘솔에 로그인한 상태에서** 합니다. 도구로 만들면 옛 계정에
> 도메인이 생깁니다.

> **1~5는 완료됐습니다 (2026-09-14).** 네 레코드가 모두 조회되고 Return-Path가
> `ap-northeast-1`을 가리키며, 콘솔 쪽 `verified`는 운영자가 확인했고, production
> 환경변수도 배포돼 `/api/ready`의 이메일 검사 셋이 모두 `true`입니다. 실측은
> §1.3에 있습니다. **남은 것은 6번의 배포 후 재확인 이후 — 즉 7번 warm-up과
> 8번 flag 해제**이고, 둘 다 이 문서 밖의 선행 조건을 기다립니다(§8).

1. **도메인 등록** — marketing 계정에서 `news.tomverse.app` 추가. region은
   특별한 이유가 없으면 기존과 같은 `ap-northeast-1`(§3.1과 같은 이유이며,
   **region은 억제 분리 수단이 아닙니다** — 계정이 이미 나뉘어 있습니다).
2. **DNS 3종** — 콘솔이 발급한 값을 그대로 넣습니다(§3.1과 같은 형태).

   | 레코드 | 이름 | 형식 |
   |---|---|---|
   | DKIM | `resend._domainkey.news` | TXT, `p=...` |
   | SPF (Return-Path) | `send.news` | MX, `feedback-smtp.<region>.amazonses.com`, priority 10 |
   | SPF | `send.news` | TXT, `v=spf1 include:amazonses.com ~all` |

3. **DMARC** — 제공자가 발급하지 않으므로 직접 넣습니다.

   ```
   _dmarc.news.tomverse.app   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@tomverse.app; fo=1"
   ```

   `rua`가 `tomverse.app`이고 발송 도메인도 그 아래이므로 **외부 수신 승인
   레코드는 필요 없습니다.** 루트 레코드는 §3.2에서 이미 넣었으므로 다시 넣지
   않습니다.

4. **검증** — DNS 쪽은 명령 하나로 끝나고, 콘솔 쪽은 사람이 봅니다.

   이 컨테이너에서 실행합니다(에이전트가 직접). 자격증명이 필요 없습니다:

   ```
   npm run report:email-dns -- news.tomverse.app
   ```

   DKIM·SPF TXT·Return-Path MX·DMARC 넷을 한 번에 보고, 빠진 것을 **한꺼번에**
   나열합니다. **DMARC를 함께 보는 것이 요점입니다** — 제공자는 그 레코드를
   발급하지도 않고 없다고 알려 주지도 않으므로, 콘솔의 `verified`만 보면 DMARC가
   없는 도메인이 준비된 것처럼 보입니다.

   `npm run report:email-domains`는 **transactional 계정만** 보므로 여기서는
   `news.`가 나오지 않는 것이 정상입니다. 그쪽은 제공자에게 묻고 이쪽은 DNS에
   물으므로, 두 보고가 어긋나는 것이 이상한 상태가 아닙니다.

   **콘솔에서 `verified` 확인은 사람이 합니다** — marketing 계정은 이 세션의
   도구가 닿지 않습니다.

5. **환경변수** — 코드보다 **먼저** 배포합니다(§17.4).

   ```
   MARKETING_RESEND_API_KEY=<marketing 계정에서 발급한 키>
   MARKETING_EMAIL_FROM=Tomverse <news@news.tomverse.app>
   EMAIL_UNSUBSCRIBE_KEYS=v1:<base64 32바이트>
   EMAIL_BUSINESS_LEGAL_NAME=...            # 이하 Q8
   EMAIL_BUSINESS_POSTAL_ADDRESS=...
   EMAIL_BUSINESS_CONTACT_EMAIL=...
   EMAIL_BUSINESS_ABN=...                             # AU·EU·CH profile
   ```

   - `MARKETING_RESEND_API_KEY`에는 **fallback이 없습니다.** transactional 키를
     빌려 쓰지 않습니다(`lib/emailProviderPortCore.ts`).
   - `EMAIL_UNSUBSCRIBE_KEYS`는 `MARKETING_EMAIL_FROM`이 설정되는 순간
     `/api/ready`의 **필수** 항목이 됩니다(`lib/emailUnsubscribeReadiness.ts`).
     형식과 생성법은 `EMAIL_SNAPSHOT_KEYS`와 같습니다 —
     `docs/ops/email-snapshot-keyring.md` §1~2를 그대로 쓰되 변수 이름만 바꿉니다.
     키가 하나면 `EMAIL_UNSUBSCRIBE_KEY_VERSION`은 두지 않습니다.
   - **`EMAIL_CONSENT_KEYS`** (2026-09-15 추가) — marketing 동의 확인 링크의 키링.
     `EMAIL_UNSUBSCRIBE_KEYS`와 **같은 조건으로** `MARKETING_EMAIL_FROM`이 있으면
     `/api/ready`의 필수 항목입니다(`lib/emailConsentReadiness.ts`). 수신거부 키와
     **다른 값**을 씁니다 — 두 토큰이 서로를 대신할 수 없어야 하기 때문입니다
     (docs/policy/email-double-opt-in.md §4.3). production은 이미
     `MARKETING_EMAIL_FROM`이 있으므로 **double opt-in 코드를 배포하기 전에** 이
     변수를 먼저 넣습니다.
   - `EMAIL_BUSINESS_*`는 **하나라도 비면 footer 전체가 사라지고** 그 profile의
     모든 메일이 거부됩니다(`lib/emailBusinessIdentity.ts`).
   - `EMAIL_BUSINESS_REGISTRATION_NUMBER`와
     `EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER`는 **목록에 없습니다.**
     발송 주체가 한국 통신판매업 신고 대상이 아니어서 값이 존재하지 않고,
     한국 profile도 2026-09-14부터 두 block을 이름 대지 않습니다. 자리표시자를
     넣는 것은 신원을 확인 가능하게 하려고 존재하는 footer에 **거짓 신원을
     넣는 것**이므로 하지 않습니다.

6. **검증** — 배포 후.

   ```
   npm run check:sending-identity -- --env
   npm run check:email-provider-port
   curl -s https://<host>/api/ready | jq '.checks[] | select(.name|test("email"))'
   ```

   `STREAMS_SHARE_A_DOMAIN`·`MARKETING_FROM_UNPARSEABLE`·
   `EMAIL_UNSUBSCRIBE_KEYS_MISSING`이 없어야 합니다.

7. **warm-up** — §14.6(4~6주, 1주차 일 50통, 매주 배증, 가장 최근 동의자부터).
   **발송 플랜 한도를 먼저 확인합니다**: 무료 구간(월 3,000통·일 100통)은
   2주차(일 100통)에서 일 한도에 닿고 3주차(일 200통)에서 넘습니다. warm-up을
   완주하려면 marketing 계정도 그 전에 유료 전환이 필요합니다.

8. `feature.emailMarketingEnabled` 해제는 **그 뒤**입니다. 이 항목은 이 문서가
   아니라 `docs/policy/email-notifications.md` §15.2의 조건(Q1·Q2·Q8)을 따릅니다.

### 4.2 왜 환경변수가 fallback을 갖지 않는가

```
MARKETING_EMAIL_FROM=Tomverse <news@news.tomverse.app>
```

이 변수가 없으면 marketing 발송은 **transactional 주소로 대체되지 않고
거부됩니다**(`MARKETING_FROM_MISSING`). 대체는 프로모션 스팸 신고를 로그인 코드가
나가는 도메인에 얹는 일이고, 증상은 로그인 메일이 안 온다는 신고로만 나타납니다.
두 스트림을 같은 도메인에 설정하면 `/api/ready`가 실패합니다
(`STREAMS_SHARE_A_DOMAIN`).

### 4.3 계정마다 webhook이 따로입니다

계정이 둘이면 webhook도 둘입니다. 각 Resend 계정의 대시보드(Webhooks)에서 **자기
경로**를 등록하고, 그 webhook의 signing secret을 **자기 변수**에 넣습니다.

| 계정 | 등록할 URL | secret 변수 |
|---|---|---|
| transactional | `https://<host>/api/webhooks/email/resend/transactional` (기존 `/api/webhooks/email/resend`도 같은 계정으로 계속 받습니다) | `RESEND_WEBHOOK_SECRET` |
| marketing | `https://<host>/api/webhooks/email/resend/marketing` | `MARKETING_RESEND_WEBHOOK_SECRET` |

- marketing endpoint는 transactional secret을 **빌리지 않습니다.** 변수가 없으면 503을
  돌려주므로 사건은 Resend에 쌓이고 버려지지 않습니다.
- 사건은 받은 경로의 계정으로 저장되고, 메일 id는 **그 계정이 보낸 발송**에서만
  찾습니다(docs/policy/email-product-news-redesign-draft.md 7.4, C56·C72).
- 기존 transactional 등록 URL은 바꾸지 않아도 됩니다. 바꾸려면 새 경로를 먼저 추가하고
  사건이 들어오는 것을 확인한 뒤 옛 경로를 지웁니다.
- 계정이 하루 5통 이상 보냈는데 webhook이 0건이면 incident `EMAIL_WEBHOOK_SILENT_<계정>`이
  올라옵니다 — Resend가 실패가 반복된 endpoint를 비활성화했을 가능성을 먼저 봅니다.
- 두 secret 변수에 같은 값을 넣으면 두 endpoint가 모두 503입니다. 계정마다 자기 webhook의 secret을 넣습니다.

---

## 5. 대량 발신자 요건 (§14.2)

규모와 무관하게 처음부터 충족합니다.

- [x] SPF + DKIM — 제공자 발급, 위 3.1
- [~] DMARC — 레코드 확인 완료(1.1). 정렬 관측과 리포트 수신 확인은 아직(3.4)
- [x] marketing One-Click unsubscribe (RFC 8058) — `lib/emailUnsubscribeHeaders.ts`
- [x] 스팸 신고율 감시 — `docs/policy/email-notifications.md` §14.5
- [x] TLS 전송 — 제공자 기본
- [ ] 유효한 정방향/역방향 DNS — 공유 IP이므로 제공자 책임

## 6. 전용 IP

**하지 않습니다.** 월 발송량이 적을 때 전용 IP는 warm-up 트래픽이 부족해 공유
IP보다 나쁩니다. 재검토 시점은 marketing 단독 월 10만 통(§14.3).

## 7. BIMI

**하지 않습니다.** VMC 비용 대비 이점이 낮습니다(§14.1).

---

## 8. 다음 작업 — 무엇을 기다리는가 (2026-09-14 기준)

> **2026-09-14 정정.** 이 문단은 DMARC TXT 레코드를 이 컨테이너에서 확인할 수
> 없다고 적고 있었습니다. `dig`이 없는 것도 DNS-over-HTTPS가 프록시에 막히는
> 것(403)도 사실이지만, **Node의 resolver는 동작하며 아무도 시도하지
> 않았습니다.** 이제 `npm run report:email-dns`가 확인하고, `mail`·`news` 두
> 도메인 모두 네 레코드가 제자리에 있습니다. 저장소 밖으로 남는 것은
> `dmarc@tomverse.app`의 **수신 여부**뿐이며, 그것은 사서함이라 다른 종류의
> 사실입니다.

**8.3(A18)은 결정됐고, 8.0은 지금 할 수 있는 유일한 항목입니다. 남은 두 건은 착수
대기이지 안 한 일이 아닙니다.** 각각 저장소가 답할 수 없는
사실을 기다리고 있으므로, 기다리는 대상을 모른 채 시작하면 멈추거나 추측하게
됩니다. 그래서 항목마다 **무엇에 막혀 있는지**와 **풀렸다는 것을 무엇으로
아는지**를 함께 적습니다.

`npm run report:issue-backlog`의 `blocked` 판정과 같은 형식입니다 — 착수 가능한
후보가 아니라, 먼저 구해야 할 사실이 있는 항목입니다.

### 8.0 한국 profile footer — 수정이 아직 production에 없습니다

| | |
|---|---|
| 막혀 있는 것 | **배포.** 수정은 `claude/to-develop/email-marketing-activation`에 있고 develop 대상입니다 |
| 지금 일어나는 일 | 한국 profile로 해석되는 수신자의 **transactional** 메일에 footer가 통째로 빠집니다. marketing은 거부되지만 지금은 flag가 꺼져 있어 해당 발송이 없습니다 |
| 왜 조용한가 | `/api/ready`는 이것을 warning으로 보므로 `true`로 답합니다. 유일한 신호는 발송마다 남는 `email_jurisdiction_footer_degraded` |
| 언제부터 | 두 등록번호 변수는 설정된 적이 없으므로 footer가 생긴 때부터. 2026-09-14의 환경변수 설정이 만든 상태가 **아닙니다** |
| 풀렸다는 신호 | 수정이 `main`에 배포된 뒤 한국 수신자 메일에 명칭·주소·연락처·수신거부가 보이고, `email_jurisdiction_footer_degraded`가 그 경로에서 멈출 것 |

**환경변수로는 못 고칩니다.** 값이 없어서가 아니라 **존재하지 않는 값을 profile이
이름 대고 있어서**이므로, 고치는 것은 seed 쪽 한 줄입니다. 반대로 자리표시자를
넣으면 footer는 렌더되지만 신원 표시가 거짓이 됩니다 — 그 footer가 존재하는
이유를 스스로 무효로 만드는 쪽입니다.

### 8.1 2주 관측 → 정책 강화 (3.4 → 3.6)

| | |
|---|---|
| 막혀 있는 것 | **시간.** `mail.tomverse.app`에서 **첫 메일이 나간 시점**부터 2주 |
| 풀렸다는 신호 | `_dmarc.mail.tomverse.app` 앞으로 2주치 집계 리포트가 모였고, 그 안에서 SPF·DKIM이 **양쪽 다 정렬**되며 모르는 발송원이 없을 것 |
| 그 다음 | `p=none` → `p=quarantine` → (최소 2주) → `p=reject` |
| **가장 빠른 검토 가능일** | **2026-09-04** — 아래 근거 |

**시계의 시작점이 이제 계산됩니다.** Resend에서 `mail.tomverse.app`은
2026-08-21 07:56 UTC에 생성됐고 지금 `verified` · sending enabled입니다
(2026-08-26 확인). §3.5가 같은 날 From 전환을 완료로 기록하므로, 첫 발송은
그 시점 이후입니다 — 2주 뒤가 **2026-09-04**입니다.

**이것은 완료일이 아니라 가장 빠른 검토 가능일입니다.** 그날 리포트가 2주치 모여
있어야 검토가 성립하고, 안 모였으면 더 뒤입니다.

시계는 **DNS를 바꾼 시점이 아닙니다.** 집계 리포트는 우리 메일을 받은 쪽이
만들므로, 그 도메인에서 아직 아무것도 안 나갔으면 보고할 수신자가 없어 리포트가
없는 것이 정상입니다(3.4).

**루트(`tomverse.app`)의 `p=`·`sp=`를 올릴 때는 우리 발송만 보고 판단하면
안 됩니다.** 루트는 자체 SPF(`include:_spf.purelymail.com`)와
MX(`mailserver.purelymail.com`)를 가지고 있습니다 — 사람이 쓰는 사서함이 그
제공자에 있습니다. **purelymail 경유 발송이 정렬을 통과하는지 리포트에서 먼저
확인**하지 않고 올리면, 우리가 쓰는 메일함이 먼저 깨집니다. 서브도메인
(`_dmarc.mail`)만 조이는 것은 이 제약과 무관하고, 두 레코드를 나눠 둔 이유이기도
합니다.

리포트가 아예 안 올 때 두 원인을 구분하는 법도 3.4에 있습니다 — 루트 리포트는
오는데 서브도메인만 없으면 사서함은 멀쩡하고 아직 안 보낸 것입니다.

### 8.2 ③ 감사 리포트 경로의 `From:` 확인 — **해결 (2026-08-26)**

| | |
|---|---|
| 실측값 | `From: Tomverse Operations <alerts@mail.tomverse.app>` |
| 증거 | Resend 발송 `cdb21eb5-9177-43dc-b390-bfcbcda44253`, 2026-08-25 23:29:36 UTC, `delivered`. 제목 `[FAILED] Tomverse daily security audit · 26/08/2026, 09:29` |
| 이 문서가 틀렸던 것 | 아래 |

**기다리던 실행은 이미 여러 번 지났습니다.** 이 절이 쓰인 2026-08-22 이후 정기
실행이 매일 있었고, 네 번째 발송 경로가 실제로 무엇을 쓰는지는 그때부터 관측
가능했습니다. 확인이 늦은 것이지 실행이 없던 것이 아닙니다.

**그리고 이 표가 기대하던 값이 틀렸습니다.** `hello@`가 아니라 `alerts@`가
맞습니다 — §3a의 역할 표가 `operations`를 `Tomverse Operations
<alerts@mail.tomverse.app>`로 정하고 있고, `scripts/send-security-audit-report.mjs`
가 의도적으로 그 mailbox로 보냅니다(`lib/emailSendingIdentityCore.ts`의 주석이
`alerts@`를 고른 이유를 적습니다). 이 절은 §3a의 역할 분리보다 먼저 쓰였고 갱신되지
않았습니다.

**틀린 기대값은 없는 기대값보다 나쁩니다.** 다음 사람이 `alerts@`를 보고 잘못된
것으로 판단했을 것이고, 그것이 이 확인이 늦어진 동안 계속 대기 중이었습니다.

부수 관측: 그 실행은 **실패**로 끝났는데(E2E 단계) 리포트 메일은 정상 발송됐습니다.
발송 경로가 감사 결과와 독립이라는 뜻이며, 이 절이 원한 증거로서는 오히려
강합니다 — 실패한 실행에서도 ③ 경로는 살아 있습니다.

**증거가 두 곳에서 나옵니다.** 리포트 메일의 헤더가 하나이고, 다른 하나는 같은
실행의 로그입니다 — preflight("Check the sending identity")를 `Install
dependencies` 바로 뒤(step 5)로 옮겨 두었으므로, 잘못 설정돼 있으면 **실행 첫 1분
안에** 로그에 나옵니다. 1.8시간짜리 E2E 뒤에 있던 때는 이 확인 자체가 비싼
일이었습니다.

메일이 안 왔는데 로그의 preflight는 통과했다면, 문제는 발신 신원이 아니라 발송
자체(수신자 secret, provider 키)입니다.

### 8.3 A18 — marketing 전 Resend 계정 분리 결정

실행 지시서: `docs/ops/a18-resend-suppression-boundary.md` — 선택지와 귀결,
결정 후 고쳐야 하는 문서 위치, 수집이 끝난 사실이 거기 있습니다.

| | |
|---|---|
| 상태 | **결정됨 (2026-09-14)** — 별도 Resend 계정. 실행 순서는 §4.1 |
| 근거 | 같은 계정 안의 team 추가는 유료 플랜이 요구됨. 결정 시점 transactional 계정의 suppression 등재 0건이라 옮길 이력이 없었음 |
| 남은 것 | ADR 쪽 기록 — `docs/policy/email-notifications.md` §22 A18 행, §5.3.1 결정표 2행, 개정 이력 v5. 문구는 `docs/ops/a18-resend-suppression-boundary.md` §6에 |

따라오지 않는 것: "이메일 외 로그인 수단 1개 이상"의 **요구 승격**은 같은 계정을
유지할 때의 조건이므로 적용되지 않습니다(§5.3.1 결정 3).

계속 따라오는 것: **hard bounce 억제 공유**(§5.3.1 결정 4). 계정이 나뉘었으므로
provider가 대신 해 주지 않으며, 우리 `SuppressionEntry`가 유일한 공유 지점입니다.

marketing이 여전히 production 비활성인 것은 이제 A18도 Q8도 아닙니다. Q8의 값은
2026-09-14에 배포됐고(§1.3), 남은 것은 **Q1·Q2**와 DMARC 관측·warm-up입니다
(`docs/policy/email-notifications.md` §15.2).

### 8.4 여기 없는 것

법률 검토 대기 항목(Q1·Q2·Q4·Q8)은 이 문서가 아니라
`docs/policy/email-notifications.md` §22에 있습니다. 발송 도메인·DNS와 무관하므로
옮겨 적지 않습니다 — 같은 사실을 두 곳에 두면 한쪽만 갱신됩니다.
