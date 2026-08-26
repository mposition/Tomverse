import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    ASSISTANT_KNOWLEDGE_FLAG_KEY,
    ASSISTANT_PROFILES_FLAG_KEY,
} from "@/lib/assistantProfileAccess";
import { ASSISTANT_PROMPT_FORMAT_VERSION } from "@/lib/assistantProfileVersioning";
import { buildChatProfileContext } from "@/lib/chatProfileContext";
import { buildChatTurnContext } from "@/lib/chatTurnContext";
import { prisma } from "@/lib/prisma";

/**
 * Release C3c's runtime context against a real database.
 *
 * The pure modules already decide the order of the system block and whether a
 * profile may run. What only a database settles is which row the runtime
 * actually reads: whether an owner boundary holds when a conversation names
 * another account's version, whether a conversation pinned to a superseded
 * revision still runs *that* revision rather than the profile's current one,
 * and whether the §10 identity the bundle binds moves when the profile does.
 * Policy: docs/policy/external-conversation-import-and-memory.md.
 */

const MODEL_ID = "gpt-5-6-luna";

const resetProfileData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AssistantKnowledgeChunk",
      "AssistantKnowledgeFile",
      "AssistantProfileVersion",
      "AssistantProfile",
      "Conversation"
    RESTART IDENTITY CASCADE
  `);
    await prisma.appSetting.deleteMany({
        where: {
            key: { in: [ASSISTANT_PROFILES_FLAG_KEY, ASSISTANT_KNOWLEDGE_FLAG_KEY] },
        },
    });
};

const setFlag = (key: string, value: boolean) =>
    prisma.appSetting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
    });

const createUser = () =>
    prisma.user.create({
        data: { email: `profile-context-${randomUUID()}@example.test` },
    });

/** A profile with one published version, which is the state a turn can run. */
const publishProfile = async (
    userId: string,
    overrides: Record<string, unknown> = {}
) => {
    const profile = await prisma.assistantProfile.create({
        data: { userId, name: "Scheduler" },
    });
    const version = await prisma.assistantProfileVersion.create({
        data: {
            profileId: profile.id,
            userId,
            revision: 1,
            instructions: "Answer in Korean, and prefer short examples.",
            models: [MODEL_ID],
            toolPolicy: { webSearch: true, deepResearch: true },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: [],
            retrievalVersion: 1,
            promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
            ...overrides,
        },
    });
    await prisma.assistantProfile.update({
        where: { id: profile.id },
        data: { currentVersionId: version.id },
    });
    return { profile, version };
};

const context = (userId: string | null, profileVersionId: string | null) =>
    buildChatProfileContext({
        userId,
        profileVersionId,
        query: "환불 규정 알려줘",
        plan: "Free",
        entitledTools: { webSearch: true, deepResearch: false },
    });

beforeEach(async () => {
    await resetProfileData();
    await setFlag(ASSISTANT_PROFILES_FLAG_KEY, true);
    await setFlag(ASSISTANT_KNOWLEDGE_FLAG_KEY, true);
});
after(async () => {
    await resetProfileData();
    await prisma.$disconnect();
});

test("a published version contributes its instructions and its identity", async () => {
    const user = await createUser();
    const { profile, version } = await publishProfile(user.id);

    const result = await context(user.id, version.id);

    assert.equal(result.refusal, null);
    assert.equal(result.version?.profileId, profile.id);
    assert.equal(result.profileVersion, `${version.id}:1`);
    assert.match(result.instructionsPrompt ?? "", /Answer in Korean/);
    assert.ok(result.profileTokens > 0);
    // No files attached, so no knowledge block and an identity that says so
    // with a value rather than an empty string.
    assert.equal(result.knowledgePrompt, null);
    assert.equal(result.knowledgeHash, "none");
});

test("another account's version is not readable through a conversation id", async () => {
    // The boundary that a `findUnique` by id alone would not hold: a
    // conversation row is the only thing naming the version, and a request
    // that reached this far has already passed the conversation's own
    // ownership check -- which is not the version's.
    const owner = await createUser();
    const stranger = await createUser();
    const { version } = await publishProfile(owner.id);

    const result = await context(stranger.id, version.id);

    assert.equal(result.refusal, "no_active_version");
    assert.equal(result.version, null);
    assert.equal(result.instructionsPrompt, null);
});

test("a pinned revision keeps running after it is superseded, and is never upgraded", async () => {
    // Found in staging on 2026-08-25. This used to assert a refusal, and the
    // refusal is what shipped: publishing a revision left every conversation
    // pinned to the old one silently without a profile -- not the current
    // version's instructions and not the pinned version's, none at all, while
    // the API and the picker both still reported the profile as attached.
    //
    // Two things are asserted here because the defect sat between them: the
    // pinned revision *runs* (its instructions reach the prompt), and it is
    // still not *upgraded* (the current version's instructions do not).
    // Policy section 14: 소급 적용 금지, 이동은 명시적 사용자 동작.
    const user = await createUser();
    const { profile, version } = await publishProfile(user.id);
    const next = await prisma.assistantProfileVersion.create({
        data: {
            profileId: profile.id,
            userId: user.id,
            revision: 2,
            instructions: "Answer in English now.",
            models: [MODEL_ID],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: [],
            retrievalVersion: 1,
            promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
        },
    });
    await prisma.assistantProfile.update({
        where: { id: profile.id },
        data: { currentVersionId: next.id },
    });

    const result = await context(user.id, version.id);

    assert.equal(result.refusal, null);
    assert.equal(result.version?.profileVersionId, version.id);
    assert.equal(result.version?.revision, 1);
    assert.ok(
        result.instructionsPrompt?.includes(
            "Answer in Korean, and prefer short examples."
        ),
        "the pinned revision's own instructions must reach the prompt"
    );
    assert.ok(
        result.profileTokens > 0,
        "a profile that runs is priced input, so its tokens are counted"
    );
    // Never upgraded: revision 2's text must not appear.
    assert.ok(
        !result.instructionsPrompt?.includes("Answer in English now."),
        "the current version's instructions must not be substituted"
    );
});

test("the flag being off refuses the profile without reading its row", async () => {
    const user = await createUser();
    const { version } = await publishProfile(user.id);
    await setFlag(ASSISTANT_PROFILES_FLAG_KEY, false);

    const result = await context(user.id, version.id);

    assert.equal(result.refusal, "flag_off");
});

test("a version published for an unsupported prompt format is refused", async () => {
    const user = await createUser();
    const { version } = await publishProfile(user.id, {
        promptFormatVersion: "assistant-profile-v0",
    });

    const result = await context(user.id, version.id);

    assert.equal(result.refusal, "format_unsupported");
});

test("a guest is refused before any row is read", async () => {
    const user = await createUser();
    const { version } = await publishProfile(user.id);

    const result = await context(null, version.id);

    assert.equal(result.refusal, "guest");
});

test("tools are intersected with the caller's entitlement, never granted", async () => {
    const user = await createUser();
    const { version } = await publishProfile(user.id);

    const result = await context(user.id, version.id);

    // The version asked for both; the caller is entitled to web search only.
    assert.deepEqual(result.tools, { webSearch: true, deepResearch: false });
});

test("knowledge excerpts reach the block, fenced, and move the bundle identity", async () => {
    const user = await createUser();
    const profile = await prisma.assistantProfile.create({
        data: { userId: user.id, name: "Support" },
    });
    const file = await prisma.assistantKnowledgeFile.create({
        data: {
            profileId: profile.id,
            userId: user.id,
            name: "refunds.txt",
            mime: "text/plain",
            bytes: 512,
            digest: `sha256-${randomUUID()}`,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: "ready",
            extractedCharacters: 120,
            chunkCount: 1,
        },
    });
    await prisma.assistantKnowledgeChunk.create({
        data: {
            fileId: file.id,
            userId: user.id,
            ordinal: 0,
            content: "환불 규정: 결제 후 30일 이내에 요청하면 전액 환불됩니다.",
            searchTerms: ["환불", "규정", "환불규정", "30", "전액"],
        },
    });
    const version = await prisma.assistantProfileVersion.create({
        data: {
            profileId: profile.id,
            userId: user.id,
            revision: 1,
            instructions: "Cite the handbook.",
            models: [MODEL_ID],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: [
                { fileId: file.id, name: file.name, digest: file.digest },
            ],
            retrievalVersion: 1,
            promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
        },
    });
    await prisma.assistantProfile.update({
        where: { id: profile.id },
        data: { currentVersionId: version.id },
    });

    const withKnowledge = await context(user.id, version.id);
    assert.equal(withKnowledge.knowledgeChunkCount, 1);
    assert.match(withKnowledge.knowledgePrompt ?? "", /refunds\.txt/);
    assert.match(
        withKnowledge.knowledgePrompt ?? "",
        /TOMVERSE_PROFILE_KNOWLEDGE/
    );
    assert.notEqual(withKnowledge.knowledgeHash, "none");

    // The knowledge flag alone takes the excerpts away again, without
    // touching the profile itself.
    await setFlag(ASSISTANT_KNOWLEDGE_FLAG_KEY, false);
    const withoutKnowledge = await context(user.id, version.id);
    assert.equal(withoutKnowledge.refusal, null);
    assert.equal(withoutKnowledge.knowledgePrompt, null);
    assert.equal(withoutKnowledge.knowledgeHash, "none");
    assert.notEqual(
        withKnowledge.knowledgeHash,
        withoutKnowledge.knowledgeHash,
        "a turn that retrieved nothing must not share an identity with one that did"
    );
});

/* ------------------------------------------------- the assembled turn */

test("the turn's system block is the profile's, in §9.1 order", async () => {
    const user = await createUser();
    const { version } = await publishProfile(user.id);

    const turn = await buildChatTurnContext({
        userId: user.id,
        query: "환불 규정 알려줘",
        profileVersionId: version.id,
        plan: "Free",
    });

    assert.match(turn.systemPrompt ?? "", /Answer in Korean/);
    assert.equal(turn.profileTokens > 0, true);
    assert.equal(turn.fingerprintInput.profileVersion, `${version.id}:1`);
    assert.equal(turn.binding?.profileVersionId, version.id);
    // Memory injection is gated off until §12.4's procedure completes, so the
    // turn carries none -- and the binding records that as a fact about this
    // turn rather than as what the profile asked for.
    assert.equal(turn.binding?.memoryUsed, false);
});

test("a conversation with no profile builds the same context it always did", async () => {
    const user = await createUser();

    const turn = await buildChatTurnContext({
        userId: user.id,
        query: "안녕하세요",
        profileVersionId: null,
    });

    assert.equal(turn.systemPrompt, null);
    assert.equal(turn.profileTokens, 0);
    assert.equal(turn.binding, null);
    assert.equal(turn.fingerprintInput.profileVersion, null);
    assert.equal(turn.fingerprintInput.knowledgeHash, "none");
});

test("republishing the profile makes a bundle priced against the old one stale", async () => {
    const user = await createUser();
    const { profile, version } = await publishProfile(user.id);
    const before = await buildChatTurnContext({
        userId: user.id,
        query: "환불 규정 알려줘",
        profileVersionId: version.id,
        plan: "Free",
    });

    const next = await prisma.assistantProfileVersion.create({
        data: {
            profileId: profile.id,
            userId: user.id,
            revision: 2,
            instructions: "Answer in English now.",
            models: [MODEL_ID],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: [],
            retrievalVersion: 1,
            promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
        },
    });
    await prisma.assistantProfile.update({
        where: { id: profile.id },
        data: { currentVersionId: next.id },
    });

    const after = await buildChatTurnContext({
        userId: user.id,
        query: "환불 규정 알려줘",
        profileVersionId: next.id,
        plan: "Free",
    });

    assert.notEqual(before.fingerprint, after.fingerprint);
});
