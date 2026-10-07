import "server-only";

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { listEngineeringAgentImagePaths,
  summarizeEngineeringAgentImagePaths } from
  "@/scripts/report-engineering-agent-image-proof-core.mjs";

export const ENGINEERING_AGENT_V22_IMAGE_PROOF_ENV =
  "ENGINEERING_AGENT_V22_IMAGE_PROOF";

/** Cheap transaction-time recheck: the exact proof used in the preflight
 * must still be installed before a capability is created. */
export function currentEngineeringAgentV22ImageProofDigest(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env[ENGINEERING_AGENT_V22_IMAGE_PROOF_ENV];
  return raw && Buffer.byteLength(raw, "utf8") <= 2_048 ?
    createHash("sha256").update(raw).digest("hex") : null;
}

type Proof = {
  sourceCommit: string;
  deploymentId: string;
  imageDigest: string;
  completePathCount: number;
  completePathListSha256: string;
  testsPathCount: number;
  approvedBy: string;
  approvedAt: string;
};

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEPLOYMENT = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Only the owner-attested exact deployment may exclude tests from the
 * runtime slice. The complete path list is retained outside the app; this
 * runtime check does not pretend to derive an image digest from inside it. */
export function decideEngineeringAgentV22ImageExclusion(input: {
  proof: unknown;
  baseSha: string;
  runtimeSourceSha: string | undefined;
  runtimeDeploymentId: string | undefined;
  runtimeManifest: { completePathCount: number;
    completePathListSha256: string; testsPathCount: number };
  testsExist: boolean;
  adminPlaywrightConfigExists: boolean;
}): readonly string[] {
  const proof = input.proof as Partial<Proof> | null;
  if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      !SHA1.test(input.baseSha) ||
      proof.sourceCommit !== input.baseSha ||
      proof.sourceCommit !== input.runtimeSourceSha ||
      typeof proof.deploymentId !== "string" ||
      !DEPLOYMENT.test(proof.deploymentId) ||
      proof.deploymentId !== input.runtimeDeploymentId ||
      typeof proof.imageDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(proof.imageDigest) ||
      typeof proof.completePathListSha256 !== "string" ||
      !SHA256.test(proof.completePathListSha256) ||
      !Number.isSafeInteger(proof.completePathCount) ||
      proof.completePathCount !== input.runtimeManifest.completePathCount ||
      proof.completePathListSha256 !==
        input.runtimeManifest.completePathListSha256 ||
      input.runtimeManifest.testsPathCount !== 0 ||
      proof.testsPathCount !== 0 ||
      proof.approvedBy !== "mposition" ||
      typeof proof.approvedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(proof.approvedAt) ||
      input.testsExist || input.adminPlaywrightConfigExists)
    return [];
  return ["tests"];
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error &&
        error.code === "ENOENT") return false;
    throw error;
  }
}

let imageManifestPromise: Promise<ReturnType<
  typeof summarizeEngineeringAgentImagePaths>> | null = null;
const runtimeImageManifest = () => {
  imageManifestPromise ??= listEngineeringAgentImagePaths("/app")
    .then(summarizeEngineeringAgentImagePaths);
  return imageManifestPromise;
};
const liveRuntime = { cwd: () => process.cwd(), exists,
  imageManifest: runtimeImageManifest };

/** An absent or malformed proof is T2, never a guessed exclusion. */
export async function readEngineeringAgentV22ImageExclusion(
  baseSha: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime: typeof liveRuntime = liveRuntime,
): Promise<{ excludedPrefixes: readonly string[];
  proofDigest: string | null }> {
  const refused = { excludedPrefixes: [], proofDigest: null } as const;
  if (runtime.cwd() !== "/app") return refused;
  const raw = env[ENGINEERING_AGENT_V22_IMAGE_PROOF_ENV];
  if (!raw || Buffer.byteLength(raw, "utf8") > 2_048) return refused;
  let proof: unknown;
  try { proof = JSON.parse(raw); }
  catch { return refused; }
  try {
    const [testsExist, adminPlaywrightConfigExists, runtimeManifest] =
      await Promise.all([
      runtime.exists("/app/tests"),
      runtime.exists("/app/playwright.admin.config.ts"),
      runtime.imageManifest(),
    ]);
    const excludedPrefixes = decideEngineeringAgentV22ImageExclusion({ proof, baseSha,
      runtimeSourceSha: env.RAILWAY_GIT_COMMIT_SHA,
      runtimeDeploymentId: env.RAILWAY_DEPLOYMENT_ID,
      runtimeManifest,
      testsExist, adminPlaywrightConfigExists });
    return excludedPrefixes.length === 0 ? refused : {
      excludedPrefixes,
      proofDigest: currentEngineeringAgentV22ImageProofDigest(env),
    };
  } catch { return refused; }
}
