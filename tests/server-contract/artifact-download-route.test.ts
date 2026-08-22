// Contract: who may download a generated file, and what the response says.
//
// docs/policy/generated-artifacts.md section 5. Four rules, and three of them
// exist because a distinguishable refusal would tell an attacker something:
//
//   * a row that is not yours is a 404, and so is a row that does not exist;
//   * a locked conversation is a 423 -- the one deliberate exception, because
//     the person being refused is the owner and hiding the reason from them
//     would only lose them the unlock prompt;
//   * a `failed` row has no file, so it is a 404 too; and
//   * the object key never appears in the response, in any shape.
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
process.env.NEXTAUTH_SECRET ||= "artifact-download-contract-2026";

const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type ArtifactRow = {
  id: string;
  conversationId: string;
  format: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  status: string;
  objectKey: string | null;
  conversation: { password: string | null; userId: string } | null;
};

const READY: ArtifactRow = {
  id: "art_1",
  conversationId: "conv_1",
  format: "xlsx",
  filename: "분기별_매출.xlsx",
  mediaType: XLSX_MEDIA_TYPE,
  byteSize: 12,
  status: "ready",
  objectKey: "message-artifacts/user_1/conv_1/art_1.xlsx",
  conversation: { password: null, userId: "user_1" },
};

const world = {
  session: null as unknown,
  /** Rows the fake database holds, keyed the way `findFirst` scopes them. */
  rows: [] as Array<ArtifactRow & { userId: string }>,
  /** Every `where` the route asked for, so the scoping itself is assertable. */
  queries: [] as Array<Record<string, unknown>>,
  unlockGranted: true,
  readKeys: [] as string[],
};

const resetWorld = () => {
  world.session = { user: { id: "user_1" } };
  world.rows = [{ ...READY, userId: "user_1" }];
  world.queries = [];
  world.unlockGranted = true;
  world.readKeys = [];
};

let mocksInstalled = false;

const loadRoute = async () => {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(
      resolve(ROOT, "lib/apiSecurity.ts")
    ) as Record<string, unknown>;
    const realLock = require(resolve(ROOT, "lib/conversationLock.ts")) as Record<
      string,
      unknown
    >;

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
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          messageArtifact: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
              world.queries.push(where);
              return (
                world.rows.find(
                  (row) =>
                    row.id === where.id && row.userId === where.userId
                ) ?? null
              );
            },
          },
        },
      },
    });
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        readOwnR2ObjectBytes: async (key: string) => {
          world.readKeys.push(key);
          return Buffer.from("PK\u0003\u0004fake-xlsx");
        },
      },
    });
  }
  return import(mod("app/api/artifacts/[artifactId]/route.ts"));
};

const request = () =>
  new Request("http://127.0.0.1:3100/api/artifacts/art_1", { method: "GET" });
const context = (artifactId = "art_1") => ({
  params: Promise.resolve({ artifactId }),
});

/* -------------------------------------------------------------------------- */

test("a signed-out visitor is refused before any lookup", async () => {
  resetWorld();
  world.session = null;
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 401);
  assert.equal(world.queries.length, 0);
});

test("the owner gets the file, with the headers a download needs", async () => {
  resetWorld();
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), XLSX_MEDIA_TYPE);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const disposition = response.headers.get("content-disposition") ?? "";
  assert.ok(disposition.startsWith("attachment; "));
  // A quoted `filename` is literal, so the Korean name travels in `filename*`.
  assert.match(disposition, /filename="generated\.xlsx"/);
  assert.ok(
    disposition.includes(
      `filename*=UTF-8''${encodeURIComponent("분기별_매출.xlsx")}`
    )
  );

  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-length"), String(body.byteLength));
  assert.deepEqual(world.readKeys, [READY.objectKey]);
});

test("the storage key never reaches the response", async () => {
  resetWorld();
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  const headers = JSON.stringify([...response.headers]);
  assert.ok(!headers.includes("message-artifacts/"));
  assert.ok(!headers.includes("art_1.xlsx"));
});

test("ownership is part of the lookup, not a check after it", async () => {
  // The route cannot tell "not yours" from "not there" even internally,
  // because there is no branch that separates them.
  resetWorld();
  const { GET } = await loadRoute();
  await GET(request(), context());
  assert.deepEqual(world.queries[0], { id: "art_1", userId: "user_1" });
});

test("another user's artifact is not found, not forbidden", async () => {
  resetWorld();
  world.session = { user: { id: "user_2" } };
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 404);
  assert.equal(world.readKeys.length, 0);
  // The same answer an id that never existed gets.
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("an id that does not exist answers exactly the same way", async () => {
  resetWorld();
  const { GET } = await loadRoute();
  const response = await GET(request(), context("art_missing"));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("a locked conversation refuses without an unlock grant", async () => {
  resetWorld();
  world.rows[0].conversation = { password: "hashed", userId: "user_1" };
  world.unlockGranted = false;
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 423);
  assert.equal((await response.json()).code, "CONVERSATION_LOCKED");
  assert.equal(world.readKeys.length, 0);
});

test("the same locked conversation serves the file once it is unlocked", async () => {
  resetWorld();
  world.rows[0].conversation = { password: "hashed", userId: "user_1" };
  world.unlockGranted = true;
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 200);
  assert.deepEqual(world.readKeys, [READY.objectKey]);
});

test("a failed artifact has no file to serve", async () => {
  resetWorld();
  world.rows[0] = {
    ...world.rows[0],
    status: "failed",
    objectKey: null,
    byteSize: 0,
  };
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 404);
  assert.equal(world.readKeys.length, 0);
});

test("a row whose conversation belongs to somebody else is refused", async () => {
  // Belt and braces: the denormalised userId alone must not be enough.
  resetWorld();
  world.rows[0].conversation = { password: null, userId: "user_9" };
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 404);
  assert.equal(world.readKeys.length, 0);
});

test("a format with no generator is refused rather than served", async () => {
  // A row can only carry a format the CHECK constraint allows, so this is a
  // row written by a build that knew a format this one does not. Serving it
  // would mean answering with a media type nothing here can name.
  resetWorld();
  world.rows[0] = { ...world.rows[0], format: "psd" };
  const { GET } = await loadRoute();
  const response = await GET(request(), context());

  assert.equal(response.status, 404);
  assert.equal(world.readKeys.length, 0);
});
