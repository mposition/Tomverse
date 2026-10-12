import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AdminChatRefinerInitialAutoReleaseControls,
  AdminGuestChatSmartAdaptiveActivationControl,
  AdminPromptRefinerProductStatusReadback,
  guestChatAutoActivationDisabled,
  guestChatAutoReleaseMatches,
  parseGuestChatAutoReleaseReadback,
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

const guestRelease = {
  state: "active" as const,
  binding: {
    runtimeCommitSha: "a".repeat(40),
    runtimeDeploymentId: "123e4567-e89b-42d3-a456-426614174000",
    releaseFingerprint: "0".repeat(64),
    configDigest: "1".repeat(64),
    baseRouterConfigDigest: "2".repeat(64),
    promptRefinerCandidateDigest: "3".repeat(64),
    promptRefinerPricePinDigest: "4".repeat(64),
    promptRefinerAdapterConfigDigest: "5".repeat(64),
  },
  activationAuditLogId: "guest-audit",
  activationPairDigest: "6".repeat(64),
  baseRouterActivationAuditLogId: "router-audit",
  baseProductActivationAuditLogId: "product-audit",
  actorUserId: "owner-a",
  approvedAt: "2026-10-12T01:02:03.000Z",
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
      releaseKind: "initial_auto_v2" as const,
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

test("the Guest activation readback accepts only the exact content-free contract", () => {
  const parsed = parseGuestChatAutoReleaseReadback({ release: guestRelease });
  assert.equal(parsed.success, true);
  assert.equal(parseGuestChatAutoReleaseReadback({
    release: { ...guestRelease, prompt: "do not expose" },
  }).success, false);
  assert.equal(parseGuestChatAutoReleaseReadback({ release: null }).success, true);
  assert.equal(parseGuestChatAutoReleaseReadback({ release: null, active: true }).success,
    false);
});

test("the Guest activation readback binds the serving tuple and POST receipt", () => {
  const runtime = {
    runtimeCommitSha: snapshot.serving.commitSha!,
    runtimeDeploymentId: snapshot.serving.deploymentId!,
  };
  assert.equal(guestChatAutoReleaseMatches(guestRelease, runtime, {
    activationAuditLogId: guestRelease.activationAuditLogId,
    activationPairDigest: guestRelease.activationPairDigest,
  }), true);
  assert.equal(guestChatAutoReleaseMatches(guestRelease, {
    ...runtime, runtimeCommitSha: "b".repeat(40),
  }), false);
  assert.equal(guestChatAutoReleaseMatches(guestRelease, runtime, {
    activationAuditLogId: "another-audit",
    activationPairDigest: guestRelease.activationPairDigest,
  }), false);
});

test("pending, unknown and active Guest states close the activation button", () => {
  const available = {
    confirmed: true,
    hasExactRuntime: true,
    readState: "absent" as const,
    pending: false,
    postAttempted: false,
  };
  assert.equal(guestChatAutoActivationDisabled(available), false);
  assert.equal(guestChatAutoActivationDisabled({ ...available, pending: true }), true);
  assert.equal(guestChatAutoActivationDisabled({ ...available,
    postAttempted: true }), true);
  assert.equal(guestChatAutoActivationDisabled({ ...available,
    readState: "active" }), true);
  assert.equal(guestChatAutoActivationDisabled({ ...available,
    readState: "unavailable" }), true);
});

test("the Owner Guest activation section states its narrow scope in both languages", () => {
  for (const messages of [
    adminPromptRefinerProductStatusMessages.en,
    adminPromptRefinerProductStatusMessages.ko,
  ]) {
    const html = renderToStaticMarkup(
      <AdminGuestChatSmartAdaptiveActivationControl
        snapshot={snapshot}
        onRefresh={async () => {}}
        messages={messages}
      />
    );
    assert.ok(html.includes(messages.guestActivationTitle));
    assert.ok(html.includes(messages.guestActivationScope));
    assert.ok(html.includes(messages.guestActivationConfirm));
    assert.ok(html.includes(messages.guestActivationAction));
    assert.ok(html.includes("disabled"));
    assert.equal(html.includes("ACTIVATE_EXACT_GUEST_CHAT"), false);
  }
});
