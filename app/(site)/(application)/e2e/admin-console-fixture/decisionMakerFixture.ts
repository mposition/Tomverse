import type { DmAdminRequestDetailView } from "@/components/admin/AmuxDecisionMakerRequestDetailPanel";
import type { DmAdminRequestList, DmAdminRequestRow } from "@/lib/amux/decisionMakerAdminCore";
import type { DmAttention } from "@/lib/amux/decisionMakerAttention";
import type { DmDeclarationAccuracyReport } from "@/lib/amux/decisionMakerJudgmentCore";
import type { DecisionMakerSwitchState } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * Decision Maker requests for the Admin console fixture: a proposal waiting on
 * a person, a confirmed answer whose delivery is unknown, and the history
 * around them. Synthetic identifiers only.
 */
const NOW = Date.UTC(2026, 9, 19, 6, 32, 0);
export const DM_FIXTURE_PROPOSAL_ID = "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a71";
export const DM_FIXTURE_UNKNOWN_ID = "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a72";

const row = (overrides: Partial<DmAdminRequestRow>): DmAdminRequestRow => ({
  requestId: DM_FIXTURE_PROPOSAL_ID,
  cardId: "CR-7",
  questionRevision: 2,
  askingWorkerId: "claude-impl",
  askingProvider: "claude",
  route: "dm_proposal",
  instance: "decision-maker-openai",
  refusalCodes: [],
  createdAtMs: NOW - 12 * 60_000,
  assignmentDeadlineAtMs: NOW - 10 * 60_000,
  assigned: true,
  snapshotState: "worker_head",
  transmitOutcome: "receipt",
  resultKind: "proposal",
  resultUnknown: false,
  closingKind: null,
  outputKind: "select",
  irreversible: true,
  declarationAccuracy: null,
  delivered: false,
  deliveryOutcome: null,
  deliveryNotSentReason: null,
  deliveryResolution: null,
  cleanupUnknownAtMs: null,
  ...overrides,
});

const proposalRow = row({});
const unknownRow = row({
  requestId: DM_FIXTURE_UNKNOWN_ID, cardId: "CR-8", questionRevision: 1, irreversible: false,
  createdAtMs: NOW - 45 * 60_000, closingKind: "confirm", declarationAccuracy: "not_judged",
  delivered: true, deliveryOutcome: "unknown",
});

export const dmFixtureAttention: DmAttention = {
  dbNowMs: NOW,
  total: 2,
  items: [
    { requestId: proposalRow.requestId, cardId: "CR-7", questionRevision: 2, askingWorkerId: "claude-impl",
      instance: "decision-maker-openai", kind: "proposal", irreversible: true, createdAtMs: proposalRow.createdAtMs,
      question: "Keep the migration as one file, or split it in two?",
      proposal: "b · Keep one file; leave the CHECK NOT VALID" },
    { requestId: unknownRow.requestId, cardId: "CR-8", questionRevision: 1, askingWorkerId: "codex-impl",
      instance: "decision-maker-anthropic", kind: "delivery_unknown", irreversible: false, createdAtMs: unknownRow.createdAtMs,
      question: "Rebuild the fixtures from develop?", proposal: "a · Rebuild them" },
  ],
};

export const dmFixtureDetail: DmAdminRequestDetailView = {
  kind: "detail",
  detail: {
    dbNowMs: NOW,
    row: proposalRow,
    card: {
      askType: "decision", resolution: "select", type: "task", tags: [], title: "Migration split",
      question: "Keep the Prisma migration as one file, or split it in two? One file ships the CHECK with the same deploy.",
      options: [
        { id: "a", label: "Split it: the CHECK goes in the next migration", effect: "two deploys", paths: [] },
        { id: "b", label: "Keep one file; leave the CHECK NOT VALID", effect: "one deploy", paths: [] },
        { id: "c", label: "Stop and ask the operator", effect: "no change", paths: [] },
      ],
      unblocks: "The worker finalises the migration file.",
      context: "The repository asks for VALIDATE in a separate migration.",
      contextPaths: ["prisma/migrations", "docs/policy/credit-and-cost-limits.md"],
    },
    answer: null,
    optionId: "b",
    rationale: "VALIDATE belongs in its own migration, and putting it in the same deploy makes the schema comparison report drift. Splitting gets the same result in two deploys.",
    escalationReason: null,
    operatorAnswer: null,
    snapshotTargetSha: "4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
    shown: {
      answerDigest: null, rationaleDigest: "3".repeat(64), optionId: "b", irreversible: true,
      snapshotState: "worker_head", snapshotTargetSha: "4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
      snapshotManifestDigest: "b".repeat(64),
    },
  },
};

export const dmFixtureSwitches: DecisionMakerSwitchState = {
  killSwitch: false,
  instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "off" },
};

export const dmFixtureReport: DmDeclarationAccuracyReport = {
  dbNowMs: NOW,
  instances: [
    { instance: "decision-maker-openai",
      decidedProposals: { status: "measured", numerator: 1, denominator: 1, value: 1 },
      daysSinceFirstProposal: { status: "measured", days: 0, firstProposalAtMs: NOW - 60 * 60_000 },
      confirmedWithoutEdit: { status: "measured", numerator: 0, denominator: 1, value: 0 },
      matchedOverJudged: { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null },
      notJudged: { status: "measured", numerator: 1, denominator: 1, value: 1 } },
    { instance: "decision-maker-anthropic",
      decidedProposals: { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null },
      daysSinceFirstProposal: { status: "insufficient_evidence" },
      confirmedWithoutEdit: { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null },
      matchedOverJudged: { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null },
      notJudged: { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null } },
  ],
};

export const dmFixtureRequests: DmAdminRequestList = {
  dbNowMs: NOW,
  rows: [
    proposalRow,
    unknownRow,
    row({ requestId: "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a73", cardId: "CR-6", questionRevision: 1, irreversible: false,
      createdAtMs: NOW - 90 * 60_000, closingKind: "reject", declarationAccuracy: "not_judged" }),
    row({ requestId: "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a74", cardId: "CR-4", questionRevision: 1,
      createdAtMs: NOW - 160 * 60_000, resultKind: "timeout", outputKind: null, irreversible: null,
      askingWorkerId: "codex-impl", askingProvider: "codex", instance: "decision-maker-anthropic" }),
    row({ requestId: "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a75", cardId: "CR-5", questionRevision: 1,
      createdAtMs: NOW - 140 * 60_000, route: "operator", instance: null, assigned: false, snapshotState: null,
      transmitOutcome: null, resultKind: null, outputKind: null, irreversible: null, refusalCodes: ["irreversible_term"] }),
  ],
};
