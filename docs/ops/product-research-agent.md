# 제품·리서치 Agent 운영

정책: `docs/policy/product-research-agent.md`. 이 문서는 **운영자가 하는 일만**
적습니다. 판정·보존·침묵 검사는 앱이 하고, 여기 있는 어떤 단계도 그것을
대신하지 않습니다.

**정책이 아직 미승인입니다.** 아래 어떤 단계도 승인 전에는 실행하지 않습니다.
승인 판정은 정책 문서 머리의 7단계입니다.

## 무엇이 있는가

| 서비스 | project | 환경 | 진입점 | 일정 | 강제 종료 |
|---|---|---|---|---|---|
| Product Research Observation | Tomverse Agents | production·staging | `npm run agent:product-research-observation` | 매일 21:30 UTC | 15분 |
| Product Research Probe | Tomverse Agents | production·staging·dev | 같은 script `--probe` | 없음(손으로 실행) | 15분 |

- 두 서비스는 **별도 Railway project**(`Tomverse Agents`)에 있습니다. reference
  변수는 자기 project 안에서만 해석되므로, DB 서비스와 공유 변수가 없는 project는
  `${{ Postgres.DATABASE_URL }}`가 가리킬 대상 자체가 없습니다.
- 그 project의 IaC 파일은 `.railway/agents-railway.ts`이고 **partial을 export하지
  않습니다.** 즉 project 전체를 소유하므로, 누가 손으로 DB 서비스를 추가하면
  다음 apply가 지웁니다. 그것이 이 분리의 요점입니다.
- 기존 `Tomverse` project의 cron은 `.railway/railway.ts`가 named partial로
  소유합니다. **두 파일을 섞지 않습니다** — `railway:iac:*` script는 공유
  project를, `railway:agents:*`는 Agent project를 대상으로 합니다.
- **probe는 환경마다 하나씩 있습니다.** 그것이 재는 것은 *이미지*이고 환경마다
  이미지를 따로 빌드하므로, 한 환경의 측정은 다른 환경에 대해 아무 말도 하지
  않습니다. production에 없던 동안 production 이미지는 아무도 잴 수 없는 유일한
  이미지였고, 그 답이 필요한 단계가 P2입니다(정책 §9의 첫 조건이 production
  실행입니다). 거기서 알게 되면 측정이 아니라 단계 보류가 됩니다.
- probe에는 제출 URL과 제출 secret이 **없습니다.** 이미지가 무엇을 할 수 있는지
  재는 데에는 행을 쓸 권한이 필요하지 않습니다.

## 스위치는 둘이고 둘 다 기본 꺼짐입니다

| 스위치 | 어디 | 무엇을 막는가 |
|---|---|---|
| `PRODUCT_RESEARCH_AGENT_ENABLED` | Agent project의 서비스 변수 | unset이면 clone·GitHub 조회·제출을 하지 않고 exit 0 |
| `PRODUCT_RESEARCH_AGENT_ENABLED` | 본 앱 환경변수 | unset이면 제출 route는 404, Admin 섹션은 꺼짐 안내 |

**꺼짐은 unset 또는 빈 문자열뿐입니다.** 값이 있으면 `false`든 `0`이든 켜짐입니다 —
끄려면 변수를 **지웁니다**. 스위치가 답하는 질문은 "운영자가 설정했는가"이고,
그 단어의 뜻을 해석하기 시작하면 아무도 읽을 수 없는 스위치가 됩니다.

**전체 정지는 둘 다 지우는 것입니다.** 자동 정지 트리거는 없고, 해제는 운영자가
변수를 다시 설정하는 것뿐입니다.

앱 스위치를 처음 켠 시각은 `AppSetting`의 `productResearch.enabledSince`에
maintenance가 **한 번** 기록합니다. 손으로 지우지 마십시오 — 그 값이 없으면
"한 번도 성공하지 못한 Agent"를 경보할 기준 시각이 사라집니다.

## 처음 켤 때 (운영자)

정책 승인 뒤, 이 순서대로 합니다. 각 단계는 앞 단계 없이는 의미가 없습니다.

### 1. migration 적용 (본 앱)

`prisma/migrations/20261002150000_product_research_observation`. 행을 하나도
만들지 않고 아무것도 켜지 않습니다. 평소 릴리스 경로로 적용합니다.

### 2. Agent project 만들기 (Railway 대시보드)

프로젝트 이름은 `Tomverse Agents`, 환경은 `production`과 `staging`.
**DB 서비스를 만들지 말고, 공유 변수를 하나도 만들지 마십시오.**

### 3. 토큰과 secret 발급

- **GitHub 읽기 토큰**: 이 저장소 하나만 대상으로 하는 fine-grained token,
  권한은 Issues: read 하나. 다른 권한이 붙어 있으면 발급을 다시 합니다.
  **이 토큰은 clone에 쓰이지 않습니다.** 대상 저장소가 공개이므로 clone은 익명
  fetch이고, 토큰이 있는 이유는 접근이 아니라 REST rate limit입니다(익명 60회/시간,
  인증 5,000회/시간). clone이 실패할 때 Contents 권한을 붙이는 것은 답이 아닙니다 —
  `RAILPACK_DEPLOY_APT_PACKAGES`를 먼저 보십시오.
- **제출 secret**: 32자 이상, 환경별로 **서로 다른 값**. 본 앱과 Agent 서비스
  양쪽에 같은 값을 넣습니다(환경 안에서만 같습니다).

### 4. 변수 설정 (Railway 대시보드)

IaC는 값을 만들지 않고 **보존만** 합니다. apply 전에 대시보드에서 아래 이름만
설정하십시오. 목록 밖의 이름은 다음 apply가 지웁니다.

- Product Research Observation: `PRODUCT_RESEARCH_AGENT_ENABLED`,
  `PRODUCT_RESEARCH_INGEST_URL`, `PRODUCT_RESEARCH_INGEST_SECRET`,
  `PRODUCT_RESEARCH_GITHUB_READ_TOKEN`, `RAILPACK_DEPLOY_APT_PACKAGES`
- Product Research Probe: `PRODUCT_RESEARCH_AGENT_ENABLED`,
  `PRODUCT_RESEARCH_GITHUB_READ_TOKEN`, `RAILPACK_DEPLOY_APT_PACKAGES`

`RAILPACK_DEPLOY_APT_PACKAGES`에는 `git`을 넣습니다. **배포 이미지에는 git이
없습니다.** 이 변수가 없으면 clone 단계에서 실패합니다.

실행 서비스의 변수는 이것이 전부입니다. 서비스는 시작할 때 자기 환경의 변수
**이름**을 검사하고, 목록 밖의 이름이 하나라도 있으면 아무 일도 하지 않고
종료합니다(값은 출력하지 않습니다).

### 5. S0 — 이미지가 무엇을 할 수 있는지 재기

staging에서 Product Research Probe를 **손으로 실행**합니다. 출력에 적힙니다.

```
git available: true|false
git version: …
partial clone supported: true|false
node version: …
slot this run would answer for: …
```

**S0은 넷을 측정하고 넷 다 통과해야 합니다**(정책 §9).

| # | 측정 | 어디서 보는가 | 통과 못 하면 |
|---|---|---|---|
| 1 | git 사용 가능·버전 2.19 이상 | probe 출력 | 멈춤. 4번의 apt 변수를 확인하고 다시 재십시오 |
| 2 | partial clone 결과의 byte 동치 | 저장소의 `tests/issueBacklogPartialClone.test.mjs` | 멈춤 |
| 3 | 읽기 토큰이 대상 저장소 하나·Issues: read 하나 | GitHub 토큰 설정 화면 | 멈춤. 토큰을 다시 발급합니다 |
| 4 | Agent project에 DB 서비스 0개·공유 변수 0개 | Railway project 화면 | 멈춤 |

**앞의 둘만 보고 넘어가지 마십시오.** 3번과 4번이 어긋난 채로도 probe는 통과를 출력합니다 — probe가 보는 것은
이미지이고, 토큰 권한과 project 경계는 화면에서 사람이 보는 것입니다.

probe가 답하는 것은 1번뿐입니다 — "이 이미지에서 clone이 되는가".

### 6. apply

로컬 PC의 PowerShell, 이 저장소 clone 폴더 안. Node 22와 `npm run
railway:iac:install`이 끝나 있어야 하고, Railway CLI 로그인이 필요합니다.
production 자격증명은 필요하지 않습니다 — Railway 계정 권한만 씁니다.

읽기 전용으로 먼저 봅니다. **무엇이 지워지는지 반드시 확인하십시오.**

```bash
npm run railway:agents:use-staging && npm run railway:agents:plan
```

계획이 의도와 같으면 적용합니다. 쓰는 명령이며, 되돌리는 방법은 대시보드에서
서비스를 되살리는 것이 아니라 **IaC 파일을 고쳐 다시 apply하는 것**입니다.

```bash
npm run railway:agents:apply
```

production도 같은 순서입니다(`railway:agents:use-production`).

### 6a. region은 apply가 고치지 못합니다

서비스의 region은 `.railway/agent-runners.ts`의 `AGENT_RAILWAY_REGION`에 적혀
있고 승인된 정책의 APP 8 기록과 같아야 합니다. 그런데 **Railway CLI는 이미
존재하는 서비스의 region을 diff하지 않습니다.** 2026-10-03에 확인했습니다 —
`railway config plan --json`의 `desiredGraph`는
`{"asia-southeast1-eqsg3a":{"numReplicas":1}}`, `currentGraph`는
`{"sfo":{"numReplicas":1}}`인데 `changeSet.changes`가 비어 있고 출력은
`Your Railway configuration is already up to date.`였습니다.

두 가지를 뜻합니다.

- **잘못 만들어진 region은 대시보드에서 고칩니다.** apply로는 안 됩니다.
- **apply가 대시보드 설정을 되돌리지도 않습니다.** 관리되지 않는 필드이기
  때문입니다. 그래서 고친 뒤 다시 apply해도 안전합니다.

**생성 시점에는 선언이 반영되고, 그 뒤로는 반영되지 않습니다.** 2026-10-03에
양쪽을 다 봤습니다 — region을 선언하기 전에 만들어진 staging 두 서비스는
Railway 기본값 `sfo`로 생겼고 apply로 고칠 수 없었으며, 선언을 넣은 뒤 만들어진
production 서비스는 처음부터 `asia-southeast1-eqsg3a`였습니다.

그래서 순서가 전부입니다. **region은 그 project에 처음 apply하기 전에
`AGENT_RAILWAY_REGION`에 적혀 있어야 합니다.** 늦으면 손으로 고치는 수밖에
없고, 그 수정은 서비스마다 환경마다 따로 해야 합니다.

apply 뒤에는 **반드시 region을 확인하십시오.** 대시보드의 각 서비스 →
Settings → Regions, 또는 아래 읽기 전용 조회로 봅니다.

```bash
railway status --json
```

맞지 않으면 각 서비스의 Settings에서 `asia-southeast1-eqsg3a`로 바꾸고
재배포합니다.

### 7. 스위치 켜기

staging의 앱 스위치 → staging의 서비스 스위치 순서로 켭니다. 반대로 하면 서비스가
제출할 곳이 404입니다.

## 매일 보는 곳

Admin Console → Operations → Engineering agent → **Product research** tab.

**관측 섹션에는 버튼이 없습니다.** 이 Agent는 아무것도 제안하지 않으므로 승인할
것도 거절할 것도 없습니다. 보이는 것은 예정 회차 목록(행이 없는 회차 포함), 가장
최근 기록 회차의 행들, 그리고 두 단계 창의 계산값입니다.

**창 계산값은 보고입니다.** 단계 전환은 운영자가 서명하고, 화면은 어떤 단계도
옮기지 않습니다.

표 머리의 문장은 정책이 고정한 것입니다. 이 표는 추천이 아니고, `open_work`는
"완료 신호 없음"이며 미완료 증거가 아닙니다.

## 상태를 어떻게 읽는가

| 화면이 말하는 것 | 뜻 | 할 일 |
|---|---|---|
| 꺼져 있음 | 앱 스위치 unset | 없음. 운영자가 고른 상태입니다 |
| 처음 켜진 시각 기록 중 | 기준 시각이 아직 없음 | 이 탭을 한 번 열면 적힙니다. 새로 고쳐도 남아 있으면 **이상 상태**입니다 -- 아래 |
| 기록된 회차 없음 | 켠 지 26시간 안이고 성공 없음 | 기다립니다 |
| `…시간 동안 기록된 회차 없음` | 26시간 이상 침묵 | 아래 분기 |
| 마지막 기록 회차 … | 정상 | 없음 |

### "처음 켜진 시각 기록 중"이 남아 있으면

기준 시각(`enabledSince`, `AppSetting`의 `productResearch.enabledSince`)은 **침묵
경보가 재기 시작하는 지점**이고, 행을 쓰는 것과는 다른 장치입니다. 둘을 섞지
않습니다 -- 기준 시각이 없어도 21:30 회차는 평소대로 행을 남깁니다.

**이 탭을 여는 것 자체가 기준 시각을 적습니다.** 스위치가 켜져 있으면
`readProductResearchConsole()`이 `readProductResearchEnabledSince(now)`를 부르고,
행이 없으면 그때 만듭니다. maintenance 통과(`Maintenance Cron`, 매일 03:00 UTC)도
같은 함수를 쓰므로, 먼저 일어난 쪽이 적습니다.

그래서 **한 번 열고 새로 고친 뒤에도 이 문구가 남아 있으면 기다릴 상태가
아닙니다.** 원인은 둘이고, 함수가 둘 다 `null`로 돌려주므로 화면만 보고는
구분되지 않습니다. `AppSetting`에서 `productResearch.enabledSince` 행을 찾아
가릅니다.

- **행이 있다** — 저장된 값이 시간으로 읽히지 않습니다. 함수는 그 행을 고치지
  않고 `null`을 돌려주므로, 사람이 그 값을 보고 정해야 합니다.
- **행이 없다** — 생성이 계속 실패하고 있습니다. 함수는 `create()`의 오류를
  모두 삼키고 재조회도 비어 있으면 `null`을 돌려주므로, 읽기는 되는데 INSERT가
  안 되는 상태(권한, DB 쓰기)가 이 문구로만 나타납니다. 앱 로그를 보십시오.

둘 중 어느 쪽이든 cron을 기다리는 것으로 안내하면 그 상태를 놓칩니다.

15분은 runner의 강제 종료 시간이고 이것과 무관합니다.

침묵 경보(`PRODUCT_RESEARCH_OBSERVATION_SILENT`)의 `measuredFrom`을 봅니다.

- `enabled_since` — **한 번도 성공한 적이 없습니다.** 서비스 스위치, 제출 secret,
  읽기 토큰, apt 변수 중 하나입니다. probe를 먼저 돌리십시오.
- `last_success` — 되던 것이 멈췄습니다. Railway cron은 실행 중인 회차가 있으면
  다음 회차를 건너뛰고 멈춘 회차를 죽이지 않으므로, **멈춘 실행 하나가 이후 모든
  실행을 막습니다.** Agent 서비스의 마지막 배포 로그를 보십시오. 15분 강제 종료가
  걸려 있으므로 24시간 이상 살아 있는 실행은 있을 수 없고, 그렇다면 cron 자체가
  뜨지 않은 것입니다.

**행이 둘 이상인 회차**가 보이면 정합성 이상입니다. DB의 unique 제약이 그것을
막으므로 정상 경로로는 생길 수 없고, 생겼다면 제약이 없는 경로가 생겼다는
뜻입니다. 그 창은 단계 판정에 쓰지 않습니다.

## 실패한 회차의 단계가 가리키는 것

회차는 성공이거나 실패이고, **실패한 회차도 행을 남깁니다.** 그래야 "오늘은
실패했다"와 "아무도 돌리지 않았다"가 구분됩니다. 실패한 행은 내용을 담지 않고
단계 하나만 담습니다 — 절반만 관측한 것을 저장하는 것이 이 모양이 막는 결함입니다.

| 단계 | 어디서 멈췄는가 | 먼저 볼 것 |
|---|---|---|
| `clone_failed` | 저장소를 clone하지 못함 | 이미지에 `git`이 있는지(probe), `RAILPACK_DEPLOY_APT_PACKAGES` |
| `release_branch_unavailable` | clone은 됐지만 `develop`·`main` tip을 읽지 못함 | 저장소의 branch 이름. partial clone이 약속한 만큼 가져오지 못한 경우입니다 |
| `issue_fetch_failed` | 이슈 목록 조회 | 읽기 토큰의 만료·권한(Issues read), GitHub 상태. 토큰 값은 로그에 없습니다 |
| `issue_input_too_large` | 조회는 됐지만 이 회차가 들 수 있는 바이트를 넘음 | 열린 이슈의 본문 총량. 상한을 올리는 것은 정책 변경입니다 |
| `row_count_exceeded` | 열린 이슈가 행 상한보다 많음 | 같습니다. 잘라서 저장하지 않습니다 |
| `issue_backlog_failed` | `report:issue-backlog` 자식 프로세스가 비정상 종료 | 배포 로그의 그 줄. 대개 `lib/modelPricing.ts` 해석이 실제 module과 어긋난 경우입니다 |
| `schema_invalid` | report가 이 표가 모르는 모양을 냄 | report와 payload builder 중 한쪽만 바뀐 것입니다. 코드 변경입니다 |
| `set_mismatch`·`count_mismatch` | 같은 이슈 번호가 둘, 또는 재계산한 수가 다름 | 코드 변경입니다 |
| `timeout` | 자식 프로세스가 자기 deadline에 죽음 | clone 시간. S0에서 재어 둔 값과 비교합니다 |

**재시도하지 않습니다.** 같은 회차에 두 번째 답을 보내는 것이 한 회차가 서로 다른
두 답을 갖는 경로이고, 서비스의 restart policy가 `NEVER`인 이유입니다. 실패한
회차는 실패로 남고, 원인을 고친 다음 회차가 답합니다.

**제출이 끝났는지 모르는 경우**가 하나 있습니다. 배포 로그에 `submission: the
submission did not complete`가 있으면 요청이 route에 닿았는지 알 수 없습니다. 그
회차에 행이 있는지 Admin 화면에서 확인하고, 없으면 그 회차는 침묵입니다 — 손으로
제출하지 않습니다.

## 하지 않는 일

- **행을 손으로 고치지 않습니다.** DB가 update를 거절합니다. 고칠 것이 없습니다 —
  회차의 답은 그 실행이 본 것이고, 나중의 편집은 어떤 실행도 관측하지 않은 내용을
  저장된 행이 말하게 만듭니다.
- **보존 기간 전에 지우지 않습니다.** DB가 거절합니다. 최신 행 예외도 없습니다.
- **실패한 회차를 성공으로 다시 제출하지 않습니다.** 같은 회차에는 행이 하나뿐이고,
  이미 답이 있는 회차의 재제출은 409입니다.
- **GitHub에 아무것도 쓰지 않습니다.** 이슈·label·comment·PR·check 전부. 토큰은
  읽기 전용이고, 쓰기 권한이 붙은 토큰을 넣으면 그 자체가 정책 위반입니다.
