# 제품 소식 이메일: 수집 경로 만들기 (초안 v3)

> **이 문서의 지위: 초안입니다. 승인되지 않았고, 코드는 하나도 없습니다.**
> 여기 적힌 D1~D5는 제안이며, §8의 승인 항목이 처리되기 전에는 어떤 것도
> 구현하지 않습니다. 이 문서가 이름 대는 새 module은 아직 존재하지 않으며,
> `scripts/check-doc-references-core.mjs`의 `PLANNED_REFERENCES`에 그렇게
> 등록돼 있습니다.

- 상위 계약: [이메일 알림](email-notifications.md)
- 관련 결정: [Q2 도달 범위 결정 기록](../ops/q2-marketing-reach-decision.md),
  [double opt-in 설계](email-double-opt-in.md),
  [EEA·스위스 검토](email-eea-marketing-review-2026-09-14.md)

## 0. 개정 이력

### v3 (2026-09-16) — 독립 검토 2회차 반영: 범위를 줄였습니다

v2는 1회차의 blocker 셋(분류 오류, 한국 라벨 우회, 저신뢰 IP 확장)을 고쳤고
검토도 그것을 인정했습니다. 그런데 2회차가 더 아픈 지적을 했습니다.

> **모든 프로파일이 `express_consent`라면, 네 가지 근거와 국가별 필드와 새
> 장부는 발송 결과를 하나도 바꾸지 않습니다.** 당장 생기는 효과는 "가입 시
> 명시적 동의를 수집할 수 있게 됨" 하나뿐이고, 나머지는 승인되지 않은 미래
> 완화를 위한 선투자입니다.

맞는 지적입니다. v3은 **지금 효과가 있는 것만** 남깁니다.

| v2에 있던 것 | v3 |
|---|---|
| `permissionBasis` 4값 추상화 | **뺍니다.** 근거는 명시적 동의 하나 |
| `releaseNotesBasis` 프로파일 컬럼 | **뺍니다.** 완화를 승인할 때 만듭니다 |
| `EmailPermissionEvidence` 장부 | **뺍니다.** soft opt-in 적격성 증거는 완화할 때 필요합니다 |
| `account_feature_change` service 템플릿 | **뺍니다.** 별도 후속 과제(§9 F1) |
| 호주 발신자 overlay | **뺍니다.** release_notes만의 문제가 아니라 이메일 시스템 전체의 과제(§9 F2) |
| release_notes 전용 국가 allowlist | **뺍니다.** 기존 10개국 allowlist를 그대로 씁니다 |
| 가입 시 고지·거부 기록 | **명시적 동의 요청으로 바뀝니다.** 거부 기록은 완화용이라 지금은 불필요 |

남은 것은 다섯입니다 — 전용 flag, purpose 하나, 가입 시 동의 수집, 템플릿과
문안 규칙, audience와 dry-run.

### v2 (2026-09-16) — 독립 검토 1회차 반영

세 축 분리, marketing 분류 유지, 전 관할권 `express_consent`, IP 비확장.
v3이 그 결론을 이어받되 구현 범위를 줄였습니다.

### v1 (2026-09-16)

최초 초안. 독립 검토에서 reject. 기록으로만 남깁니다.

---

## 1. 무엇이 문제이고, 무엇이 아닌가

기능 안내 메일이 한 통도 나가지 못하는 이유는 분류가 아니라 **동의를 물어볼
자리가 제품에 없다는 것**입니다. 설정 화면이 유일한 경로이고, 거기까지 스스로
찾아온 사람은 0명입니다(2026-09-15 `GET /api/admin/marketing-reach`).

**분류를 바꾸는 것은 답이 아닙니다.** 조사 결과 기능 안내는 대부분의 법역에서
direct marketing이고, 이름을 바꾸면 라벨과 안전장치만 잃습니다(§2).

**따라서 v3이 하는 일은 하나입니다 — 가입하는 사람에게 물어보고, 답을
증거와 함께 남기고, 동의한 사람에게 보낼 수 있게 하는 것.**

## 2. 왜 분류를 낮추지 않는가

이 저장소에서 `classification === "marketing"` 하나가 다음을 켭니다.

- `lib/emailSendingIdentityCore.ts:40` — marketing 발송 스트림
- `lib/emailFeatureFlags.ts:113` — marketing kill switch
- `lib/emailJurisdictionComposition.ts:94` — `(광고)`·`<ADV>` 접두어
- `lib/emailTemplateDefinitions.ts:414` — unsubscribe 강제
- 관할권 footer 불완전 시 fail-closed

`service`로 낮추면 **한국 사용자가 동의를 마치고 받은 메일에 `(광고)`가 붙지
않습니다.** 라벨은 동의 여부가 아니라 메시지의 성격에서 나오는 의무입니다.

법적 근거도 낮출 수 없습니다. 한국 KISA 안내서는 거래관계 예외가 **"금전적인
대가를 지불한 거래관계"** 를 요구하고 **"회원가입"을 이름 대어 배제**합니다.
ePrivacy 제13조(2)의 soft opt-in은 "원래 광고인 메일"을 조건부로 허용하는
예외이지 분류를 바꾸는 규정이 아니며, CJEU C-654/23은 그 문을 좁게 열었습니다
— 무료 tier의 비용이 유료 구독가에 내재된 **구체적 상품 구조**가 근거였고,
스위스 FDPIC는 계정 개설만으로는 부족하다고 명시합니다.

그리고 **기존 계정은 소급으로 적격이 되지 않습니다.** soft opt-in 계열 예외는
전부 "수집 시점의 거부 기회"를 요건으로 하고, 그 시점은 이미 지나갔습니다.

---

## 3. D1 — `release_notes` purpose 하나

| | 값 |
|---|---|
| purpose | `release_notes` |
| classification | **`marketing`** |
| 기본값 | **꺼짐**. 동의로만 켜짐 |
| 동의 방식 | 기존 double opt-in 그대로 |
| unsubscribe | 필수 |
| 스트림 | marketing |

`product_updates`와 나누는 이유는 **수신자가 따로 끄고 켤 수 있게** 하기
위해서입니다. "새 기능은 받고 프로모션은 안 받겠다"가 성립합니다.

경계:

- `release_notes` — 무엇이 생겼고 무엇이 바뀌었는지, 그 기능으로 가는 링크
- `product_updates` — 특정 기능을 써 보라는 캠페인, 재참여
- `promotions` / `newsletter` — 가격·할인, 정기 소식지

### 함께 고치는 결함

`withdrawAllMarketing()`이 `recordsConsent(purpose)`로 대상을 고릅니다
(`lib/emailPreferences.ts:460`). purpose와 classification의 관계가 데이터에
없어서, 앞으로 동의 기반이 아닌 marketing purpose가 생기면 "모든 마케팅
중단"이 그것을 빠뜨립니다. **purpose 표에 classification을 두고 템플릿 정의와
일치하는지 정적 검사**합니다.

---

## 4. D2 — 전용 kill switch를 가장 먼저 만듭니다

`feature.emailReleaseNotesEnabled` (기본 `false`)를 **1단계에서** 만듭니다.

- **enqueue와 drain 양쪽**에서 검사합니다. 하나만 막으면 이미 큐에 있는 것이
  나갑니다.
- 기존 `feature.emailMarketingEnabled`와 **AND**입니다. 마케팅 전체가 꺼져
  있으면 이것이 켜져도 나가지 않습니다.
- 순서가 중요합니다 — **템플릿보다 flag가 먼저 존재해야** 합니다. 반대로 하면
  전용 게이트 없이 enqueue될 수 있는 템플릿이 잠시 존재합니다.

---

## 5. D3 — 가입할 때 물어봅니다

### 무엇을 묻는가

가입 화면에 **체크되지 않은 동의 요청 하나**를 둡니다.

- 한국어 화면은 **"광고성 정보 수신동의"** 라고 적습니다. "마케팅 동의"라는
  라벨은 KISA 안내서가 무효로 지목한 표현입니다.
- 약관 동의와 **묶지 않습니다.** 별도 항목이고 선택입니다.
- 체크하면 계정 생성 후 기존 DOI 흐름이 시작됩니다 — 확인 메일이 가고, 링크를
  눌러야 켜집니다.
- 체크하지 않으면 아무 일도 없습니다. **거부를 기록하지 않습니다** — 거부
  기록은 soft opt-in 적격성을 위한 것이고, 그 경로는 이 설계에 없습니다.

### 경로가 하나가 아닙니다

- OAuth: NextAuth adapter가 callback 중 생성 (`lib/auth.ts:237`)
- 이메일 코드: `resolveUserForVerifiedEmail()` (`lib/emailLogin.ts:321`)

화면의 체크 값이 이 경로들을 건너 계정 생성까지 도달해야 합니다.

- **서명된 1회용 pending intent**를 발급합니다 — 이메일 주소에 묶이고, 짧은
  만료가 있고, 한 번만 쓰이며, 재사용은 거부됩니다.
- **계정이 확정되는 지점에서 소비**합니다. OAuth는 adapter의 `createUser`,
  이메일 코드는 같은 account-finalization 서비스를 부르게 합니다.
- 소비에 실패해도 **계정 생성은 성공합니다.** 동의를 못 받은 것이지 가입을
  막을 일이 아닙니다. 실패는 구조화 이벤트로 남깁니다.
- 취소·재시도·다른 탭·다른 이메일·callback 실패에서 무엇이 남는지는 각 경로의
  e2e가 고정합니다.

### 국가는 어떻게 되는가

DOI 흐름이 이미 국가를 묻습니다(현재 구현). 그 화면의 **기본값을 IP·언어·
시간대로 채우되**, 사용자가 확인해야 `self_declared`가 됩니다.

**추정은 발송 권한을 넓히지 않습니다.** 확인되지 않은 국가는 보류이고, 신호가
충돌하면 보류입니다. 이는 2회차 검토가 종결로 판정한 결론을 그대로 유지하는
것입니다 — 프로파일 사이에 전순서가 없어서 "더 엄격한 쪽"은 `(광고)`와
`<ADV>` 중 무엇을 붙일지조차 정하지 못합니다.

---

## 6. D4 — 템플릿과 문안 규칙

`release_notes` 템플릿은 **구조화된 payload**를 받습니다. 자유 HTML이
아닙니다.

```
{ headline, items: [{ title, body, link? }], footerNote? }
```

- `link`는 **destination allowlist**를 지납니다 — 제품 경로만 허용하고,
  가격·결제·업그레이드 경로는 거부합니다. redirect가 있으면 **최종 목적지**를
  검사합니다.
- CTA는 타입이 있는 필드이고 자유 문구가 아닙니다.
- 금칙어 검사(가격·할인·한정 기간 표현)는 **보조 guard**로만 둡니다. 2회차
  검토가 지적한 대로 문자열 검사는 법적 분류기가 아니며, 링크 대상과 전체
  인상을 잡지 못하고 정상 문구를 오탐할 수 있습니다.
- 발송 전 **미리보기 승인**이 사람의 단계로 남습니다.

7개 언어 문안은 `tests/releaseNotesContentRules.test.mjs`가 함께 검사합니다.

---

## 7. D5 — audience와 dry-run

현재 cohort는 `marketing_consent` + `purpose: "product_updates"`로 고정돼
있습니다(`lib/emailAudienceExpansionCore.ts:116`). 그대로 두면 release_notes
캠페인의 수신자 집합이 존재하지 않습니다.

- cohort spec에 purpose를 받게 하고, **발송 시점 판정과 같은 순수 함수**를
  audience·dry-run·enqueue가 공유합니다. 세 곳이 다른 답을 내면 승인 화면의
  숫자가 거짓이 됩니다.
- dry-run은 **제외 사유별 인원 수**를 보여 줍니다 — 동의 없음, 미확인, 국가
  미지원, suppression, 관할권 미확정.
- 캠페인 수신자 행에 **판정에 쓰인 정책 버전**을 기록합니다.

### 큐에 고정된 정책과 현재 권한

`EmailDelivery`는 enqueue 시점의 정책을 고정합니다. 렌더링 재현에는 맞지만
권한 판정에는 맞지 않습니다.

- **렌더링·감사**: 고정된 정책 버전
- **권한**: provider 호출 직전에 **현재 활성 정책**으로 재판정
- 현재 정책이나 프로파일을 읽지 못하면 **fail closed**
- skip 사유를 구분합니다 — `consent_withdrawn`(사용자가 껐다)과
  `permission_revoked`(정책이 강화됐다)는 다른 사건입니다

---

## 8. 승인이 필요한 항목

| # | 무엇 | 왜 사람이 정해야 하나 |
|---|---|---|
| A | **가입 화면에 동의 요청을 넣는 것** | 가입 전환율에 영향을 줍니다 |
| B | **도달이 당장 늘지 않는다는 것** | 이 설계가 만드는 것은 동의를 모으는 자리입니다. 오늘 보낼 수 있는 사람은 0명에서 시작합니다 |
| C | **`release_notes`를 marketing 스트림으로 보내는 것** | 발송 도메인 평판에 영향을 줍니다(R2) |

**C8(soft opt-in 미사용) 개정은 v3에서 필요하지 않습니다.** 근거가 명시적
동의 하나이므로 기존 결정과 충돌하지 않습니다.

---

## 9. 이 설계 밖으로 옮긴 것

| # | 무엇 | 왜 별도인가 |
|---|---|---|
| F1 | `account_feature_change` (계약상 필요한 통지) | 2회차 검토: "이미 쓰는 기능의 변경"은 service 분류 근거로 너무 넓습니다. 한국 예외는 계약·안전·보안 통지에 초점이 있고, 범위를 **법률 검토로 좁힌 allowlist**로 정의해야 합니다. 별도 purpose·기본값·철회 동작·DB CHECK가 함께 필요합니다 |
| F2 | 호주 발신자 overlay | Spam Act는 발신 조직의 중앙관리가 호주에 있으면 **수신자 국가와 무관하게** 적용됩니다. 이는 release_notes만의 문제가 아니라 우리가 보내는 모든 상업 메일의 문제이고, 이메일 시스템 전체의 개선으로 다뤄야 합니다 |
| F3 | 관할권별 근거 완화 (soft opt-in, 추론 동의) | R1 외부 자문이 선행합니다. 그때 `releaseNotesBasis`·취득 증거 장부·국가별 allowlist를 만듭니다 |
| F4 | 한국 2년 재확인 고지 배치 | 한국 동의자가 생기는 순간부터 타이머가 돕니다. 별개 항목 |

---

## 10. 변경 범위

### 데이터

| 대상 | 변경 |
|---|---|
| `EmailPreference.purpose` CHECK | `release_notes` 추가 |
| `EmailTemplate.purpose` CHECK | 동일 |
| `EmailDelivery.skipReason` CHECK | `permission_revoked` 추가 |
| purpose 표 | `classification` 컬럼(코드 상수 + 정적 검사) |

### 코드

새로: `lib/emailReleaseNotes.ts`(판정),
`lib/releaseNotesContentRules.ts`(payload·링크 규칙),
`lib/emailSignupConsentIntent.ts`(서명된 1회용 intent).

고침: `lib/emailPreferenceCore.ts`(purpose 표에 classification),
`lib/emailPreferences.ts`(`withdrawAllMarketing` 범위),
`lib/emailTemplateDefinitions.ts`, `lib/emailFeatureFlags.ts`,
`lib/standardEmailLane.ts`(전용 flag·현재 정책 재판정),
`lib/emailAudienceExpansionCore.ts`·`lib/emailAudienceExpansion.ts`(purpose),
`lib/auth.ts`·`lib/emailLogin.ts`(intent 소비),
가입 화면, `components/email/EmailNotificationSettings.tsx`,
`locales/*.ts` 7개.

---

## 11. 구현 순서

| # | 단계 | 왜 이 순서인가 | 검증 |
|---|---|---|---|
| S1 | `feature.emailReleaseNotesEnabled` (기본 false) + enqueue·drain 양쪽 검사 | **게이트가 물건보다 먼저.** 반대로 하면 전용 게이트 없는 템플릿이 잠시 존재합니다 | unit + 통합 |
| S2 | purpose 표(+classification) · DB CHECK · `withdrawAllMarketing` 범위 | 가입 화면이 켤 대상이 존재해야 합니다 | unit + enum-constraints + DB 통합 |
| S3 | 서명된 intent + 모든 가입 경로에서 소비 + DOI 연결 | 여기서 처음으로 동의가 쌓입니다 | e2e(OAuth·이메일 코드) + DB 통합. **Codex 검토** |
| S4 | 템플릿 + 구조화 payload + 링크 allowlist + 7개 언어 | 보낼 물건은 마지막에서 두 번째 | unit + locale |
| S5 | audience·dry-run·admin 표시 + 현재 정책 재판정 | 발송 전에 누가 받는지 셀 수 있어야 합니다 | 통합 + dry-run 0건 검증. **Codex 검토** |
| S6 | 문서 개정, 새 정책 버전 초안 | | 정적 검사 |

**활성화 순서는 고정입니다** — 정책 버전 활성화 → `/api/ready` 확인 →
`feature.emailReleaseNotesEnabled` 켜기. 어느 단계도 그 자체로 발송을 열지
않습니다.

---

## 12. 미해결 질문

| # | 질문 | 막히는 것 |
|---|---|---|
| R1 | 우리 freemium 구조가 ePrivacy 제13조(2)의 "판매 맥락"에 해당하는가 — 외부 자문 | F3(관할권별 완화) |
| R2 | release_notes를 marketing 스트림으로 보내는 것의 평판 영향 | 발송 도메인 |
| R3 | 싱가포르 Second Schedule para 2(2)의 "수신거부 요청을 보낼 이메일 주소"를 현재 footer가 충족하는가 | SG 발송 |
| R4 | 한국 국내대리인(제32조의5) 지정 의무가 적용되는가 | 이 설계와 무관한 현재 상태 |

---

## 13. 출처

- ePrivacy 지침 2002/58/EC 제13조 — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058)
- CJEU C-654/23 Inteligo Media (2025-11-13) — [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62023CJ0654)
- ICO, PECR 전자우편 마케팅 규칙 — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/)
- ICO, direct marketing과 service message — [ico.org.uk](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-and-regulatory-communications/)
- CNIL, 전자적 수단의 고객·잠재고객 커뮤니케이션 (2026-06-10) — [cnil.fr](https://www.cnil.fr/fr/communication-electronique-quelles-regles)
- 스위스 FDPIC, 광고·마케팅 — [edoeb.admin.ch](https://www.edoeb.admin.ch/de/werbung-marketing)
- 독일 UWG 제7조 — [gesetze-im-internet.de](https://www.gesetze-im-internet.de/uwg_2004/__7.html)
- 방송미디어통신위원회·KISA 「불법스팸 방지를 위한 정보통신망법 안내서」 KISA-GD-2025-0037 (2025.12) — [kisa.or.kr](https://www.kisa.or.kr/401/form?postSeq=3608&lang_type=KO)
- KISA 불법스팸 대응센터, 광고성 정보 예외 — [spam.kisa.or.kr](https://spam.kisa.or.kr/spam/na/ntt/selectNttInfo.do?bbsId=1003&mi=1037&nttSn=1367)
- 호주 Spam Act 2003 — [legislation.gov.au](https://www.legislation.gov.au/C2004A01214/latest/text)
- ACMA, 스팸 발송 회피 안내 — [acma.gov.au](https://www.acma.gov.au/avoid-sending-spam)
- 싱가포르 Spam Control Act 2007 — [sso.agc.gov.sg](https://sso.agc.gov.sg/Act/SCA2007)
- CAN-SPAM 15 U.S.C. 7702조 — [Cornell LII](https://www.law.cornell.edu/uscode/text/15/7702)
