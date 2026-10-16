import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let refusal;
let storeFails = false;
let reauthenticationFails = false;
const writes = [];

class DecisionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
class StoreError extends Error {}
class ReauthenticationError extends Error {}

const proposal = {
  kind: "card", localId: "c0:card-0", cardType: "task",
  featureRef: "feature-0001", parentStoryRef: null, dependencyRefs: [],
  title: "Mixed Task", problem: "One Task spans two path classes.",
  scopeIn: ["Change both files"], scopeOut: [],
  completionCriteria: ["Both changes pass"], taskRole: "implement",
  executionGrade: "routine",
  expectedPaths: ["lib/amux/contract.ts", "components/ordinary.tsx"],
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  amuxIdeaUnitDecision: { findFirst: async () => ({
    id: "decision-0001", actorUserId: "owner-1", state: "prepared",
    action: "register_card", outcomeUnknownAt: null,
    confirmationDigest: "a".repeat(64), confirmationSnapshot: {
      decisionId: "decision-0001", ideaId: "idea-0001",
      draftUnitId: "draft-0001", card: { cardType: "task" },
    }, ideaId: "idea-0001", draftUnitId: "draft-0001",
    ownerSessionDigest: "owner-digest", ownerSessionDigestKeyId: "owner-key",
  }) },
  $transaction: async () => { throw refusal; },
} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true, getAdminRole: () => "owner",
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => undefined,
} });
mock.module(mod("lib/amux/ideaCardDuplicateScanService.ts"), { namedExports: {
  AmuxCardDuplicateScanError: class extends Error {},
  loadAmuxCardDuplicateScanner: async () => async () => ({ candidates: [] }),
} });
mock.module(mod("lib/amux/ideaKeyConfig.ts"), { namedExports: {
  loadCurrentAmuxContentKeys: () => "keys",
} });
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: {
  createAmuxContentKeyRing: async () => "content-keys",
} });
mock.module(mod("lib/amux/ideaUnitBrowserCore.ts"), { namedExports: {
  amuxV4UnitBrowserDigest: () => ({ digest: "owner-digest", keyId: "owner-key" }),
} });
mock.module(mod("lib/amux/ideaUnitProposalReadService.ts"), { namedExports: {
  readVerifiedAmuxCardProposal: async () => ({
    unit: { id: "draft-0001", localRef: "c0:card-0" }, proposal,
    previewId: "preview-0001",
  }),
} });
mock.module(mod("lib/amux/ideaStoryConfirmationSnapshotCore.ts"), { namedExports: {
  assembleAmuxV4StoryConfirmation: () => ({}),
} });
mock.module(mod("lib/amux/ideaTaskConfirmationSnapshotCore.ts"), { namedExports: {
  assembleAmuxV4TaskConfirmation: () => ({}),
} });
mock.module(mod("lib/amux/ideaTaskReferenceService.ts"), { namedExports: {
  resolveAmuxV4TaskReferences: async () => ({}),
} });
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
  AmuxV4TaskCatalogApprovalError: class extends Error {},
  calculateCurrentApprovedAmuxV4TaskCost: async () => ({ receipt: {} }),
} });
mock.module(mod("lib/amux/ideaUnitDecisionStore.ts"), { namedExports: {
  AMUX_V4_UNIT_WRITE_ENV: "UNIT_WRITE_TEST",
  AmuxV4DuplicateReasonRequired: class extends DecisionError {},
  AmuxV4UnitDecisionError: DecisionError,
  amuxV4UnitWriteEnabled: () => true,
  commitAmuxV4CardRegistration: async () => ({}),
  commitAmuxV4UnitPrepare: async () => ({}),
  markAmuxV4UnitConsumeOutcomeUnknown: async () => undefined,
} });
mock.module(mod("lib/amux/ideaUnitConfirmationCore.ts"), { namedExports: {
  deriveAmuxIdeaUnitConfirmation: () => ({ ok: true,
    confirmationDigest: "a".repeat(64) }),
  sameAmuxIdeaUnitConfirmation: () => true,
} });
mock.module(mod("lib/amux/ideaRegistrationRefusalService.ts"), { namedExports: {
  AmuxV20RegistrationRefusalStoreError: StoreError,
  recordAmuxV20RegistrationRefusal: async (input) => {
    if (reauthenticationFails) throw new ReauthenticationError("step-up expired");
    if (storeFails) throw new StoreError("refusal store unavailable");
    writes.push(input);
    return { state: "awaiting_operator" };
  },
} });

const { AmuxV20RegistrationRefusalDetected } = await import(
  mod("lib/amux/ideaRegistrationRefusalDetectionCore.ts"));
const { prepareAmuxV4StoryRegistration, consumeAmuxV4StoryRegistration } =
  await import(mod("lib/amux/ideaStoryRegistrationService.ts"));

const session = { user: { id: "owner-1",
  authenticatedAt: "2026-10-16T00:00:00.000Z" }, role: "owner" };
const request = new Request("https://tomverse.test");
const prepareRequestId = "11111111-2222-4333-8444-555555555555";
const consumeRequestId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const identity = { ideaId: "idea-0001", draftUnitId: "draft-0001",
  analysisPreviewId: "preview-0001" };
const makeRefusal = () => new AmuxV20RegistrationRefusalDetected(
  "task_expected_paths_mixed", identity, proposal);

process.env.UNIT_WRITE_TEST = "enabled";

refusal = makeRefusal();
await assert.rejects(prepareAmuxV4StoryRegistration({ session, request,
  choice: { ideaId: identity.ideaId, draftUnitId: identity.draftUnitId,
    featureNodeId: "feature-0001", prepareRequestId, decisionReason: null,
    cardType: "task", publicPrDisclosureApproved: false },
  browserNonce: "browser-nonce" }),
(error) => error.code === "task_expected_paths_mixed");
assert.deepEqual(writes.map(({ attemptKind, requestId, refusalCode }) =>
  ({ attemptKind, requestId, refusalCode })), [{ attemptKind: "prepare",
  requestId: prepareRequestId, refusalCode: "task_expected_paths_mixed" }]);

refusal = makeRefusal();
await assert.rejects(consumeAmuxV4StoryRegistration({ session, request,
  decisionId: "decision-0001", consumeRequestId,
  confirmationDigest: "a".repeat(64), browserNonce: "browser-nonce" }),
(error) => error.code === "task_expected_paths_mixed");
assert.deepEqual(writes.map(({ attemptKind, requestId }) =>
  ({ attemptKind, requestId })), [
  { attemptKind: "prepare", requestId: prepareRequestId },
  { attemptKind: "consume", requestId: consumeRequestId },
]);

storeFails = true;
refusal = makeRefusal();
await assert.rejects(prepareAmuxV4StoryRegistration({ session, request,
  choice: { ideaId: identity.ideaId, draftUnitId: identity.draftUnitId,
    featureNodeId: "feature-0001", prepareRequestId, decisionReason: null,
    cardType: "task", publicPrDisclosureApproved: false },
  browserNonce: "browser-nonce" }),
(error) => error.code === "integrity_unavailable");

storeFails = false;
reauthenticationFails = true;
refusal = makeRefusal();
await assert.rejects(prepareAmuxV4StoryRegistration({ session, request,
  choice: { ideaId: identity.ideaId, draftUnitId: identity.draftUnitId,
    featureNodeId: "feature-0001", prepareRequestId, decisionReason: null,
    cardType: "task", publicPrDisclosureApproved: false },
  browserNonce: "browser-nonce" }),
(error) => error instanceof ReauthenticationError);
