import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ANSWER_CREDIT_IDS,
  parseAnswerCreditIds,
  parseAnswerCreditsResponse,
  settledAnswerCredits,
} from "../lib/chatAnswerCreditsCore.ts";
import { watchAnswerCredits } from "../lib/chatAnswerCreditsClient.ts";
import { toChatRequestMessage, toGuestPersistableMessage } from "../lib/chatMessageSerialization.ts";

const row = (assistantMessageId: string | null, status: string, settledCredits: number) => ({
  assistantMessageId,
  status,
  settledCredits,
});

/* ------------------------------------------------------------ the rule -- */

test("an answer shows the sum of its final reservations", () => {
  const credits = settledAnswerCredits([
    row("a1", "settled", 3),
    row("a1", "settled", 2),
    // A replan's first reservation, settled at nothing.
    row("a1", "refunded", 0),
    row("a2", "settled", 1),
  ]);
  assert.deepEqual([...credits], [["a1", 5], ["a2", 1]]);
});

test("one open reservation withholds the whole answer", () => {
  const credits = settledAnswerCredits([
    row("a1", "settled", 4),
    row("a1", "reserved", 0),
    // Any status that is not final is open, including ones this code has never seen.
    row("a2", "settled", 4),
    row("a2", "guest_auto_preheld", 0),
  ]);
  assert.equal(credits.size, 0);
});

test("nothing is shown for a refund, a zero total, an unlinked row or a malformed figure", () => {
  const credits = settledAnswerCredits([
    row("refunded", "refunded", 0),
    row("zero", "settled", 0),
    row(null, "settled", 7),
    row("negative", "settled", -3),
    row("fraction", "settled", 1.5),
  ]);
  assert.equal(credits.size, 0);
});

/* ----------------------------------------------------------- the inputs -- */

test("the id list is one page of plain ids, or it is refused", () => {
  assert.deepEqual(parseAnswerCreditIds("a1,a2,a1"), ["a1", "a2"]);
  assert.deepEqual(parseAnswerCreditIds("2b7c4a0e-1f9a-4c3e-9a8b-0c1d2e3f4a5b"), [
    "2b7c4a0e-1f9a-4c3e-9a8b-0c1d2e3f4a5b",
  ]);
  for (const value of [null, "", "a1,,a2", "not an id", "a1;a2", "x".repeat(101)]) {
    assert.equal(parseAnswerCreditIds(value), null, String(value));
  }
  const page = Array.from({ length: MAX_ANSWER_CREDIT_IDS }, (_, index) => `a${index}`);
  assert.equal(parseAnswerCreditIds(page.join(","))?.length, MAX_ANSWER_CREDIT_IDS);
  assert.equal(parseAnswerCreditIds([...page, "one-more"].join(",")), null);
});

test("the browser keeps only positive whole figures from the response", () => {
  const parsed = parseAnswerCreditsResponse({
    credits: { a1: 3, a2: 0, a3: -1, a4: 2.5, a5: "4", a6: null },
  });
  assert.deepEqual([...parsed], [["a1", 3]]);
  for (const body of [null, {}, { credits: [] }, { credits: "3" }, "nonsense"]) {
    assert.equal(parseAnswerCreditsResponse(body).size, 0, JSON.stringify(body));
  }
});

/* ------------------------------------------------ after the stream ends -- */

const immediately = async () => {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the browser asks until the figure is settled, reports it once, then stops", async () => {
  const answers: Array<Map<string, number> | null> = [new Map(), null, new Map([["a1", 4]])];
  const asked: string[][] = [];
  const reported: number[] = [];
  watchAnswerCredits({
    conversationId: "c1",
    messageId: "a1",
    onSettled: (credits) => reported.push(credits),
    delaysMs: [1, 1, 1, 1, 1],
    sleep: immediately,
    fetchCredits: async (conversationId, ids) => {
      assert.equal(conversationId, "c1");
      asked.push([...ids]);
      // A read that failed (null) is one of the scripted answers, not the end of the script.
      return answers.length > 0 ? answers.shift()! : new Map([["a1", 99]]);
    },
  });
  for (let i = 0; i < 20; i += 1) await settle();
  assert.deepEqual(asked, [["a1"], ["a1"], ["a1"]]);
  assert.deepEqual(reported, [4]);
});

test("an answer that is never charged is never reported, and asking stops on its own", async () => {
  let asks = 0;
  const reported: number[] = [];
  watchAnswerCredits({
    conversationId: "c1",
    messageId: "a1",
    onSettled: (credits) => reported.push(credits),
    delaysMs: [1, 1, 1],
    sleep: immediately,
    fetchCredits: async () => {
      asks += 1;
      if (asks === 2) throw new Error("network");
      return new Map();
    },
  });
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(asks, 3);
  assert.deepEqual(reported, []);
});

test("stopping the watch asks nothing more and reports nothing", async () => {
  let asks = 0;
  const reported: number[] = [];
  const stop = watchAnswerCredits({
    conversationId: "c1",
    messageId: "a1",
    onSettled: (credits) => reported.push(credits),
    delaysMs: [1, 1],
    sleep: immediately,
    fetchCredits: async () => {
      asks += 1;
      return new Map([["a1", 2]]);
    },
  });
  stop();
  for (let i = 0; i < 20; i += 1) await settle();
  assert.equal(asks, 0);
  assert.deepEqual(reported, []);
});

/* ------------------------------------------------- it never leaves here -- */

test("the figure stays out of the /api/chat transcript and the guest snapshot", () => {
  const answer = {
    id: "a1",
    role: "assistant" as const,
    content: "Done",
    status: "normal" as const,
    modelId: "gpt-5-6-luna",
    settledCredits: 3,
  };
  assert.equal("settledCredits" in toChatRequestMessage(answer), false);
  assert.equal("settledCredits" in toGuestPersistableMessage(answer), false);
});
