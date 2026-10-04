# ROUTE-01 pilot 20260830a — the first run to clear every gate

Run [33312326437](https://github.com/mposition/Tomverse/actions/runs/33312326437),
commit `4122be8a`, 3h06m end to end, $10.4669 total against a $20.00 job
ceiling. Artefact `route01-calibration-20260830a`.

This is the record of what the run produced. It is **not** decision-grade
evidence and does not set `n` — see "What this does not settle" below.

## Stage 1 — pilot

```
Outcome        MEASURED
Pairs          210 = 210 judgeable + 0 single-arm failure + 0 double-arm failure + 0 other
Judged pairs   210  (auto 36 / baseline 137 / equivalent 37)
Discordance    82.4%
semanticQualityDelta   -48.10pp  95% CI [-58.10pp, -37.62pp]  over 210 pair(s) both arms answered
endToEndOutcomeDelta   -48.10pp  95% CI [-58.10pp, -37.62pp]  over 210 pair(s)
               (bootstrap_percentile, seed 20260826)
Excluded       0 (0.0%)
Judge position 50.9% preferred the first answer (auto was first 51.9% of the time)
Routed away    78.6% of judged pairs used a model other than the baseline
Provider cost  $0.5693 of $2.00
Empty answers  0
  by reason    text_normalization_loss 0, output_budget_exhausted 0,
               provider_confirmed_empty 0, undetermined 0, provider_error 0
  by blame     harness 0, provider 0, model 0, operational_configuration 0, undetermined 0
```

**The two deltas are identical, and that is the point.** They differ only where
an arm produced nothing, and nothing was produced empty: 0 empty answers, 0
exclusions, 210 of 210 judged. The distinction that voided two earlier runs has
no work to do here.

Every cell filled completely — 14/14 in all fifteen:

```
analysis_and_reasoning/en   14/14      general_question_answering/en  14/14
analysis_and_reasoning/ko   14/14      general_question_answering/ko  14/14
coding/en                   14/14      long_context_conversation/en   14/14
coding/ko                   14/14      long_context_conversation/ko   14/14
current_information/en      14/14      translation_cross_language/ko-en 14/14
current_information/ko      14/14      writing_and_rewriting/en       14/14
document_and_attachment/en  14/14      writing_and_rewriting/ko       14/14
document_and_attachment/ko  14/14
```

### Against the runs that failed

| | 8/27 (void) | 8/28c (gate-refused) | **8/30a** |
| --- | --- | --- | --- |
| empty answers | 62 | 3 | **0** |
| harness-attributable | 60 | 0 | **0** |
| exclusion rate | 27.6% | 1.4% | **0%** |
| coverage | 210/210* | 207/210 | **210/210** |
| short cells | — | `long_context_conversation/ko` 11/14 | **none** |

\* Counted 210 only because empty answers were sent to the judge rather than
excluded, which is what voided that run.

## Stage 2 — the gate

```
OK — 210 pair(s), every cell above its floor, no bundle problems,
no empty result attributable to this harness, and the pilot finished inside its
ceiling under a frozen call-limit manifest. The independent judge may be called.

judge cost exact input 372308 token(s) = $3.7231
             expected $8.42 (447 out/pair), stress $12.52 (838 out/pair)
             against a $18.00 stage ceiling
worst request $0.5031 of $0.75 allowed (largest rendered input 9350 token(s))
```

## Stage 3 — independent judge

210 verdicts, **$9.8976** against the $18.00 ceiling. The judge-cap probe's
447-tokens-per-verdict figure held: actual spend landed between the projected
expected ($8.42) and stress ($12.52) cases.

## Stage 4 — judge calibration

```
Judge calibration — openai/gpt-5.6-luna against anthropic/claude-fable-5
  pairs            210
  exact agreement  53.8%
  baseline margin  target +48.10pp, reference +7.62pp
  judge shift      +40.48pp  95% CI [+28.57pp, +52.38pp]  (paired bootstrap, seed 20260826)
```

Rows are Luna's verdict, columns Fable's:

| | auto | baseline | equivalent | total |
| --- | ---: | ---: | ---: | ---: |
| **auto** | 22 | 4 | 10 | 36 |
| **baseline** | 30 | 63 | **44** | 137 |
| **equivalent** | 4 | 5 | 28 | 37 |
| **total** | 56 | 72 | 82 | 210 |

**The two judges do not agree.** They match on 53.8% of pairs. Luna reads the
baseline as ahead by +48.10pp; Fable reads it as ahead by +7.62pp. The
difference is +40.48pp with an interval that excludes zero.

The two largest disagreement cells are Luna saying baseline where Fable said
equivalent (44), and Luna saying baseline where Fable said auto (30).

## What `n` would be, under each judge

Both computed with `requiredSampleSize` at ±3pp, then rounded up to a multiple
of 15 so the fifteen cells stay balanced:

| judge | non-tied | discordance | raw ±3pp | balanced |
| --- | ---: | ---: | ---: | ---: |
| Luna | 173/210 | 82.4% | 3,517 | **3,525** (235/cell) |
| Fable | 128/210 | 61.0% | 2,602 | **2,610** (174/cell) |

The pre-registered `n = 3,345` corresponds to neither. It was computed from a
run since voided, and `docs/ops/router-decision-preregistration/v1.json` stays
as it is: a frozen registration is not edited. When a judge is adopted, v1 is
voided and a v2 is frozen with the number that judge implies.

## What this does not settle

`n` is **not frozen from this run**, and the reason is the +40.48pp above:
which judge is the reference changes `n` by 915 items. Choosing between them on
cost, or on which produces the smaller sample, would be choosing the answer.

The judge is decided against human labels, under the rule pre-registered in
`docs/ops/router-judge-selection-rule.md` — written before the labels are
collected, for the same reason `n` is pre-registered before the data.

The pilot itself remains what its own report says it is: not decision-grade,
because its judge is routable and, until that rule is applied, uncalibrated.
