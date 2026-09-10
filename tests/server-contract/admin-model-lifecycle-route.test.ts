import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "model-lifecycle-contract-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type World = {
  isAdmin: boolean;
  permissions: string[];
  txActive: boolean;
  transition: null | {
    workItemIds: string[];
    to: string;
    note?: string;
    hasTx: boolean;
  };
  audit: null | { action: string; hasTx: boolean; metadata: unknown };
};

const freshWorld = (): World => ({
  isAdmin: true,
  permissions: ["ops:write"],
  txActive: false,
  transition: null,
  audit: null,
});

let world = freshWorld();
let mocksInstalled = false;

async function loadRoute(): Promise<{
  PATCH: (request: Request) => Promise<Response>;
}> {
  if (!mocksInstalled) {
    mocksInstalled = true;
    mock.module(mod("node_modules/next-auth/next/index.js"), {
      namedExports: {
        getServerSession: async () => ({
          user: { id: "admin_1", email: "admin@tomverse.app" },
        }),
      },
    });
    mock.module(mod("lib/adminAuth.ts"), {
      namedExports: {
        isAdminSession: () => world.isAdmin,
        hasAdminPermission: (_session: unknown, permission: string) =>
          world.permissions.includes(permission),
      },
    });

    const fakePrisma = {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        world.txActive = true;
        try {
          return await run(fakePrisma);
        } finally {
          world.txActive = false;
        }
      },
    };
    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
    mock.module(mod("lib/adminAudit.ts"), {
      namedExports: {
        writeAdminAuditLog: async ({
          action,
          metadata,
          tx,
        }: {
          action: string;
          metadata: unknown;
          tx?: unknown;
        }) => {
          world.audit = { action, metadata, hasTx: Boolean(tx) && world.txActive };
        },
      },
    });

    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const realApiSecurity = require(
      resolve(ROOT, "lib/apiSecurity.ts")
    ) as Record<string, unknown>;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: {
        ...realApiSecurity,
        consumeApiRateLimit: async () => {},
      },
    });

    mock.module(mod("lib/modelLifecycleWorkItems.ts"), {
      namedExports: {
        MAX_BULK_WORK_ITEM_TRANSITIONS: 200,
        listModelDiscoveryQueue: async () => ({
          items: [],
          total: 0,
          truncated: false,
        }),
        transitionWorkItem: async () => ({
          ok: true,
          status: "awaiting_decision",
        }),
        transitionWorkItems: async (
          input: {
            workItemIds: string[];
            to: string;
            note?: string;
          },
          options?: { tx?: unknown }
        ) => {
          world.transition = {
            ...input,
            hasTx: Boolean(options?.tx) && world.txActive,
          };
          return {
            ok: true,
            status: input.to,
            updated: input.workItemIds.length,
          };
        },
      },
    });
  }

  return (await import(
    `${mod("app/api/admin/model-lifecycle/route.ts")}?spy=cached`
  )) as { PATCH: (request: Request) => Promise<Response> };
}

const patch = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/admin/model-lifecycle", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test.beforeEach(() => {
  world = freshWorld();
});

test("bulk review and its audit record share one transaction", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      workItemIds: ["item_a", "item_b"],
      to: "awaiting_decision",
      note: "Reviewed together as current general chat models.",
    })
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "awaiting_decision", updated: 2 });
  assert.deepEqual(world.transition, {
    workItemIds: ["item_a", "item_b"],
    to: "awaiting_decision",
    note: "Reviewed together as current general chat models.",
    decision: undefined,
    actorEmail: "admin@tomverse.app",
    hasTx: true,
  });
  assert.equal(world.audit?.action, "model_lifecycle.bulk_transition");
  assert.equal(world.audit?.hasTx, true);
  assert.deepEqual(world.audit?.metadata, {
    to: "awaiting_decision",
    count: 2,
    workItemIds: ["item_a", "item_b"],
  });
});

test("bulk review requires one common audit reason", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      workItemIds: ["item_a", "item_b"],
      to: "closed_no_action",
    })
  );

  assert.equal(response.status, 400);
  assert.equal(world.transition, null);
  assert.equal(world.audit, null);
});

test("ops:write remains mandatory for bulk review", async () => {
  const { PATCH } = await loadRoute();
  world.permissions = [];
  const response = await PATCH(
    patch({
      workItemIds: ["item_a"],
      to: "deferred",
      note: "Wait for provider pricing.",
    })
  );

  assert.equal(response.status, 404);
  assert.equal(world.transition, null);
});
