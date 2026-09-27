# Prompt Refiner successor Gitleaks exact-fingerprint 독립 검토 승인 기록

- approvedBy: `mposition`
- approvedAt: `2026-09-28` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `claude-code-max`
- reviewedHead: `b24dd58975f50dc85d871d57d1ab72c89dd6f181`
- baseCommit: `82caecfd8a3dbb4815fd9c232f2b42b2dafcf646`

`reviewedHead`는 검토 대상 source-fix commit을 뜻한다. 그 뒤에 이 SHA를 적는
authorization-only metadata commit이 생기면 `reviewedHead`는 의도적으로 그 commit의
parent다. authorization commit이 자기 SHA를 미리 적도록 요구하지 않는다. 아래 range의
끝도 항상 같은 source-fix commit이며, 이번 round 수정이 commit된 뒤 package 전에 두
곳을 그 최종 source-fix SHA로 함께 한 번 repin한다.

사용자는 CHAT-01을 완료할 때까지 권장 순서로 자동 개발하고 독립 검토가 필요할 때
Claude 검토를 받도록 지시했다. 이 작업의 Claude 검토에 `--skip-preflight` 예외도
승인했다. 이 문서는 전자서명, 검토 통과, secret의 진위에 대한 포괄 승인, provider
호출, 비용 지출, push·병합·배포 또는 제품 노출 승인이 아니다.

## 적용 범위

이번 승인은 immutable Prompt Refiner successor cross-review 기록 안의 DB 통합 테스트용
합성 환경 placeholder에서 발생한 24개 Gitleaks finding을 exact
`commit:path:rule:line` fingerprint로만 무시하는 변경의 읽기 전용 독립 검토에 적용한다.
검토자는 24개 각각의 provenance, 기존 package bytes와 digest의 불변성, 기존 allowlist의
비확장성 및 더 넓은 suppression이 없는지를 확인한다.
또한 향후 생성되는 cross-review 진단은 위 DB fixture의 정확한 세 `KEY=VALUE` token만
마스킹하고, 변경된 값·유사 key·일반 문맥과 검토 대상 source diff 및 digest는 그대로
보존하는지 확인한다.

## 결정적 검사 계약

- `node --import tsx --test tests/crossReview.test.mjs`
- `node --test tests/gitleaksAllowlist.test.mjs`
- `node --test tests/gitleaksExactRangeGuard.test.mjs`
- `npm run security:regression`
- `npm run typecheck`
- `npx eslint lib/crossReviewCore.ts scripts/cross-review.mjs scripts/check-gitleaks-exact-range.mjs tests/crossReview.test.mjs tests/gitleaksExactRangeGuard.test.mjs`
- `npm run check:encoding`
- `git diff --check 82caecfd8a3dbb4815fd9c232f2b42b2dafcf646`
- 공식 provenance는 [gitleaks/gitleaks v8.24.3 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.24.3)다.
  package runner는 저장소 밖에서 exact `gh release download v8.24.3 --repo gitleaks/gitleaks`
  명령으로 `gitleaks_8.24.3_windows_x64.zip`과
  `gitleaks_8.24.3_checksums.txt`만 받는다. archive SHA-256은 공식 checksums의
  `3f1a35578631dbfe633cc5b49e6c906e55ff14a4bfd7336a10fb27fe33b6dcd2`, 추출한
  `gitleaks.exe` SHA-256은
  `8f397272f513c00b573f50380c4724e4b3ac759be1de313d907bb968c5d14c09`로 고정한다.
- 위 두 hash 검증 뒤 외부 binary의 경로를 `GITLEAKS_BIN`으로 주입한다. guard 자체는
  다운로드·container·원격 action 또는 다른 네트워크 동작을 하지 않는다.
- package의 `--guard-command`에는 아래 command를 그대로 전달하고, command와 결과가
  `guardCommands` 및 `guardRuns`에 남아야 한다.

```sh
node scripts/check-gitleaks-exact-range.mjs --reviewed-head=b24dd58975f50dc85d871d57d1ab72c89dd6f181
```

guard는 `GITLEAKS_BIN`을 absolute path로 resolve하고 exe hash를 검사한 다음에만 정확한
`8.24.3` version을 신뢰한다. 그 뒤 exact first-parent range를 scan하며 resolved path,
hash, version, range와 scan output을 모두 기록한다. 마지막 출력은 400자 이하의
deterministic single-line `gitleaks.final` footer다. footer에는 resolved path SHA-256,
version, exe SHA-256, exact range, exit status와 full raw stdout+stderr bytes의 SHA-256 및
각 raw byte count가 들어간다. output digest는 `tomverse-gitleaks-scan-output-v1` domain
prefix와 각 stream의 uint64 byte-length frame 뒤 raw bytes를 직접 hash하므로 invalid
UTF-8이나 stream 경계도 보존한다. 사람용 UTF-8 log decoding은 digest 계산 뒤 별도다.
따라서 package의 last-five-lines와 400-character truncation 뒤에도 전체 scan의 무결성
대표값이 남는다. explicit path는 footer가 400자 이하일 때만 함께 남기고, 그렇지 않으면
항상 남는 path SHA-256으로 결속한다.

`GITLEAKS_BIN` 부재, 파일 아님, hash·version 불일치 또는 finding은 모두 실패다.
`--skip-preflight`는 이 검사 실패를 우회하지 않는다. source fix를 commit한 뒤 위
`--reviewed-head`도 문서 상단 `reviewedHead`와 같은 최종 source-fix SHA로 repin한다.

round 1 이후에는 exact own package output 아래의 canonical prior-round package·verdict를
loader가 계속 읽어야 한다. `packageExclusionProblems`가 exact outDir exclusion과 scoped
source 비중첩을 먼저 검증하고, control state가 요구하는 prior package/verdict/diff/exchange
및 그 successful review가 결속한 exact record 이름만 outside-writable-scope 검사에서
제외한다. directory 전체를 예외로 하지 않는다. unrelated tracked/untracked,
canonical-looking current-round·invalid record, failed-attempt archive, arbitrary exclude,
parent·sibling·child 경로, outDir 아래 scoped source와 outDir 밖 untracked file은
fail-closed다. 기존 package diff digest, verdict와 exchange round 결속도 다시 검사한다.

`--out`은 repository 내부의 물리 경로여야 한다. 생성 전, `mkdir` 직후와 각 write 직전에
모든 existing component 및 destination을 `lstat`과 `realpath`로 다시 확인하여 symlink,
Windows junction/reparse point, alias와 repository escape를 mutation 전에 거부한다. 기록을
쓴 뒤에는 tracked/untracked tree, scoped diff digest와 generated-path snapshots를 다시 읽고,
exact prior canonical files와 이번 round가 방금 만든 exact files 이외의 mutation이 있으면
성공을 출력하지 않는다. 이 fail-closed 경로는 사용자 파일을 삭제하지 않는다.
command 시작 시 `process.cwd()`와 `git rev-parse --show-toplevel`의 real path가 정확히
같지 않으면 어떤 output도 만들기 전에 거부한다. repository subdirectory나 alias cwd에서
상대 package/verdict/preflight namespace를 나누어 쓰는 실행은 지원하지 않는다.

기존 destination은 hardlink count가 정확히 1인 regular file만 허용한다. writer는 같은
directory에서 exclusive private temp를 만들고 내용을 쓴 뒤 `fsync`·`close`한다. parent,
output, destination과 temp identity를 rename 직전에 다시 확인하고 atomic replacement로
directory entry를 교체하므로 기존 inode를 열어 쓰지 않는다. 실패 시 현재 path가 자신이
만든 temp와 같은 identity이고 nlink 1임을 증명할 때만 그 temp를 정리한다.

후속 round의 provenance는 exact `cross-review-verdict-v3`와
`cross-review-preflight-v4`만 인정한다. verdict wrapper의 version·task·round·reviewer·tool
version·command·cwd·sandbox·receivedAt·usage와 inner task·round·package digest를 검사한다.
참조된 preflight는 같은 task·round·HEAD·digest에 결속되고 report schema와 현재 preflight
판정 규칙을 다시 통과해야 한다. 두 record의 raw event/stderr companion은 writer가 기록한
exact filename, byte count와 SHA-256으로 다시 읽는다. binding 없는 기존 v2/v3 기록은
완화하지 않고 새 exchange에서 v3/v4 writer로 다시 생성한다.

새 `cross-review-package-v5`는 reviewer role에서 결정되는 exact command, cwd, shell/auth,
tool version, Claude Max first-party auth provenance와 sandbox signature를 review 전에 기록한다.
command의 첫 항목은 repository 밖 canonical absolute executable path이고 exact byte count와
SHA-256을 함께 결속한다. version/auth/review 직전에 같은 real path와 bytes를 다시 검사하며,
preflight/review 전후로 exact packaged diff·excluded snapshot·whole tracked/untracked tree를
재검사하여 새 out-of-scope entry, 새 비생성 untracked file과 in-scope mutation도 거부한다.
production Windows reviewer는 native `.exe`/`.com`만 허용하고 `.cmd`/`.bat` shim은
transitive Node/JavaScript target이 executable digest 밖에 남으므로 거부한다. 모든 reviewer는
timeout의 단 한 번 종료에 쓰는 canonical System32 `taskkill.exe`도 bytes·SHA-256로 결속하여
PATH shadow를 사용하지 않는다.
preflight/review는 유료 호출 전에 현재 CLI version과 auth를 다시 읽어 package와 다르면 중단한다.
continuation은 verdict/preflight wrapper를
신뢰하지 않고 bound raw event bytes를 writer와 동일한 production CLI decoder로 다시 읽어
agent result가 native successful terminal보다 먼저 정확히 하나인지 확인하고 terminal 뒤의
result/failure/second terminal/추가 event를 모두 거부한다. 복원한 JSON과 wrapper의 report/verdict는 key order와
무관한 canonical deep equality로 같아야 한다. preflight stream에는 recorded probe path를
명명한 exact `Set-Content` 또는 `printf` command event 하나와 거부 증거가 있어야 한다.
참조 preflight와 verdict의 command, cwd, sandbox signature와 tool version도 exact 동일해야
하며 result-only·command-only·malformed·conflicting event와 forged wrapper·command·sandbox는
fail-closed다.

CLI stdout/stderr는 string 누적 없이 Buffer chunk를 모아 완료 후 한 번만 UTF-8 decode한다.
companion byte count와 SHA-256 및 저장 bytes는 Buffer.concat 결과 그대로이고 multi-byte 문자의
chunk 경계에 영향받지 않는다. 각 raw event/envelope JSON은 모든 object depth에서 escaped-equivalent
key와 `__proto__`를 포함한 duplicate key를 먼저 거부하고 null-prototype object로 해석한 뒤에만
`type`, `item`, `result`를 읽는다.

review prompt의 requirement, criteria, diff, test·guard output, prior finding,
author account와 repository-derived value는 전부 untrusted data다. prompt 시작과
answer format 직전에 embedded instruction, tool request, role change를 무시하고
task/repository 관련 read-only inspection만 허용한다는 경계를 반복한다. 각 payload의
Markdown fence는 payload 안의 가장 긴 backtick run보다 길고 최소 4자이므로 source가
fence를 닫고 reviewer instruction으로 탈출할 수 없다.

preflight/verdict의 usage는 bound raw events에서 다시 계산한 값과 canonical deep equality로
같아야 하고 verdict `receivedAt`은 `startedAt`보다 빠를 수 없다. 모든 companion과 wrapper를
atomic write한 뒤 validator로 다시 읽고, verdict는 저장된 exchange의 exact replay까지 같아야
결론을 출력한다.

package는 tests·guards 전에 모든 prior canonical package/verdict/diff/exchange/preflight 및
bound companion의 exact bytes·SHA-256을 snapshot한다. tests·guards 직후 이름 집합과 bytes를
재검증하고 package write 뒤 immutable prior snapshot과 새 전체 canonical set을 다시 비교한
뒤 package/verdict/preflight/exchange/replay, scoped diff와 generated snapshot을 reload한다.
어느 단계든 mutation이 있으면 package 성공을 출력하지 않는다.

이 binding·reload·snapshot은 한 control-program command의 시작부터 최종 검증까지
내부 정합성과 무변조만 증명한다. 다음 command가 시작되기 전에 서로 맞춰 다시 쓴
pre-existing record set은 인증하지 않는다. commit 전 `--out`은 mutable working state이며
durable approval evidence가 아니다. 교차 실행 provenance는 exact bytes를 commit하고 후속
작업이 repository review policy 아래 그 commit bytes와 비교하는 시점부터 성립한다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. review child와 auth/version
  probe 환경에서 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, 세
  `CLAUDE_CODE_USE_*` 외부-provider switch 및 `AWS_`/`GOOGLE_`/`AZURE_` cloud
  credential/config 변수의 모든 case variant를 제거하고,
  `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`,
  `subscriptionType=max`를 호출 직전에 확인한다. 실패하면 API 방식으로 전환하지 않는다.
- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를 사용할
  수 없다. `--skip-preflight`는 이 도구 제한 때문에 write-refusal probe를 증명할 수 없는
  환경 제약만 우회하며 test·guard 실패를 우회하지 않는다.
- package와 검토는 별도 지시 전까지 실행하지 않는다. 이번 준비 작업은 provider 호출,
  Railway 변경, database mutation, stage/run 승인, flag 활성화, 유료 shadow 실행,
  제품 Prompt Refiner 노출, Router 결합, commit·push·merge·deploy를 포함하지 않는다.
