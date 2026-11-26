import assert from "node:assert/strict";
import test from "node:test";
import { createManagedCodeClient } from "../src/host/managed-code-client";
import { createManagedCodeSession, type ManagedTimer } from "../src/host/managed-code-session";
import { accountOver, fakeManagedServer } from "./managed-code-fake-server";

/** A clock the test turns by hand: nothing runs until `tick`, and a cancelled timer never runs. */
function manualTimer() {
  const pending: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const timer: ManagedTimer = (run, ms) => {
    const entry = { run, ms, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  const live = () => pending.filter((entry) => !entry.cancelled);
  return {
    timer, live,
    async tick() {
      const entry = live().at(-1);
      assert.ok(entry, "no timer is waiting");
      entry.cancelled = true;
      entry.run();
      // The timer starts work that is queued behind earlier work; let it finish.
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

function setup(options?: Parameters<typeof fakeManagedServer>[0]) {
  const server = fakeManagedServer(options);
  const { send, signal, account } = accountOver(server);
  const clock = manualTimer();
  let ids = 0;
  const session = createManagedCodeSession({ client: createManagedCodeClient({ send, signal }), signal, timer: clock.timer,
    newTaskId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
  return { server, session, clock, account };
}
const reserve = (executorModelId = "alpha", reviewerModelId = "beta", approvedCredits = 100) =>
  ({ action: "reserve", executorModelId, reviewerModelId, approvedCredits }) as const;

test("reading lists only the models managed credits can use", async () => {
  const { session } = setup();
  const view = await session.run({ action: "read" });
  assert.equal(view.catalog?.version, 7);
  assert.deepEqual(view.catalog?.models.map((model) => model.id), ["alpha", "beta", "gamma"]);
  assert.equal(view.reservation, null);
  assert.equal(view.refusal, null);
});

test("a reservation shows the server's numbers, is kept alive, and ends with what was returned", async () => {
  const { server, session, clock } = setup();
  const view = await session.run(reserve());
  assert.equal(view.reservation?.state, "active");
  assert.deepEqual(view.reservation?.billing, { reservedCredits: 100, settledCredits: 0, releasedCredits: 0, heldCredits: 100, unknownHeldCredits: 0, availableCredits: 100 });
  assert.equal(view.reservation?.executor.name, "ALPHA");
  assert.equal(clock.live().length, 1);
  assert.equal(clock.live()[0].ms, 30_000);

  await clock.tick();
  assert.deepEqual(server.sent.map((request) => request.action), ["reserve", "heartbeat"]);
  assert.equal(clock.live().length, 1, "the next keep-alive is scheduled");

  const ended = await session.run({ action: "release", reason: "cancelled" });
  assert.equal(ended.reservation?.state, "closed");
  assert.equal(ended.reservation?.endedBy, "cancelled");
  assert.equal(ended.reservation?.billing.releasedCredits, 100);
  assert.equal(clock.live().length, 0, "no keep-alive for a closed reservation");
  assert.equal(server.control.balance, 1_000);
  assert.equal((await session.run({ action: "dismiss" })).reservation, null);
});

test("a refusal shows its reason, holds nothing, and a changed catalogue is read again", async () => {
  const { server, session, clock } = setup({ balance: 10 });
  await session.run({ action: "read" });
  let view = await session.run(reserve());
  assert.equal(view.refusal, "insufficientCredits");
  assert.equal(view.reservation, null);
  assert.equal(clock.live().length, 0);

  server.control.catalogVersion = 8;
  view = await session.run(reserve("alpha", "beta", 5));
  assert.equal(view.refusal, "catalog");
  assert.equal(view.catalog, null, "the stale list is dropped");
  view = await session.run({ action: "read" });
  assert.equal(view.catalog?.version, 8);
  assert.equal(view.refusal, null);
  view = await session.run(reserve("alpha", "beta", 5));
  assert.equal(view.reservation?.state, "active");
});

test("two models from one company, an unknown model and a second reservation are refused before anything is sent", async () => {
  const { server, session } = setup();
  assert.equal((await session.run(reserve("alpha", "gamma"))).refusal, "sameProvider");
  assert.equal((await session.run(reserve("alpha", "chat-only"))).refusal, "catalog");
  assert.equal(server.managedCalls().length, 0);
  assert.equal((await session.run(reserve())).reservation?.state, "active");
  const again = await session.run(reserve("gamma", "beta", 50));
  assert.equal(again.refusal, "alreadyReserved");
  assert.equal(server.reservations.size, 1);
});

test("a lost answer is retried under the same task id; a refusal starts a new one", async () => {
  const { server, session } = setup();
  server.control.drop = { action: "reserve", after: true };
  let view = await session.run(reserve());
  assert.equal(view.refusal, "unreachable");
  assert.equal(view.reservation, null);
  view = await session.run(reserve());
  assert.equal(view.reservation?.state, "active");
  assert.equal(server.reservations.size, 1, "the retry found the first reservation instead of holding credits twice");
  assert.equal(server.control.balance, 900);
  assert.equal(new Set(server.sent.filter((request) => request.action === "reserve").map((request) => request.action === "reserve" && request.taskId)).size, 1);

  const next = setup({ balance: 10 });
  await next.session.run(reserve());
  await next.session.run(reserve());
  const ids = next.server.sent.flatMap((request) => request.action === "reserve" ? [request.taskId] : []);
  assert.equal(new Set(ids).size, 2);
});

test("missed keep-alives read as lost after two, and the next answer clears it", async () => {
  const { server, session, clock } = setup();
  await session.run(reserve());
  server.control.drop = { action: "heartbeat", after: false };
  await clock.tick();
  assert.equal(session.view().reservation?.heartbeat, "ok");
  server.control.drop = { action: "heartbeat", after: false };
  await clock.tick();
  assert.equal(session.view().reservation?.heartbeat, "lost");
  assert.equal(session.view().reservation?.state, "active");
  await clock.tick();
  assert.equal(session.view().reservation?.heartbeat, "ok");
});

test("when the server has already closed the reservation, the view shows its record and stops keeping it alive", async () => {
  const { server, session, clock } = setup();
  const started = await session.run(reserve());
  server.interrupt(started.reservation!.id);
  await clock.tick();
  const view = session.view();
  assert.equal(view.reservation?.state, "interrupted");
  assert.equal(view.reservation?.billing.releasedCredits, 100);
  assert.equal(clock.live().length, 0);
  // The person gave no reason; the server ended it.
  assert.equal(view.reservation?.endedBy, undefined);
});

test("credits held for a call with an unknown outcome stay visible and are not shown as returned", async () => {
  const { server, session, clock } = setup();
  const started = await session.run(reserve());
  server.markUnknown(started.reservation!.id, 30);
  await clock.tick();
  const { reservation } = session.view();
  assert.equal(reservation?.state, "outcome_unknown");
  assert.equal(reservation?.billing.unknownHeldCredits, 30);
  assert.equal(reservation?.billing.releasedCredits, 70);
});

test("a release that cannot reach the server leaves the reservation active and kept alive", async () => {
  const { server, session, clock } = setup();
  await session.run(reserve());
  server.control.drop = { action: "release", after: false };
  const view = await session.run({ action: "release", reason: "cancelled" });
  assert.equal(view.refusal, "unreachable");
  assert.equal(view.reservation?.state, "active");
  assert.equal(clock.live().length, 1);
  assert.equal((await session.run({ action: "release", reason: "cancelled" })).reservation?.state, "closed");
});

test("a release that finds the reservation already closed shows the server's record", async () => {
  const { server, session } = setup();
  const started = await session.run(reserve());
  server.interrupt(started.reservation!.id);
  server.control.refuse = { action: "release", answer: { status: 409, error: "CODE_TASK_NOT_ACTIVE" } };
  const view = await session.run({ action: "release", reason: "cancelled" });
  assert.equal(view.reservation?.state, "interrupted");
});

test("signing out stops the keep-alive and the view goes empty", async () => {
  const { session, clock, account } = setup();
  await session.run(reserve());
  assert.equal(clock.live().length, 1);
  account.abort();
  assert.equal(clock.live().length, 0);
  const view = await session.run({ action: "read" });
  assert.deepEqual(view, { catalog: null, reservation: null, refusal: null });
});

test("operations run one at a time, so a late keep-alive answer cannot undo a release", async () => {
  const { server, session, clock } = setup();
  await session.run(reserve());
  const beat = clock.live().at(-1)!;
  beat.cancelled = true;
  beat.run();
  const released = session.run({ action: "release", reason: "cancelled" });
  await released;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.view().reservation?.state, "closed");
  assert.deepEqual(server.sent.map((request) => request.action), ["reserve", "heartbeat", "release"]);
});
