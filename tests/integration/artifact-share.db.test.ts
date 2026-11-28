import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { buildAccountDataExport } from "@/lib/accountDataExport";
import { ARTIFACT_SHARING_FLAG_KEY } from "@/lib/artifactShareAccess";
import {
  deleteExpiredArtifactShares,
  findArtifactShare,
  prepareArtifactShare,
  publishArtifactShare,
  readPublicArtifactShare,
  revokeArtifactShare,
  sha256Hex,
  shareAfterPublishFailure,
  isSourceKeyConflict,
} from "@/lib/artifactShareService";
import { isArtifactSharingEnabled } from "@/lib/artifactShareSettings";
import { prisma } from "@/lib/prisma";

/**
 * Share links for previewed pages against a real database, with the schema
 * built from the migrations (its CHECK constraints included).
 *
 * The rules that matter are conditions on queries and on foreign keys: that
 * the page published is text the owner's answer contains, that a lock or a
 * temporary chat refuses in the publishing statement itself, that an expired
 * or locked link is never served, and that every way the source goes away
 * takes the link with it. None of that is visible to a mocked Prisma.
 */

const OPEN = { sharingAvailable: true, planAllowsSharing: true };
/** The switch as the public route passes it when sharing is on. */
const LIVE = { sharingAvailable: true };
const PAGE = "<!doctype html>\n<h1>Quarterly chart</h1>\n<script>document.title = 'x'</script>";
const ANSWER = `Here is the page:\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\nOpen the preview to see it.`;

const reset = async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "ArtifactShare", "MessageArtifact", "ResearchReportRevision", "ResearchPreviewRun",
      "ConversationContinuationBridge", "Message", "Conversation", "User"
    RESTART IDENTITY CASCADE
  `);
  await prisma.appSetting.deleteMany({ where: { key: { in: [ARTIFACT_SHARING_FLAG_KEY, "feature.publicSharingEnabled"] } } });
  // The plan catalogue's defaults (every plan shares) come back when the row is gone.
  await prisma.billingPlan.deleteMany({ where: { id: "free" } });
};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seed = async (conversation: { password?: string | null; temporaryExpiresAt?: Date | null } = {}) => {
  const user = await prisma.user.create({ data: { email: `sharer-${randomUUID()}@example.test` } });
  const chat = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "A private conversation",
      selectedModels: '["gpt-6-luna"]',
      password: conversation.password ?? null,
      temporaryExpiresAt: conversation.temporaryExpiresAt ?? null,
      // A temporary chat keeps no memory (Conversation_temporary_scope_check).
      ...(conversation.temporaryExpiresAt ? { memoryMode: "off" } : {}),
    },
  });
  await prisma.message.create({ data: { conversationId: chat.id, role: "user", content: "Make me a chart page" } });
  const answer = await prisma.message.create({
    data: { conversationId: chat.id, role: "assistant", content: ANSWER, modelId: "gpt-6-luna" },
  });
  return { user, chat, answer };
};

const codeSource = (messageId: string, code = PAGE, place: { blockIndex?: number; language?: string } = {}) => ({
  kind: "code_block" as const,
  messageId,
  blockIndex: place.blockIndex ?? 0,
  language: place.language ?? "html",
  code,
});

const share = async (userId: string, messageId: string) => {
  const prepared = await prepareArtifactShare(userId, codeSource(messageId), OPEN);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  if (!prepared.ok) throw new Error("unreachable");
  const published = await publishArtifactShare(userId, prepared.prepared);
  assert.ok(published);
  return { prepared: prepared.prepared, ...published };
};

test("a code block from the owner's answer is published as a snapshot and opened by its token", async () => {
  const { user, answer } = await seed();
  const first = await share(user.id, answer.id);
  assert.equal(first.created, true);
  assert.match(first.share.token, /^[A-Za-z0-9_-]{32}$/);

  const page = await readPublicArtifactShare(first.share.token, LIVE);
  assert.equal(page?.content, PAGE);
  assert.equal(page?.previewKind, "html");

  // Pressing Share again answers the same link rather than making a second.
  const second = await share(user.id, answer.id);
  assert.equal(second.created, false);
  assert.equal(second.share.token, first.share.token);
  assert.equal(await prisma.artifactShare.count(), 1);

  const found = await findArtifactShare(user.id, first.prepared.sourceKey);
  assert.equal(found?.id, first.share.id);

  // A later edit of the answer does not change the shared page: it is the snapshot.
  await prisma.message.update({ where: { id: answer.id }, data: { content: "edited away" } });
  assert.equal((await readPublicArtifactShare(first.share.token, LIVE))?.content, PAGE);
});

test("text the answer does not contain, another account's answer, and a user message are not sources", async () => {
  const { user, answer } = await seed();
  const stranger = await seed();
  const invented = await prepareArtifactShare(user.id, codeSource(answer.id, "<form action=https://evil.test><input name=pw></form>"), OPEN);
  assert.deepEqual(invented, { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 });

  const notMine = await prepareArtifactShare(user.id, codeSource(stranger.answer.id), OPEN);
  assert.deepEqual(notMine, { ok: false, code: "ARTIFACT_SHARE_SOURCE_NOT_FOUND", status: 404 });

  const prompt = await prisma.message.findFirstOrThrow({ where: { conversationId: answer.conversationId, role: "user" } });
  const fromPrompt = await prepareArtifactShare(user.id, codeSource(prompt.id, "Make me a chart page"), OPEN);
  assert.equal(fromPrompt.ok, false);

  const otherLanguage = await prepareArtifactShare(user.id, { ...codeSource(answer.id), language: "python" }, OPEN);
  assert.equal(otherLanguage.ok, false);
  assert.equal(await prisma.artifactShare.count(), 0);
});

test("switches, plan, locked and temporary conversations refuse before anything is written", async () => {
  const { user, answer } = await seed();
  assert.equal((await prepareArtifactShare(user.id, codeSource(answer.id), { sharingAvailable: false, planAllowsSharing: true })).ok, false);
  const plan = await prepareArtifactShare(user.id, codeSource(answer.id), { sharingAvailable: true, planAllowsSharing: false });
  assert.equal(plan.ok === false && plan.code, "PLAN_FEATURE_NOT_INCLUDED");

  const locked = await seed({ password: "hashed-password" });
  const lockedOutcome = await prepareArtifactShare(locked.user.id, codeSource(locked.answer.id), OPEN);
  assert.equal(lockedOutcome.ok === false && lockedOutcome.code, "CONVERSATION_LOCKED");

  const temporary = await seed({ temporaryExpiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  const temporaryOutcome = await prepareArtifactShare(temporary.user.id, codeSource(temporary.answer.id), OPEN);
  assert.equal(temporaryOutcome.ok === false && temporaryOutcome.code, "TEMPORARY_CHAT");
  assert.equal(await prisma.artifactShare.count(), 0);
});

test("a lock set between the check and the write publishes nothing; a lock set later takes the link down", async () => {
  const { user, chat, answer } = await seed();
  const prepared = await prepareArtifactShare(user.id, codeSource(answer.id), OPEN);
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  await prisma.conversation.update({ where: { id: chat.id }, data: { password: "hashed-password" } });
  assert.equal(await publishArtifactShare(user.id, prepared.prepared), null);
  assert.equal(await prisma.artifactShare.count(), 0);

  await prisma.conversation.update({ where: { id: chat.id }, data: { password: null } });
  const published = await share(user.id, answer.id);
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));
  await prisma.conversation.update({ where: { id: chat.id }, data: { password: "hashed-password" } });
  assert.equal(await readPublicArtifactShare(published.share.token, LIVE), null);
});

test("an expired link is not served or offered, and sharing again issues a new token", async () => {
  const { user, answer } = await seed();
  const first = await share(user.id, answer.id);
  await prisma.artifactShare.update({
    where: { id: first.share.id },
    data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), expiresAt: new Date(Date.now() - 60 * 1000) },
  });
  assert.equal(await readPublicArtifactShare(first.share.token, LIVE), null);
  assert.equal(await findArtifactShare(user.id, first.prepared.sourceKey), null);

  const renewed = await share(user.id, answer.id);
  assert.equal(renewed.created, true);
  assert.notEqual(renewed.share.token, first.share.token);
  assert.equal(await readPublicArtifactShare(first.share.token, LIVE), null);
  assert.ok(await readPublicArtifactShare(renewed.share.token, LIVE));
  assert.equal(await prisma.artifactShare.count(), 1);
});

test("only the owner can stop a link, and a stopped link is gone", async () => {
  const { user, answer } = await seed();
  const stranger = await seed();
  const published = await share(user.id, answer.id);
  assert.equal(await revokeArtifactShare(stranger.user.id, published.share.id), false);
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));
  assert.equal(await revokeArtifactShare(user.id, published.share.id), true);
  assert.equal(await readPublicArtifactShare(published.share.token, LIVE), null);
  assert.equal(await prisma.artifactShare.count(), 0);
  assert.equal(await revokeArtifactShare(user.id, published.share.id), false);
});

test("deleting the answer, the conversation, the generated file or the account takes the link with it", async () => {
  const byMessage = await seed();
  await share(byMessage.user.id, byMessage.answer.id);
  await prisma.message.delete({ where: { id: byMessage.answer.id } });
  assert.equal(await prisma.artifactShare.count(), 0);

  const byConversation = await seed();
  await share(byConversation.user.id, byConversation.answer.id);
  await prisma.conversation.delete({ where: { id: byConversation.chat.id } });
  assert.equal(await prisma.artifactShare.count(), 0);

  const byFile = await seed();
  const artifact = await prisma.messageArtifact.create({
    data: {
      messageId: byFile.answer.id,
      conversationId: byFile.chat.id,
      userId: byFile.user.id,
      format: "html",
      filename: "chart.html",
      mediaType: "text/html; charset=utf-8",
      byteSize: Buffer.byteLength(PAGE),
      status: "ready",
      objectKey: `message-artifacts/${byFile.user.id}/${randomUUID()}.html`,
    },
  });
  // A file's bytes come from object storage in prepareArtifactShare; publishing is the same statement either way.
  const fromFile = await publishArtifactShare(byFile.user.id, {
    conversationId: byFile.chat.id,
    messageId: byFile.answer.id,
    artifactId: artifact.id,
    sourceKey: `artifact:${artifact.id}`,
    blockPrefix: null,
    previewKind: "html",
    language: "html",
    title: "chart.html",
    content: PAGE,
  });
  assert.equal(fromFile?.created, true);
  assert.equal((await readPublicArtifactShare(fromFile!.share.token, LIVE))?.title, "chart.html");
  await prisma.messageArtifact.delete({ where: { id: artifact.id } });
  assert.equal(await prisma.artifactShare.count(), 0);

  const byAccount = await seed();
  const published = await share(byAccount.user.id, byAccount.answer.id);
  const exported = JSON.stringify(await buildAccountDataExport(byAccount.user.id));
  assert.ok(exported.includes("shared_pages"), "the shares are in the account export");
  assert.ok(exported.includes("Quarterly chart"));
  assert.equal(exported.includes(published.share.token), false, "the link token is withheld from the export");
  await prisma.user.delete({ where: { id: byAccount.user.id } });
  assert.equal(await prisma.artifactShare.count(), 0);
});

test("the table refuses a page it could not show and a kind that does not match its language", async () => {
  const { user, chat, answer } = await seed();
  const row = (overrides: Record<string, unknown>) => ({
    token: randomUUID(),
    userId: user.id,
    conversationId: chat.id,
    messageId: answer.id,
    sourceKey: `code:${answer.id}:${randomUUID()}`,
    sourceKind: "code_block",
    previewKind: "html",
    language: "html",
    content: PAGE,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  });
  await assert.rejects(prisma.artifactShare.create({ data: row({ content: "x".repeat(1_000_001) }) }));
  await assert.rejects(prisma.artifactShare.create({ data: row({ content: "" }) }));
  await assert.rejects(prisma.artifactShare.create({ data: row({ previewKind: "react", language: "html" }) }));
  await assert.rejects(prisma.artifactShare.create({ data: row({ language: "python" }) }));
  await assert.rejects(prisma.artifactShare.create({ data: row({ sourceKind: "artifact" }) }), "an artifact link must name its file");
  await assert.rejects(prisma.artifactShare.create({ data: row({ expiresAt: new Date(Date.now() - 1000) }) }));
  await prisma.artifactShare.create({ data: row({ content: "x".repeat(1_000_000) }) });
  assert.equal(await prisma.artifactShare.count(), 1);
});

test("the switch is on only when stored as exactly \"true\" and public sharing is not stopped", async () => {
  assert.equal(await isArtifactSharingEnabled(), false);
  await prisma.appSetting.create({ data: { key: ARTIFACT_SHARING_FLAG_KEY, value: "TRUE" } });
  assert.equal(await isArtifactSharingEnabled(), false);
  await prisma.appSetting.update({ where: { key: ARTIFACT_SHARING_FLAG_KEY }, data: { value: "true" } });
  assert.equal(await isArtifactSharingEnabled(), true);
  await prisma.appSetting.create({ data: { key: "feature.publicSharingEnabled", value: "false" } });
  assert.equal(await isArtifactSharingEnabled(), false);
});

test("a block whose line endings differ is the same source, keyed on the hash the client sends", async () => {
  const { user, answer } = await seed();
  const lf = await prepareArtifactShare(user.id, codeSource(answer.id), OPEN);
  const crlf = await prepareArtifactShare(user.id, codeSource(answer.id, PAGE.replace(/\n/g, "\r\n")), OPEN);
  assert.ok(lf.ok && crlf.ok);
  if (!lf.ok || !crlf.ok) return;
  assert.equal(crlf.prepared.sourceKey, lf.prepared.sourceKey);
  assert.equal(lf.prepared.sourceKey, `code:${answer.id}:0:html:${sha256Hex(PAGE)}`);
  assert.equal(crlf.prepared.content, PAGE);
});

/* ---------- a link closes when its source stops qualifying ---------- */

const continueImport = (userId: string, conversationId: string) =>
  prisma.conversationContinuationBridge.create({
    data: {
      userId,
      conversationId,
      provider: "chatgpt",
      sourceImportedAt: new Date(),
      sourceConversationDigest: "artifact-share-source",
      sourceDigestVersion: 1,
      sourceMessageCount: 1,
      seedFromOrdinal: 0,
      seedToOrdinal: 0,
      seedMessageCount: 1,
      seedTruncatedMessageCount: 0,
      seedOmittedMessageCount: 0,
      contextSeedVersion: "ext-seed-v1",
      idempotencyKey: randomUUID(),
    },
  });

/** A finished engine-2 Research run behind the answer, with only public URL sources until a test says otherwise. */
const attachResearchRun = async (seeded: Awaited<ReturnType<typeof seed>>) => {
  const prompt = await prisma.message.findFirstOrThrow({ where: { conversationId: seeded.chat.id, role: "user" } });
  const run = await prisma.researchPreviewRun.create({
    data: {
      userId: seeded.user.id,
      conversationId: seeded.chat.id,
      sourceUserMessageId: prompt.id,
      assistantMessageId: seeded.answer.id,
      modelId: "gemini-3-1-pro",
      provider: "google",
      apiModel: "gemini-3.1-pro-preview",
      locale: "en",
      currentDate: "2026-11-28",
      questionDigest: `sha256:${"a".repeat(64)}`,
      totalOutputTokens: 4096,
      inputTokenCeiling: 10,
      searchSurchargeCredits: 0,
      engineVersion: 2,
      status: "completed",
      approvedCredits: 0,
      inputManifest: { version: 1, entries: [{ type: "url", url: "https://example.test/report" }] },
    },
  });
  await prisma.message.update({ where: { id: seeded.answer.id }, data: { researchRunId: run.id } });
  return run;
};

test("a conversation that becomes a continuation closes its link, and the same rule refuses a new one", async () => {
  const seeded = await seed();
  const published = await share(seeded.user.id, seeded.answer.id);
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));

  const bridge = await continueImport(seeded.user.id, seeded.chat.id);
  assert.equal(await readPublicArtifactShare(published.share.token, LIVE), null);
  const refused = await prepareArtifactShare(seeded.user.id, codeSource(seeded.answer.id), OPEN);
  assert.equal(refused.ok === false && refused.code, "CONTINUATION_SHARE_NOT_SUPPORTED");
  // Closed, not deleted -- as a lock closes a link.
  assert.equal(await prisma.artifactShare.count(), 1);

  await prisma.conversationContinuationBridge.delete({ where: { id: bridge.id } });
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));
});

test("a Research answer that comes to use private sources closes its link, by manifest or by report revision", async () => {
  const seeded = await seed();
  const run = await attachResearchRun(seeded);
  // Public sources only: the link may be made and opens.
  const published = await share(seeded.user.id, seeded.answer.id);
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));

  // A private source (an attached file) joins the run's manifest.
  await prisma.researchPreviewRun.update({
    where: { id: run.id },
    data: { inputManifest: { version: 1, entries: [{ type: "url", url: "https://example.test/report" }, { type: "file", attachmentId: "att_1" }] } },
  });
  assert.equal(await readPublicArtifactShare(published.share.token, LIVE), null);
  const refused = await prepareArtifactShare(seeded.user.id, codeSource(seeded.answer.id), OPEN);
  assert.equal(refused.ok === false && refused.code, "RESEARCH_SHARE_PRIVATE");

  // Back to public sources, but the current report revision is marked as containing private material.
  await prisma.researchPreviewRun.update({
    where: { id: run.id },
    data: { inputManifest: { version: 1, entries: [{ type: "url", url: "https://example.test/report" }] }, currentReportRevision: 1 },
  });
  await prisma.researchReportRevision.create({
    data: { runId: run.id, revision: 1, planRevision: 0, inputRevision: 0, author: "model", qualityStatus: "complete", document: {}, containsPrivate: true },
  });
  assert.equal(await readPublicArtifactShare(published.share.token, LIVE), null);

  await prisma.researchReportRevision.update({ where: { runId_revision: { runId: run.id, revision: 1 } }, data: { containsPrivate: false } });
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));
});

test("an owner whose plan stops including sharing has their links closed", async () => {
  const seeded = await seed();
  const published = await share(seeded.user.id, seeded.answer.id);
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));

  // The owner's plan (Free, the default) is changed in the plan catalogue to exclude sharing.
  await prisma.billingPlan.upsert({
    where: { id: "free" },
    update: { allowSharing: false },
    create: { id: "free", name: "Free", tier: "Free", monthlyPriceCents: 0, allowSharing: false },
  });
  assert.equal(await readPublicArtifactShare(published.share.token, LIVE), null);

  await prisma.billingPlan.update({ where: { id: "free" }, data: { allowSharing: true } });
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));
});

test("with the switch off the read refuses before it reads the link", async () => {
  const seeded = await seed();
  const published = await share(seeded.user.id, seeded.answer.id);
  assert.equal(await readPublicArtifactShare(published.share.token, { sharingAvailable: false }), null);
  assert.ok(await readPublicArtifactShare(published.share.token, LIVE));
});

/* ---------- expired links are removed, and the write re-checks the conversation ---------- */

const expire = (shareId: string) =>
  prisma.artifactShare.update({
    where: { id: shareId },
    data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000), expiresAt: new Date(Date.now() - 60 * 1000) },
  });

test("an expired link is removed where it is met: the owner's status, the public read and a new share", async () => {
  const { user, answer } = await seed();

  const byStatus = await share(user.id, answer.id);
  await expire(byStatus.share.id);
  assert.equal(await findArtifactShare(user.id, byStatus.prepared.sourceKey), null);
  assert.equal(await prisma.artifactShare.count(), 0, "the owner's status check removed it");

  const byRead = await share(user.id, answer.id);
  await expire(byRead.share.id);
  assert.equal(await readPublicArtifactShare(byRead.share.token, LIVE), null);
  assert.equal(await prisma.artifactShare.count(), 0, "the public read removed it");

  const byNewShare = await share(user.id, answer.id);
  await expire(byNewShare.share.id);
  const renewed = await share(user.id, answer.id);
  assert.equal(renewed.created, true);
  assert.notEqual(renewed.share.id, byNewShare.share.id);
  assert.equal(await prisma.artifactShare.findUnique({ where: { id: byNewShare.share.id } }), null);
  assert.equal(await prisma.artifactShare.count(), 1, "the new share replaced it");
});

test("the maintenance sweep removes every expired link and leaves the live ones", async () => {
  const first = await seed();
  const second = await seed();
  const expiredA = await share(first.user.id, first.answer.id);
  const expiredB = await share(second.user.id, second.answer.id);
  const thirdAnswer = await prisma.message.create({
    data: { conversationId: first.chat.id, role: "assistant", content: ANSWER, modelId: "gpt-6-luna" },
  });
  const live = await share(first.user.id, thirdAnswer.id);
  await expire(expiredA.share.id);
  await expire(expiredB.share.id);

  assert.deepEqual(await deleteExpiredArtifactShares(), { count: 2 });
  const left = await prisma.artifactShare.findMany({ select: { id: true } });
  assert.deepEqual(left.map((row) => row.id), [live.share.id]);
  assert.deepEqual(await deleteExpiredArtifactShares(), { count: 0 });
});

test("a continuation or a non-chat kind that lands between the check and the write publishes nothing", async () => {
  const continued = await seed();
  const beforeBridge = await prepareArtifactShare(continued.user.id, codeSource(continued.answer.id), OPEN);
  assert.ok(beforeBridge.ok);
  if (!beforeBridge.ok) return;
  await continueImport(continued.user.id, continued.chat.id);
  assert.equal(await publishArtifactShare(continued.user.id, beforeBridge.prepared), null);

  const changedKind = await seed();
  const beforeKind = await prepareArtifactShare(changedKind.user.id, codeSource(changedKind.answer.id), OPEN);
  assert.ok(beforeKind.ok);
  if (!beforeKind.ok) return;
  await prisma.conversation.update({ where: { id: changedKind.chat.id }, data: { kind: "image" } });
  assert.equal(await publishArtifactShare(changedKind.user.id, beforeKind.prepared), null);

  assert.equal(await prisma.artifactShare.count(), 0);
});

/* ---------- one link per block: its language, a changed text, and the one race a publish answers ---------- */

test("the same text written as HTML and as JSX in one answer is two links, looked up and stopped apart", async () => {
  const { user, answer } = await seed();
  const text = "<p>same</p>";
  await prisma.message.update({
    where: { id: answer.id },
    data: { content: "```html\n" + text + "\n```\n\nAs a component:\n\n```jsx\n" + text + "\n```" },
  });
  const asHtml = await prepareArtifactShare(user.id, codeSource(answer.id, text, { blockIndex: 0, language: "html" }), OPEN);
  const asJsx = await prepareArtifactShare(user.id, codeSource(answer.id, text, { blockIndex: 1, language: "jsx" }), OPEN);
  assert.ok(asHtml.ok && asJsx.ok);
  if (!asHtml.ok || !asJsx.ok) return;
  assert.notEqual(asHtml.prepared.sourceKey, asJsx.prepared.sourceKey);

  const htmlLink = await publishArtifactShare(user.id, asHtml.prepared);
  const jsxLink = await publishArtifactShare(user.id, asJsx.prepared);
  assert.ok(htmlLink?.created && jsxLink?.created);
  assert.notEqual(htmlLink!.share.token, jsxLink!.share.token);
  assert.equal((await readPublicArtifactShare(htmlLink!.share.token, LIVE))?.previewKind, "html");
  assert.equal((await readPublicArtifactShare(jsxLink!.share.token, LIVE))?.previewKind, "react");
  assert.equal((await findArtifactShare(user.id, asHtml.prepared.sourceKey))?.id, htmlLink!.share.id);
  assert.equal((await findArtifactShare(user.id, asJsx.prepared.sourceKey))?.id, jsxLink!.share.id);

  // Stopping one leaves the other as it was.
  assert.equal(await revokeArtifactShare(user.id, htmlLink!.share.id), true);
  assert.equal(await findArtifactShare(user.id, asHtml.prepared.sourceKey), null);
  assert.equal((await findArtifactShare(user.id, asJsx.prepared.sourceKey))?.id, jsxLink!.share.id);
  assert.ok(await readPublicArtifactShare(jsxLink!.share.token, LIVE));
});

test("after a block's text changes, its new link closes the old one there and no other block's", async () => {
  const { user, answer } = await seed();
  const old = await share(user.id, answer.id);
  const revised = "<!doctype html>\n<h1>Revised chart</h1>";
  // Block 0 now holds the revised page; the old page moved to block 1.
  await prisma.message.update({
    where: { id: answer.id },
    data: { content: "```html\n" + revised + "\n```\n\nThe earlier one:\n\n```html\n" + PAGE + "\n```" },
  });
  const elsewhere = await prepareArtifactShare(user.id, codeSource(answer.id, PAGE, { blockIndex: 1 }), OPEN);
  assert.ok(elsewhere.ok);
  if (!elsewhere.ok) return;
  const otherBlock = await publishArtifactShare(user.id, elsewhere.prepared);
  assert.ok(otherBlock?.created);

  const now = await prepareArtifactShare(user.id, codeSource(answer.id, revised, { blockIndex: 0 }), OPEN);
  assert.ok(now.ok);
  if (!now.ok) return;
  // The panel asks about the block as it is now: there is no link for this text yet...
  assert.equal(await findArtifactShare(user.id, now.prepared.sourceKey), null);
  // ...and making one closes the old link at the same block, so the block never keeps a link the panel cannot see or stop.
  const replacement = await publishArtifactShare(user.id, now.prepared);
  assert.equal(replacement?.created, true);
  assert.equal(await readPublicArtifactShare(old.share.token, LIVE), null);
  assert.equal(await prisma.artifactShare.findUnique({ where: { id: old.share.id } }), null);
  assert.equal((await readPublicArtifactShare(replacement!.share.token, LIVE))?.content, revised);
  // The link at the other block is untouched.
  assert.equal((await readPublicArtifactShare(otherBlock!.share.token, LIVE))?.content, PAGE);
  assert.equal(await prisma.artifactShare.count(), 2);
});

test("only a source-key race answers with the existing link; any other failure is thrown", async () => {
  const { user, chat, answer } = await seed();
  const live = await share(user.id, answer.id);
  // Real errors from this database, raised by the same raw insert the publish uses.
  const failedInsert = async (overrides: { token?: string; sourceKey?: string; content?: string }) => {
    try {
      await prisma.$queryRaw`
        INSERT INTO "ArtifactShare" ("id", "token", "userId", "conversationId", "messageId", "sourceKey", "sourceKind",
          "previewKind", "language", "content", "createdAt", "expiresAt")
        VALUES (${randomUUID()}, ${overrides.token ?? randomUUID()}, ${user.id}, ${chat.id}, ${answer.id},
          ${overrides.sourceKey ?? randomUUID()}, 'code_block', 'html', 'html', ${overrides.content ?? PAGE},
          now(), now() + interval '1 day')
        RETURNING "id"`;
    } catch (error) {
      return error;
    }
    throw new Error("the insert was expected to fail");
  };
  const sourceKeyRace = await failedInsert({ sourceKey: live.prepared.sourceKey });
  const tokenCollision = await failedInsert({ token: live.share.token });
  const checkRefusal = await failedInsert({ content: "" });
  const lostConnection = new Error("Connection terminated unexpectedly");

  assert.equal(isSourceKeyConflict(sourceKeyRace), true);
  for (const error of [tokenCollision, checkRefusal, lostConnection]) assert.equal(isSourceKeyConflict(error), false);

  // The race is answered with the live link of that source...
  assert.deepEqual(await shareAfterPublishFailure(sourceKeyRace, user.id, live.prepared.sourceKey, new Date()), {
    share: live.share,
    created: false,
  });
  // ...and every other failure is the failure, even with a live link for the source right there.
  for (const error of [tokenCollision, checkRefusal, lostConnection]) {
    await assert.rejects(shareAfterPublishFailure(error, user.id, live.prepared.sourceKey, new Date()), (thrown) => thrown === error);
  }
  assert.equal(await prisma.artifactShare.count(), 1);
});
