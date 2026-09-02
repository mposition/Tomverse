# N2 구현 — §7 테스트 벡터 커버리지 (2026-09-02)

승인된 설계
`.github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md`의 §7이
나열한 벡터 각각이 **지금 어디서 어떻게 검증되는지**를 적습니다.

이 문서는 승인 문서가 아니고 판정도 아닙니다. §8.2의 N1b 선행 조건 3번이
벡터 목록을 이름으로 요구하므로, 그 목록을 사람이 대조할 수 있게 만드는
기록입니다. **통과라고 적은 것은 실제로 실행해 통과한 것뿐이고, 통과하지
못한 것은 통과하지 못했다고 적었습니다.**

기준 커밋은 이 문서를 담은 commit이며, 실행 결과는 아래 §4에 있습니다.

---

## 1. 통과 — 실행해서 통과한 벡터

| # | 무엇을 고정하는가 | 어디서 |
|---|---|---|
| V1 | 정상 토큰이 검증되고 신원을 돌려준다 | `tests/mobileAccessTokenCore.test.mjs`, `tests/mobileAccessTokenCrypto.test.mjs` |
| V2 | 서명이 다르면 거절 | 위 둘. crypto 쪽은 **실제 Ed25519 키 두 벌**로 |
| V3 | 만료는 skew만이 유예 | 위 둘 |
| V4 | 다른 배포의 `iss`·`aud`는 거절 | `tests/mobileAccessTokenCrypto.test.mjs` |
| V4b | `tkn`이 다른 토큰은 거절 | `tests/mobileAccessTokenCore.test.mjs` |
| V4c | `iat`·`jti` 부재, `exp <= iat`은 거절 | 같은 파일 |
| V5 | 남의 자원은 "없음"이지 "거절"이 아니다 | `tests/integration/mobile-auth-service.db.test.ts` — 기기 목록과 기기 해제 두 경로. **제품 자원 전반은 N1b 이후**(§2) |
| V6 | 해제된 기기의 토큰은 route에서 막힌다 | 같은 파일 |
| V7 | 폐기된 family의 refresh는 거절 | 같은 파일(강제 로그아웃 후 refresh) |
| V8 | 회전이 소비하고 후속을 만든다 | 같은 파일 |
| V9 | 재사용은 family를 폐기한다 | 같은 파일 |
| V10 | 동시 refresh 2건 → 하나만 성공 (A안) | 같은 파일. **실제 `Promise.all` 경쟁**이며 시뮬레이션이 아님 |
| V11 | 응답 유실 재시도는 재사용과 구분 불가 | 같은 파일. A안이 받아들인 결과를 기록으로 고정 |
| V12 | 기기 하나의 logout이 **웹 cookie 세션을 건드리지 않는다** | 같은 파일. `sessionsRevokedAt`과 `Session` 행 **양쪽**을 확인 |
| V13 | 기기 해제도 마찬가지 | 같은 파일 |
| V14 | 계정 삭제가 전부 가져가고 **이름 없는 집계 한 줄만** 남긴다 | 같은 파일 |
| V16 | 웹 cookie POST는 현행 그대로 | `tests/mobileBearerProxy.test.mjs` |
| V22 | 위조된 내부 identity 헤더는 삭제된다 | 같은 파일. prefetch 분기 포함 |
| V24 | 미소비 레코드 + 틀린 secret → family 무변경 | `tests/mobileRefreshRotationCore.test.mjs` |
| V24b | **소비된** 레코드 + 틀린 secret → family 무변경 | 같은 파일, 그리고 `tests/mobileRefreshToken.test.mjs`가 **실제 HMAC 비교**로 다시 |
| V24c | **폐기된** 레코드 + 틀린 secret → family 무변경 | 같은 파일 |
| V24d | 없는 `recordId` → family 무변경 | 같은 파일 |
| V25 | 폐기 트랜잭션이 401과 함께 **커밋된다** | `tests/integration/mobile-auth-service.db.test.ts` |
| V26 | 내부 route의 운영 비밀값 bearer는 그대로 통과 | `tests/mobileBearerProxy.test.mjs`. 통과 여부를 `x-middleware-next`로 확인 |
| V26b | 같은 route의 모바일 토큰도 게이트가 관여하지 않는다 | 같은 파일 |
| V27 | 미등재 route + **진짜 유효한 토큰** → 403 | 같은 파일 |
| V28 | access token이 없어도 logout이 된다 | `tests/integration/mobile-auth-service.db.test.ts` |
| V29a | 지연된 조회는 **기다린 요청도 인가하지 않는다** | `tests/mobileRevocationFreshnessCore.test.mjs`(판정)와 `tests/mobileSessionSnapshotCache.test.mjs`(배선) |
| V29b | 그 뒤에 오는 요청도 상한을 넘기지 않는다 | 같은 둘. 캐시 항목의 유효기간이 **재조회 시작** 기준임을 확인 |
| V30 | `aud`가 부분 문자열이면 거절 | `tests/mobileAccessTokenCore.test.mjs`, crypto |
| V31 | `aud` 배열의 원소 정확 일치는 통과 | 같은 둘 |

---

## 2. 아직 통과하지 못한 것 — N1b가 열려야 도달합니다

**V17 · V18 · V19 · V23.** 넷 다 **등재된 route**를 전제합니다. `N1B_BEARER_ROUTES`는
승인된 대로 빈 목록이므로 게이트의 판정은 언제나 `not_applicable`이고, 이 네 행이
말하는 상황이 만들어지지 않습니다.

지금 검증된 것은 그 **판정 자체**입니다 — `tests/nativeBearerGate.test.mjs`가 자기
route를 주입해 §5.3의 행들(미등재 → `not_applicable`, bearer 없음 → cookie 경로,
검증 실패 → `reject`, 검증 성공 → `yes`)을 통과시킵니다. 없는 것은 그 판정이 **실제
route에서 401 또는 200으로 나타나는** 부분입니다.

**§8.2의 선행 조건 3번을 어떻게 읽어야 하는가.** 그 조건은 V17~V23을 "N1b 이전에
통과"하라고 적었는데, 이 넷은 N1b 없이는 성립하지 않습니다. 순환처럼 보이지만
아닙니다 — **첫 route 등재가 이 넷을 함께 들고 와야 한다**는 뜻으로 읽습니다.
route 하나를 등재하는 변경에 그 route에 대한 V17~V19·V23이 붙어 있어야 하고,
그것이 D18이 말하는 "전환 증거"입니다. 등재를 먼저 하고 벡터를 나중에 붙이는
순서는 이 조건을 만족하지 않습니다.

**V20 · V21**의 절반도 여기 있습니다. "위조 bearer → 401"은 등재된 route의 이야기이고,
미등재 상태에서는 403입니다. 지금 고정된 것은 **미등재 상태의 정답**(403, ACAO
없음)이며 `tests/mobileBearerProxy.test.mjs`에 있습니다.

---

## 3. 코드가 판정할 수 없는 것

**V15의 시간 절반.** 이전 서명 키가 **15분** 뒤 링에서 빠졌는지는 운영 행위이고,
저장소 안의 어떤 검사도 그것을 볼 수 없습니다. 검증된 것은 링의 동작입니다 —
은퇴한 키가 링에 있는 동안 그 키로 서명된 토큰이 검증되고, 링에서 빼면
`unknown_kid`가 됩니다(`tests/mobileAccessTokenCrypto.test.mjs`).

그리고 그 숫자가 **아무것도 읽지 않는 상수**로 남지 않도록,
`tests/mobileAuthContract.test.mjs`가 숫자들 사이의 관계를 고정합니다 — 서명 키
유예는 access 수명 + skew 이상이어야 하고, pepper 유예는 idle 수명 이상이어야
하며 서명 키 유예보다 길어야 합니다. 후자를 어기는 것이 D6이 이름 댄 실패,
"pepper 회전이 전 사용자를 로그아웃시키는" 경우입니다.

**AUTH-01 · AUTH-03 · AUTH-04의 실기기 증거.** 이 저장소에는 Swift도 Kotlin도
없고 기기에서 실행된 것도 없습니다. D19의 TypeScript 표면은 고정했고
(`npm run check:native-token-boundary`), 그것은 **번들의 JS가 refresh token을 쥘 수
없다**는 것까지입니다. 실기기의 WebView 컨텍스트에 refresh token이 없다는 증거는
별개이며 이 문서도 그 코드도 주장하지 않습니다.

---

## 4. 실행 기록

이 문서를 쓴 commit 시점에 실행한 것입니다.

- `npm run test:unit` — 이 문서의 §1이 인용하는 모든 unit 파일 포함
- `tests/integration/mobile-auth-service.db.test.ts`,
  `tests/integration/mobile-auth-schema.db.test.ts` — **실제 PostgreSQL 16**을
  전체 migration 이력으로 세운 데이터베이스에서 29/29 통과
- `npm run lint`, `npm run typecheck`, `npm run build`
- `check:enum-constraints`, `check:data-domain-registry`,
  `check:native-token-boundary`, `check:capacitor-local-bundle`,
  `check:doc-references`, `check:policy-section-references`,
  `check:encoding:strict`, `check:shared-packages`

실행하지 않은 것은 이 목록에 없습니다.
