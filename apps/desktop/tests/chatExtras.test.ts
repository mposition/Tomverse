import assert from "node:assert/strict";
import test from "node:test";
import { chatExtrasInput } from "../src/chat-extras-contract";
import { runChatExtras } from "../src/host/chat-extras";
import { failureText } from "../src/renderer/AnswerFeedback";
import { webLocales } from "../src/renderer/answer-locales";

type Call = { path: string; method?: string; body?: object };
function fake(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return { calls, send: async (call: Call) => { calls.push(call); return respond(call); } };
}
const feedback = { action: "feedback", product: "chat", messageId: "msg_1", message: "  The second paragraph is wrong.  ", modelId: "gpt-5" };

test("an answer report is posted as the web does, tied to the saved answer, with only typed fields", async () => {
  const api = fake(() => Response.json({ success: true, feedbackId: "cm1234abcdefgh", reference: "ABCD1234", emailUpdatesEnabled: true }));
  const outcome = await runChatExtras({ ...feedback, emailUpdates: true }, api);
  assert.deepEqual(outcome, { ok: true, reference: "ABCD1234", emailUpdatesEnabled: true });
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].path, "/api/feedback");
  assert.equal(api.calls[0].method, "POST");
  assert.deepEqual(api.calls[0].body, {
    type: "bug", message: "The second paragraph is wrong.", messageId: "msg_1", answerSignal: "needs_improvement",
    modelId: "gpt-5", path: "/desktop/chat", emailUpdates: true,
  });
});

test("a refused or unreachable report maps to the same failure classes the web shows", async () => {
  for (const [status, failure] of [[400, "invalid"], [429, "rateLimited"], [500, "server"], [413, "tooLarge"], [401, "verification"]] as const) {
    const outcome = await runChatExtras(feedback, fake(() => Response.json({ error: "x" }, { status })));
    assert.deepEqual(outcome, { ok: false, failure });
  }
  const unreachable = await runChatExtras(feedback, { send: async () => { throw new Error("offline"); } });
  assert.deepEqual(unreachable, { ok: false, failure: "network" });
});

test("the extras input refuses routes, short reports and unknown fields", () => {
  assert.equal(chatExtrasInput.safeParse({ ...feedback, path: "/api/admin" }).success, false);
  assert.equal(chatExtrasInput.safeParse({ ...feedback, message: "bad" }).success, false);
  assert.equal(chatExtrasInput.safeParse({ ...feedback, messageId: "../x" }).success, false);
  assert.equal(chatExtrasInput.safeParse({ action: "unknown" }).success, false);
});

test("every supported language has a sentence for each report failure", () => {
  for (const language of Object.keys(webLocales) as (keyof typeof webLocales)[]) {
    for (const failure of ["invalid", "verification", "tooLarge", "rateLimited", "server", "network", "unknown"] as const) {
      assert.ok(failureText(webLocales[language].feedback, failure).length > 0, `${language}:${failure}`);
    }
  }
});
