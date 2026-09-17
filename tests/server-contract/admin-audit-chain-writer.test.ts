import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";

import { computeAdminAuditEntryHash } from "../../lib/adminAuditIntegrityCore.ts";

/**
 * `writeAdminAuditLog` — what the live writer does, statement by statement.
 *
 * Every administrator action in the console lands in this function, and the
 * hash chain it extends is only as good as the order it does things in: take
 * the chain lock, read the database clock, read the newest hashed row, hash,
 * insert. A refactor that moves one of those — reads the previous hash before
 * the lock, or stamps the row with the process clock — still writes rows, and
 * the chain still looks fine until two writers race.
 *
 * So these tests pin the sequence against a recording client rather than
 * describing it. The marketing policy (docs/policy/marketing-automation.md §6)
 * requires a system-actor writer that shares this lock and hash path, and that
 * writer is added by moving this code, not copying it; these assertions are
 * what has to stay green across the move.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type Call =
  | { kind: "executeRaw"; sql: string; values: unknown[] }
  | { kind: "queryRaw"; sql: string; values: unknown[] }
  | { kind: "findFirst"; args: unknown }
  | { kind: "create"; args: { data: Record<string, unknown>; select: unknown } }
  | { kind: "transaction" };

type World = {
  calls: Call[];
  databaseNow: Date | null;
  previousHash: string | null;
  previousCreatedAt: Date;
  clientIp: string | null;
  ipRequests: Request[];
};

let world: World;

// Whitespace inside a tagged template is layout, not SQL; the words and their
// order are what is pinned.
const statement = (strings: TemplateStringsArray) =>
  strings.join("?").replace(/\s+/g, " ").trim();

const recordingClient = (label: string) => ({
  label,
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    world.calls.push({ kind: "executeRaw", sql: statement(strings), values });
    return 1;
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    world.calls.push({ kind: "queryRaw", sql: statement(strings), values });
    return world.databaseNow ? [{ createdAt: world.databaseNow }] : [];
  },
  adminAuditLog: {
    findFirst: async (args: unknown) => {
      world.calls.push({ kind: "findFirst", args });
      return world.previousHash
        ? { entryHash: world.previousHash, createdAt: world.previousCreatedAt }
        : null;
    },
    create: async (args: {
      data: Record<string, unknown>;
      select: unknown;
    }) => {
      world.calls.push({ kind: "create", args });
      return { id: `created-by-${label}` };
    },
  },
});

const rootClient = {
  ...recordingClient("root"),
  $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
    world.calls.push({ kind: "transaction" });
    // The integrity key is read before the transaction opens. Swapping it here
    // makes a writer that reads it inside the locked span sign with the wrong
    // key, which the hash assertion then catches.
    process.env.ADMIN_AUDIT_INTEGRITY_KEY = "key-changed-inside-the-transaction-000";
    return fn(recordingClient("transaction"));
  },
};

let writer: typeof import("../../lib/adminAudit.ts").writeAdminAuditLog;

const SECRET = "admin-audit-chain-writer-test-secret-32";
const DATABASE_NOW = new Date("2026-09-17T01:02:03.456Z");

beforeEach(async () => {
  world = {
    calls: [],
    databaseNow: DATABASE_NOW,
    previousHash: "previous-entry-hash",
    previousCreatedAt: new Date("2026-09-17T01:00:00.000Z"),
    clientIp: "203.0.113.7",
    ipRequests: [],
  };
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = SECRET;
  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  if (!writer) {
    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: rootClient },
      defaultExport: rootClient,
    });
    mock.module(mod("lib/clientIp.ts"), {
      namedExports: {
        getTrustedClientIp: (request: Request) => {
          world.ipRequests.push(request);
          return world.clientIp;
        },
      },
    });
    ({ writeAdminAuditLog: writer } = await import(mod("lib/adminAudit.ts")));
  }
});

const session = {
  user: { id: "admin-1", email: "owner@example.test" },
  expires: "2026-09-18T00:00:00.000Z",
} as never;

const request = () =>
  new Request("https://tomverse.app/api/admin/example", {
    headers: { "user-agent": "characterization-agent" },
  });

const kinds = () => world.calls.map((call) => call.kind);

const createCall = () => {
  const call = world.calls.find((entry) => entry.kind === "create");
  assert.ok(call && call.kind === "create", "the writer must insert a row");
  return call.args;
};

test("inside a caller's transaction: lock, database clock, previous hash, insert — in that order, on that client", async () => {
  const tx = recordingClient("caller-tx");
  const id = await writer({
    session,
    request: request(),
    action: "example.updated",
    targetType: "Example",
    targetId: "example-1",
    summary: "Updated an example.",
    metadata: { reason: "characterization", nested: { b: 2, a: 1 } },
    tx: tx as never,
  });

  assert.equal(id, "created-by-caller-tx");
  assert.deepEqual(kinds(), ["executeRaw", "queryRaw", "findFirst", "create"]);
  assert.ok(
    !world.calls.some((call) => call.kind === "transaction"),
    "a caller's transaction must not be wrapped in another one"
  );

  const [lock, clock, previous] = world.calls;
  assert.equal(
    lock.kind === "executeRaw" && lock.sql,
    "SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))"
  );
  assert.deepEqual(lock.kind === "executeRaw" && lock.values, []);
  assert.equal(
    clock.kind === "queryRaw" && clock.sql,
    'SELECT clock_timestamp() AS "createdAt"'
  );
  assert.deepEqual(previous.kind === "findFirst" && previous.args, {
    where: { entryHash: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { entryHash: true, createdAt: true },
  });
});

test("the inserted row and its hash use the database clock and the previous entry's hash", async () => {
  const metadata = { reason: "characterization", nested: { b: 2, a: 1 } };
  await writer({
    session,
    request: request(),
    action: "example.updated",
    targetType: "Example",
    targetId: "example-1",
    summary: "Updated an example.",
    metadata,
    tx: recordingClient("caller-tx") as never,
  });

  const expectedHash = computeAdminAuditEntryHash(
    {
      previousHash: "previous-entry-hash",
      actorUserId: "admin-1",
      actorEmail: "owner@example.test",
      action: "example.updated",
      targetType: "Example",
      targetId: "example-1",
      summary: "Updated an example.",
      metadata,
      ipAddress: "203.0.113.7",
      userAgent: "characterization-agent",
      createdAt: DATABASE_NOW.toISOString(),
    },
    SECRET
  );

  assert.deepEqual(createCall(), {
    select: { id: true },
    data: {
      actorUserId: "admin-1",
      actorEmail: "owner@example.test",
      action: "example.updated",
      targetType: "Example",
      targetId: "example-1",
      summary: "Updated an example.",
      metadata,
      ipAddress: "203.0.113.7",
      userAgent: "characterization-agent",
      previousHash: "previous-entry-hash",
      entryHash: expectedHash,
      createdAt: DATABASE_NOW,
    },
  });
  assert.equal(world.ipRequests.length, 1, "the IP comes from the trusted-proxy reader");
});

test("without a caller transaction the writer opens its own and does everything inside it", async () => {
  const id = await writer({
    session,
    request: request(),
    action: "example.updated",
    targetType: "Example",
    summary: "Updated an example.",
  });

  assert.equal(id, "created-by-transaction");
  assert.deepEqual(kinds(), [
    "transaction",
    "executeRaw",
    "queryRaw",
    "findFirst",
    "create",
  ]);
});

test("without a caller transaction the key is resolved before the transaction opens", async () => {
  await writer({
    session,
    action: "example.updated",
    targetType: "Example",
    summary: "Own transaction.",
  });
  assert.equal(
    createCall().data.entryHash,
    computeAdminAuditEntryHash(
      {
        previousHash: "previous-entry-hash",
        actorUserId: "admin-1",
        actorEmail: "owner@example.test",
        action: "example.updated",
        targetType: "Example",
        targetId: null,
        summary: "Own transaction.",
        metadata: null,
        ipAddress: null,
        userAgent: null,
        createdAt: DATABASE_NOW.toISOString(),
      },
      SECRET
    )
  );
});

test("falsy JSON metadata is hashed as null and not stored", async () => {
  // `metadata || null` and `metadata || undefined`, not `??`: false, 0 and ""
  // have always been dropped. Changing that changes the HMAC input of rows
  // written from then on, so it is pinned rather than left to a tidy-up.
  for (const metadata of [false, 0, ""]) {
    world.calls = [];
    await writer({
      session,
      action: "example.updated",
      targetType: "Example",
      summary: "Falsy.",
      metadata,
      tx: recordingClient("caller-tx") as never,
    });
    const { data } = createCall();
    assert.equal(data.metadata, undefined, String(metadata));
    assert.equal(
      data.entryHash,
      computeAdminAuditEntryHash(
        {
          previousHash: "previous-entry-hash",
          actorUserId: "admin-1",
          actorEmail: "owner@example.test",
          action: "example.updated",
          targetType: "Example",
          targetId: null,
          summary: "Falsy.",
          metadata: null,
          ipAddress: null,
          userAgent: null,
          createdAt: DATABASE_NOW.toISOString(),
        },
        SECRET
      ),
      String(metadata)
    );
  }
});

test("the first hashed entry links to nothing", async () => {
  world.previousHash = null;
  await writer({
    session,
    action: "example.updated",
    targetType: "Example",
    summary: "First.",
    tx: recordingClient("caller-tx") as never,
  });
  const { data } = createCall();
  assert.equal(data.previousHash, null);
  assert.equal(
    data.entryHash,
    computeAdminAuditEntryHash(
      {
        previousHash: null,
        actorUserId: "admin-1",
        actorEmail: "owner@example.test",
        action: "example.updated",
        targetType: "Example",
        targetId: null,
        summary: "First.",
        metadata: null,
        ipAddress: null,
        userAgent: null,
        createdAt: DATABASE_NOW.toISOString(),
      },
      SECRET
    )
  );
});

test("summary is trimmed and cut at 500, the user agent cut at 500, an empty target id stored as null", async () => {
  const longAgent = "a".repeat(700);
  await writer({
    session,
    request: new Request("https://tomverse.app/x", {
      headers: { "user-agent": longAgent },
    }),
    action: "example.updated",
    targetType: "Example",
    targetId: "",
    summary: `   ${"s".repeat(600)}   `,
    tx: recordingClient("caller-tx") as never,
  });
  const { data } = createCall();
  assert.equal(data.summary, "s".repeat(500));
  assert.equal(data.userAgent, "a".repeat(500));
  assert.equal(data.targetId, null);
  assert.equal(data.metadata, undefined, "absent metadata is not stored as JSON null");
});

test("no request means no IP and no user agent, and the IP reader is not consulted", async () => {
  await writer({
    session,
    action: "example.updated",
    targetType: "Example",
    summary: "No request.",
    tx: recordingClient("caller-tx") as never,
  });
  const { data } = createCall();
  assert.equal(data.ipAddress, null);
  assert.equal(data.userAgent, null);
  assert.equal(world.ipRequests.length, 0);
});

test("a session without a user records no actor", async () => {
  await writer({
    session: { expires: "2026-09-18T00:00:00.000Z" } as never,
    action: "example.updated",
    targetType: "Example",
    summary: "No user.",
    tx: recordingClient("caller-tx") as never,
  });
  const { data } = createCall();
  assert.equal(data.actorUserId, null);
  assert.equal(data.actorEmail, null);
});

test("with no integrity key the row is still written, unhashed, and the previous hash is never read", async () => {
  delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  const previousNextAuthSecret = process.env.NEXTAUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  try {
    await writer({
      session,
      action: "example.updated",
      targetType: "Example",
      summary: "Unkeyed.",
      tx: recordingClient("caller-tx") as never,
    });
  } finally {
    if (previousNextAuthSecret !== undefined) {
      process.env.NEXTAUTH_SECRET = previousNextAuthSecret;
    }
  }
  assert.deepEqual(kinds(), ["executeRaw", "queryRaw", "create"]);
  const { data } = createCall();
  assert.equal(data.previousHash, null);
  assert.equal(data.entryHash, null);
});

test("a database clock read that returns no row falls back to a Date rather than failing the write", async () => {
  world.databaseNow = null;
  await writer({
    session,
    action: "example.updated",
    targetType: "Example",
    summary: "No clock row.",
    tx: recordingClient("caller-tx") as never,
  });
  const { data } = createCall();
  assert.ok(data.createdAt instanceof Date);
});

// --- The system-actor writer -------------------------------------------------
//
// docs/policy/marketing-automation.md §6: system actions share this chain. The
// system writer reaches the same append function, so the sequence above holds
// for it too; what these add is what differs -- no session fields, the actor
// marker, the required transaction -- and the reserved key both writers guard.

let systemWriter: typeof import("../../lib/adminAudit.ts").writeSystemAuditLog;
let RefusedError: typeof import("../../lib/adminAudit.ts").AuditWriteRefusedError;

const loadSystemWriter = async () => {
  if (!systemWriter) {
    ({ writeSystemAuditLog: systemWriter, AuditWriteRefusedError: RefusedError } =
      await import(mod("lib/adminAudit.ts")));
  }
};

test("a system entry takes the same lock, clock and previous hash on the caller's transaction", async () => {
  await loadSystemWriter();
  const id = await systemWriter({
    tx: recordingClient("caller-tx") as never,
    systemActor: "marketing-retention",
    action: "marketing_post.content_purged",
    targetType: "MarketingPost",
    targetId: "post-1",
    summary: "  Purged content past its retention.  ",
    metadata: { purgedCount: 1 },
  });

  assert.equal(id, "created-by-caller-tx");
  assert.deepEqual(kinds(), ["executeRaw", "queryRaw", "findFirst", "create"]);
  const [lock, clock] = world.calls;
  assert.equal(
    lock.kind === "executeRaw" && lock.sql,
    "SELECT pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))"
  );
  assert.equal(
    clock.kind === "queryRaw" && clock.sql,
    'SELECT clock_timestamp() AS "createdAt"'
  );

  const metadata = { purgedCount: 1, systemActor: "marketing-retention" };
  assert.deepEqual(createCall(), {
    select: { id: true },
    data: {
      actorUserId: null,
      actorEmail: null,
      action: "marketing_post.content_purged",
      targetType: "MarketingPost",
      targetId: "post-1",
      summary: "Purged content past its retention.",
      metadata,
      ipAddress: null,
      userAgent: null,
      previousHash: "previous-entry-hash",
      entryHash: computeAdminAuditEntryHash(
        {
          previousHash: "previous-entry-hash",
          actorUserId: null,
          actorEmail: null,
          action: "marketing_post.content_purged",
          targetType: "MarketingPost",
          targetId: "post-1",
          summary: "Purged content past its retention.",
          metadata,
          ipAddress: null,
          userAgent: null,
          createdAt: DATABASE_NOW.toISOString(),
        },
        SECRET
      ),
      createdAt: DATABASE_NOW,
    },
  });
  assert.equal(world.ipRequests.length, 0);
});

test("a system entry without metadata still carries its actor", async () => {
  await loadSystemWriter();
  await systemWriter({
    tx: recordingClient("caller-tx") as never,
    systemActor: "marketing-guard",
    action: "marketing_post.guard_evaluated",
    targetType: "MarketingPost",
    summary: "Evaluated.",
  });
  assert.deepEqual(createCall().data.metadata, { systemActor: "marketing-guard" });
});

const refusedBeforeAnyStatement = async (write: () => Promise<unknown>) => {
  await assert.rejects(write, (error: unknown) => error instanceof RefusedError);
  assert.deepEqual(kinds(), [], "a refused entry must not lock, read or insert");
};

test("the system writer refuses to run without the caller's transaction", async () => {
  await loadSystemWriter();
  await refusedBeforeAnyStatement(() =>
    systemWriter({
      systemActor: "marketing-guard",
      action: "x",
      targetType: "X",
      summary: "x",
    } as never)
  );
});

test("the system writer refuses an actor that is not listed", async () => {
  await loadSystemWriter();
  await refusedBeforeAnyStatement(() =>
    systemWriter({
      tx: recordingClient("caller-tx") as never,
      systemActor: "marketing-intern" as never,
      action: "x",
      targetType: "X",
      summary: "x",
    })
  );
});

test("the system writer refuses metadata that is not an object", async () => {
  await loadSystemWriter();
  await refusedBeforeAnyStatement(() =>
    systemWriter({
      tx: recordingClient("caller-tx") as never,
      systemActor: "marketing-guard",
      action: "x",
      targetType: "X",
      summary: "x",
      metadata: ["not", "an", "object"] as never,
    })
  );
});

test("neither writer lets a caller set the actor marker itself", async () => {
  await loadSystemWriter();
  await refusedBeforeAnyStatement(() =>
    systemWriter({
      tx: recordingClient("caller-tx") as never,
      systemActor: "marketing-guard",
      action: "x",
      targetType: "X",
      summary: "x",
      metadata: { systemActor: "marketing-publisher" },
    })
  );
  await refusedBeforeAnyStatement(() =>
    writer({
      session,
      action: "x",
      targetType: "X",
      summary: "x",
      metadata: { systemActor: "marketing-publisher" },
      tx: recordingClient("caller-tx") as never,
    })
  );
});

test("a nested key of the same name is ordinary metadata for the administrator writer", async () => {
  await writer({
    session,
    action: "x",
    targetType: "X",
    summary: "x",
    metadata: { detail: { systemActor: "free text" } },
    tx: recordingClient("caller-tx") as never,
  });
  assert.deepEqual(createCall().data.metadata, {
    detail: { systemActor: "free text" },
  });
});

test("an entry stamped at or before the chain head lands one millisecond after it", async () => {
  // Ids are random, so a same-millisecond entry could sort before the head and
  // fork the chain for the next writer; the database now refuses it too.
  world.previousCreatedAt = new Date(DATABASE_NOW.getTime());
  await writer({
    session,
    action: "example.updated",
    targetType: "Example",
    summary: "Same millisecond.",
    tx: recordingClient("caller-tx") as never,
  });
  const bumped = new Date(DATABASE_NOW.getTime() + 1);
  const { data } = createCall();
  assert.deepEqual(data.createdAt, bumped);
  assert.equal(
    data.entryHash,
    computeAdminAuditEntryHash(
      {
        previousHash: "previous-entry-hash",
        actorUserId: "admin-1",
        actorEmail: "owner@example.test",
        action: "example.updated",
        targetType: "Example",
        targetId: null,
        summary: "Same millisecond.",
        metadata: null,
        ipAddress: null,
        userAgent: null,
        createdAt: bumped.toISOString(),
      },
      SECRET
    )
  );
});
