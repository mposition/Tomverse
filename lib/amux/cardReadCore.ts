import {
  BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM,
  BOARD_IMPORT_SECTION_CODES,
  boardImportStoredSnapshot,
} from "./boardImportCore.ts";

const SOURCE_KEY = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const SOURCE_SYSTEM = /^[a-z][a-z0-9._-]{0,63}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const AMUX_CARD_READ_MAX_DEPENDENCIES = 256;

export const parseAmuxCardSourceKey = (value: string | null): string | null =>
  value !== null && SOURCE_KEY.test(value) ? value : null;

export type AmuxCardReadRow = {
  id: string;
  status: string;
  priority: string;
  archivedAt: Date | null;
  sourceSystem: string | null;
  sourceKey: string | null;
  sourceVersion: string | null;
  sourceDigest: string | null;
  sourceSnapshot: unknown;
  acceptedSourceRevision: {
    id: string;
    workItemId: string;
    sourceVersion: string;
    detailDigest: string;
    sectionCode: string;
    state: string;
    observedAt: Date;
    decidedAt: Date | null;
  } | null;
  dependencies: Array<{
    dependency: {
      id: string;
      status: string;
      priority: string;
      archivedAt: Date | null;
      sourceSystem: string | null;
      sourceKey: string | null;
    };
  }>;
};

export type AmuxCardReadback = {
  sourceSystem: string;
  sourceKey: string;
  status: string;
  priority: string;
  archived: boolean;
  importSource: {
    sourceVersion: string;
    sourceDigest: string;
    snapshot: {
      representation: "metadata_only";
      sourceKey: string;
      sectionCode: string;
      detailDigest: string;
      manifestDigest: string;
      policyVersion: number;
    };
  };
  acceptedSourceRevision: {
    id: string;
    sourceVersion: string;
    detailDigest: string;
    sectionCode: string;
    state: "accepted";
    observedAt: string;
    decidedAt: string | null;
  };
  remainingGoal: {
    availability: "not_stored";
    representation: "detail_digest_only";
    sourceVersion: string;
    sectionCode: string;
    detailDigest: string;
  };
  dependencies: Array<{
    id: string;
    sourceSystem: string | null;
    sourceKey: string | null;
    status: string;
    priority: string;
    archived: boolean;
  }>;
};

export type AmuxCardReadResult =
  | { kind: "found"; card: AmuxCardReadback }
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "invalid_provenance" };

/**
 * Converts one canonical imported card to the bounded governance read model.
 * The import snapshot and accepted revision store metadata and a detail
 * digest, never the private work-item prose. `remainingGoal` therefore says
 * `not_stored`; an empty string or invented summary would overstate the data.
 */
export const amuxCardReadback = (
  row: AmuxCardReadRow,
  expectedSourceKey: string,
): AmuxCardReadback | null => {
  const snapshot = boardImportStoredSnapshot(row.sourceSnapshot);
  const accepted = row.acceptedSourceRevision;
  if (
    row.sourceKey !== expectedSourceKey ||
    row.sourceSystem !== BOARD_IMPORT_CANONICAL_SOURCE_SYSTEM ||
    row.sourceVersion === null ||
    !SOURCE_COMMIT.test(row.sourceVersion) ||
    row.sourceDigest === null ||
    !SHA256.test(row.sourceDigest) ||
    snapshot === null ||
    snapshot.sourceKey !== expectedSourceKey ||
    snapshot.detailDigest !== row.sourceDigest ||
    !SHA256.test(snapshot.detailDigest) ||
    !SHA256.test(snapshot.manifestDigest) ||
    !Number.isSafeInteger(snapshot.policyVersion) ||
    snapshot.policyVersion < 1 ||
    accepted === null ||
    accepted.workItemId !== row.id ||
    accepted.state !== "accepted" ||
    !SOURCE_COMMIT.test(accepted.sourceVersion) ||
    !(BOARD_IMPORT_SECTION_CODES as readonly string[]).includes(accepted.sectionCode) ||
    !SHA256.test(accepted.detailDigest) ||
    row.dependencies.length > AMUX_CARD_READ_MAX_DEPENDENCIES
  ) {
    return null;
  }

  const dependencies: AmuxCardReadback["dependencies"] = [];
  for (const { dependency } of row.dependencies) {
    const hasNoSourceIdentity =
      dependency.sourceSystem === null && dependency.sourceKey === null;
    const hasValidSourceIdentity =
      dependency.sourceSystem !== null &&
      SOURCE_SYSTEM.test(dependency.sourceSystem) &&
      dependency.sourceKey !== null &&
      SOURCE_KEY.test(dependency.sourceKey);
    if (!hasNoSourceIdentity && !hasValidSourceIdentity) return null;
    dependencies.push({
      id: dependency.id,
      sourceSystem: dependency.sourceSystem,
      sourceKey: dependency.sourceKey,
      status: dependency.status,
      priority: dependency.priority,
      archived: dependency.archivedAt !== null,
    });
  }
  dependencies
    .sort((left, right) => {
      const leftKey = `${left.sourceSystem ?? ""}\u0000${left.sourceKey ?? ""}\u0000${left.id}`;
      const rightKey = `${right.sourceSystem ?? ""}\u0000${right.sourceKey ?? ""}\u0000${right.id}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  return {
    sourceSystem: row.sourceSystem,
    sourceKey: row.sourceKey,
    status: row.status,
    priority: row.priority,
    archived: row.archivedAt !== null,
    importSource: {
      sourceVersion: row.sourceVersion,
      sourceDigest: row.sourceDigest,
      snapshot: {
        representation: "metadata_only",
        sourceKey: snapshot.sourceKey,
        sectionCode: snapshot.sectionCode,
        detailDigest: snapshot.detailDigest,
        manifestDigest: snapshot.manifestDigest,
        policyVersion: snapshot.policyVersion,
      },
    },
    acceptedSourceRevision: {
      id: accepted.id,
      sourceVersion: accepted.sourceVersion,
      detailDigest: accepted.detailDigest,
      sectionCode: accepted.sectionCode,
      state: "accepted",
      observedAt: accepted.observedAt.toISOString(),
      decidedAt: accepted.decidedAt?.toISOString() ?? null,
    },
    remainingGoal: {
      availability: "not_stored",
      representation: "detail_digest_only",
      sourceVersion: accepted.sourceVersion,
      sectionCode: accepted.sectionCode,
      detailDigest: accepted.detailDigest,
    },
    dependencies,
  };
};

/** The storage query is capped at two rows, which is enough to prove ambiguity. */
export const classifyAmuxCardReadRows = (
  rows: readonly AmuxCardReadRow[],
  sourceKey: string,
): AmuxCardReadResult => {
  if (rows.length === 0) return { kind: "missing" };
  if (rows.length !== 1) return { kind: "ambiguous" };
  const card = amuxCardReadback(rows[0]!, sourceKey);
  return card ? { kind: "found", card } : { kind: "invalid_provenance" };
};
