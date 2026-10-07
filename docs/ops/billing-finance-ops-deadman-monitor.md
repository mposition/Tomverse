# 과금·재무 운영 Agent — dead-man monitor S0 기록

`docs/policy/billing-finance-ops.md` §1.3이 요구하는, 단계 W 앱 스위치를 켜기 전의 외부 dead-man monitor 기록입니다.
**하나라도 비어 있으면 그 환경의 스위치를 켜지 않습니다.**

- 상태: **초안.** 1~6번은 공급자의 공개 문서에서 옮긴 사실이고, 7번(탐지 실험)은 운영자의 관측을 기다립니다.
  실행자가 각 줄을 확인한 뒤 이 상태 줄을 바꿉니다.
- 공급자 선택: 운영자 결정 2026-10-07 — engineering Agent와 같은 monitor 서비스를 쓰며, 두 Agent 모두 아직
  monitor가 없으므로 이 기록이 그 서비스를 정합니다.
- 공급자: **Healthchecks.io** (hosted). 선택 이유: engineering Agent 서비스 코드가 쓰는 ping 형식이 이 서비스와 같고
  (`<URL>`, `<URL>/fail`), 이 Agent의 신호(본문 없는 GET)가 그대로 맞으며, 무료 플랜의 20개 check 안에
  두 Agent의 monitor(이 Agent 2개, engineering Agent 2개)가 들어갑니다.
- 출처 확인일: 2026-10-07 (`https://healthchecks.io/privacy/`, `/docs/http_api/`, `/pricing/`,
  `/docs/configuring_notifications/`).

## 1. 처리자와 데이터

| 항목 | 값 |
|---|---|
| 운영 주체 | SIA Monkey See Monkey Do (라트비아, 리가) |
| 처리 지역 | 서비스와 데이터: Hetzner. 암호화된 DB 백업: Amazon Web Services. 운영 메일: Fastmail |
| 이 Agent가 보내는 것 | 회차마다 성공 응답 뒤에만 `GET <check URL>` 한 번, 본문 없음, 헤더는 런타임 기본값뿐 |
| monitor가 기록하는 것 | 수신 시각, 발신 IP(Railway egress), User-Agent, 본문(없음) |
| 개인정보 | **없음.** 고객 데이터·verdict·`modelId`·기한이 신호에 실리지 않습니다(§1.3). 알림 주소는 운영자 자신의 것 |

APP 8(국외 이전): 고객 개인정보가 가지 않으므로 해당 없음. 운영자 계정 정보(이메일)는 운영자 본인의 것입니다.

## 2. 보관

- ping 기록: 무료 플랜은 check마다 최근 **100건**(하루 1회면 약 100일). 그보다 오래된 것은 사라집니다.
- 계정을 닫은 뒤에도 DB 백업에 **최대 2개월** 남습니다.
- 이 기록이 판정에 쓰는 것은 "그날 신호가 왔는가"뿐이고, 저장소나 본 앱은 monitor의 기록을 읽지 않습니다.

## 3. 알림 경로

- check마다 **기대 주기 1일, 유예 1시간**(`docs/policy/billing-finance-ops.md` §1.3). 신호가 25시간 없으면 down.
- 알림 채널: 운영자 이메일. **`support@` 전달 주소는 쓰지 않습니다** — 전달된 경보가 받은편지함에 닿지 않은
  적이 있습니다. 운영자가 직접 받는 주소를 씁니다.
- 재알림: 계정 설정의 hourly/daily reminder를 켭니다(down이 풀릴 때까지 반복).
- 알림 본문: check 이름과 상태뿐입니다. check 이름은 `billing-finance-ops-staging` /
  `billing-finance-ops-production`처럼 Agent와 환경만 담고, 그 밖의 값을 넣지 않습니다.

## 4. export와 교체

- 개인 데이터 portability 요청과 계정 설정에서의 삭제를 제공합니다(공급자 privacy 문서).
- 교체 절차: 새 공급자에 check를 만들고 → Railway 변수 `BILLING_FINANCE_OPS_DEADMAN_URL`을 새 URL로 바꾸고 →
  다음 회차의 신호 수신을 확인한 뒤 → 이전 check를 지웁니다. 그 사이에 스위치를 끌 필요는 없습니다(신호가
  끊기면 이전 monitor가 알릴 뿐입니다).

## 5. monitor 자신의 장애

- 공급자 상태 페이지: `https://status.healthchecks.io/`.
- monitor가 멈추면 신호 1은 알릴 주체가 없습니다. 그동안 신호 2(maintenance 침묵 검사)는 앱이 살아 있는 한
  계속 봅니다. 두 쪽이 함께 멈추는 조합은 막는다고 적지 않습니다(§1.3).

## 6. 독립성

- **계정은 이메일·비밀번호로 만듭니다.** GitHub로 로그인하지 않습니다 — GitHub와 자격증명을 공유하게 됩니다.
- Railway·본 앱·GitHub와 일정·코드·자격증명·상태를 공유하지 않습니다. check URL은 Railway 서비스 변수에만
  두고, 로그·저장소·Admin에 남기지 않습니다(정책 §3 6번).
- check URL은 성공 신호를 위조할 수 있는 값입니다. 새면 B2이며, 위조가 가리는 것은 신호 2가 봅니다.

## 7. 탐지 실험 (운영자 관측 — 미기록)

환경마다 한 번. 앱 스위치를 켜기 **전에** 합니다.

1. check를 만들고(주기 1일, 유예 1시간) URL을 Railway 서비스 변수에 넣은 뒤, 서비스를 한 번 수동 실행해 check가
   "up"이 되는 것을 봅니다. 스위치가 꺼져 있어도 서비스는 `disabled` 응답에 신호를 보냅니다.
2. 다음 날 서비스 cron을 하루 멈추거나 변수를 비워 신호가 안 가게 합니다.
3. 운영자 채널로 down 알림이 실제로 오는지 봅니다.

| 환경 | check 이름 | 첫 신호 수신(UTC) | 일부러 멈춘 날 | down 알림 수신(UTC, 채널) | 확인자 |
|---|---|---|---|---|---|
| staging | | | | | |
| production | | | | | |

두 행이 채워지고 운영자가 확인하면, Admin `/admin/agent-digests?tab=billing-finance-ops`에서 "Monitor 확인
기록"을 남긴 뒤 스위치를 켤 수 있습니다(7일 안의 확인이 필요합니다).
