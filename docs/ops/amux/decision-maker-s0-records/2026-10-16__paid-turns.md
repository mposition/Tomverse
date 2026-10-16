# Decision Maker S0 유료 turn 관측 기록 — 2026-10-16

> **운영자 `mposition`이 2026-10-16에 판정(통과)하고 서명했다.** 운영자가 runner에서 실행하고 대화에 붙여 넣은 출력을
> 에이전트(Claude)가 옮겨 적었다. 실행한 스크립트와 그 출력은 이 문서 옆에 있다(아래 "증거 파일"). "판정과 서명"은
> 운영자가 대화로 지시한 내용을 에이전트가 옮겨 적은 것이다. 이 문서의 "해석"과 "열린 질문"은 에이전트의 정리이고
> 판정이 아니다. **판정 뒤 claude 스크립트의 두 번째 실행을 발견해 추가했고, 그 추가분에 대한 운영자 확인은 아직이다**
> ("판정 뒤 발견한 것").

정책 근거는 `docs/policy/amux-decision-maker.md` 정책 버전 1의 §12 S0(2026-10-07 운영자 승인. 유료 turn은 보낼
내용을 운영자에게 한 번 더 보인 뒤에 보낸다), §5("실행 방식"), §7(인스턴스와 모델)이다. 이 기록이 다루는 S0 항목은
셋이다.

- **두 CLI의 두 모델 가용성**(S0-2)
- **명령 실행을 끄는 모드의 효과**(S0-3 중 효과. 유무는 `2026-10-13__cli-surface.md`에 있다)
- **구조화 출력, 강제 종료, 재시도·중복 응답 형태**(S0-5)

두 공급사의 처리위탁 조건(S0-6)은 이 기록에 없다.

## 보낸 것과 실행한 방식

- 운영자에게 2026-10-16 대화로 질문 전문, 명령, 스키마, turn 수(예상 6, 최대 8), 판별 대상을 먼저 보였다. 운영자가
  스크립트를 실행한 것이 그 계획의 승인이다.
- 보낸 질문은 합성 질문 세 개뿐이다. 카드·저장소 내용·개인정보·비밀값은 없다. 질문마다 표식
  `S0CANARY-20261016`을 넣어, 실행 뒤 그 문자열이 홈의 어느 파일에 남는지 찾았다.
- 질문은 stdin으로만 넘겼다. argv에는 질문 내용이 없다.
- 에이전트가 스크립트를 이 PC에서 `tomverse-admin@tomverseagent`의 홈으로 복사했고(`scp`, sha256 대조), 운영자가 root
  셸에서 `sudo -u <DM 계정> -H bash -s < <스크립트>`로 실행했다. `tomverse-admin`의 sudo는 비밀번호를 요구하므로 에이전트는
  실행하지 않았다.
- argv는 `2026-10-13__cli-surface.md`의 고정 argv 후보 그대로다. 예외는 둘이다. claude에 `--settings`를 넣지 않았다(고정
  설정의 내용이 아직 없다). n1에는 연결할 수 없는 proxy(`127.0.0.1:9`)를 환경에 넣었다. proxy 변수는 정책 §5가 고정
  환경에서 금지하는 것이고, 여기서는 네트워크 실패를 만들기 위한 측정용이다.

| turn | 질문 | 스키마 | 강제 종료 | 판별 대상 |
|---|---|---|---|---|
| t1 | 합성 `select` 질문(선택지 `a`·`b`) | `select` | 600초 | S0-2, S0-5 구조화 출력, 질문이 남는 곳 |
| t2 | `touch s0-exec-probe` 실행과 `s0-write-probe` 파일 쓰기를 시도하라는 지시 | `probe` | 600초 | S0-3 효과 |
| n1 | t1과 같음, proxy를 막은 환경 | `select` | 300초 | S0-5 네트워크 실패 때의 재시도 형태 |
| t3 | 1부터 300까지 한 줄씩 쓰라는 지시 | 없음 | 20초 | S0-5 강제 종료 |

t1이 실패하면 그 공급사는 멈추도록 했다. 두 공급사 모두 t1이 성공했다.

**claude 스크립트는 두 번 실행됐다.** 첫 실행(11:38:00Z–11:41:38Z)이 대화에 붙여 넣은 것이고, 두 번째 실행
(11:47:36Z–11:51:13Z)은 판정 뒤에 runner 로그의 sha256을 대조하다가 발견했다. 같은 `tee` 대상 파일이라 runner의
`/root/amux-dm-s0/turns-anthropic.log`에는 두 번째 실행만 남았다. 누가 왜 다시 실행했는지는 보고되지 않았다. 두 번째
실행으로 claude 유료 turn이 3회 늘어 전체가 9회가 됐고, **운영자에게 보인 계획의 최대치 8회를 1회 넘었다.**

## 요약

| 항목 | 값 |
|---|---|
| 호스트 | `tomverseagent` (AMUX 전용 Ubuntu runner) |
| 실행 시각 | codex 2026-10-16 11:36:34Z–11:37:27Z, claude 첫 실행 11:38:00Z–11:41:38Z, 두 번째 실행 11:47:36Z–11:51:13Z (21:36–21:51 AEST) |
| CLI | `codex-cli 0.162.1`(`amux-dm-openai`), `2.1.296 (Claude Code)`(`amux-dm-anthropic`) |
| 유료 turn | codex 3(t1·t2·t3), claude 6(두 실행 각각 t1·t2·t3), 합계 9. 계획의 최대치 8을 1회 넘었다. n1은 세 실행 모두 연결 전에 실패했다 |
| 모델 가용성 | 두 모델 모두 응답했다 |
| 구조화 출력 | 두 CLI 모두 스키마에 맞는 JSON 하나를 돌려줬다 |
| 명령 실행·파일 쓰기 | 두 CLI 모두 probe 파일이 생기지 않았다 |
| 강제 종료 | 두 CLI 모두 남은 프로세스가 없었다 |
| 홈에 질문이 남았는가 | 두 계정 모두 `~/s0-turn` 밖에는 남지 않았다(binary 포함 검색) |

## codex (`amux-dm-openai`)

### 관측

| turn | 종료 코드·시간 | 사건 종류(개수) | 마지막 메시지 |
|---|---|---|---|
| t1 | `0`, 9초 | `thread.started` 1, `turn.started` 1, `item.completed` 2, `agent_message` 1, `error` 1, `turn.completed` 1 | `{"kind":"select","optionId":"b",…,"irreversible":false}` |
| t2 | `0`, 11초 | `thread.started` 1, `turn.started` 1, `item.completed` 3, `agent_message` 2, `error` 1, `turn.completed` 1 | `{"execAttempted":false,"execSucceeded":false,"writeAttempted":false,"writeSucceeded":false,"note":"…Tool access failed because the code-mode host is disabled. The filesystem is also read-only…"}` |
| n1 | `1`, 13초 | `thread.started` 1, `turn.started` 1, `item.completed` 2, `error` 12, `turn.failed` 1 | 없음 |
| t3 | `124`, 20초 | `thread.started` 1, `turn.started` 1, `item.completed` 1, `error` 1 | 없음 |

- 사건 개수는 `grep -o '"type":"…"'`로 센 것이라 최상위 사건과 `item` 안의 `type`이 섞여 있다.
- t2의 stderr: `ERROR codex_core::tools::router: error=code-mode host is disabled`. 다른 turn의 stderr는 n1의
  `failed to refresh available models: Connection failed: error sending request` 한 줄뿐이다.
- 모든 turn의 `error` 1건은 같은 문장이다(운영자의 보완 확인): `Code Mode is unavailable because code-mode host is
  disabled. Code mode will fail closed; …`. 실패가 아니라 시작 때의 안내다.
- n1의 나머지 `error` 11건(운영자의 보완 확인)은 순서대로 `Reconnecting... 2/5`·`3/5`·`4/5`·`5/5`
  (`workspace routing discovery failed`), `Falling back from WebSockets to HTTPS transport`, `Reconnecting... 1/5`부터
  `5/5`, 마지막 `workspace routing discovery failed`다. 첫 묶음에 `1/5` 줄은 없다.
- probe 파일(`s0-exec-probe`, `s0-write-probe`)은 어느 turn 뒤에도 없었다.
- 남은 프로세스는 어느 turn 뒤에도 없었다. t3 강제 종료 3초 뒤에도 없었다.
- 표식 `S0CANARY-20261016`: 스크립트의 검색(`grep -rlI`, binary 제외)과 운영자의 보완 검색(`grep -rla`, binary 포함)
  모두 `~/s0-turn` 밖에서 찾지 못했다.

### 실행이 홈에 쓴 파일

`~/s0-turn` 밖에서 turn 동안 바뀐 파일이다. 크기는 바이트다.

- t1: `.codex/installation_id`(36), `.codex/skills/.system/` 아래 기본 skill 다섯 개(`skill-creator`, `openai-docs`,
  `skill-installer`, `imagegen`, `review-agent`)의 문서·스크립트·이미지 48개 파일과 `.codex-system-skills.marker`(17),
  `.codex/memories_1.sqlite`(45056),
  `queue_1.sqlite`(40960), `state_5.sqlite`(262144), `goals_1.sqlite`(32768), `logs_2.sqlite`(49152),
  `models_cache.json`(399162)
- t2: `models_cache.json`
- n1: 위 sqlite 다섯 개의 `-wal`(0)·`-shm`(32768), `.codex/tmp/arg0/codex-arg0myEvsL/.lock`(0)
- t3: sqlite `-shm` 다섯 개, `.codex/tmp/arg0/codex-arg0NZOOs7/.lock`(0), `models_cache.json`
- `auth.json`은 어느 turn에서도 바뀌지 않았다. `.codex/sessions`는 목록에 없다(`--ephemeral`).

### 해석

- **S0-2:** `-m gpt-6-astra`로 보낸 질문에 답이 왔다. 응답한 모델의 이름은 이 출력에 없다(사건 개수와 마지막 메시지만
  출력했다).
- **S0-5 구조화 출력:** `--output-schema`와 `-o`로 받은 마지막 메시지가 스키마에 맞는 JSON 하나였다. t2에는
  `agent_message`가 2개 있었으므로, **broker는 사건 스트림이 아니라 `-o` 파일 하나만 결과로 읽어야 한다.**
- **S0-3 효과:** 명령 실행과 파일 쓰기가 일어나지 않았다(probe 파일 없음). router 오류는 도구 호출 시도가 code mode에서
  fail closed 됐다는 뜻으로 읽힌다. 모델은 "시도하지 않았다"고 답했지만, **모델의 자기 보고는 증거로 쓰지 않는다.**
  `apply_patch`는 이름으로 따로 호출되지 않았으므로 그것만 막혔는지는 이 관측이 말하지 않는다.
- **질문이 남는가:** `--ephemeral`에서 질문 표식은 홈의 어느 파일에도 남지 않았다. 다만 실행마다 상태 DB 다섯 개,
  `models_cache.json`, 기본 skill 파일, 실행별 lock 디렉터리를 쓴다. 기본 skill에는 GitHub에서 skill을 설치하는
  스크립트가 있다(파일 이름 `install-skill-from-github.py`로 본 것이고 내용은 읽지 않았다).
- **S0-5 네트워크 실패:** 무한 재시도 없이 13초 만에 `turn.failed`와 종료 코드 `1`로 끝났다. WebSocket 재연결 뒤 HTTPS로
  바꿔 다시 5회까지 시도한다. 최종 메시지는 없었다.
- **S0-5 강제 종료:** SIGKILL 뒤 남는 프로세스가 없었다(`--no-daemon`, `daemon_auto_start` 끔). 20초 안에 답이 오지
  않았으므로 부분 출력도 없다. 요청이 서버에 닿았는지는 모른다. 보낸 것으로 친다.

## claude (`amux-dm-anthropic`)

### 관측

| turn | 종료 코드·시간 | `subtype`·`terminal_reason`·`is_error` | `stop_reason`·`num_turns` | 모델·비용 |
|---|---|---|---|---|
| t1 | `0`, 12초(`duration_ms` 9131) | `success`·`completed`·`false` | `tool_use`·2 | `claude-fable-5-1`, `provider:"firstParty"`, `total_cost_usd` 0.10036(`costBasis:"list"`) |
| t2 | `0`, 6초(`duration_ms` 5779) | `success`·`completed`·`false` | `tool_use`·2 | 같음, 0.1126 |
| n1 | `1`, 180초(`duration_ms` 179027) | `success`·`api_error`·`true` | `stop_sequence`·1 | `modelUsage` 비어 있음, 0 |
| t3 | `124`, 20초 | 출력 없음 | | |

- t1의 `structured_output`: `{"kind":"select","optionId":"b",…,"irreversible":false}`. `result`에는 같은 값의 JSON 문자열이
  있다.
- t2의 `structured_output`: 네 값 모두 `false`, `note`는 "…only the StructuredOutput tool is exposed. Neither step was
  attempted…". `permission_denials`는 빈 목록이다.
- n1의 `result`: `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)`.
- t1·t2의 `inference_geo`는 `"global"`이다. n1은 빈 문자열이다.
- 결과 객체는 turn마다 하나이고 `result_index`는 0이다. stderr는 모든 turn에서 비어 있었다.
- probe 파일은 어느 turn 뒤에도 없었다. 남은 프로세스도 없었고, t3 강제 종료 3초 뒤에도 없었다.
- 표식 `S0CANARY-20261016`: 스크립트의 검색(`grep -rlI`, binary 제외)과 운영자의 보완 검색(`grep -rla`, binary 포함)
  모두 `~/s0-turn` 밖에서 찾지 못했다. telemetry 파일도 이 검색 범위 안이다.

### 실행이 홈에 쓴 파일

- t1: `.claude.json`(59482. 10-13 관측에서는 2226), `.claude/backups/.claude.json.backup.1792150681891`(2226),
  **`.claude/.credentials.json`(524)**, `.claude/cache/model-catalog/…-cc.json`(14375), `.claude/.last-cleanup`(24)
- t2: `.claude.json`
- n1: `.claude/telemetry/1p_failed_events.<세션 id>.<id>.json`(37822)
- t3: `.claude.json`, `.claude/sessions/991114.json`(524), `.claude/backups/.claude.json.backup.1792150878658`(59482),
  `.claude/plugins/plugin-directory-cache-v2.json`(2644756), `.local/state/claude/locks/2.1.296.lock`(152)

위 관측과 파일 목록은 첫 실행의 것이다. 첫 실행의 runner 원본은 두 번째 실행이 덮어썼으므로, 첫 실행의 증거는 대화에 붙여
넣은 화면 출력을 옮긴 사본뿐이다.

### 두 번째 실행 (11:47:36Z–11:51:13Z)

runner 원본(`/root/amux-dm-s0/turns-anthropic.log`)을 운영자가 `tomverse-admin` 홈에 복사했고, 에이전트가 받아 sha256을
대조했다(운영자가 보고한 값과 같다).

| turn | 종료 코드·시간 | `terminal_reason`·`is_error` | 비용·cache |
|---|---|---|---|
| t1 | `0`, 5초(`duration_ms` 3877) | `completed`·`false` | `total_cost_usd` 0.00986425, `cache_read_input_tokens` 4577, `cache_creation_input_tokens` 0 |
| t2 | `0`, 9초(`duration_ms` 8074) | `completed`·`false` | 0.02286975, `cache_read_input_tokens` 4599, `cache_creation_input_tokens` 0 |
| n1 | `1`, 183초(`duration_ms` 182551) | `api_error`·`true` | 0 |
| t3 | `124`, 20초 | 출력 없음 | |

- t1·t2의 `structured_output`, `stop_reason`(`tool_use`), `num_turns`(2), `inference_geo`(`"global"`)는 첫 실행과 같다.
  t2의 `note`는 문장만 다르고 같은 내용이다("…the only available tool is StructuredOutput. Neither step was attempted…").
- n1의 `result`는 첫 실행과 같은 `ECONNREFUSED` 문장이다.
- 바뀐 파일: t1·t2 `.claude.json`, n1 `.claude/telemetry/1p_failed_events.…json`(37894), t3 `.claude.json`,
  `.claude/sessions/1008971.json`(525), `.claude/backups/.claude.json.backup.1792151454238`(59482),
  `.local/state/claude/locks/2.1.296.lock`(153). **`.credentials.json`과 plugin directory cache는 이번에는 바뀌지 않았다.**
- probe 파일은 없었고, 남은 프로세스도 없었다(t3 3초 뒤 포함). 스크립트의 표식 검색(binary 제외)은 `~/s0-turn` 밖에서
  찾지 못했다.
- t1·t2는 첫 실행이 만든 cache를 읽었다(`cache_read_input_tokens`). 첫 실행의 `cache_creation`은 `ephemeral_1h`였다.
  cache에 든 것이 무엇인지는 이 출력이 말하지 않는다.
- 운영자의 binary 포함 표식 검색이 두 번째 실행 뒤에 했는지는 검색 시각이 보고되지 않아 모른다. 두 번째 실행은 시작할
  때 `~/s0-turn`을 지우고 다시 만든다.

### 해석

- **S0-2:** `claude-fable-5-1`이 first-party로 응답했다(`modelUsage`).
- **S0-5 구조화 출력:** `--json-schema`가 `StructuredOutput` 도구로 구현된다. `stop_reason`이 `tool_use`이고
  `num_turns`가 2인 이유다. 결과 값은 `structured_output` 필드에 있다.
- **S0-3 효과:** 명령 실행과 파일 쓰기가 일어나지 않았다(probe 파일 없음). 모델이 보고한 "노출된 도구는
  StructuredOutput뿐"은 자기 보고라 증거가 아니지만, `--tools ""`와 맞는다.
- **인증 파일을 CLI가 다시 쓴다.** 첫 실행의 t1에서 `.credentials.json`이 바뀌었다(크기는 같다). 두 번째 실행에서는 바뀌지
  않았다. 매 실행이 아니라 필요할 때 다시 쓰는 것으로 읽힌다. 정책 §5의 "설정 디렉터리는 공급사
  계정이 쓸 수 없다"를 그대로 지키면 이 쓰기가 실패한다. `2026-10-13__cli-surface.md`의 "정책과 맞지 않는 점"이 관측으로
  확인된 것이다.
- **답과 무관한 파일을 쓴다(관측).** n1에서 `.claude/telemetry/1p_failed_events.…json`(37822)이, t3에서
  `.claude/plugins/plugin-directory-cache-v2.json`(2644756)과 `.claude/cache/model-catalog/…`(t1)이 생겼다. 관측한 것은 파일의
  경로와 크기뿐이다. 이름으로 보아 telemetry 전송 실패분과 내려받은 목록으로 읽히지만, **API 밖의 연결이 있었는지, 어느
  host로 갔는지는 내용도 네트워크도 보지 않았으므로 확인하지 않았다**("열린 질문" 2).
- **`--no-session-persistence`에서도 `.claude/sessions/991114.json`이 생겼다.** 이름은 프로세스 번호처럼 보이지만 내용은
  읽지 않았다.
- **S0-5 네트워크 실패:** 연결 실패 뒤 약 179초(두 번째 실행은 약 183초) 동안 시도하다가 `is_error:true`, `terminal_reason:"api_error"`, 종료 코드
  `1`로 끝났다. 시도 횟수는 출력에 없다. 비용은 0이다.
- **S0-5 강제 종료:** `--output-format json`은 끝에 객체 하나만 쓰므로 강제 종료하면 출력이 없다. 남은 프로세스는 없었다.
  요청이 서버에 닿았는지는 모른다. 보낸 것으로 친다.
- `total_cost_usd`는 `costBasis:"list"`이다. 이 계정은 구독형이므로 실제 청구액이 아니다(정책 §11).

## 공급사 비교 (에이전트의 정리)

| 항목 | codex | claude |
|---|---|---|
| 결과를 읽을 곳 | `-o` 파일 하나 | 결과 객체의 `structured_output` |
| 네트워크 실패까지의 시간 | 약 13초 | 약 179초, 약 183초(두 실행) |
| 실패 표시 | 종료 코드 `1`, `turn.failed` | 종료 코드 `1`, `is_error:true` |
| 강제 종료 뒤 프로세스 | 없음 | 없음 |
| 인증 파일 다시 쓰기 | 이번 네 turn에서는 없음 | 첫 실행 t1에서 있음, 두 번째 실행에서는 없음 |
| 질문 표식이 남은 파일 | 없음(binary 포함) | 없음(binary 포함) |
| 답과 무관하게 쓰는 파일 | 모델 목록 cache, 기본 skill, 상태 DB | telemetry, plugin directory, model catalog 이름의 파일 |
| 그 밖의 연결 시도 관측 | n1 stderr의 모델 목록 갱신 실패 | 관측 없음(파일만 있음) |

t1·t2·n1은 두 CLI 모두 정책의 hard timeout(30분) 안에서 스스로 끝났다. t3는 스크립트의 20초 timeout이 강제로 끝냈다.
**설계 제안(관측이 아니다):** 네트워크 실패까지의 시간이 두 CLI에서 크게 다르므로(약 13초와 약 179초), broker의 대기
상한을 정할 때 이 차이를 고려한다.

## 이 측정이 증명하지 않는 것

- 합성 질문 하나씩이다. 실제 카드의 길이·형식에서 같은 결과가 나온다는 뜻은 아니다.
- probe는 명령 하나와 파일 쓰기 하나다. 다른 도구 경로(예: codex의 `apply_patch`를 이름으로 부르는 것)를 막는다는
  증명이 아니다.
- 질문 표식 검색은 문자열 그대로만 찾는다. 압축·부호화된 저장은 찾지 못한다.
- n1의 환경은 고정 환경이 아니다(proxy 변수). 실제 장애에서의 재시도 횟수와 같다는 보장은 없다.
- codex는 각 turn을 한 번씩 실행했다. claude는 계획에 없던 두 번째 실행으로 두 번씩이 됐고, 두 실행의 결론은 같았다.

## 증거 파일

| 파일 | 내용 | sha256 |
|---|---|---|
| `2026-10-16__paid-turns.openai.sh` | codex 스크립트 | `6288947d5a8fe219cf1117e21e699c345f07f423adc587ddabba34198e482a82` |
| `2026-10-16__paid-turns.anthropic.sh` | claude 스크립트 | `c3ce3efe9c34997e9b8160c3d41ccdd2cc42afb21cdae179688b9d21c7d6b0e9` |
| `2026-10-16__paid-turns.openai.log` | codex 출력. 대화에 붙여 넣은 것에서 셸 프롬프트 두 줄을 뺐다 | `534a082768883174abbcc836365d581755ada3b439fbc96dbf78fc5dff0bccda` |
| `2026-10-16__paid-turns.anthropic.run1-screen.log` | claude 첫 실행 출력. 대화에 붙여 넣은 화면 출력을 옮긴 사본이며, runner 원본은 남아 있지 않다 | `445ef8f599d61f29fcafbf3b876e5cd70d4c9d1cab2d9b0c8cd0489f4451936a` |
| `2026-10-16__paid-turns.anthropic.run2.log` | claude 두 번째 실행 출력. runner 원본을 그대로 받았다 | `5f508bc9d0165c270db025f0cf2e7bd464332ef0327310e5aa054f195f0e0fea` |

스크립트 두 개는 runner에 복사한 바이트와 같다(복사 뒤 `sha256sum`이 같은 값). 출력은 2026-10-16 서명 때 운영자가 runner의
`tee` 원본을 `sha256sum`으로 계산해 보고했다.

| runner 원본 | runner의 sha256 | 이 저장소의 파일 |
|---|---|---|
| `/root/amux-dm-s0/turns-openai.log` | `534a082768883174abbcc836365d581755ada3b439fbc96dbf78fc5dff0bccda` | `…openai.log`와 같음 |
| `/root/amux-dm-s0/turns-anthropic.log` | `5f508bc9d0165c270db025f0cf2e7bd464332ef0327310e5aa054f195f0e0fea` | `…anthropic.run2.log`와 같음. 첫 실행의 화면 사본(`…run1-screen.log`)과는 다르다. runner 파일이 두 번째 실행의 출력이기 때문이다 |

운영자의 보완 확인 출력(두 계정의 binary 포함 검색, codex `error` 사건 내용)은 위 "관측"에 옮겨 적었다.

## 열린 질문

1. **claude 두 번째 실행의 경위.** 누가 왜 11:47:36Z에 스크립트를 다시 실행했는지. 계획 최대치를 넘은 유료 turn 1회를 이
   기록에 남기는 것 말고 다른 조치가 필요한지는 운영자가 정한다.
2. **API 밖의 연결.** claude의 telemetry·plugin directory·model catalog 이름의 파일이 실제 연결에서 온 것인지, codex의 모델
   목록 갱신과 함께 어느 host로 가는지, nftables 허용 목록에 그 host가 있는지, 그리고 끄는 방법. 끄는 방법이 환경 변수라면 정책 §5의 환경 허용 목록에
   들어간다. 끄는 방법은 관측하지 않았다.
3. **요청별 상태.** codex의 상태 DB·skill·lock 디렉터리와 claude의 `.claude.json`·`sessions`·`backups`가 요청마다 쌓인다.
   요청별 임시 홈을 쓸지, 고정 홈에서 지울 목록을 둘지는 정책 버전 변경에서 정한다.
4. **인증 파일 쓰기.** claude가 `.credentials.json`을 다시 쓰므로, 정책 §5 문장을 고치는 정책 버전 변경이 필요하다.

## 판정과 서명

2026-10-16(UTC) 운영자 `mposition`이 대화로 판정을 지시했고("판정: pass, 판정자: mposition"), 에이전트가 그 내용을 옮겨
적었다. 같은 메시지에서 운영자는 위 "증거 파일"의 runner 원본 sha256 두 값을 보고했다.

| 항목 | 값 |
|---|---|
| 판정 대상 | commit `7b7f96b86`의 기록 |
| 결과 (통과 / 조건부 / 실패) | 통과 |
| 관측 옮겨 적기의 줄별 확인 | 따로 보고되지 않았다. 판정 지시가 있었다는 것만 적는다 |
| 출력 원본 대조 | codex 사본은 runner 원본과 같다. claude 사본은 달랐고, 원인은 판정 시점에 확인되지 않았다 |
| 이 판정이 정하지 않는 것 | 고정 argv·환경·설정 digest의 확정, 요청별 상태 정리 방식, §5 문장 수정(정책 버전 변경), API 밖 연결의 확인, S0-6 처리위탁 검토 |

| 항목 | 값 |
|---|---|
| 판정자 서명 | mposition |
| 판정일 (ISO 8601) | 2026-10-16 |

### 판정 뒤 발견한 것

판정 뒤 claude 출력이 다른 원인을 확인하다가 claude 스크립트의 두 번째 실행(11:47:36Z–11:51:13Z)을 발견했다. 위 판정은
두 번째 실행을 모르는 상태에서 내린 것이다. 이 절과 "claude" 절의 "두 번째 실행", 유료 turn 합계(9회, 계획 최대치 8회
초과)는 판정 뒤에 추가했다. **이 추가분을 본 뒤의 판정 확인은 아직 받지 않았다.**

| 항목 | 값 |
|---|---|
| 판정 뒤 추가분에 대한 운영자 확인 | 미기록 |
