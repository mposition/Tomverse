# Continuation context fidelity — local implementation evidence

Date: 2026-11-14 (Australia/Brisbane). Base: `80a95b53ea9fe99f3ef1466fd142cfb0679dddcf`.
Fresh implementation worktree and lockfile installation; no dependency junction was used.

## Implemented behavior

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
  is outside this patch.

## Validation

All commands run locally, without production credentials or live model evaluation.

| Check | Result |
| --- | --- |
| Core seed/passages, existing 8-language probes, retrieval regressions, fidelity and stream tests | 83 passed |
| Auto limited-release regression script | 141 passed |
| Continuation/system-block contracts | 125 passed |
| Router sampling/hold + real source loader + Chat fallback orchestration | 140 passed; 2 additional receipt failure cases passed |
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

`CHAT_CONTINUATION_AUTO_SOURCE_ENABLED` remains absent/off. Activation needs explicit
owner approval for the bounded excerpt reaching the existing configured Router provider
with sampling/optimizer exclusion, followed by separately authorized deployment/config
changes. This local patch does not activate that scope or increase the paid-call allowance.
Source-aware location fusion, Deep Research, automatic full-history retrieval, durable pin,
automatic Memory storage and native selection/receipt parity remain outside the patch.

No PR, push, CI admission/re-run, merge, deployment or operational flag change was performed.
Independent boundary review is requested against the finished committed diff; its result
is reported separately from these local checks.
