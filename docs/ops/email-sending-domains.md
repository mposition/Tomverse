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
| 제공자에 등록된 도메인 | `tomverse.app` 하나 |
| 상태 | `verified`, sending enabled |
| region | `ap-northeast-1` |
| 검증된 레코드 | DKIM(TXT `resend._domainkey`), SPF(MX·TXT `send`) |
| DMARC | **제공자 레코드 집합에 없음.** zone에서 따로 확인해야 합니다 |
| transactional From | `hello@tomverse.app` (= 등록 가능 도메인 자체) |
| marketing From | 미설정 |

즉 **§14.1의 목표 상태가 아닙니다.** 지금은 발송 도메인이 등록 가능 도메인
하나뿐이고, 그 위에서는 스트림별 평판도 `sp=` 정책도 나눌 수 없습니다.

`region`이 `ap-northeast-1`이라는 사실은 §5.3.1과 직접 연결됩니다. 제공자의
suppression은 **같은 region의 계정 전체**에 적용되므로, marketing을 분리하려면
도메인이 아니라 계정 또는 region을 나눠야 합니다(A18).

---

## 2. 목표 상태

| 용도 | 도메인 | 비고 |
|---|---|---|
| transactional | `mail.tomverse.app` | `hello@tomverse.app`에서 이전 |
| marketing | `news.tomverse.app` | marketing 활성화 시점에 신설 + warm-up |
| 루트 | `tomverse.app` | 발송하지 않음. DMARC와 `sp=`만 둡니다 |

---

## 3. transactional 도메인 이전 (§17.3 1~4단계)

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
_dmarc.mail.tomverse.app`으로 직접 봅니다.

### 3.4 2주 관측

`p=none` 상태로 최소 2주. 리포트에서 확인할 것:

- 우리가 보낸 메일이 SPF·DKIM 양쪽에서 **정렬(alignment)**되는가
- 우리가 모르는 발송원이 이 도메인을 쓰고 있지 않은가

### 3.5 From 주소 전환

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
(`TRANSACTIONAL_ON_ROOT_DOMAIN`)가 사라집니다. 그 경고가 이 작업의 완료 신호입니다.

### 3.6 정책 강화 (Phase 2)

리포트가 깨끗하면 `p=quarantine`, 이후 `p=reject`. 각 단계 사이에 최소 2주.
루트의 `sp=`도 함께 올립니다.

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
- [ ] DMARC 정렬 — 3.2
- [x] marketing One-Click unsubscribe (RFC 8058) — `lib/emailUnsubscribeHeaders.ts`
- [x] 스팸 신고율 감시 — `docs/policy/email-notifications.md` §14.5
- [x] TLS 전송 — 제공자 기본
- [ ] 유효한 정방향/역방향 DNS — 공유 IP이므로 제공자 책임

## 6. 전용 IP

**하지 않습니다.** 월 발송량이 적을 때 전용 IP는 warm-up 트래픽이 부족해 공유
IP보다 나쁩니다. 재검토 시점은 marketing 단독 월 10만 통(§14.3).

## 7. BIMI

**하지 않습니다.** VMC 비용 대비 이점이 낮습니다(§14.1).
