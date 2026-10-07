import "server-only";

import { lstat } from "node:fs/promises";

export const ENGINEERING_AGENT_V22_IMAGE_PROOF_ENV =
  "ENGINEERING_AGENT_V22_IMAGE_PROOF";

type Proof = {
  sourceCommit: string;
  deploymentId: string;
  imageDigest: string;
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

/** An absent or malformed proof is T2, never a guessed exclusion. */
export async function readEngineeringAgentV22ImageExclusion(
  baseSha: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly string[]> {
  if (process.cwd() !== "/app") return [];
  const raw = env[ENGINEERING_AGENT_V22_IMAGE_PROOF_ENV];
  if (!raw || Buffer.byteLength(raw, "utf8") > 2_048) return [];
  let proof: unknown;
  try { proof = JSON.parse(raw); }
  catch { return []; }
  try {
    const [testsExist, adminPlaywrightConfigExists] = await Promise.all([
      exists("/app/tests"),
      exists("/app/playwright.admin.config.ts"),
    ]);
    return decideEngineeringAgentV22ImageExclusion({ proof, baseSha,
      runtimeSourceSha: env.RAILWAY_GIT_COMMIT_SHA,
      runtimeDeploymentId: env.RAILWAY_DEPLOYMENT_ID,
      testsExist, adminPlaywrightConfigExists });
  } catch { return []; }
}
