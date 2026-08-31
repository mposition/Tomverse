# N2 — 모바일 bearer 인증 설계 승인 패킷

- 대상: `mposition/Tomverse` `develop`
- **기준 HEAD (rev.3): `af06a99`** — rev.2는 `49c2624`/`ffca693`, rev.1은 `1ee7793`/`7a1dd05`
- 산출물: 이 문서 하나. **코드·Prisma schema·migration·API route·테스트·feature
  flag·production 설정을 만들거나 바꾸지 않았습니다.**
- 정책 문서 `docs/policy/tomverse-chat-mobile-authentication.md`의 Status는
  `draft for Phase 0 approval` **그대로입니다.** release-gate registry의
  `status`·`evidenceRefs`도 건드리지 않았습니다.
- 선행 문서: `.github/audits/2026-08-30-native-mobile-readiness.md` §3.1·§6.1·§6.2

> **이 패킷이 하는 일.** 승인 가능한 보안 설계를 제시하고, **사람이 결정해야 하는
> 항목을 결정으로 남겨 두는 것**입니다. TTL·grace window 같은 숫자는 권장값과
> 대안을 제시하되 확정하지 않았습니다. §8의 승인란은 비워 두었습니다.

## 개정 이력

**rev.3 (2026-08-31, HEAD `af06a99`)** — 검토에서 여섯 가지가 지적됐고 **전부
맞았습니다.** 그중 하나는 rev.2가 **권장안으로 올린 설계 자체가 깨진 것**입니다.

| # | rev.2 | 무엇이 문제였나 | 고친 곳 |
|---|---|---|---|
| 1 | **B-2를 권장** | 반례가 성립합니다. 지연된 최초 요청이 재시도 뒤에 도착하면 서버는 앱이 이미 저장한 후속을 폐기하고 새 후속을 발급하는데, **그 응답을 앱은 받지 못합니다.** 앱에는 R1, 서버에는 R2 — 잠김. native single-flight도 이미 서버로 떠난 요청은 취소하지 못합니다 | **§4.3 — B-2를 보류로 강등** |
| 2 | `EXPECTED_AUDIENCE not in c.aud` | `aud`를 문자열로 제한해 놓고 포함 검사를 씁니다. 부분 문자열로 구현되면 `mobile-api`가 `mobile-api-other`를 통과시킵니다 | **§5.2 — 정확 일치로 명시** |
| 3 | V24의 사전 상태가 **미소비** RT | D5가 막으려는 분기(소비·폐기된 레코드 + 틀린 secret)를 지나지 않습니다. 계약은 맞고 **벡터가 계약을 따라가지 못했습니다** | **V24b·V24c 추가** |
| 4 | "15초 TTL이므로 상한 15초" | `lib/sessionSecurity.ts`는 `expiresAt`를 **조회가 끝난 시점** 기준으로 씁니다. 취소 전에 시작한 조회가 취소 후 도착하면 낡은 값이 다시 15초를 삽니다. 조회 실패가 아니므로 fail-closed로 해결되지 않습니다 | **D12 — 기준 시점·경합·테스트 요구 추가** |
| 5 | "불투명 토큰이면 문서 요청까지 DB 왕복" | **자기 D18과 모순입니다.** 미등재 경로와 `Authorization` 없는 요청은 검증 전에 빠지므로 비교 대상은 **등재된 bearer 요청**뿐입니다 | **D1 — 근거 범위 축소** |
| 6 | "키를 분리하지 않으면 HS256이 정직" | 격리 이점을 주장하지 않으면 될 뿐, Ed25519가 부적절해지지는 않습니다 | **D1 — 문구 정정** |

**rev.2 (2026-08-31, HEAD `49c2624`)** — 검토에서 다섯 가지가 지적됐고 **전부
맞았습니다.** 넷은 이 문서가 스스로 어긋난 것이고, 하나는 사실이 틀린 것입니다.

| # | rev.1 | 무엇이 문제였나 | 고친 곳 |
|---|---|---|---|
| 1 | N1b를 `/api/*` 전체에 적용 | **기존 인증을 깹니다.** `/api/internal/**`의 **7개 route**가 이미 `Authorization: Bearer <운영 비밀값>`을 씁니다. 모바일 검증기에 넣으면 정상 유지보수가 401. 반대로 **190개 route 중 156개가 여전히 cookie 신원**을 읽으므로, 앞은 bearer·뒤는 cookie인 경로가 생깁니다 | **D18 신설** — opt-in route allowlist |
| 2 | D7·D8에 secret 비교 위치 없음 | 레코드가 존재하고 소비됐다는 이유만으로 family를 폐기할 수 있게 읽힙니다. `lib/emailLogin.ts`는 **비교를 소비보다 먼저** 합니다 | **D5·D7·D8에 3-갈래 순서 명시**, V24·V25 추가 |
| 3 | "proxy는 Edge라 DB 조회 불가" | **사실이 틀렸습니다.** Next 16.3.3 자체 문서: *"Proxy defaults to using the Node.js runtime."* D1이 불투명 토큰을 배제한 근거가 성립하지 않습니다 | **D1·D12 논거 교체** |
| 4 | refresh가 JS를 통과하지 않는다고 서술 | D14는 refresh를 **HTTP 응답**으로 돌려줍니다. WebView의 `fetch`가 받으면 이미 JS를 지난 것입니다 | **D19 신설** — native 계층 경계 |
| 5 | 문서 내부 불일치 5건 | `typ` 위치·값 불일치, `iat`·`jti` 검증 누락, D12의 "상한 둘", D13의 cookie 검증 범위 미정, truth table 1행이 현행 검사를 잘못 서술 | **§5.2·§5.3·D12·D13 정정** |

함께 고친 것 셋:

- **B안의 동일 응답 재전달**은 digest만 저장하면 **원문을 복원할 수 없습니다.**
  재전달 방식 자체를 설계해야 하며, §4.3에 두 가지 기전과 비용을 넣었습니다.
- **`lib/oauthLink.ts`는 로그인 흐름이 아닙니다** — 이미 로그인한 계정에 provider를
  연결하는 흐름이고 `assertRecentAdminAuthentication`을 요구합니다. PKCE 구성은
  참고하되 최초 로그인 `grant`의 발급·일회성 소비·client 결속을 대신하지 못합니다.
- **앱 삭제 시 Keychain 항목이 사라진다는 보장을 삭제했습니다.** Apple이 계약으로
  보장하지 않으므로 D17이 그것에 기대지 않습니다.

**rev.1 (2026-08-31, HEAD `1ee7793`)** — 최초 작성.

---

## 1. 현재 상태와 상속받는 결정

이 설계가 **선택하지 않고 물려받는** 것들입니다. 근거 문서가 이미 정한 것이므로
이 패킷의 승인 대상이 아니며, 뒤집으려면 그 문서를 먼저 고쳐야 합니다.

| # | 상속된 결정 | 근거 |
|---|---|---|
| 1 | Web은 secure cookie session을 그대로 유지 | docs/policy/tomverse-chat-mobile-authentication.md, "Decision" |
| 2 | Native는 **별도의 bearer transport** | 같은 문서, "Decision" |
| 3 | access token은 짧게, **메모리에만** | 같은 문서, "Token lifecycle" |
| 4 | refresh token은 **회전**하고 Keychain/Keystore에만 저장 | 같은 문서, "Token lifecycle" |
| 5 | retired refresh token 재사용은 **token family 문제** | 같은 문서, "Token lifecycle" |
| 6 | device family는 **개별 조회·해제** 가능 | 같은 문서, "Token lifecycle" |
| 7 | password 없음, remote `server.url` 없음, `localStorage` token 없음, 앱 내 shared secret 없음 | 같은 문서, "Deliberately excluded" |
| 8 | `AUTH-03`은 회전·재사용 탐지·로그아웃·기기 해제를 **함께** 채점 | docs/release-gates/tomverse-chat-v1.yaml |
| 9 | N1a는 완료. **Native mutation은 여전히 CSRF 검사에서 403** | .github/audits/2026-08-30-native-mobile-readiness.md §6.2 |
| 10 | N1b는 `Authorization` 헤더 **존재 여부로 절대 열 수 없음** | 같은 문서 §3.1 |

### 1.1 이 저장소가 지금 실제로 하고 있는 것 — 측정값

설계가 무엇을 깨뜨릴 수 있는지는 세어 봐야 압니다. `49c2624` 기준입니다.

| 사실 | 수 | 왜 중요한가 |
|---|---|---|
| `app/api/**/route.ts` 총수 | **190** | N1b의 잠재 적용 범위 |
| `getServerSession`으로 **cookie 신원**을 읽는 route | **156** | 전역 N1b가 만들 "앞은 bearer, 뒤는 cookie" 경로의 상한 |
| `Authorization: Bearer <운영 비밀값>`을 쓰는 `/api/internal/**` route | **7** | 모바일 검증기에 넣으면 **전부 401** |
| `EXEMPT_MUTATION_PATHS`가 이미 면제하는 접두사 | `/api/internal/` 포함 6개 | 내부 route는 mutation-origin 검사를 이미 건너뜀 |

`/api/internal/**`의 7개는 `cleanup`, `notification-deliveries`, `credit-reservations`,
`scheduled-jobs/auto-fix/pending`, `scheduled-jobs/auto-fix/result`,
`provider-model-catalog/check`, `provider-probe/check`입니다. 전부
`createHash`+`timingSafeEqual`로 자기 비밀값을 직접 비교하며, JWT가 아닙니다.

### 1.2 이미 저장소에 있는, 이 설계가 새로 만들지 않는 것

새 메커니즘을 발명하기 전에 있는 것을 셌습니다. **아래는 선례이고, 설계는 가능한 한
이것들을 따릅니다** — 두 번째 방식이 생기면 두 방식이 언젠가 서로 다르게 동작합니다.

| 있는 것 | 무엇을 이미 함 | N2가 물려받는 방식 |
|---|---|---|
| `lib/sessionSecurity.ts`의 `revokeAllUserSessions` | `User.sessionsRevokedAt` epoch를 올려 그 시점 이전 발급 토큰 전부 무효화 | 계정 전체 무효화의 정본. family/device epoch를 그 **아래** 계층으로 추가 |
| `lib/sessionRevocationCore.ts` | 순수 판정, **fail-closed** — 조회 실패와 사용자 없음을 **별도 상태**로 반환하고 거절 | bearer 판정도 같은 형태의 순수 모듈로, 같은 fail-closed로 |
| `lib/sessionSecurity.ts`의 15초 snapshot 캐시 | 무효화 관측 지연의 상한을 명시적으로 15초로 둠 | D12가 같은 값을 쓸지 결정 |
| `EmailLoginAttempt` (`prisma/schema.prisma`) | 원문 미저장(`codeHash`), 단일 사용(`consumedAt`), 명시적 무효화(`invalidatedAt`) | refresh credential record의 형태 |
| `lib/emailLogin.ts`의 검증 순서 | **비밀값 비교가 소비보다 먼저**, 그 다음 조건부 UPDATE로 소비 | D5·D7·D8의 3-갈래 순서 |
| `lib/oauthLink.ts` | 자체 OAuth2 + **PKCE(S256)** 구성 | **PKCE 구성만** 참고. 흐름은 재사용 불가 — D14.1 |
| `lib/chatAdmissionCore.ts` | 서명·subject 결속·짧은 만료 토큰의 검증 형태 | 검증 순서와 `timingSafeEqual` 사용 |
| docs/ops/admin-audit-key-epochs.md | 과거 키를 등재해 이전 구간을 계속 검증 | D6의 keyring |

---

## 2. 위협 모델

### 2.1 보호 자산

| 자산 | 왜 자산인가 |
|---|---|
| 계정 자체 | 대화·첨부·크레딧·결제 이력 전부에 도달 |
| refresh token | 장수명. 이것 하나로 access token을 계속 찍어 냄 |
| access token | 단수명이지만 유효한 동안 열린 route 전부 |
| **운영 비밀값** (`MAINTENANCE_SECRET` 등) | 내부 job 실행 권한. **모바일 토큰과 같은 헤더를 씁니다** |
| 기기 목록 | 사용자의 기기 보유 이력. 그 자체가 개인정보 |
| 서명 키·pepper | 유출되면 임의 토큰 위조 또는 digest 대조 |
| 크레딧 잔액 | 탈취 세션이 소비 가능. 금전 |
| 심사 계정 자격증명 | docs/ops/tomverse-chat-store-review.md §2 |

### 2.2 trust boundary와 refresh token의 실제 경로

rev.1은 refresh가 native 안에만 있다고 적었지만 **D14가 그것을 HTTP 응답으로
돌려주고 있었습니다.** 누가 그 응답을 받는지 정하지 않으면 두 문장은 양립하지
않습니다. rev.2의 경계는 이렇습니다.

```
[사용자 기기]
  Keychain / Keystore
        ▲  (A) 저장·읽기: native 코드만
        │
  Capacitor native 계층  ──(B)── HTTPS ──▶ [서버]  exchange · refresh · logout
        │                                          (refresh token은 이 선 위에서만 오간다)
        ▼  (C) access token만 전달
  WebView JS 컨텍스트  ─────────── HTTPS ──▶ [서버]  그 밖의 모든 API
        │
   origin = capacitor://localhost | https://localhost
```

- **(B)가 D19의 요점입니다.** `exchange`·`refresh`·`logout`은 **native 계층이
  호출**하고, 응답의 refresh token은 JS에 **한 번도 도달하지 않습니다.**
- **(C)** JS가 받는 것은 access token과 만료 시각뿐입니다.
- WebView의 `fetch`가 refresh 응답을 받으면 그 순간 T3(주입 스크립트)의 사정권에
  들어옵니다. rev.1은 이 경로를 금지한다고 적지 않았습니다.

서버 쪽 경계는 그대로입니다.

```
[Cloudflare] ─(1)─ [proxy.ts / Node.js runtime] ─(2)─ [route handler] ─(3)─ [Postgres]
```

- **(1)** host allowlist + origin secret. N1a·N1b 모두 이 **뒤**입니다.
- **(2)** N1b가 사는 자리. mutation-origin 검사보다 **먼저**여야 합니다(§5.5).
- **(3)** family·device·rotation 레코드.

### 2.3 공격자와 영향

| # | 공격자 / 사건 | 얻는 것 | 성공 시 영향 | 설계상 방어 | 탐지 신호 |
|---|---|---|---|---|---|
| T1 | 탈취된 access token | 메모리 덤프, 로그 유출 | access TTL 동안 열린 route 전권 | 짧은 TTL(D3), 로그·응답 미노출(D15), 인가 경로의 무효화 확인(D12) | 다른 IP/UA에서 같은 `jti`·`did` |
| T2 | **탈취·복제된 refresh token** | 기기 탈취, 백업 유출 | 영구 접근. **가장 큰 위협** | 회전(D7), 재사용 탐지(D8), idle/absolute(D4), 원문 미저장(D5) | `reuse_detected` |
| T3 | 악성 WebView 스크립트 / XSS | CSP 우회, 3자 스크립트 | 메모리의 access token. **refresh는 못 읽음 — D19가 성립할 때만** | refresh가 JS 컨텍스트를 지나지 않음(D19) | CSP 위반 리포트 |
| T4 | `https://localhost`를 주장하는 로컬 프로세스 | 기기의 아무 프로세스 | 그 origin으로 요청 가능 | **origin은 인증이 아님.** credentialed CORS 없음, 서버가 독립 검사 | 그 origin의 401 급증 |
| T5 | hostile web origin | 피싱 페이지 | 브라우저로 API 호출 시도 | ACAO 미발급(N1a), cookie 경로는 mutation-origin 유지 | 401/403 비율 |
| T6 | 분실·판매된 기기 | 물리 소유 | 그 기기 family 전권 | 기기별 해제(D11) | **자동 탐지 불가.** 사용자 신고 — 그래서 목록 UI가 방어의 일부 |
| T7 | refresh 응답 유실 + 재시도 | 네트워크 | 정상 사용자의 세션 파괴 | **§4의 승인 대상** | `reuse_detected` 중 재로그인 비율 |
| T8 | 동시 refresh 요청 | 앱의 병렬 요청 | T7과 같은 모양 | 같음 — §4 | 같음 |
| T9 | client가 위조한 내부 identity 헤더 | 아무 클라이언트 | 신원 사칭 | 무조건 삭제 후 성공 시에만 기록(§5.4), **route가 재검증**(D2) | 위조 헤더가 실려 온 사실 |
| T10 | cookie + bearer 혼합 | 브라우저·앱 혼합 | 어느 신원인지 모호 | D13 — **cookie를 아예 해석하지 않음** | — |
| T11 | 잘못된 iss/aud/sub/did/fid/kid/typ | 다른 환경 토큰, 위조 | 환경 간 재사용 | §5.2의 전체 검증 | 실패 사유별 카운터 |
| T12 | 서명 키 유출 | 인프라 침해 | 임의 토큰 위조 | 키 회전(D6), 서명 키 격리는 **배포 문제**(D1 주) | 발급되지 않은 `jti` |
| **T13** | **운영 비밀값 bearer가 모바일 검증기에 들어감** | 설계 실수 | **내부 job 7개 전부 401 — 유지보수 정지** | **N1b는 opt-in route에만 적용**(D18) | 내부 job 실패 알림 |
| **T14** | **N1b가 열린 route가 아직 cookie 신원을 읽음** | 설계 실수 | 앞은 bearer, 뒤는 cookie. 인가가 다른 주체를 가리킬 수 있음 | route 전환 증거가 **N1b 선행 조건**(D18, §8.2) | 전환 검사 |

---

## 3. 승인 결정표

상태는 전부 **`proposed`** 입니다. 이 패킷은 승인을 기록하는 문서가 아니라
요청하는 문서입니다.

---

### D1. access token 형식과 서명 알고리즘

> **rev.2 정정.** rev.1은 "proxy는 Edge runtime이므로 DB에 닿을 수 없고, 따라서
> 불투명 토큰은 불가능하다"고 적었습니다. **틀렸습니다.** 이 저장소의 Next.js는
> `16.3.3`이고, 벤더가 함께 배포한 문서
> (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`,
> "Runtime")가 이렇게 적습니다 — *"Proxy defaults to using the Node.js runtime.
> The `runtime` config option is not available in Proxy files."* 같은 문서의
> 변경 이력도 `v16.0.0`에 *"Middleware is deprecated and renamed to Proxy. Proxy
> defaults to the Node.js runtime"*.
>
> 그러므로 **불투명 토큰 + 조회는 원리적으로 가능**하고, 선택 근거를 다시 써야
> 합니다. 살아남는 것은 **순서** 논거뿐입니다(D2·§5.5).

| | |
|---|---|
| **권장** | JWS 압축 직렬화(JWT), **EdDSA(Ed25519)**, `kid` 헤더 필수, `alg` **고정 검증**(토큰이 주장하는 alg를 신뢰하지 않음) |
| **대안 A** | HS256(HMAC) |
| **대안 B** | **불투명 토큰 + 요청마다 DB 조회.** 이제 기술적으로 가능합니다 |
| **JWT를 권장하는 (rev.3에서 다시 좁힌) 근거** | ① **비용의 대상은 등재된 bearer 요청뿐입니다.** §5.2가 route 등재(D18)와 `Authorization` 부재를 **검증 전에** 걸러 내므로, 문서 요청과 미등재 경로는 애초에 검증기에 닿지 않습니다. 그러므로 "모든 요청이 DB 왕복"은 **틀린 서술이고 rev.2에서 철회합니다** — 남는 비용은 모바일 API 요청당 왕복 하나이며, 스트리밍·폴링처럼 잦은 경로에서는 그것도 작지 않습니다. ② **가용성 결합**: proxy 계층에는 `readSessionSecuritySnapshot`이 가진 캐시·백오프 같은 완충이 없으므로, 조회를 여기 두면 DB 흔들림이 곧 인증 장애가 됩니다. 완충을 만들면 그것은 다시 D12의 staleness 문제를 가져옵니다. ③ 대안 B가 사는 것은 **즉시 취소**이고, JWT는 그것을 D12의 epoch로 근사할 뿐입니다 |
| **정직하게 말하면** | ①은 rev.2가 생각한 것보다 **약한 근거**입니다. 이 결정은 "명백히 JWT"가 아니라 **왕복 하나와 즉시 취소를 맞바꾸는 선택**이며, 그래서 §8.1의 미결 11번으로 남습니다 |
| **대안 B의 진짜 장점** | 취소가 **즉시**입니다. D12의 15초를 받아들일 수 없다면 대안 B가 정답이고, 그 경우 비용은 위 ①②입니다 |
| **비대칭 서명의 이점과 그 한계** | 검증자가 공개키만 보유하면 검증 계층 침해로 토큰을 찍어 낼 수 없습니다. **다만 proxy와 route가 같은 배포·같은 프로세스 그룹이면 실제 격리 이득은 작습니다.** 서명 비밀키를 분리 보관할지는 **배포 결정**이고 이 패킷의 범위 밖입니다 |
| **rev.3 문구 정정** | rev.2는 "분리하지 않을 것이면 HS256이 정직하다"고 적었습니다. **과했습니다.** 분리하지 않으면 **격리 이점을 주장하지 않으면 될 뿐**이고, Ed25519 자체가 부적절해지지 않습니다 — 키 관리 형태와 알고리즘 선택은 별개 결정입니다 |
| **rev.1이 달았던 caveat 해소** | "Edge WebCrypto에 Ed25519가 있는지 실측 필요"는 **더 이상 미결이 아닙니다.** Node.js 런타임이므로 `node:crypto`의 Ed25519를 그대로 씁니다 |
| **막히는 후속** | 전부 |
| **최종 승인자** | Backend/AI + Mobile/Release |
| **상태** | `proposed` |

---

### D2. verifier 실행 위치와 route까지 identity를 전달하는 방식

| | |
|---|---|
| **권장** | **이중 검증.** ① `proxy.ts`가 검증해 **N1b 게이트 판정에만** 사용하고, ② route가 같은 `Authorization` 토큰을 **독립적으로 다시 검증**해 인가에 사용합니다. proxy가 설정하는 내부 identity 헤더는 편의이며 **route는 그것을 신뢰하지 않습니다** |
| **대안 A** | proxy만 검증, route는 내부 헤더를 신뢰 |
| **대안 B** | route만 검증 |
| **trade-off** | 대안 A는 헤더 위조 방어를 삭제 로직 **한 줄**에 겁니다(T9). 대안 B는 §5.5의 순서를 만족하지 못해 **N1b가 불가능**합니다 — 이것이 rev.1에서 유일하게 살아남은 배제 근거입니다 |
| **벤더가 같은 말을 함** | 같은 Next 문서: *"A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage. **Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone.**"* 이중 검증은 이 앱의 취향이 아니라 프레임워크의 권고입니다 |
| **필수 부수 조건** | proxy는 내부 identity namespace를 **검증 전에 무조건 삭제**하고 성공 시에만 다시 씁니다(§5.4). 정적 검사와 V22로 고정 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D3. access token 수명과 clock skew

| | |
|---|---|
| **권장** | 수명 **10분**, skew 허용 **±60초**(`exp`·`nbf`·`iat` 모두) |
| **대안** | 5분 / 15분 |
| **trade-off** | 짧을수록 T1 피해 창이 작고 refresh 경합(§4)이 잦습니다 |
| **근거 수준** | **측정값 아님.** 운영 트래픽이 없으므로 어느 값도 근거가 없고, 그래서 승인 대상입니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D4. refresh token idle / absolute 수명

| | |
|---|---|
| **권장** | idle **30일**, absolute **180일** |
| **대안** | idle 14일 / absolute 90일 · idle 60일 / absolute 365일 |
| **trade-off** | absolute가 길수록 T2의 가치가 큽니다. 짧을수록 재로그인이 잦고, **이 앱에는 password가 없어** 재로그인은 메일 또는 OAuth 왕복입니다 |
| **최종 승인자** | Mobile/Release + Backend/AI |
| **상태** | `proposed` |

---

### D5. refresh token 원문 비저장, digest 방식, **그리고 비교 시점**

> **rev.2 보강.** rev.1은 상수 시간 비교를 적었지만 **그 비교가 처리 순서의 어디에
> 들어가는지**를 적지 않았습니다. D8만 읽으면 "레코드가 존재하고 소비됐다"는
> 이유만으로 family를 폐기하게 됩니다 — **secret이 틀렸는데도.**

| | |
|---|---|
| **토큰 형태** | `<recordId>.<secret>`. `recordId`는 조회용 불투명 id, `secret`은 **256비트 CSPRNG** |
| **저장** | `HMAC-SHA256(pepper, secret)` digest 하나. **원문은 어디에도 없습니다** |
| **비교** | `timingSafeEqual`. 길이가 다르면 비교 전에 실패 처리(선례: `lib/emailLogin.ts`) |
| **순서 (계약)** | ① `recordId`로 레코드 조회 → 없으면 **거절, family 무변경** ② **secret digest 비교** → 불일치면 **거절, family 무변경** ③ 여기서부터만 상태 판정: `consumedAt`/`invalidatedAt`이 있으면 **재사용**(D8), family·device·계정 상태와 만료를 확인, 통과하면 원자적 회전(D7) |
| **왜 이 순서인가** | 뒤집으면 **`recordId`만 아는 공격자가 임의 family를 폐기**할 수 있습니다 — 인증 없는 DoS. `recordId`는 비밀이 아니고(토큰의 앞부분), 로그·오류에 실수로 남을 수 있는 값입니다 |
| **금지** | 원문·digest·`secret` 조각을 로그·응답·audit·오류에 넣지 않습니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D6. signing / digest key rotation과 이전 키 검증 기간

| | |
|---|---|
| **권장** | JWT `kid` keyring. 서명은 현재 키, 검증은 **현재 + 등재된 이전 키**. 이전 **서명** 키 허용 = access 수명 + skew 이상(권장 15분). **pepper는 별개**이며 회전 시 이전 pepper를 idle 수명 동안 유지하거나 다음 회전에서 재계산 |
| **trade-off** | 두 키의 주기가 다릅니다. 서명 키는 분 단위 유예로 충분하고 pepper는 **살아 있는 refresh 전부**에 걸립니다 — 이 비대칭을 놓치면 pepper 회전이 전 사용자를 로그아웃시킵니다 |
| **선례** | docs/ops/admin-audit-key-epochs.md |
| **미결** | 이전 pepper 유지 기간, 또는 "다음 refresh에서 재계산"으로 흡수할지 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D7. refresh 회전의 원자적 consume-and-mint

| | |
|---|---|
| **권장** | D5의 ①②를 통과한 뒤, 한 트랜잭션에서: ⓐ family 행 잠금, ⓑ **조건부 UPDATE** — `where id = ? AND consumedAt IS NULL AND invalidatedAt IS NULL AND expiresAt > now()` — 영향 행이 정확히 1이 아니면 실패, ⓒ 후속 rotation 삽입, ⓓ family `lastRotatedAt` 갱신 |
| **선례** | `lib/emailLogin.ts`의 소비, `ChatRequestLease`의 claim |
| **잠금 순서** | 이 경로는 크레딧을 만지지 않으므로 docs/policy/credit-and-cost-limits.md §9의 1번을 건너뜁니다. **그 순서를 뒤집지 않습니다** — 인증 트랜잭션 안에서 크레딧을 만지지 않습니다 |
| **금지** | 판정과 소비를 다른 트랜잭션으로 나누지 않습니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D8. retired token 재사용 시 family 무효화 시맨틱

| | |
|---|---|
| **적용 조건** | **D5의 ①②를 통과한 경우에만.** 즉 레코드가 존재하고 **secret이 맞는데** `consumedAt`/`invalidatedAt`이 있는 경우 |
| **동작** | family `revokedAt` + `revokedReason = "reuse_detected"`, 그 family의 미소비 rotation 전부 `invalidatedAt`, family epoch 상승(D12) |
| **정책 대조** | docs/policy/tomverse-chat-mobile-authentication.md "Token lifecycle"이 문자 그대로 요구하는 것 |
| **커밋 계약 (rev.2 신설)** | **401을 반환하더라도 폐기 트랜잭션은 커밋되어야 합니다.** 예외를 던져 응답과 함께 폐기까지 롤백되는 구현은 재사용 탐지를 무력화합니다 — 공격자가 재사용해도 아무 일이 없습니다. V25가 이것을 고정합니다 |
| **부작용** | 그 기기는 재로그인. **다른 기기의 family는 영향 없음** |
| **§4와의 관계** | "재사용"의 **정의**는 §4의 승인 대상입니다. D8은 그 정의를 받아 적용하는 규칙입니다 |
| **최종 승인자** | Backend/AI + Mobile/Release |
| **상태** | `proposed` |

---

### D9 · D10. 동시 refresh / 응답 유실 재시도

**§4로 분리했습니다.** 정책 변경 여부가 걸린 유일한 항목입니다.

| **상태** | `proposed` — §4 |
|---|---|

---

### D11. logout · 기기 해제 · 계정 삭제 · 재사용 탐지의 무효화 범위

| 사건 | 무효화 범위 | 다른 기기 | 웹 cookie 세션 |
|---|---|---|---|
| logout(그 기기) | 그 family 하나 | 영향 없음 | **영향 없음** |
| 기기 해제 | 지정한 device의 family | 영향 없음 | 영향 없음 |
| 재사용 탐지 | 그 family 하나 | 영향 없음 | 영향 없음 |
| 전체 로그아웃 | 모든 family | 전부 | **전부** — `revokeAllUserSessions` 동반 |
| 계정 삭제 | 모든 family + device 레코드 | 전부 | 전부 |
| 계정 정지 | 모든 family | 전부 | 전부(기존 `accountStatus` 경로) |

| | |
|---|---|
| **핵심** | "기기 하나를 잃었다고 웹 세션까지 끝나지 않는다" — 정책의 revocation 논거 3번 |
| **필수** | 계정 삭제는 `lib/accountDeletion.ts`의 **같은 트랜잭션**에서 device·family·rotation을 제거합니다. `PRIVACY-01`이 "모든 device family revoke"를 삭제 E2E 증거로 이름 댑니다 |
| **필수** | 새 테이블은 docs/policy/tomverse-chat-data-domain-registry.yaml 등재 없이 추가할 수 없습니다 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D12. 취소가 관측되기까지의 상한 — **하나의 숫자로**

> **rev.2 정정.** rev.1은 "실제 상한 15초, 최악 access TTL"이라고 적었습니다.
> **두 개는 상한이 아닙니다.** 그리고 "edge라 DB 불가"라는 전제도 틀렸습니다(D1).

| | |
|---|---|
| **권장** | 무효화 확인은 **인가 경로(route)** 에서 합니다. `User.sessionsRevokedAt` + family/device epoch를 `readSessionSecuritySnapshot`과 같은 형태로 읽고 **15초 캐시**. 따라서 **취소가 관측되기까지의 상한은 15초 하나**입니다 |
| **edge 게이트는 상한이 아닙니다** | proxy의 N1b 판정은 서명·만료만 봅니다. 취소된 세션의 access token이 `exp`까지 게이트를 통과할 수 있지만, **게이트는 인가가 아니므로** route가 거절합니다. 이 문장을 쓸 수 없으면 설계가 틀린 것입니다 |
| **조회 실패 시 (rev.2 신설)** | **fail-closed.** `lib/sessionRevocationCore.ts`가 `lookup-error`·`user-not-found`를 별도 상태로 반환하고 거절하는 것과 **동일하게** 처리합니다. 캐시가 만료됐고 DB를 못 읽으면 **거절**입니다 |
| **대안** | 무캐시 조회(상한 0초, 부하 증가) / D1 대안 B의 불투명 토큰(상한 0초, 요청당 왕복) |

#### rev.3 정정 — **TTL 15초는 상한 15초를 뜻하지 않습니다**

rev.2는 "캐시 TTL이 15초이므로 상한이 15초"라고 적었습니다. **성립하지 않습니다.**
`lib/sessionSecurity.ts`의 저장은 이렇게 되어 있습니다.

```
const user = await prisma.user.findUnique(...)        // ← 여기서 읽은 값은 조회 "시작" 시점의 사실
...
snapshotCache.set(userId, {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,          // ← 그런데 유효기간은 "완료" 시점 기준
    snapshot,
});
```

그래서 다음이 성립합니다.

| t | 사건 |
|---|---|
| 0s | 요청 X가 조회를 시작. 이 시점의 사실은 "취소 없음" |
| 1s | 취소 발생. `sessionsRevokedAt` 기록 + `invalidateSnapshot()` 호출 |
| 3s | X의 조회가 **느리게** 반환. 값은 t=0의 사실(취소 없음) |
| 3s | X가 그 값을 `expiresAt = 3 + 15 = 18s`로 캐시에 **덮어씀** |
| ~18s | 그때까지 취소가 관측되지 않음 — **취소 후 17초** |

두 가지가 겹쳐 있습니다. ① 유효기간의 **기준 시점이 조회 완료**이므로 상한이
`TTL + 조회 지연`이고 지연은 꼬리가 깁니다. ② t=1의 `invalidateSnapshot()`이
**t=3의 쓰기에 덮여 사라집니다** — 무효화가 유실되는 경합입니다. 조회 실패가
아니므로 fail-closed는 이 경우를 잡지 않습니다.

**N2가 정해야 하는 것 셋:**

1. **유효기간의 기준 시점을 조회 *시작*으로** 합니다 — `expiresAt = queryStartedAt + TTL`.
   그러면 상한이 지연에 비례해 늘지 않습니다.
2. **취소와 경합한 낡은 결과를 버립니다.** family/user별 write generation(또는
   무효화 시각)을 함께 읽고, 캐시에 쓰기 직전 **조회 시작 이후 무효화가 있었으면
   쓰지 않습니다.** 이것이 없으면 1번만으로는 ②가 남습니다.
3. **지연 조회를 주입하는 테스트**로 약속한 상한을 고정합니다(V29). 숫자를 문서에
   적는 것과 그 숫자가 지켜지는 것은 다릅니다.

| **승인이 확정하는 문장** | "취소는 최대 **N초** 안에 인가 경로에서 관측되며, 조회가 느려도 그 값을 넘지 않는다." **N을 정하는 것과, 위 1~3으로 그 문장을 참으로 만드는 것이 함께 승인 대상입니다** |
|---|---|
| **기존 웹 경로에 대해** | 같은 성질이 `lib/sessionSecurity.ts`에 지금도 있습니다. **이 패킷은 그 파일을 바꾸지 않으며**, 운영 중 취약점을 보고하는 것도 아닙니다(TTL이 짧아 창이 작습니다). 다만 **N2가 그 형태를 그대로 베끼면 안 된다**는 것과, 웹 경로도 따로 볼 값어치가 있다는 것을 여기 적어 둡니다 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D13. cookie와 bearer 혼합 / bearer 실패 시 fail-closed

> **rev.2 정정.** rev.1은 "cookie를 완전히 무시"한다면서 동시에 "subject가 다르면
> 모호로 거절"했습니다. **둘은 양립하지 않습니다** — 비교하려면 cookie를 해석해야
> 합니다. 결정으로 해소합니다.

| | |
|---|---|
| **권장** | **N1b가 열린 route에서 `Authorization` 헤더가 있으면 cookie를 파싱하지 않습니다.** 신원은 토큰뿐입니다. bearer 검증 실패 → **401**, cookie fallback **없음**. `MOBILE_AUTH_AMBIGUOUS`는 **삭제합니다** — 비교하지 않으므로 모호가 발생하지 않습니다 |
| **대안** | cookie도 해석해 subject 불일치를 401로 거절 |
| **trade-off** | 대안은 모든 모바일 요청에 **세션 해석(DB 왕복)을 하나 더** 얹습니다. 그리고 막는 시나리오에 공격 가치가 없습니다 — 두 credential을 다 넣을 수 있는 자는 이미 그중 하나로 정당하게 요청할 수 있습니다. 자기 bearer + 남의 cookie를 보내면 **자기 신원**으로 동작할 뿐 권한 상승이 없습니다 |
| **금지된 것 (변함없음)** | bearer 실패 시 cookie로의 fallback. 그것은 "잘못된 bearer를 붙이면 CSRF 검사가 사라진 cookie 요청"이 됩니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D14. endpoint 요청/응답 계약

| endpoint | 호출자 | 인증 수단 | 요청 본문 | 성공 응답 | mutation-origin |
|---|---|---|---|---|---|
| `POST …/mobile/exchange` | **native 계층** | 일회성 `grant`(D14.1) | `{ grant, codeVerifier?, deviceLabel? }` | `{ accessToken, expiresIn, refreshToken, deviceId }` | **면제 필요** |
| `POST …/mobile/refresh` | **native 계층** | refresh token(본문) | `{ refreshToken }` (+ B안이면 `idempotencyKey`) | `{ accessToken, expiresIn, refreshToken }` | **면제 필요** |
| `POST …/mobile/logout` | **native 계층** | **refresh token(본문)** | `{ refreshToken }` | `204` | **면제 필요** |
| `GET …/mobile/devices` | WebView JS | access token | — | `{ devices: [...] }` | 해당 없음(GET) |
| `POST …/mobile/devices/{id}/revoke` | WebView JS | access token | — | `204` | N1b 적용(D18) |

> **rev.2 정정 — logout.** rev.1은 인증 수단을 "refresh 또는 access"라 하고 본문을
> `{}`로 적었으며, origin 면제 목록에도 넣지 않았습니다. 세 가지가 서로 어긋납니다.
> 정정: **logout은 refresh token을 본문으로 받습니다.** access가 만료된 상태(가장
> 흔한 로그아웃 시점)에서도 동작해야 하고, 그러려면 `{}` 본문일 수 없으며 면제
> 목록에 있어야 합니다. access token만 가진 호출자를 위한 로그아웃이 따로 필요하면
> 그것은 별개 결정입니다.

**부트스트랩 문제와 해법 — 승인 필요.** `exchange`·`refresh`·`logout` 셋은 **N1b가
있기 전에** native에서 도달해야 하는데, 셋 다 `POST`이므로 지금은 403입니다.

- **권장**: 이 **세 경로**를 `lib/requestOrigin.ts`의 `EXEMPT_MUTATION_PATHS`에
  추가합니다. 그 목록의 규칙은 이미 "Origin 헤더를 보낼 수 없고 Origin보다 강한
  것으로 인증되는 호출자"이며, refresh token과 일회성 grant는 **ambient credential이
  아니므로 CSRF의 전제가 성립하지 않습니다.**
- **조건 (깨지면 예외가 곧 구멍)**: 이 세 경로는 **cookie 신원을 절대 받지
  않습니다.** 본문의 비-ambient credential만 봅니다.
- **대안 거부**: "N1b가 먼저 이것들을 덮게 한다" → `exchange`는 아직 bearer가 없는
  요청이므로 성립하지 않습니다.

| **최종 승인자** | Backend/AI + Security/Privacy |
|---|---|
| **상태** | `proposed` |

#### D14.1 최초 로그인 `grant` — `oauthLink.ts`로 대체되지 않습니다

> **rev.2 정정.** rev.1은 `lib/oauthLink.ts`를 "system-browser OAuth의 서버 절반을
> 재사용"이라고 적었습니다. 과장이었습니다. 그 흐름은 **이미 로그인한 계정에
> provider를 연결**하는 것이고, 시작 route가 `getServerSession`으로 세션을 요구한 뒤
> `assertRecentAdminAuthentication`까지 통과시킵니다. **세션이 없는 최초 로그인에는
> 쓸 수 없습니다.**

재사용할 수 있는 것과 없는 것:

| 재사용 가능 | 새로 설계해야 함 |
|---|---|
| PKCE(S256) 생성·검증 구성 | 세션 없는 상태의 인가 시작 |
| 상태(state) 쿠키/파라미터 처리 방식 | native로 돌아오는 **일회성 `grant`의 발급** |
| provider 토큰 교환의 HTTP 형태 | `grant`의 **단일 사용 소비**와 만료 |
| — | `grant`의 **client 결속** — 어느 앱 인스턴스가 시작한 인가인지 |

`grant`는 refresh token과 같은 규율을 받습니다: 원문 미저장, digest 비교, 단일 사용,
짧은 만료. 이메일 OTP/매직링크 경로도 동일하게 **기존 `lib/emailLogin.ts` 정책(TTL·
lockout·Turnstile)을 그대로 통과한 뒤** `grant`를 발급합니다.

**미결**: `grant` 수명(권장 60초), client 결속 방식(PKCE verifier 재사용 vs 별도
nonce).

---

### D15. rate limit · 오류 코드 · audit · 로그와 redaction

| | 권장 | 비고 |
|---|---|---|
| **rate limit** | `refresh`: device당 분 20 / 일 500. `exchange`: 계정당 분 5 / 일 20. `logout`: device당 분 10 | 숫자는 **승인 대상** |
| **오류 코드** | `MOBILE_TOKEN_INVALID`, `MOBILE_TOKEN_EXPIRED`, `MOBILE_REFRESH_REJECTED`, `MOBILE_RATE_LIMITED` | `MOBILE_AUTH_AMBIGUOUS`는 **D13에서 삭제됨** |
| **단일 거절 문구** | 만료·위조·재사용·잘못된 secret이 **전부** `MOBILE_REFRESH_REJECTED` + `reauthenticate: true`. 정확한 사유는 audit에만 | `PRIVACY-02` 증거의 "single refusal message shared by every refusal reason"과 같은 이유 |
| **audit event** | `mobile_auth.exchanged`, `.refreshed`, `.refresh_rejected`, `.reuse_detected`, `.family_revoked`, `.device_revoked`, `.logged_out`, `.revoked_on_account_deletion` | `lib/securityAudit.ts` 경로 사용 |
| **로그 필드** | `event`, `userId`, `deviceId`, `familyId`, `outcome`, `reason`, `kid`, `tokenAgeSeconds` | 전부 서버가 고른 값이거나 계산된 숫자 |
| **절대 금지** | access/refresh 원문·조각·digest, `recordId`, `Authorization` 값, pepper, 서명 키, `grant`, PKCE verifier, OTP, magic-link token, idempotency key | `recordId`가 추가된 이유는 D5 — 그것만으로 family를 지목할 수 있어서는 안 됩니다 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D16. device record 필드와 개인정보 최소화

| | |
|---|---|
| **보이는 것** | 사용자가 붙인 이름, **거친 플랫폼 라벨**(`ios`/`android`), 앱 버전, 마지막 사용 시각, 등록 시각 |
| **수집 안 함** | 모델명 상세, OS 빌드, 광고 식별자, IDFV/ANDROID_ID, 화면·폰트 등 fingerprint 재료 |
| **IP** | 목록에 **보이지 않는 것을 권장**. 필요하면 최근 1건만 절삭(IPv4 /24, IPv6 /48). **승인 대상** |
| **trade-off** | 풍부할수록 "내 기기인가" 판단이 쉽지만, 계정이 침해되면 그 목록이 **위치·기기 이력**이 됩니다. 이 앱은 password가 없어 탈취 경로가 메일이므로 부수 피해가 그만큼 큽니다 |
| **필수** | data-domain registry 등재, 보관 기간과 `deletionAction` 명시 |
| **최종 승인자** | Security/Privacy + Mobile/Release |
| **상태** | `proposed` |

---

### D17. 서버 발급 random device identity — 하드웨어 fingerprint 금지

> **rev.2 정정.** rev.1은 "앱을 지우면 사라진다"고 단정했습니다. **Apple은 앱 삭제
> 후 Keychain 항목의 소멸을 의존 가능한 계약으로 보장하지 않습니다.** 설계가 그
> 동작에 기대면 안 됩니다.

| | |
|---|---|
| **권장** | device id는 **서버가 만든 난수**이고 refresh token과 같은 보안 저장소 항목에 둡니다. **fingerprint를 쓰지 않습니다** |
| **대안** | IDFV/ANDROID_ID로 안정적 식별 |
| **trade-off** | 대안은 재설치 후에도 같은 기기로 보이지만, **삭제해도 따라오는 식별자**를 계정에 묶는 일이며 App Store 개인정보 표시의 "Identifiers → Device ID"이자 5.1.2(iii)의 프로파일링 우려 대상이 됩니다 |
| **재설치·잔존 처리 (rev.2 신설)** | 앱 삭제로 항목이 사라졌다고 **가정하지 않습니다.** ① 재설치 후 저장소에 항목이 남아 있으면 서버가 그 family의 유효성을 판정하고, 무효면 새 기기로 등록합니다. ② 명시적 logout은 **항목을 반드시 지웁니다** — 유일하게 앱이 통제할 수 있는 시점입니다. ③ 사용자는 목록에서 오래된 기기를 지울 수 있어야 합니다 |
| **미결** | 재설치 시 이전 family를 이어받게 할지(UX 좋음), 항상 새 기기로 볼지(보안 단순) |
| **최종 승인자** | Security/Privacy |
| **상태** | `proposed` |

---

### D18. N1b 적용 범위 — **route opt-in allowlist** *(rev.2 신설)*

> 이것이 rev.2에서 가장 크게 바뀐 결정입니다. rev.1은 N1b를 `/api/*` 전체에
> 적용했고, 그러면 **양쪽으로 깨집니다.**

| | |
|---|---|
| **권장** | N1b는 **명시적으로 등재된 route에만** 적용합니다. 등재는 코드의 한 목록(`N1B_BEARER_ROUTES` 같은 것)이고, 등재 조건은 아래 셋을 **전부** 만족하는 것입니다 |
| **등재 조건** | ① route가 신원을 **bearer로 끝까지 해석**한다 — `getServerSession`으로 cookie 신원을 읽지 않는다. ② 소유권·권한 검사가 **그 bearer 신원 기준으로** 되어 있다. ③ 전환 증거(테스트)가 있다 |
| **적용하지 않는 곳** | `/api/internal/**` **전부**. 이 7개는 `Authorization: Bearer <운영 비밀값>`을 쓰며 JWT가 아닙니다. 모바일 검증기에 넣으면 **정상 유지보수가 401**입니다(T13) |
| **아직 전환되지 않은 route** | N1b가 **적용되지 않습니다.** 즉 native의 mutation은 계속 403이고, 그것이 옳습니다 — 전환 전에 여는 것이 T14입니다 |
| **비-모바일 bearer의 처리** | N1b 대상이 아닌 route에서는 검증기가 **아예 돌지 않습니다.** 따라서 운영 비밀값 bearer는 지금과 똑같이 동작합니다. 이것은 "검증 실패 시 통과"가 아닙니다 — **검증을 시도하지도 않는 것**이며, 대상 route에서는 반대로 실패가 곧 401입니다 |
| **대안** | 전역 적용 후 예외 목록 |
| **trade-off** | 예외 목록(opt-out)은 **이미 당해 본 경로만** 담습니다 — AGENTS.md가 브랜치 자동화에서 같은 실수를 이미 기록했습니다("opt-in에서 모르는 것은 없음이고, opt-out에서는 잘못된 것이 켜진 상태"). 인증에서 그 비대칭은 훨씬 큽니다 |
| **막히는 후속** | N1b 전체 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D19. native 계층과 JS 컨텍스트의 토큰 경계 *(rev.2 신설)*

| | |
|---|---|
| **권장** | `exchange`·`refresh`·`logout`은 **Capacitor native 계층이 호출**합니다. 응답의 refresh token은 native 안에서 보안 저장소로 직행하고 **WebView JS에 반환되지 않습니다.** JS가 bridge로 받는 것은 `{ accessToken, expiresAt }`뿐입니다 |
| **대안** | JS가 직접 호출하고 bridge로 저장만 위임 |
| **trade-off** | 대안은 구현이 단순하지만 **refresh token이 JS 힙을 통과**하므로 T3(주입 스크립트)의 사정권입니다. 그 순간 "refresh는 JS가 읽을 수 없다"는 정책 문장이 거짓이 됩니다 |
| **파생 요구** | ① bridge는 refresh를 **반환하는 API를 갖지 않습니다** — 없으면 유출될 수 없습니다. ② access token 만료 시 JS는 bridge에 "새 access"를 요청하고, native가 필요하면 refresh를 수행합니다. ③ §4의 single-flight는 **native 계층**에서 구현됩니다 — JS 여러 탭/컴포넌트가 아니라 한 곳입니다 |
| **검증** | 실기기 항목입니다. `AUTH-03` 증거에 "refresh token이 WebView 컨텍스트에 존재하지 않음"을 포함시킬지는 승인 대상 |
| **최종 승인자** | Mobile/Release + Backend/AI |
| **상태** | `proposed` |

---

## 4. 동시 회전 문제 — 별도 승인

**문제.** 정책은 retired refresh token 재사용을 family 전체 무효화로 요구합니다.
그런데 **정상 클라이언트의 동시 요청**(T8)과 **응답 유실 뒤 재시도**(T7)가 서버에서
**똑같은 모양**으로 보입니다 — 이미 소비된 레코드의, **secret이 맞는** 제시.

D5의 순서 덕분에 "secret이 틀린 제시"는 여기서 빠집니다. 남는 것은 진짜 동형입니다.

| 안 | 동작 | 정책 관계 | 보안 | UX |
|---|---|---|---|---|
| **A. 엄격한 1회 사용** | 소비된 토큰 제시 → 즉시 family 폐기 → 재로그인 | **정책을 문자 그대로 구현.** 변경 없음 | 최상. 창 없음 | 최악. 네트워크가 나쁜 사용자가 로그아웃되고, password가 없어 재로그인은 메일/OAuth 왕복 |
| **B. single-flight + 서버 idempotency** | native가 refresh를 단일화. 서버는 회전 시 요청의 idempotency key digest를 저장하고, **같은 key + 같은 device + 짧은 창**의 재시도에만 정상 응답. 그 밖의 재사용은 A와 동일 | **정책 변경 필요** | 창 안에서도 공격자는 **retired token + idempotency key 둘 다** 필요 | 양호 |
| **C. grace window 재전달** | retired가 직전 회전이고 창 안이며 후속이 미사용이면 후속을 다시 돌려줌 | **정책 변경 필요** | **B보다 약함.** 훔친 retired token만으로 창 안에서 후속 획득 | B와 비슷 |

### 4.1 권장

**1순위로 A를 승인하고, native 계층의 single-flight를 Mobile/Release의 구현 요건으로
못 박습니다**(D19). 근거는 정책이 이미 내린 판단입니다 — 재생은 사본이 어딘가
존재한다는 뜻입니다.

**A가 현장에서 정상 사용자를 끊는 것이 관측되면 B로 갑니다.** C는 **권장하지
않습니다** — 창을 열면서 추가 비밀을 요구하지 않으므로 훔친 토큰의 가치를 창
길이만큼 그대로 늘립니다.

### 4.2 A를 고르면 함께 승인할 것

- native single-flight가 **구현 요건**(권고 아님).
- refresh 실패 시 앱이 조용히 재시도하지 않고 재로그인으로 보내는 UX.
- `reuse_detected` 중 **재로그인으로 이어진 비율** 지표. 이 숫자가 A의 비용이고
  B로 갈지를 정할 유일한 근거입니다.

### 4.3 B를 고르면 — **"동일 응답 재전달"은 그대로 구현할 수 없습니다** *(rev.2 정정)*

rev.1은 "이미 발급한 동일 응답을 재전달"이라고 적었습니다. **D5가 digest만
저장하므로 원문을 복원할 수 없습니다.** 기전을 정해야 합니다.

| 기전 | 방식 | 비용 | rev.3 상태 |
|---|---|---|---|
| **B-1. 응답 보관** | 발급한 refresh token 원문을 창(권장 10초) 동안 봉투 암호화해 보관하고 **같은 것을 다시 전달** | **원문을 저장합니다.** D5의 "어디에도 없다"가 창 동안 거짓이 됩니다. 키 관리와 확실한 삭제가 필요 | B를 고른다면 **이쪽** |
| **B-2. 후속 재발급** | idempotent 재시도이면 기존 후속을 폐기하고 같은 family에서 **새 후속을 발급** | 원문 저장 없음 | **보류 — 아래 반례** |

##### rev.3 정정 — B-2는 정상 사용자의 토큰을 무효화할 수 있습니다

rev.2는 B-2를 권장하며 B-1의 이익을 "문자열이 같다뿐"이라고 적었습니다. **둘 다
틀렸습니다.** 문서에 적힌 B-2 규칙만으로 다음이 성립합니다.

| t | 사건 | 앱이 가진 것 | 서버의 유효 토큰 |
|---|---|---|---|
| 0 | 앱이 `refresh(RT0, key K)` 전송 → **요청 A**. 네트워크 지연 | RT0 | RT0 |
| 1 | 앱이 타임아웃. 같은 key로 **요청 B** 재전송 | RT0 | RT0 |
| 2 | **B가 먼저 도착.** RT0 소비, **R1** 발급, 응답 도달 | **R1** | R1 |
| 3 | **지연됐던 A가 뒤늦게 도착.** 같은 key의 재시도로 인정 → **R1 폐기, R2 발급** | **R1** | **R2** |
| 4 | A의 응답은 이미 타임아웃된 요청의 것이므로 **앱이 받지 못함** | R1 (무효) | R2 |
| 5 | 앱이 다음에 R1로 refresh → **폐기된 토큰 제시** → §4 A안 규칙으로 **family 폐기** | — | — |

**결과는 잠김입니다.** 그리고 native single-flight는 이것을 막지 못합니다 — 앱이
타임아웃한 요청은 앱에서만 사라질 뿐 **이미 서버로 떠난 요청은 취소되지 않습니다.**

그러므로 **B-1의 이익은 "문자열이 같다"가 아니라 "중복 요청이 이미 성공한 결과를
다시 바꾸지 않는다"** 입니다. 그것이 idempotency의 정의이고, B-2에는 그 성질이
없습니다.

**B-2는 보류합니다.** 되살리려면 최소한 지연 요청, 응답 유실, 후속 토큰의 사용
여부까지 포함한 상태 전이가 정의되고 검증되어야 합니다. 이 패킷은 그것을 갖고
있지 않습니다.

> 위 반례는 **문서에 적힌 규칙을 작은 상태 모델에 적용해 얻은 것**이며, 구현이
> 없으므로 테스트로 재현한 것은 아닙니다.

**A안은 B-2의 완성을 기다리지 않습니다.** A는 이 기전 자체를 쓰지 않습니다.

B를 고르면 함께 정할 것: 창 길이(권장 10초), idempotency key의 생성 주체(native)와
**digest만 저장**한다는 규칙, B-1의 원문 보관 키 관리와 삭제 보장, 그리고
**정책 문서 개정이 구현보다 먼저**라는 것.

| **최종 승인자** | Backend/AI + Mobile/Release |
|---|---|
| **상태** | `proposed` — **A / B-1 / C** 택일이 승인 행위. **B-2는 보류**이므로 선택지가 아닙니다 |

---

## 5. N1b의 정확한 대체 조건

### 5.1 절대 금지

1. `Authorization` 헤더가 **존재한다는 이유로** mutation-origin 검사를 생략.
2. 토큰 **문자열 모양**(접두사·길이·점 개수)만 검사.
3. client가 보낸 `userId`·`deviceId`·`familyId`·내부 헤더를 신뢰.
4. bearer 검증 실패 후 **cookie 신원으로 조용히 fallback**.
5. client 헤더가 proxy의 내부 identity 헤더를 **덮어쓰도록 허용**.
6. *(rev.2 추가)* **등재되지 않은 route에서 N1b를 여는 것** — 그 route가 아직
   cookie 신원을 읽고 있으면 앞뒤가 다른 주체를 가리킵니다(T14).
7. *(rev.2 추가)* **`/api/internal/**`을 모바일 검증기에 넣는 것**(T13).

`proxy.ts`의 prefetch 분기 주석이 1번의 근거입니다 — *"gating those on request
headers would let any caller opt out of the entire edge security layer."*

### 5.2 성립 조건 (의사 코드)

```
n1bReplacesMutationOriginCheck(request):
    # 0. host allowlist와 origin-secret 검사를 이미 통과한 뒤에만 불린다.

    # 1. route 범위 — D18. 등재되지 않은 경로에서는 검증을 시도조차 하지 않는다.
    if request.path not in N1B_BEARER_ROUTES:   return NOT_APPLICABLE
    #    → /api/internal/** 은 이 목록에 없다. 운영 비밀값 bearer는 손대지 않는다.

    header = request.headers["authorization"]
    if header is absent:                        return NO       # cookie 경로로
    if not header starts with "Bearer ":        return REJECT   # 401, fallback 없음

    parsed = parseCompactJws(header after "Bearer ")
    if parsed is malformed:                     return REJECT

    # 2. 헤더 — 미디어 타입과 키
    if parsed.header.typ != "at+jwt":           return REJECT   # RFC 8725 명시적 타이핑
    if parsed.header.kid is absent:             return REJECT
    key = keyring.lookup(parsed.header.kid)
    if key is absent:                           return REJECT
    if parsed.header.alg != key.expectedAlg:    return REJECT   # 토큰이 주장하는 alg 불신

    # 3. 서명 — 여기까지 오지 않으면 아래 claim은 전부 공격자가 쓴 값이다.
    if not verifySignature(parsed, key):        return REJECT

    # 4. claim 존재와 타입. 없거나 타입이 다르면 거절이지 기본값이 아니다.
    c = parsed.claims
    for name in ["iss", "sub", "did", "fid", "jti", "tkn"]:
        if c[name] is absent or not a non-empty string:  return REJECT
    for name in ["iat", "nbf", "exp"]:
        if c[name] is absent or not a finite number:     return REJECT
    # aud는 문자열 또는 문자열 배열. 그 밖의 타입은 거절.
    if c.aud is a non-empty string:      audiences = [c.aud]
    elif c.aud is a non-empty array of non-empty strings: audiences = c.aud
    else:                                       return REJECT

    # 5. 값
    if c.tkn != "tomverse-mobile-access":       return REJECT   # refresh·grant 혼용 차단
    if c.iss != EXPECTED_ISSUER:                return REJECT   # 정확 일치
    # 정확 일치. 부분 문자열도 접두사도 아니다 -- 아래 주 참조.
    if not any(a == EXPECTED_AUDIENCE for a in audiences):  return REJECT
    if now < c.nbf - SKEW:                      return REJECT
    if now < c.iat - SKEW:                      return REJECT   # 미래 발급 토큰 거절
    if now >= c.exp + SKEW:                     return REJECT
    if c.exp <= c.iat:                          return REJECT

    return YES(subject = c.sub, device = c.did, family = c.fid, jti = c.jti)
```

> **rev.2 정정 — `typ`.** rev.1은 D1에서 헤더 `typ`을 `tomverse-mobile-access+jwt`로,
> §5.2에서 payload `c.typ`을 `tomverse-mobile-access`로 적어 **두 곳이 달랐습니다.**
> 정정: **헤더 `typ`은 미디어 타입 `at+jwt`**, **payload의 토큰 종류는 `tkn` claim**
> 으로 이름을 분리하고 **둘 다 검사**합니다. 이름이 같으면 다시 어긋납니다.
>
> **rev.2 보강.** `iat`·`jti` 필수, 모든 claim의 **존재와 타입** 검증, 미래 발급과
> `exp <= iat` 거절이 rev.1에 없었습니다.
>
> **rev.3 정정 — `aud`.** rev.2는 `aud`를 문자열로 제한해 놓고
> `EXPECTED_AUDIENCE not in c.aud`라고 적었습니다. 이것이 **부분 문자열 검사로
> 구현되면** 기대값이 `mobile-api`일 때 `mobile-api-other`가 통과합니다 — 다른
> audience용으로 발급된 토큰이 이 API에서 받아들여진다는 뜻입니다. 정정: `aud`는
> **문자열 또는 문자열 배열**이며, 판정은 **정확 일치**(배열이면 원소 단위 정확
> 일치)입니다. `iss`도 같은 이유로 정확 일치임을 명시했습니다. 부분 문자열·접두사·
> 정규식 어느 것도 쓰지 않습니다.
>
> 이 계약은 RFC 7519 §4.1.3의 audience 규칙을 따르는 것입니다 — 다만 이 세션에서
> `rfc-editor.org`는 egress 차단이라 **원문을 확인하지 못했으므로**, 위 문단은
> 인용이 아니라 이 설계가 채택하는 계약으로 읽어 주십시오. 어느 쪽이든 정확 일치가
> 안전한 쪽입니다.

**`YES`가 뜻하는 것과 뜻하지 않는 것.**

- 뜻하는 것: **암호학적으로 검증된 모바일 bearer 요청**이므로 ambient credential에
  의존하지 않고, 따라서 CSRF의 전제가 성립하지 않습니다. mutation-origin 검사를
  **대체**합니다.
- 뜻하지 **않는** 것: 인가. 소유권·계정 상태·family 폐기·크레딧은 **전부 route가 다시
  판정**합니다(D2·D12).
- `NOT_APPLICABLE`은 "통과"가 아닙니다. **검증을 시도하지 않았다**는 뜻이고, 그
  요청은 기존 경로(mutation-origin 또는 내부 route 자신의 검사)를 그대로 지납니다.

### 5.3 truth table

`/api/*`의 비-GET 요청. host·origin-secret 검사는 통과했다고 가정합니다.

> **rev.2 정정.** rev.1의 1행은 정상 web origin까지 "cookie 없음"을 이유로 403에
>묶었습니다. **현행 `hasValidMutationOrigin`은 cookie를 보지 않습니다** — origin만
> 봅니다. cookie가 없는 정상 origin 요청은 proxy를 통과하고 route가 401을 냅니다.

| # | route | Origin | `Authorization` | bearer | cookie | mutation-origin | 결과 |
|---|---|---|---|---|---|---|---|
| 1 | 아무거나 | 정상 web | 없음 | — | 없음 | 수행 → **통과** | route로 → route가 401 |
| 2 | 아무거나 | 정상 web | 없음 | — | 있음 | 수행 → 통과 | route로 (**현행 그대로**) |
| 3 | 아무거나 | hostile | 없음 | 있음/없음 | 있음/없음 | 수행 → 실패 | 403 (**현행 그대로**) |
| 4 | 아무거나 | native | 없음 | — | 있음/없음 | 수행 → 실패 | 403 (**N1a 이후 현행**) |
| 5 | **미등재** | native | 있음 | 유효 | — | 수행 → 실패 | **403.** N1b 미적용(D18) |
| 6 | **`/api/internal/**`** | 없음 | 있음(**운영 비밀값**) | — | — | **면제**(기존) | **route가 자기 비밀값 검사** — N1b 무관 |
| 7 | 등재됨 | native | 있음 | **통과** | 없음 | **대체됨** | route로. 신원 = 토큰 |
| 8 | 등재됨 | native | 있음 | 실패 | 없음 | — | **401.** fallback 없음 |
| 9 | 등재됨 | native | 있음 | 실패 | 있음 | — | **401.** cookie를 파싱하지 않음 |
| 10 | 등재됨 | native | 있음 | 통과 | 있음 | **대체됨** | route로. 신원 = **토큰**. cookie는 **해석되지 않음**(D13) |
| 11 | 등재됨 | hostile | 있음 | 실패(위조) | — | — | **401**, 그리고 ACAO 없음 → 브라우저가 못 읽음 |
| 12 | 등재됨 | hostile | 있음 | **통과** | — | **대체됨** | route로. **Origin은 요구하지 않습니다** — 아래 주 |
| 13 | 등재됨 | 없음(비브라우저) | 있음 | 통과 | — | **대체됨** | route로 |
| 14 | 등재됨 | 아무거나 | 있음 | 통과 | — | 대체됨 | 내부 identity 헤더가 실려 와도 **삭제 후 재기록**(§5.4) |

**12번 주.** 유효한 bearer를 가진 hostile origin을 거절하지 **않습니다.** 유효한
토큰을 이미 가진 공격자는 브라우저 없이도 요청할 수 있으므로 Origin 검사는 아무것도
막지 못하고, 요구하면 Origin이 없는 정상 클라이언트만 깨집니다. **Origin은 bearer의
진위를 증명하지 않습니다.** 브라우저 안의 hostile 페이지 방어는 다른 층입니다 —
ACAO를 주지 않아 응답을 읽지 못하게 하는 것(N1a).

### 5.4 내부 identity 헤더 규칙

```
requestHeaders = new Headers(request.headers)
for name in requestHeaders:                       # 검증보다 먼저, 무조건
    if name starts with INTERNAL_AUTH_PREFIX:
        requestHeaders.delete(name)
        record("client_sent_internal_auth_header", name)   # 값은 남기지 않음

verdict = n1bReplacesMutationOriginCheck(request)
if verdict is YES:
    requestHeaders.set("x-tomverse-auth-subject", verdict.subject)
    requestHeaders.set("x-tomverse-auth-device",  verdict.device)
    requestHeaders.set("x-tomverse-auth-family",  verdict.family)
```

`set`(덮어쓰기)만으로는 부족합니다 — 검증이 **실패**하거나 `NOT_APPLICABLE`이면
아무것도 쓰지 않으므로 클라이언트 값이 살아남습니다. 그래서 삭제가 먼저입니다.

그리고 D2에 따라 **route는 이 헤더를 신뢰하지 않습니다.** route는 같은
`Authorization` 토큰을 다시 검증합니다.

### 5.5 실제 실행 순서 (`proxy.ts` 호출 흐름)

N1b가 성립하려면 검증자가 **mutation-origin 검사보다 먼저** 실행되어야 합니다.

| 순서 | 현재 (`49c2624`) | N2 이후 |
|---|---|---|
| 1 | `/api/health` 통과 | 동일 |
| 2 | `isAllowedRequestHost` + `hasRequiredOriginSecret` → 실패 시 **421** | 동일 |
| 3 | — | **내부 auth 헤더 삭제**(§5.4) |
| 4 | N1a preflight 응답(204) | 동일 |
| 5 | — | **route 등재 확인**(D18) → 미등재면 아무것도 하지 않음 |
| 6 | — | **N1b bearer 검증** → `YES` / `NO` / `REJECT`(401) |
| 7 | `requiresMutationOriginCheck` + `!hasValidMutationOrigin` → **403** | **`YES`가 아닐 때만** 수행 |
| 8 | prefetch, 언어 리다이렉트, CSP, 내부 헤더, 응답 | 6이 `YES`면 identity 헤더 추가 |

**검증자가 7번보다 늦으면 N1b는 성립하지 않습니다.** route에서만 검증하는 설계
(D2 대안 B)가 배제되는 유일한 근거이고, **rev.1이 들었던 런타임 근거는 철회**
되었습니다(D1).

---

## 6. 제안 데이터 모델 (논리 모델 — Prisma 문법 아님)

> 논리 스키마입니다. Prisma 모델도 migration도 작성하지 않았습니다. 실제 추가 시
> docs/policy/tomverse-chat-data-domain-registry.yaml 등재가 선행 조건입니다.

### 6.1 `MobileDevice`

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | 서버 발급 난수 device id | 간접 | 계정 삭제 시 제거 | PK | 아니오 |
| `userId` | 소유자 | 예 | 동일 | index, cascade | 아니오 |
| `label` | 사용자가 붙인 이름 | 예(자유 입력) | 동일 | — | 아니오 |
| `platform` | `ios` / `android` **거친 라벨만** | 낮음 | 동일 | — | 아니오 |
| `appVersion` | 지원·디버깅 | 낮음 | 동일 | — | 아니오 |
| `createdAt` / `lastSeenAt` | 목록 표시 | 예(활동 시각) | 동일 | `lastSeenAt` | 아니오 |
| `revokedAt` / `revokedReason` | 해제 상태 | 낮음 | 동일 | — | 아니오 |

**없는 것**: 하드웨어 fingerprint, 광고 식별자, 모델명 상세, 전체 IP(D16·D17).

### 6.2 `MobileTokenFamily`

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | family 식별 | 간접 | 계정 삭제 시 제거 | PK | 아니오 |
| `userId` / `deviceId` | 소유·결속 | 예 / 간접 | 동일 | index | 아니오 |
| `createdAt` | 세션 시작 | 예 | 동일 | — | 아니오 |
| `absoluteExpiresAt` | D4의 absolute 상한 | 아니오 | 동일 | index | 아니오 |
| `lastRotatedAt` | idle 계산 | 예 | 동일 | — | 아니오 |
| `revokedAt` / `revokedReason` | `logout` / `device_revoked` / `reuse_detected` / `account_deleted` | 낮음 | 동일 | index | 아니오 |
| `epoch` | D12의 무효화 세대 | 아니오 | 동일 | — | 아니오 |

### 6.3 `MobileRefreshRotation`

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | 토큰의 조회용 id (토큰 앞부분). **비밀 아님 — D5가 이것만으로 아무것도 못 하게 함** | 아니오 | 만료 정리 + 계정 삭제 | PK | 아니오 |
| `familyId` | 소속 | 간접 | 동일 | index | 아니오 |
| `secretDigest` | `HMAC-SHA256(pepper, secret)` | 아니오 | 동일 | unique | **아니오 — 원문 미저장** |
| `pepperKid` | D6의 pepper 세대 | 아니오 | 동일 | — | 아니오 |
| `createdAt` / `expiresAt` | 수명 | 낮음 | 동일 | `expiresAt` | 아니오 |
| `consumedAt` | 단일 사용 | 낮음 | 동일 | — | 아니오 |
| `invalidatedAt` | 명시적 폐기 | 낮음 | 동일 | — | 아니오 |
| `supersededById` | 회전 사슬 | 아니오 | 동일 | — | 아니오 |
| `idempotencyKeyDigest` | **§4에서 B안 승인 시에만** | 아니오 | 동일 | — | **아니오 — 원문 미저장** |

`(id, consumedAt, invalidatedAt, expiresAt)`가 D7 ⓑ의 조건부 UPDATE가 읽는 조합입니다.

### 6.4 `MobileLoginGrant` *(rev.2 신설 — D14.1)*

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | 조회용 | 아니오 | 만료 후 정리 | PK | 아니오 |
| `secretDigest` | grant 비밀값 digest | 아니오 | 동일 | unique | **아니오** |
| `userId` | 인가가 확정한 계정 | 예 | 동일 | index | 아니오 |
| `clientBindingDigest` | 어느 앱 인스턴스가 시작했는지 | 아니오 | 동일 | — | **아니오** |
| `expiresAt` / `consumedAt` | 짧은 만료, 단일 사용 | 낮음 | 동일 | `expiresAt` | 아니오 |

### 6.5 `MobileAuthEvent`

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | PK | 아니오 | **승인 대상**(권장 90일) | PK | 아니오 |
| `event` | D15의 목록 | 아니오 | 동일 | index | 아니오 |
| `userId` / `deviceId` / `familyId` | 대상 | 예 / 간접 / 간접 | 동일 | index | 아니오 |
| `occurredAt` | 시각 | 예 | 동일 | index | 아니오 |
| `reason` | 짧은 기계 판독 사유 | 아니오 | 동일 | — | 아니오 |

**없는 것**: 토큰, digest, `recordId`, 헤더 값, IP 원본, User-Agent 원문.

> 보관 기간과 계정 삭제 시 `deletionAction`은 Security/Privacy 결정이며, registry의
> `reidentificationReview`가 그 판단을 요구합니다.

---

## 7. 테스트 벡터

승인 후 구현 단계에서 실행할 벡터입니다. **이 패킷은 테스트 코드를 작성하지
않았습니다.** 약어: **AT** access token, **RT** refresh token, **F** family,
**D** device.

| # | 사전 상태 | 요청 | 예상 status / code | DB 변화 | F / D / AT 상태 | audit event | 절대 없어야 할 것 |
|---|---|---|---|---|---|---|---|
| V1 | 정상 F, 유효 AT, **등재 route** | 유효 AT | 200 (route 판정) | 없음 | 변화 없음 | 없음 | AT 값 |
| V2 | 정상 F | 서명만 바꾼 AT | 401 `MOBILE_TOKEN_INVALID` | 없음 | 변화 없음 | 카운터만 | 토큰 |
| V3 | 정상 F | `exp` 지난 AT | 401 `MOBILE_TOKEN_EXPIRED` | 없음 | 변화 없음 | 없음 | 토큰 |
| V4 | 정상 F | `iss`/`aud`가 다른 환경의 AT | 401 `MOBILE_TOKEN_INVALID` | 없음 | 변화 없음 | 없음 | 기대 iss/aud |
| V4b | 정상 F | `tkn`이 `tomverse-mobile-access`가 아닌 토큰(예: grant) | 401 | 없음 | 변화 없음 | 없음 | 토큰 |
| V4c | 정상 F | `iat`·`jti` 없는 토큰 / `exp <= iat` | 401 | 없음 | 변화 없음 | 없음 | 토큰 |
| V5 | 사용자 A의 F | 사용자 B 자원에 A의 AT | 404(존재 비노출) | 없음 | 변화 없음 | 없음 | B 자원의 존재 여부 |
| V6 | D 폐기됨 | 그 D의 AT | **edge 게이트는 통과 가능, route가 401** | 없음 | 변화 없음 | 없음 | 토큰 |
| V7 | F 폐기됨 | 그 F의 RT로 refresh | 401 `MOBILE_REFRESH_REJECTED` + `reauthenticate` | 없음 | 변화 없음 | `.refresh_rejected` | RT, 폐기 사유 |
| V8 | 정상 F, 미소비 RT | refresh | 200, 새 AT+RT | 기존 행 `consumedAt`, 새 행 삽입 | F `lastRotatedAt` 갱신 | `.refreshed` | 두 RT 원문 |
| V9 | RT 이미 소비됨 | **같은 RT 재제시(secret 일치)** | 401 `MOBILE_REFRESH_REJECTED` | F `revokedAt`+`reuse_detected`, 미소비 행 전부 `invalidatedAt` | **F 폐기** | `.reuse_detected` + `.family_revoked` | RT, digest |
| **V24** | 정상 F, **미소비** RT | 유효한 `recordId` + 틀린 secret | 401 `MOBILE_REFRESH_REJECTED` | **없음** | **F 무변경** | `.refresh_rejected` | `recordId`, secret |
| **V24b** | **`consumedAt`이 있는** 레코드 | 그 `recordId` + **틀린 secret** | 401 `MOBILE_REFRESH_REJECTED` | **없음** | **F 무변경 — 폐기되지 않음** | `.refresh_rejected` | `recordId`, secret |
| **V24c** | **`invalidatedAt`이 있는** 레코드 | 그 `recordId` + **틀린 secret** | 401 `MOBILE_REFRESH_REJECTED` | **없음** | **F 무변경 — 폐기되지 않음** | `.refresh_rejected` | `recordId`, secret |
| **V24d** | 존재하지 않는 `recordId` | 임의 secret | 401 `MOBILE_REFRESH_REJECTED` | 없음 | F 무변경 | `.refresh_rejected` | `recordId` |
| **V25** | RT 이미 소비됨 | 재사용(V9와 동일) | 401 | **폐기 트랜잭션이 커밋됨** | 재조회 시 F가 실제로 폐기 상태 | `.reuse_detected` 영속 | — |
| V10 | 미소비 RT | **동시 refresh 2건** | **§4 승인안에 따름.** A: 하나 200 / 하나 401 + F 폐기. B: 하나 200 / 같은 key면 200(B-2는 새 후속) | A: V9와 동일 | A: F 폐기 | A: `.reuse_detected` | RT, idempotency key |
| V11 | 회전 성공, 응답 유실 | 같은 RT 재시도 | **§4 승인안에 따름** — A에서는 V9와 구분 불가 | 위와 같음 | 위와 같음 | 위와 같음 | RT |
| V12 | 정상 F | logout(**RT 본문**) | 204 | 그 F `revokedAt` | 그 F만. **다른 F·웹 cookie 세션 영향 없음** | `.logged_out` | RT |
| **V28** | 정상 F, **AT 만료** | logout(RT 본문) | 204 | 그 F `revokedAt` | 동일 | `.logged_out` | RT |
| V13 | F 둘 | 기기 1에서 기기 2 해제 | 204 | 기기 2의 F `revokedAt` | 기기 1 정상 | `.device_revoked` | 기기 2 토큰 |
| V14 | F 여럿 | 계정 삭제 | 204 | **같은 트랜잭션**에서 device·family·rotation 제거 + `sessionsRevokedAt` | 전부 폐기 | `.revoked_on_account_deletion` | 어떤 토큰도 |
| V15 | 서명 키 회전 직후 | 이전 키 서명 AT | 200(유예 내) / 401(경과 후) | 없음 | 변화 없음 | 없음 | 키 |
| V16 | 웹 로그인 | cookie만, `POST` | 현행 그대로 | 없음 | — | 없음 | — |
| V17 | 앱, **등재 route** | bearer만 | 200 (route 판정) | 없음 | — | 없음 | AT |
| V18 | 둘 다, 같은 subject | cookie + 유효 bearer | 200. 신원 = 토큰, **cookie는 파싱되지 않음** | 없음 | — | 없음 | AT |
| V19 | 둘 다, bearer 무효 | cookie + 무효 bearer | **401**. fallback 없음 | 없음 | — | 없음 | AT |
| V20 | hostile origin | 위조 bearer | 401, **ACAO 없음** | 없음 | — | 없음 | AT |
| V21 | native origin | 위조 bearer | 401 | 없음 | — | 없음 | AT |
| V22 | 아무거나 | `x-tomverse-auth-subject` 위조 동봉 | 헤더 **삭제됨**, 그 밖에는 다른 벡터와 동일 | 없음 | — | `client_sent_internal_auth_header`(이름만) | 위조된 값 |
| V23 | 둘 다, subject 불일치 | cookie(A) + 유효 bearer(B) | **200, 신원 = B.** D13이 cookie를 해석하지 않으므로 모호가 발생하지 않음 | 없음 | — | 없음 | A의 subject |
| **V26** | — | `/api/internal/maintenance/cleanup`에 **운영 비밀값 bearer** | **200 (기존 그대로)** | 기존 동작 | — | 기존 | 비밀값 |
| **V26b** | — | 같은 route에 **유효한 모바일 AT** | **401 (route 자신의 검사)** — N1b가 관여하지 않음 | 없음 | — | 없음 | AT |
| **V27** | 앱, **미등재 route** | 유효 모바일 bearer + `POST` | **403 `INVALID_REQUEST_ORIGIN`** — N1b 미적용 | 없음 | — | 없음 | AT |
| **V29** | 정상 F. 무효화 조회를 **인위적으로 지연**시킨 상태에서 그 사이에 취소 발생 | 지연이 끝난 뒤 인가가 필요한 요청 | **승인된 상한 N초를 넘겨 통과하지 않음** | 낡은 결과가 캐시에 **덮어쓰지 못함** | 취소가 관측됨 | — | — |
| **V30** | `aud`가 `mobile-api`인 배포 | `aud`가 `"mobile-api-other"`인 AT | **401** — 부분 문자열 통과 금지 | 없음 | 변화 없음 | 없음 | 토큰 |
| **V31** | 같음 | `aud`가 `["other", "mobile-api"]` 배열인 AT | **200** — 배열 원소 정확 일치 | 없음 | 변화 없음 | 없음 | 토큰 |

**V10·V11이 §4의 승인 없이는 기대값을 쓸 수 없다는 사실이 §4를 별도 항목으로 둔
이유입니다.** "승인안에 따름"은 미완성이 아니라, 사람이 정하기 전에 정해진 척하지
않는다는 뜻입니다.

**rev.2가 추가한 벡터**: V4b·V4c(claim 검증), V24(틀린 secret이 family를 죽이지
않음), V25(폐기가 커밋됨), V26·V26b(내부 route 불변), V27(미등재 route 불변),
V28(만료된 AT로도 로그아웃).

**rev.3이 추가한 벡터**: V24b·V24c·V24d, V29, V30·V31.

V24b·V24c가 **rev.3의 요점**입니다. rev.2의 V24는 사전 상태가 **미소비** RT라서,
D5가 막으려는 바로 그 분기 — *소비·폐기된 레코드를 secret 비교 없이 재사용으로
판정해 family를 죽이는 것* — 을 **지나지 않습니다.** 계약은 D5에서 맞게 썼지만
벡터가 그 계약의 위험한 가지를 따라가지 못했습니다. V24b·V24c는 정확히 그 가지에
들어가서, **secret이 틀리면 소비된 레코드였더라도 family가 살아남는 것**을
고정합니다. 이 둘이 없으면 D5의 순서를 뒤집은 구현이 테스트를 통과합니다.

---

## 8. 승인과 후속 작업 경계

### 8.1 승인란

> **이 패킷을 작성한 에이전트는 아래를 채우지 않았고, 승인 상태를 추정하지도
> 않았습니다.** registry의 `approvalPolicy.independentReviewerRule`에 따라 승인자는
> 증거를 만든 주체가 아닌 사람이어야 합니다.

| 역할 | 판정 | 서명 | 날짜 |
|---|---|---|---|
| Backend/AI | ☐ approve ☐ approve with conditions ☐ reject | | |
| Mobile/Release | ☐ approve ☐ approve with conditions ☐ reject | | |

**§4의 택일 (필수):** ☐ A ☐ B-1 ☐ C  *(B-2는 rev.3에서 보류 — §4.3의 반례)*

**조건 (approve with conditions인 경우):**

```
(작성란)
```

**미결정 사항 — 승인 시 함께 답해야 하는 것:**

| # | 미결정 | 어디 | rev |
|---|---|---|---|
| 1 | access TTL과 skew | D3 | 1 |
| 2 | refresh idle / absolute | D4 | 1 |
| 3 | 이전 서명 키·pepper 유예 기간 | D6 | 1 |
| 4 | 동시 회전 정책 (A / B-1 / C) | §4 | 1 |
| 5 | B안이면 창 길이와 **정책 문서 개정** | §4.3 | 1 |
| 6 | 취소 관측 상한 **N** — 그리고 D12의 1~3(기준 시점·경합·V29)으로 그 N을 참으로 만드는 것 | D12 | 1·3 |
| 7 | rate limit 수치 | D15 | 1 |
| 8 | 기기 목록에 IP를 넣을지 | D16 | 1 |
| 9 | audit 보관 기간과 `deletionAction` | §6.5 | 1 |
| ~~10~~ | ~~Edge의 Ed25519 가용 여부~~ | ~~D1~~ | **해소** — Node.js 런타임 |
| **11** | **JWT vs 불투명 토큰** — rev.3에서 근거가 더 좁아졌습니다. 비교는 **모바일 요청당 왕복 하나 vs 즉시 취소**입니다 | D1 | 2·3 |
| **12** | **서명 비밀키를 실제로 격리 배포할지** — 아니면 HS256이 정직합니다 | D1 | 2 |
| **13** | **N1b 초기 등재 route 목록** — 어느 route를 먼저 전환할지 | D18 | 2 |
| **14** | **`grant` 수명과 client 결속 방식** | D14.1 | 2 |
| **15** | **재설치 시 이전 family를 이어받을지** | D17 | 2 |
| **16** | `AUTH-03` 증거에 "refresh가 WebView에 없음"을 넣을지 | D19 | 2 |
| **17** | **B-2를 되살릴지** — 되살리려면 지연 요청·응답 유실·후속 사용까지 포함한 상태 전이의 정의와 검증이 먼저입니다(§4.3) | §4.3 | 3 |
| **18** | `lib/sessionSecurity.ts`의 같은 staleness 성질을 **웹 경로에서도** 고칠지 — 별도 작업 | D12 | 3 |

**승인 SHA:** `______________` **날짜:** `__________`

### 8.2 작업 경계

| 단계 | 허용 조건 |
|---|---|
| **N2 구현** | 위 승인란이 채워진 뒤. Prisma migration, 토큰 발급·검증, endpoint, native bridge, 테스트 |
| **N1b** | **아래 네 가지를 전부 충족한 뒤에만** |
| **여전히 별개** | production 활성화 · 실기기 판정(`AUTH-01`·`AUTH-04`) · R2의 `capacitor://` CORS 확인 |

**N1b의 선행 조건 (rev.2에서 넷으로 늘어남):**

1. §5.2의 검증 함수가 **존재**한다.
2. §5.5의 순서대로 **mutation-origin 검사보다 먼저** 실행된다.
3. §7의 V17~V23, **V26·V26b·V27**, 그리고 **V24b·V24c·V29~V31**이 통과한다.
4. **(rev.2 신설)** 등재하려는 각 route에 대해 **신원 해석과 소유권 검사가 bearer
   기준으로 전환됐다는 증거**가 있다 — `getServerSession`으로 cookie 신원을 읽지
   않으며, 그 사실을 고정하는 테스트가 있다(D18). **증거 없는 route는 등재하지
   않습니다.**

4번이 rev.2의 핵심입니다. 1~3만으로 N1b를 열면 검증기는 옳게 동작하면서
**앞은 bearer, 뒤는 cookie**인 route가 생깁니다(T14).

### 8.3 정책 문서와 registry에 대해

- docs/policy/tomverse-chat-mobile-authentication.md의 Status는
  `draft for Phase 0 approval` **그대로입니다.**
- docs/release-gates/tomverse-chat-v1.yaml의 `AUTH-01`~`AUTH-04`·`PRIVACY-01`의
  `status`·`approvedBy`·`evidenceRefs`를 **건드리지 않았습니다.**
- §4에서 B 또는 C가 승인되면 **정책 문서 개정이 구현보다 먼저**입니다.
- D14가 `EXEMPT_MUTATION_PATHS`에 세 경로를 추가하자고 제안하지만, **이 패킷은
  `lib/requestOrigin.ts`를 수정하지 않았습니다.** 승인 후 N2 구현의 일부입니다.
