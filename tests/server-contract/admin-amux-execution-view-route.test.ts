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
let lastRootOptions: unknown = null;
let lastQuery: string | null = null;

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
mock.module(mod("lib/amux/ownerRecoveryInspectionRead.ts"), { namedExports: {
  readAmuxOwnerRecoveryInspection: async () => { throw new Error("not_requested"); },
} });
mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
  readAmuxExecutionBoardSnapshot: async () => { reads += 1;
    return { counts: {}, lanes: [] }; },
  readAmuxExecutionBoard: async () => { reads += 1;
    return { counts: {}, cards: [] }; },
  readAmuxExecutionHierarchy: async (_parent: unknown, _page: number, options: unknown) => {
    reads += 1; lastRootOptions = options;
    return { total: 0, items: [] }; },
  readAmuxExecutionHierarchySearch: async (query: string) => { reads += 1; lastQuery = query;
    return { query, matchedNodes: 0, matchedCards: 0, rows: [] }; },
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

test("the hierarchy list takes its tab, sort and creation filter at the top level only", async () => {
  const { GET } = await route;
  session = { user: { id: "owner" } }; role = "owner"; recent = true; reads = 0;
  const status = async (query: string) => (await GET(new Request(`${base}?${query}`))).status;
  assert.equal(await status("view=hierarchy&parentKind=root"), 200);
  assert.deepEqual(lastRootOptions, { scope: "active", sort: "remaining", createdWithinDays: null });
  assert.equal(await status("view=hierarchy&parentKind=root&scope=cleanup"), 200);
  assert.deepEqual(lastRootOptions, { scope: "cleanup", sort: "stale", createdWithinDays: null });
  assert.equal(await status("view=hierarchy&parentKind=root&scope=all&sort=created&createdWithin=30"), 200);
  assert.deepEqual(lastRootOptions, { scope: "all", sort: "created", createdWithinDays: 30 });
  for (const query of ["view=hierarchy&parentKind=root&scope=archived",
    "view=hierarchy&parentKind=root&sort=title",
    "view=hierarchy&parentKind=root&createdWithin=31",
    "view=hierarchy&parentKind=node&parentId=n1&scope=all",
    "view=hierarchy&parentKind=root&scope=all&scope=active"])
    assert.equal(await status(query), 400, query);
  assert.equal(reads, 3);
});

test("hierarchy search needs one bounded query and returns what the reader found", async () => {
  const { GET } = await route;
  session = { user: { id: "owner" } }; role = "owner"; recent = true; reads = 0;
  const response = await GET(new Request(`${base}?view=hierarchy_search&q=${encodeURIComponent("  다운로드 ")}`));
  assert.equal(response.status, 200);
  assert.equal(lastQuery, "다운로드");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  for (const query of ["view=hierarchy_search", "view=hierarchy_search&q=%20",
    `view=hierarchy_search&q=${"x".repeat(81)}`, "view=hierarchy_search&q=a&page=1"])
    assert.equal((await GET(new Request(`${base}?${query}`))).status, 400, query);
  assert.equal(reads, 1);
});
