# N2 구현 보고서 — native mobile bearer authentication (2026-09-02)

승인 문서: `.github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md`
(승인 SHA `190056fc2ee9ffc923a8f6e1331081e272762d2f`, 승인자 `mposition`,
2026-08-31, Backend/AI · Mobile/Release 양쪽 approve)

벡터 커버리지: `.github/audits/2026-09-02-native-mobile-auth-n2-vector-coverage.md`

---

> **rev.2 (2026-09-02).** 승인자 검토에서 다섯 건이 지적됐고 전부 고쳤습니다. §5.1이
> 각각을 적습니다. **rev.1이 “V1~V14 통과”라고 적은 것은 V10에 대해 사실이
> 아니었습니다** — 그 정정은 §5.1의 1번과 벡터 커버리지 문서 §1.1에 있습니다.
>
> **rev.7 (2026-09-02).** 6차 검토의 세 건은 §5.6입니다. 전부 운영 절차이고 코드
> 판정은 바뀌지 않았습니다. 그중 하나(**회전에 필요한 이전 링의 평문**)는 제가 정할 수
> 있는 것이 아니라 **production 활성화의 선결 조건**으로 §10에 남았습니다.
>
> **rev.8 (2026-09-02).** 7차 검토의 세 건은 §5.7입니다. §2.2의 (c)가 택일 항목이
> 아니라는 정정, wrapper 자체의 회귀망, 그리고 "넷"이 실제로는 여섯이었던 것.

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

### 5.6 6차 검토(2026-09-02)에서 지적돼 고친 것

세 건 다 **운영 절차**이고 코드 판정은 건드리지 않았습니다. 검토는 검사기 코드 자체를
승인 가능하다고 판정했고, 남은 것이 그 검사기를 사람이 어떻게 돌리느냐였습니다.

**1. [보안] runbook의 PowerShell 예시가 production 비밀값을 명령 이력에 남겼습니다.**
§2.1은 `$env:MOBILE_AUTH_SIGNING_KEYS = "<배포할 값>"` 여덟 줄이었습니다. 값이 출력에
찍히지는 않지만 **명령 자체가 PSReadLine의 영구 이력 파일에 저장됩니다.** PSReadLine이
민감해 보이는 명령을 거르기는 하나 `apikey`·`secret`·`token` 같은 패턴을 찾으므로,
`MOBILE_AUTH_SIGNING_KEYS`라는 이름이 거기 걸리기를 기대하고 서명 키를 걸 이유가
없습니다.

→ `scripts/ops/Check-MobileAuthKeyring.ps1`을 두고 §2.1이 그것을 부르게 했습니다.
링 두 개는 `Read-Host -AsSecureString`으로 받아 메모리에서만 평문으로 바꿔
(`SecureStringToBSTR` → `PtrToStringBSTR` → `ZeroFreeBSTR`) 그 프로세스의 환경변수에
넣고, 화면에는 **길이만** 찍고, `finally`에서 여덟 변수를 전부 지웁니다 — 성공·실패·
Ctrl-C 어디서든. 비밀이 아닌 여섯(활성 id 둘 · 은퇴 목록 둘 · issuer · audience)은 평범한 인수로 남겼고,
그것들은 이미 Railway 대시보드에 보이며 명령줄에서 눈으로 확인하는 것이 오타를 잡는
방법입니다. 검토가 지목한 선례
`.github/audits/google-image-thinking-cap-eval-2026-08-13.md`와 같은 모양입니다.

**이 wrapper는 실행해 보지 못했습니다 — 이 컨테이너에 `pwsh`가 없습니다.** 그렇게
문서에도 적었습니다. 판정은 전부 `npm run check:mobile-auth-keyring` 쪽에 있고
`tests/mobileAuthKeyringCheck.test.mjs`가 subprocess 14건으로 고정합니다. wrapper가
더하는 것은 입력과 정리뿐이므로, 처음 쓸 때 프롬프트가 두 번 뜨는지와 끝난 뒤
`$env:MOBILE_AUTH_SIGNING_KEYS`가 비어 있는지를 눈으로 확인하라고 적었습니다.

**2. [운영] 회전에는 현재 링의 평문이 필요한데 sealed 값은 되돌려 주지 않습니다.**
§3의 1번은 `MOBILE_AUTH_SIGNING_KEYS`를 `이전id:이전키,새id:새키`로 씁니다. 값을
sealed로 두면 그 `이전키`를 어디서도 읽을 수 없습니다. **첫 설정에서는 드러나지
않고**(그때는 방금 만든 값이 손에 있습니다) **두 번째 회전부터 절차가 실행
불가능해집니다.**

→ runbook에 **§2.2**를 새로 두고 세 선택지 — (a) 전체 링을 담는 별도 secret store를
정본으로, (b) 이전 링 평문 없이는 정상 회전을 시작하지 않는다(없으면 그것은 §5 사고
대응이며 그 세대가 재로그인합니다), (c) 평문 대신 key id 목록과 digest를 기록해 배포
뒤 대조 — 를 대가와 함께 적고, **production 활성화 전에 하나를 계약으로 정한다**고
썼습니다. §3의 1번에서 §2.2를 먼저 읽으라고 가리킵니다.

**이것은 제가 정할 수 있는 것이 아닙니다.** 저장소가 답할 수 있는 사실이 아니라
비밀 보관 위치에 대한 운영 결정이므로, 아래 §10에 **활성화의 선결 조건**으로
남깁니다.

**3. [체크리스트] 상호 배타적인 체크박스 둘이 서문과 충돌했습니다.**
서문은 체크되지 않은 항목을 전부 릴리스 차단으로 읽으라고 하는데, 두 항목은 정의상
하나만 체크됩니다.
→ **한 항목으로 합치고** 그 아래에 서비스하는 배포 / 켜지 않은 배포의 명령을 하위
항목으로 갈랐습니다. 서비스하는 쪽 명령은 이제 새 PowerShell wrapper입니다.

---

### 5.7 7차 검토(2026-09-02)에서 지적돼 고친 것

검토자가 이번에 wrapper를 **직접 실행**했습니다 — 구문 오류 0, 정상 합성 키에서
`exit=0`·잔여 `MOBILE_AUTH_*` 0개, 잘못된 개인키에서 `exit=1`·잔여 0개, 두 번째
프롬프트에서 Ctrl-C 뒤 잔여 0개, 입력이 화면과 명령 이력에 남지 않음.
`mobileAuthKeyringCheck` 14 pass / 0 fail. **이것이 이 wrapper의 첫 실행 증거입니다**
(제가 아니라 검토자의 실행이며, 대상 SHA는 `6d054a2`입니다).

**1. [운영 차단] (c)는 독립 선택지가 될 수 없습니다.**
§2.2가 "셋 중 하나"라고 해 놓고 같은 칸에서 (c)를 "(a)·(b)의 보완이지 대체가 아니다"
라고 적었습니다. 두 문장이 서로를 부정하고, §6과 이 보고서가 그 모순을 그대로 옮겨
적었습니다.

→ 계약을 둘로 갈랐습니다(**2026-09-02에 (a)로 확정됐습니다 — §5.10**).
**필수 택일은 (a) 또는 (b)**이고, **(c)는 그 위에 얹는
선택**입니다. §6과 §10도 같이 고쳤습니다.

**그리고 (c)가 무엇을 관측할지도 적었습니다.** sealed 변수는 읽히지 않고 살아 있는
설정을 감사하는 검사기도 아직 없으므로, 지금 관측 가능한 것을 표로 확인했습니다.

| 대조하고 싶은 것 | 지금 가능한가 |
|---|---|
| 활성 **서명** 키 id | **가능** — 발급된 access token의 JWS 헤더 `kid` |
| 활성 **pepper** id | **가능** — `MobileRefreshRotation.pepperKid` (§5.8의 1번에서 정정) |
| 두 링의 나머지 항목 | **불가** — 링에 있을 뿐인 키를 알리는 것이 없습니다 |

즉 (c)를 지금 채택하면 대조 범위는 **두 활성 id**입니다. runbook §2.2에 그렇게 적고,
전면 대조로 적어 두고 두 필드만 보는 것이 가장 나쁜 결과라고 덧붙였습니다.

**2. [회귀망] wrapper의 보안 계약에 자동 테스트가 없었습니다.**
기존 14건은 내부 `.mjs` 검사기만 돌리고 wrapper는 지나갑니다.
→ `scripts/ops/Test-CheckMobileAuthKeyring.ps1`을 두었습니다. `Read-Host`와 `npm`을
함수로 가려 **wrapper를 진짜로 실행**하고(PowerShell은 application보다 function을 먼저
찾습니다) 네 계약을 고정합니다 — 두 링이 parameter에 없음, 종료 코드 전달,
성공·실패·중단 뒤 여덟 변수 제거, 비밀 미출력·길이만 출력. 중단은 두 번째 프롬프트를
던지게 해서 만들며 이는 Ctrl-C가 `finally`로 들어가는 것과 같은 경로입니다. 자격증명도
네트워크도 필요 없고 실제 `npm`을 부르지 않습니다.

**이번에는 실행했습니다 — 전부 통과**(rev.8에서 10 사례, rev.9에서 12). rev.7까지 "이 컨테이너에 `pwsh`가
없다"고 적었는데, 정확히는 **받아 보지 않은 것**이었습니다. PowerShell
7.4.6(linux-x64)을 내려받아 실행했고, 그 과정에서 테스트 자신의 버그 셋을 잡아
고쳤습니다 — `$script:` 상태가 *정의된* script가 아니라 *실행 중인* script를 가리켜
shim이 무력화된 것, 빈 배열이 반환에서 `$null`로 풀려 `.Count`가 strict mode에서 터진
것, 그리고 `Write-Host`가 information stream이라 `2>&1`만으로는 잡히지 않아
**비밀이 `Write-Host`로 새면 통과했을** 것(`6>&1` 추가로 해결).

**테스트가 실제로 무언가를 잡는지도 확인했습니다.** wrapper를 네 가지로 일부러
망가뜨렸고 전부 걸렸습니다.

| 고의 결함 | 걸린 사례 |
|---|---|
| `finally`의 정리 제거 | 3a · 3b · 3c |
| 길이 대신 비밀값 출력 | 4a · 4b |
| 무조건 `exit 0` | 2d |
| 링을 parameter로 추가 | 1 |

그 뒤 트리를 되돌렸고 전부 통과로 복귀했습니다. **rev.9에서 mutation은 아홉 건으로,
사례는 12개로 늘었습니다** — §5.8.

**그래도 릴리스 체크리스트에 release SHA에 묶인 실행 기록을 요구하는 항목을
넣었습니다.** 여기서 돈 것은 Linux의 PowerShell 7.4.6이고, 이 wrapper가 막으려는 것은
**운영자의 Windows PowerShell 습관**입니다. 두 script는 5.1에도 있는 기능만 쓰지만
거기서 돌려 본 증거는 아직 없습니다. **진짜 Ctrl-C도 키보드 이벤트라 자동화되지
않습니다** — 검토자가 `6d054a2`에서 그것을 했습니다.

**3. [문구] "나머지 넷"이 실제로는 여섯이었습니다.**
비밀 둘을 뺀 parameter는 활성 id 둘 · 은퇴 목록 둘 · issuer · audience로 여섯입니다.
runbook과 이 보고서를 고쳤습니다.

**별도로 전달받은 것:** 검증 중 PowerShell 자동완성에서 기존 `OPENAI_API_KEY` 직접
대입 이력이 노출됐다는 보고. **이 wrapper와 무관한 별건이고 저장소가 고칠 수 있는
것도 아니지만**, 지적대로 그 키는 노출된 것으로 보고 폐기·회전하고 PSReadLine 이력
파일에서 해당 줄을 지우는 편이 안전합니다 — 그리고 그것이 §5.6의 1번이 막으려던
바로 그 경로가 실제로 존재한다는 증거입니다.

---

### 5.8 8차 검토(2026-09-02)에서 지적돼 고친 것

**1. [높음] pepper 관측 가능성 표가 사실과 달랐습니다.**
rev.8은 "`MobileRefreshRotation`을 포함해 어떤 행도 digest를 계산한 pepper의 id를
남기지 않는다"고 적었습니다. **`pepperKid`가 rotation 행마다 저장됩니다** —
`prisma/schema.prisma`가 컬럼을 선언하고, `lib/mobileRefreshToken.ts`의
`mintMobileRefreshToken()`이 `pepper.keyId`로 채우고, `lib/mobileAuthService.ts`가
`mobileRefreshRotation.create`에 씁니다.

**어떻게 틀렸는지가 중요합니다.** schema를 `pepperKeyId|signingKeyId|KeyId`로 grep
했고, 실제 이름은 `pepperKid`라 하나도 걸리지 않았습니다. 그리고 **아무것도 안 나온
것을 없다는 근거로 삼았습니다.** 실패한 검색은 부재의 증거가 아닙니다 — 이 저장소가
`unknown_kid`·`kid`를 쓰는 곳에서 컬럼 이름도 `Kid`라는 것은 오히려 일관적입니다.

→ runbook §2.2와 위 §5.7의 표를 고쳤습니다. 관측 경로는 **두 활성 id**이고, pepper
쪽은 통제된 exchange 또는 refresh 직후 **그때 생긴 행**을 읽는 것입니다(오래된 행은
그때의 세대를 말할 뿐입니다).

**2. [회귀망] 비밀 유출 검사가 stream 셋을 놓쳤습니다.**
`2>&1 6>&1`은 error와 information만 모으고 warning·verbose·debug(3·4·5)는 지나갑니다.
검토자가 `Write-Warning $secret`을 주입하니 화면에는 값이 찍혔는데 4a는 통과했습니다.
→ `*>&1`로 전부 수집합니다. 세 stream 각각으로 유출을 주입해 4a가 세 번 다 실패하는
것을 확인했습니다.

**그리고 4b가 signing 길이만 봤습니다** — 계약은 "두 비밀의 길이"입니다. 4b·4c로
나눠 각각 고정하고, pepper 길이 줄을 지워 4c가 실패하는 것을 확인했습니다.

**3. [회귀망] 비밀 parameter 탐지가 이름 규칙에 기댔습니다.**
`SigningKeys$|Peppers$`는 `-SigningKeyRing`을 통과시킵니다. 계약이 "비밀처럼 보이는
이름이 없다"가 아니라 "이 일곱 개 말고는 없다"이므로 그렇게 고쳤습니다.
→ `[Parser]::ParseFile`로 AST의 `ParamBlock`을 읽어 **허용 목록과 정확히 대조**합니다
(common parameter가 섞이지 않아 `Get-Command`보다 정확합니다). 초과와 누락을 함께
보고하므로, 새 parameter를 추가하는 사람이 그것이 비밀인지 묻게 되는 자리가
생깁니다. `-SigningKeyRing`을 넣어 1b가 실패하는 것을 확인했습니다.

**이번 회차의 mutation 확인은 아홉 건이고 전부 걸렸습니다.**

| 고의 결함 | 걸린 사례 |
|---|---|
| `finally`의 정리 제거 | 3a · 3b · 3c |
| 길이 대신 비밀값 출력 | 4a · 4b |
| 무조건 `exit 0` | 2d |
| 링을 parameter로 추가 | 1b |
| `Write-Warning` / `Write-Verbose` / `Write-Debug`로 유출 | 4a (세 번) |
| `-SigningKeyRing` — 비밀처럼 안 보이는 이름 | 1b |
| pepper 길이 줄 삭제 | 4c |

---

### 5.9 9차 검토(2026-09-02)에서 지적돼 고친 것

**[중간] smoke test가 `-AsSecureString` 제거를 잡지 못했습니다.**
shim이 `$AsSecureString`을 parameter로 받기만 하고 쓰지 않아서, 검토자가 wrapper에서
그 플래그를 지웠는데 **12/12가 그대로 통과**했습니다. 운영에서 그 결함의 결과는
"입력한 링이 화면에 그대로 보이는 것"이고, 나머지 열두 사례는 전부 그것을 지나갑니다 —
비밀은 여전히 parameter가 아니고, 출력에 안 나오고, 뒤에 지워지므로.

→ shim이 **호출마다 `$AsSecureString.IsPresent`를 기록**하고, 새 사례 2e가 두 번 다
`true`인지 봅니다. 사례는 13개가 됐습니다.

두 가지로 망가뜨려 확인했습니다.

| 고의 결함 | 결과 |
|---|---|
| `-AsSecureString` 제거 | 2e가 `False, False`로 실패. **다른 열두 사례는 통과합니다** |
| 두 프롬프트 중 pepper 쪽만 제거 | 2e가 `True, False`로 실패 |

두 번째가 요점입니다. **"둘 다"가 계약이므로 하나만 남은 상태를 통과시키면 안
됩니다.**

> **rev.11 정정.** 첫 줄에 "4b·4c도 함께 실패"라고 적었고 **재현되지 않습니다.**
> 제가 그때 쓴 mutation은 플래그만 뺀 것이 아니라 `Read-Host`의 반환을
> `ConvertTo-SecureString -AsPlainText`에 다시 넣는 모양이었고, shim이 플래그와 무관하게
> `SecureString`을 돌려주므로 그 변환이 값을 망가뜨려 길이가 어긋난 것입니다. **결함이
> 아니라 제 mutation의 부수효과였습니다.** 플래그만 제거하면 2e 하나만 실패하며, 그것이
> 오히려 이 사례가 필요한 이유입니다 — 나머지 열두 개는 이 결함을 전부 지나갑니다.

**검토자가 Windows에서 실행한 결과도 받았습니다.** `b10922c`에서 PowerShell Core
7.6.4로 12/12(그 시점의 사례 수), `1093f96`에서 **PowerShell Core 7.6.4와 Windows
PowerShell 5.1.19041.6456 양쪽으로 13/13**, 그리고 플래그 제거 역방향 검사에서 2e 실패
및 전체 exit 1. **운영자 셸 두 판본 모두에서 돌아간다는 개발 증거가 이것으로
확보됐습니다.** 릴리스 체크리스트가 요구하는 것은 그것과 별개로 **최종 release SHA에
묶인 기록**입니다.

---

### 5.10 §2.2 결정 — (a), 2026-09-02 승인

**승인:** `mposition`, 2026-09-02, **`f53396f` 검토 후**. 여덟 회차를 미결정으로 들고
있던 항목이고, 제가 고를 수 있는 것이 아니었습니다(비밀을 어디에 두느냐). **결정란
셋과 추가 계약 다섯은 같은 날 후속 검토에서 확정**됐고, 같은 검토가 아래 결함 둘을
지적했습니다.

계약 일곱 줄은 `docs/ops/mobile-auth-key-rotation.md` §2.2에 있습니다. 요지는 **정본은
secret store 하나, Railway sealed 변수는 그 사본, 방향은 한쪽**이라는 것입니다. 문서에
반영한 곳은 넷입니다.

| 어디 | 무엇이 바뀌었나 |
|---|---|
| §2.2 | "미결정"이 계약이 됐습니다. (c)는 **선택에서 필수**로 올라갔습니다(계약 4번) |
| §3 | 0번(Active에서 읽기) · 2번(Pending 작성, target SHA와 함께) · 4번(**Active**와 Railway 일치 확인, 어긋나면 배포 중단) · 6번(배포 후 두 활성 id 대조) · 7번(**통과 시에만 승격**, 실패 시 롤백·폐기). §3.1 정리도 같은 수명을 따릅니다 |
| §5 | 들어오는 길이 둘이 됐고 **절차가 서로 다릅니다** — 키 유출은 아래 절차, **store 평문 상실은 §5.1 전면 교체**. 사고 대응에서도 순서는 store가 먼저입니다 |
| §5.1 (신설) | 전면 교체. 회전이 아니므로 유예도 승계도 없고 살아 있는 자격증명이 전부 무효가 됩니다 |
| 릴리스 체크리스트 | **Active** 일치 확인과, 배포 후 두 id 대조 **→ 승격**이 항목이 됐습니다 |

**store를 먼저 갱신하는 순서에는 이유가 있습니다.** 정본이 사본보다 뒤에 있으면, 그
사이에 배포가 끝났을 때 **정본이 배포된 값을 모릅니다** — 정본이라는 말이 그 순간
거짓이 됩니다.

#### 그 순서가 만든 결함 둘 — 같은 날 검토에서 지적돼 고쳤습니다

**1. [높음] 정상 회전이 스스로 드리프트로 판정됐습니다.**
store를 먼저 갱신하는데 드리프트를 "store ≠ Railway"로 판정하면, **배포 직전의 정상
상태가 바로 그 조건**입니다 — Railway에 아직 이전 링이 있는 것이 맞는 상태인데 절차와
체크리스트가 그것을 오류로 보고 배포를 중단시킵니다. 순서는 맞았고 판정 대상이
틀렸습니다.

→ store 항목을 둘로 나눴습니다.

| 항목 | 무엇인가 |
|---|---|
| `Mobile Auth Keyrings — Active` | **지금 배포돼 있는** 값의 정본. **드리프트 판정은 이것하고만** 합니다 |
| `Mobile Auth Keyrings — Pending` | 다음 배포 후보와 **target SHA**. 배포 전에 Railway와 다른 것이 정상입니다 |

수명은 Pending 작성 → §2.1 검사(Pending 값) → **Active와 Railway 일치 확인** → 단일
staged 배포 → 두 활성 id 대조 → **통과 시에만 Pending을 Active로 승격**, 실패 시 Active로
롤백하고 Pending 폐기입니다. **승격이 검증 뒤에 있으므로 실패한 배포가 정본을 오염시키지
않습니다.** target SHA를 함께 적는 이유는, 없으면 남아 있는 Pending이 "이번 것"인지
"지난번에 실패하고 남은 것"인지 구분되지 않기 때문입니다.

**2. [높음] store 평문 상실 절차가 기존 링을 요구했습니다.**
§5는 "이전 링을 재현할 수 없다"고 해 놓고 아래에서 **기존 링에 새 키를 추가**하라고
안내했습니다. 링을 편집하려면 그 링을 읽을 수 있어야 하는데 그것이 바로 없는
것입니다 — 실행할 수 없는 경로였습니다.

→ **§5.1 전면 교체**를 별개 절차로 분리했습니다. 두 링을 각각 새 항목 하나만 담도록
교체, 두 active id 교체, **은퇴 목록 둘 비우기**(은퇴시킬 이전 세대가 없습니다), 기존
모바일 자격증명 전체 무효화와 재로그인 수용. Pending은 여기서 쓰지 않습니다 — 승격할
Active가 이미 신뢰를 잃었고, 이 절차의 결과물 자체가 새 Active입니다.

**그리고 "Railway 값을 store로 옮긴다"를 지웠습니다.** 계약 2번이 금지한 역수입으로
읽히고, 급할 때 정확히 그렇게 하기 쉽습니다. 지금은 **로컬에서 한 번 만든 값을 store에
먼저 저장하고 같은 값을 Railway에 배포**한다고 적혀 있습니다.

#### 결정란 — 확정

| 결정란 | 확정값 |
|---|---|
| secret store 제품명 | **1Password Individual** |
| vault 이름 | **Tomverse Production Secrets** |
| 복구 권한 | `mposition` 단독. Recovery Code와 계정 이메일을 통한 본인 복구. Recovery Code·Emergency Kit는 **주 기기와 분리된 물리적 보관 장소**에 |

추가 계약 다섯도 §2.2에 들어갔습니다 — runtime·CI·Railway에 읽기 권한 없음, 복구
자료를 Git·Railway·같은 vault에 두지 않음, 계정 이메일에 MFA와 별도 복구 수단, 운영자
추가 시 Teams 전환, 실제 명령은 **secret reference 주입**으로 작성.

**1Password의 동작(Recovery Code 기반 본인 복구, vault 분리, CLI의 실행 시점 주입)은
제품 선택과 함께 운영자가 확인한 사실이며 제가 검증한 것이 아닙니다.** 문서에도 그렇게
적었고, 실제 명령을 쓸 때 그 자리에서 확인합니다.

**이 승인이 허가하지 않는 것**(승인 문언 그대로): N1b 개방, production 활성화, 실제
자격증명 생성·배포.

---

### 5.11 12차 검토(2026-09-03)에서 지적돼 고친 것

다섯 건이고, 둘은 **코드가 필요했습니다** — 문서만 고쳐서는 닫히지 않는 것이었습니다.

**1. [높음] `Active = Railway`가 증명되지 않았습니다.**
§2.2는 전체 일치를 요구하는데 sealed 변수는 읽히지 않고, 절차가 대조하던 것은
`kid`·`pepperKid` **id 둘뿐**이었습니다. **같은 id 아래 다른 유효한 개인키나 pepper가
들어가도 전부 통과**하고, 그 값이 Active로 승격된 뒤 롤백이나 다음 회전에서 토큰이
끊깁니다.

→ `npm run verify:mobile-auth-deployment`(+`tests/mobileAuthDeploymentVerify.test.mjs`,
7건)를 만들었습니다. **id가 아니라 재료를 봅니다.**

| 무엇 | 어떻게 |
|---|---|
| 활성 서명 키 재료 | token의 서명을 **후보 개인키에서 유도한 공개키**로 검증. Ed25519 공개키는 개인키가 결정하므로 검증되면 같은 키입니다 |
| 활성 pepper 재료 | `HMAC-SHA256(후보 pepper, secret)`을 그 exchange가 만든 행의 `secretDigest`와 대조 — **런타임 자신의 `mobileRefreshSecretMatches`**로, 판정이 갈라지지 않게 |
| `iss` · `aud` | claim에서 읽어 후보와 비교 |

증거는 통제된 exchange 한 번에서 전부 나옵니다(access token · refresh token ·
`secretDigest` · `pepperKid`). 전부 환경변수로 받고, 출력에 비밀이 없습니다.
**테스트의 핵심 사례는 "같은 kid, 다른 키"** — id 검사는 `OK`, 재료 검사는 `FAIL`입니다.

**은퇴 항목은 행동으로 확인합니다.** 유예 안에서는 실제로 쓰이므로, **배포 전에** 받아
둔 access token이 배포 후에도 받아들여지는지, refresh token이 회전에 성공하는지를 봅니다.
**롤백이 의존하는 것이 정확히 그 둘**입니다. §3에 4.5번(미리 받아 두기)과 7번(확인)으로
들어갔습니다.

유예가 지난 잔여 항목은 여전히 증명되지 않지만 **런타임에서 아무것도 검증하지
않으므로** 문제가 아니며, 다음 회전의 편집 기준은 Railway가 아니라 store입니다.

**2. [높음] §5.1이 다시 Active의 뜻을 깼고 실패 경로가 없었습니다.**
5번이 **배포 전에** 새 값을 Active로 썼습니다. `Active`는 "지금 배포돼 있는 값"이므로,
배포가 실패하면 store는 새 값을 가리키고 런타임은 이전 값을 돌립니다. **이전 Active를
믿을 수 없다는 사실이 새 후보가 곧 Active라는 뜻은 아닙니다.**

→ 기존 Active를 `untrusted/unavailable`로 표시하고, 새 값은 `Emergency Pending`으로
저장하고, 배포와 **이전 자격증명 거절 확인**까지 통과한 뒤에 승격합니다. 그리고 실패
경로를 적었습니다 — **되돌릴 곳이 없으므로** 모바일 인증 비활성화(필수 변수를 걷어
503으로) 또는 새 후보로 roll-forward 둘뿐입니다.

**3. [중간] target SHA만으로 Pending을 식별할 수 없습니다.**
비밀값 변경은 코드 변경 없이 staged 배포를 만들므로 서로 다른 회전과 재시도가 같은 SHA를
가질 수 있습니다.
→ Pending이 다섯을 답니다 — `rotationId` · `createdAt` · candidate fingerprint ·
target SHA · **Railway deployment ID**(배포 생성 후). 뒤의 둘이 없으면 "이 Pending이
실린 배포"를 지목할 수 없고, 그러면 롤백 대상도 지목할 수 없습니다.

**4. [중간] 1Password 연동은 wrapper 변경까지 필요했습니다.**
`op run`은 자식 프로세스 환경변수로 주입하는데, wrapper는 그 두 변수를 **`Read-Host`
결과로 덮어썼습니다.** §6에 "명령 문구만 정하면 된다"고 적은 것은 틀렸습니다.
→ `-UsePreinjectedRings`를 넣었습니다. 프롬프트하지 않고 주입된 값을 그대로 쓰며,
주입이 없으면 **검사를 돌리지 않고** 이유를 말하며 실패합니다(빈 링으로 돌면 "일부만
설정됨"이라는 엉뚱한 이유가 나옵니다). smoke test에 5a–5f가 붙어 **13 → 19 사례**가
됐고, 그중 5b가 이 결함의 회귀 시험입니다 — 주입된 링이 덮어써지지 않고 검사기까지
가는지.

만들면서 두 결함을 잡았습니다: `Where-Object`가 아무것도 안 맞으면 `$null`이라
`$missing.Count`가 strict mode에서 터진 것, 그리고 미주입 경로가 `$null.Length`로
터진 것. 후자는 **테스트가 "실패했다"는 사실만으로 통과할 뻔했고**(exit 1이 맞긴
했습니다), 5d에 "검사기를 부르지 않았는가"와 메시지 검사를 함께 넣어 잡았습니다.

**5. [낮음] §6이 "셋"이라면서 넷을 나열했습니다.** 넷으로 고쳤습니다.

---

### 5.12 13차 검토(2026-09-03)에서 지적돼 고친 것

다섯 건이고, **넷은 제가 방금 만든 것의 결함**입니다.

**1. [높음] 만료된 과거 증거가 `PASS`였습니다.**
재료 대조는 **나이를 보지 못합니다** — 일주일 전 token도 같은 키에 대해 똑같이
검증됩니다. 그래서 지난 회전에서 남겨 둔 증거가 전부 통과했고, 증명되는 것은 "그때
맞았다"뿐이었습니다.
→ `iat`가 15분(기본, `MOBILE_AUTH_VERIFY_MAX_AGE_SECONDS`) 안이고 `exp`가 지나지
않았는지 봅니다. 테스트 둘: 8일 된 증거(**나머지는 전부 `OK`인 채** 신선도만 실패),
그리고 2분 전 발급됐지만 만료된 token.

**2. [높음] retirement 시각이 2099년이어도 `PASS`였습니다 — 세 층 다 고쳤습니다.**
`sign-1@2099-01-01…`은 문법상 멀쩡하고 "RETIRED, verifies until 2099"로 보고되며
**70년치 신뢰**입니다. 승인된 15분이 아무것도 가리키지 않게 됩니다.

이건 verifier만의 문제가 아니라 **런타임 규칙의 구멍**이었습니다 — 오타 난 은퇴 id와
같은 종류이고, `usableEntry`가 세 번째로 답해야 할 질문이었습니다.

| 층 | 무엇을 했나 |
|---|---|
| 런타임 (`lib/mobileAuthKeyring.ts`) | **도착하지 않은 은퇴 시각은 은퇴가 아닙니다** — 그 키는 아무것도 검증하지 않습니다. 운영자 시계가 앞설 수 있으므로 5분 허용(`MOBILE_RETIREMENT_FUTURE_SKEW_SECONDS`) |
| 배포 전 검사 | `RETIREMENT IN THE FUTURE`로 보고하고 **실패**합니다 |
| 배포 후 verifier | 후보 링의 은퇴 선언을 같은 규칙으로 다시 봅니다 — 승격 직전의 마지막 관문이므로 |

테스트: 런타임 4건(양쪽 링, skew 허용, 목록 함수), 검사기 1건(양쪽 링), verifier 1건.

**3. [높음] 실패 안내가 emergency에서도 "Active로 롤백"이었습니다.**
§5.1은 **이전 링을 믿을 수 없어서** 오는 곳입니다. 거기서 "이전으로 되돌리기"는 이
절차가 버린 링을 복구하라는 말이고, 유출이었다면 **유출된 링**입니다.
→ `MOBILE_AUTH_VERIFY_MODE`(`rotation` 기본 / `emergency`)가 안내를 가릅니다.
emergency에서는 롤백을 지시하지 않고 **모바일 인증 비활성화 또는 roll-forward**를
말합니다. 모르는 모드는 **실패**합니다 — 기본값으로 흘러가면 그것이 바로 이 결함입니다.

**4. [높음] 이전 refresh의 성공은 롤백 호환성이 아닙니다.**
rev.14가 "롤백이 의존하는 것이 정확히 이 둘"이라고 적었고 **틀렸습니다.** 그 확인이
증명하는 것은 **새 배포가 이전 세대를 받아 준다**는 **정방향** 호환성이고, 배포 순간
아무도 로그아웃되지 않는 이유입니다. **롤백은 반대 방향이고 그렇게 될 수 없습니다** —
되돌린 배포에는 새 키·새 pepper가 없으므로 **배포 이후 발급된 자격증명은 전부
거절됩니다.** 롤백의 값은 그 세션들이고, 이 확인으로 줄어들지 않습니다. runbook §2.2와
릴리스 체크리스트를 고쳤습니다.

**5. [높음] verifier에 token을 안전하게 넣는 wrapper가 없었습니다.**
verify가 다루는 값은 링 둘 + **live credential 둘**이고, refresh token은 family를
회전시키는 bearer secret입니다. 그것을 인수로 주면 명령줄에 남습니다.
→ `scripts/ops/Invoke-MobileAuthDeploymentVerify.ps1`. 넷 다 `Read-Host
-AsSecureString`, `-Mode`·`-UsePreinjectedRings` 지원(주입 모드에서도 **token 둘은
물어봅니다** — store가 아니라 방금 만든 exchange에서 오는 값입니다), `finally`에서 **열세
개** 변수 제거, 길이만 출력, 그리고 **exchange를 폐기하라는 안내**(script가 대신 할 수
없습니다). smoke test 17건 + mutation 4건 확인:

| 고의 결함 | 걸린 사례 |
|---|---|
| refresh token을 parameter로 | 1b |
| `Write-Warning`으로 token 유출 | 5a |
| `-Mode` 전달 누락 | 4a |
| 정리 목록에서 refresh token 누락 | 3a · 3b · 6b |

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

> **rev.7 회차.** 이 회차가 바꾼 것은 문서 셋과 새 PowerShell wrapper 하나뿐이고
> TypeScript·`.mjs`는 건드리지 않았습니다. 다시 돌린 것은 `check:doc-references`
> (711 경로, 전부 존재) · `check:policy-section-references`(3,991 인용, 없는 절 없음) ·
> `check:encoding:strict`(통과)입니다. **wrapper 자체는 실행하지 못했습니다** —
> 이 컨테이너에 `pwsh`가 없습니다(§5.6의 1번). 그 공백은 검토자가
> `6d054a2`에서 직접 실행해 메웠습니다(§5.7 머리말).
>
> **rev.15 (2026-09-03).** 13차 검토의 다섯 건은 §5.12입니다. **넷은 rev.14에서 제가
> 만든 것의 결함**이고, 그중 하나(미래 시각 은퇴)는 verifier가 아니라 **런타임 규칙의
> 구멍**이었습니다.
>
> **rev.14 (2026-09-03).** 12차 검토의 다섯 건은 §5.11입니다. 둘은 코드가 필요했고
> (`verify:mobile-auth-deployment` 신설, wrapper의 `-UsePreinjectedRings`), 그중
> 하나는 **id 대조가 계약이 요구하는 것을 증명하지 못한다**는 지적이었습니다.
>
> **rev.13 (2026-09-02).** §2.2가 **(a)로 확정**됐고(`mposition`, `f53396f` 검토 후),
> 같은 날 후속 검토에서 **결정란 셋(1Password Individual · `Tomverse Production
> Secrets` · `mposition` 단독 복구)과 추가 계약 다섯**이 확정됐습니다. 같은 검토가
> 제 초안의 결함 둘을 잡았습니다 — 정상 회전이 스스로 드리프트가 되던 것, 그리고
> store 평문 상실 절차가 없는 링을 요구하던 것. 전부 §5.10입니다.
>
> **rev.12 (2026-09-02).** 11차 검토의 두 건은 문구입니다 — §9의 환경변수 개수(필수
> 6 + 선택 2)와, §10에 남아 있던 (c)의 관측 범위(하나가 아니라 둘).
>
> **rev.11 (2026-09-02).** 10차 검토의 한 건은 §5.9 안의 정정 상자입니다 —
> mutation 결과 표의 "4b·4c도 함께 실패"가 재현되지 않았습니다. 같은 검토에서 Windows
> PowerShell 5.1 실행 증거를 받아 함께 기록했습니다.
>
> **rev.10 (2026-09-02).** 9차 검토의 한 건은 §5.9입니다 — smoke test가
> `-AsSecureString` 제거를 잡지 못했습니다. wrapper는 정상이었고 테스트가 그 계약을
> 고정하지 못한 것입니다.
>
> **rev.9 (2026-09-02).** 8차 검토의 세 건은 §5.8입니다. 그중 하나는 **제가 없다고
> 단언한 것이 있었던 경우**입니다 — `MobileRefreshRotation.pepperKid`.
>
> **rev.15 회차.** 이번에는 **런타임(`lib/mobileAuthKeyring.ts`)이 바뀌었으므로**
> lane을 넓게 돌렸습니다 — `test:unit` **7,646 pass / 0 fail**,
> `test:server-contract` **511 pass / 0 fail**, `lint app components lib tests scripts`,
> `typecheck`, smoke test **19/19**와 **17/17**, `check:mobile-auth-keyring`·
> `check:enum-constraints`·`check:data-domain-registry`·`check:doc-references`·
> `check:policy-section-references`·`check:encoding:strict` 통과. **DB integration과
> build는 다시 돌리지 않았습니다** — schema도 route도 바뀌지 않았습니다.
>
> **rev.14 회차.** 코드가 들어갔으므로 lane을 다시 돌렸습니다 —
> `npm run test:unit` **7,632 pass / 0 fail**(1 skipped, 기존; 새 verifier 테스트 7건
> 포함), `lint scripts tests` 통과, `typecheck` 통과, smoke test **19/19**,
> `check:doc-references`·`check:policy-section-references`·`check:encoding:strict`·
> `check:mobile-auth-keyring` 통과. **server-contract·DB·build는 다시 돌리지
> 않았습니다** — 이번 변경은 `scripts/`와 `tests/`, 문서뿐이고 `lib/`·`app/`·schema를
>건드리지 않았습니다.
>
> **rev.8 회차.** 바꾼 것은 문서 셋과 새 PowerShell smoke test 하나입니다. 같은 세
> 게이트를 다시 돌렸고 `tests/mobileAuthKeyringCheck.test.mjs`도 다시 돌렸습니다
> (14 pass / 0 fail). **새 smoke test도 돌렸습니다 — 10/10**, rev.9에서 12/12
> (PowerShell 7.4.6을
> 컨테이너에 받아서). 남은 공백은 **Windows PowerShell에서의 실행**과 **진짜
> Ctrl-C**이고, 그것은 §10과 릴리스 체크리스트가 들고 있습니다.

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

**여덟 개**이고, 지금까지 어느 문서도 적지 않았습니다.

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

**여덟 중 필수는 여섯이고 은퇴 목록 둘이 선택**입니다 —
`scripts/check-mobile-auth-keyring.mjs`의 `REQUIRED`·`OPTIONAL`이 그 계약이고, 검사기의
"일부만 설정됨" 판정도 그 여섯을 셉니다. 필수 중 하나라도 없거나 **활성 서명 키가
실제로 서명하지 못하면** `mobileAuthReady()`가 false이고 모든 모바일 endpoint가
**503**을 답합니다. 형식 검사만으로는 부족하다는 것이 검토 지적 2번이었습니다. 어느
변수가 없는지는 말하지 않습니다 — 인증되지 않은 요청자가 들을 이유가 없는 배포
사실입니다.

> **rev.12 정정.** 이 절은 표에 여덟 줄을 늘어놓고 "여섯 개", "여섯 중 필수는 넷"이라고
> 적었습니다. 둘 다 틀렸고 서로도 맞지 않았습니다. 정확한 계약은 **필수 6 + 선택 2**
> 입니다.

**`/api/ready`는 이 여덟을 검사하지 않습니다.** 의도된 것입니다: 모바일 인증이 아직
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
| **1Password 명령의 실제 문구** | **활성화 전에 채웁니다.** §2.2가 제품·vault·복구 권한을 확정했고 §3·§5.1이 "store에서 읽는다 / store에 먼저 저장한다"를 절차에 넣었지만, 그 문장을 실행하는 CLI 명령은 아직 없습니다. 추가 계약 5번이 **secret reference 주입**을 요구하므로 명령을 쓸 때 그 동작을 그 자리에서 확인합니다 |
| **Active·Pending 항목의 최초 생성** | 첫 설정에서 만들어지며, 그것이 §3의 0번이 읽을 대상입니다 |
| **wrapper smoke test를 Windows PowerShell에서** | `scripts/ops/Test-CheckMobileAuthKeyring.ps1`은 여기서 13/13(Linux, PowerShell 7.4.6), `1093f96`에서 검토자의 Windows PowerShell Core 7.6.4와 Windows PowerShell 5.1.19041.6456 양쪽으로 13/13 통과했습니다. **전부 개발 중 증거**이고, 체크리스트가 요구하는 것은 **최종 release SHA에 묶인 기록**입니다 |
| **검사기를 배포 이미지에서 실행 가능하게** | 순수 판정 부분을 의존성 없는 `.mjs`로. 그래야 `railway ssh`로 들어가 **살아 있는** 설정을 감사할 수 있습니다. 지금은 배포할 값을 손으로 넣는 사전 검증만 됩니다 |
| **은퇴 키 자동 제거·상시 보고** | 유예가 지난 항목과 선언되지 않은 키를 코드가 쓰지 않을 뿐, 배포 전 확인을 **돌리게 하는 것은 문서뿐**입니다. 상시 점검은 production 활성화와 함께 정합니다 |
| **`MOBILE_AUTH_PRE_AUTH_RATE_LIMIT`(분 60 / 일 2,000) 승인** | 승인된 18개 밖의 새 값입니다. 재검토에서 "미승인 값으로 명확히 기록됨 — production 승인 전 사람의 결정 필요"로 확인됐습니다 |
