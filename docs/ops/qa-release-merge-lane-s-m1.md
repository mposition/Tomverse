# QA·릴리스 병합 레인 S-M1 진입 절차

`docs/policy/qa-release-agent.md`(버전 7) 8절 7·9·10·11항과 9절의 S-M1 진입 조건을 실행 순서로 옮긴 운영 문서입니다. 규범은
정책이며, 이 문서와 정책이 어긋나면 정책이 이깁니다. 병합 레인 코드는 2026-10-07 production에 배포됐고(dark) 아무 서비스도
돌지 않습니다.

S-M1은 **판정만 하고 병합하지 않는** 단계입니다. 서비스는 10분마다 후보를 고르고 본 앱에 지시를 요청하지만, develop 레인
스위치가 꺼져 있으므로 본 앱이 지시를 거절하고, 서비스는 `instruction_refused`와 함께 **병합했을 PR 번호와 head**를 출력합니다.
그 판정과 사람이 실제로 병합한 것을 7일 이상 비교해 어긋남이 0건이어야 S-M2로 갑니다.

## 순서와 되돌림

| 단계 | 하는 사람 | 바뀌는 것 | 되돌림 |
|---|---|---|---|
| 1. 보호 읽기 | 운영자 PC (자동) | 없음 (읽기 전용) | 해당 없음 |
| 2. 시험 브랜치 관측 | 운영자 PC (자동) + 관측용 App 생성(웹) | `qa-lane-test/*` 브랜치, 이름이 `(test)`로 끝나는 ruleset 2개, 시험 PR | `teardown`이 전부 지웁니다 |
| 3. 실제 ruleset | 운영자 PC (자동) | 저장소 ruleset 2개 | Settings → Rules → Rulesets에서 두 ruleset 삭제 |
| 4. 서비스 App·토큰·IaC | 웹 대시보드 + 운영자 PC | GitHub App, Railway 토큰, Agents project 서비스, 본 앱 변수 1개 | 서비스 변수 `QA_RELEASE_MERGE_LANE_KILL_SWITCH`에 아무 값 → 즉시 정지 |
| 5. revision 1 기록 | Admin 화면 | 운영자 제어 기록 1행(append-only) | 스위치를 끈 새 revision 기록 |

**ruleset이 걸리기 전에 App 키가 Railway에 있지 않습니다**(8절 11항). 4단계는 3단계가 끝난 뒤에만 합니다.

## 1. 보호 읽기 (읽기 전용)

로컬 PC의 PowerShell, Tomverse clone 폴더 안. Node 22와 `npm ci`가 끝나 있어야 하고, `gh auth login`이 된 상태여야 합니다.
production 자격증명은 필요 없습니다. 읽기 전용이며 출력에 토큰이 없으므로 결과를 그대로 붙여도 안전합니다.

```powershell
$env:GH_TOKEN = gh auth token
npm run report:qa-release-protection -- --branch develop
npm run report:qa-release-protection -- --branch main
```

develop은 종료 코드 0과 `"differencesFromPolicyRecord": []`이어야 합니다(정책 8절 10항의 2026-10-03 기록과 같음). 차이가
나오면 멈추고 그 차이를 정책 개정으로 다룹니다. 2026-10-07 읽기에서 develop은 기록과 같았고 ruleset은 없었습니다.
`$env:GH_TOKEN`은 이 PowerShell 창에서만 살아 있으므로 2단계와 3단계도 같은 창에서 합니다.

## 2. 시험 브랜치 관측

### 2-1. 관측용 GitHub App 만들기 (GitHub 웹)

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- 이름: 예) `tomverse-qa-lane-observation` (관측 뒤 지웁니다)
- Webhook: **끔**
- Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Checks: Read-only**,
  **Commit statuses: Read-only**, Metadata: Read-only. 그 밖은 No access (Workflows·Administration 없음)
- Where can this GitHub App be installed: Only on this account
- 만든 뒤 App ID를 적어 두고, Private keys에서 키를 하나 만들어 **로컬 파일로만** 저장합니다(예: `C:\keys\qa-lane-observation.pem`).
  이 키를 저장소 secret이나 Railway에 넣지 않습니다(8절 11항).
- Install App → `mposition/Tomverse` 하나만 선택합니다.

### 2-2. 준비, 관측, 정리

로컬 PC의 PowerShell, Tomverse clone 폴더 안, 1단계와 같은 창(`$env:GH_TOKEN` 설정됨). 쓰는 명령입니다: `qa-lane-test/*`
브랜치와 `(test)` ruleset만 만들고 바꾸며, `teardown`이 전부 지웁니다. `--bypass`는 ruleset을 지나가야 하는 기존 자동화입니다
(GitHub Actions 15368, Dependabot 29110; `lib/qaReleaseLaneRulesetsCore.ts`의 근거). 목록을 바꾸려면 세 명령 모두 같은 값을 씁니다.

```powershell
npm run qa-release:lane-observe -- setup --observation-app-id <App ID> --bypass 15368,29110
```

```powershell
npm run qa-release:lane-observe -- observe --observation-app-id <App ID> --bypass 15368,29110 --observation-key C:\keys\qa-lane-observation.pem
```

`observe`는 여덟 관측의 표와 기록 파일 경로(`docs/ops/qa-release-merge-lane-observations/*.json`)를 출력합니다. 기대는 다음과
같고, 하나라도 다르면 **3단계로 가지 않습니다**(8절 7항).

| 관측 | 기대 | 정책 |
|---|---|---|
| App이 리뷰 없는 PR을 main mirror에 병합 | 거절 | 8.7 |
| App이 사람이 승인한 PR을 main mirror에 병합 | 거절, 메시지가 rule을 말함 | 8.7 |
| App이 main mirror ref를 직접 이동 | 거절 | 8.7 |
| App이 base가 develop도 main도 아닌 PR을 병합 | 거절 | 8.7 |
| 운영자가 main mirror PR 병합 | 성공 | 8.7 |
| App이 check를 통과한 commit으로 develop mirror ref를 직접 이동 | 거절 | 8.9 |
| App이 develop mirror PR 병합 | 성공 | 8.9 |
| 운영자가 develop mirror ref를 직접 이동 | 성공 | 8.9 |

```powershell
npm run qa-release:lane-observe -- teardown
```

**하네스가 하지 못하는 관측 하나**: 8절 7항은 bypass에 넣은 자동화(Actions, Dependabot)의 브랜치 갱신 성공도 관측하라고
합니다. 하네스는 그 실행을 일으킬 수 없으므로 기록에 `"automationUpdatesObserved": "not_observed"`로 남깁니다. 운영자가
판단합니다 — 거는 날과 bypass 목록은 운영자가 정한다는 같은 항의 문장이 근거입니다. 3단계 뒤 첫 Dependabot PR과
`visual-baseline-record` 실행을 확인하는 것으로 갈음할 수 있습니다.

기록 파일은 PR로 commit합니다(이 디렉터리에 남는 것이 관측의 증거입니다).

## 3. 실제 ruleset (develop 밖 모든 브랜치 갱신 제한, develop PR 필수)

로컬 PC의 PowerShell, Tomverse clone 폴더 안, `$env:GH_TOKEN` 설정됨. 먼저 dry run으로 기록이 아직 유효한지 봅니다. dry run은
읽기만 합니다.

```powershell
npm run qa-release:lane-rulesets -- --record docs/ops/qa-release-merge-lane-observations/<기록>.json --observation-app-id <App ID> --bypass 15368,29110
```

`"recordHolds": true`이면 같은 명령에 `--apply`를 붙입니다. 기록 뒤 develop·main의 보호가 바뀌었으면 거절하고 아무것도 바꾸지
않습니다(8절 10항) — 그때는 2단계를 다시 합니다.

```powershell
npm run qa-release:lane-rulesets -- --record docs/ops/qa-release-merge-lane-observations/<기록>.json --observation-app-id <App ID> --bypass 15368,29110 --apply
```

거는 날 주의할 것:

- **develop 직접 push가 막힙니다.** 저장소 관리자 역할(운영자 계정과 `GH_AUTOMATION_PAT`로 push하는 back-merge workflow)만
  지나갑니다. 다른 세션이나 다른 App이 develop에 직접 push하던 경로가 있으면 그것도 막힙니다(8절 9항).
- **develop 밖 브랜치 생성·갱신이 bypass 목록 밖 actor에게 막힙니다.** 운영자 계정으로 push하는 세션은 관리자 역할로 지나가지만,
  다른 GitHub App(예: engineering agent 게시 App)이 브랜치를 만들기 시작하면 그 App을 bypass에 넣는 것은 이 정책의 개정입니다.

끝나면 관측용 App을 지웁니다(GitHub → Developer settings → GitHub Apps → 해당 App → Advanced → Delete). 로컬 키 파일도 지웁니다.

## 4. 서비스 App, Railway 토큰, IaC

### 4-1. 서비스용 GitHub App (GitHub 웹)

2-1과 같은 권한으로 **새** App을 만들고(예: `tomverse-qa-merge-lane`) `mposition/Tomverse`에만 설치합니다. 이 App은 bypass
목록에 넣지 않습니다. App ID와 키(PEM 전체)를 4-3의 서비스 변수에만 넣습니다.

### 4-2. staging 조회용 Railway 토큰 (Railway 대시보드)

`Tomverse` project → Settings → Tokens → 새 project token, environment **staging**. 이 토큰은 staging의 배포 목록을 읽는 데만
씁니다. 서비스는 토큰이 가리키는 환경 이름이 `staging`이 아니면 아무것도 읽지 않습니다.

### 4-3. 공유 secret과 변수

1. 병합 레인 secret을 만듭니다(무작위 40자 이상). 로컬 PC의 PowerShell, 어디서나:

   ```powershell
   [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
   ```

2. **본 앱 production 서비스에 먼저** `QA_RELEASE_MERGE_LANE_SECRET`을 설정하고 배포를 기다립니다(route가 그 값으로 인증합니다).
3. IaC로 서비스를 만듭니다. 로컬 PC의 PowerShell, Tomverse clone 폴더 안 **develop checkout**, `npm run railway:iac:install`과
   Railway CLI 로그인이 끝나 있어야 합니다. production 자격증명은 필요 없습니다(Railway 계정 권한만):

   ```powershell
   npm run railway:agents:use-production
   npm run railway:agents:plan
   ```

   plan이 **`QA Release Merge Lane`(cron `*/10 * * * *`) 외의 서비스를 새로 만들거나 지우면** 멈추고 그 서비스의 담당 정책을
   확인합니다(이 파일은 Agents project 전체를 선언합니다). 괜찮으면:

   ```powershell
   npm run railway:agents:apply
   ```

4. `QA Release Merge Lane` 서비스(Agents project, production)의 변수:

   | 변수 | 값 |
   |---|---|
   | `QA_RELEASE_MERGE_LANE_SECRET` | 2에서 본 앱에 넣은 값과 같음 |
   | `QA_RELEASE_MERGE_LANE_APP_ID` | 4-1의 App ID |
   | `QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY` | 4-1의 PEM 전체 |
   | `QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN` | 4-2의 토큰 |
   | `QA_RELEASE_MERGE_LANE_KILL_SWITCH` | **선언하고 비워 둠**(값이 있으면 정지, 선언되지 않아도 정지) |
   | `QA_RELEASE_MERGE_LANE_ENABLED` | 5단계 전까지 `false` |
   | `QA_RELEASE_CONTROL_REVISION` | 5단계에서 기록한 번호 |

   이 목록 밖의 변수가 하나라도 있으면 서비스는 시작을 거절합니다(정책 3절). 서비스는 `npm run`이 아니라 `node`로 직접
   시작하며, IaC의 start command가 그렇게 되어 있습니다.

## 5. 운영자 제어 revision 1

production Admin → Agent digest → QA·릴리스 → 제어 revision 기록.

- **Digest**: S1(digest 활성)을 함께 시작하지 않으면 끔
- **병합 레인 서비스**: 켬
- **Develop 레인**: **끔** — S-M1은 판정만 합니다
- IaC commit: 4-3에서 apply한 develop commit의 40자 SHA
- 마지막 회전 시각: 4단계에서 만든 병합 레인 secret, GitHub App key, Railway 조회 토큰의 시각

기록하면 revision 번호가 나옵니다. 그 번호를 **세 서비스 모두**(digest·Monitor 서비스가 있으면 그것도)의
`QA_RELEASE_CONTROL_REVISION`에 넣고, 병합 레인 서비스의 `QA_RELEASE_MERGE_LANE_ENABLED`를 `true`로 바꿉니다.

확인: 다음 10분 회차의 서비스 로그 한 줄이 아래 중 하나입니다. 토큰·키·본문은 출력되지 않습니다.

- `{"exitCode":0,"outcome":"instruction_refused","pullRequestNumber":…,"headSha":"…","reason":"…"}` — 판정이 있었고 스위치가
  꺼져 거절됨(S-M1의 정상)
- `idle`(후보 없음), `hold`(staging 배포 진행 중)
- `refused_to_start`면 변수 목록이나 revision 번호를 확인합니다. `state_unknown`·`candidates_unknown`이 계속되면 App 설치,
  Railway 토큰의 환경, 본 앱 secret이 같은지 확인합니다.

## S-M1 동안

- 7일 이상, `instruction_refused`가 고른 PR(번호·head)과 사람이 merge train으로 실제 병합한 것을 비교합니다. 어긋남이 0건이어야
  S-M2(정책 9절)입니다.
- 멈출 때: 병합 레인 서비스의 `QA_RELEASE_MERGE_LANE_KILL_SWITCH`에 아무 값을 넣습니다(다음 회차부터 정지). 또는 병합 레인
  서비스를 끈 새 revision을 기록합니다.
- S-M2 전에 필요한 것: 8절 8항의 변경(merge train의 develop 레인 삭제, AGENTS.md의 병합 주체 문장), 8절 3항의 staging 복구
  runbook.
