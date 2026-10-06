---
status: draft
policyVersion: 1
workId: CHAT-01
scope: ONE_SHOT_UNRUN_STAGE_REPLACEMENT
approvedBy: null
approvedAt: null
---

# Prompt Refiner vNext one-shot: unrun stage replacement

This addendum applies only to the approved one-shot v2 policy and the first
stage created for that policy. It permits one replacement stage after an app
deployment changed before run approval. It grants no paid dispatch, product
traffic, or holdout access to the candidate author. The v2 numeric contract,
candidate source, corpus, and owner custody rules stay fixed.

Before replacement, the app must directly verify that the first stage is
`staged`, has a valid human stage approval and hash-chained audit, has exactly
80 reserved slots and zero consumed slots, and has no run approval or unknown
outcome. Its owner, candidate source, runner, restricted manifest root, price
pin, and per-request and full-run ceilings must match the requested replacement.
The first stage's deployment must differ from the active deployment. Any
missing or conflicting evidence refuses replacement.

The first stage and all its slot rows remain immutable historical evidence.
The app closes it and creates a distinct, single-use replacement stage with
80 new reserved slots and a separate human stage approval audit in one
transaction. The close has its own linked human audit. A closed first stage
cannot approve a run or consume a slot. The replacement cannot be repeated;
no third stage ID or reset path exists. Only the replacement's 80 slots are
eligible for the one paid run, so the total executable ceiling remains
2,393,440 microUSD and 29,918 microUSD per request.

The replacement stage must bind the exact active app deployment and its
commit. The app reobserves source bytes, Railway deployment, registry price,
owner custody pins, and all 80 slots before committing. The owner separately
approves the replacement run with recent reauthentication and exact pins.
The run approval and its own hash-chained audit commit together, after which
a content-free readback must show the same stage, deployment, audit, and
80 unconsumed slots. Stage approval never substitutes for run approval.

If an approval response is lost, the operator reads the stored stage and
audit before any retry. A mismatch or unknown outcome stops the procedure.
No holdout text, answer, rubric, counterexample, output, or content-derived
digest enters the public repository, Codex, ordinary receipts, or alerts.
The restricted root remains only in the owner-controlled approval store.

This addendum requires an exact commit and file SHA-256 approval before
implementation is merged or deployed. Code and migration must pass synthetic
rollback, concurrency, duplicate-stage, drift, audit-integrity, and
no-consumption tests and independent Claude Code Max review. The operator
must separately authorize the exact replacement deployment, stage, and run.
