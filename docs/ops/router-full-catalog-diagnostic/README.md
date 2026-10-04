# Full-catalogue routing diagnostic

What the Router would do with every model in the catalogue, for every item in
an evaluation set, decided offline by the product's own functions.

```
npm run report:router-full-catalog -- [--set=docs/ops/router-evaluation-set/development-v0.json] \
  [--items=adopted|all] [--plan=Pro] [--requested-model=<id>] [--fallback-flag=off|on] \
  [--json=<out>] [--summary-json=<out>] [--md=<out>]
```

The committed files are regenerated with the defaults:

```
npm run report:router-full-catalog -- --quiet \
  --md=docs/ops/router-full-catalog-diagnostic/development-v0.md \
  --summary-json=docs/ops/router-full-catalog-diagnostic/development-v0.summary.json \
  --json=artifacts/router-full-catalog/development-v0.full.json
```

`lib/routerFullCatalogDiagnostic.ts` calls `decideRouterModel` for the
decision and `filterRouterCandidates` / `selectRouterModel` again only to
explain it; `consistency` on every item says whether the explanation agreed
with the decision, and a disagreement is reported rather than reconciled. No
band is moved, no interval invented, no model promoted: an unmeasured model is
shown as unmeasured.

Per item it records every model's disposition (primary, fallback candidate, or
refused with the filter's own reason), the quality cell and whether any
approved evidence stands behind it, the criterion each loser lost to the
primary on, the ranked fallback candidates with the fallback gate's answer
under the shipped flag and with the flag on, and the output cap the Router
routed under beside the one dispatch will apply to the chosen model.

Whether a turn could reach a fallback is answered in the product's own
order (`app/api/chat/route.ts`, `attemptFallback`) with the product's own
functions where an offline report can call them: the gate
(`autoFallbackScope`) must allow it, `decideFallback` -- called, under the
one failure hypothesis the fallback path exists for (`FALLBACK_FAILURE_HYPOTHESIS`:
the primary failed at the provider before any token was shown) -- names a
candidate, and dispatch must fit that one candidate under its own cap, since
the product tries no other. `fallback.decision` is `decideFallback`'s answer
as given; `fallback.firstCandidate` is that candidate as dispatch would fit
it; `fallback.reachableAsDeployed` and `fallback.reachableIfFlagOn` are the
three-step answer, each refusal naming the step that said no
(`gate:<reason>`, `decision:<reason>`, `candidate_context_window_exceeded`).

Three things are kept apart by name, because an offline report can answer
only the first:

- **the offline diagnosis** -- `reachableAsDeployed` / `reachableIfFlagOn`:
  which candidate is reachable on the given inputs, with the product's own
  gate and decision, and each refusal's reason;
- **the conditions this report cannot verify** -- `unverifiedConditions` on
  every reachable answer: the account's credits and the provider budget
  (`budget_refused`), the runtime registry row (`candidate_unavailable`),
  the primary's provider reservation (`no_provider_hold`), and the request's
  search path (`search_path_unavailable`);
- **the pre-dispatch check** -- what decides on a real request, in
  `planAttemptExecution` and the route around it, against exactly those
  conditions.

So a reachable answer carries `execution: "unverified"` and is never called
executable. `planAttemptExecution` is not called here: it builds the
provider client and the credit budget for a real dispatch, which an offline
report has no account, credentials or reservation for.
`fallback.notModelled` repeats the hypothesis and the unverified list.

## What the product has that this does not

The product routes over the runtime registry's rows, with health exclusions
and measured tie-break signals from the database, under the account's plan
and credits, with the conversation's sticky state. This runs over the static
catalogue in `lib/models.ts`, with no sticky state and no measured signals,
so cost from the pricing registry decides every tie. A model an operator has
disabled in the registry is absent from the product's candidate list and
produces no rejection row there; here the static catalogue's disabled rows
are refused as `disabled`. The report's `inputs` block records what was used.

## Files

- `development-v0.md`: the report on the 210 adopted items, plan Pro, routed
  under `gpt-5-6-luna`'s cap, fallback flag off.
- `development-v0.summary.json`: the same run with per-item decision,
  rejections, caps, fallback and evidence; per-model rows are in the full
  JSON the script writes under `artifacts/`, which is not committed.
