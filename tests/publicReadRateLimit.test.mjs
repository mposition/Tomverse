import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  consumePublicReadBudget,
  PUBLIC_READ_RATE_LIMIT,
  resetPublicReadRateLimitForTests,
} from "../lib/publicReadRateLimit.ts";

/**
 * SEC-012's origin-side ceiling for the unauthenticated read endpoints had no
 * tests of its own, which is how the eviction below went unnoticed: nothing
 * exercised what happens at the cap.
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

test("a caller is allowed up to the window's request count and refused after", () => {
  const request = clientRequest("steady");
  for (let attempt = 1; attempt <= requestsPerWindow; attempt += 1) {
    assert.equal(
      consumePublicReadBudget(request, "model-catalog").allowed,
      true,
      `request ${attempt} should be allowed`
    );
  }
  const refused = consumePublicReadBudget(request, "model-catalog");
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter >= 1, "a refusal must name a wait");
});

test("the scope is part of the key, so one endpoint cannot exhaust another", () => {
  const request = clientRequest("two-scopes");
  for (let attempt = 0; attempt < requestsPerWindow + 1; attempt += 1) {
    consumePublicReadBudget(request, "model-catalog");
  }
  assert.equal(
    consumePublicReadBudget(request, "model-catalog").allowed,
    false
  );
  assert.equal(consumePublicReadBudget(request, "app-settings").allowed, true);
});

test("callers do not share an allowance", () => {
  const first = clientRequest("a");
  for (let attempt = 0; attempt < requestsPerWindow + 1; attempt += 1) {
    consumePublicReadBudget(first, "model-catalog");
  }
  assert.equal(consumePublicReadBudget(first, "model-catalog").allowed, false);
  assert.equal(
    consumePublicReadBudget(clientRequest("b"), "model-catalog").allowed,
    true
  );
});

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

test("the map never grows past its cap", () => {
  for (let visitor = 0; visitor < maxTrackedClients * 2; visitor += 1) {
    consumePublicReadBudget(clientRequest(`visitor-${visitor}`), "app-settings");
  }
  // Nothing exposes the size directly, so this asserts the property that
  // matters instead: the limiter still answers, and still limits.
  const request = clientRequest("after-overflow");
  for (let attempt = 0; attempt < requestsPerWindow; attempt += 1) {
    assert.equal(
      consumePublicReadBudget(request, "model-catalog").allowed,
      true
    );
  }
  assert.equal(
    consumePublicReadBudget(request, "model-catalog").allowed,
    false
  );
});
