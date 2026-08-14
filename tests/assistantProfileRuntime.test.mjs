// Release C3a: the sentence §45 makes, held as code.
//
// "profile은 plan·model·tool entitlement와 master toggle·memory mode·flag·
// source lock을 우회할 수 없습니다." Every test here is one way a profile
// could have become an override instead of a request, and each of those is a
// privilege escalation that would look like a feature working.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ASSISTANT_PROFILE_NO_ACTIVE_VERSION,
    decideProfileRuntime,
    profileRuntimeBinding,
    resolveProfileKnowledgeFiles,
    resolveProfileMemoryUse,
    resolveProfileTools,
} from "../lib/assistantProfileRuntime.ts";
import {
    ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
    ASSISTANT_PROMPT_FORMAT_VERSION,
    ASSISTANT_RETRIEVAL_VERSION,
} from "../lib/assistantProfileVersioning.ts";

const runnable = (overrides = {}) => ({
    isAuthenticated: true,
    profilesFlagEnabled: true,
    hasActiveVersion: true,
    modelEnabled: true,
    modelPermittedByPlan: true,
    promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
    ...overrides,
});

/* ------------------------------------------------- may this version run */

test("a fully permitted version runs", () => {
    assert.deepEqual(decideProfileRuntime(runnable()), { allowed: true });
});

test("a guest has no profile to run", () => {
    // Not degraded to a guest-shaped profile: a profile carries instructions, a
    // model choice and knowledge that all belong to an account, and there is no
    // version of that for a guest which is not a different feature.
    const decision = decideProfileRuntime(runnable({ isAuthenticated: false }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "guest");
});

test("the flag closes profiles even for an owner with a published version", () => {
    const decision = decideProfileRuntime(
        runnable({ profilesFlagEnabled: false })
    );
    assert.equal(decision.reason, "flag_off");
});

test("availability is decided before the version's content", () => {
    // Telling somebody who cannot use profiles at all that their model was
    // retired is a message about the wrong thing.
    const decision = decideProfileRuntime(
        runnable({ profilesFlagEnabled: false, modelEnabled: false })
    );
    assert.equal(decision.reason, "flag_off");
});

test("a profile with no published version cannot start a conversation", () => {
    const decision = decideProfileRuntime(runnable({ hasActiveVersion: false }));
    assert.equal(decision.reason, "no_active_version");
    assert.equal(decision.code, ASSISTANT_PROFILE_NO_ACTIVE_VERSION);
});

test("a retired model and a plan that no longer includes it are one refusal", () => {
    // From the owner's side these are one problem with one fix: pick a
    // different model. Nothing here picks one for them -- that substitution is
    // exactly what the code name exists to forbid.
    for (const overrides of [
        { modelEnabled: false },
        { modelPermittedByPlan: false },
    ]) {
        const decision = decideProfileRuntime(runnable(overrides));
        assert.equal(decision.reason, "model_unavailable");
        assert.equal(decision.code, ASSISTANT_PROFILE_MODEL_UNAVAILABLE);
    }
});

test("a version published under an older prompt format is refused, not reinterpreted", () => {
    const decision = decideProfileRuntime(
        runnable({ promptFormatVersion: "assistant-profile-v0" })
    );
    assert.equal(decision.reason, "format_unsupported");
});

/* ----------------------------------------------------- memory is an AND */

test("a profile asking for memory gets none when the account says no", () => {
    // The whole §45 sentence, in one assertion. If this ever becomes an OR, a
    // profile turns memory back on for an account that switched it off -- and
    // nothing else in the system would notice.
    assert.equal(
        resolveProfileMemoryUse({
            memoryPolicy: { useAccountMemory: true },
            memoryAllowedByAccount: false,
        }),
        false
    );
});

test("a profile can turn memory off for itself even when the account allows it", () => {
    // The asymmetry is the contract: narrowing is a profile's to do.
    assert.equal(
        resolveProfileMemoryUse({
            memoryPolicy: { useAccountMemory: false },
            memoryAllowedByAccount: true,
        }),
        false
    );
    assert.equal(
        resolveProfileMemoryUse({
            memoryPolicy: { useAccountMemory: true },
            memoryAllowedByAccount: true,
        }),
        true
    );
});

/* ------------------------------------------------- tools are an intersection */

test("a profile cannot grant a tool the plan does not include", () => {
    assert.deepEqual(
        resolveProfileTools({
            toolPolicy: { webSearch: true, deepResearch: true },
            entitled: { webSearch: true, deepResearch: false },
        }),
        { webSearch: true, deepResearch: false }
    );
});

test("a profile can withhold a tool the plan does include", () => {
    assert.deepEqual(
        resolveProfileTools({
            toolPolicy: { webSearch: false, deepResearch: false },
            entitled: { webSearch: true, deepResearch: true },
        }),
        { webSearch: false, deepResearch: false }
    );
});

/* ---------------------------------------------------------- knowledge */

test("a manifest entry whose file is gone is not retrieved from", () => {
    // §14: a manifest is audit metadata. It can say a file was listed; it
    // cannot make a deleted one readable.
    assert.deepEqual(
        resolveProfileKnowledgeFiles({
            manifestFileIds: ["f-kept", "f-deleted"],
            availableFileIds: ["f-kept"],
            knowledgeFlagEnabled: true,
        }),
        ["f-kept"]
    );
});

test("a file that exists but is not in the manifest is not pulled in", () => {
    // The version decides the scope. A file uploaded after the version was
    // published belongs to the next revision, not to conversations already
    // running under this one.
    assert.deepEqual(
        resolveProfileKnowledgeFiles({
            manifestFileIds: ["f-a"],
            availableFileIds: ["f-a", "f-uploaded-later"],
            knowledgeFlagEnabled: true,
        }),
        ["f-a"]
    );
});

test("the knowledge flag closes retrieval without touching the profile", () => {
    assert.deepEqual(
        resolveProfileKnowledgeFiles({
            manifestFileIds: ["f-a"],
            availableFileIds: ["f-a"],
            knowledgeFlagEnabled: false,
        }),
        []
    );
});

/* ------------------------------------------------------------ binding */

test("the binding records decisions, not requests", () => {
    // A bundle that recorded "the profile asked for memory" would verify
    // against a later turn on which the account had turned memory off. One
    // that records "memory was used" is a fact about the turn it was for.
    const binding = profileRuntimeBinding({
        profileId: "p-1",
        profileVersionId: "v-1",
        revision: 3,
        modelIds: ["gpt-5-6-luna"],
        memoryUsed: false,
        tools: { webSearch: true, deepResearch: false },
        knowledgeFileIds: ["f-a"],
    });
    assert.equal(binding.memoryUsed, false);
    assert.equal(binding.promptFormatVersion, ASSISTANT_PROMPT_FORMAT_VERSION);
    assert.equal(binding.retrievalVersion, ASSISTANT_RETRIEVAL_VERSION);
    assert.equal(binding.revision, 3);
});
