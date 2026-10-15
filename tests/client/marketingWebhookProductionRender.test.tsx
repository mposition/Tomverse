import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import type { MarketingAction } from "@/components/admin/MarketingActions";
import {
  MarketingWebhookProductionView,
  type MarketingWebhookProductionLive,
} from "@/components/admin/MarketingWebhookProduction";
import { MARKETING_CHECKED } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * The production webhook block (S2f), executed: the view is called and its
 * element tree walked, so the actions each rail is handed -- path, method and
 * the exact body the server will compare against -- are read directly.
 */

const m = adminMarketingMessages.en as unknown as Record<string, string>;

const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
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

const actionsOf = (node: ReactNode) =>
  propsOf(node).flatMap((props) => (Array.isArray(props.actions) ? (props.actions as MarketingAction[]) : []));

const FINGERPRINT = "f".repeat(64);
const PAIR = { eventType: "post.platform.published", channelId: "chn-youtube" };
const RECORD = {
  recordId: "2026-10-14__zernio-youtube-platform-published-main",
  status: "found" as const,
  recordDigest: "9".repeat(64),
  pipelineFingerprint: FINGERPRINT,
  observedScope: [PAIR],
  verificationSignatureAuditLogId: "audit-record",
};

const live = (overrides: Partial<MarketingWebhookProductionLive> = {}): MarketingWebhookProductionLive => ({
  environment: "production",
  deployCommitSha: "c".repeat(40),
  pipelineFingerprint: FINGERPRINT,
  productionConfigSnapshotDigest: "5".repeat(64),
  stored: { status: "absent" },
  nextGeneration: 1,
  applyScope: { status: "absent", storedDigest: "absent" },
  record: RECORD,
  ...overrides,
});

const render = (value: MarketingWebhookProductionLive) =>
  MarketingWebhookProductionView({
    live: value,
    m,
    section: "queue",
    recordId: "",
    onRecordIdChange: () => {},
    loading: false,
    onLoadRecord: () => {},
    onReload: () => {},
  });

test("a signed, current record offers exactly the signature the server will check", () => {
  const actions = actionsOf(render(live()));
  assert.deepEqual(actions.map((action) => action.id), ["webhook-production-config-sign"]);
  const sign = actions[0];
  assert.equal(sign.path, "/api/admin/marketing/webhook/production-config");
  assert.deepEqual(sign.body({}), {
    generation: 1,
    recordId: RECORD.recordId,
    recordDigest: RECORD.recordDigest,
    verificationSignatureAuditLogId: "audit-record",
    deployCommitSha: "c".repeat(40),
    pipelineFingerprint: FINGERPRINT,
    productionConfigSnapshotDigest: "5".repeat(64),
  });
});

test("nothing is offered to sign over a record that cannot be signed over", () => {
  for (const value of [
    live({ record: null }),
    live({ record: { ...RECORD, verificationSignatureAuditLogId: null } }),
    live({ record: { ...RECORD, pipelineFingerprint: "e".repeat(64) } }),
    live({ record: { ...RECORD, status: "not_found" } }),
    live({ deployCommitSha: null }),
    live({ nextGeneration: null, stored: { status: "invalid" } }),
  ]) {
    assert.deepEqual(actionsOf(render(value)), [], JSON.stringify(value.record));
  }
});

test("with a signed generation, the scope is chosen from the record's observed pairs", () => {
  const signed = { status: "valid" as const, value: { generation: 3, recordId: RECORD.recordId, signatureAuditLogId: "a" } };
  const actions = actionsOf(render(live({ stored: signed, nextGeneration: 4 })));
  const scope = actions.find((action) => action.id === "webhook-production-apply-scope");
  assert.ok(scope);
  assert.equal(scope.method, "PATCH");
  assert.deepEqual(scope.body({ pair0: MARKETING_CHECKED }), {
    recordId: RECORD.recordId,
    productionConfigGeneration: 3,
    scope: [PAIR],
    expectedStoredDigest: "absent",
  });
  assert.deepEqual((scope.body({}) as { scope: unknown[] }).scope, []);
});

test("emptying an applied scope is offered on its own, against the stored bytes", () => {
  const applied = {
    status: "valid" as const,
    value: { recordId: RECORD.recordId, productionConfigGeneration: 3, scope: [PAIR] },
    storedDigest: "7".repeat(64),
  };
  const actions = actionsOf(render(live({ record: null, applyScope: applied })));
  assert.deepEqual(actions.map((action) => action.id), ["webhook-production-apply-scope-stop"]);
  assert.deepEqual(actions[0].body({}), {
    recordId: RECORD.recordId,
    productionConfigGeneration: 3,
    scope: [],
    expectedStoredDigest: "7".repeat(64),
  });
});

test("a stored scope this build cannot read can still be emptied", () => {
  const invalid = { status: "invalid" as const, storedDigest: "8".repeat(64) };
  // With nothing readable to name the record, the operator types its id.
  const bare = actionsOf(render(live({ record: null, applyScope: invalid })));
  assert.deepEqual(bare.map((action) => action.id), ["webhook-production-apply-scope-stop"]);
  assert.deepEqual(bare[0].fields?.map((field) => field.name), ["recordId"]);
  assert.deepEqual(bare[0].body({ recordId: " 2026-10-14__typed " }), {
    recordId: "2026-10-14__typed",
    productionConfigGeneration: 1,
    scope: [],
    expectedStoredDigest: "8".repeat(64),
  });
  // A signed generation names it instead.
  const signed = { status: "valid" as const, value: { generation: 3, recordId: RECORD.recordId, signatureAuditLogId: "a" } };
  const named = actionsOf(render(live({ record: null, stored: signed, applyScope: invalid })));
  const stop = named.find((action) => action.id === "webhook-production-apply-scope-stop");
  assert.ok(stop);
  assert.equal(stop.fields, undefined);
  assert.deepEqual(stop.body({}), {
    recordId: RECORD.recordId,
    productionConfigGeneration: 3,
    scope: [],
    expectedStoredDigest: "8".repeat(64),
  });
});

test("an empty or absent scope offers no stop: nothing is applied", () => {
  for (const applyScope of [
    { status: "absent" as const, storedDigest: "absent" },
    { status: "valid" as const, value: { recordId: RECORD.recordId, productionConfigGeneration: 1, scope: [] }, storedDigest: "6".repeat(64) },
  ]) {
    const ids = actionsOf(render(live({ record: null, applyScope }))).map((action) => action.id);
    assert.equal(ids.includes("webhook-production-apply-scope-stop"), false);
  }
});
