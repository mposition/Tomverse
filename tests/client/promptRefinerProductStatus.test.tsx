import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AdminChatRefinerInitialAutoReleaseControls,
  AdminPromptRefinerProductStatusReadback,
} from "@/components/admin/AdminPromptRefinerProductStatusPanel";
import { adminPromptRefinerProductStatusMessages } from
  "@/lib/adminMessages/promptRefinerProductStatus";
import {
  parsePromptRefinerProductStatus,
  type PromptRefinerProductStatus,
} from "@/lib/promptRefinerProductStatusContract";

const snapshot: PromptRefinerProductStatus = {
  version: "prompt-refiner-product-status-v2",
  observedAt: "2026-10-10T02:00:00.000Z",
  serving: {
    commitSha: "a".repeat(40),
    deploymentId: "123e4567-e89b-42d3-a456-426614174000",
    exactProductIdentity: true,
  },
  controls: { rollout: "enabled", killSwitchEngaged: false },
  release: {
    state: "closed_or_unavailable",
    explicitEnabled: null,
    autoEnabled: null,
    approvalAuditLogId: null,
    releaseKind: null,
    routerExceptionAuditLogId: null,
  },
  router: {
    version: "auto-rollout-readiness-v1",
    ready: false,
    outstanding: [
      "shadow_report",
      "offline_quality_evaluation",
      "attempt_manifest_boundary",
    ],
    problems: [],
  },
  completionClaim: "not_established_by_status_readback",
};

test("the client accepts only the exact content-free status contract", () => {
  assert.deepEqual(parsePromptRefinerProductStatus(snapshot), snapshot);
  assert.equal(parsePromptRefinerProductStatus({ ...snapshot, secret: "x" }), null);
  assert.equal(parsePromptRefinerProductStatus({
    ...snapshot,
    release: { ...snapshot.release, explicitEnabled: false, extra: true },
  }), null);
  assert.equal(parsePromptRefinerProductStatus({
    ...snapshot,
    router: { ...snapshot.router, outstanding: ["invented_gate"] },
  }), null);
});

test("the readback shows all pending Router gates and no completion claim", () => {
  for (const messages of [
    adminPromptRefinerProductStatusMessages.en,
    adminPromptRefinerProductStatusMessages.ko,
  ]) {
    const html = renderToStaticMarkup(
      <AdminPromptRefinerProductStatusReadback
        snapshot={snapshot}
        messages={messages}
      />
    );
    for (const gate of snapshot.router.outstanding) {
      assert.ok(html.includes(gate));
    }
    assert.ok(html.includes(messages.notEstablished));
    assert.ok(html.includes(messages.unknown));
  }
});

test("the owner control keeps activation and rollout as separate actions", () => {
  const initial = {
    ...snapshot,
    controls: { ...snapshot.controls, rollout: "disabled" as const },
    release: { state: "disabled_by_rollout" as const,
      explicitEnabled: false, autoEnabled: false,
      approvalAuditLogId: "product-audit",
      releaseKind: "initial_auto_v1" as const,
      routerExceptionAuditLogId: "router-audit" },
  };
  for (const messages of [
    adminPromptRefinerProductStatusMessages.en,
    adminPromptRefinerProductStatusMessages.ko,
  ]) {
    const html = renderToStaticMarkup(
      <AdminChatRefinerInitialAutoReleaseControls snapshot={initial}
        onRefresh={async () => {}} messages={messages} />
    );
    assert.ok(html.includes(messages.activationTitle));
    assert.ok(html.includes(messages.activate));
    assert.ok(html.includes(messages.enableRollout));
    assert.ok(html.includes(messages.disableRollout));
    assert.ok(html.includes(messages.reviewJobId));
    assert.ok(html.includes(messages.validationSeal));
    assert.ok(html.includes(messages.deploymentReadback));
    assert.equal(html.includes("MANIFEST_HASH_KEYS"), false);
  }
});
