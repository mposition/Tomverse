---
status: approved_scope
policyVersion: 3
workId: CHAT-01
approvedBy: mposition
approvedAt: 2026-10-13
approvalTimezone: Australia/Brisbane
scope: CHAT_REFINER_AND_GUEST_OPERATOR_CONTROLLED_AVAILABILITY
---

# Operator-controlled Chat availability

On 2026-10-13 the operator requested immediate production reactivation and
removal of code paths that automatically disable an already activated Chat.
This decision supersedes the source-change reactivation requirement in
`chat-refiner-stable-release-authority-v2.md` and the automatic global Auto
pause requirements in `prompt-refiner-vnext-full-auto-release-exception-v1.md`.

The latest valid Owner Router/Refiner activation pair continues across source,
Git commit and deployment changes. Source fingerprints remain immutable audit
provenance, rather than an automatic product off switch. The current effective
Router controls, pinned candidate/price/adapter, audit integrity and exact
activation metadata are still verified. A newer invalid activation cannot
fall back to an older approval. Guest continuation verifies the same base
activation pair and its own latest valid Owner activation.

The operator's existing rollout controls and emergency switches determine
whether the feature is enabled. Operational observations record a content-free
audit event without changing the persistent Auto guard state or rollout flag.
The existing `prompt-refiner-product-execution` actor records only
`prompt_refiner.product_auto_guard_observed` against
`PromptRefinerProductOperationalGuard`; it gains no direct audit-table writer
or additional target permission.
Repeated observations of one reason are deduplicated for one hour within an
Owner generation; later recurrences are recorded again without disabling Auto.
An unsafe or failed request retains its existing refusal or original-input
fallback; an unknown provider result is never replayed or assigned zero cost.
Existing unknown reservations, claims, user credits, Guest quotas, provider
budgets, deadlines, retry count zero and reservation/settlement enforcement
are unchanged. No new provider call or paid test is authorized here.

Legacy paused guard rows still require the existing Owner resume operation.
Original activation, pause and quality-failure records remain immutable. The
historical failed evaluations and deferred Router measurement gates do not
become PASS. Implementation, independent review, merge, deployment and live
verification are separate completion steps.
