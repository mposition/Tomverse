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

This addendum is limited to completing the unpaid B06 operational shadow for
the approved [one-shot v2 policy](prompt-refiner-quality-evaluation-vnext-one-shot-v2.md).
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

If this addendum receives its own exact approval, it **supersedes only** the
unrun replacement's sentence forbidding a third stage ID for this named,
already-approved, zero-consumption v2 stage and B06 deployment drift. It
permits exactly one v3 and no reset, v4 or repeated recovery under this
policy. The older prohibition remains in force for every other case. This is
not a general exception for future deployment changes.

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
approval route. Its `PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED=1` setting
only makes the route reachable; it is **not** paid authority. Under the same
audit and stage locks, the slot route must refuse every request until a
distinct, valid, hash-chained paid-authorization audit for this exact v3
stage, deployment, candidate, root, runner, price and ceiling exists. That
audit is absent throughout B06, so paid calls and slot consumption remain
blocked even with the environment switch set. The approval route is included
in this deployment but may write only after a valid B06 shadow readback,
separate exact operator spend authorization, recent reauthentication and an
explicit confirmation. This policy grants no such authorization and B06
never invokes that route.

The shadow write is disabled by default and may be enabled only in the exact
deployment that will host stage, run and shadow. All required environment
pins, keys and switches are fixed before stage approval; no environment edit
or redeployment occurs between v3 stage, run, shadow and any later separately
approved paid run. Later paid authorization changes only the app's audited DB
state through its owner route, not the Railway deployment. The owner-held A17
runner receives provider credentials only after a separate paid approval;
none are needed for B06.

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
any replacement or paid run. An uncertain shadow write is read back once: one valid audit proves
completion; absent, duplicate or invalid evidence stops the attempt without
a second POST. Historical v1/v2 rows are never reset or deleted.

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
tests, including the missing-paid-audit refusal with the dispatch environment
switch set. An independent reviewer other than the author must review the policy
and code. The PR and staging deployment must be verified separately. B06 is
complete only when the app's owner readback shows v3's exact deployment and
commit, same candidate/root/runner/price binding, valid stage/run/shadow
audits, 80 reserved and zero consumed slots, integer cache-write zero, and
dispatch blocked through shadow completion.
