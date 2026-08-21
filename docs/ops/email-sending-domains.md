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
| 다른 발송 신원 3개 | **전환 안 됨.** 1.2 |

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

### 1.2 발송 신원은 넷이고, 전환된 것은 하나입니다

2026-08-21 전환 뒤에 확인한 결과입니다. `TRANSACTIONAL_EMAIL_FROM`을 읽는 경로는
넷 중 하나뿐이고, 나머지 셋은 Resend API를 직접 호출합니다.

| 경로 | From 출처 | 2026-08-21 현재 |
|---|---|---|
| `lib/email.ts` → `fromAddressForStream()` | Railway `TRANSACTIONAL_EMAIL_FROM` | `hello@mail.tomverse.app` |
| `lib/operationalMonitoring.ts` | `ADMIN_ALERT_FROM` → 하드코딩 | `Tomverse Operations <alerts@tomverse.app>` |
| `lib/providerMonitoring.ts` | `ADMIN_ALERT_FROM` → 하드코딩 | `Tomverse Admin <alerts@tomverse.app>` |
| `scripts/send-security-audit-report.mjs` | GitHub Actions **secret** → 하드코딩 | 관측값 `Tomverse Admin <alerts@tomverse.app>` |

**세 경로는 이 저장소의 어떤 검사에도 잡히지 않습니다.** `/api/ready`의
`emailSendingIdentity`도, `sendingIdentityProblems()`도, 스트림 분리도 전부
`lib/emailSendingIdentity.ts`를 통과하는 발송만 봅니다. 마지막 경로는 Railway가
아니라 GitHub secret에서 값을 읽으므로 환경변수를 바꿔도 닿지 않습니다.

**이것이 §14.1과 어긋나는 지점.** 그 표는 "운영자 내부 알림 → transactional
재사용"이라고 합니다. 전환 후 transactional은 `mail.tomverse.app`이므로 계약대로면
이들도 함께 옮겨졌어야 하는데, 그 변수를 읽지 않아서 남았습니다. §2의 "루트는
발송하지 않음"도 지금은 사실이 아닙니다 — purelymail(사람 메일함)과 이 세 경로가
루트에서 나갑니다.

**당장 깨지는 것은 없고, 하나가 취약합니다.** 이 알림들은 운영자 한 명에게 가는
내부 메일이고 사용자 메일이 아닙니다. DMARC도 통과합니다 — 다만 통과 근거가
DKIM 하나뿐입니다. 루트 SPF는 `include:_spf.purelymail.com`이라 SES를 포함하지
않으므로 SPF는 실패하고, Resend가 루트 도메인에 서명하는 DKIM만 정렬합니다.

> **그래서 전환 뒷정리로 Resend에서 `tomverse.app` 도메인을 지우면 안 됩니다.**
> 지우는 순간 이 세 경로가 DKIM을 잃고, SPF는 원래 이들을 덮은 적이 없으므로
> DMARC가 전부 실패합니다. 루트를 `p=quarantine` 이상으로 올린 뒤라면 운영 알림이
> 조용히 사라집니다 — 알림이 안 오는 것을 알려 줄 알림이 그것뿐인 상태로.

옮기려면 세 곳을 각각 손봐야 합니다: `ADMIN_ALERT_FROM`을 설정하거나(두 경로가
공유), GitHub secret을 갱신하거나(감사 리포트), 세 경로를
`fromAddressForStream()` 뒤로 넣거나. 마지막이 가장 낫지만 알림 경로를 건드리는
변경이므로 사람이 결정합니다.

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
