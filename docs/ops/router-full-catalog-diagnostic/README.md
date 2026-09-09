# Full-catalogue routing diagnostic

What the Router would do with every model in the catalogue, for every item in
an evaluation set, decided offline by the product's own functions.

```
npm run report:router-full-catalog -- [--set=docs/ops/router-evaluation-set/development-v0.json] \
  [--items=adopted|all] [--plan=Pro] [--requested-model=<id>] [--fallback-flag=off|on] \
  [--json=<out>] [--md=<out>]
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
