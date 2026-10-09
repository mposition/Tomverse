import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/amux/ideaKeyConfig.ts"), { namedExports: {
  loadCurrentAmuxContentKeys: () => { throw new Error("key unavailable"); },
} });

test("unavailable consent key only withholds optional publication", async () => {
  const { readAmuxV22PublicPrConsent } = await import(
    mod("lib/amux/v22PublicPrConsent.ts"));
  const db = {
    amuxWorkItem: { findUnique: async () => ({ id: "task-1",
      v4SourceApprovalId: "approval-1", sourceSystem: "admin-idea-v4",
      cardType: "task", taskRole: "implement" }) },
    amuxIdeaUnitDecision: { findUnique: async () => ({ id: "approval-1",
      finalAuditLogId: "audit-1" }) },
    adminAuditLog: { findUnique: async () => ({ id: "audit-1" }) },
  };
  assert.equal(await readAmuxV22PublicPrConsent("task-1", db as never), false);
  const failedDb = { ...db,
    amuxWorkItem: { findUnique: async () => { throw new Error("db unavailable"); } } };
  await assert.rejects(readAmuxV22PublicPrConsent("task-1", failedDb as never),
    /db unavailable/);
});
