# Tomverse Chat Auto Router rollout

- Status: **not started.** All three readiness gates are `pending`, so no
  account can be routed by Auto regardless of configuration.
- Owner: Backend/AI, with Product as rollout owner
- Companion to `docs/ops/tomverse-chat-router-evaluation-set.md` (which
  produces one of the three gates) and
  `docs/policy/tomverse-chat-routing.md` §5

This document is the operational half of the limited Auto cohort. The rules
live in code — `lib/autoRolloutReadiness.ts` and `lib/autoCohort.ts` — because
a rollout boundary written only in a document is a boundary that holds until
somebody is in a hurry.

## 1. The three gates, and why they are three

Auto routes nobody until all three are attested. They are not
interchangeable, and each produces reassuring numbers that look like the
others':

| Gate | Establishes | Is silent about |
| --- | --- | --- |
| `shadow_report` | blast radius: how much would change if Auto were on | whether the change would be an improvement |
| `offline_quality_evaluation` | answer quality vs. the pre-registered baseline, with a 95% interval | whether the dispatch path can record what it sent |
| `attempt_manifest_boundary` | every dispatch carries a finalized, immutable manifest | the quality of the routing choice |

Shadow cannot stand in for the evaluation. It records the model the Router
*would* have chosen and never generated that model's answer, so there is no
pair and no win rate. A Router that echoed the user's own choice would agree
with every shadow row and be worth nothing.

`npm run check:auto-rollout-readiness` prints the current state and fails the
build on an attestation that does not carry a person, a date, an artefact, an
evaluated commit, a written summary, a re-attestation deadline and its known
limitations.

## 2. Attesting a gate

Moving an entry from `pending` to `passed` in `lib/autoRolloutReadiness.ts` is
a human act. An agent may add entries, compute figures and keep the notes
current; `attestedBy` is a person's name, and the commit history is the audit
record.

An attestation expires. Readiness measures a system that keeps changing, and
an attestation with no deadline would outlive what it described — so
`expiresAt` is required, and the check fails once it passes.

## 3. Configuration

Every default is off, so a deployment that sets nothing routes nobody. A
missing variable is never mistaken for a deliberate rollout.

| Variable | Meaning |
| --- | --- |
| `AUTO_ROUTER_KILL_SWITCH` | `on` disables Auto for everybody, unconditionally |
| `AUTO_ROUTER_ROLLOUT_PERCENT` | 0–100, the share of eligible subjects Auto routes |
| `AUTO_ROUTER_ELIGIBLE_PLANS` | comma-separated plans, e.g. `Pro,Max`. Empty means none |
| `AUTO_ROUTER_COHORT_SALT` | names this cohort partition. Unset routes nobody |
| `MANIFEST_HASH_KEYS` | `keyId:secret` pairs. Required before any dispatch may be recorded |
| `MANIFEST_HASH_ACTIVE_KEY_ID` | which of them new manifests are digested with |
| `AUTO_ROUTER_FALLBACK_ENABLED` | `on` allows a second provider attempt after a pre-token failure. Anything else, including unset, allows none |
| `AUTO_ROUTER_DRILL_SUBJECTS` | staging only. Subject ids that may route while a readiness gate is outstanding, for the fallback drill. Empty means nobody, and production refuses regardless |

**The manifest keyring is not optional and not the session secret.** Recording
a dispatch refuses outright without it, because a manifest whose key nobody
can name is worse than one that was never written — the first looks like
evidence. It is separate from `NEXTAUTH_SECRET` because that key rotates on
authentication's schedule, and every rotation would leave the manifests
written before it holding a commitment nothing could check. Old keys stay in
the ring so a rotation does not strand what came before it; removing one is
the deliberate decision that those records no longer need to be verifiable.

**The kill switch is checked before everything else**, including readiness and
the percentage. An operator reaching for it during an incident must not have
to reason about anything else, and a kill switch another setting can outrank
is not a kill switch.

**Changing the salt reshuffles the cohort.** It travels on every decision for
that reason: a silent reshuffle mid-measurement replaces the population under
the metrics without replacing the metrics. Change it deliberately, and treat
the figures either side as separate runs.

## 4. Who is excluded, and why

- **Guests.** Structural rather than commercial: Auto's stickiness and
  hysteresis live on the conversation, and a guest's conversation state does
  not survive. A guest would get a Router that re-decides from scratch every
  turn, which is a different feature from the one being evaluated.
- **Accounts on a plan outside the allowlist.**
- **Conversations left on `manual`.** The mode is per conversation, so an
  account inside the cohort can have manual and Auto conversations at once.
  A manual conversation is not recorded as a cohort refusal — counting it as
  one would make the cohort look smaller than it is.

## 5. Falling back is normal

There are five ways Auto declines a turn — the conversation is manual, the
account is outside the cohort, a gate is outstanding, the kill switch is on,
or the Router found no candidate — and all five behave identically: the user
gets the model they would have had anyway, and is told nothing, because from
their side nothing went wrong.

What must never happen is the reverse. A turn that reported itself as routed
when it fell back would put turns the Router never decided into the metrics
that grade routing, and would advance the sticky streak on a turn nobody
judged. `lib/autoModelSelection.ts` makes that unrepresentable rather than
merely discouraged: `routed` is a tag, and the fallback model id lives on the
refusal branch where nothing can read it as a routing result.

## 6. Rolling back

1. Set `AUTO_ROUTER_KILL_SWITCH=on`. It takes effect on the next request; no
   deploy, no migration, no conversation edit.
2. Conversations stay on `selectionMode: auto` and keep answering with the
   user's own model. Nothing needs to be rewritten, and turning the switch off
   again resumes routing without a backfill.
3. Sticky state left behind is Auto's own and is only read on a routed turn,
   so it cannot affect a conversation while Auto is off.

Returning a conversation to `manual` clears its sticky state, and the database
enforces that — a manual row holding a router model or a challenger streak is
refused by `Conversation_manual_has_no_sticky_state_check`.

## 7. Where the decision is made

The Router runs in `app/api/chat/route.ts` immediately after the retirement
check on the model the user asked for, and before anything binds to a model.
Everything downstream — the Gemini prefill rule, admin availability, the web
search capability, the provider-context restore, the attachment shaping, the
credit budget, the context-window fit and the manifest — then runs against the
model that actually answers. There is no second pass, and nothing is checked
against a model that was never dispatched.

Three consequences worth knowing:

- **The requested model still owns its own errors.** A user whose chosen model
  was retired is told so, rather than having Auto quietly paper over it. That
  branch runs first and unchanged.
- **Provider reasoning context is model-specific.** The restore is keyed on the
  routed model, so a turn Auto moved elsewhere restores nothing — which is
  correct: another model's reasoning is not this model's context.
- **`MODEL_NOT_SELECTED` is skipped on a routed turn, and only there.** In Auto
  the user selected no model for the turn; the server did, and `selectedModels`
  is the manual list it is not choosing from.

A routed turn is recorded as `mode: "auto"` with the Router's own versions and
the model the user did *not* get, so disagreement stays measurable. The shadow
recorder is skipped on those turns — it records what Auto *would* have chosen,
and there is nothing hypothetical left once Auto has chosen for real.

## 8. Attachment turns

Attachment turns are routed, and the size that decides the routing is
**measured, never declared**.

The client knows how big its files are — it uploaded them — and
`app/api/chat/preflight` accepts a declared size for its own estimate. Routing
must not. A declared size is a claim, and an understated one would steer the
Router to a model whose window the real content does not fit; the user would
then get a context-window error for a model they never chose. So the chat route
reads each object's size from storage with a HEAD before deciding.

Two rules make that safe and cheap:

- **Only the caller's own objects.** The probe refuses any key outside the
  prefix derived from the caller's signed identity. Without that rule it is an
  object-size oracle over the whole bucket, answerable by anyone who can guess a
  key. Guests never reach it — the cohort excludes them — so one prefix is
  enough.
- **Only when it could matter.** The probe runs only when the cohort would
  admit the account, which today is nobody, so a turn that will not be routed
  pays for no HEAD requests.

An attachment that cannot be measured — no object key, a key outside the
caller's prefix, or a store that will not answer — falls back to the user's own
model, recorded as `attachments_unmeasurable`. Measurement is all-or-nothing per
turn: a partial one would let the Router choose on the strength of the files it
could see, and the one it could not is exactly the one likely to be a scanned
PDF that does not fit.

### What an attachment costs is per model

A PDF a model reads natively is a flat per-file allowance; the same PDF on a
model that cannot is its extracted text, bounded by a cap. One figure for every
candidate would be wrong in one direction or the other — generous enough for
the native readers admits a model the extracted text will not fit, and
conservative enough for the extractors rules out the native readers for nothing.

So `filterRouterCandidates` takes a per-model callback and fits each candidate's
window against what *that* model would actually receive. It is a callback rather
than a map so a model the filter considers and the caller did not answer for
cannot read as free.

The media types also reach the task profiler, which is what stops an image turn
being routed to a model that cannot see one.

## 9. What is not built yet

- **The Auto UI is behind a flag that is off**, and stays off until a cohort is
  actually running: a toggle that saves and changes nothing is the failure
  `docs/ui-contracts/auto-model-selection.md` §1 exists to prevent.
- **Automatic fallback is built and switched off.** `AUTO_ROUTER_FALLBACK_ENABLED`
  defaults to off and stays off until the staging drill has been run:
  `docs/ops/tomverse-chat-fallback-drill.md`. §9.1 to §9.4 are the record of
  how it was built and what is still owed.
- **The Planner is `"none"`,** so §6's pass-through downgrade is held. The
  policy function can return one and the route refuses it by name rather than
  silently doing nothing.

### 9.1 The fallback swap: how it was built

*This section is a record of work now complete. It is kept because the
corrections in it are the reasoning behind the shape of the code, and a
reviewer who only sees the result cannot tell which parts were argued for.*

Built and covered before this work: the decision
(`lib/routingFallbackPolicy.ts`), the records and budgets (`RoutingAttempt`,
`passThroughUsed`, `rerouteCount`), §8's recovery state, and §7's in-stream
`retrying_with_another_model` signal on both sides of the wire.

Not built at that point: the swap itself, in `app/api/chat/route.ts`'s stream.
An earlier note here said the `pull()` catch was the seam and that no
extraction was required. The seam was right; the second half was wrong, and
correcting it mattered because it understated the work by a lot. Four things
were open, and all four are now closed — each below says which step closed it.

**~~The catch does not classify the failure.~~ Done — step 1.**
`generatedText === ""` says the server has not read a text chunk yet. That is a
safe *necessary* condition and nothing more: `pull()`'s catch also receives
cancellation, client disconnect and failures from the completion handling below
it. §7 excludes cancellation, client disconnect, policy rejection and
insufficient credits from automatic fallback by name, so the error has to be
classified before `decideFallback` is consulted at all.

`lib/routingStreamFailure.ts` does that classification, and
`lib/routingAttemptSequence.ts` is the loop that runs an attempt, hands its
failure to the classifier and then to `decideFallback`, and runs the next one.
Both are pure over injected effects, so the whole thing is driven by a scripted
reader in `tests/routingAttemptSequence.test.mjs` — the first reader raises a
pre-token error and the second succeeds, fails, is cancelled, is refused before
dispatch, or is never reached. Two additions to `decideFallback` came out of
it: §7 names policy rejection and insufficient credits as non-candidates and
the function had no way to say so, so `FailedAttempt` now carries a
`providerRefusal` and there are two more named refusals for it.

Both are wired into the chat route in step 3. The scan that used to prove the
*absence* of any substitution is now
`tests/automaticFallbackBoundary.test.mjs`, and proves the narrower thing that
is actually true — see §9.3.

**~~Swapping `sourceReader` and `result` is not enough.~~ Done — step 2.** The
closure also holds `modelConfig`, `generationSettings`, `webSearchToolConfig`,
`requestMaxOutputTokens`, `dispatchRecord`, the Perplexity usage capture, and
the model id used by settlement, the logs and the stored message — all bound
to the primary. Leaving any of them would record or bill the fallback as the
primary.

`lib/chatAttemptExecution.ts` is that per-attempt state: one model in, one
complete dispatch out, pure, so two models' plans can be compared in a test
rather than in production. `ATTEMPT_BOUND_FIELDS` names what must come from a
plan, and the test fails on a field nothing produces per attempt — the failure
mode here is *forgetting* one, not writing the wrong one. Building it turned up
one hazard nothing had noticed: `perplexityUsageHeaders` keys the response
capture on the trace id alone, and consuming a capture releases it, so two
Perplexity attempts under one trace would hand the second reader the first's
body. Attempts after the primary now capture under their own key; the primary
keeps the bare trace id so nothing existing moves.

**~~Settlement cannot express two attempts.~~ Done — step 2.**
`ChatUsageReservation` carries a single `modelId`, `provider` and price
snapshot, and `settleChatUsage` prices actual usage from that snapshot. A
fallback model's tokens would be priced at the primary's rates, the second
provider's spend charged to the first provider's budget, and the fallback's
request id dropped entirely — `linkChatReservationProviderRequest` writes only
into a row whose identifier columns are still null, so the primary wins.

The contract is `lib/chatMultiAttemptSettlement.ts`, and its shape comes from
§7's own sentence: "Settlement uses actual accepted provider usage… but the
rule must be idempotent and must not rewrite provider cost accounting." That
separates two ledgers a single-attempt turn never had to distinguish.

| Ledger | Covers | Where it lands |
| --- | --- | --- |
| Provider cost | every attempt, at its own provider's rates | that provider's `provider:` spend buckets, and `ProviderDailyUsage` per attempt |
| The user's charge | one accepted attempt, never more | the reservation, settled once |

`settleChatUsage` takes an optional `attempts`; absent is the whole of today's
traffic and settles byte-for-byte as it always has, which a DB test asserts
directly. Present, it prices each attempt at its own snapshot, settles the
primary's provider bucket down to what the primary actually cost, increments
the fallback provider's buckets — which the reservation never held anything
against — and writes one `ChatAttemptUsage` row per attempt. That table takes
no updates at all and holds a partial unique index on the billed row, so
"exactly one end-user settlement" is a constraint rather than a promise, and a
goodwill refund cannot reach back and rewrite what an attempt cost.

`transferProviderBudgetForFallback` is the pre-dispatch half: §10 checks every
dispatch including the fallback, and money held at one provider does not make a
call to another affordable. One transaction, reserve before release — a
refusal leaves the primary's hold exactly as it was rather than opening a
window where the turn holds nothing anywhere.

**~~"Text-only turns" is still too wide~~ Done — step 3.** The safe initial
scope is Auto mode, plain text, no tools, no web search, no deep research, and
a candidate that passes its own filters, token check and a new manifest — §5
requires an independent attempt and manifest per fallback, so reusing the
primary's is not an option.

`lib/autoFallbackGate.ts` is that scope, with every refusal named: `flag_off`,
`not_routed`, `guest`, `deep_research`, `web_search`, `tools_offered`,
`attachments`, `no_candidate`. The flag is checked first so a deployment with
it off reports one reason for every turn rather than a distribution describing
a feature nobody enabled. `AUTO_ROUTER_FALLBACK_ENABLED` defaults to off and
only the exact string `on` turns it on.

### 9.2 What the swap still needs, and one thing it does not

Wiring the swap turned up a defect that had to be fixed before it, and a
prerequisite §9.1 did not anticipate.

**The stream named the wrong model, and Auto made it wrong.** Every log,
health record, stored assistant message and `MessageProviderContext` row
inside the stream read `requestedModelId` — the model the *user asked for*.
On a manual turn that is the same id as the one that ran. On a routed turn
they are different models: `recordModelSuccess`/`recordModelFailure` would
credit or blame a model that was never dispatched, and §8's recovery decides
whether to restore a displaced model from exactly those counters. Auto routes
nobody yet, so it never happened; a fallback would have made it two models
wrong within one turn instead of one. The stream now reads a `dispatched`
holder — the per-attempt state of step 2, in place — and
`tests/chatDispatchedModelAttribution.test.mjs` scans for a relapse.

**~~The Router does not surface a fallback candidate.~~ Done.**
`decideFallback` takes `nextCandidateModelIds`, and §6 requires that candidate
to have passed the same filters as the primary — so the list has to come from
the Router rather than be recomputed in the stream, where it would be a second
and divergent filter. `RouterSelectionResult` now carries `rankedModelIds`,
`RouterDecision` turns it into `fallbackCandidateModelIds` with the chosen
model removed, and `AutoSelection` passes it through. The removal is by
identity rather than by position: stickiness can select a model the ranking did
not put first, and a list that still held the primary would offer it as its own
alternative. `challengerModelId` was not usable despite the name — it is the
natural winner, equal to the selected model whenever stickiness is not
overriding.

### 9.3 The swap, as built

Behind `AUTO_ROUTER_FALLBACK_ENABLED`, which defaults off.

The seam is the stream's `pull()` catch, after the provider- and model-health
records and before the turn ends. A provider that failed is counted as having
failed whether or not another model rescues the answer: the fallback is a
recovery for the user, not an amnesty for the provider.

In order: classify the failure (`lib/routingStreamFailure.ts`), check the
scope, ask `decideFallback`, plan the candidate (`planAttemptExecution` — its
own budget, window fit and capability checks), move the provider budget if the
provider differs, close the failed attempt as `failed_pre_token`, open the next
one, emit the retry signal, and replace the per-attempt state wholesale.

Four things it does that are easy to get wrong:

- **One run, not two.** `beginRetryAttempt` opens a second attempt on the same
  `RoutingRun` and spends §6's build budget itself. Two runs would read as two
  responses and the reroute rate would be zero forever. It also builds the
  candidate's own manifest — §5 requires one per attempt, and it digests the
  messages inside the instrumentation module so the route never holds the
  manifest hash key.
- **The budget moves before the call.** §10 authorizes every dispatch including
  this one, and money held at one provider does not make a call to another
  affordable. Reserve before release, one transaction: a refusal leaves the
  primary's hold as it was.
- **§8 is written on success only.** `recordFallbackRecovery` runs when the
  answer exists. A recovery candidate stored for a retry that also failed would
  send the next turn back to a model that never worked. The conversation's
  sticky model becomes the one that answered, not the one the Router chose, and
  the hysteresis streak restarts — a fallback is not evidence about a
  challenger.
- **The user is billed once.** Settlement passes both attempts to
  `settleChatUsage`, which charges the accepted one and puts each attempt's
  real cost on its own provider's budget. The failed primary is recorded with
  the reserved input estimate and zero output, flagged as an estimate: no usage
  metadata exists for a stream that failed before its first chunk, and
  over-recording provider spend is the safe direction for a ledger whose job is
  to stop a budget being exceeded.

The scan that used to prove there was no substitution at all is now
`tests/automaticFallbackBoundary.test.mjs`, renamed and rewritten. It used to prove
there was no substitution mechanism at all, which is no longer true; it now
pins that the second model comes from the Router's ranked candidates and never
from the provider-suggestion table, that `decideFallback` refuses on a visible
token, that the route hands it what it actually enqueued, and that a deployment
setting nothing substitutes nothing.

### 9.4 The drill

Step 4 is prepared and not run: `docs/ops/tomverse-chat-fallback-drill.md` is
the runbook, `lib/routingFaultInjection.ts` the injector, and
`npm run drill:fallback-verify` the judgement.

The injector has three locks and needs all of them: not production (resolved by
`lib/deploymentEnvironment.ts`, which fails closed, so an unlabelled deployment
injects nothing), a configured `ROUTING_FAULT_INJECTION_SECRET`, and the
request's own header carrying that secret. Per request, never a percentage of
traffic — a QA session that had nothing to do with the drill must not start
failing. Every armed request logs `chat_fault_injection_armed` first, so a
drill is never read as an outage in the record it is about to produce.

The verifier's judgement is separated from its query and unit-tested, because a
verifier exercised only by real drills has its bugs found during one — and a
false pass is the worst outcome available here.

Step 5 is prepared too. Three of its four cases are faults —
`attempt_1_pre_token` for a fallback that also fails, `attempt_0_post_token`
for the control that must not substitute at all — and the fourth is
`npm run drill:fallback-disconnect`, a client that hangs up mid-retry, because
no provider-side fault reproduces the client going away. Its abort point is
exact rather than a race: §7 puts the retry signal on the wire before the next
model's first token and providers cannot emit a NUL, so "abort on the marker"
lands between the fallback being dispatched and its first token every time.

Writing that case is what found a real defect in the swap.
`cancelSourceSafely` latches `sourceCancelled`, and the latch means "the
current source is cancelled" — which stops being true the moment a different
source is installed. Cancelling the replaced reader through it would have left
a later disconnect with nothing to cancel, and the *fallback's* provider stream
open and billing after the user had gone. The swap now cancels the replaced
reader directly and clears the latch when it installs the new one.

§7 of the drill runbook is the enable checklist, which is deliberately a
decision and not the last line of a script.

One thing the drill needed that this document originally got wrong: the
runbook said to attest the three readiness gates "in staging only", which is
not a thing that can be done. `lib/autoRolloutReadiness.ts` is static code with
no environment dimension, so a gate moved to `passed` for staging is `passed`
in production. A fallback only happens on a routed turn and a turn is only
routed when readiness says ready, so the drill needed either a false entry in
the readiness register or a narrow request-scoped hole. It is the hole:
`lib/autoDrillOverride.ts`, four locks, production fails closed, readiness and
nothing else bypassed, every use logged and marked on the decision. A false
entry in the register would have outlived the drill and been indistinguishable
from a real judgement forever after.

| Variable | Meaning |
| --- | --- |
| `ROUTING_FAULT_INJECTION_SECRET` | ≥16 chars. Unset means the injector does not exist. Remove it when the drill is over |

Order that keeps each step checkable:

1. ~~a deterministic test double where the first reader raises a pre-token
   error and the second succeeds, fails, or is cancelled — before any real
   provider~~ — done, above;
2. ~~the per-attempt execution state and the multi-attempt settlement
   contract~~ — done, above;
3. ~~the swap, behind a flag that is off~~ — done, §9.3;
4. staging fault injection on the first provider, confirming in the database
   and the logs: one run, one reservation, two attempts, one settlement, one
   lease release;
5. fallback failure and disconnect-during-fallback, then enable.

This is its own change and should not ride along with the pieces above.

## 10. Record

| Record | Entered by | Date |
| --- | --- | --- |
| Shadow report attested | | |
| Offline quality evaluation attested | | |
| Attempt/manifest boundary attested | | |
| Cohort salt chosen | | |
| First cohort percentage set | | |
