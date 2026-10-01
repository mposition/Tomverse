# 불변식 10 — end-to-end synthetic 점검 운영 절차

계약: `docs/policy/email-product-news-redesign-draft.md` 7.1(불변식 10), 7.5,
12절(S10a). 판정은 `lib/emailSyntheticProbeCore.ts`, 실행은
`lib/emailSyntheticProbe.ts`, 진입점은 `npm run check:email-synthetic-probe`.

## 이 점검이 다른 점검과 다른 한 가지

**이것은 쓰는 점검입니다.** 다른 `check:` script는 전부 읽기만 하지만, 이것은
probe 계정의 `service_status` 수신 설정을 **실제로 끄고 되돌립니다**. 그 과정에서
`EmailPreference` · `EmailPreferenceTransition` · `SuppressionCause` 행이 쓰입니다.

## 왜 `product_updates`가 아니라 `service_status`인가

probe는 매 실행마다 purpose를 **끄고 다시 켜야** 합니다. `product_updates`는 동의
필수 purpose이고, 동의 purpose를 다시 켜는 것은 확인(double opt-in)이 있어야만
됩니다 — `setPreference()`가 확인 토큰을 검사하지 않은 모든 호출자에게
`confirmation_required`로 거부합니다. 첫 버전은 `product_updates`를 써서 **매 실행
복원에 실패했습니다.**

우회로는 둘 다 더 나쁩니다. 예약 도메인으로 보낸 확인 메일은 배달될 수 없고 그
반송이 probe 주소를 전역 suppression합니다. 확인 없이 동의 purpose를 켜는 경로는 —
예약 도메인에 한정하더라도 — double opt-in 우회입니다.

`service_status`는 끌 수 있고, 동의가 필요 없고, 기본값이 켜짐이며, **같은
endpoint · 토큰 · rate limit · preference 쓰기 · transition · suppression 원인**을
지납니다. 이 점검이 다루지 않는 것은 동의 purpose의 철회가 쓰는 `ConsentRecord`
하나이고, 그 부분은 `setPreference()`의 DB 테스트
(`tests/integration/email-preferences-consent.db.test.ts`) 소관입니다.

그래서 기본값이 off이고, 예약 도메인이 아닌 주소를 거부하며, PR gate에 넣지
않습니다. 게이트에 넣으면 실행될 수 없는 환경에서 스스로를 건너뛰고 **한 번도
돌지 않은 점검에 초록 체크가 붙습니다.**

## 7.5의 keyring canary와 무엇이 다른가

canary는 **복호화만** 확인합니다 — endpoint를 부르지 않고, rate limit에 닿지
않고, 아무것도 쓰지 않습니다. 그래서 "저장된 키로 만든 토큰이 아직 열린다"는
말할 수 있지만 **수신거부가 실제로 동작한다**는 말할 수 없습니다. 불변식 10이
그 나머지입니다.

## 전용 계정

주소는 **RFC 2606·RFC 6761 예약 이름** 아래여야 합니다 — `.invalid`, `.test`,
`.example`로 끝나거나 `example.com` · `example.net` · `example.org`. 어떤
등록기관도 이 이름을 위임하지 않으므로 **그 주소로 메일함을 가진 사람이 존재할
수 없습니다.** "probe 대상이 고객이 아니다"가 seed에 대한 약속이 아니라 이름에
대한 사실이 되는 지점이 여기입니다.

계정 자체는 아래 넷 중 하나라도 있으면 거부합니다: 크레딧 lot, 대화, billing
identity(Stripe customer id), 구매. **"synthetic 표시"라는 flag는 쓰지 않습니다**
— 행의 flag는 그 행을 마지막에 고친 사람이 정하는 것이고, 이 점검이 막으려는
것이 정확히 probe를 누군가에게 겨누는 편집이기 때문입니다.

권장 주소: `release-notes-probe@tomverse.invalid`

## 무엇이 보장되고 무엇이 보장되지 않는가

**보장됩니다.** probe 대상의 행이 수신거부 경로가 써야 할 것과 **정확히 같고**,
그 행 하나하나가 실제로 probe 대상의 것입니다. 네 단계의 응답이 계약대로이고,
재시도(두 번째 클릭)가 **아무것도 쓰지 않습니다**.

**보장되지 않습니다.** 실행 중에 다른 어디에서도 아무것도 바뀌지 않았다는 것.
어떤 점검도 그것을 말할 수 없고, 말하는 것처럼 보이는 점검은 **그렇지 않다는
증거로 읽힙니다.** 창(window) 전체의 행을 세는 방식은 실제 수신자가 같은 순간
수신거부하면 실패하므로 — 실제 트래픽에서 실패하는 점검은 일주일 안에
꺼집니다 — 채택하지 않았습니다.

## 실행

**로컬 PC의 PowerShell, 저장소 clone 폴더 안. Node 22와 `npm ci`가 끝나 있어야
하고, 대상 환경의 자격증명이 필요합니다(읽고 쓰는 명령입니다).**

```powershell
$env:EMAIL_SYNTHETIC_PROBE_ENABLED = "true"
$env:EMAIL_SYNTHETIC_PROBE_ADDRESS = "release-notes-probe@tomverse.invalid"
$env:PUBLIC_APP_URL = "https://<대상 환경 host>"
npm run check:email-synthetic-probe
```

`EMAIL_UNSUBSCRIBE_KEYS`와 `DATABASE_URL`은 대상 환경의 것이어야 합니다. 위
`$env:`는 **그 PowerShell 창에서만 삽니다** — 창을 닫으면 사라지고, 이어지는
명령은 같은 창을 전제합니다.

되돌리는 방법: 이 점검은 스스로 되돌립니다. 되돌리기가 실패하면 **실패로
보고합니다** — 수신거부 상태로 남은 probe 계정은 다음 실행부터 `already_set`
경로만 지나므로, 몇 년 전 한 번의 실행을 근거로 영원히 통과하는 점검이 됩니다.

## 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 통과 |
| 1 | 실패 — 문제 목록이 출력됩니다 |
| 2 | **실행되지 않음** — 거부 사유와 조치 한 줄이 출력됩니다 |

2가 0이 아닌 이유: 돌지 않은 점검에 "ok"를 돌려주는 것은 사실의 반대를 말하는
것입니다.

## 언제 돌리는가

- **릴리스 노트 제품 활성화 전**, staging에서 한 번 (S10a는 활성화 전 단계입니다).
- 활성화 후 production에서 한 번.
- `EMAIL_UNSUBSCRIBE_KEYS`를 회전한 뒤. canary는 복호화만 확인하므로 endpoint가
  새 키로 서명한 토큰을 받아들이는지는 이쪽만 말할 수 있습니다.
