---
status: approved
workId: CHAT-01
approvalVersion: 1
exceptionId: CHAT-01-AUTO-ROUTER-LIMITED-RELEASE-V1
approvedBy: mposition
approvedAt: 2026-10-11T00:44:09Z
approvedPolicyCommit: fa997387b93ddfaa181ffd98918247ed8c6d02d3
approvedPolicySha256: a0d0f119d1c5ab9d647ef5c72cd8af658e4cd8b4b5c92d23d6bca3c0adc6999b
evaluatedImplementationCommit: 1f5d4c60123fc33b5e40f9b5f5cb4e36bd29b177
evaluatedArtifactSha256: 159f2227c1ece70e18df8450ae313053813b280d1e21048b50ac18067fe4999f
targetEnvironmentName: production
targetEnvironmentId: 4ffdeab7-a1fb-4ec1-bf4a-4dd2818ba668
targetServiceId: f0a4f7f4-a476-4726-87a6-9114f8da8147
maxRolloutPercent: 100
eligiblePlans: [Free, Pro, Max]
expiresAt: 2026-11-10T00:00:00Z
evidenceRef: "docs/ops/tomverse-chat-auto-router-limited-release-v1-approval.md#approved-evidence"
knownLimitations: "Routing uses neutral scores and answer quality is unproven; representative Shadow evidence and the full durable Chat cancellation, stream-failure, failure-matrix, and operational-latency coverage remain incomplete; deployments without readable source fail closed; future main SHAs require separate approval; the earlier UI 21 and PostgreSQL provenance 42 checks were not rerun for the final RC."
activationAuthority: operator_runtime_selector
paidDispatchAuthority: existing_chat_request_only
---

# CHAT-01 Auto Router limited-release approval record

At `2026-10-11T00:44:09Z`, mposition approved the exact bounded release in
this record. The approved proposal SHA-256 is
`6c07b105f31afdaede6f9291a86e8a142e4ea79e1f86e1aae3ca57efa1c41601`.
This approval leaves `shadow_report`, `offline_quality_evaluation`, and
`attempt_manifest_boundary` pending. It is not an attestation for any of
them, a quality certification, a Refiner release, or CHAT-01 completion.

## Approved evidence

The approved policy is commit
`fa997387b93ddfaa181ffd98918247ed8c6d02d3`, canonical-LF SHA-256
`a0d0f119d1c5ab9d647ef5c72cd8af658e4cd8b4b5c92d23d6bca3c0adc6999b`.
The approval timing has two distinct events. The operator reviewed the
already-existing candidate policy at commit
`1f5d4c60123fc33b5e40f9b5f5cb4e36bd29b177` (Git author time
`2026-10-11T00:35:00Z`; commit time `2026-10-11T00:35:16Z`), whose
canonical-LF policy SHA-256 was
`2b9090ffcdcd3f34a5497ed87809cea5f1ff056a62db67e3d6d0b9959c589be3`.
The human reply was observed at `2026-10-11T00:44:09Z`. Commit
`fa997387b93ddfaa181ffd98918247ed8c6d02d3` (Git author and commit time
`2026-10-11T00:44:58Z`) is the post-reply transcription of that approval into
policy frontmatter; `approvedAt` is the human-reply observation time, not a
backdated Git commit time. The policy body stayed exactly 6,113 bytes with
SHA-256 `50186c3ce7751d0114430fcfac1823743a957c5d4d92398a796d5c018f41b991`
across those commits.
The evaluated implementation is the fixed public source at
[`1f5d4c60123fc33b5e40f9b5f5cb4e36bd29b177`](https://github.com/mposition/Tomverse/tree/1f5d4c60123fc33b5e40f9b5f5cb4e36bd29b177),
whose 18-path functional artifact SHA-256 is
`159f2227c1ece70e18df8450ae313053813b280d1e21048b50ac18067fe4999f`.
The content-free final validation receipt SHA-256 is
`805296f6695971684c5bf695a262e0db373b2e4916f2d67bd7a659fc307bd95e`;
the evaluated-source receipt SHA-256 is
`002ddbba9806d507dc5dee746869f55ec86cf696c30739f81e96e19be8ddb894`.

The final RC validation covered 106 focused tests, 30 main route/Admin
contracts, 15 client contracts, lint, typecheck, production build, and 12
static checks. The 8 database helper/migration blobs matched the source used
for the prior isolated PostgreSQL 17 provenance run of 42 tests. The 21 UI
tests and those 42 database tests were not rerun for the final RC and are not
reported as such.

Official review `r-20261011-003542-ce200f` recorded an actual independent
Moonshot ACCEPT. Its non-blocking source-tree availability finding is retained:
a deployment without readable source fails closed. The earlier major rejection
of source binding was fixed rather than waived. A second vendor remained
queued and unavailable. For this release only, mposition approved omitting
that unavailable second vendor after the actual independent ACCEPT and a final
metadata review; this is not two-vendor acceptance and does not carry forward.

## Approved target and limits

The target is Railway environment `production`
(`4ffdeab7-a1fb-4ec1-bf4a-4dd2818ba668`) on service
`f0a4f7f4-a476-4726-87a6-9114f8da8147`. The maximum is 100 percent of
authenticated Free, Pro, and Max Chat users who explicitly select Auto,
including eligible users who join during the release. Guests, Review, manual
selection, the ordinary model and product filters, entitlement, credit,
provider-budget, moderation, context, capability, and kill-switch boundaries
remain unchanged. The approval expires at `2026-11-10T00:00:00Z`.

Production activation is limited to these settings:

- `AUTO_ROUTER_LIMITED_RELEASE_EXCEPTION=v1`
- `AUTO_ROUTER_LIMITED_RELEASE_COMMIT=<final full serving SHA>`
- `TOMVERSE_AUTO_ROUTER_UI_ENABLED=true`
- `AUTO_ROUTER_ROLLOUT_PERCENT=100`
- `AUTO_ROUTER_ELIGIBLE_PLANS=Free,Pro,Max`
- `AUTO_ROUTER_COHORT_SALT=chat01-limited-release-v1-20261011-production`
- `ROUTING_DISPATCH_INSTRUMENTATION=enforce`
- `AUTO_ROUTER_FALLBACK_ENABLED=off`

The existing manifest keyring is verified without returning its value and is
not changed. Shadow remains enabled and the kill switch must read back as off.
The serving SHA pin must match the actual deployment; any later main SHA is
rejected until separately approved. Rollback is the ordinary kill switch or
turning the selector off. No new paid validation call is authorized: zero new
paid calls and US$0. Ordinary user-initiated Chat remains governed by existing
credits and provider guardrails.

## Single-release execution authorization

mposition separately approved pinning the same RC in Test environment
`9347d760-66f6-430b-8f2f-36fd5dbef333`, verifying it without Send, and
restoring that environment's original source. The production release path is
PR #2337 followed by selective release PR #2338. The release may omit the
full Nightly visual regression and physical-device matrix; those items remain
not verified rather than passing.

Production dependency audit reported zero findings. The five development-path
findings derive from the single `braces` advisory
`GHSA-vfj7-8cjw-p6xm`; mposition accepted that advisory only for this release.
No earlier advisory exception is reused.

The normal merge train remains first. If the only remaining blocker for PR
#2338's final frozen metadata head is the main rule requiring one GitHub
approval, mposition authorized a single `--admin --match-head-commit` merge.
Required CI, the actual independent ACCEPT, Test verification, and final
metadata review are not waived. Branch protection is not changed, and this
authorization does not apply to another PR, head, or release.

The checked-in policy approval, this record, and the runtime selector are
separate controls. This record alone does not merge, deploy, change an
environment, or authorize a different serving commit. Post-activation readback
must record the exact commit and deployment, admitted exception, effective
plans and percentage, enforce mode, configured keyring, UI/cohort admission,
and kill/manual boundaries.

## Known limitations

Answer-quality non-inferiority is unproven and routing uses neutral scores.
Representative production Shadow coverage is not established. Durable Chat
cancellation, stream failure, the full failure matrix, and operational latency
coverage remain incomplete. A deployment without the expected source tree
fails closed. Any future main SHA requires a separate approval. The earlier UI
21 and PostgreSQL provenance 42 results were not rerun for the final RC. These
accepted limits do not change the three pending readiness records or their
eventual evidence requirements.
