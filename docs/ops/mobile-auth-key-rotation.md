# 모바일 인증 키 회전

`docs/policy/tomverse-chat-mobile-authentication.md`의 토큰 경계를 운영하는 절차입니다.
설계 근거는 `.github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md`의
D6과 승인 결정 3번입니다.

**선례:** `docs/ops/admin-audit-key-epochs.md`. 같은 모양이고, 다른 점은 여기에는
**두 개의 링이 있고 주기가 서로 다르다**는 것입니다.

---

## 1. 왜 링이 둘인가

| | 서명 키 | pepper |
|---|---|---|
| 무엇을 보호하나 | access token의 서명 | refresh token secret의 HMAC |
| 무엇에 묶여 있나 | 자기가 서명한 **10분짜리** 토큰 | **살아 있는 refresh 전부**(idle 30일) |
| 은퇴 후 검증 기간 | **15분** (`MOBILE_PREVIOUS_SIGNING_KEY_SECONDS`) | **30일 + skew** (`MOBILE_PREVIOUS_PEPPER_SECONDS`) |

**pepper를 서명 키의 주기로 돌리면 전 사용자가 로그아웃됩니다.** 이것이 D6이 이름 댄
실패이고, 두 링을 하나로 합치면 안 되는 이유입니다.

---

## 2. 환경변수

| 변수 | 형태 |
|---|---|
| `MOBILE_AUTH_SIGNING_KEYS` | `id:base64Pkcs8,...` (Ed25519 개인키) |
| `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID` | `id` |
| `MOBILE_AUTH_RETIRED_SIGNING_KEYS` | `id@2026-09-02T10:00:00Z,...` (없으면 은퇴 없음) |
| `MOBILE_AUTH_REFRESH_PEPPERS` | `id:secret,...` |
| `MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID` | `id` |
| `MOBILE_AUTH_RETIRED_REFRESH_PEPPERS` | `id@2026-09-02T10:00:00Z,...` |
| `MOBILE_AUTH_TOKEN_ISSUER` | `iss`. 검증이 정확 일치합니다 |
| `MOBILE_AUTH_TOKEN_AUDIENCE` | `aud`. 같습니다 |

은퇴 목록은 **별개 변수**입니다. pepper는 운영자가 고른 비밀값이라 콜론을 담을 수
있고, ring 항목에 세 번째 필드를 두면 하필 그 값에서 파싱이 모호해집니다.

**코드가 강제하는 것**(`lib/mobileAuthKeyring.ts`):

- 은퇴한 id를 active로 지정하면 **거부**합니다. 이미 신뢰를 거둔 키로 새 자격증명을
  찍어 내는 것이 이 장치가 막으려는 실수입니다.
- 은퇴 시각 + 유예를 지난 키는 **링에 남아 있어도 검증에 쓰이지 않습니다.** 답은
  "설정된 적 없는 키"와 같고, 검증기는 `unknown_kid`로 보고합니다.
- 링에 없는 id가 은퇴 목록에 있으면 **오류 로그를 남기고 무시합니다.** 링에 없는 키는
  이미 못 쓰는 키라 그 줄이 보호하는 것도 위태롭게 하는 것도 없습니다. 처음에는
  오타를 잡으려고 거부했는데, 그러면 `mobileAuthReady()`가 false가 되어 **모든 모바일
  인증이 503**이 됩니다 — 아래 3번의 삭제 단계가 정확히 그 상태를 만들었습니다.

---

## 3. 서명 키 회전

**로컬 PC의 PowerShell에서 실행합니다.** Node 22가 필요하고 production 자격증명은
필요 없습니다 — 새 키를 만드는 것뿐입니다. 출력에 개인키가 나오므로 **화면 공유 중에는
실행하지 않습니다.**

```powershell
node -e "const {generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))"
```

그 다음 **Railway 대시보드의 환경변수 화면**에서, 한 번에 하나씩:

1. `MOBILE_AUTH_SIGNING_KEYS`에 새 항목을 **추가**합니다. 기존 항목은 그대로 둡니다.
2. 배포가 끝난 뒤 `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID`를 새 id로 바꿉니다.
3. `MOBILE_AUTH_RETIRED_SIGNING_KEYS`에 `이전id@<지금 UTC instant>`를 추가합니다.
4. **15분 뒤부터** 이전 키는 검증에 쓰이지 않습니다.

2와 3 사이에 간격을 두지 않습니다. 사이에 발급된 토큰은 새 키로 서명되고, 이전 키는
그 시점까지 서명한 토큰들을 위해서만 남습니다.

### 3.1 정리(선택) — 두 줄을 같은 배포에서 지웁니다

유예가 지난 항목은 이미 검증에 쓰이지 않으므로 **지우지 않아도 안전합니다.** 변수를
정리하고 싶을 때만 하고, 할 때는 **한 배포에서 셋을 함께** 합니다.

1. `MOBILE_AUTH_SIGNING_KEYS`에서 이전 항목 삭제
2. `MOBILE_AUTH_RETIRED_SIGNING_KEYS`에서 **같은 id의 줄도** 삭제
3. `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID`가 **남아 있는** 항목을 가리키는지 확인

> **rev.2 정정.** 이 문서의 첫 판은 4번에서 "그 뒤 아무 때나 `MOBILE_AUTH_SIGNING_KEYS`
> 에서 항목을 지우면 됩니다"라고만 적었습니다. 당시 파서는 링에 없는 은퇴 id를 오류로
> 보아 거부했으므로, 그 안내대로 링 항목만 지우면 `mobileAuthReady()`가 false가 되어
> **모든 모바일 인증이 503**이 됐습니다. 파서를 무시+로그로 바꿔 그 실패를 없앴고,
> 절차도 세 단계를 같이 하도록 고쳤습니다. 지금은 어느 순서로 지워도 서비스가
> 멈추지 않지만, 셋을 함께 하는 것이 여전히 읽기 쉬운 상태를 남깁니다.

pepper도 같습니다 — `MOBILE_AUTH_REFRESH_PEPPERS`와
`MOBILE_AUTH_RETIRED_REFRESH_PEPPERS`를 같은 배포에서 정리하고, active가 남아 있는
항목을 가리키는지 확인합니다.

## 4. pepper 회전

같은 순서이되 **4번의 기간이 30일 + skew**입니다. 그동안 이전 pepper로 계산된 refresh
token이 계속 검증되고, 성공한 refresh마다 후속 토큰이 **현재 세대로 옮겨 갑니다** —
그래서 이전 세대는 끊기는 것이 아니라 빠져나갑니다.

**30일을 기다리지 못할 이유가 있다면 그것은 사고 대응이고, 이 문서가 아니라 전체
로그아웃(`revokeAllUserSessions`)이 답입니다.** pepper를 일찍 지우는 것은 같은 결과를
설명 없이 만드는 일입니다.

## 5. 사고 시

키가 유출된 경우 유예를 기다리지 않습니다. **다만 유출된 키가 active인지 먼저
확인합니다** — active인 키를 대체 없이 지우면 `mobileAuthReady()`가 false가 되어 모든
모바일 인증이 503이 됩니다.

**유출된 키가 active일 때** (한 배포에서 순서대로):

1. 새 키를 만들어 `MOBILE_AUTH_SIGNING_KEYS`에 **추가**합니다.
2. `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID`를 새 id로 바꿉니다.
3. 유출된 항목을 `MOBILE_AUTH_SIGNING_KEYS`에서 **삭제**합니다. 그 키로 서명된 토큰은
   즉시 `unknown_kid`가 됩니다.

1~3을 나눠 배포하지 않습니다. 2 없이 3을 하면 서비스가 멈추고, 3 없이 1~2만 하면
유출된 키가 계속 검증됩니다.

**유출된 키가 active가 아닐 때**: 항목만 삭제하면 됩니다.

**pepper가 유출됐을 때**: 같은 구조입니다. active pepper라면 새 pepper 추가 → active
전환 → 삭제. 삭제한 세대로 계산된 refresh token은 전부 검증 실패하고 해당 사용자는
재로그인합니다.

어느 쪽이든 `revokeAllUserSessions`로 세션을 함께 끊을지 판단합니다.

## 6. 남은 것

**자동 제거는 없습니다.** 유예가 지난 항목을 코드가 검증에 쓰지 않을 뿐, 변수에서
지우는 것은 사람의 일입니다. 그 상태가 위험하지는 않습니다 — 지나간 키는 이미
`unknown_kid`이므로 — 다만 변수는 계속 자랍니다.

production 활성화를 결정할 때 함께 정할 것 둘:

- 유예가 지난 항목을 보고하는 점검(예: `/api/ready`나 일일 리포트)
- 이 절차의 실행 기록을 어디에 남길지
