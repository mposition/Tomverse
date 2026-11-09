import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const session = { user: { id: "operator" }, expires: "2030-01-01" } as never;
const request = new Request("https://example.test/api/admin/product-research/suggestions/one");
let status: string;
let auditFails: boolean;
let audits: Record<string, unknown>[];
let updates: number;
const tx = {
  productResearchSuggestion: {
    updateMany: async (input: { where: { id: string; status: string }; data: { status: string; amuxIdeaId: null } }) => {
      assert.equal(input.where.id, "one");
      assert.equal(input.where.status, "open");
      if (status !== input.where.status) return { count: 0 };
      assert.equal(input.data.amuxIdeaId, null);
      status = input.data.status;
      updates += 1;
      return { count: 1 };
    },
  },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const before = status;
    try { return await fn(tx); } catch (error) { status = before; throw error; }
  },
} } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeAdminAuditLog: async (input: Record<string, unknown>) => {
    assert.equal(input.tx, tx);
    if (auditFails) throw new Error("audit unavailable");
    audits.push(input);
  },
} });
let closeSuggestion: typeof import("../../lib/productResearchScoutStore").closeSuggestion;
before(async () => { ({ closeSuggestion } = await import(mod("lib/productResearchScoutStore.ts"))); });
beforeEach(() => { status = "open"; auditFails = false; audits = []; updates = 0; });

const complete = () => closeSuggestion({ session, request, id: "one", next: { status: "completed" } });

test("completion records a distinct status and human audit atomically; repeating it does not write twice", async () => {
  assert.equal(await complete(), true);
  assert.equal(status, "completed");
  assert.equal(audits[0].action, "product_research.suggestion.completed");
  assert.equal(audits[0].session, session);
  assert.equal(audits[0].targetId, "one");
  assert.equal(await complete(), false);
  assert.equal(updates, 1);
  assert.equal(audits.length, 1);
});

test("a failed audit rolls completion back", async () => {
  auditFails = true;
  await assert.rejects(complete, /audit unavailable/);
  assert.equal(status, "open");
});

test("completion does not replace dismissed or sent decisions", async () => {
  for (const existing of ["dismissed", "sent"]) {
    status = existing;
    assert.equal(await complete(), false);
    assert.equal(status, existing);
  }
  assert.equal(updates, 0);
  assert.equal(audits.length, 0);
});
