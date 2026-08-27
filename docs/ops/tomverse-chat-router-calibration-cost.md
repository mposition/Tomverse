# What the ROUTE-01 judge calibration costs

Approved before it is run, because the run makes real billed provider calls.
Nothing here has been spent: this is the estimate mposition asked for before
approving the spend.

The procedure is `docs/ops/tomverse-chat-router-evaluation-set.md` §5. The
short version of why a new run is needed at all: the 2026-08-27 pilot predates
the answer bundle, so its answers were not kept, and a calibration compares two
judges over the **same** answers. There is nothing to re-grade.

## Method, and what it rests on

The pilot journal records the cumulative cost after each pair and which model
answered each arm. It records no token counts. So the per-call split is
recovered rather than read off:

- 45 of the 210 pairs are ones where the Router chose the baseline model, so
  all three calls were `gpt-5-6-luna`;
- the other 165 are one `deepseek-v4-flash` call and two `gpt-5-6-luna` ones.

Two equations, and the prompt and rubric sizes measured directly
(`estimateRawTextTokens` over the 210 adopted prompts; the judge scaffold from
`judgePrompt("", "", "")`), give the two unknown answer lengths:

| Measured | |
| --- | --- |
| prompt tokens | mean 76.1, P95 152, max 209 |
| judge scaffold | 219 tokens |
| verdict output | 3 tokens (one word) |
| answer cap | 2,048 tokens (`maxOutputTokens` in the harness) |

| Fitted mean answer length | |
| --- | --- |
| `openai/gpt-5.6-luna` | 950 tokens |
| `deepseek/deepseek-v4-flash` | 367 tokens |

**The fit reproduces the run's own total to 0.0%** — modelled $0.3868 against
an actual $0.3868 over 210 pairs. That is the check on the method, and it is
why the projections below are quoted rather than guessed.

Two conventions, both mposition's:

- **Cache discount is taken as zero.** No input is assumed cached and
  `cachedInputPriceMultiplier` is not applied, even where the provider offers
  one. Every figure here is therefore the un-discounted price.
- **Prices are the registry's.** `gpt-5-6-luna` $0.20/$1.20, `deepseek-v4-flash`
  $0.14/$0.28, `claude-fable-5` $10/$50, `claude-opus-4-8` $5/$25, per million
  input/output tokens.

## The cost, by stage

### Stage 1 — regenerate a 210-item pilot, keeping the bundle

`--mode=pilot ... --bundle=pilot.answers.jsonl`

| | Expected |
| --- | --- |
| Auto arm answers (165 deepseek + 45 luna) | $0.0707 |
| Baseline arm answers (210 luna) | $0.2425 |
| Judge grading (210 luna) | $0.0737 |
| **Stage 1** | **$0.3868** |

Answer generation is 81% of it and the judge pass is 19%. That split matters
for the next stage: the judge pass is cheap **because the judge is cheap**, not
because judging is cheap.

### Stage 2 — re-grade the same answers with an independent judge

`--rejudge=pilot.answers.jsonl --judge=<independent judge>`

One judge call per pair. Its input is the question, both answers and the
rubric — about 1,604 tokens on a routed-away pair and 2,193 on a same-model
one — and its output is one word.

| Judge | Expected, 210 pairs | Per pair | Hard ceiling, 210 pairs |
| --- | --- | --- | --- |
| `claude-fable-5` | **$3.678** | $0.01751 | $9.53 |
| `claude-opus-4-8` | **$1.839** | $0.00876 | $4.77 |

The hard ceiling needs no fitted answer length: the harness caps output at
2,048 tokens, so no judge prompt can exceed the longest prompt plus two capped
answers plus the rubric. It is an arithmetic bound, not a percentile.

**This stage is 9.5× the entire pilot.** `claude-fable-5` is $10/$50 per
million tokens against luna's $0.20/$1.20 — 50× the input price and 42× the
output price. The calibration is dominated by it, and the choice of independent
judge is the whole cost decision.

`claude-opus-4-8` costs half as much and is equally independent of both arms
(it resolves to `anthropic/claude-opus-5`, and neither arm is Anthropic). It is
offered as an alternative, not a recommendation: which model makes the better
independent judge is a question about judgement quality, not price, and
mposition has not been asked it.

### Stage 3 — compare the two passes

`--mode=judge-calibration` reads two verdict files and computes. **It sends
nothing and costs nothing.**

## Expected against conservative

| | `claude-fable-5` | `claude-opus-4-8` |
| --- | --- | --- |
| Expected (stages 1+2) | $4.06 | $2.23 |
| With the retry allowance below | $4.47 | $2.45 |
| Conservative ceiling | $10.49 | $5.73 |

The conservative ceiling is stage 1 at the pilot's own P95 per pair ($0.00458
× 210 = $0.96, against a $0.387 expected) plus stage 2 at its arithmetic
ceiling. The pilot's per-pair spread was mean $0.00184, P50 $0.00155, P95
$0.00458, max $0.00588 — a P95/mean ratio of 2.49, which is what a long answer
costs.

### The retry allowance

**+10% on expected**, and it is an allowance rather than a measurement: the
2026-08-27 pilot excluded 0 of 210 items and needed no retries, so there is no
observed failure rate to project.

What the allowance actually covers: the harness does not retry. A failed answer
call excludes the item (`auto_arm_failed`, `baseline_arm_failed`) and the run
continues, so a failure costs whatever calls were already made and nothing
more. Re-covering the excluded items means running them again, at most one
extra pair's cost per failure. 10% covers 21 such items on a 210-item run,
which is four times the 5% exclusion ceiling the procedure already refuses a
report for.

## Recommended `--max-cost-usd`

**These are runaway guards, not budgets.** A run stopped at its cost ceiling is
refused as a calibration source — `calibrationArtefactProblems` rejects a
bundle holding fewer pairs than the run planned, because a population that
stops where the money ran out is not the population. So the ceiling must sit
comfortably above the conservative figure: tripping it wastes everything spent
up to that point.

| Stage | Expected | Recommended `--max-cost-usd` |
| --- | --- | --- |
| 1 — pilot with `--bundle=` | $0.39 | `2` |
| 2 — rejudge with `claude-fable-5` | $3.68 | `12` |
| 2 — rejudge with `claude-opus-4-8` | $1.84 | `6` |
| 3 — calibration | $0 | not applicable, it sends nothing |

Each sits above the stage's arithmetic ceiling with room, and each would still
stop a run that had gone wrong by an order of magnitude.

## For planning: the decision run itself

Not part of this approval, and not to be started before the calibration is
accepted and `n` is activated. At the pre-registered n = 3,345 (223 × 15
cells), on the pilot's answer mix and with `gpt-5-6-luna` judging:

| | |
| --- | --- |
| Expected | $6.16 |
| At the pilot's P95 per pair | $15.34 |
| Recommended `--max-cost-usd` | `25` |

The decision run needs no second judge pass: the calibration is measured on the
development set, because grading the decision set would spend one of its uses
(`docs/ops/tomverse-chat-router-evaluation-set.md` §7).

## What could make these wrong

- **Answer length is fitted, not observed.** The two lengths reproduce the
  pilot's total exactly, but a different pair of lengths summing the same way
  would too. The stage-2 hard ceiling does not depend on them; the expected
  figures do.
- **A new pilot is a new sample.** It re-runs the Router over the same 210
  prompts, so the routed-away mix could differ from 165/45 and shift stage 1.
  The effect is small — the two pair types differ by $0.0012 — but it is not
  zero.
- **Prices move.** `gpt-5-6-sol` was found at $4/$20 official against $5/$30 in
  the registry (`.github/audits/pricing-verification-gpt-5-6-sol-2026-08-27.md`).
  Nothing here uses `gpt-5-6-sol`, but the same drift could apply to any row,
  and every figure above is registry-priced.
