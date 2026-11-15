# Research Preview P1 local verification

Date: 2026-11-15. This follows the P0 implementation and verification record.
The isolated implementation branch starts at P0 `e5a79a44f` and incorporates
the fetched main `6ca4eccdf011a9c3e13e727caf6a85a1a677a3b5`.

## Implemented behavior

- Original-page reading accepts only source IDs already returned by this run.
  It reads at most two HTTPS HTML/plain-text responses, with a 128 KiB body
  limit, 12,000 characters per page, a ten-second deadline through body
  consumption, validated/pinned public DNS addresses and two redirects.
  Page text is untrusted evidence. A report can claim page support only after
  a later generation has received it. Truncation remains visible.
- Durable runs retain the existing aggregate Chat reservation and attempt
  ledger. A generation intent and dispatch claim precede the provider call;
  completed usage, tool evidence and the next checkpoint commit together.
  A safe checkpoint can resume within 24 hours. An unknown dispatched outcome
  is quarantined and cannot be replayed. Preparing-run crash windows are
  recovered without dispatching a model or creating another hold.
- A worker claim permits up to ten minutes of active execution. The shared
  caps remain three generations, five Brave attempts and 4,096 output tokens
  including reasoning. Provider retries and fallback remain disabled.
  Google SDK internal continuation requests cannot bypass these boundaries.
- Fresh web Chat and Native expose explicit one-shot Research start, server
  counters/status, cancel, safe resume and read-only reload discovery. A
  pending report with empty content displays its saved-run card. Unknown
  create results are read back, never automatically reposted.
- Raw page text lives only in the private active checkpoint. Terminal states
  clear it. Public message metadata and account exports contain curated
  cited-source fields, and account/conversation deletion cascades run data.

Research feature switches remain opt-in: `RESEARCH_PREVIEW_ENABLED`,
`RESEARCH_PREVIEW_PAGE_READING_ENABLED`, `RESEARCH_PREVIEW_DURABLE_ENABLED`
and `RESEARCH_PREVIEW_NATIVE_ENABLED`. Native also retains its existing bearer
and parity gates. The current product admission shortlist remains the P0 list;
development evaluation clones do not alter runtime model settings or prices.

## Cohere Chat connection

The owner explicitly requested Command A+ Chat integration and then changed its
default to on. `COHERE_CHAT_ENABLED=false` is the opt-out. The connection accepts
only `command-a-plus-05-2026` at the compiled public `api.cohere.com/v2` endpoint
with `COHERE_API_KEY`; text-only input and disabled thinking keep the initial
scope small. Native Cohere SDK `4.0.75` matches the installed AI SDK provider
protocol, with a compile-time assignability regression test.

The exact hosted model has a verified zero token price while within Cohere's
published rate limits. This does not price Model Vault or another model or host.
Existing user credits, rate limits, provider budgets and search charges still
apply. Research report phases request `strict_tools`; server report validation
and source binding remain authoritative. Ordinary Chat tool behavior is kept.

Source: https://docs.cohere.com/docs/command-a-plus

## Development evaluation

`npm run research:preview:evaluate` produces a preview without loading provider
clients or making requests. Execution separately requires a matching approval,
`--live`, development credentials and a valid unexpired manifest. The fixed
single-use journal commits intent before dispatch and prevents automatic retry
after a crash or unknown outcome. Production processes are refused.

The selected comparison is Gemini 4 Argon at low thinking and GPT 6 Luna at low
thinking on one identical public brief. It allows six model calls, ten Brave
attempts, four page reads and one optional Rerank 5 Fast side experiment over
captured public snippets. The conservative reservation is US$4.701131 including
rerank, beneath the US$10 ceiling. Argon uses the standard US$4/US$20 rate in
this development manifest, without relying on temporary introductory pricing.
Command A+ and the original Pro baseline are closed optional evaluation arms.

No live evaluation has been executed yet. Read-only configuration discovery
located Google/OpenAI/Brave credentials in the application's dev environment.
The owner identified the production Cohere key and authorized using that key
alone for the local bounded evaluation. Credential values are not copied into
this worktree or printed, and no production configuration or database is used.
Mock checks establish execution/provenance behavior, not semantic claim support
or a real latency/cost comparison. Page selection by rerank is a side experiment;
it does not rewrite a report or add a model judge.

This is a functional preview evaluation, not evidence that one provider's
model is generally better. The owner supplied operating model output limits:
Astra and Fable 5.2 at 128,000, Argon at 32,768. The product's shared 4,096-token
run cap is independent of those model limits. There is no measured basis for
excluding Astra or Fable on output-limit or completion-quality grounds; those
earlier selection claims were withdrawn. Quality/total-cost ranking requires
an explicitly pinned, comparable evaluation of those candidates.

## Verification

The checks use independent lockfile dependencies, mocked provider transports,
blocked external network for the Next build/browser fixture and a dedicated
local PostgreSQL 17 database outside the worktree. Database suites use the
existing integration runner's test-target checks and migration/drift setup.

| Check | Result |
| --- | --- |
| Research/search/page/evaluation focused tests | 120/120 passed |
| Cohere adapter, protocol types and existing provider regressions | 71/71 passed |
| Offer and Native authentication boundary tests | 36/36 passed |
| Native transport regressions | 15/15 passed |
| Native browser, standalone typecheck and production build | 11/11 and both checks passed |
| Web browser: Research P0/P1, Auto, Perplexity and composer contracts | 24/24 passed |
| Dedicated DB: persistence, real Chat route, durable worker/store and legacy Perplexity | 36/36 passed |
| DB setup | 413 migrations, no pending migration, no drift |
| Whole-repository TypeScript, Next production build and ESLint | Passed |
| Pricing, accent tokens, enum constraints and data-domain registry | Passed |
| Code/DB model registry | 46 rows, Command A+ credit/token settings agree |
| Worker CLI with durable feature disabled | Expected exit 1 at the feature guard |
| Whitespace check | Passed |

The checks caught and fixed the API's `{run}` envelope mismatch, an empty-body
placeholder hiding the saved-run card, an incompatible Cohere provider protocol
version and the worker CLI's CommonJS top-level-await failure. The final browser
run uses the fixed build and a dedicated server port without reusing another
session's server.

Independent review is requested for the finished changed financial, migration
and credential boundaries. Its outcome is recorded separately from local checks.

## Git and release state

Implementation, verification, independent review and release are separate.
No push, PR, CI start/retry, AMUX mutation, production migration, merge or
deployment is part of this local implementation. The original dirty workspace
and P0 worktree are preserved.
