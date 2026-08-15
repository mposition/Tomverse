import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  consumePublicReadBudget,
  PUBLIC_READ_RATE_LIMIT,
  resetPublicReadRateLimitForTests,
} from "../lib/publicReadRateLimit.ts";

/**
 * SEC-012's origin-side ceiling, continued.
 *
 * `tests/publicSnapshotCache.test.ts` already owns the limiter's basic
 * behaviour -- the allowance, per-caller and per-scope separation, and that an
 * overflow fails open rather than refusing everyone. Those are not repeated
 * here.
 *
 * What is here is everything that needs the clock moved, which is why it did
 * not exist before: a suite that can only advance time by however long it takes
 * to run cannot reach a window's end, and therefore could not tell an eviction
 * of expired entries apart from clearing the map.
 */

const { requestsPerWindow, maxTrackedClients, windowMs } = PUBLIC_READ_RATE_LIMIT;

/**
 * A request whose anonymous key is stable and distinct per `id`.
 *
 * `getAnonymousClientKey` prefers the trusted-proxy IP and falls back to a
 * user-agent/accept-language fingerprint. No trusted proxy is configured here,
 * so the fingerprint is what varies -- which is also the coarse path the
 * limiter's headroom exists for.
 */
const clientRequest = (id) =>
  new Request("https://tomverse.app/api/models/catalog", {
    headers: { "user-agent": `client-${id}`, "accept-language": `en-${id}` },
  });

beforeEach(resetPublicReadRateLimitForTests);



test("a limited caller keeps its limit when the map fills with expired entries", () => {
  // The regression. Ordinary traffic is one-shot visitors whose entries stay
  // in the map after their window ends, so the cap is reached by dead weight.
  // Clearing everything at that moment released whoever was mid-flood, which
  // is a limiter that resets on a schedule other people set.
  const start = 1_000_000;
  // One short of the cap, so the flooder below opens its window without
  // tripping the capacity path itself -- otherwise the eviction happens
  // before there is anything live to protect, and the test proves nothing.
  for (let visitor = 0; visitor < maxTrackedClients - 1; visitor += 1) {
    consumePublicReadBudget(
      clientRequest(`visitor-${visitor}`),
      "app-settings",
      start
    );
  }

  // Long enough that every visitor above is expired, and the flooder's own
  // window opens after them.
  const later = start + windowMs + 1_000;
  const flooder = clientRequest("flooder");
  for (let attempt = 0; attempt < requestsPerWindow + 1; attempt += 1) {
    consumePublicReadBudget(flooder, "model-catalog", later);
  }
  assert.equal(
    consumePublicReadBudget(flooder, "model-catalog", later).allowed,
    false
  );

  // A fresh caller arriving at the cap is what triggers the eviction.
  consumePublicReadBudget(clientRequest("newcomer"), "app-settings", later);

  assert.equal(
    consumePublicReadBudget(flooder, "model-catalog", later).allowed,
    false,
    "the flooder's live window must survive an eviction it did not cause"
  );
});

test("a genuine overflow of live windows still fails open", () => {
  // The documented behaviour, kept: when there is nothing expired to drop,
  // the map is cleared and callers get a fresh allowance rather than being
  // refused by a limiter that has run out of memory.
  const now = 2_000_000;
  const flooder = clientRequest("flooder");
  for (let attempt = 0; attempt < requestsPerWindow + 1; attempt += 1) {
    consumePublicReadBudget(flooder, "model-catalog", now);
  }
  assert.equal(
    consumePublicReadBudget(flooder, "model-catalog", now).allowed,
    false
  );

  for (let visitor = 0; visitor <= maxTrackedClients; visitor += 1) {
    consumePublicReadBudget(clientRequest(`live-${visitor}`), "app-settings", now);
  }

  assert.equal(
    consumePublicReadBudget(flooder, "model-catalog", now).allowed,
    true,
    "with no expired entries to reclaim the limiter fails open, by design"
  );
});

test("a window that has elapsed grants a fresh allowance", () => {
  const start = 3_000_000;
  const request = clientRequest("returning");
  for (let attempt = 0; attempt < requestsPerWindow + 1; attempt += 1) {
    consumePublicReadBudget(request, "model-catalog", start);
  }
  assert.equal(
    consumePublicReadBudget(request, "model-catalog", start).allowed,
    false
  );
  assert.equal(
    consumePublicReadBudget(request, "model-catalog", start + windowMs).allowed,
    true,
    "the window is inclusive of its own end -- resetAt <= now reopens it"
  );
});

