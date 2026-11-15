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

The prepared functional comparison is Gemini 4 Argon at low thinking and GPT 6
Luna at low thinking on one identical public brief. It allows six model calls, ten Brave
attempts, four page reads and one optional Rerank 5 Fast side experiment over
captured public snippets. The conservative reservation is US$4.701131 including
rerank, beneath the US$10 ceiling. Argon uses the standard US$4/US$20 rate in
this development manifest, without relying on temporary introductory pricing.
Command A+ and the original Pro baseline are closed optional evaluation arms.

The live attempt and its interruption are recorded below. Read-only configuration
discovery located Google/OpenAI/Brave credentials in the application's dev environment.
The owner identified the production Cohere key and authorized using that key
alone for the local bounded evaluation. Credential values are not copied into
this worktree or printed, and no production configuration or database is used.
Mock checks establish execution/provenance behavior, not semantic claim support
or a real latency/cost comparison. Page selection by rerank is a side experiment;
it does not rewrite a report or add a model judge.

This is a functional preview evaluation, not evidence that one provider's
model is generally better. The owner supplied the following operating DB
output limits; this session did not query the production DB to verify them:

| Candidate | Owner-supplied configured output limit | Evaluation status |
| --- | --- | --- |
| GPT Astra | 128,000 | Candidate; exact operating API ID, pricing and reasoning configuration not yet captured |
| Claude Fable 5.2 | 128,000 | Candidate; exact operating API ID, pricing and reasoning configuration not yet captured |
| Gemini 4 Argon | 32,768 | First generation completed; second dispatched outcome unknown; no final report |

The product's shared 4,096-token run cap is independent of those model limits.
There is no measured basis for excluding Astra or Fable on output-limit,
reasoning-token consumption or completion-quality grounds; those earlier
selection claims were withdrawn. Published token rates alone do not establish
cost per successful investigation. The current CLI does not yet support the
operating Astra/Fable 5.2 profiles; their IDs must not be guessed from older
compiled catalogue entries.

A comparable follow-up should pin each actual API model, pricing snapshot,
reasoning setting and the same question and application limits, then record
observed terminal outcome, citation support, latency, actual token usage and
cost. Full-pipeline runs can discover different evidence even with the same
question; they must not be described as an identical-evidence comparison.
One brief per model is a smoke evaluation and cannot establish a general
completion rate or quality ranking. A 4,096-token product-cap experiment also
does not measure the models' long-output capability. Adding all candidates
must not silently increase the approved six-generation execution scope.

### Live attempt: incomplete, no model comparison

After the owner-authorized review retry returned aggregate `accept`, the local
operator helper executed the exact approved manifest digest
`1c5a72503dd3f4b62d233e7fe13956a1b85be203e6273163d49e9f68b920eed5`.
The append-only single-use journal recorded:

| UTC time on 2026-11-15 | Event |
| --- | --- |
| 00:57:26.689 | Argon generation 1 dispatch intent |
| 00:57:33.247 | Completed generation 1 checkpoint: 820 input tokens, 45 output tokens, two successful Brave searches, zero completed page reads |
| 00:57:33.279 | Argon generation 2 dispatch intent |
| 00:57:33.811 | Attention: dispatched outcome/usage may be unknown; execution stopped |

No final report was produced. Luna and Rerank were not started, and no automatic
retry or replacement manifest was executed. The checkpoint's known usage is
US$0.014180 at the manifest's frozen model/search rates: US$0.004180 model plus
US$0.010000 search. This is a known-usage subtotal at those rates, not a complete
provider invoice or a claim that the second intent cost zero. Its outcome and
usage remain unknown. The original conservative total reservation was
US$4.701131; the Argon arm reserved US$4.440020.

The original error was intentionally reduced to a generic stop message and was
not retained, so this record cannot identify the cause retrospectively. A local
follow-up now journals only an allowlisted error type, a bounded numeric HTTP
status from the error/cause chain and two fixed internal provider refusal codes.
It never records arbitrary messages, headers, keys or request/response bodies.
The original journal is unchanged and remains single-use. The follow-up was
verified offline; it has not been exercised with a new paid call.

Neither this incomplete attempt nor the mock tests support a provider quality,
completion-rate, reasoning-efficiency or successful-investigation-cost ranking.

## Verification

The checks use independent lockfile dependencies, mocked provider transports,
blocked external network for the Next build/browser fixture and a dedicated
local PostgreSQL 17 database outside the worktree. Database suites use the
existing integration runner's test-target checks and migration/drift setup.

| Check | Result |
| --- | --- |
| Research/search/page/evaluation focused tests | 120/120 passed |
| Post-attempt evaluator diagnostics and existing offline evaluation guards | 15/15 passed |
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
| Worker CLI with `--once` and an empty dedicated test DB | Exit 0; no provider credentials or model dispatch |
| Whitespace check | Passed |

The checks caught and fixed the API's `{run}` envelope mismatch, an empty-body
placeholder hiding the saved-run card, an incompatible Cohere provider protocol
version and the worker CLI's CommonJS top-level-await failure. The final browser
run uses the fixed build and a dedicated server port without reusing another
session's server.
The final empty-queue CLI smoke also verified that the unchanged real worker
command terminates with exit 0.

Independent review job `r-20261115-003827-22b1dd` covered implementation commit
`6d57b5e796fbe18012e93545241d5770256e9e59`. One reviewer returned a parsed
`accept`; the other wrote an approving review but omitted the required verdict
block. The orchestrator therefore returned `unknown` / `no_verdict_block`,
which is not a completed aggregate approval. No blocker/major finding was
reported. Non-blocking observations cover cancel-route error mapping, Native
list-read error visibility, the resume-route lock-code comparison and the
Google fetch guard's JSON-only assumption.

The owner explicitly authorized one retry. Job `r-20261115-005304-c7fb03` reviewed
head `21c862aa5ffaba6cd8cc41ae057847429eef16df` with the same implementation
boundaries and returned `accept` from both Google and Moonshot reviewers.
The accepted boundary review is reused for the later bounded diagnostic-only
change; no live authority, model allowlist, credential boundary or spending
ceiling was expanded. Review approval, local verification and real model quality
remain separate outcomes.

## Git and release state

Implementation, verification, independent review and release are separate.
No push, PR, CI start/retry, AMUX mutation, production migration, merge or
deployment is part of this local implementation. The original dirty workspace
and P0 worktree are preserved.
