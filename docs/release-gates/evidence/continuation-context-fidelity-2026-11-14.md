# Continuation context fidelity — local implementation evidence

Date: 2026-11-14 (Australia/Brisbane). Base: `80a95b53ea9fe99f3ef1466fd142cfb0679dddcf`.
Fresh implementation worktree and lockfile installation; no dependency junction was used.

## Initial core implementation

- CF-01–05: unchanged automatic `ext-seed-v2` tail behavior; selected passages and recent
  source compose into `ext-seed-v3-selected-recent`. The server reads coordinates from its
  authorized source, merges ordinal/UTF-16 ranges, preserves source order and enforces the
  existing 3,000 body-token / 4,000 code-point limits including omission markers. Invalid,
  blank or stale selections remain empty. Selection stays in memory for the next text turn.
- CF-06–09: existing Router request accepts the same bounded `importedSource` as user data
  before its exact-request hold. Source-aware rewrite, presearch and decision sampling are
  disabled; usage settlement remains. Source access is checked across the Router hold and
  before final dispatch. Revocation discards source and routing output, refunds unused
  admission, and re-enters the existing model/capability/token/price/admission path without
  another Router call. A replan consumes the second build, so it cannot open a third build.
- CF-10–14: content-free headers/trailer receipts use the actual request/attempt plan.
  `not_sent`, `unknown` and confirmed input inclusion are distinct. Selected/recent counts
  may overlap; the unique-message count does not double count them. The web UI no longer
  substitutes bridge-creation counts. Trace/response/attempt guards and existing runtime
  identity ownership isolate late events. Serializers exclude receipts from subsequent
  provider input and browser persistence. Deep Research remains without source context.
- CF-15–17: 24 independent Korean/English fixtures across hiring, travel, software,
  procurement, events, operations, education, design, budgeting, publishing, logistics and
  support. Per-field evidence coverage and visible/full-source answer correctness are
  separate. A new small prompt candidate exists only in the evaluation runner.
- CF-18–20: no schema, source-copy store, Memory write, export/share expansion, provider
  role promotion, new model call or spending ceiling. Review-to-Chat draft/handoff code was
  not changed. Native transcript viewing remains supported; native selection/receipt parity
  was outside the initial core; the follow-up section below adds that parity.

## Validation

All commands run locally, without production credentials or live model evaluation.

| Check | Result |
| --- | --- |
| Core seed/passages, existing 8-language probes, retrieval regressions, fidelity and stream tests | 83 passed |
| Auto limited-release regression script | 141 passed |
| Continuation/system-block contracts | 125 passed |
| Router sampling/hold + real source loader + Chat fallback orchestration | 142 passed; prepared-source cache gate regression: 4 passed |
| Selected-passage once-only + actual receipt E2E | Desktop Chromium and mobile Chromium: 2 passed |
| Changed-file ESLint | Passed |
| `npm run typecheck` | Passed with a 12 GiB Node heap |
| `npm run build` | Passed with a 12 GiB Node heap; existing dynamic-filesystem tracing warnings remain |
| `report:continuation-seed -- --json` | Executed, no provider calls |
| `report:continuation-fidelity` | 72/72 declared final-input plans matched |

Default-heap typecheck/build initially exhausted memory. Increasing the local Node heap
resolved that environment limit. The install reported Node 22.22.2 below the optional
`officeparser` engine range; no dependency or lockfile was changed to suppress it.

## Proven input coverage, not answer quality

Each arm has 24 cases / 48 evidence fields. Counts refer to final rendered synthetic
inputs, not model answers, production accuracy, or account-memory performance.

| Arm | Present fields | Partial fields | Absent fields | Cases with all fields present |
| --- | ---: | ---: | ---: | ---: |
| Automatic recent window | 40 | 2 | 6 | 18 |
| Previous selected-only behavior | 16 | 8 | 24 | 4 |
| Selected + recent | 46 | 0 | 2 | 22 |

The two remaining absent fields deliberately have no shipping-date evidence anywhere in
the source. Missing unselected history outside the recent scan window is still not searched.
Field-level partial coverage does not turn every answer field into UNKNOWN.

Model calls: **0**. Answer correctness, condition/negation/target/recency accuracy and the
new prompt candidate: **not evaluated**. No Cohere, production model, `--live` evaluation,
model download or new inference service was used. Mock assertions prove transport and
orchestration behavior, not improved answer quality. PostgreSQL integration tests were
not executed; source access/ownership/flag behavior was exercised with the real loader
under mocked DB/lock boundaries, and existing contract tests remain separate evidence.

## Activation and remaining scope

The subsequent owner instruction on 2026-11-14 approved default-on Auto source input.
Missing `CHAT_CONTINUATION_AUTO_SOURCE_ENABLED` now enables the bounded excerpt for the
existing configured Router, excluding sampling and optimizer replay. Explicit `false` or
invalid configuration disables that Auto input. The continuation flag and live source
access gates remain independent. No operational setting, merge, deployment or paid-call
allowance has been changed.
At the initial implementation snapshot, source-aware location fusion, Deep Research,
automatic full-history retrieval, durable pin, automatic Memory storage and native
selection/receipt parity were outside the patch. The clarified owner follow-up below
adds the retrieval implementation and native parity; the other exclusions remain.

At the original local-only snapshot no PR or push had been performed. The subsequent owner
instruction authorizes a `ci:hold` PR. CI admission/re-run, merge, deployment and operational
flag changes remain outside this work.
Independent boundary review `r-20261114-113206-da3a43` accepted commit `6069729e0`:
Claude and Antigravity both returned `accept`, with no blocking/major findings. Follow-up
fixes reuse the accepted unchanged authority/cost boundary: record the final seed outcome
once at dispatch, revalidate current access while reusing the request-local immutable source
plan instead of rescanning messages, and remove a stray BOM. The cache regression proves
that locking/deletion/flag-off still reject prepared text before reuse.

Non-blocking review observations retained: continuation presearch optimization is suppressed
while ordinary current-query search tools remain available; the preparation card deliberately
shows a mode without inferring current coverage from bridge counts; zero-token unused usage
is settled with the existing `failed` enum while dispatch instrumentation records
`not_dispatched`. The omission note covers the whole source, including unscanned history.

A completion-time fetch observed `origin/main` at `0155ee7099ce389315403c7709cfaa708ce1ab31`.
The relevant continuation/Router/Chat transport files had no upstream changes. An object-only
`git merge-tree` simulation was conflict-free. This local branch retains the documented
implementation base; no upstream branch or another session's worktree was changed.


## Owner-approved default-on follow-up

The owner explicitly requested the new Auto source input to default on before PR creation
on 2026-11-14. Missing `CHAT_CONTINUATION_AUTO_SOURCE_ENABLED` now enables that input;
explicit `false` and invalid values opt out. The independent continuation flag and current
source ownership/deletion/unlock gates remain mandatory. The switch applies to Auto only;
manual answering source remains independent. No model, call count or spending ceiling is
added. Source-aware rewrite/presearch/sampling restrictions and final-access fallback stay.
Default semantics: 41 focused core cases and 144 mocked server contract cases passed.
This source change does not itself merge, deploy or change an operational setting.
The requested next development scope is full-history automatic source retrieval and native
selection/receipt parity; summary/capsule, Research, Memory storage and durable pin are not
included in that clarified scope.


## Full-history and native follow-up verification

Implemented after draft PR #3925 was created with `ci:hold`, on a fresh develop-based
worktree with its own lockfile installation. The original main-based worktree and the
owner's dirty `ai-chat-hub` worktree remain untouched.

- Native: source coordinates from actual DTO ordinals, loaded older-page selection,
  next-text-turn consumption, shared runtime delivery receipt, trace/answer/attempt guards,
  explicit invalid/empty coordinates, retry/abort/late-event handling. Selection and
  receipts are excluded from persisted messages and subsequent prompts. Existing bearer,
  origin, source lock and continuation flag gates still apply. Only the coordinate request
  header and content-free receipt response header were added to existing native CORS.
- History: existing Auto Router read-only tool, at most three model-authored literal
  queries against all ordinals of the owned snapshot, at most nine database matches and
  three 500 UTF-16-unit source excerpts. One `ext-seed-v4-retrieved` final plan shares the
  original 3,000 body-token / 4,000 code-point limits; manual ranges keep priority and
  the v2 recent tail remains. Final Router messages replace the preview/tool transcript
  with the same final source sent to the answer provider. No summary store or embedding
  index was added. Literal retrieval may miss paraphrases or other-language wording.
- The tool uses at most two model steps, reserves both inputs/outputs and the actual tool
  schema in the existing provider hold, and settles cumulative `totalUsage`. Concurrent
  tool calls cannot race into a second source read. Current access is rechecked before
  and after reads, before the final Router step and before answering. Revocation drops
  source and source-aware routing without an additional paid reroute.

Executed locally in the PR worktree:

| Check | Result |
| --- | --- |
| `npm run test:continuation-fidelity` | 47 pure/input tests + 157 mocked server cases passed |
| Additional actual-SDK history tool tests, after the parallel-call guard | 6 passed |
| Continuation contracts, native CORS/proxy/transport, Auto core/UI/product and concurrency regression | 244 passed |
| Native Chromium continuation + composer submit/tools | 22 passed |
| Native desktop WebKit continuation | 4 passed |
| Root TypeScript and changed-file ESLint | passed |
| Native TypeScript + Vite build | passed |

The actual-SDK suite uses `MockLanguageModelV4`, not a paid model. Korean/English buried
history fixtures prove that retrieved source and the latest correction survive the final
input. The existing 24 independent bilingual quality fixtures retain separate declared
present/absent/partial input checks and answer-quality expectations. Real-model answer
quality runs remain zero. No Cohere, production model, `--live`, PostgreSQL integration,
native binary signing or physical-device acceptance was executed.

`CHAT_CONTINUATION_AUTO_SOURCE_ENABLED` stays default-on as explicitly requested.
`CHAT_CONTINUATION_HISTORY_SEARCH_ENABLED` was initially default-off. A subsequent explicit
owner request on 2026-11-14 approves default-on bounded history search and its maximum
second Router step under the existing provider budget and continuation gates. Missing or
`true` enables it; explicit `false` and invalid configuration disable it.
No operational flags were changed. Native selection/receipt needs no new provider call.
CI hold, merge/deploy and operational settings remain unchanged.


Independent follow-up review `r-20261114-123705-c992d5` accepted `b36089cf4` with both
Claude and Antigravity; no blocker/major findings. The accepted unchanged authority and
cost boundary is reused for the following local correctness fixes: preserve the newest v2
turn before history allocation, escape LIKE percent/underscore/backslash, avoid treating
old visible text as retry delivery, and suppress the redundant zero-history-count label.
Post-review core/native transport/real-loader/actual-SDK and upstream Review-to-Chat unit
regressions: 95 passed, including a large Korean budget case and stale retry trailer.

The completion fetch found `origin/main` at `5b5a83998` (Hono security override) and
`origin/develop` at `acd9c263f` (including Review-to-Chat #3919). Develop was merged without
conflict, its handoff implementation preserved byte-for-byte, and `npm ci` rerun against
its updated lockfile. Installed `@hono/node-server` resolves to 2.1.8. Existing officeparser
engine warnings remain on local Node 22.22.2; office-file parsing is outside these checks.
Integrated root TypeScript, changed-file ESLint and native TypeScript/Vite build pass.

Final integrated Next.js production build passed (Next 16.4.5; TypeScript 3.3 minutes),
with existing dynamic-filesystem tracing warnings. The first web E2E attempt correctly
refused to start before a production build existed; after building in this worktree,
web receipt tests passed on desktop and mobile Chromium (2/2). Existing Review-to-Chat
balanced-result and Quick Summary handoff E2E cases also passed (2/2), without modifying
that feature. No live database was contacted: tests used mocks and the disabled database
configuration with loopback port 1. The 24-case input report remains 72/72 with zero model
calls and answer quality explicitly `not_evaluated`.


## Owner-approved history default-on follow-up

The owner explicitly requested full-history automatic retrieval to default on on
2026-11-14. Missing `CHAT_CONTINUATION_HISTORY_SEARCH_ENABLED` now enables it; `true`
also enables it, while explicit `false` and invalid configuration opt out. The same
semantics govern tool registration, intermediate source revalidation and the read adapter.
Both the default and explicit opt-in paths exercise current-access revocation; explicit
opt-out retains the existing selected-plus-recent source without a history tool.

This authorizes the existing bounded maximum second Router step under the existing
provider hold and budget; it does not change a provider, ceiling, credit price, source
ownership/lock/continuation gate, persistence rule or final-model admission contract.
This coding session still runs no live/production model evaluation and changes no
operational setting, merge or deployment. CI remains held with `ci:hold`.
