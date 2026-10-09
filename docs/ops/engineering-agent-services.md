# 엔지니어링 에이전트 서비스 운영

정책: `docs/policy/engineering-agent.md` §8(서비스와 자격증명), §9(게시 규칙),
§12(대기열·정지·알림·비용). 이 문서는 운영자가 하는 일만 적습니다. 판정·승인·
상한은 앱이 하고, 여기 있는 어떤 단계도 그것을 대신하지 않습니다.

## 무엇이 있는가

| 서비스 | 진입점 | 일정 | 강제 종료 |
|---|---|---|---|
| Engineering Agent Runner | `scripts/engineering-agent-runner.mjs` | 30분마다 | 20분 |
| Engineering Agent Publisher | `scripts/engineering-agent-publisher.mjs` | 10분마다 | 8분 |

- 두 서비스는 한 이미지(`docker/engineering-agent.Dockerfile`)를 씁니다. 이미지는
  `main`에서만 `.github/workflows/engineering-agent-image.yml`이 만들고, Railway는
  빌드하지 않습니다.
- **production 전용**입니다. staging·dev에는 선언되지 않습니다.
- 두 서비스는 Railway project **`Tomverse Agents`**에 있습니다. 그 project에는 DB
  서비스도 공유 변수도 없어서 `${{ Postgres.DATABASE_URL }}` 같은 참조가 해석될
  대상이 없습니다(`.railway/README.md`). 선언은 `.railway/agent-runners.ts`의
  `ENGINEERING_AGENT_SERVICES`이고, apply는 `railway:agents:*` script로 합니다.
- `image.digest`가 `null`인 동안에는 서비스가 선언되지 않으므로 apply해도 아무것도
  생기지 않습니다.

## 처음 켤 때 (운영자)

1. **이미지 digest 기록** — `main`에 병합된 뒤 workflow 실행 요약에 찍힌
   `ghcr.io/mposition/tomverse-engineering-agent@sha256:…`의 `sha256:…`를 두
   서비스의 `digest`에 넣는 PR을 만들고, 직접 검토해 병합합니다. 에이전트는 이
   값을 바꾸지 않습니다(§13).
2. **GHCR 접근** — 패키지가 비공개라면 Railway 서비스에 registry 자격증명을
   대시보드에서 설정합니다. 이 자격증명은 읽기 전용이어야 합니다.
3. **apply로 서비스 만들기** — 로컬 PC의 PowerShell, clone 폴더(`main`) 안에서
   `npm run railway:iac:install` → `npm run railway:agents:use-production` →
   `npm run railway:agents:plan` → `npm run railway:agents:apply` 순서로 합니다.
   plan은 이 두 서비스 추가 외의 변경이 없어야 합니다. 서비스는 apply가 만들기
   전에는 없으므로 변수는 apply **뒤에** 넣습니다. 그 사이의 cron 실행은 변수가 없어
   실패하지만 모드가 `off`라 아무것도 하지 않습니다.
4. **변수 설정** — IaC는 값을 만들지 않고 이미 있는 값을 보존만 합니다
   (`preserve()`). apply 직후 대시보드에서 각 서비스에 아래 이름만 설정하고
   Deploy합니다. 목록 밖의 이름은 다음 apply가 지웁니다.
   - Runner: `ENGINEERING_AGENT_APP_URL`, `ENGINEERING_AGENT_RUNNER_SECRET`,
     `ENGINEERING_AGENT_ANTHROPIC_API_KEY`(공급자 측 지출 한도가 걸린 전용 key),
     `ENGINEERING_AGENT_GITHUB_READ_TOKEN`(이 저장소 하나, 읽기 전용),
     `ENGINEERING_AGENT_RUNNER_DEADMAN_URL`
   - Publisher: `ENGINEERING_AGENT_APP_URL`, `ENGINEERING_AGENT_PUBLISHER_SECRET`,
     `ENGINEERING_AGENT_PUBLISHER_APP_ID`, `ENGINEERING_AGENT_PUBLISHER_INSTALLATION_ID`,
     `ENGINEERING_AGENT_PUBLISHER_PRIVATE_KEY`, `ENGINEERING_AGENT_PUBLISHER_DEADMAN_URL`
   - 두 secret은 32자 이상이고 서로 달라야 하며, 앱 서비스에도 같은 값이 있어야
     합니다.
5. **Publisher GitHub App** — 이 저장소 하나에 설치하고 권한은 Contents write,
   Pull requests write, Metadata read뿐입니다. **Workflows 권한을 주지 않습니다.**
   서비스는 이 셋 밖의 권한이 실린 토큰을 받으면 즉시 폐기하고 멈춥니다.
6. **dead-man monitor** — 두 서비스에 각각 하나씩, 앱·Railway·GitHub와 무관한
   외부 monitor를 만들고 알림 채널을 연결합니다. 확인했으면 Admin의 엔지니어링
   에이전트 화면에서 "monitor 확인"을 기록합니다(armed gate가 읽습니다).
7. **확인** — `npm run railway:agents:plan`이 변경 없음을 보이면 변수 이름이 선언과
   같다는 뜻입니다. 두 서비스는 모드가 `off`인 동안 회차를 끝까지 돌고 아무것도
   하지 않으며, 정상 종료마다 dead-man monitor에 성공 신호를 보냅니다.

## `Tomverse` project에서 옮길 때 (한 번)

2026-10-07에 두 서비스는 `Tomverse` project에 공유 partial(`railway:iac:*`)로 처음
배포됐습니다. `railway:agents:apply`는 `Tomverse Agents`만 바꾸므로 옛 서비스는
자격증명과 cron을 가진 채 남습니다. 두 쌍이 함께 돌면 같은 앱 route를 두 번 부르고,
같은 dead-man URL에 옛 서비스가 성공 신호를 보내 새 서비스의 장애를 가립니다.
그래서 **옛 서비스를 먼저 없앤 뒤** 새 서비스를 확인합니다. 모두 로컬 PC의
PowerShell, clone 폴더(`main`, 이 변경이 들어간 커밋 이후) 안에서 합니다.

1. Admin에서 모드를 `off`로 내리고, 화면에 `off`가 보이는지 확인합니다.
2. **옛 서비스 제거** — `npm run railway:iac:use-production` → `npm run railway:iac:plan`.
   plan은 `Engineering Agent Runner`·`Engineering Agent Publisher` **두 서비스 삭제만**
   보여야 합니다. 그 밖의 변경이 있으면 멈춥니다. 맞으면 `npm run railway:iac:apply`.
   대시보드의 `Tomverse` project에 두 서비스가 없는지 봅니다.
   이때부터 새 서비스가 돌 때까지 두 monitor가 down 알림을 보낼 수 있으며, 예상된
   알림입니다.
3. **새 서비스 생성** — 위 "처음 켤 때"의 3·4·7을 `Tomverse Agents`에서 합니다.
   변수 값은 옛 서비스와 같습니다(같은 secret, 같은 dead-man URL).
4. **새 서비스별 확인** — 각 서비스의 첫 회차 로그가 `finishedNormally: true`인지,
   그 시각 이후 각 dead-man monitor에 ping이 들어왔는지 봅니다. 옛 서비스가 없으므로
   이 ping은 새 서비스의 것입니다.
5. 그다음에만 모드를 다시 켭니다(armed gate가 최근 종료와 monitor 확인을 다시 봅니다).

되돌리기: 이 변경 이전 커밋에서 `railway:iac:apply`를 하면 옛 서비스가 다시
선언되고, `Tomverse Agents`의 두 서비스는 대시보드에서 지웁니다.

## 정지가 걸렸을 때

로컬 PC의 PowerShell, 이 저장소 clone 폴더 안에서 실행합니다. Node 22와 `npm ci`가
끝나 있어야 합니다. 자격증명 없이 됩니다(`GITHUB_TOKEN`이 있으면 읽기 한도만
넉넉해집니다). **읽기 전용**이며 GitHub와 앱에 아무것도 쓰지 않습니다.

```powershell
npm run engineering-agent:halt-plan -- --bindings bindings.json
```

- `bindings.json`은 Admin 화면의 PR 목록을 `[{ "runId", "prNumber", "headSha" }]`로
  옮긴 것입니다. 없으면 모든 항목이 `unverified`로 나옵니다.
- 종료 코드: 0 복구할 것 없음, 1 사람이 하나씩 확인, 2 **사고**, 3 목록을 끝까지
  읽지 못함(다시 읽습니다. 부분 목록으로 행동하지 않습니다).
- 사고(항목이 3개를 넘음)의 종결은 Publisher App key 폐기 또는 설치 해제, 모드
  `off`, 기록입니다. 다시 켜려면 새 전용성 기록과 정책의 새 버전 승인이 필요합니다.
- 정지 해제는 원인을 확인한 뒤 Admin 화면의 "정지 확인"뿐입니다.
