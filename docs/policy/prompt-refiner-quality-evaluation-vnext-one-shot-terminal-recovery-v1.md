---
status: draft
policyVersion: 1
workId: CHAT-01
scope: ONE_SHOT_B03O_TERMINAL_DEPLOYMENT_RECOVERY
implementationBlockedUntilApproved: true
approvedBy: null
approvedAt: null
---

# Prompt Refiner vNext one-shot: B03O terminal deployment recovery

This addendum proposes one recovery from the B06 `run_approved` v3 stage after
the B03O terminal receipt and owner readback code changes the app deployment and
the A17 owner runner bytes. It grants no provider call, slot consumption,
quality disposition, holdout access, product traffic, merge, or deployment.
The approved one-shot v2 candidate, 80 fixed ko/en slots, numeric gate, owner
custody, request ceiling of 29,918 microUSD, run ceiling of 2,393,440 microUSD,
timeout, provider retry 0, and case replacement 0 remain fixed.

The approved B06 recovery addendum permitted only v2 to v3 and expressly
forbade v4. An exact owner approval of **this addendum** is required before
implementing or activating any v3-to-v4 recovery. It supersedes that prohibition
only for the single recovery described here. It is not permission for v5,
another replacement, a new evaluation set, or a second paid run.

## 1. Source-stage eligibility

The only source is `prompt-refiner-vnext-one-shot-v3`; the only successor is
`prompt-refiner-vnext-one-shot-v4`. Before any write, the app must lock and
read back v1, v2 and v3 and their linked hash-chained audits. V1 and v2 must
remain closed with valid supersession links. V3 must have valid stage, run and
B06 shadow audits, exactly 80 reserved and zero consumed slots, no terminal or
unknown outcome receipt, no paid-dispatch authorization, no gate disposition,
and no previously created v4. An absent, duplicate, altered or ambiguous audit
or slot refuses recovery. The operator also independently reads back the same
facts immediately before approving the stage. Historical readback is not an
execution grant.

The app must reobserve the exact approved candidate source closure, manifest
digest, owner-held root binding, price and active Railway deployment and commit.
It must verify that the new deployment differs from v3's recorded deployment,
contains the reviewed B03O terminal writer, owner readback and guarded slot
route, and has the exact new A17 final runner digest built from the merged
source. The B03O runner-byte change makes the v3 runner digest unusable. The
candidate source and restricted manifest root remain identical; only the app
deployment/commit and runner digest may change. The root remains in the
restricted approval store and never enters ordinary receipts, alerts or PRs.

## 2. One atomic replacement and fresh evidence

With recent owner authentication and separate exact stage authorization, one
transaction writes a linked human supersession audit, closes v3, preserves all
of its stage, slot and audit rows, creates v4 with 80 new reserved slots, and
writes v4's own stage approval audit. It may not reset, delete or rewrite any
old reservation or audit. An uncertain transaction stops for owner readback;
there is no blind retry. The database must also reject a second successor and
any v3 consumption after closure.

V4 requires a new exact owner run approval on the same deployment and its own
hash-chained audit. The B06 v3 shadow is historical evidence only: the owner
must run a new provider-free A17 preflight against the same sealed manifest,
produce a signed content-free proof bound to v4's deployment, candidate, root,
new runner, price and approval IDs, and obtain a new v4 shadow audit/readback.
The proof must explicitly report integer `cacheWriteInputTokens: 0`, zero
provider calls and zero slot-consume calls. Any missing or uncertain proof
stops; it is never posted again without owner resolution.

The new deployment must have the app's slot-consume and dispatch switches and
runner API token safely present **before** v4 stage approval. No app variable
edit or redeployment may occur between v4 stage, run, shadow and any later
paid run. If preparing those variables requires another deployment, this
recovery stops for a new policy decision. The provider key stays only with the
owner runner and is absent from shadow. Switches and a runner token are
reachability controls, not spend authority.

The guarded slot route must refuse with all other predicates satisfied until
a distinct exact owner paid-dispatch authorization audit for v4 exists. A v3
paid audit, v3 shadow, stage approval or run approval cannot substitute for
that audit. The owner paid route must independently verify v4's signed shadow,
80-slot readback, deployment, runner and price pins before writing. Its call
requires separate exact owner spend authorization, recent reauthentication and
explicit confirmation. This addendum does not grant that authorization.

After a separate paid approval, every attempted v4 slot must be classified in
the B03O readback as `not_attempted`, valid `terminal`, valid
`outcome_unknown`, or `receipt_missing_or_invalid`. A terminal receipt binds
the exact request, slot-consumption and run audits, result kind, complete
provider usage, zero cache-write count, observed bounded cost, latency and
price pin, without prompt, answer, rubric, counterexample, output, root or
content digest. It is written atomically through the existing hash-chained
audit writer. Duplicate or conflicting terminal receipts are refused. An
unknown result keeps the full 29,918 microUSD reservation; any consumed slot
without a verified receipt blocks the next consumption. A lost receipt POST
response is resolved by owner readback, never by automatic resubmission.

## 3. Approval and completion boundaries

The owner must approve this addendum's exact commit and file SHA-256, recording
`approvedBy`, `approvedAt` and implementation-only scope before v4 recovery
implementation is merged or deployed. That approval is separate from exact PR
merge, new staging deployment, v4 stage, v4 run and later paid-dispatch
authorizations. The latter is the only permission for B07 provider calls.

Synthetic tests must cover rollback, concurrent duplicate recovery, old-row
immutability, deployment and runner drift, signed shadow rejection, absent
paid-audit refusal with switches enabled, no-provider-call shadow, terminal
receipt tamper/duplicate/cost checks, missing-receipt dispatch refusal,
content-free owner readback and unknown stop. A different reviewer must review
the policy and code. V4 operational B06 is complete only after exact active
deployment and commit, candidate/root/runner/price pins, valid stage/run/new
shadow audits, all 80 slots reserved and none consumed, zero paid audits, and
dispatch blocked are independently read back. A safe stop is never counted as
80 terminal completions or a quality-gate pass.
