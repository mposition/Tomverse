# Marketing Generator를 AMUX 박스의 Codex CLI로 돌리기

운영자 결정 2026-11-04: Marketing Generator의 A3 시장 조사, 분석, 초안, AI visibility 호출을 OpenAI API 키
대신 박스에 로그인된 Codex CLI로 합니다. API 키 경로는 지우지 않았습니다. `MARKETING_LLM_CHANNEL`을 설정하지
않으면 지금과 똑같이 API 키로 돕니다.

SEO Agent(GitHub Actions)와 Comments Monitor는 옮기지 않습니다. Comments Monitor는 제3자 댓글을 읽으므로 API
키로 둡니다.

## 무엇이 바뀌고 무엇이 그대로인가

- 바뀌는 것: 호출마다 `codex exec` 프로세스 하나(`lib/marketingCodexChannelCore.ts`). 빈 임시 디렉터리에서
  실행되고, `HOME`, `CODEX_HOME`, `PATH`, `LANG`만 받습니다.
- 그대로인 것: 원장의 reserve·dispatch·settle, 감사 체인, Admin의 모델 선택, Guard와 사람 승인, 게시 경로.
- 월 상한: 원장이 계속 pin 단가로 계산합니다. 구독에서는 실제 지출이 아니라 **사용량 한도**입니다. CLI의
  기본 지시문 때문에 호출당 토큰이 API보다 많아 상한에 더 빨리 닿을 수 있습니다. 닿으면 호출이 거절되고 그
  실행이 멈출 뿐, 돈이 나가지는 않습니다.
- 도구: 웹검색 외 로컬 도구를 모두 끕니다(`MARKETING_CODEX_DISABLED_FEATURES`). 웹 페이지가 모델에게 지시를
  넣어도 파일을 읽거나 명령을 실행할 수단이 없습니다.
- 도메인 제한: API의 필터와 같은 `tools.web_search.allowed_domains`를 호출마다 넘깁니다. 답변을 읽는 쪽의 공식
  도메인 검사도 그대로입니다.

## 알려진 한계

- CLI는 실제 응답 모델을 보고하지 않습니다. 원장의 `reportedModel`은 요청한 모델이고 tier는 pin의 값입니다.
- `max_output_tokens`와 `max_tool_calls`를 CLI에 넘기지 못합니다. 검색 횟수는 프롬프트로 pin의 3회를 지시하고, 예약이 계산한 4번째 검색이 시작되면 프로세스를 끊습니다. 실제 A3 6곳은 2~3회를 지켰습니다. 끊긴 호출은 unknown으로 닫히고 그 실행이 멈춥니다. 토큰이 예약을 넘으면 원장이
  `unknown_retained`로 닫고 그 실행이 멈춥니다. 호출 하나는 5분이면 끊습니다.
- `generator.env`는 `tommy` 계정 파일입니다. 같은 계정으로 도는 shell 도구가 있는 작업은 이 비밀값을 읽을 수
  있습니다. 이 비밀값으로 할 수 있는 일은 초안 제출과 원장 기록이고, 게시는 여전히 사람 승인을 거칩니다.
- Codex 한도를 AMUX 워커와 나눠 씁니다. 로그인이 끊기면 호출이 unknown으로 닫히고 그날 초안이 나오지 않습니다.
- 박스가 꺼져 있던 날의 실행은 나중에 메우지 않습니다.

## 설치 (운영자, 박스의 `tommy`)

아래는 production 앱에 초안과 원장을 쓰는 실행입니다. **비밀값 배치와 전환은 운영자 승인 대상입니다.**

전제: 이 기능이 main에 있어야 합니다. 앱 쪽 변경은 없으므로 앱 배포를 기다릴 필요는 없습니다. 번들은 그 main에서 만듭니다.

1. 로컬 PC의 main checkout에서 번들을 만들어 박스에 올립니다. 박스의 `/usr/bin/node`는 TypeScript 지원 없이
   빌드돼 있어 `.ts`를 읽으면 `ERR_NO_TYPESCRIPT`로 끝납니다. 그래서 저장소의 소스를 바로 실행할 수 없습니다.

   ```bash
   npm run build:marketing-generator-box
   ```

   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/tomverse-migration-20261001 tommy@192.168.0.7 "mkdir -p ~/.local/lib/tomverse-marketing-generator"
   ```

   ```bash
   scp -o IdentitiesOnly=yes -i ~/.ssh/tomverse-migration-20261001 .next/marketing-generator-box/*.mjs tommy@192.168.0.7:.local/lib/tomverse-marketing-generator/
   ```

2. 환경 파일을 만듭니다. `MARKETING_GENERATOR_SUBMIT_SECRET`은 Railway `Tomverse Agents` › production ›
   `Marketing Generator`에서 복사합니다. 대화나 로그에 붙이지 않습니다.

   ```bash
   mkdir -p ~/.config/tomverse-marketing-generator
   install -m 600 /dev/null ~/.config/tomverse-marketing-generator/generator.env
   ```

   ```ini
   MARKETING_APP_URL=https://tomverse.app
   MARKETING_GENERATOR_SUBMIT_SECRET=
   MARKETING_LLM_CHANNEL=codex-subscription
   MARKETING_CODEX_BIN=/home/tommy/.local/bin/codex
   MARKETING_AI_VISIBILITY_ENABLED=true
   ```

3. 유닛을 설치합니다. timer는 아직 켜지 않습니다.

   ```bash
   mkdir -p ~/.config/systemd/user
   # scripts/systemd/의 두 파일을 scp로 ~/.config/systemd/user/에 먼저 올립니다.
   systemctl --user daemon-reload
   ```

## 전환

두 곳이 함께 돌면 초안과 호출이 두 배가 되므로 순서를 지킵니다.

1. Railway `Marketing Generator`의 production 실행 명령을 아무 일도 하지 않는 명령으로 바꾸고, 소스에서 새로
   배포합니다. 예: `node -e "console.log('Marketing generator moved to the AMUX box; see docs/ops/marketing-generator-box.md')"`

   ```bash
   railway redeploy -p <Tomverse Agents 프로젝트 ID> --from-source -s "Marketing Generator" -e production -y
   ```

   - cron을 지우지 않습니다. Railway는 `cronSchedule`이 없는 서비스를 main 배포 때마다 실행하므로, 지우면 API 키
     호출이 오히려 늘어납니다.
   - 일반 redeploy를 쓰지 않습니다. 이전 배포의 실행 명령을 그대로 복사하므로 다음 cron이 옛 명령으로 돕니다.
   - `railway deployment list --json`에서 활성 배포의 `meta.serviceManifest.deploy.startCommand`를 확인합니다.
   - `.railway/agent-runners.ts`도 production에는 이 no-op 명령을 적습니다(`MARKETING_GENERATOR_PRODUCTION_NOOP_START`,
     2026-11-07). dev와 staging은 실제 생성기 명령 그대로입니다. 그래서 production `railway:agents:plan`에
     Marketing Generator의 실행 명령 차이가 나오지 않아야 하고, 나오면 apply하지 말고 그 차이부터 봅니다.
2. 박스에서 한 번 돌립니다.

   ```bash
   systemctl --user start tomverse-marketing-generator.service
   journalctl --user -u tomverse-marketing-generator.service -n 40 --no-pager
   ```

3. 로그의 `marketing_generator_a3`, `marketing_generator_analysis`, `marketing_generator_run`을 API 때와
   비교합니다. 2026-11-05 비교에서 API는 경쟁사 11곳에 `factsKept` 200, 박스는 182였고 둘 다 `stoppedAt` null,
   약 10분이었습니다. 같은 날 두 번째 실행은 초안이 적습니다. 안 쓴 미디어가 없는 계정은 모델 호출 전에 건너뛰기
   때문입니다(`accountsWithoutMedia`).
4. 괜찮으면 timer를 켭니다.

   ```bash
   systemctl --user enable --now tomverse-marketing-generator.timer
   ```

5. 며칠 지켜본 뒤 Railway의 `MARKETING_LLM_API_KEY`를 지웁니다. SEO Agent의 GitHub secret은 별개입니다.

## 되돌리기

```bash
systemctl --user disable --now tomverse-marketing-generator.timer
```

그다음 Railway production의 실행 명령을
`node --experimental-strip-types scripts/marketing-generator-service.mjs`로 되돌리고 전환 1번처럼 소스에서 새로
배포합니다. 같은 때에 `.railway/agent-runners.ts`의 `marketing_generator`에서 production `startCommandByEnvironment`를
지우는 PR도 냅니다. 그러지 않으면 다음 production apply가 no-op 명령으로 다시 바꿉니다.

## 코드 갱신

설치 1번을 다시 하면 됩니다. 실행 중이 아닐 때(`systemctl --user is-active tomverse-marketing-generator.service`가
`inactive`) 올립니다. 박스는 main 병합으로 자동 갱신되지 않습니다. Railway와 달리 배포 때마다 추가 실행이 생기지도
않습니다.
