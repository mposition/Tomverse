import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import {
  MARKETING_AUTOMATION_FEATURES,
  MARKETING_AUTOMATION_KILL_SWITCH_ENV,
  MARKETING_PRICE_FALLBACK_ALERT_READY,
  MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES,
  MARKETING_WEBHOOK_PIPELINE_COMPLETE,
  MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
  MARKETING_WEBHOOK_PIPELINE_FILES,
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  MARKETING_WEBHOOK_PIPELINE_ROOT,
  MARKETING_WEBHOOK_SCHEMA_MODELS,
  canonicalMarketingWebhookFileText,
  canonicalMarketingWebhookJson,
  computeMarketingWebhookConfigSnapshotDigest,
  computeMarketingWebhookPipelineFingerprint,
  digestMarketingWebhookVerificationRecord,
  marketingAutomationEnabledFromValue,
  marketingWebhookEnvDigests,
  marketingWebhookSchemaSlice,
  resolveMarketingAutomationAccess,
} from "../lib/marketingAutomationAccess.ts";
import {
  MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
  marketingWebhookSignatureAuditRequirement,
} from "../lib/marketingAuditEvidence.ts";
import { MARKETING_WEBHOOK_EVENT_TYPES } from "../lib/marketingWebhookCore.ts";

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
  acceptedEventTypes: [...MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES],
  envDigests: marketingWebhookEnvDigests(
    rawWebhookEnvironment,
    MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
  ),
  schemaVersion: "marketing-webhook-shadow-v1",
};
const stagingConfigSnapshotDigest =
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
  stagingConfigSnapshotDigest,
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
    reasons: ["webhook_pipeline_incomplete", "webhook_production_config_unsigned"],
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

  // S1 r7 amendment 1: a live snapshot that differs from the staging one the
  // record carries (here, production identity) is expected, not a refusal. What
  // still refuses is the missing production generation, which S2f adds.
  const productionSnapshot = completeInputs();
  productionSnapshot.webhookConfigSnapshot = readable({
    ...configSnapshot,
    envDigests: marketingWebhookEnvDigests(
      { TOMVERSE_DEPLOY_ENV: "production" },
      MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
    ),
  });
  assert.deepEqual(
    resolveMarketingAutomationAccess(productionSnapshot).webhookApply,
    baseline,
  );

  const oldRecordShape = completeInputs();
  const { stagingConfigSnapshotDigest: digestValue, ...withoutStaging } = record;
  oldRecordShape.webhookVerificationRecordText = readable(
    JSON.stringify({ ...withoutStaging, configSnapshotDigest: digestValue }),
  );
  assert.ok(
    resolveMarketingAutomationAccess(oldRecordShape).webhookApply.reasons.includes(
      "webhook_record_invalid",
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

test("the accepted event list is the receiver's recorded list", () => {
  // Written out in the access module because the receiver's core imports it.
  assert.deepEqual(
    [...MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES],
    [...MARKETING_WEBHOOK_EVENT_TYPES],
  );
});

// The receiver route's local import closure, from the TypeScript syntax tree:
// static imports and re-exports, `import x = require()`, and `import()` /
// `require()` calls. A call whose argument is not a plain string literal is a
// failure, not a skip -- a dependency nobody can name cannot be fingerprinted.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isFile = (candidate) => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};
const resolveLocal = (fromPath, specifier) => {
  let base;
  if (specifier.startsWith("@/")) base = path.join(repositoryRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.join(repositoryRoot, path.dirname(fromPath), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (isFile(candidate)) return path.relative(repositoryRoot, candidate).split(path.sep).join("/");
  }
  throw new Error(`${fromPath}: cannot resolve ${specifier}`);
};
const moduleSpecifiers = (filePath, source) => {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const literal = (node, what) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      found.push(node.text);
      return;
    }
    throw new Error(`${filePath}: ${what} with a specifier that is not a plain string`);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) literal(node.moduleSpecifier, "import/export");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression, "import = require");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) literal(node.arguments[0], isDynamicImport ? "import()" : "require()");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};
const localImportClosure = (rootPath) => {
  const seen = new Set();
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(path.join(repositoryRoot, current), "utf8");
    for (const specifier of moduleSpecifiers(current, source)) {
      const resolved = resolveLocal(current, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return seen;
};

test("the closure scanner names commented and template imports and refuses computed ones", () => {
  assert.deepEqual(
    moduleSpecifiers(
      "x.ts",
      'const a = import(/* why */ "@/lib/a"); const b = import(`@/lib/b`); export * from "./c"; import d = require("./d");',
    ),
    ["@/lib/a", "@/lib/b", "./c", "./d"],
  );
  for (const source of ["import(name);", "require(`@/lib/${name}`);", "const m = require(base + \"x\");"]) {
    assert.throws(() => moduleSpecifiers("x.ts", source), /not a plain string/, source);
  }
});

test("the pipeline file list is the receiver route's whole import closure", () => {
  const closure = localImportClosure(MARKETING_WEBHOOK_PIPELINE_ROOT);
  // The module holding the fingerprint cannot hash itself.
  closure.delete("lib/marketingAutomationAccess.ts");
  const declared = MARKETING_WEBHOOK_PIPELINE_FILES.filter(
    (file) => file !== "prisma/schema.prisma" && !file.startsWith("prisma/migrations/"),
  );
  assert.deepEqual([...declared].sort(), [...closure].sort());
  assert.deepEqual([...MARKETING_WEBHOOK_PIPELINE_FILES], [...MARKETING_WEBHOOK_PIPELINE_FILES].sort());
  for (const file of MARKETING_WEBHOOK_PIPELINE_FILES) {
    assert.ok(isFile(path.join(repositoryRoot, file)), file);
  }
});

test("the fingerprint watches the receiver's schema models, not the whole schema", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const slice = marketingWebhookSchemaSlice(schema);
  assert.ok(/^datasource \w+ \{/m.test(slice), "datasource block");
  assert.ok(/^generator \w+ \{/m.test(slice), "generator block");
  for (const model of MARKETING_WEBHOOK_SCHEMA_MODELS) {
    assert.ok(slice.includes(`model ${model} {`), model);
  }
  const fingerprint = (text) =>
    computeMarketingWebhookPipelineFingerprint(
      [{ path: "prisma/schema.prisma", content: text }],
      MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
    );
  // An unrelated model elsewhere changes nothing.
  assert.equal(fingerprint(`${schema}\nmodel UnrelatedAddition {\n  id String @id\n}\n`), fingerprint(schema));
  // A change inside a watched model changes it.
  const changed = schema.replace("model MarketingReport {", "model MarketingReport {\n  addedColumn String?");
  assert.notEqual(fingerprint(changed), fingerprint(schema));
  // A watched model that disappears is an error, not a smaller slice.
  assert.throws(() => marketingWebhookSchemaSlice(schema.replace("model AppSetting {", "model AppSettingRenamed {")));
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
        // One BOM, whether or not the file already starts with one.
        content: `\uFEFF${file.content.replace(/^\uFEFF/, "").replaceAll("\n", "\r\n")}`,
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
      ZERNIO_WEBHOOK_SECRET: configSnapshot.envDigests.ZERNIO_WEBHOOK_SECRET,
      ZERNIO_API_KEY: configSnapshot.envDigests.ZERNIO_API_KEY,
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
    ZERNIO_API_KEY: null,
    ZERNIO_WEBHOOK_SECRET: null,
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
    '{"acceptedEventTypes":[],"appSettings":{"marketingAutomation.webhookShadowEnabled":"true"},"envDigests":{"APP_ENV":null,"RAILWAY_ENVIRONMENT_NAME":null,"TOMVERSE_DEPLOY_ENV":"e919a75364398a449f860aeadddc57fa0502145a4e63959ddb33c417a48dc0da","ZERNIO_API_KEY":null,"ZERNIO_WEBHOOK_SECRET":null},"schemaVersion":"marketing-webhook-shadow-v1"}',
  );
  assert.equal(first, "cb02916e4097920c4655ad02f34d428daacc40fdb0f87b59b6053b77138678bc");
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
