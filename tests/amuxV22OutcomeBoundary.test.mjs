import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("owner outcome write stays separate from the read-only execution board", async () => {
  const [route, service, board, form, activation, read] = await Promise.all([
    readFile(new URL("../app/api/admin/amux/v22-outcome/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/amux/v22OutcomeObservationService.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AmuxExecutionWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/AmuxOutcomeObservationForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/amux/v22ActivationReadiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/amux/adminExecutionRead.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /hasValidMutationOrigin\(request\)/);
  assert.match(route, /amuxV22OutcomeWriteEnabled/);
  assert.match(route, /readLimitedText\(request, 2048\)/);
  assert.match(route, /retryWrite: false/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /writeAdminAuditLog\(\{ tx/);
  assert.match(service, /task\.status !== expectedStatus/);
  assert.match(service, /taskRevision: parsed\.revision - 1/);
  assert.doesNotMatch(board, /method: "POST"/);
  assert.match(form, /crypto\.randomUUID\(\)/);
  assert.match(form, /outcome_unknown/);
  assert.doesNotMatch(form, /method: "(PUT|PATCH|DELETE)"/);
  assert.match(activation, /activationAuthorized: false/);
  assert.match(read, /amuxFeedbackTaskWhere\(parent, featureIds\)/);
  assert.match(read, /card\."archivedAt" IS NULL/);
  assert.match(read, /parentStoryCardId: \{ in: storyIds \}, cardType: "task",\s+archivedAt: null/);
  assert.match(read, /const currentDecision = feedbackDecisions\.find/);
});
