# Compare Smart Adaptive search turns

Run the same synthetic question, settings and conversation history with presearch off and on. Record the `X-Request-ID` of each final Chat POST, including failed runs. Alternate order across repetitions. The manifest pairs these IDs locally. Use a short content-free case label and a unique repetition number.

```json
[{"caseId":"dependent-search","repeat":1,"off":"00000000-0000-4000-8000-000000000001","on":"00000000-0000-4000-8000-000000000002"}]
```

From the repository root on the operator's workstation, run Node 22 in PowerShell with dependencies installed. Supply the application’s `chat_turn_timing` events from the evaluation window as a JSON array or JSONL. The reader accepts the application event object or its serialized form in a log record’s `message`. Supply an export of the matching `ResponseLatencySample` client rows with `id`, `source`, `mode`, `product`, `outcome` and `timings`.

```powershell
node --import tsx scripts/compare-chat-presearch.mjs --pairs manifest.json --logs events.jsonl --timings timings.json > report.json
```

For a read-only database lookup, supply `--db` in place of `--timings timings.json` with an already configured `DATABASE_URL`. It selects only the listed client sample IDs in a read-only transaction. Client timings are retained for seven days. These commands read existing measurements and require no model or search provider calls.

Each row shows the selected answer model and whether the router offered a plan, returned queries and attached evidence with sources. `modelCalls` counts SDK language-model invocations before `doStream`, including SDK retries. `finishedSteps` counts completed SDK steps. One step may request several searches. `toolOnlySearchSteps` counts completed steps with search calls only and no non-whitespace answer text. `searchStepsAfterResults` counts search steps after the model received results from a previous step or the injected evidence. `answerBackendRequests` counts new backend requests after the presearch interval. A repeated search can add a model invocation while reusing backend results.

`modelCallsWithSearchResults` counts model dispatches whose final input message carries a successful search tool result containing at least one result. Presearch attaches evidence to a user message and has its own injection count.

`sourceCards` counts citations in the normalized response metadata. `mentionedSources` counts distinct returned source URLs literally present in the answer text, including Markdown links. `mentionedInjectedSources` restricts the latter count to injected sources. Numeric markers, paraphrases and source entailment require separate answer review. Whether one search depends on a previous fact also requires a controlled fixture or a review of the paired answers.

The report gives equal-weight paired distributions for authorized, completed and selection-eligible turns and a second view restricted to the same selected model. Each metric includes both arms only when both measurements are present. `firstMs` and `completionMs` use signed browser observations. Server first enqueue and server settlement have their own fields. Negative `onMinusOff` values mean the ON value was smaller. Percentiles use nearest rank. Review the per-arm outcome, missing events, mismatched flags and client coverage alongside the aggregate. An injected result can lead to the same number of model calls in both arms.

For each browser metric, `within10s` reports the number of OFF and ON observations
at or below 10,000 ms and the shared denominator `observedPairs`.

For paired Qwen 3.8 Flash evaluation, set `CHAT_QWEN_GROUNDED_LOOKUP_ENABLED=true` only in the candidate environment. It defaults off. It changes the first answer step only for a Smart Adaptive direct lookup with injected search sources; follow-up steps retain the regular model and tools. Report the selected model, observation date, answer correctness and linked sources alongside browser latency; distinguish live search from replayed evidence.

For an answer-generation comparison, toggle `CHAT_CONCISE_GROUNDED_ANSWER_ENABLED`.
It defaults off. Keep presearch enabled, and keep the answer model and its
thinking settings the same in both arms. When the primary search returns
sources, the app marks them as quoted data, includes their original JSON,
then supplies the answer instructions. A direct weather lookup that has both
observations and forecasts should start with two labelled lines in the user's
language. Each cites its own source. Comparisons use the requested units and
precision and link each value to its source. Analysis and derivations retain
the detail the user requested. The model can still search to resolve incomplete
or conflicting evidence.

To compare the evidence format, leave concise grounded answers enabled and
toggle `CHAT_COMPACT_SEARCH_EVIDENCE_ENABLED` (default off). A single query
uses the tool's ordinary single-result format. For a batch, each query
references its ordered extracts and identical extracts appear once. Different
snippets or dates from the same URL remain distinct. The app uses this format
only if the JSON shrinks and the complete grounded prompt uses fewer estimated
tokens within the same presearch allowance. The answer instructions, search
cache and remaining follow-up allowance are the same in both arms. Compare
source coverage, repeat searches and browser latency separately.

Pair the same question and saved history. Verify that the answer provider
received the same model, ordered evidence and source URLs in each pair.
Measure browser Send to first answer text and completion separately, and
record answer-model time and output tokens to explain changes. For weather,
check observation time, forecast period and uncertainty against their own
sources. For a comparison, check each requested fact, calculation and link.

### Grounded answers, 2026-11-11

Five matched pairs per question used Qwen 3.8 Flash, fixed official evidence,
the same saved conversation and one Chromium worker alternating arm order.
The first-answer request matched byte for byte after removing the changed
instructions. Each question used its own fixed routing and thinking settings.
Both weather requests also matched the final build after the comparison
instructions changed. The search tool replayed sources and persistence was
isolated. Seconds below use nearest-rank percentiles. With five runs per arm,
p95 is the slowest turn. Both questions receive equal weight in the pooled row.

| Query | First text p50 / p95, OFF → ON | Completion p50 / p95, OFF → ON | Completed within 10s OFF → ON |
|---|---:|---:|---:|
| Brisbane weather | 7.13 / 11.11 → 7.36 / 8.31 | 11.79 / 15.39 → 10.43 / 11.11 | 1/5 → 2/5 |
| NASA Voyager | 10.87 / 11.24 → 7.62 / 8.40 | 13.28 / 14.24 → 8.85 / 10.83 | 0/5 → 4/5 |
| Both questions | 8.82 / 11.24 → 7.36 / 8.40 | 12.40 / 15.39 → 8.85 / 11.11 | 1/10 → 6/10 |

| Query | Answer API p50 / p95, OFF → ON (s) | First text to provider stream end p50 / p95, OFF → ON (s) | Output tokens p50 OFF → ON |
|---|---:|---:|---:|
| Brisbane weather | 5.66 / 8.16 → 3.95 / 4.84 | 4.23 / 4.91 → 2.77 / 3.28 | 311 → 201 |
| NASA Voyager | 6.87 / 7.60 → 3.37 / 4.23 | 2.98 / 4.08 → 1.27 / 2.38 | 413 → 224 |
| Both questions | 6.21 / 8.16 → 3.45 / 4.84 | 3.22 / 4.91 → 2.23 / 3.28 | 352 → 204 |

The browser completion target was 10s p95. Neither question met it. In the
slowest final weather turn, standalone location classification took 4.08s,
model selection 2.94s, and the answer provider 3.95s. Existing-conversation
location fusion was off throughout this isolation test. An initial weather
control turn requested another search and the harness interrupted its follow-up
model call. A pre-registered replacement pair supplied the fifth matched pair.

All 20 paired answers included the requested core facts. Direct links to both
the weather observation and forecast documents increased from four to five
answers out of five. Three OFF answers and no ON answers described rain or
thunderstorms as observed without supporting measurements. One ON answer
overstated forecast certainty. All five Voyager answers in each arm supplied
both official mission links and the correct 16-day ordering. One OFF answer
added an unsupported launch explanation. A blinded review of the complete
answers rated 5/4/1 pass/caveat/error OFF and 9/1/0 ON.

### Answer generation after presearch

`CHAT_GROUNDED_ANSWER_FAST_PATH_ENABLED` defaults to false. On a Smart Adaptive
turn where the router classified the request and the server attached search
results, the primary answer model gets a search tool description that tells it
to cite the existing evidence and to search for a missing fact, conflicting
result or missing official source. If all excerpts returned by a subsequent
search already appeared verbatim in the evidence sent to the model, the tool
labels them as repeated. A changed snippet, date or URL preserves the original
notice. The model receives the original source records in either case.

DashScope enables thinking by default on Qwen 3.8 Flash. For a direct lookup
with no configured reasoning effort, the switch sets a 128-token thinking
budget on the first call and after a step
consisting solely of successful web searches with results. A failed search,
empty result, partially failed batch or another tool restores the ordinary
model settings on the following step. Comparisons and tasks that need reasoning
retain the model's configured behavior. The earlier
`CHAT_QWEN_GROUNDED_LOOKUP_ENABLED` switch takes precedence for Qwen's model
settings when both switches are on. It disables optional thinking on step zero
and uses the provider default on subsequent steps. [DashScope thinking parameters](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)

To evaluate this change, keep the router candidate format fixed, send the same
questions and ordered evidence to the same answer model, and include a case
whose first search omits a requested fact. Record every attempted turn, the
first visible answer text, browser completion, answer model calls and factual
support from the cited links. Record results for incomplete evidence separately.

A November 12, 2026 controlled Chromium run used the same previously built
web client in both arms, the current Chat route, real GPT-6 Luna routing and
real Qwen 3.8 Flash answers. The catalogue, selected answer model, question,
study clock, source order and search backend responses were fixed. Router
candidate compression was off. Model requests and tool follow-ups streamed
through the actual adapters. Browser timings start at Send and end at the first
nonempty answer text or client completion.

| Matched primary runs, six per arm | OFF p50 / p95 (s) | ON p50 / p95 (s) |
|---|---:|---:|
| Answer provider start to first answer text | 4.944 / 10.240 | 3.149 / 4.636 |
| Send to first answer text | 8.016 / 12.707 | 5.795 / 8.671 |
| Send to completion | 12.167 / 19.009 | 10.087 / 13.087 |

Two repetitions of each Brisbane weather, NASA Voyager and RFC 6585 question
contributed to the primary distribution. Both arms completed two of six within
ten seconds and made one answer-model call on every turn. These nearest-rank
p95s are the slowest observations in each arm. In a separate pair that required
a missing station observation, both arms searched and made a second model call,
finishing in 21.634s and 18.524s. On a separate USGS question the baseline
searched and made two answer calls (13.612s), and the candidate used the
supplied evidence in one call (9.975s).

### Source fidelity on the grounded answer fast path

`CHAT_GROUNDED_SOURCE_FIDELITY_ENABLED=true` opts a classified Smart Adaptive
presearch turn into numbered source citations when the #3783 fast path is on.
The existing packet keeps its sources, order, excerpts and metadata. The
answer receives the request time and instructions to distinguish observations
from forecasts, check the actors, dates and units, and describe gaps in the
available excerpts. If numbering exceeds the existing allowance, the original
packet wins. The primary stream expands the first reference to each source
into its exact URL before delivery and persistence. A repeated reference uses
the same number. An additional search remains available for missing facts and
can supply a new direct link. This requires no extra verification-model call.

A November 13, 2026 AEST comparison kept #3783 on and router candidate
compression off in both arms. A local Chromium client sent the same Korean
questions through the Chat route with a live GPT-6 Luna router and Qwen 3.8
Flash answer model. The source packets, clock, initial conversation history
and model selection were fixed. The six primary topics were Brisbane weather,
NASA Voyager, HTTP 429, the distribution of Earth's water, Himeji Castle and
World Aquatics medley rules. Three additional paired repetitions and one
paired missing-observation recovery case brought the total to 10 per arm. All
20 turns completed. These are controlled browser timings, with search and
persistence isolated. At these sample sizes the nearest-rank p95 is the
slowest observation in each arm.

| Browser metric | First six topics, OFF → ON (s) | All ten turns, OFF → ON (s) |
|---|---:|---:|
| First visible answer p50 | 9.370 → 6.908 | 9.370 → 6.913 |
| First visible answer p95 | 13.957 → 15.090 | 13.957 → 15.090 |
| Completion p50 | 14.621 → 9.843 | 14.621 → 10.312 |
| Completion p95 | 19.472 → 19.699 | 19.472 → 19.699 |
| Finishing within 10 seconds | 0/6 → 3/6 | 1/10 → 4/10 |

The ten turns needed 14 → 12 answer calls, including 4 → 2 follow-ups.
The incomplete weather pair recovered the missing observation in both arms
(17.370 → 14.433 seconds). The slowest candidate was the first Voyager turn:
the answer provider took 12.913 seconds to first text versus 2.909 seconds
on its paired control. Reasoning tokens rose from 102 to 622. The cached
input token counts were 1,024 and zero respectively. On repetition, Voyager
completed in 9.763 → 9.710 seconds. The trial does not establish which of
provider reasoning, caching or other provider variation caused the tail.

Blind grading before the final display fix found the requested core facts in
10/10 answers in both arms. All required official documents were reachable
through body links in 8/10 → 10/10. Three control answers added incorrect or
unsupported assertions about forecast publication times, Korean local time or
RFC history. No candidate answer repeated such an assertion. One candidate
weather answer mixed English into a Korean sentence.

In both medley repetitions the model flattened a dated directory in a bare
official PDF URL. The candidate also supplied a correct numbered citation.
The final stream recognizes that observed spelling only when an entire
standalone HTTPS URL, UUID, filename and page can be bound to the original
evidence. It restores the two date separators from that evidence. Live-model
timings above precede this final display-only change.
Replaying all ten captured candidate model outputs through the final renderer
one Unicode character at a time changed the two malformed links to the exact
official PDF. All 29 displayed links then matched evidence, up from 27/29.
The first visible character was released at the same input position and the
factual wording was identical on all ten. A local CPU replay of 100 iterations
per answer took 0.319 ms p95 with the final renderer. Original provider chunk
arrival times were not recorded, so this replay measures display behavior,
not a new browser latency distribution. The 10-second p95 goal remains open.
