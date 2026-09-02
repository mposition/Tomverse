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
- 링에 없는 id를 은퇴 목록에 적으면 **거부**합니다. 조용히 무시하면 보호하는 것처럼
  보이면서 아무것도 보호하지 않습니다.

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
4. **15분 뒤부터** 이전 키는 검증에 쓰이지 않습니다. 실제 삭제는 그 뒤 아무 때나
   `MOBILE_AUTH_SIGNING_KEYS`에서 항목을 지우면 됩니다.

2와 3 사이에 간격을 두지 않습니다. 사이에 발급된 토큰은 새 키로 서명되고, 이전 키는
그 시점까지 서명한 토큰들을 위해서만 남습니다.

## 4. pepper 회전

같은 순서이되 **4번의 기간이 30일 + skew**입니다. 그동안 이전 pepper로 계산된 refresh
token이 계속 검증되고, 성공한 refresh마다 후속 토큰이 **현재 세대로 옮겨 갑니다** —
그래서 이전 세대는 끊기는 것이 아니라 빠져나갑니다.

**30일을 기다리지 못할 이유가 있다면 그것은 사고 대응이고, 이 문서가 아니라 전체
로그아웃(`revokeAllUserSessions`)이 답입니다.** pepper를 일찍 지우는 것은 같은 결과를
설명 없이 만드는 일입니다.

## 5. 사고 시

키가 유출된 경우 유예를 기다리지 않습니다.

1. `MOBILE_AUTH_SIGNING_KEYS`에서 **항목 자체를 삭제**합니다. 그 키로 서명된 토큰은
   즉시 `unknown_kid`가 됩니다.
2. pepper가 유출됐다면 항목을 삭제하고, 그 세대로 계산된 refresh token은 전부
   검증 실패합니다 — 해당 사용자는 재로그인합니다.
3. 어느 쪽이든 `revokeAllUserSessions`로 세션을 함께 끊을지 판단합니다.

## 6. 남은 것

**자동 제거는 없습니다.** 유예가 지난 항목을 코드가 검증에 쓰지 않을 뿐, 변수에서
지우는 것은 사람의 일입니다. 그 상태가 위험하지는 않습니다 — 지나간 키는 이미
`unknown_kid`이므로 — 다만 변수는 계속 자랍니다.

production 활성화를 결정할 때 함께 정할 것 둘:

- 유예가 지난 항목을 보고하는 점검(예: `/api/ready`나 일일 리포트)
- 이 절차의 실행 기록을 어디에 남길지
