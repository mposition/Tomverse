# Prompt Refiner successor Gitleaks exact-fingerprint 독립 검토 승인 기록

- approvedBy: `mposition`
- approvedAt: `2026-09-28` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `claude-code-max`
- reviewedHead: `370ae752bdbf2db990b25a965a23cfb2e6959923`
- baseCommit: `82caecfd8a3dbb4815fd9c232f2b42b2dafcf646`

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
- `npm run security:regression`
- `npm run typecheck`
- `npx eslint lib/crossReviewCore.ts scripts/cross-review.mjs tests/crossReview.test.mjs`
- `npm run check:encoding`
- `git diff --check 82caecfd8a3dbb4815fd9c232f2b42b2dafcf646`
- 로컬에 기존 Gitleaks 8.24.3 binary가 있을 때만 그 binary의 버전을 먼저 확인하고,
  `82caecfd8a3dbb4815fd9c232f2b42b2dafcf646^..370ae752bdbf2db990b25a965a23cfb2e6959923`
  first-parent exact range를 현재 `.gitleaksignore`로 scan한다. 이번 작업을 위해 binary를
  내려받거나 다른 버전·container·원격 action으로 대체하지 않는다.

검사 실패는 `--skip-preflight`로 우회하지 않는다. 기존 binary가 없다는 사실은 scan
성공으로 기록하지 않고, package의 실행 검사 목록에서 해당 command를 제외한 사유를
명시한다.

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
