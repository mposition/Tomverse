# Limited Claude review authorization — v1 integration and v1.1

Recorded by Codex at `2026-09-10T01:49:32.1589329Z`. This is the receipt preparation time, not an independently observed timestamp of the user's message or a reviewer execution.

## User response and scope

The user's exact response in the current conversation was:

> 네 승인합니다

The immediately preceding proposal, summarized here rather than quoted verbatim, requested permission to use `--skip-preflight` only for the independent Claude reviews of this Router benchmark v1 integration and the subsequent v1.1 development work. It retained the read-only reviewer restriction and required tests/CI. This receipt records that limited response; it is not a reviewer verdict, authenticated signature or production approval.

For this integration, the task is `router-development-benchmark-v1-integration`, PR is [#1311](https://github.com/mposition/Tomverse/pull/1311), and the develop base is `5b7352564f507a722fbb1e3395b368ba5eae4299`. The v1.1 authorization is limited to that next development review and does not expand this integration task's source scope or authorize benchmark execution.

## Conditions that remain in force

- Only the existing independent Claude reviewer invocation is authorized, after successful verification and a separate orchestrator go: `claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`, prompt on stdin, no model override. No author executor, shell/write tools or additional MCP access is authorized.
- `--skip-preflight` must be explicit and recorded by the existing control program. It means the preflight was skipped with this permission, not that it passed. Original interactive-review records retain their null command/preflight/usage and their reported timestamps unchanged.
- `--review-despite-check-failures` is prohibited. All package tests and guards must pass; CI remains required before PR merge. Failed checks are fixed and verified, not overridden.
- Remove `ANTHROPIC_API_KEY` only from the review child process environment and preserve the stored `claude.ai` login/configuration directory. Do not change the parent or persistent environment, switch to `--bare`, or fall back to API-key billing. A separate read-only child authentication check reported loggedIn=true, authMethod=claude.ai and apiProvider=firstParty; it was not a review or a preflight pass, and this receipt contains no credentials.
- The existing limit is at most two fix rounds per exchange. Do not reset it by reopening a passed/exhausted exchange. Any source change requiring further independent review must be announced before that review.
- This does not authorize live benchmark collection, paid model/provider API calls for benchmark data, provider API billing, a main merge, production deployment, production routing changes, quality promotion or production approval. Claude review permission does not transfer to benchmark execution.
- Commit, package generation, reviewer execution, push and PR merge remain subject to their separate verification and orchestrator go points. This receipt alone performs none of them.

## Immutable prior evidence

The original reviewed source is `138bd4c60bd0534dbf131df5f7868fe9d1f623f4`, with digest `sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345`. Its completed approval record is at `0e853fd9ecebb0808dacefc6816a0d1f25148783`.

The [original task](router-development-benchmark-v1.task.json) and every original file under [the v1 review package](router-development-benchmark-v1/README.md) remain byte-identical to that record commit. Their inclusion in the new task's review scope is not permission to edit them. The new integration is a separate task/exchange with a freshly computed digest, not a continuation of that passed exchange or a reuse of its approval.
