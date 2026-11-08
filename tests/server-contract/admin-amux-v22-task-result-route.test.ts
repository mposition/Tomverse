import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let session: { user: { id: string } } | null = null;
let role = "viewer";
let adminSession = false;
let recent = false;
let rateLimited = false;
let reads = 0;
let opsWrite = true;
let resultState: string | undefined;
let questionState = "open";
const dmReads: string[] = [];

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => session,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  getAdminRole: () => role,
  isAdminSession: () => adminSession,
  hasAdminPermission: (_session: unknown, permission: string) => permission === "ops:write" && opsWrite,
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
mock.module(mod("lib/amux/v22TaskResultStore.ts"), { namedExports: {
  readAmuxV22TaskResultForOwner: async () => {
    reads += 1;
    return { text: "private result", state: resultState, attemptId: "attempt-1" };
  },
} });
mock.module(mod("lib/amux/v22OwnerQuestionService.ts"), { namedExports: {
  readAmuxV22OwnerQuestionForResult: async () => ({ id: "question-1", state: questionState }),
} });
mock.module(mod("lib/amux/v22OwnerQuestionDmRead.ts"), { namedExports: {
  readAmuxV22QuestionDm: async (questionId: string) => {
    dmReads.push(questionId);
    return { state: "cannot_answer", requestId: "request-1", reason: "Needs the owner." };
  },
} });

const route = import(mod("app/api/admin/amux/v22-task-result/route.ts"));
const url = "https://tomverse.test/api/admin/amux/v22-task-result?taskId=task-1";

test("private Task result requires owner, recent sign-in and rate admission", async () => {
  const { GET } = await route;
  session = null;
  assert.equal((await GET(new Request(url))).status, 404);
  session = { user: { id: "owner" } };
  adminSession = true;
  assert.equal((await GET(new Request(url))).status, 404);
  role = "owner";
  adminSession = false;
  assert.equal((await GET(new Request(url))).status, 404);
  adminSession = true;
  assert.equal((await GET(new Request(url))).status, 428);
  recent = true;
  rateLimited = true;
  const limited = await GET(new Request(url));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(reads, 0);
  rateLimited = false;
  assert.equal((await GET(new Request(`${url}&extra=1`))).status, 400);
  const result = await GET(new Request(url));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(reads, 1);
});

test("an open question carries its Decision Maker state, with bodies only for ops:write", async () => {
  const { GET } = await route;
  session = { user: { id: "owner" } };
  role = "owner";
  adminSession = true;
  recent = true;
  rateLimited = false;
  resultState = "available";
  questionState = "open";
  opsWrite = true;
  const open = await (await GET(new Request(url))).json();
  assert.deepEqual(open.decisionMaker, { state: "cannot_answer", requestId: "request-1", reason: "Needs the owner." });
  assert.deepEqual(dmReads, ["question-1"]);
  opsWrite = false;
  const restricted = await (await GET(new Request(url))).json();
  assert.deepEqual(restricted.decisionMaker, { state: "restricted" });
  assert.equal(dmReads.length, 1);
  // A question no longer open has nothing left for the Decision Maker.
  opsWrite = true;
  questionState = "answered";
  const answered = await (await GET(new Request(url))).json();
  assert.equal(answered.decisionMaker, null);
  assert.equal(dmReads.length, 1);
});
