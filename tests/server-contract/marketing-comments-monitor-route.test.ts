import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * The comment monitor's route (marketing S4d): the generator's secret or
 * nothing, off before the database or the posting tool is touched, no posting
 * key no run, and a failure that reaches the incident queue without a body.
 *
 * The route handler and the request module are real. Only the monitor's
 * database operations, the Zernio query builder, the incident reporter and
 * Prisma are replaced.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;
const SECRET = "g".repeat(48);
const BODY = "My lawyer will be in touch about this post";

const world = {
  touched: [] as string[],
  listThrows: null as Error | null,
  zernio: true,
  incidents: [] as Array<{ code: string; context?: Record<string, unknown>; error?: unknown }>,
};

let routePromise: Promise<{ POST: (request: Request) => Promise<Response> }> | null = null;
const loadRoute = () => {
  if (!routePromise) {
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
    mock.module(mod("lib/marketingCommentsMonitorOperations.ts"), {
      namedExports: {
        marketingCommentsMonitorOperations: () => ({
          listPosts: async () => {
            world.touched.push("listPosts");
            if (world.listThrows) throw world.listThrows;
            return [{ id: "p1", channelId: "c1", externalPostId: "ext-1", externalAccountRef: "acct", channelApprovalStartedAt: null }];
          },
          lastCompleteRunAt: async () => null,
          alertAnswers: async () => new Map(),
          recordAlert: async () => {
            world.touched.push("recordAlert");
            return { recorded: true };
          },
          sweepUnhandled: async () => 0,
          recordRun: async () => {
            world.touched.push("recordRun");
          },
        }),
      },
    });
    mock.module(mod("app/api/_marketing/zernioCommentsQuery.ts"), {
      namedExports: {
        buildZernioCommentsQueryFromEnv: () =>
          world.zernio
            ? {
                fetchComments: async () => {
                  world.touched.push("zernio");
                  return { kind: "ok", comments: [{ text: BODY, createdAt: new Date(Date.now() - 60_000) }], truncated: false };
                },
              }
            : null,
      },
    });
    mock.module(mod("lib/operationalMonitoring.ts"), {
      namedExports: {
        reportOperationalIncident: async (incident: { code: string; context?: Record<string, unknown>; error?: unknown }) => {
          world.incidents.push(incident);
          return { notified: true, suppressed: false };
        },
      },
    });
    routePromise = import(mod("app/api/internal/marketing-comments-monitor/route.ts")) as Promise<{
      POST: (request: Request) => Promise<Response>;
    }>;
  }
  return routePromise;
};

const call = async (body: unknown, secret = SECRET) => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("https://example.test/api/internal/marketing-comments-monitor", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const reset = (env: Record<string, string | undefined>) => {
  world.touched = [];
  world.listThrows = null;
  world.zernio = true;
  world.incidents = [];
  process.env.MARKETING_GENERATOR_SUBMIT_SECRET = SECRET;
  for (const name of ["MARKETING_COMMENTS_MONITOR_ENABLED", "MARKETING_AUTOMATION_KILL_SWITCH"]) delete process.env[name];
  Object.assign(process.env, env);
};

test("only the generator's secret is let in, and a malformed step is refused", async () => {
  reset({ MARKETING_COMMENTS_MONITOR_ENABLED: "true" });
  assert.equal((await call({ action: "collect" }, "x".repeat(48))).status, 401);
  assert.deepEqual(await call({ action: "collect", extra: 1 }), { status: 400, body: { code: "invalid_request" } });
  assert.deepEqual(world.touched, []);
});

test("off, or stopped by the kill switch: answered before anything is read", async () => {
  for (const env of [{}, { MARKETING_COMMENTS_MONITOR_ENABLED: "true", MARKETING_AUTOMATION_KILL_SWITCH: "1" }]) {
    reset(env);
    assert.deepEqual(await call({ action: "collect" }), { status: 200, body: { status: "off" } });
    assert.deepEqual(await call({ action: "judge", readAt: new Date().toISOString(), backlog: false, verdicts: [] }), {
      status: 200,
      body: { status: "off" },
    });
    assert.deepEqual(world.touched, []);
  }
});

test("on without the posting tool's key: no run", async () => {
  reset({ MARKETING_COMMENTS_MONITOR_ENABLED: "true" });
  world.zernio = false;
  assert.deepEqual(await call({ action: "collect" }), { status: 503, body: { code: "no_credential" } });
  assert.deepEqual(world.touched, []);
});

test("on: collect hands over the body and writes nothing", async () => {
  reset({ MARKETING_COMMENTS_MONITOR_ENABLED: "true" });
  const { status, body } = await call({ action: "collect" });
  assert.equal(status, 200);
  assert.deepEqual((body.items as Array<{ body: string }>).map((item) => item.body), [BODY]);
  assert.deepEqual(world.touched, ["listPosts", "zernio"]);
});

test("a step that fails is reported without the comments in it", async () => {
  reset({ MARKETING_COMMENTS_MONITOR_ENABLED: "true" });
  world.listThrows = new Error("database lost");
  assert.deepEqual(await call({ action: "collect" }), { status: 500, body: { code: "monitor_failed" } });
  assert.equal(world.incidents.length, 1);
  assert.equal(world.incidents[0].code, "MARKETING_COMMENTS_MONITOR_FAILED");
  assert.deepEqual(world.incidents[0].context, { component: "marketing-comments-monitor", action: "collect" });
  assert.equal(JSON.stringify(world.incidents[0]).includes(BODY), false);
});
