import { createHash } from "node:crypto";

import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  type AdminAuditHashInput,
  adminAuditEntryHashVariants,
} from "../adminAuditIntegrityCore.ts";

/**
 * Catalog-only AMUX board import.
 *
 * docs/policy/development-agent-orchestration.md (policy version 2).
 *
 * Preview and classification are pure. Nothing in this module opens a
 * transaction, writes an audit row, or creates a card. The service is the
 * only writer, and production apply stays off until both the environment
 * latch and `BOARD_IMPORT_APPLY_CODE_LATCH` are on. This constant ships false.
 *
 * The canonicalizer is `amux-json-v1`: object keys sort in JavaScript string
 * order, array order and string code points are preserved, and no Unicode
 * normalization is performed. The digest covers the manifest with
 * `manifestDigest` removed.
 */

export const AMUX_MANIFEST_CANONICALIZATION_VERSION = "amux-json-v1";
export const BOARD_IMPORT_POLICY_VERSION = 2;
export const BOARD_IMPORT_SCANNER_VERSION = "amux-board-content-scan-v1";
export const BOARD_IMPORT_SOURCE_VERIFICATION_MODE = "operator_attested";
export const BOARD_IMPORT_CARD_STATUS = "backlog";
export const BOARD_IMPORT_CARD_KIND = "unknown";
/** Schema default for every imported card. Not a mapping from an investment rank. */
export const BOARD_IMPORT_CARD_PRIORITY = "p3";
export const BOARD_IMPORT_RAW_BODY_MAX_BYTES = 1_048_576;
export const BOARD_IMPORT_MAX_ITEMS = 256;
export const BOARD_IMPORT_EXPIRY_MS = 15 * 60 * 1000;
export const BOARD_IMPORT_PREVIEW_LIMIT = 10;
export const BOARD_IMPORT_PREVIEW_WINDOW_MS = 60_000;
export const BOARD_IMPORT_EXPIRE_BATCH = 20;
export const BOARD_IMPORT_STATEMENT_TIMEOUT = "15000";
export const BOARD_IMPORT_APPLY_ENV = "TOMVERSE_AMUX_BOARD_IMPORT_APPLY";

/**
 * Second apply latch. One environment variable must not be enough to write
 * cards. The HTTP route passes this constant and never a literal `true`.
 */
export const BOARD_IMPORT_APPLY_CODE_LATCH = false;

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

const MANIFEST_KEYS = [
  "canonicalizationVersion",
  "items",
  "manifestDigest",
  "plannerVersion",
  "policyVersion",
  "scannerRulesetDigest",
  "scannerVersion",
  "source",
  "validatorVersion",
] as const;

const SOURCE_KEYS = [
  "activeItemCount",
  "boardDigest",
  "commit",
  "recommendationReferenceCount",
  "sectionCount",
  "verificationMode",
] as const;

const ITEM_KEYS = [
  "exclude",
  "executionBrief",
  "mode",
  "sectionCode",
  "sourceDigest",
  "sourceKey",
  "sourceSystem",
  "sourceVersion",
] as const;

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

const SOURCE_SYSTEM_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SOURCE_KEY_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const VERSION_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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

export type BoardImportItem = {
  sourceSystem: string;
  sourceKey: string;
  sourceVersion: string;
  sourceDigest: string;
  sectionCode: BoardImportSectionCode;
  executionBrief: null;
  mode: "catalog_only";
  exclude: boolean;
};

export type BoardImportManifest = {
  canonicalizationVersion: typeof AMUX_MANIFEST_CANONICALIZATION_VERSION;
  manifestDigest: string;
  policyVersion: typeof BOARD_IMPORT_POLICY_VERSION;
  scannerVersion: typeof BOARD_IMPORT_SCANNER_VERSION;
  scannerRulesetDigest: string;
  plannerVersion: string;
  validatorVersion: string;
  source: {
    commit: string;
    boardDigest: string;
    verificationMode: typeof BOARD_IMPORT_SOURCE_VERIFICATION_MODE;
    activeItemCount: number;
    sectionCount: number;
    recommendationReferenceCount: number;
  };
  items: BoardImportItem[];
};

export type BoardImportParseResult =
  | { ok: true; manifest: BoardImportManifest; rawBodyDigest: string }
  | { ok: false; code: string };

export type BoardImportSourceSnapshot = {
  sourceKey: string;
  sectionCode: BoardImportSectionCode;
  detailDigest: string;
  manifestDigest: string;
  policyVersion: number;
};

export type BoardImportExistingCard = {
  sourceSystem: string;
  sourceKey: string;
  sourceVersion: string;
  sourceDigest: string;
  sourceSnapshot: BoardImportSourceSnapshot | null;
  status: string;
  owner: string | null;
  claimedAt: string | null;
  attemptCount: number;
  deliveryCount: number;
  routeDecisionCount: number;
};

export type BoardImportClassification = {
  create: string[];
  noOp: string[];
  conflict: string[];
  exclude: string[];
};

export type BoardImportCardData = {
  title: string;
  description: null;
  status: typeof BOARD_IMPORT_CARD_STATUS;
  kind: typeof BOARD_IMPORT_CARD_KIND;
  priority: typeof BOARD_IMPORT_CARD_PRIORITY;
  owner: null;
  claimedAt: null;
  pinned: false;
  drag: 0;
  revision: 0;
  sourceSystem: string;
  sourceKey: string;
  sourceVersion: string;
  sourceDigest: string;
  sourceSnapshot: BoardImportSourceSnapshot;
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

export const canonicalAmuxManifest = (manifest: object): string => {
  const record = manifest as { canonicalizationVersion?: unknown };
  if (record.canonicalizationVersion !== AMUX_MANIFEST_CANONICALIZATION_VERSION) {
    throw new BoardImportError("schema_rejected", 400);
  }
  const jsonValue = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete jsonValue.manifestDigest;
  return canonicalJson(jsonValue);
};

export const digestAmuxManifest = (manifest: object): string =>
  createHash("sha256")
    .update(
      `amux-manifest:${AMUX_MANIFEST_CANONICALIZATION_VERSION}\n${canonicalAmuxManifest(manifest)}`,
      "utf8",
    )
    .digest("hex");

export const boardImportRawBodyDigest = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

export const boardImportPlaceholderTitle = (sourceSystem: string, sourceKey: string): string => {
  const digest = createHash("sha256")
    .update(`${sourceSystem}\n${sourceKey}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `card ${digest}`;
};

export const boardImportIdentityKey = (identity: {
  sourceSystem: string;
  sourceKey: string;
}): string => `${identity.sourceSystem}:${identity.sourceKey}`;

export const boardImportExpiresAt = (from: Date): Date =>
  new Date(from.getTime() + BOARD_IMPORT_EXPIRY_MS);

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
 * Per-account preview admission. Ten requests a minute is a product limit.
 * It is not a proof against denial of service: the map lives in one process
 * and does not coordinate across instances.
 */
export const admitBoardImportPreview = (
  timestamps: readonly number[],
  now: number,
): { allowed: boolean; retained: number[] } => {
  const retained = timestamps.filter(
    (timestamp) => timestamp <= now && now - timestamp < BOARD_IMPORT_PREVIEW_WINDOW_MS,
  );
  if (retained.length >= BOARD_IMPORT_PREVIEW_LIMIT) return { allowed: false, retained };
  return { allowed: true, retained: [...retained, now] };
};

/** Drops accounts whose preview window has emptied, so the process map does not keep them. */
export const pruneBoardImportPreviewHits = (
  entries: readonly (readonly [string, readonly number[]])[],
  now: number,
): Array<[string, number[]]> =>
  entries.flatMap(([userId, timestamps]) => {
    const retained = timestamps.filter(
      (timestamp) => timestamp <= now && now - timestamp < BOARD_IMPORT_PREVIEW_WINDOW_MS,
    );
    return retained.length === 0 ? [] : [[userId, retained]];
  });

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

const isSectionCode = (value: string): value is BoardImportSectionCode =>
  (BOARD_IMPORT_SECTION_CODES as readonly string[]).includes(value);

const parseItem = (
  value: unknown,
  commit: string,
): { ok: true; item: BoardImportItem } | { ok: false; code: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!sameKeys(value, ITEM_KEYS)) return { ok: false, code: "schema_rejected" };
  const item = value as Record<string, unknown>;
  if (item.executionBrief !== null) return { ok: false, code: "execution_brief_present" };
  if (item.mode !== "catalog_only") return { ok: false, code: "not_catalog_only" };
  if (typeof item.exclude !== "boolean") return { ok: false, code: "schema_rejected" };
  if (typeof item.sourceSystem !== "string" || !SOURCE_SYSTEM_PATTERN.test(item.sourceSystem)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (
    typeof item.sourceKey !== "string" ||
    !SOURCE_KEY_PATTERN.test(item.sourceKey) ||
    Buffer.byteLength(item.sourceKey, "utf8") > 64
  ) {
    return { ok: false, code: "schema_rejected" };
  }
  if (item.sourceVersion !== commit) return { ok: false, code: "schema_rejected" };
  if (typeof item.sourceDigest !== "string" || !SHA256_PATTERN.test(item.sourceDigest)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof item.sectionCode !== "string" || !isSectionCode(item.sectionCode)) {
    return { ok: false, code: "schema_rejected" };
  }
  return {
    ok: true,
    item: {
      sourceSystem: item.sourceSystem,
      sourceKey: item.sourceKey,
      sourceVersion: commit,
      sourceDigest: item.sourceDigest,
      sectionCode: item.sectionCode,
      executionBrief: null,
      mode: "catalog_only",
      exclude: item.exclude,
    },
  };
};

export const parseBoardImportManifest = (raw: string): BoardImportParseResult => {
  if (Buffer.byteLength(raw, "utf8") > BOARD_IMPORT_RAW_BODY_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  if (raw.includes("\u0000") || raw.includes("\uFFFD")) return { ok: false, code: "content_refused" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (contentRefused(parsed, null)) return { ok: false, code: "content_refused" };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!sameKeys(parsed, MANIFEST_KEYS)) return { ok: false, code: "schema_rejected" };
  const body = parsed as Record<string, unknown>;
  if (body.canonicalizationVersion !== AMUX_MANIFEST_CANONICALIZATION_VERSION) {
    return { ok: false, code: "schema_rejected" };
  }
  if (body.policyVersion !== BOARD_IMPORT_POLICY_VERSION) return { ok: false, code: "schema_rejected" };
  if (body.scannerVersion !== BOARD_IMPORT_SCANNER_VERSION) return { ok: false, code: "schema_rejected" };
  if (body.scannerRulesetDigest !== BOARD_IMPORT_SCANNER_RULESET_DIGEST) {
    return { ok: false, code: "scanner_mismatch" };
  }
  if (typeof body.plannerVersion !== "string" || !VERSION_TOKEN_PATTERN.test(body.plannerVersion)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof body.validatorVersion !== "string" || !VERSION_TOKEN_PATTERN.test(body.validatorVersion)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof body.manifestDigest !== "string" || !SHA256_PATTERN.test(body.manifestDigest)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!body.source || typeof body.source !== "object" || Array.isArray(body.source)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!sameKeys(body.source, SOURCE_KEYS)) return { ok: false, code: "schema_rejected" };
  const source = body.source as Record<string, unknown>;
  if (typeof source.commit !== "string" || !COMMIT_PATTERN.test(source.commit)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof source.boardDigest !== "string" || !SHA256_PATTERN.test(source.boardDigest)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (source.verificationMode !== BOARD_IMPORT_SOURCE_VERIFICATION_MODE) {
    return { ok: false, code: "source_verification_refused" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) return { ok: false, code: "empty_manifest" };
  if (body.items.length > BOARD_IMPORT_MAX_ITEMS) return { ok: false, code: "too_many_items" };
  const items: BoardImportItem[] = [];
  for (const entry of body.items) {
    const parsedItem = parseItem(entry, source.commit);
    if (!parsedItem.ok) return parsedItem;
    items.push(parsedItem.item);
  }
  const identities = new Set<string>();
  for (const item of items) {
    const key = boardImportIdentityKey(item);
    if (identities.has(key)) return { ok: false, code: "duplicate_source_identity" };
    identities.add(key);
  }
  const activeItemCount = items.filter((item) => !item.exclude).length;
  const sectionCount = new Set(items.map((item) => item.sectionCode)).size;
  if (source.activeItemCount !== activeItemCount) return { ok: false, code: "schema_rejected" };
  if (source.sectionCount !== sectionCount) return { ok: false, code: "schema_rejected" };
  if (
    typeof source.recommendationReferenceCount !== "number" ||
    !Number.isInteger(source.recommendationReferenceCount) ||
    source.recommendationReferenceCount < 0 ||
    source.recommendationReferenceCount > 10_000
  ) {
    return { ok: false, code: "schema_rejected" };
  }
  let expectedDigest: string;
  try {
    expectedDigest = digestAmuxManifest(body);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (expectedDigest !== body.manifestDigest) return { ok: false, code: "digest_mismatch" };
  return {
    ok: true,
    rawBodyDigest: boardImportRawBodyDigest(raw),
    manifest: {
      canonicalizationVersion: AMUX_MANIFEST_CANONICALIZATION_VERSION,
      manifestDigest: body.manifestDigest,
      policyVersion: BOARD_IMPORT_POLICY_VERSION,
      scannerVersion: BOARD_IMPORT_SCANNER_VERSION,
      scannerRulesetDigest: BOARD_IMPORT_SCANNER_RULESET_DIGEST,
      plannerVersion: body.plannerVersion,
      validatorVersion: body.validatorVersion,
      source: {
        commit: source.commit,
        boardDigest: source.boardDigest,
        verificationMode: BOARD_IMPORT_SOURCE_VERIFICATION_MODE,
        activeItemCount,
        sectionCount,
        recommendationReferenceCount: source.recommendationReferenceCount,
      },
      items,
    },
  };
};

const snapshotsMatch = (
  stored: BoardImportSourceSnapshot | null,
  expected: BoardImportSourceSnapshot,
): boolean =>
  stored !== null &&
  stored.sourceKey === expected.sourceKey &&
  stored.sectionCode === expected.sectionCode &&
  stored.detailDigest === expected.detailDigest &&
  stored.manifestDigest === expected.manifestDigest &&
  stored.policyVersion === expected.policyVersion;

const freshBacklogMatch = (
  item: BoardImportItem,
  card: BoardImportExistingCard,
  manifest: BoardImportManifest,
): boolean =>
  card.sourceDigest === item.sourceDigest &&
  card.sourceVersion === item.sourceVersion &&
  snapshotsMatch(card.sourceSnapshot, boardImportSourceSnapshot(item, manifest)) &&
  card.status === BOARD_IMPORT_CARD_STATUS &&
  card.owner === null &&
  card.claimedAt === null &&
  card.attemptCount === 0 &&
  card.deliveryCount === 0 &&
  card.routeDecisionCount === 0;

export const classifyBoardImport = (
  manifest: BoardImportManifest,
  existing: readonly BoardImportExistingCard[],
): BoardImportClassification => {
  const items = manifest.items;
  const existingByKey = new Map(existing.map((card) => [boardImportIdentityKey(card), card]));
  const create: string[] = [];
  const noOp: string[] = [];
  const conflict: string[] = [];
  const exclude: string[] = [];
  for (const item of items) {
    const key = boardImportIdentityKey(item);
    if (item.exclude) {
      exclude.push(key);
      continue;
    }
    const card = existingByKey.get(key);
    if (!card) {
      create.push(key);
      continue;
    }
    if (freshBacklogMatch(item, card, manifest)) noOp.push(key);
    else conflict.push(key);
  }
  return {
    create: create.sort(),
    noOp: noOp.sort(),
    conflict: conflict.sort(),
    exclude: exclude.sort(),
  };
};

/**
 * Cards of this catalog's source systems whose keys are absent from the
 * manifest. The report does not delete, archive, or refuse the import.
 * Cards of any other source system are ignored.
 */
export const boardImportSourceMissing = (
  manifest: BoardImportManifest,
  existing: readonly { sourceSystem: string; sourceKey: string }[],
): string[] => {
  const systems = new Set(manifest.items.map((item) => item.sourceSystem));
  const present = new Set(manifest.items.map((item) => boardImportIdentityKey(item)));
  const missing = new Set<string>();
  for (const card of existing) {
    if (!systems.has(card.sourceSystem)) continue;
    const key = boardImportIdentityKey(card);
    if (!present.has(key)) missing.add(key);
  }
  return [...missing].sort();
};

/** The bounded presence read. `take` is one past the cap so a full page can be told from a stopped scan. */
export const boardImportSourcePresenceQuery = (
  items: readonly { sourceSystem: string }[],
  cap: number,
) => {
  const systems = [...new Set(items.map((item) => item.sourceSystem))];
  if (systems.length === 0) return null;
  return {
    where: { sourceSystem: { in: systems }, sourceKey: { not: null } },
    select: { sourceSystem: true, sourceKey: true },
    orderBy: [{ sourceSystem: "asc" as const }, { sourceKey: "asc" as const }],
    take: cap + 1,
  };
};

export const boardImportSourcePresenceFromRows = (
  rows: readonly { sourceSystem: string | null; sourceKey: string | null }[],
  cap: number,
): { rows: { sourceSystem: string; sourceKey: string }[]; truncated: boolean } => ({
  truncated: rows.length > cap,
  rows: rows
    .flatMap((row) =>
      row.sourceSystem && row.sourceKey
        ? [{ sourceSystem: row.sourceSystem, sourceKey: row.sourceKey }]
        : [],
    )
    .slice(0, cap),
});

export const boardImportSubmissionRefusal = (
  classification: BoardImportClassification,
): string | null => {
  if (classification.exclude.length > 0) return "excluded_item";
  if (classification.conflict.length > 0) return "conflict";
  return null;
};

export const boardImportSourceSnapshot = (
  item: BoardImportItem,
  manifest: BoardImportManifest,
): BoardImportSourceSnapshot => ({
  sourceKey: item.sourceKey,
  sectionCode: item.sectionCode,
  detailDigest: item.sourceDigest,
  manifestDigest: manifest.manifestDigest,
  policyVersion: manifest.policyVersion,
});

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

export const boardImportCardData = (
  item: BoardImportItem,
  manifest: BoardImportManifest,
): BoardImportCardData => ({
  title: boardImportPlaceholderTitle(item.sourceSystem, item.sourceKey),
  description: null,
  status: BOARD_IMPORT_CARD_STATUS,
  kind: BOARD_IMPORT_CARD_KIND,
  priority: BOARD_IMPORT_CARD_PRIORITY,
  owner: null,
  claimedAt: null,
  pinned: false,
  drag: 0,
  revision: 0,
  sourceSystem: item.sourceSystem,
  sourceKey: item.sourceKey,
  sourceVersion: item.sourceVersion,
  sourceDigest: item.sourceDigest,
  sourceSnapshot: boardImportSourceSnapshot(item, manifest),
});

export const boardImportCardWrites = (
  manifest: BoardImportManifest,
  classification: BoardImportClassification,
): BoardImportCardData[] => {
  if (boardImportSubmissionRefusal(classification)) return [];
  const byKey = new Map(manifest.items.map((item) => [boardImportIdentityKey(item), item]));
  return classification.create.map((key) => {
    const item = byKey.get(key);
    if (!item) throw new BoardImportError("schema_rejected", 400);
    return boardImportCardData(item, manifest);
  });
};

export const boardImportExecutionBriefDigests = (manifest: BoardImportManifest) =>
  manifest.items.map((item) => ({
    sourceSystem: item.sourceSystem,
    sourceKey: item.sourceKey,
    executionBriefDigest: item.executionBrief,
  }));

export type BoardImportItemBinding = {
  sourceSystem: string;
  sourceKey: string;
  sourceVersion: string;
  sourceDigest: string;
  sectionCode: BoardImportSectionCode;
  exclude: boolean;
  executionBriefDigest: null;
};

/** Provenance needed to recreate a catalog card. Not a title, path or detail body. */
export const boardImportItemBindings = (manifest: BoardImportManifest): BoardImportItemBinding[] =>
  manifest.items.map((item) => ({
    sourceSystem: item.sourceSystem,
    sourceKey: item.sourceKey,
    sourceVersion: item.sourceVersion,
    sourceDigest: item.sourceDigest,
    sectionCode: item.sectionCode,
    exclude: item.exclude,
    executionBriefDigest: null,
  }));

export const boardImportItemBindingsDigest = (
  bindings: readonly BoardImportItemBinding[],
): string => createHash("sha256").update(canonicalJson(bindings), "utf8").digest("hex");

export const boardImportItemsFromBindings = (
  bindings: readonly BoardImportItemBinding[],
): BoardImportItem[] =>
  bindings.map((binding) => ({
    sourceSystem: binding.sourceSystem,
    sourceKey: binding.sourceKey,
    sourceVersion: binding.sourceVersion,
    sourceDigest: binding.sourceDigest,
    sectionCode: binding.sectionCode,
    executionBrief: null,
    mode: "catalog_only",
    exclude: binding.exclude,
  }));

export const parseBoardImportItemBindings = (value: unknown): BoardImportItemBinding[] | null => {
  if (!Array.isArray(value)) return null;
  const bindings: BoardImportItemBinding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (
      !sameKeys(entry, [
        "exclude",
        "executionBriefDigest",
        "sectionCode",
        "sourceDigest",
        "sourceKey",
        "sourceSystem",
        "sourceVersion",
      ])
    ) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.sourceSystem !== "string" ||
      !SOURCE_SYSTEM_PATTERN.test(record.sourceSystem) ||
      typeof record.sourceKey !== "string" ||
      !SOURCE_KEY_PATTERN.test(record.sourceKey) ||
      typeof record.sourceVersion !== "string" ||
      !COMMIT_PATTERN.test(record.sourceVersion) ||
      typeof record.sourceDigest !== "string" ||
      !SHA256_PATTERN.test(record.sourceDigest) ||
      typeof record.sectionCode !== "string" ||
      !isSectionCode(record.sectionCode) ||
      typeof record.exclude !== "boolean" ||
      record.executionBriefDigest !== null
    ) {
      return null;
    }
    bindings.push({
      sourceSystem: record.sourceSystem,
      sourceKey: record.sourceKey,
      sourceVersion: record.sourceVersion,
      sourceDigest: record.sourceDigest,
      sectionCode: record.sectionCode,
      exclude: record.exclude,
      executionBriefDigest: null,
    });
  }
  return bindings;
};

export const boardImportClassificationSetsEqual = (
  left: BoardImportClassification,
  right: BoardImportClassification,
): boolean =>
  (["create", "noOp", "conflict", "exclude"] as const).every(
    (name) => left[name].join("\n") === right[name].join("\n"),
  );
