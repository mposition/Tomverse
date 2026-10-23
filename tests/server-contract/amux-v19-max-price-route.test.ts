import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../../app/api/internal/amux/v19/analysis-price/route.ts";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "../../lib/amux/ideaSessionMaxLauncherAuth.ts";

const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const endpoint = "https://test.invalid/api/internal/amux/v19/analysis-price";
const names = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V19_SESSION_MAX_PRICE_READ"] as const;

async function withEnv(values: Record<string, string>, fn: () => Promise<void>) {
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    await fn();
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

function request(url = endpoint): Request {
  return new Request(url, { headers: { authorization: `Bearer ${secret}`,
    "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID } });
}

test("price discovery requires the fixed Max credential and its own switch", async () => {
  await withEnv({}, async () => {
    assert.equal((await GET(request())).status, 401);
  });
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
    async () => {
      const response = await GET(request());
      assert.equal(response.status, 409);
      assert.equal((await response.json()).reason,
        "session_max_price_read_disabled");
    });
});

test("enabled price read rejects missing and extra query keys before DB access", async () => {
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_V19_SESSION_MAX_PRICE_READ: "enabled" }, async () => {
    assert.equal((await GET(request())).status, 400);
    assert.equal((await GET(request(endpoint +
      "?reservationId=9942fb52-4b78-4af6-931a-9eec8f66d394&ideaId=53d6918e-b05d-4531-a1ab-704dd756cc40&extra=1"))).status, 400);
  });
});
