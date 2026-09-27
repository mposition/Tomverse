# Independent design review request: multi-provider routing — deployment identity

You are an independent reviewer. You did not write this design. **Do not modify any
file. Read-only.** Do not run `git` commands that change state.

Repository: current working directory (Tomverse, Next.js + Prisma). Base is the
`develop` working tree. Two of the documents below exist only on the branch
`origin/claude/loving-heisenberg-y0bxyh`; read them with
`git show 2621e051b:<path>`.

## Read first, in this order

1. `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md`
   — **the design under review** (Korean)
2. `git show 2621e051b:.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`
   — the gap analysis it builds on
3. `git show 2621e051b:docs/policy/tomverse-multi-provider-routing-v2.1.md`
   — ADR v2.1 (Proposed, **not adopted**)
4. `docs/policy/tomverse-chat-routing.md` — current routing policy (esp. §2, §4, §5, §7, §8)
5. `docs/policy/tomverse-chat-router-score-policy.md` — current selection policy
   (esp. §3, §5, §6, §8)
6. `AGENTS.md` sections: "Credit entitlement vs operational guardrail",
   "공유 package와 framework 순수성", "검증 범위는 되돌릴 수 없는 것에 비례합니다",
   "작업을 어느 모델에 보낼지"

## Code to verify the design's factual claims against

The design's §8 makes specific claims about existing code. **Check each one.** A wrong
claim here invalidates the plan built on it.

- `lib/routingStreamFailure.ts`, `lib/providerErrorClassification.ts`,
  `lib/providerMonitoring.ts`, `lib/providerHealthPolicyCore.ts`
- `lib/routerRuntimeSignals.ts`, `lib/routerSignalCore.ts`, `lib/routerScorePolicy.ts`,
  `lib/routerSelection.ts`, `lib/routerCandidates.ts`
- `lib/routingShadow.ts`, `lib/routingShadowReport.ts`, `lib/routingFallbackPolicy.ts`,
  `lib/routingAttemptSequence.ts`, `lib/routingDispatchInstrumentation.ts`,
  `lib/modelHealthRollup.ts`
- `lib/chatProviderHolds.ts`, `packages/chat-core/src/completionStatus.ts`
- `app/api/chat/route.ts` (the `settleSafely` mapping around the empty-response path)
- `app/api/admin/routing-shadow/route.ts`
- `prisma/schema.prisma`: `RoutingRun`, `RoutingAttempt`, `ProviderHealthState`,
  `ProviderProbeResult`
- `prisma/migrations/**` CHECK constraints on `RoutingAttempt`

## What to judge

### A. Factual accuracy

Is any claim in the design's §8 (8.1–8.5) wrong or overstated? Cite file:line.
In particular:

- §8.2 claims BYOK would consume Tomverse's provider budget because
  `providerBucketKey` takes a bare provider string. Is that right, and is it a real
  hazard or an artefact of a path BYOK would not take?
- §8.4 claims an empty 200 is written as `failed_post_token` / `stream` and that this
  silently depresses the model's Router tie-break score. Trace it. Is it a genuine
  defect?
- §8.3 claims `Retry-After` is never read from any AI provider response. Verify.

### B. The identity model (§2, §3)

- Is the 4-level split (`LogicalModel → ModelDeployment → ProviderEndpoint →
  CredentialBinding`) sound? Does it hold for non-Azure providers in ADR §14's pool
  (DeepInfra, Together, OpenRouter, Vertex, Bedrock, Anthropic Direct)?
- **Is the hard invariant in §3 actually enforceable?** Name any provider in ADR §14
  where endpoint/region/residency genuinely cannot be determined without resolving a
  credential. If one exists, the invariant is wrong as written.
- Is the §2.1 boundary rule ("답이 달라지거나 위법이 되면 위쪽 계층, 청구서만
  달라지면 credential") a complete test? Find a case it misclassifies.
- Does OpenRouter fit this model at all? It is an aggregator that itself routes; a
  single OpenRouter "endpoint" may serve the same logical model from several
  underlying providers with different quantization. Does that break the quality
  equivalence claim?

### C. Quality equivalence class (§5) — **Q1, Q3**

This is the reviewer-facing novelty. The design argues that splitting deployments by
region multiplies quality-gate cost, and proposes evidence attach to
`(upstreamModelRef, version/revision, quantization, tokenizerRevision)` instead.

- Is that sound, or does it let a genuinely different serving stack inherit a gate
  pass it did not earn?
- Answer **Q3**: should `quality_gate_expires_at` / `stale` be class-scoped or
  deployment-scoped? State the failure mode of the option you reject.

### D. Scope separation (§4) — **Q2, Q5**

- Answer **Q2**: health observed at deployment with endpoint correlation *derived*.
  Is derivation fast enough to catch an endpoint-wide (Azure resource) outage, or does
  that need its own observed counter? Consider the existing three-stream design in
  `ProviderHealthState` as precedent, and say whether the precedent actually applies.
- Answer **Q5**: what scope should `chatProviderHolds` take under BYOK?
- Is `quotaScopeType` as a key-derivation rule (rather than five tables) workable in
  PostgreSQL given this repo's `check:enum-constraints` gate?

### E. Ordering and cost (§7) — **Q4**

- Is "deployment selection, then credential selection" the right order? The design
  claims cost belongs to `(deployment, credential)` because BYOK makes Tomverse's cost
  zero. Does that break the cost tie-break criterion in the score policy §5.3, which
  compares "the same input and output token counts for every candidate, each model's
  own price"?
- Answer **Q4**: should a BYOK workspace fall back to a managed credential? If yes,
  does that silently change who is billed, and is that acceptable?

### F. What the design refuses to change (§6) — **Q6, Q7**

- **Q6**: the design keeps the existing execution budget (max 2 dispatched attempts)
  against ADR's `max_attempts=3`. Is that the right call, or does it forfeit most of
  the reliability benefit that justified multi-provider in the first place? Argue both
  sides before concluding.
- **Q7 — this is the one that most needs a third party.** ADR §5 proposes a weighted-sum
  penalty (`w_cost 0.35 + w_latency 0.25 + w_health 0.40`). The current policy uses a
  **lexicographic** tie-break and refuses scoring on the record: quality is a band
  (1|2|3), never a point score, because "a six-point scale would look like a
  measurement and would be read as one", and "cost, health and latency are measured,
  and quality is not".

  With multi-deployment adopted, the candidate set grows substantially. Judge:
  does lexicographic ordering still work at that scale, or does the growth force a
  weighted sum? If it forces one, **how is the "do not quantify what is not measured"
  principle preserved?** If it does not, say what breaks first as candidates grow.

  Do not split the difference. Give a recommendation.

- Related: ADR §7.3 invents `prior_failure_risk = 0.005, k = 200` for cold-start, while
  the current policy **abstains** on under-observed signals with stated thresholds
  (success rate 30 observations, TTFT p95 50). Multi-deployment creates many cold
  candidates. Which discipline should win, and what is the concrete consequence of the
  one you reject?

### G. Anything missing

- Does the design silently weaken an invariant in `docs/policy/tomverse-chat-routing.md`
  §2 or `AGENTS.md`'s credit/guardrail separation?
- Is anything here a release blocker under "검증 범위는 되돌릴 수 없는 것에 비례합니다"?
  Name what is irreversible if wrong.
- Is the §10 commit order right? In particular, is commit 1 genuinely independent of
  the ADR/deployment decisions, so it can land first?

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — 설계 §8의 주장 중 틀린 것. 파일:줄 근거 필수. 없으면 "없음"
3. **발견 사항** — 각 항목: severity (`blocker` / `major` / `minor`), 근거(파일:줄 또는
   추론), 확인 방법, 권장 수정
4. **Q1–Q7 각각에 대한 권고** — 하나도 빠뜨리지 말 것. 각 답은 기각한 쪽의 실패
   양상을 함께 적을 것
5. **권장 작업 순서 변경** — 있으면 제시

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
