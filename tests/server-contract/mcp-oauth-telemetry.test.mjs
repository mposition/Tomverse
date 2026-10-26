import assert from "node:assert/strict";
import { mock, test } from "node:test";
const configs = [];
mock.module("@sentry/nextjs", { namedExports: { init: config => configs.push(config) } });
await import("../../sentry.server.config.ts");
await import("../../sentry.edge.config.ts");
test("server and edge discard OAuth callback errors and transactions including their child spans", () => {
  assert.equal(configs.length, 2);
  for (const config of configs) {
    for (const event of [
      { request: { url: "https://tomverse.app/api/mcp/oauth/callback?code=synthetic-secret&state=synthetic-state" } },
      { request: { url: "/api/mcp/oauth/callback?code=synthetic-secret" } },
      { transaction: "GET /api/mcp/oauth/callback" },
    ]) {
      assert.equal(config.beforeSend(event, {}), null);
      assert.equal(config.beforeSendTransaction(event, {}), null);
    }
    const normal = { request: { url: "https://tomverse.app/api/mcp/connections" } };
    assert.equal(config.beforeSend(normal, {}), normal); assert.equal(config.beforeSendTransaction(normal, {}), normal);
    const unrelated = { request: { url: "https://tomverse.app/plugins?next=/api/mcp/oauth/callback" } };
    assert.equal(config.beforeSendTransaction(unrelated, {}), unrelated);
  }
});
