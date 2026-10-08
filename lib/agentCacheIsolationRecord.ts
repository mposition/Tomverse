/**
 * The dated record docs/policy/engineering-agent.md §5 names as the only way to
 * lift its cache rule, and the signature that makes it count.
 *
 * §5's cache rule forbids every agent change while a credentialed job restores
 * an Actions cache, and says the one way to lift that assumption is "a dated
 * confirmation of the cache's cross-ref sharing scope, pinned in the analyser's
 * configuration". This file is that configuration. It is drafted here with its
 * three directions and their bases filled in; `approvedBy` and `approvedAt` are
 * empty, and while they are empty the record lifts nothing.
 *
 * Signing it widens what the agent may push, so the signature is the owner's
 * act (§5, §7). Nothing here decides it: `cacheIsolationRecordSignature()` only
 * reports whether the record is signed and well-formed, and the caller must
 * still establish, from the workflows in front of it, that the third
 * direction's condition holds right now
 * (`npm run check:agent-pr-cache-isolation`, §5.2).
 *
 * This file names no workflow and no job. §16 keeps the list of unresolved
 * reachability targets out of this repository, so the record carries counts.
 */

/** The three directions §5 requires the record to establish, each on its own. */
export type CacheIsolationDirectionName =
  | "pull_request_to_other_ref"
  | "default_or_base_to_pull_request"
  | "within_the_same_pull_request";

export type CacheIsolationDirection = {
  direction: CacheIsolationDirectionName;
  /** Whether a cache entry can travel this way. */
  open: boolean;
  /** What was established, in one sentence. */
  finding: string;
  /** What it rests on. Never "Actions caches are isolated between refs". */
  basis: string;
};

export type CacheIsolationRecord = {
  /** The commit the counts in direction three were measured at. */
  verifiedAtCommit: string;
  /** The UTC day they were measured on. */
  verifiedOn: string;
  directions: readonly CacheIsolationDirection[];
  /**
   * The owner, and when they signed. Empty until then, and empty means the
   * record lifts nothing.
   */
  approvedBy: string;
  approvedAt: string;
};

/**
 * What each direction must say about itself, independent of who wrote the
 * record. A signed record that mis-states a direction does not count: these are
 * facts about GitHub's cache scoping, not fields for the signer to choose.
 *
 * Direction two is `open` on purpose. §5 is explicit that writing "Actions
 * caches are isolated between refs" is false, and that this direction is a
 * different threat with a different control -- `npm run check:ci-cache-keys`,
 * which refuses a cache written from a run that can land on main or develop.
 */
export const CACHE_ISOLATION_DIRECTION_FACTS: Readonly<Record<CacheIsolationDirectionName, boolean>> = {
  pull_request_to_other_ref: false,
  default_or_base_to_pull_request: true,
  within_the_same_pull_request: true,
};

export const CACHE_ISOLATION_RECORD: CacheIsolationRecord = {
  verifiedAtCommit: "f2d1c2b67a0f1470a2baadb08dcca869893c10dc",
  verifiedOn: "2026-10-04",
  directions: [
    {
      direction: "pull_request_to_other_ref",
      open: false,
      finding:
        "A cache entry a pull_request run writes is created in that pull request's own scope, and only runs of " +
        "that same pull request can restore it. No run on another ref reaches it.",
      basis:
        "GitHub's documented cache scope rule. This is the direction that answers the question §5's cache rule " +
        "asks, because the only cache the agent can plant is the one its own pull request writes.",
    },
    {
      direction: "default_or_base_to_pull_request",
      open: true,
      finding:
        "An entry written while a run is on the default branch is restorable by every run that can see that " +
        "scope, and one written on a base branch by every pull request opened against it.",
      basis:
        "The same rule read the other way. The subject here is not the agent, so this is a different threat from " +
        "the one §5's cache rule addresses, and isolation is not available as a basis for it. It is held instead " +
        "by npm run check:ci-cache-keys, which refuses a cache written from a run that can land on main or " +
        "develop and requires every workflow that can run there to declare a read-only cache mode.",
    },
    {
      direction: "within_the_same_pull_request",
      open: true,
      finding:
        "Re-runs of a pull request can restore that pull request's own entries, so isolation cannot answer for " +
        "this direction. What answers it is that no credentialed job which can run on the agent's own pull " +
        "request restores any Actions cache.",
      basis:
        "npm run check:agent-pr-cache-isolation, in PR Fast Gate's static stage (§5.2). It asks whether any " +
        "credentialed job, in a workflow an event the agent raises reaches, restores any cache -- the verified " +
        "package-manager cache included, because the agent can change package-lock.json in the same pull " +
        "request and the lockfile comparison then agrees with whatever it put there. It reads no job condition, " +
        "so the condition is held as a fact rather than as an exemption. At the commit above: 5 credentialed " +
        "jobs across the 8 workflows those events reach, none restoring any cache, with 10 credentialed jobs " +
        "restoring one in workflows those events do not reach, which §5 forbids all the same.",
    },
  ],
  // The owner's act. Filling both fields is what lifts §5's cache rule; see the
  // header. Leave them empty to change nothing.
  approvedBy: "mposition",
  approvedAt: "2026-10-04T03:32:28Z",
};

export type CacheIsolationSignature = {
  /** Whether this record is signed and well-formed enough to lift §5's rule. */
  signed: boolean;
  /** Why it is not, when it is not. Stable strings, no names. */
  problems: string[];
};

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const UTC_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Whether a UTC day exists in the calendar, rather than merely looking like
 * one. `2026-99-99` matches the shape and is not a date, and the owner types
 * these two fields by hand, so the shape is not enough for a record whose whole
 * claim is that it is dated.
 */
const isRealUtcDay = (value: string): boolean => {
  const parts = UTC_DAY.exec(value);
  if (parts === null) return false;
  const [, year, month, day] = parts;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-tripping is what rejects a day the month does not have: Date would
  // otherwise be free to carry 2026-02-30 over into March.
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
};

/** The same question for an instant, including the hour, minute and second. */
const isRealUtcInstant = (value: string): boolean => {
  const parts = UTC_INSTANT.exec(value);
  if (parts === null) return false;
  const [, year, month, day, hour, minute, second] = parts;
  if (!isRealUtcDay(`${year}-${month}-${day}`)) return false;
  // A leap second is not representable here, and 24:00 is a day this record
  // would be ambiguous about, so both are refused.
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? "0") > 59) return false;
  return !Number.isNaN(new Date(value).getTime());
};

/**
 * Whether the record is signed, and whether it says what §5 requires.
 *
 * This is the whole of what the file decides, and it is deliberately not the
 * whole question: a caller must also establish that the third direction's
 * condition holds against the workflows in front of it, because this record is
 * only ever true while that check passes.
 */
export const cacheIsolationRecordSignature = (
  record: CacheIsolationRecord = CACHE_ISOLATION_RECORD,
): CacheIsolationSignature => {
  const problems: string[] = [];

  if (record.approvedBy.trim() === "") problems.push("unsigned_approved_by");
  if (record.approvedAt.trim() === "") problems.push("unsigned_approved_at");
  else if (!isRealUtcInstant(record.approvedAt.trim())) problems.push("approved_at_not_a_utc_instant");

  if (!COMMIT_SHA.test(record.verifiedAtCommit)) problems.push("verified_commit_not_a_full_sha");
  if (!isRealUtcDay(record.verifiedOn)) problems.push("verified_on_not_a_utc_day");

  const names = Object.keys(CACHE_ISOLATION_DIRECTION_FACTS) as CacheIsolationDirectionName[];
  for (const name of names) {
    const entries = record.directions.filter((entry) => entry.direction === name);
    if (entries.length !== 1) {
      problems.push(entries.length === 0 ? `direction_missing:${name}` : `direction_repeated:${name}`);
      continue;
    }
    const [entry] = entries;
    // A signer does not get to choose these: they are facts about GitHub's
    // cache scoping, and a record that states one wrongly establishes nothing.
    if (entry.open !== CACHE_ISOLATION_DIRECTION_FACTS[name]) problems.push(`direction_states_wrong_openness:${name}`);
    if (entry.finding.trim() === "") problems.push(`direction_has_no_finding:${name}`);
    if (entry.basis.trim() === "") problems.push(`direction_has_no_basis:${name}`);
  }
  for (const entry of record.directions) {
    if (!names.includes(entry.direction)) problems.push("direction_unknown");
  }

  // The sentence §5 forbids outright. Catching it here rather than in review is
  // the point: it is the plausible way a later edit makes the record false.
  const prose = record.directions.map((entry) => `${entry.finding} ${entry.basis}`).join(" ").toLowerCase();
  if (/isolated between refs|ref isolation|caches are isolated/.test(prose)) {
    problems.push("claims_isolation_between_refs");
  }

  return { signed: problems.length === 0, problems: problems.sort() };
};
