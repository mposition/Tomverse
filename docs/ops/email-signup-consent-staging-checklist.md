# 가입 동의·제품 내 안내 staging 검증 체크리스트

`docs/policy/email-product-news-redesign-draft.md` §5.1–§5.4(S4 가입 흐름의 두
장치, S8 제품 내 안내)와 §7.7의 처리 결과 알림(S6b)을 staging에서 확인합니다.
이 체크리스트의 실행과 서명은 production에서
`feature.emailSignupConsentEnabled`를 켜기 위한 전제 조건입니다.

- **template revision**: `2026-09-30a`

## 이 문서는 template입니다

**여기에는 결과가 없습니다.** 체크박스는 항상 비어 있고, 그것이 이 파일의
상태입니다. 실행 결과는 날짜와 전체 deploy SHA로 이름 붙인 별도 파일로
`email-signup-consent-staging-verification-records/`에 남깁니다.

실행·판정·서명은 사람이 합니다. 에이전트는 실행자가 **보고한 관측**과 DB 조회
결과를 기록 초안에 옮겨 적을 수 있습니다. 쓸 수 없는 것은 **판정과 서명**뿐이며,
**지어낸 관측은 어느 쪽에서도 허용되지 않습니다.**

---

## 비용: 유료 turn 0회

이 표면은 모델을 부르지 않고 크레딧을 쓰지 않습니다. 비용은 staging에서 나가는
transactional 메일 몇 통(확인 메일·처리 결과 알림)뿐입니다.

## 항목 수

| 구획 | 항목 | 차단 | 비용 |
|---|---|---|---|
| A. 가입 화면의 세 선택 | 3 | 예 | 무료 |
| B. 기존 계정은 아무것도 소비하지 않음 | 1 | 예 | 무료 |
| C. 제품 내 안내의 거부 | 3 | 예 | 무료 |
| D. 제품 내 안내의 나머지 선택 | 2 | 아니오 | 무료 |
| E. 처리 결과 알림과 수신 설정 | 2 | 아니오 | 무료 |
| F. 화면과 문구 | 2 | 아니오 | 무료 |

**차단 7항목 / 전체 13항목 / 유료 turn 0회.**

범위를 줄이면 A·B·C만 실행합니다. 건너뛴 구획은 `미기록`이며, 판정란에 **무엇을
왜 건너뛰었는지** 적습니다.

## 무엇이 차단이고 무엇이 아닌가

기준은 AGENTS.md의 **틀렸을 때 되돌릴 수 없는가**입니다.

**차단 — 한 줄로 적을 수 있습니다.** `EmailPermissionEvent`와 `ConsentRecord`는
append-only이고 발송 판정의 근거입니다. 호주 관계(`relationship_started`)가
시작되지 않아야 할 가입에서 시작되거나, 기존 계정의 로그인이 가입 선택을 소비하거나, 거부가 기록되지 않으면 그
행을 근거로 나간 marketing 메일은 회수할 수 없습니다. A·B·C가 그 세 경로입니다.

**비차단** — D(나중에·네), E(결과 알림 문구·수신 설정), F(화면·문구). 틀려도
고쳐서 배포하면 끝나거나, 이미 고정된 근거 행을 새로 만들지 않는 것입니다.

---

## 왜 항목이 이것뿐인가

이미 자동화되어 **여기서 다시 하지 않는 것**:

| 이미 증명된 것 | 어디서 |
|---|---|
| attempt 발급·supersede·소비 compare-and-set, 만료, 경합 | `tests/integration/signup-consent.db.test.ts` |
| 소비·사건 기록·확인 메일이 한 transaction, 확인 불가 시 전체 롤백 | 같은 파일 |
| 제품 내 안내의 제시 조건과 거부 순서 | `tests/inProductConsentNoticeCore.test.mjs` |
| 처리 결과 알림의 enqueue 조건과 문구 | `tests/integration/processing-result-notice.db.test.ts` |
| 동의 문구의 불변성 | `npm run check:consent-copy-immutability` |

**정답은 DB가 말합니다.** 화면 앞에서 추론하지 않고, 각 계정의 행을 에이전트가
읽기 전용으로 조회해 아래 기대값과 대조합니다. 실행자는 **무엇을 눌렀는지와 어느
주소로 했는지**만 보고하면 됩니다.

**사람만 할 수 있는 것**:

1. **실제 OAuth 가입** — Google·Microsoft의 동의 화면은 합성할 수 없습니다.
2. **메일함의 링크 클릭** — 확인 메일이 실제로 도착하고 열리는지.
3. **판정과 서명.**

---

## 사전 조건

- [ ] staging이 서빙 중인 **전체 40자리 SHA**를 `GET /api/build-info`에서 읽음.
      merge SHA를 옮겨 적지 않습니다.
- [ ] 그 SHA가 `37c2cce2`(PR #1764 merge) 이후임
- [ ] staging DB의 `feature.emailSignupConsentEnabled`와
      `feature.emailConsentConfirmationEnabled`가 둘 다 `true`임
- [ ] 실행자의 접속 국가가 marketing 허용 국가(`MARKETING_ALLOWED_COUNTRY_CODES`)임.
      아니면 가입 화면에 장치가 **나타나지 않는 것이 정상**이고, 이 회차는 다른
      것을 측정합니다.
- [ ] **새 주소와 새 OAuth 계정.** staging DB는 production 사본이므로, production에
      한 번이라도 가입한 Google·Microsoft 계정이나 주소는 **기존 계정**이 되어 A
      구획을 측정하지 못합니다. 이메일 주소는 `+` 태그로 나눠도 됩니다(정규화 v1은
      소문자화만 하므로 서로 다른 주소입니다).

| 계정 | 채널 | 쓰는 곳 |
|---|---|---|
| E1 | 이메일 코드 | A-1 |
| G | Google | A-2, B-1 |
| M | Microsoft | A-3 |
| E2 | 이메일 코드(다른 탭의 링크) | C |
| E3·E4 | 이메일 코드(다른 탭의 링크) | D (선택) |

---

## A. 가입 화면의 세 선택 — 차단, 무료

**세 가입 모두 `relationship_started`가 없어야 합니다.** 관계는 동의 없이도 제품
소식이 갈 수 있음을 밝힌 가입 고지에서만 시작하는데(§4.4 결정 B), 그런 고지
버전을 담는 `RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS`가 이 SHA에서 비어
있습니다. 하나라도 있으면 그것이 발견입니다.

로그인하지 않은 상태에서 `/auth/signin`을 엽니다. 체크박스
("이메일 광고성 정보 수신동의 (선택)"), 고지 문장, 별도의 거부 체크
("광고성 이메일을 받지 않겠습니다")가 보여야 합니다.

- [ ] **A-1 (거부, E1)** 거부만 체크하고 이메일 코드로 가입.
      기대: attempt `consumed`, `notice_shown` 1건과 `objected` 1건
      (`capturedVia=signup_form`), **`relationship_started` 없음**, 확인 메일 없음,
      `UserSettings.country`에 IP 추정 국가.
- [ ] **A-2 (동의, G)** 동의 체크만 하고 Google로 가입 → 받은 확인 메일의 링크를
      눌러 확인 완료.
      기대: 가입 직후 `notice_shown`,
      `product_updates` 확인 메일 1통(`marketing_consent_confirmation`),
      `ConsentRecord` `confirmation_requested`. 링크 확인 뒤 `ConsentRecord`
      `granted`와 `consent_result_notice` 1통.
- [ ] **A-3 (무선택, M)** 아무것도 체크하지 않고 Microsoft로 가입.
      기대: `notice_shown`만, **`objected` 없음**, 확인 메일 없음,
      `ConsentRecord` 없음.

## B. 기존 계정은 아무것도 소비하지 않는다 — 차단, 무료

- [ ] **B-1** G로 로그아웃한 뒤, 가입 화면에서 동의 체크를 하고 **같은 Google
      계정으로 다시 로그인**.
      기대: 새 attempt는 `pending`으로 남고(15분 뒤 `expired`), **새
      `EmailPermissionEvent`·`ConsentRecord`·확인 메일이 하나도 없음**.

## C. 제품 내 안내의 거부 — 차단, 무료

가입 화면의 선택이 소비되지 않은 계정에만 안내가 뜹니다. 이메일 코드 가입에서
**메일의 로그인 링크를 다른 탭에서 열면** 그 탭에는 선택이 없으므로 소비되지
않습니다(§5.2). 그것으로 안내를 받을 계정을 만듭니다.

- [ ] **C-1** E2로 가입 화면에서 코드를 요청하고, 메일의 **링크를 새 탭에서** 열어
      로그인. 기대: 가입 선택 attempt는 소비되지 않고, 제품 화면에 안내
      ("제품 소식을 이메일로 받아보시겠습니까?")가 뜸. 렌더 시점에
      `notice_shown`(`capturedVia=in_product_notice`).
- [ ] **C-2** "받지 않겠습니다" 클릭. 기대: 창이 닫히고 `objected` 1건.
- [ ] **C-3** 새로고침과 재로그인 뒤에도 안내가 **다시 뜨지 않음**.

## D. 제품 내 안내의 나머지 선택 — 비차단, 무료

안내는 렌더될 때 `notice_shown`을 남겨 다시 뜨지 않으므로 선택마다 새 계정이
필요합니다.

- [ ] **D-1 (E3)** "나중에" → 아무 행도 더해지지 않음(`notice_shown`만 있음),
      새로고침 뒤 다시 뜨지 않음.
- [ ] **D-2 (E4)** "네, 받겠습니다" → 이메일 설정 화면으로 이동, 확인 메일
      **3통**(제품 소식·뉴스레터·프로모션). 링크를 누르기 전에는 `granted` 없음.

## E. 처리 결과 알림과 수신 설정 — 비차단, 무료

- [ ] **E-1** A-2의 `consent_result_notice`가 도착하고 발신자·처리 내용·결과·
      날짜를 적음.
- [ ] **E-2** G의 이메일 설정에서 marketing을 모두 끔 → `withdrawn`과
      `unsubscribe_result_notice` 1통.

## F. 화면과 문구 — 비차단, 무료

- [ ] **F-1** 320px 폭 모바일에서 가입 화면의 두 장치가 잘리거나 겹치지 않고,
      두 체크 모두 44px 터치 영역.
- [ ] **F-2** ko·en에서 가입 화면과 안내의 문구가 승인 문안
      (`lib/emailConsentCopy.ts`의 현재 버전)과 같음.
