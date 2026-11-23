# Decision Maker의 명령 실행 — box 실측과 설치 전 dry-run, 2026-11-23

> 운영자 지시(2026-11-22, 대화): "DM은 접근권한 막지 마세요." 정책 `docs/policy/amux-decision-maker.md` §0f-4·§5a의 근거다.
> 모든 측정은 AMUX box(`tomverseagent`)에서 `tommy` 계정으로 했다. sudo와 모델 호출은 없었다. 공급사 계정과 launcher unit
> 안의 확인은 설치 뒤 운영자가 `launcher.mjs <instance> --jail-selftest`로 한다(아래 "설치 뒤 확인").

## 측정한 것

### Codex 0.162.1의 쓰기 profile (`codex sandbox -P dm`, 모델 호출 없음)

DM과 같은 `-c default_permissions="dm"`, `-c permissions.dm.filesystem={":minimal"="read","<작업 디렉터리>"="write","/opt/tomverse-amux-dm/codex-cli-0.162.1"="read"}`를
root 소유 `/opt/tomverse-amux-dm/codex-cli-0.162.1/codex`에 주고, 시험용 홈 `.../home/dm-scratch/<id>/work`에서 명령을 돌렸다.

| 확인 | 결과 |
|---|---|
| 작업 디렉터리 읽기·쓰기, 하위 디렉터리, `.git` 쓰기 | 열림(쓴 파일이 디스크에 남음) |
| 홈의 `.codex/auth.json` 읽기 | 막힘 |
| 홈 목록 | codex가 만든 빈 가짜 디렉터리만 보임(`dm-scratch`) |
| 작업 디렉터리 옆 `-o` 파일 쓰기 | 명령은 성공하지만 디스크의 파일은 그대로(가짜 디렉터리에 씀) |
| 요청 디렉터리 읽기 | 막힘 |
| `/tmp` 쓰기 | 막힘 |
| `TMPDIR`(작업 디렉터리 안) 쓰기 | 열림 |
| TCP 443, DNS | 막힘 |
| 작업 디렉터리에 만든 `auth.json` symlink로 읽기 | 막힘 |
| `node` 실행 | 됨 |

`TMPDIR`가 가리키는 디렉터리가 없으면 codex sandbox가 시작하지 못한다(`failed to resolve synthetic mount registry temp
directory`, panic). launcher가 CLI를 시작하기 전에 만든다. `exec --strict-config`는 이 profile로 설정을 읽는다.

### Claude Code 2.1.296의 `Bash`와 jail (가짜 Messages endpoint, 모델 호출 없음)

127.0.0.1의 가짜 Messages endpoint가 차례로 도구 호출을 지시했다. CLI는 root 소유 `/opt/tomverse-amux-dm/claude-code-2.1.296/claude`, argv는
DM의 고정 argv(`--tools Read,Grep,Glob,Bash --allowedTools Read,Grep,Glob,Bash --restricted ... --permission-prompts none`), 환경은 §5a의
열 개에 `ANTHROPIC_BASE_URL`과 가짜 API key만 더했다. 홈의 `.claude/.credentials.json`에는 표식 문자열을 넣었다.

| 도구 호출 | CLI가 돌려보낸 결과 |
|---|---|
| `Bash`: `id`, `$HOME`, 로그인 디렉터리 목록, 로그인 읽기, 로그인 symlink 만들기, `/proc`, DNS | 묻지 않고 jail 안에서 실행. `HOME`은 작업 디렉터리의 `.amux-tmp`, 로그인 디렉터리와 파일은 "No such file", symlink는 만들어짐, `/proc`에는 jail의 pid만, DNS 없음 |
| `Read` 작업 디렉터리의 로그인 symlink | 거부: "resolves through a symlink ... outside ...; --restricted confines the file tools to the working directory" |
| `Read` 로그인 경로 | 거부: 작업 디렉터리 밖 |
| `Read` 홈을 가리키는 symlink 아래의 로그인 | 거부: symlink를 따라간 경로가 밖 |
| `Grep` 표식 문자열, 작업 디렉터리 | "No matches found"(symlink를 따라가지 않음) |
| `Bash`: 작업 디렉터리에 쓰기 | 성공 |

가짜 endpoint가 받은 모든 요청에서 표식 문자열은 0번 나왔다.

### jail 안의 의존성과 검사

bwrap 0.11.1, kernel 7.0.0-42, 저장소는 공개 develop `a7c650dd3`(depth 1)의 사본이다.

| 단계 | 결과 |
|---|---|
| cache 채우기(네트워크, `npm ci --ignore-scripts --cache`) | 14초, npm cache 433 MB, Prisma engine cache 23 MB |
| jail 안 `npm ci --offline --ignore-scripts`(cache는 읽기 전용 bind) | 성공, 11초, `node_modules` 1.7 GB |
| jail 안 `prisma generate`, engine cache를 읽기 전용으로만 | 실패: Prisma가 engine 파일에 `utime`을 쓴다(EROFS) |
| 같은 것, engine cache를 jail의 HOME으로 복사한 뒤 | 성공, 5초 |
| `node --import tsx --test tests/amuxDecisionMakerLauncherCore.test.mjs` 외 | 통과 |
| `next typegen`, jail에 `/proc` 없음 | 실패: SWC가 `/proc/self/maps`를 읽는다(`stacker` panic) |
| `next typegen`, jail 자신의 pid namespace에 새 `/proc`(`--proc /proc`) | 성공. `/proc`에는 jail의 pid 1~5만 보인다 |
| `tsc --noEmit` | 돌아간다(84~135초) |
| jail 안에서 cache·`/usr`·`/tmp` 쓰기, 홈의 로그인 읽기, DNS | 모두 막힘 |

`ProtectKernelTunables=`가 켜진 unit 안에서는 커널이 새 proc mount를 거부한다(v22 worker jail의 기록,
`lib/amux/v22ShellJail.mjs`). 그래서 DM launcher unit 두 개에서 그 줄을 뺐다. 공급사 계정은 root가 아니고 capability가 없어서
tunable을 쓸 수 없다. launcher는 요청마다 새 `/proc`이 되는지 한 번 시험하고, 안 되면 `/proc` 없이 jail을 만들며
`DEPENDENCIES.md`에 그렇게 적는다(그때는 `next typegen`과 `npm run typecheck`가 돌지 않는다).

## 설치 전 dry-run (2026-11-23)

이 PR의 코드(develop `f2ab32d71` 위)를 box의 시험 트리에 두고, 시험 host(`dmTestHost`, 정책 경로를 임시 root 밑으로 옮긴 것)에서
실제 bwrap과 실제 offline cache로 돌렸다. CLI만 가짜다: 가짜 claude가 `CLAUDE_CODE_SHELL_PREFIX`(launcher가 쓴 jail)로 실제
명령을 실행하고 결과를 기록한다.

- jail self-test(`dmJailSelfTest`의 jail 부분): 16개 확인이 모두 기대와 같았다. jail 시작, 새 `/proc`, npm cache와 pinned npm
  있음, 작업 디렉터리 쓰기 열림, 로그인 읽기·홈 목록·요청 root·`/tmp`·`/usr`·TCP·DNS·호출자 환경의 credential·cache 쓰기 막힘,
  `node` 실행, 정리 확인.
- 요청 하나(launcher 전체 경로, `launchDecisionMaker`): 요청 디렉터리에 공개 develop 사본(350 MB)을 두고 시작했다. 사본 복사,
  jail 안 `npm ci --offline`, `prisma generate`(`DEPENDENCIES.md`: `repo/: installed`), 가짜 claude 실행, 정리까지 146초 걸렸다.
  가짜 claude가 shell prefix로 돌린 명령의 결과는 다음과 같다.

  | 명령 | 결과 |
  |---|---|
  | `id -u; echo $HOME; ls /proc` | 계정 uid, `HOME`은 작업 디렉터리의 `.amux-tmp`, `/proc`의 pid 4개 |
  | 홈의 `.claude/.credentials.json` 읽기 | "No such file or directory" |
  | `getent hosts registry.npmjs.org` | 답 없음 |
  | `node --import tsx --test tests/amuxDecisionMakerLauncherCore.test.mjs` | pass 26, fail 0 |
  | `npm run typecheck`(`next typegen && tsc --noEmit`) | exit 0, `error TS` 0개 |
  | 작업 디렉터리에 쓰기 | 성공 |

  launcher 보고는 `outcome: output`, 정리는 `verified`, 의존성은 `{"proc":true,"trees":{"repo":"installed"}}`였다. 요청 디렉터리의
  정리도 `verified`였고, 임시 디렉터리는 없어졌으며, 홈에는 `.claude/.credentials.json`만 남았다.

Linux(box) 테스트: `amuxDecisionMakerLauncherCore` 26, `LauncherFs` 22, `LauncherProcess` 21, `Broker` 30, `BrokerCore` 18,
`Install` 22, `InstallShell` 9, `WorkCopy` 4(실제 bwrap 포함), `v22ShellJail` 4, `v22OneShotSidecar` 31, `v22ChannelRun` 9, 모두 통과.
`Broker`의 "a workspace that cannot be fetched" 한 건은 tommy 셸의 umask `0002`에서만 실패한다(git이 group 쓰기 디렉터리를 만들어
정리가 거부한다). broker unit은 `UMask=0077`이고, umask `022`에서는 통과한다. 이 PR과 무관하다. 전체 `tsc --noEmit`은 이 PR의 파일에서
오류가 없다.

## 설치 뒤 확인 (운영자, root)

설치 순서와 명령은 PR 본문에 있다. 설치 뒤, 요청이 없을 때 공급사 계정마다 launcher unit과 같은 보호 설정으로 self-test를 돌린다.
모델 호출은 없다. `ok`만 나오면 끝이다. `the jail has its own /proc`이 `no`면 DM은 그대로 일하지만 `next typegen`이 돌지 않는다.
`the npm cache is filled`가 `no`면 `amux-dm-dependency-cache.sh --refresh`를 먼저 돌린다.

```bash
for pair in openai:amux-dm-openai anthropic:amux-dm-anthropic; do
  vendor=${pair%%:*}; account=${pair#*:}
  sudo systemd-run --wait --pipe --quiet -p User="$account" -p Group="$account" \
    -p ProtectSystem=strict -p ReadWritePaths="/home/$account" -p PrivateTmp=yes -p NoNewPrivileges=yes \
    -p CapabilityBoundingSet= -p ProtectProc=invisible -p ProtectControlGroups=yes -p ProtectKernelModules=yes \
    -p RestrictSUIDSGID=yes -p LockPersonality=yes -p UMask=0077 \
    /usr/bin/node /opt/tomverse-amux-dm/launcher.mjs "decision-maker-$vendor" --jail-selftest
done
```
