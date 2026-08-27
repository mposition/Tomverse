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
  must not be one of the routable models, or the bias has to be measured and
  reported alongside the result.
- **The measurement is a calibration against an independent judge, not a
  self-preference rate.** The earlier `--mode=judge-bias` put the judge's own
  model in the Auto arm on held-out pairs and reported its own-answer win rate.
  That number mixes three things it cannot separate: the two models' real
  quality difference, the judge's preference for its own output, and style
  interactions between them — 50% reads as "no self-preference" only if the two
  models are equally good, which nothing established. What two passes over the
  **same** answers can settle is how far apart two judges are, so
  `--mode=judge-calibration` re-grades one answer bundle with an independent
  judge and reports the paired shift with a pair-level bootstrap interval.
- Reading that shift as self-preference still assumes the independent judge has
  no preference of its own between the two models, which is an assumption
  rather than a result. Human labels on a stratified sample are what ground it;
  `docs/ops/router-human-review/README.md` is how that sample is drawn and
  graded blind.
- The calibration is run on the **development** set. Grading the decision set
  would spend one of its uses (§7), and the harness refuses a calibration whose
  answers came from anywhere else.

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
- judge identity and, when the judge is itself routable, the calibration
  artefact cited for it;
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
# --bundle= keeps the answers, which is what a later pass re-grades.
npm run eval:router-quality -- --mode=pilot \
  --set=docs/ops/router-evaluation-set/development-v0.json \
  --baseline=<model id> --judge=<model id> --seed=<integer> \
  --json=pilot.json --bundle=pilot.answers.jsonl

# §5, step 1. Re-grade the SAME answers with an independent judge. No answers
# are regenerated and the display order is the one the bundle fixed, so the
# only thing that differs between the two passes is who graded.
npm run eval:router-quality -- --rejudge=pilot.answers.jsonl \
  --judge=<independent judge> --json=independent.verdicts.jsonl

# §5, step 2. Compare the two passes. Pure analysis -- it sends nothing.
# The judge under test first, then the independent one.
npm run eval:router-quality -- --mode=judge-calibration \
  --verdicts=pilot.answers.jsonl.<judge>.verdicts.jsonl \
  --verdicts=independent.verdicts.jsonl \
  --seed=<integer> --json=calibration.json

# The run ROUTE-01 cites.
npm run eval:router-quality -- --mode=decision \
  --set=<frozen decision set> --baseline=<pre-registered model> \
  --judge=<model id> --seed=<integer> --preregistered-n=<n> --use-index=1 \
  --calibration=calibration.json --json=decision.json
```

`--mode=judge-bias` still runs and still prints its number as a diagnostic, but
`--judge-bias=<path>` is refused outright: an artefact nobody may cite is not
one the harness should let an operator pay for and then discover is unusable.

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
| a routable judge with no calibration | §5 |
| a calibration of a different judge, compared canonically | this catalogue has an id whose API model is a different model, so an id-level match would accept a calibration of something else |
| a calibration whose reference judge wrote answers in the bundle | it is not independent of what it is grading |
| a calibration graded on the decision set | §7: a calibration is a look, and every look costs a use |
| a calibration over a bundle that stopped short of its planned items | the population stops wherever the money ran out |
| a calibration missing pairs the bundle holds | the comparison is then over the pairs both judges happened to grade |
| a legacy `judge-bias` artefact cited as a calibration | its own-answer rate mixes quality difference with self-preference |
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

## 10.1 Growing the pool to pilot size

§3 needs a 200-item pilot. Counted the way §2 requires — per cell, with a short
cell reported rather than averaged away — that is **14 adopted items in each of
the 15 cells, 210 in total**. Adopted, not drafted: a rejected candidate is
redrafted under a new id and the rejected one stays rejected, so the number of
drafts written will exceed 210.

The pool carries `proposedPilotCellTarget` for that figure. It is deliberately
a different field from `cellTargets`, which is §11's "Strata and cell targets
frozen" record: a proposal and a freeze are different acts by different
parties, and one field holding both would leave no way to tell them apart.

```
# Draft one cell. Refuses a Claude drafter outright and warns on any routable
# family; every item lands status: candidate with its drafter recorded.
npm run draft:router-eval-candidates -- \
  --model=<non-Claude model id> --stratum=coding --cell=ko --count=14 --send

# The sheet a person judges from. One file, prompts inlined, verdicts empty.
npm run make:router-eval-review-sheet -- --batch=<batchId>
```

Three properties of that loop, each answering a way it could go wrong:

- **The drafter is recorded per item**, as provider, model, the version string
  the provider itself returned, and the template hash. §8 makes the drafter a
  confound the reviewer weighs, and "drafted by AI" lets nobody weigh anything.
  A model that returns no version string leaves the field null rather than
  having one guessed for it.
- **Korean cells are never drafted from the English ones.** The drafting
  instruction is given only the cell it is filling, so the other cell's prompts
  are not available to translate, and the instruction says so as well. §2's
  rule is enforced by what the drafter can see, not only by what it is told.
- **Near-duplicates are ranked over the whole pool, not the batch.** Two
  batches that each look varied can repeat each other; a within-batch
  comparison cannot see it. Still advisory: diversity is the reviewer's call.

Collection runs in waves, and each wave waits for review before the next is
drafted, because a systematic flaw in the drafting shows up in the first cell
and drafting all fifteen first would reproduce it 210 times:

| Wave | Cells | What its review is for |
| --- | --- | --- |
| 1 | one stratum's `ko` and `en` | whether the Korean cell reads as translated, whether the two languages are of comparable difficulty, and whether the sheet is judgeable |
| 2 | one cell from each remaining stratum, plus `translation_cross_language` | flaws specific to a stratum, and the cross-language schema |
| 3 | every remaining cell | drafted with waves 1 and 2's rejections applied |

`npm run check:router-quality-eval` prints the fill of every cell — including
the full ones, so that no output cannot mean both "all full" and "nothing
counted" — and turns a short cell into a failure only once a person sets
`pilotReady`. During collection every cell is short, and a check that is red
throughout the work it supervises stops being read.

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

## 11.1 What is waiting on a person, and why it cannot be delegated

The tooling in §10.1 exists so that nothing on this list is waiting on work an
agent could have done. Each row says what makes it a human act — not as a
formality, but because in each case an agent doing it would destroy the thing
the step establishes.

| Waiting on | Why an agent cannot do it |
| --- | --- |
| **Reviewing a batch and recording verdicts** | The drafter's phrasing is the confound (§8). A reviewer who is the drafter cannot detect it, and one who is the drafter's family cannot either. |
| **Adopting items** (`status`, `adoptedBy`, `adoptedAt`) | §8 makes model-drafted items a candidate pool *because* a human decides adoption. An agent adopting its own drafts is the pool adopting itself. |
| **Freezing the cell targets** (`cellTargets`) | §11's record. `proposedPilotCellTarget` is what an agent may write; a number nobody chose is not a target, it is an assumption with a field. |
| **Setting `pilotReady`** | It converts a short cell from work-in-progress into a failure. Only someone who knows collection is finished can say so. |
| **Pre-registering the baseline** (§4) | The point is that it is named *before* the comparison. An agent naming it during the run would make the pre-registration date meaningless, and §10's checker refuses a baseline registered after the run started. |
| **Approving the pilot budget** | It spends money on provider calls. §0 puts the evaluation budget outside this document, with human sign-off. |
| **Running `--mode=pilot`** | Not because the command is hard, but because it is the first spend and the operator decides when. The command is prepared in §10.1; the decision is not. |
| **Computing and pre-registering the final `n`** (§3) | It follows the measured discordance, and choosing it after seeing a result is how a sample size becomes an outcome that was chosen rather than measured. |
| **Judging, or naming the model judge** (§5, §6) | §11: an agent may not act as the adjudicating judge of record. A model judge additionally needs its bias measured and reported. |
| **Freezing the decision set** (`frozenAt`, `frozenBy`) | §7: every look at the decision set costs a use. The freeze is what makes the count meaningful, and a self-entered freeze counts nothing. |
| **Approving `ROUTE-01`** | `approvedBy` in `docs/release-gates/tomverse-chat-v1.yaml`, and `attestedBy` in `lib/autoRolloutReadiness.ts`. Both are people by construction. |

Two of these an agent may *prepare* fully: the pilot command is written out in
§10.1, and the candidate pool is drafted to size. Neither preparation moves the
record, which is the line this document draws.
