# 제품 소식 이메일: 분류·근거·국가 판정 재설계 (초안)

> **이 문서의 지위: 초안입니다. 승인되지 않았고, 코드는 하나도 없습니다.**
> 여기 적힌 D1~D5는 제안이며, §12의 승인 항목이 처리되기 전에는 어떤 것도
> 구현하지 않습니다. 이 문서가 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

---

## 1. 무엇이 문제인가

Tomverse는 신규 플랫폼이고 기능 추가 로드맵이 크게 남아 있습니다. 새 기능을
알리는 이메일은 제품 운영의 기본 수단인데, **지금 구조에서는 한 통도 나갈 수
없습니다.**

원인은 버그가 아니라 분류입니다. [이메일 알림](email-notifications.md) §3.1의
7번 행이 "신규 기능 소개, 뉴스레터"를 **marketing**으로 두었고, §5.1 C1이
marketing을 전역 opt-in으로, §5.6 C8이 soft opt-in 미사용으로 정했습니다. 그
결과 기능 안내는 프로모션과 같은 칸에 들어가 사전 동의를 요구하고, 동의를
수집하는 경로는 설정 화면 하나뿐이며, 그 화면까지 스스로 찾아온 사람은
0명입니다(2026-09-15 `GET /api/admin/marketing-reach`).

**이 문서는 그 분류를 다시 봅니다.** 프로모션을 동의 없이 보내자는 제안이
아닙니다 — 프로모션·뉴스레터는 지금 규칙 그대로 둡니다.

## 2. 조사로 확인된 것 (2026-09-16)

### 2.1 GDPR의 적법근거는 발송 허가가 아닙니다

두 가지가 자주 섞입니다.

- **GDPR 제6조**: 주소라는 개인정보를 처리해도 되는가.
- **ePrivacy 지침 제13조**: 그 주소로 광고 이메일을 보내도 되는가.

**CJEU C-654/23 (Inteligo Media, 2025-11-13)** 이 둘의 관계를 정리했습니다 —
제13조(2)의 요건을 충족하면 GDPR 제6조 심사는 적용되지 않습니다(GDPR 제95조의
특별법 관계). 반대로 **정당한 이익을 근거로 들어도 제13조를 통과하지 못하면
보낼 수 없습니다.**

OpenAI·Anthropic의 개인정보처리방침이 마케팅에 "동의 또는 정당한 이익"을
적어 둔 것은 앞의 층에 대한 답이고, 뒤의 층에 대한 답이 아닙니다. 그러므로
**"두 회사가 정당한 이익을 쓰니 우리도 쓰면 된다"는 결론은 성립하지
않습니다.** 우리가 쓸 수 있는 것은 제13조(2)의 **soft opt-in**입니다.

### 2.2 무료 가입도 soft opt-in의 "판매 맥락"이 될 수 있습니다

같은 판결이 문을 열었습니다.

- §53: "sale"은 대가 지급을 수반하는 계약을 뜻한다.
- §54~56: 다만 그 대가는 **간접적이어도 된다** — 무료 서비스의 비용이 유료
  구독가에 내재돼 있으면 요건을 충족한다.
- §45: 무료 뉴스레터가 유료 콘텐츠로 유인하는 구조이면 그 전송은 "자사 유사
  제품·서비스의 direct marketing"에 해당한다.

사실관계가 Tomverse와 유사합니다(무료 계정 + 유료 구독). **다만 이것은 법적
판단의 영역입니다** — 판결은 freemium의 경제적 연결을 근거로 삼았고, 그 연결이
없는 순수 무료 서비스는 판시 범위 밖입니다.

영국은 더 넓습니다. PECR reg 22(3)은 "sale **or negotiations for sale**"이라
적고, ICO 안내가 **무료 체험 가입을 명문으로 인정**합니다.

### 2.3 한국과 싱가포르는 다릅니다

**한국** — 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법
안내서」(KISA-GD-2025-0037, 2025.12):

- 제50조제1항 단서의 거래관계 예외는 **"금전적인 대가를 지불한 거래관계"** 를
  요구하고, **"회원가입"을 예외 대상에서 이름 대어 배제**합니다.
- 광고성 정보의 판정 기준은 "유익한가"가 아니라 **"수신거부자에게도 반드시
  전달해야 하는가"** 입니다. 기능 출시 안내는 안 보내도 계약 이행에 지장이
  없습니다.
- 무료 멤버십 만료 안내조차 "해당 멤버십에 대한 홍보"로 광고성 정보에
  해당한다고 적습니다(Q 01-14).
- **"마케팅 동의"라는 라벨 자체가 무효**이며 "광고성 정보 수신동의"여야 하고,
  약관 동의로 갈음할 수 없습니다.

**싱가포르** — Spam Control Act 2007 s 5(2): **가입 시 본인이 주소를 적었다는
사실만으로는 동의로 보지 않습니다.** 대량 문턱(s 6: 24시간 100통 / 30일
1,000통 / 1년 10,000통)은 제품 공지가 항상 넘습니다.

### 2.4 모든 법역에 공통인 규칙 하나

**혼합 메시지는 광고 쪽으로 기웁니다.** ICO("even if that isn't the main
purpose"), CNIL("requalifié"), KISA("전체가 광고성 정보"), ACMA("even if a
message is mostly 'factual'"), FTC(16 CFR 316.3(a)(2))가 각각 같은 말을
합니다. **업그레이드 CTA나 요금제 링크 하나가 분류를 뒤집습니다.**

### 2.5 경쟁 서비스 실태 (참고이지 근거는 아닙니다)

| | OpenAI | Anthropic |
|---|---|---|
| 가입 시 국가 질문 | 없음 | 없음 |
| 국가 판정 | IP 추정 | IP 추정, **국가 수준 추정은 끌 수 없다고 명시** |
| 마케팅 동의 | opt-out, 수신거부 링크만 | 가입 화면 **간주 동의** 문구, 전 로케일 공통 |
| 한국 §50 구조 | 문서에 없음 | 문서에 없음 |
| 한국 국내대리인 §32조의5 | 지정·공개 | 지정·공개 |

**두 회사의 실태를 준거로 삼지 않습니다.** 실제 발송 메일의 제목 줄을 한 건도
확보하지 못했고, 제재 사례가 없는 것은 준수보다 집행 부재를 시사합니다. 한국은
불법스팸 과징금(관련 매출액 1~6%)을 2026년 10월 시행 예정이라 그 전제도 곧
바뀝니다. 위 표는 "우리만 유별난가"에 대한 답일 뿐입니다.

---

## 3. D1 — 기능 안내를 별도 purpose로 분리합니다

### 결정

새 purpose **`release_notes`** 를 추가합니다.

| | `release_notes` (신규) | `product_updates` (기존) |
|---|---|---|
| 내용 | 이미 계정을 가진 사람에게 **우리 서비스에 무엇이 생겼고 무엇이 바뀌었는지** | 그 밖의 홍보 — 캠페인, 재참여, 모델 출시 홍보 |
| 분류 | **service**(관할권에 따라, D2) | marketing |
| 기본값 | **켜짐**, 언제든 끌 수 있음 | 꺼짐, 동의 필요 |
| unsubscribe 링크 | **필수** | 필수 |
| 스트림 | marketing 발송 도메인(§5.3 C9) | marketing |

### 왜 기존 purpose를 재사용하지 않는가

`product_updates`의 의미를 바꾸면 그 이름을 읽는 모든 코드가 조용히 다른 것을
뜻하게 됩니다. 지금 세 marketing purpose의 `enabled`가 전부 0이라 데이터
이전 비용은 없지만, **이름이 거짓말을 하기 시작하는 비용은 데이터와 무관하게
남습니다.**

### 왜 `service_status`에 넣지 않는가

`service_status`는 장애·점검이고 **계약 이행**입니다. 기능 출시는 계약 이행이
아니며, 둘을 합치면 "장애 알림을 끄면 기능 안내도 꺼지는" 구조가 됩니다.

### 이 purpose가 **아닌** 것

- 요금제·할인·크레딧 프로모션 → `promotions`
- 정기 소식지 → `newsletter`
- 특정 기능을 써 보라고 권유하는 캠페인 → `product_updates`

경계는 D5의 문안 규칙이 강제합니다.

---

## 4. D2 — 근거는 관할권 프로파일이 정합니다

### 결정

`JurisdictionProfile`에 필드 하나를 추가합니다.

```
releaseNotesBasis: "no_consent" | "soft_opt_in" | "opt_in"
```

초기 값과 근거입니다.

| profile | 값 | 근거 | 조건 |
|---|---|---|---|
| **US** | `no_consent` | CAN-SPAM 15 U.S.C. §7702(17)(A)(iii)(I) — 기존 계정의 "기능·조건 변경 안내"는 상업 메시지가 아님 | 혼합 시 16 CFR 316.3(a)(2) |
| **AU** | `no_consent` | Spam Act Sch 2 cl 2(b) 추론 동의 — 계정이 살아 있고 메시지가 그 관계와 직접 관련 | s 17 발신자 식별, s 18 수신거부, reg 7(6) 로그인 요구 금지, 5영업일 |
| **GB** | `soft_opt_in` | PECR reg 22(3), ICO가 무료 체험 가입을 명문 인정 | 수집 시 + 매 메시지 거부 기회 |
| **EU** | `soft_opt_in` | ePrivacy 13(2) + C-654/23 | 위와 같음. **단 AT·IE는 EU profile에서 분리** |
| **CH** | `soft_opt_in` | UWG art. 3(1)(o) | 위와 같음 |
| **KR** | `opt_in` | 정보통신망법 제50조제1항, 안내서가 회원가입을 예외에서 배제 | 별도 광고성 정보 수신동의 + `(광고)` + 별표 6 |
| **SG** | `opt_in` | Spam Control Act s 5(2) | `<ADV>` + 수신거부 |
| **CA** | `opt_in` | CASL — 묵시적 동의에 거래가 필요 | |
| **ZZ** | `opt_in` | 모르는 곳에는 가장 엄격한 규칙 | |

### 오스트리아와 아일랜드는 처음부터 `opt_in`으로 둡니다

둘 다 soft opt-in이 **법적으로는 가능하지만 추가 기계를 요구**합니다.

- **오스트리아**: RTR가 운영하는 **ECG-Liste** 옵트아웃 등록부 조회가 발송 전
  의무입니다(ECG §7(2)). 4요건을 다 갖춰도 조회하지 않으면 위법이고, 제재는
  TKG 2021 §188상 **메일 1통당 최대 5만 유로**입니다.
- **아일랜드**: S.I. 336/2011 reg 13(11)(d)의 **12개월 창**을 지켜야 하고,
  위반은 **형사범**이며 동의 입증책임이 발신자에게 있습니다.

두 나라를 `opt_in`으로 두면 그 기계가 필요 없습니다. **필요해지면 그때 만들고
profile 값을 바꾸는 것이 새 정책 버전 하나입니다** — 이것이 profile을 데이터로
둔 이유입니다.

> 이는 EU profile을 쪼갠다는 뜻입니다. 현재 EU profile은 EEA 30개국을 덮고
> 있으므로, AT·IE를 별도 profile로 분리하거나 `JurisdictionCountryMap`에서
> 두 나라를 다른 profile로 매핑해야 합니다. §6에 범위를 적었습니다.

### `marketingBasis`는 건드리지 않습니다

기존 필드는 프로모션·뉴스레터의 근거이고 C1(전역 opt-in)이 그대로입니다. **두
필드가 서로 다른 질문에 답합니다.**

---

## 5. D3 — 수집 시점의 거부 기회

### 결정

가입 화면에 **문장 하나와 거부 체크박스 하나**를 둡니다.

```
[ ] 제품 소식 이메일을 받지 않겠습니다
    새 기능과 변경 사항을 가끔 보내 드립니다. 언제든 설정에서 끌 수 있습니다.
```

- **체크되지 않은 상태가 기본**이며, 체크하면 `release_notes`가 꺼진 채로
  계정이 만들어집니다.
- 이것은 **동의 체크박스가 아니라 거부 기회**입니다. soft opt-in의 요건이
  "동의를 받아라"가 아니라 "수집 시점에 거부할 기회를 주어라"이기 때문입니다.
  동의 체크박스로 만들면 한국에서는 "마케팅 동의" 라벨로 무효이고, EEA에서는
  약관과 묶인 동의로 자유롭게 주어진 동의가 아닙니다.
- **한국·싱가포르 사용자에게는 이 체크박스가 의미를 갖지 않습니다.** 그들에게
  `release_notes`는 `opt_in`이므로 기본이 꺼짐이고, 켜려면 DOI를 지납니다.

### 증거 기록

`ConsentRecord`에 새 action **`notice_at_collection`** 을 남깁니다.

```
{ action: "notice_at_collection",
  evidence: { noticeVersion, locale, objected: boolean, surface: "signup" } }
```

soft opt-in은 **"고지했다"를 입증해야 하는 제도**입니다(DE UWG §7(3) Nr.4,
AT §174(4) Z3, EU 13(2), UK reg 22(3)(c)). 문구를 바꾸면 `noticeVersion`이
올라가고, 어느 문구를 본 사람인지가 행에 남습니다.

### 매 메시지의 거부 기회

이미 있습니다 — `release_notes`는 `requiresUnsubscribe: true`이고 RFC 8058
one-click과 링크를 함께 싣습니다. **수신거부에 로그인을 요구하지 않는 것**은
호주 reg 7(6)의 명문 요건이자 ICO의 명시적 지침이며, 현재 토큰 링크 구조가 이미
충족합니다.

---

## 6. D4 — 국가는 추정하고, 사용자가 고칩니다

### 지금 구조

`resolveEmailJurisdiction()`의 신호 우선순위는 결제 국가 → 자기 신고 → 동의
시점 관할권 → (언어+시간대) → IP이고, **IP는 `observedIpCountry`로 기록만 되고
판정에 쓰이지 않습니다.** 마케팅은 `confidence: "high"`만 통과합니다.

### 결정

1. **IP를 신호로 승격하되 `low` 신뢰도로 둡니다.** 언어+시간대와 같은 층이며,
   서로 어긋나면 `conflict`가 아니라 **더 엄격한 쪽**을 택합니다.
2. **`release_notes`는 `low`에서도 보낼 수 있습니다.** 단 그 관할권의
   `releaseNotesBasis`가 `no_consent`이거나 `soft_opt_in`일 때만입니다.
3. **`opt_in` 관할권으로 추정되면 보내지 않습니다.** 그리고 **판정이 서면
   엄격한 쪽으로 떨어집니다** — KR·SG·CA·AT·IE·ZZ 중 하나로 볼 만한 신호가
   하나라도 있으면(IP, 언어 `ko`, 시간대 `Asia/Seoul` 등) 그 관할권으로
   취급합니다.
4. **프로모션·뉴스레터는 지금과 같이 `high`만 통과합니다.** 여기는 바뀌지
   않습니다.
5. **사용자가 설정에서 국가를 고칠 수 있습니다.** 고치면 `self_declared`가
   되어 `high`가 되고, 추정을 덮습니다.

### 이 결정이 받아들이는 위험

**추정이 틀리면 그 사람에게 잘못된 규칙으로 발송됩니다.** 가장 비싼 경우는
한국 사용자를 미국으로 추정해 `(광고)` 없이, 동의 없이 보내는 것입니다.

세 가지로 줄입니다 — ① 엄격한 쪽 우선(위 3번), ② 한국어 로케일과
`Asia/Seoul`은 그 자체로 KR 신호, ③ 수신거부는 즉시·무조건.

**남는 위험은 0이 아닙니다.** VPN을 쓰는 한국 사용자, 영어 로케일에 해외
시간대를 쓰는 한국 거주자는 잘못 분류될 수 있습니다. 이는 §12에서 승인해야
하는 항목입니다.

---

## 7. D5 — 문안 규칙을 계약으로 만듭니다

### 결정

`release_notes` 템플릿은 다음을 **담을 수 없습니다.**

1. 가격·요금제·업그레이드 링크 (`/pricing`, 결제 관련 경로)
2. 할인·프로모션 코드·한정 기간 표현
3. 구독을 권유하는 CTA ("지금 업그레이드", "Pro로 전환")

담을 수 있는 것은 **무엇이 생겼고 어떻게 쓰는지**, 그리고 그 기능으로 가는
링크입니다.

### 강제 방법

- 템플릿 정의에 `contentRules: "release_notes"` 표시를 두고, 렌더 결과에
  금지 경로·문구가 있으면 **발송 전에 거부**합니다.
- `tests/releaseNotesContentRules.test.mjs`가 7개 언어 문안 전부를 검사합니다.

### 왜 규칙이 필요한가

§2.4의 혼합 메시지 규칙 때문입니다. 링크 하나가 분류를 뒤집고, 뒤집히는 순간
`no_consent`·`soft_opt_in` 근거가 전부 무너지며, 그때 이미 메일은 나가 있습니다.
**문안 심사를 사람의 주의력에 맡기지 않습니다.**

---

## 8. 데이터 모델 변경

| 대상 | 변경 | 비고 |
|---|---|---|
| `EmailPreference.purpose` CHECK | `release_notes` 추가 | migration |
| `EmailTemplate.purpose` CHECK | 동일 | migration |
| `ConsentRecord.action` CHECK | `notice_at_collection` 추가 | migration |
| `JurisdictionProfile` | `releaseNotesBasis` 컬럼 추가 | migration + seed 버전 |
| `UserSettings.countrySource` | `inferred_ip` 추가 | 기존 값 유지 |
| `EmailDelivery.skipReason` CHECK | `release_notes_basis_opt_in` 추가 | migration |

`npm run check:enum-constraints`가 코드와 DB CHECK의 어긋남을 잡습니다.

---

## 9. 코드 변경 범위

새로 만드는 것:

- `lib/emailReleaseNotes.ts` — purpose의 게이트. 관할권 프로파일의
  `releaseNotesBasis`와 해석된 관할권을 받아 보낼 수 있는지 판정합니다.
- `lib/releaseNotesContentRules.ts` — D5의 금지 목록과 검사.
- `lib/emailCollectionNotice.ts` — 고지 문구 버전과 기록.

고치는 것:

- `lib/emailPreferenceCore.ts` — `release_notes`를 `CONSENT_REQUIRED_PURPOSES`에
  넣지 않고, 관할권별 근거를 읽는 분기를 추가.
- `lib/emailJurisdictionCore.ts` — IP 신호 승격, 엄격한 쪽 우선 규칙.
- `lib/emailJurisdictionSeed.ts` — `releaseNotesBasis`, AT·IE 분리, seed 버전.
- `lib/emailTemplateDefinitions.ts` — `release_notes` 템플릿과 문안 규칙 표시.
- `lib/standardEmailLane.ts` — 게이트 호출과 skip 사유.
- 가입 화면 — 고지 문장과 거부 체크박스.
- `components/email/EmailNotificationSettings.tsx` — 새 purpose 행, 국가 정정.
- `locales/*.ts` 7개 — 고지 문구, 설정 문구, 템플릿 문안.

---

## 10. 무엇을 하지 않는가

- **프로모션·뉴스레터의 근거를 바꾸지 않습니다.** C1은 그대로입니다.
- **DOI를 없애지 않습니다.** 한국·싱가포르·캐나다·오스트리아·아일랜드와
  프로모션 전체가 계속 씁니다.
- **가입을 막지 않습니다.** 거부 체크박스는 가입의 조건이 아닙니다.
- **국가를 가입 필수 항목으로 만들지 않습니다.**
- **오스트리아 ECG-Liste 연동을 지금 만들지 않습니다.**
- **한국 2년 재확인 배치를 이 작업에 넣지 않습니다.** 별개 항목입니다.

---

## 11. 구현 순서와 각 단계의 검증

| # | 단계 | 왜 이 순서인가 | 검증 |
|---|---|---|---|
| S1 | `release_notes` purpose + 템플릿 + 문안 규칙 (기본 꺼짐) | 근거 없이 보낼 수 있는 상태를 먼저 만들지 않기 위해 분류부터 | unit + enum-constraints + 7개 언어 |
| S2 | `releaseNotesBasis` + 게이트 + AT·IE 분리 | 게이트 없이 기본값을 켜면 그 순간 발송 가능해짐 | unit + DB 통합 + lane 통합 |
| S3 | 가입 고지와 거부 체크박스 + `notice_at_collection` | soft opt-in 요건이 충족돼야 S2의 `soft_opt_in` 값이 의미를 가짐 | e2e + DB 통합 |
| S4 | IP 추정 승격 + 엄격한 쪽 우선 + 설정에서 국가 정정 | 앞 셋이 없으면 추정의 결과가 쓰이는 곳이 없음 | unit(판정표) + 통합 |
| S5 | 정책 문서 개정, 새 정책 버전 초안 | 코드가 문서보다 앞서지 않도록 마지막에 문서를 맞춤 | 정적 검사 + 사람 활성화 |

각 단계는 독립 PR이며, **S2와 S4는 Codex 독립 검토를 받습니다** — 전자는 발송
가능 여부를 정하는 게이트이고, 후자는 틀리면 잘못된 관할권 규칙으로 발송되는
판정이기 때문입니다.

---

## 12. 승인이 필요한 항목

| # | 무엇 | 왜 사람이 정해야 하나 |
|---|---|---|
| A | **C8(soft opt-in 미사용) 개정** | 2026-09-15에 승인된 결정(Q2)을 뒤집습니다. 당시 근거는 "도달 인구 0이라 비용이 없다"였고, 지금은 기능 안내를 보내야 한다는 요구가 생겨 근거가 바뀌었습니다 |
| B | **기능 안내를 service로 분류** | 법적 판단입니다. §2.2의 C-654/23 적용 가능성은 우리 freemium 구조에 대한 해석이며, 조문이 자동으로 답해 주지 않습니다 |
| C | **D4가 받아들이는 오분류 위험** | 추정이 틀린 한국 사용자에게 `(광고)` 없이 발송될 잔여 가능성 |
| D | **AT·IE를 opt_in으로 두는 것** | 도달 범위를 줄이는 사업적 선택입니다 |

---

## 13. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | 우리 freemium 구조가 제13조(2)의 "판매 맥락"에 해당하는가 — 외부 자문 | EEA·GB·CH의 `soft_opt_in` 값 |
| R2 | 정보성 메일을 marketing 스트림으로 보낼 것인가, transactional로 보낼 것인가 | 발송 도메인과 평판 분리(§5.3 C9) |
| R3 | 싱가포르 Second Schedule para 2(2)의 "수신거부 요청을 보낼 이메일 주소"를 현재 footer의 연락처가 충족하는가 | SG 발송 |
| R4 | 한국 국내대리인(정보통신망법 제32조의5) 지정 의무가 Tomverse에 적용되는가 | 이 설계와 무관하게 현재 상태 |

---

## 14. 출처

- ePrivacy 지침 2002/58/EC 제13조 — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- CJEU C-654/23 Inteligo Media (2025-11-13) — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62023CJ0654)
- ICO, PECR 전자우편 마케팅 규칙 — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/)
- ICO, direct marketing과 service message — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-and-regulatory-communications/)
- CNIL, 전자적 수단의 고객·잠재고객 커뮤니케이션 (2026-06-10) — [cnil.fr](https://www.cnil.fr/fr/communication-electronique-quelles-regles)
- 독일 UWG §7 — [gesetze-im-internet.de](https://www.gesetze-im-internet.de/uwg_2004/__7.html)
- 오스트리아 ECG-Liste — [rtr.at](https://www.rtr.at/TKP/service/ecg-liste/ECG-Liste.de.html)
- 아일랜드 S.I. 336/2011 — [irishstatutebook.ie](https://www.irishstatutebook.ie/eli/2011/si/336/)
- 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」 KISA-GD-2025-0037 (2025.12) — [kisa.or.kr](https://www.kisa.or.kr/401/form?postSeq=3608&lang_type=KO)
- 호주 Spam Act 2003 — [legislation.gov.au](https://www.legislation.gov.au/C2004A01214/latest/text)
- ACMA, 스팸 발송 회피 안내 — [acma.gov.au](https://www.acma.gov.au/avoid-sending-spam)
- 싱가포르 Spam Control Act 2007 — [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/SCA2007)
- CAN-SPAM 15 U.S.C. §7702 — [Cornell LII](https://www.law.cornell.edu/uscode/text/15/7702)
