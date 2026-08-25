# 이메일 footer의 사업자 정보

발신자가 누구인지를 말하는 값 여섯 개입니다. 모든 관할권의 스팸 관련 법이
가장 먼저 요구하는 것이고, `JurisdictionProfile.footerBlocks`가 **어떤 값을**
찍을지 정하고 이 환경변수가 **그 값이 무엇인지**를 정합니다.

계약: `docs/policy/email-notifications.md` §5.2 E3, §8.5.
적용 지점: `lib/emailJurisdictionComposition.ts` (`composeJurisdictionalMessage`).

## 변수

```
EMAIL_BUSINESS_LEGAL_NAME=Tomverse Pty Ltd
EMAIL_BUSINESS_POSTAL_ADDRESS=1 Example Street, Brisbane QLD 4000, Australia
EMAIL_BUSINESS_CONTACT_EMAIL=support@tomverse.app
EMAIL_BUSINESS_REGISTRATION_NUMBER=000-00-00000
EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER=2026-Seoul-00000
EMAIL_BUSINESS_ABN=00 000 000 000
```

| 변수 | footer block | 필요한 profile |
|---|---|---|
| `EMAIL_BUSINESS_LEGAL_NAME` | `legal_name` | 전부 |
| `EMAIL_BUSINESS_POSTAL_ADDRESS` | `postal_address` | 전부 |
| `EMAIL_BUSINESS_CONTACT_EMAIL` | `contact_email` | 전부 |
| `EMAIL_BUSINESS_REGISTRATION_NUMBER` | `business_registration` | KR |
| `EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER` | `mail_order_registration` | KR |
| `EMAIL_BUSINESS_ABN` | `abn` | AU |

`EMAIL_BUSINESS_CONTACT_EMAIL`은 **발신 주소가 아닙니다.** 수신자가 이 메일에
관해 연락할 수 있는 주소이고, `TRANSACTIONAL_EMAIL_FROM`과 같을 이유가 없습니다.

이 값은 **Reply-To의 대상이기도 합니다**(`docs/policy/email-notifications.md`
§14.1a). 역할 주소(`security@`·`billing@` 등)는 발송 전용이고 수신한다는 근거가
없으므로, 답장은 여기로만 향합니다. 설정돼 있지 않으면 헤더를 붙이지 않습니다.

## 값이 하나만 없어도 footer 전체가 사라집니다

**빠진 줄 하나가 아니라 footer 전부입니다.** `renderJurisdictionFooter()`는 이름
붙은 block 중 **하나라도** 값이 없으면 `{ ok: false }`를 반환하고,
`composeJurisdictionalMessage()`가 footer를 통째로 버립니다. 그래서
`EMAIL_BUSINESS_CONTACT_EMAIL` 하나가 비어 있으면 사업자 정보가 **모든 메일에서**
빠집니다.

어느 profile이 어느 값을 요구하는지는 `JURISDICTION_PROFILE_SEED`가 정합니다.

| 값 | 요구하는 profile |
|---|---|
| `legal_name` · `postal_address` · `contact_email` | **전부** (`ZZ` 포함) |
| `business_registration` · `mail_order_registration` | `KR` |
| `abn` | `AU` |

## 확인 방법

`/api/ready`의 `emailBusinessIdentity`가 이 여섯 값을 검사합니다
(`businessIdentityReadiness()`).

- `MARKETING_EMAIL_FROM`이 없으면 **경고**입니다. transactional 메일은 이것 때문에
  붙잡지 않으므로(아래 표), 여기서 readiness를 막으면 footer가 없던 내내 통과하던
  production을 계획 안내를 위해 내리는 일이 됩니다.
- `MARKETING_EMAIL_FROM`이 설정되면 **오류**로 바뀝니다. 그 순간부터 marketing은
  전부 거부되는데 `/api/ready`는 계속 통과한다고 답하게 되기 때문입니다 — EM-10이
  unsubscribe 키에 대해 기술한 것과 같은 상태입니다.
- 관할권 전용 값(`KR`·`AU`)은 marketing이 켜져도 **경고로 남습니다.** 이 배포에
  그 관할권 수신자가 있는지는 환경변수가 가진 사실이 아닙니다.

빠진 값은 **한 번에 전부** 보고합니다 — 하나 고치고 다시 알게 되는 방식이면 세 번
배포해야 세 가지를 압니다. 발송 시점의 신호는 여전히
`email_jurisdiction_footer_degraded` 구조화 경고입니다.

## 설정하지 않으면

**기본값은 없습니다.** placeholder를 넣으면 renderer를 통과하고 모든 검사를
통과한 뒤 footer에 **거짓 신원**이 실립니다. footer가 존재하는 이유가 신원을
확인 가능하게 만드는 것이므로, 비어 있는 것이 틀린 것보다 낫습니다.

동작은 분류에 따라 다릅니다.

| 분류 | 값이 없을 때 |
|---|---|
| marketing | **발송 거부.** `skipReason = jurisdiction_footer_incomplete`, `EMAIL_JURISDICTION_LABELLING_UNAVAILABLE` incident |
| transactional · legal · service | **footer 없이 발송**하고 `email_jurisdiction_footer_degraded` 구조화 경고 |

이 비대칭이 이 문서의 핵심입니다. 표시 없는 광고는 도착한 뒤에 되돌릴 수
없으므로 보내지 않습니다. 반면 계정 삭제 예정 안내를 환경변수 하나 때문에
붙잡아 두는 것은 더 나쁜 실패입니다 — footer는 여전히 빚이지만, 조용히 빠지지
않도록 매 발송마다 경고가 남습니다.

경고 예시:

```json
{"event":"email_jurisdiction_footer_degraded","deliveryId":"...",
 "classification":"transactional","profileKey":"ZZ",
 "reasons":["footer_missing:legal_name,postal_address"],"sent":"without_footer"}
```

`reasons`가 어떤 block이 빠졌는지 한 번에 전부 나열합니다. 하나 고치고 다시
알게 되는 방식이면 세 번 배포해야 세 가지를 압니다.

## profile이 없을 때

`reasons: ["profile_missing"]`는 값이 아니라 **정책 버전** 문제입니다. delivery
행은 enqueue 시점의 `policyVersionId`에 고정되고, 그 버전에 해당 `profileKey`
행이 없다는 뜻입니다. bootstrap 정책 버전에는 profile이 하나도 없으므로,
M7의 관할권 정책을 사람이 활성화하기 전까지는 모든 발송이 이 상태입니다
(§12.5). 활성화가 곧 수정입니다.

marketing은 이때도 거부합니다 — `jurisdiction_profile_missing`.

## 고정(pin)을 바꾸지 않습니다

이미 큐에 들어간 메시지는 **그때 고정된 정책 버전**으로 조립됩니다. 새 정책을
활성화해도 대기 중인 메시지의 문구는 바뀌지 않습니다. 바뀐다면 delivery 행은
한 정책을 기록하고 수신자는 다른 정책의 메일을 받게 됩니다.

값 자체는 다릅니다 — 환경변수는 고정되지 않으므로, 지금 설정하면 **아직 발송
되지 않은 대기 메시지부터** 즉시 footer가 붙습니다.
