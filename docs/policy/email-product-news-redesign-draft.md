# 제품 소식 이메일: 권한과 기계 (초안 v11)

> **이 문서의 지위: 초안입니다. 승인되지 않았고, 코드는 하나도 없습니다.**
> **S1(기계 보강)은 착수할 수 있습니다** — G는 EEA·영국 soft opt-in만 막습니다.
> 그 밖의 단계는 12절의 선행 결정이 닫힌 뒤입니다. 이 문서가
> 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

## 0. 개정 이력

### v11 (2026-09-16) — 독립 검토 7회차 반영과 소유자 결정

7회차는 **제가 앞서 말한 것 두 가지를 뒤집었습니다.**

1. **미국 opt-out은 우리에게 열려 있지 않습니다.** 우리는 호주 법인이라 보내는
   **모든** 상업 메일에 Australian link가 붙고(Spam Act s 7(b)(ii), 중앙관리·
   통제가 호주), s 16은 명시적 또는 추론 동의를 요구합니다. 수신자가 미국이어도
   마찬가지입니다. **호주 규칙이 전 세계 발송의 바닥입니다**(4.2).
2. **싱가포르는 opt-out이 아닙니다.** Spam Control Act만 봤는데, PDPA가 개인정보를
   direct marketing에 쓸 때 명시적 opt-in을 요구하고, PDPC는 고지로 간주된 동의를
   마케팅에 쓸 수 없다고 명시합니다(4.3).

그리고 **기존 사용자에 대한 판단이 넓어졌습니다.** 우리 방침이 "신청하신 경우에만
보냅니다"라고 약속해 왔으므로, 호주 추론 동의의 "합리적 예상"을 우리 문서가
부정하고, 미국에서는 소급 완화가 FTC Section 5 위험입니다. 따라서 기존 78계정은
**어느 법역이든 근거가 없습니다.**

**소유자 결정(2026-09-16)**

- 기존 78계정은 **전원 발송, `risk_accepted`로 기록**(5.6). 동의 기록은 지어내지
  않습니다.
- 한국은 **보냅니다 — 법정 의무 전부 구현**(7.7). 14일 처리결과 통지, 2년 고지,
  footer 전화번호, 한·영 수신거부 안내. v7의 "보류"를 거둡니다.
- **G는 EEA·영국 soft opt-in만 막습니다.** S1 착수 허용.

코드 계약도 닫았습니다 — 미체크 사용자의 국가 확정 경로(5.3), 발송 판정의 전체
입출력과 두 시점 snapshot(7.6), 주소 전역 suppression 잠금(7.4), 템플릿 메타데이터
저장 방식 결정(7.2), 30일 키 보존의 canary 토큰(7.5).

### v10 (2026-09-16) — 승인 반영과 기존 사용자 처리

소유자 승인: A·B·C·E 승인, D는 방향 변경(한국도 동의 체크박스), F는 범위
한정 승인, G는 미결.

그리고 **기존 78계정의 처리 방법이 정해졌습니다.** 개별 연락은 비현실적이므로
**제품 안에서 한 번 묻습니다**(5.4) — 이메일이 아니라 로그인 후 화면이라 EEA의
"동의를 구하는 이메일도 광고" 문제와 한국의 "전송" 정의를 함께 피합니다.
응답하지 않은 분들은 법역별로 나뉘고(5.5), 사전 동의가 필요한 법역에 보내기로
한 결정은 **동의가 아니라 `risk_accepted`로 기록**합니다(5.6).

현재 위험 판단의 근거도 문서에 적었습니다 — 계정 78개, 전원 지인 경로,
순수 유입 0. **"법이 허용한다"가 아니라 "적발 가능성이 낮다"** 이며 그 구분을
남깁니다.

### v9 (2026-09-16) — 독립 검토 6회차 반영

v8은 순서(기계 → 기록 → 근거 → 분류)와 방향은 인정받았고, **중심 계약 여섯
개가 닫히지 않아 반려**됐습니다. v9가 그것을 닫습니다.

| 지적 | v9의 처리 |
|---|---|
| **L1** EU 근거를 자문 전에 확정 | EEA·영국은 **`express_consent`로 시작**하고, soft opt-in은 회원국별 해제 게이트로 둡니다 |
| **L2** 체크박스 하나에 동의와 이의 없음을 동시에 부여 | **두 장치로 분리** — opt-in 체크박스와 고지·독립 거부 수단은 다른 것입니다 |
| **L3** 호주 추론 동의의 관계 판정이 미정 | **관계 lifecycle 모델**을 설계에 넣고, 그 전에는 AU도 닫습니다 |
| **L4** 기존 사용자 처리 부재 | **신규/기존 × 국가 × 근거 전환표**. 소급 backfill 금지 |
| **L5** "제품 내"의 경계가 넓음 | 인증된 화면에서 사용자가 열었을 때만. 푸시·알림·백그라운드 제외 |
| **L6** Lululemon 사실 오류 | 2026년 3월, **오분류로 수신거부 수단이 아예 없던 사건**으로 정정 |
| **C1** 템플릿 메타데이터 drift | DB와 코드가 다르면 **fail-closed**. 저장된 `requiresUnsubscribe=false`를 신뢰하지 않음 |
| **C2** 철회와 발송의 경합 | (주소, purpose) **직렬화 키**와 잠금 안의 최종 재검사 |
| **C4** 증거 장부가 답을 완결하지 못함 | `ConsentRecord`(동의) + `EmailPermissionEvent`(고지·관계) + `EmailPermissionDecision`(발송별 판정) 세 층 |
| **C5** basis를 profile에 두면 AT·IE를 표현 못 함 | 국가 단위 **`ReleaseNotesCountryRule`** 로 분리. allowlist는 그 rule의 status |
| **C6** v7의 계약이 압축되며 사라짐 | 5절·7절에 **복원**했습니다 |
| **C7** 순서의 두 구멍 | 수집 표면에 별도 게이트, 법적 문안 승인을 S3 앞으로 |

### v8 이전

v1 service 분류(reject) → v2 세 축 분리 → v3 범위 축소 → v4~v6 계약 보완 →
v7 한국 세 층 → v8 기계 우선·근거 축 복원. 각 회차의 지적과 대응은 git
이력에 있습니다.

---

## 1. 무엇이 문제인가

기능 안내 메일이 한 통도 나가지 못합니다. 원인은 둘입니다.

1. **동의를 물어볼 자리가 제품에 없습니다.** 설정 화면이 유일한 경로이고, 거기
   까지 스스로 찾아온 사람은 0명입니다(2026-09-15 `GET /api/admin/marketing-reach`).
2. **우리 정책이 peer보다 보수적입니다.**
   [이메일 알림](email-notifications.md) §5.1 C1(전역 opt-in)과
   [같은 문서](email-notifications.md) §5.6 C8(soft opt-in 미사용)은 법이 아니라
   우리가 고른 것이고, 그 문서가 스스로 "사업적 결정"이라 적었습니다.

---

## 2. 조사 결과 (요약)

### 2.1 판정 기준은 법역마다 다릅니다

| 법역 | 기준 | 숨은 목적이 분류를 바꾸는가 |
|---|---|---|
| EU/EEA · 영국 · 한국 | 목적 | **예** |
| 호주 · 싱가포르 | 목적이되 판단 자료가 메시지와 링크로 한정 | 아니오 |
| 미국 | 내용 | **아니오** — FTC가 발신자 의도 기준을 명시적으로 거부 |

### 2.2 EEA는 열릴 수 있지만 아직 아닙니다

CJEU C-654/23(2025-11-13)은 무료 계정도 "서비스 판매의 맥락"에 **해당할 수
있다**고 했고, 근거는 그 사건의 **구체적 상품 구조**(유료 구독이 무료 이용을
간접 재정 지원)였습니다. CNIL 2026 지침도 "certains cas"로 한정하며, **구매 없는
일반 전자상거래 계정은 반대 사례**로 듭니다.

**따라서 프랑스 예시를 EEA 전체에 적용할 수 없습니다.** 회원국별 국내법 구현도
다릅니다(독일 UWG는 더 엄격할 수 있고 미조사).

### 2.3 peer 여덟 곳의 flow

가입 시 문장 한 줄(Anthropic), 방침의 opt-out만(OpenAI·US SaaS·7-Eleven),
근거 불명(DeepSeek). **아무도 "정보성이라 예외"를 주장하지 않습니다.**

### 2.4 한국 — 적용되지만 집행되지 않고, 대안이 있습니다

제5조의2가 국외행위에 적용되고 무료 회원가입은 거래관계 예외에서 명문 배제.
집행 사례는 없음. **KISA가 "접속해서 보게 된 것은 전송이 아니다"라고 적습니다.**
**D 결정으로 한국은 동의를 받아 이메일로 보내고 법정 의무를 전부 구현합니다**(7.7).

### 2.5 호주 — 전 세계 발송의 바닥입니다

Spam Act s 7의 Australian link는 **선택적 요건 목록**이고, 어느 하나만 걸려도
적용됩니다. 수신자 측 limb(s 7(c)(d))도 있지만, **우리에게 결정적인 것은 발신자
측 limb**입니다 — s 7(b)(ii) "중앙관리·통제가 호주에 있는 조직".

**Tomverse는 호주 법인이므로 우리가 보내는 모든 상업 메일에 호주법이 붙습니다.**
수신자가 미국이든 한국이든 마찬가지이고, s 16은 **명시적 또는 추론 동의**를
요구합니다. 그래서 미국의 CAN-SPAM opt-out은 **수신자 측 요건을 충족할 뿐** 우리
발송의 근거가 되지 못합니다.

ACMA는 계정 관계를 추론 동의 근거로 인정하되 **관계가 끝나면 안 되고** 수신자가
마케팅을 **합리적으로 예상**할 수 있어야 한다고 봅니다. 입증책임은 발신자(s 16(5)).

### 2.6 집행 기록이 말하는 것

2020년 이후 ACMA 스팸 집행 약 27건의 사유 — 수신거부 부재·미작동 ~20, 무동의
~19, 철회 후 발송 ~14, **오분류 7**, 발신자 정보 6, 수신거부에 로그인 요구 1.

**정정(v8의 오류)**: Lululemon A$702,900은 **2026년 3월** 발표이고, 서비스
메일에 판촉을 섞어 **오분류한 결과 수신거부 수단이 아예 없던** 사건입니다.
"수신거부 미작동 하나"가 아니라 **분류 불변식과 수신거부 불변식을 함께**
보여 주는 사례입니다.

---

## 3. D1 — 분류는 marketing, purpose는 분리

`release_notes` purpose를 만들고 **`classification`은 `marketing`으로 둡니다.**
`classification === "marketing"` 하나가 발송 스트림·kill switch·`(광고)`·`<ADV>`
접두어·unsubscribe 강제·관할권 fail-closed를 켭니다. 낮추면 한국 사용자가
동의를 마치고 받은 메일에 라벨이 붙지 않습니다.

`withdrawAllMarketing()`이 `recordsConsent(purpose)`로 대상을 고르므로
(`lib/emailPreferences.ts`), **purpose 표에 classification을 두고 그것을 철회의
단일 source로 씁니다.** 정적 검사가 템플릿 정의와의 일치를 강제합니다.

---

## 4. D2 — 권한: 국가 rule과 이중 authority

### 4.1 저장 위치를 나눕니다 (C5)

- **`JurisdictionProfile`** — 표시·footer·라벨. 지금 그대로.
- **`ReleaseNotesCountryRule(policyVersionId, countryCode, basis, status, conditions)`**
  — **권한**. 국가 단위이므로 EU profile 아래의 AT·IE가 다른 값을 가질 수
  있습니다. **allowlist는 별도 상수가 아니라 이 rule의 `status`** 입니다(drift 제거).

### 4.2 판정은 authority별로 남기고, 전부 통과해야 보냅니다

수신자 관할권 authority와 **호주 발신자 authority**를 각각 평가합니다.
**최종 허용은 모든 authority가 허용할 때만** 성립합니다. 미국 수신자라면
CAN-SPAM(수신자 authority)을 통과하고 **동시에** 호주 동의(발신자 authority)가
있어야 합니다.

하나의 근거가 양쪽을 충족하면(예: 명시적 동의) 그 사실도 기록합니다. 판정
함수의 전체 입출력은 7.6입니다. **이 함수 하나를 estimate·audience expansion·
writer·drain이 공유합니다.**

### 4.3 출발 값

아래는 **수신자 authority**의 값입니다. 모든 행 위에 **호주 발신자 authority**
(명시적 또는 추론 동의)가 함께 걸립니다.

| 국가 | 수신자 authority 출발 값 | 해제 조건 |
|---|---|---|
| **US** | `opt_out` | 수신자 측은 이것으로 충분. **발송 가능 여부는 호주 authority가 정합니다** |
| **AU** | 4.4의 관계가 서면 `inferred_consent` | 4.4의 여섯 항목 |
| **SG** | **`express_consent`** | PDPA가 direct marketing에 opt-in 요구. SCA의 `<ADV>`·수신거부 이메일 요건은 별도 표시 의무로 유지 |
| **KR** | `express_consent` | 가입 화면 동의 + DOI. 7.7의 법정 의무 전부 구현 |
| **EEA 각국·GB** | `express_consent` | **G(R1 외부 자문)** 가 회원국별로 확인하면 soft opt-in |
| **CH·CA·AT·IE** | `express_consent` | CH는 FDPIC, AT는 ECG-Liste, IE는 12개월 창 |
| **ZZ** | 발송 안 함 | — |

**신규 가입자의 호주 추론 동의**는 E(방침 개정)가 시행된 뒤, 5.1의 고지를 본
계정에만 성립합니다. 그 전에 가입한 계정은 5.5·5.6입니다.

`risk_accepted`는 이 표의 값이 아닙니다 — 국가 rule은 그대로 두고, 그 위에서
내린 결정으로 5.6에 따라 기록됩니다.

### 4.4 호주 관계 lifecycle (L3)

추론 동의를 주장하려면 **관계를 추론하는 함수가 아니라 사건을 저장하는 모델**이
필요합니다.

| 항목 | 정의 |
|---|---|
| 시작 사건 | 계정 생성 시 주소를 **본인이 직접 입력**했고, 그 시점 고지가 있었을 것 |
| 유지 조건 | 계정이 살아 있고 최근 활동이 있을 것(기준값은 S4에서 정하고 문서에 적음) |
| 종료 사건 | 계정 삭제·해지, 휴면 기준 초과, 수신거부 |
| 휴면·무료 계정 | 휴면은 종료로 취급. 무료 계정도 관계는 성립하되 **콘텐츠 관련성**을 더 좁게 |
| 관련 콘텐츠 범위 | 그 사람이 쓰는 제품의 기능. 별개 제품군 교차판매는 제외 |
| 종료 시 즉시 전환 | 종료 사건이 기록되면 그 순간부터 발송 불가. suppression과 동일 층 |

---

## 5. D3 — 수집: 두 장치를 분리합니다 (L2)

**하나의 체크박스가 동의와 이의 없음을 동시에 뜻할 수 없습니다.** "제품 소식을
받겠습니다"를 체크하지 않은 행동은 합리적으로 **거절**로 읽힙니다.

### 5.1 가입 흐름에 두 가지를 둡니다

1. **opt-in 체크박스** (체크되지 않은 상태) — **동의**입니다. 체크하면 DOI로
   이어집니다. 미체크를 다른 의미로 재해석하지 않습니다. 한국어 문구는
   **"이메일 광고성 정보 수신동의 (선택)"** — 채널과 선택성을 명시합니다.
2. **고지 문장과 독립 거부 수단** — 무엇을 보내는지 적고, 체크박스와 별개인
   거부 링크를 둡니다.

세 상태는 **서로 독립**으로 저장합니다 — `expressOptInRequested`, `noticeShown`,
`objected`. 하나에서 다른 하나를 추론하지 않습니다.

두 장치의 **정확한 문안과 선택 상태를 불변 artifact로 보존**합니다.

### 5.2 계정 확정 경계 (C6, v7에서 복원)

OAuth는 NextAuth adapter가 callback 중 계정을 만들고(`lib/auth.ts`), 이메일
코드는 `resolveUserForVerifiedEmail()`이 만듭니다(`lib/emailLogin.ts`).
`createUser`에는 provider·state가 오지 않습니다.

**`SignupConsentAttempt`**

| 필드 | 뜻 |
|---|---|
| `nonceHash` | 클라이언트가 가진 값의 해시. 원본 미저장 |
| `channel` | `oauth` \| `email_code` |
| `binding` | oauth는 provider, email_code는 **`EmailLoginAttempt` id와 정규화된 주소** |
| `expressOptInRequested` · `noticeShown` · `objected` | 두 장치의 결과(5.1, 서로 독립) |
| `expiresAt` · `consumedAt` · `supersededAt` · `userId` | 소비 결과 |

- `attemptId`는 **탭 범위 `sessionStorage`**. 쿠키를 쓰지 않습니다.
- **로그인이 끝난 뒤 finalize** — 인증된 세션을 신뢰하고, 그 계정이 **이
  흐름에서 방금 만들어진 것**일 때만 소비합니다.
- 소비는 **`consumedAt IS NULL AND supersededAt IS NULL AND expiresAt > now()`
  조건의 compare-and-set 한 번**.
- **소비·권한 사건 기록·확인 메일 생성은 한 transaction**입니다. 따로 두면 선택은
  소비됐는데 메일이 없는 상태가 남습니다.
- **기존 사용자의 로그인은 절대 소비하지 않습니다.**
- 체크 해제 후 재시도는 이전 행을 `supersededAt`으로 무효화하고, 무효화와 새 행
  발급은 한 transaction입니다.
- 소비 실패·만료·탭 닫힘에도 **계정 생성은 성공**합니다.

| 지금 | 사건 | 다음 |
|---|---|---|
| `pending` | 소비 성공 | `consumed` |
| `pending` | 같은 브라우저가 새로 발급 | `superseded` |
| `pending` | 만료 | `expired` |
| 그 밖 | 무엇이든 | 변하지 않음 |

### 5.3 국가는 로그인 직후 한 번 묻습니다 (C8)

v9는 국가를 DOI 확인 화면에서만 물었습니다. 그러면 **체크하지 않은 사용자는
확인 메일이 없으므로 국가가 영영 정해지지 않고**, 어떤 rule 아래서 고지를
봤는지도 증명할 수 없습니다.

그래서 **모든 신규 계정이 로그인 직후 거치는 인증된 화면**에서 국가를 확정하고,
**그 국가의 rule에 맞는 장치를 그 자리에서** 보여 줍니다.

- 추정값(IP·언어·시간대)으로 기본을 채우되, 사용자가 확인해야 `self_declared`.
- 확정 전에는 어떤 marketing 판정도 통과하지 않습니다.
- `notice_shown` 사건에 **그때 적용된 국가와 rule 버전**을 함께 남깁니다.
- 한국이 확정되면 그 화면에서 **이메일 광고성 정보 수신동의·발신자·내용 범위·
  철회 방법**을 보여 주고, 렌더된 문구의 해시를 남깁니다.

DOI 확인 화면은 동의한 사람의 **주소 확인**만 담당합니다. 최종 POST는
`token`을 받아 `setPreference()` transaction 안에서 처리합니다.

### 5.4 기존 사용자 — 제품 안에서 한 번 묻습니다

**소급으로 적격이 되지 않습니다.** 방침 변경 고지는 과거 수집 시점의 거부
기회를 만들지 않고, **evidence도 consent도 만들지 않습니다.**

그런데 기존 사용자는 전부 **로그인해서 제품을 쓰는 분들**입니다. 그래서 개별
연락 없이 **실제 동의를 받을 수 있습니다** — 다음 접속 때 **일회성 안내를
화면에 띄웁니다.**

- **이메일이 아니므로 ePrivacy 제13조의 대상이 아닙니다.** "동의를 구하는
  이메일" 자체가 EEA에서 direct marketing이라 보낼 수 없는 문제를 피합니다.
- **한국에서도 "전송"이 아닙니다**(KISA 안내서, 9절).
- 부품은 5.1의 opt-in 체크박스와 같고 배치만 다릅니다.
- 누르지 않아도 불이익이 없고, 한 번 닫으면 다시 뜨지 않습니다. 닫은 사실은
  `notice_shown`으로 남되 **동의도 거부도 아닙니다.**

이렇게 동의한 주소는 법역과 무관하게 `express_consent` 위에 섭니다.

### 5.5 기존 사용자에게는 근거가 없습니다

우리 방침은 지금까지 **"신청하신 경우에만 보냅니다"** 라고 약속했습니다.

- 호주 추론 동의의 **"합리적 예상"을 우리 문서가 부정**합니다.
- 미국에서 기존 데이터에 대한 개인정보 약속을 **소급해 완화하면 FTC Section 5
  위험**입니다(Gateway Learning, 2004).
- 방침 변경 고지는 **기존 사용자에게 새 권한을 만들지 않습니다.**

**그래서 기존 78계정은 어느 법역에서도 5.4의 제품 내 동의 없이는 근거가
없습니다.** 제품 내 안내로 동의한 분은 `express_consent` 위에 섭니다.

### 5.6 `risk_accepted` — 근거가 아니라 기록된 결정

**이것은 법적 근거가 아닙니다.** 근거 없이 보내기로 한 **사업 결정**이고, 그
사실을 있는 그대로 남기는 이름입니다.

**소유자 결정(2026-09-16)**: 기존 78계정 **전원에게 발송**, `risk_accepted`로
기록. 판단 근거는 계정 78개·전원 지인 경로·순수 유입 0이며, **"법이 허용한다"가
아니라 "적발 가능성이 낮다"** 입니다. 범위는 **전 법역**이고, 미국에서는 방침
약속 위반(FTC) 위험까지 포함합니다.

쓰는 규칙입니다.

1. **동의를 지어내지 않습니다.** `ConsentRecord(granted)`를 쓰지 않습니다. 실제로
   없던 동의를 장부에 적으면 대조되는 날 실수가 아니라 위조로 보입니다.
2. **승인자·날짜·범위를 함께 기록합니다.** `EmailPermissionDecision`에 남습니다.
3. **admin 화면에 그대로 보입니다.** 숨기면 다음 사람이 동의로 읽습니다.
4. **동의가 들어오면 덮입니다.** 그 주소가 5.4의 안내나 설정에서 동의하면 근거가
   `express_consent`로 바뀌고, 이전 결정은 이력으로 남습니다.
5. **표시 의무는 면제되지 않습니다.** `risk_accepted`로 보내도 수신자 관할의
   라벨·명시사항·수신거부는 그대로입니다 — 한국 수신자에게는 `(광고)`와 별표 6,
   수신거부 시 14일 처리결과 통지(7.7).
6. **범위가 닫혀 있습니다.** 기존 78계정에만 적용되며 신규 가입자에게 확장되지
   않습니다.
7. **재검토 시점을 적습니다.** 순수 유입이 생기거나, 수신거부·불만이 들어오면 다시
   판단합니다.

## 6. D4 — 기록: 세 층 (C4)

| 장부 | 담는 것 |
|---|---|
| **`ConsentRecord`** (기존) | **명시적 동의**의 생애 — 요청·부여·철회·재확인 |
| **`EmailPermissionEvent`** (신규, append-only) | 고지와 관계의 사실 — `notice_shown`, `objected`, `relationship_started`, `relationship_ended`, `basis_ended` |
| **`EmailPermissionDecision`** (신규) | **발송별 판정** — 어떤 authority를 어떤 evidence로 통과했는지 |

**두 장부가 같은 사실의 경쟁 source가 되지 않습니다.** 동의는 `ConsentRecord`
하나가 말하고, 나머지 사실은 `EmailPermissionEvent`가 말합니다.

`EmailPermissionDecision`이 담는 것 — `deliveryId`, 적용 authority 목록과 각
결과, 참조한 evidence id들, `policyVersionId`와 `ruleVersion`, **발송 직전
suppression 판정 시각**, **provider 제출 시각**. `risk_accepted`로 보낸 건은
**승인자·승인일·적용 범위**를 함께 담습니다(5.6).

**판정 snapshot은 두 개입니다** — enqueue 시점의 판정과 **provider 제출 직전의 현재
판정**. 한 개의 `policyVersionId`로 두 시점을 표현할 수 없으므로 각각 버전을
담습니다(7.6).

그 밖에 필요한 것 — `purpose`와 권한 범위, `copyHash`가 가리키는 **실제 불변
문안 artifact**, 주소 정규화 규칙, 보존 기간, 그리고 반대 사건의 발생 시각.

**위탁해도 우리 기록입니다**(ACMA Statement of Expectations).

---

## 7. D5 — 기계: 벌금이 실제로 나오는 곳

### 7.1 불변식

| # | 불변식 | 현재 상태 |
|---|---|---|
| 1 | **marketing 분류에는 예외 없이 수신거부** | **부분** — 재분류 시 구멍(7.2) |
| 2 | 로그인·개인정보 없는 one-click | **있음.** rate limit 조정 필요(7.3) |
| 3 | **철회 후 발송 0건** | **없음** — 경합 구간(7.4) |
| 4 | 수신거부 주소가 발송 후 30일 이상 유효 | **증명 불가** — canary 토큰(7.5) |
| 5 | 전체 수신거부 선택지 | **부분 구현** — `withdrawAllMarketing()` 범위 |
| 6 | suppression이 **고객 대상 lane** 모든 발송보다 우선 | **부분** — purpose 철회뿐 아니라 **주소 전역 suppression에도 경합**(7.4) |
| 7 | 재구독 권유 금지 | **없음** |
| 8 | 관계 종료 시 중단 | **없음** — 4.4 선행 |
| 9 | **법적 발신자 정보가 없으면 marketing은 fail-closed** — 한국은 별표 6의 명칭·**전자우편주소·전화번호**·주소 | **부분** — 한국 footer에 **전화번호 block이 없습니다** |
| 10 | end-to-end synthetic 점검 | **없음** |
| 11 | **발송 판정 조회 오류는 영구 실패가 아니라 재시도** | **없음** — 현재 drain은 예상 밖 오류를 영구 `failed`로 만듭니다(7.6) |

### 7.2 템플릿 메타데이터 drift (C1) — 저장 방식을 정했습니다

`ensureTemplateVersion()`이 기존 `EmailTemplate`에 `update: {}`를 씁니다
(`lib/emailTemplateRegistry.ts`). 코드에서 분류를 바꿔도 DB의 `classification`과
`requiresUnsubscribe`는 옛 값으로 남고, 발송기는 **분류는 코드에서, 수신거부
여부는 DB 행에서** 읽습니다. **재분류된 템플릿이 수신거부 없이 나갑니다** —
Luxottica·Lululemon의 형태입니다.

**결정: classification·purpose·requiresUnsubscribe를 immutable `TemplateVersion`
메타데이터로 둡니다.** "새 template key" 대안은 채택하지 않습니다(감사 이력이
key마다 끊깁니다).

- 새 `TemplateVersion`을 만들 때 그 셋을 함께 저장하고 이후 바꾸지 않습니다.
- **registry와 drain 모두** 코드 정의와 **정확히** 비교하고, 다르면 fail-closed.
- marketing 분류면 저장된 `requiresUnsubscribe=false`를 **신뢰하지 않고** 강제합니다.

### 7.3 수신거부 rate limit

`/api/unsubscribe`의 IP 기준 20회/분·200회/일 제한은 기업 NAT나 메일 사업자의
one-click 요청을 429로 만들 수 있습니다. **유효 토큰은 본질적으로 해지밖에
못 하므로 유효 요청은 처리하고, 제한은 invalid token 남용에 겁니다.**

### 7.4 철회와 발송의 경합 (C2, C10)

suppression은 `lib/standardEmailLane.ts`에서 확인한 뒤 여러 DB 조회·렌더링·지연
처리를 거쳐 provider를 호출합니다. 그 사이에 커밋된 것은 잡지 못합니다.

경합은 **두 종류**입니다.

- **purpose 철회** — 사용자가 특정 purpose를 끔.
- **주소 전역 suppression** — hard bounce, complaint, privacy request. **모든
  purpose에 걸립니다.**

그래서 잠금도 둘입니다.

1. **`(normalizedAddress, *)`** — 주소 전역 suppression writer와 모든 고객 발송이
   잡습니다.
2. **`(normalizedAddress, purpose)`** — purpose 철회와 그 purpose 발송이 잡습니다.

**획득 순서는 1 → 2로 고정**합니다(교착 방지). sender는 **두 잠금 안에서 최종
suppression을 재검사한 뒤 provider 제출까지** 마칩니다. 철회가 먼저 이기면
sender가 관측하고 중단하고, sender가 먼저 이기면 철회 응답은 제출이 끝난 뒤
완료됩니다.

보장 문구는 관측 가능한 사건으로 적습니다 — **"철회 또는 suppression 커밋
이후 시작된 provider 제출 0건"**, 그리고 두 시각을 `EmailPermissionDecision`에
남깁니다.

### 7.5 30일 유효 — canary 토큰 (C12)

토큰은 만료되지 않지만 **과거 키가 환경변수에 남아 있는 동안만** 해독됩니다
(`lib/unsubscribeToken.ts`). 토큰은 random IV로 만들어지고 실제 발송 토큰을
보관하지 않으므로, **"가장 오래된 실제 토큰"은 시험 대상이 될 수 없습니다.**

- **key version마다 inert canary 토큰**을 발급해 보관합니다. 해지할 대상이 없는
  토큰이라 눌러도 아무것도 끄지 않습니다.
- **delivery에 key version을 기록**합니다.
- readiness 계약: **그 key version으로 마지막 발송한 뒤 30일이 지나기 전에는 그
  키를 제거할 수 없습니다.** synthetic check가 canary로 해독을 확인합니다.

### 7.6 발송 판정의 전체 계약 (C9)

```
releaseNotesAuthorizationVerdict({
  address, purpose,
  recipientCountry,       // 5.3에서 확정된 국가. 미확정이면 거부
  rule,                   // 그 국가의 ReleaseNotesCountryRule(버전 포함)
  auSenderAuthority,      // 호주 발신자 authority 입력(동의·관계 사건)
  consentRecords,         // ConsentRecord 중 이 주소·purpose
  permissionEvents,       // EmailPermissionEvent 중 이 주소
  riskAcceptance,         // 5.6의 결정(있으면)
  suppression,            // 주소 전역 + purpose
  flags,                  // marketing, releaseNotes, collection
  phase,                  // "enqueue" | "send"
}) -> {
  allowed,
  authorities: [{ authority, basis, evidenceIds, verdict, reason }],
  ruleVersion, policyVersionId, evaluatedAt,
}
```

- **렌더링 정책과 권한 판정을 나눕니다.** 렌더링은 enqueue 시점에 고정된 정책,
  권한은 **provider 제출 직전의 현재 값**으로 다시 판정합니다.
- **snapshot을 둘 남깁니다** — `phase: enqueue`와 `phase: send`. 두 번째가
  거부하면 `permission_revoked`(정책 쪽 변화) 또는 `consent_withdrawn`(사용자
  쪽 변화)으로 skip합니다.
- **판정에 필요한 DB 조회가 실패하면 skip도 failed도 아닙니다.** claim을 풀고
  **기존 backoff로 `nextAttemptAt`을 설정**하며 incident를 올립니다. 즉시 재claim은
  hot loop입니다. **현재 drain은 예상 밖 오류를 영구 `failed`로 만들므로**
  (`lib/standardEmailLane.ts`) 이 분기를 따로 둡니다.

### 7.7 한국 법정 의무 — 전부 구현합니다

**소유자 결정(2026-09-16)**: 한국에 이메일을 보내며, 적용되는 의무를 전부
구현합니다. v7의 "보류"를 거둡니다.

| 의무 | 근거 | 구현 |
|---|---|---|
| 제목 `(광고)`, 변칙 표기 금지 | 제50조제4항, 시행령 별표 6 | 이미 있음(`JurisdictionProfile.subjectPrefix`) |
| 본문 명시사항 — 명칭·**전자우편주소·전화번호**·주소 | 별표 6 | **`contact_phone` footer block 추가**, 없으면 fail-closed |
| **한·영** 수신거부 안내와 간편한 기술적 조치 | 별표 6 | footer 문구를 한국어·영어 병기 |
| **14일 이내 처리결과 통지** — 수신동의·**수신거부**·철회 모두 | 제50조제7항, 시행령 제62조의2 | transactional 통지 메일. 내용: 전송자 명칭, 의사 표시 사실과 날짜, 처리 결과 |
| **2년마다 수신동의 사실 고지** | 제50조제8항, 시행령 제62조의3 | 배치. 동의일부터 매 2년이 되는 해의 같은 날 **전까지**, Asia/Seoul 달력 기준. 내용: 전송자 명칭, 동의 사실과 날짜, 유지·철회 방법 |
| 수신거부에 로그인 요구 금지 | 안내서 | 이미 있음 |

**14일 통지는 수신거부에도 붙습니다** — unsubscribe를 누른 한국 사용자에게도 처리
결과를 알립니다. `risk_accepted`로 받은 사람이 수신거부해도 마찬가지입니다.

**2년 고지의 증거 기준**은 "배치를 배포했다"가 아니라 "기한 전에 실제로
나갔다"입니다. `ConsentRecord(confirmation_notice_sent)`는 **provider 접수 이후에만**
멱등 생성하고 `EmailDelivery` id와 연결합니다. 윤일(2월 29일) 동의자는 **보수적으로
2월 28일**을 기한으로 씁니다.

**하나라도 빠지면 한국 rule은 disabled**입니다.

## 8. D6 — 문안 규칙

`release_notes` 템플릿은 **구조화된 payload**를 받습니다.

```
{ headline, items: [{ title, body, link? }], footerNote? }
```

- `link`는 **제품 경로 id**입니다. 고정 표에서 고르며 가격·결제·업그레이드
  경로는 표에 없습니다.
- **발송 시점에 redirect를 따라가지 않습니다.** 외부 목적지는 이 범위에서
  허용하지 않습니다.
- 금칙어 검사는 보조 guard입니다.

ACMA(Lululemon, 2026-03): "marketing messages must have an unsubscribe option and
**the simplest way to comply is to keep transactional or service messages
separate from sales content and links.**"

---

## 9. 제품 내 안내 — 선택지이며 이메일의 대체물이 아닙니다

**D 결정(11.1)에 따라 한국 사용자도 동의를 받아 이메일로 보냅니다.** 이 절은
동의하지 않은 사용자에게 같은 내용을 제품 안에서 보여 주는 **선택지**이며,
이번 범위의 필수 단계가 아닙니다.

KISA 안내서는 접속해서 보게 된 광고 정보를 "전송"과 구분합니다. 다만 **"제품
안"의 경계를 명시합니다.**

**포함** — 사용자가 직접 연 **인증된 웹·앱 화면 안에서 요청 시 렌더링되는
콘텐츠**만.

**제외** — 이메일, SMS, 앱·브라우저 push, OS 알림, service worker, 백그라운드
badge·toast.

**그리고** — 제품 내 표시를 이유로 한국 사용자의 이메일 suppression이나
preference를 바꾸지 않습니다. 보안·청구·서비스 이메일은 자체 분류로 계속
가능하되 **그 안에 `release_notes` 내용을 섞지 않습니다.** 한국에서 이메일은
주소별 express consent가 있을 때만입니다.

---

## 10. 문서 검토 — 근거는 문서 위에 섭니다

**지금 우리 방침이 새 설계와 정면으로 어긋납니다.**

> 현재 `/privacy`: "…**신청하신 경우에만** 제품 소식·뉴스레터·프로모션을
> 보냅니다. … 뒤의 셋은 **켜신 뒤에만** 발송되고…"

법이 opt-out을 허용해도 우리가 안 한다고 적어 두었으면 그 약속이 기준입니다.

| 대상 | 무엇을 |
|---|---|
| `/privacy` | 국가 rule별 근거, 거부 방법(로그인 불필요), 보존 기간 |
| `/terms` | 이메일 조항 유무 확인, 동의의 유효 기간(R5) |
| 가입 화면 2개 장치 문안 | 근거별로 다른 문안. 7개 언어 |
| 로그인 화면 동의 문장 | 이메일을 묶을지 별도로 둘지 |

**절차** — 방침·약관 변경은 [이메일 알림](email-notifications.md) §3.1 표의
5번 유형(service/legal)이라 **수신 거부자에게도 보내야 하는 통지**입니다. 전체
사용자에게 변경 고지가 나가고 시행일을 정해야 합니다.

**법적 문안은 제가 초안을 만들고 승인을 받습니다. 그리고 S3보다 먼저입니다** —
승인되지 않은 문안을 구현하고 해시할 수는 없습니다.

---

## 11. 승인 현황 (2026-09-16)

| # | 무엇 | 상태 |
|---|---|---|
| A | **C1·C8 개정** — 국가 rule로 대체 | **승인** |
| B | **가입 흐름에 두 장치** | **승인** |
| C | **호주에서 추론 동의** | **승인.** 4.4의 관계 모델과 E 시행 뒤 발효 |
| D | **한국** | **승인 — 동의 체크박스 + 법정 의무 전부 구현**(7.7) |
| E | **방침·약관 개정과 전체 변경 고지** | **승인** |
| F | **기존 78계정** | **승인 — 전원 발송, `risk_accepted`로 기록**(5.6) |
| G | **R1 외부 자문** | **미결. EEA·영국 soft opt-in만 막습니다.** S1은 착수 가능 |

### 11.1 D — 한국은 동의를 받아서 이메일로 보냅니다

제품 내 안내를 이메일의 대체물로 쓰지 않습니다. 한국 사용자는 5.3의 화면에서
**"이메일 광고성 정보 수신동의 (선택)"** 으로 동의하고 DOI를 지나 이메일을
받습니다. 그 메일에는 **7.7의 의무가 전부** 붙습니다. 9절의 제품 내 안내는
동의하지 않은 사용자를 위한 선택지로 남습니다.

### 11.2 F — 기존 78계정

5.5가 적었듯 **기존 계정에는 어느 법역에서도 근거가 없습니다.** 소유자는 이를
알고 **전원 발송**을 결정했고, 그 결정은 `risk_accepted`로 기록됩니다(5.6).

- 5.4의 **제품 내 동의 안내는 그대로 띄웁니다.** 동의한 분은 `express_consent`로
  옮겨가고 `risk_accepted`가 덮입니다.
- **동의 기록을 지어내지 않습니다.**
- **표시 의무는 면제되지 않습니다** — 한국 수신자에게는 7.7 전부.
- 수신거부는 즉시·영구이며 7절의 불변식 전부를 지납니다.

### 11.3 G — 외부 자문 의뢰 범위

EEA·영국을 여는 선행 게이트입니다.

**물어야 할 것**

1. Tomverse의 무료 이용과 유료 구독 사이에 CJEU C-654/23이 말한 **간접 보상
   관계**가 성립하는가. 성립한다면 그 근거는 무엇인가.
2. `release_notes`가 제13조(2)의 **"자사의 유사한 상품·서비스"** 에 해당하는가.
3. 5절의 **두 장치**가 "수집 시점의 거부 기회" 요건을 충족하는가. 문안 초안을
   함께 검토받습니다.
4. **회원국별 국내법 구현** — 최소 프랑스(CPCE L.34-5), 독일(UWG 제7조제3항의
   네 요건), 그리고 발송 예정국. 오스트리아(ECG-Liste)와 아일랜드(12개월·형사범)를
   이번 범위에서 제외해도 되는지 확인합니다.
5. **영국** — ICO가 freemium에 입장이 없는 상태에서 PECR reg 22(3)의
   "negotiations for the sale"에 우리 무료 계정이 들어가는가.
6. **기존 사용자** — 소급 불가라는 이 문서의 판단이 맞는가.

**건네야 할 자료** — 가입·과금 흐름, 무료/유료 기능 경계와 한도, 가격 구조,
`release_notes` 문안 예시, 두 장치의 문안 초안, 현재 방침·약관, 이 문서.

**받아야 할 형태** — 국가별로 "열림 / 조건부 / 닫힘"과 그 조건. 조건은
`ReleaseNotesCountryRule.conditions`에 그대로 들어갑니다.

---

## 12. 구현 순서

| # | 단계 | 선행 결정 | 비고 |
|---|---|---|---|
| S0 | 상위 계약 개정 — 분류표, 국가 확인 시점, 기록 세 층, 4.3의 표, 7.7 | — | 문서 |
| S1 | **기계** — 7.2 TemplateVersion 메타데이터, 7.4 두 잠금, 7.3 rate limit, 7.5 canary, 7.6 판정 계약과 DB 오류 재시도, 불변식 5·7·9·10·11. 전용 flag를 `createStandardDeliveryRows`·`expandEmailEvent`·drain에서 검사 | **닫힘**(7.2 결정) | **착수 가능.** **Codex 검토** |
| S2 | **법적 문안 초안과 승인** — `/privacy`·`/terms`·가입 두 장치·한국 동의 화면·7.7의 통지 문안, 7개 언어 | R5 동의 유효 기간 | 해시할 문안이 먼저 |
| S3 | `EmailPermissionEvent`·`Decision` + purpose classification 표 + DB CHECK | — | **Codex 검토** |
| S4 | `SignupConsentAttempt` + 두 가입 경로 finalize + **로그인 직후 국가 확정 화면**(5.3). 별도 `collectionEnabled` 게이트 | 5.3의 흐름 | **Codex 검토** |
| S5 | `ReleaseNotesCountryRule` + 이중 authority + 호주 관계 lifecycle | **R4** 유지·휴면 기준, OAuth 주소가 "직접 제공"을 충족하는 방법 | |
| S6 | 한국 법정 의무(7.7) — `contact_phone`, 한·영 안내, 14일 통지, 2년 배치 | — | 빠지면 KR disabled |
| S7 | 템플릿 + 구조화 payload + 링크 표 | — | |
| S8 | 기존 사용자 제품 내 동의 안내(5.4) + 제품 내 안내 화면(9절) + `risk_accepted` 기록·admin 표시 | — | |
| S9 | audience·estimate·drain 판정 공유 + 행 없는 미리보기 | — | **Codex 검토** |
| S10 | 방침·약관 게시, 전체 변경 고지, 시행일, 새 정책 버전 | — | 마지막 |

**활성화 전에 닫아야 하는 것** — R3(싱가포르 수신거부 이메일 주소), R2(발송 도메인
평판). **EEA·영국 soft opt-in 전에** — G.

**활성화 순서** — 문서 시행 → 정책 버전 활성화 → readiness 확인 → send flag.

## 13. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | freemium이 ePrivacy 13(2)의 "판매 맥락"인가 — **회원국별** 외부 자문 | EEA·영국 해제 |
| R2 | marketing 스트림 발송의 평판 영향 | 발송 도메인 |
| R3 | 싱가포르 "수신거부 요청을 보낼 이메일 주소"를 현재 footer가 충족하는가 | **SG 활성화 전 필수** |
| R4 | 호주 관계의 유지·휴면 기준값 | 4.4에서 정하고 문서에 적음 |
| R5 | 동의의 유효 기간 — ACMA는 숫자를 주지 않고 **약관에 적으면 그 기간이 기준** | 문서 문구 |

**보류 없음** — v7에서 보류했던 한국 14일 처리결과 통지와 2년 고지는 D 결정에
따라 구현합니다(7.7).

**참고**: 불변식 5(전체 수신거부)는 법정 최소요건이 아니라 **보수적인 제품
정책**입니다. TAB 사건의 핵심은 거부한 채널로 계속 보낸 것입니다.

---

## 14. 출처

- ePrivacy 지침 2002/58/EC 제13조 — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- CJEU C-654/23 Inteligo Media (2025-11-13) — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62023CJ0654)
- CNIL, 전자적 수단의 고객·잠재고객 커뮤니케이션 (2026-06-10) — [cnil.fr](https://www.cnil.fr/fr/communication-electronique-quelles-regles)
- ICO, direct marketing 식별 — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/identify-direct-marketing/)
- 스위스 FDPIC, 광고·마케팅 — [edoeb.admin.ch](https://www.edoeb.admin.ch/de/werbung-marketing)
- 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」 KISA-GD-2025-0037 (2025.12) — [kisa.or.kr](https://www.kisa.or.kr/401/form?postSeq=3608&lang_type=KO)
- 호주 Spam Act 2003 — [legislation.gov.au](https://www.legislation.gov.au/C2004A01214/latest/text)
- ACMA 침해통지 등록부 — [acma.gov.au](https://www.acma.gov.au/infringement-notices)
- ACMA, 동의에 관한 Statement of Expectations (2024) — [acma.gov.au](https://www.acma.gov.au/publications/2024-07/guide/consumer-consent-expectations-businesses-conducting-telemarketing-and-e-marketing)
- ACMA, Lululemon 처분 (2026-03) — [acma.gov.au](https://www.acma.gov.au/articles/2026-03/lululemon-penalised-702k-spam-breaches)
- OAIC, APP Guidelines Chapter 7 — [oaic.gov.au](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-7-app-7-direct-marketing)
- 싱가포르 Spam Control Act 2007 — [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/SCA2007)
- CAN-SPAM 15 U.S.C. 7702조 — [Cornell LII](https://www.law.cornell.edu/uscode/text/15/7702)
- FTC, CAN-SPAM 최종규칙 제정이유 70 Fed. Reg. 3110 (2005-01-19) — [federalregister.gov](https://www.federalregister.gov/documents/2005/01/19/05-974/definitions-and-implementation-under-the-can-spam-act)
- 중국 「互联网电子邮件服务管理办法」 — [moj.gov.cn](https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/200606/t20060606_144140.html)
