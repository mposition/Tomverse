import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read(
  "prisma/migrations/20260913100000_chat_durable_recovery_foundation/migration.sql"
);
const draftRoute = read("app/api/products/chat/drafts/[scopeKey]/route.ts");
const attemptRoute = read("app/api/products/chat/attempts/[assistantMessageId]/route.ts");

test("schema has one draft per account scope and attempt identity as the primary key", () => {
  const attemptModel = schema.match(/model ChatResponseAttempt \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(schema, /model ChatComposerDraft[\s\S]*@@unique\(\[userId, scopeKey\]\)/);
  assert.match(attemptModel, /assistantMessageId\s+String\s+@id/);
  assert.match(attemptModel, /sourceUserMessage\s+Message[\s\S]*onDelete: Cascade/);
  assert.doesNotMatch(attemptModel, /assistantMessageId[^\n]*@relation/);
});

test("migration constrains draft scope, opaque JSON shape and terminal consistency", () => {
  assert.match(migration, /ChatComposerDraft_scope/);
  assert.match(migration, /jsonb_typeof\("attachmentReferences"\) = 'array'/);
  assert.match(migration, /ChatResponseAttempt_terminal/);
  assert.match(migration, /ChatResponseAttempt_failure_code_check/);
  assert.doesNotMatch(migration, /raw_provider_error|provider_message|exception_text/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test("recovery GET routes are model-passive and make every response no-store", () => {
  for (const source of [draftRoute, attemptRoute]) {
    assert.match(source, /export const dynamic = "force-dynamic"/);
    assert.match(source, /"Cache-Control": "no-store"/);
    assert.match(source, /if \(securityResponse\) return noStore\(securityResponse\)/);
    assert.doesNotMatch(source, /streamText|generateText|acquireChatAccess|reserve|providerAdapter/i);
  }
  assert.match(draftRoute, /params: Promise<\{ scopeKey: string \}>/);
  assert.match(attemptRoute, /params: Promise<\{ assistantMessageId: string \}>/);
});

test("policy and account export encode the privacy boundary", () => {
  const policy = read("docs/policy/chat-durable-draft-and-attempt-recovery.md");
  const domains = read("lib/accountDataExportDomains.ts");
  const exportSource = read("lib/accountDataExport.ts");
  assert.match(policy, /They may write[\s\S]*security rate-limit bookkeeping/);
  assert.match(policy, /GET never changes recovery state,[\s\S]*creates an attempt, or submits a message/);
  assert.match(domains, /domain: "chatComposerDraft"[\s\S]*state: "included_filtered"/);
  assert.match(domains, /domain: "chatResponseAttempt"[\s\S]*state: "included_filtered"/);
  assert.match(exportSource, /chatComposerDraft: \(userId\)[\s\S]*text: true/);
  assert.match(exportSource, /chatResponseAttempt: \(userId\)[\s\S]*partialContent: true/);
  assert.doesNotMatch(
    exportSource.match(/chatResponseAttempt: \(userId\)[\s\S]*?\n\s*\}\),/)?.[0] ?? "",
    /fingerprint: true|ownerId: true|leaseExpiresAt: true/
  );
});

test("conversation recovery ownership is scoped inside the query and shares a 404", () => {
  const access = read("lib/chatDurableRecoveryAccess.ts");
  assert.match(access, /findFirst\(\{[\s\S]*where: \{ id: input\.scopeKey, userId: input\.userId \}/);
  assert.doesNotMatch(access, /CONVERSATION_FORBIDDEN/);
});

test("draft rate limiting happens before a valid-looking scope reaches authorization", () => {
  const route = read("app/api/products/chat/drafts/[scopeKey]/route.ts");
  const limiter = route.indexOf("await consumeApiRateLimit", route.indexOf("async function requestScope"));
  const authorization = route.indexOf("await authorizeChatRecoveryScope", limiter);
  assert.ok(limiter >= 0 && limiter < authorization);
});

test("attempt write CAS evaluates leases on the database clock", () => {
  const persistence = read("lib/chatResponseAttemptPersistence.ts");
  const atomicUpdates = persistence.match(/UPDATE "ChatResponseAttempt"[\s\S]*?CURRENT_TIMESTAMP/g) ?? [];
  assert.equal(atomicUpdates.length >= 2, true);
  assert.equal(
    (
      persistence.match(
        /"leaseExpiresAt" > \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)/g
      ) ?? []
    ).length,
    2
  );
  assert.doesNotMatch(persistence, /"leaseExpiresAt" > CURRENT_TIMESTAMP/);
  assert.doesNotMatch(persistence, /leaseExpiresAt: \{ gt: now \}/);
});

test("an existing owned attempt resolves identity before create-only validation", () => {
  const persistence = read("lib/chatResponseAttemptPersistence.ts");
  const claimStart = persistence.indexOf("export async function claimChatResponseAttempt");
  const claimEnd = persistence.indexOf("export async function checkpointChatResponseAttempt");
  const claim = persistence.slice(claimStart, claimEnd);
  const identityDecision = claim.indexOf("decideAttemptClaim(existing, identity)");
  const createScope = claim.indexOf("const scoped = await prisma.conversation.findFirst");
  const leaseValidation = claim.indexOf("validateAttemptLease");
  assert.match(
    claim,
    /const existing = await prisma\.chatResponseAttempt\.findFirst\(\{[\s\S]*?where: \{ assistantMessageId: parsed\.assistantMessageId, userId: input\.userId \}/
  );
  assert.match(
    claim,
    /const raced = await prisma\.chatResponseAttempt\.findFirst\(\{[\s\S]*?where: \{ assistantMessageId: parsed\.assistantMessageId, userId: input\.userId \}/
  );
  assert.doesNotMatch(claim, /chatResponseAttempt\.findUnique/);
  assert.ok(identityDecision >= 0 && identityDecision < createScope);
  assert.ok(identityDecision < leaseValidation);
});
