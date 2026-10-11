---
status: proposed_exact_approval_pending
policyVersion: 1
workId: CHAT-01
scope: AUTO_ROUTER_LIMITED_RELEASE_EXCEPTION
scopeRequestedBy: mposition
scopeRequestedAt: 2026-10-11
approvedBy: null
approvedAt: null
activationAuthority: none
---

# Tomverse Chat Auto Router limited-release exception v1

## 1. Decision and boundary

This policy permits a separately approved, bounded Auto Router product release
while `shadow_report`, `offline_quality_evaluation`, and
`attempt_manifest_boundary` remain `pending`. It does not mark any of them
`passed`, change their evidence requirements, or declare CHAT-01 complete.
The product must continue to describe the quality risk honestly: the paired
offline non-inferiority claim has not been established, so Auto may say it
chooses a model but may not promise the best, optimal, or improved answer.

The irreversible action is the provider dispatch: it can spend money and
creates permanent message, routing-attempt, manifest, and settlement records.
This exception therefore changes only the readiness admission predicate. It
does not waive the routing policy's dispatch, manifest, billing, authorization,
moderation, capability, context, or audit boundaries.

## 2. Conditions that may not be waived

The limited release is admitted only when all of these are true at once:

1. A checked-in human approval record names the exact policy commit and digest,
   evaluated implementation commit, approver and time, expiry, evidence
   reference, known limitations, target Railway environment and service,
   eligible plans, and maximum rollout percentage. A pending, malformed,
   expired, or incomplete record grants no authority.
2. `AUTO_ROUTER_LIMITED_RELEASE_EXCEPTION=v1` is explicitly set. Unset and all
   other values are off. `AUTO_ROUTER_LIMITED_RELEASE_COMMIT` must be a full
   commit SHA equal to the serving `RAILWAY_GIT_COMMIT_SHA`; the approved
   environment and service IDs must also match the serving process.
3. `ROUTING_DISPATCH_INSTRUMENTATION=enforce` and the active manifest keyring
   resolves. Observe mode, an invalid keyring, or instrumentation failure may
   not be accepted as a beta limitation.
4. Automatic provider fallback remains off. The release authorizes at most one
   provider dispatch per logical assistant response and adds zero provider
   attempts compared with the ordinary one-attempt response. A Chat turn may
   contain more than one logical response; this exception does not create a
   new global turn cap. Existing Chat entitlement, credit,
   provider-budget, and operational guardrail decisions remain authoritative;
   this exception creates no separate spend allowance.
5. The live rollout percentage is above zero, no greater than the human-
   approved maximum (which may be 100 for a small explicitly chosen eligible
   population), and the live eligible-plan set exactly matches the approval.
   The ordinary non-empty cohort salt and deterministic bucket still apply.
6. The readiness register itself is well formed. The exception may accept
   honest `pending` entries; it may not hide a missing/duplicate entry, an
   expired ordinary attestation, or any other register validation problem.

The ordinary kill switch is still first and unconditional. Guests remain
excluded. Only Chat conversations may be offered Auto. Returning to manual is
always accepted. Plan/model allowlists, product boundary, attachments,
capability and context filters, rate/concurrency limits, moderation, credits,
and the no-candidate fallback to the user's own model remain unchanged.
Prompt Refiner behavior is outside this exception and is not enabled or
modified by it.

## 3. Evidence and activation

The operator may accept the explicitly disclosed quality and low-traffic
coverage risk for this limited release without creating a new paid evaluation
run. Existing deterministic, database, route, migration, and exact-source
validation may support that decision. It does not become shadow evidence,
paired quality evidence, or a passed attempt/manifest attestation.

Before activation, the operator must choose the exact target service and
environment, eligible plans, rollout maximum and live percentage, expiry, and
the serving commit. The checked-in approval and runtime selector are separate:
neither one alone authorizes routing. After activation, the runtime readback
must show the exact build and deployment, admitted exception, effective
percentage and plans, `enforce`, and a configured manifest keyring. That
content-free readback is the deployment receipt; a deployment ID is not put in
the pre-deployment approval because doing so would require another deployment
and invalidate its own target.

Any mismatch, expiry, unreadable approval, instrumentation downgrade, invalid
keyring, fallback enablement, or scope increase fails closed to the ordinary
`readiness_incomplete` behavior. Rollback uses
`AUTO_ROUTER_KILL_SWITCH=on`; conversations may remain stored as `auto` and
fall back to the user's model as the rollout runbook already specifies.

## 4. Reporting

Operator and release reporting must say:

- three ordinary readiness gates remain pending;
- Auto is running under the named limited-release exception, if admitted;
- offline quality non-inferiority is unestablished;
- the exact target, scope, expiry, evidence and known limitations accepted by
  the person approving activation; and
- Refiner release state and CHAT-01 completion are unchanged.

The exception marker and the outstanding gate IDs travel with the server's
cohort decision. The client still receives only `offered`; it never receives a
bucket, percentage, salt, readiness status, or exception detail.
