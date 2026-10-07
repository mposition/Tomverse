import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let session: { user: { id: string } } | null = null;
let role = "viewer";
let recent = false;
let reads = 0;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => role, isAdminSession: () => true,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {
    if (!recent) throw new Error("stepup");
  },
  isAdminReauthenticationError: (error: unknown) =>
    error instanceof Error && error.message === "stepup",
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => undefined,
  apiSecurityResponse: () => null,
} });
mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
  readAmuxExecutionBoardSnapshot: async () => { reads += 1;
    return { counts: {}, lanes: [] }; },
  readAmuxExecutionBoard: async () => { reads += 1;
    return { counts: {}, cards: [] }; },
  readAmuxExecutionHierarchy: async () => { reads += 1;
    return { total: 0, items: [] }; },
  readAmuxExecutionTaskDetail: async () => { reads += 1;
    return { id: "card-1", title: "private" }; },
} });

const route = import(mod("app/api/admin/amux/execution-view/route.ts"));
const base = "https://tomverse.test/api/admin/amux/execution-view";

test("private execution views require owner and recent reauthentication", async () => {
  const { GET } = await route;
  assert.equal((await GET(new Request(`${base}?view=board_snapshot`))).status, 404);
  session = { user: { id: "operator" } };
  assert.equal((await GET(new Request(`${base}?view=board_snapshot`))).status, 404);
  role = "owner";
  const stepup = await GET(new Request(`${base}?view=board_snapshot`));
  assert.equal(stepup.status, 428);
  assert.equal(stepup.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(reads, 0);
  recent = true;
  assert.equal((await GET(new Request(`${base}?view=board_snapshot&extra=1`))).status, 400);
  assert.equal((await GET(new Request(`${base}?view=board&lane=todo&page=-1`))).status, 400);
  assert.equal((await GET(new Request(`${base}?view=hierarchy&parentKind=root&parentId=x`))).status, 400);
  assert.equal((await GET(new Request(`${base}?view=detail&taskId=x&taskId=y`))).status, 400);
  const board = await GET(new Request(`${base}?view=board_snapshot`));
  assert.equal(board.status, 200);
  assert.equal(board.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal((await GET(new Request(`${base}?view=board&lane=todo&page=0`))).status, 200);
  assert.equal((await GET(new Request(`${base}?view=hierarchy&parentKind=root`))).status, 200);
  assert.equal((await GET(new Request(`${base}?view=hierarchy&parentKind=unassigned`))).status, 200);
  assert.equal((await GET(new Request(`${base}?view=detail&taskId=card-1`))).status, 200);
  assert.equal(reads, 5);
});
