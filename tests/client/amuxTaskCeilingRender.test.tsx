import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AmuxTaskCeilingPanel, type AmuxTaskCeilingView,
  requestAmuxTaskCeilingReapproval,
} from "@/components/admin/AmuxTaskCeilingPanel";

// A registered Task the catalog now prices above its receipt (AMUX-IMGOUT-003,
// 2026-11-14): what the owner sees, and how each answer of the route is read.

const view: AmuxTaskCeilingView = {
  eligible: true, refusal: null, reason: "task_route_changed",
  approvedCeilingMicroUsd: "8200000", currentCeilingMicroUsd: "11800000",
  catalogDigest: "a".repeat(64), maxAttempts: 2,
  routes: [
    { workerName: "claude-impl", modelId: "claude-opus", perAttemptMicroUsd: "4100000", approved: true },
    { workerName: "antigravity-impl", modelId: "gemini-4-argon", perAttemptMicroUsd: "5900000", approved: false },
  ],
};

const html = (input: Partial<AmuxTaskCeilingView> = {}, canAct = true) => renderToStaticMarkup(
  <AmuxTaskCeilingPanel taskId="task-1" revision={3} view={{ ...view, ...input }} canAct={canAct}
    onChanged={() => {}} />);

test("the owner sees the ceiling in force, the one asked for and each route", () => {
  const out = html();
  assert.match(out, /data-testid="amux-task-ceiling"/);
  assert.match(out, /\$8\.2000/);
  assert.match(out, /\$11\.8000/);
  assert.match(out, /up to 2 attempts/);
  assert.match(out, /antigravity-impl · gemini-4-argon · \$5\.9000/);
  assert.equal(out.match(/>new</g)?.length, 1);
  assert.match(out, /data-testid="amux-task-ceiling-approve"/);
});

test("a viewer who is not the owner sees the amounts but no action", () => {
  const out = html({}, false);
  assert.match(out, /\$11\.8000/);
  assert.doesNotMatch(out, /amux-task-ceiling-approve/);
});

test("a Task with nothing to re-approve shows no panel", () => {
  assert.equal(html({ eligible: false, refusal: "within_approved_ceiling" }), "");
  assert.equal(html({ catalogDigest: null }), "");
});

const answer = (status: number, body: unknown) => (async () =>
  Response.json(body, { status })) as unknown as typeof fetch;

test("the request posts what the owner was shown and reads each answer", async () => {
  const sent: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ status: "reapproved", ceilingMicroUsd: "11800000" });
  }) as unknown as typeof fetch;
  const input = { taskId: "t1", revision: 3, catalogDigest: "a".repeat(64), ceilingMicroUsd: "11800000" };
  assert.deepEqual(await requestAmuxTaskCeilingReapproval({ ...input, fetcher }),
    { kind: "approved", ceilingMicroUsd: "11800000" });
  assert.deepEqual(sent, [{ url: "/api/admin/amux/task-ceiling",
    body: { ...input, ownerConfirmed: true } }]);

  const call = (fetcher: typeof fetch) => requestAmuxTaskCeilingReapproval({ ...input, fetcher });
  assert.deepEqual(await call(answer(409, { error: "not_reapprovable", reason: "cost_changed" })),
    { kind: "refused", reason: "cost_changed" });
  assert.deepEqual(await call(answer(409, { error: "busy" })), { kind: "refused", reason: "busy" });
  assert.deepEqual(await call(answer(428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" })), { kind: "reauth" });
  // An unknown outcome is never read as a refusal: it may have written.
  assert.deepEqual(await call(answer(503, { error: "outcome_unknown" })), { kind: "unknown" });
  assert.deepEqual(await call(answer(200, { status: "reapproved" })), { kind: "unknown" });
  assert.deepEqual(await call((async () => { throw new Error("offline"); }) as unknown as typeof fetch),
    { kind: "unknown" });
});

void React;
