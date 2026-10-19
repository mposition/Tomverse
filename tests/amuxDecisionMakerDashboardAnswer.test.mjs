// AMUX Decision Maker stage S2-2b3, the dashboard's half of
// docs/policy/amux-decision-maker.md §2-7: "질문 revision 하나에는 답이 한 번만
// 전달된다 ... 먼저 쓴 쪽만 전달되고, 다른 쪽은 거절되어 운영자에게 보인다".
//
// The dashboard's direct answer (vendor/amux/crates/amux-dashboard/static/app.js)
// claims the card's answer record before it sends, and sends only on the
// claim it won. This runs the shipped `_focusClaimAnswer` itself, read out of
// app.js, against a stand-in for the board route's answers, so the decision
// it makes -- send or not -- is the one under test, not a copy of it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const APP = new URL("../vendor/amux/crates/amux-dashboard/static/app.js", import.meta.url);

/** The shipped function's source, from its declaration to the next one. */
const shipped = (name) => {
  const source = readFileSync(APP, "utf8");
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is in app.js`);
  const end = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

/**
 * `_focusClaimAnswer` bound to a board route that answers `reply` (a status
 * and a body, or a thrown error). Returns the refusal it shows, or null when
 * it lets the answer go, and the requests it made.
 */
const claimWith = async (reply, revision = 3) => {
  const requests = [];
  const context = vm.createContext({
    API: "https://amux.local",
    AbortSignal: { timeout: () => undefined },
    JSON,
    encodeURIComponent,
    Number,
    _authHeaders: (headers) => headers,
    _directInteractionFetch: async (url, init) => {
      requests.push({ url, init });
      if (reply instanceof Error) throw reply;
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
    },
  });
  vm.runInContext(shipped("_focusClaimAnswer"), context);
  const refusal = await vm.runInContext(`_focusClaimAnswer({ id: "AMUX-12" }, ${JSON.stringify(revision)})`, context);
  return { refusal, requests };
};

test("only the claim this answer won lets it go; an answer already recorded, by anyone, sends nothing", async () => {
  // Review r-20261018-065705-65cb2a, finding 1: two tabs answering the same
  // revision -- the first is `claimed`, the second `already_answered` by the
  // operator -- must not both send.
  const won = await claimWith({ status: 200, body: { outcome: "claimed", question_revision: 3, answer: { source: "operator" } } });
  assert.equal(won.refusal, null);
  for (const source of ["operator", "dm_confirmed"]) {
    const { refusal } = await claimWith({
      status: 200,
      body: { outcome: "already_answered", question_revision: 3, answer: { source } },
    });
    assert.equal(typeof refusal, "string", `already answered by ${source}: nothing is sent`);
    assert.match(refusal, /nothing was sent/);
  }
});

test("a card with no typed question has nothing to claim; every other answer refuses", async () => {
  assert.equal((await claimWith({ status: 200, body: { outcome: "no_typed_revision" } }, null)).refusal, null);
  for (const reply of [
    { status: 200, body: { outcome: "question_changed", question_revision: 4 } },
    { status: 200, body: { outcome: "refused", reason: "stale_revision" } },
    { status: 200, body: {} },
    { status: 400, body: { reason: "question_revision_required" } },
    { status: 500, body: {} },
    new Error("offline"),
  ]) {
    const { refusal } = await claimWith(reply);
    assert.equal(typeof refusal, "string", JSON.stringify(reply.body ?? String(reply)));
  }
});

test("the claim names the revision the operator was shown, on the board route", async () => {
  const { requests } = await claimWith({ status: 200, body: { outcome: "claimed" } }, 7);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://amux.local/api/board/AMUX-12/typed-ask/answer");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), { question_revision: 7 });
});
