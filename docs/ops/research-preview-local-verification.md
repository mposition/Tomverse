# Research Preview P0 local verification

Date: 2026-11-15 (Australia/Brisbane). Base: `c8cb7c62e192814b8522786a8749d38769073661`.

This is a local implementation record, not permission to activate a provider,
run a paid evaluation, change pricing or budgets, merge, or deploy.

## Implemented scope

- A request-scoped Research Preview inside a saved, signed-in Chat. The stored
  conversation must use manual selection and exactly one eligible model. Existing
  ownership, unlock, operational access and profile tool restrictions apply.
- Default off. Both `RESEARCH_PREVIEW_ENABLED` and a model ID in
  `RESEARCH_PREVIEW_MODEL_IDS` are required; configuration cannot expand the code
  shortlist. The initial API pin is the existing `gemini-3-1-pro` catalogue entry
  (`google`, `gemini-3.1-pro-preview`). This pin has offline adapter coverage, not
  live quality or cost approval. Pro/Max admission also checks the actual model's
  existing minimum plan.
- Only the current, self-contained public question is sent. History, Memory,
  profile text/knowledge, continuation imports, files, location, Refiner and
  connectors are excluded. Draft files and overlong questions are retained with
  an explanation. The current model selection and product identity are preserved.
- At most three generation steps and five shared Brave backend attempts. Search
  only, then search/report, then report only. No repair generation, retry or
  automatic fallback. The output allowance is the smaller of the existing model
  cap and 4,096 tokens across all steps, including reasoning. The run aborts at
  120 seconds; the existing search deadline also covers response-body consumption.
- The provider hold covers repeated input, tool schemas, bounded cumulative
  evidence and previous output. Known output usage reduces the next request's
  allowance. Unknown usage stops subsequent dispatch. Existing LLM and
  `search-provider:brave` buckets, model credits and search surcharge remain.
- Strict terminal reports bind only to evidence available before that generation.
  The run registry covers 25 results; at most 15 cited sources are persisted with
  continuous display numbers. Model-supplied links cannot bypass the server's
  citation mapping. Only the server-rendered report reaches the answer stream.
- Content and curated, versioned Research metadata use the existing Message
  lifetime. Reload does not execute another request; export and deletion include
  the result. Body links retain meaning in sharing/TXT and ordinary follow-up
  Chat. Excerpts are limited to 400 characters and to actually cited sources.

## Local evidence

The implementation uses an independent `npm ci` installation from the lockfile:
AI SDK 7.0.162 and Next.js 16.4.5. AI SDK 7's `usage` aggregates all generation
steps; no migration to the deprecated `totalUsage` alias was made.

The original seven-suite search/Perplexity failure was not reproduced. With
grounded-link and response-body checks included, the initial focused run passed
146/146. The final 17-suite focused unit/regression run passed 239/239, and the
offer endpoint contract passed 5/5. Report/metadata/export/trailer checks passed
45/45. The real SDK mock
executor checks cover the three-step output remainder, source R25, tool-only
terminal output, mixed/duplicate calls, unknown usage, truncation, abort and
downstream cancellation. In particular, a missing final-step usage count cannot
be hidden by the SDK's partial sum of earlier known counts. Tests use fake search
responses and mock models.

The dedicated PostgreSQL 17 test databases were initialized through the existing
DB integration safety runner. Focused runs may set `DB_INTEGRATION_SUITES` to
comma-separated registered integration suite paths; database safety checks and
schema setup remain mandatory. Research persistence passed 1/1 and the existing
Perplexity route passed 23/23. The actual Research route passed 3/3 with the real
SDK and database: terminal-only persistence, 900 input/600 output aggregate token
settlement, replay without a new dispatch, private context exclusion, prohibited
input/profile refusal, and unknown usage stopping without a report or measured
zero cost. Failed user-credit refunds retain their existing contract; they do
not mean the provider's estimated cost is zero.

The broader finance run passed 222/239. Its 17 failures were reproduced on the
unchanged base with the same lockfile dependencies and a separate test database:

| Existing suite | Reproduced failures |
| --- | ---: |
| `chat-concurrency.db.test.ts` | 10 |
| `chat-rate-limit.db.test.ts` | 6 |
| `image-generation.db.test.ts` | 1 |

They concern existing admission/concurrency behavior. The first run is not an
all-green finance result and those unrelated behaviors were not changed here.
The default 4 GiB Node heap was insufficient for whole-repository type checking;
integration checks use an expanded local heap.

The final full build (including TypeScript), standalone whole-repository
TypeScript check, whole-repository ESLint, model pricing, accent-token and
database enum-constraint checks passed. The build and browser harness block
external network access and use local fixture credentials, not production ones.

Browser regressions passed 21/21 on this worktree's build, using a separate local
port without reusing another session's server: Research Preview 5, existing
Perplexity 1, Auto 9, and composer/mobile input 6. They cover one-shot follow-up,
unchanged model/product selection, attached and oversized draft preservation,
reload without dispatch, 320px attachments, Korean IME, keyboard and 200% text.

## Independent review and Git state

Implementation commit: `43e5de354645e6312b497cd080cfafea3ee90f45`.
Independent review job: `r-20261114-150628-1b42c3`, reviewer vendor Google,
provider `antigravity`. The prose report described no defects and supported the
change, but omitted the required verdict JSON block. The orchestrator therefore
returned `unknown` / `no_verdict_block` (exit 2), not an accepted review.
Per the repository's unknown-outcome rule, the review was not resubmitted.
The remaining follow-up changes contain only the verified browser fixture
assertion and this verification record; the reviewed production code is unchanged.

No PR, push, CI start/retry, merge, deployment, AMUX mutation, feature activation,
pricing/budget increase or paid model/search evaluation was performed.

## Limits and next validation

No real model/search call or production activation was performed. Source URL
binding establishes provenance, not semantic proof of a claim. This preview reads
search excerpts, not full pages. Cancellation stops subsequent work; it does not
promise that incurred provider costs disappear or that all credits are refunded.

P1 retains full-page evidence, long-running durable research/checkpoints/resume,
new-Chat and Native start UI, and a small separately approved evaluation of
usefulness, claim support, latency and total cost. Existing Perplexity settings,
jobs, reports and pricing remain available.
