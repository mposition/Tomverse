import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxDecisionMakerJudgmentView,
  DM_OPERATOR_ANSWER_MAX_BYTES,
  dmJudgmentBody,
  dmJudgmentDraftProblem,
  runDmJudgment,
  type DmJudgmentDraft,
  type DmJudgmentIo,
  type DmJudgmentState,
} from "@/components/admin/AmuxDecisionMakerJudgmentPanel";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxDecisionMakerJudgmentMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import type { DmShownProposal } from "@/lib/amux/decisionMakerJudgmentCore";

/**
 * AMUX › Decision Maker, a person's judgment of one proposal
 * (docs/policy/amux-decision-maker.md §2-6, §4, §6), executed: the hook-free
 * view is called and its tree walked, and runDmJudgment() runs against a fake
 * route. The questions: a confirmation sends exactly the values Admin showed;
 * a judgment is sent once and never again over an unknown outcome; a refusal
 * before the transaction gives the controls back; the page says a confirmed
 * answer is not an approval; and nothing is sent from a draft the store would
 * refuse.
 */

type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
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

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const byTestId = (node: ReactNode, id: string) => propsOf(node).filter((props) => props["data-testid"] === id);
const one = (node: ReactNode, id: string) => {
  const found = byTestId(node, id);
  assert.equal(found.length, 1, id);
  return found[0]!;
};

const REQUEST_ID = "00000000-0000-4000-8000-000000000011";
const RELOAD = `/admin/amux-settings?tab=decision-maker&request=${REQUEST_ID}`;
const SHOWN: DmShownProposal = {
  answerDigest: "2".repeat(64),
  rationaleDigest: "3".repeat(64),
  optionId: null,
  irreversible: false,
  snapshotState: "worker_head",
  snapshotTargetSha: "0123456789abcdef0123456789abcdef01234567",
  snapshotManifestDigest: "b".repeat(64),
};
const DRAFT: DmJudgmentDraft = { accuracy: "not_judged", mismatchedItems: [], operatorAnswer: "" };

const view = (m: (typeof adminAmuxDecisionMakerJudgmentMessages)["en"], overrides: Partial<Parameters<typeof AmuxDecisionMakerJudgmentView>[0]> = {}) =>
  AmuxDecisionMakerJudgmentView({
    m,
    requestId: REQUEST_ID,
    irreversible: false,
    draft: DRAFT,
    state: { phase: "editing" },
    failure: null,
    reloadHref: RELOAD,
    onDraft: () => {},
    onSend: () => {},
    ...overrides,
  });

for (const locale of ["en", "ko"] as const) {
  const m = adminAmuxDecisionMakerJudgmentMessages[locale];

  test(`${locale}: while editing, confirm and reject are open and an edit waits for its answer`, () => {
    const sent: string[] = [];
    const tree = view(m, { onSend: (kind) => sent.push(kind) });
    assert.equal(one(tree, "amux-dm-judgment-confirm").disabled, false);
    assert.equal(one(tree, "amux-dm-judgment-reject").disabled, false);
    const edit = one(tree, "amux-dm-judgment-edit_confirm");
    assert.equal(edit.disabled, true);
    assert.equal(edit.title, m.answerRequired);
    (one(tree, "amux-dm-judgment-confirm").onClick as () => void)();
    assert.deepEqual(sent, ["confirm"]);
    // The page says a confirmed answer is not an approval (§1).
    assert.equal(textOf(one(tree, "amux-dm-judgment-not-approval").children as ReactNode), m.notApproval);
    assert.equal(byTestId(tree, "amux-dm-judgment-irreversible").length, 0);
    assert.equal(textOf(one(view(m, { irreversible: true }), "amux-dm-judgment-irreversible").children as ReactNode), m.irreversible);
    // Every control is a touch target of at least 44px.
    for (const kind of ["confirm", "edit_confirm", "reject"]) {
      assert.match(String(one(tree, `amux-dm-judgment-${kind}`).className), /min-h-11/);
    }
  });

  test(`${locale}: a draft the store would refuse sends nothing`, () => {
    const mismatchedNone: DmJudgmentDraft = { ...DRAFT, accuracy: "mismatched" };
    for (const kind of ["confirm", "edit_confirm", "reject"] as const) {
      assert.equal(dmJudgmentDraftProblem(m, kind, mismatchedNone), m.itemsRequired, kind);
      assert.equal(one(view(m, { draft: mismatchedNone }), `amux-dm-judgment-${kind}`).disabled, true, kind);
    }
    const tooLong = { ...DRAFT, operatorAnswer: "가".repeat(Math.floor(DM_OPERATOR_ANSWER_MAX_BYTES / 3) + 1) };
    assert.equal(dmJudgmentDraftProblem(m, "edit_confirm", tooLong), m.answerTooLong);
    assert.equal(dmJudgmentDraftProblem(m, "edit_confirm", { ...DRAFT, operatorAnswer: "   " }), m.answerRequired);
    assert.equal(dmJudgmentDraftProblem(m, "edit_confirm", { ...DRAFT, operatorAnswer: "Use the model id." }), null);
    assert.equal(dmJudgmentDraftProblem(m, "confirm", { ...DRAFT, accuracy: "mismatched", mismatchedItems: ["paths"] }), null);
  });

  test(`${locale}: sending and every settled state lock the controls; a settled state offers only a reload`, () => {
    const settled: Array<[DmJudgmentState, string]> = [
      [{ phase: "recorded", kind: "confirm" }, m.recorded.confirm],
      [{ phase: "recorded", kind: "reject" }, m.recorded.reject],
      [{ phase: "refused", reason: "shown_mismatch", bodyRefusal: null }, m.refused.shown_mismatch],
      [{ phase: "refused", reason: "operator_answer_refused", bodyRefusal: "secret_detected" }, `${m.refused.operator_answer_refused} ${m.bodyRefusals.secret_detected}`],
      [{ phase: "unknown" }, m.unknown],
    ];
    for (const [state, text] of [[{ phase: "sending", kind: "confirm" } as DmJudgmentState, ""] as const, ...settled]) {
      const tree = view(m, { state, draft: { ...DRAFT, operatorAnswer: "Use it." } });
      for (const kind of ["confirm", "edit_confirm", "reject"]) {
        assert.equal(one(tree, `amux-dm-judgment-${kind}`).disabled, true, `${state.phase} ${kind}`);
      }
      assert.equal(one(tree, "amux-dm-judgment-answer").disabled, true);
      // The accuracy fieldset is disabled with them.
      for (const value of ["not_judged", "matched", "mismatched"]) assert.ok(byTestId(tree, `amux-dm-judgment-accuracy-${value}`).length === 1);
      if (state.phase === "sending") {
        assert.equal(textOf(one(tree, "amux-dm-judgment-sending").children as ReactNode), m.sending);
        assert.equal(byTestId(tree, "amux-dm-judgment-reload").length, 0);
      } else {
        const box = one(tree, "amux-dm-judgment-settled");
        assert.equal(box.role, "status");
        assert.ok(textOf(box.children as ReactNode).includes(text), state.phase);
        assert.equal(one(tree, "amux-dm-judgment-reload").href, RELOAD);
      }
    }
  });
}

test("a confirmation names exactly what Admin showed; a rejection names none; the items keep the policy's order", () => {
  assert.deepEqual(dmJudgmentBody(REQUEST_ID, "confirm", SHOWN, DRAFT), {
    requestId: REQUEST_ID,
    kind: "confirm",
    shown: SHOWN,
    accuracy: { accuracy: "not_judged" },
  });
  assert.deepEqual(dmJudgmentBody(REQUEST_ID, "reject", SHOWN, { ...DRAFT, operatorAnswer: "ignored" }), {
    requestId: REQUEST_ID,
    kind: "reject",
    accuracy: { accuracy: "not_judged" },
  });
  assert.deepEqual(
    dmJudgmentBody(REQUEST_ID, "edit_confirm", SHOWN, { accuracy: "mismatched", mismatchedItems: ["paths", "effect_class"], operatorAnswer: "Use the model id." }),
    {
      requestId: REQUEST_ID,
      kind: "edit_confirm",
      shown: SHOWN,
      accuracy: { accuracy: "mismatched", mismatchedItems: ["effect_class", "paths"] },
      operatorAnswer: "Use the model id.",
    },
  );
});

const FAILURE = { message: "failure" } as unknown as AdminApiFailure;
const NETWORK = { message: "network" } as unknown as AdminApiFailure;
const run = async (answer: (() => Promise<Response>) | Response) => {
  let posts = 0;
  const updates: Array<{ state?: DmJudgmentState; failure?: AdminApiFailure | null }> = [];
  const io: DmJudgmentIo = {
    post: async () => {
      posts += 1;
      return typeof answer === "function" ? answer() : answer;
    },
    failureOf: async () => FAILURE,
    networkFailure: () => NETWORK,
  };
  await runDmJudgment(dmJudgmentBody(REQUEST_ID, "confirm", SHOWN, DRAFT), io, (changes) => updates.push(changes));
  const last = updates.filter((update) => update.state !== undefined).at(-1)!.state!;
  const failure = updates.filter((update) => "failure" in update).at(-1)?.failure ?? null;
  return { posts, last, failure, first: updates[0]!.state };
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a judgment is sent once and settles on the route's answer", async () => {
  const recorded = await run(json(200, { recorded: true, kind: "confirm", judgmentId: "j", createdAt: "t" }));
  assert.equal(recorded.posts, 1);
  assert.deepEqual(recorded.first, { phase: "sending", kind: "confirm" });
  assert.deepEqual(recorded.last, { phase: "recorded", kind: "confirm" });

  const refused = await run(json(409, { error: "judgment_refused", reason: "kill_switch_on" }));
  assert.equal(refused.posts, 1);
  assert.deepEqual(refused.last, { phase: "refused", reason: "kill_switch_on", bodyRefusal: null });
});

test("a refusal before the transaction, or a rolled-back 503, gives the controls back with the failure", async () => {
  for (const response of [
    json(428, { error: "reauthentication_required", code: "ADMIN_REAUTHENTICATION_REQUIRED" }),
    json(403, { error: "Forbidden." }),
    json(400, { error: "invalid_judgment" }),
    json(429, { error: "rate_limited" }),
    json(503, { error: "judgment_failed" }),
    json(503, { error: "dm_digest_keys_unavailable" }),
  ]) {
    const outcome = await run(response);
    assert.equal(outcome.posts, 1, String(response.status));
    assert.deepEqual(outcome.last, { phase: "editing" }, String(response.status));
    assert.equal(outcome.failure, FAILURE, String(response.status));
  }
});

test("an unknown outcome, an unreadable answer or no answer at all is never sent again", async () => {
  for (const answer of [
    json(503, { error: "outcome_unknown" }),
    json(502, { error: "bad gateway" }),
    new Response("not json", { status: 200 }),
    json(200, { recorded: false }),
    new Response("not json", { status: 503 }),
  ]) {
    const outcome = await run(answer);
    assert.equal(outcome.posts, 1);
    assert.deepEqual(outcome.last, { phase: "unknown" });
  }
  const lost = await run(async () => {
    throw new TypeError("network");
  });
  assert.equal(lost.posts, 1);
  assert.deepEqual(lost.last, { phase: "unknown" });
  assert.equal(lost.failure, NETWORK);
});
