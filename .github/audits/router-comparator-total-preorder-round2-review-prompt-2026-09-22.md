# Independent code review, round 2: router tie-break as a partition refinement

You are an independent reviewer. You did not write this change. **Do not modify
any file. Read-only.**

Repository: current working directory (Tomverse, Next.js + Prisma), checked out at
the commit under review (`HEAD`).

Round 1 reviewed `router-selection-v3` — the tie-break becoming a partition
refinement rather than a pairwise comparator — and **rejected** it with two majors
and three minors. `HEAD` claims to close all five. Judge the result on its own
merits; do not re-run round 1.

## The two commits

- `git show HEAD~1` — the original change (`router-selection-v3`)
- `git show HEAD` — the fixes under review

Read both; the second only makes sense against the first.

## What round 1 found, and what HEAD claims

| # | Round 1 | Claimed fix |
|---|---|---|
| major | a non-finite `qualityCi95Lower` left its candidate in no bucket, shortening its rank key | `Number.isFinite` guard in `partitionByQuality`, **plus** a coverage check in `rankCandidates` that treats a non-covering partition as an abstention |
| major | the full-catalogue diagnostic reported the new ranking as `pairwise_inversion`, i.e. as evidence of non-transitivity | renamed `subset_context_reversal`, detail rewritten, diagnostic version v3 → v4, regression test added |
| minor | `lib/routerScorePolicy.ts` still documented per-pair abstention and pairwise epsilon equality | both rewritten |
| minor | `compareRouterScoreCells` documented as an ordering comparator although nothing orders with it | redocumented as the pairwise relation the partitioner implements |
| minor | the frozen plan digest's counterfactual was a comment, not an assertion | computed in `tests/routerDevelopmentPlanV2.test.mjs` |

## Read

1. `lib/routerSelection.ts` — `partitionBy*`, `partitionFor`, `rankCandidates`
2. `lib/routerScorePolicy.ts` — `ROUTER_TIE_BREAK_ORDER`, epsilons, observation
   minimums, `RouterTieBreakSignals`, `compareRouterScoreCells`
3. `lib/routerFullCatalogDiagnostic.ts` — `versusPrimary`, `subsetContextReversals`,
   `ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION`
4. `docs/policy/tomverse-chat-router-score-policy.md` §5, especially
   "The order is built, not compared"
5. `tests/routerSelection.test.mjs`, `tests/routerFullCatalogDiagnostic.test.mjs`,
   `tests/routerDevelopmentPlanV2.test.mjs`
6. `lib/routingShadowReport.ts` — the comparison axis

## What to judge

### A. Are the two majors actually closed?

- Is the coverage check in `rankCandidates` sufficient to guarantee equal rank-key
  lengths for **every** partitioner, present and future? Can a partitioner still
  produce a covering partition that is nonetheless wrong — duplicates across
  buckets, say?
- `partitionByQuality` now requires `Number.isFinite`. Is that the right predicate
  for every value the type admits? What about a cell whose band is fine but whose
  interval is finite in one cell and `null` in another *within the same band* — is
  the abstention still group-scoped there?
- The diagnostic rename: is `subset_context_reversal` reported under a heading
  (`improvementCandidates`) that still implies something should be improved? Should
  it have moved to a different part of the report?
- Does the regression test actually exercise the bucket-boundary mechanism, or does
  it pass for an unrelated reason? Work through its arithmetic.

### B. Is anything *new* broken by the fixes?

- The coverage check silently downgrades a criterion. Could that mask a real
  partitioner bug in production rather than surfacing it? Should it throw instead?
  Argue both, then recommend.
- The diagnostic version bump moved the frozen benchmark plan digest a second time.
  `tests/routerDevelopmentPlanV2.test.mjs` re-baselines and substitutes **both**
  version strings back. Verify the counterfactual is sound: does substituting into
  the plan body reproduce exactly what the previous build would have produced, or
  does it only reproduce a plausible-looking digest?
- Does `delete body.planDigest` preserve key order in the way the test's comment
  claims, and does `JSON.stringify` of the reconstructed object match the original
  byte for byte?

### C. The property that was traded

The policy now states that the ranking is transitive and emission-order independent
in exchange for depending on which candidates are present.

- Is that trade stated accurately, and is it the *only* trade? Independence of
  irrelevant alternatives is the formal name — does anything else in the codebase
  assume IIA holds?
- A hard filter refusing a model can now reorder the rest. Does any caller —
  stickiness, fallback candidate order, the shadow report — rely on an ordering
  that is stable under candidate removal?

### D. Group-scoped abstention, revisited

Round 1 concluded this is the reading the policy's words require, while noting the
success-rate criterion may then almost never fire. HEAD does not change that.

- Is leaving it unaddressed acceptable, or does the policy now promise a criterion
  that cannot act? If the latter, what is the least-bad change?

### E. Documentation accuracy

- Does `docs/policy/tomverse-chat-router-score-policy.md` now describe what the code
  does, with no remaining sentence that is false?
- Is the `selectionVersion` vs `selectionPolicyVersion` note correct about
  `lib/routingShadowReport.ts`?
- `compareRouterScoreCells` is now used only by tests. Is documenting it enough, or
  should it be deleted?

### F. Tests

- What is still not covered? Be specific.
- Round 1 asked whether "a criterion one candidate cannot answer no longer cycles"
  would pass under the old comparator. Re-check that for the tests added in HEAD.

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **round 1 findings 종결 여부** — 5건 각각 `closed` / `partially closed` /
   `not closed`와 근거(파일:줄)
3. **사실 오류** — 커밋 메시지·주석·정책 문서의 주장 중 코드와 맞지 않는 것. 없으면 "없음"
4. **새 발견 사항** — severity (`blocker` / `major` / `minor`), 근거, 확인 방법, 권장 수정
5. **A–F 각 절에 대한 답**
6. **권장 후속 작업**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
