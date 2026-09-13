import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A cron runner must not give up on its route before the route may finish.
 *
 * Each Railway cron service runs a `scripts/run-*.mjs` that POSTs to an
 * internal route and aborts the request after a fixed time. The route declares
 * how long it is allowed to run with `export const maxDuration`. When the
 * runner's abort is shorter, a run that is slow but healthy -- inside the
 * route's own budget -- ends with the runner exiting non-zero, and Railway
 * reports the deployment as CRASHED while the work completes on the server.
 *
 * That happened on 2026-09-13. `run-credit-reconciliation.mjs` still aborted at
 * 60s after its route had grown to `maxDuration = 300` to fit the memory
 * extraction dispatch; the staging route took 125s, the platform logged
 * `499 125012ms`, and the service crashed with nothing wrong with it.
 *
 * The two numbers live in different files and nothing tied them together, so
 * the route was changed and the runner was not. This is the tie.
 */

const repoRoot = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

const toNumber = (literal) => Number(literal.replaceAll("_", ""));

/** The abort delay a runner passes to `setTimeout`, resolved to milliseconds. */
const runnerAbortMs = (source) => {
  const call = source.match(
    /setTimeout\(\s*\(\)\s*=>\s*controller\.abort\(\)\s*,\s*([A-Za-z_$][\w$]*|[\d_]+)\s*\)/
  );
  if (!call) return null;
  const argument = call[1];
  if (/^[\d_]+$/.test(argument)) return toNumber(argument);
  const constant = source.match(
    new RegExp(`const\\s+${argument}\\s*=\\s*([\\d_]+)\\s*;`)
  );
  return constant ? toNumber(constant[1]) : null;
};

/** The internal route a runner calls, as a repository path to its handler. */
const runnerRoute = (source) => {
  const path = source.match(/["'](\/api\/internal\/[a-z0-9/_-]+)["']/);
  return path ? `app${path[1]}/route.ts` : null;
};

/** The route's declared `maxDuration`, in milliseconds, or null if it has none. */
const routeMaxDurationMs = (source) => {
  const declared = source.match(/export\s+const\s+maxDuration\s*=\s*([\d_]+)/);
  return declared ? toNumber(declared[1]) * 1000 : null;
};

const runners = readdirSync(join(repoRoot, "scripts"))
  .filter((name) => /^run-.+\.mjs$/.test(name))
  .map((name) => {
    const source = read(`scripts/${name}`);
    const route = runnerRoute(source);
    return {
      name,
      abortMs: runnerAbortMs(source),
      route,
      maxDurationMs:
        route && existsSync(join(repoRoot, route))
          ? routeMaxDurationMs(read(route))
          : null,
    };
  });

/** Runners that both abort on a timer and call a route that declares a limit. */
const bounded = runners.filter(
  (runner) => runner.abortMs !== null && runner.maxDurationMs !== null
);

test("the comparison has something to compare", () => {
  // A parser that stopped matching would make every assertion below vacuous
  // and green. The incident's own pair has to be found, by name.
  const credit = bounded.find(
    (runner) => runner.name === "run-credit-reconciliation.mjs"
  );
  assert.ok(
    credit,
    "run-credit-reconciliation.mjs must be found with both an abort timer and its route's maxDuration"
  );
  assert.equal(
    credit.route,
    "app/api/internal/maintenance/credit-reservations/route.ts"
  );
});

test("no cron runner aborts before its route is allowed to finish", () => {
  const early = bounded.filter((runner) => runner.abortMs < runner.maxDurationMs);
  assert.deepEqual(
    early.map(
      (runner) =>
        `${runner.name} aborts at ${runner.abortMs}ms but ${runner.route} may run for ${runner.maxDurationMs}ms`
    ),
    [],
    "a runner that gives up first turns a slow, healthy run into a crashed deployment"
  );
});

test("credit reconciliation waits past its route's limit, not merely up to it", () => {
  // Equal is a race: the runner's abort and the platform's own limit land at
  // the same instant, and which one the log shows is luck. This runner is the
  // one that crashed, so it keeps a margin over the route rather than a tie.
  const credit = bounded.find(
    (runner) => runner.name === "run-credit-reconciliation.mjs"
  );
  assert.ok(
    credit.abortMs > credit.maxDurationMs,
    `the runner waits ${credit.abortMs}ms and the route may run ${credit.maxDurationMs}ms`
  );
});
