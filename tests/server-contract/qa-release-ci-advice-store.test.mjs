import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const settings = new Map();
let audits, rejectAudit, scans, tail = Promise.resolve();
const tx = { appSetting: {
  findUnique: async ({ where }) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
  findMany: async ({ where }) => { scans += 1; return [...settings].filter(([key]) => key.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })); },
  upsert: async ({ where, create, update }) => { if (!settings.has(where.key)) settings.set(where.key, create.value); else if (update.value !== undefined) settings.set(where.key, update.value); },
  update: async ({ where, data }) => { assert.equal(settings.has(where.key), true); settings.set(where.key, data.value); },
} };
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { ...tx, $transaction: async (fn) => {
  const before = tail;
  let release;
  tail = new Promise((done) => { release = done; });
  await before;
  const saved = new Map(settings), auditCount = audits.length;
  try { return await fn(tx); } catch (error) {
    settings.clear(); for (const [key, value] of saved) settings.set(key, value);
    audits.length = auditCount; throw error;
  } finally { release(); }
} } } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {}, writeAdminAuditLog: async (entry) => {
    assert.equal(entry.tx, tx);
    if (rejectAudit) throw new Error("audit unavailable");
    audits.push(entry);
  },
} });
const { ciAdviceId, recordQaReleaseCiAdvice, readQaReleaseCiAdviceConsole, changeCiAdviceStatus, reserveCiAdviceSend } = await import(mod("lib/qaReleaseCiAdviceStore.ts"));
const { CI_ADVICE_ITEM_PREFIX, ciAdviceWorkBrief } = await import(mod("lib/qaReleaseCiAdviceActionsCore.ts"));
const NOW = "2026-11-13T08:32:00.000Z";
const suggestion = (title) => ({ title, why: "A measured six-minute check.", change: "Reuse existing fixtures.", savesMinutes: 2 });
const owner = { session: { user: { id: "operator" } }, request: new Request("https://app.example.test/admin/release") };
const seed = (list) => settings.set("qa_release.ci_advice", JSON.stringify({ askedAt: NOW, answeredAt: NOW, suggestions: list }));
test.beforeEach(() => { settings.clear(); audits = []; rejectAudit = false; scans = 0; });

test("legacy suggestions receive stable IDs and duplicate copies retain one durable item", async () => {
  const first = suggestion("One"); seed([first, first]);
  const view = await readQaReleaseCiAdviceConsole();
  assert.equal(view.suggestions.length, 1);
  assert.equal(view.suggestions[0].id, ciAdviceId(first));
  assert.equal(settings.size, 1, "reading must not write");
  assert.match(ciAdviceWorkBrief(view.suggestions[0]), /preserve security, billing and audit coverage/);
  assert.match(ciAdviceWorkBrief(view.suggestions[0]), /develop draft PR with ci:hold/);
});

test("new model rounds and failed asks preserve pending items and operator decisions", async () => {
  const first = suggestion("First"), second = suggestion("Second"); seed([first, second]);
  await changeCiAdviceStatus({ ...owner, id: ciAdviceId(first), status: "completed" });
  await recordQaReleaseCiAdvice("2026-11-14T08:32:00.000Z", [first, suggestion("Third")]);
  await recordQaReleaseCiAdvice("2026-11-15T08:32:00.000Z", null);
  const view = await readQaReleaseCiAdviceConsole();
  assert.equal(view.suggestions.length, 3);
  assert.equal(view.answeredAt, "2026-11-14T08:32:00.000Z");
  assert.equal(view.suggestions.find((item) => item.title === "First").status, "completed");
  assert.equal(view.suggestions.find((item) => item.title === "Second").status, "open");
  assert.equal(audits.length, 1);
});

test("a concurrent completion and dismissal cannot overwrite each other or duplicate an audit", async () => {
  const first = suggestion("One"), id = ciAdviceId(first); seed([first]);
  const [complete, dismiss] = await Promise.all([
    changeCiAdviceStatus({ ...owner, id, status: "completed" }), changeCiAdviceStatus({ ...owner, id, status: "dismissed" }),
  ]);
  assert.equal(complete.status, "completed"); assert.equal(dismiss, null);
  assert.equal((await changeCiAdviceStatus({ ...owner, id, status: "completed" })).status, "completed");
  assert.equal(audits.length, 1);
});

test("AMUX reservations survive subsequent rounds and block closing an unresolved send", async () => {
  const first = suggestion("One"), id = ciAdviceId(first); seed([first]);
  await reserveCiAdviceSend({ ...owner, id });
  assert.equal(scans, 0, "an action must not scan every historical item");
  await recordQaReleaseCiAdvice("2026-11-14T08:32:00.000Z", [first]);
  assert.equal((await reserveCiAdviceSend({ ...owner, id })).status, "sending_to_amux");
  assert.equal(await changeCiAdviceStatus({ ...owner, id, status: "completed" }), null);
  assert.equal(await changeCiAdviceStatus({ ...owner, id, status: "dismissed" }), null);
  await changeCiAdviceStatus({ ...owner, id, status: "sent", ideaId: "idea-one" });
  assert.equal((await readQaReleaseCiAdviceConsole()).suggestions[0].amuxIdeaId, "idea-one");
  assert.equal(await reserveCiAdviceSend({ ...owner, id }), null);
  assert.equal(audits.length, 2);
});

test("audit failure rolls back decisions and corrupt rows never become fresh actionable suggestions", async () => {
  const first = suggestion("One"), id = ciAdviceId(first); seed([first]); rejectAudit = true;
  await assert.rejects(changeCiAdviceStatus({ ...owner, id, status: "dismissed" }), /audit unavailable/);
  assert.equal((await readQaReleaseCiAdviceConsole()).suggestions[0].status, "open");
  assert.equal(settings.has(`${CI_ADVICE_ITEM_PREFIX}${id}`), false);
  settings.set(`${CI_ADVICE_ITEM_PREFIX}${id}`, "corrupt"); rejectAudit = false;
  assert.equal(await reserveCiAdviceSend({ ...owner, id }), null);
  assert.equal(await changeCiAdviceStatus({ ...owner, id, status: "completed" }), null);
  assert.equal(settings.get(`${CI_ADVICE_ITEM_PREFIX}${id}`), "corrupt");
});
