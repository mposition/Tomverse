import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const approvedModels = [{ approvalId: "123e4567-e89b-42d3-a456-426614174000", approvalVersion: 1,
  provider: "openai", modelId: "gpt-frontier", allowedEfforts: ["high"] }];
const world = {
  session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner",
  recent: true,
  readOn: true,
  listCalls: 0,
  checkCalls: 0,
  checkedInput: null as unknown,
  selection: { decision: "selection_current", approvalId: approvedModels[0].approvalId,
    approvalVersion: 1 } as
    | { decision: "selection_current"; approvalId: string; approvalVersion: number }
    | { decision: "hold" | "reject"; reason: string },
  catalog: { decision: "catalog_current", models: approvedModels } as
    | { decision: "catalog_current"; models: unknown[] }
    | { decision: "hold"; reason: string },
};

let installed = false;
async function loadRoute(): Promise<{ GET: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null, getAdminRole: () => world.role,
    } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (!world.recent) throw new Error("reauth"); },
      isAdminReauthenticationError: (error: unknown) => error instanceof Error && error.message === "reauth",
    } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      apiSecurityResponse: () => null, consumeApiRateLimit: async () => undefined,
      readLimitedText: async () => "",
    } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/ideaFrontierCatalogWriteCore.ts"), { namedExports: {
      AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES: 2048,
      AMUX_V4_FRONTIER_CATALOG_READ_ENV: "FRONTIER_READ_TEST",
      AMUX_V4_FRONTIER_CATALOG_WRITE_ENV: "FRONTIER_WRITE_TEST",
      frontierCatalogReadPermitted: () => world.readOn,
      frontierCatalogWritePermitted: () => false,
      inspectFrontierCatalogWrite: () => ({ ok: false }),
      isFrontierApprovalId: () => false,
    } });
    mock.module(mod("lib/amux/ideaFrontierCatalogWrite.ts"), { namedExports: {
      FrontierCatalogWriteError: class extends Error {},
      writeFrontierCatalogDecision: async () => null,
    } });
    mock.module(mod("lib/amux/ideaFrontierCatalogRead.ts"), { namedExports: {
      listApprovedAmuxIdeaFrontierModels: async () => { world.listCalls += 1; return world.catalog; },
      readCurrentAmuxIdeaFrontierSelection: async (selected: unknown) => {
        world.checkCalls += 1;
        world.checkedInput = selected;
        return world.selection;
      },
    } });
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
  }
  return import(mod("app/api/admin/amux/ideas/frontier-models/route.ts"));
}

const request = (query = "?mode=available") =>
  new Request(`https://tomverse.app/api/admin/amux/ideas/frontier-models${query}`);
const reset = () => {
  world.session = { user: { id: "owner-1" } };
  world.role = "owner";
  world.recent = true;
  world.readOn = true;
  world.listCalls = 0;
  world.checkCalls = 0;
  world.checkedInput = null;
  world.selection = { decision: "selection_current", approvalId: approvedModels[0].approvalId,
    approvalVersion: 1 };
  world.catalog = { decision: "catalog_current", models: approvedModels };
};

test("available models stay owner-only, recently authenticated, and dark when read is off", async () => {
  const { GET } = await loadRoute();
  for (const setup of [
    () => { world.session = null; },
    () => { world.role = "admin"; },
    () => { world.recent = false; },
    () => { world.readOn = false; },
  ]) {
    reset();
    setup();
    const response = await GET(request());
    assert.ok([404, 403, 428, 503].includes(response.status));
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(world.listCalls, 0);
  }
});

test("only one exact available query reaches the verified catalog", async () => {
  const { GET } = await loadRoute();
  for (const query of ["", "?mode=available&mode=available", "?mode=available&extra=1", "?mode=other"]) {
    reset();
    const response = await GET(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(world.listCalls, 0, query);
  }
  reset();
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { state: "available", models: approvedModels,
    transferAuthorized: false });
  assert.equal(world.listCalls, 1);
});

test("catalog uncertainty is a no-store hold with no candidate list", async () => {
  const { GET } = await loadRoute();
  reset();
  world.catalog = { decision: "hold", reason: "model_catalog_unverified" };
  const response = await GET(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { state: "hold", error: "model_catalog_unverified",
    transferAuthorized: false });
});

test("exact model check is owner-only and never authorizes transfer", async () => {
  const { GET } = await loadRoute();
  const query = "?mode=check&provider=openai&modelId=gpt-frontier&reasoningEffort=high";
  for (const setup of [
    () => { world.session = null; },
    () => { world.role = "admin"; },
    () => { world.recent = false; },
    () => { world.readOn = false; },
  ]) {
    reset(); setup();
    const response = await GET(request(query));
    assert.ok([404, 403, 428, 503].includes(response.status));
    assert.equal(world.checkCalls, 0);
  }
  for (const bad of [
    "?mode=check&provider=openai&modelId=gpt-frontier",
    `${query}&reasoningEffort=high`,
    `${query}&extra=1`,
    "?mode=check&provider=openai&modelId=gpt-frontier&extra=1",
  ]) {
    reset();
    assert.equal((await GET(request(bad))).status, 400, bad);
    assert.equal(world.checkCalls, 0);
  }
  reset();
  const response = await GET(request(query));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { state: "current", approvalId: approvedModels[0].approvalId,
    approvalVersion: 1, transferAuthorized: false });
  assert.equal(world.checkCalls, 1);
  assert.deepEqual(world.checkedInput, { provider: "openai", modelId: "gpt-frontier",
    reasoningEffort: "high" });
});

test("revoked and uncertain model checks fail closed", async () => {
  const { GET } = await loadRoute();
  const query = "?mode=check&provider=openai&modelId=gpt-frontier&reasoningEffort=high";
  for (const selection of [
    { decision: "reject" as const, reason: "model_not_approved" },
    { decision: "hold" as const, reason: "model_catalog_unverified" },
  ]) {
    reset(); world.selection = selection;
    const response = await GET(request(query));
    assert.equal(response.status, selection.decision === "hold" ? 503 : 409);
    assert.deepEqual(await response.json(), { state: selection.decision, error: selection.reason,
      transferAuthorized: false });
  }
});
