import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  ATTACHMENT_TEXT_CACHE_VERSION,
  ATTACHMENT_TEXT_CLAIM_VERSION,
  claimAttachmentTextCache,
  readAttachmentTextCache,
  writeAttachmentTextCache,
} from "@/lib/attachmentTextCache";
import {
  AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS,
  transcribeAudioAttachmentOnce,
  type AudioTranscriptionDeps,
} from "@/lib/chatAudioAttachment";
import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import {
  releaseVoiceBudgets,
  reserveVoiceBudgets,
  settleVoiceBudgets,
} from "@/lib/voiceBudgetReservation";
import { VOICE_PROVIDER_BUDGET_PERIODS } from "@/lib/voiceProviderBudget";

/**
 * One paid transcription per recording, against a real database.
 *
 * Review r-20261127-082100-427572: several models answering one message are
 * several requests, and each used to miss the transcript cache and transcribe
 * the same recording, booking the provider and the caller's seconds budget
 * once per model. The claim is a row of the cache table itself
 * (`ATTACHMENT_TEXT_CLAIM_VERSION`), taken in one statement; what only a
 * database can show is that two requests racing for it really do leave one
 * transcription and one booking (docs/policy/chat-attachment-formats.md 2.4.1).
 * The provider is the only fake: the ledgers, the claim and the cache are the
 * production ones.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MessageAttachmentTextCache",
      "MessageAttachment",
      "Message",
      "Conversation",
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const recording = async () => {
  const user = await prisma.user.create({
    data: { email: `transcript-claim-${randomUUID()}@example.test`, plan: "Pro" },
  });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, title: "meeting", selectedModels: '["gemini-3-6-flash"]' },
  });
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: "summarise" },
  });
  const attachment = await prisma.messageAttachment.create({
    data: {
      messageId: message.id,
      conversationId: conversation.id,
      userId: user.id,
      name: "meeting.mp3",
      mediaType: "audio/mpeg",
      size: 12_452,
      // attachmentKindForFormat: every non-text format is a "file".
      kind: "file",
      objectKey: `users/${user.id}/attachments/${randomUUID()}.mp3`,
    },
  });
  return { userId: user.id, attachmentId: attachment.id };
};

/** The production ledgers, with a provider that answers after a short delay. */
const transcription = (calls: { count: number }): AudioTranscriptionDeps => ({
  reserve: reserveVoiceBudgets,
  settle: settleVoiceBudgets,
  release: releaseVoiceBudgets,
  transcribe: async () => {
    calls.count += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      ok: true as const,
      text: "Minutes of the meeting.",
      usage: { kind: "duration" as const, seconds: 3 },
    };
  },
});

const bucketTotal = async (period: string) => {
  const rows = await prisma.chatUsageBucket.findMany({ where: { period } });
  return rows.reduce((sum, row) => sum + usageBucketCount(row.count), 0);
};

const quietly = async <T>(run: () => Promise<T>) => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

test("two requests for one recording transcribe it once and book its seconds once", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  const ask = () =>
    transcribeAudioAttachmentOnce(
      {
        bytes: new Uint8Array(16),
        mediaType: "audio/mpeg",
        extension: "mp3",
        durationSeconds: 3,
        subjectKey: `integration:user:${userId}`,
        traceId: `trace-${randomUUID()}`,
        attachmentId,
      },
      { transcription: transcription(calls) }
    );
  const [first, second] = await quietly(() => Promise.all([ask(), ask()]));

  assert.equal(calls.count, 1, "one paid transcription");
  assert.deepEqual(first, [{ kind: "audio transcript", text: "Minutes of the meeting." }]);
  assert.deepEqual(second, first);
  // Stored as text, the claim gone.
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(row.version, ATTACHMENT_TEXT_CACHE_VERSION);
  assert.deepEqual(await readAttachmentTextCache(attachmentId), first);
  // The caller's day and the deployment's day each booked once: three seconds,
  // settled on the provider's own figure.
  assert.equal(await bucketTotal("voice-seconds-day"), 3);
  assert.equal(await bucketTotal(VOICE_PROVIDER_BUDGET_PERIODS.day), 3);

  // A third request later reads it and books nothing.
  const third = await quietly(() => ask());
  assert.deepEqual(third, first);
  assert.equal(calls.count, 1);
  assert.equal(await bucketTotal("voice-seconds-day"), 3);
});

test("a claim is taken once, refused while fresh or answered, and taken over once stale", async () => {
  const { attachmentId } = await recording();
  assert.equal(await claimAttachmentTextCache(attachmentId, "a", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), true);
  assert.equal(await claimAttachmentTextCache(attachmentId, "b", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), false);
  // A claim is never read as text.
  assert.equal(await readAttachmentTextCache(attachmentId), null);

  // Older than the stale window: the request that held it died.
  await prisma.$executeRaw`
    UPDATE "MessageAttachmentTextCache"
    SET "createdAt" = CURRENT_TIMESTAMP - ${AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS + 5}::int * INTERVAL '1 second'
    WHERE "attachmentId" = ${attachmentId}`;
  assert.equal(await claimAttachmentTextCache(attachmentId, "b", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), true);
  const claim = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(claim.version, ATTACHMENT_TEXT_CLAIM_VERSION);
  assert.deepEqual(claim.entries, { claim: "b" });

  // Answered text is never claimed over, however old it is.
  await writeAttachmentTextCache(attachmentId, [{ kind: "audio transcript", text: "Done." }]);
  await prisma.$executeRaw`
    UPDATE "MessageAttachmentTextCache"
    SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '1 day'
    WHERE "attachmentId" = ${attachmentId}`;
  assert.equal(await claimAttachmentTextCache(attachmentId, "c", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), false);
  assert.deepEqual(await readAttachmentTextCache(attachmentId), [{ kind: "audio transcript", text: "Done." }]);
});
