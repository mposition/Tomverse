# Independent review — task prompt-refiner-durable-stage-writer-linux-route-test-v1, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

PR #1555의 Linux 통합 CI에서 Prompt Refiner 관리자 route server-contract 5개가 route.GET/POST is not a function으로 연쇄 실패한 테스트 로더 결함을 고친다. 이 테스트 파일은 격리된 server-contract process에서 route를 한 번만 import하므로 Windows에서만 우연히 named export를 보존하던 query-string cache suffix를 제거하고, route가 참조하는 authOptions를 다른 관리자 route 테스트와 같이 명시적으로 mock해 platform별 transitive auth import를 없앤다. 실제 route, 제품 runtime, database, provider/model, Railway, credential, stage, flag/rollout 및 유료 실행은 변경하지 않는다. author는 Codex, reviewer는 Claude Code Max이며 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only와 strict MCP로 검토한다.

## Completion criteria

- admin-prompt-refiner-shadow-stage-route server-contract가 route.ts를 query suffix 없이 직접 import하고 lib/auth.ts authOptions를 명시적으로 mock한다.
- 해당 6개 테스트가 Windows 로컬 server-contract 명령에서 통과하고 Linux PR Fast Gate에서 GET/POST named exports를 정상 호출한다.
- typecheck, 수정 파일 lint, strict encoding 및 diff whitespace 검사가 통과한다.
- 변경은 테스트와 검토 기록에 한정되며 실제 route 또는 제품 동작을 바꾸지 않는다.
- Claude verdict는 package digest와 결속하며 최초 검토와 최대 두 번의 수정 검토 후 actionable finding이 남으면 on_hold다.

## Change under review — digest sha256:e01bfa7ae5df3b59fe073fc64e2d7b7eff1d09cd4f3071d6f8373f011368dee7, commit ae33745fb76b9f5a8e11d3b37646e81d7c2d0192

```diff
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.authorization.md b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.authorization.md
new file mode 100644
index 00000000..1538c0ec
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.authorization.md
@@ -0,0 +1,17 @@
+# Prompt Refiner Linux route 테스트 수정 Claude 독립 검토 제한 승인
+
+Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 중단된 자동 개발을 이어서
+마무리하도록 요청했고, 앞선 지시에서 독립 검토가 필요하면 Claude에 요청하며
+`--skip-preflight` 예외를 허용했다. 이 문서는 전자서명, 제품 실행 승인 또는 검토
+통과 기록이 아니다.
+
+이 승인은
+[검토 task](prompt-refiner-durable-stage-writer-linux-route-test-v1.task.json)에 정의된
+Linux server-contract 테스트 로더 수정의 Claude 읽기 전용 독립 검토에만 적용한다.
+
+- Claude는 저장된 Claude Max `claude.ai` 로그인과 `Read,Grep,Glob`만 사용한다.
+- review child 환경에서 Anthropic API key 환경변수를 제거하고 Max 인증을 확인한다.
+- `--skip-preflight`만 허용하며 test/CI 우회와 `--review-despite-check-failures`는 금지한다.
+- 제품 route, database, provider/model, Railway, credential, stage, flag/rollout 및 유료
+  실행은 승인하지 않는다.
+- 최초 검토와 최대 두 번의 수정 검토만 허용한다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.task.json
new file mode 100644
index 00000000..923fa3c8
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.task.json
@@ -0,0 +1,18 @@
+{
+  "taskId": "prompt-refiner-durable-stage-writer-linux-route-test-v1",
+  "requirement": "PR #1555의 Linux 통합 CI에서 Prompt Refiner 관리자 route server-contract 5개가 route.GET/POST is not a function으로 연쇄 실패한 테스트 로더 결함을 고친다. 이 테스트 파일은 격리된 server-contract process에서 route를 한 번만 import하므로 Windows에서만 우연히 named export를 보존하던 query-string cache suffix를 제거하고, route가 참조하는 authOptions를 다른 관리자 route 테스트와 같이 명시적으로 mock해 platform별 transitive auth import를 없앤다. 실제 route, 제품 runtime, database, provider/model, Railway, credential, stage, flag/rollout 및 유료 실행은 변경하지 않는다. author는 Codex, reviewer는 Claude Code Max이며 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only와 strict MCP로 검토한다.",
+  "completionCriteria": [
+    "admin-prompt-refiner-shadow-stage-route server-contract가 route.ts를 query suffix 없이 직접 import하고 lib/auth.ts authOptions를 명시적으로 mock한다.",
+    "해당 6개 테스트가 Windows 로컬 server-contract 명령에서 통과하고 Linux PR Fast Gate에서 GET/POST named exports를 정상 호출한다.",
+    "typecheck, 수정 파일 lint, strict encoding 및 diff whitespace 검사가 통과한다.",
+    "변경은 테스트와 검토 기록에 한정되며 실제 route 또는 제품 동작을 바꾸지 않는다.",
+    "Claude verdict는 package digest와 결속하며 최초 검토와 최대 두 번의 수정 검토 후 actionable finding이 남으면 on_hold다."
+  ],
+  "baseCommit": "aaefe4245457335874b078746ae067a23a0d11dc",
+  "writableScope": [
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.authorization.md",
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-linux-route-test-v1.task.json",
+    "tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts"
+  ],
+  "generatedPaths": []
+}
diff --git a/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts b/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
index f62a248d..d854063b 100644
--- a/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
+++ b/tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts
@@ -104,6 +104,9 @@ async function loadRoute() {
             : null,
       },
     });
+    mock.module(mod("lib/auth.ts"), {
+      namedExports: { authOptions: {} },
+    });
     mock.module(mod("lib/adminAuth.ts"), {
       namedExports: {
         isAdminSession: () => world.authenticated,
@@ -180,7 +183,7 @@ async function loadRoute() {
       },
     });
   }
-  return import(`${mod("app/api/admin/prompt-refiner/shadow-stage/route.ts")}?cached`);
+  return import(mod("app/api/admin/prompt-refiner/shadow-stage/route.ts"));
 }
 
 const post = (body: unknown) =>

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --experimental-test-module-mocks --no-warnings=ExperimentalWarning --import tsx --test --test-concurrency=1 tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts` (629ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 541.8911

## Guard results (run by the control program)

- PASS `npm run typecheck` (41861ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npx eslint tests/server-contract/admin-prompt-refiner-shadow-stage-route.test.ts` (2849ms)
- PASS `npm run check:encoding:strict` (1407ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check aaefe4245457335874b078746ae067a23a0d11dc HEAD -- .` (59ms)

## Findings from the previous round (check each was addressed)

- [nit/judgement] tests/server-contract/chat-preflight-rate-limit.test.ts:65, chat-attachment-unavailable.test.ts:120, chat-route-turnstile-grant.test.ts:102, chat-native-search-cost-parity.test.ts:189, chat-route-model-selection.test.ts:66, chat-route-safety.test.ts:82: Six other server-contract files still import route modules through a query-string cache suffix, the same loader pattern this change identifies as the Linux failure cause, so the same defect may be latent there (out of this task's writable scope, informational only).

## Author's account (read last; a claim, not a finding)

Summary: Round 0은 현재 digest를 merge as is로 승인했고 현재 task에 변경 요청이 없다. 범위 밖 6개 query-suffix 테스트는 동일 Linux PR Fast Gate run에서 모두 통과했으므로 이번 관측 실패의 재현 대상이 아니며, 검증되지 않은 예방 관찰을 위해 scope를 확장하지 않는다. 현재 test fix와 digest는 변경 없이 유지한다.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-durable-stage-writer-linux-route-test-v1",
  "round": 1,
  "reviewedDigest": "sha256:e01bfa7ae5df3b59fe073fc64e2d7b7eff1d09cd4f3071d6f8373f011368dee7",
  "conclusion": "approve | request_changes | blocked",
  "findings": [
    {
      "location": "path:line or symbol",
      "severity": "error | warning | nit",
      "basis": "evidence | preference | judgement",
      "claim": "what is wrong, in one sentence",
      "reproduction": "how to see it: a command, or an input and its expected output (required for the finding to be acted on)"
    }
  ],
  "nextAction": "one sentence"
}
```

`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands.
