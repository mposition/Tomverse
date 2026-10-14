import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";

import {
  AmuxCardOwnerReview,
  amuxCardReviewReturnPath,
  type AmuxOwnerReviewController,
} from "@/components/admin/AdminAmuxRoutingPanel";

const TASK_ID = "16b56903-card";
const ESCALATION_ID = "clcardreview12345678901234";
const PENDING_DECISION_KEY = "amux-review-pending-decision-v1";

function browser(t: TestContext, stored: Record<string, string> = {}) {
  const values = new Map(Object.entries(stored));
  const sessionStorage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ code: "AMUX_REVIEW_TEMPORARILY_UNAVAILABLE" }, { status: 503 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { requests };
}

// Minimal hook harness for the actual component, in the shape the recovery
// panel test uses: React's installed client dispatcher is swapped for one
// that keeps slots, runs effects after render and re-renders on state.
function mount() {
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:
    { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  assert.ok(internals && "H" in internals, "installed React client dispatcher is required");
  const slots: unknown[] = [];
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  const queued: (() => void)[] = [];
  let cursor = 0, dirty = true;
  let tree!: React.ReactElement<{ children: React.ReactElement<{ controller: AmuxOwnerReviewController }>[] }>;
  const same = (deps: unknown[], previous?: unknown[]) =>
    previous !== undefined && deps.every((value, pos) => Object.is(value, previous[pos]));
  const dispatcher = {
    useContext: () => ({ locale: "en", pending: false, setLocale: () => {} }),
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: unknown) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next; dirty = true;
      }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback: unknown, deps: unknown[]) => {
      const index = cursor++;
      const previous = slots[index] as { callback: unknown; deps: unknown[] } | undefined;
      if (!previous || !same(deps, previous.deps)) slots[index] = { callback, deps };
      return (slots[index] as { callback: unknown }).callback;
    },
    useEffect: (create: () => (() => void) | undefined, deps: unknown[]) => {
      const index = cursor++, previous = effects.get(index);
      if (previous && same(deps, previous.deps)) return;
      queued.push(() => { previous?.cleanup?.(); effects.set(index, { deps, cleanup: create() }); });
    },
  };
  const render = () => {
    cursor = 0; dirty = false;
    const previous = internals.H; internals.H = dispatcher;
    try {
      tree = AmuxCardOwnerReview({ taskId: TASK_ID, escalationId: ESCALATION_ID,
        canInspectCards: true, onDecisionCommitted: () => {} }) as typeof tree;
    } finally { internals.H = previous; }
    queued.splice(0).forEach((create) => create());
  };
  const flush = async () => {
    for (let turn = 0; turn < 32; turn += 1) { if (dirty) render(); await Promise.resolve(); }
    if (dirty) render();
  };
  render();
  return { flush, get controller() { return tree.props.children[1].props.controller; },
    get children() { return tree.props.children; } };
}

test("a card's review step-up returns to that card, and only a well-formed task id", () => {
  assert.equal(amuxCardReviewReturnPath(TASK_ID), `/admin/amux-execution?tab=cards&taskId=${TASK_ID}`);
  for (const bad of ["", "a&tab=assignment", "x".repeat(129), "../cards"]) {
    assert.equal(amuxCardReviewReturnPath(bad), "/admin/amux-execution?tab=cards");
  }
});

test("a card waiting on the owner reads its newest escalation's review exactly once", async (t) => {
  const { requests } = browser(t);
  const view = mount();
  await view.flush();
  await view.flush();
  assert.deepEqual(requests, [
    `/api/admin/amux/escalations/review?escalation_id=${ESCALATION_ID}`,
  ]);
  assert.equal(view.controller.selectedEscalationId, ESCALATION_ID);
  // The card dialog closes the card; the review has no close of its own, and
  // a refused step-up comes back to this card rather than to Assignment.
  const detail = view.children[1].props as unknown as { showClose: boolean; reviewReturnPath: string };
  assert.equal(detail.showClose, false);
  assert.equal(detail.reviewReturnPath, `/admin/amux-execution?tab=cards&taskId=${TASK_ID}`);
  const notice = view.children[0].props as unknown as { returnPath: string };
  assert.equal(notice.returnPath, `/admin/amux-execution?tab=cards&taskId=${TASK_ID}`);
});

test("a decision left unresolved by a reload freezes the card review before any read", async (t) => {
  const pending = { decision_id: "0b5c9a52-4d1e-4f6a-9b7c-2d3e4f5a6b7c",
    subject_digest: "a".repeat(64), outcome: "block", escalation_id: "clotherreview1234567890123" };
  const { requests } = browser(t, { [PENDING_DECISION_KEY]: JSON.stringify(pending) });
  const view = mount();
  await view.flush();
  await view.flush();
  assert.deepEqual(requests, []);
  assert.deepEqual(view.controller.pendingDecision, pending);
  assert.equal(view.controller.decisionStatusUnknown, true);
  assert.equal(view.controller.selectedEscalationId, null);
});
