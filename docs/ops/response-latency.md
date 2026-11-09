# Chat and Review latency

The existing Auto Router Optimizer now receives content-free timing evidence in
its existing generator call. It stores that evidence with its cycle report and
shows it in Admin's optimizer panel. There is no extra model call on a user turn,
new optimizer schedule, budget increase or automatic setting change introduced
by this feature. Existing optimizer enablement and promotion controls still apply.

## Immediate changes

- Chat loads the billing plan and model catalogue concurrently, before using
  either result. Authorization and reservation order after those reads is intact.
- AI Review clients opt into NDJSON. A validated primary result is sent after
  its existing settlement path, before the secondary finishes. The final event
  follows the route's original persistence and quota handling. JSON callers,
  preflight errors and cache hits keep their existing responses.
- Partial results are explicitly pending. Agreement, item feedback and web
  verification do not become available from a partial account result. An EOF or
  final save failure keeps the first result visible without claiming success or
  a refund. There is no automatic paid retry after an unknown outcome.
- Disconnecting the reader does not cancel server-side review finalization.
  Whitespace heartbeats keep the remaining streaming connection active.

## Optional parallel review

`COMPARISON_REVIEW_PARALLEL_ENABLED=true` prefetches the first two independent
reviewer candidates. It is **off by default**. Both calls still use the existing
reservation, concurrency limits, retry policy, grounding and settlement paths.
Candidate order and final primary/secondary attribution are preserved. A locally
refused prefetched attempt is retried sequentially after both prefetched attempts
finish; provider failures do not get an extra retry from prefetching. Remaining
candidates follow the existing fallback order. All prefetched work is drained
before the service returns, including on failure.

Earlier primary display is available without this switch. It improves time to
usable review, not the duration of the remaining model call. Parallel execution
can reduce total review processing time when two reservations are admitted;
actual production savings must be measured after an authorized rollout.

## Evidence definitions

| Measurement | Start and end |
| --- | --- |
| Browser preparation | Submit handler entry to panel API dispatch, including asynchronous preparation |
| Browser first content | Same start to nonempty response text delivered to UI state; **not paint** |
| Browser completion | Same start to handler finalization; outcome separates success, timeout/failure and user stop |
| Server first content | API handler entry to its first visible output |
| Server settlement | API handler entry to settlement start; **not final completion** |
| Routing / context | Measured duration of the corresponding preparation stage |
| Before provider | API handler entry to provider dispatch preparation |
| Review first result | Service entry through the primary attempt and its settlement/release path |
| Review processing | Service entry through attempts and operational recording; excludes route persistence |
| Existing review run duration | Existing `ComparisonReviewRun` operational measurement, a separate source |

The summary separates product, mode, source, model and outcome. Each metric has
its own sample count and nearest-rank p50/p95. Missing measurements are unknown,
not zero. Groups below 30 samples are marked inconclusive; all evidence remains
observational. Samples are not unique user submissions: parallel answer panels
and server/client reports are separate measurements. Model attribution stays
absent on browser reports; unsupported product attribution remains `unknown`.
Guest manual turns without a durable product identity therefore remain unknown.
Requests that fail before a signed response header have no browser report.

The read is bounded to the latest 1,500 timing rows and 500 existing review runs
within seven days; the report marks truncation and omitted smaller groups.
An unavailable read is shown as unavailable. Never add overlapping stages or
subtract unrelated percentiles to claim a saving. The generator is instructed to
preserve models, dual reviews, grounding, tools, memory, authorization and credits.

## Storage and rollout

Apply the additive `20261109120000_response_latency_samples` migration through
the normal authorized deployment process before collecting evidence. No existing
table or credit ledger is modified. `ResponseLatencySample` stores opaque request
IDs, product/mode/model/provider identifiers, outcome and bounded numeric timings;
it contains no prompt, answer, attachment, user or conversation field. Maintenance
deletes samples older than seven days.

Browser reports require a same-origin request and a purpose-bound HMAC proof
issued in the Chat response using the existing server secret. Proofs expire in
one hour, do not authorize AI or access user data, and select one immutable sample
ID. Input schema, body size and rate limits are enforced. Replays cannot overwrite
the first sample. Browser measurements remain untrusted observations. Native
bearer permissions are not widened. Diagnostic writes are best effort; failures
cannot reject or delay a model response.

For rollout, compare equal product/mode/model/outcome cohorts for first content,
total processing, failure/primary-only rates, grounding and credit reconciliation.
Keep parallel review off until its rollout is authorized. This PR does not apply
the migration to production, run paid evaluations, enable automation or deploy.
