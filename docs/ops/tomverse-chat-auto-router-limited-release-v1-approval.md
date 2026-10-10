---
status: pending_exact_approval
workId: CHAT-01
approvalVersion: 1
exceptionId: CHAT-01-AUTO-ROUTER-LIMITED-RELEASE-V1
approvedBy: null
approvedAt: null
approvedPolicyCommit: null
approvedPolicySha256: null
evaluatedImplementationCommit: null
targetEnvironmentName: null
targetEnvironmentId: null
targetServiceId: null
maxRolloutPercent: null
eligiblePlans: []
expiresAt: null
evidenceRef: null
knownLimitations: null
activationAuthority: none
paidDispatchAuthority: none
---

# CHAT-01 Auto Router limited-release approval record

This record is intentionally pending. The request to prepare a smaller launch
boundary is not the final approval of an unknown deployment, population, or
cost scope. Its nullable fields are filled only after the implementation and
content-free evidence are concrete and the operator has reviewed them.

An approved record must bind the exact policy commit and SHA-256, evaluated
implementation commit, Railway environment and service, maximum percentage,
exact eligible plans, expiry, evidence location, and written limitations. Its
runtime counterpart in `lib/autoRouterLimitedReleaseApproval.ts` must carry the
same decision. Activation additionally requires the live serving commit in
`AUTO_ROUTER_LIMITED_RELEASE_COMMIT`; the post-activation runtime readback
records the exact deployment ID.

The fixed scope is `ROUTING_DISPATCH_INSTRUMENTATION=enforce`, a valid manifest
keyring, automatic fallback off, one provider dispatch per logical assistant
response, and existing Chat entitlement and provider guardrails only. This is
not a new whole-turn cap when one turn contains multiple logical responses.
The three ordinary readiness
gates remain pending. This record never authorizes Refiner changes, a new paid
evaluation, a merge, deployment, or environment change by itself.
