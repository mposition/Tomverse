import assert from "node:assert/strict";
import test from "node:test";

import { queueBulkActions } from "@/components/admin/AdminMarketingPanel";
import { marketingBatchToSend, sendMarketingBatch } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * Approve-all and reject-all on the approval queue (owner request
 * 2026-11-12). Executed, not read: the batch is built and sent.
 */

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "pending_approval",
  provider: "zernio",
  accountSlug: "tomverse-en",
  channel: "x",
  envelopeDigest: id.repeat(64).slice(0, 64),
  historyVersion: 3,
  legalHold: false,
  guardDecision: "approval_required",
  ...overrides,
});

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const byId = (actions: ReturnType<typeof queueBulkActions>, id: string) => {
  const action = actions.find((candidate) => candidate.id === id);
  assert.ok(action, `no ${id}`);
  return action;
};

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: no buttons when nothing is waiting`, () => {
    assert.deepEqual(queueBulkActions([], m), []);
    assert.deepEqual(queueBulkActions([row("d", { status: "drafted" })], m), []);
  });

  test(`${locale}: reject-all takes every waiting card through its own route and check`, () => {
    const rows = [row("a"), row("h", { legalHold: true }), row("d", { status: "drafted" })];
    const reject = byId(queueBulkActions(rows, m), "reject-all-pending");
    assert.ok(reject.label.includes("2"));
    assert.deepEqual(reject.batch?.(), [
      {
        path: "/api/admin/marketing/posts/a/reject",
        body: { expectedEnvelopeDigest: "a".repeat(64), expectedHistoryVersion: 3 },
      },
      {
        path: "/api/admin/marketing/posts/h/reject",
        body: { expectedEnvelopeDigest: "h".repeat(64), expectedHistoryVersion: 3 },
      },
    ]);
  });

  test(`${locale}: approve-all leaves out legal holds and Guard blocks, and says so before and after`, () => {
    const rows = [
      row("a"),
      row("b", { accountSlug: "tomverse-ko", channel: "threads" }),
      row("e", { guardDecision: "autonomous_eligible" }),
      row("h", { legalHold: true }),
      row("g", { guardDecision: "reject" }),
      row("d", { status: "drafted" }),
    ];
    const approve = byId(queueBulkActions(rows, m), "approve-all-pending");
    assert.equal(approve.unavailable, undefined);
    assert.ok(approve.label.includes("3"));
    const question = String(approve.confirm);
    // Count, per account, and the skipped with their reasons.
    assert.ok(question.includes("tomverse-en · X: 2"), question);
    assert.ok(question.includes("tomverse-ko · Threads: 1"), question);
    assert.ok(question.includes("2") && question.includes("1"));
    assert.equal(question.includes("{"), false, question);

    const before = Date.now();
    const requests = approve.batch?.() ?? [];
    assert.deepEqual(
      requests.map((request) => request.path),
      [
        "/api/admin/marketing/posts/a/approve",
        "/api/admin/marketing/posts/b/approve",
        "/api/admin/marketing/posts/e/approve",
      ]
    );
    for (const request of requests) {
      const body = request.body as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), [
        "approvalExpiresAt",
        "expectedEnvelopeDigest",
        "expectedHistoryVersion",
      ]);
      // The week a single approval starts with, from the press.
      const expires = new Date(String(body.approvalExpiresAt)).getTime();
      assert.ok(expires >= before + 7 * 24 * 60 * 60 * 1000 - 1000);
      assert.ok(expires <= Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    const result = approve.describe?.({ sent: 2, failed: 1, unsent: 0, requiresReauthentication: false }) ?? "";
    assert.ok(result.includes("2") && result.includes("1"), result);
    assert.ok(result.includes(m.bulkFailedNote), result);
    assert.ok(result.includes(m.bulkSkippedWhy.replace("{skipped}", "2").replace("{held}", "1").replace("{blocked}", "1")), result);
    assert.equal(result.includes("{"), false, result);
  });

  test(`${locale}: approve-all is drawn unavailable, with why, when every waiting card is held or blocked`, () => {
    const actions = queueBulkActions([row("h", { legalHold: true }), row("g", { guardDecision: "reject" })], m);
    const approve = byId(actions, "approve-all-pending");
    assert.ok(approve.unavailable && !approve.unavailable.includes("{"));
    assert.ok(byId(actions, "reject-all-pending").batch?.().length === 2);
  });

  test(`${locale}: a batch that stopped says how many were not sent`, () => {
    const reject = byId(queueBulkActions([row("a")], m), "reject-all-pending");
    const stopped = reject.describe?.({ sent: 20, failed: 0, unsent: 5, requiresReauthentication: false }) ?? "";
    assert.ok(stopped.includes("20") && stopped.includes("5") && !stopped.includes("{"), stopped);
  });
}

test("declining the question sends nothing", async () => {
  const m = adminMarketingMessages.en as unknown as Record<string, string>;
  const approve = byId(queueBulkActions([row("a")], m), "approve-all-pending");
  assert.equal(await marketingBatchToSend(approve, () => false), null);
});

test("a request that never answers is counted as failed and not sent again", async () => {
  const m = adminMarketingMessages.en as unknown as Record<string, string>;
  const approve = byId(queueBulkActions([row("a"), row("b"), row("c")], m), "approve-all-pending");
  const requests = await marketingBatchToSend(approve, () => true);
  assert.ok(Array.isArray(requests));
  const seen: string[] = [];
  const result = await sendMarketingBatch(requests, async (request) => {
    seen.push(request.path);
    if (request.path.includes("/b/")) throw new Error("offline");
    return json(200, { result: { id: "x" } });
  });
  assert.deepEqual(seen, [
    "/api/admin/marketing/posts/a/approve",
    "/api/admin/marketing/posts/b/approve",
    "/api/admin/marketing/posts/c/approve",
  ]);
  assert.deepEqual(result, { sent: 2, failed: 1, unsent: 0, requiresReauthentication: false });
});
