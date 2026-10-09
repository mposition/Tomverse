import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { AdminRoutingRuntimeReadback } from "@/components/admin/AdminRoutingShadowPanel";
import { adminRoutingShadowMessages } from "@/lib/adminMessages/routingShadow";

const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Record<string, unknown> };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

test("an enforced process still displays the outstanding release gates and exact build", () => {
  const runtime = {
    observedAt: "2026-10-09T14:00:00.000Z",
    build: {
      environment: "staging" as const,
      commitSha: "a".repeat(40), shortCommitSha: "aaaaaaa",
      builtAt: null, deploymentId: "deployment-fixture",
      deploymentStartedAt: null, deployedAt: null, deploymentStatus: "unknown" as const,
      unexpectedSecret: "do-not-render",
    },
    readiness: {
      version: "auto-rollout-readiness-v1", ready: false,
      outstanding: ["shadow_report", "offline_quality_evaluation", "attempt_manifest_boundary"] as const,
      problems: [],
    },
    shadowEnabled: true,
    dispatchInstrumentationMode: "enforce" as const,
    manifestKeyringConfigured: true,
    unexpectedSecret: "do-not-render",
  };
  const tree = AdminRoutingRuntimeReadback({ runtime, messages: adminRoutingShadowMessages.en.runtime });
  const json = propsOf(tree).find((p) => p["data-testid"] === "admin-routing-runtime-snapshot")?.children;
  assert.equal(typeof json, "string");
  const snapshot = JSON.parse(json as string);
  assert.equal(snapshot.build.commitSha, runtime.build.commitSha);
  assert.equal(snapshot.build.deploymentId, runtime.build.deploymentId);
  assert.equal(snapshot.observedAt, runtime.observedAt);
  assert.equal(snapshot.dispatchInstrumentationMode, "enforce");
  assert.equal(snapshot.readiness.ready, false);
  assert.deepEqual(snapshot.readiness.outstanding, runtime.readiness.outstanding);
  assert.equal((json as string).includes("do-not-render"), false);
});

test("an older API response is explicitly unknown rather than an off or ready snapshot", () => {
  for (const messages of [adminRoutingShadowMessages.en.runtime, adminRoutingShadowMessages.ko.runtime]) {
    const tree = AdminRoutingRuntimeReadback({ runtime: undefined, messages });
    const props = propsOf(tree);
    assert.ok(props.some((p) => p.children === messages.unavailable));
    assert.equal(props.some((p) => p["data-testid"] === "admin-routing-runtime-snapshot"), false);
  }
});
