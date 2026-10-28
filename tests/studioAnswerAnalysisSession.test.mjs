import test from "node:test";
import assert from "node:assert/strict";
import { StudioAnswerAnalysisSession } from "../lib/studioAnswerAnalysisSession.ts";

const setup = (answer = "first") => ({ available: true, source: { question: "Question", responses: [{ messageId: "a", content: answer }, { messageId: "b", content: "second" }] } });
const review = { id: "saved" };
test("repeated opens and concurrent scopes share one execution for the same actual input", async () => {
  const session = new StudioAnswerAnalysisSession();
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const execute = async () => { calls++; await gate; return review; };
  const a = session.open("a", async () => setup(), execute);
  const b = session.open("a", async () => setup(), execute);
  const c = session.open("b", async () => setup(), execute);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(); await Promise.all([a, b, c]);
  await session.open("a", async () => { throw Error("unexpected lookup"); }, execute);
  assert.equal(calls, 1);
  assert.equal(session.get("a").review, review);
  assert.equal(session.get("b").review, review);
});
test("stored server result never executes and changed answer never inherits the prior analysis", async () => {
  const session = new StudioAnswerAnalysisSession();
  let calls = 0;
  await session.open("saved", async () => ({ ...setup(), storedReview: review }), async () => { throw Error("must not execute"); });
  await session.open("first", async () => setup(), async () => { calls++; return review; });
  await session.open("changed", async () => setup("edited"), async () => { calls++; return { id: "new" }; });
  assert.equal(calls, 2);
  assert.equal(session.get("saved").review, review);
  assert.equal(session.get("changed").review.id, "new");
});
test("a late completion updates its own scope, not the new question or identity", async () => {
  const session = new StudioAnswerAnalysisSession();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const old = session.open("old", async () => setup(), async () => { await gate; return review; });
  await session.open("new", async () => setup("new"), async () => ({ id: "new" }));
  release(); await old;
  assert.equal(session.get("new").review.id, "new");
  assert.equal(new StudioAnswerAnalysisSession().get("old"), undefined);
});
test("unknown execution failure rechecks server storage before retrying", async () => {
  const session = new StudioAnswerAnalysisSession();
  let calls = 0;
  await session.open("a", async () => setup(), async () => { calls++; throw Error("connection lost"); });
  assert.equal(session.get("a").phase, "error");
  await session.open("a", async () => ({ ...setup(), storedReview: review }), async () => { calls++; return review; });
  assert.equal(calls, 1);
  assert.equal(session.get("a").phase, "done");
});
