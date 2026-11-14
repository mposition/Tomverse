import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

let session: { user: { id: string } } | null = null;
let adminSession = false;
let opsWrite = true;
let rateLimited = false;
let dmFails = false;
let engineeringFails = false;
const dmReads: Array<{ cards: unknown; canReadDm: boolean }> = [];

const queueItem = (n: number, escalationId: string | null) => ({
  taskId: `task-${n}`, displayKey: `AMUX-${n}`, sourceKey: null, title: `Card ${n}`, status: "blocked",
  worker: null, channel: null, attentionReason: "human_review_required", ownerQuestion: null,
  escalationId, waitingSince: "2026-11-13T00:00:00.000Z",
});
const settlement = { status: "read", settlementId: "set-1", kind: "stopped", state: "open", decision: null,
  handoffReason: null, dm: { state: "filed" }, confirmable: false };

mock.module("next-auth/next", { namedExports: { getServerSession: async () => session } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => adminSession,
  hasAdminPermission: (_session: unknown, permission: string) => permission === "ops:write" && opsWrite,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => { if (rateLimited) throw new Error("rate"); },
  apiSecurityResponse: (error: unknown) =>
    error instanceof Error && error.message === "rate" ? Response.json({ error: "rate" }, { status: 429 }) : null,
} });
mock.module(mod("lib/amux/adminOwnerQueueRead.ts"), { namedExports: {
  readAmuxOwnerQueue: async () => ({
    items: [queueItem(1, "esc-1"), queueItem(2, null), queueItem(3, "esc-3")],
    total: 3, processedToday: 0, generatedAt: "2026-11-14T00:00:00.000Z",
  }),
} });
mock.module(mod("lib/engineeringAgentConsoleRead.ts"), { namedExports: {
  readEngineeringAgentCardItems: async () => {
    if (engineeringFails) throw new Error("engineering read failed");
    return new Map();
  },
} });
mock.module(mod("lib/amux/ownerQueueDmRead.ts"), { namedExports: {
  readAmuxOwnerQueueDm: async (cards: unknown, canReadDm: boolean) => {
    dmReads.push({ cards, canReadDm });
    if (dmFails) throw new Error("decision maker read failed");
    return new Map([["task-1", settlement]]);
  },
} });

const route = import(mod("app/api/admin/amux/owner-queue/route.ts"));
const url = "https://tomverse.test/api/admin/amux/owner-queue";
const signIn = () => { session = { user: { id: "admin" } }; adminSession = true; rateLimited = false; };

test("the owner queue is for admin sessions only, and rate limited", async () => {
  const { GET } = await route;
  session = null;
  assert.equal((await GET(new Request(url))).status, 404);
  session = { user: { id: "user" } };
  adminSession = false;
  assert.equal((await GET(new Request(url))).status, 404);
  signIn();
  rateLimited = true;
  assert.equal((await GET(new Request(url))).status, 429);
  assert.equal(dmReads.length, 0);
});

test("each card carries its settlement: the entry read, null for a card with none", async () => {
  const { GET } = await route;
  signIn();
  dmFails = false;
  engineeringFails = false;
  const response = await GET(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.items.map((item: { dmSettlement: unknown }) => item.dmSettlement), [settlement, null, null]);
  assert.equal(body.total, 3);
});

test("the Decision Maker's bodies are read only for ops:write", async () => {
  const { GET } = await route;
  signIn();
  dmReads.length = 0;
  opsWrite = true;
  await GET(new Request(url));
  opsWrite = false;
  await GET(new Request(url));
  opsWrite = true;
  assert.deepEqual(dmReads.map((read) => read.canReadDm), [true, false]);
  assert.deepEqual(
    (dmReads[0].cards as Array<{ taskId: string }>).map((card) => card.taskId), ["task-1", "task-2", "task-3"]);
});

test("a failed Decision Maker read leaves the queue readable, each escalated card unread", async () => {
  const { GET } = await route;
  signIn();
  dmFails = true;
  const response = await GET(new Request(url));
  dmFails = false;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.items.map((item: { dmSettlement: unknown }) => item.dmSettlement),
    [{ status: "unread" }, null, { status: "unread" }]);
});

test("a failed engineering read does not hide the settlement", async () => {
  const { GET } = await route;
  signIn();
  engineeringFails = true;
  const body = await (await GET(new Request(url))).json();
  engineeringFails = false;
  assert.equal(body.items[0].dmSettlement.settlementId, "set-1");
  assert.equal("engineeringItems" in body.items[0], false);
});
