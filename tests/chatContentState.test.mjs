import assert from "node:assert/strict";
import test from "node:test";

import {
  chatContentStateKey,
  readGuestChatContentState,
  resolveChatContentState,
} from "../lib/chatContentState.ts";
import { guestMessageKeysForConversation } from "../lib/guestConversationStorage.ts";

// The defect these tests pin: "no panel has reported yet" used to be folded
// into "empty", and "empty" is the one state that renders ChatWelcomeScreen.
// Every case below is a moment where the old boolean said `empty` about a
// conversation nobody had established anything about.

const MODELS = ["gpt-5-6-luna", "claude-sonnet-5"];

const base = (overrides = {}) => ({
  isConversationSelectionResolved: true,
  conversationId: "conv-1",
  selectedModelIds: MODELS,
  reported: {},
  ...overrides,
});

const reportedAs = (conversationId, states) =>
  Object.fromEntries(
    Object.entries(states).map(([modelId, state]) => [
      chatContentStateKey(conversationId, modelId),
      state,
    ])
  );

test("the key names the conversation and the model, with an explicit id for a chat that has none", () => {
  assert.equal(chatContentStateKey("conv-1", "m"), "conv-1:m");
  assert.equal(chatContentStateKey(null, "m"), "new:m");
});

test("nothing is claimed before the active conversation has been decided", () => {
  assert.equal(
    resolveChatContentState(
      base({
        isConversationSelectionResolved: false,
        // Even with an id already in hand and a report already in: which
        // conversation is active is still being decided, so this report may
        // not describe the one the user is about to see.
        reported: reportedAs("conv-1", {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "unknown"
  );
});

test("an unreported panel is unknown, never empty", () => {
  assert.equal(resolveChatContentState(base()), "unknown");
  assert.equal(
    resolveChatContentState(
      base({
        reported: reportedAs("conv-1", { "gpt-5-6-luna": "empty" }),
      })
    ),
    "unknown",
    "one panel out of two is not the whole conversation"
  );
});

test("a panel that has gone back to loading retracts its own answer", () => {
  assert.equal(
    resolveChatContentState(
      base({
        reported: reportedAs("conv-1", {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "unknown",
        }),
      })
    ),
    "unknown"
  );
});

test("every panel reporting empty is the only way reports reach empty", () => {
  assert.equal(
    resolveChatContentState(
      base({
        reported: reportedAs("conv-1", {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "empty"
  );
});

test("one panel with a turn in it settles the whole conversation", () => {
  assert.equal(
    resolveChatContentState(
      base({
        reported: reportedAs("conv-1", {
          // A model added to the comparison later has nothing in it yet; that
          // does not make the conversation empty.
          "gpt-5-6-luna": "non-empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "non-empty"
  );
});

test("reports for a different conversation are not read", () => {
  assert.equal(
    resolveChatContentState(
      base({
        conversationId: "conv-2",
        reported: reportedAs("conv-1", {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "unknown",
    "switching conversations must not inherit the previous one's answer"
  );
});

test("no conversation id at all means there is nothing to load", () => {
  assert.equal(
    resolveChatContentState(base({ conversationId: null })),
    "empty",
    "an account sitting on the welcome home screen has no stored transcript anywhere"
  );
});

test("an optimistic first turn outranks the no-id shortcut", () => {
  assert.equal(
    resolveChatContentState(
      base({
        conversationId: null,
        reported: reportedAs(null, { "gpt-5-6-luna": "non-empty" }),
      })
    ),
    "non-empty"
  );
});

test("an accepted send keeps the conversation non-empty while its panels re-report", () => {
  // Exactly the window a send opens: the shell has adopted the conversation
  // id the send created, so every report is still filed under the old key.
  assert.equal(
    resolveChatContentState(
      base({
        conversationId: "conv-created-by-this-send",
        hasAcceptedSubmission: true,
        reported: reportedAs("conv-created-by-this-send", {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "non-empty",
    "a stale 'empty' from before the send must not send the user back to the welcome screen"
  );
});

test("a seed only speaks while no panel has", () => {
  assert.equal(
    resolveChatContentState(base({ storedSeed: "non-empty" })),
    "non-empty"
  );
  assert.equal(
    resolveChatContentState(
      base({
        storedSeed: "non-empty",
        reported: reportedAs("conv-1", {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "empty",
    "the panels are the authority once they have read their own transcripts"
  );
});

test("a pending send carries the reports from the conversation it started from", () => {
  // The first send of a new chat: the shell has adopted the id the send just
  // created, the panels have not caught up, and the one that has reloaded
  // reports the still-untouched new conversation as empty. Neither is a reason
  // to put the welcome screen back over a chat the user has just sent in.
  const pendingSubmission = { originConversationId: null };
  assert.equal(
    resolveChatContentState(
      base({
        conversationId: "conv-just-created",
        pendingSubmission,
        reported: {
          ...reportedAs(null, {
            "gpt-5-6-luna": "non-empty",
            "claude-sonnet-5": "non-empty",
          }),
          // The adopted id: one panel still loading, one already reloaded.
          ...reportedAs("conv-just-created", { "claude-sonnet-5": "unknown" }),
        },
      })
    ),
    "non-empty"
  );

  assert.equal(
    resolveChatContentState(
      base({
        conversationId: "conv-just-created",
        pendingSubmission,
        reported: reportedAs(null, {
          "gpt-5-6-luna": "empty",
          "claude-sonnet-5": "empty",
        }),
      })
    ),
    "empty",
    "an empty new chat mid-send stays on the welcome screen rather than blinking through a panel"
  );
});

test("a panel that has spoken about the adopted conversation outranks the carry-over", () => {
  assert.equal(
    resolveChatContentState(
      base({
        conversationId: "conv-just-created",
        pendingSubmission: { originConversationId: null },
        reported: {
          ...reportedAs(null, {
            "gpt-5-6-luna": "empty",
            "claude-sonnet-5": "empty",
          }),
          ...reportedAs("conv-just-created", {
            "gpt-5-6-luna": "non-empty",
            "claude-sonnet-5": "non-empty",
          }),
        },
      })
    ),
    "non-empty"
  );
});

test("with no send pending nothing is carried over between conversations", () => {
  assert.equal(
    resolveChatContentState(
      base({
        conversationId: "conv-2",
        reported: reportedAs(null, {
          "gpt-5-6-luna": "non-empty",
          "claude-sonnet-5": "non-empty",
        }),
      })
    ),
    "unknown",
    "opening another conversation must start from nothing, not from the last one"
  );
});

test("no models selected is not an empty conversation", () => {
  assert.equal(
    resolveChatContentState(base({ selectedModelIds: [] })),
    "unknown",
    "the shells render their choose-a-model copy for this, not the welcome screen"
  );
});

// ---------------------------------------------------------------------------
// The guest's synchronous seed
// ---------------------------------------------------------------------------

const storageOf = (entries) => ({
  keys: () => Object.keys(entries),
  getItem: (key) => (key in entries ? entries[key] : null),
});

const guestState = (entries, conversationId = "guest_1") =>
  readGuestChatContentState(
    conversationId,
    storageOf(entries),
    guestMessageKeysForConversation
  );

test("a stored guest transcript with a user turn reads non-empty", () => {
  assert.equal(
    guestState({
      "guest_messages_guest_1_gpt-5-6-luna": JSON.stringify([
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "hello" },
      ]),
    }),
    "non-empty"
  );
});

test("a transcript belonging to a model that is no longer selected still counts", () => {
  // The seed reads every key of the conversation, not just today's panels.
  assert.equal(
    guestState({
      "guest_messages_guest_1_some-retired-model": JSON.stringify([
        { id: "u1", role: "user", content: "hi" },
      ]),
    }),
    "non-empty"
  );
});

test("the welcome placeholder alone is an empty conversation", () => {
  assert.equal(
    guestState({
      "guest_messages_guest_1_gpt-5-6-luna": JSON.stringify([
        { id: "welcome", role: "assistant", content: "Welcome" },
      ]),
    }),
    "empty"
  );
});

test("another conversation's transcript is not this conversation's", () => {
  assert.equal(
    guestState({
      "guest_messages_guest_2_gpt-5-6-luna": JSON.stringify([
        { id: "u1", role: "user", content: "hi" },
      ]),
    }),
    "empty"
  );
});

test("nothing stored at all is an empty conversation", () => {
  assert.equal(guestState({}), "empty");
});

test("unreadable storage claims nothing", () => {
  assert.equal(
    guestState({ "guest_messages_guest_1_gpt-5-6-luna": "{not json" }),
    "unknown"
  );
  assert.equal(guestState({}, null), "unknown", "no conversation id yet");
  assert.equal(
    readGuestChatContentState("guest_1", null, guestMessageKeysForConversation),
    "unknown",
    "no storage (private mode, blocked cookies)"
  );
});

test("a throwing storage claims nothing rather than guessing empty", () => {
  const hostile = {
    keys: () => ["guest_messages_guest_1_m"],
    getItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(
    readGuestChatContentState("guest_1", hostile, guestMessageKeysForConversation),
    "unknown"
  );
});
