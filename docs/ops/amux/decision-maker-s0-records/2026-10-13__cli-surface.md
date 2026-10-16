# Decision Maker S0 CLI 실행 표면 관측 기록 — 2026-10-13 (초안)

> **초안이다. 운영자가 서명하지 않았다.** 운영자가 runner에서 실행하고 대화에 붙여 넣은 출력을 에이전트(Claude)가
> 옮겨 적었다. 이 문서의 "후보"와 "열린 질문"은 에이전트의 정리이고 판정이 아니다. 서명 전의 이 기록은 S2 선행
> 조건의 증거가 아니며, 정책 버전에 argv·환경·설정 digest를 기록하는 승인도 아니다. 아래 "판정과 서명"은 비어 있다.

정책 근거는 `docs/policy/amux-decision-maker.md` 정책 버전 1의 §5("실행 방식")와 §12 S0이다. 이 기록이 다루는 S0
항목은 둘이다.

- **명령 실행을 끄는 모드의 유무.** 있는지만 본다. 효과(실제로 막히는지)는 유료 turn이 있어야 확인되므로 이 기록에
  없다.
- **고정 argv와 설정 digest의 후보.** 정책 §5가 "S0이 실측해 정책 버전에 기록한다"고 한 값의 재료다.

**유료 turn은 0이다.** 실행한 것은 `--version`, `--help`, `codex features list`, 그리고 root의 파일 목록 조회뿐이다.
모델에게 보낸 요청은 없다.

계정 격리 실측은 같은 날의 `2026-10-13__a3f51403afccf147442f7c2ca7eeb4ccf97b8068.md`(서명 완료)에 있고, 이 기록은
그것을 바꾸지 않는다.

## 요약

| 항목 | 값 |
|---|---|
| 호스트 | `tomverseagent` (AMUX 전용 Ubuntu runner) |
| 설치·로그인 | 2026-10-13 03:58Z 설치, 04:01Z(codex)·04:02Z(claude) 로그인 |
| 관측 시각 | 2026-10-13 10:55Z–10:57Z (2026-10-13 20:55–20:57 AEST). 대화에 붙여 넣은 시각이다 |
| 실행 위치 | root 셸, `sudo -u <DM 계정> -H bash -lc 'cd ~ && …'` |
| 유료 turn | 0 |
| 명령 실행을 끄는 모드 | codex: 단일 스위치 없음. claude: `--tools ""`와 `--restricted`가 있음 |
| 고정 설정 파일 | 두 계정 모두 없음(`config.toml`, `settings.json` absent) |

## CLI

| 계정 | UID | CLI | 버전 | 실행 파일 |
|---|---|---|---|---|
| `amux-dm-openai` | 992 | Codex CLI | `codex-cli 0.162.1` | `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex` |
| `amux-dm-anthropic` | 991 | Claude Code | `2.1.296 (Claude Code)` | `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.296` |

- 설치는 각 계정으로 공급사의 설치 스크립트를 실행했다(`https://chatgpt.com/codex/install.sh`, `https://claude.ai/install.sh`).
  codex는 `0.162.1-x86_64-unknown-linux-musl` standalone 패키지를 받았다고 출력했다.
- **두 실행 파일과 그 symlink는 DM 계정 홈 안에 있고 그 계정 소유다.** 그래서 DM 계정은 자기 CLI를 바꿀 수 있다.
  이것이 고정 launcher에 주는 의미는 "열린 질문" 3에 적었다.

## 로그인 뒤 홈 상태

root가 `find /home/<계정> -maxdepth 2`로 본 목록이다(`~/.local/share`와 `~/.codex/packages`는 제외했다). 모델 요청을 한
번도 보내지 않은 상태이므로, **한 번의 실행이 무엇을 쓰는지는 이 목록이 말하지 않는다.** 로그인과 `--help`·`--version`
까지가 남긴 것이다.

### `amux-dm-openai`

| 모드 | 경로 | 크기 |
|---|---|---|
| `drwx------` | `/home/amux-dm-openai` | |
| `drwxr-xr-x` | `.codex` | |
| `-rw-------` | `.codex/auth.json` | 4125 |
| `drwxr-xr-x` | `.codex/log` | |
| `drwxr-xr-x` | `.codex/tmp` | |
| `drwxr-xr-x` | `.local`, `.local/bin` | |
| `-rw-r--r--` | `.bash_logout`, `.bashrc`, `.profile` | 220, 3771, 912 |

### `amux-dm-anthropic`

| 모드 | 경로 | 크기 |
|---|---|---|
| `drwx------` | `/home/amux-dm-anthropic` | |
| `drwxr-xr-x` | `.claude`, `.claude/backups`, `.claude/cache`, `.claude/downloads` | |
| `-rw-------` | `.claude/.credentials.json` | 524 |
| `drwx------` | `.claude/sessions` | |
| `-rw-------` | `.claude.json` | 2226 |
| `drwxr-xr-x` | `.cache`, `.cache/claude` | |
| `drwxr-xr-x` | `.local`, `.local/bin`, `.local/state` | |
| `drwxr-xr-x` | `.npm`, `.npm/_logs` | |
| `-rw-r--r--` | `.npm/_update-notifier-last-checked` | 0 |
| `-rw-r--r--` | `.bash_logout`, `.bashrc`, `.profile` | 220, 3771, 807 |

### 고정 설정 파일

```
absent: /home/amux-dm-openai/.codex/config.toml
absent: /home/amux-dm-anthropic/.claude/settings.json
```

digest를 잴 설정 파일이 지금은 없다. 정책 §5의 "설정 digest"가 무엇의 digest인지는 "정책과 맞지 않는 점"에 적었다.

## codex

### 관측: `codex exec --help`

`exec`에 있는 옵션은 다음이다(설명은 줄였다).

| 옵션 | 도움말이 말하는 것 |
|---|---|
| `[PROMPT]`, `-` | 인자가 없거나 `-`이면 stdin에서 읽는다 |
| `-c, --config <key=value>` | `~/.codex/config.toml`의 값을 덮어쓴다 |
| `--enable`, `--disable <FEATURE>` | `-c features.<name>=true/false`와 같다 |
| `--strict-config` | `config.toml`에 모르는 필드가 있으면 오류 |
| `-i, --image` | 이미지 첨부 |
| `-m, --model` | 모델 |
| `--oss`, `--local-provider` | 오픈소스·로컬 공급자 |
| `-p, --profile` | `$CODEX_HOME/<name>.config.toml`을 겹친다 |
| `-s, --sandbox` | `read-only`, `workspace-write`, `danger-full-access` |
| `--approve-for-me` | 승인 요청을 workspace-write sandbox의 자동 검토로 보낸다 |
| `--dangerously-bypass-approvals-and-sandbox` | 확인 없이 sandbox 없이 실행 |
| `--dangerously-bypass-hook-trust` | 신뢰 기록 없이 hook 실행 |
| `-C, --cd <DIR>` | 작업 루트 |
| `--worktree` | 새 Git worktree에서 실행 |
| `--add-dir <DIR>` | 쓰기 가능한 디렉터리 추가 |
| `--thread-source` | thread 출처 분류 |
| `--cyber-access-program` | 실험적 Cyber access program 요청 |
| `--skip-git-repo-check` | Git 저장소 밖에서 실행 허용 |
| `--ephemeral` | 세션 파일을 디스크에 남기지 않는다 |
| `--ignore-user-config` | `$CODEX_HOME/config.toml`을 읽지 않는다. 인증은 `CODEX_HOME`을 계속 쓴다 |
| `--ignore-rules` | user·project execpolicy `.rules`를 읽지 않는다 |
| `--output-schema <FILE>` | 최종 응답의 JSON Schema |
| `--json` | 사건을 JSONL로 stdout에 |
| `-o, --output-last-message <FILE>` | 마지막 메시지를 파일로 |

하위 명령은 `resume`, `fork`, `review`다.

**`codex --help`(최상위)에만 있고 `exec --help`에는 없는 옵션:** `-a, --ask-for-approval`(`on-request`·`never`),
`--search`, `--remote`, `--remote-auth-token-env`, `--no-alt-screen`, `--no-daemon`. 최상위 사용법은
`codex [OPTIONS] <COMMAND> [ARGS]`이지만, 최상위 옵션이 `exec`에 적용되는지는 도움말이 말하지 않는다("열린 질문" 1).

### 관측: 기능 목록

`codex features list`는 기능마다 단계와 실제 상태를 출력한다. 출력 전체 가운데 **켜져 있는(`true`) 것 57개**는
다음이다. 단계가 `removed`인 것은 괄호에 적었다.

`api_key_model_discovery`, `apps`, `auth_elicitation`, `browser_annotation_api`, `browser_use`,
`browser_use_external`, `browser_use_full_cdp_access`, `code_mode_host`, `collaboration_modes`(removed),
`compaction_image_budget`, `computer_use`, `content_item_kinds`, `daemon_auto_start`, `enable_request_compression`,
`fast_mode`, `goals`, `guardian_approval`, `guardian_reuse_parent_compaction`, `hooks`, `image_generation`,
`in_app_browser`, `in_app_chat`, `in_app_dictation`, `in_app_local_automation`, `in_app_updates`, `in_app_voice`,
`instant_interrupt`(under development), `item_ids`(removed), `mentions_v2`, `multi_agent`, `plugin_sharing`, `plugins`,
`realtime_conversation`, `remote_plugin`, `resize_all_images`(removed), `shell_snapshot`, `shell_tool`,
`skill_mcp_dependency_install`, `skill_search`, `sleep_tool`, `sqlite`(removed), `steer`(removed),
`system_proxy_fallback`, `terminal_resize_reflow`(removed), `tool_call_mcp_elicitation`,
`tool_search_always_defer_mcp_tools`(removed), `tool_suggest`, `tui_app_server`(removed), `ultrafast_mode`,
`unbounded_connection_retries`, `unified_exec`, `unified_exec_tty`, `unified_exec_zsh_fork`(removed), `view_image`,
`workspace_dependencies`, `worktrees`, `write_stdin_approval`.

`apply_patch` 계열은 목록에 `removed` 단계로만 있고(`apply_patch_freeform`, `apply_patch_preserve_line_endings`)
`apply_patch_streaming_events`는 `under development`·`false`다. 파일을 고치는 도구를 끄는 기능 이름은 목록에 없다.

### 명령 실행을 끄는 모드

**단일 스위치는 없다.** 명령 실행은 기능별로 끈다(`--disable <FEATURE>`, 반복 가능). 정책 §5가 적은 대로
`-s read-only`는 파일 읽기와 명령 실행을 막지 않으며, DM이 읽을 수 있는 범위는 계정 경계가 정한다. 아래 목록을 다
꺼도 모델이 어떤 도구를 쓸 수 있는지는 유료 turn으로만 확인된다("열린 질문" 2).

### 고정 argv 후보

```
codex exec - \
  --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check \
  -s read-only --json --output-schema <root 소유 스키마> -o <요청별 출력 파일> \
  -m <정책이 정한 OpenAI 모델> -C <요청 디렉터리> \
  --disable <기능> …
```

- 질문은 stdin(`-`)으로 넘긴다. argv에 카드 내용을 싣지 않는다.
- 승인 정책 `never`는 `exec`에 옵션이 없으므로 `codex -a never exec …` 형태나 `-c`로 줄지 정해야 한다("열린 질문" 1).
- `--disable` 후보(켜져 있는 것 가운데 명령 실행·외부 연결·상주 프로세스·자기 수정과 닿는 것):
  - 명령 실행: `shell_tool`, `unified_exec`, `unified_exec_tty`, `shell_snapshot`, `code_mode_host`,
    `write_stdin_approval`, `sleep_tool`
  - 브라우저·화면·외부 앱: `browser_use`, `browser_use_external`, `browser_use_full_cdp_access`,
    `browser_annotation_api`, `computer_use`, `in_app_browser`, `apps`
  - 확장·자동 설치: `plugins`, `plugin_sharing`, `remote_plugin`, `hooks`, `skill_mcp_dependency_install`,
    `skill_search`, `tool_suggest`, `workspace_dependencies`, `tool_call_mcp_elicitation`
  - 하위 에이전트·작업 공간: `multi_agent`, `worktrees`, `goals`, `in_app_local_automation`
  - 생성·이미지: `image_generation`, `view_image`
  - 상주·갱신·네트워크: `daemon_auto_start`(상주 서버 프로세스가 요청 뒤에 남지 않게), `in_app_updates`,
    `system_proxy_fallback`, `unbounded_connection_retries`(재시도 형태가 S0-5의 측정 대상이므로 끈 상태로 잰다),
    `realtime_conversation`

  어느 것을 끄는지는 이 기록이 정하지 않는다. 정책 버전에 기록할 때 정한다.

### 거부할 argv

`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--approve-for-me`, `--add-dir`,
`-s workspace-write`, `-s danger-full-access`, `--worktree`, `--enable`, `-p`/`--profile`, `--oss`, `--local-provider`,
`--cyber-access-program`, `-i`/`--image`, 그리고 최상위의 `--search`, `--remote`, `--remote-auth-token-env`,
하위 명령 `resume`·`fork`·`review`. 고정 argv와 바이트 단위로 같지 않으면 시작을 거부하므로(정책 §5), 이 목록은
broker 테스트가 "이것이 섞이면 거부한다"를 고정할 때의 기준이다.

## claude

### 관측: `claude --help`

후보 argv에 쓰는 옵션의 도움말 설명이다.

| 옵션 | 도움말이 말하는 것 |
|---|---|
| `-p, --print` | 응답을 출력하고 끝난다 |
| `--tools <tools...>` | 내장 도구 목록. `""`이면 모든 도구를 끈다 |
| `--restricted` | 명령·코드를 실행하는 내장 도구(Bash, PowerShell, REPL 등)와 WebFetch를 `--tools`가 이름 대지 않는 한 없앤다. user·project·local 설정 파일을 무시한다(managed settings와 `--settings`는 적용). 파일 도구를 작업 디렉터리에 가둔다. `bypassPermissions`를 거부한다 |
| `--strict-mcp-config` | `--mcp-config`의 MCP 서버만 쓰고 다른 MCP 설정은 무시한다 |
| `--setting-sources <sources>` | 읽을 설정 출처(user, project, local) |
| `--settings <file-or-json>` | 추가 설정 파일이나 JSON |
| `--no-session-persistence` | 세션을 디스크에 저장하지 않는다(`--print`에서만) |
| `--output-format` | `text`, `json`, `stream-json`(`--print`에서만) |
| `--json-schema <schema>` | 구조화 출력 검증용 JSON Schema |
| `--permission-prompts <target>` | `--print`에서 권한 질문에 답하는 쪽. `none`이면 질문할 것은 모두 자동 거부 |
| `--disable-slash-commands` | 모든 skill을 끈다 |
| `--model` | 모델 |
| `--max-budget-usd` | API 호출 금액 상한(`--print`에서만) |
| `--bare` | hook·LSP·plugin 동기화·auto-memory·keychain 읽기·CLAUDE.md 탐색을 건너뛴다. **인증은 `ANTHROPIC_API_KEY`나 `apiKeyHelper`뿐이고 OAuth는 읽지 않는다** |

### 명령 실행을 끄는 모드

**있다.** `--tools ""`가 모든 내장 도구를 끄고, `--restricted`가 명령 실행 도구와 WebFetch를 없애며 설정 파일을
무시한다. 둘을 함께 쓴다. 효과는 유료 turn으로 확인한다("열린 질문" 2).

`--bare`는 쓰지 않는다. 이 계정은 OAuth로 로그인했고(`.claude/.credentials.json`), `--bare`는 OAuth를 읽지 않는다.

### 고정 argv 후보

```
claude -p \
  --tools "" --restricted --strict-mcp-config --setting-sources "" --settings <root 소유 고정 설정> \
  --disable-slash-commands --no-session-persistence --permission-prompts none \
  --output-format json --json-schema <스키마> --model <정책이 정한 Anthropic 모델>
```

- 질문은 stdin으로 넘긴다.
- `--setting-sources ""`가 빈 목록으로 받아들여지는지는 도움말이 말하지 않는다("열린 질문" 1).
- `--max-budget-usd`는 공급사 쪽 비용 상한으로 쓸 수 있는 후보다. 쓰는지는 정책 버전에서 정한다.

### 거부할 argv

- 권한 우회: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, 그리고 값과 상관없이
  `--permission-mode`(도움말의 선택지는 `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`이다.
  후보 argv는 이 옵션을 쓰지 않는다)
- 범위 확장: `--add-dir`, `--allowedTools`/`--allowed-tools`, `--tools`의 `""` 밖 값, `-w`/`--worktree`, `--tmux`
- 외부 연결·확장: `--mcp-config`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent`, `--file`, `--chrome`,
  `--cloud`, `--environment`, `--remote-control`, `--ide`, `--desktop`, `--brief`
- 세션 이어가기·백그라운드: `--bg`/`--background`, `-r`/`--resume`, `-c`/`--continue`, `--fork-session`,
  `--session-id`, `--teleport`, `--from-pr`
- 모델·설정 바꾸기: `--fallback-model`, `--betas`, `--system-prompt`(고정 지시문을 argv로 바꾸게 되므로),
  `--bare`(위 이유)
- 디스크에 쓰는 진단: `-d`/`--debug`, `--debug-file`, `--verbose`

## 정책과 맞지 않는 점

정책 §5는 "CLI의 설정 디렉터리는 공급사 계정이 쓸 수 없고(인증과 고정 설정만 있음)"라고 한다. 관측은 다음이다.

- 인증 파일(`.codex/auth.json`, `.claude/.credentials.json`)은 설정 디렉터리 안에 있고 그 계정 소유다. OAuth 토큰은
  갱신 때 CLI가 다시 쓰므로, 설정 디렉터리를 계정이 쓸 수 없게 하면 로그인이 유지되지 않을 수 있다.
- claude는 `.claude.json`을 홈 바로 아래에, 세션·캐시를 `.claude/` 아래에 쓴다.
- 실행 파일도 계정 홈 안에 있다.

그래서 이 문장을 그대로 지키는 배치는 지금 관측으로는 보이지 않는다. 에이전트가 정리한 대안은 **고정 설정을 root
소유 별도 파일에 두고 argv로 넘기는 것**이다(codex는 `--ignore-user-config`와 `-c`·`--disable`, claude는 `--restricted`와
`--settings`). 그러면 "설정 digest"는 그 root 소유 파일의 digest가 된다. 이 대안은 정책 문장을 바꾸므로 **정책 버전
변경**이며, 이 기록이 정하지 않는다.

## 열린 질문

유료 turn 없이 답할 수 있는 것(1)과 유료 turn이 필요한 것(2), 배치 결정(3–4)으로 나눴다.

1. **argv 형태(무료).**
   - `codex -a never --no-daemon exec --help`가 오류 없이 받아들여지는지. 안 되면 `-c`의 어떤 key로 주는지.
   - `claude -p --setting-sources "" --help`가 빈 목록을 받아들이는지.
2. **효과(유료 turn).**
   - 위 `--disable` 목록을 준 codex와 `--tools "" --restricted`를 준 claude가 명령을 실행하거나 파일을 고칠 수 있는지.
     특히 codex의 `apply_patch`가 막히는지(끄는 기능 이름이 목록에 없다).
   - 한 번의 실행 뒤 `.codex/log`, `.codex/tmp`, `.claude/`, `.claude.json`, `.cache/claude`, `.local/state`에 질문 내용이
     남는지. 정책 §5는 CLI의 기록·transcript를 끄거나 요청별 임시 디렉터리에 두고 지우라고 한다.
3. **실행 파일 고정.** 실행 파일이 계정 소유라서 계정이 바꿀 수 있다. broker가 시작 전에 실행 파일의 digest도
   대조할지, 실행 파일을 root 소유 경로로 옮길지 정해야 한다.
4. **자동 업데이트.** codex는 `in_app_updates`(켜짐)와 `codex update`가 있고, claude 네이티브 설치는 자동 업데이트를
   한다. 끄는 방법이 환경 변수라면 그 변수는 정책 §5의 환경 허용 목록에 들어간다. 끄는 방법은 아직 관측하지 않았다.

## 판정과 서명

비어 있다. 운영자가 각 관측 줄을 확인한 뒤 적는다.

| 항목 | 상태 |
|---|---|
| 관측 옮겨 적기 확인 | 미확인 |
| 판정 | 미기록 |
| 서명 | 미서명 |
