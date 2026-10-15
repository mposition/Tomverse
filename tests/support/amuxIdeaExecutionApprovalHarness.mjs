import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let calls;
let ownedIdea;
let priceMatches;
let reservationFails;
let commitFails;

class ConfirmationError extends Error { constructor(code) { super(code); this.code = code; } }
class ReservationError extends Error { constructor(code) { super(code); this.code = code; } }

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      amuxIdeaSubmission: { findFirst: async () => (ownedIdea ? { id: "idea" } : null) },
      amuxIdeaAnalysisPriceVersion: { findUnique: async () => ({ id: "price" }) },
      $transaction: async (work) => {
        const result = await work("tx-1");
        if (commitFails) throw new Error("connection lost at commit");
        return result;
      },
    },
  },
});
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: { adminAuditIntegrityKeys: () => ["k"] } });
mock.module(mod("lib/adminAuth.ts"), {
  namedExports: { isAdminSession: () => true, getAdminRole: (session) => session.role },
});
mock.module(mod("lib/amux/ideaAnalysisApprovedCostProfile.ts"), {
  namedExports: { amuxV4ApprovedCliCostProfileMatches: () => priceMatches },
});
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: { loadAmuxContentKeyRing: async () => "keys" } });
mock.module(mod("lib/amux/ideaTransferConfirmationService.ts"), {
  namedExports: {
    IdeaTransferConfirmationError: ConfirmationError,
    commitIdeaTransferConfirmation: async (tx, input) => {
      calls.push(["confirm", tx, input.choice.previewId, input.browserNonce, input.keys]);
      return { previewId: "preview", ideaId: "idea", confirmExpiresAt: new Date(0), auditId: "a1",
        payloadDigest: "d", payloadDigestKeyId: "k" };
    },
  },
});
mock.module(mod("lib/amux/ideaAnalysisBudgetReservationService.ts"), {
  namedExports: {
    AMUX_V4_ANALYSIS_BUDGET_RESERVE_CODE_LATCH: true,
    AmuxIdeaAnalysisReservationError: ReservationError,
    commitAmuxIdeaAnalysisBudgetReservation: async (tx, input) => {
      calls.push(["reserve", tx, input.holdId, input.previewId, input.priceVersionId, input.runner]);
      if (reservationFails) throw new ReservationError("budget_unavailable");
      return { holdId: input.holdId, previewId: input.previewId, reservedMicroUsd: "123", auditId: "a2" };
    },
  },
});

const { approveIdeaExecution, IdeaExecutionApprovalError } = await import(mod("lib/amux/ideaExecutionApprovalService.ts"));

const switches = {
  TOMVERSE_AMUX_V4_TRANSFER_CONFIRM_WRITE: "enabled",
  TOMVERSE_AMUX_V4_TRANSFER_CONFIRM_READ: "enabled",
  TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE: "enabled",
  TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ: "enabled",
};
const owner = { user: { id: "owner-1" }, role: "owner" };
const input = { confirmation: { previewId: "preview", ideaId: "idea", payloadDigest: "d".repeat(64), payloadDigestKeyId: "k" },
  holdId: "hold", priceVersionId: "price" };
const reset = () => {
  calls = []; ownedIdea = true; priceMatches = true; reservationFails = false; commitFails = false;
  Object.assign(process.env, switches);
};
const code = (error) => error.code;

// One approval: the confirmation and the reservation run in the same transaction, in that order.
reset();
const approved = await approveIdeaExecution(owner, new Request("https://t.test"), input, "nonce");
assert.equal(approved.holdId, "hold");
assert.equal(approved.confirmationAuditId, "a1");
assert.equal(approved.reservationAuditId, "a2");
assert.deepEqual(calls.map(([kind, tx]) => [kind, tx]), [["confirm", "tx-1"], ["reserve", "tx-1"]]);
assert.deepEqual(calls[0].slice(2), ["preview", "nonce", "keys"]);
assert.deepEqual(calls[1].slice(2), ["hold", "preview", "price", { tokenCapsEnforceable: true, billableToolsDisabled: true }]);

// A reservation refusal is the refusal of the whole decision: it surfaces as itself.
reset(); reservationFails = true;
await assert.rejects(approveIdeaExecution(owner, new Request("https://t.test"), input, "nonce"),
  (error) => error instanceof ReservationError && code(error) === "budget_unavailable");

// A failure after the callback returned is an unknown outcome, never a refusal to retry from.
reset(); commitFails = true;
await assert.rejects(approveIdeaExecution(owner, new Request("https://t.test"), input, "nonce"),
  (error) => error instanceof IdeaExecutionApprovalError && code(error) === "outcome_unknown");

// Nothing runs without every switch, the owner, the owned idea and the approved price profile.
for (const name of Object.keys(switches)) {
  reset(); process.env[name] = "disabled";
  await assert.rejects(approveIdeaExecution(owner, new Request("https://t.test"), input, "nonce"),
    (error) => code(error) === "disabled");
  assert.deepEqual(calls, []);
}
reset();
await assert.rejects(approveIdeaExecution({ user: { id: "o" }, role: "ops" }, new Request("https://t.test"), input, "nonce"),
  (error) => code(error) === "not_found");
reset(); ownedIdea = false;
await assert.rejects(approveIdeaExecution(owner, new Request("https://t.test"), input, "nonce"),
  (error) => code(error) === "not_found");
reset(); priceMatches = false;
await assert.rejects(approveIdeaExecution(owner, new Request("https://t.test"), input, "nonce"),
  (error) => code(error) === "price_profile_unapproved");
assert.deepEqual(calls, []);
