// Contract: the image routes that hand out a conversation's pictures -- the
// download, the group read and the by-id read -- follow the conversation's lock
// on the web as its attachments and generated files do (423 without the unlock
// grant), while an image workspace or Studio conversation, which has no
// password, reads exactly as before.

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
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "image-lock-routes-contract-2026";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const world = {
  password: null as string | null,
  unlockGranted: false,
  unlockChecks: [] as Array<{ conversationId: string; passwordVersion: number | null }>,
  readKeys: [] as string[],
};

let mocksInstalled = false;

const lockOf = () => ({ password: world.password, passwordVersion: 3 });

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    const realLock = require(resolve(ROOT, "lib/conversationLock.ts")) as Record<string, unknown>;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => ({ user: { id: "user-1" } }) },
    });
    mock.module(mod("lib/chatRouteSession.ts"), {
      namedExports: { resolveChatRouteSession: async () => ({ session: { user: { id: "user-1" } } }) },
    });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
    });
    mock.module(mod("lib/conversationLock.ts"), {
      namedExports: {
        ...realLock,
        hasConversationUnlockGrant: (
          _request: Request,
          _userId: string,
          conversationId: string,
          passwordVersion: number | null
        ) => {
          world.unlockChecks.push({ conversationId, passwordVersion });
          return passwordVersion === null || world.unlockGranted;
        },
      },
    });
    mock.module(mod("lib/imageGenerationRead.ts"), {
      namedExports: {
        IMAGE_GROUP_READ_SELECT: {},
        IMAGE_GENERATION_READ_SELECT: {},
        serializeImageGroup: async () => ({ groupId: "group-1", signedUrl: "https://signed.example/x" }),
        serializeImageGeneration: async () => ({ id: "gen-1", signedUrl: "https://signed.example/x" }),
      },
    });
    mock.module(mod("lib/imageGenerationSignals.ts"), {
      namedExports: { recordImageGenerationSignal: async () => undefined },
    });
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        readOwnR2ObjectBytes: async (key: string) => {
          world.readKeys.push(key);
          return PNG;
        },
      },
    });
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          conversation: {
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
              where.id === "conv-1" && where.userId === "user-1" ? lockOf() : null,
          },
          imageGenerationGroup: {
            findUnique: async () => ({ id: "group-1", userId: "user-1", conversationId: "conv-1", targets: [] }),
          },
          imageCreditReservation: {
            findMany: async () => [],
            findUnique: async () => null,
          },
          imageGeneration: {
            findUnique: async () => ({ id: "gen-1", userId: "user-1", conversationId: "conv-1" }),
            findFirst: async () => ({
              id: "gen-1",
              status: "succeeded",
              modelId: "gpt-image-2",
              conversationId: "conv-1",
              conversation: lockOf(),
              assets: [{ r2Key: "images/original.png", mimeType: "image/png", byteSize: 16, role: "original" }],
            }),
          },
        },
      },
    });
  }
  return {
    group: await import(mod("app/api/images/groups/[groupId]/route.ts")),
    byId: await import(mod("app/api/images/generations/[generationId]/route.ts")),
    download: await import(mod("app/api/images/generations/[generationId]/download/route.ts")),
  };
}

const reset = () => {
  world.password = null;
  world.unlockGranted = false;
  world.unlockChecks = [];
  world.readKeys = [];
};

const get = () => new Request("http://127.0.0.1:3100/api/images/x", { method: "GET" });
const groupParams = { params: Promise.resolve({ groupId: "group-1" }) };
const generationParams = { params: Promise.resolve({ generationId: "gen-1" }) };

test("a locked conversation's images are refused on the web without the unlock grant", async () => {
  reset();
  world.password = "hashed";
  const { group, byId, download } = await load();

  for (const response of [
    await group.GET(get(), groupParams),
    await byId.GET(get(), generationParams),
    await download.GET(get(), generationParams),
  ]) {
    assert.equal(response.status, 423);
    assert.equal((await response.json()).code, "CONVERSATION_LOCKED");
  }
  // No bytes were read for a locked conversation, and the check was made
  // against the conversation's current password version.
  assert.deepEqual(world.readKeys, []);
  assert.ok(world.unlockChecks.every((check) => check.conversationId === "conv-1" && check.passwordVersion === 3));
  assert.equal(world.unlockChecks.length, 3);
});

test("the same conversation is served once it is unlocked", async () => {
  reset();
  world.password = "hashed";
  world.unlockGranted = true;
  const { group, byId, download } = await load();

  assert.equal((await group.GET(get(), groupParams)).status, 200);
  assert.equal((await byId.GET(get(), generationParams)).status, 200);
  const file = await download.GET(get(), generationParams);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("Content-Type"), "image/png");
  assert.deepEqual(world.readKeys, ["images/original.png"]);
});

test("a conversation without a password reads exactly as before", async () => {
  reset();
  const { group, byId, download } = await load();

  assert.equal((await group.GET(get(), groupParams)).status, 200);
  assert.equal((await byId.GET(get(), generationParams)).status, 200);
  assert.equal((await download.GET(get(), generationParams)).status, 200);
  // Not locked: the grant is asked with no password version, which always passes.
  assert.ok(world.unlockChecks.every((check) => check.passwordVersion === null));
});
