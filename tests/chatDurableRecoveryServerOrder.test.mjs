import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const source = (path) => readFileSync(resolve(root, path), "utf8");

/*
 * These tests are narrow source-order tripwires. They do not prove runtime
 * atomicity or race behavior; those contracts are exercised through the
 * actual route and PostgreSQL in the server-contract and integration suites.
 */
test("route source places durable claim before context consumption, credit reservation and provider dispatch", () => {
  const route = source("app/api/chat/route.ts");
  const claim = route.indexOf("const claim = await claimChatResponseAttempt");
  const consume = route.indexOf("const consumption = await consumeContextBundle", claim);
  const reserve = route.indexOf("const accessGrant = await acquireChatAccess", claim);
  const dispatch = route.indexOf("const result = await beginProviderCall", claim);
  assert.ok(claim > 0);
  assert.ok(consume > claim);
  assert.ok(reserve > consume);
  assert.ok(dispatch > reserve);
});

test("route source places exact source lookup and terminal call inside the assistant transaction", () => {
  const route = source("app/api/chat/route.ts");
  const transaction = route.indexOf("await prisma.$transaction(async (tx) => {", 100_000);
  const exactSource = route.indexOf("...(persistenceSourceUserMessageId", transaction);
  const deterministicFallback = route.indexOf('{ createdAt: "desc" as const }', exactSource);
  const assistantCreate = route.indexOf("await tx.message.create({", exactSource);
  const terminal = route.indexOf("await terminalChatResponseAttempt(", assistantCreate);
  assert.ok(transaction > 0);
  assert.ok(exactSource > transaction);
  assert.ok(deterministicFallback > exactSource);
  assert.ok(assistantCreate > exactSource);
  assert.ok(terminal > assistantCreate);
});

test("durable request identity does not include ephemeral admission or worker tokens", () => {
  const route = source("app/api/chat/route.ts");
  const start = route.indexOf("chatResponseAttemptRequestPayloadDigest({");
  const end = route.indexOf("});", start);
  const digestInput = route.slice(start, end);
  assert.doesNotMatch(digestInput, /admissionToken|ownerId|traceId/);
  assert.match(digestInput, /messages/);
  assert.match(digestInput, /requestedModelId/);
  assert.match(digestInput, /verifiedContext\?\.requestIdentity/);
  assert.doesNotMatch(digestInput, /contextBundle:/);
});

test("route source places the persisted-source verifier call before durable claim plumbing", () => {
  const route = source("app/api/chat/route.ts");
  const admission = route.indexOf('"chat-durable-attempt"');
  const verify = route.indexOf("await verifyDurableChatSourceMessage({");
  const claim = route.indexOf("const claim = await claimChatResponseAttempt", verify);
  const reserve = route.indexOf("const accessGrant = await acquireChatAccess", claim);
  assert.ok(admission > 0 && verify > admission && claim > verify && reserve > claim);
});

test("claim and model-history deletion statically call the same advisory lock helper", () => {
  const claim = source("lib/chatResponseAttemptPersistence.ts");
  const deletion = source("lib/chatResponseAttemptDeletion.ts");
  assert.match(claim, /lockChatRecoveryConversation\(tx, input\.userId, parsed\.conversationId\)/);
  assert.match(deletion, /lockChatRecoveryConversation\(tx, input\.userId, input\.conversationId\)/);
  assert.match(deletion, /CHAT_RESPONSE_IN_PROGRESS/);
});

test("Deep Research stays on its separate persisted async-job contract", () => {
  const route = source("app/api/chat/route.ts");
  const durableDecision = route.indexOf("const isDurableStoredChat = Boolean(");
  const durableDecisionEnd = route.indexOf(");", durableDecision);
  const durablePredicate = route.slice(durableDecision, durableDecisionEnd);
  const deepResearchBranch = route.indexOf(
    'if (modelConfig.usageClass === "deep-research")',
    durableDecisionEnd
  );
  const asyncJobResponse = route.indexOf(
    '"X-Chat-Response-Mode": "async-job"',
    deepResearchBranch
  );
  assert.ok(durableDecision > 0);
  assert.match(durablePredicate, /modelConfig\.usageClass !== "deep-research"/);
  assert.ok(deepResearchBranch > durableDecisionEnd);
  assert.ok(asyncJobResponse > deepResearchBranch);
});
