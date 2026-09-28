import assert from "node:assert/strict";
import { adminAuditEntryHashVariants } from "../lib/adminAuditIntegrityCore.ts";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import ts from "typescript";

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

const IMMUTABLE_SUCCESSOR_STAGE_IDS = [
  "PROMPT_REFINER_RESERVATION_STAGE_V3_ID",
  "PROMPT_REFINER_RESERVATION_STAGE_V4_ID",
];

const unwrapExpression = (node) => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const auditMetadataSuccessorStageIds = (source) => {
  const sourceFile = ts.createSourceFile(
    "promptRefinerStageAdmission.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const initializers = [];
  const findAuditMetadata = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "promptRefinerStageAuditMetadata" &&
      node.initializer
    ) {
      initializers.push(node.initializer);
    }
    ts.forEachChild(node, findAuditMetadata);
  };
  findAuditMetadata(sourceFile);
  assert.equal(initializers.length, 1, "expected one promptRefinerStageAuditMetadata initializer");

  const arrays = [];
  const findScopedIncludes = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments.length === 1
    ) {
      const argument = unwrapExpression(node.arguments[0]);
      if (
        ts.isPropertyAccessExpression(argument) &&
        ts.isIdentifier(argument.expression) &&
        argument.expression.text === "stage" &&
        argument.name.text === "id"
      ) {
        const receiver = unwrapExpression(node.expression.expression);
        assert.ok(
          ts.isArrayLiteralExpression(receiver),
          "audit metadata stage.id includes receiver must be an inline array"
        );
        arrays.push(receiver);
      }
    }
    ts.forEachChild(node, findScopedIncludes);
  };
  findScopedIncludes(initializers[0]);
  assert.equal(arrays.length, 1, "expected one audit metadata stage.id includes array");
  const array = arrays[0];
  assert.ok(
    array.elements.every(ts.isIdentifier),
    "audit metadata successor stage IDs must be direct identifiers"
  );
  return {
    names: array.elements.map((element) => element.text),
    start: array.getStart(sourceFile),
    end: array.getEnd(),
  };
};

const assertImmutableSuccessorAuditStageIds = (source) => {
  assert.deepEqual(
    auditMetadataSuccessorStageIds(source).names,
    IMMUTABLE_SUCCESSOR_STAGE_IDS,
    "audit metadata successor stage IDs must be the ordered immutable v3/v4 literals"
  );
};

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

  const successorMetadata = {
    ...metadata,
    runApprovalEnabled: true,
    executionEnabled: true,
  };
  const signedSuccessorAudit = (stageId, auditMetadata) => {
    const candidate = { ...unsigned, targetId: stageId, metadata: auditMetadata };
    return {
      ...candidate,
      entryHash: adminAuditEntryHashVariants(
        {
          previousHash: candidate.previousHash,
          actorUserId: candidate.actorUserId,
          actorEmail: candidate.actorEmail,
          action: candidate.action,
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          summary: candidate.summary,
          metadata: candidate.metadata,
          ipAddress: candidate.ipAddress,
          userAgent: candidate.userAgent,
          createdAt: candidate.createdAt.toISOString(),
        },
        currentKey
      ).codepoint,
    };
  };
  for (const stageId of ["prompt-refiner-shadow-v3", "prompt-refiner-shadow-v4"]) {
    const successorStage = { ...stage, id: stageId };
    assert.equal(
      promptRefinerStageAuthorizationAuditEntryIsValid(
        successorStage,
        signedSuccessorAudit(stageId, successorMetadata),
        [currentKey]
      ),
      true
    );
    assert.equal(
      promptRefinerStageAuthorizationAuditEntryIsValid(
        successorStage,
        signedSuccessorAudit(stageId, metadata),
        [currentKey]
      ),
      false
    );
    assert.equal(
      promptRefinerStageAuthorizationAuditEntryIsValid(
        successorStage,
        signedSuccessorAudit(stageId, { ...successorMetadata, executionEnabled: false }),
        [currentKey]
      ),
      false
    );
  }
});

test("successor audit facts are tied to immutable v3/v4 identities, not the moving current alias", (t) => {
  const source = readFileSync(
    new URL("../lib/promptRefinerStageAdmission.ts", import.meta.url),
    "utf8"
  );
  assertImmutableSuccessorAuditStageIds(source);

  const { start, end } = auditMetadataSuccessorStageIds(source);
  const withArray = (replacement) => source.slice(0, start) + replacement + source.slice(end);
  assertImmutableSuccessorAuditStageIds(
    withArray(`[
      PROMPT_REFINER_RESERVATION_STAGE_V3_ID,

      PROMPT_REFINER_RESERVATION_STAGE_V4_ID,
    ]`)
  );
  t.diagnostic("multiline-whitespace immutable v3/v4 array: accepted");

  for (const [name, replacement] of [
    ["import-only", "[]"],
    ["current-alias-only", "[PROMPT_REFINER_RESERVATION_STAGE_ID]"],
    [
      "v3-to-current-alias",
      "[PROMPT_REFINER_RESERVATION_STAGE_ID, PROMPT_REFINER_RESERVATION_STAGE_V4_ID]",
    ],
    [
      "v4-to-current-alias",
      "[PROMPT_REFINER_RESERVATION_STAGE_V3_ID, PROMPT_REFINER_RESERVATION_STAGE_ID]",
    ],
    [
      "extra-id",
      "[PROMPT_REFINER_RESERVATION_STAGE_V3_ID, PROMPT_REFINER_RESERVATION_STAGE_V4_ID, PROMPT_REFINER_RESERVATION_STAGE_V3_ID]",
    ],
    [
      "reordered",
      "[PROMPT_REFINER_RESERVATION_STAGE_V4_ID, PROMPT_REFINER_RESERVATION_STAGE_V3_ID]",
    ],
  ]) {
    assert.throws(
      () => assertImmutableSuccessorAuditStageIds(withArray(replacement)),
      /audit metadata successor stage IDs/
    );
    t.diagnostic(`${name}: refused`);
  }
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
