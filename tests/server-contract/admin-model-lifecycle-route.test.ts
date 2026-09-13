import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { analysisFingerprint } from "../../lib/modelLifecycleWorkItemCore.ts";

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
    eventDecision?: unknown;
    hasTx: boolean;
  };
  snapshotRequests: string[][];
  queueComplete: boolean;
  queueUnchanged: boolean;
  audit: null | { action: string; hasTx: boolean; metadata: unknown };
};

const freshWorld = (): World => ({
  isAdmin: true,
  permissions: ["ops:write"],
  txActive: false,
  transition: null,
  audit: null,
  snapshotRequests: [],
  queueComplete: true,
  queueUnchanged: true,
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
        EXCLUDABLE_WORK_ITEM_STATUSES: ["discovered", "awaiting_decision", "deferred"],
        queueStatusSetUnchanged: async (
          tx: unknown,
          _statuses: readonly string[],
          ids: ReadonlySet<string>
        ) => {
          assert.ok(tx, "the recheck runs inside the write transaction");
          assert.ok(ids.has("item_a"));
          return world.queueUnchanged;
        },
        queueFamilies: async (view: string) => {
          world.snapshotRequests.push([view]);
          // item_a and item_b are one family (alpha); item_c is another.
          return {
            complete: world.queueComplete,
            items: new Map(
              ["item_a", "item_b", "item_c"].map((id) => [
                id,
                {
                  analysisKo: `analysis of ${id}`,
                  familyKey: id === "item_c" ? "gamma" : "alpha",
                },
              ])
            ),
          };
        },
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

test("an exclusion records the chosen reason and the server's own analysis", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "duplicate_alias",
      operatorReason: "Same as grok-4.20",
      families: [
        {
          representativeId: "item_a",
          workItemIds: ["item_a", "item_b"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_a"),
        },
      ],
      // Ignored: the analysis snapshot is never taken from the request.
      analysisSnapshot: "client text",
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(world.snapshotRequests, [["excludable"]]);
  const transition = world.transition as NonNullable<World["transition"]> & {
    eventDecision: {
      decision: string;
      reasonCode: string;
      operatorReason: string;
      analysisSnapshots: Map<string, string>;
    };
  };
  assert.equal(transition.to, "closed_no_action");
  assert.equal(transition.note, undefined, "no analysis sentence is written as the note");
  assert.equal(transition.hasTx, true);
  assert.equal(transition.eventDecision.decision, "exclude");
  assert.equal(transition.eventDecision.reasonCode, "duplicate_alias");
  assert.equal(transition.eventDecision.operatorReason, "Same as grok-4.20");
  // Every member records the sentence the operator read: the representative's.
  assert.deepEqual(
    [...transition.eventDecision.analysisSnapshots],
    [
      ["item_a", "analysis of item_a"],
      ["item_b", "analysis of item_a"],
    ]
  );
  assert.equal(world.audit?.action, "model_lifecycle.exclude");
  assert.deepEqual(world.audit?.metadata, {
    to: "closed_no_action",
    count: 2,
    workItemIds: ["item_a", "item_b"],
    reasonCode: "duplicate_alias",
  });
});

test("an exclusion made against an analysis that has since changed is refused", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "no_product_path",
      families: [
        {
          representativeId: "item_a",
          workItemIds: ["item_a", "item_b"],
          shownAnalysisFingerprint: analysisFingerprint("yesterday's analysis"),
        },
      ],
    })
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 409);
  assert.equal(body.error, "ANALYSIS_CHANGED");
  assert.deepEqual(body.workItemIds, ["item_a"]);
  assert.equal(world.transition, null);
  assert.equal(world.audit, null);
});

test("an exclusion cannot pin one family's analysis on another family's items", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "no_product_path",
      families: [
        {
          representativeId: "item_a",
          workItemIds: ["item_a", "item_c"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_a"),
        },
      ],
    })
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 409);
  assert.equal(body.error, "FAMILY_MISMATCH");
  assert.equal(world.transition, null);
});

test("a family's representative must be one of the items it excludes", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "no_product_path",
      families: [
        {
          representativeId: "item_a",
          workItemIds: ["item_b"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_a"),
        },
      ],
    })
  );
  assert.equal(response.status, 409);
  assert.equal(world.transition, null);
});

test("an exclusion of part of a family is refused", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "no_product_path",
      families: [
        {
          representativeId: "item_a",
          workItemIds: ["item_a"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_a"),
        },
      ],
    })
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 409);
  assert.equal(body.error, "FAMILY_MISMATCH");
  assert.equal(world.transition, null);
});

test("an exclusion is refused when an undecided item appeared after the family check", async () => {
  const { PATCH } = await loadRoute();
  world.queueUnchanged = false;
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "no_product_path",
      families: [
        {
          representativeId: "item_c",
          workItemIds: ["item_c"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_c"),
        },
      ],
    })
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 409);
  assert.equal(body.error, "FAMILY_MISMATCH");
  assert.equal(world.transition, null);
  assert.equal(world.audit, null);
});

test("an exclusion is refused when the queue cannot be read whole", async () => {
  const { PATCH } = await loadRoute();
  world.queueComplete = false;
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "no_product_path",
      families: [
        {
          representativeId: "item_c",
          workItemIds: ["item_c"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_c"),
        },
      ],
    })
  );
  assert.equal(response.status, 503);
  assert.equal(world.transition, null);
});

test("a full bulk exclusion fits the request size limit", async () => {
  const { PATCH } = await loadRoute();
  const families = Array.from({ length: 200 }, (_, index) => ({
    representativeId: `cm${"x".repeat(22)}${String(index).padStart(3, "0")}`,
    workItemIds: [`cm${"x".repeat(22)}${String(index).padStart(3, "0")}`],
    shownAnalysisFingerprint: "0".repeat(16),
  }));
  const response = await PATCH(
    patch({ decision: "exclude", reasonCode: "no_product_path", families })
  );
  // Refused for naming items the queue does not hold, not for its size.
  assert.equal(response.status, 409);
});

test("an exclusion reason outside the list is refused before any write", async () => {
  const { PATCH } = await loadRoute();
  const response = await PATCH(
    patch({
      decision: "exclude",
      reasonCode: "because",
      families: [
        {
          representativeId: "item_a",
          workItemIds: ["item_a"],
          shownAnalysisFingerprint: analysisFingerprint("analysis of item_a"),
        },
      ],
    })
  );
  assert.equal(response.status, 400);
  assert.equal(world.transition, null);
});

test("a reopen needs a written reason and moves the whole family back to discovered", async () => {
  const { PATCH } = await loadRoute();
  const family = [{ representativeId: "item_a", workItemIds: ["item_a", "item_b"] }];
  const missing = await PATCH(patch({ decision: "reopen", families: family }));
  assert.equal(missing.status, 400);
  assert.equal(world.transition, null);

  const partial = await PATCH(
    patch({
      decision: "reopen",
      families: [{ representativeId: "item_a", workItemIds: ["item_a"] }],
      operatorReason: "Price dropped",
    })
  );
  assert.equal(partial.status, 409);
  assert.equal(world.transition, null);

  const response = await PATCH(
    patch({ decision: "reopen", families: family, operatorReason: "Price dropped" })
  );
  assert.equal(response.status, 200);
  const transition = world.transition as unknown as NonNullable<World["transition"]> & {
    eventDecision: { analysisSnapshots?: unknown };
  };
  assert.equal(transition.to, "discovered");
  assert.equal(transition.eventDecision.analysisSnapshots, undefined, "a reopen snapshots nothing");
  assert.deepEqual(world.snapshotRequests.at(-1), ["excluded"]);
  assert.equal(world.audit?.action, "model_lifecycle.reopen");
});

test("closing, reopening or approving through a bare transition is refused", async () => {
  const { PATCH } = await loadRoute();
  for (const to of ["closed_no_action", "discovered", "approved"]) {
    const response = await PATCH(
      patch({ workItemIds: ["item_a"], to, note: "Reviewed together." })
    );
    assert.equal(response.status, 400, to);
  }
  assert.equal(world.transition, null);
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
