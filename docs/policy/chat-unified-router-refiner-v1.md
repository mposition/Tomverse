---
status: approved_scope_not_activated
policyVersion: 1
workId: CHAT-01
proposedAt: 2026-10-16
approvedBy: mposition
approvedAt: 2026-10-16
approvalEvidence: owner_chat_approval_of_e25fb17f_on_2026_10_16
approvalTimezone: Australia/Brisbane
scope: CHAT_UNIFIED_ROUTER_REFINER_AND_OPTIMIZER
implementationAuthority: provider_free_implementation_within_approved_scope
initialRuntimeActivationAuthority: owner_action_after_exact_release_readback
productModelId: gpt-5-6-luna
productApiModelId: gpt-5.6-luna
productInputTokenCap: 100000
productOutputTokenCap: 4096
productDeadlineMs: 13000
productRetryCount: 0
productPerRequestCeilingMicroUsd: 29918
sharedProductDailyCostCapUsd: 100
sharedProductMonthlyCostCapUsd: 3000
optimizerRunCostCapUsd: 25
optimizerDailyCostCapUsd: 25
optimizerMonthlyCostCapUsd: 150
optimizerActivePlanLimit: 1
optimizerActiveRunLimit: 1
optimizerCandidateDailyLimit: 1
optimizerCandidateMonthlyLimit: 6
globalChatAvailabilityMutation: prohibited
---

# Unified Router and Refiner v1

## 1. Status and owner decision

On 2026-10-16 the owner approved the recommended policy in local commit
`e25fb17f07b9e06a4bd87da61b7d7510797f5996` in this development conversation.
The owner allowed a higher optimizer budget if needed; this version retains
the proposed exact US$25/run, US$25/day and US$150/month caps. A higher cap
requires a new numeric decision and policy version before use.
This records provider-free implementation authority within the approved scope.
Provider calls, vendor transfers, rollout, promotion, merge and deployment still
require the specific gates and activation records below. Material changes
require a new policy version and owner approval.

The owner approved these five decisions:

1. add a bounded semantic signal to the existing deterministic Router and
   combine that signal with the optional Refiner rewrite in one low-cost
   preprocessing model call for eligible Chat turns;
2. keep that call inside the existing product Refiner cost, authorization,
   audit and unknown-outcome boundaries;
3. authorize implementation of a separate background optimizer with the
   closed cost and data boundaries below;
4. authorize, once its independent evidence and initial activation gates have
   passed, automatic promotion of a narrow immutable candidate bundle; and
5. authorize time-based deletion of the optimizer's hidden synthetic material
   when no legal hold exists.

The one-call statement refers to preprocessing. The answering model remains a
separate, ordinary Chat provider call under the existing Chat authorization.

Policy approval alone does not authorize the first paid optimizer run, install
or activate a protected Ubuntu worker, transmit a hidden case to a vendor, or
activate the unified product path. Those irreversible steps require the
specific activation records in sections 8 and 11.

## 2. Existing contracts retained

The governing existing contracts are the
[initial Auto release](chat-refiner-initial-auto-release-v1.md),
[release continuity](chat-refiner-stable-release-authority-v2.md),
[operator-controlled availability v3](chat-operator-controlled-availability-v3.md),
[Refiner UI and input boundary](../ui-contracts/prompt-refiner-suggestion.md),
[receipt observability](prompt-refiner-observability.md) and
[Router score policy](tomverse-chat-router-score-policy.md).
The v3 availability decision supersedes the older automatic pause and
source-change reactivation requirements.

The implementation reuses the existing product Refiner adapter, model
transport, cost reservation and settlement, owner/conversation/scope binding,
attempt claim, accepted-resolution handoff, content-free receipts, audit chain,
Router hard filters and scoring, model health, final Chat preflight and provider
execution. Reuse means calling those boundaries; it does not mean weakening or
copying them into a second writer.

The following remain unchanged:

- the durable user Message retains the exact authored bytes;
- only an accepted server-owned rewrite may be used as the effective execution
  prompt;
- user credits, plan eligibility, context manifest, capability filters, model
  health, provider budgets and final-answer settlement retain their existing
  authority;
- manual mode, Off, explicit model choice and Guest behavior keep their
  existing contracts;
- historical B08 failures, unresolved evaluation-audit concerns and pending
  Router attestations remain failed or pending; and
- merge, main release and deployment authority remain human-controlled under
  the repository's existing policies.

Operator-controlled Chat availability has priority. Operational observations,
candidate failures and optimizer state must never write the global Chat rollout
flag, availability switch or persistent legacy Auto guard. A historical paused
legacy guard row remains paused until the existing owner resume operation.
Source fingerprints remain audit provenance. An unrelated deployment does not
require a fresh activation when the operator-controlled availability contract
allows continuity.

## 3. Eligible product scope

The first eligible scope is an authenticated, stored Chat conversation in the
registered-user Auto or Smart Adaptive experience, for a text-only current
turn. Eligibility is checked on the server immediately before dispatch.

The following are outside this version:

- Guest turns;
- manual and Off modes;
- attachment contents, attachment names and attachment-derived text;
- conversation history, Memory, profile knowledge, tool results, search
  results, files, voice data and system instructions; and
- any client-provided Router candidate, provider identity, model identity,
  authority boolean, analysis label or execution decision.

The model input remains `current_user_turn_text_only`. No metadata expansion is
approved by this version. Server-known settings, attachment facts and explicit
search state are merged later by deterministic code and are never added to the
model-facing input.

## 4. One-call product contract

### 4.1 Fixed transport and limits

The initial unified stage retains the current product pin:

| Field | Required value |
|---|---|
| Registry model | `gpt-5-6-luna` |
| Provider API model | `gpt-5.6-luna` |
| Route | direct OpenAI Responses API |
| Processing tier | Standard |
| Reasoning effort | `medium` |
| Tools | none |
| Input cap | 100,000 tokens |
| Output cap | 4,096 tokens |
| Deadline | 13,000 ms from authenticated route entry through held publication |
| Retry count | 0 |
| Per-request ceiling | 29,918 microUSD |

The effective current registry row, transport, rates and price-pin digest must
be verified immediately before reservation. A price, model, tier, transport,
usage-shape or cache-write mismatch closes dispatch. This policy does not
declare a future price valid merely because the table above records the current
pin.

The stage uses the existing exact two-message boundary: fixed system rules
first, followed by one canonical JSON user message containing only
`inputScope` and `sourceText`. The fixed safety wrapper is not candidate-editable.
The optimizer may propose only the bounded task-instruction payload nested by
that wrapper. User text stays quoted untrusted data.

### 4.2 Closed model output

The response must be an ordinary JSON object with exactly this shape:

```json
{
  "schemaVersion": "unified-router-refiner-v1",
  "analysis": {
    "kind": "coding",
    "difficulty": "standard",
    "expectedOutputLength": "medium",
    "needsCurrentInformation": false
  },
  "rewrite": {
    "decision": "keep_original",
    "text": null
  }
}
```

The allowed values are closed:

- `analysis.kind`: `coding`, `documents`, `research`, `writing`,
  `multilingual` or `general`;
- `analysis.difficulty`: `simple`, `standard`, `complex` or `unknown`;
- `analysis.expectedOutputLength`: `short`, `medium` or `long`;
- `analysis.needsCurrentInformation`: boolean; and
- `rewrite`: either exactly `{ "decision": "keep_original", "text": null }`
  or exactly `{ "decision": "rewrite", "text": <bounded non-empty string> }`.

No extra key, prototype, accessor, duplicate JSON key, non-finite value,
free-form rationale, confidence number, provider/model identifier, tool command,
authority request or partially repaired output is accepted. The rewritten text
must pass the existing prompt bounds and preserve the source task, quoted data,
requested operations and safety-relevant constraints. It may not answer the
task, add facts, infer attachment contents or widen authority.

### 4.3 Binding and exactly one dispatch

The server captures the exact current draft snapshot and binds one attempt to
the authenticated owner, stored conversation, mounted surface, mode, scope
epoch, recovery epoch, draft revision, source message and request identity.
That source snapshot may cause at most one preprocessing dispatch.

Selection between the legacy and unified contracts happens before dispatch. A
valid existing legacy Refiner result bound to the same source snapshot is
reused; the unified stage is not called as a second opinion. A terminal,
expired, stale, cross-account, cross-scope, reconnect or concurrent duplicate
attempt cannot dispatch again.

The stage records durable dispatch intent before the provider call. Known usage
settles once. An unknown provider or billing outcome retains the conservative
hold, latches that attempt for readback and is never replayed. A late result
cannot become an accepted analysis or rewrite.

### 4.4 Deterministic merge and fallback

The model result is a signal. Deterministic server code owns the effective task
profile and Router decision.

- Explicit user settings, stored mode, attachment facts, context requirements,
  capability needs and existing hard filters have higher priority.
- A model value may tighten a requirement. It cannot turn off explicit search,
  remove an image/document requirement, lower a trusted constraint, enable a
  tool, grant permission or choose a provider/model.
- `difficulty: unknown` and missing evidence remain neutral.
- A valid profile with `keep_original` is a normal successful outcome. It must
  not be recorded as an accepted rewrite.
- Invalid, abstained, late or pre-dispatch timeout output uses the original
  authored text and the pure deterministic Router. It must not call the legacy
  Refiner as a fallback.
- Budget refusal or pre-dispatch unavailability uses the original authored
  text under the ordinary Chat authorization.
- An unknown dispatch or billing outcome follows the existing hold/latch and
  readback path; it never causes another preprocessing call.

Per-model/task/difficulty quality evidence is read only from a separately
versioned evidence bundle. A cell with fewer than 30 independent questions, an
unknown provenance, a mismatched bundle or no approved evidence remains at the
neutral Router quality band.

## 5. Product cost authority

The legacy Refiner and unified stage share one Brisbane-calendar product
budget: US$100 per day and US$3,000 per month. These are the existing caps, not
an additional allocation. Every dispatched preprocessing request reserves the
verified worst-case amount up to 29,918 microUSD before dispatch. Known cost is
settled once; unknown cost keeps the worst-case hold.

No change is made to user credits or to the provider budget for the answering
model. Budget shortage never reduces token accounting, skips a guard, changes
the model pin or creates a free retry. It returns to the original-input path
before dispatch.

## 6. Receipts, authority state and telemetry

Existing Refiner execution and disposition receipts remain immutable and keep
their current content restrictions. They must not be extended with analysis
labels, Router data, prompt or proposal bytes or digests, user/conversation/
session identity, attachment/Memory/profile data or provider error prose.

The effective semantic profile belongs in `RoutingRun` or a new separate,
content-free, strictly typed routing record. The server-owned authority store
may retain the minimum scope binding needed to reject stale and replayed work,
but it is not an analytics receipt and is read only through its existing
authorization boundary.

Allowed product metrics are closed enums, versions and numbers: schema,
candidate, prompt payload, evidence, Router and parser versions; profile labels;
rewrite decision; selected model; outcome/reason code; latency; normalized
token usage; and known or unknown cost. Logs, alerts and reports contain no user
text, rewrite text, text digest, provider error prose or identity. Empty
populations are `null`, never evidence of success.

Every human or system state transition uses the existing transactional
hash-chained audit writer. No service writes the audit table directly.

## 7. Optimizer boundary and execution

The optimizer is a separate business agent, not part of the user request path.
Its approved `platformProductKey` is `internal-chat-optimization`, its approved
system actors are `chat-unified-optimizer` and
`chat-unified-candidate-promoter`, and its approved Admin permission is
`chat-optimization:write`. Using these identifiers still requires the
corresponding closed registries to be changed through independent review.

The normal coordinator runs as a dedicated Railway service. It has no product
database credentials and changes product state only through authenticated app
internal routes. The app is the single database writer and owns queue, lease,
deadline, audit, evidence, candidate and active-pointer transitions. Pure
deterministic admission and promotion judgment may run inside those app routes.
LLM calls and execution of model-produced text remain in a credential-free
service or protected worker account.

Using the dedicated review host for hidden case and judge CLIs is a proposed
execution-location exception. It may be implemented or activated only after a
separate approved agent-foundation and orchestration version names this agent,
its worker list and launcher. Existing AMUX Decision Maker and AMUX intake
exceptions do not apply to this optimizer.

Each protected role and vendor uses a separate unprivileged operating-system
account, home, credential, request directory and log boundary. The fixed
launcher denies shell, write, network expansion, MCP, sub-agent, sandbox-bypass
and arbitrary-argument flags; egress is limited to that vendor. Worker, broker,
case author, candidate author and each judge cannot read another role's home,
process environment, clone, request material, output or signing key. Ptrace,
sudo and shared claude-mem access are denied. Output reaches the app only
through the broker's typed pipe and authenticated internal route. Cleanup runs
on every exit; an unverified cleanup latches the optimizer.

Creating those accounts and launchers requires a human administrator login and
sudo. The agent never supplies, consumes or records those credentials.

## 8. Optimizer cost and paid-run activation

Optimizer cost has its own namespace and never consumes user credits or the
US$100/US$3,000 product preprocessing budget. The proposed limits are:

| Limit | Value |
|---|---:|
| One evaluation run (one fresh 80-case corpus and its full author/review, three-arm, fixed-evidence and judge work) | US$25 |
| Brisbane calendar day | US$25 |
| Brisbane calendar month | US$150 |
| Concurrent active promotion plans | 1 |
| Concurrent active runs | 1 |
| New candidates entering evaluation | 1/day, 6/month |

Each metered call reserves its verified worst-case price before dispatch and
settles known usage once. Unknown usage keeps its hold and stops the run. A
missing price, missing usage shape, missing quota readback or unknown outcome
refuses admission. Budget shortage postpones the run; it never reduces corpus
size, judge count, confidence level, strata or a quality threshold.

One promotion plan requires three independent evaluation runs. Before admitting
the plan, the app verifies that all three frozen run quotes can fit the remaining
monthly capacity and that every run fits the US$25 run/day caps. This does not
pre-spend a future provider call: each dispatch still receives its own durable
reservation immediately before execution. At the absolute caps a three-run
candidate may consume up to US$75, so US$150/month can fund at most two such
full plans before any other metered work. The six-candidates-per-month rule is
an additional family-wise limit, not a promise that the cost budget can fund six.

Subscription CLI capacity is not zero-cost. It uses a separate vendor quota
ledger with call count, input/output token limits where the CLI reports them,
and before/after quota readback. U31 S0 must measure the real interface and
produce the exact per-vendor call/token ceiling and whole-run quote. Until the
owner activates that measured quote, normal-cycle subscription-backed calls
remain closed; only the separately activated narrow S0 probe below may run.

Code, schema, tests and provider-free synthetic integration use zero prepaid
provider calls. Policy approval is not paid-run approval. The paid boundary has
two non-circular activations:

1. a narrow S0 probe quote is prepared from current official price documents,
   the adapter's closed usage upper bounds and a fresh quota readback. The owner
   activates its exact adapters, vendors, call plan, request/token limits and
   maximum reservation within US$25 before the first probe;
2. the probe records real usage, cancel/timeout/lookup behavior and before/after
   quota. Those observations produce the full-cycle quote and quota contract,
   which the owner separately activates before a normal optimizer run.

An unknown rate, quota, usage cap or price source refuses even the S0 probe.
Each later price, adapter or quota-contract change repeats the applicable
activation; it cannot inherit a stale measurement.

## 9. Hidden evaluation separation

Customer prompts, conversations, Memory and production answer text are never
background optimizer inputs. Initial and continuing improvement use only
reviewed public fixtures and newly generated synthetic cases.

The candidate author receives public development cases and content-free
aggregate failures only. It cannot read fresh hidden cases, answers, rubrics,
counterexamples, per-question feedback, raw judge output, keyed digests or the
signing key. App metadata, Admin reports and normal code-review reports must not
return that hidden material to the candidate role.

The queue, candidate draft and approval state have one canonical home in the
app database and Admin. Hidden bodies live in a separate app-owned encrypted,
restricted body store whose only credential-bearing writer is the app. The
candidate payload plus public few-shots is capped at 256 KiB. Candidate, case,
judge, coordinator and protected Ubuntu CLI processes receive no product DB or
body-store credential. Ubuntu request material is temporary and is removed
after the broker pipe closes on every terminal path; unverifiable cleanup
latches the optimizer.

Fresh corpus authorship, candidate authorship, code review and hidden judgment
use distinct identities. The recommended hidden panel is one Cursor/xAI judge
and one Copilot/Moonshot judge per case. Exact model assignment, live quota,
vendor identity and candidate/corpus-author conflicts are verified before a
run. A missing independent vendor, a self-judge conflict or an uninspectable
aggregate judgment closes the run.

This recommendation is not evidence that either panel is currently available.
Admission requires a fresh successful quota and identity readback for two
independent vendors; `unknown` and exhausted capacity both refuse the run.

Before each irreversible vendor transmission the app records a durable intent
containing provider, role, payload manifest digest and run identity. Unknown
receipt means sent and is not retried. This policy's approval and the protected
worker activation are the one-time owner approval for only the named closed
vendor/data scope. A new vendor, new data class or wider source needs a new
policy version and owner approval.

Raw hidden synthetic material is deleted at the earlier of 30 days after run
disposition and 60 days after corpus sealing, unless a separately recorded
legal hold applies. A candidate body is retained while it is active or is the
last-known-good rollback target; after it becomes unreferenced and reaches a
terminal disposition, it is deleted in 30 days. Content-free signed evidence,
candidate identity, decisions and audit rows follow their existing approved
data-domain and audit retention.
Deletion is a single-writer, audited transition; cleanup failure latches the
optimizer and does not pretend deletion succeeded.

## 10. Candidate and evaluation contract

### 10.1 Writable candidate bundle

The optimizer may propose only one immutable bundle containing:

1. the integrated task-instruction payload inside the fixed safety wrapper;
2. bounded public synthetic few-shots; and
3. a compatible Router evidence reference.

It cannot modify the output schema/parser, fixed safety wrapper, model or
provider pin, pricing, token/cost/deadline/retry guards, admission gates,
policies, audit writers, permissions, workflow/CI, publisher rules, hidden
cases, judge configuration or its own code. A bundle that requires any such
change is a human-reviewed engineering proposal, not an optimizer candidate.

### 10.2 Three-arm frozen comparison

Before opening hidden evidence, the run freezes one full source SHA, schema,
candidate bundle, model pool, Router evidence version, price set, judge panel,
strata, metrics and exactly one promotion mode:

- `quality_superiority`; or
- `quality_noninferior_cost_10pct`.

It then compares paired versions of:

1. the current incumbent;
2. unified analysis with the original text; and
3. unified analysis plus conditional rewrite.

For the initial unified candidate, the incumbent is the legacy path. For every
later candidate, the incumbent is the exact currently active frozen bundle; a
legacy result may remain as a descriptive anchor but cannot substitute for
beating the active incumbent. Each arm may dispatch preprocessing at most once
for one case. One evaluation run is one fresh corpus of at least 80 paired
cases across all three arms, followed by its fixed model-evidence and judge
work. Its minimum preprocessing worst-case reservation is exactly
80 x 3 x 29,918 microUSD = US$7.180320. A promotion plan requires three such
independent runs, so its preprocessing component alone can reserve up to
US$21.540960 before final-answer, evidence and judge charges. Every run still
has to fit the same US$25 run/day cap; a plan that cannot fit is postponed.

Promotion evidence uses the three fresh sealed runs: at least 80 paired cases
per run and at least 240 cases total. Every case receives two independent
judgments. The same case may pair arms within its frozen run, but a prior run,
prior candidate's hidden corpus or a peeked result cannot be reused for
promotion.

Each judge must first score at least 29 of 30 fixed calibration labels correctly
(at least 95%) with zero disagreement on a critical label. An independent
evaluation-criteria owner fixes and owns those labels; the candidate author,
case author and judges cannot edit them. The initial calibration is a separate
one-time operator-reviewed act. Failure closes the judge and the run; it does
not remove hard cases.

At most six candidate families may enter promotion evaluation per Brisbane
month. The family-wise alpha is 0.05/6. This policy uses the more conservative
one-sided 99.5% confidence interval for every promotion comparison. Repeated
peeking, optional stopping, post-freeze metric selection and selective corpus
discard are prohibited.

Promotion requires all applicable checks:

- zero critical failures in every corpus and predeclared stratum;
- no safety-constraint loss, task-intent change, quoted-data execution,
  unauthorized capability/tool enablement, trusted-fact downgrade, attachment
  claim or hidden-data exposure;
- in `quality_superiority`, the lower confidence bound of the paired quality
  improvement is strictly greater than zero;
- in `quality_noninferior_cost_10pct`, the paired quality lower bound is at
  least -2 percentage points and the lower confidence bound of paired all-in
  API cost saving is at least 10%;
- complete, reconciled preprocessing and final-answer usage/cost evidence; and
- all predeclared model/task/difficulty evidence cells have at least 30
  independent questions; smaller cells remain neutral and are not promoted.

Call completion, parser validity, judge agreement, aggregate preference and a
finished report are not by themselves a quality pass. Missing evidence is
`insufficient_evidence` and retains the incumbent.

The preregistered paired quality score is bounded from 0 to 1. Differences and
the -2 threshold are reported in percentage points. `all-in API cost` starts at
the first admitted preprocessing reservation and ends after the corresponding
final-answer provider settlement; it includes every metered preprocessing,
Router-evidence and final-answer provider charge attributable to that arm and
excludes user credits and fixed infrastructure. The exact paired resampling or
bootstrap implementation, random seed, strata weights and interval routine are
part of a separately reviewed frozen evaluation protocol before the first paid
run. They cannot be selected after observing a candidate result.

## 11. Promotion, canary and rollback

Promotion is a candidate-pointer change, never a code merge or deployment. A
distinct system promoter may write it only after deterministic code verifies
the signed exact evidence, frozen source/base SHA, candidate digest, active
revision and policy version. The write uses compare-and-swap and the existing
hash-chained system audit in the same transaction. An unknown write result is
read back and never blindly retried.

Before any automatic candidate promotion, the owner performs one initial
activation after exact reviewed source, schema, fixed wrapper, controls, CI,
serving deployment and off-switch readback. This activation grants the narrow
candidate-pointer authority defined here. It does not authorize a schema,
model, price, guard, permission, vendor or policy change. Unrelated deployments
do not require renewed activation and do not disable Chat.

A passing candidate enters only the owner-approved eligible cohort. A fixed 10%
of all eligible turns remains on the exact current incumbent as the concurrent
control, while candidate treatment advances through 5%, 25% and 90% of all
eligible turns. Turns outside treatment and the fixed control continue to use
the incumbent but are not silently added to the fixed-control denominator.
Each phase requires at least 24 hours and 100 completed eligible turns. Full
canary completion also requires at least seven elapsed days and 300 completed
eligible turns, zero critical incidents, complete content-free final-Chat/
error/fallback/cost/latency observations and no unknown billing, dispatch,
audit or pointer state. After the 90% phase passes every gate, the candidate
becomes the 100% active candidate and the fixed control is released. If evidence
is insufficient, the phase remains unchanged.

Each canary phase applies these deterministic candidate-specific operational
thresholds against a concurrent fixed incumbent control from the same eligible
cohort and phase window:

- the one-sided 99.5% confidence upper bound for the candidate-minus-control
  final Chat completion-error difference is at most +1 percentage point;
- the same upper-bound rule and +1 percentage-point limit applies to
  original-input fallback;
- the one-sided 99.5% confidence upper bound for the candidate/control
  end-to-end p90 latency ratio is at most 1.10;
- in `quality_superiority` mode, the corresponding upper bound for the
  candidate/control mean all-in API cost ratio is at most 1.10;
- in `quality_noninferior_cost_10pct` mode, the lower confidence bound of
  all-in API cost saving remains at least 10%; and
- billing, dispatch, audit and pointer unknown counts are all zero.

The measurements, denominators, strata, concurrent-control assignment and
interval routine are frozen before initial activation and bound into the signed
evidence. A zero denominator, missing metric, missing required stratum or
interval that does not meet the threshold is insufficient evidence. The 300
turn minimum is a floor, not an automatic pass; an underpowered interval keeps
the current phase until more eligible turns accrue. A candidate cannot change a
threshold, and technical success logs alone cannot advance it.
The historical global `p90 > 6 seconds` and `more than 5 fallbacks in 100`
pause rules are not reintroduced as automatic Chat controls by this policy.

A critical failure, unknown candidate dispatch/cost, audit-integrity failure,
signature or CAS mismatch, hidden-data exposure, cleanup failure or failed
candidate-specific canary gate rolls the candidate pointer back to the last
known-good bundle and latches that optimizer cycle. Readback precedes any
resolution. Only the owner may clear a latched cycle after reviewing its exact
generation and cause.

Rollback and latching affect only the optimizer cycle and candidate pointer.
They must not turn global Chat availability, the product rollout switch, a
legacy Auto guard or another agent on or off. The operator remains the sole
authority for those controls.

## 12. Deterministic guards and audit actions

The optimizer Guard has three results:

- `refused`: scope, identity, price, quota, source, schema, independence,
  evidence, deadline, audit, secret scan, retention or CAS validation failed;
- `awaiting_owner`: a first paid quote, protected-worker/vendor activation,
  initial product activation, new irreversible data transfer, new vendor/data
  class or policy/permission change is required; or
- `eligible`: every closed deterministic condition for the current transition
  passed.

No LLM chooses one of those results. Model text is parsed as untrusted data and
may contribute only bounded candidate or judge signals.

Proposed system audit actions are:

- `chat.unified_optimizer.run_admitted`;
- `chat.unified_optimizer.dispatch_intended`;
- `chat.unified_optimizer.run_terminal`;
- `chat.unified_optimizer.cleanup_terminal`;
- `chat.unified_candidate.promoted`;
- `chat.unified_candidate.rolled_back`; and
- `chat.unified_candidate.cycle_latched`.

Proposed human actions are:

- `chat.unified_optimizer.paid_scope_activated`;
- `chat.unified_optimizer.vendor_scope_activated`;
- `chat.unified_runtime.initial_activated`; and
- `chat.unified_candidate.cycle_resumed`.

Audit metadata is a closed set of ids, versions, digests, counts, money, quota,
timestamps and reason codes. It contains no prompt, case, answer, rubric,
rewrite, judge prose, path from a hidden corpus, identity or provider error
text.

## 13. Failure and recovery

Every external operation records intent before dispatch. Known refusal before
dispatch may be attempted later as a new run identity. Once dispatch may have
occurred, timeout, disconnect, missing receipt or malformed response is
`outcome_unknown`: retain the conservative reservation, stop the affected run,
read the provider/app ledger where a safe lookup exists, and require owner
resolution when the result remains unknown. No automatic retry is permitted.

Queue claims, leases, candidate revisions, evidence seals, approvals and
pointer changes use server-minted ids and database compare-and-swap. Late work
cannot become success. A late model result after stop, expiry or supersession is
recorded only as a content-free refusal reason.

## 14. Legal and regional boundary

The product is operated by the Australian entity. User-facing text must not
claim that routing is best, optimal or guaranteed to improve quality. The
background system handles no customer content in this version. Any future
customer-data use requires a new policy, privacy/data-domain review and APP 8
overseas-transfer assessment before collection.

Vendor processing terms, DPA, security posture and data location must be
verified before the first real hidden transmission. Mainland China is outside
scope. Synthetic data does not waive secret scanning or vendor-transfer
recording.

## 15. Implementation and release gates

Implementation proceeds in provider-free slices after owner policy approval:
strict schema/parser, prompt builder, adapter, reservation/binding, profile
merge, Router evidence, handoff/UI compatibility, telemetry, optimizer ledger,
protected-worker broker, candidate/evaluation guard, promotion store, canary
and end-to-end synthetic failure tests.

The first paid S0 remains closed until section 8's documented narrow probe
quote is activated; normal paid runs remain closed until the measured
full-cycle quote is separately activated.
The first hidden vendor transfer remains closed until section 9's worker and
vendor scope is activated. The first product turn remains closed until section
11's initial runtime activation. Independent contract review, applicable local
checks, PR readiness, CI, merge, deployment and activation are separate status
claims.

## 16. Agent design checklist closure

1. **Products and untouched state.** Reuses Chat Refiner, Router, app audit and
   internal agent routes. It does not write user credits, billing entitlement,
   Chat history, Memory, global availability, deployment or merge state.
2. **Namespace and permissions.** Proposed identifiers are in section 7 and
   require closed-registry review before use.
3. **Irreversible actions.** Paid calls, vendor transfers, protected-account
   setup, timed deletion and initial automatic-promotion authority have the
   one-time owner activations in sections 8, 9 and 11. Main release remains
   human.
4. **Guard.** Section 12 defines the deterministic three-way result. LLM output
   never makes the transition decision.
5. **External text.** Product input is only quoted current-turn text. Optimizer
   input is reviewed public fixtures or isolated hidden synthetic material;
   embedded instructions are data.
6. **Credentials.** Generation/judge accounts have one vendor credential,
   restricted egress and no product DB, GitHub write, deployment, signing or
   peer-account access.
7. **Storage.** The app owns strict single-writer queue, lease, run, dispatch,
   evidence, retention, candidate and pointer records with database transition,
   deadline, uniqueness and CAS constraints. Exact schemas require independent
   review before migration.
8. **Cost.** Sections 5 and 8 separate product, agent and user-credit ledgers
   and define refusal on shortage or unknown values.
9. **Switches.** Product and optimizer switches are separate and fail closed.
   Only candidate pointer/cycle state may change automatically; owner resumes a
   latch and controls global Chat availability.
10. **Unknown outcome.** Sections 4, 11 and 13 require hold, stop, lookup and no
    blind retry with server-minted identities.
11. **External S0.** Price/usage/quota, timeout/cancel behavior, identity,
    egress, receipt lookup, DPA and data location are measured before activation.
12. **Audit.** Section 12 names proposed human and system actions; every write
    shares the existing transaction and hash chain.
13. **Law and region.** Section 14 covers ACL claims, APP/overseas processing
    and the mainland-China exclusion.
14. **Phases and blockers.** Section 15 separates provider-free implementation,
    paid S0, hidden transfer, product activation and release status.
15. **Execution and publishing.** Railway coordinates, the app decides/writes,
    and the protected host exception requires separate approval. Services have
    no product DB credential. Code publication uses existing human-reviewed PR,
    merge and deployment paths.
16. **Queue, drafts and approval records.** They live in the app DB and Admin,
    bind exact digests/base SHA/revisions and follow size, secret-scan and
    retention rules. Hidden material never uses GitHub issue, label, comment or
    artifact as a state store. This policy changes a gate file, so it is not an
    agent-generated PR exception and requires ordinary human review.

## 17. Owner choices captured by approval

The recorded owner decision accepts the recommended online scope, shared
product budget, optimizer caps, original-input fallback, evidence thresholds,
protected role separation and narrow automatic candidate-pointer authority
above. Numeric values remain those in the approved proposal. This policy
approval does not replace the first paid probe, protected-worker/vendor or
initial-runtime activation records, independent review, CI, merge or deployment.
