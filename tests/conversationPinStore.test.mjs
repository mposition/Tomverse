import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  PIN_UNKNOWN_RETRIES,
  __readPinStoreForTests,
  __resetPinStoreForTests,
  forgetMissingPins,
  getLegacyPins,
  getPinOverrides,
  observeServerPins,
  reconcilePinStore,
  requestPin,
  subscribePinStore,
  toggleLegacyPin,
} from "../lib/conversationPinStore.ts";

/**
 * The pin store, run against a fake server rather than reasoned about.
 *
 * Ten rounds of independent review found the same class of defect here: the
 * screen and the column disagreeing, with nothing on screen looking wrong. Most
 * cases below are those reported scenarios.
 *
 * The fake server applies the route's rule exactly -- a write lands only when
 * its sequence is greater than the column's -- and can hold a request, tell the
 * client it failed, and apply it afterwards. That last ability is what every
 * client-only design failed against, so it is used deliberately and often.
 */

let storage;
let now;

beforeEach(() => {
  storage = { value: [] };
  now = 1_000;
  __resetPinStoreForTests(
    {
      read: () => [...storage.value],
      write: (ids) => {
        storage.value = [...ids];
      },
    },
    { clock: () => now, wait: () => Promise.resolve() }
  );
});

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** What a reader sees for one row, mirroring the sidebar's resolution. */
const effectivePin = (id, serverPinned) =>
  getPinOverrides()[id] ?? (serverPinned === true || getLegacyPins().includes(id));

/**
 * A server that behaves like `PUT /api/conversations/[id]/pin`.
 *
 * By default a request is answered at once. `hold(n)` holds the next `n`: then
 * `answer()` applies one and reports it, `lose()` reports a failure without
 * applying it, and `failThenApply()` reports a failure now and hands back a
 * function that applies the write whenever the test chooses.
 */
const makeServer = (initial = {}) => {
  const rows = new Map(Object.entries(initial).map(([id, row]) => [id, { ...row }]));
  const held = [];
  let holdNext = 0;
  const sent = [];

  const apply = ({ id, pinned, seq }) => {
    const row = rows.get(id);
    if (!row) return { kind: "gone" };
    if (!(row.seq < seq)) return { kind: "superseded", pinned: row.pinned, seq: row.seq };
    row.pinned = pinned;
    row.seq = seq;
    return { kind: "applied", pinned: row.pinned, seq: row.seq };
  };

  const transport = (request) => {
    sent.push({ ...request });
    if (holdNext > 0) {
      holdNext -= 1;
      return new Promise((resolve) => held.push({ request, resolve }));
    }
    return Promise.resolve(apply(request));
  };

  const take = async () => {
    for (let i = 0; i < 50 && held.length === 0; i += 1) await Promise.resolve();
    const entry = held.shift();
    if (!entry) throw new Error("no request is being held");
    return entry;
  };

  return {
    rows,
    sent,
    transport,
    apply,
    hold: (count = 1) => {
      holdNext += count;
    },
    answer: async () => {
      const entry = await take();
      entry.resolve(apply(entry.request));
    },
    lose: async () => {
      const entry = await take();
      entry.resolve({ kind: "failed" });
    },
    failThenApply: async () => {
      const entry = await take();
      entry.resolve({ kind: "failed" });
      return () => apply(entry.request);
    },
    /** Write it now, but deliver the answer only when the test says so. */
    applyNowAnswerLater: async () => {
      const entry = await take();
      const outcome = apply(entry.request);
      return () => entry.resolve(outcome);
    },
  };
};

const pin = (server, id, pinned, extra = {}) =>
  requestPin({
    id,
    pinned,
    identity: extra.identity ?? "account-a",
    ownerId: extra.ownerId ?? "account-a",
    transport: extra.transport ?? server.transport,
    seen: extra.seen,
  });

const seedList = (id, pinned, seq) => {
  observeServerPins([{ id, pinned, pinSeq: seq }]);
  forgetMissingPins([id]);
};

// ---------------------------------------------------------------------------
// The ordering guarantee
// ---------------------------------------------------------------------------

test("two taps that both fail on the wire still end on the last tap", async () => {
  // The tenth review's first major. With a compare-and-set on an observed
  // version, neither failure taught the client anything, both writes named the
  // same version, and whichever the server ran first won. Here the server runs
  // them in the worst order: the last tap first, the earlier one after.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(6); // every attempt of both taps is held
  const first = pin(server, "c1", true);
  now += 1;
  const last = pin(server, "c1", false);

  const applyFirst = await server.failThenApply();
  const applyLast = await server.failThenApply();
  // Retries of the last tap fail too. The first tap stops retrying once it is
  // no longer the newest, so only the last tap keeps trying.
  for (let i = 0; i < PIN_UNKNOWN_RETRIES; i += 1) await server.lose();
  await Promise.all([first, last]);

  applyLast();
  applyFirst();

  assert.equal(server.rows.get("c1").pinned, false, "the column ends on the last tap");
  assert.equal(effectivePin("c1", false), false, "and so does the screen");
});

test("the same two failed taps end on the last tap in the other order too", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(6);
  const first = pin(server, "c1", true);
  now += 1;
  const last = pin(server, "c1", false);
  const applyFirst = await server.failThenApply();
  const applyLast = await server.failThenApply();
  for (let i = 0; i < PIN_UNKNOWN_RETRIES; i += 1) await server.lose();
  await Promise.all([first, last]);

  applyFirst();
  applyLast();

  assert.equal(server.rows.get("c1").pinned, false);
});

test("a write that failed and landed late cannot overwrite the next tap", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(PIN_UNKNOWN_RETRIES + 1);
  const first = pin(server, "c1", true);
  const landLater = await server.failThenApply();
  for (let i = 0; i < PIN_UNKNOWN_RETRIES; i += 1) await server.lose();
  await first;

  now += 1;
  await pin(server, "c1", false);
  const late = landLater();

  assert.equal(late.kind, "superseded", "the late write is older than the column");
  assert.equal(server.rows.get("c1").pinned, false);
  assert.equal(effectivePin("c1", false), false);
});

test("sequences strictly increase per tap even when the clock does not", async () => {
  // Same millisecond, or a clock that went backwards: order still holds.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  await pin(server, "c1", true);
  now -= 500;
  await pin(server, "c1", false);

  const [a, b] = server.sent.map((request) => request.seq);
  assert.ok(b > a, "a later tap always carries a greater sequence");
  assert.equal(server.rows.get("c1").pinned, false);
});

test("a sequence is never below what the server has already accepted", async () => {
  // Another device with a clock far ahead set a huge sequence. This client's
  // clock is behind it, but it has seen that sequence, so its tap still wins.
  const server = makeServer({ c1: { pinned: true, seq: 9_000_000 } });
  seedList("c1", true, 9_000_000);
  await pin(server, "c1", false);
  assert.equal(server.rows.get("c1").pinned, false);
});

test("taps do not wait behind a request that never answers", async () => {
  // There is no queue: order lives in the sequence, so nothing waits.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  pin(server, "c1", true); // never answered
  now += 1;
  await pin(server, "c1", false);

  assert.equal(server.sent.length, 2, "the second tap went out at once");
  assert.equal(server.rows.get("c1").pinned, false);
});

// ---------------------------------------------------------------------------
// Resolving an unknown outcome
// ---------------------------------------------------------------------------

test("a failed write is resent, and a resend reports that the first landed", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const pending = pin(server, "c1", true);
  const landNow = await server.failThenApply();
  landNow(); // it did land; the client was only told it failed
  await pending; // the resend is answered: superseded, carrying our own sequence

  assert.equal(server.sent.length, 2, "one resend");
  assert.equal(server.sent[1].seq, server.sent[0].seq, "the same write, not a new one");
  assert.equal(effectivePin("c1", false), true, "the screen learns it landed");
});

test("a write that truly never landed is landed by the resend", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const pending = pin(server, "c1", true);
  await server.lose();
  await pending;

  assert.equal(server.rows.get("c1").pinned, true);
  assert.equal(effectivePin("c1", false), true);
});

test("an older tap stops resending once a newer tap exists", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const first = pin(server, "c1", true);
  now += 1;
  const last = pin(server, "c1", false); // answered at once
  await last;
  await server.lose(); // the first tap's answer: failed
  await first;

  const firstSeq = server.sent[0].seq;
  const resends = server.sent.filter((request) => request.seq === firstSeq).length;
  assert.equal(resends, 1, "no resend: the newer tap decides the column");
  assert.equal(server.rows.get("c1").pinned, false);
});

test("still unprovable after every resend, the row shows the server's last word", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(PIN_UNKNOWN_RETRIES + 1);
  const pending = pin(server, "c1", true);
  for (let i = 0; i <= PIN_UNKNOWN_RETRIES; i += 1) await server.lose();
  await pending;

  assert.equal(effectivePin("c1", false), false);
});

test("a refusal is not resent", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return { kind: "refused" };
  };
  await pin(server, "c1", true, { transport });
  assert.equal(calls, 1);
  assert.equal(effectivePin("c1", false), false);
});

// ---------------------------------------------------------------------------
// Drawing from what is known
// ---------------------------------------------------------------------------

test("a slow `applied` answer older than a list already seen does not draw the past", async () => {
  // The tenth review's second major, exactly. This tab's pin is written at once
  // but its answer is slow. Another device then unpins, and a list showing that
  // arrives first. The late answer says `applied, pinned` -- true when it was
  // written, and older than what the store now knows. Drawing the answer rather
  // than the store put the screen behind the store's own state.
  //
  // Note the answer and the store disagree here (pinned vs unpinned). A case
  // where they happen to agree would pass whichever one the code drew.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const pending = pin(server, "c1", true);
  const deliver = await server.applyNowAnswerLater(); // written; answer withheld

  now += 1_000;
  server.apply({ id: "c1", pinned: false, seq: now }); // the other device, later
  observeServerPins([{ id: "c1", pinned: false, pinSeq: now }]);

  deliver(); // "applied, pinned" -- now stale
  await pending;

  assert.equal(__readPinStoreForTests().known.c1.pinned, false, "the store knows unpinned");
  // Asserted as what a reader sees. The list or an override may carry the row;
  // which one is the store's business, but the row must not be pinned.
  assert.equal(effectivePin("c1", false), false, "and the row shows that, not the answer");
});

test("a slow `superseded` answer is drawn from the store, not from itself", async () => {
  // The same rule for the other answer that carries a state.
  const server = makeServer({ c1: { pinned: true, seq: 0 } });
  seedList("c1", true, 0);

  // An older write this tab believes in. Its answer will describe a state that
  // the store has already moved past.
  server.rows.get("c1").seq = 50;
  server.hold(1);
  now = 10; // this tap's sequence ends up below the column's
  const pending = pin(server, "c1", false);
  const deliver = await server.applyNowAnswerLater(); // superseded: pinned@50

  observeServerPins([{ id: "c1", pinned: false, pinSeq: 9_000 }]); // newer still
  deliver();
  await pending;

  assert.equal(effectivePin("c1", false), false, "drawn from the newer store state");
});

// ---------------------------------------------------------------------------
// The contract, as decided on 2026-09-16
// ---------------------------------------------------------------------------

test("contract 2: a tap made after seeing a state beats it, whatever the clocks say", async () => {
  // Another device, clock far ahead, pinned the row. This device's clock is far
  // behind -- but it has *seen* that write, so its later tap must still win.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  server.apply({ id: "c1", pinned: true, seq: 50_000_000 });
  observeServerPins([{ id: "c1", pinned: true, pinSeq: 50_000_000 }]); // seen

  now = 10; // this clock is hopelessly behind
  await pin(server, "c1", false);

  assert.equal(server.rows.get("c1").pinned, false, "the tap after seeing wins");
  assert.ok(server.sent[0].seq > 50_000_000);
});

test("contract 3: devices that never saw each other still converge", async () => {
  // Two devices tap the same row concurrently; neither has seen the other.
  // Which one wins is decided by their clocks -- that is the documented limit.
  // What must hold is that both end up drawing what the column holds.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });

  // Device A: clock ahead, pins.
  seedList("c1", false, 0);
  now = 900_000;
  await pin(server, "c1", true);
  const deviceA = { override: getPinOverrides().c1, known: __readPinStoreForTests().known.c1 };

  // Device B: a fresh store, clock behind, unpins without having seen A.
  __resetPinStoreForTests(
    { read: () => [], write: () => {} },
    { clock: () => now, wait: () => Promise.resolve() }
  );
  seedList("c1", false, 0);
  now = 2_000;
  await pin(server, "c1", false);

  const column = server.rows.get("c1");
  assert.equal(deviceA.override, column.pinned, "device A draws the column");
  assert.equal(getPinOverrides().c1, column.pinned, "device B follows it too");
  assert.equal(
    effectivePin("c1", false),
    column.pinned,
    "the screen and the database agree, even though B's tap was later in real time"
  );
});

// ---------------------------------------------------------------------------
// Two devices
// ---------------------------------------------------------------------------

test("when two devices tap the same row, the later tap wins and is not fought", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  // Another device taps unpin at t=2000; this device taps pin earlier, t=1500,
  // but its request arrives last.
  server.apply({ id: "c1", pinned: false, seq: 2_000 });
  now = 1_500;
  await pin(server, "c1", true);

  assert.equal(server.rows.get("c1").pinned, false, "the later tap is the column");
  assert.equal(server.sent.length, 1, "and this device does not retry to overturn it");
  assert.equal(effectivePin("c1", false), false, "it follows the later tap");
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test("a stale list does not undo this tab's own write", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  await pin(server, "c1", true);
  observeServerPins([{ id: "c1", pinned: false, pinSeq: 0 }]);
  assert.equal(effectivePin("c1", false), true);
});

test("a change made elsewhere and changed back is still noticed", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  await pin(server, "c1", true);

  observeServerPins([{ id: "c1", pinned: false, pinSeq: 9_000 }]);
  assert.equal(effectivePin("c1", false), false);
  assert.equal("c1" in getPinOverrides(), false);
});

test("a stale request that never answers does not freeze the row against a newer list", async () => {
  // The eleventh review's second major. An old pin hangs; the newest tap
  // (unpin) settles; then another device's newer list says pinned. Counting any
  // request as "out" kept the old override on screen for good -- even after the
  // stale request finally answered, since it was not the newest and so drew
  // nothing.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const stale = pin(server, "c1", true); // hangs
  await flush();
  now += 1;
  await pin(server, "c1", false); // newest, settles at once
  assert.equal(getPinOverrides().c1, false);

  now += 10_000;
  observeServerPins([{ id: "c1", pinned: true, pinSeq: now }]); // another device
  assert.equal(effectivePin("c1", true), true, "the row follows the newer list");

  await server.answer(); // the stale request finally answers
  await stale;
  assert.equal(effectivePin("c1", true), true, "and still does afterwards");
});

test("a list newer than the pending tap wins even while that tap is unanswered", async () => {
  // The twelfth review's first major. The gate asked only whether the newest
  // tap was still out, never whether the list was newer than it. A tap at 100
  // that never answers kept the row pinned over a list that already said
  // unpinned at 500 -- and the same list, repeated, taught the store nothing new
  // and so never corrected it.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  now = 100;
  pin(server, "c1", true); // never answers
  await flush();
  assert.equal(effectivePin("c1", false), true, "the tap's claim shows first");

  observeServerPins([{ id: "c1", pinned: false, pinSeq: 500 }]);
  assert.equal(effectivePin("c1", false), false, "a newer list outranks the claim");
});

test("an older write that lands after the newest tap was refused is drawn", async () => {
  // The twelfth review's second major. Only the newest tap was allowed to draw.
  // When that tap was refused, an older write still out went on to land -- the
  // store learned pinned@100 and the row kept showing unpinned, and a list with
  // the same sequence changed nothing because it was not newer.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  now = 100;
  const older = pin(server, "c1", true); // answer withheld
  const deliver = await server.applyNowAnswerLater(); // pinned@100 written

  now = 101;
  await pin(server, "c1", false, { transport: async () => ({ kind: "refused" }) });

  deliver();
  await older;
  await flush();

  assert.equal(server.rows.get("c1").pinned, true, "the database holds the older write");
  assert.equal(effectivePin("c1", false), true, "and the row shows what the store learned");
});

test("a refused sequence from a wrong clock does not hold later taps above it", async () => {
  // The twelfth review's minor. The route refuses a sequence more than an hour
  // ahead, but the store kept the refused one as its floor, so every later tap
  // was issued above it and refused too -- until the page was reopened.
  const HOUR = 60 * 60 * 1000;
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  const serverNow = 2_000_000_000_000;
  const routeLike = async (request) =>
    request.seq > serverNow + HOUR ? { kind: "refused" } : server.transport(request);

  now = serverNow + 2 * HOUR; // the device clock is two hours ahead
  await pin(server, "c1", true, { transport: routeLike });
  assert.equal(server.rows.get("c1").pinned, false, "refused");

  now = serverNow; // the clock is corrected
  await pin(server, "c1", true, { transport: routeLike });
  assert.equal(server.rows.get("c1").pinned, true, "the next tap is not held above it");
});

test("a newer list does not overrule a request still out", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  server.hold(1);
  const pending = pin(server, "c1", true);
  await flush();

  observeServerPins([{ id: "c1", pinned: false, pinSeq: 500 }]);
  assert.equal(getPinOverrides().c1, true, "that request's answer is on its way");
  await server.answer();
  await pending;
});

test("a list without sequences is ignored rather than guessed at", () => {
  observeServerPins([{ id: "c1", pinned: true }]);
  assert.deepEqual(__readPinStoreForTests().known, {});
});

// ---------------------------------------------------------------------------
// Legacy pins
// ---------------------------------------------------------------------------

test("a legacy pin comes back when nothing reached the server", async () => {
  storage.value = ["c1"];
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(2 * (PIN_UNKNOWN_RETRIES + 1));
  const first = pin(server, "c1", false);
  now += 1;
  const last = pin(server, "c1", true); // reads an already-emptied list
  await server.lose();
  for (let i = 0; i <= PIN_UNKNOWN_RETRIES; i += 1) await server.lose();
  await Promise.all([first, last]);
  await flush();

  assert.deepEqual([...getLegacyPins()], ["c1"], "the original pin survives");
  assert.deepEqual(storage.value, ["c1"]);
});

test("a legacy pin is spent once the server has answered for it", async () => {
  storage.value = ["c1"];
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  await pin(server, "c1", false);
  await flush();
  assert.deepEqual([...getLegacyPins()], []);
});

test("a legacy pin survives a sign-out taken while its write is out", async () => {
  storage.value = ["c1"];
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const pending = pin(server, "c1", false);
  await flush();
  reconcilePinStore("account-b");
  await server.lose();
  await pending;
  await flush();

  assert.deepEqual([...getLegacyPins()], ["c1"]);
});

test("a write that lands during a sign-out still counts as the server's answer", async () => {
  storage.value = ["c1"];
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const pending = pin(server, "c1", false);
  await flush();
  reconcilePinStore("account-b");
  await server.answer();
  await pending;
  await flush();

  assert.deepEqual([...getLegacyPins()], [], "spent, not restored over the column");
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test("nothing is resent for a session that has ended", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  const pending = pin(server, "c1", true);
  await flush();
  reconcilePinStore("account-b");
  await server.lose();
  await pending;

  assert.equal(server.sent.length, 1, "the ended session does not resend");
});

test("a switch drops this session's rows but keeps what the server said", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  await pin(server, "c1", true);

  reconcilePinStore("account-b");
  assert.deepEqual(getPinOverrides(), {});
  assert.equal(__readPinStoreForTests().known.c1.pinned, true);
});

// ---------------------------------------------------------------------------
// Not there (404)
//
// A 404 proves only that nothing was written. The route answers the same for a
// deleted conversation and for someone else's, so the store never concludes a
// conversation is gone; whether a row exists is the list's to say (decided
// 2026-09-16, docs/ui-contracts/mobile-sidebar-drawer.md).
// ---------------------------------------------------------------------------

test("a 404 draws what the store knows rather than guessing", async () => {
  const server = makeServer({});
  seedList("c1", false, 0);
  await pin(server, "c1", true);
  assert.equal(effectivePin("c1", false), false);
});

test("a 404 from another account's session does not block the owner's later writes", async () => {
  // The fifteenth review's first major. The session bounced to account B before
  // B's list arrived, and a tap on A's still-visible row answered 404 -- "not
  // yours", not "deleted". An absorbing tombstone then ignored everything about
  // that conversation, including A's own successful write after bouncing back.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  reconcilePinStore("account-b");
  now = 101;
  const notYours = async () => ({ kind: "gone" });
  await pin(server, "c1", true, { identity: "account-b", ownerId: "account-b", transport: notYours });

  reconcilePinStore("account-a");
  seedList("c1", false, 0);
  now = 102;
  await pin(server, "c1", true); // A's own write, applied

  assert.equal(server.rows.get("c1").pinned, true);
  assert.equal(effectivePin("c1", false), true, "the owner's write is drawn");
});

test("a 404 does not hold later taps above the sequence it was sent with", async () => {
  // Nothing was written, so the sequence cannot land and must not be a floor.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  const HOUR = 60 * 60 * 1000;
  now = 5 * HOUR;
  await pin(server, "c1", true, { transport: async () => ({ kind: "gone" }) });
  assert.equal(__readPinStoreForTests().live.c1, undefined);
});

test("once the list drops a deleted conversation, nothing about it is left", async () => {
  // Existence is the list's to say. A late answer from before the deletion may
  // still teach the store a pin while a stale list keeps showing the row; the
  // next list without the row is what settles it, and it leaves nothing behind.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  server.hold(1);
  now = 100;
  const older = pin(server, "c1", true);
  const deliver = await server.applyNowAnswerLater();
  server.rows.delete("c1");
  now = 101;
  await pin(server, "c1", false); // 404
  deliver();
  await older;
  await flush();

  forgetMissingPins([]); // the list no longer carries c1
  const after = __readPinStoreForTests();
  assert.equal(after.known.c1, undefined);
  assert.equal(after.live.c1, undefined);
  assert.equal("c1" in after.overrides, false);
});

test("a tap made in the gap before the list effect runs still beats what was on screen", async () => {
  // The seventeenth review's major. React paints a new list before the effect
  // that teaches the store its sequence. A tap in that gap was issued from the
  // store's older knowledge -- here, below the pinned@5000 the reader was
  // looking at -- was superseded by it, and the unpin never happened.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  server.apply({ id: "c1", pinned: true, seq: 5_000 }); // what the new list shows

  now = 100; // a clock behind the state on screen
  await pin(server, "c1", false, {
    // No observeServerPins: the effect has not run. Only the rendered row.
    seen: { id: "c1", pinned: true, pinSeq: 5_000 },
  });

  assert.equal(server.rows.get("c1").pinned, false, "the tap after seeing wins");
  assert.ok(server.sent[0].seq > 5_000);
});

test("writes whose outcome stays unknown do not pile up one by one", async () => {
  // The seventeenth review's minor. Each unanswered write left one more entry
  // behind for the life of the tab. They are folded into a single floor.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  const alwaysFails = async () => ({ kind: "failed" });

  for (let i = 0; i < 200; i += 1) {
    now = 1_000 + i;
    await pin(server, "c1", i % 2 === 0, { transport: alwaysFails });
  }
  await flush();

  const floorEntries = __readPinStoreForTests().live.c1 ?? [];
  assert.ok(floorEntries.length <= 1, `folded into one, not ${floorEntries.length}`);

  // And the floor still holds: the next tap is issued above every one of them.
  now = 0;
  await pin(server, "c1", true);
  assert.ok(server.sent.at(-1).seq > 1_199);
});

// ---------------------------------------------------------------------------
// Sweeping
// ---------------------------------------------------------------------------

test("another account's list does not sweep away writes that may still land", async () => {
  // The sixteenth review's major. A's pin and unpin both fail on the wire but
  // may still land. Account B's list, lacking A's conversation, swept every map
  // -- including those landable sequences. Back on A, with the clock corrected
  // backwards, the next tap was issued below them and an earlier write won.
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);

  // A: two taps, every attempt fails, both may land later. The first tap sends
  // once and stops resending once the second exists; the second sends and then
  // resends PIN_UNKNOWN_RETRIES times. Hold exactly those, or a spare hold
  // swallows the final tap below and the test hangs.
  server.hold(1 + 1 + PIN_UNKNOWN_RETRIES);
  now = 1_000;
  const first = pin(server, "c1", true);
  now = 1_001;
  const second = pin(server, "c1", false);
  const landFirst = await server.failThenApply();
  const landSecond = await server.failThenApply();
  for (let i = 0; i < PIN_UNKNOWN_RETRIES; i += 1) await server.lose();
  await Promise.all([first, second]);
  await flush();

  // Switch to B, whose list does not carry A's conversation.
  reconcilePinStore("account-b");
  forgetMissingPins([]);

  // Back to A; its list arrives before the late writes land.
  reconcilePinStore("account-a");
  seedList("c1", false, 0);
  landFirst();
  landSecond(); // the column is now unpinned@1001

  // The clock is corrected backwards, and the reader taps pin.
  now = 500;
  await pin(server, "c1", true);

  assert.equal(server.rows.get("c1").pinned, true, "the last tap is the last write");
});

test("a conversation deleted while its write is out is swept afterwards", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  server.hold(1);
  const pending = pin(server, "c1", true);
  await flush();

  forgetMissingPins([]);
  assert.ok("c1" in __readPinStoreForTests().latest, "kept while out");

  await server.answer();
  await pending;
  await flush();
  const after = __readPinStoreForTests();
  assert.deepEqual(after.latest, {});
  assert.deepEqual(after.live, {});
  assert.deepEqual(after.known, {});
  assert.equal("c1" in after.overrides, false);
});

test("nothing is swept before anything has said which conversations exist", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  observeServerPins([{ id: "c1", pinned: false, pinSeq: 0 }]); // no forgetMissingPins
  await pin(server, "c1", true);
  await flush();
  assert.equal(__readPinStoreForTests().known.c1.pinned, true);
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

test("a snapshot is a new object, so useSyncExternalStore sees the change", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  const before = getPinOverrides();
  const pending = pin(server, "c1", true);
  assert.notEqual(getPinOverrides(), before);
  await pending;
});

test("subscribers hear a change, and stop hearing after unsubscribing", async () => {
  const server = makeServer({ c1: { pinned: false, seq: 0 } });
  seedList("c1", false, 0);
  let calls = 0;
  const unsubscribe = subscribePinStore(() => {
    calls += 1;
  });
  await pin(server, "c1", true);
  assert.ok(calls > 0);
  unsubscribe();
  const heard = calls;
  now += 1;
  await pin(server, "c1", false);
  assert.equal(calls, heard);
});

// ---------------------------------------------------------------------------
// Guest pins and storage
// ---------------------------------------------------------------------------

test("a guest toggle is the whole operation, and it reaches storage", () => {
  toggleLegacyPin("c1");
  assert.deepEqual(storage.value, ["c1"]);
  toggleLegacyPin("c1");
  assert.deepEqual(storage.value, []);
});

test("another tab's pin is not erased by this one", () => {
  getLegacyPins();
  storage.value = ["from-other-tab"];
  toggleLegacyPin("mine");
  assert.deepEqual([...storage.value].sort(), ["from-other-tab", "mine"]);
});

test("another tab's unpin is not resurrected by this one", () => {
  storage.value = ["c1"];
  getLegacyPins();
  storage.value = [];
  toggleLegacyPin("c2");
  assert.deepEqual(storage.value, ["c2"]);
});

test("the real browser adapter tells blocked storage from empty", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => {
      throw new Error("SecurityError: storage blocked");
    },
    setItem: () => {
      throw new Error("SecurityError: storage blocked");
    },
  };
  try {
    __resetPinStoreForTests(); // no storage argument: the production adapter
    toggleLegacyPin("c1");
    assert.deepEqual([...getLegacyPins()], ["c1"]);
    toggleLegacyPin("c1");
    assert.deepEqual([...getLegacyPins()], [], "the second tap unpins it");
  } finally {
    globalThis.localStorage = original;
  }
});
