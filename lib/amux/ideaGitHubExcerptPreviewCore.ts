import { createHash, createHmac } from "node:crypto";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import type { AmuxGitHubFileCandidateResult } from "./ideaGitHubFileCandidate.ts";
import {
  LOCAL_INTAKE_INPUT_MAX_BYTES,
  LOCAL_INTAKE_SCANNER_VERSION,
  scanLocalIntakeInput,
} from "./localIntakeCore.ts";

type Candidate = Extract<AmuxGitHubFileCandidateResult, { status: "unscanned_candidate" }>;

export type AmuxGitHubExcerptSelection = {
  candidate: Candidate;
  startByte: number;
  endByte: number;
};

export type AmuxGitHubExcerptPreviewSource = {
  repositoryId: number;
  refName: string;
  refObjectSha: string;
  refCommitSha: string;
  commitSha: string;
  path: string;
  blobSha: string;
  fileSha256: string;
  startByte: number;
  endByte: number;
  excerptText: string;
};

export type AmuxGitHubExcerptPreviewResult =
  | {
      status: "preview_candidate";
      previewDigest: string;
      scannerVersion: typeof LOCAL_INTAKE_SCANNER_VERSION;
      payloadBytes: number;
      model: string;
      sources: readonly AmuxGitHubExcerptPreviewSource[];
    }
  | { status: "hold" | "reject"; reason: string };

const MAX_SOURCES = 12;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODEL = /^[A-Za-z0-9._/-]{1,120}$/;
const SOURCE_PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const DOMAIN = "amux-v4-github-excerpt-preview-v1\n";

function gitBlobSha(bytes: Uint8Array, length: number): string {
  return createHash(length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}

/**
 * Builds a display-only candidate from collector-owned observations. This
 * provisional scanner is a conservative prefilter, not a sufficient live
 * privacy/secret gate. No caller may treat this result as a send approval.
 * The final route must use its own current source/scan/model/owner checks,
 * short-lived one-time confirmation and a fresh pre-send collection.
 */
export function prepareAmuxGitHubExcerptPreview(
  ideaText: string,
  model: string,
  selections: readonly AmuxGitHubExcerptSelection[],
  digestSecret: string,
): AmuxGitHubExcerptPreviewResult {
  const hold = (reason: string): AmuxGitHubExcerptPreviewResult => ({ status: "hold", reason });
  const reject = (reason: string): AmuxGitHubExcerptPreviewResult => ({ status: "reject", reason });
  try {
  if (typeof digestSecret !== "string" || Buffer.byteLength(digestSecret, "utf8") < 32 ||
      typeof model !== "string" || !MODEL.test(model)) return hold("preview_contract_unverified");
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > MAX_SOURCES) {
    return reject("invalid_excerpt_selection");
  }
  if (typeof ideaText !== "string") return reject("input_schema_rejected");
  if (Buffer.from(ideaText, "utf8").toString("utf8") !== ideaText) {
    return reject("invalid_utf8_input");
  }
  const ideaScan = scanLocalIntakeInput(ideaText);
  if (!ideaScan.ok) return reject(`input_${ideaScan.code}`);

  const sources: AmuxGitHubExcerptPreviewSource[] = [];
  const seen = new Map<string, { blobSha: string; sha256: string; ranges: Array<[number, number]> }>();
  for (const selection of selections) {
    const candidate = selection?.candidate;
    const file = candidate?.file;
    const witness = candidate?.witness;
    // A witness ref may point to a descendant of file.commitSha. Its ancestry
    // was established by collectAmuxGitHubFileCandidate; equality is not the
    // invariant. This display-only core cannot prove collector provenance.
    if (candidate?.status !== "unscanned_candidate" || file?.status !== "verified_file" ||
        !Number.isSafeInteger(file.repositoryId) || file.repositoryId <= 0 ||
        witness?.repositoryId !== file.repositoryId ||
        typeof witness.name !== "string" || witness.name.length > 512 ||
        !(witness.name.startsWith("refs/heads/") || witness.name.startsWith("refs/tags/")) ||
        /[\x00-\x1f\x7f]/.test(witness.name) ||
        !SHA.test(witness.refObjectSha) || !SHA.test(witness.refCommitSha) ||
        !SHA.test(file.commitSha) || !SHA.test(file.blobSha) ||
        witness.refCommitSha.length !== file.commitSha.length ||
        witness.refObjectSha.length !== file.commitSha.length ||
        file.blobSha.length !== file.commitSha.length ||
        !SHA256.test(file.sha256) || typeof file.path !== "string" ||
        file.path.split("/").some((part: string) => part === "." || part === "..") ||
        !SOURCE_PATH.test(file.path) ||
        typeof file.text !== "string") return hold("source_unverified");
    if (!Number.isSafeInteger(selection.startByte) || !Number.isSafeInteger(selection.endByte) ||
        selection.startByte < 0 || selection.endByte <= selection.startByte) {
      return reject("invalid_excerpt_selection");
    }
    const fullBytes = Buffer.from(file.text, "utf8");
    if (fullBytes.byteLength !== file.size ||
        createHash("sha256").update(fullBytes).digest("hex") !== file.sha256 ||
        gitBlobSha(fullBytes, file.blobSha.length) !== file.blobSha ||
        selection.endByte > fullBytes.byteLength) return hold("source_unverified");
    const excerptBytes = fullBytes.subarray(selection.startByte, selection.endByte);
    let excerptText: string;
    try {
      excerptText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(excerptBytes);
      if (!Buffer.from(excerptText, "utf8").equals(excerptBytes)) {
        return reject("invalid_utf8_boundary");
      }
    } catch {
      return reject("invalid_utf8_boundary");
    }
    const scan = scanLocalIntakeInput(excerptText);
    if (!scan.ok) return reject(`excerpt_${scan.code}`);
    const metadataScan = scanLocalIntakeInput(`${witness.name}\n${file.path}`);
    if (!metadataScan.ok) return reject(`metadata_${metadataScan.code}`);
    const source: AmuxGitHubExcerptPreviewSource = {
      repositoryId: file.repositoryId,
      refName: witness.name,
      refObjectSha: witness.refObjectSha,
      refCommitSha: witness.refCommitSha,
      commitSha: file.commitSha,
      path: file.path,
      blobSha: file.blobSha,
      fileSha256: file.sha256,
      startByte: selection.startByte,
      endByte: selection.endByte,
      excerptText,
    };
    const identity = `${source.repositoryId}:${source.commitSha}:${source.path}`;
    const prior = seen.get(identity);
    if (prior) {
      if (prior.blobSha !== source.blobSha || prior.sha256 !== source.fileSha256) {
        return hold("source_unverified");
      }
      if (prior.ranges.some(([start, end]) => source.startByte < end && start < source.endByte)) {
        return reject("duplicate_excerpt");
      }
      prior.ranges.push([source.startByte, source.endByte]);
    } else {
      seen.set(identity, {
        blobSha: source.blobSha, sha256: source.fileSha256,
        ranges: [[source.startByte, source.endByte]],
      });
    }
    sources.push(source);
  }

  const payload = { ideaText, model, scannerVersion: LOCAL_INTAKE_SCANNER_VERSION, sources };
  const canonicalPayload = amuxCanonicalJson(payload);
  const payloadBytes = Buffer.byteLength(canonicalPayload, "utf8");
  if (payloadBytes > LOCAL_INTAKE_INPUT_MAX_BYTES) return reject("chunk_input_too_large");
  const payloadScan = scanLocalIntakeInput(canonicalPayload);
  if (!payloadScan.ok) return reject(`payload_${payloadScan.code}`);
  const joinedTextScan = scanLocalIntakeInput(ideaText + sources.map((source) => source.excerptText).join(""));
  if (!joinedTextScan.ok) return reject(`combined_${joinedTextScan.code}`);
  return {
    status: "preview_candidate",
    previewDigest: createHmac("sha256", digestSecret)
      .update(DOMAIN, "utf8").update(canonicalPayload, "utf8").digest("hex"),
    scannerVersion: LOCAL_INTAKE_SCANNER_VERSION,
    payloadBytes,
    model,
    sources,
  };
  } catch {
    return hold("preview_unavailable");
  }
}
