import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const ideaId = "a3eb94f2-c3b2-4e2a-93b4-902ce0e43f15";
const url = `https://tomverse.test/api/admin/amux/ideas/read-manifest?ideaId=${ideaId}&referenceOrdinal=0`;
let session: { user: { id: string } } | null = null;
let role = "viewer";
let adminSession = false;
let recent = false;
let rateLimited = false;
let reads = 0;
let available = true;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => role,
  isAdminSession: () => adminSession,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {
    if (!recent) throw new Error("stepup");
  },
  isAdminReauthenticationError: (error: unknown) =>
    error instanceof Error && error.message === "stepup",
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {
    if (rateLimited) throw new Error("rate");
  },
  apiSecurityResponse: (error: unknown) =>
    error instanceof Error && error.message === "rate" ?
      Response.json({ error: "rate" }, { status: 429 }) : null,
} });
mock.module(mod("lib/amux/ideaTrackedCheckoutReadManifestStore.ts"), {
  namedExports: { readAmuxTrackedCheckoutReadManifestForOwner: async (
    actorUserId: string, requestedIdeaId: string, referenceOrdinal: number,
  ) => {
    reads += 1;
    assert.equal(actorUserId, "owner");
    assert.equal(requestedIdeaId, ideaId);
    assert.equal(referenceOrdinal, 0);
    return available ? { pinnedCommitSha: "a".repeat(40),
      files: ["README.md", "src/read.ts"] } : null;
  } },
});

const route = import(mod("app/api/admin/amux/ideas/read-manifest/route.ts"));

test("read paths require owner, recent authentication, and rate admission", async () => {
  const { GET } = await route;
  session = null;
  assert.equal((await GET(new Request(url))).status, 404);
  session = { user: { id: "owner" } };
  adminSession = true;
  assert.equal((await GET(new Request(url))).status, 403);
  role = "owner";
  adminSession = false;
  assert.equal((await GET(new Request(url))).status, 404);
  adminSession = true;
  assert.equal((await GET(new Request(url))).status, 428);
  recent = true;
  rateLimited = true;
  assert.equal((await GET(new Request(url))).status, 429);
  assert.equal(reads, 0);
  rateLimited = false;
  for (const invalid of [`${url}&extra=1`, url.replace("referenceOrdinal=0",
    "referenceOrdinal=00"), url.replace(ideaId, "not-an-id")]) {
    assert.equal((await GET(new Request(invalid))).status, 400);
  }
  assert.equal(reads, 0);
});

test("owner receives uncached paths only while the store permits access", async () => {
  const { GET } = await route;
  available = true;
  const response = await GET(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { manifest: {
    pinnedCommitSha: "a".repeat(40),
    files: ["README.md", "src/read.ts"],
  } });
  available = false;
  const missing = await GET(new Request(url));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"),
    "private, no-store, max-age=0");
  assert.deepEqual(await missing.json(), { error: "not_found" });
  assert.equal(reads, 2);
});
