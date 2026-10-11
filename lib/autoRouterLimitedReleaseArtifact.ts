import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

export const AUTO_ROUTER_LIMITED_RELEASE_ARTIFACT_VERSION =
  "auto-router-limited-release-artifact-v1";
export const AUTO_ROUTER_LIMITED_RELEASE_POLICY_PATH =
  "docs/policy/tomverse-chat-auto-router-limited-release-exception-v1.md";

const sources = Object.freeze([
  ["app/api/chat/route.ts", (root: string) =>
    readFileSync(resolve(root, "app", "api", "chat", "route.ts"))],
  ["lib/autoCohort.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoCohort.ts"))],
  ["lib/autoDrillOverride.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoDrillOverride.ts"))],
  ["lib/autoModelSelection.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoModelSelection.ts"))],
  ["lib/autoProductBoundary.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoProductBoundary.ts"))],
  ["lib/autoRolloutReadiness.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoRolloutReadiness.ts"))],
  ["lib/autoRouterLimitedRelease.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoRouterLimitedRelease.ts"))],
  ["lib/autoRouterLimitedReleaseArtifact.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoRouterLimitedReleaseArtifact.ts"))],
  ["lib/autoRoutingRuntimeReadback.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoRoutingRuntimeReadback.ts"))],
  ["lib/autoRoutingUi.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "autoRoutingUi.ts"))],
  ["lib/manifestHashKeyring.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "manifestHashKeyring.ts"))],
  ["lib/routingApplicationIdentity.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingApplicationIdentity.ts"))],
  ["lib/routingAttemptSequence.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingAttemptSequence.ts"))],
  ["lib/routingAttemptStore.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingAttemptStore.ts"))],
  ["lib/routingDispatchInstrumentation.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingDispatchInstrumentation.ts"))],
  ["lib/routingIdentityManifest.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingIdentityManifest.ts"))],
  ["lib/routingInstrumentationMode.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingInstrumentationMode.ts"))],
  ["lib/routingManifestContent.ts", (root: string) =>
    readFileSync(resolve(root, "lib", "routingManifestContent.ts"))],
] as const);

export type AutoRouterLimitedReleaseArtifactPath = typeof sources[number][0];

export const AUTO_ROUTER_LIMITED_RELEASE_ARTIFACT_PATHS:
  readonly AutoRouterLimitedReleaseArtifactPath[] = Object.freeze(
    sources.map(([path]) => path),
  );

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A stable digest of the exact runtime source boundary the operator reviewed.
 * Per-file byte lengths and digests make the envelope unambiguous without
 * ever retaining source text in the approval or runtime readback.
 */
export function autoRouterLimitedReleaseArtifactSha256(input: {
  root?: string;
  readFile?: (path: AutoRouterLimitedReleaseArtifactPath) => Uint8Array;
} = {}): string {
  const root = input.root ?? process.cwd();
  const files = sources.map(([path, read]) => {
    const bytes = input.readFile ? input.readFile(path) : read(root);
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  return createHash("sha256")
    .update(JSON.stringify({
      version: AUTO_ROUTER_LIMITED_RELEASE_ARTIFACT_VERSION,
      files,
    }), "utf8")
    .digest("hex");
}

/** Git and Linux serve this policy as UTF-8 with LF line endings. */
export function autoRouterLimitedReleasePolicySha256(input: {
  root?: string;
  readFile?: (path: typeof AUTO_ROUTER_LIMITED_RELEASE_POLICY_PATH) => Uint8Array;
} = {}): string {
  const root = input.root ?? process.cwd();
  const bytes = input.readFile
    ? input.readFile(AUTO_ROUTER_LIMITED_RELEASE_POLICY_PATH)
    : readFileSync(resolve(
        root,
        "docs",
        "policy",
        "tomverse-chat-auto-router-limited-release-exception-v1.md",
      ));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return createHash("sha256")
    .update(text.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
}

let runtimeResolved = false;
let runtimeDigest: string | null = null;
let runtimePolicyResolved = false;
let runtimePolicyDigest: string | null = null;

/** Fail-closed and process-stable: deployed source is immutable per process. */
export function runtimeAutoRouterLimitedReleaseArtifactSha256(): string | null {
  if (runtimeResolved) return runtimeDigest;
  runtimeResolved = true;
  try {
    runtimeDigest = autoRouterLimitedReleaseArtifactSha256();
  } catch {
    runtimeDigest = null;
  }
  return runtimeDigest;
}

export function runtimeAutoRouterLimitedReleasePolicySha256(): string | null {
  if (runtimePolicyResolved) return runtimePolicyDigest;
  runtimePolicyResolved = true;
  try {
    runtimePolicyDigest = autoRouterLimitedReleasePolicySha256();
  } catch {
    runtimePolicyDigest = null;
  }
  return runtimePolicyDigest;
}
