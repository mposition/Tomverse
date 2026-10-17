import { posix } from "node:path";

import {
  AMUX_V19_READ_MANIFEST_RECORDED_ACTION,
  AMUX_V19_READ_MANIFEST_RECORDED_SCOPE,
  AMUX_V19_READ_MANIFEST_RECORDED_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "../adminAuditSystemActors.ts";

export { AMUX_V19_READ_MANIFEST_RECORDED_ACTION,
  AMUX_V19_READ_MANIFEST_RECORDED_SCOPE,
  AMUX_V19_READ_MANIFEST_RECORDED_TARGET };
export const AMUX_V19_READ_MANIFEST_AUDIT_ACTOR = AMUX_V4_IDEA_SYSTEM_ACTOR;
export const AMUX_V19_READ_MANIFEST_AUDIT_SUMMARY =
  "Recorded one encrypted AMUX v19 CLI read manifest.";

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validReadPath = (file: unknown): file is string =>
  typeof file === "string" && file.length > 0 &&
  !file.startsWith("/") && !file.includes("\\") &&
  !/[\x00-\x1f\x7f]/.test(file) && posix.normalize(file) === file &&
  file.split("/").every((part) => !!part && part !== "." && part !== ".." &&
    part.toLowerCase() !== ".git");

function inspectReadPaths(files: unknown): string[] | null {
  if (!Array.isArray(files)) return null;
  const seen = new Set<string>();
  for (const file of files) {
    if (!validReadPath(file) || seen.has(file)) return null;
    seen.add(file);
  }
  return [...seen].sort();
}

export type AmuxTrackedCheckoutVerifiedReadInput = {
  manifestId: string;
  ideaId: string;
  referenceOrdinal: number;
  pinnedCommitSha: string;
  observed: { kind: "verified_success"; readFiles: string[] };
};

export type ValidAmuxTrackedCheckoutReadManifest = Readonly<{
  manifestId: string;
  ideaId: string;
  referenceOrdinal: number;
  pinnedCommitSha: string;
  files: readonly string[];
  plaintext: Buffer;
}>;

/** Only a completed verified host observation may become a stored manifest.
 * Keep paths in the encrypted payload, never in an audit event or error. */
export function inspectAmuxTrackedCheckoutReadManifest(
  input: AmuxTrackedCheckoutVerifiedReadInput,
): ValidAmuxTrackedCheckoutReadManifest | null {
  if (!input || !UUID_V4.test(input.manifestId) ||
      !UUID_V4.test(input.ideaId) ||
      !Number.isSafeInteger(input.referenceOrdinal) || input.referenceOrdinal < 0 ||
      !FULL_SHA.test(input.pinnedCommitSha) ||
      input.observed?.kind !== "verified_success") return null;
  const canonical = inspectReadPaths(input.observed.readFiles);
  if (!canonical) return null;
  return Object.freeze({ manifestId: input.manifestId, ideaId: input.ideaId,
    referenceOrdinal: input.referenceOrdinal, pinnedCommitSha: input.pinnedCommitSha,
    files: Object.freeze(canonical),
    plaintext: Buffer.from(JSON.stringify({ version: 1, files: canonical }), "utf8") });
}

export function amuxTrackedCheckoutReadManifestAuditMetadata(
  input: ValidAmuxTrackedCheckoutReadManifest,
  digest: string,
  digestKeyId: string,
) {
  return Object.freeze({ policyVersion: 19, manifestId: input.manifestId,
    ideaId: input.ideaId, referenceOrdinal: input.referenceOrdinal,
    pinnedCommitSha: input.pinnedCommitSha, fileCount: input.files.length,
    digest, digestKeyId });
}

export function parseAmuxTrackedCheckoutReadManifest(
  plain: Buffer, expectedCount: number,
): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(plain.toString("utf8")); }
  catch { throw new Error("invalid_read_manifest"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "files,version" ||
      (parsed as { version?: unknown }).version !== 1) throw new Error("invalid_read_manifest");
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length !== expectedCount) {
    throw new Error("invalid_read_manifest");
  }
  const checked = inspectReadPaths(files);
  if (!checked || checked.some((file, index) => file !== files[index])) {
    throw new Error("invalid_read_manifest");
  }
  return files;
}
