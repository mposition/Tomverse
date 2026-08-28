# Memory extraction evaluation instrument — 2026-08-28

`MEMORY-02` and `MEMORY-03` evidence reference. Approved for recording by
@mposition on 2026-08-28.

## What this is, and what it is not

This records the **instrument** those two gates' evaluations will be computed
with: a frozen sample and a frozen scoring contract. It is not a result. No
decision-grade run has been made against either, no metric in the registry has
been measured, and both gates stay `status: pending` with `approvedBy` and
`approvedAt` empty. They stay that way until a decision-grade run and a
model/prompt pair approval are complete, which are separate approvals.

Recording the instrument now is worth doing because the thing a later number
will be checked against has to be pinned before the number exists. A digest
recorded afterwards can be chosen to match.

## The frozen dataset

| | |
|---|---|
| datasetVersion | `mem-eval-succ-4` |
| schemaVersion | 3 |
| supersedes | `mem-eval-succ-3` |
| cases | 1,150 = 1,047 inherited + 103 replacements |
| dataset digest | `0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0` |
| transition manifest digest | `44bc58bad215ed572f1accd74979b19b6708453f37e474734940953edf51a325` |
| source dataset digest (`mem-eval-succ-3`) | `38468da0dce31a144d61d360189b4ce9e1d55e0e914ae66a2d61bfb1e793dc3b` |
| frozen at commit | `0540e0be6b5da4dbd0ebd9cf0259d0f9f58a3e9d` |

Eight cells: `durable_facts` ko 200 · en 200, `assistant_only` ko 125 · en 125,
`sensitive_secrets` ko 125 · en 125, `injection_directives` ko 125 · en 125.

`MEMORY-03`'s adversarial question is carried by the `sensitive_secrets` and
`injection_directives` cells — 500 of the 1,150. `MEMORY-02`'s relevance
question is carried by the other 650. Neither gate is measured by the whole
sample, and neither number exists yet.

## The frozen scoring contract

| | |
|---|---|
| contractVersion | `mem-score-v3.3` |
| descriptor digest | `19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777` |
| approvedOn | 2026-08-28 |
| pendingRules (dataset-satisfiable) | none |
| prompt-pending | `v3-unfixable-evidence-emits-nothing` |
| recorded at commit | `fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4` |

The previous contract stays pinned and unaltered: `mem-score-v3.2`,
`8d6dfef8537cf910a40d175e0bb315bdfaa4e47fa5e89ea3c4bfbc032d9b6e1b`.

### One rule is enforced by the prompt, not by the contract

`v3-unfixable-evidence-emits-nothing` is about what a model emits at run time.
v3.3 split it from the gold-authoring half it used to share an id with, so that
a rule only a model can satisfy stops being counted against a sample.

Approved by @mposition on 2026-08-28: the split does not invalidate the dataset
freeze, **and a paid run before that rule is implemented must be refused by the
run-mode gate.** A verdict produced under a contract whose prompt-side rule
nothing applies would describe a bar that was never applied.

The contract is frozen and cannot learn that a prompt written after it answered
the rule, so the mapping from prompt version to rule id lives outside the
digest, in `lib/memoryEvalPromptRuleImplementations.ts`. It is written by
whoever writes the rule into a prompt and is deliberately not derived by
searching the prompt for words — a paraphrase that dropped the rule would keep
claiming it. `decideEvalRunMode()` refuses `prompt_rule_unimplemented` for any
version the mapping does not cover.

## The extraction prompt

| | |
|---|---|
| promptVersion | `mem-extract-v6` |
| contract digest | `c85389d8360a997fe80e4d8905304c223f67f67b1676fa2df483daf902b05052` |
| supersedes | `mem-extract-v5` (`7bb6b27abce3f29dee70f4defd24d8a65175d7a17ab2b9e8d3846ebcc76de281`, unaltered) |
| register status | `candidate`, `evalBudget: null`, for both `gpt-5-6-luna` and `gpt-5-4-mini` |
| recorded at commit | `b45b4996ff967fe3ccada594d7cf7286a60ef030` |

v6 exists because schema-3 scoring compares a candidate's `polarity` to the
gold's field to field and a v5 candidate has no such field: **no v5 pair can be
scored against `mem-eval-succ-4` at all.** It adds the field, requires an exact
quote beside every citation — checked against the server's own copy of the
message, since Structured Outputs guarantees shape and not truth — and refuses
to emit a candidate from evidence whose polarity a plain reading cannot fix.

Registering the pairs makes them *known*, not funded. Both carry no budget, so
`decideEvalRunMode()` refuses `no_eval_budget`, and §12.5's budget is the
separate approval this document's opening paragraph names.

### What still stands between v6 and a number

The harness scores `mem-eval-succ-3` at schema 2. Pointing it at
`mem-eval-succ-4` means schema-3 scoring — polarity compared field to field and
evidence anchors re-read against the source conversation — and that is not part
of this change. Until it lands, a live run against succ-4 is refused by
`legacy_dataset_schema` on top of everything else above.

## Provenance of the 103 replacements

103 of the 1,150 cases were replaced because their originals could not score
the contract they helped write, or because their golds were corrected.
`lib/memoryEvalSucc4Transition.ts` is the single manifest the exclusion list,
the replacement list, the audit view and the regression provenance all derive
from. The superseded originals are held in
`lib/memoryEvalSucc4Regression.ts`, which no path from the decision set reaches.

Adoption is recorded in `docs/ops/memory-extraction-eval-succ4-adoption.md`:
@mposition reviewed all five replacement tranches on 2026-08-28 and adopted
every one.

## How to reproduce every figure above

Each command is read-only and needs no credentials. Run them in this
repository's clone, on Node 22, after `npm ci`.

```
npm run check:memory-eval-freeze
npm run report:memory-eval-succ4-tranche
npm run report:memory-eval-succ4-assembly
npm run report:memory-eval-succ4-rejections
```

The digests are recomputed and compared on every unit-test run by
`tests/memoryEvalSucc4Manifest.test.mjs`; `check:memory-eval-freeze` fails the
build if any of the nine freeze conditions stops holding.

## CI

| commit | run |
|---|---|
| `22fb4aeb1032a7b3b6f37c07873308d648b9e8f7` (freeze) | https://github.com/mposition/Tomverse/actions/runs/33154411698 |
| `60f89598bfc7f7c5745143c07a98b3ad923d6a5b` (contract v3.3) | https://github.com/mposition/Tomverse/actions/runs/33151805896 |
| `d493c301d5c23d79c7679a457c95d4abd0b95813` (prompt v6, PR Fast Gate) | https://github.com/mposition/Tomverse/actions/runs/33159852303 |
| `d493c301d5c23d79c7679a457c95d4abd0b95813` (prompt v6, DB integration) | https://github.com/mposition/Tomverse/actions/runs/33159852329 |

All four concluded `success`.

The v6 runs are cited against the head commit that was merged rather than
against the squash commit the merge produced: the runs never saw
`b45b4996ff967fe3ccada594d7cf7286a60ef030`, and citing a commit no run was
computed on is exactly the thing this document exists to make checkable.
