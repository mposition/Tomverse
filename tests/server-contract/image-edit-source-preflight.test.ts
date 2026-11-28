// Contract: a photo an image edit cannot use is refused by name when the edit is
// requested -- before any credit is reserved -- instead of failing generically
// when it runs (docs/policy/image-generation.md, photo edits).

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

let attachment: { id: string; objectKey: string; size: number } | null = null;
let stored: Buffer | Error = Buffer.alloc(0);
let reads = 0;
let mocksInstalled = false;

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: { messageAttachment: { findFirst: async () => attachment } },
      },
    });
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        readOwnR2ObjectBytes: async () => {
          reads += 1;
          if (stored instanceof Error) throw stored;
          return stored;
        },
      },
    });
  }
  return import(mod("lib/imageEditSource.ts"));
}

const params = { userId: "user-1", conversationId: "conv-1", sourceUserMessageId: "msg-1" };
const refused = (code: string) => (error: unknown) =>
  (error as { code?: string }).code === code;

test("a photo over the edit limit is refused before it is read", async () => {
  const { findChatImageEditSource } = await load();
  const { IMAGE_EDIT_SOURCE_MAX_BYTES } = await import(mod("lib/imageGenerationPricing.ts"));
  attachment = { id: "a1", objectKey: "k", size: IMAGE_EDIT_SOURCE_MAX_BYTES + 1 };
  reads = 0;
  await assert.rejects(() => findChatImageEditSource(params), refused("IMAGE_EDIT_SOURCE_TOO_LARGE"));
  assert.equal(reads, 0);
});

test("a photo that cannot be decoded is refused as unsupported", async () => {
  const { findChatImageEditSource } = await load();
  attachment = { id: "a2", objectKey: "k", size: 1024 };
  stored = Buffer.from("this is not an image");
  await assert.rejects(() => findChatImageEditSource(params), refused("IMAGE_EDIT_SOURCE_UNSUPPORTED"));
});

test("a readable photo keeps its shape; a photo storage cannot be reached for stays square", async () => {
  const { findChatImageEditSource } = await load();
  const sharp = (await import("sharp")).default;
  stored = await sharp({
    create: { width: 300, height: 200, channels: 3, background: "#808080" },
  })
    .png()
    .toBuffer();
  attachment = { id: "a3", objectKey: "k", size: stored.length };
  assert.deepEqual(await findChatImageEditSource(params), {
    attachmentId: "a3",
    size: "1536x1024",
  });

  // A storage fault is not a verdict on the photo: the executor decides later.
  stored = new Error("storage unreachable");
  assert.deepEqual(await findChatImageEditSource(params), {
    attachmentId: "a3",
    size: "1024x1024",
  });
});

test("no photo on the question is still no photo", async () => {
  const { findChatImageEditSource } = await load();
  attachment = null;
  assert.equal(await findChatImageEditSource(params), null);
});
