import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const writers = [
  ["ideaSubmissionService.ts", "commitIdeaSubmission", "amuxIdeaSubmission.create"],
  ["ideaInitialSourcePlanService.ts", "createInitialIdeaOnlySourcePlan", "FOR UPDATE"],
  ["ideaFrontierCatalogWrite.ts", "commitFrontierCatalogDecision", "lockModel(tx"],
  ["ideaSourceScopeApprovalService.ts", "commitAmuxSourceScopeApproval", "FOR UPDATE"],
  ["ideaTransferPreviewService.ts", "commitIdeaOnlyTransferPreview", "FOR UPDATE"],
  ["ideaTransferConfirmationService.ts", "commitIdeaTransferConfirmation", "FOR UPDATE"],
];

test("AMUX v4 audited writers take the chain lock before idea and model locks", () => {
  for (const [file, functionName, firstContendedOperation] of writers) {
    const source = readFileSync(new URL(`../lib/amux/${file}`, import.meta.url), "utf8");
    const functionStart = source.indexOf(`export async function ${functionName}(`);
    assert.ok(functionStart >= 0, `${file}: writer missing`);
    const body = source.slice(functionStart);
    const chainLock = body.indexOf("await takeAuditChainLock(tx)");
    const contended = body.indexOf(firstContendedOperation);
    assert.ok(chainLock >= 0 && contended >= 0 && chainLock < contended,
      `${file}: audit chain must be locked before ${firstContendedOperation}`);
  }
});
