# Human review of the Router evaluation pairs

The model judges grade the pairs; this is how we find out whether people agree
with them. Nothing here decides whether the Router passes. It produces two
numbers of different kinds and keeps them apart.

The procedure is `docs/ops/tomverse-chat-router-evaluation-set.md`. The code is
`lib/routerHumanReviewSample.ts`, `lib/routerHumanReviewSheet.ts`,
`lib/routerHumanReviewSubmission.ts`, `lib/routerHumanReviewAdjudication.ts`
and `lib/routerHumanReviewDiagnostic.ts`.

## The two samples, and why they can never be pooled

**The primary sample** is 60 pairs — 4 from each of the 15 cells — drawn from
an answer bundle and a seed. `drawPrimarySample` has no parameter through which
a verdict, a score or a judge's name could arrive, so "drawn before the judges
were read" is a property of the code rather than a claim in this file. It
estimates how often people agree with the judges: near 80% agreement, 60 pairs
is about ±10pp, which is a direction check on the whole and not a measurement
of any single cell.

**The diagnostic supplement** is at most 2 pairs per cell, chosen *because* the
two model judges read them differently, and drawn only from outside everything
the primary draw has spoken for. It says something about where the judges
differ. It is not a rate, it has no interval, and a percentage from it printed
beside the primary one would be read as though the two measured the same thing.

`npm run check:router-human-review` refuses a pair that appears in both.

## What a reviewer sees

The question, both answers in the order the model judge saw them, and the same
rubric the judges were given — `lib/routerJudgeRubric.ts`, rendered from the
same strings for both. No model id, no provider, no arm, no routing reason, no
model judge's verdict, and none of the internal score, cost, TTFT or generation
time that would let a model be guessed. The sheet type has no field for any of
them, and `sheetBlindnessProblems` checks the rendered page as well.

Two reviewers grade every pair, under different item labels and in different
orders, so neither can compare notes with the other by item number. Where they
split, a third person grades the disputed pairs on an ordinary blind sheet —
they are never shown what the two said — and the majority of three settles it.
Three graders holding three different verdicts is recorded as no consensus and
left out, not broken apart by a rule chosen after the answers were seen.

## The reserve

Two per cell, in an order fixed at the draw. A reserve is spent only when a
pair cannot be reviewed at all: absent from the bundle, no output, an
unparseable submission, an order that disagrees with the bundle. A win, a loss,
a tie or two judges disagreeing are refused by name — replacing on those
grounds selects the sample on the thing it is meant to measure. Substitutions
are append-only and carry the pair they replace, the reason, the time and the
recorder. Nothing spends one automatically; the commands report candidates and
stop there.

## Running it

```
npm run eval:router-human-sheets -- \
  --bundle=<answer-bundle.jsonl> --seed=<integer> --by=<name> \
  --reviewers=<id>,<id> --out=<directory>

npm run eval:router-human-collect -- \
  --sheets=<directory> --bundle=<answer-bundle.jsonl> --by=<name> \
  --submission=<id>=<filled-in.md> --submission=<id>=<filled-in.md> \
  [--adjudication=<id>=<filled-in.md>] --out=<directory>

npm run eval:router-human-diagnostic -- \
  --primary=<directory> --bundle=<answer-bundle.jsonl> \
  --target=<verdicts.jsonl> --reference=<verdicts.jsonl> \
  --seed=<integer> --by=<name> --reviewers=<id>,<id> --out=<directory>
```

None of them make provider calls or cost anything. `eval:router-human-collect`
reads one draw per run — a primary directory or a diagnostic one, never both.

## What goes in this directory

One subdirectory per draw, holding the `manifest.json` (primary) or
`diagnostic-draw.json` (supplement) and, once the review is done,
`settled.json` and `human-verdicts.json`.

`key.json` and the filled-in sheets do **not** belong here. The key says which
item was which pair and which side was which arm; committing it beside a sheet
is the one step between this and an unblinded review.

`npm run check:router-human-review` reads whatever is committed here on every
PR. It passes when nothing is, and it does not decide whether a review is owed.
