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
