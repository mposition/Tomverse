---
status: approved_production_limited_read_not_activated
policyVersion: 2
workId: CHAT-01
scope: PROMPT_REFINER_PRODUCT_PRODUCTION_LIMITED_DARK_READ
approvedBy: mposition
approvedAt: 2026-10-10
revisionRecordedAt: 2026-10-11
activationAuthority: none
paidDispatchAuthority: none
supersedes: prompt-refiner-product-limited-dark-read-v1
---

# Prompt Refiner product limited dark read v2

## 1. Narrow corrections to v1

The operator authorised the approvals needed to complete the product connection
on 2026-10-10. Version 1 applied that continuing approval to five lexical dark
source/table pairs. It remains the historical record, including descriptions
that did not match the frozen code's actual read path:

- `readPromptRefinerVnextOneShotGateEvidence` calls
  `readPromptRefinerVnextOneShotStage`, so its product path reads Stage and Slot
  through `promptRefinerVnextOneShotStageReadback.ts`;
- the same gate read executes `verifyConsumedSlotAudits`, including the Slot
  `findMany` that v1 described as reachable only from a record export; and
- for v5, the gate read calls the terminal receipt reader, which reaches the
  Stage readback and the consumed-request verifier in
  `promptRefinerVnextOneShotOutcomeRecovery.ts`.

Independent review also found that the product release store queried a full
Stage directly from an unhashed fourth source. Version 2 corrects both gaps. It
adds a server-only selected-field Stage reader and binds the two existing
transitive pure-read sources to their byte-identical source hashes. Product
release admission may use exactly six source hashes, ten lexical Stage/Slot
pairs and the seven named read edges in section 4.

This correction becomes production permission only after required CI and
independent review pass and the exact change is merged and deployed. It is not
a quality judgement, activation record, limited-audit receipt, Router decision
or dispatch approval. `activationAuthority` and `paidDispatchAuthority` remain
`none`.

## 2. Exact six sources and ten lexical pairs

| Source | SHA-256 | Dark table | Product read authority |
| --- | --- | --- | --- |
| `lib/promptRefinerProductStageSnapshot.ts` | `74ad9fd42081d6eee8afa9032bb73bc42f91ddde60735ed42f75737de3a42ac6` | `PromptRefinerVnextOneShotStage` | One `findUnique` with the selected fields in section 3. Only the product release store may import its named read export. |
| `lib/promptRefinerVnextOneShotGateEvidence.ts` | `5bb5ef80cb3fb4d970561f354a9153994139818a67f749530c7f27b6189b50b3` | `PromptRefinerVnextOneShotStage` | The direct Stage query remains confined to a historical record export and is not executable authority for the product path. The full-file hash keeps that boundary fixed. |
| `lib/promptRefinerVnextOneShotGateEvidence.ts` | `5bb5ef80cb3fb4d970561f354a9153994139818a67f749530c7f27b6189b50b3` | `PromptRefinerVnextOneShotSlot` | Its read export executes `verifyConsumedSlotAudits`, selecting consumed slot identity, index and request binding for the signed digest. |
| `lib/promptRefinerVnextOneShotOperationalShadow.ts` | `38ed57a470a50ab498cdca120701c866a3700a379f33280772f4da167b1881e4` | `PromptRefinerVnextOneShotStage` | The direct Stage query remains confined to a historical record export. The product path supplies the selected Stage and reads the signed shadow audit evidence. |
| `lib/promptRefinerVnextOneShotTerminalReceipt.ts` | `b2de8a7e900e3b122e827ff6a0cebdd63812ed87acedaec8478602eb856cebc6` | `PromptRefinerVnextOneShotStage` | The v5 read export checks the exact stage and its content-free run binding. |
| `lib/promptRefinerVnextOneShotTerminalReceipt.ts` | `b2de8a7e900e3b122e827ff6a0cebdd63812ed87acedaec8478602eb856cebc6` | `PromptRefinerVnextOneShotSlot` | The v5 read export selects terminal slot state, bounded reservation and request binding. Its record export remains excluded. |
| `lib/promptRefinerVnextOneShotStageReadback.ts` | `adce761677ea1907dd5f0aeba58d2dd76bcc9c033eac94c72472e991de94d130` | `PromptRefinerVnextOneShotStage` | The named diagnostic read checks the current and required predecessor Stage rows and their approval/replacement audit bindings. |
| `lib/promptRefinerVnextOneShotStageReadback.ts` | `adce761677ea1907dd5f0aeba58d2dd76bcc9c033eac94c72472e991de94d130` | `PromptRefinerVnextOneShotSlot` | The named diagnostic read selects slot index, status, bounded reservation, request binding and consumption time to validate the reservation shape. |
| `lib/promptRefinerVnextOneShotOutcomeRecovery.ts` | `bfcb62b97199cfa8a54a9edae330f02cfdf332e198c4c4e5090b30b49fb7c7e2` | `PromptRefinerVnextOneShotStage` | For v5 terminal validation only, `verifyPromptRefinerVnextOneShotConsumedRequest` checks the stage's run-approval binding. |
| `lib/promptRefinerVnextOneShotOutcomeRecovery.ts` | `bfcb62b97199cfa8a54a9edae330f02cfdf332e198c4c4e5090b30b49fb7c7e2` | `PromptRefinerVnextOneShotSlot` | The same pure verifier checks one consumed slot's request, index, time and bounded reservation, then returns only its slot id. |

The three v1 sources and the two existing transitive sources remain
byte-for-byte frozen. Adding the latter hashes does not grant their sibling
lock, stop, write or readback exports to the product path. Existing legacy
StageReadback and emergency outcome-stop authorities remain separate and are
not expanded by this policy.

## 3. Exact selected Stage snapshot

The new reader selects only these content-free fields:

- identity and state: `id`, `status`;
- candidate and runtime pins: `sourceCommitSha`, `sourceManifestDigest`,
  `runnerDigest`, `runtimeDeploymentId`, `runtimeCommitSha`, `pricePinDigest`;
- bounded execution shape: `perRequestCostMicroUsd`, `slotCount`,
  `costCeilingMicroUsd`;
- owner and approval evidence: `approvedBy`, `approvedAt`,
  `stageApprovalAuditLogId`, `runApprovalAuditLogId`, `manifestRoot`.

`manifestRoot` and `approvedAt` are included only because the frozen approval
audit validator compares the canonical approval metadata and approval time
against them. They are not returned to a browser or written into a product
receipt. `supersededAuditLogId`, `createdAt`, `updatedAt`, relations and every
other column are excluded. The reader performs no write, lock, raw SQL, record
operation or dispatch.

## 4. Exact transitive product read chain

The selective verifier requires these named static import edges:

1. ProductReleaseStore -> ProductStageSnapshot:
   `readPromptRefinerProductStageSnapshot`;
2. ProductReleaseStore -> GateEvidence:
   `readPromptRefinerVnextOneShotGateEvidence` and
   `readPromptRefinerVnextOneShotDisposition`;
3. GateEvidence -> OperationalShadow:
   `readPromptRefinerVnextOneShotOperationalShadow`;
4. GateEvidence -> StageReadback: `readPromptRefinerVnextOneShotStage`;
5. GateEvidence -> TerminalReceipt:
   `readPromptRefinerVnextOneShotTerminalReceipts`;
6. TerminalReceipt -> StageReadback: `readPromptRefinerVnextOneShotStage`; and
7. TerminalReceipt -> OutcomeRecovery:
   `verifyPromptRefinerVnextOneShotConsumedRequest`.

The Stage diagnostic returns only stage presence/status, runtime and approval
identifiers, slot counts, reservation/approval validity and
`dispatchAuthorized: false`. The consumed-request verifier returns only a slot
id. The v5 terminal reader returns content-free terminal classifications,
bounded cost, token accounting and audit identifiers. Audit-log reads validate
hash-chain receipts; they do not expose prompt or result content.

The frozen GateEvidence file also imports
`lockAndReadPromptRefinerVnextOneShotStage` for its historical record export.
That import is not invoked by either product read export and receives no product
authority here. Likewise, the retained emergency stop caller of OutcomeRecovery
continues under its earlier lifecycle authority. The verifier proves the seven
product read edges without turning those legacy imports into a universal ban or
a new product capability.

## 5. Enforcement

The dark-table and selective-release checks must:

1. preserve all 17 dark tables and existing unrelated and legacy exceptions;
2. accept exactly six complete source hashes and ten source/table pairs;
3. reject a seventh source, another pair, a table change or source-byte drift;
4. reject direct Stage or Slot access from the product release store;
5. allow only the named new Stage snapshot read export and only from the product
   release store; namespace, default, re-export, require and dynamic access fail;
6. prove the seven static named read edges in section 4 while leaving the frozen
   Gate lock import and legacy emergency stop caller under their separate
   authorities;
7. preserve the 15-source lifecycle omission and all historical record-export
   restrictions; and
8. receive independent review before merge or deployment.

Missing, invalid or unavailable evidence remains fail-closed. Genuine gate,
disposition, owner, audit-chain, price, candidate-source and exact-runtime
checks remain mandatory.

## 6. Exclusions

This version does not authorise a Stage or Slot write, lock, lifecycle endpoint,
provider call, paid run, retry, flag change, activation, quality pass,
limited-audit pass, Router release decision, budget change, user-credit change,
holdout access or another dark-table read. It does not expose prompts, answers,
rubrics, counterexamples, attachments, user identifiers or conversation data.
