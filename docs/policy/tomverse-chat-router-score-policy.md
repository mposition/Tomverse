# Tomverse Chat Router Scoring Policy

- Status: Proposed for Phase 2 (Router shadow)
- Decision owner: Backend/AI
- Required reviewers: Product/QA, Security/Privacy
- Implementation: `lib/routerScorePolicy.ts`, applied by `lib/routerSelection.ts`
- Canonical release thresholds: `docs/release-gates/tomverse-chat-v1.yaml`
- Routing rules this sits inside: `docs/policy/tomverse-chat-routing.md`

## 1. Scope

This document defines how Auto ranks the models that survived the hard filters
in `lib/routerCandidates.ts`. It covers the quality scale, which models carry a
score, the tie-break order, the stickiness thresholds, and how all of them are
versioned and recorded.

It does not define who may be considered — that is the hard-filter set in
`docs/policy/tomverse-chat-routing.md` §4, and nothing here can outweigh it. It
does not define whether Auto is switched on, which is the cohort and readiness
question in `lib/autoRolloutReadiness.ts`. And it does not establish quality:
`ROUTE-01` is the gate that would, and it has not run.

## 2. Why this is separate from the model finder

Until this policy existed, the Router ranked from `TASK_SCORES` in
`lib/modelFinder.ts` — since renamed `MODEL_FINDER_SCORES` — the table behind
the onboarding wizard that recommends one of six Standard models to a new
account.

Two consequences followed from sharing it, and both are the reason for the
split.

The Router could reach six of the thirty enabled models. The other twenty-four
were absent from the table, scored zero, and fell through to a tie-break that
ordered them by their position in a six-model list none of them appeared in.
They could only be selected when everything ahead of them failed a hard filter.
Premium-reasoning and research models were unreachable as a class.

And a change made for routing would have silently rewritten a product
recommendation. The two consumers already read the table differently — the
wizard adds an order-derived base score plus priority and file-usage scores,
the Router used the task column alone — so a value tuned for one was a
side-effect on the other.

`MODEL_FINDER_SCORES` (the renamed table) is now static product curation for
the wizard, and this policy is versioned operational configuration for Auto.
`tests/modelFinder.test.mjs` pins the wizard's output over every combination of
answers it can be given, so the split cannot quietly become nominal, and
`lib/routerSelection.ts` no longer imports the model finder at all.

## 3. Quality is a band, and it starts neutral

Quality is one of three bands — 1, 2, 3 — never a point score. Three levels is
as much resolution as can be defended today, because nothing has been measured;
a six-point scale would look like a measurement and be read as one.

Every (model, task) cell starts at band 2, neutral. A cell moves only when
`RouterQualityEvidence` names an approved record it moved for. In particular a
band is **not** raised or lowered for:

- price or usage class. Cost is a separate criterion, below, where it can be
  compared against an actual figure;
- capability. Native web search, image input and context length are hard
  filters. Folding a capability into quality would apply it twice — once as a
  rule and once as an opinion — and would let a model that already passed the
  filter be rewarded again for passing it;
- provider reputation, benchmark screenshots, or the shape of a model's
  marketing copy.

`qualityCi95Lower` is null in every cell. The existing `eval:router-quality`
harness compares the Router as a whole against a fixed baseline; it is not a
multi-arm evaluation and produces no per-(model, task) interval. Those need
their own pre-registered protocol, which is a separate piece of work.

## 4. Every enabled model is enrolled

`ROUTER_SCORE_SNAPSHOT` carries an entry for every enabled catalogue model, and
`tests/routerScorePolicy.test.mjs` fails when one is missing. Enrolling a model
is therefore a decision somebody makes when they enable it, rather than an
omission nobody notices.

Each entry records `providerId`. Provider-variant routing is out of scope for
v1, but the same model reached through two providers is two different costs,
latencies and health signals, and a snapshot with nowhere to say which one it
scored would have to be rebuilt rather than extended.

A model absent from the snapshot still routes, at the neutral band. An
unregistered model is unmeasured, not bad, and refusing it would let a
catalogue addition remove a model from Auto silently.

## 5. The tie-break

Applied in order, most decisive first:

1. **quality band** — §3. Within one band, and only when both cells carry one,
   a 95% confidence interval refines the order. The band is a strict primary
   key: letting an interval outrank a band would make the comparison
   non-transitive on a partly-measured snapshot, and the sort result would then
   depend on the order the filters happened to emit.
2. **health degraded** — the health path reports this model misbehaving. Not a
   refusal: refusal is `unavailable`, and that is a hard filter. It sits above
   cost because "this model is currently misbehaving" is a stronger reason to
   pick the other one than "this model is cheaper". A set rather than a rate,
   and absence from it means "not known to be degraded" — a healthy model and
   an unprobed one alike.
3. **expected total cost** — what this turn would cost on this model, from the
   pricing registry (`lib/routerCostSignal.ts`): the same input and output
   token counts for every candidate, each model's own price. A comparison, not
   a forecast; nothing bills from it.
4. **recent success rate** — from real dispatch outcomes (`RoutingAttempt`),
   through `lib/routerSignalCore.ts`.
5. **time to first token, p95** — from the same dispatch rows, measured from
   `dispatchedAt` to `firstVisibleTokenAt`.
6. **stable model id** — arbitrary, and deliberately so. What it buys is that
   two runs over the same inputs answer the same way.

Criteria 2, 4 and 5 are supplied by the caller, exactly as `unhealthyModelIds`
is: where a number comes from is the caller's business, and what it means is
this policy's. That is also what keeps `selectRouterModel` pure —
`tests/routerScorePolicy.test.mjs` walks its import graph and fails on anything
that touches a database, the filesystem or the network.
`lib/routerRuntimeSignals.ts` is the caller-side reader that supplies them, on
a snapshot refreshed at most once per `ROUTER_SIGNAL_SNAPSHOT_TTL_MS`.

### Two populations, never one number

Probes and dispatches both look like they measure success, and they are not the
same measurement. A probe is a synthetic request the scheduler makes to find
out whether a provider answers at all; a dispatch is a person waiting for a
reply. Ranking one model's probe rate against another's dispatch rate would
compare two different questions and report the answer as a preference.

So the split is by what the number decides:

| Source | Decides | Where |
|---|---|---|
| `ProviderProbeResult` | whether a model is a candidate (`unavailable`), and whether it is degraded | hard filter, and criterion 2 |
| `RoutingAttempt` | the order of the candidates that survive | criteria 4 and 5 |

Neither is ever folded into the other, and a model with too few observations on
either gets no entry rather than a provisional number. Under-sampled means the
criterion abstains and the next one decides.

The counted outcomes are fixed so that a rate means one thing across models:
`succeeded`, `failed_pre_token` and `failed_post_token`. `not_dispatched` never
reached a provider, `cancelled` is the person changing their mind, `pending` has
not ended, and `unknown_after_dispatch` is a crash that is evidence neither way.

A signal missing for either side means *unknown*. The criterion abstains and
the next one decides. Treating an absent success rate as a perfect one would
rank a model nobody has ever called above one with a measured record.

Two values within these thresholds are the same value:

| Threshold | Value |
|---|---|
| `ROUTER_COST_TIE_EPSILON_RATIO` | 0.05, relative |
| `ROUTER_SUCCESS_RATE_TIE_EPSILON` | 0.01 |
| `ROUTER_TTFT_TIE_EPSILON_MS` | 250 |
| `ROUTER_SIGNAL_WINDOW_MS` | 24 hours |
| `ROUTER_SUCCESS_RATE_MIN_OBSERVATIONS` | 30 |
| `ROUTER_TTFT_MIN_OBSERVATIONS` | 50 |
| `ROUTER_SIGNAL_SNAPSHOT_TTL_MS` | 60 seconds |

One window for every model, because a rate over the last day compared against a
rate over the last week is not a comparison. The minimum counts are what stop a
number being reported before it can carry the epsilon above it: at ten attempts
the smallest expressible success-rate difference is ten points, and a p95 over
twenty points is simply the largest of them.

Without them the cost criterion decides every tie on the fourth decimal place
of a price, and the Router reshuffles itself over a rounding difference while
reporting a confident reason for it.

## 6. Stickiness, in the units of this scale

`ROUTER_STICKY_SWITCH_MARGIN_BANDS` is 1: a challenger must be a full band
better than the model the conversation is on. `ROUTER_STICKY_HYSTERESIS_TURNS`
is 2: it must be that much better on two consecutive turns.

The margin was 2 before this policy, in the old table's 0-to-12 point units,
where 2 was a small step. On a three-level scale the same literal would mean
"only a 1-to-3 jump ever switches" — a different policy wearing the old
policy's number. This is why the scale, the margin and the hysteresis carry one
version between them.

**A consequence to state plainly:** while every band is neutral, no challenger
can clear the margin, so Auto keeps its model until that model fails a hard
filter. That is the correct behaviour for a scale with no measurements in it —
there is no evidence on which to move anyone — and it means the first approved
evidence record is also the first thing that can make Auto switch mid
conversation. A cheaper or faster model is a reason to have started somewhere
else, not a reason to change models mid-conversation, so criteria 2 to 4 rank
the first turn and never trigger a switch.

The task profile's own confidence band is used rather than recorded and
ignored:

- `kindConfidence: "none"` — the turn's kind rests on no signal at all. It
  ranks on the `general` column, not on the kind's. An unsupported kind must
  not steer routing to a specialist. Today's profiler only ever reports `none`
  together with `general`, so this is an invariant rather than a visible
  change, and it is written as a rule so the next profiler version cannot lose
  it by accident.
- `kindConfidence: "weak"` — one rule fired. The kind stands, but a switch
  needs `ROUTER_WEAK_CONFIDENCE_EXTRA_TURNS` (1) more consecutive turns. The
  honest use of a band that is explicitly not a probability is to make an
  ambiguous turn move the conversation more slowly, not to weight it by an
  invented factor.

`expectedOutputLength` stays recorded and unused. Turning a coarse reading of
the request into a routing input — or into dollars, in criterion 2 — would give
an uncalibrated label authority it has not earned.

## 7. Versioning and what is recorded

`ROUTER_SCORE_POLICY_VERSION` covers the whole bundle: the band scale, the
snapshot, the tie-break order, the thresholds in §5, the switch margin and the
hysteresis turns. Any change to any of them is a new version.

It is recorded on `RoutingRun.selectionPolicyVersion`, beside the task-profile,
candidate-filter, selection and estimator versions, and it travels in
`RouterVersions.scorePolicy` through `lib/routerDecision.ts`. It is its own
version rather than an implied part of the selection version because the rule
and the numbers it applies move independently — a band changing is not the
comparator changing — and a run recorded with only one of the two can be
attributed to neither.

The column is nullable. Rows written before the policy existed had none, and a
manual turn the Router never decided ran under no policy at all; both are
recorded as null rather than backfilled with a claim.

Everything recorded stays content-free, per `docs/policy/tomverse-chat-routing.md`
§2: fixed identifiers, model ids, counts and version strings. `selectionDecidedBy`
— which tie-break criterion separated the top two — is a fixed identifier from
§5 and operator telemetry only. It is never rendered: the user-facing reason
stays `task_preference` or `fallback_order`, because splitting it per criterion
would put the Router's cost and latency comparisons into chat copy.

## 8. Known gaps

These are gaps in what is implemented, recorded here rather than left for a
reader to discover.

- **No measured quality evidence exists.** Every band is neutral, so §5's first
  criterion currently separates nobody and cost decides the first turn of most
  conversations. Auto's disposition today is "the cheapest candidate that
  passed the filters", which is a defensible default and is not a quality
  claim.
- **The measured criteria are wired, and mostly have nothing to say yet.**
  `lib/routerRuntimeSignals.ts` supplies them from a cached snapshot, and both
  sources are thin:

  - probes cover about ten of the thirty enabled models, because
    `getProbeModelFor` probes one model per provider — the cheapest standard
    one — and none of Perplexity's, whose every model is search-backed. A
    probe result is never spread to a provider's other models: that would be
    ranking one model on another's traffic.
  - `RoutingAttempt` is written only when `ROUTING_DISPATCH_INSTRUMENTATION` is
    `observe` or `enforce`, and it defaults to `off`. Until it is switched on,
    the success-rate and TTFT maps are empty and criteria 4 and 5 abstain on
    every turn.

  Both are the designed behaviour rather than a defect — an absent observation
  abstains — but neither should be described as a live signal until its source
  is populated. Switching the instrumentation on is an operational decision
  with its own volume and retention questions.

- **The hard health filter admits confirmed failures only.** `unavailable`
  excludes a model from Auto; `degraded` keeps it as a candidate and demotes it
  at criterion 2; `unknown` excludes nobody. Excluding on `unknown` would take
  the twenty unprobed models out of Auto for want of a probe, and uncertainty
  is not a verdict. A verdict is honoured only while the probe behind it is
  fresh (`PROBE_FRESHNESS_WINDOW_MS`), so a stale failure stops excluding
  rather than excluding forever, and recovery uses
  `evaluateProviderFailureHealth`'s existing trailing-success rule rather than
  a second one.

- **The Router's provider verdict is probe-derived, not the public status
  page's.** That page merges real-traffic heartbeats and operator-declared
  incidents, and reaching its verdict needs a bucket-derived `internalStatus`
  this path does not compute. The blind spot has a name: a provider failing
  real traffic while its probes pass is not excluded. It is not invisible —
  that shows up as the model's own dispatch success rate, in the tie-break.

- **A degraded model is not labelled for the user.** The demotion is internal.
  Manual selection of a degraded model stays possible and says nothing about
  its state, which is a UI question this policy does not answer.
- **Passing the web-search filter is not proof of a search path, and the
  remaining half is a product decision.** The filter in
  `lib/routerCandidates.ts` checks the *declared* capability — the register
  says `native`, `search-model`, `unverified` or `unsupported`. A
  `search-model` searches as part of ordinary completion, but a `native` model
  only actually searches when the dispatch also sets `webSearchMode` to
  `always`, builds its tool configuration, and reserves the search surcharge.
  The invariant is

  > `needsCurrentInformation` → `search-model`, **or** an approved native tool
  > configuration together with a successful search-cost reservation

  and its second half is an attempt-preflight fact, not a filter one: the
  filter runs before there is an attempt to configure or a cost to reserve.

  It is now computed there. `resolveAttemptSearchPath()`
  (`lib/webSearchPath.ts`) answers it from what the attempt actually carries —
  read off the built plan rather than rebuilt, so the check cannot pass for a
  request that dispatched no tools — and every plan carries the answer, with a
  fixed identifier for which half failed.

  Two of the three cases are closed:

  - a turn whose primary offered a provider-native tool never falls back at
    all, which `lib/autoFallbackGate.ts` already enforced: a search may have
    run and been surcharged by then;
  - a turn whose primary was a `search-model` may fall back, and now refuses a
    candidate that would answer from training data instead. §10's rule that a
    fallback may not silently change what the user was allowed to get reads in
    this direction too.

  What stays open is the primary of a routed turn whose profile needs the web
  while the account's web search mode is `auto` or `off`. The filter admitted a
  native model *because* it can search; on that turn it will not. The dispatch
  records it (`chat_auto_search_path_missing`, model id and gap identifier
  only) and answers anyway, because the alternatives — refusing a turn the user
  would rather have answered imperfectly, or switching search on for someone
  who set the mode to `off` and billing them the surcharge — are product
  decisions with a cost either way. Recorded rather than chosen here.

- **`ROUTE-01` has not run.** Nothing here may be described as accurate; it can
  only be described as defined.
