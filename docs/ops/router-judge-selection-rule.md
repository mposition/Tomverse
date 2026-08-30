# How the ROUTE-01 judge is chosen

Pre-registered on 2026-08-30, **before any human label is collected**, and for
the same reason `n` is pre-registered before the data: a rule written after
seeing which judge it favours is not a rule.

## Why this document exists

`docs/ops/tomverse-chat-router-evaluation-set.md` §5 defines how human review is
run. It does not define what the review is *for* — how the result picks a judge.
`scripts/check-router-quality-eval.mjs` has the same gap from the other side: it
checks that a calibration artefact is complete and well formed, and it has no
opinion on whether the number in it is acceptable.

Pilot 20260830a made that gap load-bearing. The two pre-registered judges
disagree by **+40.48pp** on baseline margin, 95% CI [+28.57pp, +52.38pp], over
the same 210 answers, agreeing exactly on 53.8% of them
(`docs/ops/router-evaluation-runs/route01-pilot-20260830a.md`). Which one is the
reference changes the required `n` from 3,525 to 2,610.

A disagreement that size is not settled by another model. It is settled by
people, or not at all.

## The reference

**The final human adjudicated verdict on the 60 primary pairs.** Not the
diagnostic supplement, and not any model.

`lib/routerHumanReviewSample.ts` draws the primary sample; two reviewers grade
each pair blind (`scripts/router-human-review-sheets.mjs`), and disagreements go
to a third reviewer, also blind
(`scripts/router-human-review-collect.mjs`). The adjudicated verdict is the
reference for everything below.

## What is computed, for each judge

Luna and Fable are measured against the same human labels, on the same pairs:

1. **Exact agreement** — the fraction of pairs where the judge's verdict equals
   the human verdict.
2. **Margin shift** — `judge baseline margin − human baseline margin`, in
   percentage points. Signed, and reported with its sign.
3. **Opposite-verdict rate** — the fraction where one says `auto` and the other
   says `baseline`. Not "disagreed"; reversed.
4. **A pair-level bootstrap 95% CI for each**, on the same seed the run used.

## How the judge is picked

**Primary criterion: the smaller `|margin shift|` against the humans.** ROUTE-01
decides on a margin, so the judge that misstates the margin least is the judge
whose error matters least. A judge can agree pair-by-pair more often and still
be worse here, if its disagreements all lean one way.

**Second: exact agreement**, used when the margin shifts cannot be told apart.

**Safety rail: the opposite-verdict rate.** A judge that reverses verdicts
against people is not adopted on a good margin figure — two errors that cancel
in aggregate are still two errors, and they will not cancel on a different
sample.

**Neither is adopted** when the two cannot be statistically distinguished, or
when both are far from the humans. In that case the next step is a larger human
sample or a third judge. It is **not** the cheaper judge, and **not** the one
implying the smaller `n`: both of those choose the answer.

The diagnostic supplement is for root-cause reading only. It does not enter
agreement, the intervals, or the selection.

## What 60 pairs can and cannot do

The primary sample is sized for **direction**, at roughly ±10pp
(`docs/ops/tomverse-chat-router-evaluation-set.md` §5). It can say which judge is
clearly closer to people. It **cannot** certify that the adopted judge's
residual bias is smaller than ROUTE-01's −2pp decision boundary — that is a
finer question than 60 labels can answer, and claiming otherwise would put a
±10pp instrument behind a 2pp decision.

So adopting a judge under this rule licenses computing `n` and running the
decision set. It does not license treating the adopted judge as unbiased. Any
report that turns on a margin near −2pp has to say that its judge was selected
at ±10pp resolution.

## After a judge is adopted

1. Recompute the discordance over all 210 pairs of a qualifying pilot, under the
   adopted judge.
2. Size `n` at ±3pp, then round **up** to a multiple of 15 so the fifteen cells
   stay balanced.
3. Void `docs/ops/router-decision-preregistration/v1.json` and freeze a v2 with
   that number. The existing registration is never edited — a version whose
   numbers change is not a registration.
