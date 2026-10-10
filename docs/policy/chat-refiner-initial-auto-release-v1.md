---
status: approved_scope_not_activated
policyVersion: 1
workId: CHAT-01
approvedBy: mposition
approvedAt: 2026-10-11
approvalTimezone: Australia/Brisbane
scope: CHAT_REFINER_INITIAL_AUTO_RELEASE
activationAuthority: exact_deployment_owner_action_after_required_checks
dailyCostCapUsd: 100
monthlyCostCapUsd: 3000
perRequestCeilingMicroUsd: 29918
refinerDeadlineMs: 13000
refinerRetryCount: 0
---

# Chat Refiner initial Auto release v1

## 1. Owner decision and historical evidence

On 2026-10-11, the operator requested that this small platform ship working
functionality first and improve Refiner quality afterwards. The operator then
explicitly selected **Chat Auto automatic application in this release**, rather
than a manual-acceptance-only release. This is a new initial-release exception;
it does not extend the historical latency-only exception by implication.

The B08-v5 result remains failed, including `quality_cell_threshold`,
`challenge_threshold`, `audit_incomplete`, latency, and 34 unresolved evaluation
audit concerns. No original result, attestation, evaluation slot, rubric,
counterexample, or earlier approval is edited or declared passed. Completing
the quality and evaluation-audit work is a follow-up milestone under this
exception, not an initial product-activation prerequisite. This deferral does
not permit a known critical product safety failure or broken product audit
integrity.

The Router's `shadow_report`, `offline_quality_evaluation`, and
`attempt_manifest_boundary` attestations remain pending until their actual
owners attest them. This exception may authorize an initial Auto cohort while
those measurements are pending. It never turns an entry into `passed` or
authorizes dispatch without the actual finalized attempt/manifest boundary.

## 2. Four required release checks

1. **Server connection and data safety.** The server stores and validates the
   exact Refiner proposal against the authenticated owner, stored Chat
   conversation, surface, source message, draft snapshot/revision, epochs and
   lifetime. A decision is consumed once, after recoverable model/plan/context
   preflight. Router profiling, token estimation, shadow and final provider
   execution use the same authorized execution view. The saved user Message
   retains the authored bytes. Replay, stale, cross-account and scope ABA,
   invalid binding and unknown outcome cannot cause another dispatch or charge.
2. **Cost, product audit and stop controls.** Refiner reserves the current
   verified worst-case amount before dispatch, settles known cost once, and
   retains the worst-case hold for unknown billing. Its separate Brisbane
   calendar budgets remain US$100/day and US$3,000/month, with 29,918 microUSD
   per request, a 13,000ms deadline and zero retries. Budget exhaustion or an
   unavailable proposal uses the original Chat input under ordinary Chat
   authorization. Product receipts and human activation use the existing
   hash-chained audit writers, never a direct audit-table insert. Refiner and
   Router kill switches, the durable Refiner Auto stop latch, model/price/config
   pins and ordinary credit/plan/capability limits remain effective. Initial
   Router admission requires dispatch instrumentation `enforce` and a valid
   manifest keyring; actual dispatch still requires its immutable finalized
   manifest and original financial guards.
3. **Independent review and CI.** The final exact source passes applicable
   checks and actual independent review through the review server. A contract
   change keeps the required distinct-vendor review quorum. Accepted earlier
   heads do not approve a changed source. Normal PR, required CI and merge
   procedures remain in place.
4. **Exact deployment and short integration check.** The reviewed source,
   required migrations, candidate/model/price/adapter configuration and exact
   serving commit/deployment are verified before the existing owner-authenticated
   activation action records this exception. A small, scoped staging/serving
   regression covers automatic application, explicit acceptance, original
   preservation/fallback, a replay or stale refusal, and kill/off behavior.
   Synthetic tests cover the broader failure and integration matrix. An
   activation action records evidence references without claiming unobserved
   tests or model quality.

## 3. Runtime authority and scope

The initial release writes two separately versioned, canonical owner facts in
one transaction through the existing audit chain:
`chat_auto.initial_release_exception_activated` and
`prompt_refiner.product_initial_auto_release_activated`. The Refiner fact
references the exact Router fact. Both bind this policy's commit and exact
bytes, the serving commit/deployment, the checked-in candidate, price and
adapter identities, and the effective routing configuration. A partial write,
duplicate or mismatched pair grants no authority. The legacy activation shape
continues to enforce its original B03G latency-only and limited-audit conditions.

Only an owner session with recent administrator authentication and a valid
same-origin mutation may activate. The default-off activation writer switch,
rollout controls and kill switches remain separate. A checked-in approval
record, a browser boolean, a forged object, a staging drill header or an
environment flag alone cannot mint this authority. No new evaluation-stage,
slot, holdout or direct product-database writer is introduced.

Availability, mode storage and turn routing consult the same server-owned
initial-release authority. The serving deployment must match on every use.
Missing or ambiguous activation, policy/config drift, database uncertainty,
invalid audit integrity, missing manifest enforcement or keys closes the
exception. Ordinary authenticated Chat eligibility, product boundary, plan,
cohort percentage, user model choice and ability to leave Auto are preserved.
Refiner Auto prepares only an ordinary human Send in a stored Auto Chat
conversation; it does not send a turn itself or edit history, attachments,
voice data, files, search results, Memory or system instructions.

## 4. Completion and follow-up

After all four checks and actual activation/readback, the release may be
reported as **initial Refiner/Auto product connection complete under this
exception**. This is distinct from B08 quality certification, the Router's
three attestations and overall CHAT-01 completion. Those historical states
remain visible in operator reports. User-facing copy makes no superiority,
optimal-model, guaranteed-improvement or benchmark-pass claim.

Quality, challenge coverage, the 34 evaluation-audit concerns, latency tuning,
shadow measurements and production measurement attestations remain tracked
follow-ups. A known critical safety incident, unknown dispatch/cost, failed
original fallback, budget enforcement failure or product audit failure is an
operational stop, not deferred quality work. Existing stop latches cannot be
silently resumed by a new deployment or successful request.
