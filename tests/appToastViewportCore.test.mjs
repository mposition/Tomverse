import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_TOAST_DURATION_MS,
  APP_TOAST_MAX_VISIBLE,
  appToastDurationMs,
  appToastPoliteness,
  appToastRole,
  appendAppToast,
  dismissAppToast,
} from "../lib/appToastViewportCore.ts";

const toast = (id, tone = "info") => ({ id, message: `message ${id}`, tone });

test("consecutive events stack instead of replacing one another", () => {
  let queue = [];
  queue = appendAppToast(queue, toast("a"));
  queue = appendAppToast(queue, toast("b", "error"));
  assert.deepEqual(
    queue.map((item) => item.id),
    ["a", "b"]
  );
});

// A validation sweep can raise several toasts in one tick, and a retry lands
// right after its own failure. An unbounded stack would cover the console.
test("a burst is capped at the visible maximum, newest first out", () => {
  let queue = [];
  for (let index = 0; index < APP_TOAST_MAX_VISIBLE + 3; index += 1) {
    queue = appendAppToast(queue, toast(`t${index}`));
  }
  assert.equal(queue.length, APP_TOAST_MAX_VISIBLE);
  assert.equal(queue.at(-1).id, `t${APP_TOAST_MAX_VISIBLE + 2}`);
  assert.equal(queue.at(0).id, "t3");
});

test("manual dismissal removes only the toast that was closed", () => {
  const queue = [toast("a"), toast("b"), toast("c")];
  assert.deepEqual(
    dismissAppToast(queue, "b").map((item) => item.id),
    ["a", "c"]
  );
});

// An auto-dismiss timer can outlive the toast it was armed for once the queue
// has been trimmed or the operator closed it by hand.
test("dismissing an id that is no longer queued is a no-op", () => {
  const queue = [toast("a")];
  assert.deepEqual(dismissAppToast(queue, "gone"), queue);
});

test("errors are announced assertively, everything else politely", () => {
  assert.equal(appToastRole("error"), "alert");
  assert.equal(appToastPoliteness("error"), "assertive");
  for (const tone of ["success", "info"]) {
    assert.equal(appToastRole(tone), "status");
    assert.equal(appToastPoliteness(tone), "polite");
  }
});

test("errors stay on screen longer than acknowledgements", () => {
  assert.ok(APP_TOAST_DURATION_MS.error > APP_TOAST_DURATION_MS.success);
  assert.equal(appToastDurationMs("error"), APP_TOAST_DURATION_MS.error);
  assert.equal(appToastDurationMs("info"), APP_TOAST_DURATION_MS.info);
  // An unknown tone must still auto-dismiss rather than stick forever.
  assert.equal(appToastDurationMs("mystery"), APP_TOAST_DURATION_MS.info);
});
