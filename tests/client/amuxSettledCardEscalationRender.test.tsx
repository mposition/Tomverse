import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AmuxSettledCardEscalationPanel,
  requestAmuxSettledCardEscalationClose,
} from "@/components/admin/AmuxSettledCardEscalationPanel";

// A card that moved on while an earlier attempt's escalation stayed open (AMUX-FILEREQ-004):
// what the owner sees, and how each answer of the close route is read.

const html = (canAct = true) => renderToStaticMarkup(
  <AmuxSettledCardEscalationPanel taskId="task-1" escalationId="esc-1" canAct={canAct} onChanged={() => {}} />);

test("the owner sees why nothing else opens and the one close", () => {
  const out = html();
  assert.match(out, /data-testid="amux-settled-card-escalation"/);
  assert.match(out, /no review decision opens on this card/);
  assert.match(out, /The card keeps its status, results and history\./);
  assert.match(out, /data-testid="amux-settled-card-escalation-close"/);
});

test("a viewer who is not the owner sees the explanation but no action", () => {
  const out = html(false);
  assert.match(out, /data-testid="amux-settled-card-escalation"/);
  assert.doesNotMatch(out, /amux-settled-card-escalation-close/);
});

const answer = (status: number, body: unknown) => (async () =>
  Response.json(body, { status })) as unknown as typeof fetch;

test("the request posts the shown escalation with the owner's confirmation and reads each answer", async () => {
  const sent: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ status: "closed", escalationsResolved: 1 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await requestAmuxSettledCardEscalationClose({ taskId: "t1", escalationId: "e1", fetcher }),
    { kind: "closed" });
  assert.deepEqual(sent, [{ url: "/api/admin/amux/settled-card-escalation",
    body: { taskId: "t1", escalationId: "e1", ownerConfirmed: true } }]);

  const call = (fetcher: typeof fetch) => requestAmuxSettledCardEscalationClose({ taskId: "t1",
    escalationId: "e1", fetcher });
  assert.deepEqual(await call(answer(409, { error: "not_closable", reason: "decision_available" })),
    { kind: "refused", reason: "decision_available" });
  assert.deepEqual(await call(answer(409, { error: "busy" })), { kind: "refused", reason: "busy" });
  assert.deepEqual(await call(answer(428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" })), { kind: "reauth" });
  // An unknown outcome is never read as a refusal: it may have written.
  assert.deepEqual(await call(answer(503, { error: "outcome_unknown" })), { kind: "unknown" });
  assert.deepEqual(await call((async () => { throw new Error("offline"); }) as unknown as typeof fetch),
    { kind: "unknown" });
});

void React;
