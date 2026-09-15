# 관할권 정책 version 활성화 — 실행 기록

> **이 문서는 에이전트가 만든 초안입니다.** §4의 실행 기록란은 비어 있고,
> 실행자가 화면에서 본 것을 확인한 뒤 채워서 commit 합니다. 지어낸 관측을
> 적지 않습니다(AGENTS.md "기록을 채우는 경계는 관측과 판정입니다").

| 항목 | 값 |
|---|---|
| 작성일 | 2026-09-15 |
| 대상 | production `/admin/email-policy` |
| 성격 | **쓰기.** 1단계는 행 생성(발송 무변화), 2단계는 활성화(발송 변화) |
| 승인 | 2단계에 §12.3 2인 승인 |
| 근거 | docs/policy/email-notifications.md §12.3, §12.5 |

## 1. 왜 하는가

2026-09-15 `/admin/email-policy` 확인 결과, production의 활성 policy version은
**`2026-08-21.1`이고 프로필 0개 · 국가 0개**였습니다. 사람이 만든 것이 아니라
첫 발송 때 `ensureBootstrapPolicyVersion()`(`lib/emailTemplateRegistry.ts`)이
자동으로 만들어 `active`로 올린 bootstrap version이며, 생성·활성화 시각이 둘 다
**2026-08-23 11:06**입니다. 목록에 그 version 하나뿐이었고
`2026-08-21.jurisdictions.1`은 만들어진 적이 없습니다.

발송 경로는 seed 상수가 아니라 `JurisdictionProfile` **행**을 읽으므로
(`lib/standardEmailLane.ts`), 행이 없으면 `composeJurisdictionalMessage()`가
`profile_missing`으로 갈라집니다(`lib/emailJurisdictionComposition.ts`). 그
갈래는 관할권을 가리지 않습니다.

| | 그동안 일어난 일 |
|---|---|
| transactional | **모든 수신자**에게 사업자 footer 없이 발송 (약 3주) |
| marketing | `jurisdiction_profile_missing`으로 전량 거부될 상태 |
| `/api/ready` | 계속 `true` — 환경변수 값을 보고 행을 보지 않습니다 |
| 유일한 신호 | 발송마다 남는 `email_jurisdiction_footer_degraded` |

**코드는 이미 맞습니다.** `main`이 9개 profile을 정확히 들고 있으므로 배포가
필요 없고, 빠진 것은 그 코드로 행을 만드는 행위 하나입니다.

## 2. 실행 절차

> **어디서**: 관리자로 로그인한 브라우저(로컬 PC)의 `/admin/email-policy`,
> `관할권` 탭. 저장소·셸·환경변수 불필요. `ops:write` 권한이 필요합니다.

### 2.1 초안 생성 — 발송은 아직 바뀌지 않습니다

`초안 생성` 버튼. `2026-08-21.jurisdictions.1`이 `draft` 상태로 생깁니다.
**이 단계에서는 어떤 메일도 달라지지 않습니다** — 활성 version은 여전히
bootstrap이고, 초안은 활성화하기 전까지 문서입니다.

되돌리기: 활성화하지 않으면 효과가 없습니다.

### 2.2 §3의 정답지와 대조

아래 표와 화면을 맞춰 봅니다. **하나라도 어긋나면 활성화하지 않고 멈춥니다.**

### 2.3 활성화 — 여기서부터 발송이 바뀝니다

2인 승인을 거칩니다. 이 시점부터 새 발송에 footer가 붙고 KR 제목에 `(광고)`가
붙습니다(marketing에 한함 — 영수증에는 붙지 않습니다).

이미 발송된 delivery는 렌더링 당시 version을 유지하므로 **소급되지 않습니다.**

## 3. 정답지 — 초안에 들어 있어야 하는 것

`lib/emailJurisdictionSeed.ts`와 `jurisdictionCountryMapSeed()`에서 계산한
값입니다. production이 도는 `main`의 seed와 동일함을 대조했습니다.

| 항목 | 값 |
|---|---|
| version | `2026-08-21.jurisdictions.1` |
| **프로필 수** | **9** |
| **국가 매핑 수** | **37** |

| profile | 국가 | basis | 제목 접두어 | 수신거부 SLA | footer blocks |
|---|---|---|---|---|---|
| **KR** | KR (1) | opt_in | `(광고)` | 1일 | legal_name, postal_address, contact_email, unsubscribe_link, unsubscribe_reason |
| **US** | US (1) | opt_out | 없음 | 10일 | 〃 |
| **CA** | CA (1) | opt_in | 없음 | 10일 | 〃 |
| **AU** | AU (1) | opt_in | 없음 | 5일 | legal_name, **abn**, postal_address, contact_email, unsubscribe_link, unsubscribe_reason |
| **GB** | GB (1) | opt_in | 없음 | 5일 | legal_name, postal_address, contact_email, unsubscribe_link, unsubscribe_reason |
| **SG** | SG (1) | opt_out | `<ADV> ` | 10일 | 〃 |
| **EU** | **30개국** | opt_in | 없음 | 5일 | legal_name, **abn**, postal_address, contact_email, unsubscribe_link, unsubscribe_reason |
| **CH** | CH (1) | opt_in | 없음 | 5일 | legal_name, **abn**, postal_address, contact_email, unsubscribe_link, unsubscribe_reason |
| **ZZ** | 0개 | opt_in | 없음 | 5일 | legal_name, postal_address, contact_email, unsubscribe_link, unsubscribe_reason |

EU 30개국: `AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LI LT LU LV MT NL NO PL PT RO SE SI SK`

기타 값:

- **KR quietHours** `21:00–08:00 Asia/Seoul` — 다른 profile은 전부 없음
- **KR consentNoticeIntervalMonths** `24` — 다른 profile은 전부 없음
- **CA impliedConsentDays** `{transaction: 730, enquiry: 183}` — CASL의 2년·6개월
  창을 사실대로 적어 둔 것이며 **미사용 필드**입니다(C8이 implied consent를
  어디서도 쓰지 않습니다). 다른 profile은 전부 없음

### 특히 확인할 세 가지

1. **KR의 footer에 `business_registration`·`mail_order_registration`이 없을 것.**
   있으면 그 두 값이 환경변수에 없으므로 한국 수신자 footer가 다시 통째로
   빠집니다. 발송 주체가 한국 통신판매업 신고 대상이 아니어서 번호가 존재하지
   않습니다(2026-09-14 확인).
2. **`CH`가 `EU`와 별개 profile로 있을 것.** 스위스는 EEA가 아니고 법령·감독·
   이전 근거가 다릅니다.
3. **프로필 9개 · 국가 37개.** 8개나 36개면 낡은 코드로 만들어진 것입니다.

## 4. 실행 기록 — **미기록**

실행자가 화면에서 본 것을 적습니다. 판정과 서명은 실행자의 것입니다.

| 항목 | 관측 | 비고 |
|---|---|---|
| 초안 생성 시각 (UTC) | | |
| 생성된 version 문자열 | | `2026-08-21.jurisdictions.1` 예상 |
| 프로필 수 / 국가 수 | | 9 / 37 예상 |
| KR footer에 등록번호 없음 | | |
| CH profile 존재 | | |
| §3 표와 불일치한 항목 | | 없으면 "없음" |
| 활성화 시각 (UTC) | | |
| 승인자 | | |
| 대체된 version | | `2026-08-21.1` (bootstrap) 예상 |

**판정**: (통과 / 조건부 / 중단)

**서명**:

## 5. 활성화 후 확인

- 다음 발송부터 `email_jurisdiction_footer_degraded`가 **더 이상 나오지 않아야**
  합니다. 계속 나온다면 이유가 `profile_missing`이 아니라
  `footer_missing:<block>`으로 바뀌었을 가능성이 크고, 그때는 그 block의
  환경변수가 비어 있다는 뜻입니다.
- `/api/ready`는 이 상태를 보지 않으므로 **판정 근거가 되지 못합니다.** 활성
  version에 profile이 0개인 상태를 검사에 추가하는 것은 별도 작업이며, 이번 일이
  3주 동안 발견되지 않은 이유가 정확히 그 검사의 부재입니다.
