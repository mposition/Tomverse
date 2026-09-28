# Independent design review, round 4: multi-provider routing — deployment identity

You are an independent reviewer. You did not write this design. **Do not modify
any file. Read-only.** If a command you want is refused by the environment, say so
in your answer rather than inferring the result.

Repository: current working directory (Tomverse, Next.js + Prisma), checked out at
the commit under review.

Revisions 1, 2 and 3 were each reviewed and **rejected**. Revision 4 claims to close
round 3's two blockers, three majors and two factual errors. Judge revision 4 on
its own merits; do not re-run the earlier rounds.

## Read first

1. `.github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md`
   — **the design under review** (revision 4, Korean). §13 lists what changed from
   revision 3; §16 has the review history. Note that three of its rules were *reversed* in this revision, not merely tightened.
2. `.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`
3. `docs/policy/tomverse-chat-routing.md` — current policy (§2, §4, §5, §7, §8)
4. `docs/policy/tomverse-chat-router-score-policy.md` — current selection policy
5. `AGENTS.md`: "Credit entitlement vs operational guardrail",
   "검증 범위는 되돌릴 수 없는 것에 비례합니다"

## Code the design makes claims about

Verify §8 and §9. A wrong claim invalidates what is built on it. Round 2 found five
factual errors here; revision 3 rewrote all five, and those rewrites are the first
thing to check.

- `app/api/chat/route.ts` — the order of `recordProviderFailure` and
  `attemptFallback`, and the settlement funnel
- `lib/providerErrorClassification.ts` — `PROVIDER_SCOPED`, the NETWORK rule
- `lib/providerMonitoring.ts`, `lib/routerRuntimeSignals.ts` (`readProbeHealth`),
  `lib/routerSignalCore.ts`
- `lib/routingStreamFailure.ts`, `lib/routingFallbackPolicy.ts`,
  `lib/routingAttemptStore.ts`, `lib/chatSettlementOutcome.ts`
- `lib/routerCandidates.ts` — is there a production producer for
  `regionBlockedModelIds`?
- `lib/chatSecurity.ts` — `reservedCost` feeding both the account guardrail and the
  provider hold; the settlement's bucket-key parsing
- `lib/chatProviderHolds.ts`, `lib/routingShadow.ts`
- `prisma/schema.prisma` and `prisma/migrations/**` — `RoutingAttempt` CHECKs
  (including `20260922120000_routing_attempt_model_output_layer`),
  `ProviderHealthState`, `ProviderProbeResult`, `ChatAttemptUsage`

## What to judge

### A. Did revision 3 close round 2?

Round 3's blockers were: a `routingPolicyDigest` with no observation of actual
serving; and "no stated residency constraint" being treated as "any destination
permitted". Its majors were: health projection without a canonical observation or a
single authority; BYOK cost separation colliding with the existing `reservedCost`
wiring; an incomplete `QuotaScope`; an undecided candidate-freeze shape with no size
bound; and a blanket different-endpoint fallback that regresses today's behaviour.

For each, say `closed` / `partially closed` / `not closed`, with evidence from the
document and the code.

### B. §4 — broker and residency

- Is "digest is intent, per-response attestation decides" implementable? **S1**: name
  any provider in ADR §14's pool that actually returns a per-response serving
  identity. If none does, the OpenRouter emergency-fallback role in ADR §14 cannot
  serve constrained traffic at all — is the design honest about that consequence?
- **S2**: the design makes `unknown` fail-closed absent an approved default
  destination set. Today `regionBlockedModelIds` has no production producer, so
  nothing is blocked. Adopting this rule literally would remove every endpoint whose
  residency is unrecorded. What is the correct transition — and is calling the
  present state "explicit legacy" acceptable under APP 8, or is that just the same
  gap with a label?

### C. §6 — deferring the equivalence class

- Is deferring right, or does it leave D3 (a deployment per region) paying an eval
  cost the organisation cannot actually pay? **S3.**
- Does anything else in the design still depend on the class having been built?

### D. §8 — the claims about existing code

- §8.1: is "canonical append-only observation, idempotent projection by event id,
  one routing authority, atomic cutover" right, given the Router reads
  `ProviderProbeResult` directly? **S4**: probes cover roughly one model per
  provider — is a deployment-grain probe sample even reachable, and if not, what
  actually feeds deployment health at cutover?
- §8.3: verify the `reservedCost` claim and judge whether passing
  `providerChargeEstimate` to the account guardrail preserves today's semantics
  exactly. What breaks for a BYOK account whose spend Tomverse does not fund?
- §8.4: one-shot grain cut. Is there any consumer of `modelId`-grained routing
  signals that cannot be cut at the same instant?
- §8.5: **S5** — a per-run candidate cap means some candidate's verdict is not
  recorded. Which one should be dropped, and does dropping any of them defeat the
  purpose?

### E. §11 — what the design refuses

- The failure-scope-dependent fallback rule. Is the scope split implementable from
  what `classifyStreamFailure` actually produces today, given §9 says most provider
  categories collapse into one `failureLayer`?
- Two dispatched attempts under multi-deployment: still right?

### F. Ordering, and what is irreversible

- §14's order puts A-5 (atomic config manifest) after C and pairs A-3b with A-4a.
  Is that right?
- Under `AGENTS.md` "검증 범위는 되돌릴 수 없는 것에 비례합니다", name what is
  irreversible if this design is wrong. Residency is one — are there others?
- §15.1 lists T1–T5. Answer each.

### G. Is anything new broken?

Revision 3 changed a lot. Name anything it broke that revisions 1 and 2 had right.

## Output format

Reply in **Korean**. Structure:

1. **판정**: `approve` / `approve_with_changes` / `reject`
2. **사실 오류** — §8·§9의 주장 중 코드와 맞지 않는 것. 파일:줄 근거 필수. 없으면 "없음"
3. **round 3 findings 종결 여부** — blocker 2건·major 3건 각각
4. **새 발견 사항** — severity (`blocker` / `major` / `minor`), 근거, 확인 방법, 권장 수정
5. **T1–T5 각각에 대한 권고** — 기각한 쪽의 실패 양상을 함께
6. **권장 작업 순서**

근거 없는 동의는 검토가 아닙니다. 동의하는 항목도 왜 동의하는지 한 줄로 적으십시오.
