---
status: approved
policyVersion: 1
workId: CHAT-01
scope: B07_POST_UNKNOWN_NEW_INDEPENDENT_RUN
implementationBlockedUntilApproved: false
approvedBy: mposition
approvedAt: 2026-10-06
---

# Prompt Refiner vNext: new independent one-shot after v4 safe stop

This proposal permits implementation of **one** new, independent 80-case run
after the v4 safe stop. It does not authorize a provider call, stage or run
approval, PR merge, deployment, flag change, quality pass, or product exposure.
The owner must approve this file's exact commit and SHA-256 and record
`approvedBy` and `approvedAt` before the v5 recovery writer is implemented.
Operational approvals remain separate.

## 1. Immutable source evidence

The only eligible predecessor is `prompt-refiner-vnext-one-shot-v4`, closed by
its signed `outcome_unknown` audit after slot 33. Its B03O readback must still
be valid and distinguish 33 terminal, one unknown, 46 not attempted and zero
missing receipts. The observed terminal cost is 7,624 microUSD; the unknown
keeps its full 29,918 microUSD reservation, so the v4 worst case is 37,542
microUSD. These counts are an eligibility snapshot, not a claim that the
unknown result or actual provider cost is known. If the current signed
readback differs, this proposal cannot be used without a new decision.

V4's stage, slots, owner files and hash-chained audits remain immutable. Slot
33 is never resent, converted to `failed`, or charged an invented exact cost.
The 46 untouched v4 reservations are not resumed. No v4 result is counted in
the new run's numerator or denominator. V1–v3 history stays unchanged.

## 2. New cohort and fixed candidate

V5 is a fresh evaluation, not a continuation or case replacement within v4.
The owner creates and seals **80 new independent cases**, ko/en 40 each, only
after the candidate source closure, runner bytes, parser, evaluator, price and
numeric contract are fixed and reviewed. The owner verifies that no v4 case
content is reused. Case IDs may follow the required schema but the content,
answers, rubric and counterexamples stay solely in owner custody. Codex and
the independent code reviewer receive none of them or their root.

The approved one-shot v2 numeric contract remains unchanged: fixed 80-slot
denominator, request ceiling 29,918 microUSD, run ceiling 2,393,440 microUSD,
15-second timeout, provider retry 0, case replacement 0, and all quality,
safety, cost and latency thresholds. A verified parser failure with complete
provider usage is a `failed` terminal and makes the quality gate fail; an
unverified response, missing usage, uncertain cost or uncertain transport
outcome remains `outcome_unknown` and stops. Neither status can be promoted to
success. The old v4 `response_unverified` receipt cannot be diagnosed more
finely or relabeled from later code.

The owner runner must be a self-contained, exact-digest artifact built from
the merged source. It may resolve only Node built-in dynamic requires needed
by its bundled SDK. An external, unpinned preload is not an operating
dependency. The app verifies the exact candidate source closure, new manifest
root binding, runner digest, price, deployment and commit at the same guarded
boundaries as v4.

## 3. Single guarded v5 stage and approvals

Only a new, reviewed and deployed app version may create
`prompt-refiner-vnext-one-shot-v5`. One transaction checks the signed v4
readback, absence of any v5 or later successor, new source/root/runner/price
pins and current deployment, then appends a linked recovery audit and 80
new reserved slots. The already-closed v4 row and all historical rows are
neither deleted nor rewritten.
Duplicate, missing, tampered or ambiguous evidence refuses the write.

The new deployment must have its slot, dispatch and runner-token controls
prepared before v5 stage approval. No variable edit or redeployment occurs
between v5 stage, run, shadow and paid execution. The owner separately
authorizes exact v5 stage, exact run, a new signed provider-free shadow with
integer zero cache-write/provider/slot counters, and an exact paid audit only
after fresh readback of all 80 reserved slots, source, root binding, runner,
price and deployment. V4 approvals and shadow never transfer to v5.

V5 has a separate maximum spend of 2,393,440 microUSD, subject to a new
explicit owner approval. Combining v4's held worst case and a fully spent v5
gives a cross-run worst case of **2,430,982 microUSD**. The owner must see
both figures before approving any new paid call. A lower owner cap requires a
new admission calculation and cannot be inferred from expected low usage.
The provider key remains only with the owner runner; no production database
credential enters it.

## 4. Stop, readback and review

Each v5 slot is consumed once, in fixed order, with no automatic retry or
replacement. A complete terminal receipt records a content-free result kind,
usage, explicit zero cache-write count, cost, latency and exact audit links.
A confirmed `failed` receipt remains in the denominator. Any unknown keeps
the full request reservation, closes v5, and blocks the next slot. Lost POST
responses are resolved by readback, never by resubmission. No v6 or third paid
run is authorized here.

Completion reporting distinguishes 80 valid terminal receipts from a safe
stop. A safe stop is not a quality pass. Even 80 terminals can produce `fail`
or `insufficient_evidence` under the unchanged numeric gate. No implementation
can guarantee a provider's 80 responses or a passing quality result.

Before merge or deployment, synthetic and PostgreSQL tests must cover old v4
audit immutability, single v5 successor, new-root/deployment/runner/price
drift, no paid dispatch before fresh approvals and shadow, complete failed
terminal billing, unknown stop and no retry. A different Claude Code Max
reviewer examines the policy and code without restricted content, followed by
CI. Merge, deployment, v5 stage/run/shadow and paid execution each require
their own applicable authorization and exact readback.
