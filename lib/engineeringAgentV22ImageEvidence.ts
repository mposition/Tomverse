import "server-only";

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { listEngineeringAgentImagePaths,
  summarizeEngineeringAgentImagePaths } from
  "@/scripts/report-engineering-agent-image-proof-core.mjs";

type Manifest = { completePathCount: number;
  completePathListSha256: string; testsPathCount: number };

const SHA256 = /^[0-9a-f]{64}$/;

/** The running image measures itself (owner decision 2026-10-27). An
 * operator-pasted proof bound to a deployment ID could never match: setting
 * the variable starts a new deployment. Only an image that really lacks the
 * test sources may leave them out of the runtime slice; whether the base
 * commit's build excludes them too is checked against that commit's own
 * `.dockerignore` in the base evidence. */
export function decideEngineeringAgentV22ImageExclusion(input: {
  cwd: string;
  runtimeManifest: Manifest;
  testsExist: boolean;
  adminPlaywrightConfigExists: boolean;
}): readonly string[] {
  const manifest = input.runtimeManifest;
  if (input.cwd !== "/app" ||
      !Number.isSafeInteger(manifest.completePathCount) ||
      manifest.completePathCount < 1 ||
      !SHA256.test(manifest.completePathListSha256) ||
      manifest.testsPathCount !== 0 ||
      input.testsExist || input.adminPlaywrightConfigExists)
    return [];
  return ["tests"];
}

/** The digest names the measured image, so a redeploy between the preflight
 * and the settlement transaction changes it and the patch is not published. */
export function engineeringAgentV22ImageEvidenceDigest(manifest: Manifest,
  env: Readonly<Record<string, string | undefined>>): string {
  return createHash("sha256").update(JSON.stringify({
    format: "engineering-agent-v22-live-image-v1",
    deploymentId: env.RAILWAY_DEPLOYMENT_ID ?? null,
    sourceCommit: env.RAILWAY_GIT_COMMIT_SHA ?? null,
    completePathCount: manifest.completePathCount,
    completePathListSha256: manifest.completePathListSha256,
    testsPathCount: manifest.testsPathCount,
  })).digest("hex");
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
  // A failed scan is not cached: the next read measures again.
  imageManifestPromise.catch(() => { imageManifestPromise = null; });
  return imageManifestPromise;
};
const liveRuntime = { cwd: () => process.cwd(), exists,
  imageManifest: runtimeImageManifest as () => Promise<Manifest> };

/** A failed measurement is T2, never a guessed exclusion. */
export async function readEngineeringAgentV22ImageExclusion(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime: typeof liveRuntime = liveRuntime,
): Promise<{ excludedPrefixes: readonly string[];
  proofDigest: string | null }> {
  const refused = { excludedPrefixes: [], proofDigest: null } as const;
  try {
    const cwd = runtime.cwd();
    if (cwd !== "/app") return refused;
    const [testsExist, adminPlaywrightConfigExists, runtimeManifest] =
      await Promise.all([
      runtime.exists("/app/tests"),
      runtime.exists("/app/playwright.admin.config.ts"),
      runtime.imageManifest(),
    ]);
    const excludedPrefixes = decideEngineeringAgentV22ImageExclusion({ cwd,
      runtimeManifest, testsExist, adminPlaywrightConfigExists });
    return excludedPrefixes.length === 0 ? refused : {
      excludedPrefixes,
      proofDigest: engineeringAgentV22ImageEvidenceDigest(runtimeManifest, env),
    };
  } catch { return refused; }
}

/** Transaction-time recheck: the image measured in the preflight must still
 * be the one this process runs. */
export async function currentEngineeringAgentV22ImageProofDigest(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runtime: typeof liveRuntime = liveRuntime,
): Promise<string | null> {
  return (await readEngineeringAgentV22ImageExclusion(env, runtime)).proofDigest;
}
