# Limited Claude review authorization - Router collector v1.1

Recorded by Codex at `2026-09-10 02:57:55 UTC`. This is the receipt preparation time only,
not an independently observed timestamp of either user message, an integration,
a provider call or a reviewer execution.

## User responses and their limited meaning

The user's automatic-sequence instruction in the current conversation was:

> 네 권장 순서로 자동으로 진행해주세요. 단, 독립 검토 필요시 미리 꼭 알려주세요.

The user's exact response to the subsequent limited review-preflight question was:

> 네 승인합니다

The immediately preceding question, summarized rather than quoted, requested
permission to use `--skip-preflight` only for the independent Claude reviews
of Router benchmark v1 integration and the subsequent v1.1 development work,
while retaining read-only review and required tests/CI. This receipt carries
that existing permission forward to the new collector task; it does not ask
for or invent broader permission.

The earlier receipt is preserved at archived commit
`c76fc59c778f5ad5839229ff46cf27a9e97b4823`:
[the immutable v1 integration/v1.1 authorization](https://github.com/mposition/Tomverse/blob/c76fc59c778f5ad5839229ff46cf27a9e97b4823/docs/ops/cross-review/packages/router-development-benchmark-v1-integration.authorization.md).
Its scope was read from that committed file, not inferred from a passed
exchange or a null preflight field. The original receipt and review records
are not copied, rewritten, reopened or used as this feature's verdict.

## Task binding and preparation status

This receipt belongs only to
[router-development-collector-v1-1](router-development-collector-v1-1.task.json),
a new feature task with no `supersedes`, base
`88dc1d6bfd6cbac983d6d0c2609b7eb37df08910` and exactly 13 review-scope paths.
The scope comprises the 11 implementation/documentation paths plus this
receipt and its task declaration. These two records are instructions and
authorization provenance, not implementation or test evidence.

This receipt records limited authorization at creation time; it does not
certify completion of integration, packaging or reviewer execution. The
actual integration evidence belongs in the separate integration records,
and the control program records the package, checks, reviewed commit,
full digest and reviewer result. No earlier digest or approval substitutes
for that task-specific evidence. This receipt is not a live status report.

The existing v1 source and original 11 task/review records remain protected.
The original record baseline is
`0e853fd9ecebb0808dacefc6816a0d1f25148783`. Their prior approvals name their
own snapshots and do not approve collector v1.1 or authorize paid collection.

## Conditions that remain in force

- Announce the independent review before it runs. Actual reviewer execution
  still requires successful checks and a separate explicit orchestrator go.
  The automatic-sequence instruction does not waive this checkpoint.
- Use the unchanged control program with author Codex and reviewer Claude.
  Its intended read-only invocation is
  `claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`,
  with the prompt on stdin and no model override. No author executor, shell,
  write tool or expanded MCP access is authorized.
- `--skip-preflight` is permitted only for this announced v1.1 review under
  the existing limited authorization. Record it as a skip, not as a passed
  preflight or evidence that a write attempt was refused. All original
  interactive-review null command/preflight/usage fields remain unchanged.
- `--review-despite-check-failures` is prohibited. Required tests, guards and
  CI remain mandatory. A failed check is investigated, fixed and reverified,
  not overridden or relabeled by this receipt.
- Remove `ANTHROPIC_API_KEY` case-insensitively from a copy of the review
  child's environment only, retaining the stored `claude.ai` login/config.
  Do not change parent or persistent environment, switch to `--bare`, or
  fall back to API-key billing. Before an authorized actual invocation,
  verify login through sanitized read-only authentication status; this
  receipt is not that observation and contains no credentials.
- Only the exact new output directory
  `docs/ops/cross-review/packages/router-development-collector-v1-1` may be
  excluded during packaging. `generatedPaths` is empty. Every one of the
  13 scoped paths remains visible in the reviewed diff; the original passed
  exchange and control program remain unchanged.
- At most two fix rounds are permitted under the existing control-program
  cap. This new feature task is not a mechanism to reset an exhausted review
  or reopen a passed exchange. Keep the eventual exchange
  `awaiting_review` until an actual verdict exists on its exact new digest.
- This permission is not an authenticated signature, human source-code
  inspection, sandbox-test result, reviewer verdict, model-quality result
  or production approval. Internal Codex reproductions and mock/offline test
  observations must remain distinct from actual Claude observations.
- No paid benchmark collection/provider call for benchmark answers,
  API-billing fallback, main merge,
  production deployment, production Router/pricing/registry/credit change,
  model-winner claim, quality-band promotion or adoption is authorized.
  A future paid collection needs its own numeric budget, selected rows,
  digest, expiry and accepted assumptions; review permission does not supply
  any of those.
- Source commit, normal integration, package creation, reviewer invocation,
  push and merge each retain their applicable verification and separate
  orchestrator go. Authoring these two records performs none of them.

## Round-0 storage relocation record

At `2026-09-10T03:36:31.4130639Z`, Codex completed the orchestrator-authorized
storage relocation of all 13 generated round-0/preparation files. The old
directory was
`H:/Project/tomverse-router-collector-v1-1-20260910/docs/ops/cross-review/packages/router-development-collector-v1-1`.
Its entire contents were copied to the active default-output location
`H:/Project/tomverse-router-collector-v1-1-20260910/artifacts/cross-review/router-development-collector-v1-1`,
already covered by the existing `/artifacts/` ignore rule. The original
directory was then recoverably moved, without deletion or overwrite, to
`C:/Users/Vyper/AppData/Local/Temp/router-collector-round0-preserved-20260910-aa101467e6e14ee7b42f00b145b1aed1/records`.
Every file's SHA-256 matched the pre-move bytes in both locations, including
the original package, verdict, events, preparation attempt and mutable-name
aliases (`change.diff`, `review-prompt.md`, `exchange.json`). The external copy
preserves those aliases before later rounds replace the active copies.

This is the same `router-development-collector-v1-1` exchange, not a new
exchange or a reset: base `88dc1d6bfd6cbac983d6d0c2609b7eb37df08910`, the 13
review-scope paths and `MAX_REVISIONS=2` remain unchanged. Round 0's raw
`approve` has three evidence findings; its control-program replay remains
`awaiting_revision` on
`sha256:55cb20818f04feabb2ea0af86cb641da5caed13d329ea34d424558ac2b5b3420`.
The relocation avoids the wrapper's whole-tree check treating its own
untracked documentation output as an out-of-scope source change. No controller,
ignore rule, source scope, verdict or prior package was changed to do so.

After the applicable verification and go, the next package must explicitly
use round 1 in the active location with **no `--diff-exclude` arguments**.
The earlier permission to exclude only the exact documentation output is not
expanded: the next exclusion list is empty, and all 13 source paths remain
visible. This note does not certify implementation tests, a new package or a
new review. Copying the completed evidence back to the documentation location
is reserved for after the control program derives `passed`; doing so does not
remove the existing whole-tree constraint on any future packaging.
