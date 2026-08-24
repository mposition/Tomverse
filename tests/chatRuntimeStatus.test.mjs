import assert from "node:assert/strict";
import test from "node:test";
import {
  chatModelStatusKey,
  isConversationResponding,
  scopeModelStatusesToConversation,
} from "../lib/chatRuntimeStatus.ts";

// ---------------------------------------------------------------------------
// The regression these cover: both shells held `modelStatuses` keyed by model
// id alone, so a run started in conversation A disabled the composer of every
// other conversation -- including a brand new chat, which then showed a stop
// button for a run it had never started.
// ---------------------------------------------------------------------------

const KEY_A = chatModelStatusKey("conversation-a", "gpt-5-4-mini");
const KEY_NEW = chatModelStatusKey(null, "gpt-5-4-mini");

test("a report is keyed by the conversation it was made in", () => {
  assert.equal(KEY_A, "conversation-a:gpt-5-4-mini");
  // A chat with no id yet is a state of its own, not a missing value.
  assert.equal(KEY_NEW, "new:gpt-5-4-mini");
  assert.notEqual(KEY_A, KEY_NEW);
});

test("a run in another conversation is invisible to the one on screen", () => {
  const statuses = { [KEY_A]: "responding" };

  const scoped = scopeModelStatusesToConversation({
    statuses,
    conversationId: null,
    selectedModelIds: ["gpt-5-4-mini"],
  });

  assert.deepEqual(scoped, {});
  assert.equal(
    isConversationResponding({
      statuses: scoped,
      selectedModelIds: ["gpt-5-4-mini"],
      disabledModelIds: [],
    }),
    false
  );
});

test("the conversation that owns the run still reads as busy", () => {
  const scoped = scopeModelStatusesToConversation({
    statuses: { [KEY_A]: "responding" },
    conversationId: "conversation-a",
    selectedModelIds: ["gpt-5-4-mini"],
  });

  assert.deepEqual(scoped, { "gpt-5-4-mini": "responding" });
  assert.equal(
    isConversationResponding({
      statuses: scoped,
      selectedModelIds: ["gpt-5-4-mini"],
      disabledModelIds: [],
    }),
    true
  );
});

test("a model dropped from the selection stops counting immediately", () => {
  // The exact shape of the reported bug: two conversations with different
  // model sets. `claude-sonnet-5` answered in this same conversation and is
  // still marked responding, but it is no longer one of its panels.
  const statuses = {
    [chatModelStatusKey("conversation-a", "claude-sonnet-5")]: "responding",
    [chatModelStatusKey("conversation-a", "gpt-5-4-mini")]: "idle",
  };

  const scoped = scopeModelStatusesToConversation({
    statuses,
    conversationId: "conversation-a",
    selectedModelIds: ["gpt-5-4-mini"],
  });

  assert.deepEqual(scoped, { "gpt-5-4-mini": "idle" });
  assert.equal(
    isConversationResponding({
      statuses: scoped,
      selectedModelIds: ["gpt-5-4-mini"],
      disabledModelIds: [],
    }),
    false
  );
});

test("a paused panel runs nothing, so it blocks nothing", () => {
  const scoped = {
    "gpt-5-4-mini": "responding",
    "claude-sonnet-5": "idle",
  };

  assert.equal(
    isConversationResponding({
      statuses: scoped,
      selectedModelIds: ["gpt-5-4-mini", "claude-sonnet-5"],
      disabledModelIds: ["gpt-5-4-mini"],
    }),
    false
  );
  assert.equal(
    isConversationResponding({
      statuses: scoped,
      selectedModelIds: ["gpt-5-4-mini", "claude-sonnet-5"],
      disabledModelIds: [],
    }),
    true
  );
});

test("only `responding` holds the composer -- errors and stops release it", () => {
  for (const status of ["idle", "error", "cancelled", "paused", "loading"]) {
    assert.equal(
      isConversationResponding({
        statuses: { "gpt-5-4-mini": status },
        selectedModelIds: ["gpt-5-4-mini"],
        disabledModelIds: [],
      }),
      false,
      `${status} must not hold the composer`
    );
  }
});
