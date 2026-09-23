import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKETING_AUTOMATION_FEATURES,
  MARKETING_AUTOMATION_KILL_SWITCH_ENV,
  MARKETING_PRICE_FALLBACK_ALERT_READY,
  MARKETING_WEBHOOK_PIPELINE_COMPLETE,
  MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
  MARKETING_WEBHOOK_PIPELINE_FILES,
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  canonicalMarketingWebhookFileText,
  canonicalMarketingWebhookJson,
  computeMarketingWebhookConfigSnapshotDigest,
  computeMarketingWebhookPipelineFingerprint,
  digestMarketingWebhookVerificationRecord,
  marketingAutomationEnabledFromValue,
  marketingWebhookEnvDigests,
  resolveMarketingAutomationAccess,
} from "../lib/marketingAutomationAccess.ts";
import {
  MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
  marketingWebhookSignatureAuditRequirement,
} from "../lib/marketingAuditEvidence.ts";

const readable = (value) => ({ ok: true, value });
const unreadable = { ok: false };

const scopeEntry = { eventType: "post.published", channelId: "channel-1" };
const rawWebhookEnvironment = {
  TOMVERSE_DEPLOY_ENV: "staging",
};
const configSnapshot = {
  appSettings: {
    "marketingAutomation.webhookShadowEnabled": "true",
  },
  acceptedEventTypes: [],
  envDigests: marketingWebhookEnvDigests(
    rawWebhookEnvironment,
    MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
  ),
  schemaVersion: "marketing-webhook-shadow-v1",
};
const configSnapshotDigest =
  computeMarketingWebhookConfigSnapshotDigest(configSnapshot);

const record = {
  recordId: "2026-09-18__zernio-published",
  executor: "staging-operator",
  stagingCommitSha: "a".repeat(40),
  observedScope: [scopeEntry],
  conditions: {
    c1: "pass",
    c2: "pass",
    c3: "pass",
    c4: "pass",
    c5: "pass",
  },
  evidenceRefs: ["artifact://marketing-webhook/c1-c5"],
  pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  configSnapshotDigest,
};
const recordText = `${JSON.stringify(record, null, 2)}\n`;
const recordDigest = digestMarketingWebhookVerificationRecord(recordText);
const signature = {
  recordId: record.recordId,
  recordDigest,
  signatureAuditLogId: "audit-webhook-signature-1",
};

const completeInputs = () => ({
  killSwitchValue: readable(undefined),
  adminAuthenticated: readable(true),
  draftsEnabled: readable(true),
  llmGenerationBudgetAvailable: readable(true),
  generatorAuthenticated: readable(true),
  priceFallbackAlertReady: readable(true),
  adminHasMarketingWrite: readable(true),
  adminStepUpRecent: readable(true),
  publishEnabled: readable(true),
  channelMode: readable("autonomous_mode"),
  adapterHealthy: readable(true),
  recoveryContractAvailable: readable(true),
  platformBudgetAvailable: readable(true),
  autoPublishEnabled: readable(true),
  commentsMonitorHealthy: readable(true),
  publicationCancellable: readable(true),
  o4Eligible: readable(true),
  o15Channel: readable(false),
  o3Satisfied: readable(true),
  experimentsEnabled: readable(true),
  cacheCspSpikePassed: readable(true),
  autonomousSurfaceGraduated: readable(true),
  seoAutoMergeRepositoryEnabled: readable(true),
  surfaceGraduation: readable(true),
  webhookShadowEnabled: readable(true),
  deploymentEnvironment: readable("staging"),
  resolvedDeploymentEnvironment: readable("staging"),
  webhookSignatureVerified: readable(true),
  webhookApplyScopeValue: readable(
    JSON.stringify({ recordId: record.recordId, scope: [scopeEntry] }),
  ),
  webhookVerificationRecordText: readable(recordText),
  webhookVerificationSignatureText: readable(JSON.stringify(signature)),
  webhookSignatureAuditEvidence: readable({
    auditLogId: signature.signatureAuditLogId,
    action: "marketing_webhook.verification_signed",
    targetId: record.recordId,
    recordDigest,
    verified: true,
  }),
  webhookConfigSnapshot: readable(configSnapshot),
  webhookEvent: readable(scopeEntry),
  configGeneration: readable(1),
});

const BOOLEAN_REQUIREMENTS = {
  adminRead: ["adminAuthenticated"],
  draftIntake: [
    "draftsEnabled",
    "llmGenerationBudgetAvailable",
    "generatorAuthenticated",
    "priceFallbackAlertReady",
  ],
  manualApproval: [
    "adminHasMarketingWrite",
    "adminStepUpRecent",
    "draftsEnabled",
  ],
  approvalPublish: [
    "publishEnabled",
    "adapterHealthy",
    "recoveryContractAvailable",
    "platformBudgetAvailable",
    "priceFallbackAlertReady",
  ],
  autonomousPublish: [
    "publishEnabled",
    "adapterHealthy",
    "recoveryContractAvailable",
    "platformBudgetAvailable",
    "priceFallbackAlertReady",
    "autoPublishEnabled",
    "commentsMonitorHealthy",
    "publicationCancellable",
    "o4Eligible",
  ],
  graduate: [
    "adminHasMarketingWrite",
    "adminStepUpRecent",
    "o3Satisfied",
    "commentsMonitorHealthy",
  ],
  experimentActivate: ["experimentsEnabled", "cacheCspSpikePassed"],
  seoAutoMerge: [
    "seoAutoMergeRepositoryEnabled",
    "surfaceGraduation",
  ],
  webhookShadow: ["webhookShadowEnabled", "webhookSignatureVerified"],
};

test("exports exactly the policy section 6.1 feature rows", () => {
  assert.deepEqual(MARKETING_AUTOMATION_FEATURES, [
    "adminRead",
    "draftIntake",
    "manualApproval",
    "approvalPublish",
    "autonomousPublish",
    "graduate",
    "experimentActivate",
    "seoAutoMerge",
    "webhookShadow",
    "webhookApply",
  ]);
  assert.equal(MARKETING_PRICE_FALLBACK_ALERT_READY, false);
});

test("the complete admitted inputs enable every S1 feature except apply", () => {
  const decisions = resolveMarketingAutomationAccess(completeInputs());
  for (const feature of MARKETING_AUTOMATION_FEATURES) {
    assert.equal(
      decisions[feature].enabled,
      feature !== "webhookApply",
      feature,
    );
  }
});

test("only autonomous publishing asks which configuration it was decided under", () => {
  // The question is about a gap. A person acting in the console decides and
  // writes in the same moment, so "have the settings changed since" has no
  // since to ask about; an autonomous post is sealed by a Guard and written
  // later, and the generation is what closes that interval.
  for (const value of [
    { ok: false },
    readable(0),
    readable(-1),
    readable(1.5),
  ]) {
    const inputs = completeInputs();
    inputs.configGeneration = value;
    const decisions = resolveMarketingAutomationAccess(inputs);
    assert.equal(decisions.autonomousPublish.enabled, false, JSON.stringify(value));
    assert.equal(
      decisions.approvalPublish.enabled,
      true,
      "the approval path does not depend on the generation",
    );
    assert.equal(decisions.manualApproval.enabled, true);
  }

  const unreadable = completeInputs();
  unreadable.configGeneration = { ok: false };
  assert.ok(
    resolveMarketingAutomationAccess(unreadable).autonomousPublish.reasons.includes(
      "input_unreadable:configGeneration",
    ),
  );

  const invalid = completeInputs();
  invalid.configGeneration = readable(0);
  assert.ok(
    resolveMarketingAutomationAccess(invalid).autonomousPublish.reasons.includes(
      "input_invalid:configGeneration",
    ),
    "zero is a number no writer stored: the setting starts at one",
  );
});

test("manual approval does not depend on the LLM generation budget", () => {
  const inputs = completeInputs();
  inputs.llmGenerationBudgetAvailable = readable(false);
  const decisions = resolveMarketingAutomationAccess(inputs);
  assert.equal(decisions.draftIntake.enabled, false);
  assert.equal(decisions.manualApproval.enabled, true);
});

test("each simple required boolean fails closed when false or unreadable", () => {
  for (const [feature, names] of Object.entries(BOOLEAN_REQUIREMENTS)) {
    for (const name of names) {
      const falseInputs = completeInputs();
      falseInputs[name] = readable(false);
      const falseDecision = resolveMarketingAutomationAccess(falseInputs)[feature];
      assert.equal(falseDecision.enabled, false, `${feature}: ${name}=false`);
      assert.ok(falseDecision.reasons.includes(`input_false:${name}`));

      const unreadableInputs = completeInputs();
      unreadableInputs[name] = unreadable;
      const unreadableDecision =
        resolveMarketingAutomationAccess(unreadableInputs)[feature];
      assert.equal(unreadableDecision.enabled, false, `${feature}: ${name}=unreadable`);
      assert.ok(
        unreadableDecision.reasons.includes(`input_unreadable:${name}`),
      );
    }
  }
});

test("a non-blank kill switch wins before every non-read input", () => {
  const inputs = completeInputs();
  inputs.killSwitchValue = readable(" stop ");
  inputs.draftsEnabled = unreadable;

  const decisions = resolveMarketingAutomationAccess(inputs);
  assert.equal(decisions.adminRead.enabled, true);
  for (const feature of MARKETING_AUTOMATION_FEATURES) {
    if (feature === "adminRead") continue;
    assert.deepEqual(decisions[feature], {
      enabled: false,
      reasons: ["kill_switch"],
    });
  }
  assert.equal(MARKETING_AUTOMATION_KILL_SWITCH_ENV, "MARKETING_AUTOMATION_KILL_SWITCH");
});

test("an unreadable kill-switch input also fails every non-read feature closed", () => {
  const inputs = completeInputs();
  inputs.killSwitchValue = unreadable;
  const decisions = resolveMarketingAutomationAccess(inputs);
  assert.equal(decisions.adminRead.enabled, true);
  for (const feature of MARKETING_AUTOMATION_FEATURES) {
    if (feature === "adminRead") continue;
    assert.deepEqual(decisions[feature], {
      enabled: false,
      reasons: ["input_unreadable:killSwitchValue"],
    });
  }
});

test("publish mode, O4, and O15 constraints are explicit", () => {
  const approval = completeInputs();
  approval.channelMode = readable("approval_mode");
  assert.equal(resolveMarketingAutomationAccess(approval).approvalPublish.enabled, true);
  assert.equal(
    resolveMarketingAutomationAccess(approval).autonomousPublish.enabled,
    false,
  );

  const o15 = completeInputs();
  o15.o15Channel = readable(true);
  const o15Decisions = resolveMarketingAutomationAccess(o15);
  assert.equal(o15Decisions.autonomousPublish.enabled, false);
  assert.ok(o15Decisions.autonomousPublish.reasons.includes("channel_o15"));
  assert.equal(o15Decisions.graduate.enabled, false);
  assert.ok(o15Decisions.graduate.reasons.includes("channel_o15"));

  const o15Unreadable = completeInputs();
  o15Unreadable.o15Channel = unreadable;
  const unreadableDecisions = resolveMarketingAutomationAccess(o15Unreadable);
  assert.ok(
    unreadableDecisions.autonomousPublish.reasons.includes(
      "input_unreadable:o15Channel",
    ),
  );
  assert.ok(
    unreadableDecisions.graduate.reasons.includes(
      "input_unreadable:o15Channel",
    ),
  );

  const modeUnreadable = completeInputs();
  modeUnreadable.channelMode = unreadable;
  assert.ok(
    resolveMarketingAutomationAccess(modeUnreadable).approvalPublish.reasons.includes(
      "input_unreadable:channelMode",
    ),
  );

  const modeInvalid = completeInputs();
  modeInvalid.channelMode = readable("paused");
  assert.ok(
    resolveMarketingAutomationAccess(modeInvalid).approvalPublish.reasons.includes(
      "input_invalid:channelMode",
    ),
  );

  const o4 = completeInputs();
  o4.o4Eligible = unreadable;
  assert.ok(
    resolveMarketingAutomationAccess(o4).autonomousPublish.reasons.includes(
      "input_unreadable:o4Eligible",
    ),
  );
});

test("experiment activation accepts either authorised approval mode or graduation", () => {
  const approvalPath = completeInputs();
  approvalPath.autonomousSurfaceGraduated = readable(false);
  assert.equal(
    resolveMarketingAutomationAccess(approvalPath).experimentActivate.enabled,
    true,
  );

  const graduatedPath = completeInputs();
  graduatedPath.adminHasMarketingWrite = readable(false);
  graduatedPath.adminStepUpRecent = unreadable;
  assert.equal(
    resolveMarketingAutomationAccess(graduatedPath).experimentActivate.enabled,
    true,
  );

  const neither = completeInputs();
  neither.autonomousSurfaceGraduated = readable(false);
  neither.adminHasMarketingWrite = readable(false);
  assert.equal(resolveMarketingAutomationAccess(neither).experimentActivate.enabled, false);

  const unreadableBoth = completeInputs();
  unreadableBoth.autonomousSurfaceGraduated = unreadable;
  unreadableBoth.adminHasMarketingWrite = unreadable;
  unreadableBoth.adminStepUpRecent = unreadable;
  const decision = resolveMarketingAutomationAccess(unreadableBoth).experimentActivate;
  assert.equal(decision.enabled, false);
  assert.ok(
    decision.reasons.includes("input_unreadable:autonomousSurfaceGraduated"),
  );
});

test("webhook shadow requires exact staging and a verified signature", () => {
  for (const value of ["production", "Staging", "", undefined]) {
    const inputs = completeInputs();
    inputs.deploymentEnvironment = readable(value);
    const decision = resolveMarketingAutomationAccess(inputs).webhookShadow;
    assert.equal(decision.enabled, false);
    assert.ok(decision.reasons.includes("environment_not_staging"));
  }

  const unreadableEnvironment = completeInputs();
  unreadableEnvironment.deploymentEnvironment = unreadable;
  assert.ok(
    resolveMarketingAutomationAccess(unreadableEnvironment).webhookShadow.reasons.includes(
      "input_unreadable:deploymentEnvironment",
    ),
  );

  const canonicalMismatch = completeInputs();
  canonicalMismatch.resolvedDeploymentEnvironment = readable("production");
  const mismatchDecision =
    resolveMarketingAutomationAccess(canonicalMismatch).webhookShadow;
  assert.equal(mismatchDecision.enabled, false);
  assert.ok(mismatchDecision.reasons.includes("environment_not_staging"));

  const canonicalUnreadable = completeInputs();
  canonicalUnreadable.resolvedDeploymentEnvironment = unreadable;
  assert.ok(
    resolveMarketingAutomationAccess(canonicalUnreadable).webhookShadow.reasons.includes(
      "input_unreadable:resolvedDeploymentEnvironment",
    ),
  );
});

test("webhook apply validates record, sibling signature, scope, audit, and config", () => {
  assert.equal(MARKETING_WEBHOOK_PIPELINE_COMPLETE, false);
  const baseline = resolveMarketingAutomationAccess(completeInputs()).webhookApply;
  assert.deepEqual(baseline, {
    enabled: false,
    reasons: ["webhook_pipeline_incomplete"],
  });

  const cases = [
    ["webhookApplyScopeValue", readable("not json"), "webhook_scope_invalid"],
    [
      "webhookVerificationRecordText",
      readable(JSON.stringify({ ...record, conditions: { ...record.conditions, c3: "fail" } })),
      "webhook_record_invalid",
    ],
    [
      "webhookVerificationSignatureText",
      readable(JSON.stringify({ ...signature, extra: true })),
      "webhook_signature_invalid",
    ],
    [
      "webhookSignatureAuditEvidence",
      readable({
        auditLogId: signature.signatureAuditLogId,
        action: "marketing_webhook.verification_signed",
        targetId: record.recordId,
        recordDigest,
        verified: false,
      }),
      "webhook_audit_invalid",
    ],
    [
      "webhookConfigSnapshot",
      readable({
        ...configSnapshot,
        envDigests: marketingWebhookEnvDigests(
          { TOMVERSE_DEPLOY_ENV: "production" },
          MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
        ),
      }),
      "webhook_config_snapshot_stale",
    ],
    [
      "webhookEvent",
      readable({ eventType: "post.failed", channelId: scopeEntry.channelId }),
      "webhook_event_outside_scope",
    ],
  ];

  for (const [name, value, reason] of cases) {
    const inputs = completeInputs();
    inputs[name] = value;
    const decision = resolveMarketingAutomationAccess(inputs).webhookApply;
    assert.equal(decision.enabled, false, name);
    assert.ok(decision.reasons.includes(reason), `${name}: ${reason}`);
    assert.ok(decision.reasons.includes("webhook_pipeline_incomplete"));
  }

  const notObserved = completeInputs();
  notObserved.webhookApplyScopeValue = readable(
    JSON.stringify({
      recordId: record.recordId,
      scope: [...record.observedScope, { eventType: "post.failed", channelId: "channel-2" }],
    }),
  );
  assert.ok(
    resolveMarketingAutomationAccess(notObserved).webhookApply.reasons.includes(
      "webhook_scope_not_observed",
    ),
  );

  for (const name of [
    "webhookApplyScopeValue",
    "webhookVerificationRecordText",
    "webhookVerificationSignatureText",
    "webhookSignatureAuditEvidence",
    "webhookConfigSnapshot",
    "webhookEvent",
  ]) {
    const inputs = completeInputs();
    inputs[name] = unreadable;
    const decision = resolveMarketingAutomationAccess(inputs).webhookApply;
    assert.ok(decision.reasons.includes(`input_unreadable:${name}`), name);
  }

  const stalePipeline = completeInputs();
  stalePipeline.webhookVerificationRecordText = readable(
    JSON.stringify({ ...record, pipelineFingerprint: "f".repeat(64) }),
  );
  assert.ok(
    resolveMarketingAutomationAccess(stalePipeline).webhookApply.reasons.includes(
      "webhook_pipeline_fingerprint_stale",
    ),
  );

  const invalidConfig = completeInputs();
  invalidConfig.webhookConfigSnapshot = readable({
    ...configSnapshot,
    envDigests: {},
  });
  assert.ok(
    resolveMarketingAutomationAccess(invalidConfig).webhookApply.reasons.includes(
      "webhook_config_snapshot_invalid",
    ),
  );

  const unsigned = completeInputs();
  unsigned.webhookVerificationSignatureText = readable(null);
  assert.ok(
    resolveMarketingAutomationAccess(unsigned).webhookApply.reasons.includes(
      "webhook_signature_invalid",
    ),
  );

  for (const invalidRecordId of ["../record", "2026-09-18__../record", "record/child"]) {
    const invalidRecord = completeInputs();
    invalidRecord.webhookVerificationRecordText = readable(
      JSON.stringify({ ...record, recordId: invalidRecordId }),
    );
    assert.ok(
      resolveMarketingAutomationAccess(invalidRecord).webhookApply.reasons.includes(
        "webhook_record_invalid",
      ),
      invalidRecordId,
    );
  }
});

test("webhook signature audit verification is bound to the exact record digest", () => {
  assert.equal(
    MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
    "marketing_webhook.verification_signed",
  );
  assert.deepEqual(
    marketingWebhookSignatureAuditRequirement({
      signatureAuditLogId: signature.signatureAuditLogId,
      recordId: signature.recordId,
      recordDigest: signature.recordDigest,
    }),
    {
      auditLogId: signature.signatureAuditLogId,
      action: "marketing_webhook.verification_signed",
      targetId: signature.recordId,
      metadata: { recordDigest: signature.recordDigest },
    },
  );
});

test("record digest strips BOM and normalises CRLF without changing the record", () => {
  const lf = `${JSON.stringify(record, null, 2)}\n`;
  const crlfWithBom = `\uFEFF${lf.replaceAll("\n", "\r\n")}`;
  assert.equal(canonicalMarketingWebhookFileText(crlfWithBom), lf);
  assert.equal(
    digestMarketingWebhookVerificationRecord(crlfWithBom),
    digestMarketingWebhookVerificationRecord(lf),
  );
});

test("pipeline fingerprint is current and independent of LF versus CRLF", () => {
  const files = MARKETING_WEBHOOK_PIPELINE_FILES.map((path) => ({
    path,
    content: readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
  }));
  assert.equal(
    computeMarketingWebhookPipelineFingerprint(
      files,
      MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
    ),
    MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  );
  assert.equal(
    computeMarketingWebhookPipelineFingerprint(
      files,
      MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
    ),
    computeMarketingWebhookPipelineFingerprint(
      files.map((file) => ({
        ...file,
        content: `\uFEFF${file.content.replaceAll("\n", "\r\n")}`,
      })),
      MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
    ),
  );
});

test("configuration digest accepts only caller-hashed environment values", () => {
  const first = computeMarketingWebhookConfigSnapshotDigest(configSnapshot);
  const reordered = computeMarketingWebhookConfigSnapshotDigest({
    schemaVersion: configSnapshot.schemaVersion,
    envDigests: {
      TOMVERSE_DEPLOY_ENV: configSnapshot.envDigests.TOMVERSE_DEPLOY_ENV,
      RAILWAY_ENVIRONMENT_NAME:
        configSnapshot.envDigests.RAILWAY_ENVIRONMENT_NAME,
      APP_ENV: configSnapshot.envDigests.APP_ENV,
    },
    acceptedEventTypes: [...configSnapshot.acceptedEventTypes].reverse(),
    appSettings: {
      "marketingAutomation.webhookShadowEnabled": "true",
    },
  });
  assert.equal(first, reordered);
  assert.deepEqual(configSnapshot.envDigests, {
    APP_ENV: null,
    RAILWAY_ENVIRONMENT_NAME: null,
    TOMVERSE_DEPLOY_ENV: createHash("sha256")
      .update("staging", "utf8")
      .digest("hex"),
  });

  const canonicalSnapshot = canonicalMarketingWebhookJson({
    acceptedEventTypes: [],
    appSettings: {
      "marketingAutomation.webhookShadowEnabled": "true",
    },
    envDigests: configSnapshot.envDigests,
    schemaVersion: "marketing-webhook-shadow-v1",
  });
  assert.equal(
    canonicalSnapshot,
    '{"acceptedEventTypes":[],"appSettings":{"marketingAutomation.webhookShadowEnabled":"true"},"envDigests":{"APP_ENV":null,"RAILWAY_ENVIRONMENT_NAME":null,"TOMVERSE_DEPLOY_ENV":"e919a75364398a449f860aeadddc57fa0502145a4e63959ddb33c417a48dc0da"},"schemaVersion":"marketing-webhook-shadow-v1"}',
  );
  assert.equal(first, "a0edae0675b3d90bb1087fa1fbb4b6189525dd9b24f8b94f714341fc235e1f73");
  assert.notEqual(
    first,
    computeMarketingWebhookConfigSnapshotDigest({
      ...configSnapshot,
      envDigests: marketingWebhookEnvDigests(
        { TOMVERSE_DEPLOY_ENV: "production" },
        MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
      ),
    }),
  );

  const missing = marketingWebhookEnvDigests(
    {},
    MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
  );
  const empty = marketingWebhookEnvDigests(
    { TOMVERSE_DEPLOY_ENV: "" },
    MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
  );
  assert.equal(missing.TOMVERSE_DEPLOY_ENV, null);
  assert.notEqual(empty.TOMVERSE_DEPLOY_ENV, null);
});

test("only the literal true enables a stored marketing boolean", () => {
  for (const value of [undefined, null, "", "TRUE", " true ", "1", "false"]) {
    assert.equal(marketingAutomationEnabledFromValue(value), false);
  }
  assert.equal(marketingAutomationEnabledFromValue("true"), true);
});
