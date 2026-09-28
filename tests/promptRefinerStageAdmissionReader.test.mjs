import assert from "node:assert/strict";
import { adminAuditEntryHashVariants } from "../lib/adminAuditIntegrityCore.ts";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  PROMPT_REFINER_STAGE_FIXED_BINDINGS,
  promptRefinerStageAuthorizationAuditEntryIsValid,
  readExactCheckoutFile,
  readPromptRefinerRuntimeSourceFiles,
} from "../lib/promptRefinerStageAdmission.ts";
import {
  prefixedPromptRefinerDigest,
  promptRefinerExecutionManifest,
} from "../lib/promptRefinerStageAdmissionCore.ts";

const roots = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-refiner-source-"));
  roots.push(root);
  await writeFile(join(root, "source.txt"), "stable bytes\n");
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("fixed execution digest is derived from the single execution manifest source", () => {
  assert.equal(
    PROMPT_REFINER_STAGE_FIXED_BINDINGS.executionManifestDigest,
    prefixedPromptRefinerDigest(promptRefinerExecutionManifest())
  );
});

test("stage authorization accepts current and legacy canonical HMAC formats across key rotation", () => {
  const oldKey = "old-audit-integrity-key";
  const currentKey = "current-audit-integrity-key";
  const approvedAt = new Date("2026-09-17T02:00:00.000Z");
  const stage = {
    id: "prompt-refiner-shadow-v2",
    approvedBy: "mposition",
    admissionVersion: "prompt-refiner-stage-admission-v1",
    proposalDigest: `sha256:${"1".repeat(64)}`,
    evidenceBundleDigest: `sha256:${"2".repeat(64)}`,
    runtimeSourceManifestDigest: `sha256:${"3".repeat(64)}`,
    executionManifestDigest: `sha256:${"4".repeat(64)}`,
    runtimeEnvironment: "staging",
    runtimeDeploymentId: "deployment-1",
    runtimeCommitSha: "a".repeat(40),
    perRequestCostMicroUsd: 24_916n,
    maxReservations: 100,
    costCeilingMicroUsd: 2_491_600n,
    approvedAt,
    approvalExpiresAt: new Date(approvedAt.getTime() + 60 * 60 * 1_000),
  };
  const metadata = {
    admissionVersion: stage.admissionVersion,
    proposalDigest: stage.proposalDigest,
    evidenceBundleDigest: stage.evidenceBundleDigest,
    runtimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
    executionManifestDigest: stage.executionManifestDigest,
    environment: stage.runtimeEnvironment,
    deploymentId: stage.runtimeDeploymentId,
    commitSha: stage.runtimeCommitSha,
    perRequestCostMicroUsd: 24_916,
    maxReservations: 100,
    costCeilingMicroUsd: 2_491_600,
    approvalTtlMinutes: 60,
    approvedAt: stage.approvedAt.toISOString(),
    approvalExpiresAt: stage.approvalExpiresAt.toISOString(),
    reason: "bounded_staging_shadow_cost_approval",
  };
  const unsigned = {
    actorUserId: "mposition",
    actorEmail: "owner@example.com",
    action: "prompt_refiner.shadow_stage.activated",
    targetType: "PromptRefinerReservationStage",
    targetId: stage.id,
    summary: "Approved the bounded Prompt Refiner staging shadow stage.",
    metadata,
    ipAddress: null,
    userAgent: "unit-test",
    previousHash: "5".repeat(64),
    entryHash: null,
    createdAt: approvedAt,
  };
  const hashInput = {
    previousHash: unsigned.previousHash,
    actorUserId: unsigned.actorUserId,
    actorEmail: unsigned.actorEmail,
    action: unsigned.action,
    targetType: unsigned.targetType,
    targetId: unsigned.targetId,
    summary: unsigned.summary,
    metadata: unsigned.metadata,
    ipAddress: unsigned.ipAddress,
    userAgent: unsigned.userAgent,
    createdAt: unsigned.createdAt.toISOString(),
  };
  const currentVariants = adminAuditEntryHashVariants(hashInput, currentKey);
  const oldVariants = adminAuditEntryHashVariants(hashInput, oldKey);
  const current = {
    ...unsigned,
    entryHash: currentVariants.codepoint,
  };
  const legacyPrevious = {
    ...unsigned,
    entryHash: oldVariants.locale,
  };

  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(stage, current, [currentKey, oldKey]),
    true
  );
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(stage, legacyPrevious, [currentKey, oldKey]),
    true
  );
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(stage, legacyPrevious, [currentKey]),
    false
  );
  const legacyV1 = { ...stage, id: "prompt-refiner-shadow-v1" };
  const legacyV1Unsigned = { ...unsigned, targetId: legacyV1.id };
  const legacyV1Hash = adminAuditEntryHashVariants(
    {
      ...hashInput,
      targetId: legacyV1.id,
    },
    currentKey
  ).codepoint;
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(
      legacyV1,
      { ...legacyV1Unsigned, entryHash: legacyV1Hash },
      [currentKey]
    ),
    true
  );
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(
      { ...stage, runtimeDeploymentId: "different" },
      current,
      [currentKey, oldKey]
    ),
    false
  );

  const successorStage = { ...stage, id: "prompt-refiner-shadow-v3" };
  const successorMetadata = {
    ...metadata,
    runApprovalEnabled: true,
    executionEnabled: true,
  };
  const successorUnsigned = {
    ...unsigned,
    targetId: successorStage.id,
    metadata: successorMetadata,
  };
  const successorHash = adminAuditEntryHashVariants(
    {
      previousHash: successorUnsigned.previousHash,
      actorUserId: successorUnsigned.actorUserId,
      actorEmail: successorUnsigned.actorEmail,
      action: successorUnsigned.action,
      targetType: successorUnsigned.targetType,
      targetId: successorUnsigned.targetId,
      summary: successorUnsigned.summary,
      metadata: successorUnsigned.metadata,
      ipAddress: successorUnsigned.ipAddress,
      userAgent: successorUnsigned.userAgent,
      createdAt: successorUnsigned.createdAt.toISOString(),
    },
    currentKey
  ).codepoint;
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(
      successorStage,
      { ...successorUnsigned, entryHash: successorHash },
      [currentKey]
    ),
    true
  );
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(
      successorStage,
      {
        ...successorUnsigned,
        metadata,
        entryHash: adminAuditEntryHashVariants(
          {
            previousHash: successorUnsigned.previousHash,
            actorUserId: successorUnsigned.actorUserId,
            actorEmail: successorUnsigned.actorEmail,
            action: successorUnsigned.action,
            targetType: successorUnsigned.targetType,
            targetId: successorUnsigned.targetId,
            summary: successorUnsigned.summary,
            metadata,
            ipAddress: successorUnsigned.ipAddress,
            userAgent: successorUnsigned.userAgent,
            createdAt: successorUnsigned.createdAt.toISOString(),
          },
          currentKey
        ).codepoint,
      },
      [currentKey]
    ),
    false
  );
  const falseFlagMetadata = { ...successorMetadata, executionEnabled: false };
  const falseFlagHash = adminAuditEntryHashVariants(
    {
      previousHash: successorUnsigned.previousHash,
      actorUserId: successorUnsigned.actorUserId,
      actorEmail: successorUnsigned.actorEmail,
      action: successorUnsigned.action,
      targetType: successorUnsigned.targetType,
      targetId: successorUnsigned.targetId,
      summary: successorUnsigned.summary,
      metadata: falseFlagMetadata,
      ipAddress: successorUnsigned.ipAddress,
      userAgent: successorUnsigned.userAgent,
      createdAt: successorUnsigned.createdAt.toISOString(),
    },
    currentKey
  ).codepoint;
  assert.equal(
    promptRefinerStageAuthorizationAuditEntryIsValid(
      successorStage,
      { ...successorUnsigned, metadata: falseFlagMetadata, entryHash: falseFlagHash },
      [currentKey]
    ),
    false
  );
});

test("successor audit facts are tied to immutable v3 identity, not the moving current alias", () => {
  const source = readFileSync(
    new URL("../lib/promptRefinerStageAdmission.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /stage\.id === PROMPT_REFINER_RESERVATION_STAGE_V3_ID/);
  assert.doesNotMatch(
    source,
    /stage\.id === PROMPT_REFINER_RESERVATION_STAGE_ID\s*\?\s*\{\s*runApprovalEnabled/
  );
});

test("runtime source reader returns one stable fd snapshot", async () => {
  const root = await fixture();
  const bytes = await readExactCheckoutFile(root, "source.txt");
  assert.equal(Buffer.from(bytes).toString("utf8"), "stable bytes\n");
});

test("runtime source reader rejects a symlink component even when its target is inside the root", async () => {
  const root = await fixture();
  await mkdir(join(root, "target"));
  await writeFile(join(root, "target", "nested.txt"), "nested\n");
  await symlink(join(root, "target"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    readExactCheckoutFile(root, "link/nested.txt"),
    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR"
  );
});

test("runtime source reader rejects a file one byte over the exact cap", async () => {
  const root = await fixture();
  await writeFile(join(root, "source.txt"), Buffer.alloc(65));
  await assert.rejects(
    readExactCheckoutFile(root, "source.txt", { maxBytes: 64 }),
    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_SIZE"
  );
});

test("runtime closure reader refuses before allocating past the aggregate cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompt-refiner-total-source-"));
  roots.push(root);
  await writeFile(join(root, ".gitattributes"), Buffer.alloc(8 * 1024 * 1024, 1));
  await writeFile(join(root, "package.json"), Buffer.alloc(8 * 1024 * 1024, 2));
  await assert.rejects(
    readPromptRefinerRuntimeSourceFiles(root),
    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_SIZE"
  );
});

test("runtime source reader rejects a path swap after the fd snapshot", async () => {
  const root = await fixture();
  await writeFile(join(root, "replacement.txt"), "replacement\n");
  await assert.rejects(
    readExactCheckoutFile(root, "source.txt", {
      hooks: {
        afterInitialSnapshot: async () => {
          await rename(join(root, "source.txt"), join(root, "original.txt"));
          await rename(join(root, "replacement.txt"), join(root, "source.txt"));
        },
      },
    }),
    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_CHANGED"
  );
});

test("runtime source reader rejects in-place size drift before the post-fstat", async () => {
  const root = await fixture();
  await assert.rejects(
    readExactCheckoutFile(root, "source.txt", {
      hooks: {
        beforePostSnapshot: async () => {
          await writeFile(join(root, "source.txt"), "stable bytes with mutation\n");
        },
      },
    }),
    (error) => error?.code === "PROMPT_REFINER_STAGE_SOURCE_CHANGED"
  );
});
