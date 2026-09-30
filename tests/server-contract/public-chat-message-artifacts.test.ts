import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * A file card survives a reload (CHAT-ART-01).
 *
 * The stream trailer is what the browser sees while the answer arrives; the
 * conversation GET is what it sees afterwards. Both must describe the same
 * cards, and the second must do it without handing the browser a storage key
 * (docs/policy/generated-artifacts.md, "objectKey never reaches the client").
 *
 * `tests/integration/generated-artifacts.db.test.ts` pins that a failed card
 * gets a row. What is pinned here is the read boundary: the shared select, the
 * serializer, and that the conversation route uses both rather than a select
 * of its own.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

// The serializer never queries; the module only imports the client.
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });

type PublicChatMessageModule = typeof import("../../lib/publicChatMessage");
// Imported inside the tests: this runner transforms test files to CommonJS,
// where a top-level await does not compile.
const load = () => import(mod("lib/publicChatMessage.ts")) as Promise<PublicChatMessageModule>;

const CARD_FIELDS = [
  "byteSize",
  "failureCode",
  "filename",
  "format",
  "id",
  "mediaType",
  "modelId",
  "ordinal",
  "status",
];

const row = (artifacts: Array<Record<string, unknown>>) => ({
  id: "assistant-1",
  role: "assistant",
  content: "웹페이지를 만들었습니다.",
  status: "incomplete",
  modelId: "claude-haiku-4-5",
  pendingJobId: null,
  searchMetadata: null,
  createdAt: "2026-09-17T00:00:00.000Z",
  memoryUsedCount: null,
  knowledgeChunkCount: null,
  attachments: [],
  artifacts: artifacts as never,
});

test("the shared select reads a card's public fields and never its storage key", async () => {
  const { PUBLIC_CHAT_MESSAGE_SELECT } = await load();
  const select = PUBLIC_CHAT_MESSAGE_SELECT.artifacts.select as Record<string, unknown>;
  assert.deepEqual(Object.keys(select).sort(), CARD_FIELDS);
  assert.equal(select.objectKey, undefined);
  assert.deepEqual(PUBLIC_CHAT_MESSAGE_SELECT.artifacts.orderBy, { ordinal: "asc" });
});

test("a reloaded message carries its ready and turn_incomplete cards as they were streamed", async () => {
  const { toPublicChatMessage } = await load();
  const message = toPublicChatMessage(
    row([
      {
        id: "row_1",
        ordinal: 0,
        format: "html",
        filename: "generated-report.html",
        mediaType: "text/html",
        byteSize: 42,
        status: "ready",
        failureCode: null,
        modelId: "claude-haiku-4-5",
        // A row that somehow carried the key must still not pass it on.
        objectKey: "message-artifacts/u/c/row_1.html",
      },
      {
        id: "row_2",
        ordinal: 1,
        format: "txt",
        filename: "generated.txt",
        mediaType: "text/plain",
        byteSize: 0,
        status: "failed",
        failureCode: "turn_incomplete",
        modelId: "claude-haiku-4-5",
      },
    ])
  );

  assert.equal(message.artifacts?.length, 2);
  for (const card of message.artifacts!) {
    assert.deepEqual(Object.keys(card).sort(), CARD_FIELDS);
  }
  assert.deepEqual(
    message.artifacts!.map((card) => [card.id, card.status, card.failureCode]),
    [
      ["row_1", "ready", null],
      ["row_2", "failed", "turn_incomplete"],
    ]
  );
  assert.doesNotMatch(JSON.stringify(message), /message-artifacts\//);
});

test("a message that made no file has no artifacts key at all", async () => {
  const { toPublicChatMessage } = await load();
  assert.equal("artifacts" in toPublicChatMessage(row([])), false);
});

test("the conversation GET reads messages through the shared select and serializer", () => {
  const source = readFileSync(
    resolve(ROOT, "app/api/conversations/[conversationId]/route.ts"),
    "utf8"
  );
  assert.match(source, /select:\s*PUBLIC_CHAT_MESSAGE_SELECT/);
  assert.match(source, /\.map\(toPublicChatMessage\)/);
  // No second, route-local artifact select that could drift from the shared one.
  assert.doesNotMatch(source, /artifacts:\s*\{\s*(select|include)/);
});
