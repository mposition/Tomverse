import { isCanonicalRepoPath } from "@/lib/agentAuthorityFiles";
import { v22PatchBinaryPayloads } from "@/lib/amux/v22PatchBinary";
import { AMUX_V22_PATCH_MAX_BYTES } from "@/lib/amux/v22PatchLimit";
import { detectSecrets } from "@/lib/engineeringAgentSecretPatterns";
import { createHash } from "node:crypto";

export type V22PublishFile = { path: string; mode: "100644";
  bytesBase64: string };

/** The stored evidence, text or JSON: the one patch bound (owner decision
 * 2026-11-15; 64 KiB until then). */
const MAX_PATCH_BYTES = AMUX_V22_PATCH_MAX_BYTES;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function v22PublishFilesSha256(files: readonly V22PublishFile[]): string {
  // This digest binds the exact array the sidecar transferred, including
  // ordering. Ingress separately validates canonical fields and base64.
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

type V22PublishFileLimits = Readonly<{ maxFiles: number;
  maxFileBytes: number; maxTotalBytes: number }>;

/** File bytes a sidecar before 2026-11-15 stored beside the patch text (it
 * sent up to five, 48 KiB in all). Still accepted, so its settlement and the
 * rows it left keep their evidence, but bounded only as the evidence is: the
 * candidate rebuilds from the text and reads none of them. */
export const V22_STORED_FILE_LIMITS: V22PublishFileLimits = Object.freeze({
  maxFiles: Number.MAX_SAFE_INTEGER, maxFileBytes: MAX_PATCH_BYTES,
  maxTotalBytes: MAX_PATCH_BYTES });

/** Canonical paths and base64, UTF-8 text with no NUL and no secret. Throws
 * `invalid_patch_evidence`; returns copies of the checked fields. */
export function checkV22PublishFiles(files: readonly V22PublishFile[],
  limits: V22PublishFileLimits): V22PublishFile[] {
  if (files.length < 1 || files.length > limits.maxFiles)
    throw new Error("invalid_patch_evidence");
  const seen = new Set<string>();
  let aggregate = 0;
  const checked: V22PublishFile[] = [];
  for (const file of files) {
    if (!isCanonicalRepoPath(file.path) || seen.has(file.path) ||
        file.mode !== "100644" || !BASE64.test(file.bytesBase64))
      throw new Error("invalid_patch_evidence");
    seen.add(file.path);
    const bytes = Buffer.from(file.bytesBase64, "base64");
    try {
      if (bytes.toString("base64") !== file.bytesBase64 ||
          bytes.length < 1 || bytes.length > limits.maxFileBytes)
        throw new Error("invalid_patch_evidence");
      aggregate += bytes.length;
      if (aggregate > limits.maxTotalBytes)
        throw new Error("invalid_patch_evidence");
      const content = utf8.decode(bytes);
      if (content.includes("\0") || detectSecrets(content).length)
        throw new Error("invalid_patch_evidence");
      checked.push({ path: file.path, mode: "100644",
        bytesBase64: file.bytesBase64 });
    } finally { bytes.fill(0); }
  }
  return checked;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

/** A secret in the patch text, or inside a binary file it carries (whose
 * bytes are base85 text of deflated data, so the text shows none of them).
 * A binary section that cannot be read cannot be shown clean. */
function patchCarriesSecret(text: string): boolean {
  if (detectSecrets(text).length) return true;
  const payloads = v22PatchBinaryPayloads(text);
  if (payloads === null) return true;
  return payloads.some((payload) => {
    let content: string;
    try { content = utf8Strict.decode(payload); } catch { content = latin1.decode(payload); }
    return detectSecrets(content).length > 0;
  });
}

/** Sparse file evidence is never publication authority by itself. */
export function encodeV22PatchEvidence(text: string,
  files?: readonly V22PublishFile[]): Buffer {
  if (!text.startsWith("diff --git ") || patchCarriesSecret(text))
    throw new Error("invalid_patch_evidence");
  if (!files) {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length < 1 || bytes.length > MAX_PATCH_BYTES ||
        text.includes("\0")) throw new Error("invalid_patch_evidence");
    return bytes;
  }
  const checked = checkV22PublishFiles(files, V22_STORED_FILE_LIMITS);
  const encoded = Buffer.from(JSON.stringify({ version: 1, text,
    files: checked }), "utf8");
  if (encoded.length > MAX_PATCH_BYTES) {
    encoded.fill(0);
    throw new Error("invalid_patch_evidence");
  }
  return encoded;
}

export function decodeV22PatchEvidence(bytes: Buffer): {
  text: string; files: V22PublishFile[] | null } {
  const value = utf8.decode(bytes);
  if (value.startsWith("diff --git ")) return { text: value, files: null };
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new Error("invalid_patch_evidence");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_patch_evidence");
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1 || typeof row.text !== "string" ||
      !Array.isArray(row.files) || Object.keys(row).sort().join(",") !==
      "files,text,version") throw new Error("invalid_patch_evidence");
  const files = row.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("invalid_patch_evidence");
    const file = item as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "bytesBase64,mode,path" ||
        typeof file.path !== "string" || file.mode !== "100644" ||
        typeof file.bytesBase64 !== "string")
      throw new Error("invalid_patch_evidence");
    return file as V22PublishFile;
  });
  const canonical = encodeV22PatchEvidence(row.text, files);
  try {
    if (!canonical.equals(bytes)) throw new Error("invalid_patch_evidence");
  } finally { canonical.fill(0); }
  return { text: row.text, files };
}
