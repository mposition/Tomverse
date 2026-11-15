import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let authenticated = true;
let failure: Error | null = null;
const seen: Array<Record<string, unknown>> = [];
const rates: string[] = [];
class Refusal extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: {
  resolveChatRouteSession: async () => authenticated
    ? { session: { user: { id: "verified-owner" } } }
    : { response: Response.json({ error: "Unauthorized" }, { status: 401 }) },
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async (_request: Request, userId: string, scope: string) => { rates.push(`${userId}:${scope}`); },
  apiSecurityResponse: () => null,
} });
mock.module(mod("lib/conversationLock.ts"), { namedExports: {
  conversationLockedResponse: () => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }),
} });
mock.module(mod("lib/generatedArtifactLineage.ts"), { namedExports: {
  GeneratedArtifactLineageError: Refusal,
  readGeneratedArtifactVersions: async (input: Record<string, unknown>) => {
    seen.push(input); if (failure) throw failure;
    return { artifacts: [{ id: "clicked-file", ordinal: 0, format: "txt", filename: "same.txt",
      mediaType: "text/plain", byteSize: 3, status: "ready", parentArtifactId: "real-parent",
      lineageId: "real-root", createdAt: "2026-11-15T00:00:00.000Z" }], nextCursor: null };
  },
} });
let get: typeof import("../../app/api/artifacts/[artifactId]/versions/route").GET;
before(async () => { ({ GET: get } = await import("../../app/api/artifacts/[artifactId]/versions/route")); });
beforeEach(() => { authenticated = true; failure = null; seen.length = 0; rates.length = 0; });
const request = () => get(new Request("http://localhost/api/artifacts/clicked-file/versions?cursor=older-page"),
  { params: Promise.resolve({ artifactId: "clicked-file" }) });

test("version reads use exact clicked identity, verified owner, bounded helper and private response", async () => {
  const response = await request();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(seen[0].artifactId, "clicked-file"); assert.equal(seen[0].userId, "verified-owner");
  assert.equal(seen[0].cursor, "older-page"); assert.deepEqual(rates, ["verified-owner:artifact-versions"]);
  assert.equal((await response.json()).artifacts[0].parentArtifactId, "real-parent");
});
test("anonymous version reads never query source metadata", async () => {
  authenticated = false; assert.equal((await request()).status, 401);
  assert.equal(seen.length, 0); assert.equal(rates.length, 0);
});
test("unknown and foreign source refusals expose only not found", async () => {
  failure = new Refusal("ARTIFACT_NOT_FOUND", 404);
  const response = await request(); assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});
test("current lock refusal keeps the existing unlock response", async () => {
  failure = new Refusal("CONVERSATION_LOCKED", 423);
  const response = await request(); assert.equal(response.status, 423);
  assert.deepEqual(await response.json(), { code: "CONVERSATION_LOCKED" });
});
