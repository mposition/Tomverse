import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminPromptRefinerAutoResumeControl } from
  "@/components/admin/AdminPromptRefinerAutoResumeControl";
import { adminPromptRefinerProductStatusMessages } from
  "@/lib/adminMessages/promptRefinerProductStatus";
import { promptRefinerProductAutoResumeBody, promptRefinerProductAutoResumeStateSchema } from
  "@/lib/promptRefinerProductAutoResumeContract";
import type { PromptRefinerProductStatus } from "@/lib/promptRefinerProductStatusContract";

const state = {
  version: "prompt-refiner-product-auto-resume-state-v1" as const,
  runtimeCommitSha: "a".repeat(40),
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
  writerEnabled: true, active: false, generation: 7,
  reasonCode: "unknown_dispatch_or_cost" as const,
  transitionAuditLogId: "recorded-pause-audit",
};

test("resume binds the observed generation, reason and audit without inventing authority", () => {
  const parsed = promptRefinerProductAutoResumeStateSchema.parse(state);
  assert.deepEqual(promptRefinerProductAutoResumeBody(parsed), {
    expectedGeneration: 7, expectedReasonCode: "unknown_dispatch_or_cost",
    expectedPauseAuditLogId: "recorded-pause-audit",
    confirmation: "RESUME_REFINER_PRODUCT_AUTO_AFTER_OPERATOR_REVIEW",
  });
  assert.notDeepEqual(promptRefinerProductAutoResumeBody({ ...parsed, generation: 8 }),
    promptRefinerProductAutoResumeBody(parsed));
  for (const invalid of [{ active: true }, { writerEnabled: false },
    { generation: null }, { reasonCode: null }, { transitionAuditLogId: null }]) {
    assert.equal(promptRefinerProductAutoResumeBody({ ...parsed, ...invalid }), null);
  }
  assert.equal(promptRefinerProductAutoResumeStateSchema.safeParse({ ...state,
    reasonCode: "invented_stop" }).success, false);
  assert.equal(promptRefinerProductAutoResumeStateSchema.safeParse({ ...state,
    prompt: "not allowed" }).success, false);
});

test("an unread Auto guard has no enabled confirmation or resume action", () => {
  const snapshot: PromptRefinerProductStatus = {
    version: "prompt-refiner-product-status-v2", observedAt: "2026-10-11T00:00:00Z",
    serving: { commitSha: state.runtimeCommitSha, deploymentId: state.runtimeDeploymentId,
      exactProductIdentity: true },
    controls: { rollout: "enabled", killSwitchEngaged: false },
    release: { state: "recorded", explicitEnabled: true, autoEnabled: false,
      approvalAuditLogId: "product-audit", releaseKind: "initial_auto_v2",
      routerExceptionAuditLogId: "router-audit" },
    router: { version: "auto-rollout-readiness-v1", ready: false, outstanding: [], problems: [] },
    completionClaim: "not_established_by_status_readback",
  };
  for (const messages of [adminPromptRefinerProductStatusMessages.en,
    adminPromptRefinerProductStatusMessages.ko]) {
    const html = renderToStaticMarkup(<AdminPromptRefinerAutoResumeControl
      snapshot={snapshot} onRefresh={async () => {}} messages={messages} />);
    assert.ok(html.includes(messages.resumeDescription));
    assert.match(html, /type="checkbox"[^>]*disabled/);
    assert.match(html, /<button[^>]*disabled[^>]*>[^<]*Record Auto resume|<button[^>]*disabled[^>]*>[^<]*Auto 재개 기록/);
  }
});
