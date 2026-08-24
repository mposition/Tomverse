import assert from "node:assert/strict";
import test from "node:test";
import {
  leadOutOfSync,
  rewriteNewConversationModelIds,
} from "../lib/defaultModelReconciliationCore.ts";

const rewrite = (raw) =>
  rewriteNewConversationModelIds(raw, {
    from: "gpt-5-4-mini",
    to: "gpt-5-6-luna",
  });

test("NULL is not stale and is left alone", () => {
  // NULL means [defaultModel], so it follows whatever defaultModel becomes.
  assert.deepEqual(rewrite(null), { status: "unset" });
  assert.deepEqual(rewrite(undefined), { status: "unset" });
});

test("a combination naming the retired model is rewritten in place", () => {
  const result = rewrite(["gpt-5-4-mini", "claude-sonnet-5"]);
  assert.equal(result.status, "rewritten");
  assert.deepEqual(result.models, ["gpt-5-6-luna", "claude-sonnet-5"]);
  assert.equal(result.leadChanged, true);
});

test("position is preserved: a retired model in second place stays second", () => {
  const result = rewrite(["claude-sonnet-5", "gpt-5-4-mini"]);
  assert.deepEqual(result.models, ["claude-sonnet-5", "gpt-5-6-luna"]);
  // The lead did not move, so this user's first model is unchanged.
  assert.equal(result.leadChanged, false);
});

test("a combination that already held the replacement does not name it twice", () => {
  const result = rewrite(["gpt-5-4-mini", "gpt-5-6-luna", "claude-sonnet-5"]);
  assert.deepEqual(result.models, ["gpt-5-6-luna", "claude-sonnet-5"]);
});

test("a combination without the retired model is untouched", () => {
  assert.deepEqual(rewrite(["claude-sonnet-5"]), { status: "unchanged" });
});

test("malformed values are reported, never repaired", () => {
  for (const raw of [[], "gpt-5-4-mini", [1, 2], ["gpt-5-4-mini", ""], {}]) {
    assert.equal(
      rewrite(raw).status,
      "malformed",
      `${JSON.stringify(raw)} must be reported`
    );
  }
});

test("a combination over the picker's limit is flagged rather than trimmed", () => {
  const result = rewriteNewConversationModelIds(
    ["a", "b", "c", "gpt-5-4-mini"],
    { from: "gpt-5-4-mini", to: "gpt-5-6-luna", maxSelectedModels: 3 }
  );
  assert.equal(result.status, "rewritten");
  assert.equal(result.models.length, 4);
  assert.match(result.warning, /above the 3/);
});

test("the lead and defaultModel disagreeing is reported, not corrected", () => {
  // Reordering to match would be choosing which model speaks first on the
  // user's behalf, which is the opposite of what a retirement pass is for.
  assert.equal(leadOutOfSync(["claude-sonnet-5", "gpt-5-6-luna"], "gpt-5-6-luna"), true);
  assert.equal(leadOutOfSync(["gpt-5-6-luna", "claude-sonnet-5"], "gpt-5-6-luna"), false);
  assert.equal(leadOutOfSync(null, "gpt-5-6-luna"), false);
});

test("rewriting is idempotent", () => {
  const once = rewrite(["gpt-5-4-mini", "claude-sonnet-5"]);
  assert.deepEqual(rewrite(once.models), { status: "unchanged" });
});
