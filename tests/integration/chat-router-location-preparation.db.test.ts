import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("a saved answer admits one concurrent preparation and one unexpired resume", async () => {
  assert.equal(process.env.NODE_ENV, "test");
  const target = process.env.TEST_DATABASE_URL;
  assert.ok(target && target === process.env.DATABASE_URL, "Use the DB integration runner");
  const url = new URL(target);
  assert.match(url.pathname + "_" + (url.searchParams.get("schema") ?? ""), /(?:^|[\/_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i);
  const { prisma } = await import("../../lib/prisma");
  const { claimRouterLocation, consumeRouterLocation } = await import("../../lib/chatRouterLocationPreparation");
  const user = await prisma.user.create({ data: {} });
  try {
    const { id: conversationId } = await prisma.conversation.create({
      data: { userId: user.id, title: "Location fixture", productKey: "chat", selectedModels: "[]" },
    });
    const key = { conversationId, sourceUserMessageId: randomUUID(), assistantMessageId: randomUUID() };
    const requestDigest = "a".repeat(64);
    const claims = await Promise.allSettled([claimRouterLocation(key, requestDigest), claimRouterLocation(key, requestDigest)]);
    assert.equal(claims.filter(row => row.status === "fulfilled").length, 1);
    const rejected = claims.find(row => row.status === "rejected");
    assert.equal(rejected?.reason.code, "CHAT_ROUTER_LOCATION_UNAVAILABLE");
    const otherAnswer = { ...key, assistantMessageId: randomUUID() };
    await assert.rejects(claimRouterLocation(otherAnswer, requestDigest), { code: "CHAT_ROUTER_LOCATION_UNAVAILABLE" });
    await assert.rejects(consumeRouterLocation(otherAnswer, requestDigest), { code: "CHAT_ROUTER_LOCATION_UNAVAILABLE" });
    await assert.rejects(consumeRouterLocation(key, "changed"), { code: "CHAT_ROUTER_LOCATION_UNAVAILABLE" });
    const resumes = await Promise.allSettled([consumeRouterLocation(key, requestDigest), consumeRouterLocation(key, requestDigest)]);
    assert.equal(resumes.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(resumes.find(row => row.status === "rejected")?.reason.code, "CHAT_ROUTER_LOCATION_UNAVAILABLE");
    const expired = { ...key, sourceUserMessageId: randomUUID(), assistantMessageId: randomUUID() };
    await prisma.chatRouterLocationPreparation.create({ data: { ...expired, requestDigest, expiresAt: new Date(0) } });
    await assert.rejects(consumeRouterLocation(expired, requestDigest), { code: "CHAT_ROUTER_LOCATION_UNAVAILABLE" });
    await prisma.conversation.delete({ where: { id: conversationId } });
    assert.equal(await prisma.chatRouterLocationPreparation.count({ where: { conversationId } }), 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
