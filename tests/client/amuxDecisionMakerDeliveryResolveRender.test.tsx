import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxDecisionMakerDeliveryResolveView,
  runDmDeliveryResolve,
  type DmDeliveryResolveState,
} from "@/components/admin/AmuxDecisionMakerDeliveryResolvePanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import type { DmDeliveryResolveOutcome } from "@/lib/amux/decisionMakerJudgmentCore";
import { adminAmuxDecisionMakerAttentionMessages } from "@/lib/adminMessages/amuxDecisionMaker";

/**
 * docs/policy/amux-decision-maker.md §9: a person records what became of a
 * confirmed answer whose delivery is unknown, once. The hook-free view is
 * called and its tree walked; the send is driven with a fake transport.
 */

type Props = Record<string, unknown>;
const propsOf = (node: ReactNode, found: Props[] = []): Props[] => {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};
const one = (tree: ReactNode, id: string) => {
  const found = propsOf(tree).filter((props) => props["data-testid"] === id);
  assert.equal(found.length, 1, id);
  return found[0]!;
};

const RELOAD = "/admin/amux-execution?dmRequest=r-1";
const view = (d: (typeof adminAmuxDecisionMakerAttentionMessages)["en"], state: DmDeliveryResolveState, onResolve: (outcome: DmDeliveryResolveOutcome) => void = () => {}) =>
  AmuxDecisionMakerDeliveryResolveView({ d, state, failure: null, reloadHref: RELOAD, onResolve });

for (const locale of ["en", "ko"] as const) {
  const d = adminAmuxDecisionMakerAttentionMessages[locale];

  test(`${locale}: both outcomes are offered while idle, as 44px targets, and send what they say`, () => {
    const sent: DmDeliveryResolveOutcome[] = [];
    const tree = view(d, { phase: "idle" }, (outcome) => sent.push(outcome));
    for (const outcome of ["delivered", "not_delivered"]) {
      const button = one(tree, `amux-dm-delivery-resolve-${outcome}`);
      assert.equal(button.disabled, false);
      assert.match(String(button.className), /min-h-11/);
      (button.onClick as () => void)();
    }
    assert.deepEqual(sent, ["delivered", "not_delivered"]);
  });

  test(`${locale}: sending and every settled state lock both buttons; a settled state offers a reload`, () => {
    const states: DmDeliveryResolveState[] = [
      { phase: "sending", outcome: "delivered" },
      { phase: "recorded", outcome: "not_delivered" },
      { phase: "refused", reason: "already_resolved" },
      { phase: "unknown" },
    ];
    for (const state of states) {
      const tree = view(d, state);
      for (const outcome of ["delivered", "not_delivered"]) assert.equal(one(tree, `amux-dm-delivery-resolve-${outcome}`).disabled, true);
      if (state.phase !== "sending") assert.equal(one(tree, "amux-dm-delivery-resolve-settled").role, "status");
    }
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const drive = async (answer: () => Promise<Response>) => {
  const posts: unknown[] = [];
  const steps: Array<{ state?: DmDeliveryResolveState; failure?: AdminApiFailure | null }> = [];
  await runDmDeliveryResolve(
    "r-1",
    "delivered",
    {
      post: async (body) => {
        posts.push(body);
        return answer();
      },
      failureOf: async () => ({ message: "failed" }) as unknown as AdminApiFailure,
    },
    (changes) => steps.push(changes),
  );
  return { posts, last: steps.at(-1)! };
};

test("a resolution is sent once and settles on the route's answer", async () => {
  const recorded = await drive(async () => json(200, { recorded: true, outcome: "delivered" }));
  assert.deepEqual(recorded.posts, [{ requestId: "r-1", outcome: "delivered" }]);
  assert.deepEqual(recorded.last.state, { phase: "recorded", outcome: "delivered" });

  const refused = await drive(async () => json(409, { error: "resolution_refused", reason: "not_unknown" }));
  assert.deepEqual(refused.last.state, { phase: "refused", reason: "not_unknown" });
});

test("an unknown outcome or a lost answer is never sent again; a refusal before the write gives the buttons back", async () => {
  for (const answer of [async () => json(503, { error: "outcome_unknown" }), async () => { throw new Error("network"); }]) {
    const run = await drive(answer);
    assert.equal(run.posts.length, 1);
    assert.deepEqual(run.last.state, { phase: "unknown" });
  }
  const stale = await drive(async () => json(428, { code: "ADMIN_REAUTHENTICATION_REQUIRED" }));
  assert.deepEqual(stale.last.state, { phase: "idle" });
  assert.ok(stale.last.failure, "the failure is shown with the way back");
});
