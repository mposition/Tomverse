import assert from "node:assert/strict";
import test from "node:test";

import { scheduleAllApprovedActions } from "@/components/admin/AdminMarketingPanel";
import { sendMarketingBatch } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * One press for the approved posts on the Published tab (owner request
 * 2026-11-05). Executed, not read: the batch is built and sent.
 */

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "approved",
  provider: "zernio",
  envelopeDigest: id.repeat(64).slice(0, 64),
  historyVersion: 2,
  ...overrides,
});

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: the button counts only what the publisher can carry, and asks first`, () => {
    const rows = [
      row("a"),
      row("b"),
      row("m", { provider: "manual" }),
      row("s", { status: "scheduled" }),
      row("v", { status: "verified" }),
    ];
    const [action] = scheduleAllApprovedActions(rows, m);
    assert.ok(action.label.includes("2"));
    assert.ok(String(action.confirm).includes("2"));
    assert.deepEqual(
      action.batch?.().map((request) => request.path),
      ["/api/admin/marketing/posts/a/schedule", "/api/admin/marketing/posts/b/schedule"]
    );
  });

  test(`${locale}: no button when nothing is left to schedule`, () => {
    assert.deepEqual(scheduleAllApprovedActions([row("m", { provider: "manual" })], m), []);
    assert.deepEqual(scheduleAllApprovedActions([], m), []);
  });

  test(`${locale}: each request carries its row's own check and a time still to come`, () => {
    const before = Date.now();
    const [action] = scheduleAllApprovedActions([row("a")], m);
    const [request] = action.batch?.() ?? [];
    const body = request.body as Record<string, string | number>;
    assert.equal(body.expectedEnvelopeDigest, "a".repeat(64));
    assert.equal(body.expectedHistoryVersion, 2);
    assert.ok(new Date(String(body.scheduledAt)).getTime() >= before + 60_000);
  });

  test(`${locale}: the sentence says how many went and how many did not`, () => {
    const [action] = scheduleAllApprovedActions([row("a")], m);
    const done = action.describe?.({ sent: 3, failed: 0, unsent: 0, requiresReauthentication: false });
    assert.ok(done?.includes("3") && !done.includes("{"));
    const partial = action.describe?.({ sent: 3, failed: 1, unsent: 0, requiresReauthentication: false });
    assert.ok(partial?.includes("3") && partial.includes("1") && !partial.includes("{"));
  });

  test(`${locale}: a batch that stopped never reads as done`, () => {
    const [action] = scheduleAllApprovedActions([row("a")], m);
    const stopped = action.describe?.({ sent: 0, failed: 0, unsent: 5, requiresReauthentication: true });
    assert.equal(stopped, m.scheduleAllStopped.replace("{sent}", "0").replace("{failed}", "0").replace("{unsent}", "5"));
    assert.notEqual(stopped, m.scheduleAllDone.replace("{sent}", "0"));
    assert.ok(stopped?.includes("5") && !stopped.includes("{"));
  });
}

const requests = ["a", "b", "c"].map((id) => ({ path: `/${id}`, body: null }));

test("a refused row does not stop the others, and none is sent twice", async () => {
  const seen: string[] = [];
  const result = await sendMarketingBatch(requests, async (request) => {
    seen.push(request.path);
    return request.path === "/b" ? json(409, { code: "schedule_conflict" }) : json(200);
  });
  assert.deepEqual(seen, ["/a", "/b", "/c"]);
  assert.deepEqual(result, { sent: 2, failed: 1, unsent: 0, requiresReauthentication: false });
});

test("the route's rate limit stops the batch and says how many were left unsent", async () => {
  const seen: string[] = [];
  const result = await sendMarketingBatch(requests, async (request) => {
    seen.push(request.path);
    return request.path === "/a" ? json(200) : json(429, { error: "Too many requests" });
  });
  assert.deepEqual(seen, ["/a", "/b"]);
  assert.deepEqual(result, { sent: 1, failed: 0, unsent: 2, requiresReauthentication: false });
});

test("a lapsed step-up stops the batch: every later request would be refused too", async () => {
  const seen: string[] = [];
  const result = await sendMarketingBatch(requests, async (request) => {
    seen.push(request.path);
    return request.path === "/a" ? json(200) : json(403, { code: "ADMIN_REAUTHENTICATION_REQUIRED" });
  });
  assert.deepEqual(seen, ["/a", "/b"]);
  assert.deepEqual(result, { sent: 1, failed: 0, unsent: 2, requiresReauthentication: true });
});

test("a request that never answers counts as failed, and a body that is not JSON does too", async () => {
  const result = await sendMarketingBatch(requests, async (request) => {
    if (request.path === "/a") throw new Error("offline");
    return request.path === "/b" ? new Response("nope", { status: 500 }) : json(200);
  });
  assert.deepEqual(result, { sent: 1, failed: 2, unsent: 0, requiresReauthentication: false });
});
