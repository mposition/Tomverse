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
