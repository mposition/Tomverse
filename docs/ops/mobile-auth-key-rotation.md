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

**규칙 하나**(`lib/mobileAuthKeyring.ts`):

> **키는 active이거나, 명시적으로 은퇴했고 유예 안에 있을 때만 검증에 쓰입니다.**
> 링에 있으면서 둘 다 아닌 키는 아무것도 검증하지 않습니다.

여기서 나오는 것들:

- 은퇴한 id를 active로 지정하면 **거부**합니다. 이미 신뢰를 거둔 키로 새 자격증명을
  찍어 내는 것이 이 장치가 막으려는 실수입니다.
- 유예를 지난 키는 링에 남아 있어도 쓰이지 않습니다. 답은 "설정된 적 없는 키"와
  같고, 검증기는 `unknown_kid`로 보고합니다.
- 링에 없는 id가 은퇴 목록에 있으면 **로그를 남기고 무시합니다.** 정리하고 남은 줄과
  오타는 여기서 구분되지 않기 때문입니다. **오타가 위험하지 않은 이유는 그 줄이
  무시돼서가 아니라 위 규칙 때문입니다** — 은퇴시키려던 진짜 키는 선언되지 않은
  상태가 되어 즉시 검증에서 빠집니다. 계약의 15분보다 **엄격한** 쪽이지 느슨한
  쪽이 아닙니다.

> **rev.3 정정.** 이 규칙은 세 번째 모양입니다. 처음에는 링에 없는 은퇴 id를 오류로
> 거부했고, 그러면 링 정리만으로 모든 모바일 인증이 **503**이 됐습니다. 두 번째는
> 그 id를 무시했고, 그러면 오타가 난 설정에서 **이전 키가 무기한 신뢰**됐습니다 —
> 실제로 `sign-old`가 2099년에도 검증에 쓰였습니다. 두 번 다 질문이 틀렸습니다.
> "이 은퇴 줄이 맞는가"는 답할 수 없고(정리 잔여물과 오타가 같아 보입니다),
> "이 키가 검증해도 되는가"는 답할 수 있으며 안전한 기본값이 "아니오"입니다.

**대가가 있고, 그것이 아래 §2.1이 있는 이유입니다.** 은퇴 줄을 빠뜨리는 것은 이제
공짜가 아닙니다 — pepper라면 그 세대의 refresh token이 검증에 실패하고 해당
사용자들이 다시 로그인합니다. 배포 전에 확인하는 것이 그래서 절차의 일부입니다.

## 2.1 배포 전 확인 — 필수

**Railway 서비스 shell에서 실행합니다.** 로컬 PC가 아닙니다 — 이 검사는 **서명
개인키와 pepper 원문**을 읽어야 하고(활성 키로 실제 서명해 보는 것이 검사의
일부입니다), 그 값을 노트북으로 복사하는 것이 검사보다 큰 위험입니다.

> **rev.4 정정.** 이 문서의 이전 판은 "production 자격증명이 필요한 것이 아니다"라고
> 적었습니다. 틀렸습니다. **배포할 값이 곧 production 자격증명입니다.**

- **바꾸기 전 상태를 볼 때**: 서비스 shell에서 그대로 실행합니다.
- **바꾼 뒤를 미리 볼 때**: 바꿀 변수만 그 shell 세션에 얹어 실행합니다. 그 창을
  닫으면 사라지고 서비스에는 아무 영향이 없습니다.

```bash
npm run check:mobile-auth-keyring
```

읽기 전용입니다. 아무것도 바꾸지 않고, 출력에 비밀값이 없으므로 결과는 그대로
붙여도 안전합니다.

키마다 `ACTIVE` / `RETIRED, verifies until …` / `UNDECLARED -- verifies nothing`을
출력합니다. 실패하는 것:

- `UNDECLARED`가 하나라도 있을 때
- 링에 없는 id를 은퇴 목록이 지목할 때 (오타의 다른 절반)
- active id가 링에 없거나, 은퇴했거나, 그 키가 서명하지 못할 때
- **일부만 설정됐을 때** — 모바일 인증이 전부 503이 되는데 endpoint는 어느 변수가
  빠졌는지 말하지 않습니다

아무것도 설정되지 않은 것은 기본 모드에서 **통과**입니다(모바일 인증을 켜지 않은
배포는 정상입니다). 모바일 인증을 서비스하기로 한 배포의 릴리스 점검에서는
`--require-configured`를 붙여 그것도 실패로 만듭니다.

```bash
npm run check:mobile-auth-keyring -- --require-configured
```

---

## 3. 서명 키 회전

**로컬 PC의 PowerShell에서 실행합니다.** Node 22가 필요하고 production 자격증명은
필요 없습니다 — 새 키를 만드는 것뿐입니다. 출력에 개인키가 나오므로 **화면 공유 중에는
실행하지 않습니다.**

```powershell
node -e "const {generateKeyPairSync}=require('crypto');console.log(generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))"
```

그 다음 **Railway 대시보드의 환경변수 화면**에서, 한 번에 하나씩:

**세 변수를 한 배포에서 함께 바꿉니다.** 나눠 배포하면 안 됩니다 — 이유는 아래에
있습니다.

1. 최종 값 셋을 정합니다.
   - `MOBILE_AUTH_SIGNING_KEYS` = `이전id:이전키,새id:새키`
   - `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID` = `새id`
   - `MOBILE_AUTH_RETIRED_SIGNING_KEYS` = `이전id@<지금 UTC instant>` (기존 줄에 추가)
2. §2.1의 검사를 그 세 값으로 실행합니다. 이전 키가
   `RETIRED, verifies until …`로, 새 키가 `ACTIVE (signs)`로 나와야 합니다.
3. 셋을 **한 번에** 저장하고 배포합니다.
4. **15분 뒤부터** 이전 키는 검증에 쓰이지 않습니다.

> **rev.4 정정 — 왜 나눠 배포하면 안 되는가.** 이 문서의 이전 판은 ① 새 키만 추가해
> 배포 ② 그 뒤 active 전환 ③ 그 뒤 은퇴 줄 추가로 적었습니다. 지금 규칙에서는 **두
> 배포 다 잘못된 상태**입니다.
>
> - ① 뒤: 새 키가 active도 은퇴도 아니어서 `UNDECLARED`입니다. 아직 아무것도
>   서명하지 않았으니 사용자 피해는 없지만 §2.1 검사가 실패하고, 그 상태를 정상으로
>   넘기면 검사가 무의미해집니다.
> - ② 뒤 ③ 전: **이전 키가 `UNDECLARED`가 되어 즉시 검증에서 빠집니다.** 서명 키라면
>   아직 살아 있는 access token이 그 즉시 거절되고(클라이언트가 refresh로 회복합니다),
>   pepper라면 **그 세대 사용자들이 다시 로그인합니다.**
>
> 세 값을 함께 적용하면 그 중간 상태가 존재하지 않습니다. Railway는 변수 변경을 한
> 배포로 적용하므로 "함께"가 실제로 가능합니다.

### 3.1 정리(선택) — 두 줄을 같은 배포에서 지웁니다

유예가 지난 항목은 이미 검증에 쓰이지 않으므로 **지우지 않아도 안전합니다.** 변수를
정리하고 싶을 때만 하고, 할 때는 **한 배포에서 셋을 함께** 합니다.

1. `MOBILE_AUTH_SIGNING_KEYS`에서 이전 항목 삭제
2. `MOBILE_AUTH_RETIRED_SIGNING_KEYS`에서 **같은 id의 줄도** 삭제
3. `MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID`가 **남아 있는** 항목을 가리키는지 확인

> **rev.2 정정.** 이 문서의 첫 판은 4번에서 "그 뒤 아무 때나 `MOBILE_AUTH_SIGNING_KEYS`
> 에서 항목을 지우면 됩니다"라고만 적었습니다. 당시 파서는 링에 없는 은퇴 id를 오류로
> 보아 거부했으므로, 그 안내대로 링 항목만 지우면 **모든 모바일 인증이 503**이
> 됐습니다. 지금은 어느 순서로 지워도 서비스가 멈추지 않지만, 셋을 함께 하는 것이
> 여전히 읽기 쉬운 상태를 남깁니다. §2.1의 확인을 먼저 돌리면 어느 쪽이든 배포 전에
> 보입니다.

pepper도 같습니다 — `MOBILE_AUTH_REFRESH_PEPPERS`와
`MOBILE_AUTH_RETIRED_REFRESH_PEPPERS`를 같은 배포에서 정리하고, active가 남아 있는
항목을 가리키는지 확인합니다.

## 4. pepper 회전

같은 절차이고 — **세 값을 한 배포에서** — 4번의 기간이 **30일 + skew**입니다.
그동안 이전 pepper로 계산된 refresh token이 계속 검증되고, 성공한 refresh마다 후속
토큰이 **현재 세대로 옮겨 갑니다** — 그래서 이전 세대는 끊기는 것이 아니라
빠져나갑니다.

**pepper에서 은퇴 줄을 빠뜨리는 것의 대가가 가장 큽니다.** 그 세대의 refresh token이
전부 검증에 실패하고 해당 사용자들이 다시 로그인합니다. family가 폐기되는 것은
아니지만(거절 사유는 `secret_mismatch`입니다) 사용자에게는 로그아웃으로 보입니다.
§2.1 검사가 배포 전에 잡는 것이 정확히 이것입니다.

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
`unknown_kid`이므로 — 다만 변수는 계속 자랍니다. §2.1의 확인이 `NOTE`로 알려 줍니다.

**배포 전 확인은 CI가 아닙니다.** CI에는 모바일 키가 없고, 설정되지 않은 배포는
정상 상태입니다(endpoint가 503으로 답하는 것이 설계입니다). 그래서 이 확인은
운영자가 배포할 값을 들고 직접 돌리는 것이며, 그 실행을 강제하는 것은 이 문서뿐입니다.

production 활성화를 결정할 때 함께 정할 것 둘:

- 유예가 지난 항목과 선언되지 않은 키를 보고하는 상시 점검(예: 일일 리포트)
- 이 절차와 §2.1 확인의 실행 기록을 어디에 남길지
