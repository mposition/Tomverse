# 제품 소식 이메일: 분류·근거·국가 판정 재설계 (초안 v2)

> **이 문서의 지위: 초안입니다. 승인되지 않았고, 코드는 하나도 없습니다.**
> 여기 적힌 D1~D6은 제안이며, §12의 승인 항목이 처리되기 전에는 어떤 것도
> 구현하지 않습니다. 이 문서가 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

## 0. 개정 이력

### v2 (2026-09-16) — 독립 검토 1회차 반영

v1은 독립 검토에서 **reject**됐습니다. 지적의 핵심은 셋이고, v2는 그 셋을
구조로 고쳤습니다.

1. **soft opt-in은 메일을 service로 만드는 근거가 아닙니다.** ePrivacy 제13조(2)는
   "원래 direct marketing인 메일"을 조건부로 허용하는 **예외**이지 분류를
   바꾸는 규정이 아닙니다. v1은 근거와 분류를 한 축으로 묶어 범주 오류를
   만들었습니다 → **D1에서 세 축을 분리**했습니다.
2. **service 분류는 안전장치를 우회합니다.** 현재 코드에서
   `classification === "marketing"` 하나가 발송 스트림(`emailSendingIdentityCore.ts:40`),
   marketing kill switch(`emailFeatureFlags.ts:113`), `(광고)`·`<ADV>` 접두어
   (`emailJurisdictionComposition.ts:94`), 관할권 fail-closed를 모두 켭니다.
   v1대로면 한국 사용자가 DOI를 마쳐도 라벨 없이 나갑니다 → **release_notes는
   marketing 분류를 유지**합니다.
3. **저신뢰 신호가 권한을 넓혀서는 안 됩니다.** IP는 발송을 허용하는 근거가
   될 수 없고, 보류하거나 물어보는 데만 쓸 수 있습니다 → **D4를 뒤집었습니다.**

그 밖에 반영한 것: 호주법의 발신자 측 적용(D2a), 스위스·EEA·영국의 기존 계정
소급 불가(D2), 미국 예외의 협소함(D6), 싱가포르의 법정 최소요건과 우리 정책의
분리(D2), release_notes 전용 국가 allowlist(D2), 전역 purpose 모델 교체(D1),
캠페인 audience 범위 포함(§9), 큐에 고정된 정책과 현재 근거의 분리(D5),
가입 경로가 하나가 아니라는 사실(D3).

### v1 (2026-09-16)

최초 초안. 기록으로만 남기며 이 문서가 대체합니다.

---

## 1. 무엇이 문제인가

Tomverse는 신규 플랫폼이고 기능 추가 로드맵이 크게 남아 있습니다. 새 기능을
알리는 이메일은 제품 운영의 기본 수단인데, **지금 구조에서는 한 통도 나갈 수
없습니다.**

원인은 버그가 아니라 도달 경로입니다. 기능 안내는 marketing으로 분류돼 사전
동의를 요구하고, 동의를 수집하는 경로는 설정 화면 하나뿐이며, 그 화면까지
스스로 찾아온 사람은 0명입니다(2026-09-15 `GET /api/admin/marketing-reach`).

**v1은 이것을 "분류를 바꾸면 풀린다"고 봤습니다. 그 진단이 틀렸습니다.**
조사 결과 기능 안내는 대부분의 법역에서 direct marketing이고, 분류를 바꾸는
것은 이름만 바꾸는 일입니다. 실제로 막고 있는 것은 **동의를 물어보는 자리가
제품 어디에도 없다는 것**입니다.

그래서 v2의 중심은 분류가 아니라 **수집 경로와 근거 기록**입니다.

## 2. 조사로 확인된 것 (2026-09-16)

### 2.1 GDPR의 적법근거는 발송 허가가 아닙니다

- **GDPR 제6조**: 주소라는 개인정보를 처리해도 되는가.
- **ePrivacy 지침 제13조**: 그 주소로 광고 이메일을 보내도 되는가.

**CJEU C-654/23 (Inteligo Media, 2025-11-13)**: 제13조(2) 요건을 충족하면
GDPR 제6조 심사는 적용되지 않습니다(제95조 특별법 관계). 반대로 정당한 이익을
들어도 제13조를 통과하지 못하면 보낼 수 없습니다.

OpenAI·Anthropic이 방침에 적은 "동의 또는 정당한 이익"은 앞의 층에 대한
답이고, **"두 회사가 정당한 이익을 쓰니 우리도"라는 결론은 성립하지 않습니다.**

### 2.2 무료 가입이 "판매 맥락"이 되는 조건은 좁습니다

같은 판결이 문을 열되 좁게 열었습니다 — 판결문 53~56문단은 대가가 **간접적이어도**
된다고 했고, 근거는 무료 tier의 비용이 유료 구독가에 내재돼 있다는 **구체적
상품 구조**였습니다. Inteligo의 무료 계정은 약관 수락·무료 콘텐츠·뉴스레터·
유료 콘텐츠가 묶인 구조였습니다.

**"무료 계정이 있고 유료 플랜도 있으면 된다"로 일반화할 수 없습니다.** 영국
ICO도 무료 체험 가입이나 구매 협상은 인정하지만 단순 로그인·탐색은 인정하지
않습니다. 스위스 FDPIC는 **"온라인 계정 개설만으로는 부족"** 하다고 명시하고
실제 판매나 서비스 이용을 요구합니다.

### 2.3 기존 계정은 소급으로 적격이 되지 않습니다

soft opt-in 계열 예외는 전부 **"수집 시점의 거부 기회"** 를 요건으로 답니다
(EU 13(2), UK reg 22(3)(c), DE UWG §7(3) Nr.4, AT TKG 제174조제4항 Z3, IE reg 13(11)(c)).
이미 만들어진 계정은 그 시점이 지나갔고, 나중에 설정 화면을 만들어도 그때의
고지가 생기지 않습니다. [Q2 결정 기록](../ops/q2-marketing-reach-decision.md)도
soft opt-in이 소급되지 않는다고 적었습니다.

### 2.4 한국과 싱가포르

**한국** — KISA 안내서(KISA-GD-2025-0037, 2025.12): 제50조제1항 단서의 거래관계
예외는 **"금전적인 대가를 지불한 거래관계"** 를 요구하고 **"회원가입"을 이름
대어 배제**합니다. 판정 기준은 "수신거부자에게도 반드시 전달해야 하는가"이고,
무료 멤버십 만료 안내조차 홍보로 봅니다. **"마케팅 동의" 라벨은 무효**이며
"광고성 정보 수신동의"여야 하고 약관 동의로 갈음할 수 없습니다.

**싱가포르** — 법정 최소요건은 **opt-out**입니다. Spam Control Act는 대량
미요청 상업 메시지에 `<ADV>`와 수신거부 의무를 지우는 구조이고, s 5(2)는
**가입 시 주소를 적었다는 사실만으로는 동의가 아니라고** 할 뿐입니다. 즉
"싱가포르는 opt-in을 강제한다"는 v1의 서술은 부정확했습니다. 우리가 opt-in을
쓰는 것은 **정책 선택**입니다.

### 2.5 호주법은 수신자가 아니라 우리에게 붙습니다

Spam Act 2003 s 7의 Australian link는 수신자 소재만이 아니라 **발신 조직의
중앙관리·통제가 호주에 있는 경우**를 포함합니다. Tomverse는 호주 법인입니다.
**따라서 우리가 보내는 모든 상업 전자 메시지에 호주법이 겹칩니다** — 수신자가
어느 나라에 있든 s 17(발신자 식별), s 18(수신거부), Sch 2 cl 6(5영업일),
그리고 동의(명시적이거나 **입증 가능한** 추론 동의)가 요구됩니다.

이것이 v1의 가장 큰 누락입니다. v1은 관할권을 "수신자 국가 하나 고르기"로
모델링했는데, 실제로는 **발신자법이 전역 overlay로 깔립니다.**

### 2.6 모든 법역에 공통인 규칙

**혼합 메시지는 광고 쪽으로 기웁니다.** ICO, CNIL, KISA, ACMA, FTC가 각각 같은
말을 합니다. 다만 미국에서는 "링크 하나로 뒤집힌다"가 과장이고, 제목·본문
배치·링크 대상·전체 인상을 함께 봅니다. 호주는 링크된 페이지 내용을 명문으로
봅니다.

---

## 3. D1 — 세 축을 분리합니다

### 결정

지금은 `classification` 하나가 세 가지를 동시에 정합니다. 이를 나눕니다.

| 축 | 값 | 무엇을 정하나 |
|---|---|---|
| `classification` | `transactional` \| `service` \| `legal` \| `marketing` | **법적 성격.** 광고 라벨, 관할권 fail-closed, kill switch, 발송 스트림 |
| `purpose` | `release_notes` 외 기존 값 | 수신자가 끄고 켜는 단위 |
| `permissionBasis` | `express_consent` \| `soft_opt_in` \| `inferred_consent` \| `no_prior_consent` | **왜 보내도 되는가.** 관할권 프로파일이 정함 |

그리고 **`release_notes`의 `classification`은 `marketing`입니다.**

### 왜 marketing으로 두는가

현재 코드에서 `classification === "marketing"`이 켜는 것들입니다.

- `lib/emailSendingIdentityCore.ts:40` — marketing 발송 스트림
- `lib/emailFeatureFlags.ts:113` — marketing kill switch
- `lib/emailJurisdictionComposition.ts:94` — `(광고)`·`<ADV>` 접두어
- `lib/emailTemplateDefinitions.ts:414` — unsubscribe 강제
- 관할권 footer 불완전 시 fail-closed

`service`로 두면 **한국 사용자가 DOI를 마치고 받은 메일에 `(광고)`가 붙지
않습니다.** 라벨은 동의 여부가 아니라 메시지의 성격에서 나오는 의무이므로,
분류를 낮추는 것은 라벨을 잃는 것과 같습니다.

### 그러면 무엇이 service인가 — `account_feature_change`

**수신자가 이미 쓰고 있는 기능이 실제로 바뀔 때** 보내는 좁은 템플릿 하나를
별도로 둡니다. 예: 그 계정이 쓰던 모델의 은퇴, 저장 한도 변경, 기존 기능의
동작 변경. 이것은 계약 이행에 가깝고, 한국 안내서의 "계약 관련 고지가 필요한
정보"에 들어갈 여지가 있는 유일한 범주입니다.

- 수신자 조건: **그 기능을 실제로 보유·사용 중**일 것. 전체 발송 금지.
- 문안: 무엇이 어떻게 바뀌는지와 사용자가 할 일. 홍보·권유·업셀 금지.
- 분류: `service`. 동의 불요, 끌 수 없음은 아님(`service_status`와 같은 층).

**"새 기능이 생겼다"는 여기 들어가지 않습니다.** 없던 것이 생긴 것은 그
사람의 계약 조건 변경이 아닙니다.

### purpose 모델 교체

전역 집합 `CONSENT_REQUIRED_PURPOSES` 하나로는 관할권별 근거를 표현할 수
없습니다(같은 purpose가 한국에서는 동의 필요, 미국에서는 불요). 대체합니다.

```
permissionVerdict({ purpose, classification, jurisdiction, evidence, preference })
  -> { allowed: true } | { allowed: false, reason }
```

- `release_notes`도 `ConsentRecord`를 씁니다. 근거가 무엇이든 **왜 보냈는지가
  행으로 남아야** 하고, 호주법이 추론 동의의 입증책임을 발신자에게 두기
  때문입니다.
- `withdrawAllMarketing()`은 **marketing 분류 전체**를 순회합니다. 동의 기반
  집합만 도는 현재 구현이면 "모든 마케팅 중단" 후에도 release_notes가 켜진 채
  남습니다.

---

## 4. D2 — 근거는 관할권 프로파일이 정하고, 기본은 동의입니다

### 결정

`JurisdictionProfile`에 `releaseNotesBasis`를 추가하고, **초기값은 전부
`express_consent`** 입니다.

| profile | 초기값 | 법정 최소요건 | 완화하려면 필요한 것 |
|---|---|---|---|
| KR | `express_consent` | opt-in (제50조제1항) | 완화 불가 — 회원가입은 예외에서 배제 |
| SG | `express_consent` | **opt-out** (SCA) | 정책 결정. `<ADV>`·수신거부 유지 시 완화 가능 |
| CA | `express_consent` | opt-in (CASL) | 거래 기반 묵시적 동의 데이터 |
| AT | `express_consent` | soft opt-in 가능 | ECG-Liste 조회 연동 |
| IE | `express_consent` | soft opt-in 가능 | 12개월 창 추적 |
| CH | `express_consent` | soft opt-in 가능하나 FDPIC가 **계정 개설만으로는 부족**이라 명시 | 실제 이용·취득 증거 |
| EU | `express_consent` | soft opt-in 가능 | **R1 외부 자문** + 취득 증거 |
| GB | `express_consent` | soft opt-in 가능 | 같음 |
| US | `express_consent` | opt-out (CAN-SPAM) | 정책 결정 |
| AU | `express_consent` | 추론 동의 가능 | **입증 가능한** 관계·관련성 증거 |
| ZZ | `express_consent` | — | — |

**v1과 가장 크게 달라진 곳입니다.** v1은 US·AU를 `no_consent`, GB·EU·CH를
`soft_opt_in`으로 확정했습니다. 근거가 되는 법적 판단(R1)이 나오기 전에
기본값을 확정한 것이 검토에서 blocker로 지적됐습니다.

### 그러면 이 설계가 지금 당장 무엇을 바꾸는가

**근거가 아니라 수집 경로를 바꿉니다.** D3이 가입 시점에 동의를 물어볼 자리를
만들고, D5가 그 증거를 남깁니다. 그 위에서 각 관할권의 값을 하나씩 완화하는
것은 **profile 값 변경 + 새 정책 버전 + 사람의 승인**이며 코드 변경이
아닙니다.

### release_notes 전용 국가 allowlist

`RELEASE_NOTES_ALLOWED_COUNTRY_CODES`를 `MARKETING_ALLOWED_COUNTRY_CODES`와
별도로 둡니다. EU profile이 EEA 30개국을 덮으므로, profile 값 하나를 완화하면
검토되지 않은 국가까지 열립니다. **국가는 명시적으로 추가합니다.**

### D2a — 호주법은 전역 overlay입니다

수신자 국가와 무관하게, 우리가 보내는 모든 marketing 분류 메시지에 다음이
적용됩니다.

- s 17 발신자 식별 + 30일 유효 연락처 → 이미 footer가 충족
- s 18 수신거부 + reg 7(6) **로그인 요구 금지** → 토큰 링크가 충족
- Sch 2 cl 6 **5영업일** → 즉시 처리이므로 충족
- 동의: 명시적이거나 **입증 가능한** 추론 동의

**따라서 `permissionVerdict`는 수신자 관할권 프로파일과 호주 overlay를 함께
평가합니다.** 단일 프로파일 선택으로 모델링하지 않습니다.

---

## 5. D3 — 수집 시점에 물어봅니다

### 결정

계정이 만들어지는 **모든 경로**에서, 주소가 확정되는 바로 그 사건과 원자적으로
다음을 기록합니다.

1. **명시적 동의 요청** — "제품 소식과 새 기능 안내를 이메일로 받겠습니다"
   (체크 안 됨이 기본). 체크하면 그 관할권의 요구에 따라 DOI로 이어집니다.
2. **고지와 거부 기회** — soft opt-in 적격성의 요건이며, 나중에 어떤 관할권을
   완화할 때 비로소 쓰입니다. 지금은 **증거를 모으는 일**입니다.

한국어 화면에서는 **"광고성 정보 수신동의"** 라는 표현을 쓰고 "마케팅 동의"로
적지 않습니다. 관할권별 승인 문구를 두고, **실제 렌더된 문구의 버전과 해시를
기록**합니다.

### 가입 경로가 하나가 아닙니다

- OAuth: NextAuth adapter가 callback 중 생성 (`lib/auth.ts`)
- 이메일 코드: `resolveUserForVerifiedEmail()` (`lib/emailLogin.ts`)
- 향후 모바일

화면의 체크박스 값이 이 경로들을 건너 계정 생성과 원자적으로 기록되지
않습니다. **서명된 pending collection evidence를 발급해 계정 생성 트랜잭션에서
소비**합니다. OAuth 취소·재시도, 다른 탭, 다른 이메일, callback 실패에서
무엇이 남는지는 각 경로의 e2e가 고정합니다.

### 증거는 별도 ledger에 남깁니다

`ConsentRecord`는 이름과 계약이 동의 증거 테이블입니다. 고지 사실을 그 안에
넣으면 일부 소비자가 동의로 읽습니다. **`EmailPermissionEvidence`** 를 따로
두고 다음을 담습니다.

- 취득 사건(무엇을 하다가 주소가 수집됐는지)과 시각
- 렌더된 문구의 버전과 해시, locale, surface
- 거부 여부
- 적격성 시작 시점
- legacy 여부(이 기록이 없는 기존 계정)

---

## 6. D4 — 국가 추정은 권한을 넓히지 않습니다

### v1을 뒤집습니다

v1은 IP를 `low` 신호로 승격해 그 위에서 발송을 허용했습니다. 검토가 여섯 가지
실패 경로를 제시했고 전부 현실적입니다 — 미국 VPN을 쓰는 한국 거주자, 미국
카드를 쓰는 한국 거주자, 미국에서 만들고 한국으로 이주한 계정, KR IP와 SG
언어가 어긋나는 계정(둘 다 opt_in이지만 `(광고)`와 `<ADV>` 중 무엇을 붙일지
결정 불가).

**근본 문제는 프로파일 사이에 전순서가 없다는 것입니다.** "더 엄격한 쪽"은
허용 여부만 정할 뿐 어떤 라벨을 붙일지 정하지 못합니다.

### 결정

1. **저신뢰 신호는 발송을 허용하지 않습니다.** IP·언어·시간대는 (a) 보류하거나
   (b) 사용자에게 국가 확인을 요청하는 데만 씁니다.
2. **발송 허용은 명시적 자기신고나 목적별 적격 증거를 요구합니다.**
3. **신호 충돌은 무조건 보류**입니다.
4. **국가 질문은 없애지 않되 자리를 옮깁니다.** 가입 때 묻지 않고, **동의를
   켜는 순간**에 묻습니다(지금과 같음). 추정은 그 화면의 **기본값을 채우는**
   데만 씁니다 — 사용자가 확인하면 그때 `self_declared`가 됩니다.

### 이것이 목표와 어긋나는 지점

"국가를 마케팅 규칙에 쓰고 싶지 않다"는 요구를 **부분적으로만** 충족합니다.
국가는 여전히 필요하고, 다만 **사람이 답하는 한 번의 확인**으로 줄어듭니다.
국가 없이 보내려면 모든 관할권의 최강 규칙을 동시에 적용해야 하는데, 한국
`(광고)`와 싱가포르 `<ADV>`가 동시에 만족될 수 없어 불가능합니다.

---

## 7. D5 — 문안 규칙과 근거의 재확인

### 문안 규칙

`release_notes` 템플릿이 담을 수 없는 것:

1. 가격·요금제·업그레이드 링크
2. 할인·프로모션 코드·한정 기간 표현
3. 구독을 권유하는 CTA

추가로 미국 예외를 쓸 때를 대비해 **제목 규칙**(제목만 읽은 수신자가 홍보로
읽지 않을 것)과 **본문 순서**(계약 관련 내용이 앞에 올 것)를 규칙에 넣습니다.

강제는 `lib/releaseNotesContentRules.ts`와
`tests/releaseNotesContentRules.test.mjs`가 7개 언어 전부에 대해 합니다.

### 큐에 고정된 정책과 현재 근거

`EmailDelivery`는 enqueue 시점의 정책 버전을 고정합니다. 렌더링 재현에는
맞지만, **근거가 강화된 뒤에도 옛 프로파일을 읽어 보내면 안 됩니다.**

- **렌더링·감사**: 고정된 정책 버전
- **허용 여부**: provider 호출 직전에 **현재 활성 정책**으로 재판정
- 정책이 강화되면 이미 큐에 있는 release_notes는 `permission_revoked`로
  건너뜁니다

---

## 8. D6 — 미국 예외는 좁게만 씁니다

CAN-SPAM 15 U.S.C. 7702조(17)(A)(iii)(I)의 예외는 **기존 계정·구독의 조건이나 기능
변경**, 또는 수신자가 거래상 받을 자격이 있는 업데이트로 좁게 해석됩니다.
"모든 계정에 새 선택 기능을 소개하는 메일"은 그 자체로 해당하지 않을 수
있습니다.

따라서 **미국에서도 release_notes는 기본적으로 상업 메시지 규칙을 따릅니다.**
D1의 `account_feature_change`만이 좁은 예외이고, 그것도 그 기능을 실제로 쓰는
수신자에게만 갑니다.

---

## 9. 변경 범위

### 데이터

| 대상 | 변경 |
|---|---|
| `EmailPreference.purpose` CHECK | `release_notes` 추가 |
| `EmailTemplate.purpose` CHECK | 동일 |
| `JurisdictionProfile` | `releaseNotesBasis` 컬럼 |
| `EmailPermissionEvidence` | 신규 테이블 |
| `EmailDelivery.skipReason` CHECK | `permission_not_established`, `permission_revoked` 추가 |
| `UserSettings.countrySource` | 변경 없음 — 추정은 저장하지 않고 화면 기본값으로만 씀 |

### 코드

새로: `lib/emailPermission.ts`(`permissionVerdict`),
`lib/emailReleaseNotes.ts`, `lib/releaseNotesContentRules.ts`,
`lib/emailCollectionNotice.ts`, `lib/emailAustralianLink.ts`(overlay).

고침: `lib/emailPreferenceCore.ts`(전역 집합 → verdict),
`lib/emailPreferences.ts`(`withdrawAllMarketing` 범위),
`lib/emailJurisdictionCore.ts`(AT·IE 분리, 추정은 허용 근거 아님),
`lib/emailJurisdictionSeed.ts`, `lib/emailTemplateDefinitions.ts`,
`lib/standardEmailLane.ts`, `lib/auth.ts`·`lib/emailLogin.ts`(가입 증거),
`components/email/EmailNotificationSettings.tsx`, `locales/*.ts` 7개.

**AT·IE 분리는 코드 변경입니다.** `profileForCountry()`가 EU 국가 집합을
하드코딩하고 `JurisdictionCountryMap` seed도 그 함수에서 생성되므로, DB 매핑만
고쳐서는 런타임이 바뀌지 않습니다(v1은 이를 "데이터 한 줄"이라고 잘못
적었습니다).

### 캠페인·운영 (v1에서 빠졌던 것)

- audience: `emailAudienceExpansionCore.ts`의 cohort가
  `marketing_consent` + `product_updates`로 고정돼 있어 release_notes 수신자
  집합이 존재하지 않습니다. **발송 판정과 같은 순수 함수**를 estimate·fan-out·
  send-time이 공유하게 합니다.
- 관할권별·근거별 예상 수신자 수와 제외 사유 집계를 dry-run에서 제공
- **release_notes 전용 kill switch** (`feature.emailReleaseNotesEnabled`)
- admin 승인 화면에 분류·근거·링크 대상 표시
- 활성화 전 0건 발송 검증

---

## 10. 무엇을 하지 않는가

- 프로모션·뉴스레터의 근거를 바꾸지 않습니다(C1 유지).
- DOI를 없애지 않습니다. 오히려 초기값이 전부 `express_consent`이므로 DOI가
  모든 관할권의 기본 경로입니다.
- 기존 계정을 soft opt-in으로 편입시키지 않습니다. **소급 불가**이며, 기존
  계정이 받으려면 DOI를 지납니다.
- 가입을 막지 않고, 국가를 가입 필수 항목으로 만들지 않습니다.
- ECG-Liste 연동, 12개월 창 추적, 한국 2년 재확인 배치는 이 작업 밖입니다.

---

## 11. 구현 순서

전 단계가 **`feature.emailReleaseNotesEnabled` 기본 `false`** 뒤에서
비활성으로 배포됩니다. flag가 꺼져 있으면 enqueue와 기존 큐의 발송이 모두
거부됩니다.

| # | 단계 | 왜 이 순서인가 | 검증 |
|---|---|---|---|
| S0 | 상위 정책 개정 승인(§12) | 코드가 문서를 앞서지 않습니다 | 사람 |
| S1 | `permissionVerdict` + 호주 overlay + `withdrawAllMarketing` 범위 | 게이트를 먼저 만들고 그 뒤에 그 게이트를 지날 것을 만듭니다 | unit + DB 통합. **Codex 검토** |
| S2 | `EmailPermissionEvidence` + 모든 가입 경로의 고지·증거 | 증거가 없으면 어떤 완화도 근거를 못 댑니다 | e2e(OAuth·이메일 코드) + DB 통합. **Codex 검토** |
| S3 | `release_notes` purpose + 템플릿 + 문안 규칙 + allowlist | 보낼 물건은 게이트와 증거가 선 뒤에 만듭니다 | unit + 7개 언어 + enum-constraints |
| S4 | audience·dry-run·admin 표시 | 발송 전에 누가 받는지 셀 수 있어야 합니다 | 통합 + dry-run 0건 검증 |
| S5 | `account_feature_change` (service, 좁은 범위) | 별개 범주라 마지막 | unit + 통합 |
| S6 | 문서 개정, 새 정책 버전 초안 | | 정적 검사 + 사람 활성화 |

**어느 단계도 그 자체로 발송을 열지 않습니다.** 여는 것은 사람이 정책 버전을
활성화하고 flag를 켜는 두 행위입니다.

---

## 12. 승인이 필요한 항목

| # | 무엇 | 왜 사람이 정해야 하나 |
|---|---|---|
| A | **C8(soft opt-in 미사용) 개정 — 부분** | v2는 soft opt-in을 *지금* 쓰지 않습니다. 다만 그 적격성 증거를 모으기 시작하는 것이 C8의 전제를 바꿉니다 |
| B | **release_notes를 marketing 분류로 두고 DOI를 기본 경로로 삼는 것** | 도달이 즉시 늘지 않는다는 뜻입니다. 대신 늘릴 수 있는 구조가 생깁니다 |
| C | **가입 화면에 동의 요청과 고지를 넣는 것** | 가입 전환율에 영향을 줍니다 |
| D | **`account_feature_change`의 범위** | "이미 쓰는 기능의 변경"의 경계는 제품 판단입니다 |
| E | **각 관할권을 언제 완화할 것인가** | R1 외부 자문 결과에 달려 있습니다 |

---

## 13. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | 우리 freemium 구조가 제13조(2)의 "판매 맥락"에 해당하는가 — 외부 자문 | EEA·GB의 완화 |
| R2 | release_notes를 marketing 스트림으로 보내는 것이 맞는가(분류상 그렇게 됩니다) — 평판 영향 | 발송 도메인 |
| R3 | 싱가포르 Second Schedule para 2(2)의 "수신거부 요청을 보낼 이메일 주소"를 현재 footer가 충족하는가 | SG 발송 |
| R4 | 한국 국내대리인(제32조의5) 지정 의무가 적용되는가 | 이 설계와 무관한 현재 상태 |
| R5 | 호주 추론 동의가 우리 계정 관계에서 성립하는가 | AU 완화 |

---

## 14. 출처

- ePrivacy 지침 2002/58/EC 제13조 — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- CJEU C-654/23 Inteligo Media (2025-11-13) — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62023CJ0654)
- ICO, PECR 전자우편 마케팅 규칙 — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/)
- ICO, direct marketing과 service message — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-and-regulatory-communications/)
- CNIL, 전자적 수단의 고객·잠재고객 커뮤니케이션 (2026-06-10) — [cnil.fr](https://www.cnil.fr/fr/communication-electronique-quelles-regles)
- 스위스 FDPIC, 광고·마케팅 — [edoeb.admin.ch](https://www.edoeb.admin.ch/de/werbung-marketing)
- 독일 UWG §7 — [gesetze-im-internet.de](https://www.gesetze-im-internet.de/uwg_2004/__7.html)
- 오스트리아 ECG-Liste — [rtr.at](https://www.rtr.at/TKP/service/ecg-liste/ECG-Liste.de.html)
- 아일랜드 S.I. 336/2011 — [irishstatutebook.ie](https://www.irishstatutebook.ie/eli/2011/si/336/)
- 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」 KISA-GD-2025-0037 (2025.12) — [kisa.or.kr](https://www.kisa.or.kr/401/form?postSeq=3608&lang_type=KO)
- 호주 Spam Act 2003 — [legislation.gov.au](https://www.legislation.gov.au/C2004A01214/latest/text)
- ACMA, 스팸 발송 회피 안내 — [acma.gov.au](https://www.acma.gov.au/avoid-sending-spam)
- 싱가포르 Spam Control Act 2007 — [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/SCA2007)
- IMDA, 미요청 커뮤니케이션 실무 — [imda.gov.sg](https://www.imda.gov.sg/infocomm-regulation-and-guides/unsolicited-communications/best-practices-for-organisations)
- CAN-SPAM 15 U.S.C. 7702조 — [Cornell LII](https://www.law.cornell.edu/uscode/text/15/7702)
- FTC, CAN-SPAM 준수 안내 — [ftc.gov](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
