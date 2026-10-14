import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const panel = readFileSync("components/admin/AdminAmuxRoutingPanel.tsx", "utf8");
const messages = readFileSync("lib/adminMessages/amuxRouting.ts", "utf8");

test("general routing cards use only safe reason codes, not the raw escalation reason", () => {
  const escalationType = panel.split("export type AmuxEscalationSummary = {")[1]
    ?.split("type AmuxReport = {")[0];
  assert.ok(escalationType);
  assert.match(panel, /reason_code:/);
  assert.match(panel, /m\.reasonCode\[escalation\.reason_code\]/);
  assert.doesNotMatch(escalationType, /reason:\s*string;/);
  assert.doesNotMatch(panel, /escalation\.reason\b/);
});

test("raw review content loads only from the protected endpoint and is not persisted", () => {
  assert.match(panel, /\/api\/admin\/amux\/escalations\/review\?escalation_id=/);
  assert.match(panel, /data-testid="admin-amux-review-content"/);
  assert.match(panel, /data-testid="admin-amux-developer-details"/);
  assert.match(panel, /hasReviewSubject\(review\)/);
  assert.match(panel, /setReview\(null\)/);
  assert.doesNotMatch(panel, /localStorage|console\.(log|warn|error)/);
  assert.match(panel, /sessionStorage\.setItem\(PENDING_DECISION_KEY, JSON\.stringify\(pending\)\)/);
  assert.doesNotMatch(panel, /sessionStorage\.setItem\([^\n]*(review_content|diffText|resolution)/);
});

test("review UI identifies the exact GitHub PR, head, and diff digest", () => {
  assert.match(panel, /data-testid="admin-amux-review-artifact"/);
  assert.match(panel, /Number\.isSafeInteger\(value\.pr_number\)/);
  assert.match(panel, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(panel, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(panel, /github\.com\/mposition\/Tomverse\/pull\/\$\{validArtifact\.pr_number\}/);
  assert.match(panel, /validArtifact\.head_sha/);
  assert.match(panel, /validArtifact\.base_sha/);
  assert.match(panel, /validArtifact\.diff_digest/);
  assert.match(panel, /data-testid="admin-amux-assigned-work"/);
  assert.match(panel, /validArtifact\.diff_text/);
  assert.match(panel, /review\.review_context\.previous_block_reason/);
  assert.match(panel, /review\.retry\.remaining === 0 && \(/);
  assert.match(panel, /review\.review_content\?\.truncated/);
  assert.match(panel, /m\.reviewContentTruncated/);
  assert.match(panel, /\{review\.review_content\.digest\}/);
  assert.match(messages, /GitHub review PR/);
  assert.match(messages, /GitHub 검토 PR/);
});

test("a proposal is bound to the subject seen and final confirmation carries its decision ID", () => {
  assert.match(panel, /expected_subject_digest:\s*review\.review_content\.digest/);
  assert.match(panel, /body\.proposal\.subject_digest !== review\.review_content\.digest/);
  assert.match(panel, /proposal_id:\s*proposal\.id/);
  assert.match(panel, /idempotency_key:\s*idempotencyKey/);
  assert.match(panel, /setIdempotencyKey\(crypto\.randomUUID\(\)\)/);
  assert.match(panel, /decision_id: proposal\.decision_id/);
  assert.match(panel, /data-testid=\{`admin-amux-confirm-\$\{selectedOutcome\}`\}/);
});

test("disabled approval and stale step-up have explicit bilingual operator guidance", () => {
  assert.match(panel, /AMUX_AGENT_APPROVAL_UNAVAILABLE/);
  assert.match(panel, /ADMIN_REAUTHENTICATION_REQUIRED/);
  // The step-up returns to where the panel now lives: AMUX › Execution's
  // Assignment section, which it left /admin/routing for, with the review
  // that was open reopened rather than the bare section.
  assert.match(panel, /const AMUX_ASSIGNMENT_PATH = "\/admin\/amux-execution\?tab=assignment"/);
  assert.match(panel, /adminRecentAuthenticationHref\(\s*amuxAssignmentReviewReturnPath\(selectedEscalationId\)\)/);
  assert.match(panel, /adminRecentAuthenticationHref\(\s*amuxAssignmentReviewReturnPath\(pendingDecision\.escalation_id\)\)/);
  assert.doesNotMatch(panel, /adminRecentAuthenticationHref\("\/admin\/amux-execution\?tab=assignment"\)/);
  assert.doesNotMatch(panel, /adminRecentAuthenticationHref\("\/admin\/routing"\)/);
  assert.match(panel, /reviewOutcomes = review \? visibleAmuxOwnerReviewOutcomes\(review\) : \[\]/);
  assert.match(messages, /No review subject with a verifiable digest/);
  assert.match(messages, /검증 가능한 digest를 가진 검토 대상/);
});

test("ambiguous decision transport freezes writes until ID/digest status lookup confirms commit", () => {
  assert.match(panel, /setReviewError\(m\.decisionUncertain\)/);
  assert.match(panel, /setDecisionStatusUnknown\(true\)/);
  assert.match(panel, /decision_id: proposal\.decision_id/);
  assert.match(panel, /subject_digest: proposal\.subject_digest/);
  assert.match(panel, /result\.status === "committed"/);
  assert.match(panel, /disabled=\{reviewBusy \|\| reauthenticationRequired \|\| decisionStatusUnknown\}/);
  assert.match(panel, /data-testid="admin-amux-check-decision-status"/);
  assert.match(panel, /data-testid="admin-amux-check-pending-decision-status"/);
  assert.match(messages, /decision status is unknown/);
  assert.match(messages, /결정 상태가 불명확합니다/);
  assert.doesNotMatch(messages, /safe retry|안전한 재시도/);
});

test("only explicit pre-decision refusals release the pending-decision lock", () => {
  assert.match(panel, /DEFINITIVE_REVIEW_REFUSALS/);
  assert.match(panel, /AMUX_REVIEW_COST_GUARD_BLOCKED/);
  assert.match(panel, /DEFINITIVE_REVIEW_REFUSALS\.has\(code\)/);
  assert.match(panel, /setReviewError\(m\.decisionRefused\)/);
  assert.match(messages, /before committing it/);
  assert.match(messages, /기록하기 전에 명시적으로 거절/);
});

test("failed detail reads offer an explicit read-only retry without clearing an unknown decision", () => {
  assert.match(panel, /amuxReviewReadError\(response\.status, code\)/);
  assert.match(panel, /m\.reviewProxyConfigurationFailed/);
  assert.match(panel, /m\.reviewAccessRefused/);
  assert.match(panel, /m\.reviewTemporarilyUnavailable/);
  const retry = panel.split('data-testid="admin-amux-retry-review-read"')[1]?.split("</button>")[0];
  assert.ok(retry);
  assert.match(retry, /disabled=\{reviewBusy \|\| decisionStatusUnknown \|\| pendingDecision !== null\}/);
  assert.match(retry, /onClick=\{\(\) => void openReview\(selectedEscalationId\)\}/);
  assert.doesNotMatch(retry, /resolve|clearPendingDecision|POST/);
  assert.match(messages, /Task 승인·재실행·차단 해제·실행은 하지 않습니다/);
});

test("recovery preparation is read-only and retry keeps the existing bound proposal flow", () => {
  assert.match(panel, /amuxOwnerRecoveryPreparation/);
  assert.match(panel, /recovery\.decisionContextReady/);
  assert.match(panel, /recovery\.retryPreviewReady/);
  assert.match(panel, /data-testid="admin-amux-recovery-checklist"/);
  assert.match(panel, /data-testid="admin-amux-retry-preview"/);
  assert.match(panel, /data-testid="admin-amux-retry-read-confirmation"/);
  assert.match(panel, /selectedOutcome === "retry" && !retryReadConfirmed/);
  assert.match(panel, /expected_subject_digest:\s*review\.review_content\.digest/);
  assert.match(messages, /does not start an evidence-retrieval job/);
  assert.match(messages, /근거 조회 작업을 시작하거나/);
  assert.doesNotMatch(panel, /force.?requeue|runtime.?cancel|automatic.?recovery/i);
});
