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
and parity gates. The owner subsequently approved adding the exact Google
`gemini-4-argon` identity to the product shortlist for dev UI validation. Both
shortlisted models still require explicit `RESEARCH_PREVIEW_MODEL_IDS` activation;
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

The original prepared functional comparison is Gemini 4 Argon at low thinking and GPT 6
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
| Gemini 4 Argon | 32,768 | HTTP 400 isolated to nested report maxItems and repaired; later live original-read investigation submitted a validated complete report |

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

### Owner-authorized recovery and completed Luna evaluation

The owner reported no provider logs for the original unknown call and explicitly
authorized retry, raising the cumulative generation-intent limit to eight while
retaining US$10. The old outcome remains unknown; a later similar failure does
not retrospectively establish its status or cost. All original journal data was
preserved. Each additional run used a matching new approval and a reduced USD
ceiling after retaining every earlier run's full maximum reservation.

An isolated local observer recorded response status, request/response IDs where
available, numeric usage and redacted provider error messages. It recorded no
request content, authentication headers or successful generated text. This
observer was checked offline before use. Browser log access was stopped by the
computer-use URL safety check, and no browser workaround or logging-setting
change was attempted.

| Run | Generation intents | Result |
| --- | --- | --- |
| Original Argon (`1c5a72503dd3...`) | 2 | First checkpoint known; second outcome unrecoverable |
| Argon retry (`66f893521ea0...`) | 2 | First response HTTP 200; second HTTP 400 `INVALID_ARGUMENT`, generic error message |
| Initial Luna (`cc0a3783012d...`) | 1 | HTTP 400: forced custom `web_search` was translated to missing native `web_search_preview` |
| Corrected Luna (`9c1a82df784d...`) | 3 | Three HTTP 200 responses and validated `partial` report; Rerank HTTP 200 |

The Luna fix keeps exactly one active first-step tool and uses required function
choice, avoiding the SDK's reserved native-search name mapping. The underlying
Brave adapter, source registry, dispatch ledger, output allowance, retries and
terminal validation are unchanged. A regression uses the actual OpenAI SDK and
asserts the wire request contains only the custom function. Another actual
Google SDK test verifies signed parallel calls survive JSON checkpoint restore.

The corrected run finished report submission in 12.823 seconds at 11:26:58 AEST
on 2026-11-15. It used 5,070 input and 733 output tokens, zero reported reasoning
tokens and 4,100 cache-write tokens. Two Brave searches and two page-read
attempts were recorded. Both pages returned `response_too_large`; the report
correctly disclosed that it had only snippets and did not answer the requested
Active/Maintenance LTS distinction. Successful full-page acquisition was not
demonstrated in this run.

Frozen-rate cost: Luna including search US$0.011769; Rerank 690 input tokens
US$0.000014; combined US$0.011783. All known-usage subtotals across the four
runs sum to US$0.045583. Unknown/refused calls with no supplied usage are not
assigned zero, and this subtotal is not a complete provider invoice. Retaining
all four maximum reservations gives US$9.924484, below the unchanged US$10 cap.
Total generation intents are exactly eight; no further generation was executed.
Known successful searches total seven; allowing all three remaining searches
and both page reads in the original unknown step still keeps the overall maxima
within ten searches and four page reads. Rerank ran once.

Manual review found four reachable official cited URLs and one date mismatch:
the report says Node 26 entered LTS on October 27, while its cited
[26.13.0 announcement](https://nodejs.org/en/blog/release/v26.13.0) is dated
October 28 and identifies that release as the transition. Original snippets
were not retained, so attribution to the model versus a stale search excerpt
is unresolved. Other checked release/codename/support-period claims were
supported by their current cited pages. The report remains unchanged and
`partial`; it was not edited into a correct complete answer.

Rerank returned three source-bound results with the official release overview
first. This one side experiment establishes API integration, not an improvement
in report quality. Four separate non-generation token-counting probes accepted
synthetic request variants; at that stage they did not prove generation-schema
acceptance or explain Argon's HTTP 400. No specific Gemini fix was claimed from
those probes. There is no live
Astra/Fable result and no cross-provider quality ranking.

### Argon repair: isolated maxItems failure and successful original read

The owner subsequently authorized at most seven additional generations and
US$1.50, with cumulative ceilings of 15 generations and US$11.50. The four
diagnostic calls and three-step original-page case used exactly seven calls.
Their conservative reservation is US$1.384872; retaining all earlier maximum
reservations gives US$11.309356, inside the new cumulative ceiling. No product
credits, runtime prices, provider budget settings or production configuration
were changed.

Controlled requests kept the model, prompt/history, tools and generation
settings identical and changed only report-array cardinality hints:

| Report schema variant | HTTP result |
| --- | --- |
| Original nested maxItems and minItems | 400 INVALID_ARGUMENT |
| Remove both array limits | 200 |
| Remove only maxItems, retaining minItems | 200 |
| Remove only minItems, retaining maxItems | 400 INVALID_ARGUMENT |

This isolates nested `maxItems` in this report tool as the request rejection
trigger, rather than output capacity, search evidence quality or provider
latency. Google documents schema-complexity constraints, and the upstream
[tool-schema issue](https://github.com/googleapis/python-genai/issues/2170)
reports the same opaque array-bound failure. No specific undocumented numeric
threshold is inferred for this report.

The fix removes only `maxItems` from `submit_research_report` on the exact
`gemini-4-argon` Research transport. Minimum array lengths, required fields,
enums, patterns and string limits are retained. Other tools and Google models
are unchanged. The original Zod schema still rejects oversized reports before
execution; the actual SDK regression sends seven findings and confirms a tool
error and no accepted report. Tool descriptions explicitly retain the report
count limits and the successful-page-only citation rule for model guidance.
The later description clarification was checked locally, not with another
paid generation.

A manifest-bound optional request-input ceiling now permits smaller development
probes without inventing a smaller provider context window. It can only reduce
the existing ceiling and reservation. The compact official-source case used
32,768 reserved input tokens per request and the unchanged aggregate 4,096
output cap. The preview remains network-free, and execution still requires the
exact manifest approval. Tests cover the smaller reservation and private page
content remaining absent from the journal.

The RFC Editor original-page case has manifest digest
`5dc39332d7c2449efe9288a949b3cd489aec82631d02d40c608c204ec7551a1b`.
From 11:57:50 to 11:58:20 AEST on 2026-11-15, it recorded:

- Three HTTP 200 model responses, 7,582 input tokens and 1,550 output tokens,
  with zero reported reasoning tokens and no fallback or hidden retry.
- Two successful Brave queries, followed by two bounded read attempts.
- Source R2, `https://www.rfc-editor.org/rfc/rfc1149.html`: `status=read`,
  `text/html`, 3,407 characters, `truncated=false`. This real page result was
  delivered to the following model generation.
- Source R3, `https://www.rfc-editor.org/rfc/rfc1149.txt`: unavailable with
  `unsupported_content`. This is not counted as a successful read.
- A separate no-model read-only smoke checked the R2 title and original text.
  Its content digest matched the investigation checkpoint exactly:
  `d0d110a83e0b5d6766211170f07f1cbda0ea61b1c895a2f0072049d0c74a7989`.
  It used the same production reader and retained the DNS/IP pinning, TLS,
  128 KiB body, 12,000-character, redirect and deadline guards.

The loop completed after three generations, but the terminal report was
`invalid_report`, with no accepted content or cited-source projection. This
does **not** demonstrate a successful final report. The HTTP 400 repair and
successful original-page delivery are established separately; the report
rejection remains a quality/validation follow-up. The rejected payload was
not retained, so this record does not assign a specific validation cause.
No fourth repair call or fabricated report was produced.

Known frozen-rate costs for this round: accepted diagnostic responses
US$0.026816 and the original-page case including search US$0.071328, subtotal
US$0.098144. HTTP refusals without usage are not assigned zero. The known-usage
subtotal through this repair round is US$0.143727, not a complete provider invoice.
The original unknown call remains unknown and all earlier journals are intact.

### Argon final-report submission verified

The owner authorized a further six generations and US$1.10 for at most two
RFC 1149 investigations, with cumulative ceilings of 21 generations and
US$12.50. The first investigation succeeded, so the second was not executed.
Manifest `54cd962ee702abaf68bd4879082ee7aa7e7b97d79a8540c3d125d3fa6defe181`
binds the unchanged strict server validation, explicit report cardinality and
page-citation instructions, and the smaller 32,768-token request input ceiling.

At 12:27:48–12:28:22 AEST on 2026-11-15, all three Google generation requests
returned HTTP 200. Two Brave searches preceded the page reads. The official
RFC 1149 HTML source R2 was read without truncation: 3,407 characters, with the
same content digest as the earlier reader proof. R3's plain-text read remained
unavailable with `unsupported_content`, and the model disclosed that failure.
The final tool call passed the original Zod schema and immutable source-binding
checks: `stopReason=report_submitted`, `outcome=complete`, nonempty server-rendered
content (6,188 characters), four findings and five cited sources. All ten
`page_text` statements cite successfully read prior-step evidence; unavailable
R3 is used only at `search_snippets` level.

The operator retained the public report tool input and curated source snapshot
outside the repository, without raw page bodies, hidden reasoning, credentials
or arbitrary provider errors. An offline replay of that exact input produced
identical serialized report content, citations and cited sources. A separate
reader-only check matched the original page digest, and manual reading supported
the report's identity, publication date, stated purpose and operational limits.
This is one successful case, not a provider quality ranking.

The old rejected report was not retained, so its precise historical validation
failure cannot be identified. The explicit report-limit/page-citation guidance
was present in the successful run; this result does not prove which instruction
caused the difference. Rejection diagnostics now distinguish schema locations,
unread page citations, unknown sources, missing citations and rendering limits.
SDK schema failures before tool execution are included. Only bounded codes and
allowlisted schema paths reach the evaluation journal; server acceptance rules
and paid-call limits are unchanged. Regression fixtures retain rejection of
oversized reports and unsupported page-text claims, rather than accepting them
to manufacture a successful result.

The successful run used 7,714 input and 1,478 output tokens, zero reported
reasoning tokens, two searches and 33.842 seconds. Frozen-rate known cost is
US$0.070416 including search. Cumulative generation intents are 18 of the
authorized 21; retaining all maximum reservations gives US$11.842260, below
US$12.50. The cumulative known-usage subtotal is US$0.214143, not an invoice
total; the original unknown request remains unknown. No second investigation
or additional paid judge was run.

## Verification

The checks use independent lockfile dependencies, mocked provider transports,
blocked external network for the Next build/browser fixture and a dedicated
local PostgreSQL 17 database outside the worktree. Database suites use the
existing integration runner's test-target checks and migration/drift setup.
The original implementation checks below are retained as such. Recovery reran
the 81 focused regressions, whole-repository TypeScript and scoped ESLint; the
unchanged UI and database suites were not rerun for the tool-choice correction.

| Check | Result |
| --- | --- |
| Research/search/page/evaluation focused tests | 120/120 passed |
| Post-attempt evaluator diagnostics and existing offline evaluation guards | 15/15 passed |
| Recovery Research/page/report/evaluation and Cohere focused regressions | 81/81 passed |
| Argon maximum-hint repair, lower input reservation, private-page journal and focused regressions | 84/84 passed |
| Final-report diagnostics, strict rejection, checkpoint and evaluator regressions | 52/52 passed |
| Exact accepted Argon tool input replay and original-page digest match | Passed, no model/search calls |
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

### Dev integration preparation

The owner then requested a PR, dev deployment and actual UI save/resume
verification. A new `codex/research-preview-to-develop` branch starts at current
develop `39e9696b1`, cherry-picking only the Research P0/P1 and Cohere commits.
The previous main-based implementation branch remains intact. Conflict
resolution preserves develop's source-continuation receipts, file-revision
drafts, Native workspace routes and newer SDK versions. Research excludes
continuation context at the new preparation boundary as well as at dispatch.
The exact Cohere SDK adds its two older protocol dependencies as nested lockfile
entries instead of downgrading the current provider packages.

For controlled work batches, `worker:research-preview -- --once
--max-steps-per-claim=1` saves a safe checkpoint after a completed generation.
The default remains three. Values outside 1–3 are rejected before queue work;
the option cannot raise the shared three-generation/output/search limits.
The database regression exercises actual service creation, one generation,
checkpoint read, the resume route and completion under the same reservation.

The owner selected Argon for the UI validation instead of Pro. Dev has no
existing Argon registry row. A read-only transaction on production inspected
only its exact Argon row; no production write was made. The dev plan copies
that profile's existing prices, credits and 32,768 output limit, with dev-only
low reasoning and app-managed search. Its frozen maximum reservation for one
three-generation case is US$4.440248; earlier full reservations plus this case
are US$16.282508, within the proposed cumulative US$16.50 ceiling. This is
preparation, not evidence of an executed UI case or a successful deployment.

The current integration review `r-20261115-030651-f58ad2` rejected two
settlement paths. An undispatched queued cancellation could fall back to the
full reservation. A 24-hour checkpoint could expire without terminalization,
allowing the generic reservation sweep to refund work whose provider cost was
already known. Both are fixed: no-dispatch cancellation stores explicit known
zero counters; checkpoint expiry preserves the saved usage and clears private
state. Generic reservation reconciliation resolves Research ownership and
usage under its existing settlement lock and locks the run row before changing
it. A valid active checkpoint cannot be refunded by that sweep. Terminal
accounting can read an expired hold; paid resume still requires an unexpired
hold. Three real-DB regressions verify zero cancellation and expiry through
both worker recovery and generic reconciliation. The durable suite passes
11/11; existing Perplexity/search settlement suites and 43 focused accounting
tests pass. Failed Brave attempts retain their backend request count, and
cancellation errors use the sibling routes' structured response mapping.

The review's Cohere default-off suggestion conflicts with the owner's explicit
default-on instruction recorded above; the exact hosted zero-price profile and
opt-out remain unchanged. One reviewer in the rejected job was unknown; this
is a changed-diff submission after fixing the other reviewer's major findings,
not a blind retry of an unchanged unknown review.
