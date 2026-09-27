# Prompt Refiner successor Gitleaks exact-fingerprint 독립 검토 승인 기록

- approvedBy: `mposition`
- approvedAt: `2026-09-28` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `claude-code-max`
- reviewedHead: `366a7e6b05f638ba55c8f892a5afd3e2d5c10430`
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
node scripts/check-gitleaks-exact-range.mjs --reviewed-head=366a7e6b05f638ba55c8f892a5afd3e2d5c10430
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

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. child 환경에서
  `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 대소문자와 무관하게 제거하고,
  `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`,
  `subscriptionType=max`를 호출 직전에 확인한다. 실패하면 API 방식으로 전환하지 않는다.
- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를 사용할
  수 없다. `--skip-preflight`는 이 도구 제한 때문에 write-refusal probe를 증명할 수 없는
  환경 제약만 우회하며 test·guard 실패를 우회하지 않는다.
- package와 검토는 별도 지시 전까지 실행하지 않는다. 이번 준비 작업은 provider 호출,
  Railway 변경, database mutation, stage/run 승인, flag 활성화, 유료 shadow 실행,
  제품 Prompt Refiner 노출, Router 결합, commit·push·merge·deploy를 포함하지 않는다.
