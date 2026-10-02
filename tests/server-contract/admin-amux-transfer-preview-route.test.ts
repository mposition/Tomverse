import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const previewId = "123e4567-e89b-42d3-a456-426614174001";
const ideaId = "123e4567-e89b-42d3-a456-426614174002";
const approvalId = "123e4567-e89b-42d3-a456-426614174003";
const choice = { version: 1, previewId, ideaId, provider: "openai",
  modelId: "gpt-frontier", reasoningEffort: "high", approvalId, approvalVersion: 1 };
class FakeIdeaTransferPreviewError extends Error {
  constructor(readonly code: string) { super(code); }
}
const world = {
  session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner",
  recent: true,
  readOn: true,
  writeOn: true,
  catalogOn: true,
  writes: 0,
  unknown: false,
  reads: 0,
  body: JSON.stringify(choice),
};
let installed = false;

async function route(): Promise<{ POST: (request: Request) => Promise<Response>;
  GET: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null, getAdminRole: () => world.role,
    } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (!world.recent) throw new Error("reauth"); },
      isAdminReauthenticationError: (error: unknown) =>
        error instanceof Error && error.message === "reauth",
    } });
    mock.module(mod("lib/adminApproval.ts"), { namedExports: {
      adminApprovalErrorResponse: () => null,
    } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      apiSecurityResponse: () => null, consumeApiRateLimit: async () => undefined,
      readLimitedText: async () => world.body,
    } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/ideaFrontierCatalogWriteCore.ts"), { namedExports: {
      AMUX_V4_FRONTIER_CATALOG_READ_ENV: "FRONTIER_READ_TEST",
      frontierCatalogReadPermitted: () => world.catalogOn,
    } });
    mock.module(mod("lib/amux/ideaSubmissionCore.ts"), { namedExports: {
      isAmuxIdeaRequestId: (id: string) => id === previewId,
    } });
    mock.module(mod("lib/amux/ideaTransferPreviewInputCore.ts"), { namedExports: {
      AMUX_V4_TRANSFER_PREVIEW_MAX_BYTES: 1024,
      AMUX_V4_TRANSFER_PREVIEW_READ_ENV: "TRANSFER_READ_TEST",
      AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV: "TRANSFER_WRITE_TEST",
      inspectIdeaOnlyTransferPreviewRequest: (raw: string) => raw === JSON.stringify(choice)
        ? { ok: true, request: choice } : { ok: false, code: "schema_rejected" },
      transferPreviewReadPermitted: () => world.readOn,
      transferPreviewWritePermitted: () => world.writeOn,
    } });
    mock.module(mod("lib/amux/ideaTransferPreviewService.ts"), { namedExports: {
      IdeaTransferPreviewError: FakeIdeaTransferPreviewError,
      prepareIdeaOnlyTransferPreview: async () => {
        world.writes += 1;
        if (world.unknown) throw new FakeIdeaTransferPreviewError("outcome_unknown");
        return { previewId, expiresAt: new Date("2026-10-02T10:00:00Z"), payload: { prompt: "synthetic" } };
      },
      readIdeaOnlyTransferPreview: async () => {
        world.reads += 1;
        return { state: "prepared", previewId, transferAuthorized: false };
      },
    } });
  }
  return import(mod("app/api/admin/amux/ideas/transfer-preview/route.ts"));
}

const post = () => new Request("https://tomverse.test/api/admin/amux/ideas/transfer-preview", {
  method: "POST", headers: { "content-type": "application/json" }, body: world.body,
});
const get = (query = `?previewId=${previewId}`) =>
  new Request(`https://tomverse.test/api/admin/amux/ideas/transfer-preview${query}`);
const reset = () => {
  world.session = { user: { id: "owner-1" } };
  world.role = "owner"; world.recent = true;
  world.readOn = true; world.writeOn = true; world.catalogOn = true;
  world.writes = 0; world.reads = 0; world.unknown = false;
  world.body = JSON.stringify(choice);
};

test("preview write and read refuse unauthenticated, stale, or disabled callers", async () => {
  const { POST, GET } = await route();
  for (const setup of [
    () => { world.session = null; },
    () => { world.role = "admin"; },
    () => { world.recent = false; },
    () => { world.readOn = false; },
  ]) {
    reset(); setup();
    assert.notEqual((await POST(post())).status, 201);
    assert.notEqual((await GET(get())).status, 200);
    assert.equal(world.writes, 0);
    assert.equal(world.reads, 0);
  }
  reset(); world.writeOn = false;
  assert.equal((await POST(post())).status, 503);
  assert.equal(world.writes, 0);
  reset(); world.catalogOn = false;
  assert.equal((await POST(post())).status, 503);
  assert.equal(world.writes, 0);
});

test("prepared preview is no-store and never represents transfer permission", async () => {
  const { POST, GET } = await route();
  reset();
  const response = await POST(post());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, new RegExp(`amux-v4-preview-${previewId}=`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal((await response.json()).transferAuthorized, false);
  assert.equal(world.writes, 1);
  const read = await GET(get());
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal((await read.json()).transferAuthorized, false);
  assert.equal(world.reads, 1);
  for (const query of ["", `${get().url.split("?")[1]}&extra=1`,
    `?previewId=${previewId}&previewId=${previewId}`]) {
    const malformed = query.startsWith("?") ? query : `?${query}`;
    assert.equal((await GET(get(malformed))).status, 400);
  }
});

test("unknown write keeps the same browser receipt for exact-ID read-back", async () => {
  const { POST } = await route();
  reset(); world.unknown = true;
  const response = await POST(post());
  assert.equal(response.status, 503);
  assert.match(response.headers.get("set-cookie") || "", new RegExp(`amux-v4-preview-${previewId}=`));
  assert.deepEqual(await response.json(), { error: "outcome_unknown", previewId,
    retryWrite: false, transferAuthorized: false });
  assert.equal(world.writes, 1);
});
