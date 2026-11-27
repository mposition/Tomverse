import assert from "node:assert/strict";
import test from "node:test";

import { buildGuestImportPayload, removeGuestConversationStorage } from "../lib/guestImport.ts";
import {
  beginReplacement,
  getSupersededIds,
  resetSupersededForTests,
  restoreGuestSuperseded,
} from "../lib/chatSupersededTurns.ts";

class FakeStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    this.#values.set(normalizedKey, normalizedValue);
    Object.defineProperty(this, normalizedKey, {
      configurable: true,
      enumerable: true,
      value: normalizedValue,
      writable: true,
    });
  }

  removeItem(key) {
    const normalizedKey = String(key);
    this.#values.delete(normalizedKey);
    delete this[normalizedKey];
  }
}

const withGuestStorage = (entries, callback) => {
  const previousWindow = globalThis.window;
  const storage = new FakeStorage();
  for (const [key, value] of Object.entries(entries)) {
    storage.setItem(key, value);
  }
  globalThis.window = { localStorage: storage };

  try {
    callback(storage);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
};

test("deleting the last Chat conversation removes only its legacy and per-model transcripts", () => {
  withGuestStorage(
    {
      "guest_messages_last-chat": "legacy-chat",
      "guest_messages_last-chat_active-model": "active-chat",
      "guest_messages_last-chat_hidden-old-model": "hidden-chat",
      "guest_messages_last-chat-archive": "prefix-collision-legacy",
      "guest_messages_last-chat-archive_model": "prefix-collision-model",
      "guest_messages_last-review": "legacy-review",
      "guest_messages_last-review_model": "active-review",
      guest_conversations_chat_v1: "chat-index",
      guest_conversations_review_v1: "review-index",
      "next-auth.session-token": "auth-session",
    },
    (storage) => {
      removeGuestConversationStorage("last-chat");

      assert.equal(storage.getItem("guest_messages_last-chat"), null);
      assert.equal(storage.getItem("guest_messages_last-chat_active-model"), null);
      assert.equal(storage.getItem("guest_messages_last-chat_hidden-old-model"), null);

      assert.equal(storage.getItem("guest_messages_last-chat-archive"), "prefix-collision-legacy");
      assert.equal(storage.getItem("guest_messages_last-chat-archive_model"), "prefix-collision-model");
      assert.equal(storage.getItem("guest_messages_last-review"), "legacy-review");
      assert.equal(storage.getItem("guest_messages_last-review_model"), "active-review");
      assert.equal(storage.getItem("guest_conversations_chat_v1"), "chat-index");
      assert.equal(storage.getItem("guest_conversations_review_v1"), "review-index");
      assert.equal(storage.getItem("next-auth.session-token"), "auth-session");
    }
  );
});

test("deleting the last Review conversation preserves Chat and unrelated storage", () => {
  withGuestStorage(
    {
      "guest_messages_last-review": "legacy-review",
      "guest_messages_last-review_active-model": "active-review",
      "guest_messages_last-review_hidden-old-model": "hidden-review",
      "guest_messages_last-chat": "legacy-chat",
      "guest_messages_last-chat_model": "active-chat",
      tomverse_guest_chat_active_v1: "last-chat",
      tomverse_guest_review_active_v1: "last-review",
      unrelated_setting: "keep-me",
    },
    (storage) => {
      removeGuestConversationStorage("last-review");

      assert.equal(storage.getItem("guest_messages_last-review"), null);
      assert.equal(storage.getItem("guest_messages_last-review_active-model"), null);
      assert.equal(storage.getItem("guest_messages_last-review_hidden-old-model"), null);

      assert.equal(storage.getItem("guest_messages_last-chat"), "legacy-chat");
      assert.equal(storage.getItem("guest_messages_last-chat_model"), "active-chat");
      assert.equal(storage.getItem("tomverse_guest_chat_active_v1"), "last-chat");
      assert.equal(storage.getItem("tomverse_guest_review_active_v1"), "last-review");
      assert.equal(storage.getItem("unrelated_setting"), "keep-me");
    }
  );
});

test("a guest's replaced-turn note survives a reload, leaves with its conversation, and is not imported", () => {
  withGuestStorage(
    {
      guest_conversations: JSON.stringify([{ id: "g1", title: "Guest", selectedModels: ["m1"], createdAt: "2026-11-27T00:00:00.000Z" }]),
      "guest_messages_g1_m1": JSON.stringify([
        { id: "u1", role: "user", content: "first question", createdAt: "2026-11-27T00:00:01.000Z" },
        { id: "a1", role: "assistant", content: "first answer", createdAt: "2026-11-27T00:00:02.000Z" },
        { id: "u2", role: "user", content: "asked again", createdAt: "2026-11-27T00:00:03.000Z" },
        { id: "a2", role: "assistant", content: "new answer", createdAt: "2026-11-27T00:00:04.000Z" },
      ]),
      "guest_superseded_g1-archive": JSON.stringify(["other"]),
    },
    (storage) => {
      resetSupersededForTests();
      // A guest regenerates: the note is kept beside the transcript, outside the transcript keys.
      beginReplacement("g1", ["u1", "a1"]).complete("normal", { saved: false });
      assert.deepEqual(JSON.parse(storage.getItem("guest_superseded_g1")).sort(), ["a1", "u1"]);
      assert.ok(Object.keys(storage).every((key) => !key.startsWith("guest_messages_g1_") || key === "guest_messages_g1_m1"));

      // A reload forgets the page's memory; loading the guest conversation brings the note back.
      resetSupersededForTests();
      assert.equal(getSupersededIds("g1").size, 0);
      restoreGuestSuperseded("g1");
      assert.deepEqual([...getSupersededIds("g1")].sort(), ["a1", "u1"]);

      // Signing in imports only the turns that stand.
      const payload = buildGuestImportPayload("g1");
      assert.deepEqual(payload.messages.map((message) => message.content), ["asked again", "new answer"]);

      // Deleting the conversation removes its note, and only its note.
      removeGuestConversationStorage("g1");
      assert.equal(storage.getItem("guest_superseded_g1"), null);
      assert.equal(storage.getItem("guest_superseded_g1-archive"), JSON.stringify(["other"]));
      resetSupersededForTests();
    }
  );
});

test("a signed-in conversation's replacement is never written to the browser", () => {
  withGuestStorage({}, (storage) => {
    resetSupersededForTests();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      beginReplacement("s1", ["u1", "a1"], true).complete("normal", { saved: true });
      assert.deepEqual([...getSupersededIds("s1")].sort(), ["a1", "u1"]);
      assert.equal(storage.length, 0);
    } finally {
      globalThis.fetch = previousFetch;
      resetSupersededForTests();
    }
  });
});
