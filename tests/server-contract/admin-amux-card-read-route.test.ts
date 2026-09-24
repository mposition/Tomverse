import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type ReadResult =
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "invalid_provenance" }
  | { kind: "found"; card: Record<string, unknown> };

const world: {
  session: { user: { id: string } } | null;
  authorized: boolean;
  result: ReadResult;
  readCalls: string[];
} = {
  session: { user: { id: "admin-1" } },
  authorized: true,
  result: { kind: "missing" },
  readCalls: [],
};

let installed = false;

async function loadRoute(): Promise<{ GET: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", {
      namedExports: { getServerSession: async () => world.session },
    });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: { isAdminSession: () => world.authorized },
    });
    mock.module(mod("lib/auth.ts"), {
      namedExports: { authOptions: {} },
    });
    mock.module(mod("lib/amux/cardRead.ts"), {
      namedExports: {
        readAmuxCardBySourceKey: async (sourceKey: string) => {
          world.readCalls.push(sourceKey);
          return world.result;
        },
      },
    });
  }
  return import(mod("app/api/admin/amux/card/route.ts"));
}

const request = (query = "") =>
  new Request(`https://tomverse.app/api/admin/amux/card${query}`);

const assertNoStore = (response: Response) =>
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");

const reset = () => {
  world.session = { user: { id: "admin-1" } };
  world.authorized = true;
  world.result = { kind: "missing" };
  world.readCalls = [];
};

test("authentication fails closed before parsing or reading a card", async () => {
  const { GET } = await loadRoute();
  for (const setup of [
    () => (world.session = null),
    () => (world.authorized = false),
  ]) {
    reset();
    setup();
    const response = await GET(request("?sourceKey=CHAT-01"));
    assert.equal(response.status, 404);
    assertNoStore(response);
    assert.deepEqual(await response.json(), { error: "Not found." });
    assert.deepEqual(world.readCalls, []);
  }
});

test("missing, duplicate, normalized, and malformed source keys never reach storage", async () => {
  const { GET } = await loadRoute();
  for (const query of [
    "",
    "?sourceKey=CHAT-01&sourceKey=CHAT-01",
    "?sourceKey=CHAT-01&extra=value",
    "?sourceKey=chat-01",
    "?sourceKey=%20CHAT-01",
    "?sourceKey=CHAT_01",
    `?sourceKey=${"A".repeat(65)}`,
  ]) {
    reset();
    const response = await GET(request(query));
    assert.equal(response.status, 400, query);
    assertNoStore(response);
    assert.deepEqual(world.readCalls, [], query);
  }
});

test("the exact key distinguishes missing, ambiguous, invalid, and found cards", async () => {
  const { GET } = await loadRoute();
  const scenarios: Array<[ReadResult, number, object]> = [
    [{ kind: "missing" }, 404, { error: "Not found." }],
    [{ kind: "ambiguous" }, 409, { error: "Source key is ambiguous." }],
    [
      { kind: "invalid_provenance" },
      409,
      { error: "Canonical source metadata is unavailable." },
    ],
    [
      { kind: "found", card: { sourceKey: "CHAT-01", status: "doing" } },
      200,
      { card: { sourceKey: "CHAT-01", status: "doing" } },
    ],
  ];

  for (const [result, status, body] of scenarios) {
    reset();
    world.result = result;
    const response = await GET(request("?sourceKey=CHAT-01"));
    assert.equal(response.status, status, result.kind);
    assertNoStore(response);
    assert.deepEqual(await response.json(), body);
    assert.deepEqual(world.readCalls, ["CHAT-01"]);
  }
});

test("the route and service contain no write, audit, preview, or rate-bucket path", () => {
  const route = readFileSync(resolve(ROOT, "app/api/admin/amux/card/route.ts"), "utf8");
  const service = readFileSync(resolve(ROOT, "lib/amux/cardRead.ts"), "utf8");
  for (const forbidden of [
    "writeAdminAuditLog",
    "writeSystemAuditLog",
    "consumeApiRateLimit",
    "previewBoard",
    "readLimitedJson",
    "POST(",
    "PUT(",
    "PATCH(",
    "DELETE(",
    ".$transaction(",
    ".create(",
    ".update(",
    ".upsert(",
    ".delete(",
    ".$executeRaw",
  ]) {
    assert.equal(route.includes(forbidden), false, forbidden);
    assert.equal(service.includes(forbidden), false, forbidden);
  }
  assert.match(service, /sourceSystem:\s*BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM/);
  assert.match(service, /sourceKey,/);
  assert.match(service, /take:\s*2/);
  assert.match(service, /take:\s*AMUX_CARD_READ_MAX_DEPENDENCIES \+ 1/);
  assert.match(route, /export async function GET/);
});
