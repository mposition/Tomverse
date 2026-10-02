# 가입 동의·제품 내 안내 staging 검증 체크리스트

이 체크리스트는 staging에서 네 가지를 확인합니다.

- `docs/policy/email-product-news-redesign-draft.md` §5.1–§5.2: 가입 흐름의 두 장치(S4)
- 같은 문서 §5.2a: 로그인과 가입의 분리(v25)
- 같은 문서 §5.4: 제품 내 안내(S8)
- 같은 문서 §7.7: 처리 결과 알림(S6b)
- 주소가 증명된 세션의 즉시 동의(B안): docs/policy/email-double-opt-in.md §14, Microsoft 포함 §14.7,
  가입 opt-in의 세 항목과 결과 알림 한 통 §14.8

이 체크리스트를 실행하고 서명하는 것이 production에서 `feature.emailSignupConsentEnabled`를 켜기 위한 전제 조건입니다.

- **template revision**: `2026-10-02a`

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
transactional 메일 몇 통(로그인 코드·확인 메일·처리 결과 알림)뿐입니다.

## 항목 수

| 구획 | 항목 | 차단 | 비용 |
|---|---|---|---|
| A. 가입 화면의 세 선택 | 3 | 예 | 무료 |
| B. 기존 계정은 아무것도 소비하지 않음 | 2 | 예 | 무료 |
| C. 로그인 화면의 "계정 없음"은 증명 뒤 가입 단계로 | 3 | 예 | 무료 |
| D. 제품 내 안내의 거부 | 3 | 예 | 무료 |
| E. 제품 내 안내의 나머지·처리 결과 알림 | 4 | 아니오 | 무료 |
| F. 화면과 문구 | 3 | 아니오 | 무료 |

**차단 11항목 / 전체 18항목 / 유료 turn 0회.**

범위를 줄이면 A·B·C·D만 실행합니다. 건너뛴 구획은 `미기록`이며, 판정란에 **무엇을
왜 건너뛰었는지** 적습니다.

## 무엇이 차단이고 무엇이 아닌가

기준은 AGENTS.md의 **틀렸을 때 되돌릴 수 없는가**입니다.

**차단 — 한 줄로 적을 수 있습니다.** `EmailPermissionEvent`와 `ConsentRecord`는
append-only이고 발송 판정의 근거입니다. 아래 가운데 하나라도 일어나면, 그 행을 근거로 나간 marketing 메일은 회수할 수 없습니다.

- 장치를 보지 않은 사람에게 `notice_shown`이 남는다.
- 기존 계정의 로그인이 가입 선택을 소비한다.
- 증명 전에 계정이 만들어진다.
- 거부가 기록되지 않는다.

A·B·C·D가 그 경로들입니다.

**비차단** — E(나중에·네·결과 알림), F(화면·문구). 틀려도 고쳐서 배포하면
끝나거나, 이미 고정된 근거 행을 새로 만들지 않는 것입니다.

---

## 왜 항목이 이것뿐인가

이미 자동화되어 **여기서 다시 하지 않는 것**:

| 이미 증명된 것 | 어디서 |
|---|---|
| attempt 발급·supersede·소비 compare-and-set, 만료, 경합, 소비된 로그인 행 binding | `tests/integration/signup-consent.db.test.ts` |
| 가입 보류의 1회성·만료·두 탭 경합·잠금 해제, 보류로 로그인·재활성화 거부 | `tests/integration/email-login-signup-hold.db.test.ts` |
| OAuth 가입 판정표(계정·주소·세션·의도) | `tests/oauthSignupGate.test.mjs` |
| 로그인·가입 화면 분리, 링크, 알 수 없는 제공자 거부, 320px | `tests/e2e/signin-signup-split.spec.ts` |
| 제품 내 안내의 제시 조건과 거부 순서 | `tests/inProductConsentNoticeCore.test.mjs` |
| 처리 결과 알림의 enqueue 조건과 문구 | `tests/integration/processing-result-notice.db.test.ts` |
| 동의 문구의 불변성 | `npm run check:consent-copy-immutability` |

**정답은 DB가 말합니다.** 화면 앞에서 추론하지 않고, 각 계정의 행을 에이전트가
읽기 전용으로 조회해 아래 기대값과 대조합니다. 실행자는 **무엇을 눌렀는지와 어느
주소·계정으로 했는지**만 보고하면 됩니다.

**사람만 할 수 있는 것**:

1. **실제 OAuth 가입** — Google·Microsoft의 동의 화면은 합성할 수 없습니다.
2. **메일함의 코드·링크** — 로그인 코드와 확인 메일이 실제로 도착하고 열리는지.
3. **판정과 서명.**

---

## 사전 조건

- [ ] staging이 서빙 중인 **전체 40자리 SHA**를 `GET /api/build-info`에서 읽음.
      merge SHA를 옮겨 적지 않습니다.
- [ ] 그 SHA가 `3e3a7d30`(PR #1854 merge) 이후임 — 여백(#1801)·동의 메일 디자인(#1802)·Microsoft 증명(#1804)·가입 opt-in 세 항목(#1854) 포함
- [ ] staging DB의 `feature.emailSignupConsentEnabled`와
      `feature.emailConsentConfirmationEnabled`가 둘 다 `true`임
- [ ] 실행자의 접속 국가가 marketing 허용 국가(`MARKETING_ALLOWED_COUNTRY_CODES`)임.
      아니면 장치가 **나타나지 않는 것이 정상**이고, 이 회차는 다른 것을 측정합니다.
- [ ] **새 주소와 새 OAuth 계정.** staging DB는 production 사본이므로, production에
      한 번이라도 가입한 Google·Microsoft 계정이나 주소는 **기존 계정**입니다.
      계정을 지우고 같은 주소를 다시 쓰면 그 주소의 **거부 기록이 남아 있습니다** —
      거부는 계정이 아니라 주소에 붙으므로, 거부한 적 있는 주소에는 제품 내 안내가
      뜨지 않습니다.
      이메일 주소는 `+` 태그로 나눠도 됩니다(정규화 v1은 소문자화만 하므로 서로
      다른 주소입니다).
- [ ] 계정마다 **새 시크릿 창**을 씁니다.

| 계정 | 채널 | 쓰는 곳 |
|---|---|---|
| G | 새 Google 계정(주소 확인된 Gmail 등) | C-2 → A-2 → B-1·B-2 (이 순서) |
| M | 새 Microsoft 계정 | A-3 |
| E1 | 새 이메일 주소 | A-1 |
| E2 | 새 이메일 주소 | C-1 |
| E3 | 새 이메일 주소 | C-3 |
| E4 | 새 이메일 주소 | D (에이전트가 flag를 잠시 끈 동안 가입) |
| E5·E6 | 새 이메일 주소 | E-1·E-2 (선택, E4와 같은 방식) |

---

## A. 가입 화면의 세 선택 — 차단, 무료

`/auth/signup`을 엽니다. 체크박스("이메일 광고성 정보 수신동의 (선택)"), 고지
문장, 별도의 거부 체크("광고성 이메일을 받지 않겠습니다")가 버튼 **위**에 있어야
합니다.

**세 가입 모두 `relationship_started`가 없어야 합니다.** 관계는 동의 없이도 제품
소식이 갈 수 있음을 밝힌 가입 고지에서만 시작하는데(docs/policy/email-product-news-redesign-draft.md §4.4 결정 B), 그런 고지
버전을 담는 `RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS`가 비어 있습니다. 하나라도
있으면 그것이 발견입니다.

- [ ] **A-1 (거부, E1)** 거부만 체크하고 이메일 코드로 가입(같은 탭의 코드 입력칸).
      기대: attempt `consumed`, `notice_shown` 1건과 `objected` 1건
      (`capturedVia=signup_form`), 확인 메일 없음, `UserSettings.country`에 IP
      추정 국가.
- [ ] **A-2 (동의, 증명된 세션, G)** 동의 체크만 하고 Google로 가입.
      기대: 가입 직후 `notice_shown`과 **세 항목**(`product_updates`·`newsletter`·
      `promotions`) 각각 **`granted`**(`evidence.confirmedVia=verified_session`,
      `proof=google_verified`, `capturedVia=signup_form`), 세 `EmailPreference` 모두
      켜지고 `confirmedAt` 있음(docs/policy/email-double-opt-in.md §14.8). **확인 메일
      (`marketing_consent_confirmation`)은 없고**, `consent_result_notice`는 **1통**만
      (세 항목에 한 통). 이메일 설정 화면에서 세 스위치가 켜져 보임.
- [ ] **A-3 (동의, Microsoft, M)** 동의 체크만 하고 Microsoft로 가입.
      기대: Microsoft 로그인도 주소 증명이므로(docs/policy/email-double-opt-in.md §14.7)
      가입 직후 `notice_shown`과 세 항목 각각 **`granted`**
      (`confirmedVia=verified_session`, `proof=microsoft_signin`). **확인 메일은 없고**,
      `consent_result_notice` 1통만. "무선택"은 C-3이 확인합니다.

## B. 기존 계정은 아무것도 소비하지 않는다 — 차단, 무료

- [ ] **B-1 (G)** 로그아웃한 뒤 **`/auth/signup`**에서 동의 체크를 하고 같은 Google
      계정으로 계속.
      기대: 로그인되고, 착지에 "이미 가입된 계정으로 로그인했습니다 … 알림 설정"
      안내가 한 번 뜸. 새 attempt는 `pending`으로 남고, **새
      `EmailPermissionEvent`·`ConsentRecord`·확인 메일이 없음**.
- [ ] **B-2 (G)** 로그아웃한 뒤 **`/auth/signin`**에서 Google로 로그인.
      기대: 로그인 화면에 동의 장치가 **없음**, 새 `SignupConsentAttempt`가 **없음**.

## C. 로그인 화면의 "계정 없음"은 증명 뒤 가입 단계로 — 차단, 무료

- [ ] **C-2 (G, A-2보다 먼저)** 한 번도 쓰지 않은 Google 계정으로 **`/auth/signin`**에서
      Google 클릭.
      기대: Google 인증 **뒤** `/auth/signup`으로 오고 "이 Google 계정으로 가입된
      계정이 없습니다" 안내. **`User`·`Account` 행이 생기지 않음.**
- [ ] **C-1 (E2)** **`/auth/signin`**에서 E2로 코드를 요청하고 코드를 입력.
      기대: "E2(으)로 가입된 계정이 없습니다. 이 주소로 가입하시겠어요?"와 두 장치가
      뜨고, **이 시점에 `User`가 없음**, 그 로그인 행은 소비되고 보류가 걸림. 거부를
      체크하고 "이 주소로 가입하기" → 계정 생성, `notice_shown`·`objected`
      (`signup_form`), attempt가 그 로그인 행에 묶임. 코드는 다시 받지 않음.
- [ ] **C-3 (E3)** **`/auth/signin`**에서 E3로 코드를 요청하고, 코드를 입력하지 말고
      메일의 **로그인 링크를 새 탭에서** 엶.
      기대: 링크 화면에 "가입된 계정이 없습니다"와 두 장치, **그 시점에 `User` 없음**.
      아무것도 체크하지 않고 가입 → `notice_shown`만.

## D. 제품 내 안내의 거부 — 차단, 무료

제품 내 안내는 `notice_shown`이 없는 계정에만 뜹니다. 분리 이후 가입 화면은 항상
장치를 보여 주므로, 안내를 받을 계정은 **장치가 없는 가입**으로 만듭니다 —
에이전트가 `feature.emailSignupConsentEnabled`를 잠시 `false`로 쓰고, 실행자가
E4로 가입하면 다시 `true`로 씁니다. 두 쓰기는 기록의 관측 칸에 시각과 함께
남깁니다.

- [ ] **D-1 (E4)** flag가 꺼진 동안 `/auth/signup`에서 E4로 가입(장치가 **없음**을
      확인). 가입을 마치면 에이전트에게 알리고, flag가 다시 켜진 **뒤에** 같은 창의
      **새 탭**에서 staging을 열고 1–2초 뒤 한 번 더 새로고침. 국가 추정은 탭마다 한
      번만 보내므로, flag가 꺼진 동안 열었던 탭에서는 국가가 기록되지 않고 안내도
      뜨지 않습니다. E4는 거부 이력이 없는 새 주소여야 합니다(사전 조건).
      기대: 제품 화면에 안내("제품 소식을 이메일로 받아보시겠습니까?")가 뜨고, 렌더
      시점에 `notice_shown`(`capturedVia=in_product_notice`).
- [ ] **D-2** "받지 않겠습니다" 클릭. 기대: 창이 닫히고 `objected` 1건.
- [ ] **D-3** 새로고침과 재로그인 뒤에도 안내가 **다시 뜨지 않음**.

## E. 제품 내 안내의 나머지·처리 결과 알림 — 비차단, 무료

- [ ] **E-1 (E5)** D-1과 같은 방식으로 만든 계정에서 "나중에" → `notice_shown`만
      있고, 새로고침 뒤 다시 뜨지 않음.
- [ ] **E-2 (E6)** 같은 방식으로 만든 계정(이메일 코드 로그인 = 증명된 세션)에서
      "네, 받겠습니다" → 이메일 설정 화면으로 이동, 세 항목이 **즉시 켜짐**.
      기대: `granted` 3건(`evidence.via=in_product_notice`,
      `confirmedVia=verified_session`), 확인 메일 없음. 처리 결과 알림은 한 번의 "네"에
      **1통**입니다(docs/policy/email-double-opt-in.md §14.8).
- [ ] **E-3** A-2(또는 A-3)의 `consent_result_notice`가 도착하고 발신자·처리 내용·결과·날짜를
      적음. 환영 메일과 같은 디자인(로고·카드·제목 띠)이고, 문구는 승인 문안 그대로(#1802).
- [ ] **E-4 (G)** 이메일 설정에서 marketing을 모두 끔 → `withdrawn`과
      `unsubscribe_result_notice` 1통.

## F. 화면과 문구 — 비차단, 무료

- [ ] **F-1** 가입 화면과 안내의 문구가 버전 `2026-09-30`임: 고지 문장은 "켜시면 …
      보내 드립니다. 언제든 끄실 수 있습니다." 두 문장뿐이고, 로그인 코드·영수증
      문장과 "로그인 없이"가 없음. ko·en에서 확인.
- [ ] **F-2** 320px 폭 모바일에서 `/auth/signup`의 두 장치와 버튼이 잘리거나 겹치지
      않고, 두 체크 모두 44px 터치 영역. 머리글 구분선 아래 여백이 과하지 않고, 고지 문장이
      동의 체크박스 바로 아래 그 글자 위치에서 시작함(#1801).
- [ ] **F-3** 로그인·가입 화면이 서로를 링크함("아직 회원이 아니신가요? 회원가입",
      "이미 회원이신가요? 로그인"), 약관 문장은 버튼 아래 한 줄.
