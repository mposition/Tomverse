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
- 모든 단계는 AMUX 서비스 계정(`tommy`)으로 하며 sudo가 필요 없다. 바이너리는
  `~/.local/bin/amux-server-rs`, 서비스는 user unit `amux-server.service`다.

## 1. 빌드

정확한 commit을 별도 worktree로 꺼내 빌드한다. `amux-server`의 `build.rs`가
`git`으로 commit을 읽어 `/health`의 `commit_full`에 새기므로, git checkout 밖(예:
`git archive`)에서 빌드하면 `unknown`이 되고, 수정 중인 트리에서 빌드하면 그
상태가 새겨진다.

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

다음 스크립트에 commit과 두 sha256을 채워 서비스 계정으로 실행한다
(`ssh <host> 'bash -s' < install.sh`처럼 파일로 넘기면 셸 인용 문제가 없다).

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

```bash
curl -ksS https://127.0.0.1:8824/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["commit_full"], d["build"])'
tmux list-sessions -F '#{session_name} #{session_created}' | grep '^amux-'
sqlite3 -readonly -cmd '.timeout 3000' ~/.amux/amux.db \
  "SELECT invariant_id, entity_key, status, build FROM _amux_invariant_result ORDER BY rowid DESC LIMIT 20;"
```

- `/health`: `status`가 `ok`, `commit_full`이 배포한 commit이다.
- 워커 세션의 생성 시각이 교체 전과 같다. `amux-init`만 새로 생기는 것이 정상이다.
- 새 `build` 값으로 기록된 invariant 결과에 `fail`이 없다. provider를 바꾼
  회차라면 `provider.launch_matches_adapter`가 모든 provider에서 `pass`여야 한다.
- 대시보드는 `APP_VER`가 바뀌었으면 브라우저가 새 service worker를 받아 스스로
  다시 읽는다. 바뀌지 않았으면 새로고침한다.

## 5. 되돌리기

```bash
install -m 0755 ~/.local/bin/amux-server-rs.before-<commit 8자리>-<날짜> ~/.local/bin/amux-server-rs
systemctl --user restart amux-server.service
```

백업 바이너리는 지우지 않고 남긴다. 직전 몇 회차의 백업이 그 회차의 되돌릴 지점이다.

## 6. 정리와 기록

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

AMUX 호스트는 develop 빌드로 먼저 돌 수 있다. 같은 변경을 main으로 보낼 때
(`.github/RELEASE_CHECKLIST.md` §7.9.1) release 브랜치의 `vendor/amux` tree가 배포한
빌드와 같으면, 배포 회차의 확인이 그 release 후보에도 그대로 적용된다.

```bash
git rev-parse <release 브랜치>:vendor/amux <배포한 commit>:vendor/amux
```

두 값이 다르면 release 후보는 실행된 적 없는 조합이며, 따로 빌드해 확인한다.
