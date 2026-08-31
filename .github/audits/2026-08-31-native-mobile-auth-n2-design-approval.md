# N2 — 모바일 bearer 인증 설계 승인 패킷

- 대상: `mposition/Tomverse` `develop`
- **기준 HEAD: `1ee77933dc3ff34d9a3d720446629fbc86751e25`** (`1ee7793`, 2026-08-31)
- 산출물: 이 문서 하나. **코드·Prisma schema·migration·API route·테스트·feature
  flag·production 설정을 만들거나 바꾸지 않았습니다.**
- 정책 문서 `docs/policy/tomverse-chat-mobile-authentication.md`의 Status는
  `draft for Phase 0 approval` **그대로 두었습니다.** release-gate registry의
  `status`·`evidenceRefs`도 건드리지 않았습니다.
- 선행 문서: `.github/audits/2026-08-30-native-mobile-readiness.md` §3.1·§6.1·§6.2

> **이 패킷이 하는 일.** 승인 가능한 보안 설계를 제시하고, **사람이 결정해야 하는
> 항목을 결정으로 남겨 두는 것**입니다. TTL·grace window 같은 숫자는 권장값과
> 대안을 제시하되 확정하지 않았습니다. §8의 승인란은 비워 두었고 대신 채우지
> 않았습니다.

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

### 1.1 이미 저장소에 있는, 이 설계가 새로 만들지 않는 것

새 메커니즘을 발명하기 전에 있는 것을 셌습니다. **아래 여섯은 선례이고, 설계는
가능한 한 이것들을 따릅니다** — 두 번째 방식이 생기면 두 방식이 언젠가 서로 다르게
동작합니다.

| 있는 것 | 무엇을 이미 함 | N2가 물려받는 방식 |
|---|---|---|
| `lib/sessionSecurity.ts`의 `revokeAllUserSessions` | `User.sessionsRevokedAt` epoch를 올려 그 시점 이전 발급 토큰 전부 무효화 | 계정 전체 무효화의 정본. family/device epoch를 그 **아래** 계층으로 추가 |
| `lib/sessionRevocationCore.ts` | 순수 판정, **fail-closed**(발급 시각을 못 읽으면 거절) | 같은 형태의 순수 판정 모듈로 bearer 판정 작성 |
| `lib/sessionSecurity.ts`의 15초 snapshot 캐시 | 무효화가 관측되기까지의 상한을 명시적으로 15초로 둠 | access token의 "이미 발급된 것"이 살아 있는 상한을 같은 방식으로 규정(§3의 D12) |
| `EmailLoginAttempt` (`prisma/schema.prisma`) | 원문 미저장(`codeHash`), 단일 사용(`consumedAt`), 명시적 무효화(`invalidatedAt`) | refresh credential record의 형태를 그대로 차용 |
| `lib/emailLogin.ts`의 조건부 UPDATE 소비 | `where { id, consumedAt: null }` 후 `count !== 1`이면 경쟁에서 짐 | 회전의 consume-and-mint 원자성 |
| `lib/oauthLink.ts` | 자체 OAuth2 + PKCE(S256) 클라이언트, SDK 없음 | system-browser OAuth의 서버 절반을 재사용 |
| `lib/chatAdmissionCore.ts` | 서명·subject 결속·짧은 만료를 가진 토큰의 검증 형태 | 검증 순서와 `timingSafeEqual` 사용의 선례 |
| `docs/ops/admin-audit-key-epochs.md` | 과거 키를 등재해 이전 구간을 계속 검증하는 다중 키 방식 | signing key rotation(§3의 D6) |

---

## 2. 위협 모델

### 2.1 보호 자산

| 자산 | 왜 자산인가 |
|---|---|
| 계정 자체 | 대화·첨부·크레딧·결제 이력 전부에 도달 |
| refresh token | 장수명. 이것 하나로 access token을 계속 찍어 냄 |
| access token | 단수명이지만 유효한 동안 모든 API |
| 기기 목록 | 사용자의 기기 보유 이력. 그 자체가 개인정보 |
| 서명 키·pepper | 유출되면 임의 토큰 위조 또는 digest 역산 시도 |
| 크레딧 잔액 | 탈취 세션이 소비 가능. 금전 |
| 심사 계정 자격증명 | docs/ops/tomverse-chat-store-review.md §2 |

### 2.2 trust boundary

```
[사용자 기기]
  Keychain/Keystore  ──(1)──  WebView JS 컨텍스트  ──(2)──  기기 OS/네트워크
                                      │
                                     (3)
                                      ▼
[Cloudflare] ─(4)─ [proxy.ts / Edge] ─(5)─ [route handler / Node] ─(6)─ [Postgres]
```

- **(1)** 이 경계가 이 설계의 핵심입니다. refresh token은 (1)의 안쪽에만 있고,
  access token은 (1)을 넘어 WebView 메모리에 있되 **저장되지 않습니다.**
  `localStorage`는 (2)의 어떤 주입 스크립트도 읽으므로 금지입니다.
- **(3)** 여기서 origin이 `capacitor://localhost` 또는 `https://localhost`가 됩니다.
  **origin은 credential의 진위를 말하지 않습니다.**
- **(4)** host allowlist와 Cloudflare origin secret. N1a·N1b 모두 이 **뒤**입니다.
- **(5)** N1b가 사는 자리. 여기서 검증되지 않으면 N1b는 성립하지 않습니다(§5).
- **(6)** family·device·rotation 레코드.

### 2.3 공격자와 영향

| # | 공격자 / 사건 | 얻는 것 | 성공 시 영향 | 설계상 방어 | 탐지 신호 |
|---|---|---|---|---|---|
| T1 | **탈취된 access token** | 메모리 덤프, 로그 유출, 중간자 | access TTL 동안 그 계정 전권 | 짧은 TTL(D3), 토큰을 로그·응답에 절대 남기지 않음(D15), 무효화 epoch 확인(D12) | 평소와 다른 IP/UA에서 같은 `jti`·`did` |
| T2 | **탈취·복제된 refresh token** | 기기 탈취, 백업 유출, Keystore 우회 | 영구 접근. **가장 큰 위협** | 회전(D7), 재사용 탐지(D8), idle/absolute 만료(D4), 원문 미저장(D5) | `reuse_detected` audit event |
| T3 | **악성 WebView 스크립트 / XSS** | CSP 우회, 3자 스크립트 | 메모리의 access token 탈취. refresh는 **못** 읽음 | refresh는 native 저장소에만, JS에서 접근 불가한 bridge 경유(D16) | CSP 위반 리포트, 비정상 refresh 빈도 |
| T4 | **`https://localhost`를 주장하는 로컬 프로세스** | 사용자 기기의 아무 프로세스 | 그 origin으로 API 호출 가능 | **origin은 인증이 아님.** credentialed CORS 공유 없음, 서버가 인증·권한·CSRF 독립 검사 | 해당 origin에서의 401 급증 |
| T5 | **hostile web origin** | 피싱 페이지 | 사용자의 브라우저로 API 호출 시도 | ACAO 미발급(N1a), cookie 경로는 mutation-origin 검사 유지 | 브라우저 CORS 실패는 서버에 안 보임 → 401/403 비율로만 관측 |
| T6 | **분실·판매된 기기** | 기기 물리 소유 | 그 기기의 family 전권 | 기기별 해제(D11), 사용자에게 기기 목록 제공 | 사용자 신고 — **자동 탐지 불가.** 그래서 UI가 방어의 일부 |
| T7 | **refresh 응답 유실 + 클라이언트 재시도** | 네트워크 | (정상 사용자) 세션이 파괴될 수 있음 | **§4의 승인 대상.** 조용히 완화하지 않음 | `reuse_detected` 중 재로그인으로 이어진 비율 |
| T8 | **동시 실행된 refresh 요청** | 앱의 병렬 요청 | T7과 같은 모양 | 같음 — §4 | 같음 |
| T9 | **client가 위조한 내부 identity/device 헤더** | 아무 클라이언트 | 신원 사칭 | proxy가 내부 namespace를 **무조건 삭제한 뒤** 성공 시에만 기록(D2, §5) | 요청에 내부 헤더가 실려 온 사실 자체를 기록 |
| T10 | **cookie와 bearer 동시 요청** | 브라우저 + 앱 혼합, 또는 공격 | 어느 신원으로 판정되는지 모호 | fail-closed 규칙(D13) | `AUTH_AMBIGUOUS` 카운트 |
| T11 | **잘못된 iss/aud/sub/did/fid/kid 토큰** | 다른 환경의 토큰, 위조 시도 | 환경 간 토큰 재사용 | 검증 순서에 전부 포함(§5) | 실패 사유별 카운터 |
| T12 | **서명 키 유출** | 인프라 침해 | 임의 토큰 위조 | 비대칭 서명 시 edge는 공개키만 보유(D1), 키 회전(D6) | 정상 발급되지 않은 `jti` |

---

## 3. 승인 결정표

상태는 전부 **`proposed`** 입니다. 이 패킷은 승인을 기록하는 문서가 아니라
요청하는 문서입니다.

---

### D1. access token 형식과 서명 알고리즘

| | |
|---|---|
| **권장** | JWS 압축 직렬화(JWT), **EdDSA(Ed25519)**, `kid` 헤더 필수, `alg` **고정 검증**(토큰이 주장하는 alg를 신뢰하지 않음), `typ: "tomverse-mobile-access+jwt"` |
| **대안 A** | HS256(HMAC). 구현이 단순하고 Edge 지원이 확실 |
| **대안 B** | 불투명 토큰 + 서버 조회. 즉시 무효화가 공짜 |
| **trade-off** | EdDSA는 **검증자가 공개키만 보유**하므로 edge가 침해돼도 토큰을 찍어 낼 수 없습니다(T12). HS256은 검증자가 곧 발급 가능자입니다. 대안 B는 무효화가 완벽하지만 **edge에서 DB에 닿을 수 없으므로** §5의 실행 순서를 만족하지 못합니다 — N1b가 route로 밀려나고, 그러면 mutation-origin 검사보다 늦어 성립하지 않습니다 |
| **검증 필요** | Ed25519가 이 배포의 Edge runtime WebCrypto에서 실제로 쓸 수 있는지는 **구현 시점에 실측해야 합니다.** 이 패킷은 그것을 가정하지 않으며, 불가하면 대안 A로 승인 항목을 되돌립니다 |
| **막히는 후속** | 전부. 형식이 없으면 검증자도 없고 N1b도 없습니다 |
| **최종 승인자** | Backend/AI + Mobile/Release (공동) |
| **상태** | `proposed` |

---

### D2. verifier 실행 위치와 route까지 identity를 전달하는 방식

| | |
|---|---|
| **권장** | **이중 검증.** ① `proxy.ts`가 Edge에서 검증해 **N1b 게이트 판정에만** 사용하고, ② route는 같은 `Authorization` 토큰을 **독립적으로 다시 검증**해 인가에 사용합니다. proxy는 내부 identity 헤더를 정보 전달용으로만 설정하고, route는 그것을 **신뢰하지 않습니다** |
| **대안 A** | proxy만 검증하고 route는 내부 헤더를 신뢰 |
| **대안 B** | route만 검증. proxy는 관여하지 않음 |
| **trade-off** | 대안 A는 헤더 위조 방어를 proxy의 삭제 로직 **하나**에 겁니다. 그 한 줄이 빠지면 T9가 성립합니다. 대안 B는 §5의 실행 순서를 만족하지 못해 **N1b가 불가능**합니다. 권장안은 서명 검증을 요청당 두 번 하지만, 대칭키 HMAC/Ed25519 검증은 DB 왕복이 없어 비용이 작고, "헤더를 신뢰하는가"라는 질문 자체를 없앱니다 |
| **필수 부수 조건** | proxy는 내부 identity namespace(예: `x-tomverse-auth-*`)를 **검증 전에 무조건 삭제**합니다. 성공했을 때만 다시 씁니다. 정적 검사와 테스트로 고정합니다(§7 V21) |
| **막히는 후속** | N1b, 그리고 모든 route의 신원 해석 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D3. access token 수명과 clock skew

| | |
|---|---|
| **권장** | 수명 **10분**, skew 허용 **±60초**(`exp`·`nbf`·`iat` 모두) |
| **대안** | 5분(무효화 지연 절반, refresh 트래픽 2배) / 15분(반대) |
| **trade-off** | 이 값이 곧 **취소된 세션이 살아 있는 상한**입니다(D12와 함께 읽습니다). 짧을수록 T1·T6의 피해 창이 작아지고 refresh 경합(§4)이 잦아집니다 |
| **근거 수준** | **측정값 아님.** 운영 트래픽이 없으므로 어느 값도 근거가 없고, 이것이 승인 대상인 이유입니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D4. refresh token idle / absolute 수명

| | |
|---|---|
| **권장** | idle **30일**, absolute **180일** |
| **대안** | idle 14일 / absolute 90일 (보안 우선) · idle 60일 / absolute 365일 (UX 우선) |
| **trade-off** | absolute가 길수록 T2의 가치가 커집니다. 짧을수록 정상 사용자가 재로그인하고, 이 앱에는 password가 없으므로 재로그인은 **메일 왕복 또는 OAuth 왕복**입니다 — 그 비용을 UX 쪽에 정확히 계산해 넣어야 합니다 |
| **최종 승인자** | Mobile/Release (UX 비용 소유) + Backend/AI |
| **상태** | `proposed` |

---

### D5. refresh token 원문 비저장과 digest 방식

| | |
|---|---|
| **권장** | 토큰 = `<recordId>.<secret>`. `recordId`는 조회용 불투명 id, `secret`은 **256비트 CSPRNG**. 저장은 `HMAC-SHA256(pepper, secret)` digest 하나뿐이고 **원문은 어디에도 남기지 않습니다.** 비교는 상수 시간 |
| **대안** | digest만 저장하고 digest로 조회(id 없음) |
| **trade-off** | id 분리는 조회를 인덱스 한 번으로 끝내고, digest를 **조회 키가 아니라 비교 대상**으로 만듭니다. digest 조회 방식은 인덱스가 곧 비밀의 함수가 되어 DB 유출 시 대조 표적이 됩니다 |
| **선례** | `EmailLoginAttempt.codeHash`, `lib/emailLogin.ts`의 `hmacHex` |
| **금지** | 원문·digest·`secret` 조각을 로그·응답·audit payload·오류 메시지에 넣지 않습니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D6. signing / digest key rotation과 이전 키 검증 기간

| | |
|---|---|
| **권장** | JWT `kid` 기반 keyring. 서명은 항상 현재 키, 검증은 **현재 + 등재된 이전 키**. 이전 서명 키 허용 기간 = **access token 수명 + skew 이상**(권장 15분). refresh **pepper**는 별개이며, 회전 시 이전 pepper를 **idle 수명 동안** 검증에 유지하거나 다음 회전에서 재계산 |
| **대안** | 서명 키와 pepper를 한 값에 묶음(단순하나 회전 비용이 결합) |
| **trade-off** | 두 키의 회전 주기가 다릅니다. 서명 키는 분 단위 유예로 충분하고, pepper는 **살아 있는 refresh 전부**에 걸립니다 — 이 비대칭을 놓치면 pepper 회전이 전 사용자를 로그아웃시킵니다 |
| **선례** | docs/ops/admin-audit-key-epochs.md의 다중 키 검증 |
| **미결** | 이전 pepper를 얼마나 오래 유지할지, 아니면 회전을 "다음 refresh에서 재계산"으로 흡수할지 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D7. refresh 회전의 원자적 consume-and-mint 트랜잭션

| | |
|---|---|
| **권장** | 한 트랜잭션 안에서 순서대로: ① family 행 잠금(advisory 또는 `FOR UPDATE`), ② **조건부 UPDATE**로 제시된 rotation 레코드 소비 — `where id = ? AND consumedAt IS NULL AND invalidatedAt IS NULL AND expiresAt > now()` — 영향 행이 정확히 1이 아니면 즉시 실패, ③ 후속 rotation 레코드 삽입, ④ family `lastRotatedAt` 갱신 |
| **대안** | 낙관적 버전 컬럼 |
| **trade-off** | 조건부 UPDATE는 이 저장소가 이미 두 곳에서 쓰는 방식입니다(`lib/emailLogin.ts`의 소비, `ChatRequestLease`의 claim). 새 방식을 만들 이유가 없습니다 |
| **잠금 순서** | 이 경로는 **크레딧을 건드리지 않으므로** docs/policy/credit-and-cost-limits.md §9의 1번(`lockCreditAccount`)을 건너뜁니다. 다만 **그 순서를 뒤집지 않습니다** — 인증 트랜잭션 안에서 크레딧을 만지지 않습니다 |
| **금지** | 판정과 소비를 다른 트랜잭션으로 나누지 않습니다. 나누면 §4가 설계가 아니라 사고가 됩니다 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D8. retired token 재사용 시 family 무효화 시맨틱

| | |
|---|---|
| **권장** | 제시된 레코드가 존재하되 `consumedAt IS NOT NULL` 또는 `invalidatedAt IS NOT NULL`이면 → **family 전체 무효화**: family에 `revokedAt`·`revokedReason = "reuse_detected"` 기록, 그 family의 미소비 rotation 전부 `invalidatedAt` 설정, family epoch 상승(D12) |
| **정책 대조** | 이것이 docs/policy/tomverse-chat-mobile-authentication.md "Token lifecycle"이 **문자 그대로 요구하는 것**입니다 |
| **부작용** | 그 기기는 재로그인해야 합니다. 다른 기기의 family는 **영향 없음** |
| **§4와의 관계** | §4가 승인하는 안에 따라 "재사용"의 정의가 달라집니다. **D8은 그 정의를 받아 적용하는 규칙이고, 정의 자체는 §4의 승인 대상입니다** |
| **최종 승인자** | Backend/AI + Mobile/Release |
| **상태** | `proposed` |

---

### D9. 동시 refresh 두 건의 정확한 결과

**§4로 분리했습니다.** 정책 변경 여부가 걸린 유일한 항목이므로 결정표 한 줄로
줄이지 않습니다.

| **상태** | `proposed` — §4 참조 |
|---|---|

---

### D10. 응답 유실 후 동일 요청 재시도

**§4로 분리했습니다.** D9와 같은 결정의 다른 얼굴입니다.

| **상태** | `proposed` — §4 참조 |
|---|---|

---

### D11. logout · 기기 해제 · 계정 삭제 · 재사용 탐지의 무효화 범위

| 사건 | 무효화 범위 | 다른 기기 | 웹 cookie 세션 |
|---|---|---|---|
| **logout**(그 기기) | 그 device의 family 하나 | 영향 없음 | **영향 없음** |
| **기기 해제**(다른 기기에서) | 지정한 device의 family | 영향 없음 | 영향 없음 |
| **재사용 탐지** | 그 family 하나 | 영향 없음 | 영향 없음 |
| **전체 로그아웃**(사용자 요청) | 모든 family | 전부 | **전부** — `revokeAllUserSessions` 동반 |
| **계정 삭제** | 모든 family + 모든 device 레코드 | 전부 | 전부 |
| **계정 정지** | 모든 family | 전부 | 전부(기존 `accountStatus` 경로) |

| | |
|---|---|
| **권장** | 위 표. 핵심은 **"기기 하나를 잃었다고 웹 세션까지 끝나지 않는다"** 이고, 이는 정책의 revocation 논거 3번입니다 |
| **필수** | 계정 삭제는 `lib/accountDeletion.ts`의 **같은 트랜잭션 안에서** family·device·rotation을 지웁니다. 별도 정리 작업으로 미루지 않습니다 — `PRIVACY-01`이 "모든 device family revoke"를 삭제 E2E의 증거로 이름 댑니다 |
| **필수** | 새 테이블 셋은 **등재 없이 추가할 수 없습니다.** docs/policy/tomverse-chat-data-domain-registry.yaml에 행이 없으면 `npm run check:data-domain-registry`가 실패합니다 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D12. 이미 발급된 access token의 최대 잔여 유효 시간

| | |
|---|---|
| **권장** | **두 층.** ① **edge(N1b 게이트)**: 서명·만료만 봅니다. 즉 무효화된 세션의 access token도 `exp`까지 게이트를 통과할 수 있습니다 — **게이트는 인가가 아닙니다.** ② **route(인가)**: 기존 `readSessionSecuritySnapshot` 패턴을 확장해 `User.sessionsRevokedAt` + family/device epoch를 확인하고 **짧은 캐시**(현행 15초)를 둡니다. 그러므로 실제 상한 = **캐시 TTL(15초)**, 최악 = access TTL |
| **대안** | route에서 매 요청 무캐시 조회(상한 0초, DB 부하 증가) / edge에서만 판정(불가 — DB 미도달) |
| **trade-off** | 15초는 임의값이 아니라 **이미 웹 세션이 감수하고 있는 값**입니다(`lib/sessionSecurity.ts`의 `SNAPSHOT_TTL_MS`). 모바일에 다른 값을 주려면 왜 다른지를 적어야 합니다 |
| **명시할 것** | 승인되면 "취소가 관측되기까지 최대 15초"가 **문서화된 계약**이 됩니다. 그 문장을 쓸 수 없다면 값을 바꿔야 합니다 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D13. cookie와 bearer 혼합 / bearer 실패 시 fail-closed 규칙

| | |
|---|---|
| **권장** | `Authorization` 헤더가 **있으면 그 요청은 bearer 요청**입니다. 그 순간 cookie 신원은 **완전히 무시**됩니다. bearer 검증 실패 → **401**, cookie로의 fallback **없음**. 둘 다 유효하고 subject가 다르면 → **401 모호**(`MOBILE_AUTH_AMBIGUOUS`), 어느 쪽도 고르지 않습니다 |
| **대안** | bearer 실패 시 cookie로 fallback(편의) |
| **trade-off** | 대안은 **공격자가 임의의 잘못된 bearer를 붙여 판정 경로를 고를 수 있게** 합니다. 그리고 bearer 경로는 CSRF 검사를 대체하므로(N1b), fallback은 "잘못된 bearer를 붙이면 CSRF 검사가 사라진 cookie 요청"이 됩니다 — 정확히 §5가 금지하는 것 |
| **최종 승인자** | Backend/AI |
| **상태** | `proposed` |

---

### D14. endpoint 요청/응답 계약

| endpoint | 인증 수단 | 요청 | 성공 응답 | 비고 |
|---|---|---|---|---|
| `POST …/mobile/exchange` | OAuth code + PKCE verifier, **또는** 검증된 email OTP/magic-link 증표 | `{ grant, deviceLabel? }` | `{ accessToken, expiresIn, refreshToken, deviceId }` | 기존 `lib/emailLogin.ts` 정책(TTL·lockout·Turnstile)을 **그대로** 통과한 뒤에만 발급 |
| `POST …/mobile/refresh` | refresh token(본문) | `{ refreshToken }` | `{ accessToken, expiresIn, refreshToken }` | §4의 승인안이 이 응답의 재시도 의미를 정합니다 |
| `POST …/mobile/logout` | refresh token 또는 access token | `{ }` | `204` | 그 family만 |
| `GET …/mobile/devices` | access token | — | `{ devices: [...] }` | D16의 최소 필드만 |
| `POST …/mobile/devices/{id}/revoke` | access token | — | `204` | 자기 계정의 device만. 남의 id는 **404**(존재 여부를 알리지 않음) |

**부트스트랩 문제와 그 해법 — 승인 필요.** `exchange`와 `refresh`는 **N1b가 있기
전에** native에서 도달할 수 있어야 합니다. 그런데 둘 다 `POST`이므로 현재
`proxy.ts`의 mutation-origin 검사에서 403입니다.

- **권장**: 이 두 경로를 `lib/requestOrigin.ts`의 `EXEMPT_MUTATION_PATHS`에
  **명시적으로 추가**합니다. 그 목록의 규칙은 이미 "Origin 헤더를 보낼 수 없고,
  Origin보다 강한 것으로 인증되는 호출자"이며, refresh token과 OAuth code+PKCE는
  정확히 그것입니다 — **ambient credential이 아니므로 CSRF의 전제가 성립하지
  않습니다.**
- **조건**: 이 두 경로는 **cookie 신원을 절대 받지 않습니다.** 본문/헤더의
  비-ambient credential만 봅니다. 이 조건이 깨지면 예외가 곧 CSRF 구멍입니다.
- **대안**: N1b를 먼저 만들어 부트스트랩까지 덮게 한다 → **거부합니다.** N1b는
  검증된 bearer가 전제인데 `exchange`는 아직 bearer가 없는 요청입니다.

| **최종 승인자** | Backend/AI + Security/Privacy |
|---|---|
| **상태** | `proposed` |

---

### D15. rate limit · 오류 코드 · audit event · 구조화 로그와 redaction

| | 권장 | 비고 |
|---|---|---|
| **rate limit** | `refresh`: device당 분 20 / 일 500. `exchange`: 계정당 분 5 / 일 20(기존 `consumeApiRateLimit` 사용). IP 층은 기존 정책 유지 | 숫자는 **승인 대상**. §4가 B안이면 refresh 한도가 낮아도 됩니다 |
| **오류 코드(클라이언트)** | `MOBILE_TOKEN_INVALID`, `MOBILE_TOKEN_EXPIRED`, `MOBILE_REFRESH_REJECTED`, `MOBILE_AUTH_AMBIGUOUS`, `MOBILE_RATE_LIMITED` | **재사용 탐지는 별도 코드를 주지 않습니다.** 만료·위조·재사용이 전부 `MOBILE_REFRESH_REJECTED`에 `reauthenticate: true`로 합쳐집니다 — 정확한 사유는 audit에만. `PRIVACY-02` 증거의 "single refusal message shared by every refusal reason"과 같은 이유 |
| **audit event** | `mobile_auth.exchanged`, `.refreshed`, `.reuse_detected`, `.family_revoked`, `.device_revoked`, `.logged_out`, `.revoked_on_account_deletion` | `lib/securityAudit.ts`의 기존 경로 사용. 새 로깅 계층을 만들지 않습니다 |
| **구조화 로그 필드** | `event`, `userId`, `deviceId`, `familyId`, `outcome`, `reason`, `kid`, `tokenAgeSeconds` | 전부 서버가 고른 값이거나 계산된 숫자 |
| **절대 금지** | access token, refresh token 원문·조각·digest, `Authorization` 헤더 값, pepper, 서명 키, OAuth code, PKCE verifier, email OTP, magic-link token | Voice 정책 §11.2와 store review §3이 같은 규칙을 이미 씁니다 |
| **최종 승인자** | Backend/AI + Security/Privacy |
| **상태** | `proposed` |

---

### D16. device record 필드와 개인정보 최소화

| | |
|---|---|
| **권장** | 사용자에게 보이는 것: 사용자가 붙인 이름(편집 가능), **거친 플랫폼 라벨**(`ios` / `android`), 앱 버전, 마지막 사용 시각, 등록 시각 |
| **수집하지 않음** | 모델명 상세, OS 빌드 번호, 광고 식별자, IDFV/ANDROID_ID, 화면 크기·폰트 목록 같은 fingerprint 재료 |
| **IP** | 기기 목록에 IP를 **보이지 않는 것을 권장**합니다. 필요하다면 최근 1건만, 절삭(IPv4 /24, IPv6 /48). **승인 대상** |
| **trade-off** | IP·모델명은 "이 기기가 내 것인가"를 판단하기 쉽게 만듭니다. 동시에 계정이 침해되면 그 목록이 **사용자 위치·기기 이력**이 됩니다. 이 앱은 password가 없어 계정 탈취 경로가 메일이므로, 목록을 풍부하게 만들수록 메일 탈취의 부수 피해가 커집니다 |
| **필수** | docs/policy/tomverse-chat-data-domain-registry.yaml 등재. 보관 기간과 `deletionAction`을 각 테이블마다 적습니다 |
| **최종 승인자** | Security/Privacy + Mobile/Release |
| **상태** | `proposed` |

---

### D17. 서버 발급 random device identity — 하드웨어 fingerprint 금지

| | |
|---|---|
| **권장** | device id는 **서버가 만든 난수**이고, 앱은 refresh token과 **같은 Keychain/Keystore 항목**에 보관합니다. 앱을 지우면 사라지고, 다음 로그인은 **새 기기**가 됩니다 |
| **대안** | 플랫폼 제공 식별자(IDFV, ANDROID_ID)로 기기를 안정적으로 식별 |
| **trade-off** | 대안은 재설치 후에도 같은 기기로 인식되어 목록이 덜 지저분합니다. 대신 **삭제해도 따라오는 식별자**가 되고, 그것을 계정에 묶는 순간 App Store 개인정보 표시의 "Identifiers → Device ID"이자 5.1.2(iii)의 프로파일링 우려 대상이 됩니다 |
| **결정** | **fingerprint를 쓰지 않습니다.** 목록이 지저분해지는 비용은 사용자가 기기를 지울 수 있게 해서 갚습니다 |
| **최종 승인자** | Security/Privacy |
| **상태** | `proposed` |

---

## 4. 동시 회전 문제 — 별도 승인

**문제.** 정책은 retired refresh token 재사용을 family 전체 무효화로 처리하라고
요구합니다. 그런데 **정상 클라이언트의 동시 요청**(T8)과 **응답 유실 뒤 재시도**
(T7)가 서버에서 **똑같은 모양**으로 보입니다 — 이미 소비된 레코드의 제시.

이것을 조용히 완화하면 정책은 그대로 두고 구현만 다르게 하는 상태가 되므로,
**선택지를 명시하고 어느 것이 정책 변경인지 표시합니다.**

| 안 | 동작 | 정책 관계 | 보안 | UX |
|---|---|---|---|---|
| **A. 엄격한 1회 사용** | 소비된 토큰 제시 → 즉시 family 폐기 → 재로그인 | **정책을 문자 그대로 구현.** 변경 없음 | 최상. 창(window) 없음 | 최악. 네트워크가 나쁜 사용자가 이유 없이 로그아웃되고, 이 앱에는 password가 없어 재로그인이 메일/OAuth 왕복 |
| **B. client single-flight + 서버 제한적 idempotency** | 클라이언트가 refresh를 단일화(single-flight). 서버는 회전 시 요청의 **idempotency key**를 함께 저장하고, **같은 key + 같은 device + 짧은 창** 안의 재시도에만 **이미 발급한 동일 응답**을 재전달. 그 밖의 재사용은 A와 동일 | **정책 변경 필요.** "retired 제시 = family 무효화"에 예외가 생김 | 창 안에서도 공격자는 **retired token + idempotency key 둘 다** 필요. 훔친 토큰만으로는 못 뚫음 | 양호. 유실 재시도가 세션을 죽이지 않음 |
| **C. grace window 재전달** | retired token이 **직전 회전**이고 창 안이며 후속 토큰이 아직 미사용이면 후속을 다시 돌려줌 | **정책 변경 필요** | **B보다 약함.** 훔친 retired token만으로 창 안에서 후속 토큰 획득 가능 | B와 비슷 |

### 4.1 권장

**1순위로 A를 승인하고, 동시에 클라이언트 single-flight를 Mobile/Release의
구현 요건으로 못 박습니다.** 근거는 정책이 이미 내린 판단입니다 — "재생은 사본이
어딘가 존재한다는 뜻이고, 안전한 해석은 요청이 단지 낡았다는 것이 아니다."

**A가 현장에서 정상 사용자를 끊는 것이 관측되면 B로 갑니다.** C는 명시적으로
**권장하지 않습니다** — 창을 열면서 추가 비밀을 요구하지 않으므로, 훔친 토큰의
가치를 창 길이만큼 그대로 늘립니다.

### 4.2 A를 고르면 반드시 함께 승인해야 하는 것

- 클라이언트 single-flight가 **구현 요건**이라는 사실(권고가 아님).
- refresh 실패 시 앱이 **조용히 재시도하지 않고** 재로그인으로 보내는 UX.
- `reuse_detected` 중 **재로그인으로 이어진 비율**을 세는 지표. 이 숫자가 A의
  비용이고, B로 갈지 말지를 결정할 유일한 근거입니다.

### 4.3 B를 고르면 반드시 함께 하는 것

- **정책 문서 개정이 먼저입니다.** 구현이 정책을 앞서면 정책이 설명하지 못하는
  코드가 생깁니다.
- idempotency key는 **클라이언트가 만든 난수**이고 요청마다 새로 만들되 재시도에는
  같은 값을 씁니다. 서버는 이것을 **비밀로 취급**해 로그에 남기지 않습니다.
- 창 길이는 승인 대상(권장 10초).
- 창 밖·key 불일치·다른 device는 **전부 A와 동일하게 family 폐기**입니다.

| **최종 승인자** | Backend/AI + Mobile/Release (공동) |
|---|---|
| **상태** | `proposed` — A / B / C 중 택일이 승인 행위입니다 |

---

## 5. N1b의 정확한 대체 조건

### 5.1 절대 금지

1. `Authorization` 헤더가 **존재한다는 이유로** mutation-origin 검사를 생략.
2. 토큰 **문자열 모양**(접두사·길이·점 개수)만 검사.
3. client가 보낸 `userId`·`deviceId`·`familyId`·내부 헤더를 신뢰.
4. bearer 검증 실패 후 **cookie 신원으로 조용히 fallback**.
5. client 헤더가 proxy의 내부 identity 헤더를 **덮어쓰도록 허용**.

`proxy.ts`가 prefetch 분기에 이미 적어 둔 문장이 1번의 근거입니다 — *"gating those
on request headers would let any caller opt out of the entire edge security
layer."*

### 5.2 성립 조건 (의사 코드)

```
n1bReplacesMutationOriginCheck(request):
    # 0. 이 함수는 host allowlist와 origin-secret 검사를 이미 통과한 뒤에만 불린다.
    header = request.headers["authorization"]
    if header is absent:                      return NO      # cookie 경로로
    if not header starts with "Bearer ":      return REJECT  # 401, fallback 없음

    token = header after "Bearer "
    parsed = parseCompactJws(token)
    if parsed is malformed:                   return REJECT

    key = keyring.lookup(parsed.header.kid)   # kid 없거나 미등재면 실패
    if key is absent:                         return REJECT
    if parsed.header.alg != key.expectedAlg:  return REJECT  # 토큰이 주장하는 alg 불신

    if not verifySignature(parsed, key):      return REJECT  # ← 여기까지 오지 않으면
                                                             #   그 아래는 전부 무의미
    c = parsed.claims
    if c.typ != "tomverse-mobile-access":     return REJECT  # id token·refresh 혼용 차단
    if c.iss != EXPECTED_ISSUER:              return REJECT
    if EXPECTED_AUDIENCE not in c.aud:        return REJECT
    if now < c.nbf - SKEW:                    return REJECT
    if now >= c.exp + SKEW:                   return REJECT
    if c.sub is absent or malformed:          return REJECT
    if c.did is absent or c.fid is absent:    return REJECT

    return YES(subject = c.sub, device = c.did, family = c.fid, jti = c.jti)
```

**`YES`가 뜻하는 것과 뜻하지 않는 것.**

- 뜻하는 것: 이 요청은 **암호학적으로 검증된 모바일 bearer 요청**이므로, ambient
  credential에 의존하지 않고 따라서 CSRF의 전제가 성립하지 않습니다. mutation-origin
  검사를 **대체**합니다.
- 뜻하지 **않는** 것: 인가. 이 사용자가 이 대화를 소유하는지, 계정이 살아 있는지,
  family가 폐기됐는지, 크레딧이 있는지는 **전부 route가 다시 판정**합니다(D2·D12).

### 5.3 truth table

`/api/*`의 비-GET 요청 기준. host·origin-secret 검사는 이미 통과했다고 가정합니다.

| # | Origin | `Authorization` | bearer 검증 | cookie | mutation-origin 검사 | 결과 |
|---|---|---|---|---|---|---|
| 1 | 없음/native/web/hostile | 없음 | — | 없음 | 수행 | 403 `INVALID_REQUEST_ORIGIN` |
| 2 | 웹 정상 origin | 없음 | — | 있음 | 수행 → 통과 | route로 (**현행 그대로**) |
| 3 | hostile | 없음 | — | 있음 | 수행 → 실패 | 403 (**현행 그대로**) |
| 4 | native | 없음 | — | 있음/없음 | 수행 → 실패 | 403 (**N1a 이후 현행 그대로**) |
| 5 | native | 있음 | **통과** | 없음 | **대체됨** | route로. 신원 = 토큰 |
| 6 | native | 있음 | 실패 | 없음 | — | **401**. cookie fallback 없음 |
| 7 | native | 있음 | 실패 | 있음 | — | **401**. cookie를 쓰지 않음 |
| 8 | native | 있음 | 통과 | 있음(다른 subject) | — | **401** `MOBILE_AUTH_AMBIGUOUS` |
| 9 | native | 있음 | 통과 | 있음(같은 subject) | **대체됨** | route로. 신원 = **토큰**(cookie 무시) |
| 10 | hostile | 있음 | 실패(위조) | 있음/없음 | — | **401**. 그리고 ACAO 없음 → 브라우저가 응답을 못 읽음 |
| 11 | hostile | 있음 | **통과** | — | **대체됨** | route로. **Origin은 요구하지 않습니다** — 아래 주 참조 |
| 12 | 없음(비브라우저) | 있음 | 통과 | — | **대체됨** | route로 |
| 13 | 아무거나 | 있음 | 통과 | — | 대체됨 | 요청에 내부 identity 헤더가 실려 있어도 **삭제 후 재기록**(§5.4) |

**11번 주.** 유효한 bearer를 가진 hostile origin을 거절하지 **않습니다.** 유효한
토큰을 이미 가진 공격자는 브라우저 없이도 요청할 수 있으므로 Origin 검사는 아무것도
막지 못하고, 요구하면 Origin이 없는 정상 클라이언트만 깨집니다. **Origin은 bearer의
진위를 증명하지 않습니다.** 브라우저 안의 hostile 페이지에 대한 방어는 다른 층입니다 —
ACAO를 주지 않아 응답을 읽지 못하게 하는 것(N1a).

### 5.4 내부 identity 헤더 규칙

내부 namespace(`x-tomverse-auth-*`)는 **외부 입력에서 무조건 제거한 뒤**, 검증이
성공한 경우에만 proxy가 새로 씁니다.

```
requestHeaders = new Headers(request.headers)
for name in requestHeaders:                       # 검증보다 먼저
    if name starts with INTERNAL_AUTH_PREFIX:
        requestHeaders.delete(name)
        record("client_sent_internal_auth_header", name)   # 값은 남기지 않음

verdict = n1bReplacesMutationOriginCheck(request)
if verdict is YES:
    requestHeaders.set("x-tomverse-auth-subject", verdict.subject)
    requestHeaders.set("x-tomverse-auth-device",  verdict.device)
    requestHeaders.set("x-tomverse-auth-family",  verdict.family)
```

`set`(덮어쓰기)만으로는 부족합니다 — 검증이 **실패**했을 때 아무것도 쓰지 않으면
클라이언트가 보낸 값이 그대로 살아남습니다. 그래서 삭제가 먼저입니다.

그리고 D2에 따라 **route는 이 헤더를 신뢰하지 않습니다.** route는 같은
`Authorization` 토큰을 다시 검증합니다. 헤더는 편의이지 신뢰 근거가 아닙니다.

### 5.5 실제 실행 순서 (`proxy.ts` 호출 흐름)

N1b가 성립하려면 검증자가 **mutation-origin 검사보다 먼저** 실행되어야 합니다.
현재 파일의 실제 순서와, N2 이후의 순서입니다.

| 순서 | 현재 (`1ee7793`) | N2 이후 |
|---|---|---|
| 1 | `/api/health` 통과 | 동일 |
| 2 | `isAllowedRequestHost` + `hasRequiredOriginSecret` → 실패 시 **421** | 동일 |
| 3 | — | **내부 auth 헤더 삭제**(§5.4) |
| 4 | N1a preflight 응답(204) | 동일 |
| 5 | — | **N1b bearer 검증** → `YES` / `NO` / `REJECT`(401) |
| 6 | `requiresMutationOriginCheck` + `!hasValidMutationOrigin` → **403** | **`YES`가 아닐 때만** 수행 |
| 7 | prefetch 통과, 언어 리다이렉트, CSP, 내부 헤더 설정, 응답 | 5의 `YES`면 identity 헤더 추가 |

**검증자가 6번보다 늦으면 N1b는 성립하지 않습니다.** route에서 검증하는 설계
(D2의 대안 B)가 거부된 이유가 이것이고, 이 표가 그 이유를 실행 순서로 보인 것입니다.

---

## 6. 제안 데이터 모델 (논리 모델 — Prisma 문법 아님)

> 아래는 **논리 스키마**입니다. Prisma 모델도 migration도 작성하지 않았습니다.
> 실제 추가 시 docs/policy/tomverse-chat-data-domain-registry.yaml 등재가
> 선행 조건입니다.

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

### 6.3 `MobileRefreshRotation` (credential record)

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | 토큰의 조회용 id (토큰 앞부분) | 아니오 | 만료 후 정리 + 계정 삭제 | PK | 아니오 |
| `familyId` | 소속 | 간접 | 동일 | index | 아니오 |
| `secretDigest` | `HMAC-SHA256(pepper, secret)` | 아니오 | 동일 | unique | **아니오 — 원문 미저장** |
| `pepperKid` | D6의 pepper 세대 | 아니오 | 동일 | — | 아니오 |
| `createdAt` / `expiresAt` | 수명 | 낮음 | 동일 | `expiresAt` | 아니오 |
| `consumedAt` | 단일 사용 | 낮음 | 동일 | — | 아니오 |
| `invalidatedAt` | 명시적 폐기 | 낮음 | 동일 | — | 아니오 |
| `supersededById` | 회전 사슬 | 아니오 | 동일 | — | 아니오 |
| `idempotencyKeyDigest` | **§4에서 B안을 승인한 경우에만** | 아니오 | 동일 | — | **아니오 — 원문 미저장** |

`(id, consumedAt, invalidatedAt, expiresAt)`가 D7의 조건부 UPDATE가 읽는 조합입니다.

### 6.4 `MobileAuthEvent` (revocation / reuse audit)

| 필드 | 목적 | 개인정보 | 보관 | 인덱스 | 원문 비밀 |
|---|---|---|---|---|---|
| `id` | PK | 아니오 | **승인 대상**(권장 90일) | PK | 아니오 |
| `event` | `reuse_detected` 등 D15 목록 | 아니오 | 동일 | index | 아니오 |
| `userId` / `deviceId` / `familyId` | 대상 | 예 / 간접 / 간접 | 동일 | index | 아니오 |
| `occurredAt` | 시각 | 예 | 동일 | index | 아니오 |
| `reason` | 짧은 기계 판독 사유 | 아니오 | 동일 | — | 아니오 |

**없는 것**: 토큰, digest, 헤더 값, IP 원본, User-Agent 원문.

> **보관 기간과 계정 삭제 시 처리는 `deletionAction`을 정해야 등재됩니다.** audit을
> `retain`으로 둘지 `anonymise`할지는 Security/Privacy 결정이며, registry의
> `reidentificationReview`가 그 판단을 요구합니다.

---

## 7. 테스트 벡터

승인 후 구현 단계에서 실행할 벡터입니다. **이 패킷은 테스트 코드를 작성하지
않았습니다.**

약어: **AT** access token, **RT** refresh token, **F** family, **D** device.

| # | 사전 상태 | 요청 | 예상 status / code | DB 변화 | F / D / AT 상태 | audit event | 응답·로그에 절대 없어야 할 것 |
|---|---|---|---|---|---|---|---|
| V1 | 정상 F, 유효 AT | `POST /api/chat` + 유효 AT | 200 (route 판정) | 없음 | 변화 없음 | 없음 | AT 값 |
| V2 | 정상 F | 서명만 바꾼 AT | 401 `MOBILE_TOKEN_INVALID` | 없음 | 변화 없음 | 없음(카운터만) | 토큰, `kid` 이외 헤더 |
| V3 | 정상 F | `exp` 지난 AT | 401 `MOBILE_TOKEN_EXPIRED` | 없음 | 변화 없음 | 없음 | 토큰 |
| V4 | 정상 F | `iss`/`aud`가 다른 환경의 AT | 401 `MOBILE_TOKEN_INVALID` | 없음 | 변화 없음 | 없음 | 토큰, 기대 iss/aud |
| V5 | 사용자 A의 F | 사용자 B 자원에 A의 AT | 404(존재 비노출) | 없음 | 변화 없음 | 없음 | B의 자원 존재 여부 |
| V6 | D 폐기됨 | 그 D의 AT | 401 (edge는 통과 가능, **route가 거절**) | 없음 | 변화 없음 | 없음 | 토큰 |
| V7 | F 폐기됨 | 그 F의 RT로 refresh | 401 `MOBILE_REFRESH_REJECTED` + `reauthenticate` | 없음 | 변화 없음 | `.refresh_rejected` | RT, 폐기 사유 |
| V8 | 정상 F, 미소비 RT | refresh | 200, 새 AT+RT | 기존 행 `consumedAt` 설정, 새 행 삽입 | F `lastRotatedAt` 갱신 | `.refreshed` | 두 RT 원문 |
| V9 | RT 이미 소비됨 | **같은 RT 재제시** | 401 `MOBILE_REFRESH_REJECTED` | F `revokedAt`+`reuse_detected`, 미소비 행 전부 `invalidatedAt` | **F 폐기**, D는 남되 재로그인 필요 | `.reuse_detected` + `.family_revoked` | RT, digest |
| V10 | 미소비 RT | **동시 refresh 2건** | **§4 승인안에 따름.** A안: 하나 200 / 하나 401 + F 폐기. B안: 하나 200 / 같은 key면 200 동일 응답 | A안: V9와 동일 | A안: F 폐기 | A안: `.reuse_detected` | RT, idempotency key |
| V11 | 회전 성공했으나 응답 유실 | 같은 RT 재시도 | **§4 승인안에 따름** — A안은 V9와 구분 불가 | 위와 같음 | 위와 같음 | 위와 같음 | RT |
| V12 | 정상 F | logout | 204 | 그 F `revokedAt` | 그 F만. **다른 F·웹 cookie 세션 영향 없음** | `.logged_out` | RT |
| V13 | F 둘(기기 둘) | 기기 1에서 기기 2 해제 | 204 | 기기 2의 F `revokedAt` | 기기 1 정상 | `.device_revoked` | 기기 2의 토큰 |
| V14 | F 여럿 | 계정 삭제 | 204 | **같은 트랜잭션**에서 device·family·rotation 제거 + `sessionsRevokedAt` | 전부 폐기 | `.revoked_on_account_deletion` | 어떤 토큰도 |
| V15 | 서명 키 회전 직후 | 이전 키로 서명된 AT | 200 (유예 기간 내) / 401 (경과 후) | 없음 | 변화 없음 | 없음 | 키, `kid` 이외 |
| V16 | 웹 로그인, 앱 아님 | cookie만, `POST` | 현행 그대로(정상 origin 200 / hostile 403) | 없음 | — | 없음 | — |
| V17 | 앱 | bearer만, `POST` | 200 (route 판정) | 없음 | — | 없음 | AT |
| V18 | 둘 다, 같은 subject | cookie + 유효 bearer | 200. **신원은 토큰**, cookie 무시 | 없음 | — | 없음 | AT |
| V19 | 둘 다, bearer 무효 | cookie + 무효 bearer | **401**. cookie fallback **없음** | 없음 | — | 없음 | AT |
| V20 | hostile origin | 위조 bearer | 401, **ACAO 없음** | 없음 | — | 없음 | AT |
| V21 | native origin | 위조 bearer | 401 | 없음 | — | 없음 | AT |
| V22 | 아무거나 | `x-tomverse-auth-subject` 위조 헤더 동봉 | 헤더가 **삭제됨**. 그 밖에는 다른 벡터와 동일 | 없음 | — | `client_sent_internal_auth_header` (이름만) | 위조된 값 |
| V23 | 둘 다, subject 불일치 | cookie(A) + 유효 bearer(B) | **401** `MOBILE_AUTH_AMBIGUOUS` | 없음 | — | 없음 | 두 subject |

**V10·V11이 §4의 승인 없이는 기대값을 쓸 수 없다는 사실이 §4를 별도 승인 항목으로
둔 이유입니다.** 두 줄에 "승인안에 따름"이라고 적힌 것은 미완성이 아니라, 사람이
결정하기 전에는 결정된 척할 수 없다는 뜻입니다.

---

## 8. 승인과 후속 작업 경계

### 8.1 승인란

> **이 패킷을 작성한 에이전트는 아래를 채우지 않았고, 승인 상태를 추정하지도
> 않았습니다.** registry의 `approvalPolicy.independentReviewerRule`에 따라
> 승인자는 증거를 만든 주체가 아닌 사람이어야 합니다.

| 역할 | 판정 | 서명 | 날짜 |
|---|---|---|---|
| Backend/AI | ☐ approve ☐ approve with conditions ☐ reject | | |
| Mobile/Release | ☐ approve ☐ approve with conditions ☐ reject | | |

**§4의 택일 (필수):** ☐ A ☐ B ☐ C

**조건 (approve with conditions인 경우):**

```
(작성란)
```

**미결정 사항 — 승인 시 함께 답해야 하는 것:**

| # | 미결정 | 어디 |
|---|---|---|
| 1 | access TTL과 skew | D3 |
| 2 | refresh idle / absolute | D4 |
| 3 | 이전 서명 키·pepper 유예 기간 | D6 |
| 4 | 동시 회전 정책 (A/B/C) | §4 |
| 5 | B안이면 창 길이와 정책 문서 개정 | §4.3 |
| 6 | 취소 관측 상한을 15초로 둘지 | D12 |
| 7 | rate limit 수치 | D15 |
| 8 | 기기 목록에 IP를 넣을지 | D16 |
| 9 | audit 보관 기간과 `deletionAction` | §6.4 |
| 10 | Edge runtime에서 Ed25519 가용 여부 실측 | D1 |

**승인 SHA:** `______________` **날짜:** `__________`

### 8.2 작업 경계

| 단계 | 허용 조건 |
|---|---|
| **N2 구현** | 위 승인란이 채워진 뒤. Prisma migration, 토큰 발급·검증, endpoint, 테스트 |
| **N1b** | **N2 구현과 그 검증이 끝난 뒤에만.** §5의 검증자가 실제로 존재하고 §7의 V1~V23이 통과해야 합니다 |
| **여전히 별개** | production 활성화 · 실기기 판정(`AUTH-01`·`AUTH-04`) · R2의 `capacitor://` CORS 확인 |

**N1b가 안전해지는 정확한 선행 조건**은 하나로 줄일 수 있습니다 — **§5.2의 검증
함수가 존재하고, §5.5의 순서대로 mutation-origin 검사보다 먼저 실행되며, §7의
V17~V23이 통과하는 것.** 그 전에는 N1b를 여는 어떤 변경도 `Authorization` 헤더의
존재를 신뢰하는 일이 됩니다.

### 8.3 정책 문서와 registry에 대해

- docs/policy/tomverse-chat-mobile-authentication.md의 Status는
  `draft for Phase 0 approval` **그대로입니다.** 이 패킷은 그 승인을 요청하는
  입력이지 승인 자체가 아닙니다.
- docs/release-gates/tomverse-chat-v1.yaml의 `AUTH-01`~`AUTH-04`·`PRIVACY-01`의
  `status`·`approvedBy`·`evidenceRefs`를 **건드리지 않았습니다.**
- §4에서 B 또는 C가 승인되면 **정책 문서 개정이 구현보다 먼저**입니다.
