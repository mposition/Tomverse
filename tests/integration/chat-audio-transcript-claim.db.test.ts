import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  ATTACHMENT_TEXT_CACHE_VERSION,
  ATTACHMENT_TEXT_CLAIM_VERSION,
  AUDIO_TRANSCRIPT_RESULT_VERSION,
  claimAttachmentTextCache,
  readAttachmentTextCache,
  readAttachmentTranscriptOutcome,
  readInheritedTranscriptOutcome,
  releaseAttachmentTextClaim,
  renewAttachmentTextClaim,
  writeAttachmentNoTextOutcome,
  writeAttachmentTextCache,
  writeAudioTranscript,
} from "@/lib/attachmentTextCache";
import {
  AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS,
  resolveRecordingAttachmentId,
  transcribeAudioAttachmentOnce,
  type AudioTranscriptionDeps,
  type AudioTranscriptStore,
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
      "MessageAttachmentUpload",
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

/** A recording saved with its message, through the upload step the composer takes. */
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
  const file = {
    name: "meeting.mp3",
    mediaType: "audio/mpeg",
    size: 12_452,
    // attachmentKindForFormat: every non-text format is a "file".
    kind: "file",
    objectKey: `users/${user.id}/attachments/${randomUUID()}.mp3`,
  };
  const upload = await prisma.messageAttachmentUpload.create({
    data: { userId: user.id, ...file, boundAt: new Date() },
  });
  const attachment = await prisma.messageAttachment.create({
    data: {
      messageId: message.id,
      conversationId: conversation.id,
      userId: user.id,
      uploadId: upload.id,
      ...file,
    },
  });
  return { userId: user.id, attachmentId: attachment.id, uploadId: upload.id, objectKey: file.objectKey };
};

/** The production ledgers, with a provider that answers after a short delay. */
const transcription = (calls: { count: number }, text = "Minutes of the meeting."): AudioTranscriptionDeps => ({
  reserve: reserveVoiceBudgets,
  settle: settleVoiceBudgets,
  release: releaseVoiceBudgets,
  transcribe: async () => {
    calls.count += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      ok: true as const,
      text,
      usage: { kind: "duration" as const, seconds: 3 },
    };
  },
});

/** The production store, with one part replaced. */
const productionStore = (overrides: Partial<AudioTranscriptStore> = {}): AudioTranscriptStore => ({
  read: readAttachmentTranscriptOutcome,
  readInherited: readInheritedTranscriptOutcome,
  claim: claimAttachmentTextCache,
  renew: renewAttachmentTextClaim,
  write: writeAudioTranscript,
  writeNoText: writeAttachmentNoTextOutcome,
  release: releaseAttachmentTextClaim,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  ...overrides,
});

const input = (userId: string, attachmentId: string) => ({
  bytes: new Uint8Array(16),
  mediaType: "audio/mpeg",
  extension: "mp3",
  durationSeconds: 3,
  subjectKey: `integration:user:${userId}`,
  traceId: `trace-${randomUUID()}`,
  attachmentId,
});

const askFor = (
  userId: string,
  attachmentId: string,
  calls: { count: number }
) =>
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
  const ask = () => askFor(userId, attachmentId, calls);
  const [first, second] = await quietly(() => Promise.all([ask(), ask()]));

  assert.equal(calls.count, 1, "one paid transcription");
  assert.deepEqual(first, [{ kind: "audio transcript", text: "Minutes of the meeting." }]);
  assert.deepEqual(second, first);
  // Stored as a paid result, at its own version, the claim gone.
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(row.version, AUDIO_TRANSCRIPT_RESULT_VERSION);
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

  // A paid result is never claimed over, however old it is.
  await writeAudioTranscript(attachmentId, [{ kind: "audio transcript", text: "Done." }]);
  await prisma.$executeRaw`
    UPDATE "MessageAttachmentTextCache"
    SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '1 day'
    WHERE "attachmentId" = ${attachmentId}`;
  assert.equal(await claimAttachmentTextCache(attachmentId, "c", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), false);
  assert.deepEqual(await readAttachmentTextCache(attachmentId), [{ kind: "audio transcript", text: "Done." }]);
});

// Review r-20261127-110354-67c5f8 (a): a request may name the recording by the
// upload id rather than the attachment id. It is the same recording, so it is
// the same claim and the same transcript; an upload nothing has bound has no
// row to claim on, and the route does not transcribe it.
test("naming a recording by its upload id claims the same row", async () => {
  const { userId, attachmentId, uploadId, objectKey } = await recording();
  const resolve = () =>
    resolveRecordingAttachmentId({ userId, attachmentId: null, uploadId, objectKey });
  assert.equal(await resolve(), attachmentId);
  const calls = { count: 0 };
  const [byUpload, byAttachment] = await quietly(() =>
    Promise.all([
      resolve().then((id) => askFor(userId, id!, calls)),
      askFor(userId, attachmentId, calls),
    ])
  );
  assert.equal(calls.count, 1, "one paid transcription");
  assert.deepEqual(byUpload, byAttachment);
  assert.equal(await bucketTotal("voice-seconds-day"), 3);
  assert.equal(await bucketTotal(VOICE_PROVIDER_BUDGET_PERIODS.day), 3);

  // Another account's upload id, or a different object, names nothing here.
  assert.equal(
    await resolveRecordingAttachmentId({ userId: randomUUID(), attachmentId: null, uploadId, objectKey }),
    null
  );
  assert.equal(
    await resolveRecordingAttachmentId({ userId, attachmentId: null, uploadId, objectKey: `${objectKey}.other` }),
    null
  );
  // An upload nothing has bound has no row.
  const unbound = await prisma.messageAttachmentUpload.create({
    data: {
      userId, name: "draft.mp3", mediaType: "audio/mpeg", size: 1, kind: "file",
      objectKey: `users/${userId}/attachments/${randomUUID()}.mp3`,
    },
  });
  assert.equal(
    await resolveRecordingAttachmentId({ userId, attachmentId: null, uploadId: unbound.id, objectKey: unbound.objectKey }),
    null
  );
});

// Review r-20261127-110354-67c5f8 (b): the transcript is a paid result, not an
// extractor cache, so turning the text cache off does not turn the claim off.
test("with the text cache switched off, the recording is still transcribed once", async () => {
  const previous = process.env.CHAT_ATTACHMENT_TEXT_CACHE;
  process.env.CHAT_ATTACHMENT_TEXT_CACHE = "0";
  try {
    const { userId, attachmentId } = await recording();
    const calls = { count: 0 };
    const [first, second] = await quietly(() =>
      Promise.all([askFor(userId, attachmentId, calls), askFor(userId, attachmentId, calls)])
    );
    assert.equal(calls.count, 1, "one paid transcription");
    assert.deepEqual(second, first);
    assert.equal(await bucketTotal("voice-seconds-day"), 3);
    assert.equal(await bucketTotal(VOICE_PROVIDER_BUDGET_PERIODS.day), 3);
  } finally {
    if (previous === undefined) delete process.env.CHAT_ATTACHMENT_TEXT_CACHE;
    else process.env.CHAT_ATTACHMENT_TEXT_CACHE = previous;
  }
});

// Review r-20261127-114544-4444fa: no claim, no call.
test("a claim the database will not write ends the request before anything is booked", async () => {
  const { userId } = await recording();
  const calls = { count: 0 };
  // No such attachment row: the claim's INSERT fails on the foreign key.
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(userId, `missing-${randomUUID()}`), {
      transcription: transcription(calls),
    })),
    (error: { code?: string }) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE"
  );
  assert.equal(calls.count, 0, "nothing transcribed");
  assert.equal(await bucketTotal("voice-seconds-day"), 0, "nothing booked");
  assert.equal(await bucketTotal(VOICE_PROVIDER_BUDGET_PERIODS.day), 0);
});

test("a transcript that cannot be stored keeps its claim, so no later request pays before it is stale", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  const paid = await quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
    transcription: transcription(calls),
    store: productionStore({ write: async () => false }),
  }));
  assert.deepEqual(paid, [{ kind: "audio transcript", text: "Minutes of the meeting." }], "used for the turn that paid");
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(row.version, ATTACHMENT_TEXT_CLAIM_VERSION, "the claim stands");
  // A later request finds it taken and waits; it does not pay. Cut off after
  // a few looks -- the claim is 150 seconds from stale.
  let looks = 0;
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
      transcription: transcription(calls),
      store: productionStore({
        wait: async (ms) => {
          looks += 1;
          if (looks > 3) throw new Error("still waiting");
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      }),
    })),
    /still waiting/
  );
  assert.equal(calls.count, 1);
  assert.equal(await bucketTotal("voice-seconds-day"), 3, "booked once");
});

// Same review: a recording with no speech is not paid for again on every turn.
test("a recording found to hold no speech is stored as such and never transcribed again", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  const ask = () => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
    transcription: transcription(calls, "   "),
  });
  const silent = (error: { code?: string }) => error.code === "ATTACHMENT_NO_TEXT";
  const [first, second] = await quietly(() => Promise.allSettled([ask(), ask()]));
  assert.ok(first.status === "rejected" && silent(first.reason));
  assert.ok(second.status === "rejected" && silent(second.reason));
  await assert.rejects(quietly(ask), silent);
  assert.equal(calls.count, 1, "one paid transcription");
  assert.equal(await bucketTotal("voice-seconds-day"), 3);
  assert.equal(await readAttachmentTranscriptOutcome(attachmentId), "no_text");
  // Every other reader sees a miss, and the claim cannot take it over.
  assert.equal(await readAttachmentTextCache(attachmentId), null);
  assert.equal(await claimAttachmentTextCache(attachmentId, "x", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), false);
});

// -- Review r-20261127-122037-b72ce5: the claim goes back only when nothing
// can have been paid (the table in transcribeAudioAttachmentOnce's comment) --

/** A later request, cut off after a few looks: the claim is far from stale. */
const laterRequestPays = async (userId: string, attachmentId: string) => {
  const calls = { count: 0 };
  let looks = 0;
  await quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
    transcription: transcription(calls),
    store: productionStore({
      wait: async (ms) => {
        looks += 1;
        if (looks > 3) throw new Error("still waiting");
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    }),
  })).catch((error) => {
    if (!/still waiting/.test(String(error?.message))) throw error;
  });
  return calls.count;
};

/** The production ledgers, with a provider that answers `result`. */
const answering = (calls: { count: number }, result: Awaited<ReturnType<AudioTranscriptionDeps["transcribe"]>>): AudioTranscriptionDeps => ({
  ...transcription(calls),
  transcribe: async () => {
    calls.count += 1;
    return result;
  },
});

test("an indeterminate failure keeps the claim and the seconds; no later request pays before it is stale", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
      // What the port answers for a body cut off at its deadline.
      transcription: answering(calls, {
        ok: false, code: "provider_response_unreadable", status: 200, disposition: "indeterminate",
      }),
    })),
    (error: { code?: string }) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE"
  );
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(row.version, ATTACHMENT_TEXT_CLAIM_VERSION, "the claim stands");
  assert.equal(await bucketTotal("voice-seconds-day"), 3, "the reservation stands too");
  assert.equal(await laterRequestPays(userId, attachmentId), 0);
});

test("a settlement that throws after the answer keeps the claim", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
      transcription: { ...transcription(calls), settle: async () => { throw new Error("ledger down"); } },
    })),
    /ledger down/
  );
  assert.equal(calls.count, 1);
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(row.version, ATTACHMENT_TEXT_CLAIM_VERSION, "the claim stands");
  assert.equal(await laterRequestPays(userId, attachmentId), 0);
});

test("a refusal that cost nothing gives the claim back, and the next request may pay", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
      transcription: answering(calls, {
        ok: false, code: "provider_rejected_audio", status: 400, disposition: "refused",
      }),
    })),
    (error: { code?: string }) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE"
  );
  assert.equal(await prisma.messageAttachmentTextCache.count({ where: { attachmentId } }), 0, "given back");
  assert.equal(await bucketTotal("voice-seconds-day"), 0, "nothing billed, nothing kept");
  const next = { count: 0 };
  await quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), { transcription: transcription(next) }));
  assert.equal(next.count, 1);
});

test("a holder whose claim was taken over while it booked never calls, and gives its seconds back", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  const deps = transcription(calls);
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(userId, attachmentId), {
      transcription: {
        ...deps,
        reserve: async (booking) => {
          const booked = await deps.reserve(booking);
          // Another request takes the claim over while this one books.
          await prisma.$executeRaw`
            UPDATE "MessageAttachmentTextCache"
            SET "entries" = ${JSON.stringify({ claim: "someone-else" })}::jsonb
            WHERE "attachmentId" = ${attachmentId}`;
          return booked;
        },
      },
    })),
    (error: { code?: string }) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE"
  );
  assert.equal(calls.count, 0, "no call");
  assert.equal(await bucketTotal("voice-seconds-day"), 0, "its seconds given back");
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.deepEqual(row.entries, { claim: "someone-else" }, "the other request's claim is left alone");
});

test("renewing a claim is the holder's alone and restarts its clock", async () => {
  const { attachmentId } = await recording();
  assert.equal(await claimAttachmentTextCache(attachmentId, "mine", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), true);
  await prisma.$executeRaw`
    UPDATE "MessageAttachmentTextCache"
    SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '100 seconds'
    WHERE "attachmentId" = ${attachmentId}`;
  assert.equal(await renewAttachmentTextClaim(attachmentId, "theirs"), false);
  assert.equal(await renewAttachmentTextClaim(attachmentId, "mine"), true);
  // Measured in the database, in the clock that wrote it.
  const [{ age }] = await prisma.$queryRaw<Array<{ age: number }>>`
    SELECT EXTRACT(EPOCH FROM (LOCALTIMESTAMP - "createdAt"))::float AS age
    FROM "MessageAttachmentTextCache" WHERE "attachmentId" = ${attachmentId}`;
  assert.ok(age < 10, `restarted, ${age}s old`);
  // Once text replaces it, there is no claim left to renew.
  await writeAudioTranscript(attachmentId, [{ kind: "audio transcript", text: "Done." }]);
  assert.equal(await renewAttachmentTextClaim(attachmentId, "mine"), false);
});

// -- Review r-20261127-124325-a4352d: a paid result has its own version ------

test("bumping the extractor cache version leaves paid transcripts and no-speech results in force", async () => {
  const { userId, attachmentId } = await recording();
  const calls = { count: 0 };
  const paid = await quietly(() => askFor(userId, attachmentId, calls));
  const silent = await recording();
  await quietly(() =>
    transcribeAudioAttachmentOnce(input(silent.userId, silent.attachmentId), {
      transcription: transcription(calls, "   "),
    })
  ).catch(() => undefined);
  assert.equal(calls.count, 2);
  const bookedBefore = await bucketTotal("voice-seconds-day");

  // The extractor version a PDF change would bump to: the route's early read
  // still finds the transcript, and the audio path never consults it at all.
  const bumped = { extractorVersion: ATTACHMENT_TEXT_CACHE_VERSION + 1 };
  assert.deepEqual(await readAttachmentTextCache(attachmentId, bumped), paid);
  assert.equal(await readAttachmentTranscriptOutcome(silent.attachmentId), "no_text");
  // An extractor's own row at the old version is a miss, as it should be.
  const pdf = await recording();
  await writeAttachmentTextCache(pdf.attachmentId, [{ kind: "pdf text", text: "page one" }]);
  assert.equal(await readAttachmentTextCache(pdf.attachmentId, bumped), null);

  // Asked again, neither recording is transcribed or booked.
  assert.deepEqual(await quietly(() => askFor(userId, attachmentId, calls)), paid);
  await assert.rejects(
    quietly(() => transcribeAudioAttachmentOnce(input(silent.userId, silent.attachmentId), {
      transcription: transcription(calls),
    })),
    (error: { code?: string }) => error.code === "ATTACHMENT_NO_TEXT"
  );
  assert.equal(calls.count, 2, "no transcription");
  assert.equal(await bucketTotal("voice-seconds-day"), bookedBefore, "no booking");
});

test("a claim takes over only a stale claim or an older audio result, never a paid one", async () => {
  const { attachmentId } = await recording();
  const age = async (seconds: number) => prisma.$executeRaw`
    UPDATE "MessageAttachmentTextCache"
    SET "createdAt" = CURRENT_TIMESTAMP - ${seconds}::int * INTERVAL '1 second'
    WHERE "attachmentId" = ${attachmentId}`;
  for (const write of [
    () => writeAudioTranscript(attachmentId, [{ kind: "audio transcript", text: "Paid." }]),
    () => writeAttachmentNoTextOutcome(attachmentId),
    // An extractor's row on this attachment is no claim's to take either.
    () => writeAttachmentTextCache(attachmentId, [{ kind: "text", text: "Extracted." }]),
  ]) {
    await write();
    await age(10 * 24 * 3600);
    assert.equal(await claimAttachmentTextCache(attachmentId, "x", AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS), false);
  }
});

test("bumping the audio result version transcribes again, on purpose", async () => {
  const { userId, attachmentId } = await recording();
  // A result stored at the version before the current one.
  await prisma.$executeRaw`
    INSERT INTO "MessageAttachmentTextCache" ("attachmentId", "version", "entries")
    VALUES (${attachmentId}, ${AUDIO_TRANSCRIPT_RESULT_VERSION - 1},
            ${JSON.stringify([{ kind: "audio transcript", text: "Old model." }])}::jsonb)`;
  assert.equal(await readAttachmentTranscriptOutcome(attachmentId), null);
  const calls = { count: 0 };
  const fresh = await quietly(() => askFor(userId, attachmentId, calls));
  assert.equal(calls.count, 1, "transcribed again");
  assert.deepEqual(fresh, [{ kind: "audio transcript", text: "Minutes of the meeting." }]);
  const row = await prisma.messageAttachmentTextCache.findUniqueOrThrow({ where: { attachmentId } });
  assert.equal(row.version, AUDIO_TRANSCRIPT_RESULT_VERSION);
});

test("a resent copy of a recording inherits the paid result of the one it was copied from", async () => {
  const original = await recording();
  const calls = { count: 0 };
  const paid = await quietly(() => askFor(original.userId, original.attachmentId, calls));
  const source = await prisma.messageAttachment.findUniqueOrThrow({ where: { id: original.attachmentId } });
  // What a resend binds: a new message, a new object, the original named.
  const copyOf = async (sourceAttachmentId: string, overrides: { size?: number } = {}) => {
    const message = await prisma.message.create({
      data: { conversationId: source.conversationId, role: "user", content: "again" },
    });
    return prisma.messageAttachment.create({
      data: {
        messageId: message.id, conversationId: source.conversationId, userId: source.userId,
        name: source.name, mediaType: source.mediaType, size: overrides.size ?? source.size, kind: source.kind,
        objectKey: `users/${source.userId}/attachments/${randomUUID()}.mp3`, sourceAttachmentId,
      },
    });
  };
  const copy = await copyOf(original.attachmentId);
  const copyOfCopy = await copyOf(copy.id);
  assert.deepEqual(await readInheritedTranscriptOutcome(copyOfCopy.id), paid, "two copies back");
  assert.deepEqual(await quietly(() => askFor(original.userId, copyOfCopy.id, calls)), paid);
  assert.equal(calls.count, 1, "no new transcription");
  assert.equal(await bucketTotal("voice-seconds-day"), 3, "no new booking");
  assert.deepEqual(await readAttachmentTranscriptOutcome(copyOfCopy.id), paid, "kept on the copy's own row");
  // A row that does not match its original is not taken for a copy of it.
  const different = await copyOf(original.attachmentId, { size: source.size + 1 });
  assert.equal(await readInheritedTranscriptOutcome(different.id), null);
});
