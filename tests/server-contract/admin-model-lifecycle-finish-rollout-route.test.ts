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
process.env.NEXTAUTH_SECRET ||= "model-lifecycle-finish-rollout-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type World = {
  isAdmin: boolean;
  permissions: string[];
  txActive: boolean;
  finishable: Set<string>;
  refusal: null | { code: string; message: string };
  finished: null | { workItemIds: readonly string[]; note: string; hasTx: boolean };
  audit: null | { action: string; hasTx: boolean; metadata: unknown };
};

const freshWorld = (): World => ({
  isAdmin: true,
  permissions: ["ops:write"],
  txActive: false,
  finishable: new Set(["item_a", "item_b"]),
  refusal: null,
  finished: null,
  audit: null,
});

let world = freshWorld();
let mocksInstalled = false;

async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
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
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: fakePrisma } });
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
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<
      string,
      unknown
    >;
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => {} },
    });
    mock.module(mod("lib/modelLifecycleWorkItems.ts"), {
      namedExports: {
        MAX_BULK_WORK_ITEM_TRANSITIONS: 200,
        listModelDiscoveryQueue: async ({ workItemIds }: { workItemIds: string[] }) => ({
          items: workItemIds.map((id) => ({ id, rolloutFinishable: world.finishable.has(id) })),
          total: workItemIds.length,
          truncated: false,
        }),
        finishServedRollouts: async (
          tx: unknown,
          input: { workItemIds: readonly string[]; note: string }
        ) => {
          world.finished = {
            workItemIds: input.workItemIds,
            note: input.note,
            hasTx: Boolean(tx) && world.txActive,
          };
          if (world.refusal) return { ok: false, refusal: world.refusal };
          return { ok: true, completed: input.workItemIds.length - 1, awaitingNotice: 1 };
        },
      },
    });
  }
  return (await import(
    `${mod("app/api/admin/model-lifecycle/finish-rollout/route.ts")}?spy=cached`
  )) as { POST: (request: Request) => Promise<Response> };
}

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/admin/model-lifecycle/finish-rollout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test.beforeEach(() => {
  world = freshWorld();
});

test("served adopted items close in one transaction with their audit record", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    post({ workItemIds: ["item_a", "item_b"], note: "Both live in production." })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { completed: 1, awaitingNotice: 1 });
  assert.deepEqual(world.finished, {
    workItemIds: ["item_a", "item_b"],
    note: "Both live in production.",
    hasTx: true,
  });
  assert.equal(world.audit?.action, "model_lifecycle.finish_rollout");
  assert.equal(world.audit?.hasTx, true);
});

test("an item the queue does not mark finishable refuses the whole request", async () => {
  const { POST } = await loadRoute();
  const response = await POST(
    post({ workItemIds: ["item_a", "item_new"], note: "Trying an undecided one too." })
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string; workItemIds: string[] };
  assert.equal(body.error, "NOT_FINISHABLE");
  assert.deepEqual(body.workItemIds, ["item_new"]);
  assert.equal(world.finished, null);
  assert.equal(world.audit, null);
});

test("a state-machine refusal is answered and writes no audit record", async () => {
  world.refusal = { code: "not_allowed", message: "completed does not lead to completed." };
  const { POST } = await loadRoute();
  const response = await POST(post({ workItemIds: ["item_a"], note: "Live." }));
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "not_allowed");
  assert.equal(world.audit, null);
});

test("a note is required, and only ops writers may close", async () => {
  const { POST } = await loadRoute();
  assert.equal((await POST(post({ workItemIds: ["item_a"], note: " " }))).status, 400);
  world.permissions = [];
  assert.equal((await POST(post({ workItemIds: ["item_a"], note: "Live." }))).status, 404);
  assert.equal(world.finished, null);
});

test("a model that stopped being live between the read and the lock is refused", async () => {
  world.refusal = {
    code: "not_live",
    message: "The model is no longer live, or the item moved, so it cannot be closed as rolled out.",
  };
  const { POST } = await loadRoute();
  const response = await POST(post({ workItemIds: ["item_a"], note: "Live a moment ago." }));
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "not_live");
  assert.equal(world.audit, null);
});
