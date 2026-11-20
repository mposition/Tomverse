import { createHash } from "node:crypto";

import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  type AdminAuditHashInput,
  adminAuditEntryHashVariants,
} from "../adminAuditIntegrityCore.ts";

/**
 * What the AMUX board services still share from the catalog import.
 *
 * docs/policy/development-agent-orchestration.md (policy version 2).
 *
 * The one-time catalog import (preview, approve, apply, its route, service
 * and Admin panel) was consumed on 2026-09-23 and its code was removed on
 * 2026-11-18 (owner direction). What stays is the vocabulary the later board
 * services use: the section codes and scanner identity, the approval status
 * list the `AmuxBoardImportApproval` CHECK constraint pins, the closed card
 * snapshot reader, the catalog text scanner, `amux-json-v1` canonical JSON,
 * the error type and the small guards (content type, ambiguous database
 * failures, audit hash check, approval transition). Nothing here opens a
 * transaction, writes an audit row, or creates a card.
 *
 * The canonicalizer is `amux-json-v1`: object keys sort in JavaScript string
 * order, array order and string code points are preserved, and no Unicode
 * normalization is performed.
 */

export const AMUX_MANIFEST_CANONICALIZATION_VERSION = "amux-json-v1";
export const BOARD_IMPORT_SCANNER_VERSION = "amux-board-content-scan-v1";
/** Fixed source identity assigned by the canonical private-workboard manifest contract. */
export const BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM = "tomverse_private_workboard";
export const BOARD_IMPORT_MAX_ITEMS = 256;
export const BOARD_IMPORT_EXPIRY_MS = 15 * 60 * 1000;
export const BOARD_IMPORT_EXPIRE_BATCH = 20;
export const BOARD_IMPORT_STATEMENT_TIMEOUT = "15000";

export const BOARD_IMPORT_APPROVAL_STATUSES = [
  "prepared",
  "approved",
  "rejected",
  "expired",
  "consumed",
] as const;
export type BoardImportApprovalStatus = (typeof BOARD_IMPORT_APPROVAL_STATUSES)[number];

export const BOARD_IMPORT_SECTION_CODES = [
  "investment",
  "parallel_improvement",
  "security_operations",
  "platform_idea",
] as const;
export type BoardImportSectionCode = (typeof BOARD_IMPORT_SECTION_CODES)[number];

export const BOARD_IMPORT_SNAPSHOT_KEYS = [
  "detailDigest",
  "manifestDigest",
  "policyVersion",
  "sectionCode",
  "sourceKey",
] as const;

export const BOARD_IMPORT_AMBIGUOUS_PRISMA_CODES = [
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2028",
  "P2034",
] as const;

/**
 * Changing the scanner's refusals is a ruleset change. Update this text in
 * the same edit so the bound digest moves with the behavior.
 */
export const BOARD_IMPORT_SCANNER_RULESET = [
  "version:amux-board-content-scan-v1",
  "reject:nul,controls,url,filesystem-path,token-prefix,private-path,replacement-char",
  "reject:40-hex-and-64-hex-outside-designated-fields",
  "designated-digest:manifestDigest,boardDigest,sourceDigest,rawBodyDigest,scannerRulesetDigest,detailDigest",
  "designated-commit:commit,sourceCommit,sourceVersion",
  "forbidden-keys:title,sourceStateSummary,sourcePriorityLabel,detailPath,description,url,path,objectKey,content,prompt,secret,markdown,body,localPath,repoPath",
].join("\n");

export const BOARD_IMPORT_SCANNER_RULESET_DIGEST = createHash("sha256")
  .update(BOARD_IMPORT_SCANNER_RULESET, "utf8")
  .digest("hex");

const APPROVAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  prepared: ["approved", "rejected", "expired"],
  approved: ["consumed", "rejected", "expired"],
};

const FORBIDDEN_KEYS = new Set([
  "body",
  "content",
  "description",
  "detailPath",
  "localPath",
  "markdown",
  "objectKey",
  "path",
  "prompt",
  "repoPath",
  "secret",
  "sourcePriorityLabel",
  "sourceStateSummary",
  "title",
  "url",
]);

const DIGEST_KEYS = new Set([
  "boardDigest",
  "detailDigest",
  "manifestDigest",
  "rawBodyDigest",
  "scannerRulesetDigest",
  "sourceDigest",
]);

const COMMIT_KEYS = new Set(["commit", "sourceCommit", "sourceVersion"]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export class BoardImportError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly approvalId: string | null;

  constructor(code: string, httpStatus: number, approvalId: string | null = null) {
    super(code);
    this.name = "BoardImportError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.approvalId = approvalId;
  }
}

export type BoardImportSourceSnapshot = {
  sourceKey: string;
  sectionCode: BoardImportSectionCode;
  detailDigest: string;
  manifestDigest: string;
  policyVersion: number;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

export const boardImportTransitionAllowed = (from: string, to: string): boolean =>
  (APPROVAL_TRANSITIONS[from] ?? []).includes(to);

export const boardImportSameOperatorApproval = (preparerId: string, approverId: string): boolean =>
  preparerId.length > 0 && preparerId === approverId;

export const boardImportApplyPermitted = (input: {
  envValue: string | undefined;
  codeLatch: boolean;
}): boolean => input.codeLatch === true && input.envValue === "enabled";

export const boardImportAuditKeysPresent = (keyCount: number): boolean =>
  Number.isInteger(keyCount) && keyCount > 0;

export const boardImportFailureIsAmbiguous = (code: string | null | undefined): boolean =>
  code != null && (BOARD_IMPORT_AMBIGUOUS_PRISMA_CODES as readonly string[]).includes(code);

/** `application/json` only, with an optional UTF-8 charset. Any other media type is refused. */
export const boardImportContentTypeAccepted = (header: string | null): boolean => {
  if (!header) return false;
  const [mediaType, ...parameters] = header.split(";").map((part) => part.trim().toLowerCase());
  if (mediaType !== "application/json") return false;
  return parameters.every((parameter) => parameter === "charset=utf-8" || parameter === "charset=utf8");
};

/**
 * True only when a stored audit hash is the HMAC of these fields under one
 * configured key. A 64-hex string that no key reproduces does not match.
 */
export const boardImportAuditEntryHashMatches = (
  input: AdminAuditHashInput,
  entryHash: string,
  keys: readonly string[],
): boolean =>
  keys.some((key) => {
    const variants = adminAuditEntryHashVariants(input, key);
    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some((order) => variants[order] === entryHash);
  });

const sameKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const stringIsForbidden = (value: string, key: string | null): boolean => {
  if (value.includes("\uFFFD")) return true;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return true;
  if (/https?:\/\//i.test(value) || /\bwww\./i.test(value)) return true;
  if (/[A-Za-z]:\\/.test(value) || value.includes("\\\\") || value.includes("/")) return true;
  if (/\.git\//.test(value) || value.includes("tomverse-private-docs")) return true;
  if (/ghp_/.test(value) || /github_pat_/.test(value) || /AKIA[0-9A-Z]{16}/.test(value)) return true;
  if (/xox[baprs]-/.test(value) || /sk-[A-Za-z0-9]/.test(value) || /-----BEGIN /.test(value)) return true;
  if (key && DIGEST_KEYS.has(key)) return !SHA256_PATTERN.test(value);
  if (key && COMMIT_KEYS.has(key)) return !COMMIT_PATTERN.test(value);
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) return true;
  if (value.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return true;
  return false;
};

const contentRefused = (value: unknown, key: string | null): boolean => {
  if (typeof value === "string") return stringIsForbidden(value, key);
  if (Array.isArray(value)) return value.some((entry) => contentRefused(entry, key));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([childKey, child]) => FORBIDDEN_KEYS.has(childKey) || contentRefused(child, childKey),
    );
  }
  return false;
};

/** Catalog scanner, including nested digest-key exceptions. Promotion briefs use this. */
export const amuxCatalogTextRefused = (value: unknown): boolean => contentRefused(value, null);

/** `amux-json-v1` object-key sort. Array order and string code points stay as they are. */
export const amuxCanonicalJson = (value: unknown): string => canonicalJson(value);

const isSectionCode = (value: string): value is BoardImportSectionCode =>
  (BOARD_IMPORT_SECTION_CODES as readonly string[]).includes(value);

/** Closed snapshot read back from a card. Extra or missing fields are not a match. */
export const boardImportStoredSnapshot = (value: unknown): BoardImportSourceSnapshot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!sameKeys(record, BOARD_IMPORT_SNAPSHOT_KEYS)) return null;
  const sectionCode = record.sectionCode;
  if (
    typeof record.sourceKey !== "string" ||
    typeof sectionCode !== "string" ||
    !isSectionCode(sectionCode) ||
    typeof record.detailDigest !== "string" ||
    typeof record.manifestDigest !== "string" ||
    typeof record.policyVersion !== "number"
  ) {
    return null;
  }
  return {
    sourceKey: record.sourceKey,
    sectionCode,
    detailDigest: record.detailDigest,
    manifestDigest: record.manifestDigest,
    policyVersion: record.policyVersion,
  };
};
