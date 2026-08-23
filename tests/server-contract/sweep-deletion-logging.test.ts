import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The three tombstone drains that ride along on the fifteen-minute cron used
 * to delete objects and say nothing.
 *
 * Each computed `deleted`, returned it, and had it written into
 * `ScheduledJobRun.result` — a JSON column no query reads. The cron script
 * logged only the credit-reservation object, and the admin panel renders
 * `processedCount`, which is that same object. So a run that deleted two
 * hundred files and a run that deleted none produced identical output, and
 * "did the sweep work?" had no answer short of counting rows by hand.
 *
 * `message_attachment_cleanup_swept` was already doing this correctly, so the
 * three new lines copy its shape and its gate rather than inventing a second
 * convention. The gate matters as much as the line: a log entry every fifteen
 * minutes saying nothing happened is what buries the entry that matters, which
 * is the same reason `billing_price_catalog_fallback` stays silent on the
 * normal path (AGENTS.md).
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

type QueueRow = { id: string; r2Key?: string; objectKey?: string };

type World = {
  pending: QueueRow[];
  exhausted: number;
  deleteFails: Set<string>;
  logs: string[];
};

const world: World = {
  pending: [],
  exhausted: 0,
  deleteFails: new Set(),
  logs: [],
};

/** One queue model, shared by all three drains: they have the same shape. */
const queueModel = () => ({
  findMany: async () => world.pending,
  count: async () => world.exhausted,
  update: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
});

let loaded: Promise<{
  drainKnowledgeCleanupQueue: (
    limit?: number,
    now?: Date
  ) => Promise<{ deleted: number }>;
  drainImageAssetCleanupQueue: (
    limit?: number,
    now?: Date
  ) => Promise<{ deleted: number }>;
  drainArtifactCleanupQueue: (
    limit?: number,
    now?: Date
  ) => Promise<{ deleted: number }>;
}> | null = null;

const load = () => {
  if (!loaded) {
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          assistantKnowledgeCleanup: queueModel(),
          imageAssetCleanup: queueModel(),
          messageArtifactCleanup: queueModel(),
        },
      },
    });
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        deleteR2Object: async (key: string) => {
          if (world.deleteFails.has(key)) throw new Error("storage refused");
        },
      },
    });
    loaded = (async () => {
      const knowledge = await import(mod("lib/assistantKnowledgeLifecycle.ts"));
      const image = await import(mod("lib/imageAssetLifecycle.ts"));
      const artifact = await import(mod("lib/generatedArtifactStorage.ts"));
      return {
        drainKnowledgeCleanupQueue: knowledge.drainKnowledgeCleanupQueue,
        drainImageAssetCleanupQueue: image.drainImageAssetCleanupQueue,
        drainArtifactCleanupQueue: artifact.drainArtifactCleanupQueue,
      };
    })();
  }
  return loaded;
};

const captureLogs = async (run: () => Promise<unknown>) => {
  const original = console.info;
  world.logs = [];
  console.info = (...args: unknown[]) => {
    world.logs.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.info = original;
  }
  return world.logs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
};

const DRAINS = [
  { event: "assistant_knowledge_cleanup_swept", key: "r2Key" as const },
  { event: "image_asset_cleanup_swept", key: "r2Key" as const },
  { event: "generated_artifact_cleanup_swept", key: "objectKey" as const },
];

const drainFor = async (index: number) => {
  const api = await load();
  return [
    api.drainKnowledgeCleanupQueue,
    api.drainImageAssetCleanupQueue,
    api.drainArtifactCleanupQueue,
  ][index];
};

test("each drain reports what it deleted", async () => {
  for (const [index, { event, key }] of DRAINS.entries()) {
    world.pending = [
      { id: "a", [key]: "key-a" },
      { id: "b", [key]: "key-b" },
      { id: "c", [key]: "key-c" },
    ];
    world.exhausted = 4;
    world.deleteFails = new Set(["key-c"]);

    const drain = await drainFor(index);
    const entries = await captureLogs(() => drain(200, new Date("2026-08-23T11:00:00Z")));
    const entry = entries.find((line) => line.event === event);

    assert.ok(entry, `${event} was not emitted`);
    assert.equal(entry.examined, 3);
    assert.equal(entry.deleted, 2);
    assert.equal(entry.failed, 1);
    assert.equal(entry.exhausted, 4);
    assert.equal(entry.timestamp, "2026-08-23T11:00:00.000Z");
  }
});

test("a drain with nothing to do says nothing", async () => {
  // The gate, not decoration. At four runs an hour, an unconditional line is
  // ~35,000 entries a year that mean "no change" -- and the one entry that
  // means a backlog stopped draining sits among them.
  for (const [index, { event }] of DRAINS.entries()) {
    world.pending = [];
    world.exhausted = 0;
    world.deleteFails = new Set();

    const drain = await drainFor(index);
    const entries = await captureLogs(() => drain(200, new Date()));

    assert.equal(
      entries.filter((line) => line.event === event).length,
      0,
      `${event} was emitted for a no-op run`
    );
  }
});

test("an empty queue with an exhausted backlog still reports", async () => {
  // Nothing to drain and rows stuck at the attempt ceiling is the state that
  // most needs saying: the queue looks idle and is not empty.
  for (const [index, { event }] of DRAINS.entries()) {
    world.pending = [];
    world.exhausted = 7;
    world.deleteFails = new Set();

    const drain = await drainFor(index);
    const entries = await captureLogs(() => drain(200, new Date()));
    const entry = entries.find((line) => line.event === event);

    assert.ok(entry, `${event} was not emitted for an exhausted backlog`);
    assert.equal(entry.examined, 0);
    assert.equal(entry.deleted, 0);
    assert.equal(entry.exhausted, 7);
  }
});
