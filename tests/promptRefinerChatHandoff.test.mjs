import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  promptRefinerAutoMessageView,
  projectPromptRefinerChatHandoff,
  PromptRefinerChatProjectionError,
} from "../lib/promptRefinerChatHandoff.ts";
import {
  preflightInputEstimate,
  profileTextFor,
} from "../lib/autoDispatchPreflight.ts";
import {
  chatResponseAttemptFingerprint,
  chatResponseAttemptRequestPayloadDigest,
  decideAttemptClaim,
} from "../lib/chatResponseAttemptCore.ts";
import {
  ChatSourceMessageMismatchError,
  verifyDurableChatSourceMessage,
} from "../lib/chatDurableSourceMessage.ts";
import { prisma } from "../lib/prisma.ts";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  bindPromptRefinerSuggestion,
  resolvePromptRefinerDecision,
} from "../lib/promptRefinerSuggestion.ts";

const sourcePrompt = "  Cafe\u0301와 한글 🙂을 그대로 유지해 주세요.\r\n둘째 줄  ";
const refinedPrompt =
  "  Cafe\u0301와 한글 🙂의 공백과 줄바꿈을 유지해서 비교해 주세요.\r\n" +
  "먼저 기준을 표로 정리하고, 차이와 근거를 항목별로 설명한 뒤 마지막에 한 문장으로 요약해 주세요.  ";
const scope = Object.freeze({
  identityKey: "account:owner",
  mountedSurface: "chat",
  conversationId: "conversation:current",
});
const attachmentA = Object.freeze({ attachmentId: "attachment_a" });
const attachmentB = Object.freeze({ uploadId: "upload_b" });
const historyUser = Object.freeze({
  id: "message_history_user",
  role: "user",
  content: "earlier question",
  attachments: Object.freeze([attachmentA]),
});
const historyAssistant = Object.freeze({
  id: "message_history_assistant",
  role: "assistant",
  content: "earlier answer",
  attachments: Object.freeze([]),
});
const currentUser = Object.freeze({
  id: "message_current_user",
  role: "user",
  content: sourcePrompt,
  attachments: Object.freeze([attachmentA, attachmentB]),
  clientRequestId: "client_request_current",
});
const messages = Object.freeze([
  historyUser,
  historyAssistant,
  currentUser,
]);

const request = Object.freeze({ requestId: "request_current", prompt: sourcePrompt });
const response = Object.freeze({
  requestId: request.requestId,
  suggestionId: "suggestion_current",
  refinedPrompt,
  refinerVersion: "suggest-v1",
  inputScope: PROMPT_REFINER_INPUT_SCOPE,
});
const serverSuggestion = Object.freeze(
  bindPromptRefinerSuggestion({
    request,
    response,
    currentPrompt: sourcePrompt,
  })
);
assert.ok(serverSuggestion);

const resolutionFor = (decision) =>
  resolvePromptRefinerDecision({
    suggestion: serverSuggestion,
    currentPrompt: sourcePrompt,
    decision,
  });

const inputFor = (decision = "accepted") => ({
  messages,
  sourceMessageId: currentUser.id,
  serverSuggestion,
  boundScope: scope,
  currentScope: scope,
  decision,
  suppliedResolution: resolutionFor(decision),
});

const expectCode = (code, operation) => {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof PromptRefinerChatProjectionError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal("cause" in error, false);
    assert.doesNotMatch(error.message, /Cafe|account:owner|conversation:current/);
    return true;
  });
};

test("accepted projection preserves authored bytes and changes only current-user execution content", () => {
  const snapshot = structuredClone(messages);
  const projection = projectPromptRefinerChatHandoff(inputFor());

  assert.equal(projection.authoredMessages, messages);
  assert.deepEqual(projection.authoredMessages, snapshot);
  assert.notEqual(projection.executionMessages, messages);
  assert.equal(projection.executionMessages[0], historyUser);
  assert.equal(projection.executionMessages[1], historyAssistant);
  assert.notEqual(projection.executionMessages[2], currentUser);
  assert.equal(projection.executionMessages[2].content, refinedPrompt);
  assert.equal(projection.executionMessages[2].id, currentUser.id);
  assert.equal(projection.executionMessages[2].role, currentUser.role);
  assert.equal(
    projection.executionMessages[2].clientRequestId,
    currentUser.clientRequestId
  );
  assert.equal(
    projection.executionMessages[2].attachments,
    currentUser.attachments
  );
  assert.deepEqual(messages, snapshot, "the frozen input transcript was not mutated");
  assert.equal(currentUser.content, sourcePrompt);
  assert.equal(projection.authoredMessages[2].content, sourcePrompt);
  assert.equal(projection.authoredMessages[2].content.normalize("NFC") === sourcePrompt, false);
});

test("execution consumers see accepted content while the actual durable verifier receives authored bytes", async () => {
  const projection = projectPromptRefinerChatHandoff(inputFor());

  assert.equal(profileTextFor(projection.authoredMessages), sourcePrompt);
  assert.equal(profileTextFor(projection.executionMessages), refinedPrompt);
  assert.ok(
    preflightInputEstimate(projection.executionMessages).estimatedInputTokens >
      preflightInputEstimate(projection.authoredMessages).estimatedInputTokens
  );

  const userId = "user_current";
  const conversationId = "conversation_current";
  const messageDelegate = prisma.message;
  const originalFindFirst = messageDelegate.findFirst;
  messageDelegate.findFirst = async () => ({
    id: currentUser.id,
    content: sourcePrompt,
    attachments: [
      {
        id: attachmentA.attachmentId,
        uploadId: "upload_a_original",
        userId,
        conversationId,
      },
      {
        id: "attachment_b_bound",
        uploadId: attachmentB.uploadId,
        userId,
        conversationId,
      },
    ],
  });
  try {
    assert.deepEqual(
      await verifyDurableChatSourceMessage({
        userId,
        conversationId,
        sourceUserMessageId: currentUser.id,
        messages: projection.authoredMessages,
      }),
      { id: currentUser.id }
    );
    await assert.rejects(
      () =>
        verifyDurableChatSourceMessage({
          userId,
          conversationId,
          sourceUserMessageId: currentUser.id,
          messages: projection.executionMessages,
        }),
      ChatSourceMessageMismatchError
    );
  } finally {
    messageDelegate.findFirst = originalFindFirst;
  }
});

test("execution content changes the actual attempt digest and exact replay remains stable", () => {
  const first = projectPromptRefinerChatHandoff(inputFor());
  const replay = projectPromptRefinerChatHandoff(inputFor());
  const digestInput = (projectedMessages) => ({
    messages: projectedMessages,
    requestedModelId: "provider/model",
    webSearchMode: "off",
    context: null,
    acknowledgedUnavailableAttachmentIds: [],
  });
  const authoredDigest = chatResponseAttemptRequestPayloadDigest(
    digestInput(first.authoredMessages)
  );
  const executionDigest = chatResponseAttemptRequestPayloadDigest(
    digestInput(first.executionMessages)
  );
  const replayDigest = chatResponseAttemptRequestPayloadDigest(
    digestInput(replay.executionMessages)
  );
  assert.notEqual(executionDigest, authoredDigest);
  assert.equal(replayDigest, executionDigest);

  const fingerprintInput = {
    conversationId: "conversation_current",
    sourceUserMessageId: currentUser.id,
    requestedModelId: "provider/model",
    requestPayloadDigest: executionDigest,
  };
  const fingerprint = chatResponseAttemptFingerprint(fingerprintInput);
  assert.equal(fingerprint, chatResponseAttemptFingerprint(fingerprintInput));
  const identity = {
    assistantMessageId: "assistant_current",
    userId: "user_current",
    conversationId: fingerprintInput.conversationId,
    sourceUserMessageId: currentUser.id,
    fingerprint,
    requestedModelId: fingerprintInput.requestedModelId,
  };
  assert.deepEqual(decideAttemptClaim(identity, { ...identity }), {
    action: "reattach",
  });
});

test("keeping the original returns byte-identical authored and execution views", () => {
  const projection = projectPromptRefinerChatHandoff(inputFor("kept_original"));
  assert.equal(projection.authoredMessages, messages);
  assert.equal(projection.executionMessages, messages);
  assert.equal(profileTextFor(projection.executionMessages), sourcePrompt);
  assert.deepEqual(projection.authoredMessages, projection.executionMessages);
  assert.deepEqual(projection.provenance, {
    sourceMessageId: currentUser.id,
    requestId: request.requestId,
    suggestionId: response.suggestionId,
    refinerVersion: response.refinerVersion,
    inputScope: PROMPT_REFINER_INPUT_SCOPE,
    decision: "kept_original",
  });
});

test("only an explicit accepted choice projects the suggestion into execution", () => {
  const accepted = projectPromptRefinerChatHandoff(inputFor("accepted"));
  const kept = projectPromptRefinerChatHandoff(inputFor("kept_original"));
  assert.equal(accepted.authoredMessages[2].content, sourcePrompt);
  assert.equal(kept.authoredMessages[2].content, sourcePrompt);
  assert.equal(accepted.executionMessages[2].content, refinedPrompt);
  assert.equal(kept.executionMessages[2].content, sourcePrompt);
  expectCode("prompt_refiner_chat_decision_invalid", () =>
    projectPromptRefinerChatHandoff({ ...inputFor("accepted"), decision: undefined })
  );
  expectCode("prompt_refiner_chat_resolution_invalid", () =>
    projectPromptRefinerChatHandoff({ ...inputFor("accepted"), suppliedResolution: null })
  );
});

test("Auto live and shadow inputs stay authored without a handoff and share the accepted execution view", () => {
  const ordinary = promptRefinerAutoMessageView({ authoredMessages: messages });
  assert.equal(ordinary, messages);
  assert.equal(profileTextFor(ordinary), sourcePrompt);

  const accepted = promptRefinerAutoMessageView({
    authoredMessages: messages,
    projection: projectPromptRefinerChatHandoff(inputFor("accepted")),
    currentScope: scope,
  });
  assert.equal(profileTextFor(accepted), refinedPrompt);
  assert.ok(
    preflightInputEstimate(accepted).estimatedInputTokens >
      preflightInputEstimate(ordinary).estimatedInputTokens
  );
  assert.equal(accepted[0], ordinary[0]);
  assert.equal(accepted[1], ordinary[1]);
  assert.equal(accepted[2].attachments, ordinary[2].attachments);
  assert.equal(messages[2].content, sourcePrompt);

  const kept = promptRefinerAutoMessageView({
    authoredMessages: messages,
    projection: projectPromptRefinerChatHandoff(inputFor("kept_original")),
    currentScope: scope,
  });
  assert.equal(kept, messages);
  assert.equal(profileTextFor(kept), sourcePrompt);
});

test("Auto input selector rejects forged or mismatched local projections", () => {
  const accepted = projectPromptRefinerChatHandoff(inputFor());
  expectCode("prompt_refiner_chat_projection_untrusted", () =>
    promptRefinerAutoMessageView({
      authoredMessages: messages,
      projection: { ...accepted },
    })
  );
  expectCode("prompt_refiner_chat_projection_untrusted", () =>
    promptRefinerAutoMessageView({
      authoredMessages: [...messages],
      projection: accepted,
    })
  );
  expectCode("prompt_refiner_chat_scope_stale", () =>
    promptRefinerAutoMessageView({
      authoredMessages: messages,
      projection: accepted,
      currentScope: { ...scope, conversationId: "conversation:stale" },
    })
  );
  const mutable = messages.map((message) => ({ ...message }));
  const projected = projectPromptRefinerChatHandoff({
    ...inputFor(),
    messages: mutable,
  });
  mutable[2].content = `${sourcePrompt}!`;
  expectCode("prompt_refiner_chat_draft_stale", () =>
    promptRefinerAutoMessageView({
      authoredMessages: mutable,
      projection: projected,
      currentScope: scope,
    })
  );
});

test("Auto rebuilds execution from pinned bytes and refuses post-projection transcript mutation", () => {
  const makeMutable = () =>
    messages.map((message) => ({
      ...message,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
    }));
  const source = makeMutable();
  const projection = projectPromptRefinerChatHandoff({
    ...inputFor(),
    messages: source,
  });
  projection.executionMessages[2].content = "forged execution";
  projection.executionMessages[0] = { ...source[0], content: "forged history" };
  const autoMessages = promptRefinerAutoMessageView({
    authoredMessages: source,
    projection,
    currentScope: scope,
  });
  assert.equal(autoMessages[0], source[0]);
  assert.equal(autoMessages[2].content, refinedPrompt);
  assert.equal(source[2].content, sourcePrompt);

  for (const mutate of [
    (transcript) => { transcript[0].content = "changed history"; },
    (transcript) => { transcript[2].id = "changed source id"; },
    (transcript) => { transcript[2].attachments[0].attachmentId = "changed attachment"; },
    (transcript) => { transcript.push({ ...currentUser, id: "later user" }); },
  ]) {
    const transcript = makeMutable();
    const bound = projectPromptRefinerChatHandoff({
      ...inputFor(),
      messages: transcript,
    });
    mutate(transcript);
    expectCode("prompt_refiner_chat_draft_stale", () =>
      promptRefinerAutoMessageView({
        authoredMessages: transcript,
        projection: bound,
        currentScope: scope,
      })
    );
  }
});

test("Chat Auto and shadow call sites share the consumed execution view", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.match(
    route,
    /const autoRoutingMessages = executionMessages/
  );
  assert.match(route, /text: profileTextFor\(autoRoutingMessages\)/);
  assert.match(
    route,
    /reservedInputTokens: preflightInputEstimate\(autoRoutingMessages\)\.estimatedInputTokens/
  );
  assert.match(
    route,
    /text: profileTextFor\(autoRoutingMessages\)/
  );
});

test("scope, draft, source target and duplicate ids fail closed", () => {
  for (const changedScope of [
    { identityKey: "account:other" },
    { mountedSurface: "review" },
    { conversationId: "conversation:other" },
  ]) {
    expectCode("prompt_refiner_chat_scope_stale", () =>
      projectPromptRefinerChatHandoff({
        ...inputFor(),
        currentScope: { ...scope, ...changedScope },
      })
    );
  }
  expectCode("prompt_refiner_chat_scope_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      currentScope: { ...scope, unexpected: true },
    })
  );
  expectCode("prompt_refiner_chat_scope_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      boundScope: { ...scope, unexpected: true },
    })
  );
  expectCode("prompt_refiner_chat_source_id_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      messages: [
        historyUser,
        historyAssistant,
        { ...currentUser, id: "" },
      ],
      sourceMessageId: "",
    })
  );
  expectCode("prompt_refiner_chat_source_id_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      sourceMessageId: 42,
    })
  );
  expectCode("prompt_refiner_chat_draft_stale", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      messages: [
        historyUser,
        historyAssistant,
        { ...currentUser, content: `${sourcePrompt}!` },
      ],
    })
  );
  expectCode("prompt_refiner_chat_source_message_missing", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      sourceMessageId: "message_missing",
    })
  );
  expectCode("prompt_refiner_chat_source_message_not_current_user", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      sourceMessageId: historyUser.id,
    })
  );
  expectCode("prompt_refiner_chat_source_message_not_current_user", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      sourceMessageId: historyAssistant.id,
    })
  );
  expectCode("prompt_refiner_chat_message_id_duplicate", () =>
    projectPromptRefinerChatHandoff({
      ...inputFor(),
      messages: [historyUser, historyAssistant, currentUser, { ...currentUser }],
    })
  );
});

test("explicit decision and every supplied resolution byte are rederived", () => {
  const accepted = inputFor();
  expectCode("prompt_refiner_chat_decision_invalid", () =>
    projectPromptRefinerChatHandoff({ ...accepted, decision: "automatic" })
  );

  const forgeries = [
    { requestId: "request_forged" },
    { suggestionId: "suggestion_forged" },
    { refinerVersion: "suggest-v2" },
    { decision: "kept_original" },
  ];
  for (const provenanceChange of forgeries) {
    expectCode("prompt_refiner_chat_resolution_forged", () =>
      projectPromptRefinerChatHandoff({
        ...accepted,
        suppliedResolution: {
          ...accepted.suppliedResolution,
          provenance: {
            ...accepted.suppliedResolution.provenance,
            ...provenanceChange,
          },
        },
      })
    );
  }

  for (const resolutionChange of [
    { decision: "kept_original" },
    { displayPrompt: sourcePrompt },
    { persistedUserPrompt: refinedPrompt },
    { executionPrompt: sourcePrompt },
  ]) {
    expectCode("prompt_refiner_chat_resolution_forged", () =>
      projectPromptRefinerChatHandoff({
        ...accepted,
        suppliedResolution: {
          ...accepted.suppliedResolution,
          ...resolutionChange,
        },
      })
    );
  }
});

test("extra resolution fields and malformed server-held suggestions fail without disclosure", () => {
  const accepted = inputFor();
  expectCode("prompt_refiner_chat_resolution_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...accepted,
      suppliedResolution: {
        ...accepted.suppliedResolution,
        refinedPrompt: "browser supplied suggestion",
      },
    })
  );
  expectCode("prompt_refiner_chat_resolution_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...accepted,
      suppliedResolution: {
        ...accepted.suppliedResolution,
        provenance: {
          ...accepted.suppliedResolution.provenance,
          provider: "browser supplied provider",
        },
      },
    })
  );
  expectCode("prompt_refiner_chat_resolution_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...accepted,
      suppliedResolution: {
        ...accepted.suppliedResolution,
        provenance: {
          ...accepted.suppliedResolution.provenance,
          inputScope: "whole_conversation",
        },
      },
    })
  );
  expectCode("prompt_refiner_chat_server_suggestion_invalid", () =>
    projectPromptRefinerChatHandoff({
      ...accepted,
      serverSuggestion: {
        ...serverSuggestion,
        provider: "must not cross this boundary",
      },
    })
  );
});

test("projection provenance is narrow, content-free and not a receipt", () => {
  const projection = projectPromptRefinerChatHandoff(inputFor());
  assert.deepEqual(Object.keys(projection.provenance).sort(), [
    "decision",
    "inputScope",
    "refinerVersion",
    "requestId",
    "sourceMessageId",
    "suggestionId",
  ]);
  assert.equal(JSON.stringify(projection.provenance).includes(sourcePrompt), false);
  assert.equal(JSON.stringify(projection.provenance).includes(refinedPrompt), false);
  assert.equal("digest" in projection.provenance, false);
  assert.equal("conversationId" in projection.provenance, false);
  assert.equal("identityKey" in projection.provenance, false);
});
