# Independent design review, round 2: multi-provider routing — deployment identity

You are an independent reviewer. You did not write this design. **Do not modify
any file. Read-only.**

Repository: current working directory (Tomverse, Next.js + Prisma), checked out at
the commit under review.

Revision 1 of this design was reviewed and **rejected** with two blockers, six
majors and five factual errors. Revision 2 claims to have addressed all of them.
Your job is to judge revision 2 on its own merits — not to re-run round 1.

## Read first, in this order

1. `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md`
   — **the design under review** (revision 2, Korean). §12 lists what changed.
2. `git show 2621e051b:.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`
3. `git show 2621e051b:docs/policy/tomverse-multi-provider-routing-v2.1.md` — ADR v2.1 (not adopted)
4. `docs/policy/tomverse-chat-routing.md` — current policy (§2, §4, §5, §7, §8)
5. `docs/policy/tomverse-chat-router-score-policy.md` — current selection policy
6. `AGENTS.md`: "Credit entitlement vs operational guardrail",
   "검증 범위는 되돌릴 수 없는 것에 비례합니다"

## Code the design makes claims about

Verify §8 and §9 against the code. A wrong claim invalidates what is built on it.

- `lib/routingStreamFailure.ts`, `lib/providerErrorClassification.ts`,
  `lib/providerMonitoring.ts`, `lib/routerRuntimeSignals.ts`, `lib/routerSignalCore.ts`
- `lib/routerCandidates.ts`, `lib/routerScorePolicy.ts`, `lib/routerSelection.ts`,
  `lib/routerCostSignal.ts`
- `lib/routingShadow.ts`, `lib/chatProviderHolds.ts`, `lib/chatSecurity.ts`
- `lib/chatSettlementOutcome.ts`, `app/api/chat/route.ts`
- `prisma/schema.prisma`: `ProviderHealthState`, `ProviderProbeResult`, `RoutingRun`,
  `RoutingAttempt`; and the CHECK constraints under `prisma/migrations/`
- `scripts/check-enum-constraints.mjs`

## What to judge

### A. Did revision 2 actually close round 1's findings?

Take §12's table as a set of claims and check each against the body of the document.
Name any that are asserted in the table but not actually carried into the design.

Round 1's blockers were:
- an aggregator endpoint does not identify where a request is served;
- re-keying `ProviderHealthState` destroys history that cannot be backfilled.

Are §4 and §8.1 sufficient answers, or do they move the problem rather than solve it?

### B. §4 — broker / aggregator routes

- The three rules: `residencyClass = unknown` excluded only from residency-constrained
  requests; routing-eligible requires a pinned `servingProvider` with broker fallback
  off, recorded as `routingPolicyDigest`; unknown is never guessed.
- **R1**: can a change to `routingPolicyDigest` actually be *observed* by us, or is
  the design relying on a fact no API reports? If it cannot be observed, the rule is
  decorative — say so.
- Does rule 1 leak? A request with no stated residency constraint still sends data
  somewhere. Is "no constraint" the same as "any region is acceptable" in Australian
  privacy terms (the company is an Australian entity, APP 8 applies to overseas
  disclosure)?

### C. §6 — quality equivalence class

- **R2**: `servingContractDigest` requires a provider-attested immutable artifact.
  For the pools in ADR §14, how many providers actually attest one? If the honest
  answer is "almost none", then almost every deployment is a singleton class and §6
  saves nothing while adding a concept. Judge whether the concept still earns its
  place in that case.
- Is the class-quality vs deployment-conformance split (§6.2) sound, or does
  conformance quietly become a second quality gate with no evidence behind it?
- **R3 / §6.3**: is "one region drifts → membership released, class not stale" right?

### D. §7 — cost semantics

- The four values (`providerChargeEstimate`, `tomverseMarginalCost`,
  `workspaceExternalCost`, `billingOwner`). Is tie-breaking on
  `providerChargeEstimate` correct?
- **R4**: a BYOK workspace is then ranked by money it does not pay. Round 1 argued
  zeroing it breaks the comparison; this argues not zeroing it ranks on the wrong
  quantity. Which is less wrong, and why? Give a recommendation, not both sides.
- Is §7.2's ban on implicit BYOK→managed fallback right, given it reduces availability?

### E. §8 — the claims about existing code

- §8.1: is "keep `ProviderHealthState`, add a projection, derive idempotently from one
  observation" implementable without the two ever disagreeing? **R3**: what governs
  the period when both the provider-level table and the deployment projection can
  influence routing?
- §8.2: does a typed-FK `QuotaScope` registry with "exactly the needed columns
  non-null" CHECKs actually work in PostgreSQL, and does it satisfy
  `check:enum-constraints`?
- §8.3: verify the `reservedCost > 0` correction and the proposed
  `providerBudgetAccountId` scope.
- §8.4: **R5** — the grain change from `modelId` to `deploymentId` touches
  `ROUTER_SCORE_SNAPSHOT`, every signal map and the final tie-break. One cut or a
  coexistence period? State the failure mode of the option you reject.
- §8.5: is "freeze every non-reconstructible candidate verdict" bounded enough to
  keep `RoutingRun` content-free and its rows a sane size?

### F. §10 — what the design refuses

- **R6**: requiring a fallback to use a different `ProviderEndpoint` removes fallback
  entirely for a logical model with one deployment. Intended, or a regression against
  today's behaviour where a fallback to a *different model* is allowed?
- Is keeping two dispatched attempts still right under multi-deployment?
- The design keeps lexicographic ordering and abstention. Anything in revision 2 that
  quietly contradicts that?

### G. Release-blocking and ordering

- Under `AGENTS.md` "검증 범위는 되돌릴 수 없는 것에 비례합니다", name what is
  irreversible if this design is wrong. Residency is the obvious one — are there
  others?
- §13 lists A-3, A-4, A-5 as next. Is that order right, or does anything there depend
  on C (deployment identity) landing first?
- §14 lists R1–R6. Answer each.

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — §8·§9의 주장 중 코드와 맞지 않는 것. 파일:줄 근거 필수. 없으면 "없음"
3. **round 1 findings 종결 여부** — blocker 2건·major 6건 각각에 대해
   `closed` / `partially closed` / `not closed`와 근거
4. **새 발견 사항** — 각 항목: severity (`blocker` / `major` / `minor`), 근거,
   확인 방법, 권장 수정
5. **R1–R6 각각에 대한 권고** — 하나도 빠뜨리지 말 것. 기각한 쪽의 실패 양상을 함께
6. **권장 작업 순서**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
