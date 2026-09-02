import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    applyModelSwap,
    continuationTurns,
    messagesForModel,
    planModelSelectionChange,
} from "../lib/continuationModelPanels.ts";

/**
 * A continuation answers one question with several models.
 *
 * docs/policy/external-conversation-continuation.md §5.1, §8.3.
 *
 * Both functions here decide something that would be wrong quietly: a history
 * that leaked one model's answer into another's request, and a selection
 * change at the cap that dropped a model nobody chose to drop.
 */

const user = (id, content, modelId) => ({
    id,
    role: "user",
    content,
    ...(modelId ? { modelId } : {}),
});
const answer = (id, modelId, content) => ({
    id,
    role: "assistant",
    content,
    modelId,
});

/* ------------------------------------------------------- per-model history */

test("a model sees every question and only its own answers", () => {
    const messages = [
        user("u1", "first"),
        answer("a1", "alpha", "alpha one"),
        answer("a2", "beta", "beta one"),
        user("u2", "second"),
        answer("a3", "alpha", "alpha two"),
    ];
    assert.deepEqual(
        messagesForModel(messages, "alpha").map((message) => message.id),
        ["u1", "a1", "u2", "a3"]
    );
    assert.deepEqual(
        messagesForModel(messages, "beta").map((message) => message.id),
        ["u1", "a2", "u2"]
    );
});

test("a question addressed to one panel stays out of the others", () => {
    const messages = [user("u1", "only alpha", "alpha")];
    assert.equal(messagesForModel(messages, "alpha").length, 1);
    assert.equal(messagesForModel(messages, "beta").length, 0);
});

test("an answer with no model belongs to nobody", () => {
    // A row whose modelId was never written must not be handed to whichever
    // model happens to be first: it would be read as that model's own words.
    const messages = [{ id: "a1", role: "assistant", content: "orphan" }];
    assert.equal(messagesForModel(messages, "alpha").length, 0);
});

/* -------------------------------------------------------------- the turns */

test("one question, one panel per selected model, in selection order", () => {
    const { turns } = continuationTurns(
        [
            user("u1", "first"),
            answer("a1", "beta", "beta one"),
            answer("a2", "alpha", "alpha one"),
        ],
        ["alpha", "beta"]
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user.id, "u1");
    // Selection order, not arrival order: beta answered first and is second.
    assert.deepEqual(
        turns[0].answers.map((entry) => entry.modelId),
        ["alpha", "beta"]
    );
    assert.equal(turns[0].answers[0].message.id, "a2");
});

test("a model just added shows an empty panel rather than none", () => {
    const { turns } = continuationTurns(
        [user("u1", "first"), answer("a1", "alpha", "alpha one")],
        ["alpha", "gamma"]
    );
    assert.equal(turns[0].answers.length, 2);
    assert.equal(turns[0].answers[1].modelId, "gamma");
    assert.equal(turns[0].answers[1].message, null);
});

test("answers from a deselected model are reported, never silently dropped", () => {
    // The row is still stored and the user paid for it. Hiding it with no
    // trace would read as deletion.
    const { turns, orphanedAnswers } = continuationTurns(
        [
            user("u1", "first"),
            answer("a1", "alpha", "alpha one"),
            answer("a2", "retired", "retired one"),
        ],
        ["alpha"]
    );
    assert.equal(turns[0].answers.length, 1);
    assert.deepEqual(
        orphanedAnswers.map((message) => message.id),
        ["a2"]
    );
});

test("an answer with no question above it still renders", () => {
    const { turns } = continuationTurns(
        [answer("a1", "alpha", "alpha one")],
        ["alpha"]
    );
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, null);
    assert.equal(turns[0].answers[0].message.id, "a1");
});

test("a re-run does not overwrite the answer already read", () => {
    const { turns } = continuationTurns(
        [
            user("u1", "first"),
            answer("a1", "alpha", "first attempt"),
            answer("a2", "alpha", "second attempt"),
        ],
        ["alpha"]
    );
    assert.equal(turns.length, 2);
    assert.equal(turns[0].answers[0].message.id, "a1");
    assert.equal(turns[1].answers[0].message.id, "a2");
});

/* -------------------------------------------------------- model selection */

test("below the cap, choosing a model adds it", () => {
    assert.deepEqual(
        planModelSelectionChange({
            selected: ["alpha"],
            modelId: "beta",
            maxModels: 3,
        }),
        { kind: "add", modelIds: ["alpha", "beta"] }
    );
});

test("at the cap, choosing a model asks what it replaces", () => {
    // Never a silent substitution: which model leaves changes what every
    // later turn costs, and the owner has said only which one they want.
    assert.deepEqual(
        planModelSelectionChange({
            selected: ["alpha", "beta", "gamma"],
            modelId: "delta",
            maxModels: 3,
        }),
        { kind: "swap_required", incomingModelId: "delta" }
    );
});

test("a selected model is removed, unless it is the last one", () => {
    assert.deepEqual(
        planModelSelectionChange({
            selected: ["alpha", "beta"],
            modelId: "alpha",
            maxModels: 3,
        }),
        { kind: "remove", modelIds: ["beta"] }
    );
    assert.deepEqual(
        planModelSelectionChange({
            selected: ["alpha"],
            modelId: "alpha",
            maxModels: 3,
        }),
        { kind: "refused", reason: "last_model" }
    );
});

test("a plan of one still lets the one model be swapped", () => {
    // A cap of 1 is a real plan shape. Removing is refused (nothing would
    // answer) but replacing must stay possible, or the account is stuck with
    // whichever model it started with.
    assert.deepEqual(
        planModelSelectionChange({
            selected: ["alpha"],
            modelId: "beta",
            maxModels: 1,
        }),
        { kind: "swap_required", incomingModelId: "beta" }
    );
});

test("a swap keeps the position of the model it replaces", () => {
    assert.deepEqual(
        applyModelSwap({
            selected: ["alpha", "beta", "gamma"],
            outgoingModelId: "beta",
            incomingModelId: "delta",
        }),
        ["alpha", "delta", "gamma"]
    );
});

/* ------------------------------------------------ what the screen may send */

test("the workspace never puts imported text in a request body", () => {
    // §5.1: the excerpt reaches the model as a server-built system block that
    // the server priced. A client that could put imported text in `messages`
    // could put anything there, so the assertion is that this component has no
    // access to it at all -- the timeline it renders is never read into the
    // chat request.
    const source = readFileSync(
        "components/continuations/ContinuedConversationWorkspace.tsx",
        "utf8"
    );
    const send = source.slice(
        source.indexOf("const send = useCallback"),
        source.indexOf("if (state.kind === \"loading\")")
    );
    assert.ok(send.length > 0, "the send path must be findable");
    for (const forbidden of ["timeline", "source.messages", "transcript"]) {
        assert.ok(
            !send.includes(forbidden),
            `the send path must not read ${forbidden}`
        );
    }
    // Each request names a model and carries that model's own branch.
    assert.match(send, /messagesForModel\(priorMessages, modelId\)/);
});

test("a comparison is admitted once, and a single model needs no admission", () => {
    // docs/policy/chat-concurrency-and-identity.md: all approved or all
    // refused. Panels that each asked for their own slot would refuse each
    // other.
    const source = readFileSync(
        "components/continuations/ContinuedConversationWorkspace.tsx",
        "utf8"
    );
    assert.match(source, /if \(modelIds\.length >= 2\) \{/);
    assert.equal(
        (source.match(/"\/api\/chat\/preflight"/g) ?? []).length,
        1,
        "exactly one preflight call site"
    );
});

test("one model's failure is reported on that panel, not on the turn", () => {
    // §5.1: reservation, settlement and refund are per model request. A banner
    // saying the turn failed would be false whenever another panel answered.
    const source = readFileSync(
        "components/continuations/ContinuedConversationWorkspace.tsx",
        "utf8"
    );
    assert.match(source, /setPanelErrors\(\(current\) => \(\{/);
    assert.match(source, /data-testid="continuation-panel-error"/);
});
