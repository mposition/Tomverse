# sre-ops S1b → S2 단계 전환 기록 (초안)

> **초안입니다.** 관측은 2026-11-04 Railway 로그에서 읽은 값이고, 판정은 소유자가 합니다. 제안이라고 적은 줄은 대화에서 바꿀 수 있습니다.
> 근거: docs/policy/sre-ops.md §8(S1b 전환 조건, S2 착수 조건), §9 D5c.

## 1. S1b 전환 조건 (14일)

관측 구간은 2026-10-24T09:02Z(AEST 19:02)부터 2026-11-07T09:02Z까지입니다. 11-04 기준 11일 경과이며 아직 끝나지 않았습니다.

| 조건 | 관측 | 상태 |
|---|---|---|
| P8 알림 0회 | 소유자가 2026-11-05에 받지 않았다고 확인했습니다. 구간이 끝나는 11-07까지 다시 확인합니다 | 11-05 기준 충족 |
| 최초 genesis 뒤 추가 genesis 0건 | 이 기록을 쓸 때 genesis 행을 읽지 않았습니다 | 판정 전 Admin 화면에서 확인 |
| `shadowed`에 이르지 않은 예약 0건 | 로그에는 `shadowed=true` 실행이 4건(10-27 2건, 10-29 2건)이고, 전송 기록 테이블과는 대조하지 않았습니다 | 판정 전 Admin 화면에서 확인 |

### 실패한 실행 (exit 1)

| 서비스 | 시각(AEST) | 결과 | 원인 |
|---|---|---|---|
| page | 10-29 02:40 | `untrusted`(`state_unavailable`) 1건 | 미확인. 당시 로그에 응답 코드가 없습니다 |
| page | 10-29 10:10, 10:23, 11:01 | `heartbeat_failed` 3건 | 미확인. monitor 쪽 응답 또는 연결 |
| page | 11-03 13:31, 13:43, 13:52, 14:10, 14:23 | `untrusted`(`state_unavailable`) 5건 | 아래 |
| digest | 11-03 07:04 | `heartbeat_failed` 1건 | 미확인 |

11-03 구간은 앱이 원인이 아니라는 근거가 있습니다. 13:31 실행의 health 요청은 앱에 도착해 200이었지만, 같은 실행의 상태 집계와 state 요청은 Railway HTTP 로그에 없습니다. 컨테이너의 network flow에는 Cloudflare로 나가는 재전송과 `TCP_OLD_DATA` drop이 보입니다. 같은 구간의 다른 실행(13:20, 14:03, 14:33)은 정상입니다.

성공한 heartbeat 사이 간격이 13:20에서 14:03까지 약 43분으로 허용치 30분을 넘었지만, 소유자는 알림을 받지 않았습니다. monitor 쪽 유예 때문인지는 확인하지 않았습니다. 관측 구간은 다시 세지 않습니다.

이 실패를 줄이려고 읽기 요청과 heartbeat ping은 연결 실패 때 한 번 다시 시도하도록 고쳤고, 실패 로그에 응답 코드를 남깁니다.

## 2. S2 착수 조건

| 조건 | 상태 |
|---|---|
| S1b 전환 조건 충족 | 1절 |
| page 키가 아닌 readiness 검사의 영향표에 대한 소유자 결정 | 3절 제안, **소유자 결정 필요** |
| page 채널이 소유자 전용이고 휴대폰 푸시로 도달 | **소유자 확인 필요.** digest와 다른 Slack 채널을 권합니다 |
| 점검 요일·시간 창 | 제안: 화요일 10:00–12:00(Brisbane). 코드에 이 값으로 들어 있습니다 |
| check-in monitor 생성, monitor 셋의 알림 대상이 page 채널이 아님 | **소유자 작업.** 주기 7일, 유예 2일. URL은 어떤 서비스에도 넣지 않습니다 |
| Railway의 주 프로세스 종료 인식(D5c) | 4절 관측, 소유자 판정 |
| activation genesis(`live`) | **소유자 승인.** `OPS_OBSERVER_PAGE_WEBHOOK_URL` 설정 뒤 Admin 화면에서 |

## 3. page 키가 아닌 readiness 검사 영향표 (제안)

17개 중 page 키 5개를 뺀 12개입니다. 제안은 모두 **digest 유지**입니다. 고쳐서 배포하면 되돌릴 수 있거나, 다음 날 digest로 봐도 쌓이는 피해가 작다고 보았습니다.

| 검사 | false일 때의 영향 | 제안 |
|---|---|---|
| `imageProviderBudget` | 이미지 생성 예산 구성 문제 | digest |
| `voiceProviderBudget` | 음성 예산 구성 문제 | digest |
| `voiceModelPrice` | 음성 전사 모델 가격 문제 | digest |
| `searchProviderBudget` | 검색 예산 구성 문제 | digest |
| `emailUnsubscribeKeyring` | 수신 거부 서명 키 문제. marketing 발송이 거부됩니다 | digest |
| `emailUnsubscribeKeyRetention` | 수신 거부 키 보존 문제 | digest |
| `emailConsentKeyring` | 동의 키 문제 | digest |
| `emailBusinessIdentity` | 발송자 사업자 정보 문제 | digest |
| `emailSubjectLabels` | 제목 표기 문제 | digest |
| `emailFooterDisclosures` | 바닥글 고지 문제 | digest |
| `emailBiennialConsentNotice` | 2년 주기 동의 안내 문제(ready 판정에 들어가지 않음) | digest |
| `amuxReviewApproval` | AMUX 검토 승인 구성 문제 | digest |

영향 설명은 검사 이름과 구성에서 추정한 것이며 각 검사를 실패시켜 확인하지는 않았습니다.

## 4. D5c 관측

Railway cron은 이전 회차가 끝나지 않았으면 다음 회차를 시작하지 않으므로, 회차가 이어지면 주 프로세스 종료를 실행 종료로 인식한다는 뜻입니다.

- 2026-11-04 00:00–12:00Z의 page 실행 로그 약 70건은 약 10분 간격으로 끊기지 않았습니다(`exitCode=0`).
- exit 1로 끝난 실행 뒤에도 다음 회차가 이어졌습니다(11-03 13:31–14:23).
- supervisor의 180초 강제 종료 경로는 production에서 관측하지 못했습니다(`deadline_killed` 없음). 테스트로만 확인된 경로입니다.

## 5. S3의 남은 항목

- provider 예산 키와 알림 전달 실패 키는 구현했고 `OPS_OBSERVER_S3_PAGES`가 켜질 때까지 동작하지 않습니다.
- HTTP 5xx 급증 키는 소유자 결정(2026-11-05)으로 뺐습니다. Railway 읽기 전용 token scope를 문서에서 확인하지 못했고, 토큰을 두지 않습니다.

## 6. 판정 (소유자)

- S1b → S2 전환: (미판정)
- 서명·일시: (미기록)
