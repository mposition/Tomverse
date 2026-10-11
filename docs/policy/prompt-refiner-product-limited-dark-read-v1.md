---
status: approved_production_limited_read_not_activated
policyVersion: 1
workId: CHAT-01
scope: PROMPT_REFINER_PRODUCT_PRODUCTION_LIMITED_DARK_READ
approvedBy: mposition
approvedAt: 2026-10-10
activationAuthority: none
paidDispatchAuthority: none
---

# Prompt Refiner product limited dark read v1

## 1. Approved implementation scope

The operator has authorised development, review, merge and default-off deployment
of the Prompt Refiner product connection and explicitly approved approvals
needed to finish it. This record applies that continuing approval to one narrow
implementation grant: product release admission may validate content-free
historical one-shot evidence through the three exact source files below.

The existing full-Auto exception remains a separate decision. Its approved
policy bytes are SHA-256
`6080eada4a66d5e9f45b07d6ae9314252119e68d0eb0269e1513a7bfd776c8a3`
at commit `75fbeade2a54a863bf94292a75935edf2df59418`, as recorded by
[the approval record](../ops/prompt-refiner-vnext-full-auto-release-exception-v1-approval.md).
That earlier policy approval does not itself name these production dark-table
reads. The `approvedBy` and `approvedAt` above record the operator's continuing
2026-10-10 product-connection approval for only the five exact pairs below. They are
not a new quality, activation or dispatch attestation.

This is the production permission for those exact reads after the enforcing
change passes required CI and independent review and is merged and deployed.
It is not Prompt Refiner product activation. The release remains closed until
its separate quality, limited-audit, Router, runtime and activation authorities
all pass.

## 2. Exact sources and five named access pairs

The grant is bound to all bytes of each source file. A source hash
change closes the grant until the new bytes receive the same review and an exact
approval.

| Source | SHA-256 | Dark table | Lexical access and product authority |
| --- | --- | --- | --- |
| `lib/promptRefinerVnextOneShotGateEvidence.ts` | `5bb5ef80cb3fb4d970561f354a9153994139818a67f749530c7f27b6189b50b3` | `PromptRefinerVnextOneShotStage` | The frozen file names a Stage `findUnique` only inside record exports. The product reader receives its stage from the caller and reads only hash-chained gate/disposition audit evidence; the Stage query is not authorised. |
| `lib/promptRefinerVnextOneShotGateEvidence.ts` | `5bb5ef80cb3fb4d970561f354a9153994139818a67f749530c7f27b6189b50b3` | `PromptRefinerVnextOneShotSlot` | The frozen file names Slot `findMany` only in `verifyConsumedSlotAudits`, reached by the record export. The product reader does not call it and this grant does not authorise it. |
| `lib/promptRefinerVnextOneShotOperationalShadow.ts` | `38ed57a470a50ab498cdca120701c866a3700a379f33280772f4da167b1881e4` | `PromptRefinerVnextOneShotStage` | The frozen file names a Stage `findUnique` only inside its record export. The product reader validates the caller-supplied stage against one shadow audit receipt; the Stage query is not authorised. |
| `lib/promptRefinerVnextOneShotTerminalReceipt.ts` | `b2de8a7e900e3b122e827ff6a0cebdd63812ed87acedaec8478602eb856cebc6` | `PromptRefinerVnextOneShotStage` | `findUnique` read used by `readPromptRefinerVnextOneShotTerminalReceipts`. |
| `lib/promptRefinerVnextOneShotTerminalReceipt.ts` | `b2de8a7e900e3b122e827ff6a0cebdd63812ed87acedaec8478602eb856cebc6` | `PromptRefinerVnextOneShotSlot` | `findMany` read of content-free terminal states and bounded reservation amounts. |

The TerminalReceipt source also contains a historical receipt-recording export
whose transaction takes a `FOR NO KEY UPDATE NOWAIT` read lock. Its production
route is excluded from this selective release. This approval does not authorise
that export, its lock, or a write. The product call chain is limited to
`readPromptRefinerVnextOneShotGateEvidence`, which calls the read exports named
in the table.

The permitted data is content-free operational state: stage and slot state,
deployment and price pins, approval and audit actor identity, audit identifiers,
counts, timestamps, bounded cost, and result classifications. It excludes
product Chat user and conversation identifiers, product Message content,
prompts, refined text, model output, holdout contents, answers, rubrics,
counterexamples and attachments.

## 3. Enforcement

This approval permits `scripts/check-dark-tables.mjs` to name only the five
source/table pairs above. The enforcement must:

1. keep all 17 dark tables and every existing named exception intact;
2. compare each of the three complete source files with the SHA-256 above before
   accepting its named pair;
3. fail closed if a byte changes, a fourth source appears, or another Stage or
   Slot pair is requested;
4. require the selective production release verifier to prove that all fifteen
   excluded lifecycle sources are absent and that retained runtime callers use
   only the named read exports; the verifier rejects direct, aliased,
   namespace, require, dynamic and re-export access to
   `recordPromptRefinerVnextOneShotGateEvidence`,
   `recordPromptRefinerVnextOneShotDisposition`,
   `recordPromptRefinerVnextOneShotOperationalShadow`, and
   `recordPromptRefinerVnextOneShotTerminal`; and
5. receive independent review before merge or deployment.

`scripts/check-dark-tables.mjs` enforces the exact source hashes and five named
table pairs for every branch. The selective production release additionally
runs `npm run verify:prompt-refiner-product-selective-release` for the omission
and caller proof. That release-specific proof is deliberately not a universal
ban on the separately approved lifecycle implementation and record callers that
remain on other branches. These guards are the only permission changed by this
policy. Product release admission still requires all of its separate evidence
and activation checks.

## 4. Explicit exclusions

This scope does not authorise a paid one-shot run, dispatch, retry, lifecycle
endpoint, stage or slot write, provider call, flag change, activation, quality
pass, limited-audit pass, Router release decision, budget change, user-credit
change, or access to another dark table. It does not waive the exact deployment,
source, price, receipt, budget, kill-switch, audit or Router gates. Missing,
invalid or unavailable evidence remains fail-closed.

The implementation sources existing in the repository and their earlier
implementation approvals are not a production access grant. This document also
does not activate explicit Refiner use or Auto application.
