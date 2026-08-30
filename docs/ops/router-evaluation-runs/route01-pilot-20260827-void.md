# ROUTE-01 pilot runs 2 and 3 — void

Neither run's numbers may be cited, and neither may be used to size the
decision set. Recorded here rather than deleted: the runs happened, they were
paid for, and what they show about the harness is worth keeping.

| run | status | why |
| --- | --- | --- |
| 3 — 2026-08-27 11:15 UTC | `VOID_GENERATION_VALIDATION_MISMATCH` | 62 empty answer slots, ≥31 pairs affected, ≥14.8% against a 5% ceiling |
| 2 — 2026-08-27 02:33 UTC | `SUSPECT_UNVERIFIABLE` | same code path, kept no bundle, so it cannot be checked either way |

Neither is a decision input and neither is a sizing basis.

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

### The two adjudications, read back from the journal

The journal this run kept
(`docs/ops/router-evaluation-runs/route01-pilot-20260827.json.jsonl`) records
all 210 pairs as `judged` with **zero exclusions**, so what the empty answers
were actually scored as can be read directly. The two named in the refusal
above went both of the two possible wrong ways:

| pair | empty slot | recorded verdict | what it should have been |
| --- | --- | --- | --- |
| `general-en-010` | auto arm only | `baseline` wins | a generation failure of the auto arm — a deterministic loss, not a quality loss |
| `writing-ko-011` | **both arms** | `equivalent` | not judgeable at all — a generation failure of both arms |

These are the two failure directions, and they push the number opposite ways.
The first inflates the measured gap: an arm that returned nothing is scored as
having answered worse. The second deflates it: a pair where **nobody** answered
is scored as a tie and pulls the delta toward zero while inflating the
`equivalent` bucket. A single reported delta contains both, in unknown
proportion.

This is also why simply dropping empty answers would not have been a fix.
Dropping catches the first row and leaves the second scored as a tie — and it
would delete an arm's worst turns from the comparison, flattering whichever arm
fails less gracefully. Both rows are now handled by their own rule: single-arm
empty is a deterministic loss with no judge call, both-arms empty is recorded
as a generation failure of both and never reaches the judge.

**The per-arm origin of the 62 remains unestablished.** The auto arm's deficit
is concentrated in `deepseek-v4-flash` (12% wins against 36% for the same-model
control), and the same-model control being symmetric — auto 16, baseline 18 —
rules out position bias. But the `equivalent` rates are 21% and 24%
respectively, which is not the depressed-tie signature a one-arm concentration
of empties would leave. The run stored no answer text, so nothing here settles
it, and none of it changes the void decision.

## Run 2 — 2026-08-27 02:33 UTC — `SUSPECT_UNVERIFIABLE`

Run [33033630960](https://github.com/mposition/Tomverse/actions/runs/33033630960),
commit `5a9ab87`, 84.8 minutes, $0.386845, 210 of 210, 0 excluded, win-rate
delta **-43.81pp** 95% CI [-53.81pp, -33.33pp], discordance 78.1%.

Same harness, same code path, same absence of any emptiness check. It kept no
bundle, so whether its answers were empty **cannot be established either way**
— which is precisely why it is marked suspect rather than merely re-read. A
run that cannot be checked is not a run that passed.

**Not usable for any decision and not usable for sizing.** Its delta, its
discordance and its 210/0 completion count are all out of scope for citation.

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

## What may not be cited from either run

Stated once, plainly, because a voided run's numbers are exactly the kind that
get quoted later by somebody who did not read this file:

* the win-rate **delta** and its confidence interval, from either run;
* the **discordance** rate, from either run — including as a sizing input;
* any **sizing** conclusion computed from either, `n = 3,345` included;
* the per-cell and per-stratum win rates, which inherit the same defect.

What may be cited is what the runs show about the harness, which is what this
file is for.

## What was changed so this cannot recur

`lib/routerAnswerOutcome.ts` and `lib/routerQualityEvalCore.ts`. An answer is
a typed outcome, an empty one is a deterministic loss for its arm rather than
a dropped pair, both estimates are reported side by side, and
`scripts/check-router-answer-bundle.mjs` refuses a bundle before the expensive
judge is called.

An empty answer is also no longer assumed to be the model's doing.
`rawTextLength === 0` says only that this code holds no text; it does not
establish that the provider sent none, because the text may have been lost
anywhere upstream. So the classification says how far back the emptiness is
actually known to reach:

| classification | what is established | whose failure |
| --- | --- | --- |
| `harness_lost_text` | content existed — raw text non-empty, or the provider billed for output tokens — and this code holds none of it | ours; **voids the run** |
| `observed_empty_at_adapter_boundary` | blank from the adapter boundary onward, cause open | unattributed |
| `provider_confirmed_empty` | the provider finished and reports generating zero output tokens | the model's |

Only the third is the model's behaviour. The middle one is a real failure the
user would have seen with its cause unsettled, and it is reported per failure
with arm, provider, API model, finish reason, usage and trace id rather than
filed under a cause nobody established.

## Run 6 — 2026-08-28 07:12 UTC — measured, but refused by the gate

Run [33150563141](https://github.com/mposition/Tomverse/actions/runs/33150563141),
commit `950f23ad`, 2h44m, $0.5849 of a $2.00 ceiling, 210 of 210 attempted.

**The harness defect is fixed.** Empty answers went from 60 to 3, and
`harnessAttributableFailureCount` from 60 to **0**. The exclusion rate went from
27.6% to **1.4%**, inside the 5% ceiling. The two estimates now agree —
`semanticQualityDelta` −47.83pp [−57.97, −37.20] against
`endToEndOutcomeDelta` −48.57pp [−58.57, −38.10] — which is what three
generation failures out of 210 should look like.

It was refused by the gate on one cell:

```
long_context_conversation/ko  11/14  short      (floor 13/14)
every other cell              14/14
overall                       207/210            (floor 200/210)
```

### The three failures were the end of the run, not a defect of that cell

Read from the artefact rather than inferred:

| pair | model | error | latency | usage |
| --- | --- | --- | --- | --- |
| `long-ko-013` | `deepseek-v4-flash` | `Insufficient Balance` | ~0.6s | none |
| `long-ko-014` | `deepseek-v4-flash` | `Insufficient Balance` | ~0.6s | none |
| `long-ko-015` | `deepseek-v4-flash` | `Insufficient Balance` | ~0.6s | none |

All three are consecutive and they are the **last three items in execution
order**. The DeepSeek account ran out of balance late in the run; the cell they
fell in is where the run happened to be, not what caused them. Nothing about
`long_context_conversation/ko` is implicated, and a re-run should fill it.

This corrects the first reading of this run, which called them likely-transient
provider faults. A refusal in 0.6 seconds with no usage, three times in a row,
at the end of a run, is not a transient fault.

### The attribution was wrong, and is fixed

They were recorded as `attribution: provider`. The provider did not fail — it
refused correctly, because the account behind the key had run out. That is:

```
failure     = provider_error
reason      = provider_account_balance_exhausted
attribution = operational_configuration
```

`operational_configuration` is a fourth attribution for exactly this: ours, but
not the code's, and fixed by topping up rather than by changing anything in
this repository.

Two things follow, and both are now enforced. The run **halts** on this error
rather than continuing — a balance does not come back mid-run, so every later
call fails the same way and one failed item becomes every remaining item. And
the workflow reads DeepSeek's available balance before the first paid call,
refusing to start when it is under the pilot's own ceiling.

### What this run may and may not be used for

* **May** be cited as an operational observation: the harness fix works, and
  the end-to-end shape of a clean run.
* **May not** be used as a calibration source, and did not reach the
  independent judge. The Fable stage was never called and nothing was billed
  for it.
* `n` stays pending. This pilot's 81.6% discordance would size ±3pp at ~3,485,
  but a run that did not clear its own coverage gate does not set `n`.
