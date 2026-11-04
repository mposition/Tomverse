import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * The comment monitor's route while the privacy notice's comments section is
 * unpublished (operator decision 2026-11-04; policy 12.1).
 *
 * `COMMENTS_PRIVACY_NOTICE_CONFIRMED` is the real constant here, not replaced:
 * it is false, so with the monitor's variable on and the posting tool's key
 * present the answer is still `off`, and neither the database operations nor
 * the posting tool are reached. The sibling file
 * (marketing-comments-monitor-route.test.ts) replaces the constant with true
 * and holds the behaviour of a monitor that may run.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;
const SECRET = "g".repeat(48);

const touched: string[] = [];

let routePromise: Promise<{ POST: (request: Request) => Promise<Response> }> | null = null;
const loadRoute = () => {
  if (!routePromise) {
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
    mock.module(mod("lib/marketingCommentsMonitorOperations.ts"), {
      namedExports: {
        marketingCommentsMonitorOperations: () => {
          touched.push("operations");
          return {
            listPosts: async () => {
              touched.push("listPosts");
              return [];
            },
            lastCompleteRunAt: async () => null,
            alertAnswers: async () => new Map(),
            recordAlert: async () => ({ recorded: true }),
            sweepUnhandled: async () => 0,
            recordRun: async () => {
              touched.push("recordRun");
            },
          };
        },
      },
    });
    mock.module(mod("app/api/_marketing/zernioCommentsQuery.ts"), {
      namedExports: {
        buildZernioCommentsQueryFromEnv: () => {
          touched.push("zernio-client");
          return {
            fetchComments: async () => {
              touched.push("zernio");
              return { kind: "ok", comments: [], truncated: false };
            },
          };
        },
      },
    });
    mock.module(mod("lib/operationalMonitoring.ts"), {
      namedExports: { reportOperationalIncident: async () => ({ notified: true, suppressed: false }) },
    });
    routePromise = import(mod("app/api/internal/marketing-comments-monitor/route.ts")) as Promise<{
      POST: (request: Request) => Promise<Response>;
    }>;
  }
  return routePromise;
};

const call = async (body: unknown) => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("https://example.test/api/internal/marketing-comments-monitor", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test("the variable on and the key present, the notice unconfirmed: both steps answer off and touch nothing", async () => {
  process.env.MARKETING_GENERATOR_SUBMIT_SECRET = SECRET;
  process.env.MARKETING_COMMENTS_MONITOR_ENABLED = "true";
  delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
  const { COMMENTS_PRIVACY_NOTICE_CONFIRMED } = await import(mod("lib/privacyNoticeStatus.ts"));
  assert.equal(COMMENTS_PRIVACY_NOTICE_CONFIRMED, false, "this file is about the unconfirmed notice");

  assert.deepEqual(await call({ action: "collect" }), { status: 200, body: { status: "off" } });
  assert.deepEqual(await call({ action: "judge", readAt: new Date().toISOString(), backlog: false, verdicts: [] }), {
    status: 200,
    body: { status: "off" },
  });
  assert.deepEqual(touched, []);
});

test("an unauthenticated or malformed step is still refused first, not answered off", async () => {
  process.env.MARKETING_GENERATOR_SUBMIT_SECRET = SECRET;
  process.env.MARKETING_COMMENTS_MONITOR_ENABLED = "true";
  assert.deepEqual(await call({ action: "collect", extra: 1 }), { status: 400, body: { code: "invalid_request" } });
  assert.deepEqual(touched, []);
});
