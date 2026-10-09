import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const rawUrl = process.env.TEST_DATABASE_URL?.trim();

test("server-held Chat decisions on PostgreSQL", { skip: !rawUrl }, async t => {
  if (!rawUrl) return;
  const url = new URL(rawUrl);
  assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])test(?:[_-]|$)/);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "synthetic loopback database only");
  const schema = `refiner_execution_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: rawUrl });
  await client.connect();
  let release = { explicitEnabled: false, autoEnabled: false };
  let auditFailure = false;
  const pool = new pg.Pool({ connectionString: rawUrl, max: 4 });
  const query = (db: pg.PoolClient, strings: TemplateStringsArray, values: unknown[]) =>
    db.query(strings.reduce((sql, part, index) => sql + part + (index < values.length ? `$${index + 1}` : ""), ""), values);
  const transaction = async (work: (tx: Record<string, unknown>) => Promise<unknown>) => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN"); await db.query(`SET LOCAL search_path TO "${schema}"`);
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (await query(db, strings, values)).rows,
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (await query(db, strings, values)).rowCount,
        conversation: { findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
          (await db.query(`SELECT "id", "chatRecoveryEpoch" FROM "Conversation" WHERE "id"=$1 AND "userId"=$2 AND "kind"='chat' AND "productKey"='chat'`, [where.id, where.userId])).rows[0] ?? null },
        chatComposerDraft: { findUnique: async ({ where }: { where: { userId_scopeKey: { userId: string; scopeKey: string } } }) =>
          (await db.query(`SELECT "id", "revision", "text" FROM "ChatComposerDraft" WHERE "userId"=$1 AND "conversationId"=$2`, [where.userId_scopeKey.userId, where.userId_scopeKey.scopeKey])).rows[0] ?? null },
      };
      const result = await work(tx); await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  };
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "Conversation" ("id" TEXT PRIMARY KEY, "userId" TEXT REFERENCES "User"("id") ON DELETE CASCADE,
        "kind" TEXT, "productKey" TEXT, "chatRecoveryEpoch" INTEGER DEFAULT 0, "selectionMode" TEXT DEFAULT 'auto');
      CREATE TABLE "ChatComposerDraft" ("id" TEXT PRIMARY KEY, "userId" TEXT, "conversationId" TEXT,
        "revision" INTEGER, "text" TEXT, "attachmentReferences" JSONB DEFAULT '[]');
      CREATE TABLE "Message" ("id" TEXT PRIMARY KEY, "conversationId" TEXT, "role" TEXT, "content" TEXT);
      CREATE TABLE "TestAudit" ("id" TEXT PRIMARY KEY, "action" TEXT, "metadata" JSONB);`);
    await client.query(await readFile(resolve(root, "prisma/migrations/20261009140000_prompt_refiner_chat_execution/migration.sql"), "utf8"));
    await client.query(`INSERT INTO "User" VALUES ('owner'), ('other');
      INSERT INTO "Conversation" ("id","userId","kind","productKey") VALUES
      ('conversation','owner','chat','chat'), ('other-conversation','other','chat','chat');`);
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
      $transaction: transaction,
      message: { findFirst: async ({ where }: { where: { id: string; conversationId: string; conversation: { userId: string } } }) => {
        const row = (await client.query(`SELECT m.* FROM "Message" m JOIN "Conversation" c ON c."id"=m."conversationId"
          WHERE m."id"=$1 AND c."id"=$2 AND c."userId"=$3 AND m."role"='user'`, [where.id, where.conversationId, where.conversation.userId])).rows[0];
        return row ? { ...row, attachments: [] } : null;
      } },
    } } });
    mock.module(mod("lib/chatResponseAttemptPersistence.ts"), { namedExports: {
      lockChatRecoveryConversation: async () => {},
    } });
    mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: { promptRefinerChatExecutionRelease: () => release } });
    mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeSystemAuditLog: async (input: {
      tx: { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };
      systemActor: string; action: string; metadata: unknown;
    }) => {
      if (auditFailure) throw new Error("synthetic audit failure");
      assert.equal(input.systemActor, "prompt-refiner-chat-execution");
      assert.equal(JSON.stringify(input.metadata).includes("source"), false);
      return input.tx.$executeRaw`INSERT INTO "TestAudit" VALUES (${randomUUID()}, ${input.action}, ${JSON.stringify(input.metadata)}::jsonb)`;
    } } });
    const store = await import(mod("lib/promptRefinerChatExecutionStore.ts"));
    const setup = async (mode = "explicit") => {
      const scope = await store.advancePromptRefinerChatScope({ userId: "owner", conversationId: "conversation", surface: "chat", mountId: randomUUID() });
      await client.query(`DELETE FROM "ChatComposerDraft"`);
      const draftId = randomUUID(); const text = "  source 🙂\r\noriginal  ";
      await client.query(`INSERT INTO "ChatComposerDraft" ("id","userId","conversationId","revision","text") VALUES ($1,'owner','conversation',1,$2)`, [draftId, text]);
      const snapshot = await store.capturePromptRefinerChatDraft({ userId: "owner", conversationId: "conversation", scopeId: scope.id, epoch: scope.epoch });
      const held = await store.holdPromptRefinerChatSuggestion({ snapshot, mode, response: {
        requestId: snapshot.requestId, suggestionId: randomUUID(), refinedPrompt: "Refined execution text", refinerVersion: "suggest-v2", inputScope: "current_user_turn_text_only",
      } });
      const save = async () => {
        await client.query("BEGIN");
        await client.query(`DELETE FROM "ChatComposerDraft" WHERE "id"=$1`, [draftId]);
        await client.query(`INSERT INTO "Message" VALUES ($1,'conversation','user',$2)`, [snapshot.sourceMessageId, text]);
        await client.query("COMMIT");
      };
      const input = { userId: "owner", conversationId: "conversation", sourceMessageId: snapshot.sourceMessageId,
        messages: [{ id: snapshot.sourceMessageId, role: "user", content: text }],
        decision: { suggestionId: held.suggestionId, scopeId: held.scopeId, epoch: held.epoch, decision: "accepted" } };
      return { scope, draftId, snapshot, held, save, input };
    };
    const row = async (id: string) => (await client.query(`SELECT * FROM "PromptRefinerChatSuggestion" WHERE "id"=$1`, [id])).rows[0];
    const refuse = (input: unknown) => assert.rejects(store.consumePromptRefinerChatExecution(input), /no longer available|persisted source message/);

    await t.test("default-off refuses and does not consume", async () => {
      const f = await setup(); await f.save(); await refuse(f.input);
      assert.equal((await row(f.held.suggestionId)).state, "ready");
    });
    release = { explicitEnabled: true, autoEnabled: false };
    await t.test("a serialized snapshot cannot mint a held server suggestion", async () => {
      const f = await setup();
      const response = { requestId: f.held.requestId, suggestionId: randomUUID(), refinedPrompt: "browser proposal",
        refinerVersion: "suggest-v2", inputScope: "current_user_turn_text_only" };
      await assert.rejects(store.holdPromptRefinerChatSuggestion({ snapshot: { ...f.snapshot }, mode: "explicit", response }), /no longer available/);
    });
    await t.test("accepted input is consumed with audit; raw source is unchanged and replay refuses", async () => {
      const f = await setup(); await f.save();
      const view = await store.consumePromptRefinerChatExecution(f.input);
      assert.equal(view.executionMessages.at(-1).content, "Refined execution text");
      assert.equal(view.authoredMessages.at(-1).content, f.snapshot.sourcePrompt);
      assert.equal((await client.query(`SELECT "content" FROM "Message" WHERE "id"=$1`, [f.snapshot.sourceMessageId])).rows[0].content, f.snapshot.sourcePrompt);
      assert.equal((await row(f.held.suggestionId)).sourcePrompt, null);
      assert.equal((await row(f.held.suggestionId)).refinedPrompt, null);
      await refuse(f.input);
    });
    await t.test("keep-original consumes once without modifying execution", async () => {
      const f = await setup(); await f.save(); f.input.decision.decision = "kept_original";
      const view = await store.consumePromptRefinerChatExecution(f.input);
      assert.equal(view.executionMessages, f.input.messages);
      assert.equal((await row(f.held.suggestionId)).decision, "kept_original");
    });
    await t.test("two concurrent consumers produce one view and one refusal", async () => {
      const f = await setup(); await f.save();
      const result = await Promise.allSettled([store.consumePromptRefinerChatExecution(f.input), store.consumePromptRefinerChatExecution(f.input)]);
      assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
      assert.equal(result.filter(x => x.status === "rejected").length, 1);
    });
    await t.test("audit failure rolls back consumption and body purge", async () => {
      const f = await setup(); await f.save(); auditFailure = true;
      try { await assert.rejects(store.consumePromptRefinerChatExecution(f.input), /synthetic audit failure/); }
      finally { auditFailure = false; }
      assert.equal((await row(f.held.suggestionId)).state, "ready");
      assert.equal((await row(f.held.suggestionId)).sourcePrompt, f.snapshot.sourcePrompt);
    });
    await t.test("cross-account and forged source binding refuse", async () => {
      const f = await setup(); await f.save();
      await refuse({ ...f.input, userId: "other" });
      await refuse({ ...f.input, decision: { ...f.input.decision, suggestionId: randomUUID() } });
      assert.equal((await row(f.held.suggestionId)).state, "ready");
    });
    await t.test("draft edits including same-bytes and attachment edits invalidate irrevocably", async () => {
      const f = await setup();
      await client.query(`UPDATE "ChatComposerDraft" SET "revision"="revision"+1, "attachmentReferences"='[{"uploadId":"different"}]' WHERE "id"=$1`, [f.draftId]);
      assert.equal((await row(f.held.suggestionId)).state, "stale");
      await f.save(); await refuse(f.input);
      const response = { requestId: f.held.requestId, suggestionId: f.held.suggestionId,
        refinedPrompt: f.held.refinedPrompt, refinerVersion: f.held.refinerVersion, inputScope: f.held.inputScope };
      await assert.rejects(store.holdPromptRefinerChatSuggestion({ snapshot: f.snapshot, mode: "explicit", response }), /no longer available/);
    });
    await t.test("scope ABA advances epoch even for identical values", async () => {
      const f = await setup(); await f.save();
      const mount = (await client.query(`SELECT "mountId" FROM "PromptRefinerChatScope" WHERE "id"=$1`, [f.scope.id])).rows[0].mountId;
      const next = await store.advancePromptRefinerChatScope({ userId: "owner", conversationId: "conversation", surface: "chat", mountId: mount });
      assert.equal(next.epoch, f.scope.epoch + 1); await refuse(f.input);
      assert.equal((await row(f.held.suggestionId)).state, "stale");
    });
    await t.test("automatic result cannot borrow explicit authority", async () => {
      const f = await setup("auto"); await f.save(); await refuse(f.input);
      release = { explicitEnabled: false, autoEnabled: true };
      const view = await store.consumePromptRefinerChatExecution(f.input);
      assert.equal(view.executionMessages.at(-1).content, "Refined execution text");
      release = { explicitEnabled: true, autoEnabled: false };
    });
    await t.test("kill switch refuses before consumption", async () => {
      const f = await setup(); await f.save(); process.env.PROMPT_REFINER_KILL_SWITCH = "test-stop";
      try { await refuse(f.input); } finally { delete process.env.PROMPT_REFINER_KILL_SWITCH; }
      assert.equal((await row(f.held.suggestionId)).state, "ready");
    });
    await t.test("terminal tombstones cannot be reset, rebound or consumed twice", async () => {
      const f = await setup(); await f.save(); await store.consumePromptRefinerChatExecution(f.input);
      await assert.rejects(client.query(`UPDATE "PromptRefinerChatSuggestion" SET "state"='ready' WHERE "id"=$1`, [f.held.suggestionId]), /immutable/);
      await assert.rejects(client.query(`UPDATE "PromptRefinerChatSuggestion" SET "sourceMessageId"='another' WHERE "id"=$1`, [f.held.suggestionId]), /immutable/);
    });
    await t.test("expiry sweep purges only its bounded batch and expired consume refuses", async () => {
      const f = await setup(); await f.save();
      // Synthetic aged row in an isolated schema; product DDL remains unchanged.
      await client.query(`ALTER TABLE "PromptRefinerChatSuggestion" DISABLE TRIGGER "PromptRefinerChatSuggestion_guard"`);
      await client.query(`UPDATE "PromptRefinerChatSuggestion" SET "createdAt"=(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '6 minutes',
        "expiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '1 minute' WHERE "id"=$1`, [f.held.suggestionId]);
      await client.query(`ALTER TABLE "PromptRefinerChatSuggestion" ENABLE TRIGGER "PromptRefinerChatSuggestion_guard"`);
      await refuse(f.input);
      assert.deepEqual(await store.expirePromptRefinerChatSuggestions(1), { expired: 1 });
      assert.equal((await row(f.held.suggestionId)).sourcePrompt, null);
      await assert.rejects(store.expirePromptRefinerChatSuggestions(101), /no longer available/);
    });
    await t.test("account cascade removes both transient domains", async () => {
      await client.query(`DELETE FROM "User" WHERE "id"='owner'`);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM "PromptRefinerChatSuggestion"`)).rows[0].n, 0);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM "PromptRefinerChatScope"`)).rows[0].n, 0);
    });
  } finally {
    await pool.end(); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end();
  }
});
