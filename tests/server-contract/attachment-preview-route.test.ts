// Contract: who may see the thumbnail of an image they sent, and what the
// response says.
//
// docs/policy/user-attachment-persistence.md section 5.1. The route serves an
// owner's own raster image back to that owner and nothing else:
//
//   * a row that is not yours is a 404, and so is a row that does not exist;
//   * a document, an SVG or a file storage already lost is a 404 too, so this
//     never becomes a general download route for input files;
//   * a locked conversation is CONVERSATION_LOCKED, to the owner only;
//   * a storage failure is a 404 and never marks the row unavailable; and
//   * the object key never appears in the response.
//
// Only the route's collaborators are replaced. The route is real.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "attachment-preview-contract-2026";

type AttachmentRow = {
  id: string;
  userId: string;
  conversationId: string;
  mediaType: string;
  size: number;
  objectKey: string | null;
  unavailableAt: Date | null;
  conversation: {
    password: string | null;
    passwordVersion: number;
    userId: string;
  } | null;
};

const SENT: AttachmentRow = {
  id: "att_1",
  userId: "user_1",
  conversationId: "conv_1",
  mediaType: "image/jpeg",
  size: 16,
  objectKey: "message-attachments/user_1/2026/11/15/upload.jpg",
  unavailableAt: null,
  conversation: { password: null, passwordVersion: 0, userId: "user_1" },
};

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const world = {
  session: null as unknown,
  rows: [] as AttachmentRow[],
  queries: [] as Array<Record<string, unknown>>,
  unlockGranted: true,
  readKeys: [] as string[],
  readMaxBytes: [] as number[],
  readError: null as Error | null,
  writes: 0,
};

const resetWorld = () => {
  world.session = { user: { id: "user_1" } };
  world.rows = [{ ...SENT, conversation: { ...SENT.conversation! } }];
  world.queries = [];
  world.unlockGranted = true;
  world.readKeys = [];
  world.readMaxBytes = [];
  world.readError = null;
  world.writes = 0;
};

let mocksInstalled = false;

const loadRoute = async () => {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
      string,
      unknown
    >;
    const realLock = require(resolve(ROOT, "lib/conversationLock.ts")) as Record<
      string,
      unknown
    >;

    mock.module(mod("lib/chatRouteSession.ts"), {
      namedExports: {
        resolveChatRouteSession: async () => ({ session: world.session }),
      },
    });
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => undefined,
      },
    });
    mock.module(mod("lib/conversationLock.ts"), {
      namedExports: {
        ...realLock,
        hasConversationUnlockGrant: () => world.unlockGranted,
      },
    });
    const refuseWrite = async () => {
      world.writes += 1;
      throw new Error("the preview route must not write");
    };
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          messageAttachment: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
              world.queries.push(where);
              return (
                world.rows.find(
                  (row) => row.id === where.id && row.userId === where.userId
                ) ?? null
              );
            },
            update: refuseWrite,
            updateMany: refuseWrite,
          },
        },
      },
    });
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        readOwnR2ObjectBytes: async (key: string, options: { maxBytes: number }) => {
          world.readKeys.push(key);
          world.readMaxBytes.push(options.maxBytes);
          if (world.readError) throw world.readError;
          return JPEG_BYTES;
        },
      },
    });
  }
  return import(mod("app/api/attachments/[attachmentId]/preview/route.ts"));
};

const request = () =>
  new Request("http://127.0.0.1:3100/api/attachments/att_1/preview", {
    method: "GET",
  });
const context = (attachmentId = "att_1") => ({
  params: Promise.resolve({ attachmentId }),
});

const silenceConsole = () => {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
};

/* -------------------------------------------------------------------------- */

test("a signed-out visitor is refused before any lookup", async () => {
  resetWorld();
  world.session = null;
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 401);
  assert.equal(world.queries.length, 0);
});

test("the owner gets the picture inline, with headers that keep it a picture", async () => {
  resetWorld();
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(body, JPEG_BYTES);
  assert.equal(response.headers.get("content-length"), String(body.byteLength));
  assert.deepEqual(world.readKeys, [SENT.objectKey]);
  // Never more than the row says it stored.
  assert.deepEqual(world.readMaxBytes, [SENT.size]);
});

test("the storage key never reaches the response", async () => {
  resetWorld();
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  const headers = JSON.stringify([...response.headers]);
  assert.ok(!headers.includes("message-attachments/"));
  assert.ok(!headers.includes("upload.jpg"));
});

test("ownership is part of the lookup, not a check after it", async () => {
  resetWorld();
  const { GET } = await loadRoute();
  await GET(request(), context());
  assert.deepEqual(world.queries[0], { id: "att_1", userId: "user_1" });
});

test("another user's picture is not found, the same as a missing one", async () => {
  resetWorld();
  world.session = { user: { id: "user_2" } };
  const { GET } = await loadRoute();
  const notYours = await GET(request(), context());
  const missing = await GET(request(), context("att_missing"));

  assert.equal(notYours.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await notYours.json(), await missing.json());
  assert.equal(world.readKeys.length, 0);
});

for (const mediaType of [
  "application/pdf",
  "image/svg+xml",
  "text/plain",
  "application/zip",
]) {
  test(`a ${mediaType} file has no thumbnail`, async () => {
    resetWorld();
    world.rows[0].mediaType = mediaType;
    const { GET } = await loadRoute();
    const response = await GET(request(), context());

    assert.equal(response.status, 404);
    assert.equal(world.readKeys.length, 0);
  });
}

test("a file storage already lost is not read again", async () => {
  resetWorld();
  world.rows[0].unavailableAt = new Date("2026-11-15T00:00:00Z");
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 404);
  assert.equal(world.readKeys.length, 0);
});

test("a row whose conversation belongs to somebody else is refused", async () => {
  resetWorld();
  world.rows[0].conversation = { password: null, passwordVersion: 0, userId: "user_9" };
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 404);
  assert.equal(world.readKeys.length, 0);
});

test("a locked conversation refuses without an unlock grant", async () => {
  resetWorld();
  world.rows[0].conversation = { password: "hashed", passwordVersion: 1, userId: "user_1" };
  world.unlockGranted = false;
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 423);
  assert.equal((await response.json()).code, "CONVERSATION_LOCKED");
  assert.equal(world.readKeys.length, 0);
});

test("a storage failure is a 404 and never marks the file unavailable", async () => {
  resetWorld();
  world.readError = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
  const restore = silenceConsole();
  try {
    const { GET } = await loadRoute();
    const response = await GET(request(), context());
    assert.equal(response.status, 404);
    assert.equal(world.writes, 0);
  } finally {
    restore();
  }
});
