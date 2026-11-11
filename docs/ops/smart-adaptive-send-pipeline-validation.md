# Smart Adaptive send pipeline

Goal-Step: response-latency/send-pipeline

## Observed problem

The post-#3675 production snapshot at 2026-11-10 06:14:27 UTC had only
two complete browser reports before deployment and three afterwards. For the
two GPT 6 Luna requests that each used four application-managed searches,
submit-to-first-content was 23.703s before and 21.508s after; completion was
25.414s and 23.270s. These were different questions, one sample per side.
Preparation increased from 1.904s to 5.375s, offsetting 3.471s of the 5.666s
improvement between dispatch and first content. This is observational evidence,
not a controlled quality or performance comparison.

The previous browser sample stored preparation as one number. Code inspection
found context pricing and draft flushing serialized before Refiner preparation,
durable question persistence and location acquisition. A disabled location-intent
feature still incurred an authenticated HTTP request per new source message.
The production location-intent switch was absent at inspection, so a location
LLM call cannot explain that snapshot's preparation delay.

## Changes

- Prepare context and flush the captured draft concurrently. Both must settle
  before the identity/conversation/model fence, Refiner, question consumption or
  Chat dispatch. A stale or failed preparation releases any prepared draft.
- Pass the server's location-intent availability through both web shells. When
  disabled, skip automatic intent HTTP requests. Manually enabled location still
  reads a fresh position. When enabled, retain semantic classification, guest
  verification, per-source deduplication, consent, revocation and freshness.
- Do not ask the Router to rewrite a turn with an already validated Refiner
  preview, including keep-original. Atomic Refiner consumption restores that
  exact execution view before dispatch, so the second rewrite was discarded.
  Keep model selection, file/image classification and ordinary Router rewriting.
- Add bounded numeric stages to the existing signed, best-effort timing report
  and Admin response-latency table. No migration or content logging is required.

| Observation | Boundary |
| --- | --- |
| submitHandoffMs | Submit to entry into the owned preparation path, including earlier intent/new-chat work |
| attachmentPrepareMs | Attachment preview preparation |
| conversationPrepareMs | Conversation preparation within the owned path |
| modelSyncMs | Model-settings send barrier |
| preflightMs | Existing comparison admission step (single Chat has no network preflight) |
| contextPrepareMs / draftPrepareMs | Independent, overlapping context preparation and draft flush |
| refinerPrepareMs | Existing automatic Refiner preparation, when applicable |
| messageSaveMs | Durable question save, receipt recovery and local reconciliation |
| panelHandoffMs | Prepared payload to panel run, including its model-settings barrier |
| locationMs | Remaining location wait after the durable save, including device/human permission |
| locationIntentMs | Semantic intent HTTP time. It can overlap new conversation preparation or Refiner. |
| freshLocationOverlapMs | Time an early intent request spent in flight before the saved turn needed its result. Present when a new conversation reuses that result. |
| responseHeadersMs | Latest dispatch to response headers |
| dispatchToContentMs | Latest dispatch to first nonempty visible content |
| contentToEndMs | First content to consumed stream end |
| clientFinalizeMs | Stream end to client handler completion |
| beforeRoutingMs / routingMs / afterRoutingMs | Server entry to router, routing, routing end to provider dispatch |
| presearchMs | Router-proposed search through the admitted attempt tool, before answer-model dispatch |
| contextMs | Nested server context verification build, when a bundle is present |
| providerToContentMs | Provider dispatch to first content, including model thinking and tool/search rounds |

The existing `app_managed_web_search` events correlate by trace ID and expose
tool-call index, batch size, backend duration and reuse without query text. Use
those to separate backend search latency from the intervening model/tool rounds.
Native provider-internal searches have no equivalent per-query observation.

The table reports p50/p95 and count separately for each stage. Do not sum
overlapping durations or subtract unrelated percentiles. First content still
means UI state update, not browser paint. Server settlement still means the
start of settlement, not completion. Old clients remain accepted and absent
stages stay unknown. Pre-stream refusals without a signed token remain outside
the browser report; use existing route rejection logs for those requests.

## Controlled comparison

Local PowerShell in the repository: `node --import tsx scripts/smart-adaptive-send-benchmark.mjs`.
No production credentials, database, network or paid model calls are used.
The baseline reproduces serial context/draft preparation; the candidate imports
the production preparation helper. Both return identical context/draft values,
call each dependency once, and retain identical subsequent save, enabled-location,
provider/search and stream delays. Forty pairs alternate execution order.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| First content p50 | 216.27ms | 170.66ms | -21.1% |
| First content p95 | 230.38ms | 184.27ms | -20.0% |
| Completion p50 | 247.01ms | 201.80ms | -18.3% |
| Completion p95 | 261.50ms | 215.08ms | -17.8% |

These are fixture results, not projected production savings. Context and draft
delays are synthetic (30–34ms and 50–56ms); timer scheduling also contributes.
Real savings depend on their overlap. If the draft was already flushed, that
part saves little or nothing. No routing prompt, model, tool/search limit, memory,
answer length or Refiner decision was weakened to obtain these results.

## Location activation and subsequent comparison

The owner separately requested production location-intent activation during this
work. Existing review r-20261025-104233-cbed73 was accepted; the unchanged
location route/provider contracts passed all eight tests. The existing flag
`TOMVERSE_CHAT_LOCATION_INTENT_ENABLED=true` was applied without changing budgets
or providers. Deployment `e4a003c8-da12-4c97-9377-2906e08a0a8a` became successful
at 2026-11-10 06:44:05 UTC (16:44:05 AEST). Runtime readback confirmed the flag
and `/api/health` returned 200. Its code remains main commit
`f2fafdfbeab3a6346beb4cf9d39e491b58e3262d`; it does not contain this PR.

This activation adds a semantic intent wait to eligible sends and changes the
comparison cohort. Compare this PR before/after only with location intent enabled
on both sides, matching model, source, outcome, search usage and permission state.
Keep first-permission interactions separate from already-enabled/denied location.
The small earlier location-off snapshot cannot establish this change's live gain.

## Verification

- Preparation tests execute overlapping jobs and the actual stale/failure cleanup.
- Timing tests cover strict numeric allowlists, old-client compatibility, signed
  proof/origin enforcement, nested timings, replay and telemetry failure isolation.
- Browser regression exercises real submit/stream reporting and existing
  model-change/draft fences; location tests retain automatic/manual/denied flows.
- Existing route contracts cover selection, fallback, guest credit/auth boundaries,
  tools and full artifact streaming. The unrelated ART-FORMAT-01 TODO remains.

Final local results: 122 route/timing contracts passed with that one existing
TODO; 34 preparation/latency/location unit and render checks, 20 Auto UI render
checks and eight location route/provider contracts passed. Browser checks passed
five send/fence scenarios plus 14 enabled-location and two disabled-location
desktop/mobile scenarios. The disabled browser lane was explicitly run with
`E2E_CHAT_LOCATION_INTENT_ENABLED=false`; the default Playwright lane enables
intent and skips that dedicated test. Production build and targeted ESLint passed.
Independent review r-20261110-070954-d034a5 accepted the final runtime changes,
following r-20261110-065304-50d126. The follow-up test supplies a Router rewrite
even when forbidden and verifies both execution bytes and response provenance;
all three adversarial cases passed. It changes no reviewed runtime boundary.

No performance-code merge or deployment is included. Production speed and
semantic answer quality were not remeasured with paid model calls in this task.

## Deeper critical-path review

Read-only Railway HTTP logs and content-free Refiner execution receipts resolved
the previously unknown preparation segment. At 06:11 and 06:12 UTC:

| Observation | Request A | Request B |
| --- | ---: | ---: |
| Browser preparation | 5.375s | 5.011s |
| Refiner prepare HTTP duration | 4.261s | 3.954s |
| Refiner admission before provider (receipt timestamps) | 0.375s | 0.337s |
| Refiner provider to verified completion (receipt timestamps) | 3.711s | 3.460s |
| Context prepare HTTP duration | 0.081s | 0.100s |
| Disabled location-intent HTTP duration | 0.036s | 0.037s |

These are temporally corresponding requests in the earlier snapshot, not new
controlled runs. The Refiner receipts were `suggested`, model ID
`gpt-5-6-luna`, 286 input tokens each, zero cached input tokens, and 90/209
output tokens including 55/173 reasoning tokens. No source text was read.
Most of this delay is the existing medium-reasoning Refiner generation, not
context retrieval or the disabled location endpoint. The preparation overlap
fix alone is therefore unlikely to produce a large perceptual change.

For the four-search post-deploy request, the first-content path was 21.508s:
5.375s browser preparation, 3.426s server pre-provider work, 12.517s from provider
dispatch to first content, and approximately 0.190s of remaining cross-boundary
overhead. These are one request's durations, not subtracted percentiles.
Routing occupied 2.725s inside server pre-provider work. The three search tool
calls had backend critical waits of approximately 1.200s, 1.062s (two queries
in parallel), and 1.167s. The remaining approximately 9.1s inside provider-to-first
content includes model/tool round trips, transport and processing; it cannot
be labeled pure model reasoning from these logs. Completion followed first
content by another 1.762s. Search orchestration remains a larger target than
the roughly 0.1s context preparation endpoint.

The deeper review also found the discarded Router rewrite described above.
Removing that task uses the existing no-rewrite prompt/schema and its existing
200-token routing output ceiling instead of the 900-token rewrite ceiling.
Those are ceilings, not measured token savings. The request still selects a
model and checks file/image intent; the final Refiner execution bytes remain
unchanged. Routed accepted, keep-original and ordinary turns are exercised
through primary failure and fallback, in addition to the existing view tests.

### Structural alternatives

| Approach | Critical path and quality trade-off | Decision |
| --- | --- | --- |
| Independent Refiner and location-intent calls in parallel | Changes `F + L` to `max(F,L)` while retaining each model, prompt and result. Maximum theoretical saving is `min(F,L)`, not an observed result. | Implemented behind `CHAT_PARALLEL_PREPARATION_ENABLED`. Prime only the semantic decision; defer permission/GPS until the saved turn is current. Preserve identity cancellation, exact-source binding and one call per turn. Account for spend if a later save fails. Guest one-use verification must finish before either dependent request. |
| Search preparation in the existing Router call | Have the Router propose independent grounded-search queries, then execute them together after ordinary access/credit admission and supply the results to the answering model. This may avoid repeated answer-model planning round trips; it adds no separate planner call. | Implemented behind `CHAT_ROUTER_PRESEARCH_ENABLED`. Keep the same search backend, shared per-attempt query ceiling, untrusted-source treatment and provenance. Retain answering-model follow-up tools for genuinely dependent queries. Compare source relevance/completeness and added Router latency before adopting. Do not pre-spend search budget before admission. |
| One structured preparation call for refinement, routing, image/file and location intent | Removes repeated reading and model round trips. A larger combined prompt/output may offset the gain, and decisions can interfere. | Strong candidate for a separate evaluated adapter. Do not silently change the currently approved Refiner model/config pin or merge its budget ledger with the Router. |
| Faster Refiner model or lower reasoning | May shorten the observed 3.5–3.7s provider segment, but equal quality is unproven. | Compare as a candidate; do not activate from a latency hypothesis. |
| Speculative refinement while typing | Can hide submit latency but sends unsent text and spends on abandoned drafts. | Exclude from this change; user-input privacy and spending behavior would change. |
| Stream a raw answer before refinement or shorten search/answer limits | Improves apparent start time by changing the answer path or amount of work. | Exclude: cannot claim preservation of the current result. |
| Cache arbitrary previous answers or refined prompts | Can remove calls, but source/conversation/consent changes and audit attribution must be resolved. | No broad cache added. Existing exact-query search deduplication remains. |

For the combined candidate, use the same synthetic multilingual questions,
histories, attachment metadata, tool fixtures and allowed model pool. Include
follow-ups, abstention/keep-original, local-vs-explicit-place questions, denied
location, file/image ambiguity, stale scope, injection, citations and tool
failures. Compare final answer correctness and completeness, routing/file/image/
location decisions, credit/consent invariants, errors and cost as well as both
latency percentiles. Set non-inferiority criteria before running blinded paired
answer evaluation. Mock timing or schema tests alone cannot establish semantic
equivalence. A paid evaluation and production activation are separate actions;
neither was performed for these alternatives.


## Parallel preparation and Router presearch implementation

Both switches are default-off server environment variables. This PR does not
activate them or change the production location-intent switch enabled earlier.

- `CHAT_PARALLEL_PREPARATION_ENABLED=true`: on authenticated Auto follow-ups
  already eligible for automatic Refiner preparation, start the existing
  location-intent call alongside that Refiner call, after context/draft admission.
  Keep the same authored text, models and prompts. Wait for both decisions before
  durable question save. The prepared boolean is tied to the location session's
  identity, generation and exact authored text; it cannot contain a fix or request permission. GPS
  still runs only from the saved, current turn. A manually granted or suppressed
  session makes no speculative intent call. Guests and image turns retain their
  existing path. A failed/stale preparation uses the existing saved-turn path.
  An abandoned send may have spent its already-admitted location intent call;
  no retry is scheduled by preparation. A stale or failed prepared decision may
  cause the saved-turn path to classify again; one call holds only for an
  unchanged, successful preparation. No typing-time calls are added.
- `CHAT_ROUTER_PRESEARCH_ENABLED=true`: the existing Router call can return zero
  to two validated independent queries on authenticated text Auto turns with web
  search enabled. The extra 240 output-token ceiling and prompt are included in
  that call's existing provider cost hold. No separate planner call is created.
  Only the final selected model's actually dispatchable application-managed tool
  executes the plan, after the ordinary credit/admission boundary. Native search,
  guests, turns with attachments, artifact requests, MCP, consented-location,
  search-off and unrouted turns keep their paths. A file-capable answer model
  may still presearch for an ordinary text question when the Router explicitly
  marks it as not requesting a file. Missing or unclear file intent does not
  admit presearch. The normal file and search tools remain available to the
  answering model. The Router does not receive device coordinates; the answering
  model retains location-aware search after the usual consent boundary.
  The same tool/session handles presearch and all later model queries: five
  searches total, exact-query reuse, the same backend, sources, notices and billing.
  At least three slots remain for dependent facts. The answer model receives the
  results as application-collected, untrusted reference text appended to the
  unchanged question parts, with source notices,
  and retains every normal tool. Empty/invalid plans and errors use normal tools.
  Presearch evidence uses at most 2,400 of the existing 6,000 result tokens,
  leaving three-fifths for follow-up evidence; it is never
  truncated or added above the reservation. Oversized results remain in the
  attempt's exact-query cache for the ordinary tool path. No search evidence is
  inherited by a replacement attempt, and existing search-turn recovery policy
  is unchanged. An outer failure retains incurred/uncertain backend cost even
  before an answer-model stream exists: all-successful reads settle the exact
  count; incomplete backend responses conservatively retain the hold. Manifests include the evidence text digests. No synthetic assistant tool
  history or provider reasoning signatures are fabricated. This also supports
  providers whose Chat Completions endpoint rejects inserted tool calls
  ([DeepSeek documentation](https://api-docs.deepseek.com/guides/tool_calls/)).

`locationIntentMs` and `refinerPrepareMs` now overlap for eligible parallel turns;
never add them to estimate elapsed time. `presearchMs` is inside server pre-provider
work; compare submit-to-content and completion totals, not that stage in isolation.
The Router still has to produce correct queries: unchanged answering models and
retained tools do not by themselves prove semantic non-inferiority.

### Controlled comparison of both changes

Local PC, PowerShell, repository root. Read-only fixture execution; no production
credentials, network, database or paid model calls:

```powershell
node --conditions=react-server --import tsx scripts/smart-adaptive-parallel-benchmark.mjs
```

Forty alternating paired runs used the real location-session preparation and
presearch/tool code with fixed delays and intercepted backend responses. Both
variants use the same execution text, two initial independent searches, one
**dependent** follow-up search, three sources, and one Refiner/location/Router
call. The candidate removes one simulated answer-model planning pass; the fixture
also charges it an additional 5ms for the longer Router output.

| End-to-end fixture metric | Serial baseline | Both improvements |
| --- | ---: | ---: |
| First content p50 | 342.46ms | 251.78ms |
| First content p95 | 407.25ms | 315.27ms |
| Completion p50 | 372.86ms | 282.64ms |
| Completion p95 | 454.96ms | 343.03ms |

These establish orchestration savings under the stated delays, not production
percentages or equal LLM answer quality. Real gains depend on actual Router output
latency, query relevance, whether the first answering-model pass was avoidable,
permission state, and follow-up searches. Do not combine these values with the
previous context/draft benchmark or the tiny production snapshot.


Local follow-up verification covers the real Router request and its exact cost
hold, malformed/disabled plans, shared search caps and reuse, input headroom,
failures and abortion, route admission/settlement, native/location exclusions,
and the existing signed timing and selection contracts (193 passing checks).
The two new controlled-browser scenarios prove simultaneous semantic requests,
no permission/GPS before durable save, one intent call on the accepted turn, and
no save/dispatch/GPS when model selection changes. Five existing send/timing/fence
scenarios also pass. Build and targeted lint pass. Full provider semantic quality
and production p50/p95 still require a separately authorized matched evaluation.


Independent review `r-20261110-074257-2c1b88` accepted the initial follow-up.
After the provider-history compatibility fix, review
`r-20261110-080106-5da3b5` accepted runtime commit `e60e70bf6`. The remaining
partial-backend-failure case is covered by the final local test, and the full
6,000-token precheck intentionally preserves the follow-up allowance even though
presearch injects at most 2,400 tokens. External snippets are verified to remain
literal data without triggering additional deterministic work. This is not an
LLM prompt-injection evaluation: before activation, include malicious-source
cases in the matched semantic quality evaluation because reference data is
carried in user-content parts for cross-provider compatibility.

Browser verification covers 22 cases: seven desktop send/timing/fence cases,
nine mobile send/location cases, four desktop/mobile serial-path cases with
`E2E_CHAT_PARALLEL_PREPARATION_ENABLED=false`, and two disabled-location/manual
refresh cases. The final controlled-delay run above was made locally alongside
a build; scheduling jitter affects its absolute times and p95. No production
speed or semantic quality conclusion is drawn from these synthetic milliseconds.

### First submission in a new Smart Adaptive chat

`CHAT_FRESH_LOCATION_PREPARATION_ENABLED` lets a signed-in blank Auto Chat
start its existing semantic location request as soon as the submitted draft
revision and its owner are confirmed, before conversation creation. An
outstanding draft write must finish first. It defaults to off and also requires
`TOMVERSE_CHAT_LOCATION_INTENT_ENABLED`. The follow-up Refiner parallelism
switch is independent. An abandoned send can spend an admitted location call
even if the conversation or question is never saved. An explicit resend
after a failed question save can admit another classifier call for the new
send. Count those attempts when comparing call volume, budget and latency.

Use the browser's submit-to-first-content and completion metrics for the
10-second target. Report the fraction at or below 10,000 ms and p50/p95,
separately for fresh and follow-up, search and non-search. Match the question,
location permission state and model selection conditions. Report missing
browser measurements and failed sends. For a reused fresh decision,
`freshLocationOverlapMs` is the observed portion of the semantic lookup
before the saved turn asks for the result. It can overlap several other
stages. Compare end-to-end times per send to assess the actual change.

A combined Router/location call remains a candidate for new text turns.
The standalone classifier reads up to 8,000 characters of the authored
message. The Router reads up to 4,000 characters of its execution view and
may also receive history, file/image instructions and search planning. A
combined evaluation needs the original location input and a saved-turn
continuation for a positive decision, so the browser can obtain consent
before location-aware search. A routed negative should continue without
another model call. Include named cities, nearby requests, quoted examples
and a decisive instruction near the end of a long prompt in the comparison.
Measure the combined Router's actual duration, model choice, resulting
sources and answer quality alongside the calls it removes.
