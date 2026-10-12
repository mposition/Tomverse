---
status: implementation_review_pending
policyVersion: 2
workId: CHAT-01
approvedBy: null
approvedAt: null
scopeAuthorizedBy: mposition
scopeAuthorizedAt: 2026-10-13
approvalTimezone: Australia/Brisbane
scope: CHAT_REFINER_AND_GUEST_RELEASE_CONTINUITY
activationAuthority: owner_action_after_exact_release_readback
guestQuotaIncrease: none
refinerDailyCostCapUsd: 100
refinerMonthlyCostCapUsd: 3000
refinerPerRequestCeilingMicroUsd: 29918
refinerRetryCount: 0
---

# Chat and Guest release continuity v2

The operator requested that an unrelated production web deployment no longer
turn off Tomverse Chat or Guest Smart Adaptive. This replaces the continuing
authority check of the initial Auto and Guest v1 releases. It does not change
the v1 audit facts, claim a new quality verdict, or silently convert their
exact-deployment approvals into broader approvals.

## Owner activation and continued authority

After the reviewed v2 code and required schema are installed, the owner records
one new, hash-chained Router/Refiner activation pair and, separately, one Guest
activation. The owner action still requires recent administrator authentication,
same-origin mutation, a checked exact serving deployment and source readback.
The activation audit records its commit and deployment UUID as provenance.

The continuing lookup key binds a stable SHA-256 execution-source fingerprint
to the effective Router configuration and pinned Refiner candidate, price,
adapter and policy digests, not the deployment UUID or whole Git commit. The
source fingerprint covers the checked-in Chat, Auto, Router, Refiner, Guest,
model/pricing, provider, manifest, credit and audit execution modules, their
local import closure, the Chat and release routes, the relevant Prisma model
definitions, and the lockfile entries for dependencies reached by that
execution graph. The shared proxy contributes its host/origin/bearer/request
admission region and the selected request-boundary helpers. The shared
maintenance route is excluded; its Chat credit settlement implementation is
already in the Chat execution closure. This avoids binding marketing and
unrelated maintenance edits to Chat activation. File paths and bytes are both
hashed. Missing or unreadable source closes authority. The exact path-selection
code is in the fingerprint, so changing its coverage also changes the key.
The versioned policy body is bound by its own digest; frontmatter status changes
do not rotate an active release. An unrelated AMUX,
marketing, homepage or Composer-only deployment may continue using the same
owner activation when this fingerprint and all effective controls are unchanged.
An executable boundary or effective control change requires a new reviewed
release and owner activation. A changed or ambiguous authority key cannot
inherit the old audit, but the owner may record a new audit pair for the new key.

The effective Router cohort, eligible plans, fallback, instrumentation, manifest
key ID, checked-in Refiner candidate/price/adapter, Guest policy and Guest
execution contract remain separately bound. Current price registry, audit
integrity, release pair, product rollout, kill switches, durable Auto stop latch,
Guest signed subject and one-turn claim, ordinary Chat/Guest quota and every
reservation/settlement/unknown hold are still checked at their original
boundaries. No source fingerprint, deployment success or stored flag alone
authorizes a paid turn. Unknown outcome stops without replay.

An in-flight Guest capability token minted by an old deployment remains
short-lived and may be refused after deployment; the client can obtain a new
read-only capability. This does not disable the Guest release. No provider
request or paid test is authorized by this policy change.

## Migration and completion

The v1 actions remain immutable and valid only under their original exact
deployment contract. V2 records use a distinct target type and metadata
version. Deployment of v2 without its new owner activation stays closed. The
first activation must follow exact runtime/source/schema/control readback and
the applicable independent contract review. Thereafter a deployment with an
unchanged fingerprint can remain active without another owner action.

Implementation, local tests, independent review, PR readiness, CI, merge,
deployment and live activation are separate statuses. The already recorded
B08 quality/evaluation failures and pending Router attestations remain pending
under the initial-release exception, not PASS. The statistics system remains
a separate work item.
