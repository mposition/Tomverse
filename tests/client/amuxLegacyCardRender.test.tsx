import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AmuxLegacyCardPanel,
  requestAmuxLegacyCardAction,
  type AmuxLegacyCardView,
} from "@/components/admin/AmuxLegacyCardPanel";

// The legacy WORKBOARD card panel on the execution board's card detail: what
// the owner sees before acting, and how each answer of the route is read.

const ready: AmuxLegacyCardView = { kind: "workboard", closeRefusal: null,
  idea: { state: "ready", title: "The renewal date is hidden.", truncated: false,
    text: "The renewal date is hidden.\n\n완료 기준:\n- The date shows\n\n원래 카드: AMUX-WORKBOARD-061" } };

const html = (view: AmuxLegacyCardView, canAct = true) => renderToStaticMarkup(
  <AmuxLegacyCardPanel taskId="cmlegacy0001" revision={4} view={view} canAct={canAct} onChanged={() => {}} />);

test("the owner sees the idea that will be saved and both actions", () => {
  const out = html(ready);
  assert.match(out, /data-testid="amux-legacy-card"/);
  assert.match(out, /The idea that will be saved: The renewal date is hidden\./);
  assert.match(out, /원래 카드: AMUX-WORKBOARD-061/);
  assert.match(out, /data-testid="amux-legacy-card-recreate"/);
  assert.match(out, /data-testid="amux-legacy-card-close"/);
  assert.doesNotMatch(out, /amux-legacy-card-not-closable/);
});

test("a pre-v22 Task says why it has no recovery path", () => {
  const out = html({ ...ready, kind: "pre_v22_task" });
  assert.match(out, /Task made before v22/);
  assert.match(out, /has no v22 receipt/);
  assert.match(out, /data-testid="amux-legacy-card-recreate"/);
});

test("an archived card still in the owner queue says the close only resolves its escalation", () => {
  const out = html({ ...ready, alreadyArchived: true });
  assert.match(out, /already archived, but an open escalation still lists it in the owner queue/);
  assert.doesNotMatch(out, /Closing archives the card/);
  assert.match(out, /data-testid="amux-legacy-card-recreate"/);
  assert.match(out, /data-testid="amux-legacy-card-close"/);
  assert.doesNotMatch(out, /amux-legacy-card-not-closable/);
});

test("a viewer who is not the owner sees the card but no action", () => {
  const out = html(ready, false);
  assert.match(out, /data-testid="amux-legacy-card"/);
  assert.doesNotMatch(out, /amux-legacy-card-recreate|amux-legacy-card-close"/);
});

test("a running card shows why and offers nothing to press", () => {
  const out = html({ ...ready, closeRefusal: "running" });
  assert.match(out, /cannot be closed now: work for this card is still queued, leased or running/);
  assert.doesNotMatch(out, /amux-legacy-card-recreate|amux-legacy-card-close"/);
});

test("an idea the input gate refuses shows the reason and leaves only the close", () => {
  const out = html({ ...ready, idea: { state: "refused", code: "content_refused" } });
  assert.match(out, /data-testid="amux-legacy-card-idea-refused"/);
  assert.match(out, /an address, a secret, personal data or a path/);
  assert.doesNotMatch(out, /amux-legacy-card-recreate/);
  assert.match(out, /data-testid="amux-legacy-card-close"/);
});

const answer = (status: number, body: unknown) => (async () =>
  Response.json(body, { status })) as unknown as typeof fetch;

test("the request posts the owner's confirmation and reads each answer", async () => {
  const sent: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ status: "recreated", ideaId: "idea-1", requestId: "r-1", closed: true });
  }) as unknown as typeof fetch;
  assert.deepEqual(await requestAmuxLegacyCardAction({ action: "recreate", taskId: "t1", revision: 4, fetcher }),
    { kind: "recreated", requestId: "r-1", closed: true, reason: null });
  assert.deepEqual(sent, [{ url: "/api/admin/amux/legacy-card",
    body: { action: "recreate", taskId: "t1", revision: 4, ownerConfirmed: true } }]);

  const call = (fetcher: typeof fetch) => requestAmuxLegacyCardAction({ action: "close", taskId: "t1", revision: 4,
    fetcher });
  assert.deepEqual(await call(answer(200, { status: "closed", closed: true })), { kind: "closed" });
  assert.deepEqual(await call(answer(409, { error: "not_closable", reason: "running" })),
    { kind: "refused", error: "not_closable", reason: "running" });
  assert.deepEqual(await call(answer(400, { error: "idea_refused", reason: "too_large" })),
    { kind: "refused", error: "idea_refused", reason: "too_large" });
  assert.deepEqual(await call(answer(503, { error: "amux_submission_disabled" })),
    { kind: "refused", error: "amux_submission_disabled", reason: null });
  assert.deepEqual(await call(answer(428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" })), { kind: "reauth" });
  // An unknown outcome is never read as a refusal: it may have written.
  assert.deepEqual(await call(answer(503, { error: "outcome_unknown" })), { kind: "unknown" });
  assert.deepEqual(await call(answer(500, {})), { kind: "unknown" });
  assert.deepEqual(await call((async () => { throw new Error("offline"); }) as unknown as typeof fetch),
    { kind: "unknown" });
});

void React;
