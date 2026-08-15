import assert from "node:assert/strict";
import test from "node:test";
import {
  auditImageExecutorBudget,
  IMAGE_EXECUTOR_ROUTES,
  readDeclaredMaxDuration,
} from "../scripts/check-image-executor-budget-core.mjs";

const MINUTE = 60_000;

const healthyRoute = (overrides = {}) => ({
  file: "app/api/images/generations/route.ts",
  declaredSeconds: 968,
  drivesExecutor: true,
  ...overrides,
});

const audit = (overrides = {}) =>
  auditImageExecutorBudget({
    attemptWorstCaseMs: 8 * MINUTE,
    staleAfterMs: 12 * MINUTE,
    requiredSeconds: 968,
    routes: [healthyRoute()],
    ...overrides,
  });

test("the shipped deadlines and routes pass", () => {
  assert.deepEqual(audit().failures, []);
  assert.equal(IMAGE_EXECUTOR_ROUTES.length, 2);
});

test("a stale threshold at or below the worst attempt is refunding live work", () => {
  for (const staleAfterMs of [8 * MINUTE, 7 * MINUTE, 0]) {
    const { failures } = audit({ staleAfterMs });
    assert.equal(failures.length, 1, `stale=${staleAfterMs}`);
    assert.match(failures[0], /must exceed/);
  }
  // One millisecond of margin is enough for the arithmetic; the comfortable
  // margin is a judgement the constant carries, not something to assert here.
  assert.deepEqual(audit({ staleAfterMs: 8 * MINUTE + 1 }).failures, []);
});

test("a route that drives the executor must state a budget", () => {
  const { failures } = audit({
    routes: [healthyRoute({ declaredSeconds: null })],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /declares no maxDuration/);
});

test("a budget below what the executor needs is reported with both numbers", () => {
  const { failures } = audit({
    routes: [healthyRoute({ declaredSeconds: 60 })],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /maxDuration = 60/);
  assert.match(failures[0], /968s/);
  // Equal is fine: the requirement is "at least".
  assert.deepEqual(
    audit({ routes: [healthyRoute({ declaredSeconds: 968 })] }).failures,
    []
  );
});

test("a listed route that stopped driving the executor fails rather than passing", () => {
  // The failure mode a list like this always has: the code moves on, the entry
  // stays, and the check quietly verifies nothing.
  const { failures } = audit({
    routes: [healthyRoute({ drivesExecutor: false })],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no longer drives/);
});

test("every route is judged, not just the first that fails", () => {
  const { failures } = audit({
    routes: [
      healthyRoute({ declaredSeconds: null }),
      healthyRoute({ file: "b/route.ts", declaredSeconds: 10 }),
    ],
  });
  assert.equal(failures.length, 2);
});

test("maxDuration is read only as its own top-level declaration", () => {
  assert.equal(
    readDeclaredMaxDuration("export const maxDuration = 968;\n"),
    968
  );
  assert.equal(
    readDeclaredMaxDuration('export const dynamic = "force-dynamic";\n'),
    null
  );
  // Indented, commented out, or spelled as anything else is not the route
  // segment config Next reads, so it must not satisfy the check either.
  for (const source of [
    "  export const maxDuration = 968;\n",
    "// export const maxDuration = 968;\n",
    "const maxDuration = 968;\n",
    "export let maxDuration = 968;\n",
    'export const maxDuration = "968";\n',
  ]) {
    assert.equal(readDeclaredMaxDuration(source), null, source.trim());
  }
});
