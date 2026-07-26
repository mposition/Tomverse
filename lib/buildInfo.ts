import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Single source of truth for "what is actually running right now" (STG-F010).
// commitSha/environment/deploymentId are read live from process.env at call
// time, matching the existing sentry.server.config.ts / sentry.edge.config.ts
// precedent (`process.env.RAILWAY_GIT_COMMIT_SHA`) and Next.js's own
// documented "runtime environment variables" pattern -- these values are
// fixed for the lifetime of a Railway deployment, so reading them per-call
// is not the same as recomputing them; it never changes without a new
// deploy. builtAt is the one value Railway does not expose anywhere, so it
// is captured once at build time by scripts/generate-build-info.mjs and
// read here from its output file -- never computed at request time.

export const BUILD_ENVIRONMENTS = [
  "development",
  "staging",
  "production",
  "test",
] as const;

export type BuildEnvironment = (typeof BUILD_ENVIRONMENTS)[number];

export type PublicBuildInfo = {
  environment: BuildEnvironment;
  commitSha: string | null;
  shortCommitSha: string | null;
  builtAt: string | null;
  // No Railway-provided signal distinguishes "built" from "deployed" (build
  // and deploy are one atomic step, with no separate promotion timestamp
  // exposed) -- this stays null rather than being faked from build time or
  // server-process-start time, per this feature's explicit anti-fabrication
  // requirement. RAILWAY_DEPLOYMENT_ID already distinguishes redeploys of
  // an unchanged commit on its own.
  deployedAt: null;
  deploymentId: string | null;
};

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const SHORT_SHA_LENGTH = 7;

type GeneratedBuildInfo = {
  buildTimestamp?: unknown;
  gitCommitShaFallback?: unknown;
};

const readGeneratedBuildInfo = (): GeneratedBuildInfo => {
  try {
    const raw = readFileSync(
      join(process.cwd(), "lib", "generated", "build-info.generated.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing in a fresh checkout before the first `npm run build`/`dev` --
    // every public field just falls back to null/unknown, never a crash.
    return {};
  }
};

export function validateCommitSha(value: unknown): string | null {
  return typeof value === "string" && SHA_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

export function formatShortCommitSha(sha: string | null): string | null {
  return sha ? sha.slice(0, SHORT_SHA_LENGTH) : null;
}

export function validateIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function validateEnvironment(value: unknown): BuildEnvironment | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (BUILD_ENVIRONMENTS as readonly string[]).includes(normalized)
    ? (normalized as BuildEnvironment)
    : null;
}

const resolveEnvironment = (): BuildEnvironment => {
  const explicit = validateEnvironment(process.env.APP_ENV);
  if (explicit) return explicit;

  const railway = validateEnvironment(process.env.RAILWAY_ENVIRONMENT_NAME);
  if (railway) return railway;

  return process.env.NODE_ENV === "production" ? "production" : "development";
};

export function getPublicBuildInfo(): PublicBuildInfo {
  const generated = readGeneratedBuildInfo();

  const commitSha =
    validateCommitSha(process.env.RAILWAY_GIT_COMMIT_SHA) ||
    validateCommitSha(generated.gitCommitShaFallback) ||
    null;

  return {
    environment: resolveEnvironment(),
    commitSha,
    shortCommitSha: formatShortCommitSha(commitSha),
    builtAt: validateIsoTimestamp(generated.buildTimestamp),
    deployedAt: null,
    deploymentId:
      typeof process.env.RAILWAY_DEPLOYMENT_ID === "string" &&
      process.env.RAILWAY_DEPLOYMENT_ID.trim()
        ? process.env.RAILWAY_DEPLOYMENT_ID.trim()
        : null,
  };
}
