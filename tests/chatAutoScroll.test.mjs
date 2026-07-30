import assert from "node:assert/strict";
import test from "node:test";
import {
  getDistanceFromBottom,
  isNearBottom,
  nextModeForUserScroll,
  NEAR_BOTTOM_THRESHOLD_PX,
} from "../lib/chatAutoScroll.ts";

const metrics = (scrollTop, scrollHeight, clientHeight) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

test("getDistanceFromBottom measures the gap between viewport bottom and content bottom", () => {
  assert.equal(getDistanceFromBottom(metrics(900, 1000, 100)), 0);
  assert.equal(getDistanceFromBottom(metrics(500, 1000, 100)), 400);
  assert.equal(getDistanceFromBottom(metrics(0, 500, 500)), 0);
});

test("getDistanceFromBottom never goes negative, even with rounding overshoot", () => {
  // Sub-pixel scrollTop values can put scrollTop + clientHeight fractionally
  // past scrollHeight; that must read as "at the bottom", not a negative gap.
  assert.equal(getDistanceFromBottom(metrics(900.4, 1000, 100)), 0);
});

test("isNearBottom uses the shared threshold by default", () => {
  assert.equal(isNearBottom(metrics(1000 - NEAR_BOTTOM_THRESHOLD_PX, 1000, 0)), true);
  assert.equal(isNearBottom(metrics(1000 - NEAR_BOTTOM_THRESHOLD_PX - 1, 1000, 0)), false);
});

test("isNearBottom respects a custom threshold", () => {
  assert.equal(isNearBottom(metrics(800, 1000, 100), 150), true);
  assert.equal(isNearBottom(metrics(700, 1000, 100), 150), false);
});

test("nextModeForUserScroll resumes following once the user scrolls back near the bottom", () => {
  assert.equal(nextModeForUserScroll(metrics(950, 1000, 50)), "following");
});

test("nextModeForUserScroll pauses once the user scrolls away from the bottom", () => {
  assert.equal(nextModeForUserScroll(metrics(200, 1000, 50)), "paused");
});

test("nextModeForUserScroll is a pure function of the current position, not history", () => {
  // No fixed "how long ago did the user scroll" concept exists in this
  // module at all -- two calls with the same metrics always agree,
  // regardless of how much real time passed between them.
  const farFromBottom = metrics(0, 5000, 500);
  assert.equal(nextModeForUserScroll(farFromBottom), "paused");
  assert.equal(nextModeForUserScroll(farFromBottom), "paused");
});
