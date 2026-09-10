# Router Replay v1: bounded review follow-up

## Authorization and scope

- Recorded at: `2026-09-10T12:43:56.3363218Z` (recording time, not the user message's send time).
- Recorded by: `codex`.
- Approved by: `mposition`.
- Exact user reply: "네 후속으로 처리해주세요".
- Preceding question: retain the terminated review record and separately address
  the README dependency-installation note and accept the LF checkout limitation.

This records that bounded authorization, not a new model verdict, a reopened
exchange, an automatic pass, or new permission to promote a routing policy,
merge, deploy, or make further paid benchmark calls. Any separately authorized
publication of the working branch is outside this disposition. The two tracked changes are
the [README](README.md) clarification and this follow-up record. Runtime source,
tests, lockfile, controller, guards, original observations, and review records
are unchanged by this follow-up.

## Preserved review identity

- Reviewed source commit: `1fc988bd81868dce4d4e7912112508001ff3d939`.
- Task and round: `router-replay-v1`, round `2`.
- Reviewed diff digest: `sha256:6fd19dbf9268ec31e935b41ba8b4256ac514419a2dedcb7cc2eb037ed91ed665`.
- Actual Claude conclusion: `approve`, with two `nit` findings whose basis is
  `judgement`. The reviewer described both as optional; the controller still
  retained both as `unresolved_on_hold` after the revision limit.
- Terminal controller state: `on_hold`, reason `revisions_exhausted`.

The source exchange and its byte-preserved archive are not edited or reopened.
The archive is local at
`H:/Project/router-replay-v1-evidence-20260910/final-on-hold-1fc988bd`.
Its manifest's 27 listed files were checked against their recorded size and
SHA-256 before writing this follow-up; all matched. Relevant pinned files are:

| Archive file | SHA-256 |
| --- | --- |
| `archive-manifest.json` | `7b417ec09e72b61385a8f7219be3a027e760365168f85d45e86655523b4ff9d9` |
| `exchange.json` | `21e3534aa49ca4c3f897a6e63bdf6398a9243c302f6d9c08270a166191773ae4` |
| `verdict-round2.json` | `81a0305ad857f49c4ff0f6fb9caf30085c99dd86b4aa4e4a9e1a5382ff86f2bf` |
| `review-round2.events.jsonl` | `148f7ff4ac251bf93a649b0339b40af085ed1a64602734aa902962f0667b1246` |
| `change-round2.diff` | `6fd19dbf9268ec31e935b41ba8b4256ac514419a2dedcb7cc2eb037ed91ed665` |
| `checks-round2.tests.tap.log` | `be7acb29e478f3e28825fd42f820950f65000691ffb81ab38fcce4ebc8300647` |

These hashes identify the historical review, not a Claude review of this later
documentation. The archived TAP records **375 passed, 0 failed**, on the reviewed
source commit. That is a historical result, not a newly executed 375-test suite
for this follow-up.

## Disposition outside the terminated exchange

1. **Dependency-installation wording: addressed in documentation.** The README
   now names `npm ci`, not `npm install`, in a new disposable byte-preserving
   checkout with Node 22, npm, and the committed package manifests present. It
   distinguishes potentially networked installation and install scripts from
   offline Replay execution, warns that existing `node_modules` is replaced,
   and forbids using the working checkout's shared dependency junction for this
   setup. This follows the reviewer's proposed command and the
   [official npm ci contract](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-ci.md):
   an existing lockfile is required, mismatch fails, and npm does not write
   package manifests or lockfiles. No dependency installation was performed.

2. **LF/raw-byte checkout limitation: accepted by the user, unchanged in code.**
   For this LF observation, a checkout that changes Git blob line endings is
   refused even when Git status is clean. The documented separate worktree is
   the recovery path; source normalization, historical hash regeneration, and
   disabling source checks are not accepted alternatives. The existing
   `package.json` semantic compatibility exception remains exactly as reviewed;
   no other source, corpus, or lockfile gains an exception.

Neither disposition overwrites the historical findings or changes the
controller's terminal result. No new Claude review is required for this exact
reviewer-proposed command clarification plus the user's explicit acceptance of
the unchanged limitation. Any functional change would require a new,
announced Claude independent review under its own review record.

## Evidence and execution limits remain unchanged

The saved comparison has only **4 common observed cases out of 24**, with the
four observed choices correct on both sides. There is no established quality
lift, full-corpus outcome delta, whole-catalogue optimum, or production-quality
approval. The remaining observations are not invented or counted as losses.

This follow-up made no additional provider or Claude calls, installed no
dependencies, and changed no production Router, model catalogue, pricing,
settings, flags, CI, or controller behavior. It neither redraws the corpus nor
regenerates answers, scores, manifests, or review artifacts.
