# CHAT-01 initial Refiner release: second-review exception

- Decision maker: mposition, in the active development conversation.
- Decision observed: 2026-10-11T05:05:35Z (observation time, not an invented message timestamp).
- Instruction: `xAI 두번째 검토 없이 다음으로 넘어가주세요`.
- Scope: omit the second xAI independent review for this initial Refiner and
  Chat Auto automatic-application release. This is a one-release owner
  exception to the distinct-vendor review requirement, not two-vendor acceptance.

Actual review job `r-20261011-011443-f4e5d4` evaluated source
`5563e1b2c916d92de89d59dab71f3f1680a8c95a`, with truthful Codex/OpenAI
authorship and automatic nearest base
`d5eb48b8eff1827a3f61c0eaa8a40abddb4ae256`. Copilot/Moonshot returned
ACCEPT with zero findings. Its raw report SHA-256 is
`3cc05f67aab7d18bae54c807fb599d07e4e7ba238cdc66238f2cfe702b8fc100`.

That report explicitly discloses partial coverage after its session credit
limit. Parts of budget settlement and unknown holds, the stop latch, product
deduplication and scope ABA, store internals and migration SQL were not fully
reviewed. The ACCEPT is not a full-coverage claim. The Cursor/xAI slot had not
made an actual call when the operator waived it; its last observed state was
queued. No xAI verdict, joint ACCEPT, capacity override or reviewer-identity
change is represented by this record.

The operator subsequently reported `closedSlots: 1` for this exact job. Actual
review-server RPC readback confirmed slot 0 remains Copilot/Moonshot
`done/accept`, while slot 1 is `done/unknown/cancelled_by_operator`, with no
actual provider or vendor assigned. The aggregate is `unknown`, not ACCEPT.
There is no remaining xAI dispatch for this job and no temporary capacity
configuration to restore.

The existing exact-source validation receipt for `5563e1b2c` binds 26 passing
applicable check rows and 72 artifacts, SHA-256
`1246a5dd07eab35074326a42e2b5ab8373aaacea19443565c1938c44f99c4cd1`.
It does not certify a later source or a serving deployment. Integration of
subsequently merged upstream changes must preserve their approved behavior
and receive the relevant source and seam checks; changed-source evidence is
recorded separately.

This exception does not waive required CI, normal PR and merge procedures,
develop-first source ordering, exact staging and production verification,
canonical owner activation, original Message storage, scope-bound single
consumption, shared Router/provider execution input, actual budget reservation
and settlement, audit integrity, kill switches, or enforced finalized manifests.
It does not enable a flag, authorize an unbounded paid test, or alter any
runtime policy or release gate. The frozen initial policy remains
`chat-refiner-initial-auto-release-v1`, committed first at
`3aeb001a4abde2d93e945ed5e5de61b10c412c0b`, SHA-256
`a9dbe509a056152015a59a45fd6438304fac36f36521a1319c11f8d1704970f9`.

The B08 quality, challenge, latency and evaluation-audit limitations, the
34 unresolved evaluation suspicions, and the three pending ordinary Router
readiness attestations remain disclosed follow-up under the separately
approved initial-release policy. They are not changed to PASS. Product
connection completion requires the exact active deployment and actual runtime
evidence; this review exception alone does not complete the connection or
CHAT-01.

## PR #2342 source-order and final-source disposition

- Decision maker: mposition, in the active development conversation.
- Decision observed: 2026-10-11T05:38:37Z (observation time).
- Instruction: `이번 PR의 두 절차 예외 승인`.
- Scope: PR #2342 only, for the initial Refiner and Chat Auto automatic-
  application release.

The owner approved releasing this selective release PR to main before its
develop backport. Existing develop Stage/Slot permission failures remain
separate unresolved work; this decision grants no additional table access and
does not represent those checks as passing.

For this PR, the owner also approved judging the final main integration using
the prior partial Moonshot report, checks on the current source and required
CI, without another model review. Neither that disposition nor the second-
review waiver changes the old source's ACCEPT into a verdict on a new head.
Subsequent CI failures must still receive a concrete fix and relevant tests;
the final PR head and exact CI results must be recorded before merge.

These two narrow decisions supersede only the develop-first source ordering
and additional final-source model review conditions for this PR. Required
CI, exact staging and production verification, canonical owner activation,
original Message storage, single consumption, shared Router/provider input,
budget reservation and settlement, audit integrity, kill switches and
finalized manifests remain required. No deployment or activation is attested
by this record.

## Required CI corrections

The first PR candidate, `fe41cd4d6083df24c29e30f0c9eb4b3268c39821`, failed
CodeQL on SHA-256 hashing of the internal one-shot stop bearer token. The
correction compares the bounded UTF-8 token bytes directly with
`timingSafeEqual` after checking equal byte lengths. The existing refusal,
single-writer and unknown-outcome contracts remain in place; the security
finding is not suppressed or waived.

Its shared PostgreSQL agents lane also failed two full-schema test assertions
that checked the entire audit history with one test process's synthetic key.
Other suites use different synthetic keys in that same database. The test
now verifies its own canonical Refiner rows and their immediate predecessor
links. Product audit writers, runtime integrity verification and permissions
remain unchanged. These corrections require current-source tests and new
required CI results; the failed candidate is retained as history.
