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

## The correction, and what it moved

The instrument below was first recorded as `mem-eval-succ-4` bound to
`mem-score-v3.3`. It is now `mem-eval-succ-5` bound to `mem-score-v3.4`, and
**the sample did not change** — the same 1,150 cases, the same dataset digest,
not re-reviewed.

`mem-score-v3.3` records `schemaVersion: 2` in its own descriptor while
scoring schema 3. It read the run-mode gate, which answers a different question
and held the same number until the gate moved to 3 on 2026-08-28. The digest of
that mistake is pinned here, in the release-gate registry, in succ-4's manifest
and in the adoption record, so it could not be edited in place; and a
decision-grade number computed under a contract whose own description of itself
is wrong is not something this document could repair by noting it
(@mposition, 2026-08-28).

So the correction is forward-only. v3.3 and succ-4 are preserved exactly as
frozen and are **excluded from decision-grade runs**; v3.4 records the 3 it
always scored; succ-5 carries succ-4's cases under it.
`harnessTargetBindingFailures()` refuses any dataset bound to a superseded
contract, so the exclusion is a gate rather than a note.

## The frozen dataset

| | |
|---|---|
| datasetVersion | `mem-eval-succ-5` |
| schemaVersion | 3 |
| supersedes | `mem-eval-succ-4` (contract descriptor correction; cases inherited whole, not re-reviewed) |
| cases | 1,150 = 1,047 inherited + 103 replacements, via succ-4 |
| dataset digest | `0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0` (succ-4's, unchanged) |
| manifest digest | `215b679444c610928975c63b8c095f98eefb0d0bd22f28acff3255fcaf464762` |
| transition manifest digest (succ-3 → succ-4) | `44bc58bad215ed572f1accd74979b19b6708453f37e474734940953edf51a325` |
| source dataset digest (`mem-eval-succ-3`) | `38468da0dce31a144d61d360189b4ce9e1d55e0e914ae66a2d61bfb1e793dc3b` |
| cases frozen at | `0540e0be6b5da4dbd0ebd9cf0259d0f9f58a3e9d` (see **Commits and CI**) |
| approved as a contract-only successor | @mposition, 2026-08-28 |

Eight cells: `durable_facts` ko 200 · en 200, `assistant_only` ko 125 · en 125,
`sensitive_secrets` ko 125 · en 125, `injection_directives` ko 125 · en 125.

`MEMORY-03`'s adversarial question is carried by the `sensitive_secrets` and
`injection_directives` cells — 500 of the 1,150. `MEMORY-02`'s relevance
question is carried by the other 650. Neither gate is measured by the whole
sample, and neither number exists yet.

## The frozen scoring contract

| | |
|---|---|
| contractVersion | `mem-score-v3.4` |
| descriptor digest | `a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd` |
| corrects | `mem-score-v3.3`, which recorded `schemaVersion: 2` while scoring schema 3 |
| what else changed | nothing — the same rules, thresholds, categories, languages and floors |
| approvedOn | 2026-08-28 |
| pendingRules (dataset-satisfiable) | none |
| prompt-pending | `v3-unfixable-evidence-emits-nothing` |

Earlier contracts stay pinned and unaltered: `mem-score-v3.2`,
`8d6dfef8537cf910a40d175e0bb315bdfaa4e47fa5e89ea3c4bfbc032d9b6e1b`, and
`mem-score-v3.3`, `19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777`,
recorded at `fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4` (see **Commits and CI**).

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
| mergedCommitSha | `b45b4996ff967fe3ccada594d7cf7286a60ef030` (see **Commits and CI**) |

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

## Commits and CI

**Two commits, not one.** A pull request's checks run on its head; what lands
on `develop` is a different commit object with a different SHA. Recording one
"commit" for both invites the reader to believe a run was computed on a commit
it never saw. So each recorded artefact carries four fields:

* **testedHeadSha** — the commit CI actually ran on.
* **mergedCommitSha** — the commit that is on `develop`.
* **treeEquivalence** — whether the two commits have the same tree, which is
  what decides whether the first one's run is evidence about the second one's
  content.
* **ciRun** — the run, cited against `testedHeadSha`.

| artefact | testedHeadSha | mergedCommitSha | treeEquivalence |
|---|---|---|---|
| dataset freeze `mem-eval-succ-4` | `22fb4aeb1032a7b3b6f37c07873308d648b9e8f7` | `0540e0be6b5da4dbd0ebd9cf0259d0f9f58a3e9d` | same tree `2a2fa4e8edd00c7f54c969534fd7b1371b34fced` |
| scoring contract `mem-score-v3.3` | `60f89598bfc7f7c5745143c07a98b3ad923d6a5b` | `fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4` | **different** — `851a1d7136d8f2d8b2e414fc9ad5015b8f5c11fe` vs `54de53e56f2a9da84d28ca521bdf587b8a50976a` |
| prompt `mem-extract-v6` | `d493c301d5c23d79c7679a457c95d4abd0b95813` | `b45b4996ff967fe3ccada594d7cf7286a60ef030` | same tree `e8578d41459949a7ff79ddceb8d0274b98f0627e` |

| artefact | ciRun (on testedHeadSha) | conclusion |
|---|---|---|
| dataset freeze | PR Fast Gate https://github.com/mposition/Tomverse/actions/runs/33154411698 | `success` |
| scoring contract | PR Fast Gate https://github.com/mposition/Tomverse/actions/runs/33151805896 | `success` |
| prompt v6 | PR Fast Gate https://github.com/mposition/Tomverse/actions/runs/33159852303 | `success` |
| prompt v6 | Credit Finance DB Integration https://github.com/mposition/Tomverse/actions/runs/33159852329 | `success` |

### Where the trees are the same

The freeze and the prompt were squash-merged onto a `develop` that had not
moved, so `mergedCommitSha` names a different commit object with byte-identical
content. The run on `testedHeadSha` is therefore evidence about the merged
tree as well: same tree, same checks, different commit metadata.

### Where the tree is not the same, and what that costs

`mem-score-v3.3` was brought in as a merge commit, and its base had advanced,
so `fc57ccf4…` carries content `60f89598…` never held. **Its PR run is not
evidence about the merged tree as a whole.** The difference is ten files, all
of them the base branch moving underneath: the router routing plan and its
Fable entry with their tests, the router eval script, workflow and answer-bundle
check, the message-attachment audit script, `docs/ops/r2-object-lifecycle.md`
and `AGENTS.md`. None of them is a memory-eval file — the difference contains
nothing under `lib/memoryEval*`, `tests/memoryEval*` or the memory ops
documents — so the run is still evidence about the contract's own content,
which is what this document cites it for. It is not a licence to read that run
as green for everything in `fc57ccf4…`.

What is green on the merged tree comes from the push runs `develop` makes on
each merge, which are a narrower set of workflows than a PR gets (PR Fast Gate
does not run on push):

| mergedCommitSha | push runs | conclusion |
|---|---|---|
| `0540e0be6b5da4dbd0ebd9cf0259d0f9f58a3e9d` | 33155347723, 33155347730 | `success` |
| `fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4` | 33152970434, 33152970498 | `success` |
| `b45b4996ff967fe3ccada594d7cf7286a60ef030` | 33160719890, 33160719746 | in progress at the time of writing |

### Reproducing the tree comparison

Read-only, no credentials. In a clone of this repository, on any shell that
has `git`:

```
git fetch origin d493c301d5c23d79c7679a457c95d4abd0b95813 develop
git rev-parse d493c301d5c23d79c7679a457c95d4abd0b95813^{tree}
git rev-parse b45b4996ff967fe3ccada594d7cf7286a60ef030^{tree}
git diff --name-only 60f89598bfc7f7c5745143c07a98b3ad923d6a5b fc57ccf4d6b38e1c87c6d7dbbf2f03ae0032f9a4
```

The first two print the same tree SHA. The last prints the ten files above,
and is the check to repeat rather than the list to trust.
