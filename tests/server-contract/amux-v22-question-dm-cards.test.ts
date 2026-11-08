// The relay card of a v22 worker question (owner, 2026-11-08): the Decision
// Maker escalated AMUX-AUTOFILE-003 because its card held the question alone,
// titled by a Task id, with no context or paths. The card now names the
// asking card and carries what the worker found and the files it points at.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const QUESTION_ID = "e33984a0-9828-45e1-9999-d0bf594aeeb6";
const resultText = [
  "Added the trailer type and parser.",
  'AMUX_OWNER_QUESTION: {"question":"Which retry signal should the helper make?","unblocks":"the helper",' +
    '"options":[{"id":"a","label":"Toast"},{"id":"b","label":"Inline on the file card"}],' +
    '"context":"lib/amux/fileRetry.ts has no signal yet.","paths":["lib/amux/fileRetry.ts"]}',
].join("\n");
const titleReads: unknown[] = [];

mock.module(mod("lib/amux/v22TaskResultStore.ts"), { namedExports: {
  openAmuxV22TaskResultRow: async () => resultText,
} });
mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
  readAmuxCardTitle: async (row: unknown) => { titleReads.push(row); return "File retry trailer signal"; },
} });

const service = import(mod("lib/amux/v22OwnerQuestionDmService.ts"));

const pendingRow = (overrides: Record<string, unknown> = {}) => ({
  questionId: QUESTION_ID, taskId: "cdd90973-16bd-4729-8940-1219cc639be5", attemptId: "attempt-1",
  worker: "codex-impl", sequence: 1, sourceSha256: "a".repeat(64), provider: "openai",
  ideaId: "idea-1", ciphertext: new Uint8Array([1]), keyId: "k", keyVersion: 1, digest: "d",
  digestKeyId: "dk", bodyPurgedAt: null, displayKey: "AMUX-AUTOFILE-003", cardTitle: "sealed",
  sourceSystem: "admin-idea-v4", sourceSnapshot: { ideaId: "idea-1" }, v4TitleCiphertext: new Uint8Array([2]),
  v4TitleKeyId: "tk", v4TitleKeyVersion: 1, v4TitleDigest: "td", v4TitleDigestKeyId: "tdk", ...overrides,
});

test("a question's relay card names the asking card and carries the worker's context and paths", async () => {
  const { openAmuxV22QuestionCards } = await service;
  const [card] = await openAmuxV22QuestionCards([pendingRow()] as never);
  assert.equal(card.title, "AMUX-AUTOFILE-003 File retry trailer signal");
  assert.match(card.context, /^Card: AMUX-AUTOFILE-003 "File retry trailer signal", question 1 from worker codex-impl\./);
  assert.match(card.context, /lib\/amux\/fileRetry\.ts has no signal yet\./);
  assert.deepEqual(card.context_paths, ["lib/amux/fileRetry.ts"]);
  assert.deepEqual(card.options.map((option: { id: string }) => option.id), ["a", "b"]);
  // The card's own sealed title is opened with the card's own row.
  assert.deepEqual(titleReads.at(-1), { id: "cdd90973-16bd-4729-8940-1219cc639be5", title: "sealed",
    sourceSystem: "admin-idea-v4", sourceSnapshot: { ideaId: "idea-1" }, v4TitleCiphertext: new Uint8Array([2]),
    v4TitleKeyId: "tk", v4TitleKeyVersion: 1, v4TitleDigest: "td", v4TitleDigestKeyId: "tdk" });
});

test("the sync read selects the asking card's key and title in the statement it already sends", async () => {
  const { readAmuxV22QuestionSyncRows } = await service;
  const sent: string[] = [];
  // Every other read of the tick (the refused session answers) finds nothing.
  const model = { findMany: async () => [], findFirst: async () => null, count: async () => 0 };
  const tx = new Proxy({ $queryRaw: async (strings: TemplateStringsArray) => { sent.push(strings.join("$")); return []; } },
    { get: (target, key) => key in target ? target[key as keyof typeof target] : model });
  await readAmuxV22QuestionSyncRows(tx as never, new Date());
  const pending = sent.find((sql) => sql.includes('FROM "AmuxV22TaskQuestion" q') && sql.includes('"localCardId" IS NULL'));
  assert.ok(pending);
  assert.match(pending, /w\."displayKey", w\."title" AS "cardTitle", w\."sourceSystem"/);
  assert.match(pending, /w\."v4TitleCiphertext", w\."v4TitleKeyId",\s*w\."v4TitleKeyVersion", w\."v4TitleDigest", w\."v4TitleDigestKeyId"/);
});
