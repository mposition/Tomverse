import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The server half of the Auto UI contract (routing policy §5).
 *
 * The flag is off in production and the readiness register is empty, so the
 * only state this route can actually be in today is "Auto is not offered".
 * That is exactly the state worth pinning: the failure that would ship is not
 * a broken Auto, it is an Auto that appears available, stores `auto`, and then
 * answers every turn manually — which the user cannot distinguish from Auto
 * choosing their model every time.
 *
 * Its own process under scripts/run-db-integration-tests.mjs: `mock.module` is
 * process-global and this file replaces next-auth for every module that
 * imports it, and it sets the rollout environment variables that
 * `lib/autoCohort.ts` reads at call time.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

/**
 * Readiness is attested in code and the committed register is empty, so the
 * branch that runs once the gate opens is unreachable without replacing the
 * module. `mock.module` rather than reassigning the export, because
 * `lib/autoCohort.ts` binds the function at import time and an ESM binding
 * cannot be rewritten from outside.
 *
 * This is not a way around the gate -- the gate itself is asserted for real in
 * tests/autoCohort.test.mjs, where the committed register is read unmocked.
 * Here it is a switch, so both sides of it can be exercised.
 */
let readinessAttested = false;
const pendingReadiness = {
  ready: false,
  outstanding: ["shadow_report", "offline_quality_evaluation", "attempt_manifest_boundary"],
  problems: [] as string[],
};
mock.module(mod("lib/autoRolloutReadiness.ts"), {
  namedExports: {
    AUTO_ROLLOUT_READINESS_VERSION: "auto-rollout-readiness-test",
    AUTO_ROLLOUT_READINESS: [],
    autoRolloutReadinessProblems: () => [],
    autoRolloutReadiness: () =>
      readinessAttested
        ? { ready: true, outstanding: [], problems: [] }
        : pendingReadiness,
  },
});

type ConversationRoute = {
  GET: (request: Request, context: unknown) => Promise<Response>;
  PATCH: (request: Request, context: unknown) => Promise<Response>;
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: ConversationRoute;

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  route = (await import(
    mod("app/api/conversations/[conversationId]/route.ts")
  )) as ConversationRoute;
});

const resetData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message",
      "Conversation",
      "UserSettings",
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);

const clearRolloutEnvironment = () => {
  delete process.env.TOMVERSE_AUTO_ROUTER_UI_ENABLED;
  delete process.env.AUTO_ROUTER_ROLLOUT_PERCENT;
  delete process.env.AUTO_ROUTER_ELIGIBLE_PLANS;
  delete process.env.AUTO_ROUTER_COHORT_SALT;
  delete process.env.AUTO_ROUTER_KILL_SWITCH;
};

beforeEach(async () => {
  await resetData();
  sessionOverride = null;
  readinessAttested = false;
  clearRolloutEnvironment();
});

after(async () => {
  await resetData();
  clearRolloutEnvironment();
  await prisma.$disconnect();
});

/**
 * A Chat conversation, because Auto is offered in one product (decision record
 * v1.2 §3). `productKey` is stated rather than left NULL: a NULL row resolves
 * to Review through PRODUCT_KEY_READ_MODE and is refused, which is its own
 * test below.
 */
const seedOwner = async (productKey: string | null = "chat") => {
  const user = await prisma.user.create({
    data: { email: `auto-ui-${randomUUID()}@example.test`, plan: "Pro" },
  });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, title: "auto selection fixture", productKey },
  });
  return { user, conversation };
};

const read = async (userId: string, conversationId: string) => {
  sessionOverride = { user: { id: userId } };
  const response = await route.GET(
    new Request(`https://tomverse.test/api/conversations/${conversationId}`),
    { params: Promise.resolve({ conversationId }) }
  );
  return { response, body: await response.json() };
};

const patch = async (
  userId: string,
  conversationId: string,
  payload: Record<string, unknown>
) => {
  sessionOverride = { user: { id: userId } };
  const response = await route.PATCH(
    new Request(`https://tomverse.test/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ conversationId }) }
  );
  return { response, body: await response.json() };
};

/** Opens the cohort for the account, so the offered branch can be exercised. */
const openTheRollout = () => {
  process.env.TOMVERSE_AUTO_ROUTER_UI_ENABLED = "true";
  process.env.AUTO_ROUTER_ROLLOUT_PERCENT = "100";
  process.env.AUTO_ROUTER_ELIGIBLE_PLANS = "Free,Pro,Max";
  process.env.AUTO_ROUTER_COHORT_SALT = "integration-test-salt";
};

test("a conversation reports its mode, and Auto is not offered by default", async () => {
  const { user, conversation } = await seedOwner();

  const { response, body } = await read(user.id, conversation.id);
  assert.equal(response.status, 200);
  assert.equal(body.selectionMode, "manual");
  // The flag is off, so nothing about the rollout is computed or disclosed.
  assert.deepEqual(body.autoSelection, { offered: false });
});

// A client that could read its bucket could work out the rollout percentage,
// and one that knew the salt could work out anyone's.
test("the response discloses no rollout state at all", async () => {
  openTheRollout();
  const { user, conversation } = await seedOwner();

  const { body } = await read(user.id, conversation.id);
  const serialised = JSON.stringify(body.autoSelection);
  assert.equal(serialised.includes("bucket"), false);
  assert.equal(serialised.includes("salt"), false);
  assert.equal(serialised.includes("reason"), false);
  assert.deepEqual(Object.keys(body.autoSelection), ["offered"]);
});

// The failure that would actually ship: a mode stored for an account nothing
// will route, which reads to the user exactly like Auto agreeing with them.
test("storing auto is refused while the rollout would not route this account", async () => {
  const { user, conversation } = await seedOwner();

  const { response, body } = await patch(user.id, conversation.id, {
    selectionMode: "auto",
  });
  assert.equal(response.status, 403);
  assert.equal(body.code, "AUTO_SELECTION_UNAVAILABLE");

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.selectionMode, "manual");
});

test("the flag alone does not open it: the cohort still has to admit the account", async () => {
  process.env.TOMVERSE_AUTO_ROUTER_UI_ENABLED = "true";
  const { user, conversation } = await seedOwner();

  const { response } = await patch(user.id, conversation.id, { selectionMode: "auto" });
  assert.equal(response.status, 403, "an unconfigured rollout accepted auto");
});

test("an outstanding readiness gate refuses auto even with the rollout configured", async () => {
  openTheRollout();
  const { user, conversation } = await seedOwner();

  // No readiness patch: the committed register is all `pending`.
  const { response, body } = await patch(user.id, conversation.id, {
    selectionMode: "auto",
  });
  assert.equal(response.status, 403);
  assert.equal(body.code, "AUTO_SELECTION_UNAVAILABLE");
});

test("with the rollout open and readiness attested, auto stores", async () => {
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner();

  const { response } = await patch(user.id, conversation.id, { selectionMode: "auto" });
  assert.equal(response.status, 200);

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.selectionMode, "auto");
  // A conversation that has not been routed yet holds no sticky state.
  assert.equal(stored.routerModelId, null);
  assert.equal(stored.routerChallengerTurns, 0);

  const { body } = await read(user.id, conversation.id);
  assert.equal(body.selectionMode, "auto");
  assert.deepEqual(body.autoSelection, { offered: true });
});

// The reason the route calls selectionModeTransition rather than writing the
// column: a streak accumulated under Auto would otherwise decide the first
// switch after Auto is turned back on, from turns the user routed by hand.
test("returning to manual clears the model and the challenger streak", async () => {
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner();

  await patch(user.id, conversation.id, { selectionMode: "auto" });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { routerModelId: "deepseek-v4-flash", routerChallengerTurns: 2 },
  });

  const { response } = await patch(user.id, conversation.id, { selectionMode: "manual" });
  assert.equal(response.status, 200);

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.selectionMode, "manual");
  assert.equal(stored.routerModelId, null);
  assert.equal(stored.routerChallengerTurns, 0);
});

// An account can leave the cohort while its conversations are still marked
// auto. Refusing manual would strand them in a mode they cannot act on.
test("an account that has left the cohort can still return to manual", async () => {
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner();
  await patch(user.id, conversation.id, { selectionMode: "auto" });

  // The rollout is switched off underneath the conversation.
  process.env.AUTO_ROUTER_KILL_SWITCH = "on";

  const { response } = await patch(user.id, conversation.id, { selectionMode: "manual" });
  assert.equal(response.status, 200, "a stranded conversation could not leave auto");
  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.selectionMode, "manual");
});

test("a mode nobody enumerated is refused by the request schema", async () => {
  const { user, conversation } = await seedOwner();
  const { response } = await patch(user.id, conversation.id, {
    selectionMode: "auto_v2",
  });
  assert.equal(response.status, 400);
});

test("someone else's conversation cannot have its mode changed", async () => {
  openTheRollout();
  readinessAttested = true;
  const { conversation } = await seedOwner();
  const intruder = await prisma.user.create({
    data: { email: `intruder-${randomUUID()}@example.test`, plan: "Pro" },
  });

  const { response } = await patch(intruder.id, conversation.id, {
    selectionMode: "auto",
  });
  assert.equal(response.status, 403);
  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.selectionMode, "manual");
});

test("a Review conversation is not offered Auto, however open the rollout is", async () => {
  // The product is settled before the cohort (decision record v1.2 §3). What
  // reaches the client is still one boolean -- the reason stays on the server.
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner("review");

  const { body } = await read(user.id, conversation.id);
  assert.equal(body.autoSelection.offered, false);
  assert.equal(body.autoSelection.reason, undefined);
  assert.equal(body.autoSelection.cohort, undefined);
});

test("a Review conversation cannot be switched to Auto", async () => {
  // There is no PATCH that changes a conversation's product either: turning a
  // Review conversation into a Chat one is a fork, not an update.
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner("review");

  const { response } = await patch(user.id, conversation.id, { selectionMode: "auto" });
  assert.equal(response.status, 403);

  const stored = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  assert.equal(stored.selectionMode, "manual");
  assert.equal(stored.productKey, "review");
});

test("a conversation whose product is still NULL is treated as Review", async () => {
  // Every conversation in the database is in this state until the backfill
  // runs. Reading NULL as "unknown, proceed" would route Review traffic.
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner(null);

  const { body } = await read(user.id, conversation.id);
  assert.equal(body.autoSelection.offered, false);

  const { response } = await patch(user.id, conversation.id, { selectionMode: "auto" });
  assert.equal(response.status, 403);
});

test("manual is still accepted on a Review conversation", async () => {
  // UI contract §5: returning to manual is unconditional. A conversation must
  // be able to leave a mode the account can no longer act on, and refusing
  // here would strand rows the sticky-state constraint expects nothing to hold.
  openTheRollout();
  readinessAttested = true;
  const { user, conversation } = await seedOwner("review");

  const { response } = await patch(user.id, conversation.id, { selectionMode: "manual" });
  assert.equal(response.status, 200);
});
