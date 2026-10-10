# CHAT-01 Prompt Refiner selective production release scope

## Release identity

- Production base: `cf18bf4e71c341603410540177d3ac4cf4f2be6a`
- Prior cancellation checkpoint:
  `dd98e0fb261b44c573bddde792441a3b27a11fac`
- Latest main preserved before final validation:
  `666f7b164f7d3d101d1145a480324e6239773114`
- Integrated checkpoint before scope reduction:
  `332037d80fa816ce07590b266798e99cf0c09f6e`
- Work item: `CHAT-01`
- Mode: production installation with all product flags default off

The final candidate commit is assigned after this scope reduction is reviewed.
This record does not activate a flag, approve evidence or authorise a provider
call.

## Included product connection

The selective release retains the server-owned proposal, exact draft snapshot,
one-use decision consumption, authored Message preservation, shared Router and
provider execution view, receipts, operational Auto guard, aggregate Refiner
budget, owner status readback and release admission. The twelve Prompt Refiner
schema migrations retain their reviewed bytes and order.

It also retains the frozen candidate and gate source manifests. Removing an
execution endpoint does not rewrite a past evaluation, stage, slot, gate,
receipt or approval.

The latest main cancellation changes are merged into the candidate. The shared
fallback fixture retains both execution-message assertions and provider-abort
assertions, including cancellation after an accepted Refiner decision.
The merge also preserves PR #2327's `dispatchStartedAt` and
marker-before-provider boundary with its upstream SQL bytes unchanged, together
with PR #2326's normal release behaviour.

## Lifecycle functionality excluded from this release

This is an actual product-surface exclusion, not a scanner exception. The
following routes and services are absent from the production candidate:

- one-shot disposition and gate write routes;
- operational-shadow and v5 preflight routes;
- paid authorisation, stage approval and v5 stage approval routes;
- the internal one-shot slot dispatch and terminal settlement routes;
- paid authorisation, slot consumption, stage admission, v4 stage writer,
  v5 predecessor readback and v5 stage writer services.

Fifteen source files and thirteen tests dedicated to those omitted functions are
removed. Package scripts and the DB integration harness no longer advertise the
omitted endpoints. The universal admin route guard retains its reviewed,
conditional lifecycle exceptions so a later back-merge does not break the
normal develop tree; with the routes absent, those exceptions grant nothing in
this candidate. Tests for the retained product connection and its database
assertions remain in scope; no product execution assertion is skipped.

The frozen owner runner still names the internal slot and terminal URLs because
changing its bytes would change the evaluated candidate. In this production
candidate neither URL has a route, so an owner one-shot paid run is unavailable.
This is the intended fail-closed result of the selective release.

## Limited read authority

Version 1 recorded three evidence sources and five lexical Stage/Slot pairs.
Independent review found that the product release store also performed an
unhashed full-Stage lookup, which was outside that grant. A follow-up source
audit found that v1 also misdescribed the frozen gate read: it does execute its
Slot audit query and reaches Stage/Slot through StageReadback, and the v5 branch
also reaches the consumed-request verifier through TerminalReceipt. Version 1
remains the historical record of those errors.

[Prompt Refiner product limited dark read v2](../policy/prompt-refiner-product-limited-dark-read-v2.md)
applies the operator's continuing 2026-10-10 product-connection approval to the
corrected boundary: one new server-only Stage snapshot reader, the three v1
sources, and the two byte-identical transitive pure-read sources. The exact
scope is six source hashes, ten lexical source/table pairs and seven static
named read edges. The snapshot selects only the fields required by the frozen
gate, disposition, approval-audit, owner and candidate-source checks. The
product release store no longer has a Stage or Slot exception and may only
import the snapshot reader's named read export. GateEvidence's historical
StageReadback lock-helper import and OutcomeRecovery's emergency stop path
remain under their separate legacy authorities; v2 does not grant them to
product admission. This permission takes effect only after required CI and
independent review pass and
the exact change is merged and deployed; it does not activate Refiner or
authorise a paid call.

The generic static guard rejects a seventh source, source-byte drift and any
additional or changed file/table pair. The release harness must also run
`npm run verify:prompt-refiner-product-selective-release`; that verifier checks
the actual candidate tree for all fifteen omissions and rejects any retained
runtime caller of the reviewed modules that imports a record export, imports
the snapshot through a non-named form, or calls it from a path other than the
product release store. It also proves the seven product read edges without
forbidding the separate frozen Gate lock import or retained emergency stop
caller. Its fixture test covers positive and negative inventories without
making source absence a universal repository rule.

The remaining blockers are unchanged: the available quality result is not a
qualifying pass, unresolved limited-audit findings are nonzero, all three Router
release decisions are pending, and no exact product activation exists. These
facts keep explicit and Auto product release closed even after code deployment.
