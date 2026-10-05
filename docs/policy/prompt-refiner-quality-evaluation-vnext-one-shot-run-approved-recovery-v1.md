---
status: draft
policyVersion: 1
workId: CHAT-01
scope: ONE_SHOT_B06_RUN_APPROVED_ZERO_CONSUMPTION_RECOVERY
implementationBlockedUntilApproved: true
approvedBy: null
approvedAt: null
---

# Prompt Refiner vNext one-shot: B06 run-approved recovery

This addendum defines the unpaid B06 operational shadow recovery and the
future paid-run eligibility and guard for its v3 stage under the approved
[one-shot v2 policy](prompt-refiner-quality-evaluation-vnext-one-shot-v2.md).
It does not revise the N=80 numeric gate, candidate, corpus, A17 final runner,
price, owner custody, or holdout access boundary. It grants no provider call,
slot consumption, product traffic, or quality disposition.

The [unrun replacement](prompt-refiner-quality-evaluation-vnext-one-shot-restage-v1.md)
was approved for implementation by its
[exact approval record](../ops/prompt-refiner-quality-evaluation-vnext-one-shot-restage-v1-approval.md).
It allowed one v1-to-v2 replacement before run approval. It cannot be reused
here: v1 is closed and v2 is already `run_approved`. Deploying the B06 proof
receiver changes the app deployment ID and commit, so the existing v2 approval
cannot authorize a shadow on that new deployment.

If this addendum receives its own exact approval, it **supersedes only for
this named recovery** the unrun replacement's clauses forbidding a repeated
replacement and a third stage ID, and its clause making only v2's 80 slots
eligible for the paid run. It permits exactly one v3 with 80 new slots. After
separate paid authorization, only v3's slots can ever be eligible for the
single 2,393,440 microUSD run; v1 and v2 slots remain ineligible. No reset,
v4 or repeated recovery is allowed under this policy. The older clauses
remain in force for every other case. This is not a general exception for
future deployment changes.

## 1. Exact source stage and reason

This is one recovery from `prompt-refiner-vnext-one-shot-v2` to the distinct
`prompt-refiner-vnext-one-shot-v3` stage. The source stage was read back on
2026-10-05 as `run_approved`, with stage approval audit
`cmuuyx04a001d02qt3ald6khq`, run approval audit
`cmuuz1ltu002002qtnct9lojp`, 80 reserved slots, zero consumed slots, valid
approval audits, and no operational shadow audit. Its deployment is
`3565f671-c168-4d3d-8573-8e79126e1c63` at commit
`291e6d07f284e6333c34a3061dd94da77752aad9`. This historical observation
is not execution authority; the app must re-read every condition at mutation
time. Any changed condition stops this recovery.

The app must directly verify, under the existing audit-first lock order, that
v1 remains closed with its valid replacement audit; v2 has the exact IDs,
deployment and commit above; v2 is `run_approved` with valid stage and run
audits; every one of its 80 slots is still reserved and none consumed; there
is no shadow row, unknown-stop row, slot-consumption audit or disposition for
v2; and there is no paid-dispatch authorization audit. Missing, duplicate,
unverifiable or ambiguous evidence refuses the transition. The app must also reobserve the
candidate source closure, owner custody pins, exact active Railway deployment
and commit, registry price pin, 29,918 microUSD request ceiling and 2,393,440
microUSD run ceiling. The new deployment must differ from v2's deployment.

## 2. One atomic replacement and a separate paid guard

After a separate exact owner stage approval and recent reauthentication, one
transaction closes v2, keeps its run approval and all 80 slot rows as immutable
history, writes a linked human supersession audit, creates v3 with 80 **new**
reserved slots, and writes v3's separate human stage approval audit. The same
candidate commit and source digest, A17 runner digest, restricted manifest
root, price pin and cost ceilings must be copied from v2 by the app, never
accepted from a caller boolean. The root remains in the restricted approval
store and is absent from ordinary receipts, alerts, PRs and readback. A
conflict or uncertain transaction outcome stops for readback; it is never
blindly retried. No v4, reset, row deletion or second replacement is allowed
under this policy.

V2 cannot consume a slot or dispatch after closure. V3 must obtain its own
separate exact owner run approval and hash-chained audit on the same active
deployment. Stage approval cannot stand in for run approval. The app must
read back v3's stage and run audits, deployment ID and commit, 80 reserved and
zero consumed slots before B06 shadow. The exact target deployment must
already contain the reviewed paid-slot route and its separate owner-only paid
approval route. Its `PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED=1` and
`PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED=1` settings only make the
slot route reachable; neither is paid authority. Under the same
audit and stage locks, the slot route must refuse every request until a
distinct, valid, hash-chained paid-authorization audit for this exact v3
stage, deployment, candidate, root, runner, price and ceiling exists. That
audit is absent throughout B06, so paid calls and slot consumption remain
blocked even with both environment switches set. The approval route is included
in this deployment but may write only after a valid B06 shadow readback,
separate exact owner spend authorization, recent reauthentication and an
explicit confirmation. This policy grants no such authorization and B06
never invokes that route.

The B06 deployment is refused before v3 stage approval unless its reviewed
commit includes the v3 paid-audit guard in the slot route, the owner paid
approval route, and a passing CI test with an exact `run_approved` v3 stage,
a valid B06 shadow audit that the slot route itself verifies against the strict
signed-proof and exact-binding readback criteria below, 80 reserved and
zero consumed slots, matching candidate/root/runner/price, the 29,918 and
2,393,440 microUSD ceilings, and active deployment pins, **both** environment
switches set to `1`, and a valid runner token and slot request. With only the
paid-authorization audit absent, the slot route must refuse before slot or
audit mutation. The test must establish that all other admission predicates
are satisfied so a refusal for another reason cannot pass it. V3 stage
admission also checks a server-owned capability version exported by the
guarded slot implementation;
an absent or mismatched version refuses stage creation. A caller field or
environment claim cannot satisfy that check. No earlier build with only the
environment switch is eligible for this recovery.

The shadow write is disabled by default and may be enabled only in the exact
deployment that will host stage, run and shadow. All required environment
pins, keys and switches **in the app deployment** are fixed before stage
approval; no app environment edit or redeployment occurs between v3 stage,
run, shadow and any later separately approved paid run. Later paid
authorization changes only the app's audited DB state through its owner
route, not the Railway deployment. The distinct owner-held A17 runner process
receives `PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY` only after a separate
paid approval; changing that owner-process environment does not change the
app's deployment ID. The provider key is absent from the B06 shadow process.

The B06 shadow accepts only the owner-held, signed, content-free proof produced
after the exact A17 final runner checks the sealed 80-case manifest without a
provider call. The app verifies the signature and signer pin, exact v3
candidate/deployment/root/runner/price/audit IDs, all 80 reservations, and
explicit integer `cacheWriteInputTokens: 0`. Caller booleans are not evidence.
It writes one app-bound hash-chained audit without root, signature, source,
answer, rubric, counterexample or output content, then reads back that audit
and `dispatchAuthorized: false`. A local synthetic preflight or mock alone
does not satisfy operational B06. Any unknown result is read back and stopped,
not posted again.

Definite refusal leaves v2 unchanged or, if v3 already exists, leaves v3 in
its audited state. An uncertain stage write is resolved only by owner readback
of both stages, slots and linked audits; no automatic or blind retry follows.
If v3 exists and is valid, the owner may continue its distinct run approval
on that same deployment. If v3 is absent, invalid, or the deployment drifts,
B06 remains incomplete and this recovery stops; the formal quality gate stays
unassessed. A new explicit policy and owner decision would be required before
any replacement or paid run. An uncertain shadow write is read back once:
completion requires one valid v3 shadow audit, the same active deployment ID
and commit, valid v3 stage and run audits, all 80 slots reserved and zero
consumed, an app audit recording the proof's explicit integer
`cacheWriteInputTokens: 0` from the A17 signed proof for that exact v3 binding
(not a missing, defaulted, derived or unrelated zero), no paid-authorization
audit, and `dispatchAuthorized: false`. Absent,
duplicate, mismatched or invalid evidence stops the attempt without a second
POST. The later paid-approval route must also refuse a drifted deployment and
must not treat a B06 shadow receipt as spend authority. Historical v1/v2 rows
are never reset or deleted.

## 3. Approval and verification gates

The owner must approve this addendum's **exact commit and file SHA-256** before
its implementation is merged or deployed. The approval record must name that
commit, digest, `approvedBy`, `approvedAt` and the implementation-only scope.
That approval does not replace separate authorization for the exact PR merge,
new deployment, v3 stage and v3 run. No spend or dispatch authority is
granted. The owner must retain the actual holdout outside Codex and public
artifacts; no actual source, answer, rubric or counterexample is requested,
read or transmitted to the candidate author or reviewer.

The implementation must pass synthetic rollback, concurrent duplicate,
deployment and source drift, audit integrity, old-stage immutability,
zero-consumption, no-provider-call, proof-rejection and content-free readback
tests, including the missing-paid-audit refusal with both environment switches
set and all other admission predicates satisfied, and v3 stage refusal when
the guarded-slot capability version is absent or mismatched. An independent
reviewer other than the author must review the policy
and code. The PR and staging deployment must be verified separately. B06 is
complete only when the app's owner readback shows v3's exact deployment and
commit, same candidate/root/runner/price binding, valid stage/run/shadow
audits, 80 reserved and zero consumed slots, an audit recording explicit integer
`cacheWriteInputTokens: 0` from the A17 signed proof for that exact v3 binding
(not a missing, defaulted, derived or unrelated zero), no paid-authorization
audit, and dispatch blocked through shadow completion. The paid-approval route
must apply this same strict shadow readback before any future write.
