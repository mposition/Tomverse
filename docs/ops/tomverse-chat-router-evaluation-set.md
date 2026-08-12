# Tomverse Chat Router evaluation set

- Status: **draft.** Agree the procedure before writing batches; anything
  written earlier is a candidate pool only.
- Owner: Backend/AI, with Product/QA as adjudication owner
- Satisfies the evidence required by `ROUTE-01` and `PLANNER-01` in
  `docs/release-gates/tomverse-chat-v1.yaml`
- Companion to `docs/ops/memory-extraction-eval-dataset.md`, which uses the
  same division of labour

The gate registry decides *what must be met*. This document decides *how the
evidence is produced and what is recorded*. Execution, adjudication and
sign-off are human. An agent may update the procedure here, but may not enter
the freeze record or the approval record — the same rule the memory eval
dataset follows, and the same rule `approvedBy` enforces in the gate registry.

Question collection has the longest lead time in Phase 0, which is why this
starts alongside the parity baseline rather than after it.

## 0. What this document does not decide

- whether the Router passes (`ROUTE-01`'s threshold does, and the harness computes it);
- gate status or approval (`docs/release-gates/tomverse-chat-v1.yaml`);
- the evaluation budget (human sign-off);
- whether Auto ships to a wider cohort (a separate rollout decision).

## 1. What is actually measured

Not "did the Router choose the right model". There is no ground truth for the
best model on a free-form question, and inventing one would measure agreement
with whoever wrote the key rather than answer quality.

What is measured is **answer quality, paired and blind**: the same question is
answered once by Auto and once by the pre-registered fixed-model baseline, and
a judge states which answer is better, or that they are equivalent. The
win-rate delta over those pairs is `ROUTE-01`'s metric.

`PLANNER-01` uses the identical protocol with `planned` versus `pass_through`
as the two arms.

## 2. Sample structure

Strata are managed as independent cells. A cell that misses its target makes
the whole set unjudgeable, reported as `UNDERPOWERED` rather than averaged away.

| # | Stratum | Cells | Why it is separate |
| --- | --- | --- | --- |
| 1 | General question answering | ko / en | the default path; largest share of real traffic |
| 2 | Writing and rewriting | ko / en | style-sensitive; where model differences are most visible |
| 3 | Coding | ko / en | correctness is checkable, so judge noise is lowest here |
| 4 | Analysis and reasoning | ko / en | where routing to a stronger model should pay off |
| 5 | Translation and cross-language | ko-en | the Router's language signal has to survive mixed input |
| 6 | Current information | ko / en | exercises the web-search capability filter |
| 7 | Document and attachment | ko / en | exercises context size and the image/PDF filters |
| 8 | Long-context conversation | ko / en | the stratum most likely to trigger Pass 2 |

Korean is a first-class cell in every stratum, not a translation of the
English one. Translated prompts measure translation quality, not Korean usage.

## 3. How large the set must be

**500 items is not enough for the margin `ROUTE-01` states.** This is the
single most important planning fact in this document, because it sets the
collection lead time.

`ROUTE-01` requires the **lower bound of a 95% confidence interval** on the
win-rate delta to be at or above -2pp. In a paired design, ties do not move the
estimate, so the interval is driven by the discordant pairs: with a discordance
rate `d` over `n` items, `SE ≈ sqrt(d / n)`.

At n = 500:

| Discordance | 95% CI half-width | Point estimate needed to clear -2pp |
| --- | --- | --- |
| 10% | ±2.8pp | +0.8pp |
| 15% | ±3.4pp | +1.4pp |
| 20% | ±3.9pp | +1.9pp |
| 30% | ±4.8pp | +2.8pp |
| 40% | ±5.5pp | +3.5pp |

So a 500-item set can only pass if Auto *wins clearly*. If Auto lands at
genuine parity — the expected and perfectly acceptable outcome for a router
whose value is cost and latency rather than raw quality — a 500-item set
returns an interval too wide to clear the bound, and the gate fails on
insufficient evidence rather than on insufficient quality.

For a ±2pp half-width:

| Discordance | Items needed |
| --- | --- |
| 10% | ~960 |
| 15% | ~1,440 |
| 20% | ~1,920 |
| 30% | ~2,880 |
| 40% | ~3,840 |

**Do not guess the discordance rate; measure it.** Run a 200-item pilot across
all strata, observe the discordance, then compute and pre-register the final
`n` before collecting the rest. Sizing after seeing the full result is how a
sample size becomes an outcome that was chosen rather than measured.

Three ways to reduce the required `n`, to be decided at pilot time rather than
mid-analysis:

- **graded scoring instead of binary preference** — lower per-item variance, so
  fewer items, at the cost of a harder rubric to keep consistent;
- **non-inferiority per critical stratum only**, with the rest reported but not
  gating — smaller total, but the choice of critical strata must be
  pre-registered;
- **widening the margin** from -2pp — a threshold change, so it goes through
  YAML diff review under `governance.thresholdChangeRequires`, not through this
  document.

## 4. The baseline is pre-registered

"Non-inferior to the fixed-model baseline" is only meaningful if the baseline
is named **before** the comparison runs. Choosing it afterwards means choosing
the comparison that flatters Auto.

Record, before any decision-set run: the baseline model id, its catalogue
version, why it was chosen, and the date. If the baseline model is retired or
repriced mid-evaluation, that invalidates the run rather than silently
substituting a successor.

## 5. Blinding and ordering

- The judge sees the question and two answers. It does not see which arm is
  Auto, which model produced either answer, or the routing reason.
- Answer order is randomised per item, and **the seed is recorded** —
  `ROUTE-01`'s evidence requires it, and without it the run cannot be replayed.
- Model self-identification ("As an AI model developed by …") is stripped before
  judging, and an item whose answer still identifies its model is excluded and
  logged rather than silently kept.
- A model judging its own output is a known bias. If a model judge is used, it
  must not be one of the routable models, or the bias has to be measured on a
  held-out subset and reported alongside the result.

## 6. Rubric

One rubric across all strata, with per-stratum notes. The judge answers a
single question — *which answer better serves the person who asked?* — with
these tie-breakers in order:

1. **Correctness.** Factual or logical error outweighs everything below it.
   In the coding stratum this is checkable; check it rather than judge it.
2. **Instruction compliance.** Format, length, language, and explicit constraints.
   Answering in the wrong language is a failure, not a style difference.
3. **Usefulness.** Does it resolve the request, or only describe it.
4. **Grounding.** In the current-information stratum, sourced claims beat
   confident unsourced ones.
5. **Concision.** Only as a tie-break; length is not quality.

"Equivalent" is a first-class verdict and must not be discouraged. Forcing a
preference on genuinely equal answers inflates discordance, which widens the
interval and makes the gate harder to clear — the opposite of what forcing a
choice is meant to achieve.

## 7. Development set and decision set are separate

Two disjoint sets, split before any Router tuning begins:

- **development set** — used while tuning rules, thresholds, hysteresis and
  Planner templates. May be looked at freely.
- **decision set** — used only to produce `ROUTE-01` / `PLANNER-01` evidence.
  Every look at it costs a use; repeated runs against it while tuning report
  how well the Router fits its own test set.

If the decision set is exhausted by repeated runs, it is replaced, not reused.

## 8. Sourcing rules

- Real usage first. Anonymised, consented Tomverse questions are the best
  source because they carry the distribution the Router will actually meet.
- Model-drafted questions are a **candidate pool only**; a human decides
  adoption. A set drafted by a routable model measures how well that model
  handles its own phrasing.
- No personal data, credentials or customer-identifying content enters the set,
  even from real traffic — the same filter memory extraction applies.
- Record per item: stratum, cell, language, source (real / drafted / adapted),
  the adopter, and the adoption date.

## 9. What each run records

`ROUTE-01`'s evidence line requires all of these, and the harness must emit
them rather than leaving them to a write-up:

- evaluation set version and cell counts;
- baseline model id and catalogue version, with its pre-registration date;
- Router, Estimator, Planner and template versions;
- sample size, and the count of discordant pairs;
- the paired evaluation unit (one question, two arms);
- confidence-interval method;
- randomisation seed;
- point estimate and both 95% bounds;
- judge identity and, when a model judge is used, its bias measurement;
- excluded items with reasons.

Absent any of these, the run is not decision-grade evidence, whatever number it
produced.

## 10. The harness

The procedure above is implemented by `npm run eval:router-quality`, and the
arithmetic by `lib/routerQualityEvalCore.ts`. Three modes, kept apart on
purpose — "run it and see, then decide how big it should have been" is how a
sample size becomes an outcome that was chosen rather than measured:

```
# §3. Measure the discordance rate so `n` is computed, not guessed.
npm run eval:router-quality -- --mode=pilot \
  --set=docs/ops/router-evaluation-set/development-v0.json \
  --baseline=<model id> --judge=<model id> --seed=<integer> --json=pilot.json

# §5. Only where the judge is itself one of the routable models.
npm run eval:router-quality -- --mode=judge-bias \
  --set=<development set> --baseline=<other model> --judge=<routable judge> \
  --seed=<integer> --json=judge-bias.json

# The run ROUTE-01 cites.
npm run eval:router-quality -- --mode=decision \
  --set=<frozen decision set> --baseline=<pre-registered model> \
  --judge=<model id> --seed=<integer> --preregistered-n=<n> --use-index=1 \
  --judge-bias=judge-bias.json --json=decision.json
```

`npm run check:router-quality-eval` validates what came out. It runs on every
PR against the committed set files, and takes `--report=<path>` for a run.
What it refuses, and why each one would otherwise read as a pass:

| Refusal | Why it matters |
| --- | --- |
| a pilot or bias report cited as evidence | a pilot's numbers are formatted identically to a decision run's |
| a run against the development set | §7's split is the entire reason the decision set is worth anything |
| a run truncated by `--max-cost-usd` | a partial set still produces a real-looking interval |
| `--use-index` above 1 | §7: a reused decision set reports Router fit to its own test set |
| a baseline pre-registered after the run started | §4, and the dates are in the record, so it is checkable |
| a routable judge with no bias measurement | §5 |
| exclusions above 5% of pairs | they land on the Auto arm, so the survivors are the items Auto managed to answer |
| a judge preferring the first answer above 65% of the time | that is a judge reading position, not quality |

Two things the harness will not do, because neither is its decision: it never
touches the gate registry, and a `measured` run that misses the margin exits
zero. It measured what it set out to measure; whether that clears -2pp is
`ROUTE-01`'s call, and whether Auto ships is a separate one again.

Reported beside the delta, never subtracted from it: the share of judged pairs
where the Router chose something other than the baseline. A Router that picked
the baseline every time would score exactly zero with a tight interval and
clear the gate honestly — its answers really are non-inferior — but "Auto
passed the quality gate" would then be read as "its choices are good" when it
means "it hardly makes any". The number keeps the two readings apart.

`docs/ops/router-evaluation-set/development-v0.json` is a drafted candidate
pool covering every cell in §2. It exists so the harness can be run at all. It
is not a set: nothing in it is adopted, §8 forbids an agent adopting anything,
and `lib/routerQualityEvalSet.ts` refuses to let a development file stand in
for a decision one.

## 11. Sign-off

An agent may draft candidates, run the harness, and update this procedure. An
agent may not adopt items into the decision set, act as the adjudicating judge
of record, approve the budget, or enter the records below.

| Record | Entered by | Date |
| --- | --- | --- |
| Procedure agreed | | |
| Strata and cell targets frozen | | |
| Pilot complete, discordance measured | | |
| Final `n` pre-registered | | |
| Baseline pre-registered | | |
| Decision set frozen | | |
