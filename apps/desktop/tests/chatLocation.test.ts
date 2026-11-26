import assert from "node:assert/strict";
import test from "node:test";
import { createChatLocationSession, type ChatLocation } from "@tomverse/chat-core";
import { readDesktopLocation } from "../src/renderer/chat-location-read";

const fix = (n: number): ChatLocation => ({ latitude: -27.46551 + n / 1_000, longitude: 153.025879, accuracy: 23, timestamp: Date.now() });

function desktopSession(positions: Array<ChatLocation | Error>, granted = true) {
  const reads: number[] = [];
  const arms: number[] = [];
  const session = createChatLocationSession(() => readDesktopLocation(
    async () => { arms.push(Date.now()); return granted; },
    async () => {
      reads.push(Date.now());
      const next = positions.shift();
      if (!next) throw new Error("unavailable");
      if (next instanceof Error) throw next;
      return next;
    },
  ));
  session.setIdentity("account-1");
  return { session, reads, arms };
}

test("Turning Current location on reads once and each later message reads a fresh position", async () => {
  const { session, reads, arms } = desktopSession([fix(0), fix(1), fix(2)]);
  assert.equal(session.isEnabled("account-1"), false);
  await session.enable("account-1");
  assert.equal(session.isEnabled("account-1"), true);
  assert.equal(reads.length, 1);
  const first = await session.readForTurn("account-1");
  const second = await session.readForTurn("account-1");
  assert.equal(reads.length, 3, "a message does not reuse the previous position");
  assert.equal(arms.length, 3, "the host is asked before every read");
  assert.ok(first && second && first !== second);
  assert.ok(session.canShare(first, "account-1"));
});

test("Nothing is read for a message while the switch is off or after it is turned off", async () => {
  const { session, reads } = desktopSession([fix(0), fix(1)]);
  assert.equal(await session.readForTurn("account-1"), null);
  await session.enable("account-1");
  session.disable();
  assert.equal(await session.readForTurn("account-1"), null);
  assert.equal(reads.length, 1, "only the read that turned it on");
  assert.equal(session.isEnabled("account-1"), false);
});

test("A denied or failed read switches off, names the reason, and the message continues without a location", async () => {
  const { session } = desktopSession([new Error("denied")]);
  await session.enable("account-1");
  assert.deepEqual(session.getSnapshot(), { enabled: false, pending: false, error: "denied" });
  assert.equal(await session.readForTurn("account-1"), null);

  const failing = desktopSession([fix(0), new Error("timeout")]);
  await failing.session.enable("account-1");
  assert.equal(await failing.session.readForTurn("account-1"), null, "the send is not blocked");
  assert.deepEqual(failing.session.getSnapshot(), { enabled: false, pending: false, error: "timeout" });
});

test("Without a host grant no position is read and the read counts as unavailable", async () => {
  const { session, reads } = desktopSession([fix(0)], false);
  await session.enable("account-1");
  assert.equal(reads.length, 0);
  assert.deepEqual(session.getSnapshot(), { enabled: false, pending: false, error: "unavailable" });
});

test("The position sent to the provider is rounded and keeps a coarse accuracy", async () => {
  const { session } = desktopSession([fix(0), fix(0)]);
  await session.enable("account-1");
  const sent = await session.readForTurn("account-1");
  assert.ok(sent);
  assert.equal(sent.latitude, -27.466);
  assert.equal(sent.longitude, 153.026);
  assert.equal(sent.accuracy, 150);
});

test("Changing the account switches the setting off", async () => {
  const { session } = desktopSession([fix(0)]);
  await session.enable("account-1");
  session.setIdentity("account-2");
  assert.equal(session.isEnabled("account-2"), false);
  assert.equal(session.isEnabled("account-1"), false);
});
