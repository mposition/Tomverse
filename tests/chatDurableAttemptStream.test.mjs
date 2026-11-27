import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS,
  CHAT_DURABLE_PARTIAL_MAX_CHARACTERS,
  createChatResponseAttemptCheckpointWriter,
} from "../lib/chatDurableAttemptStream.ts";

const attemptRow = (input, revision) => ({
  assistantMessageId: input.assistantMessageId,
  userId: input.userId,
  conversationId: "conversation_1",
  sourceUserMessageId: "source_1",
  fingerprint: "a".repeat(64),
  requestedModelId: "provider/model",
  actualModelId: input.actualModelId ?? null,
  provider: input.provider ?? null,
  status: "streaming",
  partialContent: input.partialContent,
  checkpointRevision: revision,
  ownerId: input.ownerId,
  leaseExpiresAt: input.leaseExpiresAt,
  finishReason: null,
  failureCode: null,
  terminalAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

test("flush always performs a fresh lease/owner CAS even below the coalescing step", async () => {
  const calls = [];
  const writer = createChatResponseAttemptCheckpointWriter(
    {
      userId: "user_1",
      assistantMessageId: "assistant_1",
      ownerId: "worker_1",
      initialRevision: 0,
      requestedModelId: "provider/model",
    },
    async (input) => {
      calls.push(input);
      return attemptRow(input, calls.length);
    }
  );
  writer.observe("short");
  const first = await writer.flush("short");
  assert.equal(calls.length, 1);
  assert.equal(first.revision, 1);
  assert.equal(first.partialContent, "short");

  const second = await writer.flush("short");
  assert.equal(calls.length, 2);
  assert.equal(second.revision, 2);
});

test("checkpoint content is a stable first-100k prefix", async () => {
  const calls = [];
  const writer = createChatResponseAttemptCheckpointWriter(
    {
      userId: "user_1",
      assistantMessageId: "assistant_1",
      ownerId: "worker_1",
      initialRevision: 0,
      requestedModelId: "provider/model",
    },
    async (input) => {
      calls.push(input);
      return attemptRow(input, calls.length);
    }
  );
  const content = "x".repeat(CHAT_DURABLE_PARTIAL_MAX_CHARACTERS + 10);
  const result = await writer.flush(content);
  assert.equal(result.partialContent.length, CHAT_DURABLE_PARTIAL_MAX_CHARACTERS);
  assert.equal(calls.at(-1).partialContent, content.slice(0, CHAT_DURABLE_PARTIAL_MAX_CHARACTERS));
});

test("a small visible prefix is checkpointed when no later chunk arrives", async () => {
  const calls = [];
  const writer = createChatResponseAttemptCheckpointWriter(
    {
      userId: "user_1",
      assistantMessageId: "assistant_1",
      ownerId: "worker_1",
      initialRevision: 0,
      requestedModelId: "provider/model",
    },
    async (input) => {
      calls.push(input);
      return attemptRow(input, calls.length);
    }
  );
  writer.observe("visible");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].partialContent, "visible");
});

// 2026-11-21: Fable 5.2 reasoned 290-516 s before its first token on a turn
// with three PDFs. Only checkpoints renewed the lease, and they follow text,
// so the claim's 4-minute lease had expired and the terminal CAS refused the
// answer the user had already read (CHAT_ATTEMPT_REVISION_CONFLICT).
const leaseWriter = (calls, persist = async (input) => {
  calls.push(input);
  return attemptRow(input, calls.length);
}) => createChatResponseAttemptCheckpointWriter(
  {
    userId: "user_1",
    assistantMessageId: "assistant_1",
    ownerId: "worker_1",
    initialRevision: 0,
    requestedModelId: "provider/model",
  },
  persist
);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("while no text arrives, the lease is renewed once a minute has passed since the last write", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const calls = [];
  const writer = leaseWriter(calls);
  writer.renewLease();
  await settle();
  assert.equal(calls.length, 0, "too soon after the claim");

  t.mock.timers.tick(CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS);
  writer.renewLease();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].partialContent, "", "nothing new is written");
  assert.equal(calls[0].expectedRevision, 0);
  const leaseMs = calls[0].leaseExpiresAt.getTime() - Date.now();
  assert.ok(leaseMs > 4 * 60_000 && leaseMs <= 5 * 60_000, String(leaseMs));

  // The next tick inside the minute does nothing; the one after renews again
  // against the revision the first renewal returned.
  writer.renewLease();
  await settle();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS);
  writer.renewLease();
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedRevision, 1);

  // Eight minutes of reasoning, then the answer: the terminal flush CASes
  // against the latest revision.
  for (let minute = 0; minute < 6; minute += 1) {
    t.mock.timers.tick(CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS);
    writer.renewLease();
    await settle();
  }
  const final = await writer.flush("the answer");
  assert.equal(final.partialContent, "the answer");
  assert.equal(calls.at(-1).expectedRevision, calls.length - 1);
});

test("a failed renewal is logged and retried, never the writer's failure", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  const calls = [];
  let refuse = true;
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(line));
  const writer = leaseWriter(calls, async (input) => {
    calls.push(input);
    if (refuse) throw Object.assign(new Error("db unavailable"), { name: "PrismaClientKnownRequestError", code: "P1001" });
    return attemptRow(input, calls.length);
  });
  t.mock.timers.tick(CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS);
  writer.renewLease();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
  const logged = JSON.parse(warnings[0]);
  assert.equal(logged.event, "chat_attempt_lease_renewal_failed");
  assert.equal(logged.code, "P1001");
  assert.doesNotMatch(warnings[0], /db unavailable/);

  refuse = false;
  t.mock.timers.tick(CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS);
  writer.renewLease();
  await settle();
  assert.equal(calls.length, 2);
  const final = await writer.flush("ok");
  assert.equal(final.partialContent, "ok");
});

test("a renewal never runs while text is queued or being checkpointed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 3_000_000 });
  const calls = [];
  const writer = leaseWriter(calls);
  writer.observe("x");
  t.mock.timers.tick(CHAT_DURABLE_LEASE_RENEWAL_INTERVAL_MS);
  writer.renewLease();
  await settle();
  // The queued text is what gets written; no lease-only write beside it.
  assert.ok(calls.every((call) => call.partialContent === "x"), JSON.stringify(calls.map((c) => c.partialContent)));
});

test("the chat route renews the attempt lease from the keepalive tick, before and after the first token", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  const tick = source.slice(source.indexOf("keepaliveWriter = setInterval(() => {"),
    source.indexOf("}, plan.intervalMs);"));
  assert.match(tick, /state: "awaiting_first_token"/);
  // Renewed before the phase branch: minutes of tool input after the first
  // token add no checkpoint either, and would let the lease run out.
  assert.ok(
    tick.indexOf("durableCheckpointWriter?.renewLease();") <
      tick.indexOf("if (!visibleTokenEmitted) {"),
    "the lease renewal must not be confined to the first-token wait"
  );
  // The tick ends only with the stream, not at the first visible token.
  assert.match(tick, /if \(streamState !== "open"\) \{\s*stopFirstTokenWatch\(\);/);
  assert.doesNotMatch(tick, /visibleTokenEmitted \|\| streamState/);
  // After the first token it writes only on provider evidence.
  assert.match(tick, /state: "provider_active"/);
  assert.match(tick, /!partsArrived \|\|/);
});

// S4: one failed checkpoint write used to be latched as the writer's failure,
// so the stream ran to the end and the final flush threw -- AI_STREAM_FAILED
// after the user had read the whole answer, and nothing saved.
const { ChatAttemptCasError } = await import("../lib/chatResponseAttemptPersistence.ts");
const transient = () =>
  Object.assign(new Error("connection closed"), { name: "PrismaClientKnownRequestError", code: "P1017" });
const big = (character) => character.repeat(3_000);

test("a transient checkpoint failure is not latched: the final flush persists the answer", async (t) => {
  t.mock.method(console, "warn", () => {});
  const calls = [];
  let failures = 1;
  const writer = leaseWriter(calls, async (input) => {
    calls.push(input);
    if (failures-- > 0) throw transient();
    return attemptRow(input, calls.length);
  });
  writer.observe(big("a"));
  await settle();
  assert.equal(calls.length, 1, "the first write was attempted and failed");
  const final = await writer.flush(big("a") + "end");
  assert.equal(final.partialContent, big("a") + "end");
  assert.equal(calls.at(-1).partialContent, big("a") + "end");
});

test("flush writes the final content itself when the cycle it started fails transiently", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(JSON.parse(line)));
  const calls = [];
  let failures = 2;
  const writer = leaseWriter(calls, async (input) => {
    calls.push(input);
    if (failures-- > 0) throw transient();
    return attemptRow(input, calls.length);
  });
  writer.observe(big("b"));
  await settle();
  const final = await writer.flush(big("b") + "!");
  assert.equal(final.partialContent, big("b") + "!");
  assert.equal(calls.length, 3);
  assert.deepEqual(warnings.map((warning) => [warning.event, warning.code]), [
    ["chat_attempt_checkpoint_retry", "P1017"],
    ["chat_attempt_checkpoint_retry", "P1017"],
  ]);
  assert.doesNotMatch(JSON.stringify(warnings), /connection closed/);
});

test("a persistent outage still fails the turn at the terminal flush", async (t) => {
  t.mock.method(console, "warn", () => {});
  const calls = [];
  const writer = leaseWriter(calls, async (input) => {
    calls.push(input);
    throw transient();
  });
  writer.observe(big("c"));
  await settle();
  await assert.rejects(writer.flush(big("c")), (error) => error.code === "P1017");
});

test("a CAS refusal (lost lease, the user's stop) is still latched and thrown by flush", async () => {
  const calls = [];
  const refusal = new ChatAttemptCasError("revision_conflict");
  const writer = leaseWriter(calls, async (input) => {
    calls.push(input);
    throw refusal;
  });
  writer.observe(big("d"));
  await settle();
  writer.observe(big("d") + "more");
  await settle();
  assert.equal(calls.length, 1, "a refused writer never writes again");
  await assert.rejects(writer.flush(big("d") + "more"), (error) => error === refusal);
});

test("after a transient failure, chunks wait out the interval instead of a write each", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 4_000_000 });
  const calls = [];
  let failures = 1;
  const writer = leaseWriter(calls, async (input) => {
    calls.push(input);
    if (failures-- > 0) throw transient();
    return attemptRow(input, calls.length);
  });
  writer.observe(big("e"));
  await settle();
  assert.equal(calls.length, 1);
  writer.observe(big("e") + big("f"));
  writer.observe(big("e") + big("f") + big("g"));
  await settle();
  assert.equal(calls.length, 1, "no write per chunk while backing off");
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].partialContent, big("e") + big("f") + big("g"));
});
