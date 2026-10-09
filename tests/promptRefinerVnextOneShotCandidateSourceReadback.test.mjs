import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

import {
  previewPromptRefinerVnextOneShotCandidateSourcePin,
  readPromptRefinerVnextOneShotCandidateSource,
  verifyPromptRefinerVnextOneShotCandidateSourceAtRoot,
} from "../lib/promptRefinerVnextOneShotCandidateSourceReadback.ts";

const MANIFEST_PATH =
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-candidate-source.json";
const COMMIT = "a".repeat(40);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tomverse-a02-source-"));
  assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const manifestBytes = await readFile(join(process.cwd(), MANIFEST_PATH));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  for (const path of [MANIFEST_PATH, ...Object.keys(manifest.files)]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(process.cwd(), path), target);
  }
  return { root, manifest, pin: {
    sourceCommitSha: COMMIT,
    sourceManifestDigest: sha256(manifestBytes),
  } };
}

test("A02 re-reads the exact full commit and every candidate file digest", async (t) => {
  const { root, pin, manifest } = await fixture(t);
  const result = await verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, COMMIT, pin);
  assert.equal(result.candidateSourceVerified, true);
  assert.equal(result.sourceCommitSha, COMMIT);
  assert.equal(result.sourceManifestDigest, pin.sourceManifestDigest);
  assert.equal(result.verifiedFileCount, Object.keys(manifest.files).length);
  assert.equal(result.dispatchAuthorized, false);
});

test("A02 refuses a single changed candidate byte", async (t) => {
  const { root, pin } = await fixture(t);
  await appendFile(join(root, "lib/promptRefinerQualityEvaluationVnextCandidate.ts"), "\n");
  await assert.rejects(
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, COMMIT, pin),
    /vnext_one_shot_candidate_file_drift/
  );
});

test("A02 accepts a later deployment only when every candidate byte is unchanged", async (t) => {
  const { root, pin } = await fixture(t);
  const laterDeployment = await verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(
    root, "b".repeat(40), pin);
  assert.equal(laterDeployment.sourceCommitSha, pin.sourceCommitSha);
  assert.equal(laterDeployment.candidateSourceVerified, true);
  await assert.rejects(
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, "a".repeat(7), pin),
    /vnext_one_shot_candidate_commit_mismatch/
  );
  await assert.rejects(
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, "b".repeat(40), {
      ...pin, sourceCommitSha: "short",
    }), /vnext_one_shot_candidate_commit_mismatch/
  );
  await appendFile(join(root, MANIFEST_PATH), "\n");
  await assert.rejects(
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, "b".repeat(40), pin),
    /vnext_one_shot_candidate_manifest_drift/
  );
});

test("A02 refuses a missing candidate file", async (t) => {
  const { root, pin } = await fixture(t);
  await rm(join(root, "lib/promptRefinerQualityEvaluationVnextCore.ts"));
  await assert.rejects(
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, COMMIT, pin),
    /vnext_one_shot_candidate_source_unavailable/
  );
});

test("A02 rejects an incomplete allowlist even when its new digest is pinned", async (t) => {
  const { root, pin, manifest } = await fixture(t);
  delete manifest.files["lib/promptRefinerQualityEvaluationVnextCore.ts"];
  const altered = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(root, MANIFEST_PATH), altered);
  await assert.rejects(
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, COMMIT, {
      ...pin, sourceManifestDigest: sha256(altered),
    }),
    /vnext_one_shot_candidate_manifest_invalid/
  );
});

test("A02 server entrypoint cannot use request-supplied pin without a stage", async () => {
  const tx = {
    promptRefinerVnextOneShotStage: {
      findUnique: async ({ where, select }) => {
        assert.equal(where.id, "prompt-refiner-vnext-one-shot-v4");
        assert.deepEqual(select, { sourceCommitSha: true, sourceManifestDigest: true });
        return null;
      },
    },
  };
  await assert.rejects(
    readPromptRefinerVnextOneShotCandidateSource(tx),
    /vnext_one_shot_candidate_stage_absent/
  );
});

test("A02 server entrypoint reads the immutable stage pin and deployed checkout", async () => {
  const manifestBytes = await readFile(join(process.cwd(), MANIFEST_PATH));
  const previous = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = COMMIT;
  try {
    const preview = await previewPromptRefinerVnextOneShotCandidateSourcePin();
    assert.deepEqual(preview, {
      sourceCommitSha: COMMIT,
      sourceManifestDigest: sha256(manifestBytes),
      dispatchAuthorized: false,
    });
    const tx = {
      promptRefinerVnextOneShotStage: {
        findUnique: async () => ({
          sourceCommitSha: COMMIT,
          sourceManifestDigest: sha256(manifestBytes),
        }),
      },
    };
    const result = await readPromptRefinerVnextOneShotCandidateSource(tx);
    assert.equal(result.candidateSourceVerified, true);
    assert.equal(result.dispatchAuthorized, false);
  } finally {
    if (previous === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = previous;
  }
});
