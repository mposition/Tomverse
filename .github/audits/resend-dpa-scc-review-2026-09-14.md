# Resend DPA·SCC 및 국외이전 장치 검토 — 2026-09-14

이 문서는 Tomverse가 현재 이용하는 이메일 처리자 Resend의 공개 계약, 국제 이전
장치와 실제 저장소 데이터 흐름을 대조한 기록이다. 정식 로펌 의견서나 특정 감독기관의
사전 승인을 대신하지는 않지만, 현행 1차 자료와 실제 구현에서 확인할 수 있는 사실은
추측과 분리해 기록한다.

| | |
|---|---|
| 검토일 | 2026-09-14 |
| 저장소 기준 branch / HEAD | `codex/memory-eval-vnext-oi-f4-start-tip-revalidation` / `e1fde769` |
| 사업자 위치·형태 | 호주 소재 1인 사업자(사용자 제공 사실) |
| 현재 제품 범위 | Resend를 이용한 transactional·service·legal 이메일. marketing은 비활성 |
| Resend 계약 법인 | Plus Five Five, Inc., 미국 |
| 검토한 공개 DPA | 2026-08-27 업데이트본 |
| 계정 Documents에서 받은 PDF | `resend-dpa-signed.pdf`, 200,988 bytes, SHA-256 `F028A0D8C49850DCA8CA2959ECD6E853095C55017BF72395567B787DD44C42EF` |
| PDF provenance | `https://resend.com/static/documents/resend-dpa-signed.pdf`와 SHA-256·크기 모두 동일 |
| 이 기록의 상태 | **Resend 문의 보류 결정 반영. TIA 승인·개인정보 고지는 미완료** |

## 0. 결론부터

### 0.1 계약과 이전 장치

**Resend를 현재의 비민감 transactional 이메일에 계속 사용하는 것은 조건부로
가능하다.** 별도 DPA 서명 요청은 필요하지 않다. Resend는 모든 계정에 GDPR 제28조
DPA가 적용되고, 가입으로 사전 서명본이 체결된다고 명시한다. 공개 DPA는 Tomverse가
controller이고 Resend가 processor일 때의 **EU SCC Module 2**, 영국용 **UK
Addendum**, 스위스용 **EU SCC 수정조항**을 계약에 편입한다. 계정 Documents에서
받은 PDF는 공개 사전서명 PDF와 바이트 단위로 동일하다. 이 PDF만 보면
SCC Annex I.C의 관할 감독기관과 UK Addendum Part 1의 필수 표가 명시적으로 완성되어
있지 않다. 다만 이는 현재 활성 DPF가 적용되는 EU·영국 이전의 선행조건이 아니라,
DPF가 중단되거나 SCC 제출을 요구받을 때 보완할 fallback 증빙이다. 스위스
수정조항은 관할기관으로 FDPIC를 별도로 지정한다.

미국 상무부 DPF 명부에서는 Resend가 EU–U.S. DPF와 UK Extension의 **Active
Participant**로 표시된다. 다만 세부 상태는 둘 다 `Active - Re-certification under
Review`이다. EU·영국 Non-HR 데이터에는 현재 DPF를 적법한 이전 근거로 사용할 수
있다. 갱신·무효화 시에는 EU SCC/UK Addendum fallback의 부속정보를 확인한 뒤 해당
이전을 계속한다. 스위스는 명부상 Swiss–U.S. DPF가 없어 수정 SCC에 의존하며, 공개
DPA가 FDPIC를 지정한 사실과 Agreement 수락 증거를 함께 보관한다.

### 0.2 현재 남은 기록·고지

DPA 체결과 현재의 이전 근거 확인은 완료됐다. Q11 전체는 다음 기록·고지가 남아 있어
부분 해소로 유지한다.

1. 계정에서 받은 PDF도 표준 공개본이라 Customer 서명란·명칭과 계정별 효력일이
   채워져 있지 않다. Resend Terms상 가입·무료 플랜 신청·동의 checkbox가 계약 체결
   행위이므로, **실제 계정 명의자와 확인 가능한 최초 계정·결제일**을 내부 기록으로
   남긴다. 정확한 수락일을 찾지 못하는 것만으로 자동 체결된 DPA가 무효가 되지는
   않으며, 조건부 문의를 보내게 되면 함께 확인할 수 있다.
2. PDF에 EU SCC Annex I.C와 UK Addendum Part 1 완결 정보가 없다. 현재 EU·영국
   이전은 활성 DPF에 의존하므로 Resend 문의는 필수가 아니다. DPF 중단, 기업 고객의
   감사, 감독기관 요구 또는 고위험 처리 시작 시에만 서면 답변이나 보완문서를 받는다.
3. 현재 `/privacy`는 Resend, 미국 저장, 이메일 본문·로그 보관, 이전 장치를
   고지하지 않는다. DPA가 있어도 GDPR 제13·14조 투명성 의무는 별개다.

### 0.3 운영 판단

- **현재 이메일을 즉시 중단할 사유까지는 확인되지 않았다.** DPA는 자동 체결되고,
  EU·영국에는 현재 활성 DPF 근거도 있다. 현재 메시지는 인증·계정·결제·운영
  용도이며 평문 자격증명은 Tomverse 저장소에 남지 않는다. 다만 EU SCC/UK Addendum
  fallback은 아래 재검토 조건이 발생하기 전까지 보완 문의를 보류한다.
- **marketing 활성화는 이 검토로 허용되지 않는다.** 국가별 ePrivacy/UWG/CNIL
  검토, 발신자 정보, 동의와 footer 요건은 별도 선행 조건이다.
- 건강, 정치성향, 노동조합, 성생활, 생체·유전정보 등 GDPR 특별범주 데이터나
  장문의 고객 비밀을 이메일 본문에 넣지 않는다. Resend DPA Exhibit A는 민감정보를
  `Not applicable`로 전제한다.
- 로그인 코드와 로그인 링크는 Resend에 본문으로 전달되어 기본 보관 대상이 될 수
  있다. 현재 둘 다 최대 10분에 만료되므로 실사용 위험 창은 짧지만, $50/월 본문
  저장 비활성화 옵션의 도입 여부는 별도 비용·보안 결정으로 남긴다.
- `tomverse.app`과 `mail.tomverse.app` 모두 open/click tracking은 비활성으로
  확인됐다. 두 도메인의 SMTP 전달 TLS는 `Opportunistic`이다. 인증 이메일에는
  `Enforced TLS`가 더 적합하지만, TLS 미지원 수신 서버에는 발송 실패가 생길 수 있어
  가역적인 보안·도달률 결정으로 분리한다.

## 1. 확인한 계약 내용

### 1.1 DPA 체결 방식과 당사자

[Resend GDPR 안내](https://resend.com/security/gdpr)와
[Documents 안내](https://resend.com/docs/knowledge-base/downloading-documents)는 다음을
명시한다.

- 모든 Resend 계정에 GDPR 제28조 DPA가 적용된다.
- Resend가 미리 서명했으며 계정 가입 시 완전히 체결된다.
- 별도 counter-signature는 필요하지 않다.
- 계정별 체결본은 로그인 후 `Settings → Documents`에서 다운로드한다.

사용자가 계정 Documents에서 내려받아 제공한 PDF는 공개 PDF와 SHA-256이 동일하다.
19쪽, DocuSign DMv10 생성, 암호화 없음, JavaScript 없음이며 Resend CEO Zeno Rocha
Bueno Netto가 2026-01-14 서명한 모습과 DocuSign 서명 객체가 있다. 이 환경에 독립
CMS 서명 검증기가 없어 인증서 체인을 별도로 검증하지는 않았지만, 공식 HTTPS 원본과
바이너리가 동일함을 확인했다.

[공개 DPA](https://resend.com/legal/dpa)의 importer는 Plus Five Five, Inc.
(2261 Market Street #5039, San Francisco, CA 94114)이고, exporter는 Agreement에
기재된 Customer다. PDF의 Customer 서명·이름·직함·날짜 칸은 비어 있고, §12는 이
칸이 참고용이며 Agreement 수락으로 구속된다고 명시한다. [Resend Terms](https://resend.com/legal/terms-of-service)는
유료 구매, 무료 플랜 가입 또는 동의 checkbox로 Agreement가 성립한다고 한다. 따라서
Customer는 실제 계정 명의자이지만, 정확한 법적 명칭과 효력일의 증거는 이 PDF가 아닌
계정 가입/청구 기록 또는 Resend의 확인에서 확보해야 한다.

### 1.2 관할권별 이전 장치

| 데이터 주체/범위 | 주된 장치 | 추가 또는 fallback | 판정 |
|---|---|---|---|
| EU/EEA 이용자 Customer Data | 현재 활성 EU–U.S. DPF | EU SCC Module 2 fallback | **현재 근거 확인. DPF 중단·감사 시 SCC 보완** |
| Tomverse가 다른 controller의 processor인 경우 | EU SCC Module 3 | 동일 | 현재 B2C 직접 제공에는 통상 해당 없음 |
| Resend의 account·billing·usage data | 적용 범위의 DPF | Resend가 독립 controller이며 Module 1 fallback을 편입 | **현재 근거 확인. 재검토 조건 발생 시 fallback 보완** |
| 영국 이용자 | 현재 활성 UK Extension to EU–U.S. DPF | EU SCC를 수정하는 UK Addendum | **현재 근거 확인. DPF 중단·감사 시 Addendum 보완** |
| 스위스 이용자 | 스위스 FADP에 맞춘 EU SCC 수정조항 | 공개 DPA §6.5.3이 FDPIC를 관할기관으로 지정. Swiss–U.S. DPF 참여 표시는 없음 | **SCC 확인. Agreement 수락 증거 보관** |

호주 사업자라는 이유만으로 이 장치가 불필요해지는 것은 아니다. EDPB
[Guidelines 05/2021, Example 2](https://www.edpb.europa.eu/system/files/2023-02/edpb_guidelines_05-2021_interplay_between_the_application_of_art3-chapter_v_of_the_gdpr_v2_en_0.pdf)는
EU 이용자에게 재화·서비스를 제공하여 GDPR 제3조 제2항 적용을 받는 제3국
controller가 다른 비EEA processor에게 데이터를 넘기면 GDPR 제28조와 Chapter V가
적용된다고 설명한다. Tomverse → Resend가 그 구조다.

### 1.3 DPF 직접 조회

2026-09-14 미국 상무부
[Data Privacy Framework List](https://www.dataprivacyframework.gov/list)에서 `Resend`를
직접 검색해 다음을 관측했다.

| 항목 | 명부 표시 |
|---|---|
| 참가자 | Resend / 문의 법인 `PLUS FIVE FIVE` |
| EU–U.S. DPF | `Active - Re-certification under Review`, Non-HR Data |
| UK Extension | `Active - Re-certification under Review`, Non-HR Data |
| 최초 인증일 | 2025-02-20 |
| 다음 인증 기한 | 2027-03-03 |
| 검증 방식 | Self-Assessment |
| 감독기관 | Federal Trade Commission |
| 독립 구제 | EU DPAs / UK ICO |
| Swiss–U.S. DPF | 표시 없음 |

검색 결과의 상단 상태는 `Active Participant`다. 이 기록은 “활성”과 “갱신 심사
중”을 둘 다 보존하며, 단순히 `DPF 인증 완료`로 줄여 쓰지 않는다.

### 1.4 SCC의 완결성

공개 DPA는 다음 SCC 요소를 채운다.

- Module 2와 Module 3의 적용 조건
- Irish law와 Ireland courts
- 당사자, 역할과 연락처(Exhibit B)
- 데이터 주체, 데이터 종류, 빈도, 목적과 처리 기간(Exhibit A)
- 기술·조직적 보호조치(Exhibit C)
- 일반 사전승인 방식의 하위처리자 이용과 최소 14일 변경 통지
- 정부기관 요청 통지·고객으로의 redirect 시도·보호명령 협조
- importer가 SCC를 준수할 수 없게 되면 재평가, 추가 조치, 정지 또는 종료
- DPA 체결을 SCC와 Annex 서명으로 간주하는 조항

그러나 공개 PDF에는 다음 항목이 명시적으로 보이지 않는다.

- [EU SCC Clause 13과 Annex I.C](https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj)가
  적도록 요구하는 **관할 감독기관**. Tomverse는 호주 exporter이므로 이 칸은 Irish
  governing law만으로 자동 대체되지 않는다.
- UK Addendum의 필수 Part 1 Tables 1–4 또는 그 표가 요구하는 정보를 어느 계약
  조항이 제공하는지에 대한 완결된 매핑. [ICO 공식 안내](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/appropriate-safeguards/what-are-standard-data-protection-clauses-the-uk-idta-and-the-addendum/)는
  Part 1 표의 정보를 반드시 제공해야 한다고 설명한다.

공개 PDF의 EU SCC 부속정보를 실제 위치와 대조하면 다음과 같다.

| SCC 부속정보 | 공개 PDF 위치 | 판정 |
|---|---|---|
| Annex I.A 당사자 | Exhibit B | 있음. exporter는 `Customer, as specified in the Agreement` |
| Annex I.B 이전 설명 | Exhibit A | 있음. 데이터·주체·빈도·목적·기간 기재 |
| Annex I.C 관할 감독기관 | 별도 항목을 찾지 못함 | **확인 필요** |
| Annex II 기술·조직 조치 | Exhibit C | 있음 |
| Annex III 하위처리자 | 별도 표 없음 | Clause 9(a) Option 2 일반 승인이므로 통상 미적용 |

DPA §6.3.7은 “Exhibit B가 Annex I과 Annex III의 정보를 포함한다”고 선언하지만,
실제 PDF의 Exhibit B는 당사자만 기재하고 이전 상세는 Exhibit A에 둔다. 계정
Documents에서 받은 파일도 공개 PDF와 완전히 같으므로 계정별 추가 Annex가 뒤에
붙어 있지 않다. 이
표제·참조 불일치가 계약을 당연히 무효로 만든다고 단정하지는 않지만, Annex I.C가
어디에서 완성되는지 서면으로 확인할 충분한 이유가 된다.

UK Addendum도 동일하게 보면 당사자·SCC 버전·Module·일부 선택사항과 Appendix
Information은 DPA 본문과 Exhibits에서 상당 부분 읽을 수 있다. 그러나 Part 1 Table
4의 변경 시 종료권 선택과 Annex I.C 정보가 어느 조항에서 채워지는지는 공개본만으로
확인되지 않는다.

Annex III 하위처리자 표가 공개 PDF에 없는 것 자체는 현재 구조의 결함으로 보지
않는다. Resend DPA는 SCC Clause 9(a)의 **일반 승인**과 14일 사전 통지를 사용하고,
[공식 SCC의 Annex III 설명](https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj)은
**특정 승인(Option 1)**을 택할 때 작성하는 표라고 명시하기 때문이다. 다만 계정
PDF도 공개본과 동일하므로 이 계정에도 공개 DPA의 Option 2가 적용되는 것으로
기록한다.

따라서 별도 서명부터 다시 할 필요는 없다. 계정 PDF가 공개본과 같다는 사실까지
확인됐으므로, 이제 §8의 질문으로 Resend가 어떤 문서로 해당 정보를 충족하는지
확인하고 필요하면 보완 SCC/Addendum를 받아 이 TIA와 함께 보관한다.
공개 DPA §6.6.4는 적용법이 별도 SCC를 요구하면 Customer의 요청에 따라 해당 Annex와
이전 상세를 반영한 SCC를 신속히 체결하겠다고 이미 약정하므로, 보완 요청의 계약상
근거도 있다.

## 2. 실제 Tomverse 데이터 흐름

### 2.1 저장소에서 확인한 전송 필드

`lib/emailProviderPortCore.ts`의 `POST https://api.resend.com/emails` 요청은 다음을
Resend에 전달한다.

- `from`, 선택적 `reply_to`
- 수신자 이메일 주소 `to`
- `subject`
- 렌더된 `html`과 `text` 본문 전체
- 필요한 메일 헤더

첨부파일 필드, Resend contact/audience/segment, open/click tracking 필드는 이 API
요청에 없다. 오류 응답 본문은 수신자 주소가 들어 있을 수 있어 읽은 뒤 폐기하고,
API key도 로그에 남기지 않는다. webhook은 Svix 서명을 검증한 후 처리한다.

현재 등록된 메시지에는 로그인 코드·링크, 계정 환영·삭제·복원, 결제·플랜 안내,
내부 운영 리포트, 아직 비활성인 모델 출시 marketing이 있다. 로그인 메일의 6자리
코드와 링크 token은 본문에 들어가 Resend로 전송된다. `lib/emailLogin.ts`는 둘의
유효기간을 최대 10분으로 제한하고 Tomverse에는 HMAC만 저장한다.

### 2.2 위치와 보관

[Resend의 region 문서](https://resend.com/docs/dashboard/domains/regions)에 따르면
domain region은 라우팅·발송 위치만 정한다. 계정 데이터, 메일 metadata, log와 API
record는 선택한 region과 무관하게 미국에 저장된다. 따라서 Tomverse의 현재
`ap-northeast-1` 설정은 일본에서 발송한다는 뜻일 뿐 EU 또는 일본 데이터 보관을
의미하지 않는다.

[Resend GDPR 안내](https://resend.com/security/gdpr)의 공개 보관기간은 다음과 같다.

| 범위 | 기간 |
|---|---|
| Free / Pro / Scale의 email 및 log data | 계정 활성 중 30일 |
| backup | 7일 |
| 계정 종료 뒤 남은 customer data | 종료 후 90일 이내 삭제 |
| Enterprise | 계약에 따른 유연한 보관기간 |

공개 DPA Exhibit A 자체는 계정 활성 중 구체적인 30일을 계약상 보장하지 않고
Agreement가 유지되는 동안 처리한다고 쓴다. 30일은 현재 공개 운영정책이므로 변경을
모니터링해야 한다.

### 2.3 본문 저장 비활성화 옵션

[Resend 안내](https://resend.com/docs/knowledge-base/how-do-i-ensure-sensitive-data-isnt-stored-on-resend)에
따르면 다음을 모두 만족한 Pro/Scale team만 지원을 통해 message content storage를
끌 수 있다.

1. 유료 구독 1개월 이상
2. 활성 웹사이트가 있는 domain 사용
3. 3,000통 초과 발송, bounce rate 5% 미만
4. $50/월 add-on

이 옵션은 `message content` 비활성화다. metadata, delivery log, webhook payload와
backup까지 어떤 필드가 남는지는 공개 문서만으로 확정하지 않는다. 도입할 때 지원팀의
서면 답을 받아 범위를 기록한다.

### 2.4 계정 도메인 설정 증거

2026-09-14 대표가 제공한 Resend `Configuration` 화면을 확인했다.

| domain | 상태·발송 region | tracking | SMTP TLS | 화면 SHA-256 |
|---|---|---|---|---|
| `mail.tomverse.app` | Verified, Tokyo (`ap-northeast-1`) | `Enable tracking metrics`와 `Configure`만 표시. 추적 subdomain 미구성 | `Opportunistic` | `90F8A71837AE4E5ECDA7C3584BB9BD02AC3907F2E1B2210967EC050E34A68B43` |
| `tomverse.app` | Verified, Tokyo (`ap-northeast-1`) | `Enable tracking metrics`와 `Configure`만 표시. 추적 subdomain 미구성 | `Opportunistic` | `D530BE7236C7042E8B7CC67FE3180228BE2522859848A0F4681362932702ADCC` |

[Resend tracking 문서](https://resend.com/docs/dashboard/domains/tracking)는 open/click
tracking이 모든 domain에서 기본 비활성이며, tracking subdomain이 구성·검증된 경우에만
해당 설정이 적용된다고 명시한다. 따라서 두 화면은 **open/click tracking 비활성**의
충분한 계정 증거로 판정한다.

[Resend TLS 문서](https://resend.com/docs/knowledge-base/whats-the-difference-between-opportunistic-tls-vs-enforced-tls)는
`Opportunistic`이 먼저 TLS 연결을 시도하되 상대 서버가 지원하지 않으면 암호화 없이
전달하고, `Enforced`는 그 경우 발송에 실패한다고 설명한다. Resend는 인증 이메일에는
`Enforced`를 권고한다. 이는 SCC의 존재 여부와 별개인 보안 조치이며, 변경 전 도달 실패
영향을 받아들일지 대표가 결정한다.

## 3. GDPR 제28조 처리자 계약 체크

| 요구사항 | 공개 DPA 상태 | 비고 |
|---|---|---|
| 처리 대상·기간·성격·목적 | 충족 | Exhibit A. 활성 중 처리, 종료 후 90일 내 삭제 |
| 데이터 주체·개인정보 종류 | 충족 | 수신자, 계정 사용자; 주소·metadata·본문, 선택적 tracking |
| controller의 지시와 책임 | 충족 | Agreement·DPA·Exhibit A에 따른 처리 |
| 비밀유지·보안 | 충족 | 접근통제, TLS, at-rest 암호화, 조직·사고대응 조치 |
| 하위처리자 | 충족 | 일반 승인, 14일 통지, 이의제기와 서비스 중단권 |
| 정보주체 권리 지원 | 충족 | Resend가 요청을 Customer로 연결하고 필요한 지원 제공 |
| 침해 통지 | 충족 | 부당한 지체 없이 통지·협조 |
| 삭제·반환 | 충족 | 종료 시 선택, 불가능하면 처리 차단; 공개 보관정책 90일 |
| 감사·정보 제공 | 충족 | 인증·감사자료와 제한된 감사권 |
| 국외 이전 | **현재 범위 충족·fallback 보완 유보** | EU·UK DPF는 활성. SCC Annex I.C와 UK Addendum Part 1은 DPF 중단·감사 등 재검토 조건 발생 시 보완. Swiss 수정 SCC는 FDPIC를 지정 |
| 계정별 체결 증거 | **부분 확인** | Documents PDF 확보·공식 공개본과 hash 일치. Customer 명칭·Terms 수락일은 PDF 밖의 계정 증거/Resend 확인 필요 |

## 4. Transfer Impact Assessment 초안

EU Commission SCC Clause 14는 이전의 구체적 상황, 미국 법과 실무, 추가 계약·기술·
조직 조치를 함께 평가하도록 한다. EDPB
[Recommendations 01/2020](https://www.edpb.europa.eu/documents/recommendation/recommendations-012020-on-measures-that-supplement-transfer-tools-to_en)의
6단계에 맞춰 다음과 같이 기록한다.

### Step 1 — 이전 파악

- exporter: Tomverse의 실제 호주 사업자명(계정 기록 또는 Resend 답변으로 확정 예정)
- importer: Plus Five Five, Inc. / Resend, 미국
- 정보주체: EEA·영국·스위스 이메일 수신자
- 데이터: 이메일 주소, 제목, HTML/text 본문, delivery·bounce·complaint metadata,
  webhook payload. 로그인 코드·링크 포함 가능
- 빈도: 계정 계약이 유지되는 동안 지속적
- 목적: 인증과 계정·결제·서비스 안내의 전달
- onward transfer: Resend의 공개 하위처리자 중 실제 서비스 수행에 필요한 업체

### Step 2 — 이전 도구

- EEA: 현재 활성 EU–U.S. DPF. EU SCC Module 2는 fallback이며 DPF 중단·감사 등
  재검토 조건이 발생하면 부속정보를 보완한 뒤 사용
- 영국: 현재 활성 UK Extension. UK Addendum는 fallback이며 DPF 중단·감사 등
  재검토 조건이 발생하면 Part 1 정보를 보완한 뒤 사용
- 스위스: 수정 EU SCC. 공개 DPA가 FDPIC를 지정하며, 계정 체결 증거는 필요
- Article 49 예외: 반복적인 서비스 발송의 근거로 사용하지 않음

### Step 3 — 목적지 법·실무와 구체적 위험

- 미국 provider가 평문 이메일을 전달해야 하므로, 전송·저장 암호화는 provider나
  적법한 미국 정부 요구로부터 본문을 기술적으로 숨기지 못한다.
- 공개 DPA는 2026-08-27 현재 정보·보안기관의 Customer Data 공식 요청을 받은 적이
  없다고 진술한다. 이는 Resend의 계약상 진술이지 Tomverse의 독립 통계가 아니다.
- 데이터는 일반적으로 이메일 주소와 서비스 메시지이며 특별범주를 의도하지 않는다.
  그러나 본문에는 10분짜리 로그인 자격증명이 있고, 계정·결제 상태가 나타날 수 있다.
- 공개 하위처리자 목록은 범위가 넓고 각 업체가 어떤 Tomverse field를 실제로 받는지
  개별적으로 표시하지 않는다.
- DPF는 현재 활성 상태지만 re-certification review 중이다.

### Step 4 — 추가 조치

이미 확인된 조치:

- Tomverse → Resend API 구간의 HTTPS와 Resend의 AES-256 at-rest 암호화 공개 약속
- 역할 기반 접근통제, 비밀유지, 연례 침투시험, SOC 2 Type II
- 정부 요구 통지, 고객으로의 redirect, 보호명령 협조, 주기적 재평가라는 DPA 조항
- Tomverse가 API key와 provider 오류 본문을 로그에 남기지 않음
- Tomverse가 credential 평문을 DB·outbox snapshot에 저장하지 않고 10분 후 무효화
- 이메일 attachment를 Resend 요청에 포함하지 않음
- marketing 비활성과 사용자 질문·AI 응답을 이메일 본문에 넣지 않는 현재 구조
- 두 발송 domain의 open/click tracking 비활성

남은 조치:

- 확보한 DPA의 hash를 보존하고 최신 SOC 2·침투시험 attestation을 계정에서 내려받아
  제한된 운영 보관소에 저장
- Customer/effective date는 우선 계정·청구 기록으로 확인
- `/privacy`에 Resend 처리와 미국 이전을 고지
- 인증 이메일의 수신 서버 구간에도 TLS를 강제할지 결정. 현재는 두 domain 모두
  `Opportunistic`
- 하위처리자 변경 통지가 계정 관리자 이메일로 실제 수신되는지 확인
- 특별범주·민감한 자유서술을 이메일 본문에 넣지 않는 개발 규칙 유지

조건부 후속 조치:

- EU–U.S. DPF 또는 UK Extension이 inactive, lapsed, withdrawn 또는 무효가 되거나,
  기업 고객·감독기관·감사가 완성된 이전계약을 요구하거나, 특별범주·고위험 이메일
  처리를 시작할 때 EU SCC Annex I.C와 UK Addendum Part 1을 Resend 서면 답변 또는
  보완문서로 확정한다.
- 위 재검토 조건이 없는 동안에는 1인·무료 계정의 부담을 고려해 Resend 문의를 보류한다.

### Step 5 — 절차

SCC 원문을 수정하지 않고 DPA에 포함된 Module 2를 사용하는 구조에는 감독기관 사전
허가가 통상 필요하지 않다. 다만 그것은 SCC 부속정보를 비워도 된다는 뜻이 아니다.
체결본 PDF, 이 TIA의 대표 승인, 당시 DPF·하위처리자 조회 결과와 개인정보처리방침
버전을 함께 보관한다. 위 재검토 조건으로 Resend의 보충 답변·문서를 받으면 같은 기록에
추가한다.

### Step 6 — 재평가

정기 재평가 주기는 6개월로 두고, 다음 사건에는 즉시 다시 본다.

- Resend DPA·subprocessor·보관정책 변경 통지
- DPF가 inactive, lapsed 또는 withdrawn으로 변경
- 실제 정부기관 요청이나 보안침해 통지
- 특별범주 또는 대량 자유서술을 이메일로 보내는 새 template
- marketing 활성화 또는 Resend account/provider 분리
- data region·retention 요구가 있는 기업 고객 도입

### 4.1 잔여위험 판단 초안

**조건부 수용 초안.** 현재의 최소화된 비민감 transactional 이메일에는 자동 체결
DPA, 현재 활성 EU·UK DPF와 추가 조치가 비례적이다. EU SCC/UK Addendum fallback의
부속정보 보완은 현재 이전의 선행조건이 아니며, 위 재검토 조건이 발생할 때 실행한다.
Swiss 이전은 공개 DPA의 수정 SCC와 FDPIC 지정에 의존하며 Agreement 수락 증거를
보관한다. provider가 전달을 위해 평문을 볼 수 있다는 잔여위험은 남는다.
특별범주, 의료·인사·법률 비밀 또는 장문의 지원 내용을 발송하려면 이 판단을 재사용하지
말고 template별 새 평가 또는 EU 저장 provider를 선택한다.

승인자는 아래 §7에 날짜와 결정을 기록한다.

## 5. 현재 하위처리자와 변경 통지

[Resend 하위처리자 목록](https://resend.com/legal/subprocessors)은 2026-08-27
업데이트됐고, 미국 소재로 표시된 22개 업체를 열거한다.

Amazon Web Services, Anthropic, Attio, Cloudflare, Datadog, Elastic, Estuary,
Google, Inngest, Liveblocks, Metabase, Not Just Tickets(Plain), PlanetScale, Retool,
RunPod, Salesforce(Slack), Snowflake, Stripe, Supabase, Svix, Tinybird, Vercel.

이는 Resend가 서비스 전체에서 이용할 수 있는 승인 목록이다. 목록에 있다는 사실만으로
모든 업체가 모든 Tomverse 메일 본문을 받는다고 단정하지 않는다. DPA는 추가·교체 전
최소 14일 서면 통지, 합리적 이의제기, 대안을 제공할 수 없을 때 해당 서비스 중단권,
Resend의 하위처리자 책임을 규정한다.

## 6. 공개 개인정보처리방침 추가 문안

아래 문구는 대표가 실제 사업자 표시, 시행일과 변경 고지 방식을 승인한 뒤 모든 locale에
같은 의미로 반영한다. 아직 production 문구로 배포하지 않았다.

### 6.1 한국어 정본 초안

**이메일 전송 제공자**

> Tomverse는 계정 인증, 보안, 결제 및 서비스 안내와 사용자가 별도로 동의한
> 마케팅 이메일을 보내기 위해 미국의 Plus Five Five, Inc.(Resend)를 개인정보
> 처리자로 사용합니다. Resend에는 수신자의 이메일 주소, 발신·수신 정보, 제목,
> HTML·텍스트 본문(로그인 코드와 로그인 링크 포함), 발송·전달·반송·스팸 신고
> 정보와 관련 webhook 기록이 전송됩니다. Resend는 Free·Pro·Scale 계정의 이메일과
> 로그를 계정 활성 중 30일, backup을 7일 보관한다고 밝히며, 계정 종료 후 남은
> 고객 데이터는 90일 이내 삭제합니다. 발송 region 선택은 저장 위치를 바꾸지 않아
> 이 정보는 미국에 저장됩니다. EEA 관련 이전에는 Resend DPA에 포함된 EU 표준계약조항
> Module 2와, 적용되는 범위에서 EU–U.S. Data Privacy Framework를 사용합니다.
> 영국 이전에는 UK Addendum와 UK Extension, 스위스 이전에는 스위스법에 맞게 수정된
> EU 표준계약조항을 사용합니다. Resend의 최신 하위처리자 목록은
> https://resend.com/legal/subprocessors 에서 확인할 수 있습니다.

### 6.2 영어 정본 초안

**Email delivery provider**

> Tomverse uses Plus Five Five, Inc. (Resend), in the United States, as a
> processor to send account authentication, security, billing and service
> notices, and marketing email where you have separately opted in. Resend
> receives the recipient email address, sender and recipient details, subject,
> the complete HTML and text body (including login codes and sign-in links),
> delivery, bounce and complaint information, and related webhook records.
> Resend states that email and log data for active Free, Pro and Scale accounts
> is retained for 30 days, backups for 7 days, and remaining customer data is
> deleted within 90 days after account termination. A sending region does not
> change the storage location, and this information is stored in the United
> States. For relevant EEA transfers we use Module 2 of the EU Standard
> Contractual Clauses incorporated into Resend's DPA and, where applicable, the
> EU-U.S. Data Privacy Framework. UK transfers use the UK Addendum and UK
> Extension, and Swiss transfers use the EU SCCs as modified for Swiss law.
> Resend's current subprocessor list is available at
> https://resend.com/legal/subprocessors.

## 7. 대표가 완료할 항목

| 우선순위 | 할 일 | 완료 증거 | 상태 |
|---:|---|---|---|
| 1 | Resend 로그인 → `Settings → Documents` → DPA PDF 다운로드 | 2026-09-14 제공 파일의 SHA-256과 공식 공개본 일치 | **완료** |
| 2 | 실제 Customer 법적 명칭과 확인 가능한 최초 계정·결제일 기록 | 내부 계정/청구 기록. 정확한 Terms 수락일이 없어도 현재 발송을 차단하지 않음 | 미완료·비차단 |
| 1 | 현재 Resend 문의를 보류하고 재검토 조건 발생 시에만 §8 문의 사용 | 대표 결정 2026-09-14 | **완료** |
| 1 | 이 TIA의 `조건부 수용` 여부 결정·서명 | 아래 승인란 | 미완료 |
| 1 | §6 문구, 실제 사업자 표시와 개인정보처리방침 시행일 승인 | 전 locale 변경 및 배포 기록 | 미완료 |
| 2 | Resend 두 domain의 open/click tracking이 모두 off인지 확인 | 2026-09-14 화면 2개와 hash | **완료** |
| 2 | 인증 이메일 domain을 `Enforced TLS`로 바꿀지 결정 | 보안 강화 대 TLS 미지원 수신 서버 발송 실패 | 미완료·비차단 |
| 2 | Documents에서 최신 SOC 2 Type II와 침투시험 attestation 다운로드 | 접근 제한 운영 보관소의 파일명·기준기간 | 미완료 |
| 2 | Resend 계정 관리자 이메일이 14일 subprocessor 변경 통지를 받는 주소인지 확인 | 관리자 주소와 확인일. 주소 자체는 이 문서에 적지 않음 | 미완료 |
| 3 | 본문 저장 비활성화 add-on을 도입할지 결정 | 비용·자격·지원팀의 잔존 metadata 범위 답변 | 보류 가능 |

체결 DPA, SOC 2 전체 보고서와 침투시험 자료에는 비공개 계약·보안 정보가 있을 수
있으므로 public repository에 commit하지 않는다. 내부 보관 위치와 SHA-256만 이 감사
기록에 남길 수 있다.

## 8. 조건부 Resend 문의 초안 — 현재 발송 불필요

계정 Documents의 PDF도 공개본과 같고 필수정보가 별도로 붙어 있지 않다는 사실이
확인됐다. 그러나 현재 EU·영국 이전에는 활성 DPF가 적용되고, Resend DPA는 별도
문의 없이 Agreement 수락으로 체결된다. 1인·무료 계정이라는 운영 부담과 현재의
비민감 transactional 범위를 고려해 이 문의는 **보류**한다.

다음 중 하나가 발생할 때만 대표가 자신의 Resend 계정 이메일에서 support 또는
`privacy@resend.com`으로 아래 초안을 보낸다.

- EU–U.S. DPF 또는 UK Extension이 inactive, lapsed, withdrawn 또는 무효가 됨
- 기업 고객, 감독기관 또는 감사자가 완성된 SCC/UK Addendum를 요구함
- 특별범주·민감정보 또는 대량의 자유서술을 이메일로 처리하기 시작함
- 개인정보 민원·보안사고로 이전 장치의 구체적 증명이 필요해짐

> Subject: Request for completed SCC Annex I.C and UK Addendum information — Tomverse
>
> Hello Resend Privacy Team,
>
> I operate Tomverse as an Australian sole trader and use Resend to send
> transactional email to users, including users in the EEA, the UK and
> Switzerland. The PDF downloaded from Settings > Documents is the same standard
> pre-signed PDF available on Resend's public website and contains no account-specific
> Customer name or Effective Date.
>
> Please confirm for my account: (1) the legal Customer identity and Effective Date,
> and what account record evidences acceptance of the Agreement; (2) the competent
> supervisory authority required by Annex I.C of the EU SCCs, or the method by which
> that field is completed for an Australian exporter subject to GDPR Article 3(2);
> and (3) which document and provisions supply all information required by Part 1
> Tables 1–4 of the UK Addendum, including the parties permitted to end the Addendum
> when it changes.
>
> Section 6.3.7 says Exhibit B contains the Annex I information, but Exhibit B in the
> downloaded PDF appears to list only the parties. Please also confirm the channel
> through which the 14-day subprocessor change notice is sent and that section 6.5's
> Swiss modifications apply to this account.
>
> If the current executed documents do not supply the information in items (2) or
> (3), please provide the required clarification or execute a supplemental SCC or
> Addendum under section 6.6.4 of the DPA.
>
> Please do not include API keys, message bodies or recipient addresses in the
> response.

## 9. 승인란

| 항목 | 값 |
|---|---|
| 결정 | `미결` / `조건부 수용` / `불수용` |
| 승인자 |  |
| 승인일 |  |
| DPA 파일명·SHA-256 | `resend-dpa-signed.pdf` / `F028A0D8C49850DCA8CA2959ECD6E853095C55017BF72395567B787DD44C42EF` |
| PDF provenance | 공식 공개 사전서명본과 바이너리 일치 |
| Resend 서명 | Zeno Rocha Bueno Netto, CEO, 2026-01-14; DocuSign 객체 있음 |
| Resend 문의 | **현재 보류**. §8 재검토 조건 발생 시에만 발송(대표 결정 2026-09-14) |
| Customer·Effective Date | PDF에는 없음. 우선 계정·청구 기록으로 확인; 조건부 문의에서도 확인 가능 |
| EU SCC Annex I.C 관할 감독기관 | PDF에서 찾지 못함. §8 재검토 조건 발생 시 Resend 답변/보완문서 확보 |
| UK Addendum Part 1 정보 | 일부는 본문·Exhibits에 있으나 Table 4 등 완결 위치 불명. §8 재검토 조건 발생 시 보완 |
| SCC Clause 9(a) 선택 | **Option 2 일반 승인 확인**, DPA §6.3.2 |
| open/click tracking | `tomverse.app`, `mail.tomverse.app` 모두 비활성 확인(2026-09-14) |
| SMTP TLS | 두 domain 모두 `Opportunistic`; 강화 결정 대기 |
| 다음 정기 재검토일 | 승인일 + 6개월 |
| 조건 또는 예외 |  |
