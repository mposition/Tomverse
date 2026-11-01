import assert from "node:assert/strict";
import test from "node:test";

// Policy 9.1: an experiment assignment exists only under analytics consent.
// Declining (or withdrawing) goes through `disableAnalyticsClient`, so that is
// where the assignment cookie has to go -- at once, not at the next landing
// view, because the visitor was just told analytics is off.

const writes = [];
const storage = () => ({
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
});
globalThis.window = {
  localStorage: storage(),
  sessionStorage: storage(),
  location: { hostname: "tomverse.app" },
  dataLayer: [],
};
globalThis.document = {
  get cookie() {
    return "tv_exp=spring-hero.home-hero-v1.b; _ga=GA1.1.1; theme=dark";
  },
  set cookie(value) {
    writes.push(value);
  },
};

const { disableAnalyticsClient } = await import("../lib/productAnalyticsClient.ts");
const { EXPERIMENT_COOKIE_NAME, EXPERIMENT_HOLD_COOKIE_NAME } = await import("../lib/marketingRoutes.ts");

test("declining analytics deletes the experiment assignment cookie immediately", () => {
  writes.length = 0;
  disableAnalyticsClient();
  assert.ok(
    writes.some(
      (write) =>
        write.startsWith(`${EXPERIMENT_COOKIE_NAME}=;`) && /Max-Age=0/.test(write)
    ),
    `no deletion of ${EXPERIMENT_COOKIE_NAME} among: ${writes.join(" | ")}`
  );
  assert.ok(
    writes.some(
      (write) =>
        write.startsWith(`${EXPERIMENT_HOLD_COOKIE_NAME}=;`) && /Max-Age=0/.test(write)
    ),
    "the short hold cookie goes with the assignment"
  );
  // The existing behaviour is intact: the analytics cookie goes too, and an
  // unrelated cookie is left alone.
  assert.ok(writes.some((write) => write.startsWith("_ga=;")));
  assert.ok(!writes.some((write) => write.startsWith("theme=")));
});
