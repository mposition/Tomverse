import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "zod";
import * as z from "zod";
import * as core from "zod/v4/core";

/**
 * The CSP violation this removes is a browser fact, so the browser test is the
 * one that proves it (tests/e2e/csp-eval-free.spec.ts). What is checkable here
 * is the two things that make that test's result trustworthy:
 *
 *   1. the probe really is short-circuited rather than merely caught, and
 *   2. validation answers the same thing with the JIT off.
 *
 * The second matters more than the first. Choosing the interpreted path on
 * purpose is only safe if it is the same path Zod was already falling back to,
 * and "the CSP report went away" would be a poor thing to discover a parser
 * difference through.
 */

test("the instrumentation entry sets the flag the probe reads first", async () => {
  await import("../instrumentation-client.ts");
  assert.equal(core.globalConfig.jitless, true);

  // Not just "an exception was caught": with the flag set, allowsEval reports
  // false without evaluating anything. That is the whole point -- a caught
  // exception still files a CSP report, a skipped call does not.
  assert.equal(core.util.allowsEval.value, false);
});

test("validation answers identically with the JIT disabled", () => {
  const schema = z.object({
    id: z.string().min(1),
    count: z.number().int().nonnegative(),
    tags: z.array(z.string()).max(3),
    nested: z.object({ enabled: z.boolean() }).optional(),
    kind: z.union([z.literal("a"), z.literal("b")]),
  });

  const cases = [
    { id: "x", count: 0, tags: [], kind: "a" },
    { id: "x", count: 2, tags: ["one", "two"], nested: { enabled: true }, kind: "b" },
    // Every shape of failure the schema can produce, because an error's
    // *contents* are what a caller renders.
    { id: "", count: 1, tags: [], kind: "a" },
    { id: "x", count: -1, tags: [], kind: "a" },
    { id: "x", count: 1.5, tags: [], kind: "a" },
    { id: "x", count: 1, tags: ["1", "2", "3", "4"], kind: "a" },
    { id: "x", count: 1, tags: [], kind: "c" },
    { id: "x", count: 1, tags: [], nested: { enabled: "yes" }, kind: "a" },
    {},
    null,
  ];

  const snapshot = (input) => {
    const result = schema.safeParse(input);
    return result.success
      ? { success: true, data: result.data }
      : {
          success: false,
          issues: result.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
          })),
        };
  };

  config({ jitless: false });
  const withJit = cases.map(snapshot);
  config({ jitless: true });
  const withoutJit = cases.map(snapshot);

  assert.deepEqual(withoutJit, withJit);
  // Sanity: the fixtures actually exercise both outcomes.
  assert.ok(withoutJit.some((entry) => entry.success));
  assert.ok(withoutJit.some((entry) => !entry.success));
});
