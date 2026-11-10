import assert from "node:assert/strict";
import test from "node:test";
import { prepareChatSendInputs } from "../lib/chatSendPreparation";

const deferred = <T>() => Promise.withResolvers<T>();

test("context and draft start together, but neither result permits dispatch before both settle", async () => {
  const context = deferred<string | null>();
  const draft = deferred<{ revision: number } | null>();
  const calls: string[] = [];
  let returned = false;
  const pending = prepareChatSendInputs({
    context: () => { calls.push("context"); return context.promise; },
    draft: () => { calls.push("draft"); return draft.promise; },
    isCurrent: () => true,
    abortDraft: () => assert.fail("current draft must survive"),
  }).then(value => { returned = true; return value; });
  assert.deepEqual(calls, ["context", "draft"]);
  draft.resolve({ revision: 7 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  context.resolve("same-priced-context");
  assert.deepEqual(await pending, { contextBundle: "same-priced-context", preparedDraft: { revision: 7 } });
});

test("an identity or model change during either job releases the prepared draft without dispatch", async () => {
  for (const delayed of ["context", "draft"]) {
    const gate = deferred<void>();
    let current = true;
    const aborted: string[] = [];
    const pending = prepareChatSendInputs({
      context: async () => { if (delayed === "context") await gate.promise; return "context"; },
      draft: async () => { if (delayed === "draft") await gate.promise; return "draft"; },
      isCurrent: () => current,
      abortDraft: draft => { aborted.push(draft); },
    });
    current = false;
    gate.resolve();
    assert.equal(await pending, null);
    assert.deepEqual(aborted, ["draft"]);
  }
});

test("a failed context job drains and releases a late draft before propagating failure", async () => {
  const draft = deferred<string | null>();
  const aborted: string[] = [];
  const pending = prepareChatSendInputs({ context: async () => { throw Error("failed"); },
    draft: () => draft.promise, isCurrent: () => true, abortDraft: value => { aborted.push(value); } });
  const rejected = assert.rejects(pending, /failed/);
  draft.resolve("late-draft");
  await rejected;
  assert.deepEqual(aborted, ["late-draft"]);
});

test("empty context and refused draft retain their distinct existing outcomes", async () => {
  assert.deepEqual(await prepareChatSendInputs({ context: async () => null, draft: async () => null,
    isCurrent: () => true, abortDraft: () => assert.fail() }), { contextBundle: null, preparedDraft: null });
  await assert.rejects(prepareChatSendInputs({ context: async () => "context", draft: async () => { throw Error("draft failed"); },
    isCurrent: () => true, abortDraft: () => assert.fail() }), /draft failed/);
});
