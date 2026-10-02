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
| Product Research Probe | Tomverse Agents | staging만 | 같은 script `--probe` | 없음(손으로 실행) | 15분 |

- 두 서비스는 **별도 Railway project**(`Tomverse Agents`)에 있습니다. reference
  변수는 자기 project 안에서만 해석되므로, DB 서비스와 공유 변수가 없는 project는
  `${{ Postgres.DATABASE_URL }}`가 가리킬 대상 자체가 없습니다.
- 그 project의 IaC 파일은 `.railway/agents-railway.ts`이고 **partial을 export하지
  않습니다.** 즉 project 전체를 소유하므로, 누가 손으로 DB 서비스를 추가하면
  다음 apply가 지웁니다. 그것이 이 분리의 요점입니다.
- 기존 `Tomverse` project의 cron은 `.railway/railway.ts`가 named partial로
  소유합니다. **두 파일을 섞지 않습니다** — `railway:iac:*` script는 공유
  project를, `railway:agents:*`는 Agent project를 대상으로 합니다.
- probe에는 제출 URL과 제출 secret이 **없습니다.** 이미지가 무엇을 할 수 있는지
  재는 데에는 행을 쓸 권한이 필요하지 않습니다.

## 스위치는 둘이고 둘 다 기본 꺼짐입니다

| 스위치 | 어디 | 무엇을 막는가 |
|---|---|---|
| `PRODUCT_RESEARCH_AGENT_ENABLED` | Agent project의 서비스 변수 | unset이면 clone·GitHub 조회·제출을 하지 않고 exit 0 |
| `PRODUCT_RESEARCH_AGENT_ENABLED` | 본 앱 환경변수 | unset이면 제출 route는 404, Admin 섹션은 꺼짐 안내 |

**전체 정지는 둘 다 unset입니다.** 자동 정지 트리거는 없고, 해제는 운영자가
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

**`git available: false`이거나 `partial clone supported: false`이면 여기서
멈춥니다.** 4번의 apt 변수를 확인하고 다시 재십시오.

partial clone 결과가 전체 checkout과 같은 보고를 내는지는 저장소 안에서 이미
고정돼 있습니다 — `tests/issueBacklogPartialClone.test.mjs`가 네트워크도
자격증명도 없이 local fixture로 byte 단위 비교를 합니다. probe는 "이 이미지에서
clone이 되는가"만 답합니다.

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
| 처음 켜진 시각 기록 중 | 기준 시각이 아직 없음 | 다음 maintenance 실행까지 기다립니다(15분) |
| 기록된 회차 없음 | 켠 지 26시간 안이고 성공 없음 | 기다립니다 |
| `…시간 동안 기록된 회차 없음` | 26시간 이상 침묵 | 아래 분기 |
| 마지막 기록 회차 … | 정상 | 없음 |

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

## 하지 않는 일

- **행을 손으로 고치지 않습니다.** DB가 update를 거절합니다. 고칠 것이 없습니다 —
  회차의 답은 그 실행이 본 것이고, 나중의 편집은 어떤 실행도 관측하지 않은 내용을
  저장된 행이 말하게 만듭니다.
- **보존 기간 전에 지우지 않습니다.** DB가 거절합니다. 최신 행 예외도 없습니다.
- **실패한 회차를 성공으로 다시 제출하지 않습니다.** 같은 회차에는 행이 하나뿐이고,
  이미 답이 있는 회차의 재제출은 409입니다.
- **GitHub에 아무것도 쓰지 않습니다.** 이슈·label·comment·PR·check 전부. 토큰은
  읽기 전용이고, 쓰기 권한이 붙은 토큰을 넣으면 그 자체가 정책 위반입니다.
