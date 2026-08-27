# ROUTE-01 pilot runs 2 and 3 — void

Neither run's numbers may be cited, and neither may be used to size the
decision set. Recorded here rather than deleted: the runs happened, they were
paid for, and what they show about the harness is worth keeping.

## Run 3 — 2026-08-27 11:15 UTC — `VOID_GENERATION_VALIDATION_MISMATCH`

Run [33066583293](https://github.com/mposition/Tomverse/actions/runs/33066583293),
commit `acb14122`, 91 minutes, $0.3868, 210 of 210 items, **0 excluded**.

What it printed:

```
Judged pairs   210  (auto 29 / baseline 144 / equivalent 37)
Discordance    82.4%
Win-rate delta -54.76pp  95% CI [-64.29pp, -44.76pp]
Judge position 49.7% preferred the first answer (auto was first 51.9%)
Routed away    78.6%
```

And what its bundle could not do:

```
artifacts/route01-pilot-20260827.answers.jsonl cannot be judged:
  - pair general-en-010 first answer has no text
  - pair writing-ko-011 first answer has no text
  - pair writing-ko-011 second answer has no text
  ... and 52 more
```

**62 answer slots held no text, and the run excluded none of them.** The
harness took `result.text ?? ""` and the only content gate was the
self-identification rule; an empty string names no model, so empty answers
went to the judge. A judge shown an empty answer beside a real one picks the
real one every time, so part of that -54.76pp is "the model returned nothing"
wearing the clothes of "the model answered worse".

The name is what it is because the writer and the reader disagreed about the
same file: the pilot wrote answers that `answerBundleProblems` refuses, and
found out 91 minutes and $0.39 later.

**Why it is void rather than caveated.** 62 empty slots is at least 31
affected pairs — fewer only if both slots of a pair were empty, and
`writing-ko-011` shows that happens. So the true exclusion rate is at least
31/210 = **14.8%**, against the 5% ceiling
`docs/ops/tomverse-chat-router-evaluation-set.md` §9 already refuses a report
for. That holds whichever arm the empty slots fell on, so the per-arm
breakdown is worth having for root cause and is not needed for this decision.

## Run 2 — 2026-08-27 02:33 UTC — unverifiable / suspect

Run [33033630960](https://github.com/mposition/Tomverse/actions/runs/33033630960),
commit `5a9ab87`, 84.8 minutes, $0.386845, 210 of 210, 0 excluded, win-rate
delta **-43.81pp** 95% CI [-53.81pp, -33.33pp], discordance 78.1%.

Same harness, same code path, same absence of any emptiness check. It kept no
bundle, so whether its answers were empty **cannot be established either way**
— which is precisely why it is marked suspect rather than merely re-read. Its
numbers are not evidence and its discordance is not a sizing basis.

`docs/ops/router-evaluation-runs/README.md` and its record are unchanged as a
record of what was run; this file is what says they may not be cited.

## What this costs

The pre-registered `n = 3,345`
(`docs/ops/router-decision-preregistration/v1.json`) was computed from run 2's
78.1% discordance. Run 3 measured 82.4%, which would size ±3pp at ~3,517 —
**but both discordance figures are contaminated by the same defect**, so
neither is a basis for changing `n`. The registration stays `pending`. When an
uncontaminated pilot has run, `n` is recomputed and the registration is either
confirmed or voided and re-frozen. It is not edited.

## What was changed so this cannot recur

`lib/routerAnswerOutcome.ts` and `lib/routerQualityEvalCore.ts`. An answer is
a typed outcome, an empty one is a deterministic loss for its arm rather than
a dropped pair, both estimates are reported side by side, and
`scripts/check-router-answer-bundle.mjs` refuses a short bundle before the
expensive judge is called.
