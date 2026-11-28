// Contract: the owner's share-link routes (docs/policy/generated-artifacts.md section 19).
//
//   * signed-out callers are refused before anything is read;
//   * the switch and the plan reach the decision, and a refusal names its code;
//   * the link is `/share/a/<token>` on the public origin;
//   * a link is shown (so it can be stopped) even while sharing is off;
//   * a stopped link is only the owner's to stop.
//
// The service is replaced; it has its own database test.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "artifact-share-owner-contract-2026";
process.env.PUBLIC_APP_URL = "https://tomverse.app";

const SHARE = { id: "share_1", token: "T".repeat(32), createdAt: "2026-11-28T00:00:00.000Z", expiresAt: "2026-12-28T00:00:00.000Z" };

const world = {
  session: { user: { id: "user_1" } } as unknown,
  enabled: true,
  allowSharing: true,
  gates: [] as unknown[],
  prepared: { ok: true, prepared: { sourceKey: "artifact:art_1" } } as unknown,
  published: { share: SHARE, created: true } as unknown,
  found: null as unknown,
  revoked: [] as Array<[string, string]>,
  rateLimited: false,
};
const reset = () => {
  world.session = { user: { id: "user_1" } };
  world.enabled = true;
  world.allowSharing = true;
  world.gates = [];
  world.prepared = { ok: true, prepared: { sourceKey: "artifact:art_1" } };
  world.published = { share: SHARE, created: true };
  world.found = null;
  world.revoked = [];
  world.rateLimited = false;
};

let installed = false;
const load = async () => {
  if (!installed) {
    installed = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown> & {
      ApiSecurityError: new (status: number, code: string, message: string) => Error;
    };
    mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session: world.session }) } });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => {
          if (world.rateLimited) throw new realApiSecurity.ApiSecurityError(429, "RATE_LIMITED", "Too many requests");
        },
      },
    });
    mock.module(mod("lib/artifactShareSettings.ts"), {
      namedExports: { isArtifactSharingEnabled: async () => world.enabled, isArtifactSharingSwitchOn: async () => world.enabled, setArtifactSharingEnabled: async () => {} },
    });
    mock.module(mod("lib/billingEntitlements.ts"), { namedExports: { getUserBillingPlan: async () => ({ allowSharing: world.allowSharing }) } });
    mock.module(mod("lib/artifactShareService.ts"), {
      namedExports: {
        prepareArtifactShare: async (_userId: string, _source: unknown, gates: unknown) => {
          world.gates.push(gates);
          return world.prepared;
        },
        publishArtifactShare: async () => world.published,
        findArtifactShare: async () => world.found,
        revokeArtifactShare: async (userId: string, shareId: string) => {
          world.revoked.push([userId, shareId]);
          return userId === "user_1" && shareId === "share_1";
        },
      },
    });
  }
  return {
    collection: await import(mod("app/api/artifact-shares/route.ts")),
    item: await import(mod("app/api/artifact-shares/[shareId]/route.ts")),
  };
};

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/artifact-shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ARTIFACT = { source: { kind: "artifact", artifactId: "art_1" } };

test("signed out is refused before anything is read", async () => {
  reset();
  world.session = null;
  const { collection, item } = await load();
  assert.equal((await collection.POST(post(ARTIFACT))).status, 401);
  assert.equal((await collection.GET(new Request("http://127.0.0.1:3100/api/artifact-shares?artifactId=art_1"))).status, 401);
  assert.equal((await item.DELETE(new Request("http://x/api/artifact-shares/share_1", { method: "DELETE" }), { params: Promise.resolve({ shareId: "share_1" }) })).status, 401);
  assert.deepEqual(world.gates, []);
});

test("making a link hands the switch and the plan to the decision and answers the public address", async () => {
  reset();
  const { collection } = await load();
  const response = await collection.POST(post(ARTIFACT));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(world.gates, [{ sharingAvailable: true, planAllowsSharing: true }]);
  assert.equal(body.share.url, `https://tomverse.app/share/a/${SHARE.token}`);
  assert.equal(body.share.expiresAt, SHARE.expiresAt);
  assert.equal("token" in body.share, false);

  reset();
  world.enabled = false;
  world.allowSharing = false;
  world.prepared = { ok: false, code: "ARTIFACT_SHARING_DISABLED", status: 503 };
  const refused = await collection.POST(post(ARTIFACT));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).code, "ARTIFACT_SHARING_DISABLED");
  assert.deepEqual(world.gates, [{ sharingAvailable: false, planAllowsSharing: false }]);
});

test("a lock that lands between the check and the write is a refusal, not a link", async () => {
  reset();
  world.published = null;
  const { collection } = await load();
  const response = await collection.POST(post(ARTIFACT));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CONVERSATION_LOCKED");
});

test("a malformed or oversized body is refused before the decision", async () => {
  reset();
  const { collection } = await load();
  assert.equal((await collection.POST(post({ source: { kind: "file", artifactId: "x" } }))).status >= 400, true);
  assert.equal((await collection.POST(post({ source: { kind: "artifact", artifactId: "../etc" } }))).status >= 400, true);
  assert.equal(
    (await collection.POST(post({ source: { kind: "code_block", messageId: "m1", language: "html", code: "x".repeat(1_000_001) } }))).status >= 400,
    true
  );
  assert.deepEqual(world.gates, []);
});

test("making links is rate limited", async () => {
  reset();
  world.rateLimited = true;
  const { collection } = await load();
  assert.equal((await collection.POST(post(ARTIFACT))).status, 429);
  assert.deepEqual(world.gates, []);
});

test("an existing link is shown while sharing is off, so its owner can still stop it", async () => {
  reset();
  world.enabled = false;
  world.found = SHARE;
  const { collection } = await load();
  const response = await collection.GET(new Request("http://127.0.0.1:3100/api/artifact-shares?artifactId=art_1"));
  const body = await response.json();
  assert.equal(body.enabled, false);
  assert.equal(body.share.url, `https://tomverse.app/share/a/${SHARE.token}`);
  assert.equal(typeof body.ttlDays, "number");
  assert.equal((await collection.GET(new Request("http://127.0.0.1:3100/api/artifact-shares"))).status, 400);
  assert.equal((await collection.GET(new Request("http://127.0.0.1:3100/api/artifact-shares?messageId=m1&contentHash=nothex"))).status, 400);
});

test("only the owner stops a link; anything else is the same 404", async () => {
  reset();
  const { item } = await load();
  const stop = (shareId: string) =>
    item.DELETE(new Request(`http://127.0.0.1:3100/api/artifact-shares/${shareId}`, { method: "DELETE" }), { params: Promise.resolve({ shareId }) });
  assert.equal((await stop("share_1")).status, 200);
  assert.equal((await stop("share_2")).status, 404);
  world.session = { user: { id: "user_2" } };
  assert.equal((await stop("share_1")).status, 404);
  assert.deepEqual(world.revoked, [["user_1", "share_1"], ["user_1", "share_2"], ["user_2", "share_1"]]);
});
