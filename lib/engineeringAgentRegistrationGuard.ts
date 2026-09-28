/**
 * Registering cards into the AMUX backlog from our own backlog, develop CI and
 * dependabot failures.
 *
 * docs/policy/engineering-agent.md §2.2 is the contract. Registration is not
 * execution: a card is created in `backlog` only, and becomes work only when a
 * person promotes it. The model proposes; everything that decides -- which
 * items are even offered to it, whether a proposal names a real item at the
 * pinned commit, whether its text is safe to store, whether the caps allow it,
 * what priority the card gets -- is deterministic code here.
 *
 * Dependency-free apart from AMUX's own content scanner and intake limits, so
 * a proposal meets exactly the rules an operator's registration meets.
 */

import { createHash } from "node:crypto";

import { amuxCatalogTextRefused } from "./amux/boardImportCore.ts";
import { AMUX_INTAKE_TEXT_MAX_BYTES, AMUX_INTAKE_TITLE_MAX_BYTES } from "./amux/intakeCore.ts";
import { detectSecretsInFields } from "./engineeringAgentSecretPatterns.ts";

/* ------------------------------------------------------------------------- */
/* Sources and caps                                                           */
/* ------------------------------------------------------------------------- */

/**
 * The registration sources, and nothing else. Adding or changing one is a
 * revision of the policy, which the agent cannot make.
 */
export const REGISTRATION_SOURCES = {
  S1: {
    kind: "shared_backlog",
    branch: "codex/product-idea-backlog-2026-09-15",
    path: ".github/audits/tomverse-product-idea-backlog.md",
  },
  S2: { kind: "develop_ci_failure", branch: "develop" },
  S3: { kind: "dependabot_failure" },
} as const;
export type RegistrationSource = keyof typeof REGISTRATION_SOURCES;

/** The source ids as a list, for the database's CHECK to be compared against. */
export const REGISTRATION_SOURCE_IDS = Object.keys(REGISTRATION_SOURCES) as RegistrationSource[];

/** Fixed by the policy (§2.2); changing them is a revision. */
export const REGISTRATION_CAPS = {
  perRound: 3,
  perUtcDay: 10,
  unpromoted: 20,
} as const;

export const REGISTRAR_SYSTEM_ACTOR = "engineering-agent-registrar";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The identity a card carries back to its source, stable across revisions of the item. */
export const registrationSourceIdentity = (source: RegistrationSource, key: string) =>
  `engineering-agent:${source}:${key}`;

/* ------------------------------------------------------------------------- */
/* Items                                                                      */
/* ------------------------------------------------------------------------- */

export type RegistrationItem = {
  source: RegistrationSource;
  key: string;
  /** The status text the source gives the item, or empty. */
  statusText: string;
  /** SHA-256 of the item's text as it stands at the pinned revision, before any truncation. */
  digest: string;
  /** Read deterministically from the source; never from the model. */
  priority: "p0" | "p1" | "p2" | "p3" | null;
  /** The text offered to the model after truncation happens elsewhere. */
  text: string;
};

const ITEM_KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const PRIORITY = /\bP([0-3])\b/;

const splitRow = (line: string) => {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
};

const isSeparatorRow = (cells: string[]) =>
  cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));

const plain = (cell: string) => cell.replace(/\*\*/g, "").replace(/`/g, "").trim();

/**
 * The ID-table shapes the shared backlog uses, each with the column that
 * carries an item's status and priority. The list is closed: a table with an
 * `ID` column in any other shape is not read, and every key it names is
 * treated as ambiguous so it is never offered -- a column this does not know
 * might be the one that says "done". A shape with no status column at all is
 * known but unreadable for status, so its items are held back the same way.
 */
export const BACKLOG_TABLE_SCHEMAS: ReadonlyArray<{
  header: readonly string[];
  statusColumn: string | null;
}> = [
  { header: ["ID", "작업", "우선순위·상태", "다음 완료 단위"], statusColumn: "우선순위·상태" },
  { header: ["ID", "작업", "우선순위·상태", "원인과 다음 완료 단위"], statusColumn: "우선순위·상태" },
  { header: ["ID", "우선순위·상태", "다음 완료 단위·착수 조건"], statusColumn: "우선순위·상태" },
  { header: ["ID", "상태·분류", "다음 완료 단위"], statusColumn: "상태·분류" },
  { header: ["순서", "ID", "작업", "우선순위·다음 완료 단위"], statusColumn: "우선순위·다음 완료 단위" },
  { header: ["이번 제안 내 순서", "ID", "작업", "우선순위·다음 완료 단위"], statusColumn: "우선순위·다음 완료 단위" },
  { header: ["제안 내 배치", "ID", "작업", "우선순위·다음 완료 단위"], statusColumn: "우선순위·다음 완료 단위" },
  { header: ["투자 순위", "ID", "작업", "다음 완료 목표"], statusColumn: null },
];

const schemaFor = (header: readonly string[]) =>
  BACKLOG_TABLE_SCHEMAS.find(
    (schema) =>
      schema.header.length === header.length && schema.header.every((cell, i) => cell === header[i]),
  );

/**
 * Items of the shared backlog: the rows of its ID tables. An item named in more
 * than one row, in a table of unknown shape, or in a table without a status
 * column is ambiguous and never offered -- which row, and what status, would
 * the card be about?
 */
export const parseBacklogItems = (
  markdown: string,
): { items: RegistrationItem[]; ambiguousKeys: string[] } => {
  const rows = new Map<string, Array<{ row: string; status: string | null }>>();
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = splitRow(lines[i]).map(plain);
    if (!isSeparatorRow(splitRow(lines[i + 1]))) continue;
    const idColumn = header.indexOf("ID");
    if (idColumn === -1) continue;
    const schema = schemaFor(header);
    const statusColumn =
      schema === undefined || schema.statusColumn === null ? -1 : header.indexOf(schema.statusColumn);
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j += 1) {
      const cells = splitRow(lines[j]);
      const key = plain(cells[idColumn] ?? "").split(/\s+/)[0] ?? "";
      if (!ITEM_KEY.test(key)) continue;
      // `null` status: this row cannot say whether the item is done.
      const status = statusColumn === -1 ? null : (cells[statusColumn] ?? null);
      const list = rows.get(key) ?? [];
      list.push({ row: lines[j].trim(), status });
      rows.set(key, list);
    }
  }

  const items: RegistrationItem[] = [];
  const ambiguousKeys: string[] = [];
  for (const [key, found] of rows) {
    if (found.length !== 1 || found[0].status === null) {
      ambiguousKeys.push(key);
      continue;
    }
    const [{ row, status: knownStatus }] = found;
    const status = knownStatus as string;
    const priority = PRIORITY.exec(status);
    items.push({
      source: "S1",
      key,
      statusText: status,
      digest: sha256(row),
      priority: priority ? (`p${priority[1]}` as RegistrationItem["priority"]) : null,
      text: row,
    });
  }
  return { items, ambiguousKeys: ambiguousKeys.sort() };
};

/** A failing required check on develop's head, as one item per check name. */
export const ciFailureItem = (input: {
  checkName: string;
  headSha: string;
  conclusion: string;
}): RegistrationItem | null => {
  if (input.conclusion !== "failure" && input.conclusion !== "timed_out") return null;
  const key = `CI-${sha256(input.checkName).slice(0, 12).toUpperCase()}`;
  return {
    source: "S2",
    key,
    statusText: "",
    digest: sha256(JSON.stringify([input.checkName, input.headSha, input.conclusion])),
    priority: null,
    text: `${input.checkName} ${input.conclusion} at ${input.headSha}`,
  };
};

/** A dependabot PR whose checks fail, as one item per PR. The PR is never touched. */
export const dependabotFailureItem = (input: {
  prNumber: number;
  headSha: string;
  failingChecks: readonly string[];
}): RegistrationItem | null => {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) return null;
  if (input.failingChecks.length === 0) return null;
  const checks = [...input.failingChecks].sort();
  return {
    source: "S3",
    key: `DEPENDABOT-${input.prNumber}`,
    statusText: "",
    digest: sha256(JSON.stringify([input.prNumber, input.headSha, checks])),
    priority: null,
    text: `dependabot #${input.prNumber} at ${input.headSha}: ${checks.join(", ")}`,
  };
};

/* ------------------------------------------------------------------------- */
/* Deterministic pre-filter                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Status text that takes an item out of the offer: done, on hold, blocked,
 * operator-only, or waiting on a decision or approval. Erring towards
 * excluding is cheap -- an item left out is still in the backlog for a person.
 */
const EXCLUDED_STATUS =
  /완료(?!\s*(?:단위|조건|목표|기준))|보류|중지|중단|폐기|운영자\s*전용|대기|미승인|결정\s*필요|확정\s*필요|승인\s*(?:후|필요)|조건부|\bblocked\b|\bon hold\b|\bdone\b|\bpaused\b/i;

export type PrefilterReason =
  | "status_excluded"
  | "existing_card"
  | "already_proposed"
  | "ambiguous";

export const prefilterItems = (input: {
  items: readonly RegistrationItem[];
  ambiguousKeys: readonly string[];
  /** Source identities of every AMUX card, any revision, any status. */
  existingSourceIdentities: ReadonlySet<string>;
  /** Source identities this agent proposed that are still pending. */
  pendingSourceIdentities: ReadonlySet<string>;
}): {
  eligible: RegistrationItem[];
  excluded: Array<{ key: string; reason: PrefilterReason }>;
} => {
  const eligible: RegistrationItem[] = [];
  const excluded: Array<{ key: string; reason: PrefilterReason }> = input.ambiguousKeys.map(
    (key) => ({ key, reason: "ambiguous" as const }),
  );
  for (const item of input.items) {
    const identity = registrationSourceIdentity(item.source, item.key);
    if (EXCLUDED_STATUS.test(item.statusText)) excluded.push({ key: item.key, reason: "status_excluded" });
    else if (input.existingSourceIdentities.has(identity)) {
      excluded.push({ key: item.key, reason: "existing_card" });
    } else if (input.pendingSourceIdentities.has(identity)) {
      excluded.push({ key: item.key, reason: "already_proposed" });
    } else eligible.push(item);
  }
  return { eligible, excluded };
};

/* ------------------------------------------------------------------------- */
/* The guard                                                                  */
/* ------------------------------------------------------------------------- */

const PROPOSAL_KEYS = ["completion", "itemDigest", "itemKey", "scope", "source", "title"] as const;

export type RegistrationRefusal =
  | "schema_rejected"
  | "source_not_allowed"
  | "item_digest_mismatch"
  | "item_not_eligible"
  | "content_refused"
  | "control_character"
  | "path_separator_in_title"
  | "secret_detected"
  | "round_cap_reached"
  | "daily_cap_reached"
  | "unpromoted_cap_reached";

export type CardPlan = {
  status: "backlog";
  kind: "unknown";
  priority: "p0" | "p1" | "p2" | "p3";
  owner: null;
  claimedAt: null;
  executionBrief: null;
  sourceIdentity: string;
  itemDigest: string;
  proposalDigest: string;
  title: string;
  scope: string;
  completion: string;
  actor: typeof REGISTRAR_SYSTEM_ACTOR;
};

export type GuardVerdict =
  | { outcome: "register"; card: CardPlan }
  | { outcome: "refuse"; reason: RegistrationRefusal };

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const withinText = (value: string, maxBytes: number) =>
  byteLength(value) >= 1 && byteLength(value) <= maxBytes && !amuxCatalogTextRefused(value);

/** Control characters other than newline and tab. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/;

/**
 * The guard for one proposal. `eligible` is the pre-filter's output for the
 * same pinned revision, recomputed by the app -- never taken from the drafting
 * service. `counts` are read from the database in the same transaction that
 * will write the card, so the caps cannot be raced.
 */
export const guardRegistrationProposal = (input: {
  proposal: unknown;
  eligible: readonly RegistrationItem[];
  counts: { thisRound: number; todayUtc: number; unpromoted: number };
}): GuardVerdict => {
  const refuse = (reason: RegistrationRefusal): GuardVerdict => ({ outcome: "refuse", reason });
  const value = input.proposal;
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("schema_rejected");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PROPOSAL_KEYS.length || keys.some((key, i) => key !== PROPOSAL_KEYS[i])) {
    return refuse("schema_rejected");
  }
  const { source, itemKey, itemDigest, title, scope, completion } = record;
  if (
    typeof source !== "string" ||
    typeof itemKey !== "string" ||
    typeof itemDigest !== "string" ||
    typeof title !== "string" ||
    typeof scope !== "string" ||
    typeof completion !== "string"
  ) {
    return refuse("schema_rejected");
  }
  if (!Object.hasOwn(REGISTRATION_SOURCES, source)) return refuse("source_not_allowed");

  const item = input.eligible.find((candidate) => candidate.source === source && candidate.key === itemKey);
  if (item === undefined) return refuse("item_not_eligible");
  if (!/^[0-9a-f]{64}$/.test(itemDigest)) return refuse("schema_rejected");
  if (item.digest !== itemDigest) return refuse("item_digest_mismatch");

  for (const text of [title, scope, completion]) {
    if (CONTROL.test(text)) return refuse("control_character");
  }
  if (/[\\/]/.test(title)) return refuse("path_separator_in_title");
  if (!withinText(title, AMUX_INTAKE_TITLE_MAX_BYTES)) return refuse("content_refused");
  if (!withinText(scope, AMUX_INTAKE_TEXT_MAX_BYTES)) return refuse("content_refused");
  if (!withinText(completion, AMUX_INTAKE_TEXT_MAX_BYTES)) return refuse("content_refused");
  if (detectSecretsInFields({ title, scope, completion }).length > 0) return refuse("secret_detected");

  if (input.counts.thisRound >= REGISTRATION_CAPS.perRound) return refuse("round_cap_reached");
  if (input.counts.todayUtc >= REGISTRATION_CAPS.perUtcDay) return refuse("daily_cap_reached");
  if (input.counts.unpromoted >= REGISTRATION_CAPS.unpromoted) return refuse("unpromoted_cap_reached");

  const proposalDigest = sha256(
    JSON.stringify({ completion, itemDigest, itemKey, scope, source, title }),
  );
  return {
    outcome: "register",
    card: {
      status: "backlog",
      kind: "unknown",
      // The source's own priority if it states one; otherwise the lowest.
      priority: item.priority ?? "p3",
      owner: null,
      claimedAt: null,
      executionBrief: null,
      sourceIdentity: registrationSourceIdentity(item.source, item.key),
      itemDigest: item.digest,
      proposalDigest,
      title,
      scope,
      completion,
      actor: REGISTRAR_SYSTEM_ACTOR,
    },
  };
};
