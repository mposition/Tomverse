import assert from "node:assert/strict";
import test from "node:test";

import {
  activeChatIdentityIs,
  adoptActiveChatIdentity,
  chatIdentityCallbackIsCurrent,
} from "../lib/chatIdentityEpoch.ts";

test("SSR identity adoption is inert across sequential and concurrent requests", async () => {
  assert.equal(typeof globalThis.window, "undefined");

  assert.deepEqual(adoptActiveChatIdentity("account:ssr-a"), {
    identityKey: null,
    epoch: 0,
  });
  assert.deepEqual(
    await Promise.all([
      Promise.resolve().then(() => adoptActiveChatIdentity("account:ssr-a")),
      Promise.resolve().then(() => adoptActiveChatIdentity("account:ssr-b")),
    ]),
    [
      { identityKey: null, epoch: 0 },
      { identityKey: null, epoch: 0 },
    ]
  );
  assert.equal(activeChatIdentityIs("account:ssr-a", 1), false);

  globalThis.window = {};
  try {
    const browserA = adoptActiveChatIdentity("account:browser-a");
    assert.equal(browserA.epoch, 1, "SSR calls must not consume a browser epoch");
    assert.equal(activeChatIdentityIs("account:browser-a", browserA.epoch), true);
  } finally {
    delete globalThis.window;
  }
});

test("an unresolved submit fence cannot authorize an old identity callback", () => {
  globalThis.window = {};
  try {
    const browserA = adoptActiveChatIdentity("account:callback-a");
    assert.equal(chatIdentityCallbackIsCurrent({
      originIdentityKey: "account:callback-a",
      originIdentityEpoch: browserA.epoch,
      currentNamespaceKey: "account:callback-a",
      submitFence: { identityKey: null, epoch: browserA.epoch },
    }), false);
    assert.equal(chatIdentityCallbackIsCurrent({
      originIdentityKey: "account:callback-a",
      originIdentityEpoch: browserA.epoch,
      currentNamespaceKey: "account:callback-a",
      submitFence: browserA,
    }), true);
  } finally {
    delete globalThis.window;
  }
});
