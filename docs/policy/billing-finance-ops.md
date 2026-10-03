# 과금·재무 운영 Agent 정책

상태: **승인됨 — 구현 없음.** 작성 2026-10-03, 승인 2026-10-03.
approvedBy: mposition · approvedAt: 2026-10-03 · 정책 버전: 1
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-10-03 mposition | 최초 승인. 활성 범위(on-demand 로컬 report) 하나 |

운영자 `mposition`이 2026-10-03 대화 세션에서 이 문서를 승인했습니다(버전 1). 이 문서는 Claude가 설계하고 교차 vendor 독립 검토(`accept`)를 받은 비공개 설계서를 공개 계약으로 옮긴 것입니다.
내용 변경은 운영자 승인과 정책 버전 증가가 필요합니다. 승인은 단계별 착수 조건을 없애지 않으며, 어떤 workflow·
Railway 서비스·secret·스위치·migration 변경도 그 자체로 허가하지 않습니다.

**이 정책이 덮는 것은 활성 범위 하나뿐입니다.** 정기 실행·기록·통지·production 측정·Stripe 대조·공급자 가격 관측은
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

1. **실행 지점을 만들지 않습니다.** 이 script를 부르는 workflow·schedule·cron·Railway 서비스·본 앱 내부 route·git hook·
   npm lifecycle script를 만들지 않고, 기존 workflow나 `.railway/**`에 더하지도 않습니다. 그것은 §7의 단계 W입니다.
2. **script는 네트워크 요청·subprocess·파일 쓰기·환경변수 읽기를 하지 않고, 새 의존성을 추가하지 않습니다.** 출력은
   stdout과 exit code뿐이고, import하는 저장소 module은 `check:model-pricing`과 같은 범위입니다.
3. 출력은 §2의 줄과 정책 인용 한 줄뿐이며 tracked source에서만 계산됩니다. production·Stripe·공급자 응답에서 온 값이
   없습니다.
4. exit code는 §2.5로 고정합니다.
5. **이 Agent는 `PENDING_VERIFIED_PRICE_REGISTER`, 가격·크레딧 값, release gate registry, `docs/policy/perplexity-sonar-credit-price-hold.md`의
   승인 기록, `check:model-pricing`을 편집하지 않고 편집을 제안하지 않습니다.** 가격 초안(`priceSchedule`·가격 PR)도 만들지
   않습니다 — 가격 결정은 사람의 판정입니다(`docs/policy/credit-and-cost-limits.md`).
6. **활성 범위에서 이 Agent는 어떤 자격증명도 갖지 않습니다.** 후속 단계는 그 단계의 정책 개정이 승인한 최소 집합 밖의
   것을 갖지 않습니다.
7. 이 Agent의 기록은 활성 범위가 기한을 매일 계산하거나 공개 기록으로 남기거나 소유자에게 전달한다고 주장하지 않습니다.
8. **앱 DB의 role·grant·함수 ACL을 바꾸는 SQL·절차·초안은 어느 단계에도 두지 않습니다.**
9. 후속 단계(§7)는 새 설계 revision, 새 독립 검토, 이 문서의 개정 승인 없이 시작하지 않습니다.
10. 소유자 전달 경로(push 통지, issue·comment·webhook·heartbeat, GitHub 기본 알림을 전달 근거로 쓰는 것)를 더하는 것은
    단계 N이며 단계 W보다 먼저 올 수 없습니다.
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
script 이름의 참조와 script 안의 네트워크·subprocess·파일 쓰기·환경변수 읽기 형태를 찾는 **문자열 회귀 경보**이며 증명이
아닙니다. 다른 이름의 wrapper나 검사가 열거하지 않은 형태는 코드 검토의 몫입니다.

## 4. 실행 위치와 자격증명

활성 범위에는 실행 서비스·cron·queue·worker·본 앱 route가 없습니다. 실행 위치는 사람의 checkout이고, 자격증명은 없으며,
게시도 없습니다. 상태·초안·승인 기록을 둘 곳도 없습니다 — 저장하는 것이 없기 때문입니다.

## 5. 비용

LLM·외부 유료 API·외부 monitor·GitHub Actions 실행이 없습니다. 비용은 실행한 사람의 로컬 실행 시간뿐입니다. 후속 단계에서
비용이 생기면 그 namespace는 `agent:billing-finance-ops`이며 사용자 크레딧·플랜·Chat provider 예산과 섞지 않습니다.

## 6. 개인정보

활성 범위는 개인정보를 수집·저장·전송하지 않습니다. 입력은 저장소의 tracked source뿐이고, 등록부의 `owner` 필드는 출력하지
않으며, 출력은 실행한 사람의 터미널에만 남습니다. 사용자 콘텐츠·DB 행·결제 데이터를 읽지 않습니다. 후속 단계가 무엇이든
저장하거나 보내면 그 단계의 정책 개정이 APP 확인값(수집 필요성, 통지, 처리 지역)을 함께 기록합니다.

## 7. 단계

| 단계 | 내용 | 시작 조건 |
|---|---|---|
| S0 | report script·core·`package.json` script·test. 그 PR을 사람이 병합 | §0 판정이 `origin/develop` 끝에서 "승인됨". 병합 직전 그 PR의 base에서 다시 판정 |
| S1 | 도구 사용 가능. 켤 것이 없습니다(workflow·변수·서비스·스위치 없음) | S0 병합. 평가 창·운영 지표 없음. 기록은 "도구 사용 가능" |

S1 뒤에 이 정책이 여는 단계는 없습니다.

**후속 단계 — 이 정책의 범위가 아닙니다.** 아래는 승인도 계획도 아니며, 각 단계는 새 설계 revision과 새 독립 검토, 그리고
그 단계를 담은 이 문서의 개정(버전 증가와 §0 재판정)이 있어야 시작합니다.

| 단계 | 내용 |
|---|---|
| W | 기한 판정의 일간 정기 실행과 그 기록. 실행 실패와 누락을 실패한 구성요소에 의존하지 않고 감지하는 경로가 진입 조건 |
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
| 후속 단계를 열지의 결정 | 운영자 |

반복되는 사람 일은 없습니다. script를 정기적으로 실행할 사람을 정하지 않으며, 누군가 실행하기로 선택하는 것은 선택이지
이 Agent가 만든 일이 아닙니다. owner-bound 대기열과 알림이 없으므로 이 Agent의 owner-bound 항목 수는 0입니다.
