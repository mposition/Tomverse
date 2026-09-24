import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideAmuxAttemptBudget } from "../lib/amux/executionBudgetCore.ts";

const service = readFileSync("lib/amux/reviewApproval.ts", "utf8");
const internal = readFileSync("app/api/internal/amux/review/route.ts", "utf8");
const general = readFileSync("app/api/admin/amux/escalations/route.ts", "utf8");
const detail = readFileSync("app/api/admin/amux/escalations/review/route.ts", "utf8");
const proposal = readFileSync("app/api/admin/amux/escalations/proposals/route.ts", "utf8");
const statusRoute = readFileSync("app/api/admin/amux/escalations/review/decision-status/route.ts", "utf8");
const reviewProxy = readFileSync("lib/amux/reviewAdminProxy.ts", "utf8");
const reviewPanel = readFileSync("components/admin/AdminAmuxRoutingPanel.tsx", "utf8");

test("review API uses its own one-person authorization boundary, never AdminActionApproval", () => {
  for (const source of [service, internal, general, detail, proposal, statusRoute]) {
    assert.doesNotMatch(source, /AdminActionApproval|runWithAdminApproval|adminApprovalErrorResponse|adminSoleApprover/);
  }
  assert.match(internal, /isAmuxSyncAuthorized\(request\)/);
  assert.match(internal, /hasAdminPermission\(session, "ops:write"\)/);
  assert.match(internal, /assertRecentAdminAuthentication\(session\)/);
  assert.match(detail, /assertRecentAdminAuthentication\(session\)/);
  assert.match(proposal, /assertRecentAdminAuthentication\(session\)/);
  assert.match(statusRoute, /assertRecentAdminAuthentication\(session\)/);
  assert.match(general, /if \(body\.action === "resolve"\) \{\s*await assertRecentAdminAuthentication\(session\)/);
});

test("general escalation list cannot disclose raw persisted reasons or resolution", () => {
  const select = general.split("const escalations = await prisma.amuxHumanEscalation.findMany({")[1]
    ?.split("return NextResponse.json(")[0];
  assert.ok(select);
  assert.doesNotMatch(select, /\breason:\s*true|\bresolution:\s*true/);
  assert.match(general, /publicAmuxEscalationReasonCode\(escalation\.task\.status\)/);
  assert.match(general, /safeTitle\(escalation\.task\.title\)/);
});

test("retry is bounded, planning correction is revision-proven, and approve needs a fetched PR artifact", () => {
  assert.match(service, /escalation\.openedTaskRevision !== null/);
  assert.match(service, /task\.revision > escalation\.openedTaskRevision/);
  assert.match(service, /task\.dueParseState === "valid"/);
  assert.match(service, /!displayTruncated && budget\.allowed && dueCorrected &&\s*\(lastAttempt !== null \|\| escalation\.specialty === "planning-review"\)/);
  assert.match(service, /if \(artifact && !displayTruncated\) outcomes\.push\("approve"\)/);
  assert.match(service, /amuxReviewTextExceedsDisplay\(description\)/);
  assert.match(service, /readAmuxReviewPullRequest\(escalation\.task\.reviewPrNumber\)/);
  assert.match(service, /lastAttempt\.taskRevision < task\.revision/);
  assert.match(service, /review_pr_number: artifact\?\.prNumber \?\? null/);
  assert.match(service, /review_base_sha: artifact\?\.baseSha \?\? null/);
  assert.match(service, /review_head_sha: artifact\?\.headSha \?\? null/);
  assert.match(service, /review_diff_digest: artifact\?\.diffDigest \?\? null/);
  assert.match(service, /input\.outcome === "approve" \? state\.artifact\?\.diffDigest \?\? null : null/);
  assert.match(service, /proposal\.reviewHeadSha !== state\.artifact\?\.headSha/);
  assert.match(service, /proposal\.reviewBaseSha !== state\.artifact\?\.baseSha/);
  assert.match(service, /proposal\.reviewDiffDigest !== state\.artifact\?\.diffDigest/);
});

test("proposal preallocates decision identity and status lookup never reports an uncommitted failure", () => {
  assert.match(service, /const decisionId = randomUUID\(\);\s*\/\/ The database trigger/);
  assert.match(service, /decisionId,\s*escalationId: state\.escalation\.id/);
  assert.match(service, /decision_id: proposed\.decisionId/);
  assert.match(service, /const decisionId = proposal\.decisionId/);
  assert.match(service, /where: \{ decisionId \}/);
  assert.match(service, /proposal\.subjectDigest !== subjectDigest/);
  assert.match(service, /status: "unconfirmed" as const/);
  assert.match(service, /status: "committed" as const/);
  assert.match(internal, /action: z\.literal\("decision_status"\)/);
  assert.match(internal, /action\.action !== "decision_status"/);
  assert.match(statusRoute, /forwardAmuxAdminReviewCommand\(request, \{ action: "decision_status"/);
  assert.doesNotMatch(service, /status: "failed"/);
});

test("recoverable block opens a successor, but exhausted 5-attempt task stays terminal", () => {
  const resolve = service.split("export async function resolveAmuxReview(")[1]
    ?.split("export async function acknowledgeAmuxReview(")[0];
  assert.ok(resolve);
  assert.match(resolve, /proposal\.outcome === "block" && state\.budget\.allowed/);
  assert.match(resolve, /openAmuxHumanEscalation\(tx, \{/);
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 4, greatest_attempt_number: 4 }).allowed, true);
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: 5 }).allowed, false);
});

test("retry requeue checks the current cost cap in resource-before-task lock order", () => {
  const resolve = service.split("export async function resolveAmuxReview(")[1]
    ?.split("export async function acknowledgeAmuxReview(")[0];
  assert.ok(resolve);
  const resourceLock = resolve.indexOf("lockAmuxResourcePolicies(tx, amuxResourceRefs(retryPlanning.task))");
  const taskLock = resolve.indexOf("lockTaskAndEscalation(tx, input.escalationId)");
  const costCheck = resolve.indexOf("evaluateLockedAmuxCostAdmission(");
  const taskCas = resolve.indexOf("tx.amuxWorkItem.updateMany(");
  assert.ok(resourceLock >= 0 && resourceLock < taskLock && taskLock < costCheck && costCheck < taskCas);
  assert.match(resolve, /state\.task\.projectKey !== retryPlanning\.task\.projectKey/);
  assert.match(resolve, /state\.task\.estimatedCostMicrousd !== retryPlanning\.task\.estimatedCostMicrousd/);
  assert.match(resolve, /AMUX_REVIEW_COST_GUARD_BLOCKED/);
  assert.match(service, /task\.dueParseState === "valid" \|\| task\.dueParseState === "none"/);
});

test("decision write is one task CAS, audited escalation closure and immutable decision", () => {
  const resolve = service.split("export async function resolveAmuxReview(")[1]
    ?.split("export async function acknowledgeAmuxReview(")[0];
  assert.ok(resolve);
  const cas = resolve.indexOf("tx.amuxWorkItem.updateMany(");
  const close = resolve.indexOf("tx.amuxHumanEscalation.updateMany(");
  const audit = resolve.indexOf("writeAdminAuditLog(");
  const decision = resolve.indexOf("tx.amuxReviewDecision.create(");
  assert.ok(cas >= 0 && cas < close && close < audit && audit < decision);
  assert.match(resolve, /revision: \{ increment: 1 \}/);
  assert.match(resolve, /task_status: proposal\.targetStatus,\s*task_revision: proposal\.taskRevision \+ 1/);
  assert.match(resolve, /proposal\.expiresAt\.getTime\(\) <= now\.getTime\(\)/);
  assert.match(resolve, /existing\.idempotencyKeyHash !== keyHash \|\| existing\.requestDigest !== requestDigest/);
});

test("refusals record safe measured/verdict and never raw review text", () => {
  assert.match(internal, /verdict: "refused"/);
  assert.match(internal, /measured: \{/);
  assert.doesNotMatch(internal, /metadata: \{[^}]*resolution:/s);
  assert.doesNotMatch(internal, /metadata: \{[^}]*description:/s);
});

test("review transport budgets keep the browser outside the complete server path", () => {
  assert.match(reviewProxy, /AMUX_REVIEW_PROXY_TIMEOUT_MS = 40_000/);
  assert.match(reviewProxy, /AbortSignal\.timeout\(AMUX_REVIEW_PROXY_TIMEOUT_MS\)/);
  assert.match(reviewPanel, /AMUX_REVIEW_CLIENT_TIMEOUT_MS = 45_000/);
  assert.equal(
    (reviewPanel.match(/AbortSignal\.timeout\(AMUX_REVIEW_CLIENT_TIMEOUT_MS\)/g) ?? []).length,
    4,
  );
});
