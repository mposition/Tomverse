import assert from "node:assert/strict";
import test from "node:test";
import { readBrowserChatLocation } from "../lib/chatLocationClient.ts";
import { createChatLocationSession } from "../packages/chat-core/src/location.ts";

test("a browser permission decision can take longer than the acquisition timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  let allow;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { geolocation: {
    getCurrentPosition: (success, _error, options) => {
      assert.equal(options.timeout, 10_000); assert.equal(options.maximumAge, 0);
      allow = success;
    },
  } } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  try {
    let settled = false;
    const pending = readBrowserChatLocation().then((value) => { settled = true; return value; });
    t.mock.timers.tick(30_000);
    await Promise.resolve();
    assert.equal(settled, false);
    const timestamp = Date.now();
    allow({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp });
    assert.deepEqual(await pending, { latitude: 1, longitude: 2, accuracy: 3, timestamp });
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
    if (secureDescriptor) Object.defineProperty(globalThis, "isSecureContext", secureDescriptor); else delete globalThis.isSecureContext;
  }
});

test("a per-turn read continues without location if a renewed permission prompt never calls back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  let respond;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { geolocation: {
    getCurrentPosition: (success) => { respond = success; },
  } } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  try {
    const session = createChatLocationSession(readBrowserChatLocation);
    const enable = session.enable("account:a");
    await Promise.resolve();
    const fix = () => ({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: Date.now() });
    respond(fix()); await enable;
    const turn = session.readForTurn("account:a");
    await Promise.resolve();
    t.mock.timers.tick(11_000);
    assert.equal(await turn, null);
    assert.equal(session.getSnapshot().error, "timeout");
    respond(fix()); await Promise.resolve();
    assert.equal(session.isEnabled("account:a"), false);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
    if (secureDescriptor) Object.defineProperty(globalThis, "isSecureContext", secureDescriptor); else delete globalThis.isSecureContext;
  }
});
