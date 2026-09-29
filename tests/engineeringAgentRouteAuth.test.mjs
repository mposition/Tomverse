import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ENGINEERING_AGENT_ROUTE_SECRET_ENV,
  isEngineeringAgentRouteAuthorized,
} from "../lib/engineeringAgentRouteAuth.ts";

// The engineering agent's internal routes (docs/policy/engineering-agent.md
// §11): each service's own secret, 32 characters or more, compared as digests,
// and the two services never sharing one.

const RUNNER = "r".repeat(40);
const PUBLISHER = "p".repeat(40);
const env = {
  [ENGINEERING_AGENT_ROUTE_SECRET_ENV.runner]: RUNNER,
  [ENGINEERING_AGENT_ROUTE_SECRET_ENV.publisher]: PUBLISHER,
};
const call = (authorization) =>
  new Request("https://tomverse.test/api/internal/engineering-agent/status", {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });

test("each service passes only its own routes", () => {
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${PUBLISHER}`), "publisher", env), true);
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${RUNNER}`), "runner", env), true);
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${RUNNER}`), "publisher", env), false, "the runner cannot publish");
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${PUBLISHER}`), "runner", env), false);
});

test("a missing, malformed or wrong credential passes nothing", () => {
  for (const header of [undefined, "", "Bearer ", PUBLISHER, `bearer ${PUBLISHER}`, `Bearer ${PUBLISHER}x`, `Basic ${PUBLISHER}`]) {
    assert.equal(isEngineeringAgentRouteAuthorized(call(header), "publisher", env), false, String(header));
  }
});

test("a short secret, or one both services share, authenticates neither", () => {
  const short = { ...env, [ENGINEERING_AGENT_ROUTE_SECRET_ENV.publisher]: "p".repeat(31) };
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${"p".repeat(31)}`), "publisher", short), false);
  const shared = { ...env, [ENGINEERING_AGENT_ROUTE_SECRET_ENV.runner]: PUBLISHER };
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${PUBLISHER}`), "publisher", shared), false);
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${PUBLISHER}`), "runner", shared), false);
  assert.equal(isEngineeringAgentRouteAuthorized(call(`Bearer ${PUBLISHER}`), "publisher", {}), false, "no secret, no route");
});

const routeFiles = () => {
  const root = "app/api/internal/engineering-agent";
  const files = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const next = join(at, name);
      if (statSync(next).isDirectory()) walk(next);
      else if (name === "route.ts") files.push(next);
    }
  };
  walk(root);
  return files;
};

test("every engineering route checks its credential before it reads anything, answers POST only, and never caches", () => {
  const files = routeFiles();
  assert.ok(files.length >= 3, "the routes were found");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /export const dynamic = "force-dynamic";/, file);
    assert.doesNotMatch(source, /export async function (GET|PUT|PATCH|DELETE)\b/, `${file} answers POST only`);
    const post = source.slice(source.indexOf("export async function POST"));
    const auth = post.search(/isEngineeringAgentRouteAuthorized\(/);
    const read = post.search(/readLimitedJson\(/);
    assert.ok(auth > 0 && read > auth, `${file} authenticates before reading the body`);
    assert.doesNotMatch(source, /new Response\(|Response\.json\(/, `${file} answers through the no-store helper`);
  }
});
