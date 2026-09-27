# Independent code review request: router tie-break as a partition refinement

You are an independent reviewer. You did not write this change. **Do not modify
any file. Read-only.**

Repository: current working directory (Tomverse, Next.js + Prisma), checked out at
the commit under review. The change is the tip commit: `git show HEAD`.

## What the change claims

`lib/routerSelection.ts` ranked candidates with a pairwise comparator passed to
`Array.prototype.sort`. Two of the scoring policy's rules make such a comparator
intransitive — per-pair abstention on missing signals, and epsilon equality — so
the ranking could depend on the order the filters emitted candidates in.

The ranking is now built by partition refinement: all candidates start in one
group, each criterion in `ROUTER_TIE_BREAK_ORDER` splits each surviving group into
ordered buckets, a criterion that cannot speak for every member of a group leaves
that group whole, and the ranking is the lexicographic order of the bucket indices.

## Read

1. `git show HEAD` — the whole diff and its message
2. `lib/routerSelection.ts` — the new `partitionBy*` / `rankCandidates`
3. `lib/routerScorePolicy.ts` — `ROUTER_TIE_BREAK_ORDER`, the epsilons, the
   observation minimums, `compareRouterScoreCells`
4. `docs/policy/tomverse-chat-router-score-policy.md` — especially §5 (including
   the new subsection "The order is built, not compared"), §6 and §7
5. `tests/routerSelection.test.mjs`, `tests/routerScorePolicy.test.mjs`
6. `tests/routerDevelopmentPlanV2.test.mjs` — the re-baselined digests
7. `lib/routingShadow.ts` and `lib/routerDecision.ts` — the callers

## What to judge

### A. Is the new ordering actually a total preorder?

- Prove or break it. Is the lexicographic comparison over bucket-index vectors
  total and transitive **for every input this function can receive**?
- Are all rank keys guaranteed the same length? Check the `group.length <= 1`
  short-circuit in `rankCandidates` specifically.
- `partitionByMetric` sorts by reading then by model id, then walks buckets
  anchored to the first value. Is the resulting partition independent of the
  input order in every case, including equal readings, `-0`, and values that
  differ only below floating-point resolution?
- `partitionByQuality` splits by band and then by exact interval equality. Is
  exact float equality on `qualityCi95Lower` safe here, or does it need its own
  tolerance? Say which, and why.

### B. Did the semantics change more than the commit admits?

The commit claims exactly two rule changes: abstention becomes group-scoped, and
the epsilon is anchored. Check for any third change that was not declared.

- Is any ranking the **old** code produced now different, beyond the two declared
  changes? Construct a case if one exists.
- `partitionByDegraded` returns `[group]` when either side of the split is empty.
  Is that equivalent to the old `degraded.length > 0` guard in every case?
- Is `decidedBy` still the criterion that actually separates winner from
  runner-up? Can it now name a criterion that the old code would not have, or
  fail to name one it would have?
- `margin` is still `bandOf(winner) - bandOf(runnerUp)`, computed from the new
  ranking. Does the new ranking ever choose a different runner-up, and would that
  change stickiness behaviour in §6?

### C. Group-scoped abstention — is it the right reading?

One unmeasured candidate now silences a criterion for everybody it is tied with.
That is more conservative than the old per-pair behaviour.

- Is that faithful to §5's "an unknown value never wins and never loses", or does
  it throw away information the policy intended to use?
- Concretely: with instrumentation on and some models past
  `ROUTER_SUCCESS_RATE_MIN_OBSERVATIONS` and others not, does the success-rate
  criterion now effectively never fire? Work out when it does fire. If the answer
  is "almost never in production", say so plainly — that is a behaviour change
  the commit message does not mention.
- Is there a better reading — for example partitioning measured from unmeasured
  first — and what does *it* break?

### D. Purity and the version bump

- `tests/routerScorePolicy.test.mjs` walks the import graph of
  `lib/routerSelection.ts` and fails on anything impure. Does the new code keep
  that property? Does it introduce any non-determinism (iteration order of `Set`
  or `Map`, `sort` stability assumptions)?
- `ROUTER_SELECTION_VERSION` moved to v3 and `ROUTER_SCORE_POLICY_VERSION` did
  not. §7 of the policy is cited as the basis. Is that the right call, or should
  the score-policy version have moved too? Consider what
  `RoutingRun.selectionPolicyVersion` is used for in `lib/routingShadowReport.ts`.
- The `tests/routerDevelopmentPlanV2.test.mjs` digests were re-baselined. The
  claim is that holding the version string at v2 with the new code re-derives the
  old digests exactly, so the rewrite moves no row. **Verify that claim yourself**
  — it is the whole justification for editing a frozen digest.

### E. Tests

- Do the four new tests actually pin what they say they pin? In particular,
  would "a criterion one candidate cannot answer no longer cycles" still pass
  under the *old* pairwise comparator? If yes, it is not a regression test.
- `permutations` is recursive over the candidate list. Any problem there?
- What is **not** covered that should be?

### F. Anything else

- Anything that would make this a release blocker under
  `AGENTS.md` "검증 범위는 되돌릴 수 없는 것에 비례합니다". Name what is
  irreversible if wrong, or say that nothing is.
- Is the policy-document wording accurate about what the code does?

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — 커밋 메시지나 정책 문서의 주장 중 코드와 맞지 않는 것. 파일:줄
   근거 필수. 없으면 "없음"
3. **발견 사항** — 각 항목: severity (`blocker` / `major` / `minor`), 근거(파일:줄),
   재현 또는 확인 방법, 권장 수정
4. **A–F 각 절에 대한 답** — 하나도 빠뜨리지 말 것
5. **권장 후속 작업**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
