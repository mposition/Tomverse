/**
 * Reviewer assignment. Pure: every input is passed in, nothing is read from
 * disk or the clock, so the ordering rules are pinned by tests rather than by
 * whatever the queue happened to look like.
 *
 * Independence is decided by model vendor, not by CLI. Cursor and Devin can
 * run Anthropic or OpenAI models, so a provider whose configured vendor is the
 * author's vendor is never eligible, whatever its name. A provider whose
 * vendor is unknown is never eligible either: it cannot be shown to differ.
 */

/** Authors whose vendor follows from the app itself. */
export const AUTHOR_VENDORS = Object.freeze({ claude: "anthropic", codex: "openai" });

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const isName = (value) => typeof value === "string" && NAME.test(value);

/**
 * The author's model vendor, or null when it cannot be known. A Cursor or
 * Devin author must state the vendor of the model it ran; guessing would let
 * a Claude-model Cursor session be reviewed by Claude.
 */
export function resolveAuthorVendor(author, authorVendor) {
  if (!isName(author)) return null;
  if (authorVendor !== undefined && authorVendor !== null && authorVendor !== "") {
    if (!isName(authorVendor) || authorVendor === "unknown") return null;
    const implied = AUTHOR_VENDORS[author];
    if (implied && implied !== authorVendor) return null;
    return authorVendor;
  }
  return AUTHOR_VENDORS[author] ?? null;
}

export function eligibleProviders(providers, authorVendor) {
  return providers.filter(
    (provider) =>
      provider.enabled === true &&
      isName(provider.vendor) &&
      provider.vendor !== "unknown" &&
      provider.vendor !== authorVendor,
  );
}

/** How many distinct vendors could review this author's work at all. */
export function independentVendorCount(providers, authorVendor) {
  return new Set(eligibleProviders(providers, authorVendor).map((provider) => provider.vendor)).size;
}

const loadOf = (load, id) => load[id] ?? { running: 0, recent24h: 0, lastAssignedAt: null };

/**
 * `priority` (default 0) is compared first: a provider with a higher number is
 * chosen only when no lower-numbered provider of an allowed vendor is free. A
 * provider billed per request from a credit pool -- Copilot on Kimi K3, about
 * 34 credits a review -- is a reserve: it takes the slot that would otherwise
 * wait for a busy vendor, and does not draw work just for being least used.
 */
const priorityOf = (provider) => provider.priority ?? 0;

const compareCandidates = (load) => (a, b) => {
  if (priorityOf(a) !== priorityOf(b)) return priorityOf(a) - priorityOf(b);
  const la = loadOf(load, a.id);
  const lb = loadOf(load, b.id);
  if (la.running !== lb.running) return la.running - lb.running;
  if (la.recent24h !== lb.recent24h) return la.recent24h - lb.recent24h;
  // Rotation: the provider that has waited longest goes next; never-used first.
  const ta = la.lastAssignedAt ?? -Infinity;
  const tb = lb.lastAssignedAt ?? -Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * One reviewer for one slot.
 *
 * - `impossible`: no enabled provider of an allowed vendor exists, so waiting
 *   will not help.
 * - `wait`: an allowed provider exists but every one is at its concurrency cap.
 * - `assign`: the least-loaded allowed provider.
 */
export function pickReviewer({ providers, authorVendor, excludeVendors = [], load, blockedProviders = new Set(), requestedProvider }) {
  const excluded = new Set([authorVendor, ...excludeVendors]);
  const allowed = eligibleProviders(providers, authorVendor).filter(
    (provider) => !excluded.has(provider.vendor) &&
      (requestedProvider === undefined || provider.id === requestedProvider),
  );
  if (allowed.length === 0) return { kind: "impossible" };
  const free = allowed.filter(
    (provider) => !blockedProviders.has(provider.id) &&
      loadOf(load, provider.id).running < (provider.maxConcurrent ?? 1),
  );
  if (free.length === 0) return { kind: "wait" };
  const [chosen] = [...free].sort(compareCandidates(load));
  return { kind: "assign", provider: chosen };
}

/**
 * Plan one scheduling pass. `jobs` are in submission order; each carries its
 * slots. A job that cannot be placed does not hold back the jobs behind it.
 * Returns the decisions; the caller applies them.
 */
export function planAssignments({ jobs, providers, load, now, blockedProviders = new Set() }) {
  const blocked = new Set(blockedProviders);
  const working = {};
  for (const provider of providers) working[provider.id] = { ...loadOf(load, provider.id) };
  const decisions = [];
  for (const { job, slots } of jobs) {
    const taken = slots.filter((slot) => slot.vendor).map((slot) => slot.vendor);
    // Reserve pinned vendors even while their slots wait, so an automatic
    // slot cannot take their vendor and make the requested slot impossible.
    const reserved = (job.reviewerProviders ?? []).map((id) => providers.find((p) => p.id === id)?.vendor).filter(Boolean);
    for (const slot of slots) {
      if (slot.status !== "queued") continue;
      const requestedProvider = job.reviewerProviders?.[slot.index];
      const pick = pickReviewer({
        providers,
        authorVendor: job.authorVendor,
        excludeVendors: requestedProvider === undefined ? [...taken, ...reserved] : taken,
        load: working,
        blockedProviders: blocked,
        requestedProvider,
      });
      if (pick.kind === "wait") continue;
      if (pick.kind === "impossible") {
        decisions.push({ kind: "impossible", jobId: job.id, slot: slot.index });
        continue;
      }
      const entry = working[pick.provider.id];
      entry.running += 1;
      entry.recent24h += 1;
      entry.lastAssignedAt = now;
      taken.push(pick.provider.vendor);
      // An operator-recorded balance is single-use evidence. A later pass can
      // start another review only after the account is measured again.
      if (pick.provider.quotaProbe === "manual") blocked.add(pick.provider.id);
      decisions.push({
        kind: "assign",
        jobId: job.id,
        slot: slot.index,
        provider: pick.provider.id,
        vendor: pick.provider.vendor,
      });
    }
  }
  return decisions;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-provider load derived from slot records. */
export function computeLoad(jobs, now) {
  const load = {};
  for (const { slots } of jobs) {
    for (const slot of slots) {
      if (!slot.provider || slot.assignedAt === undefined || slot.assignedAt === null) continue;
      const entry = (load[slot.provider] ??= { running: 0, recent24h: 0, lastAssignedAt: null });
      if (slot.status === "running") entry.running += 1;
      if (now - slot.assignedAt < DAY_MS) entry.recent24h += 1;
      if (entry.lastAssignedAt === null || slot.assignedAt > entry.lastAssignedAt) {
        entry.lastAssignedAt = slot.assignedAt;
      }
    }
  }
  return load;
}
