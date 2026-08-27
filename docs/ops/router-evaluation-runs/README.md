# Router evaluation runs

Artefacts written by `scripts/eval-router-quality.mjs`, one directory entry per
run. Each run keeps two files:

- `<label>.json` — the report `lib/routerQualityEvalCore.ts` validates.
- `<label>.json.jsonl` — the journal, one line per pair as it completed, with a
  header naming the commit, the set, the baseline, the judge and the seed. A
  run killed part-way leaves this and no report; `--from-journal=<path>`
  rebuilds one from it.

`npm run check:router-quality-eval` does **not** read this directory. Validate a
report by naming it:

```
npm run check:router-quality-eval -- --report=docs/ops/router-evaluation-runs/<label>.json
```

Nothing here is ROUTE-01 evidence yet, and the check says so for every file in
it. `docs/ops/tomverse-chat-router-evaluation-set.md` §7 reserves that for a
`--mode=decision` run against a frozen decision set.

## route01-pilot-20260827

The sizing run of `docs/ops/tomverse-chat-router-evaluation-set.md` §3: measure
the discordance rate so the decision set's `n` is
computed rather than guessed.

| | |
|---|---|
| run | [33033630960](https://github.com/mposition/Tomverse/actions/runs/33033630960) |
| commit | `5a9ab87424c3bc28c1daf55ce54dabce2da1606c` |
| set | `router-eval-development-v0`, frozen 2026-08-26 by mposition, 210 adopted items |
| baseline / judge / seed | `gpt-5-6-luna` / `gpt-5-6-luna` / `20260826`, all pre-registered 2026-08-26 |
| duration / cost | 84.8 minutes, $0.386845 |
| completeness | 210 of 210, 0 excluded |

```
Judged pairs   210  (auto 36 / baseline 128 / equivalent 46)
Discordance    78.1%
Win-rate delta -43.81pp  95% CI [-53.81pp, -33.33pp]
Routed away    78.6%
```

### What it sizes

From the measured discordance, a decision set needs roughly:

| half-width | items |
|---|---|
| ±2pp | 7500 |
| ±3pp | 3334 |
| ±4pp | 1875 |

One of these is pre-registered as `n` **before** the decision set is collected.
Choosing after seeing a result is how a sample size becomes an outcome.

### What it does not establish

Auto lost, and the interval is entirely below zero. It is still not a finding
about Auto's quality, for one reason: **the judge is the baseline model.** The
baseline arm is `gpt-5-6-luna` on all 210 pairs, so the judge graded its own
answer every time. That is the self-preference
`docs/ops/tomverse-chat-router-evaluation-set.md` §5 exists to measure, and
`judge.biasMeasurement` is null.

This run also predates the answer bundle, so there is nothing to re-grade. The
calibration now asked for by
`docs/ops/tomverse-chat-router-evaluation-set.md` §5 compares two judges over
the **same** answers, and these answers were not kept. Measuring it means a
fresh pilot run with `--bundle=`, then `--rejudge=` with an independent judge,
then `--mode=judge-calibration`.

45 of the 210 pairs are ones where the Router chose the baseline model, so both
answers came from `gpt-5-6-luna`. They are worth reporting separately, with
their intervals:

| | n decided | auto share | 95% CI (Wilson) |
|---|---:|---:|---|
| same model both sides | 34 of 45 | 47.1% | 31.5% – 63.3% |
| Auto routed away | 130 of 165 | 15.4% | 10.2% – 22.6% |

**What that does and does not say.** The same-model subset is consistent with an
even split, and with the position figures (52.4% preferred the first answer;
Auto was first 51.9% of the time) it gives no sign of a label or position
effect. It is not enough to rule one out: 34 decided pairs put the interval
between 31.5% and 63.3%, which still admits a substantial effect in either
direction.

Nor is the distance between the two rows evidence about self-preference. The
Router chose which prompts went into which subset, so they are different
populations of question, not a treatment and a control. The contrast says the
losses are concentrated where Auto routed away — an operational fact worth
acting on — and nothing about why.

### Per cell

| stratum / cell | auto | baseline | equivalent | same model |
|---|---:|---:|---:|---:|
| analysis_and_reasoning/en | 1 | 13 | 0 | 1 |
| analysis_and_reasoning/ko | 0 | 14 | 0 | 1 |
| coding/en | 3 | 9 | 2 | 1 |
| coding/ko | 1 | 10 | 3 | 2 |
| current_information/en | 4 | 8 | 2 | 10 |
| current_information/ko | 6 | 7 | 1 | 12 |
| document_and_attachment/en | 1 | 1 | 12 | 2 |
| document_and_attachment/ko | 3 | 7 | 4 | 1 |
| general_question_answering/en | 2 | 10 | 2 | 0 |
| general_question_answering/ko | 1 | 12 | 1 | 0 |
| long_context_conversation/en | 1 | 12 | 1 | 2 |
| long_context_conversation/ko | 2 | 8 | 4 | 6 |
| translation_cross_language/ko-en | 4 | 6 | 4 | 2 |
| writing_and_rewriting/en | 4 | 3 | 7 | 3 |
| writing_and_rewriting/ko | 3 | 8 | 3 | 2 |

Two cells barely test routing: `current_information` sends 10 of 14 (en) and 12
of 14 (ko) to the baseline model, so most of those pairs compare a model with
itself. `writing_and_rewriting/en` is the only cell where Auto is not behind.

`analysis_and_reasoning` is 1 win in 28 across both languages. That is a routing
signal worth investigating on its own, before and regardless of anything the
judge calibration settles.

### A correction to an earlier version of this file

The first version of this record said the control showed "the gap is not an
artefact of arm labelling or answer position". At 34 decided pairs that was
stronger than the data supports, and it has been replaced with the interval
above. mposition caught it.
