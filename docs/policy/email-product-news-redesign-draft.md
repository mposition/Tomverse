# 제품 소식 이메일: 권한과 기계 (초안 v10)

> **이 문서의 지위: 초안입니다. 승인되지 않았고, 코드는 하나도 없습니다.**
> 11절의 승인 항목이 처리되기 전에는 어떤 것도 구현하지 않습니다. 이 문서가
> 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

## 0. 개정 이력

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

### 2.5 호주 — 우리가 실제 집행 대상입니다

Spam Act는 법인 소재지로 회피되지 않고(s 7(c)(d)), 우리는 ACMA 관할 안입니다.
ACMA는 계정 관계를 추론 동의 근거로 인정하되 **관계가 끝나면 안 된다**고
명시했습니다. 입증책임은 발신자(s 16(5)).

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

### 4.2 판정은 authority별로 남깁니다

수신자 관할권 authority와 **호주 발신자 authority**를 각각 평가하고, 결과를
하나의 basis로 접지 않습니다.

```
releaseNotesAuthorizationVerdict({ ... })
  -> { allowed, authorities: [{ authority, basis, evidenceIds, verdict, reason }] }
```

미국 `opt_out` + 호주 consent가 동시에 성립하는 경우처럼, **하나의 근거가 양쪽을
충족하면 그 관계도 기록**합니다. 이 함수 하나를 **estimate·audience expansion·
writer·drain이 공유합니다** — 세 곳이 다른 답을 내면 승인 화면의 숫자가
거짓이 됩니다.

### 4.3 출발 값

| 국가 | 출발 basis | 해제 조건 |
|---|---|---|
| **US** | `opt_out` | — (CAN-SPAM. 수신거부·발신자 정보로 충분) |
| **SG** | `opt_out` | — (SCA는 primary purpose 기준, 대량 미요청에만 라벨 의무) |
| **AU** | `express_consent` → **관계 lifecycle(4.4)이 서면 `inferred_consent`** | 4.4의 여섯 항목 |
| **EEA 각국** | `express_consent` | **R1 외부 자문**이 회원국별로 ① 간접 보상 관계 ② `release_notes`가 유사 서비스인지 ③ 수집 시 고지·즉시 거부 ④ 국내법 구현을 확인 |
| **GB** | `express_consent` | ICO가 freemium에 입장이 없음. R1과 함께 |
| **KR** | `express_consent` | 가입 화면의 동의 체크박스와 DOI로 받습니다(11.1). 동의해도 `(광고)` 표기와 별표 6 명시사항은 그대로 |
| **CH·CA·AT·IE** | `express_consent` | CH는 FDPIC가 계정 개설만으로는 부족이라 명시. AT는 ECG-Liste, IE는 12개월 창 |
| **ZZ** | 발송 안 함 | — |

`risk_accepted`는 이 표의 값이 아닙니다 — 국가 rule은 그대로 두고, 그 위에서 내린 결정으로 5.6에 따라 기록됩니다.

**R1은 "추후 검토"가 아니라 해당 국가 활성화의 선행 게이트입니다.**

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

### 5.1 가입 화면에 두 가지를 둡니다

1. **opt-in 체크박스** (체크되지 않은 상태) — **동의**입니다. 체크하면 DOI로
   이어집니다. 미체크는 **발송 불가**이며 다른 의미로 재해석하지 않습니다.
   한국어 화면은 **"광고성 정보 수신동의"** 라고 적습니다.
2. **고지 문장과 독립 거부 수단** — opt-out·soft opt-in 관할권용입니다. 무엇을
   보내는지 적고, **체크박스와 별개인 거부 링크**를 둡니다. 이 장치의 표시와
   거부 여부가 `notice_shown`·`objected` 사건으로 남습니다.

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
| `wantsReleaseNotes` · `noticeShown` · `objected` | 두 장치의 결과 |
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

### 5.3 국가는 확인 화면에서 묻습니다

확인 메일은 국가 없이 나가고(아직 아무것도 켜지지 않았고 그 메일은
transactional), **링크를 누른 화면에서 한 번 묻습니다.** 추정값으로 기본을
채우되 사용자가 확인해야 `self_declared`입니다. 요청 기록은 미확정 관할권으로
남고, **국가를 고른 시점의 활성 rule**이 화면 문구와 `granted` 기록을 정합니다.
최종 POST는 `token + confirmedCountry`를 받아 `setPreference()` transaction
안에서 처리합니다.

한국이 확정되면 그 클릭 전에 **광고성 정보 수신동의·발신자·목적·철회 방법·
국가와 rule 버전**을 보여 주고 **렌더된 문구의 해시를 남깁니다.**

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

### 5.5 안내에 응답하지 않은 기존 사용자

| 대상 | 근거 |
|---|---|
| 신규(고지 시행 후 수집) | 그 국가 rule의 basis |
| 기존 · **US·SG** | **`opt_out`** — 이 법역은 동의를 요구하지 않습니다. 수신거부만 제대로 제공하면 됩니다 |
| 기존 · **AU** | **`inferred_consent`** — 4.4의 관계가 실제로 성립하는 주소만. 11.2의 방침 시행일 이후 |
| 기존 · **EEA·GB·CH·KR·CA·AT·IE** | 법이 사전 동의를 요구합니다. 보내려면 **`risk_accepted`**(5.6) |

### 5.6 `risk_accepted` — 근거가 아니라 기록된 결정

**이것은 법적 근거가 아닙니다.** 사전 동의가 필요한 법역에 동의 없이 보내기로
한 **사업 결정**이고, 그 사실을 있는 그대로 남기는 이름입니다.

쓰는 규칙입니다.

1. **동의를 지어내지 않습니다.** `ConsentRecord(granted)`를 쓰지 않습니다.
   실제로 없던 동의를 장부에 적으면, 대조되는 날 그것은 실수가 아니라 위조로
   보입니다. **낮은 위험을 가장 나쁜 종류의 위험으로 바꾸는 거래입니다.**
2. **승인자·날짜·범위를 함께 기록합니다.** 어느 국가에, 어느 기간에, 누구의
   승인으로 적용했는지가 `EmailPermissionDecision`에 남습니다.
3. **admin 화면에 그대로 보입니다.** 숨기지 않습니다 — 숨기면 다음 사람이
   그것을 동의로 읽습니다.
4. **동의가 들어오면 덮입니다.** 그 주소가 나중에 5.4의 안내나 설정에서
   동의하면 근거가 `express_consent`로 바뀌고, 이전 결정은 이력으로 남습니다.
5. **재검토 시점을 적습니다.** 유입이 늘거나 해당 법역의 수신자가 일정 수를
   넘으면 다시 판단합니다.

**현재 근거(2026-09-16)**: 계정 78개, 전원 지인 경로 유입, 순수 유입 0.
신고를 통해 규제기관에 도달할 경로가 사실상 없다는 판단입니다. **이는 "법이
허용한다"가 아니라 "적발 가능성이 낮다"이며**, 그 구분을 문서에 남깁니다.

---

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

그 밖에 필요한 것 — `purpose`와 권한 범위, `copyHash`가 가리키는 **실제 불변
문안 artifact**, 주소 정규화 규칙, 보존 기간, 그리고 반대 사건의 발생 시각.

**위탁해도 우리 기록입니다**(ACMA Statement of Expectations).

---

## 7. D5 — 기계: 벌금이 실제로 나오는 곳

### 7.1 불변식

| # | 불변식 | 현재 상태 |
|---|---|---|
| 1 | **marketing 분류에는 예외 없이 수신거부** | **부분** — 정의 검사는 있으나 **재분류 시 구멍**(7.2) |
| 2 | 로그인·개인정보 없는 one-click | **있음.** 단 rate limit 조정 필요(7.3) |
| 3 | **철회 후 발송 0건** | **없음** — 경합 구간 존재(7.4) |
| 4 | 수신거부 주소가 발송 후 30일 이상 유효 | **증명 불가** — 키 보존 일정과 synthetic check 필요(7.5) |
| 5 | 전체 수신거부 선택지 | **부분 구현** — UI와 `all=1` route는 있고 `withdrawAllMarketing()` 범위가 문제 |
| 6 | suppression이 **고객 대상 lane** 모든 발송보다 우선 | **있음**(범위를 고객 대상 standard·credential lane으로 명시) |
| 7 | 재구독 권유 금지 | **없음** — 템플릿·캠페인 검사와 audience 제외 규칙 필요 |
| 8 | 관계 종료 시 중단 | **없음** — 4.4의 사건 모델이 선행 |
| 9 | **법적 발신자 명칭·연락처·주소가 없으면 marketing은 fail-closed** | **확인 필요** — 집행 기록의 sender-detail 실패 6건 |
| 10 | **end-to-end synthetic 점검** — 링크 존재가 아니라 실제로 눌러 suppression까지 반영되는지 | **없음** |

### 7.2 템플릿 메타데이터 drift (C1)

`ensureTemplateVersion()`이 기존 `EmailTemplate`에 `update: {}`를 씁니다
(`lib/emailTemplateRegistry.ts`). 코드에서 분류를 바꿔도 DB의 `classification`과
`requiresUnsubscribe`는 옛 값으로 남고, 발송기는 **분류는 코드에서, 수신거부
여부는 DB 행에서** 읽습니다(`lib/standardEmailLane.ts`).

**즉 service로 등록된 템플릿이 marketing으로 재분류되면 수신거부가 빠진 채
나갑니다.** Luxottica·Lululemon이 맞은 바로 그 형태입니다.

- DB 메타데이터와 코드 정의가 다르면 **registry와 drain 모두 fail-closed**.
- classification을 바꾸려면 **새 template key**를 요구하거나
  classification·purpose·unsubscribe를 `TemplateVersion`에 버전별로 저장.
- **저장된 `requiresUnsubscribe=false`를 신뢰해 생략하지 않습니다.**

### 7.3 수신거부 rate limit

`/api/unsubscribe`의 IP 기준 20회/분·200회/일 제한은 기업 NAT나 메일 사업자의
one-click 요청을 429로 만들 수 있습니다. **유효 토큰은 본질적으로 해지밖에
못 하므로 유효 요청은 처리하고, 제한은 invalid token 남용에 겁니다.**

### 7.4 철회와 발송의 경합 (C2)

suppression은 `lib/standardEmailLane.ts`에서 확인한 뒤 여러 DB 조회·렌더링·
지연 처리를 거쳐 provider를 호출합니다. **그 사이에 커밋된 수신거부는 잡지
못합니다.**

- 철회와 최종 발송을 **(주소, purpose) 직렬화 키**로 동기화합니다.
- sender는 **잠금 안에서 최종 suppression을 재검사한 뒤 provider 제출까지**
  마칩니다.
- 수신거부가 먼저 이기면 sender가 그것을 관측하고 중단합니다.
- sender가 먼저 이기면 수신거부 응답은 제출이 끝난 뒤 완료됩니다.
- 보장 문구는 관측 가능한 사건으로 적습니다 — **"철회 커밋 이후 시작된 provider
  제출 0건"**, 그리고 두 시각을 `EmailPermissionDecision`에 남깁니다.

### 7.5 30일 유효

토큰 자체는 만료되지 않지만 **과거 키가 환경변수에 남아 있는 동안만** 해독
됩니다(`lib/unsubscribeToken.ts`). readiness는 키의 존재와 구문만 봅니다.
**키별 활성·폐기 예정일을 두고, 가장 오래된 실제 토큰으로 synthetic check**를
돌립니다.

---

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
| A | **C1·C8 개정** — 전역 opt-in과 soft opt-in 미사용을 국가 rule로 대체 | **승인** |
| B | **가입 화면에 두 장치** | **승인** |
| C | **호주에서 추론 동의에 기대는 것** | **승인.** 4.4의 관계 모델이 서기 전에는 발효되지 않습니다 |
| D | **한국** | **승인 — 방향 변경.** 제품 내 안내로 돌리는 대신, **한국 사용자에게 동의 체크박스를 제공**합니다(11.1) |
| E | **방침·약관 개정과 전체 변경 고지 발송** | **승인** |
| F | **기존 사용자의 취급** | **승인, 범위 한정**(11.2). 2026-09-16 보완 — 개별 연락 대신 **제품 내 일회성 안내**(5.4), 미응답자는 5.5·5.6 |
| G | **R1 외부 자문 의뢰** | **미결.** 의뢰 범위는 11.3 |

### 11.1 D — 한국은 동의를 받아서 이메일로 보냅니다

제품 내 안내를 이메일의 **대체물**로 쓰지 않습니다. 한국 사용자도 가입 화면의
opt-in 체크박스로 동의할 수 있고, 동의하면 DOI를 지나 이메일을 받습니다.

따라오는 것 셋입니다.

1. **한국어 문안은 "광고성 정보 수신동의"** 입니다. KISA가 "마케팅 동의"·
   "정보 제공 동의"·"혜택 알림" 같은 표현을 무효로 지목했습니다.
2. **그 메일에는 제목 `(광고)` 표기와 별표 6의 명시사항이 붙습니다.** 동의를
   받았다고 라벨이 면제되지 않습니다.
3. **9절의 제품 내 안내는 남되 선택지입니다** — 동의하지 않은 한국 사용자에게
   같은 내용을 제품 안에서 보여 주는 길이며, 이번 범위의 필수 단계가 아닙니다.

### 11.2 F의 범위 — "신청한 것으로 본다"가 뜻할 수 있는 것과 없는 것

승인 문구는 "기존 가입자는 신청한 경우로 보고 unsubscribe를 통한 opt-out을
제공한다"였습니다. **성립하는 법역과 성립하지 않는 법역이 갈립니다.**

| 대상 | F가 뜻하는 것 |
|---|---|
| **US·SG (`opt_out`)** | **그대로 성립합니다.** 이 법역은 애초에 동의를 요구하지 않으므로, 기존 사용자에게 보내고 수신거부를 제공하면 됩니다 |
| **AU (`inferred_consent`)** | **조건부.** 4.4의 관계가 실제로 성립하는 주소만. 아래 2번 주의 |
| **EEA·GB·CH·KR·CA·AT·IE (`express_consent`)** | **성립하지 않습니다.** 법이 사전 동의를 요구하므로 "신청한 것으로 본다"는 선언으로 만들 수 없습니다. 이들 법역의 기존 사용자는 **DOI를 지납니다** |

**세 가지를 분명히 합니다.**

1. **동의 기록을 지어내지 않습니다.** 기존 사용자에게 `ConsentRecord(granted)`를
   쓰지 않습니다. 근거는 `opt_out`이며 그렇게 기록됩니다. 지어낸 동의는 규제기관
   앞에서 설명할 수 없고 우리 장부의 의미를 망칩니다.
2. **호주에는 우리 방침이 만든 약점이 있습니다.** ACMA의 추론 동의 기준에는
   "수신자가 마케팅을 **합리적으로 예상**할 수 있었는가"가 들어 있는데, 우리
   방침이 지금 **"신청하신 경우에만 보냅니다"** 라고 적어 두었습니다. 즉 기존
   호주 사용자에 대해서는 **우리 문서가 그 기대를 부정하는 증거**가 됩니다.
   그래서 기존 호주 사용자는 **E의 방침 개정과 변경 고지가 시행된 뒤**부터
   대상으로 삼고, 그 시행일을 관계 증거에 기록합니다.
3. **수신거부는 즉시·영구입니다.** opt-out 근거로 보내는 모든 메일이 7절의
   불변식 전부를 지납니다.
4. **개별 연락은 하지 않습니다.** 78명에게 따로 연락하는 대신 **제품 내
   일회성 안내**(5.4)로 동의를 모으고, 응답하지 않은 분들은 5.5의 근거로
   나눕니다. 사전 동의가 필요한 법역에 보내기로 한 결정은 **동의가 아니라
   `risk_accepted`로 기록**합니다(5.6).

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

| # | 단계 | 왜 |
|---|---|---|
| S0 | 상위 계약 개정과 11절 승인 | 코드가 문서를 앞서지 않습니다 |
| S1 | **기계** — 7.2 drift fail-closed, 7.4 직렬화, 7.3 rate limit, 불변식 5·7·9·10. 전용 flag를 `createStandardDeliveryRows`·`expandEmailEvent`·drain에서 검사 | **벌금이 나오는 곳.** 게이트가 물건보다 먼저. **Codex 검토** |
| S2 | **법적 문안 초안과 승인** — `/privacy`·`/terms`·가입 2개 장치, 7개 언어 | 해시할 문안이 먼저 승인돼야 합니다 |
| S3 | **`EmailPermissionEvent`·`Decision`** + purpose classification 표 + DB CHECK + `withdrawAllMarketing` 범위 | 기록이 없으면 근거를 증명하지 못합니다. **Codex 검토** |
| S4 | **`SignupConsentAttempt`** + 두 가입 경로 finalize + 확인 화면 국가·한국 표시. **별도 `collectionEnabled` 게이트** | 수집 표면도 게이트 뒤. **Codex 검토** |
| S5 | `ReleaseNotesCountryRule` + 이중 authority 판정 + 호주 관계 lifecycle(4.4) | 근거 판정 |
| S6 | 템플릿 + 구조화 payload + 링크 표 | 보낼 물건 |
| S7 | audience·estimate·drain이 **같은 판정 함수** 공유 + 행 없는 미리보기 + admin 표시 | 숫자가 서로 달라지지 않게. **Codex 검토** |
| S8 | **기존 사용자용 제품 내 일회성 동의 안내**(5.4) + 한국 제품 내 안내 화면(9절) | 같은 부품, 다른 배치. 기존 78계정의 동의가 여기서 들어옵니다 |
| S9 | 방침·약관 게시, 전체 변경 고지, 시행일, 새 정책 버전 | 마지막 |

**활성화 순서** — 문서 시행 → 정책 버전 활성화 → readiness 확인 → send flag.

---

## 13. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | freemium이 ePrivacy 13(2)의 "판매 맥락"인가 — **회원국별** 외부 자문 | EEA·영국 해제 |
| R2 | marketing 스트림 발송의 평판 영향 | 발송 도메인 |
| R3 | 싱가포르 "수신거부 요청을 보낼 이메일 주소"를 현재 footer가 충족하는가 | **SG 활성화 전 필수** |
| R4 | 호주 관계의 유지·휴면 기준값 | 4.4에서 정하고 문서에 적음 |
| R5 | 동의의 유효 기간 — ACMA는 숫자를 주지 않고 **약관에 적으면 그 기간이 기준** | 문서 문구 |

**보류로 기록**(적용되지만 지금 구현하지 않음): 한국 14일 처리결과 통지, 한국
2년 재확인 고지. 재검토 방아쇠 — 한국 법인·자산 보유, 방미통위 자료제출 요구
수령, 정보통신서비스 부문 매출 100억원 접근, 한국 대상 상시 대량 발송,
2026-10-01 과징금 제도의 집행 사례 등장.

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
