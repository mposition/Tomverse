import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { scanAmuxNodeDuplicates } from "@/lib/amux/ideaNodeDuplicateScanService";
import { sealAmuxNodeText } from "@/lib/amux/ideaNodeContentCore";
import { prisma } from "@/lib/prisma";

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url || process.env.DATABASE_URL !== url ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== url) ||
    !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    !/(?:^|[_-])test(?:[_-]|$)/i.test(new URL(url).pathname)) {
  throw new Error("AMUX v4 node scan requires an isolated loopback test database");
}

process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-node-scan-${randomUUID()}`;
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest",
  digestKey: randomBytes(32) };
const session = { user: { id: `synthetic-${randomUUID()}`,
  email: "synthetic@example.test" } } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/nodes",
  { method: "POST" });

after(async () => { await prisma.$disconnect(); });

test("a local transaction sees the exact-title node and rollback leaves no node", async () => {
  const nodeId = randomUUID();
  const content = sealAmuxNodeText(nodeId,
    { title: "검색 품질", description: "합성 테스트 설명" }, keys);
  const rollback = new Error("synthetic rollback");
  let candidateId: string | null = null;
  await assert.rejects(prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const auditId = await writeAdminAuditLog({ tx, session, request,
      action: "amux.v4.synthetic.node", targetType: "AmuxPortfolioNode",
      targetId: nodeId, summary: "Synthetic node scan fixture" });
    await tx.amuxPortfolioNode.create({ data: { id: nodeId,
      level: "initiative", parentId: null, state: "active", revision: 0,
      ...content,
      titleCiphertext: Uint8Array.from(content.titleCiphertext),
      descriptionCiphertext: Uint8Array.from(content.descriptionCiphertext),
      approvedByUserId: session.user!.id!,
      authorizationAuditLogId: auditId } });
    const scan = await scanAmuxNodeDuplicates(tx,
      { level: "initiative", parentId: null, title: "검색 품질" }, keys);
    candidateId = scan.candidates.find((candidate) => candidate.id === nodeId)?.id ?? null;
    assert.equal(scan.complete, true);
    throw rollback;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
  (error: unknown) => error === rollback);
  assert.equal(candidateId, nodeId);
  assert.equal(await prisma.amuxPortfolioNode.count({ where: { id: nodeId } }), 0);
});
