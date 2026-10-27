/**
 * The worker CLIs' own model names (owner decision 2026-10-27). Cursor and
 * Copilot are CLIs, not model providers: their names (`claude-opus-5-5-high`,
 * `kimi-k3`) need not be any Admin › Models entry's id or API model. The AMUX
 * host refreshes what each CLI lists (AmuxCliModel); the owner links a name to
 * the Admin › Models entry that prices it (AmuxCliModelLinkEvent, audited).
 *
 * Pure. Pricing reads the newest link of a name; with none, the name prices
 * from the entry whose id or API model is that exact name, as before. A link
 * to nothing holds the name rather than falling back to an exact match.
 */

import {
  AMUX_WORKER_PROVIDER_CLASSES,
  type AmuxWorkerProviderClass,
} from "./workerRegistryCore.ts";

/** The CLIs are the worker classes: a worker's class is the CLI it runs. */
export const AMUX_CLI_MODEL_CLIS = AMUX_WORKER_PROVIDER_CLASSES;
export type AmuxCliModelCli = AmuxWorkerProviderClass;

/** A CLI model name: the CLI usage receipt's grammar, so no colon. */
export const AMUX_CLI_MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const AMUX_CLI_MODEL_DISPLAY_NAME_MAX = 120;
export const AMUX_CLI_MODEL_REFRESH_MAX = 500;
export const AMUX_CLI_MODEL_PRICED_ID_MAX = 160;

export const AMUX_CLI_MODEL_LINK_AUDIT_ACTION = "amux.cli_model.link" as const;
export const AMUX_CLI_MODEL_LINK_AUDIT_TARGET_TYPE = "AmuxCliModelLinkEvent" as const;

export const isAmuxCliModelCli = (value: unknown): value is AmuxCliModelCli =>
  typeof value === "string" && (AMUX_CLI_MODEL_CLIS as readonly string[]).includes(value);
export const isAmuxCliModelName = (value: unknown): value is string =>
  typeof value === "string" && AMUX_CLI_MODEL_NAME_PATTERN.test(value);

/** Where a Claude or Codex worker's names come from when its CLI has not been read yet. */
const FALLBACK_VENDOR: Readonly<Partial<Record<AmuxCliModelCli, string>>> = Object.freeze({
  claude: "anthropic",
  codex: "openai",
});

// ---------------------------------------------------------------------------
// The host's refresh

export type AmuxCliModelRefresh = {
  cli: AmuxCliModelCli;
  models: Array<{ cliModel: string; displayName: string | null }>;
};

const cleanDisplayName = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  // One line of printable text; anything else is not a name to show.
  const trimmed = value.replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > AMUX_CLI_MODEL_DISPLAY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
};

/** What one CLI lists now, from untrusted input, or null. At least one name. */
export function parseAmuxCliModelRefresh(input: unknown): AmuxCliModelRefresh | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (!isAmuxCliModelCli(body.cli) || !Array.isArray(body.models)) return null;
  if (body.models.length < 1 || body.models.length > AMUX_CLI_MODEL_REFRESH_MAX) return null;
  const seen = new Set<string>();
  const models: AmuxCliModelRefresh["models"] = [];
  for (const entry of body.models) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { cliModel, displayName } = entry as Record<string, unknown>;
    if (!isAmuxCliModelName(cliModel) || seen.has(cliModel)) return null;
    const name = cleanDisplayName(displayName);
    if (name === undefined) return null;
    seen.add(cliModel);
    models.push({ cliModel, displayName: name });
  }
  return { cli: body.cli, models };
}

// ---------------------------------------------------------------------------
// Links and the price they lead to

export type AmuxCliModelLink = { cli: AmuxCliModelCli; cliModel: string; pricedModelId: string | null };

export const amuxCliModelKey = (cli: string, cliModel: string) => `${cli}\u0000${cliModel}`;

/** The newest link of each name, keyed by `amuxCliModelKey`. */
export type AmuxCliModelLinks = ReadonlyMap<string, string | null>;

export function amuxCliModelLinkMap(links: readonly AmuxCliModelLink[]): AmuxCliModelLinks {
  return new Map(links.map((link) => [amuxCliModelKey(link.cli, link.cliModel), link.pricedModelId]));
}

/**
 * Which Admin › Models entry a CLI model name prices from: an owner's link
 * (`pricedModelId` may be null: held), or none, when the exact name decides.
 */
export function amuxCliModelLinkFor(
  links: AmuxCliModelLinks,
  cli: string,
  cliModel: string,
): { linked: true; pricedModelId: string | null } | { linked: false } {
  const key = amuxCliModelKey(cli, cliModel);
  return links.has(key) ? { linked: true, pricedModelId: links.get(key) ?? null } : { linked: false };
}

/** An owner's link change, from untrusted input, or null. */
export function parseAmuxCliModelLinkChange(input: {
  cli: unknown;
  cliModel: unknown;
  pricedModelId: unknown;
}): AmuxCliModelLink | null {
  if (!isAmuxCliModelCli(input.cli) || !isAmuxCliModelName(input.cliModel)) return null;
  const priced = input.pricedModelId;
  if (priced !== null && (typeof priced !== "string" || priced.length < 1 ||
      priced.length > AMUX_CLI_MODEL_PRICED_ID_MAX)) {
    return null;
  }
  return { cli: input.cli, cliModel: input.cliModel, pricedModelId: priced };
}

export const AMUX_CLI_MODEL_LINK_REFUSALS = ["model_not_found", "no_change"] as const;
export type AmuxCliModelLinkRefusal = (typeof AMUX_CLI_MODEL_LINK_REFUSALS)[number];

// ---------------------------------------------------------------------------
// The Admin view

/** How a Tomverse model can be used now: Admin › Models' own words. */
export type AmuxTomverseModelAvailability = "available" | "disabled" | "retired";

export type AmuxTomverseModelSummary = {
  id: string;
  name: string;
  apiModel: string;
  provider: string;
  availability: AmuxTomverseModelAvailability;
  replacementModelId: string | null;
};

export function amuxTomverseModelAvailability(row: {
  catalogDeleted: boolean;
  enabled: boolean;
  status: string;
}): AmuxTomverseModelAvailability {
  if (row.catalogDeleted) return "retired";
  if (!row.enabled || row.status === "disabled" || row.status === "coming-soon") return "disabled";
  return "available";
}

export type AmuxCliModelAdminEntry = {
  cli: AmuxCliModelCli;
  cliModel: string;
  displayName: string | null;
  /** False when the CLI's last refresh no longer listed it; null when no refresh ever saw it. */
  listed: boolean | null;
  lastSeenAt: string | null;
  /** The owner's link; null when the exact name decides. */
  link: { pricedModelId: string | null } | null;
};

export type AmuxCliModelCatalogAdminView = {
  /** When each CLI was last read; null when never. */
  refreshedAt: Record<AmuxCliModelCli, string | null>;
  entries: AmuxCliModelAdminEntry[];
  models: AmuxTomverseModelSummary[];
};

/** One row per name the host saw or the owner linked, in CLI then name order. */
export function buildAmuxCliModelCatalogAdminView(input: {
  observed: ReadonlyArray<{ cli: string; cliModel: string; displayName: string | null; listed: boolean; lastSeenAt: string }>;
  links: readonly AmuxCliModelLink[];
  registry: ReadonlyArray<{
    id: string; name: string; apiModel: string; provider: string;
    catalogDeleted: boolean; enabled: boolean; status: string; replacementModelId: string | null;
  }>;
}): AmuxCliModelCatalogAdminView {
  const refreshedAt = Object.fromEntries(AMUX_CLI_MODEL_CLIS.map((cli) => [cli, null])) as
    Record<AmuxCliModelCli, string | null>;
  const entries = new Map<string, AmuxCliModelAdminEntry>();
  for (const row of input.observed) {
    if (!isAmuxCliModelCli(row.cli)) continue;
    const previous = refreshedAt[row.cli];
    if (row.listed && (previous === null || row.lastSeenAt > previous)) refreshedAt[row.cli] = row.lastSeenAt;
    entries.set(amuxCliModelKey(row.cli, row.cliModel), {
      cli: row.cli, cliModel: row.cliModel, displayName: row.displayName,
      listed: row.listed, lastSeenAt: row.lastSeenAt, link: null,
    });
  }
  for (const link of input.links) {
    const key = amuxCliModelKey(link.cli, link.cliModel);
    const entry = entries.get(key) ?? {
      cli: link.cli, cliModel: link.cliModel, displayName: null, listed: null, lastSeenAt: null, link: null,
    };
    entries.set(key, { ...entry, link: { pricedModelId: link.pricedModelId } });
  }
  const order = (cli: string) => (AMUX_CLI_MODEL_CLIS as readonly string[]).indexOf(cli);
  return {
    refreshedAt,
    entries: [...entries.values()].sort((a, b) =>
      order(a.cli) - order(b.cli) || a.cliModel.localeCompare(b.cliModel)),
    models: input.registry
      .map((row) => ({
        id: row.id, name: row.name, apiModel: row.apiModel, provider: row.provider,
        availability: amuxTomverseModelAvailability(row),
        replacementModelId: row.replacementModelId,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
  };
}

/** What a chip says about a CLI model name. */
export type AmuxCliModelIssue = "retired" | "disabled" | "unpriced" | "unlisted";

export type AmuxCliModelStatus = {
  issues: AmuxCliModelIssue[];
  /** The Tomverse model it prices from, or null. */
  priced: AmuxTomverseModelSummary | null;
  /** Admin › Models' named replacement of a retired or disabled model. */
  replacement: AmuxTomverseModelSummary | null;
  source: "link" | "exact" | "none";
};

/**
 * The state of one name a worker uses: the Tomverse model it prices from
 * (a link first, else the exact name, as the cost catalog decides), and what
 * is wrong with it. `unlisted` only once the CLI has been read at all.
 */
export function amuxCliModelStatus(
  view: AmuxCliModelCatalogAdminView,
  cli: string,
  cliModel: string,
): AmuxCliModelStatus {
  const entry = view.entries.find((row) => row.cli === cli && row.cliModel === cliModel) ?? null;
  const byId = (id: string | null) => (id === null ? null : view.models.find((model) => model.id === id) ?? null);
  let priced: AmuxTomverseModelSummary | null;
  let source: AmuxCliModelStatus["source"];
  if (entry?.link) {
    priced = byId(entry.link.pricedModelId);
    source = entry.link.pricedModelId === null ? "none" : "link";
  } else {
    // The cost catalog's rule: the id first, else an API model; a live entry wins.
    const exact = view.models.filter((model) => model.id === cliModel);
    const pool = exact.length > 0 ? exact : view.models.filter((model) => model.apiModel === cliModel);
    priced = pool.find((model) => model.availability !== "retired") ?? pool[0] ?? null;
    source = priced === null ? "none" : "exact";
  }
  const issues: AmuxCliModelIssue[] = [];
  if (priced === null) issues.push("unpriced");
  else if (priced.availability === "retired") issues.push("retired");
  else if (priced.availability === "disabled") issues.push("disabled");
  const refreshed = isAmuxCliModelCli(cli) && view.refreshedAt[cli] !== null;
  if (refreshed && entry?.listed !== true) issues.push("unlisted");
  const replacement = priced !== null && priced.availability !== "available" ? byId(priced.replacementModelId) : null;
  return { issues, priced, replacement, source };
}

export type AmuxCliModelOption = { value: string; label: string; issues: AmuxCliModelIssue[] };

/**
 * The names a worker of this CLI may be given: what the CLI lists now, or,
 * for Claude and Codex before their CLI is read, the usable Admin › Models
 * entries of their vendor by API model. The current value always stays, so
 * opening the editor never changes it.
 */
export function amuxCliModelOptions(
  view: AmuxCliModelCatalogAdminView,
  cli: AmuxCliModelCli,
  current: string,
): AmuxCliModelOption[] {
  const listed = view.entries.filter((entry) => entry.cli === cli && entry.listed === true);
  const vendor = FALLBACK_VENDOR[cli];
  const names: Array<{ value: string; label: string }> = listed.length > 0
    ? listed.map((entry) => ({ value: entry.cliModel, label: entry.displayName ?? entry.cliModel }))
    : vendor === undefined ? [] : view.models
      .filter((model) => model.provider === vendor && model.availability === "available")
      .map((model) => ({ value: model.apiModel, label: model.name }));
  const unique = new Map(names.map((name) => [name.value, name]));
  if (current.length > 0 && !unique.has(current)) unique.set(current, { value: current, label: current });
  return [...unique.values()]
    .map((name) => ({ ...name, issues: amuxCliModelStatus(view, cli, name.value).issues }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

// ---------------------------------------------------------------------------
// Parsing the route's body

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isStringOrNull = (value: unknown, max: number) =>
  value === null || (typeof value === "string" && value.length >= 1 && value.length <= max);
const AVAILABILITIES: readonly string[] = ["available", "disabled", "retired"];

/** The catalog route's GET body, or null when it is not exactly that shape. */
export function parseAmuxCliModelCatalogAdminView(body: unknown): AmuxCliModelCatalogAdminView | null {
  if (!isRecord(body) || !isRecord(body.refreshedAt) || !Array.isArray(body.entries) || !Array.isArray(body.models)) {
    return null;
  }
  const refreshedAt = {} as Record<AmuxCliModelCli, string | null>;
  for (const cli of AMUX_CLI_MODEL_CLIS) {
    const value = body.refreshedAt[cli];
    if (value !== null && !isIso(value)) return null;
    refreshedAt[cli] = value as string | null;
  }
  const entries: AmuxCliModelAdminEntry[] = [];
  for (const entry of body.entries) {
    if (!isRecord(entry) || !isAmuxCliModelCli(entry.cli) || !isAmuxCliModelName(entry.cliModel) ||
        !isStringOrNull(entry.displayName, AMUX_CLI_MODEL_DISPLAY_NAME_MAX) ||
        !(entry.listed === null || typeof entry.listed === "boolean") ||
        !(entry.lastSeenAt === null || isIso(entry.lastSeenAt))) {
      return null;
    }
    let link: AmuxCliModelAdminEntry["link"] = null;
    if (entry.link !== null) {
      if (!isRecord(entry.link) || !isStringOrNull(entry.link.pricedModelId, AMUX_CLI_MODEL_PRICED_ID_MAX)) return null;
      link = { pricedModelId: entry.link.pricedModelId as string | null };
    }
    entries.push({
      cli: entry.cli, cliModel: entry.cliModel, displayName: entry.displayName as string | null,
      listed: entry.listed as boolean | null, lastSeenAt: entry.lastSeenAt as string | null, link,
    });
  }
  const models: AmuxTomverseModelSummary[] = [];
  for (const model of body.models) {
    if (!isRecord(model) || typeof model.id !== "string" || typeof model.name !== "string" ||
        typeof model.apiModel !== "string" || typeof model.provider !== "string" ||
        typeof model.availability !== "string" || !AVAILABILITIES.includes(model.availability) ||
        !(model.replacementModelId === null || typeof model.replacementModelId === "string")) {
      return null;
    }
    models.push({
      id: model.id, name: model.name, apiModel: model.apiModel, provider: model.provider,
      availability: model.availability as AmuxTomverseModelAvailability,
      replacementModelId: model.replacementModelId as string | null,
    });
  }
  return { refreshedAt, entries, models };
}
