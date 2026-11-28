// Contract: the orphan sweep of generated files keeps its position between runs,
// so old files that have rows cannot stand in front of an orphan forever, and
// it still deletes only an object with no row that is older than the TTL.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const PREFIX = "message-artifacts/";
const NOW = new Date("2026-11-28T12:00:00Z");
const OLD = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const FRESH = new Date(NOW.getTime() - 60 * 1000);

type Stored = { key: string; lastModified: Date };
let bucket: Stored[] = [];
let referencedKeys = new Set<string>();
let settings = new Map<string, string>();
let deletedKeys: string[] = [];
let listCalls: Array<{ startAfter?: string | null; maxKeys?: number }> = [];
let failDeleteFor: string | null = null;
let mocksInstalled = false;

const PAGE = 3;

async function load() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("lib/prisma.ts"), {
      namedExports: {
        prisma: {
          messageArtifact: {
            findMany: async ({ where }: { where: { objectKey: { in: string[] } } }) =>
              where.objectKey.in
                .filter((key) => referencedKeys.has(key))
                .map((objectKey) => ({ objectKey })),
          },
          appSetting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
              settings.has(where.key) ? { value: settings.get(where.key) } : null,
            upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
              settings.set(where.key, create.value);
              return {};
            },
            deleteMany: async ({ where }: { where: { key: string } }) => {
              settings.delete(where.key);
              return { count: 1 };
            },
          },
        },
      },
    });
    mock.module(mod("lib/r2.ts"), {
      namedExports: {
        writeR2Object: async () => undefined,
        deleteR2Object: async (key: string) => {
          if (key === failDeleteFor) throw new Error("storage refused");
          deletedKeys.push(key);
        },
        listR2ObjectsPage: async (
          _prefix: string,
          options: { startAfter?: string | null; maxKeys?: number } = {}
        ) => {
          listCalls.push(options);
          const sorted = [...bucket].sort((a, b) => a.key.localeCompare(b.key));
          const from = options.startAfter
            ? sorted.findIndex((object) => object.key > (options.startAfter as string))
            : 0;
          const rest = from < 0 ? [] : sorted.slice(from);
          const objects = rest.slice(0, PAGE);
          return {
            objects,
            nextStartAfter: rest.length > PAGE ? objects[objects.length - 1].key : null,
          };
        },
      },
    });
  }
  return import(mod("lib/generatedArtifactStorage.ts"));
}

const reset = () => {
  bucket = [];
  referencedKeys = new Set();
  settings = new Map();
  deletedKeys = [];
  listCalls = [];
  failDeleteFor = null;
};

const object = (name: string, lastModified = OLD): Stored => ({ key: `${PREFIX}${name}`, lastModified });

test("old files with rows in front of an orphan no longer stall the sweep", async () => {
  reset();
  const { sweepOrphanedArtifactObjects } = await load();
  // Six old files that are in use, then an orphan in key order.
  for (const name of ["a1", "a2", "a3", "b1", "b2", "b3"]) {
    bucket.push(object(name));
    referencedKeys.add(`${PREFIX}${name}`);
  }
  bucket.push(object("c-orphan"));

  const first = await sweepOrphanedArtifactObjects(NOW);
  assert.deepEqual(first, { examined: 3, deleted: 0, failed: 0 });
  const second = await sweepOrphanedArtifactObjects(NOW);
  assert.deepEqual(second, { examined: 3, deleted: 0, failed: 0 });
  assert.deepEqual(deletedKeys, []);
  // The third run reaches the orphan, and the listing then wraps to the start.
  const third = await sweepOrphanedArtifactObjects(NOW);
  assert.deepEqual(third, { examined: 1, deleted: 1, failed: 0 });
  assert.deepEqual(deletedKeys, [`${PREFIX}c-orphan`]);
  assert.equal(settings.size, 0);
  assert.equal(listCalls[0].startAfter ?? null, null);
  assert.equal(listCalls[1].startAfter, `${PREFIX}a3`);
});

test("only an old object with no row is ever deleted", async () => {
  reset();
  const { sweepOrphanedArtifactObjects } = await load();
  bucket.push(object("a-used"), object("b-orphan"), object("c-fresh", FRESH));
  referencedKeys.add(`${PREFIX}a-used`);
  const result = await sweepOrphanedArtifactObjects(NOW);
  assert.deepEqual(result, { examined: 2, deleted: 1, failed: 0 });
  assert.deepEqual(deletedKeys, [`${PREFIX}b-orphan`]);
});

test("a failed delete is counted and the sweep moves on", async () => {
  reset();
  const { sweepOrphanedArtifactObjects } = await load();
  bucket.push(object("a-orphan"), object("b-orphan"));
  failDeleteFor = `${PREFIX}a-orphan`;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await sweepOrphanedArtifactObjects(NOW), { examined: 2, deleted: 1, failed: 1 });
  } finally {
    console.error = originalError;
  }
});

test("a saved position outside the prefix is ignored", async () => {
  reset();
  const { sweepOrphanedArtifactObjects, ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY } = await load();
  settings.set(ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY, "attachments/someone-elses-key");
  bucket.push(object("a-orphan"));
  const result = await sweepOrphanedArtifactObjects(NOW);
  assert.equal(listCalls[0].startAfter ?? null, null);
  assert.equal(result.deleted, 1);
});

test("a failed delete keeps the sweep's position before that key, and a second failure there lets it go", async () => {
  reset();
  const { sweepOrphanedArtifactObjects, ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY } = await load();
  // a-1 and a-2 are in use, a-3 is an orphan that cannot be deleted, b-1 is fine.
  for (const name of ["a-1", "a-2"]) {
    bucket.push(object(name));
    referencedKeys.add(`${PREFIX}${name}`);
  }
  bucket.push(object("a-3"), object("b-1"), object("b-2"), object("b-3"));
  referencedKeys.add(`${PREFIX}b-1`);
  referencedKeys.add(`${PREFIX}b-2`);
  referencedKeys.add(`${PREFIX}b-3`);
  failDeleteFor = `${PREFIX}a-3`;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    // First page is a-1..a-3: the delete of a-3 fails, so the next run starts after a-2.
    assert.equal((await sweepOrphanedArtifactObjects(NOW)).failed, 1);
    assert.equal(settings.get(ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY), `${PREFIX}a-2`);
    // It is tried again, first in its page, and fails again: now the sweep moves on.
    assert.equal((await sweepOrphanedArtifactObjects(NOW)).failed, 1);
    assert.equal(listCalls[1].startAfter, `${PREFIX}a-2`);
    assert.equal(settings.get(ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY), `${PREFIX}b-2`);
    // Once the delete works, the retry deletes it.
    failDeleteFor = null;
    settings.set(ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY, `${PREFIX}a-2`);
    assert.deepEqual(await sweepOrphanedArtifactObjects(NOW), { examined: 3, deleted: 1, failed: 0 });
    assert.deepEqual(deletedKeys, [`${PREFIX}a-3`]);
  } finally {
    console.error = originalError;
  }
});

test("a delete that fails on the very first key holds the sweep at the start of the prefix, once", async () => {
  reset();
  const { sweepOrphanedArtifactObjects, ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY } = await load();
  bucket.push(object("a-1"), object("a-2"), object("a-3"), object("a-4"));
  referencedKeys.add(`${PREFIX}a-2`);
  referencedKeys.add(`${PREFIX}a-3`);
  referencedKeys.add(`${PREFIX}a-4`);
  failDeleteFor = `${PREFIX}a-1`;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await sweepOrphanedArtifactObjects(NOW);
    assert.equal(settings.get(ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY), PREFIX);
    await sweepOrphanedArtifactObjects(NOW);
    assert.equal(settings.get(ARTIFACT_ORPHAN_SWEEP_CURSOR_KEY), `${PREFIX}a-3`);
  } finally {
    console.error = originalError;
  }
});
