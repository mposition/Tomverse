# AMUX Server Deploy

이 문서는 `vendor/amux`(AMUX 서버와 대시보드)의 실행 바이너리를 AMUX 호스트에서
빌드해 교체하는 절차다. 2026-10-07에 develop `15956d418`을 배포한 회차를 그대로
옮겼다.

## 범위와 승인

- PR 병합은 실행 바이너리를 바꾸지 않는다(`architecture.md`). 대시보드도 서버
  바이너리에 컴파일 시점에 묶이므로(`amux-dashboard`의 `RustEmbed`) 같은 절차로만
  바뀐다.
- **교체는 실행 중인 서버를 재시작하는 행위이므로 운영자의 명시적 승인이 있어야
  한다.** 빌드와 사전 검사는 실행 중인 서버에 영향이 없으므로 승인 전에 해도 된다.

## 공통 실행 조건

아래 모든 명령 블록은 같은 조건에서 실행한다. 블록마다 이 중 무엇이 달라지는지만
덧붙인다.

- **기계와 계정**: AMUX 호스트의 bash, AMUX 서비스 계정(`tommy`). 바이너리는
  `~/.local/bin/amux-server-rs`, 서비스는 user unit `amux-server.service`다.
- **권한과 자격증명**: sudo도 production 자격증명도 필요 없다. 필요한 것은 그
  계정의 `~/Tomverse` clone이 `origin`에서 fetch할 수 있는 GitHub 읽기 권한과
  `~/.cargo/bin`의 Rust 도구체인뿐이다.
- **같은 셸 유지**: 1~2단계와 6단계는 앞 블록에서 정한 `C`, `B`, `W`, `R`을
  쓴다. 같은 셸 세션에서 이어서 실행하거나, 새 셸이면 1단계의 첫 세 줄을 다시
  정한다.

## 1. 빌드

정확한 commit을 별도 worktree로 꺼내 빌드한다. `amux-server`의 `build.rs`가
`git`으로 commit을 읽어 `/health`의 `commit_full`에 새기므로, git checkout 밖(예:
`git archive`)에서 빌드하면 `unknown`이 되고, 수정 중인 트리에서 빌드하면 그
상태가 새겨진다.

쓰는 것: `~/Tomverse`의 원격 참조(fetch)와 worktree 목록, `$W`(소스), `$B/target`
(빌드 결과). 실행 중인 서버와 워커는 건드리지 않는다. 되돌리기는 6단계의 worktree
삭제다.

```bash
C=<40자리 commit>
B=$HOME/.local/share/tomverse-build
W=$B/src-$C
git -C ~/Tomverse fetch origin develop
git -C ~/Tomverse worktree add --detach "$W" "$C"
cd "$W/vendor/amux"
env PATH=$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=$B/target \
  nice -n 10 cargo build --release -p amux-server --locked -j 8
```

- `CARGO_TARGET_DIR`은 워커들이 쓰는 `~/.amux/rust-build-target`과 분리한다. 캐시가
  있으면 약 3분 걸린다.
- `nice`와 `-j 8`은 같은 호스트에서 도는 워커의 몫을 남기기 위한 것이다.
- `git fetch`에 `--depth`를 주지 않는다. 공유 clone이 shallow가 된다.

## 2. 보관과 사전 검사

쓰는 것: release 폴더 `$R` 하나. 나머지는 읽기만 한다.

```bash
R=$HOME/.local/share/tomverse-release/$C
mkdir -p "$R" && chmod 700 "$R"
install -m 0755 "$B/target/release/amux-server" "$R/amux-server-rs"
sha256sum "$R/amux-server-rs" ~/.local/bin/amux-server-rs
grep -a -o -E "$C(-dirty)?" "$R/amux-server-rs" | sort | uniq -c
```

- 두 sha256은 교체 스크립트에 그대로 고정한다.
- commit이 `-dirty` 없이 나와야 한다.
- 대시보드를 바꾼 회차라면 새 `APP_VER`(예: `grep -c -a 'amux-v0.9.984'`)와
  바꾼 화면의 고유 문자열이 바이너리 안에 있는지 확인한다.
- 실행 중인 서버와 같은 포트를 쓰므로 후보 바이너리를 따로 띄워 보지 않는다.

## 3. 교체

다음 스크립트에 commit과 두 sha256을 채워 파일(예: `install.sh`)로 저장한다.
운영자 승인 뒤, 공통 조건의 계정으로 실행한다. 원격에서 넘길 때는
`ssh <host> 'bash -s' < install.sh`처럼 파일로 넘겨야 셸 인용 문제가 없다.

쓰는 것: `~/.local/bin/amux-server-rs`(교체), 같은 폴더의 백업 파일, 그리고 AMUX
서버 재시작. `/health`를 30번 검사해도 새 commit이 보고되지 않으면 스크립트가
스스로 백업으로 되돌린다. 검사 한 번은 연결이 바로 거부되면 약 1초, 응답 없이
시간 초과되면 약 3초(요청 2초와 대기 1초)이므로, 되돌리기는 재시작 뒤 최대 약
90초가 걸린다. 수동 되돌리기는 5단계다.

```bash
#!/usr/bin/env bash
set -euo pipefail
[[ $(id -un) == tommy ]] || { echo 'requires_tommy'; exit 1; }
commit=<40자리 commit>
old_sha=<실행 중인 바이너리 sha256>
new_sha=<후보 바이너리 sha256>
source_bin=$HOME/.local/share/tomverse-release/$commit/amux-server-rs
target=$HOME/.local/bin/amux-server-rs
backup=$HOME/.local/bin/amux-server-rs.before-${commit:0:8}-$(date +%Y%m%d)
staged=$HOME/.local/bin/.amux-server-rs.${commit:0:8}-staged

printf '%s  %s\n' "$old_sha" "$target" | sha256sum -c - >/dev/null || { echo 'live_binary_changed'; exit 1; }
[[ ! -e "$backup" && ! -e "$staged" ]] || { echo 'staging_path_exists'; exit 1; }
install -m 0755 "$target" "$backup"
install -m 0755 "$source_bin" "$staged"
printf '%s  %s\n' "$new_sha" "$staged" | sha256sum -c - >/dev/null || { rm -f -- "$staged"; echo 'candidate_sha_mismatch'; exit 1; }
mv -T -- "$staged" "$target"

rollback() { install -m 0755 "$backup" "$target"; systemctl --user restart amux-server.service || true; echo "rolled_back: $1"; exit 1; }
systemctl --user restart amux-server.service || rollback restart_failed
for _ in $(seq 1 30); do
  if curl -ksS --max-time 2 https://127.0.0.1:8824/health \
      | python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["commit_full"]=="'"$commit"'" and x["status"]=="ok"' 2>/dev/null; then
    echo "amux_server_active $commit"; exit 0
  fi
  sleep 1
done
rollback health_not_ok_in_30s
```

- 실행 중인 바이너리가 고정한 sha256과 다르면 아무것도 바꾸지 않고 멈춘다. 다른
  누군가가 먼저 교체했다는 뜻이다.
- 재시작 직후 첫 `/health` 요청은 연결 거부가 정상이다.
- `amux-server.service`는 `KillMode=process`라서 재시작은 서버 프로세스만 멈추고,
  워커 tmux 세션은 그대로 남는다.

## 4. 사후 확인

읽기만 한다. invariant monitor가 재시작 뒤 첫 pass를 기록할 때까지(이번 회차는
약 40초) 기다린 다음 실행한다. `NEW`는 `/health`가 보고한 `build` 값이다.

```bash
curl -ksS https://127.0.0.1:8824/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["commit_full"], d["build"])'
tmux list-sessions -F '#{session_name} #{session_created}' | grep '^amux-'
NEW=<health의 build 값>
DB=~/.amux/amux.db
# 새 build가 기록한 실패. 비어 있어야 한다.
sqlite3 -readonly -cmd '.timeout 3000' "$DB" \
  "SELECT invariant_id, entity_key, observed FROM _amux_invariant_result
   WHERE build = '$NEW' AND status = 'fail';"
# 새 build가 몇 개의 invariant를 기록했는지. 0이면 아직 pass 전이다.
sqlite3 -readonly -cmd '.timeout 3000' "$DB" \
  "SELECT COUNT(DISTINCT invariant_id), COUNT(*) FROM _amux_invariant_result WHERE build = '$NEW';"
# provider별 최신 launch 검사 결과.
sqlite3 -readonly -cmd '.timeout 3000' "$DB" \
  "SELECT entity_key, status, MAX(rowid) FROM _amux_invariant_result
   WHERE build = '$NEW' AND invariant_id = 'provider.launch_matches_adapter'
   GROUP BY entity_key ORDER BY entity_key;"
```

- `/health`: `status`가 `ok`, `commit_full`이 배포한 commit이다.
- 워커 세션의 생성 시각이 교체 전과 같다. `amux-init`만 새로 생기는 것이 정상이다.
- 첫 쿼리가 비어 있고, 둘째 쿼리가 0이 아니다. 결과가 0이면 실패가 없는 것이
  아니라 아직 측정 전이다.
- 셋째 쿼리의 provider 목록이 `session_verbs.rs`의 `SESSION_PROVIDERS`와 같고 모두
  `pass`다. 목록에 없는 provider는 측정되지 않은 것이다.
- 대시보드는 `APP_VER`가 바뀌었으면 브라우저가 새 service worker를 받아 스스로
  다시 읽는다. 바뀌지 않았으면 새로고침한다.

## 5. 되돌리기

쓰는 것: `~/.local/bin/amux-server-rs`와 AMUX 서버 재시작. 워커 세션은 남는다.

```bash
install -m 0755 ~/.local/bin/amux-server-rs.before-<commit 8자리>-<날짜> ~/.local/bin/amux-server-rs
systemctl --user restart amux-server.service
```

백업 바이너리는 지우지 않고 남긴다. 직전 몇 회차의 백업이 그 회차의 되돌릴 지점이다.

## 6. 정리와 기록

쓰는 것: `~/Tomverse`의 worktree 목록과 `$W` 삭제.

```bash
git -C ~/Tomverse worktree remove "$W"
```

빌드 캐시(`$B/target`)와 release 폴더는 다음 회차를 위해 남긴다. 회차마다 다음을
남긴다.

- 배포한 commit과 그 commit이 담은 PR
- 이전·새 바이너리 sha256과 백업 경로
- 교체 시각, 승인한 운영자
- 사후 확인 결과(`/health`, 워커 세션, invariant)

## main으로 가는 selective release와의 관계

AMUX 호스트는 develop 빌드로 먼저 돌 수 있다. 같은 변경을 main으로 보낼 때는
`.github/RELEASE_CHECKLIST.md` §7.9.1을 **그대로** 따른다. 특히 release 후보 SHA를
staging이나 scratch 환경에 배포하고 `/api/build-info`로 그 SHA를 확인하는 항목은
이 문서의 어떤 확인으로도 대신하지 않는다. 그 항목은 release 후보 전체를 대상으로
하기 때문이다.

이 문서의 확인을 release 후보에 쓸 수 있는 범위는 AMUX 부분 하나다. release
브랜치의 `vendor/amux` tree가 배포한 빌드의 tree와 같으면, 그 회차의 사후
확인(4단계)은 release 후보에 담긴 AMUX 코드에 대한 근거가 된다.

읽기만 하며, 어느 clone에서나 실행할 수 있다.

```bash
git rev-parse <release 브랜치>:vendor/amux <배포한 commit>:vendor/amux
```

두 값이 다르면 release 후보의 AMUX 코드는 실행된 적 없는 조합이며, 1~4단계로
따로 빌드해 확인한다. 같더라도 release 기록에는 AMUX 근거와 RC 배포 확인을 각각
적는다.
