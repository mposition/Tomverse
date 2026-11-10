# Smart Adaptive search batching and compact triage

Baseline: `02f3f0c195cbbee4396a8307cd7d913bce74ec85` (develop).
Local comparison: 2026-11-10, Windows, Node 22, 40 paired samples per variant.

## What was measured

The real application-managed search executor ran against a controlled transport.
Both variants requested the same four queries and received the same four sources.
The answer-model fixture waited 20 ms before each tool call, 20 ms before first
text, and 20 ms before completion; search delays were 10/12/14/16 ms. Actual timer
scheduling was measured with `performance.now()`. Variant order alternated.
Percentiles use nearest rank, like the product latency report.

**These are offline fixture timings, not production or live-model improvements.**
The first-text/completion endpoints belong to the fixture, not browser paint or
the full Chat request. No paid model/search call or production write was made.

| Controlled transport metric | Sequential | Batch |
| --- | ---: | ---: |
| Tool round trips | 4 | 1 |
| Backend requests / settled successes | 4 / 4 | 4 / 4 |
| Returned source coverage | 4 / 4 | 4 / 4 |
| First fixture text p50 | 234.53 ms | 80.15 ms |
| First fixture text p95 | 238.02 ms | 94.99 ms |
| Fixture completion p50 | 265.59 ms | 112.01 ms |
| Fixture completion p95 | 269.60 ms | 126.99 ms |

The search schema and description measure 402 `o200k_base` tokens, within the
existing 600-token definition allowance. Backend request, result, payload and
output-token ceilings are unchanged. The batching improvement applies when the
model has independent queries; dependent follow-up searches still take another
round trip, and model adoption of batching requires live observation.

## Combined routing payload

The benchmark captures actual before/after `generateText` request construction
without calling a provider. The fixture uses two eligible chat candidates and
one image candidate. Counts below cover system plus user prompt, excluding the
output schema and provider framing; larger catalogues will have different ratios.

| Synthetic case | Before tokens | After tokens | Reduction |
| --- | ---: | ---: | ---: |
| Ordinary text | 1,462 | 1,227 | 16.1% |
| Document creation | 1,466 | 1,229 | 16.2% |
| Image creation | 1,454 | 1,223 | 15.9% |
| Image follow-up | 1,462 | 1,368 | 6.4% |
| Photo editing | 1,468 | 1,339 | 8.8% |
| Photo analysis | 1,468 | 1,339 | 8.8% |

Ordinary chat may return `imageIntent: null`. No image model, quality preset,
empty prompt or edit field needs to be generated for that branch. Image requests
retain the existing object and validators. Follow-up and photo instructions are
kept when that context is available, and an exact shared message is sent once.
This reduces input/output work; it is **not a measured routing latency gain**.
The router model, reasoning effort, timeout and output ceiling are unchanged.

## Regression coverage and remaining evidence

Tests cover concurrent batch launch and ordered results, shared per-attempt
limits across simultaneous batches, duplicate reuse, partial failure and targeted
retry, malformed batches, cancellation, source notices and settlement counts.
Router tests cover exact request cost holds, budget refusal, unknown-usage holds,
nullable chat versus missing output, image edit/follow-up admission, retained
image context, file precedence, fallback and existing image eligibility gates.

Local checks passed: production build (including TypeScript), changed-file ESLint,
API cache-control, protected-table writer and strict encoding checks. The focused
12-file regression run passed 266 tests with zero failures and one pre-existing
ART-FORMAT-01 TODO. After adding cancellation coverage, the search tool suite
passed all 27 tests.

These tests preserve deterministic contracts. They cannot establish unchanged
LLM answer quality or production p50/p95. After an authorized deployment, compare
equal model/mode cohorts and include failed/fallback requests. Check source
coverage, image/file routing accuracy, first content, full completion, and the
new content-free `toolCallIndex`/`batchSize`/`reused` search log fields. Distinguish
combined `+image-intent-v2` decisions from v1/standalone decisions. Small samples
or different model mixes remain inconclusive.

Reproduction and prerequisites: [response latency runbook](response-latency.md#reproducible-local-comparison).
