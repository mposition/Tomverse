# 과금·재무 운영 Agent 정책

상태: **승인됨 — 단계 W 구현 완료, 활성화 전.** 버전 1·2 승인 2026-10-03, 버전 3 승인 2026-10-04, 버전 4 승인 2026-10-07.
approvedBy: mposition · approvedAt: 2026-10-07 · 정책 버전: 4
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-10-03 mposition | 최초 승인. 활성 범위(on-demand 로컬 report) 하나 |
| 2 | 2026-10-03 mposition | 단계 W 추가: 일간 계산과 공통 Agent digest 기록, 앱 소유 스위치, 외부 dead-man monitor와 maintenance 침묵 검사, 공통 `/admin/agents` 읽기 화면, 공통 digest 보존 job(§1.1–§1.4, §4, §7) |
| 3 | 2026-10-04 mposition | 단계 W의 Admin 화면을 이미 있는 공통 Agent digest 영역 `/admin/agent-digests`의 이 Agent 탭으로 바꾸고, 표시를 원문 JSON 대신 닫힌 스키마로 다시 읽은 값으로(§1.2, §1.4, §7 W2). 다른 계약은 바뀌지 않음 |
| 4 | 2026-10-07 mposition | dead-man monitor가 받는 데이터에 회차 내용을 담지 않는 고정 User-Agent를 허용(§1.3, §6). 다른 계약은 바뀌지 않음 |

운영자 `mposition`이 2026-10-03 대화 세션에서 버전 1과 버전 2를, 2026-10-04 대화 세션에서 버전 3을, 2026-10-07 대화 세션에서 버전 4를 승인했습니다. 이 문서는 Claude가 설계하고 교차 vendor 독립 검토(`accept`)를 받은 비공개 설계서를 공개 계약으로 옮긴 것입니다.
내용 변경은 운영자 승인과 정책 버전 증가가 필요합니다. 승인은 단계별 착수 조건을 없애지 않으며, 어떤 workflow·
Railway 서비스·secret·스위치·migration 변경도 그 자체로 허가하지 않습니다.

**이 정책이 덮는 것은 활성 범위(§1)와 단계 W(§1.1–§1.4)입니다.** 통지·production DB 측정·Stripe 대조·공급자 가격 관측은
이 정책에 없고, 각각 새 설계 revision·새 독립 검토·이 문서의 개정 승인이 있어야 시작합니다(§7).

## 0. 승인 판정

승인은 아래 단계를 **모두** 통과해야 인정합니다. 판정은 git·GitHub 기록만으로 재현할 수 있어야 하며, 하나라도
어긋나면 "승인되지 않음"입니다. 판정하는 주체는 구현을 시작하려는 세션(사람, 또는 운영자가 시작한 세션)이고 script가
아닙니다. 판정 시점은 S0 착수 직전과 구현 PR 병합 직전(그 PR의 base에서) 두 번입니다. GitHub 읽기 실패(한도, 네트워크,
응답 형식 불일치)는 불충족이며 추측으로 메우지 않습니다.

| # | 판정 |
|---|---|
| 0 | `approvedBy`의 계정이 판정 base의 `docs/policy/agent-operator-allowlist.md` 목록에 있고, 그 목록 파일이 자기 3절의 규칙으로 승인돼 있다. 그 파일의 최초 commit이 위 `allowlistGenesisCommit`과 정확히 같다 |
| 1 | `git log --first-parent -1 --format=%H <base> -- docs/policy/billing-finance-ops.md`로 이 파일의 현재 바이트를 보호 브랜치에 들여놓은 통합 commit `D`를 구한다. `<base>:<path>`와 `<D>:<path>`의 blob이 같다. `상태:` 줄이 하나이고 `승인됨`으로 시작하며, `approvedBy · approvedAt · 정책 버전` 줄이 정확히 하나, 버전은 앞에 0 없는 양의 정수, 이력 표 마지막 행의 버전과 같다. `allowlistGenesisCommit` 줄이 정확히 하나다 |
| 1f | `D`의 첫 부모 `D^1`에 있던 이 파일의 버전보다 **엄격히 크다**(`D^1`에 파일이 없으면 1이어야 한다. rename·copy면 옛 경로의 버전과 비교하고, 옛 경로를 읽을 수 없으면 불충족. `D`가 root commit이면 불충족). 내용을 되돌리는 변경도 버전을 올린다 |
| 2 | `D`를 `develop`에 넣은 병합 PR이 **정확히 하나**이고, 그 PR 상세의 `merge_commit_sha`가 `D`와 같다. squash·rebase 병합으로 어긋나면 불충족이며, 복구는 이 파일 하나만 담은 새 PR을 사람이 다시 병합하는 것이다 |
| 2a | 그 병합 시각 이후 `develop`의 repository activity에 `force_push`·`branch_deletion` 기록이 **없고**, 읽은 기록이 병합 시각 이전까지 **닿았다**. 닿지 못하면 불충족이다(없음을 본 것이 아니라 보지 못한 것) |
| 3 | 그 PR의 head 브랜치 이름에 `to-develop` 경로 조각이 없다 |
| 4 | 병합자가 사람(`type = User`)이고 `approvedBy`와 같은 계정이다. 병합자를 읽을 수 없으면 불충족 |
| 5 | `approvedAt`이 그 병합 시각의 UTC 날짜와 같다 |
| 6 | 그 PR이 이 파일 **하나만** 바꾸고, 그 파일 항목의 blob이 `<D>:<path>`와 같다. commit 수가 250 이하이고, 모든 commit의 author가 `approvedBy`이며 author·committer가 bot이 아니다 |
| 7 | 그 뒤 이 파일이 다시 바뀌면 1번부터 다시 판정한다 |

**이 판정은 절차를 증명하지 저작을 증명하지 않습니다.** Agent 세션은 운영자와 같은 git 신원으로 commit할 수 있으므로,
기록만으로는 운영자 자격증명으로 만든 commit을 구별하지 못합니다. 이 판정이 잡는 것은 실수와 우회이고, 활성 범위에는
자격증명·게시·저장 상태가 없어 그 경우의 결과도 되돌리면 끝나는 위반입니다.

**force-push를 막는 것은 이 판정이 아닙니다.** 그것은 보호 브랜치 설정(`non_fast_forward`)의 일이며, 그 설정 여부는
운영자 결정이고 이 판정은 그 답을 기다리지 않습니다 — 2a가 관측으로 판정합니다.

## 1. 무엇을 하는가

`PENDING_VERIFIED_PRICE_REGISTER`(`lib/modelPricing.ts`) 항목마다 가격 검증 기한까지 남은 일수와 표시를 계산하고,
등록부 결함을 알려 주는 **report script** 하나입니다.

- 명령: `npm run report:pending-price-deadlines`
  (S0이 `scripts` 아래에 `report-pending-price-deadlines` report script와 판정 core 둘로 만들고, `node --import tsx`로 실행)
- 실행 조건: Node 22와 `npm ci`가 끝난 저장소 checkout. **자격증명이 필요 없고 읽기 전용입니다.**
- 사람이 원할 때(또는 운영자가 시작한 세션이) 직접 실행합니다. 결과는 실행한 사람의 터미널에만 나옵니다.
- 판정은 `findPendingPriceRegisterProblems()`·`daysUntil()`·`AVAILABLE_MODELS`를 재사용하며 다시 구현하지 않습니다.
  core는 `register`·`models`·`now`를 인자로 받는 순수 함수입니다.
- **LLM이 없습니다.**

**이 정책이 약속하지 않는 것**: 매일 계산, 공개 기록, 소유자에게 기한 전 통지가 도달한다는 보장, `main`·`develop` 두
branch의 자동 판정(결과는 실행한 checkout 하나만 반영합니다), 정해진 실행자나 주기. 구현이 끝나면 "도구 사용 가능"으로
기록하고 **"운영 중"으로 기록하지 않습니다.**

**바뀌지 않는 backstop**: 기한 당일 UTC 자정부터 `npm run check:model-pricing`이 실패하고, 그날 이후 열리거나 갱신되는
모든 PR의 PR Fast Gate required check가 실패합니다. 이 script는 그 동작을 바꾸지 않고, 그보다 강한 보장을 주장하지도
않습니다.

### 1.1 단계 W — 일간 계산과 기록

하루 한 번, 각 환경(`production`·`staging`)의 본 앱이 **자기 배포 commit의** `PENDING_VERIFIED_PRICE_REGISTER`로 §2와 같은
판정을 계산해 공통 Agent digest(`AgentDigestItem`)에 한 행으로 남깁니다. 알리지 않고, 가격을 바꾸지 않고, 외부에 쓰지 않습니다.

1. **트리거:** Agents Railway project의 이 Agent 전용 cron 서비스가 `0 1 * * *`(UTC)에 본 앱 내부 route
   `POST /api/internal/agents/billing-finance-ops/runs`를 **한 번** 부릅니다. 본문은 없습니다. 재시도하지 않습니다.
2. **route 순서:** Bearer secret(32자 이상, SHA-256 후 constant-time 비교, 실패 401) → 앱 스위치(§1.2) → 본문이 있으면 400 →
   DB 시계 `startedAt`을 한 번 읽어 `computedAtDate`(그 UTC 날짜)와 `deadlineAt = startedAt + 45초`를 정함 → 환경은 서버가
   자기 배포에서 정하고 `production`·`staging`이 아니면 503 → payload 계산(등록부 항목이 60을 넘으면 잘라내지 않고 409) →
   공통 store `recordAgentDigestItem` 한 트랜잭션.
3. **payload:** `{ environment, computedAtDate, verdict, items[≤60], rejectedFields[≤240] }`, `.strict()`, 자유 텍스트 없음.
   `verificationTicket`·`owner`는 넣지 않습니다. 멱등 키 `billing-finance-ops:price-deadline:<environment>:<computedAtDate>`,
   본문 보존 90일, 메타 365일(공통 불변값).
4. **늦은 실행은 성공으로 기록되지 않습니다.** store 트랜잭션의 마지막 문장이 `clock_timestamp() <= deadlineAt`을 DB 시계로
   검사하고, 거짓이면 행과 감사가 함께 롤백됩니다(409 `deadline_exceeded`). 보장은 "마지막 DB 문장 시점에 마감 안"이며,
   `COMMIT` 완료 시각에는 PostgreSQL 16·17 모두 상한이 없습니다.
5. **응답은 enum뿐입니다**(`created` 201, `replayed` 200, `conflict` 409, `refused` 422, `deadline_exceeded` 409,
   `disabled` 200, `control_unreadable` 503). payload·`modelId`·ticket을 싣지 않습니다.
6. **결과를 모르면 재시도하지 않습니다.** 같은 날 다시 실행돼도 멱등 키가 같아 행이 둘 생기지 않습니다.

### 1.2 앱 스위치

- AppSetting `billingFinanceOps.control` 한 행 `{ enabled, revision, enabledAt }`. 처음 배포 때 migration이 꺼진 행으로 만듭니다.
- reader는 `enabled`·`disabled`·`unreadable`(DB 오류, 행 없음, 형식 불일치) 세 상태를 돌려주고, **`unreadable`을
  `disabled`로 바꾸지 않습니다.** 실행은 `enabled`일 때뿐입니다.
- 변경은 Admin 공통 Agent digest 영역(`/admin/agent-digests`)의 이 Agent 탭에 있는 route 하나뿐이며 `ops:write` 권한과 최근 로그인을 route 안에서 검사하고, 갱신과
  `writeAdminAuditLog`를 같은 트랜잭션에 씁니다. **켜는 변경은 7일 안의 monitor 확인 기록(§1.3)이 있어야 하고**, 끄는 변경은
  아무것도 요구하지 않습니다. 자동 복귀와 자동 정지 트리거는 없습니다.
- 서비스의 `BILLING_FINANCE_OPS_AGENT_ENABLED`는 스위치가 아니라 배포 설정입니다(unset이면 아무것도 부르지 않고 exit 0).

### 1.3 침묵 감지 — 신호 둘

| 신호 | 무엇 | 언제 |
|---|---|---|
| 1 (주) | **외부 dead-man monitor**(환경마다 하나, 기대 주기 24시간 + 유예 1시간). 본 앱·Railway·GitHub와 계정·자격증명·일정·상태를 공유하지 않습니다 | 서비스는 응답이 `created`·`replayed`·`conflict` 또는 인증된 `disabled`일 때만 신호 URL에 값 없는 GET을 한 번 보냅니다. 그 밖(401, 503, `deadline_exceeded`, `refused`, 500, 예외, timeout)에는 보내지 않으므로 서비스·Railway·앱·DB 정지와 늦거나 거절된 회차가 모두 신호의 부재가 됩니다 |
| 2 (보조) | 기존 Maintenance Cron의 step `billing_finance_ops_silence` | 스위치가 `enabled`이고 `enabledAt`이 그날 01:00 UTC 이전인데 그날 그 환경의 행이 없으면 `BILLING_FINANCE_OPS_DEADLINE_SILENT`, 스위치가 `unreadable`이면 `BILLING_FINANCE_OPS_CONTROL_UNREADABLE` 운영 incident. context는 environment·date뿐 |

경보에는 verdict·`modelId`·기한이 실리지 않습니다 — 경보는 기한 통지(단계 N)가 아닙니다. 두 신호가 함께 침묵하는 조합(monitor
정지와 앱·DB 정지가 겹침)은 막는다고 적지 않습니다.

**monitor의 S0 기록**(켜기 전, 환경마다): 처리자·처리 지역과 monitor가 받는 데이터(신호 시각, 발신 IP, 그리고 HTTP 요청에 붙는 **고정 User-Agent**뿐임을 확인. User-Agent는 런타임이나 서비스가 정한 고정 문자열이어야 하고 회차의 결과·verdict·`modelId`·기한 같은 회차 내용을 담지 않습니다), 보관 기간,
알림 채널과 재알림 주기(본문이 monitor 이름뿐임을 확인), export와 교체 절차, monitor 자신의 장애를 알 수 있는지, 독립성,
그리고 **탐지 실험** — 신호를 일부러 멈춘 하루에 운영자 채널로 알림이 실제로 왔다는 수신 관측. 하나라도 비어 있으면 켜지
않습니다.

### 1.4 결과를 읽는 곳과 보존

- **공통 Agent digest 영역 `/admin/agent-digests`의 이 Agent 탭.** 그 영역은 이미 있고 Agent마다 탭(`?tab=`) 하나를
  둡니다(`docs/policy/qa-release-agent.md` §4). 새 Admin 화면을 만들지 않고, 탭 하나를 더합니다(Admin IA 계약의 탭 규칙).
- **보이는 것은 닫힌 스키마의 값뿐입니다.** 최근 14개 행마다 계산 날짜, 저장 시각, 크기, 본문 상태(있음·만료·읽을 수 없음),
  그리고 본문이 있으면 verdict, 항목(`modelId`·만료일·남은 일수·mark)과 거절 필드(index·필드 이름). 본문은 이 문서 §1.1의
  닫힌 스키마로 다시 읽고, 통과하지 못하면 값을 하나도 보이지 않고 "읽을 수 없음"으로 보입니다. 값은 escape된 텍스트로만
  그리고, 원문 JSON은 보이지 않습니다. 화면은 자기가 보이는 개수(14)를 적습니다. 화면이 보여 주는 것은 기록이지 통지가
  아닙니다(통지는 단계 N).
- 이 탭의 변경은 §1.2 스위치와 monitor 확인 두 개뿐이며 둘 다 감사됩니다.
- **공통 보존 job:** 본문 만료(`retentionUntil`이 지난 행의 본문 삭제)와 메타 삭제(본문이 지워지고 365일이 지난 행)를
  모든 `agentKey`에 대해 maintenance step 두 개로 돌립니다. 배치 200행, 배치마다 시스템 감사 1행. **본문 삭제는 되돌릴 수
  없으므로** 대상이 보존 기간이 지난 행뿐임을 DB 통합 test로 보이고, 기존 trigger가 그 밖을 거절하는 것을 그대로 둡니다.

## 2. report 계약

아래 값 가운데 mark 폭, exit code, `modelId` 길이 100은 **이 정책의 승인으로 확정되는 값**입니다.

### 2.1 출력 줄

항목마다 한 줄:

```
register_deadline modelId=<id> registeredAt=<YYYY-MM-DD> expiresAt=<YYYY-MM-DD> remainingDays=<int|NONE> mark=<none|30|14|7|1|expired> ticket=<NONE|s:percent-encoded>
```

거절된 필드가 있는 항목은 위 줄 대신 거절된 필드마다:

```
register_value_rejected index=<등록부 0부터의 정수> field=<modelId|registeredAt|expiresAt|ticket>
```

그리고 정책 인용 한 줄("기한만 미루는 것은 승인이 아닙니다", `docs/policy/credit-and-cost-limits.md`)과 마지막 줄
`verdict=<quiet|notice|register_invalid>`. 등록부가 비어 있으면 항목 줄 없이 `verdict=quiet`입니다.

### 2.2 값 encoding

tracked 값을 그대로 출력하지 않고 필드마다 한 규칙만 적용합니다.

| 필드 | 규칙 |
|---|---|
| `modelId` | `^[a-z0-9][a-z0-9._/-]{0,99}$`에 맞으면 그대로, 아니면 거절 |
| `registeredAt`·`expiresAt` | `^\d{4}-\d{2}-\d{2}$`에 맞으면 그대로(달력상 해석할 수 없으면 `remainingDays=NONE mark=none`), 아니면 거절 |
| `ticket` | `null`이면 `NONE`. 문자열이면 `s:` 뒤에 UTF-8 byte 기준 percent encoding — `A–Z a–z 0–9 . _ ~ -` 밖의 모든 byte를 대문자 `%XX`로. 짝 없는 surrogate는 거절 |

거절된 값은 **어느 부분도 출력하지 않습니다.**

### 2.3 결과 문법

정책 인용 줄을 뺀 모든 줄은 ASCII `0x21–0x7E` token을 공백 하나로 이은 것이고, 첫 token은 `register_deadline` 또는
`register_value_rejected`이거나 줄 전체가 `verdict=<enum>`입니다. key 순서는 위와 같이 고정이고 값에는 공백·`=`·개행이
없습니다. `verdict=` 줄은 정확히 하나이며 마지막 줄입니다. 그러므로 tracked 값이 가짜 `verdict=` 줄이나 추가 token을 만들
수 없습니다. 이 문법 밖의 출력은 script 결함입니다. 출력에 명령형 문장이 없습니다.

### 2.4 mark

| `remainingDays` | mark |
|---|---|
| 30, 29 | `30` |
| 14, 13 | `14` |
| 7, 6 | `7` |
| 2, 1 | `1` |
| 0 이하 | `expired` |
| 그 밖 | `none` |

폭은 서로 겹치지 않습니다. `remainingDays`가 항상 함께 출력되므로 표시 없는 날에도 남은 일수를 읽을 수 있습니다.

### 2.5 verdict와 exit code

| verdict | 조건 | exit |
|---|---|---|
| `register_invalid` | `expired`가 아닌 등록부 error(`duplicate`·`priced`·`invalid_dates`)가 하나라도 있거나, 2.2의 거절이 하나라도 있음 | 2 |
| `notice` | 위가 아니고 `mark`가 `none`이 아닌 항목이 하나라도 있음 | 2 |
| `quiet` | 그 밖 | 0 |

owner·ticket·승인 누락 warning은 verdict에 반영하지 않습니다(`check:model-pricing`이 이미 출력합니다). script가 예외로
끝나면 `verdict=` 줄이 없습니다. **`verdict=` 줄이 없는 결과를 "알릴 것 없음"으로 읽는 문구·문서를 두지 않습니다.**

## 3. 절대 조건

1. **실행 지점은 §1.1의 Railway 서비스 하나와 내부 route 하나뿐입니다.** 판정 core를 부르는 다른 workflow·schedule·cron·
   서비스·route·git hook·npm lifecycle script를 만들지 않습니다. 로컬 script(§1)는 그대로 사람이 실행합니다.
2. **로컬 script와 판정 core는 네트워크 요청·subprocess·파일 쓰기·환경변수 읽기를 하지 않고, 새 의존성을 추가하지 않습니다.** 출력은
   stdout과 exit code뿐이고, import하는 저장소 module은 `check:model-pricing`과 같은 범위입니다.
3. 출력은 §2의 줄과 정책 인용 한 줄뿐이며 tracked source에서만 계산됩니다. production·Stripe·공급자 응답에서 온 값이
   없습니다.
4. exit code는 §2.5로 고정합니다.
5. **이 Agent는 `PENDING_VERIFIED_PRICE_REGISTER`, 가격·크레딧 값, release gate registry, `docs/policy/perplexity-sonar-credit-price-hold.md`의
   승인 기록, `check:model-pricing`을 편집하지 않고 편집을 제안하지 않습니다.** 가격 초안(`priceSchedule`·가격 PR)도 만들지
   않습니다 — 가격 결정은 사람의 판정입니다(`docs/policy/credit-and-cost-limits.md`).
6. **자격증명의 최소 집합.** 로컬 script는 아무것도 갖지 않습니다. 단계 W의 Railway 서비스가 갖는 것은 제출 secret
   `BILLING_FINANCE_OPS_RUN_SECRET`, dead-man 신호 URL `BILLING_FINANCE_OPS_DEADMAN_URL`, 배포 설정
   `BILLING_FINANCE_OPS_AGENT_ENABLED` 셋뿐이며, 신호 URL은 로그에 남기지 않습니다. 이 밖의 것을 갖지 않습니다.
7. 이 Agent의 기록은 기한을 소유자에게 **전달**한다고 주장하지 않습니다. 단계 W는 계산해 본 앱에 남길 뿐입니다.
8. **앱 DB의 role·grant·함수 ACL을 바꾸는 SQL·절차·초안은 어느 단계에도 두지 않습니다.**
9. 후속 단계(§7)는 새 설계 revision, 새 독립 검토, 이 문서의 개정 승인 없이 시작하지 않습니다.
10. 소유자 전달 경로(push 통지, issue·comment·webhook, GitHub 기본 알림을 전달 근거로 쓰는 것)를 더하는 것은 단계 N이며
    단계 W보다 먼저 올 수 없습니다. **§1.3의 dead-man 생존 신호는 전달 경로가 아닙니다** — 값이 없는 GET이고, 알리는 것은
    "회차가 끊겼다"뿐이며 기한·verdict·`modelId`를 싣지 않습니다. 생존 신호나 침묵 경보에 그런 값을 싣는 변경은 단계 N입니다.
11. **어느 단계도 GitHub Actions를 실행 경로로 쓰지 않습니다.** 실행 서비스에 제품 DB 자격증명(read replica 포함)·GitHub
    쓰기 자격증명·소유자 통지 채널 자격증명·제3자 결제 자격증명(Stripe restricted key 포함)을 주지 않고, GitHub에 결과를
    게시하지 않습니다(issue·comment·commit status·check·branch·PR·artifact). 제품 상태는 본 앱 내부 route로만 읽고 씁니다.
12. **이 문서를 뺀 어떤 파일도 §0 판정이 "승인됨"이기 전에 구현·병합하지 않습니다.** Agent는 이 문서와
    `docs/policy/agent-operator-allowlist.md`를 commit·push·PR·병합하지 않고 승인 필드를 채우지 않습니다. 정책 PR과 구현
    PR은 `to-develop` 경로 조각이 없는 브랜치에서 열고, auto-merge를 켜지 않으며, 사람이 병합합니다.

### 3.1 위반의 분류

위반이 발견되면 그 변경을 되돌립니다. **release blocker는 되돌릴 수 없는 것이 실제로 일어난 경우뿐입니다.**

| id | 무엇이 일어났나 | 되돌릴 수 없는 이유 |
|---|---|---|
| B1 | 실행 환경의 값이 이 Agent의 script를 통해 프로세스 밖으로 나갔다 | 유출은 회수가 성립하지 않는다 |
| B2 | 이 Agent가 쥔 자격증명의 값이 로그·빌드 산출물·출력·저장소에 나타났다 | 회전해도 노출된 사실은 남는다 |
| B3 | 이 Agent의 결과나 비공개 데이터가 공개 저장소에 게시됐다 | 공개 이력에서 회수되지 않는다 |
| B4 | 이 Agent가 이력으로 복원할 수 없는 제품 상태(`Conversation.selectedModels`, pin된 profile version, 사용자 데이터, `CreditLedgerEntry` 행을 함께 쓰지 않은 `CreditLot` 변경)를 직접 바꿨다 | 원상 복구할 이력이 없다 |

그 밖의 위반은 **구현·병합 차단**(그 PR을 병합하지 않고 그 단계를 열지 않음) 또는 **일반 검토**(고쳐서 배포하면 끝남)입니다.
release blocker가 아니라는 것은 통과시킨다는 뜻이 아닙니다. 자격증명을 **쥔** 것은 병합 차단이고, 그 값이 **샌** 것이
B2입니다.

**차단의 대부분은 사람의 검토입니다.** 이 저장소의 `develop`은 승인 0건으로 병합될 수 있으므로 중앙 gate가 대신 막아
주지 않습니다. 자동 검사는 구현 PR의 test가 `.github/workflows/**`·`.railway/**`·`package.json`의 다른 script에서 이
script 이름의 참조를 찾고(단계 W의 서비스 선언과 그 npm script만 허용), 로컬 script와 core 안의 네트워크·subprocess·
파일 쓰기·환경변수 읽기 형태를 찾는 **문자열 회귀 경보**이며 증명이 아닙니다. 다른 이름의 wrapper나 검사가 열거하지 않은 형태는 코드 검토의 몫입니다.

## 4. 실행 위치와 자격증명

- **로컬 script(§1):** 실행 위치는 사람의 checkout이고 자격증명·게시·저장이 없습니다.
- **단계 W(§1.1):** Agents Railway project의 전용 cron 서비스(`restartPolicyType: NEVER`, IaC 선언, apply는 운영자)가 트리거이고,
  계산과 저장은 본 앱 내부 route입니다 — LLM도 외부 텍스트도 없는 결정적 판정이기 때문입니다. 서비스에는 제품 DB·GitHub·
  결제 자격증명이 없습니다.
- **마감:** 서비스 전체 hard timeout 90초(감독 타이머가 끝나면 진행 중인 요청을 abort하고 exit 1), route 호출 abort 70초,
  route `maxDuration` 60초. 앱 쪽은 공통 store가 거는 `statement_timeout` 2초·`idle_in_transaction_session_timeout` 1초·
  PostgreSQL 17 이상의 `transaction_timeout` 32초(설정 문장 이후, `COMMIT` durable 단계 제외)와 §1.1의 4번입니다.
- **게시 없음.** 결과는 본 앱 DB와 Admin에만 있습니다.

## 5. 비용

LLM·외부 유료 API·GitHub Actions 실행이 없습니다. 비용 namespace는 `agent:billing-finance-ops`이며 사용자 크레딧·플랜·Chat
provider 예산과 섞지 않습니다. 구조적 상한은 환경당 하루 POST 1회 × 90초와 dead-man 신호 1회입니다. dead-man monitor 요금이
생기면 그 namespace로 셉니다.

## 6. 개인정보

활성 범위는 개인정보를 수집·저장·전송하지 않습니다. 입력은 저장소의 tracked source뿐이고, 등록부의 `owner` 필드는 출력하지
않으며, 출력은 실행한 사람의 터미널에만 남습니다. 사용자 콘텐츠·DB 행·결제 데이터를 읽지 않습니다. 후속 단계가 무엇이든
저장하거나 보내면 그 단계의 정책 개정이 APP 확인값(수집 필요성, 통지, 처리 지역)을 함께 기록합니다.

단계 W도 개인정보를 다루지 않습니다. payload에 `owner`·ticket이 없고, dead-man monitor가 받는 것은 신호 시각, 발신 IP, 회차 내용을 담지 않는 고정 User-Agent뿐이며
(§1.3 S0 기록이 확인), 알림 주소는 운영자 자신의 것입니다. 그래서 APP 8(국외 이전) 대상이 없습니다.

## 7. 단계

| 단계 | 내용 | 시작 조건 |
|---|---|---|
| S0 | report script·core·`package.json` script·test. 그 PR을 사람이 병합 (완료, 2026-10-03) | §0 판정이 `origin/develop` 끝에서 "승인됨". 병합 직전 그 PR의 base에서 다시 판정 |
| S1 | 도구 사용 가능. 켤 것이 없습니다(workflow·변수·서비스·스위치 없음) | S0 병합. 평가 창·운영 지표 없음. 기록은 "도구 사용 가능" |
| W1a | 공통 digest 계약에 `billing-finance-ops` 등록(`contract` 등급 migration: agentKey·kind CHECK와 보존 CASE만 확장, 제어 행 생성) | S1 완료(충족)와 이 문서 버전 2의 §0 판정 "승인됨" |
| W1b | 판정 core의 구조화 결과, payload 스키마, route와 마감 검사 | 같음 |
| W1c | Railway 트리거 서비스(IaC, hard timeout, 변수 allowlist)와 dead-man 신호 | 같음 |
| W1d | maintenance 침묵 검사 | 같음 |
| W2 | 공통 Agent digest 영역(`/admin/agent-digests`)의 이 Agent 탭, 앱 스위치 변경 route, monitor 확인 기록 | 이 문서 버전 3의 §0 판정 "승인됨" |
| W3 | 공통 보존 job 두 개 | 같음. **production에서 켜기 전에 병합** |
| W-staging | 운영자: Railway apply·secret·변수, monitor 생성과 §1.3 S0 기록, Admin monitor 확인, 앱 스위치 켜기 | W1a–W3 병합과 staging 배포 |
| W-production | 같은 순서를 production에서 | 아래 관찰 창 충족 |

**staging 관찰 창**(production 착수 조건): 연속 **14** UTC 날 동안 (1) 각 날 그 환경의 행이 **정확히 1개**, (2)
`deadline_exceeded`·`refused`·`control_unreadable` **0건**, (3) 의도적으로 서비스를 하루 멈춘 날에 dead-man monitor 알림과
`BILLING_FINANCE_OPS_DEADLINE_SILENT`가 **각각 1회** 수신. 조건이 깨지면 창은 처음부터 다시 셉니다. 각 조각의 PR은
`to-develop` 경로 조각 없는 브랜치에서 열고, 사람이 병합하며, 병합 직전 그 PR의 base에서 §0을 다시 판정합니다.

**후속 단계 — 이 정책의 범위가 아닙니다.** 아래는 승인도 계획도 아니며, 각 단계는 새 설계 revision과 새 독립 검토, 그리고
그 단계를 담은 이 문서의 개정(버전 증가와 §0 재판정)이 있어야 시작합니다.

| 단계 | 내용 |
|---|---|
| N | 소유자 전용 push 통지. W 뒤에만 |
| D | production DB 측정 |
| S | Stripe 읽기 대조. D 뒤에만 |
| P | 공급자 가격 페이지 관측 |

어느 후속 단계든 §3의 11번(실행 위치와 금지 자격증명)과 8번(DB 권한 변경 금지)을 그대로 지키며, 바꾸려면 그 단계의 정책
개정이 근거를 새로 증명합니다.

## 8. 사람에게 남는 일

| 일 | 누가 |
|---|---|
| 이 문서를 본인이 commit하고, `to-develop` 경로 조각 없는 브랜치의 PR(이 파일 하나만)을 본인 계정으로 병합 | 운영자 |
| 구현 PR의 병합 | 운영자 |
| 등록부 항목의 처리(검증된 가격 추가 또는 production 유지 재승인) | 기존 가격 정책의 담당자 |
| 단계 W의 Railway apply, secret·변수 설정, dead-man monitor 생성과 S0 기록·탐지 실험, Admin monitor 확인과 스위치 켜기·끄기 | 운영자 |
| 후속 단계를 열지의 결정 | 운영자 |

반복되는 사람 일은 스위치를 **다시 켤 때의 monitor 확인**(7일 안)뿐입니다 — 이미 켜진 스위치는 확인이 낡아도 멈추지
않습니다. 경보(§1.3)가 오면 원인을 보는 것은 운영 일이며, 경보는 환경당 하루 많아야 두 번입니다. owner-bound 대기열은 없습니다.
