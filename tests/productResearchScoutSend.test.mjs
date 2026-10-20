import assert from "node:assert/strict";
import { test } from "node:test";

import { sendScoutSuggestion } from "../lib/productResearchScoutSend.ts";

/**
 * Sending a Scout suggestion to AMUX (lib/productResearchScoutSend.ts), over
 * an in-memory AMUX that holds one submission per request id and refuses a
 * second, as the real one does. The read-back here is the derived-id read:
 * it finds a submission whichever owner made it.
 */
const ALREADY_SEEN = new Error("request_already_seen");

const amux = () => {
  const byRequest = new Map();
  let created = 0;
  return {
    get created() {
      return created;
    },
    readBack: async (requestId) => {
      const row = byRequest.get(requestId);
      return row ? { status: "committed", ideaId: row.ideaId } : { status: "absent" };
    },
    submit: async (requestId, actor) => {
      if (byRequest.has(requestId)) throw ALREADY_SEEN;
      created += 1;
      byRequest.set(requestId, { ideaId: `idea-${created}`, actor });
      return { ideaId: `idea-${created}` };
    },
  };
};

const suggestion = () => {
  let status = "open";
  let ideaId = null;
  return {
    get status() {
      return status;
    },
    get ideaId() {
      return ideaId;
    },
    close: async (id) => {
      if (status !== "open") return false;
      status = "sent";
      ideaId = id;
      return true;
    },
  };
};

const depsFor = (store, row, requestId, actor, { closeFails = false } = {}) => ({
  readBack: () => store.readBack(requestId),
  submit: () => store.submit(requestId, actor),
  isAlreadySeen: (error) => error === ALREADY_SEEN,
  close: async (id) => {
    if (closeFails) throw new Error("process stopped before the suggestion was closed");
    return row.close(id);
  },
});

test("a send whose idea was made but whose suggestion stayed open is finished by another owner, without a second idea", async () => {
  const store = amux();
  const row = suggestion();
  await assert.rejects(sendScoutSuggestion(depsFor(store, row, "req-1", "owner-a", { closeFails: true })));
  assert.equal(store.created, 1);
  assert.equal(row.status, "open");

  const result = await sendScoutSuggestion(depsFor(store, row, "req-1", "owner-b"));
  assert.deepEqual(result, { kind: "sent", ideaId: "idea-1", closed: true });
  assert.equal(store.created, 1);
  assert.equal(row.status, "sent");
  assert.equal(row.ideaId, "idea-1");
});

test("two sends at once make one idea; the loser reads the winner's back", async () => {
  const store = amux();
  const row = suggestion();
  // Both read "absent" before either submits.
  let reads = 0;
  const racing = (actor) => ({
    ...depsFor(store, row, "req-2", actor),
    readBack: async () => (reads++ < 2 ? { status: "absent" } : store.readBack("req-2")),
  });
  const [a, b] = await Promise.all([sendScoutSuggestion(racing("owner-a")), sendScoutSuggestion(racing("owner-b"))]);
  assert.equal(store.created, 1);
  assert.deepEqual([a.kind, b.kind], ["sent", "sent"]);
  assert.equal(a.ideaId, b.ideaId);
  assert.deepEqual([a.closed, b.closed].sort(), [false, true]);
});

test("a submission still being written is reported, not repeated", async () => {
  let submitted = 0;
  const result = await sendScoutSuggestion({
    readBack: async () => ({ status: "partial", ideaId: "idea-9" }),
    submit: async () => {
      submitted += 1;
      return { ideaId: "never" };
    },
    isAlreadySeen: () => false,
    close: async () => true,
  });
  assert.deepEqual(result, { kind: "partial", ideaId: "idea-9" });
  assert.equal(submitted, 0);

  const lost = await sendScoutSuggestion({
    readBack: async () => ({ status: "absent" }),
    submit: async () => {
      throw ALREADY_SEEN;
    },
    isAlreadySeen: (error) => error === ALREADY_SEEN,
    close: async () => true,
  });
  assert.deepEqual(lost, { kind: "in_progress" });
});

test("a failure that is not AMUX's request-id refusal is not swallowed", async () => {
  const boom = new Error("audit_unavailable");
  await assert.rejects(
    sendScoutSuggestion({
      readBack: async () => ({ status: "absent" }),
      submit: async () => {
        throw boom;
      },
      isAlreadySeen: () => false,
      close: async () => true,
    }),
    boom,
  );
});
