import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AdminPromptRefinerProductStatusReadback,
} from "@/components/admin/AdminPromptRefinerProductStatusPanel";
import { adminPromptRefinerProductStatusMessages } from
  "@/lib/adminMessages/promptRefinerProductStatus";
import {
  parsePromptRefinerProductStatus,
  type PromptRefinerProductStatus,
} from "@/lib/promptRefinerProductStatusContract";

const snapshot: PromptRefinerProductStatus = {
  version: "prompt-refiner-product-status-v1",
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
    for (const gate of snapshot.router.outstanding) assert.match(html, new RegExp(gate));
    assert.match(html, new RegExp(messages.notEstablished));
    assert.match(html, new RegExp(messages.unknown));
  }
});
