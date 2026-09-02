# N2 구현 보고서 — native mobile bearer authentication (2026-09-02)

승인 문서: `.github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md`
(승인 SHA `190056fc2ee9ffc923a8f6e1331081e272762d2f`, 승인자 `mposition`,
2026-08-31, Backend/AI · Mobile/Release 양쪽 approve)

벡터 커버리지: `.github/audits/2026-09-02-native-mobile-auth-n2-vector-coverage.md`

---

> **rev.2 (2026-09-02).** 승인자 검토에서 다섯 건이 지적됐고 전부 고쳤습니다. §5.1이
> 각각을 적습니다. **rev.1이 “V1~V14 통과”라고 적은 것은 V10에 대해 사실이
> 아니었습니다** — 그 정정은 §5.1의 1번과 벡터 커버리지 문서 §1.1에 있습니다.

## 1. 한 문단 요약

승인된 설계의 §8.1.1을 계약으로 삼아 N2를 구현했습니다. 토큰 발급·검증, refresh
회전, 취소, 다섯 개 endpoint, proxy의 순서, native bridge 경계가 모두 들어갔고
`develop`에 병합돼 있습니다. **동작은 아직 아무것도 바뀌지 않았습니다** —
`N1B_BEARER_ROUTES`가 승인된 대로 빈 목록이므로 native의 mutation은 여전히 403이고,
모바일 인증 자체는 환경변수가 없으면 503을 답합니다. 들어간 것은 **순서와 경계**이지
개방이 아닙니다.

---

## 2. 이 보고서가 주장하지 않는 것

승인 문서 §8.2.1이 명시한 것을 그대로 유지합니다. 아래 어느 것도 **아닙니다**.

- N1b 개방
- production 활성화
- 실기기 검증(`AUTH-01`·`AUTH-03`·`AUTH-04`)
- release-gate 통과
- R2의 `capacitor://` CORS 확인

`docs/release-gates/tomverse-chat-v1.yaml`의 `status`·`approvedBy`·`evidenceRefs`는
**건드리지 않았습니다.**

---

## 3. 커밋

| commit | 무엇 |
|---|---|
| `e07c7d5` | 순수 판정 모듈 — 토큰 검증(§5.2), 회전 3-갈래(D5), 취소 신선도(D12) |
| `236eb61` | data-domain registry 등재 → 다섯 테이블 migration |
| `9412dc4` | 암호 경계 — keyring 둘, JWS/Ed25519, refresh HMAC |
| `27bd00c` | 서비스와 다섯 endpoint, mutation-origin 면제와 그 조건 |
| `31b813e` | proxy의 §5.4·§5.5 순서, V14, D19의 TypeScript 표면 |
| `f9c4475` | native bridge, 거절하는 web fallback, `check:native-token-boundary` |
| `60383b2` | D12 배선 분리와 그 테스트, 남은 §7 벡터, 계약 불변식 |

그 사이에 다른 사람이 고친 것이 둘 있습니다 — `e0e60d6`, `75062ac`. §8에 적습니다.

---

## 4. 만들어진 것

### 4.1 판정 — 데이터베이스도 환경도 없는 순수 모듈

| 파일 | 무엇을 정하는가 |
|---|---|
| `lib/mobileAuthContract.ts` | 승인된 18개 값과 닫힌 목록 넷. 항목 번호를 각 값에 붙였습니다 |
| `lib/mobileAccessTokenCore.ts` | §5.2의 **순서**. 서명 검증이 주입된 port이고 step 3에서 불립니다 |
| `lib/mobileRefreshRotationCore.ts` | D5의 3단계. secret 비교가 **thunk**이고 step 2에서 불립니다 |
| `lib/mobileRevocationFreshnessCore.ts` | D12의 판정. `usable`과 `cacheable`을 따로 답합니다 |
| `lib/mobileSessionSnapshotCache.ts` | D12의 **기계** — 캐시, generation, 재조회 1회 |
| `lib/nativeBearerGate.ts` | §5.2를 바깥에서 본 판정, §5.4의 헤더 삭제 |

**왜 순서가 모듈 안에 있는가.** 이 여섯 중 셋은 "검사 목록"이 아니라 "순서"입니다.
호출자에게 순서를 맡기면 가독성을 위해 두 줄을 바꾸는 순간 틀립니다. 그래서
`verifyMobileAccessToken`은 claim을 반환하기 전까지 호출자에게 주지 않고,
`decideMobileRefresh`는 boolean이 아니라 thunk를 받습니다 — boolean은 호출자가 잘못된
순서로 계산해도 모듈이 알 수 없습니다.

### 4.2 암호 경계

| 파일 | 무엇 |
|---|---|
| `lib/mobileAuthKeyring.ts` | 링 **둘**. 서명 키와 pepper는 주기가 다릅니다(D6) |
| `lib/mobileAccessToken.ts` | JWS 압축 직렬화, Ed25519, port 결속 |
| `lib/mobileRefreshToken.ts` | 256비트 secret, pepper HMAC, 상수 시간 비교 |
| `lib/mobileLoginGrant.ts` | 60초 단일 사용 grant, PKCE S256 결속 |

링이 둘인 것이 D6의 요점입니다. 서명 키는 자기가 서명한 10분짜리 토큰만 넘기면 되고,
pepper는 **살아 있는 refresh 전부**에 묶여 있습니다. 같은 주기로 돌리면 전 사용자가
로그아웃됩니다. `tests/mobileAuthContract.test.mjs`가 그 관계를 고정합니다.

### 4.3 서비스와 인가

| 파일 | 무엇 |
|---|---|
| `lib/mobileAuthService.ts` | 발급·회전·logout·기기 목록·기기 해제·전체 폐기 |
| `lib/mobileSessionAuthorization.ts` | 검증된 토큰이 **아직 인가하는가** |
| `lib/mobileAuthRoute.ts` | route가 같은 토큰을 독립적으로 다시 검증(D2) |

**게이트는 인가가 아닙니다.** proxy는 서명과 만료만 봅니다. 폐기된 세션의 토큰이
`exp`까지 게이트를 통과할 수 있고, 그것을 막는 것이 `mobileSessionAuthorization.ts`
입니다. 이 문장을 쓸 수 없으면 설계가 틀린 것이라고 D12가 적었고, 쓸 수 있습니다.

### 4.4 데이터

migration `20260831120000_mobile_bearer_authentication` (201줄): `MobileDevice`,
`MobileTokenFamily`, `MobileRefreshRotation`, `MobileLoginGrant`, `MobileAuthEvent`.

- **등재가 먼저였습니다.** `docs/policy/tomverse-chat-data-domain-registry.yaml`에
  네 행을 넣은 뒤 migration을 썼습니다. `MobileRefreshRotation`은 user 컬럼이 없어
  등재 대상이 아니고, 등재하면 오히려 검사가 실패합니다. 2단계 cascade로 지워집니다.
- **`MobileAuthEvent.deviceId`·`familyId`에 FK가 없습니다.** audit 행은 자기가
  기록한 기기보다 오래 살아야 하니까요. 그래서 CHECK로 `userId`를 함께 요구합니다 —
  없으면 사람을 식별하는 행이 cascade를 피해 남습니다.
- 닫힌 목록 넷이 코드와 CHECK 양쪽에 있고 `check:enum-constraints`가 대조합니다.
- retention 정책 셋과 maintenance step 셋을 추가했습니다. rotation 정리는 **나이
  기준이 아닙니다** — 소비된 행이 재사용을 `reuse_detected`로 만드는 유일한 근거라,
  오래됐다고 지우면 공격자가 가장 오래 쥔 토큰에 대해서만 탐지가 사라집니다.

### 4.5 endpoint

| 경로 | 인증 | mutation-origin |
|---|---|---|
| `POST /api/auth/mobile/login-grant` | cookie 세션 | **적용**(브라우저 요청) |
| `POST /api/auth/mobile/exchange` | 본문의 grant + PKCE verifier | 면제 |
| `POST /api/auth/mobile/refresh` | 본문의 refresh token | 면제 |
| `POST /api/auth/mobile/logout` | 본문의 refresh token | 면제 |
| `GET /api/auth/mobile/devices` | access token | 해당 없음 |
| `POST /api/auth/mobile/devices/{id}/revoke` | access token | **적용** — D14대로 N1b 뒤 |

**면제에는 조건이 붙어 있고, 그 조건이 테스트입니다.** 세 handler는 cookie 신원을
절대 받지 않습니다 — `tests/mobileAuthExemptPaths.test.mjs`가 그 파일들이
`getServerSession`을 **언급만 해도** 실패합니다. 그 문장이 참인 동안에만 면제가
안전하고, 거짓이 되는 날 면제는 CSRF 구멍이 됩니다.

logout은 **항상 204**입니다. 다르게 답하면 토큰 진위 oracle이 되고, 호출자가 그 답으로
달리 할 수 있는 일이 없습니다.

### 4.6 proxy의 순서

§5.5 그대로: ① host·origin-secret → ② **내부 auth 헤더 무조건 삭제** →
③ N1a preflight → ④ route 등재 확인 → ⑤ bearer 검증 → ⑥ mutation-origin(⑤가
`yes`가 **아닐 때만**).

`N1B_BEARER_ROUTES`가 비어 있으므로 오늘 모든 판정이 `not_applicable`이고 어떤 요청도
다르게 동작하지 않습니다. `tests/mobileBearerProxy.test.mjs`가 그 무해함을 실제
proxy로 확인합니다 — **진짜 유효한 토큰**을 미등재 route에 보내도 여전히 403입니다.

route 목록은 상수를 읽지 않고 **인자로 받습니다.** 빈 목록은 그러지 않으면 곧
"테스트되지 않은 목록"이 됩니다.

### 4.7 native bridge (D19)

`apps/mobile/src/authBridgeContract.ts`가 표면을 셋으로 고정하고
(`getAccessToken`·`hasSession`·`signOut`), `authBridge.ts`의 web 구현은 **거절합니다.**
Capacitor가 권하는 web fallback의 자연스러운 형태가 JS에서 refresh endpoint를 부르는
것이고, 그것이 정확히 D19가 막는 것입니다. 브라우저에서는 로그인되지 않은 상태이며,
그것은 나중에 채울 구멍이 아니라 기기 밖에서 셸을 돌리는 일의 한계입니다.

`npm run check:native-token-boundary`가 게이트입니다. `apps/mobile`이 싣는 모든
파일에서 세 endpoint와 필드 이름을 찾습니다. **잡는다고 주장하는 세 형태 모두에서
실제로 실패하는 것을 확인했고**, 그 이름이 왜 없는지 설명하는 주석에는 걸리지 않는
것도 확인했습니다. PR Fast Gate와 릴리스 체크리스트에 있습니다.

---

## 5. 구현 중 발견해 고친 것

설계에 없던, 코드를 쓰다가 드러난 것들입니다.

1. **강제 로그아웃이 모바일 세션을 되살렸습니다.** `sessionsRevokedAt`만 찍으면
   access token(`iat`이 그보다 앞섬)은 막히지만 refresh token은 살아 있어서, 다음
   refresh가 sign-out **이후** 날짜의 access token을 발급하고 세션이 돌아왔습니다.
   `revokeAllUserSessions`가 모바일 family도 폐기하도록 했습니다 — D11의 가장 넓은
   행이 원래 그렇게 말하고 있었습니다. 이 수정 없이는 실패하는 db 테스트가 함께
   있습니다.
2. **`mobile_auth.revoked_on_account_deletion`을 아무도 쓰지 않았습니다.** CHECK
   제약에는 있고 writer가 없는 상태였습니다. 삭제 트랜잭션 안, User 행이 사라지기
   전에 `userId: null`로 씁니다 — 계정을 지목하는 행은 잠시 뒤 같은 cascade에 쓸려
   가고, 승인 결정 9는 비식별 집계 하나만 남기는 것을 허용합니다.
3. **D12의 배선에 테스트가 하나도 없었습니다.** 판정은 처음부터 테스트가 있었지만
   15초 상한을 실제로 참으로 만드는 캐시·generation·재조회에는 없었습니다.
   `lib/mobileSessionSnapshotCache.ts`로 분리해 조회와 시계를 주입받게 했고,
   V29a·V29b가 느린 DB를 기다리는 실험이 아니라 unit test가 됐습니다.
4. **N1a의 가드가 실패했고, 그게 맞았습니다.** "검증기가 생기기 전까지
   `Authorization`의 존재가 아무것도 바꿔서는 안 된다"는 문장은 생기는 날을 위한
   예약이었습니다. 실제로 성립하는 규칙으로 다시 썼습니다 — 헤더는 읽되 검증에
   넘기기 위해서만, 우회는 판정에 걸립니다.
5. **prefetch 분기가 위조 헤더를 그대로 전달했습니다.** 인자 없는
   `NextResponse.next()`는 요청을 그대로 넘기므로, §5.4의 삭제를 모든 early return
   위로 올려야 했습니다. 실제로 확인했고 테스트는 재작성된 헤더 목록의 **존재를
   단언**합니다 — 없어도 통과하면 회귀를 지나갑니다.

### 5.1 승인자 검토(2026-09-02)에서 지적돼 고친 것

다섯 건이고, 두 건은 차단 사유였습니다. 전부 이 rev.2에서 고쳤습니다.

**1. [차단] 동시 refresh가 A안이 아니었습니다.**
조건부 UPDATE가 0행이면 `lost_rotation_race`로 거절하고 family를 살려 두었습니다.
승인된 V10은 하나 200, 하나 401, **family 폐기**입니다. 그 동작은 A안도 B-1도 아니고,
패자의 조회가 승자의 commit 앞이었는지 뒤였는지에 따라 결과가 달라지는 **비결정적**
상태였습니다. 통합 테스트가 그 잘못된 동작을 고정하고 있었으므로 테스트의 존재가
통과를 뜻하지 않았습니다.
→ 0행이면 같은 트랜잭션에서 행의 실제 상태를 다시 읽어 판정합니다. 소비·폐기면
재사용(D8), 만료·부재면 거절. 순차 요청이 받았을 답과 같아집니다. 다섯 회 반복
테스트가 결정성을 고정합니다.

**2. [차단] 잘못된 키를 ‘설정 완료’로 보고 자격증명을 먼저 소비했습니다.**
`mobileAuthConfigured()`는 형식과 길이만 봤고, 서명은 세션 트랜잭션이 커밋된 뒤에
일어납니다. 잘못된 키가 배포되면 exchange는 grant와 rate limit을 소비하고 device·
family를 만든 뒤 500이었고, refresh는 기존 토큰을 소비하고 successor를 만든 뒤
500이라 다음 시도가 재사용으로 판정될 수 있었습니다.
→ `mobileAuthReady()`가 활성 키를 **실제로 파싱하고 서명하고 검증**합니다. 키 자료로
memo하므로 배포당 한 번입니다. 다섯 endpoint 전부 이것을 가장 먼저 부릅니다. 실제
route handler로 “503, 행 0건, grant 미소비”를 확인하는 db 테스트가 있고, 정상 키에서
같은 요청이 200이 되는 대조도 함께 둡니다.

**3. [높음] 인증 전 실패가 무제한으로 DB·로그를 늘렸습니다.**
malformed refresh도 즉시 `MobileAuthEvent`를 썼고, rate limit은 secret과 family가
확인된 **뒤에만** 걸렸습니다. 이 셋은 mutation-origin 예외 경로라 환경변수가
배포되면 누구나 부를 수 있습니다.
→ `enforceMobileAuthAdmission()`이 본문을 읽기 **전에** 클라이언트 키 기준으로
admission을 겁니다(`MOBILE_AUTH_PRE_AUTH_RATE_LIMIT`, 분 60 / 일 2,000).
그리고 파싱조차 안 되는 토큰은 **행을 쓰지 않습니다** — 계정도 기기도 family도 이름
대지 못하는 행이고, 그 사실은 구조화 로그가 담습니다. 기기·계정 기준 한도는 그대로
남아 있고 이것이 대체하지 않습니다.

**이 숫자는 승인된 18개에 없습니다.** 검토 지적에 따라 새로 만든 운영 guardrail이며,
다음에 이 설계를 볼 때 함께 기록해야 합니다.

**4. [높음] WebView의 access token을 임의 URL에 붙일 수 있었습니다.**
`authenticatedFetch()`가 임의 문자열을 받아 origin 검증 없이 Bearer를 붙였습니다.
→ 이제 **경로**를 받고 설정된 API origin에 대해 해석하며, `/api/` 밖·scheme-relative
(`//evil`)·절대 URL·백슬래시·해석 결과 origin 불일치를 전부 거절합니다. 거절된 경로는
**bridge에 토큰을 요청하지도 않습니다.** redirect는 `redirect: "error"`로 따라가지
않습니다 — same-origin redirect는 `Authorization`을 유지하므로 조용히 따라가는 것이
토큰이 아무도 고르지 않은 곳에 닿는 경로입니다.

**5. [중간] 승인된 키 유예기간이 상수일 뿐이었습니다.**
링에 있는 키는 기간 제한 없이 계속 신뢰됐습니다.
→ 은퇴 시각을 별개 변수(`MOBILE_AUTH_RETIRED_SIGNING_KEYS`,
`MOBILE_AUTH_RETIRED_REFRESH_PEPPERS`, `id@<ISO instant>`)로 받고, 유예를 지난 키는
검증에서 **null**이 됩니다 — 설정된 적 없는 키와 같은 답입니다. 은퇴한 id를 active로
지정하면 거부하고, 링에 없는 id의 은퇴는 오타로 보아 거부합니다. pepper는 자기
윈도우(30일 + skew)를 쓰며 서명 키 윈도우로 만료되지 않는 것을 테스트가 고정합니다.
절차는 `docs/ops/mobile-auth-key-rotation.md`에 있고, **자동 제거는 아직 없다**는 것도
그 문서가 적습니다.

### 5.2 재검토(2026-09-02)에서 지적돼 고친 것

1차 다섯 건이 해결된 것을 확인받은 뒤, 세 건이 새로 나왔습니다. 두 건이 차단이었습니다.

**1. [차단] rate limit의 실제 응답 코드가 계약과 달랐습니다.**
계약은 `MOBILE_RATE_LIMITED`를 정의하는데, 모든 한도가 공통 `apiSecurityResponse()`를
지나 `API_RATE_LIMITED`를 반환했습니다. **`MOBILE_RATE_LIMITED`는 실행 코드에서 한 번도
쓰이지 않았습니다.** 제가 §5.1의 3번에서 새로 쓴 admission 테스트도 **429 상태만**
보고 본문의 code는 보지 않아 이것을 지나쳤습니다.
→ `mobileApiSecurityResponse()`가 429만 모바일 코드로 옮깁니다. 400·413 같은 일반
요청 오류는 인증 거절이 아니므로 그대로 둡니다. 그리고 계약의 **네 코드 전부를 실제
route 응답 본문에서** 꺼내 대조하는 테스트를 넣었습니다 — 선언돼 있고 아무도 내보내지
않는 코드는 아무도 지키지 않는 약속입니다.

**2. [차단·운영] 회전 문서대로 하면 전체 모바일 인증이 503이 됐습니다.**
문서는 유예 후 링에서 이전 항목만 지우라고 안내했는데, 은퇴 목록에 그 id가 남아
있으면 파서가 "링에 없는 retirement id"로 **거부**했고 `mobileAuthReady()`가 false가
됐습니다. 사고 대응 절차도 유출된 키가 active일 때 대체 없이 삭제하도록 읽혀 같은
결과를 냈습니다.
→ **파서를 되돌렸습니다.** 링에 없는 은퇴 id는 이제 오류 로그를 남기고 무시합니다.
제가 그것을 거부로 만든 근거는 오타 탐지였는데, **두 실수의 비용이 비교되지
않습니다** — 링에 없는 키는 이미 못 쓰는 키라 그 줄이 보호하는 것도 위태롭게 하는
것도 없고, 반대쪽은 전체 장애입니다. 오타는 로그가 알립니다.
문서도 고쳤습니다: 정리는 **링 항목 · 은퇴 줄 · active 확인 셋을 한 배포에서**,
사고 대응은 active 키라면 **새 키 추가 → active 전환 → 삭제**를 나눠 배포하지 않도록.
정리 자체가 선택이라는 것도 적었습니다 — 유예가 지난 항목은 이미 검증에 쓰이지
않습니다.

**3. [높음] 설정 origin이 HTTP여도 토큰을 보냈습니다.**
`resolveApiUrl()`이 설정 origin과의 일치만 봤으므로 `http://tomverse.app`이 완벽히
일치하며 Bearer가 평문 연결에 붙었습니다.
→ `assertUsableApiOrigin()`이 fail-closed로 `https:`만 허용하고, 자격증명이 실린
origin과 path·query·fragment가 붙은 값을 거절합니다. 거절은 **bridge에 토큰을
요청하기 전에** 일어납니다.

---

### 5.3 3차 검토(2026-09-02)에서 지적돼 고친 것

**1. [차단] 은퇴 id 오타가 이전 키를 무기한 신뢰하게 만들었습니다.**
검토자가 `b6e7bb2`에서 직접 실행해 보였습니다 — 링 `{sign-old, sign-new}`, active
`sign-new`, 은퇴 목록에 오타 `sign-odl`. 결과는 `mobileAuthReady=true`였고
**`sign-old`가 2099년에도 신뢰**됐습니다. 승인된 "이전 서명 키 15분"이 적용되지 않았고,
유출된 이전 개인키로 계속 토큰을 만들 수 있었습니다. pepper도 같았습니다. 제가 이
저장소에서 재현했고 지적대로였습니다.

**§5.2의 2번에서 제가 한 수정이 이것을 만들었습니다.** 전체 장애를 조용한 보안 실패로
바꾼 것이고, 어느 쪽도 답이 아니었습니다. 두 번 다 **질문이 틀렸습니다** — "이 은퇴
줄이 맞는가"는 답할 수 없습니다(정리 잔여물과 오타가 같아 보입니다). "이 키가
검증해도 되는가"는 답할 수 있고, 안전한 기본값이 "아니오"입니다.

→ 규칙을 키에 대한 것으로 바꿨습니다: **키는 active이거나, 명시적으로 은퇴했고 유예
안에 있을 때만 검증에 쓰입니다.** 링에 있으면서 둘 다 아닌 키는 아무것도 검증하지
않습니다. 오타는 이제 이전 키를 **즉시** 검증에서 뺍니다 — 계약보다 엄격한 쪽이고,
드러나며(그 키로 서명된 토큰이 거절되고 클라이언트가 refresh합니다), 다른 것을
멈추지 않습니다. 회귀 테스트가 검토자의 구성을 그대로 넣고 2099년에도 `null`임을
확인합니다.

대가는 은퇴 줄을 빠뜨리는 것이 더는 공짜가 아니라는 점입니다 — pepper라면 그 세대의
사용자가 다시 로그인합니다. 그래서 **배포 전 확인**을 절차에 넣었습니다:
`npm run check:mobile-auth-keyring`이 키마다 `ACTIVE` / `RETIRED, verifies until …` /
`UNDECLARED -- verifies nothing`을 출력하고 마지막 것이 있으면 실패합니다. CI가
아닙니다 — CI에는 키가 없고, 설정되지 않은 배포는 정상 상태입니다.

**로그 증폭도 함께 고쳤습니다.** 같은 오류가 파싱할 때마다 기록돼 한 번의 readiness에서
3회 나왔고, 공개 endpoint가 admission 전에 `mobileAuthReady()`를 부르므로 잘못된 설정에서
증폭 경로가 됐습니다. 파싱을 원문 기준으로 memo하고 같은 메시지는 프로세스당 한 번만
기록합니다.

**2. [중간] "네 코드 모두 wire에서 관측" 테스트가 상수를 주입하고 있었습니다.**
`seen.add(MOBILE_AUTH_ERROR_CODES.rateLimited)` — 테스트 이름과 이 보고서의 주장이 그
한 코드에 대해 사실이 아니었습니다. 이제 그 테스트가 자기 client 주소로 admission을
소진시켜 **실제 429 응답의 body.code**를 같은 집계에 넣습니다.
`lib/mobileAuthKeyring.ts`의 낡은 주석(unknown id를 거부한다는 설명)도 함께 고쳤습니다.

---

### 5.4 4차 검토(2026-09-02)에서 지적돼 고친 것

두 건 다 **운영 경로**입니다 — 런타임은 맞았고, 그것을 운영하는 도구와 절차가
틀렸습니다.

**1. [차단] 배포 전 검사가 미설정·부분 설정을 정상으로 판정했습니다.**
두 링이 비면 즉시 `exit 0`이었으므로, 운영자가 **환경변수를 하나도 불러오지 않아도**
릴리스 점검이 `OK`였습니다. 그리고 검사기는 active id를 `trim()`했는데 런타임은
원문으로 비교했습니다.

확인해 보니 **런타임이 자기 자신과도 어긋나 있었습니다.** `" sign-2 "`에서
`activeMobileSigningKey`는 던지고(모든 요청 503) `mobileSigningKeyById("sign-2")`는
같은 키를 usable이라고 답했습니다. `normalizeMobileKeyId()` 하나를 런타임 두 곳과
검사기가 함께 씁니다.

→ 검사기는 이제 **일부만 설정된 상태에서 실패**하고(어느 변수가 빠졌는지 이름을
댑니다), 완전 미설정은 기본 모드에서 통과하되 `--require-configured`로 실패시킬 수
있습니다. 릴리스 체크리스트가 그 플래그를 씁니다. 그리고 검사기가 **정상·완전
미설정·부분 설정·공백·오타·서명 불가·중복 은퇴**를 subprocess로 돌려 exit code를
확인하는 테스트 13개가 생겼습니다 — 그전까지 이 검사기를 실행하는 테스트는 하나도
없었습니다.

그 테스트를 쓰다 검사기의 구멍이 하나 더 나왔습니다. 오타 난 은퇴 id를 **파서가
버리므로** 검사기가 그것을 볼 수 없었고, 오타의 절반(`UNDECLARED`)만 보고했습니다.
이제 원문 변수를 직접 읽어 양쪽을 다 보고합니다.

**2. [차단·운영] 회전 절차가 새 규칙과 충돌했습니다.**
문서는 ① 새 키만 추가해 배포 ② active 전환 ③ 은퇴 줄 추가로 적었는데, 지금 규칙에서
**두 배포 다 잘못된 상태**입니다. ① 뒤에는 새 키가 `UNDECLARED`라 검사가 실패하고,
② 뒤 ③ 전에는 **이전 키가 `UNDECLARED`가 되어 즉시 검증에서 빠집니다** — 서명 키면
살아 있는 access token이 거절되고, pepper면 그 세대 사용자가 재로그인합니다.
→ 절차를 **세 값을 정하고 → 검사하고 → 한 배포로 적용**하도록 고쳤습니다. 왜 나눠
배포하면 안 되는지도 각 중간 상태의 결과와 함께 적었습니다.

**그리고 §2.1의 "production 자격증명이 필요하지 않다"는 제 문장이 틀렸습니다.**
검사가 활성 키로 실제 서명해 보므로 개인키와 pepper 원문이 필요합니다 — **배포할
값이 곧 production 자격증명입니다.** 실행 위치를 로컬 PC에서 **Railway 서비스
shell**로 바꿨습니다. 그 값을 노트북으로 복사하는 것이 검사보다 큰 위험입니다.

---

### 5.5 5차 검토(2026-09-02)에서 지적돼 고친 것

**1. [운영 차단] 체크리스트의 명령이 아직 기본 모드였습니다.**
체크박스에는 `npm run check:mobile-auth-keyring`이 적혀 있고 플래그는 아래 설명에만
있었으니, 그대로 복사하면 **변수가 하나도 없는 셸에서도 초록**이 됩니다.
→ 체크박스를 둘로 나눴습니다. 모바일 인증을 서비스하는 배포용 항목의 **명령 자체에**
`-- --require-configured`가 들어 있고, 켜지 않은 배포용 항목은 완전 미설정을
통과시키되 부분 설정은 여전히 실패한다고 적었습니다.

**2. [운영 차단] "Railway 서비스 shell"이 두 가지로 틀렸습니다.**
Railway 문서를 확인했습니다. `railway shell`은 컨테이너 접속이 아니라 **서비스 변수를
로컬 셸에 주입**하는 명령이고, sealed 변수는 UI·API 어느 쪽으로도 읽히지 않으므로
그렇게는 오지 않습니다. 컨테이너에 들어가는 것은 `railway ssh`입니다.

그리고 더 중요한 쪽 — **검사기가 그 컨테이너에서 돌아간다고 보장할 수 없습니다.**
`tsx`는 devDependency이고, 이 저장소에서 배포되는 script들은 전부 TypeScript를
import하지 않는 순수 `.mjs`입니다(`scripts/run-maintenance.mjs`는 HTTP 호출만
합니다). 그 관례가 곧 이유이고, production 이미지에 `tsx`가 있는지 저는 여기서
확인할 수 없습니다.

→ 실행 위치를 **저장소가 있는 곳(로컬 clone)** 으로 되돌리고, **배포하려는 값을 손으로
넣어** 돌리게 했습니다. 검증 대상은 *지금 설정된 것*이 아니라 *설정하려는 것*이므로
그것이 원래 맞습니다. 활성 키의 개인키가 필요한 것은 그대로이며, 회전에서는 방금 만든
새 키라 이미 손에 있습니다.

**한계를 문서에 적었습니다.** 살아 있는 설정을 감사하려면 컨테이너 안에서 돌려야 하고
그것은 아직 지원되지 않습니다. 해결하려면 검사기의 순수 판정 부분을 의존성 없는
`.mjs`로 옮겨야 하며(`lib/schemaComparisonCore.mjs`가 선례), production 활성화와 함께
정할 일로 §10에 남겼습니다.

**3. [증거 정합성] 보고서가 subprocess 범위에 "중복 은퇴"를 넣었는데 없었습니다.**
문구를 좁히는 대신 **경우를 추가했습니다** — 중복·형식 오류 은퇴 줄 다섯 가지가
exit 1이 되고 어느 변수인지 이름을 대는지 확인합니다. subprocess 테스트는 14개가
됐습니다.

**그리고 runbook의 "한 번에 하나씩"이 바로 뒤의 "세 변수를 한 배포에서"와
충돌했습니다.** Railway 대시보드의 편집은 배포로 확정되기 전까지 staged 상태로
모이므로, 셋을 모두 고친 뒤 한 번에 배포한다고 고쳤습니다.

---

---

## 6. 검증

이 보고서를 쓴 시점에 실행한 것입니다.

| 무엇 | 결과 |
|---|---|
| `npm run test:unit` | **7,479 pass / 0 fail** (1 skipped, 기존) |
| `npm run test:server-contract` | **508 pass / 0 fail** |
| `tests/integration/mobile-auth-*.db.test.ts` | **29 pass / 0 fail** — 실제 PostgreSQL 16, 전체 migration 이력으로 세운 DB |
| `prisma migrate diff --exit-code` | 차이 없음 |
| `npm run lint` · `typecheck` · `build` | 통과 |
| `check:enum-constraints` · `check:data-domain-registry` · `check:native-token-boundary` · `check:capacitor-local-bundle` · `check:doc-references` · `check:policy-section-references` · `check:encoding:strict` · `check:shared-packages` | 전부 0 |

모바일 인증 테스트는 **147개 unit + 29개 db = 176개**, 16개 파일입니다.
소스는 lib·routes·apps·script 합쳐 약 3,460줄입니다.

**실행하지 않은 것은 위 표에 없습니다.** E2E(Playwright), 부하, 실기기는 실행하지
않았습니다.

---

## 7. §7 벡터

전체 대조는 `.github/audits/2026-09-02-native-mobile-auth-n2-vector-coverage.md`에
있습니다. 요약하면:

- **통과**: V1~V14, V16, V22, V24~V31 (V24b·V24c·V25·V26·V26b·V27·V28·V29a·V29b·V30·V31 포함)
- **N1b가 열려야 도달**: V17·V18·V19·V23, 그리고 V20·V21의 401 절반
- **코드가 판정할 수 없음**: V15의 15분(운영 행위), 실기기 증거

§8.2 선행 조건 3번은 V17~V23을 "N1b 이전에" 요구하는데 이 넷은 N1b 없이 성립하지
않습니다. 순환처럼 보이지만 아닙니다 — **첫 route 등재가 이 넷을 함께 들고 와야
한다**는 뜻으로 읽습니다. 등재를 먼저 하고 벡터를 나중에 붙이는 순서는 이 조건을
만족하지 않습니다.

---

## 8. 이번 작업이 `develop`을 빨갛게 만들었습니다

정직하게 적습니다. `236eb61`("다섯 테이블")이 `lib/maintenance.ts`에 cleanup step
셋을 추가하면서, server-contract 테스트의 stub에 그 세 모델을 넣지 않았습니다.
`develop`이 그 시점부터 빨갛게 됐고 열려 있던 모든 PR이 그 실패를 물려받았습니다.
`e0e60d6`이 stub을 채워 고쳤고, 같은 수정이 두 PR에 중복으로 들어가 `75062ac`이
중복을 지웠습니다.

**원인은 제가 실행한 lane이 하나 모자랐다는 것입니다.** 저는
`npm run test:unit`만 돌렸고 `npm run test:server-contract`는 별도 script인데 돌리지
않았습니다. 이 보고서를 쓰면서 실행했고 508/508 통과합니다. 이후 커밋부터는 두 lane을
모두 확인했습니다.

배운 것을 한 줄로: **`lib/maintenance.ts`에 step을 추가하면 server-contract stub도
같이 움직여야 합니다.** `75062ac`이 남긴 주석이 그 stub이 뒤처진 것이 이번이 두 번째
라고 적고 있고, 아직 그것을 검사하는 것은 없습니다.

---

## 9. 운영에 필요한 환경변수

여섯 개이고, **지금까지 어느 문서도 적지 않았습니다.**

| 변수 | 형태 | 뜻 |
|---|---|---|
| `MOBILE_AUTH_SIGNING_KEYS` | `id:base64Pkcs8,...` | Ed25519 개인키 링. 은퇴한 키는 링에 남깁니다 |
| `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID` | `id` | 새 access token을 서명할 키 |
| `MOBILE_AUTH_REFRESH_PEPPERS` | `id:secret,...` | refresh digest용 pepper 링 |
| `MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID` | `id` | 새 digest를 계산할 pepper |
| `MOBILE_AUTH_TOKEN_ISSUER` | 문자열 | `iss`. 검증이 **정확 일치**합니다 |
| `MOBILE_AUTH_TOKEN_AUDIENCE` | 문자열 | `aud`. 같습니다 |
| `MOBILE_AUTH_RETIRED_SIGNING_KEYS` | `id@<ISO instant>,...` | 선택. 은퇴 시각. 유예 15분이 지나면 검증에서 빠집니다 |
| `MOBILE_AUTH_RETIRED_REFRESH_PEPPERS` | `id@<ISO instant>,...` | 선택. 유예 30일 + skew |

여섯 중 필수는 넷이고(은퇴 목록은 선택), 하나라도 없거나 **활성 서명 키가 실제로
서명하지 못하면** `mobileAuthReady()`가 false이고 모든 모바일 endpoint가 **503**을
답합니다. 형식 검사만으로는 부족하다는 것이 검토 지적 2번이었습니다. 어느 변수가 없는지는 말하지 않습니다 — 인증되지 않은 요청자가
들을 이유가 없는 배포 사실입니다.

**`/api/ready`는 이 여섯을 검사하지 않습니다.** 의도된 것입니다: 모바일 인증이 아직
켜지지 않은 배포에서 readiness를 실패시킬 이유가 없고, 켜졌는지 여부는 endpoint가
fail-closed로 답합니다. production 활성화를 결정할 때 `/api/ready`에 넣을지는 그때의
결정입니다.

회전 절차와 키 생성 명령은 `docs/ops/mobile-auth-key-rotation.md`에 있습니다.

---

## 10. 남은 것

| 항목 | 조건 |
|---|---|
| **N1b 개방** | §8.2의 네 선행 조건. route 하나씩, 각각 bearer 전환 증거와 V17~V19·V23을 함께 |
| **production 활성화** | 별도 승인. 환경변수 배포가 코드보다 먼저 |
| **실기기 판정** | `AUTH-01`·`AUTH-03`·`AUTH-04`. Swift·Kotlin이 아직 없습니다 |
| **R2의 `capacitor://` CORS** | 별도 확인 |
| **B-2 재검토** | 승인 항목 17 — 별도 후속 |
| **웹 `sessionSecurity` 캐시 조사** | 승인 항목 18 — 별도 후속. N2에는 D12의 강화된 계약을 처음부터 적용했습니다 |
| **maintenance stub 검사** | §8의 재발 방지. 아직 없습니다 |
| **검사기를 배포 이미지에서 실행 가능하게** | 순수 판정 부분을 의존성 없는 `.mjs`로. 그래야 `railway ssh`로 들어가 **살아 있는** 설정을 감사할 수 있습니다. 지금은 배포할 값을 손으로 넣는 사전 검증만 됩니다 |
| **은퇴 키 자동 제거·상시 보고** | 유예가 지난 항목과 선언되지 않은 키를 코드가 쓰지 않을 뿐, 배포 전 확인을 **돌리게 하는 것은 문서뿐**입니다. 상시 점검은 production 활성화와 함께 정합니다 |
| **`MOBILE_AUTH_PRE_AUTH_RATE_LIMIT`(분 60 / 일 2,000) 승인** | 승인된 18개 밖의 새 값입니다. 재검토에서 "미승인 값으로 명확히 기록됨 — production 승인 전 사람의 결정 필요"로 확인됐습니다 |
