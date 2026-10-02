import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const previewId = "123e4567-e89b-42d3-a456-426614174001";
const ideaId = "123e4567-e89b-42d3-a456-426614174002";
const nonce = "A".repeat(43);
const choice = { version: 1, previewId, ideaId,
  payloadDigest: "a".repeat(64), payloadDigestKeyId: "synthetic-key" };
class FakeConfirmationError extends Error {
  constructor(readonly code: string) { super(code); }
}
const world = {
  session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner", recent: true, readOn: true, writeOn: true,
  writes: 0, reads: 0, unknown: false, body: JSON.stringify(choice),
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
    mock.module(mod("lib/amux/ideaSubmissionCore.ts"), { namedExports: {
      isAmuxIdeaRequestId: (id: string) => id === previewId,
    } });
    mock.module(mod("lib/amux/ideaTransferBrowserCore.ts"), { namedExports: {
      readIdeaTransferBrowserNonce: (cookies: string | null, id: string) =>
        id === previewId && cookies === `amux-v4-preview-${previewId}=${nonce}` ? nonce : null,
    } });
    mock.module(mod("lib/amux/ideaTransferConfirmationCore.ts"), { namedExports: {
      AMUX_V4_TRANSFER_CONFIRM_MAX_BYTES: 512,
      AMUX_V4_TRANSFER_CONFIRM_READ_ENV: "TRANSFER_CONFIRM_READ_TEST",
      AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV: "TRANSFER_CONFIRM_WRITE_TEST",
      inspectIdeaTransferConfirmationRequest: (raw: string) => raw === JSON.stringify(choice)
        ? { ok: true, request: choice } : { ok: false, code: "schema_rejected" },
      transferConfirmReadPermitted: () => world.readOn,
      transferConfirmWritePermitted: () => world.writeOn,
    } });
    mock.module(mod("lib/amux/ideaTransferConfirmationService.ts"), { namedExports: {
      IdeaTransferConfirmationError: FakeConfirmationError,
      confirmIdeaTransferPreview: async () => {
        world.writes += 1;
        if (world.unknown) throw new FakeConfirmationError("outcome_unknown");
        return { previewId, ideaId,
          payloadDigest: choice.payloadDigest,
          payloadDigestKeyId: choice.payloadDigestKeyId,
          confirmExpiresAt: new Date("2026-10-02T10:00:00Z"),
          auditId: "synthetic-audit" };
      },
      readIdeaTransferConfirmation: async () => {
        world.reads += 1;
        return { state: "confirmed", previewId, ideaId,
          payloadDigest: choice.payloadDigest,
          payloadDigestKeyId: choice.payloadDigestKeyId, modelCallStarted: false };
      },
    } });
  }
  return import(mod("app/api/admin/amux/ideas/transfer-confirmation/route.ts"));
}

const post = (cookie = `amux-v4-preview-${previewId}=${nonce}`) =>
  new Request("https://tomverse.test/api/admin/amux/ideas/transfer-confirmation", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: world.body,
  });
const get = (query = `?previewId=${previewId}`) =>
  new Request(`https://tomverse.test/api/admin/amux/ideas/transfer-confirmation${query}`);
const reset = () => {
  world.session = { user: { id: "owner-1" } }; world.role = "owner";
  world.recent = true; world.readOn = true; world.writeOn = true;
  world.writes = 0; world.reads = 0; world.unknown = false;
  world.body = JSON.stringify(choice);
};

test("confirmation refuses unauthenticated, stale, and disabled callers", async () => {
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
});

test("confirmation requires one same-preview browser receipt and exact request", async () => {
  const { POST, GET } = await route();
  reset();
  assert.equal((await POST(post(""))).status, 409);
  assert.equal((await POST(post("amux-v4-preview-other=token"))).status, 409);
  world.body = JSON.stringify({ ...choice, payloadDigest: "b".repeat(64) });
  assert.equal((await POST(post())).status, 400);
  assert.equal(world.writes, 0);
  world.body = JSON.stringify(choice);
  const response = await POST(post());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  const result = await response.json();
  assert.equal(result.modelCallStarted, false);
  assert.equal(result.ideaId, ideaId);
  assert.equal(result.payloadDigest, choice.payloadDigest);
  assert.equal(world.writes, 1);
  const read = await GET(get());
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "private, no-store, max-age=0");
  const readResult = await read.json();
  assert.equal(readResult.modelCallStarted, false);
  assert.equal(readResult.payloadDigestKeyId, choice.payloadDigestKeyId);
  assert.equal(world.reads, 1);
  assert.equal((await GET(get(`?previewId=${previewId}&extra=1`))).status, 400);
});

test("unknown confirmation outcome never invites a blind retry", async () => {
  const { POST } = await route();
  reset(); world.unknown = true;
  const response = await POST(post());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "outcome_unknown", previewId,
    retryWrite: false, modelCallStarted: false });
  assert.equal(world.writes, 1);
});
