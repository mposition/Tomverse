import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_SHADOW_HISTORICAL_CASE_IDS as CLIENT_CASE_IDS,
  PROMPT_REFINER_SHADOW_HISTORICAL_RUN_ID as CLIENT_RUN_ID,
  parsePromptRefinerShadowHistoricalDiagnostics,
  projectPromptRefinerShadowHistoricalDiagnostics,
} from "../lib/promptRefinerShadowHistoricalDiagnostics.ts";
import {
  PROMPT_REFINER_SHADOW_CASE_IDS,
  PROMPT_REFINER_SHADOW_RUN_ID,
} from "../lib/promptRefinerShadowRunContract.ts";

const ids = [
  ...Array.from({ length: 8 }, (_, index) => `prsv1-ko-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `prsv1-en-${String(index + 1).padStart(2, "0")}`),
];

const fixture = () => ({
  gateOutcome: "fail",
  gateReasons: ["case_evidence_failed", "injection_evidence_failed"],
  executionAdmitted: false,
  productAdapterReady: false,
  suggestionUiAuthorized: false,
  routerCouplingAuthorized: false,
  paidRunAuthorized: false,
  humanReviewRequired: true,
  summary: { attemptedCases: 16, passedCases: 13 },
  cases: ids.map((caseId, index) => ({
    caseId,
    terminalStatus: "suggested",
    evidenceStatus: index < 13 ? "pass" : "fail",
    failureReasons: index < 13 ? [] : [
      index === 15 ? "unsafe_injection_framing" : "required_concept_missing",
    ],
  })),
});

const terminalFixture = (includeFailed) => {
  const bundle = fixture();
  for (const item of bundle.cases) {
    item.evidenceStatus = "pass";
    item.failureReasons = [];
  }
  bundle.cases[1].terminalStatus = "unknown";
  bundle.cases[1].evidenceStatus = "insufficient_evidence";
  if (includeFailed) {
    bundle.cases[0].terminalStatus = "failed";
    bundle.cases[0].evidenceStatus = "fail";
    bundle.cases[0].failureReasons = ["not_suggested"];
  }
  bundle.summary.passedCases = includeFailed ? 14 : 15;
  bundle.gateOutcome = includeFailed ? "fail" : "insufficient_evidence";
  bundle.gateReasons = [
    ...(includeFailed ? ["case_evidence_failed"] : []),
    "case_evidence_incomplete",
    ...(includeFailed ? ["terminal_failure_present"] : []),
    "unknown_present", "cost_incomplete", "latency_incomplete",
  ];
  return bundle;
};

test("client run and case identities match the canonical server contract", () => {
  assert.equal(CLIENT_RUN_ID, PROMPT_REFINER_SHADOW_RUN_ID);
  assert.deepEqual(CLIENT_CASE_IDS, PROMPT_REFINER_SHADOW_CASE_IDS);
});

test("historical projection exposes only fixed content-free fields", () => {
  const bundle = fixture();
  bundle.sourceText = "private input must not leave the store";
  bundle.cases[13].refinedPrompt = "private proposal must not leave the store";
  bundle.cases[14].userId = "private user";
  bundle.cases[14].conversationId = "private conversation";
  bundle.cases[15].providerError = "private provider error";
  bundle.cases[15].modelOutput = "private model output";
  const diagnostics = projectPromptRefinerShadowHistoricalDiagnostics(bundle);
  assert.equal(diagnostics.passedCases, 13);
  assert.deepEqual({
    executionAdmitted: diagnostics.executionAdmitted,
    productAdapterReady: diagnostics.productAdapterReady,
    suggestionUiAuthorized: diagnostics.suggestionUiAuthorized,
    routerCouplingAuthorized: diagnostics.routerCouplingAuthorized,
    paidRunAuthorized: diagnostics.paidRunAuthorized,
    humanReviewRequired: diagnostics.humanReviewRequired,
  }, {
    executionAdmitted: false,
    productAdapterReady: false,
    suggestionUiAuthorized: false,
    routerCouplingAuthorized: false,
    paidRunAuthorized: false,
    humanReviewRequired: true,
  });
  assert.equal(diagnostics.cases[15].failureReasons[0], "unsafe_injection_framing");
  assert.deepEqual(Object.keys(diagnostics.cases[13]).sort(), [
    "caseId", "evidenceStatus", "failureReasons", "terminalStatus",
  ]);
  assert.doesNotMatch(
    JSON.stringify({ diagnostics }),
    /private input|private proposal|private user|private conversation|private provider error|private model output|sourceText|refinedPrompt|userId|conversationId|providerError|modelOutput/
  );
});

test("historical projection accepts failed and unknown terminal evidence", () => {
  for (const includeFailed of [false, true]) {
    const diagnostics = projectPromptRefinerShadowHistoricalDiagnostics(
      terminalFixture(includeFailed)
    );
    assert.equal(diagnostics.gateOutcome, includeFailed ? "fail" : "insufficient_evidence");
    assert.equal(diagnostics.passedCases, includeFailed ? 14 : 15);
    assert.deepEqual(diagnostics.cases[1], {
      caseId: ids[1],
      terminalStatus: "unknown",
      evidenceStatus: "insufficient_evidence",
      failureReasons: [],
    });
    assert.deepEqual(diagnostics.cases[0], {
      caseId: ids[0],
      terminalStatus: includeFailed ? "failed" : "suggested",
      evidenceStatus: includeFailed ? "fail" : "pass",
      failureReasons: includeFailed ? ["not_suggested"] : [],
    });
    assert.deepEqual(
      parsePromptRefinerShadowHistoricalDiagnostics({ diagnostics }),
      diagnostics
    );
  }
});

test("browser parser refuses content, identity, case order, count and reason drift", () => {
  const valid = { diagnostics: projectPromptRefinerShadowHistoricalDiagnostics(fixture()) };
  assert.deepEqual(parsePromptRefinerShadowHistoricalDiagnostics(valid), valid.diagnostics);
  const tamper = (mutate) => {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(parsePromptRefinerShadowHistoricalDiagnostics(candidate), null);
  };
  tamper((value) => { value.userId = "owner"; });
  tamper((value) => { value.diagnostics.sourceText = "secret"; });
  tamper((value) => { value.diagnostics.cases[0].refinedPrompt = "secret"; });
  tamper((value) => { value.diagnostics.cases[0].providerError = "secret"; });
  tamper((value) => { value.diagnostics.cases[0].caseId = ids[1]; });
  tamper((value) => { value.diagnostics.cases.reverse(); });
  tamper((value) => { value.diagnostics.passedCases = 14; });
  tamper((value) => { value.diagnostics.gateReasons = ["provider error text"]; });
  tamper((value) => { value.diagnostics.gateOutcome = "unreviewed_outcome"; });
  tamper((value) => { value.diagnostics.cases[0].terminalStatus = "unreviewed_terminal"; });
  tamper((value) => { value.diagnostics.cases[0].evidenceStatus = "unreviewed_evidence"; });
  tamper((value) => { value.diagnostics.cases[15].failureReasons = ["unknown reason"]; });
  tamper((value) => { value.diagnostics.gateOutcome = "pass"; });
  tamper((value) => { value.diagnostics.cases[13].failureReasons = []; });
  for (const flag of [
    "executionAdmitted", "productAdapterReady", "suggestionUiAuthorized",
    "routerCouplingAuthorized", "paidRunAuthorized", "humanReviewRequired",
  ]) {
    tamper((value) => { value.diagnostics[flag] = flag !== "humanReviewRequired"; });
  }
});

test("projection fails closed if stored case evidence is malformed", () => {
  const bundle = fixture();
  bundle.cases[0].caseId = ids[1];
  assert.throws(
    () => projectPromptRefinerShadowHistoricalDiagnostics(bundle),
    /prompt_refiner_historical_evidence_invalid/
  );
  for (const flag of [
    "executionAdmitted", "productAdapterReady", "suggestionUiAuthorized",
    "routerCouplingAuthorized", "paidRunAuthorized", "humanReviewRequired",
  ]) {
    const authorizationDrift = fixture();
    authorizationDrift[flag] = flag !== "humanReviewRequired";
    assert.throws(
      () => projectPromptRefinerShadowHistoricalDiagnostics(authorizationDrift),
      /prompt_refiner_historical_evidence_invalid/,
      `${flag} drift must be refused before projection`
    );
  }
});
