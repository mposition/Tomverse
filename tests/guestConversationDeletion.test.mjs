import assert from "node:assert/strict";
import test from "node:test";

import { removeGuestConversationStorage } from "../lib/guestImport.ts";

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
