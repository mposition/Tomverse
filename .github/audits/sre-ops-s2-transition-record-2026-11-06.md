# sre-ops S1b → S2 단계 전환 기록

> 1–5절은 2026-11-04~05 초안의 관측과 결정이고, 6절이 2026-11-06 소유자 결정과 활성화 기록입니다.
> 근거: docs/policy/sre-ops.md §8(S1b 전환 조건, S2·S3 착수 조건), §9 D5c.

- 작성: 2026-11-04 초안, 2026-11-06 활성화 기록, Claude Code
- 대상 단계: S1b → S2, 이어서 S3 스위치
- production: `Ops Observer` 배포는 main `a90cdd9e1`(release #3368, S3 코드 #3343 포함)

## 1. S1b 전환 조건 (14일)

처음 관측 구간은 2026-10-24T09:02Z(AEST 19:02)부터 2026-11-07T09:02Z까지였습니다. P8 알림이 있었으므로 §8에 따라 다시 셉니다. 마지막 downtime이 끝난 2026-11-04 AEST 07:02부터 14일, 2026-11-18 AEST 07:02에 끝납니다(추정 시각. 소유자가 받은 마지막 알림 메일로 확인합니다).

| 조건 | 관측 | 상태 |
|---|---|---|
| P8 알림 0회 | 소유자가 2026-11-05에 알림을 받았다고 확인했습니다. 처음에 받지 않았다고 답한 것은 메일의 heartbeat 표현을 P8로 알아보지 못해서였습니다. monitor 기록: page 11월 2회(합계 13분 15초)와 10월 1회(2분 49초), digest 11월 1회(22시간 2분). 두 check 모두 이메일 알림이 켜져 있습니다. monitor의 발송 기록은 보관 기간(page 기준 11-04부터)이 지나 볼 수 없습니다 | **처음 구간은 불충족. 11-04 07:02부터 다시 관측 중** |
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

성공한 heartbeat 사이 간격이 13:20에서 14:03까지 약 43분으로 허용치 30분을 넘었습니다. page의 11월 downtime 합계 13분 15초의 대부분이 이 구간으로 보입니다(13:50 → 14:03). digest의 22시간 2분은 11-03 07:04 heartbeat 실패 뒤 다음 ping까지의 공백으로 보이며(11-03 09:00 → 11-04 07:02), 시각은 cron과 유예에서 계산한 값입니다.

§8에 따라 관측은 그 뒤 근거가 있는 시점부터 다시 세며, 마지막 downtime이 끝난 11-04 07:02부터 세면 11-18 07:02에 끝납니다.

이 실패를 줄이려고 읽기 요청과 heartbeat ping은 연결 실패 때 한 번 다시 시도하도록 고쳤고, 실패 로그에 응답 코드를 남깁니다.

## 2. S2 착수 조건

| 조건 | 상태 |
|---|---|
| S1b 전환 조건 충족 | 1절 |
| page 키가 아닌 readiness 검사의 영향표에 대한 소유자 결정 | **결정됨(2026-11-05):** 3절대로 12개 모두 digest 유지 |
| page 채널이 소유자 전용이고 휴대폰 푸시로 도달 | **완료(2026-11-05).** digest와 다른 비공개 Slack 채널이고 멤버는 소유자뿐입니다. 소유자가 푸시를 설정했습니다. 실제 도달은 webhook 연결 뒤 확인합니다 |
| 점검 요일·시간 창 | **결정됨(2026-11-05):** 화요일 10:00–12:00(Brisbane). 코드에 이 값으로 들어 있습니다 |
| check-in monitor 생성, monitor 셋의 알림 대상이 page 채널이 아님 | **생성됨(2026-11-05).** `ops-observer-channel-check`, 주기 7일, 유예 2일, 이메일 알림 2곳(page 채널 아님). 첫 ping 전에는 알리지 않습니다. URL은 어떤 서비스에도 넣지 않습니다 |
| Railway의 주 프로세스 종료 인식(D5c) | **통과(소유자 판정 2026-11-05).** 근거와 한계는 4절 |
| activation genesis(`live`) | **완료(2026-11-06).** 소유자가 `OPS_OBSERVER_PAGE_WEBHOOK_URL`을 넣은 뒤 Admin 화면에서 승인했습니다. 6절 |

## 3. page 키가 아닌 readiness 검사 영향표 (소유자 결정 2026-11-05)

17개 중 page 키 5개를 뺀 12개입니다. 결정은 모두 **digest 유지**입니다. 고쳐서 배포하면 되돌릴 수 있거나, 다음 날 digest로 봐도 쌓이는 피해가 작다고 보았습니다.

| 검사 | false일 때의 영향 | 결정 |
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

소유자는 이 한계를 안내받고 2026-11-05에 통과로 판정했습니다.

## 5. S3의 남은 항목

- provider 예산 키와 알림 전달 실패 키는 구현했습니다. 2026-11-06에 `OPS_OBSERVER_S3_PAGES`를 켰습니다(6절).
- HTTP 5xx 급증 키는 소유자 결정(2026-11-05)으로 뺐습니다. Railway 읽기 전용 token scope를 문서에서 확인하지 못했고, 토큰을 두지 않습니다.

## 6. 소유자 결정과 활성화 (2026-11-06)

**결정.** 소유자는 2026-11-06 대화에서 S2를 지금 켜라고 지시했습니다("활성화 해주세요"). S1b의 다시 센 관측 구간(11-18 07:02 종료 예정)을 기다리지 않습니다. 같은 날 S3 스위치도 켜라고 지시했습니다. 따라서 §8의 S1b 전환 조건과 S2 전환 조건은 **충족 판정 없이 소유자 결정으로 건너뛴 것**으로 남깁니다. 1절의 미확인 두 줄(추가 genesis, `shadowed`에 이르지 않은 예약)도 판정하지 않았습니다.

| 시각(AEST) | 일 | 누가 |
|---|---|---|
| 11-06 11:19 | Railway `Tomverse Agents` › `Ops Observer`(production)에 `OPS_OBSERVER_PAGE_WEBHOOK_URL` 설정과 배포 | 소유자(값은 대화에 없습니다) |
| 11-06 11:22 이전 | Admin `/admin/sre-ops`에서 activation genesis(`live`) 승인. 직전 genesis는 10-13이라 7일 규칙(D5b)에 걸리지 않습니다 | 소유자 |
| 11-06 11:22 | 첫 page 실행 `mode=live outcome=noop exitCode=0`, 보낸 page 0 | 로그 |
| 11-06 11:23 | 같은 서비스에 `OPS_OBSERVER_S3_PAGES=true` 설정, Railway가 다시 배포 | Claude Code(소유자 지시) |
| 11-06 11:31 | `mode=live outcome=advanced reservedItems=0 exitCode=0`. 상태만 저장했고 보낸 page는 없습니다 | 로그 |

**관측 구간.** S2 관측 14일은 2026-11-06 AEST 11:22부터 셉니다(가장 이른 종료 11-20 11:22). S3의 30일은 11:31부터 셉니다(가장 이른 종료 12-06 11:31). 두 구간이 겹쳐 있으므로, 이 기간의 page가 S2 키에서 왔는지 S3 키에서 왔는지는 전송 기록의 키로 나눠 셉니다.

**아직 확인하지 않은 것.**
- page 채널 휴대폰 도달: 아직 보낸 메시지가 없습니다. 첫 기회는 2026-11-10(화) 10:00–12:00 채널 점검입니다. 소유자가 받으면 check-in URL을 한 번 열어 `ops-observer-channel-check`가 작동합니다.
- S3 키 두 종의 실제 값과 production의 `AdminNotificationLog` `failed` 빈도는 읽지 않았습니다.

**끄는 방법.** `OPS_OBSERVER_S3_PAGES`를 지우면 S3 키만, `OPS_OBSERVER_ENABLED`를 지우면 전부 다음 회차부터 멈춥니다. Railway 변수는 다음 배포부터 반영됩니다.
