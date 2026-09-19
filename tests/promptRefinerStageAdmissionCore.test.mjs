import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
  PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
  PROMPT_REFINER_STAGE_ADMISSION_VERSION,
  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
  PROMPT_REFINER_STAGE_CONFIRMATION,
  buildPromptRefinerStagePreviewBinding,
  buildPromptRefinerRuntimeSourceManifest,
  buildPromptRefinerStageAdmissionFacts,
  prefixedPromptRefinerDigest,
  promptRefinerStageAdmissionProblems,
  promptRefinerStageApprovalWindowProblems,
  promptRefinerStagePreviewBindingDigest,
} from "../lib/promptRefinerStageAdmissionCore.ts";

const commitSha = "a".repeat(40);

const sourceFiles = () =>
  new Map(
    PROMPT_REFINER_RUNTIME_SOURCE_PATHS.map((path, index) => [
      path,
      new TextEncoder().encode(`${index}:${path}\n`),
    ])
  );

const admissionFacts = () => {
  const source = buildPromptRefinerRuntimeSourceManifest({
    commitSha,
    files: sourceFiles(),
  });
  return buildPromptRefinerStageAdmissionFacts({
    runtimeCommitSha: commitSha,
    runtimeDeploymentId: "deployment-test-1",
    runtimeEnvironment: "staging",
    runtimeSourceManifest: source.manifest,
    runtimeSourceIdentityDigest: source.sourceIdentityDigest,
    runtimeSourceManifestDigest: source.manifestDigest,
  });
};

test("durable admission facts are deterministic, content-free, and never admit execution", () => {
  const left = admissionFacts();
  const right = admissionFacts();
  assert.deepEqual(left, right);
  assert.equal(left.admissionVersion, PROMPT_REFINER_STAGE_ADMISSION_VERSION);
  assert.equal(left.executionManifest.executionAdmitted, false);
  assert.equal(left.executionManifest.productAdapterReady, false);
  assert.deepEqual(promptRefinerStageAdmissionProblems(left), []);
  assert.equal(PROMPT_REFINER_STAGE_APPROVAL_TTL_MS, 60 * 60 * 1_000);
  assert.match(PROMPT_REFINER_STAGE_CONFIRMATION, /60 MINUTES$/);
  const objectKeys = [];
  const visitKeys = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      objectKeys.push(key);
      visitKeys(nested);
    }
  };
  visitKeys(left);
  for (const forbidden of ["promptText", "refinedText", "conversationId", "userId", "apiKey", "providerError"]) {
    assert.equal(objectKeys.includes(forbidden), false);
  }
});

test("runtime source manifest binds exact bytes, sizes, paths, and commit", () => {
  const first = buildPromptRefinerRuntimeSourceManifest({ commitSha, files: sourceFiles() });
  for (const path of [
    "lib/adminAuditIntegrityCore.ts",
    "lib/promptRefinerShadowAdmissionCore.ts",
    "lib/routerDevelopmentBenchmark.ts",
    "lib/auth.ts",
    "lib/originProtection.ts",
  ]) {
    const changedFiles = sourceFiles();
    const original = changedFiles.get(path);
    changedFiles.set(path, Uint8Array.from([...original, 0x21]));
    const changed = buildPromptRefinerRuntimeSourceManifest({ commitSha, files: changedFiles });
    assert.notEqual(first.sourceIdentityDigest, changed.sourceIdentityDigest, path);
    assert.notEqual(first.manifestDigest, changed.manifestDigest, path);
  }
  assert.equal(first.manifest.files.length, PROMPT_REFINER_RUNTIME_SOURCE_PATHS.length);
  assert.equal(
    first.manifest.totalSizeBytes,
    [...sourceFiles().values()].reduce((total, bytes) => total + bytes.byteLength, 0)
  );
  assert.deepEqual(first.manifest.files.map((entry) => entry.path), [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS]);
  assert.throws(
    () => buildPromptRefinerRuntimeSourceManifest({ commitSha, files: new Map([...sourceFiles()].slice(1)) }),
    /source_path_allowlist/
  );
  assert.throws(
    () => buildPromptRefinerRuntimeSourceManifest({ commitSha: "not-a-commit", files: sourceFiles() }),
    /runtime_commit_invalid/
  );
  const oversized = sourceFiles();
  oversized.set(PROMPT_REFINER_RUNTIME_SOURCE_PATHS[0], new Uint8Array(6 * 1024 * 1024));
  oversized.set(PROMPT_REFINER_RUNTIME_SOURCE_PATHS[1], new Uint8Array(6 * 1024 * 1024));
  oversized.set(PROMPT_REFINER_RUNTIME_SOURCE_PATHS[2], new Uint8Array(6 * 1024 * 1024));
  assert.throws(
    () => buildPromptRefinerRuntimeSourceManifest({ commitSha, files: oversized }),
    /runtime_source_total_size/
  );
  assert.equal(PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES, 16 * 1024 * 1024);
});

test("caller-controlled environment, deployment, and manifest drift fail closed", () => {
  const source = buildPromptRefinerRuntimeSourceManifest({ commitSha, files: sourceFiles() });
  const base = {
    runtimeCommitSha: commitSha,
    runtimeDeploymentId: "deployment-test-1",
    runtimeEnvironment: "staging",
    runtimeSourceManifest: source.manifest,
    runtimeSourceIdentityDigest: source.sourceIdentityDigest,
    runtimeSourceManifestDigest: source.manifestDigest,
  };
  assert.throws(() => buildPromptRefinerStageAdmissionFacts({ ...base, runtimeEnvironment: "production" }), /not_staging/);
  assert.throws(() => buildPromptRefinerStageAdmissionFacts({ ...base, runtimeDeploymentId: "" }), /deployment_id_invalid/);
  assert.throws(() => buildPromptRefinerStageAdmissionFacts({ ...base, runtimeSourceManifestDigest: `sha256:${"0".repeat(64)}` }), /manifest_digest_mismatch/);
});

test("preview binding digest is canonical and every deployment or budget fact is bound", () => {
  const facts = admissionFacts();
  const binding = buildPromptRefinerStagePreviewBinding(facts);
  const digest = promptRefinerStagePreviewBindingDigest(binding);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    digest,
    promptRefinerStagePreviewBindingDigest({
      approvalTtlMinutes: binding.approvalTtlMinutes,
      costCeilingMicroUsd: binding.costCeilingMicroUsd,
      maxReservations: binding.maxReservations,
      perRequestCostMicroUsd: binding.perRequestCostMicroUsd,
      executionManifestDigest: binding.executionManifestDigest,
      runtimeSourceManifestDigest: binding.runtimeSourceManifestDigest,
      proposalDigest: binding.proposalDigest,
      commitSha: binding.commitSha,
      deploymentId: binding.deploymentId,
      environment: binding.environment,
    })
  );

  for (const changed of [
    { environment: "staging-other" },
    { deploymentId: "deployment-test-2" },
    { commitSha: "b".repeat(40) },
    { proposalDigest: `sha256:${"4".repeat(64)}` },
    { runtimeSourceManifestDigest: `sha256:${"5".repeat(64)}` },
    { executionManifestDigest: `sha256:${"6".repeat(64)}` },
    { perRequestCostMicroUsd: binding.perRequestCostMicroUsd + 1 },
    { maxReservations: binding.maxReservations + 1 },
    { costCeilingMicroUsd: binding.costCeilingMicroUsd + 1 },
    { approvalTtlMinutes: binding.approvalTtlMinutes + 1 },
  ]) {
    assert.notEqual(
      promptRefinerStagePreviewBindingDigest({ ...binding, ...changed }),
      digest,
      Object.keys(changed)[0]
    );
  }
});

test("validation rejects fabricated runtime commit and source identity facts", () => {
  const facts = admissionFacts();
  assert.ok(
    promptRefinerStageAdmissionProblems({
      ...facts,
      runtimeCommitSha: "b".repeat(40),
    }).includes("runtime_commit_sha")
  );

  const fabricatedManifest = {
    ...facts.runtimeSourceManifest,
    commitSha: "b".repeat(40),
  };
  assert.ok(
    promptRefinerStageAdmissionProblems({
      ...facts,
      runtimeSourceManifest: fabricatedManifest,
      runtimeSourceManifestDigest: prefixedPromptRefinerDigest(fabricatedManifest),
    }).includes("runtime_commit_sha")
  );

  const fabricatedFiles = facts.runtimeSourceManifest.files.map((entry, index) =>
    index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry
  );
  const fabricatedSource = {
    ...facts.runtimeSourceManifest,
    files: fabricatedFiles,
  };
  assert.ok(
    promptRefinerStageAdmissionProblems({
      ...facts,
      runtimeSourceManifest: fabricatedSource,
      runtimeSourceManifestDigest: prefixedPromptRefinerDigest(fabricatedSource),
    }).includes("runtime_source_identity_digest")
  );
});

test("approval window is exactly 60 minutes and uses an observed clock", () => {
  const approvedAt = new Date("2026-09-17T00:00:00.000Z");
  const approvalExpiresAt = new Date(approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS);
  assert.deepEqual(
    promptRefinerStageApprovalWindowProblems({ approvedAt, approvalExpiresAt, now: new Date(approvedAt.getTime() + 1) }),
    []
  );
  assert.deepEqual(
    promptRefinerStageApprovalWindowProblems({ approvedAt, approvalExpiresAt, now: approvalExpiresAt }),
    ["approval_expired"]
  );
  assert.deepEqual(
    promptRefinerStageApprovalWindowProblems({ approvedAt, approvalExpiresAt: new Date(approvalExpiresAt.getTime() + 1), now: approvedAt }),
    ["approval_ttl"]
  );
});
