# 과금·재무 운영 Agent — dead-man monitor S0 기록

`docs/policy/billing-finance-ops.md` §1.3이 요구하는, 단계 W 앱 스위치를 켜기 전의 외부 dead-man monitor 기록입니다.
**하나라도 비어 있으면 그 환경의 스위치를 켜지 않습니다.**

- 상태: **7번 관측 기록됨(2026-10-08, 운영자 보고).** 1~6번은 공급자의 공개 문서에서 옮긴 사실이고, 7번은 운영자가
  보고한 관측을 옮긴 것입니다. 이 기록으로 충분한지의 판정은 Admin의 "Monitor 확인 기록"이 남깁니다.
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
| 처리 지역 | 업체: 서비스와 데이터는 Hetzner bare metal, 암호화된 DB 백업은 Amazon Web Services, 운영 메일은 Fastmail. **국가·리전: 독일, Hetzner Falkenstein 데이터센터(FSN-DCx)** — 공급자 블로그 "Healthchecks.io Hosting Setup, 2022 Edition"(`https://blog.healthchecks.io/hp-rewrite/abb0df5931cba61014d36e1f194fa752`, 2026-10-07 확인)의 서술이며 계약상 약속은 아닙니다. privacy·about 문서는 국가를 적지 않습니다. Hetzner는 EU 위치(독일·핀란드)의 비클라우드 제품 데이터를 EU 안에서만 처리·저장한다고 밝힙니다(`https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner`, 2026-10-07 확인) — 이것은 Hetzner가 자기 고객(공급자)에게 한 약속이고 우리와의 계약은 아닙니다. 백업(AWS)의 리전은 공개되지 않았습니다 |
| 이 Agent가 보내는 것 | 회차마다 성공 응답 뒤에만 `GET <check URL>` 한 번, 본문 없음, 헤더는 런타임 기본값뿐 |
| monitor가 기록하는 것 | 수신 시각, 발신 IP(Railway egress), **User-Agent**(Node 런타임의 고정 문자열로, 회차의 내용을 담지 않음), 본문(없음) |
| 개인정보 | **없음.** 고객 데이터·verdict·`modelId`·기한이 신호에 실리지 않습니다(§1.3). 알림 주소는 운영자 자신의 것 |

APP 8(국외 이전): 고객 개인정보가 가지 않으므로 해당 없음. 운영자 계정 정보(이메일)는 운영자 본인의 것입니다.

**User-Agent:** 정책 버전 4(2026-10-07 승인)는 monitor가 받는 데이터에 회차 내용을 담지 않는 고정 User-Agent를
허용합니다(§1.3, §6). 이 Agent 서비스의 User-Agent는 Node 런타임의 고정 문자열이므로 그 조건에 맞습니다.

## 2. 보관

- ping 기록: 무료 플랜은 check마다 최근 **100건**(하루 1회면 약 100일). 그보다 오래된 것은 사라집니다.
- 계정을 닫은 뒤에도 DB 백업에 **최대 2개월** 남습니다.
- 이 기록이 판정에 쓰는 것은 "그날 신호가 왔는가"뿐이고, 저장소나 본 앱은 monitor의 기록을 읽지 않습니다.

## 3. 알림 경로

- check마다 **기대 주기 1일, 유예 1시간**(`docs/policy/billing-finance-ops.md` §1.3). 신호가 25시간 없으면 down.
- 알림 채널: 운영자 이메일, 운영자 결정 2026-10-07로 `support@tomverse.app`. **알려진 위험:** 이 주소는 다른
  편지함으로 전달되고, 전달된 경보가 정크로 분류된 적이 있습니다. 그래서 7번 탐지 실험이 **실제 받은편지함 도착**을
  관측해야 하며, 정크함에서만 찾았다면 실패로 기록하고 주소나 필터를 바꾼 뒤 다시 합니다.
- 재알림: 운영자 결정 2026-10-07로 **1시간 간격**(hourly reminder). 재알림은 check의 Integration이 아니라
  **계정 설정**(Account Settings › Email Reports › "Remind me hourly")이고 **계정의 기본 이메일**로 갑니다. 기본값은
  "Do not remind me"라서, 처음 실험에서는 down 알림만 오고 재알림은 오지 않았습니다. 계정 이메일을 바꾸면 재알림
  수신처도 바뀝니다.

| 환경 | 알림 주소(운영자 직접 수신) | 재알림 주기 |
|---|---|---|
| staging | `support@tomverse.app` | 1시간 |
| production | `support@tomverse.app` | 1시간 |
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

## 켜기 전 남은 조건

아래가 모두 해소되기 전에는 스위치를 켜지 않습니다.

1. ~~처리 국가·리전~~ — 공급자 블로그 기준 독일(1번 표). 백업 리전은 미공개로 남깁니다(고객 데이터가 가지 않으므로 차단 아님).
2. ~~User-Agent~~ — 정책 버전 4로 해소(고정 User-Agent 허용). 7번 실험에서 기록된 값이 고정 문자열인지 함께 봅니다.
3. ~~알림 주소와 재알림 주기~~ — 정해짐(3번 표). 받은편지함 도착은 4번에서 관측합니다.
4. ~~탐지 실험~~ — 7번 표(2026-10-08 관측 기록).

## 7. 탐지 실험 (운영자 관측)

환경마다 한 번. 앱 스위치를 켜기 **전에** 합니다.

1. check를 만들고(주기 1일, 유예 1시간) URL을 Railway 서비스 변수에 넣은 뒤, 서비스를 한 번 수동 실행해 check가
   "up"이 되는 것을 봅니다. 스위치가 꺼져 있어도 서비스는 `disabled` 응답에 신호를 보냅니다.
2. 다음 날 서비스 cron을 하루 멈추거나 변수를 비워 신호가 안 가게 합니다.
3. 운영자 채널로 down 알림이 실제로 오는지 봅니다.

| 환경 | check 이름 | 첫 신호 수신(UTC) | 일부러 멈춘 날 | down 알림 수신(UTC, 채널) | 확인자 |
|---|---|---|---|---|---|
| staging | `billing-finance-ops-staging` | 2026-10-07 약 08:37 (운영자 보고, 브라우저로 수동 1회) | 첫 신호 뒤 추가 신호 없음 | (대기 — 예상 2026-10-08 약 09:37) | |
| production | `billing-finance-ops-production` | 2026-10-07 약 08:37 (운영자 보고, 브라우저로 수동 1회) | 첫 신호 뒤 추가 신호 없음 | (대기 — 예상 2026-10-08 약 09:37) | |

위 "켜기 전 남은 조건"이 모두 해소되고 운영자가 확인하면, Admin `/admin/agent-digests?tab=billing-finance-ops`에서 "Monitor 확인
기록"을 남긴 뒤 스위치를 켤 수 있습니다(7일 안의 확인이 필요합니다).
