# 이메일 발송 도메인과 DNS

계약: `docs/policy/email-notifications.md` §5.3, §14.1, §14.2, §17.3.
현황 확인: `npm run report:email-domains`, Admin Console의 **Email policy →
Sending domains**.

이 문서는 DNS 레코드를 **사람이** 등록하는 절차입니다. 저장소의 코드는 도메인을
만들지도, 검증하지도, 지우지도 않습니다 — 계정의 대외 신원과 우리가 소유하지
않은 DNS zone을 바꾸는 일이기 때문입니다.

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
| marketing From | 미설정 |
| DNS | Cloudflare |

`region`이 `ap-northeast-1`이라는 사실은 §5.3.1과 직접 연결됩니다. 제공자의
suppression은 **같은 region의 계정 전체**에 적용되므로, marketing을 분리하려면
도메인이 아니라 계정 또는 region을 나눠야 합니다(A18). `mail.tomverse.app`을
같은 region에 만든 것은 그 결정을 이 작업에서 우연히 내리지 않기 위해서입니다.

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
없는 것이 요점**입니다. Resend의 suppression은 계정·region 전체 범위라(정책 문서
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
레코드를 발급하지도, 상태를 보고하지도 않기 때문입니다. `dig TXT
_dmarc.mail.tomverse.app`으로 직접 봅니다(1.1 — 이 환경에서 동작합니다).

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

## 4. marketing 도메인 (`news.tomverse.app`)

**아직 만들지 않습니다.** 선행 조건이 둘입니다.

1. **A18 결정** — 별도 Resend team/region을 쓸지, 별도 provider를 쓸지, 아니면
   같은 suppression 범위를 유지할지. 같은 범위를 유지하기로 하면 §5.3.1 결정 3이
   따라옵니다: 이메일이 아닌 계정 복구 수단이 **권장이 아니라 요구**가 됩니다.
2. **Q8** — footer에 넣을 법인명·사업자등록번호·통신판매업 신고번호·주소·ABN의
   실제 값. 값이 없으면 `renderJurisdictionFooter()`가 발송을 거부합니다.

만들 때는 위 3.1~3.4를 `news.` 이름으로 반복하고, §14.6의 warm-up(4~6주, 주당
배증, 가장 최근 동의자부터)을 함께 시작합니다.

설정은 환경변수 하나입니다.

```
MARKETING_EMAIL_FROM=Tomverse <news@news.tomverse.app>
```

이 변수가 없으면 marketing 발송은 **transactional 주소로 대체되지 않고
거부됩니다**(`MARKETING_FROM_MISSING`). 대체는 프로모션 스팸 신고를 로그인 코드가
나가는 도메인에 얹는 일이고, 증상은 로그인 메일이 안 온다는 신고로만 나타납니다.
두 스트림을 같은 도메인에 설정하면 `/api/ready`가 실패합니다
(`STREAMS_SHARE_A_DOMAIN`).

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
