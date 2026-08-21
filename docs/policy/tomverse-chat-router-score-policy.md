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
2. **expected total cost** — what this turn would cost on this model, from the
   pricing registry (`lib/routerCostSignal.ts`): the same input and output
   token counts for every candidate, each model's own price. A comparison, not
   a forecast; nothing bills from it.
3. **recent success rate** — from the per-model health rollup.
4. **time to first token, p95** — from output-token telemetry.
5. **stable model id** — arbitrary, and deliberately so. What it buys is that
   two runs over the same inputs answer the same way.

Criteria 3 and 4 are supplied by the caller, exactly as `unhealthyModelIds`
already is: where a number comes from is the caller's business, and what it
means is this policy's. That is also what keeps `selectRouterModel` pure —
`tests/routerScorePolicy.test.mjs` walks its import graph and fails on anything
that touches a database, the filesystem or the network.

A signal missing for either side means *unknown*. The criterion abstains and
the next one decides. Treating an absent success rate as a perfect one would
rank a model nobody has ever called above one with a measured record.

Two values within these thresholds are the same value:

| Threshold | Value |
|---|---|
| `ROUTER_COST_TIE_EPSILON_RATIO` | 0.05, relative |
| `ROUTER_SUCCESS_RATE_TIE_EPSILON` | 0.01 |
| `ROUTER_TTFT_TIE_EPSILON_MS` | 250 |

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

- **No measured evidence exists.** Every band is neutral, so §5's first
  criterion currently separates nobody and cost decides the first turn of most
  conversations. Auto's disposition today is "the cheapest candidate that
  passed the filters", which is a defensible default and is not a quality
  claim.
- **Criteria 3 and 4 are not wired on the chat path.** `lib/autoModelSelection.ts`
  accepts them and passes them through; no caller supplies them yet, so they
  abstain. Wiring `lib/modelHealthRollup.ts` and the output-token telemetry is
  a separate change with its own freshness questions.
- **Passing the web-search filter is not proof of a search path.** The filter
  in `lib/routerCandidates.ts` checks the *declared* capability only — the
  register says `native`, `search-model`, `unverified` or `unsupported`. A
  `search-model` searches as part of ordinary completion, but a `native` model
  only actually searches when the dispatch also sets `webSearchMode` to
  `always`, builds its tool configuration successfully, and reserves the search
  surcharge. The precise invariant is therefore

  > `needsCurrentInformation` → `search-model`, **or** an approved native tool
  > configuration together with a successful search-cost reservation

  and its second half is an attempt-preflight check, not a candidate filter:
  the filter runs before there is an attempt to configure or a cost to
  reserve. Recorded here so the two halves are not mistaken for one, and so
  nobody closes the second by tightening the first.
- **`ROUTE-01` has not run.** Nothing here may be described as accurate; it can
  only be described as defined.
