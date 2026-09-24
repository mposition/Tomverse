import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

const findManyCalls: unknown[] = [];
const forbiddenDelegateAccesses: string[] = [];

const amuxWorkItem = new Proxy(
  {
    findMany: async (query: unknown) => {
      findManyCalls.push(query);
      return [];
    },
  },
  {
    get(target, property, receiver) {
      if (property === "findMany") return Reflect.get(target, property, receiver);
      forbiddenDelegateAccesses.push(`amuxWorkItem.${String(property)}`);
      throw new Error(`Unexpected AMUX card delegate access: ${String(property)}`);
    },
  },
);

const prisma = new Proxy(
  { amuxWorkItem },
  {
    get(target, property, receiver) {
      if (property === "amuxWorkItem") return Reflect.get(target, property, receiver);
      forbiddenDelegateAccesses.push(`prisma.${String(property)}`);
      throw new Error(`Unexpected Prisma access: ${String(property)}`);
    },
  },
);

mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma },
});

test("the service issues exactly one bounded canonical composite read and has no writer capability", async () => {
  const { readAmuxCardBySourceKey } = await import(mod("lib/amux/cardRead.ts"));

  const result = await readAmuxCardBySourceKey("CHAT-01");

  assert.deepEqual(result, { kind: "missing" });
  assert.deepEqual(forbiddenDelegateAccesses, []);
  assert.equal(findManyCalls.length, 1);
  assert.deepEqual(findManyCalls[0], {
    where: {
      sourceSystem: "tomverse_private_workboard",
      sourceKey: "CHAT-01",
    },
    orderBy: [{ sourceSystem: "asc" }, { id: "asc" }],
    take: 2,
    select: {
      id: true,
      status: true,
      priority: true,
      archivedAt: true,
      sourceSystem: true,
      sourceKey: true,
      sourceVersion: true,
      sourceDigest: true,
      sourceSnapshot: true,
      acceptedSourceRevision: {
        select: {
          id: true,
          workItemId: true,
          sourceVersion: true,
          detailDigest: true,
          sectionCode: true,
          state: true,
          observedAt: true,
          decidedAt: true,
        },
      },
      dependencies: {
        take: 257,
        select: {
          dependency: {
            select: {
              id: true,
              status: true,
              priority: true,
              archivedAt: true,
              sourceSystem: true,
              sourceKey: true,
            },
          },
        },
      },
    },
  });
});
