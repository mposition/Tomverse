import assert from "node:assert/strict";
import test from "node:test";
import {
  isNextNoFallbackError,
  isNextNoFallbackSentryEvent,
} from "../lib/operationalMonitoringCore.ts";

test("recognizes Next.js NoFallbackError after instrumentation processing", () => {
  assert.equal(
    isNextNoFallbackError(new Error("Internal: NoFallbackError")),
    true
  );
  assert.equal(
    isNextNoFallbackError({ message: "Internal: NoFallbackError" }),
    true
  );
  assert.equal(
    isNextNoFallbackError({ cause: { name: "NoFallbackError" } }),
    true
  );
});

test("recognizes NoFallbackError in a Sentry event", () => {
  assert.equal(
    isNextNoFallbackSentryEvent({
      exception: {
        values: [{ type: "Error", value: "Internal: NoFallbackError" }],
      },
    }),
    true
  );
});

test("does not suppress real application failures", () => {
  assert.equal(isNextNoFallbackError(new Error("Provider fallback failed")), false);
  assert.equal(
    isNextNoFallbackSentryEvent({
      exception: {
        values: [{ type: "NoFallbackAvailable", value: "Provider failed" }],
      },
    }),
    false
  );
});
