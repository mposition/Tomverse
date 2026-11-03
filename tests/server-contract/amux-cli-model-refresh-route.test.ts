import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The AMUX host's CLI model refresh (owner decision 2026-10-27). It uses the
// CLI monitor's telemetry credential and records only which names a CLI
// offers: no credential, no write; a body the core does not accept, no write.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const SECRET = "s".repeat(40);

let credential: string | null = createHash("sha256").update(SECRET).digest("hex");
const refreshes: unknown[] = [];
let boundaryError: Error | null = null;

mock.module(mod("lib/agentOfficeCliMonitor.ts"), { namedExports: { agentOfficeCliMonitorCredential: () => credential } });
mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: { cliModelRefresh: { operation: "cli_model_refresh" } },
    AmuxDbBoundaryError: class extends Error {},
    withAmuxRouteBudget: async (work: () => Promise<unknown>) => work(),
    withAmuxDbBoundary: async (_boundary: unknown, work: (tx: unknown) => Promise<unknown>) => {
      if (boundaryError) throw boundaryError;
      return work({ fake: "tx" });
    },
  },
});
mock.module(mod("lib/amux/cliModelCatalogStore.ts"), {
  namedExports: {
    recordAmuxCliModelRefresh: async (_tx: unknown, refresh: unknown) => {
      refreshes.push(refresh);
      return { listed: 1, unlisted: 0 };
    },
  },
});
const route = import(mod("app/api/internal/amux/cli-models/route.ts"));

const post = (body: unknown, token: string | null = SECRET) =>
  new Request("https://tomverse.app/api/internal/amux/cli-models", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
const BODY = { cli: "copilot", models: [{ cliModel: "kimi-k3" }] };

test("only the CLI monitor's credential records a refresh, and only a whole valid list", async () => {
  const { POST } = await route;
  refreshes.length = 0;
  assert.equal((await POST(post(BODY, null))).status, 401);
  assert.equal((await POST(post(BODY, "t".repeat(40)))).status, 401);
  credential = null;
  assert.equal((await POST(post(BODY))).status, 401, "a monitor that is off accepts nothing");
  credential = createHash("sha256").update(SECRET).digest("hex");
  assert.deepEqual(refreshes, []);
  for (const bad of [{ cli: "devin", models: [{ cliModel: "x" }] }, { cli: "copilot", models: [] }, { cli: "copilot", models: [{ cliModel: "a:b" }] }]) {
    assert.equal((await POST(post(bad))).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(refreshes, []);
  const answer = await POST(post(BODY));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { cli: "copilot", listed: 1, unlisted: 0 });
  assert.deepEqual(refreshes, [{ cli: "copilot", models: [{ cliModel: "kimi-k3", displayName: null }] }]);
  boundaryError = new Error("down");
  assert.equal((await POST(post(BODY))).status, 503);
  boundaryError = null;
});
