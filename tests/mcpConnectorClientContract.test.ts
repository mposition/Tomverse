import assert from "node:assert/strict";
import test from "node:test";
import { readPluginInventory } from "@/lib/mcpConnectorClientContract";

test("plugin inventory consumes unauthorized and failed response bodies before returning", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 503]) {
      const response = new Response("synthetic error", { status });
      globalThis.fetch = async () => response;
      if (status === 401) assert.equal(await readPluginInventory(), null);
      else await assert.rejects(() => readPluginInventory(), { message: "inventory_failed" });
      assert.equal(response.bodyUsed, true);
    }
    const inventory = { enabled: false, servers: [], connections: [], invocations: [] };
    const response = Response.json(inventory);
    globalThis.fetch = async () => response;
    assert.deepEqual(await readPluginInventory(), inventory);
    assert.equal(response.bodyUsed, true);
  } finally { globalThis.fetch = originalFetch; }
});
