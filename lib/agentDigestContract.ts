/**
 * The closed lists of the shared AgentDigestItem table, as the application
 * knows them. Migration 20261003000000_agent_digest_item enforces the same
 * lists in CHECK constraints. scripts/check-enum-constraints.mjs compares the
 * agentKey list; tests/agentDigestContract.test.mjs compares the per-agent
 * kinds, the retention, the 365-day delete and the size limit, which that
 * parser does not read.
 * Adding an agent or a kind is one reviewed change to both.
 *
 * Pure constants: safe to import from the store, the route and the services.
 */

export const AGENT_DIGEST_AGENT_KEYS = ["qa-release"] as const;

export type AgentDigestAgentKey = (typeof AGENT_DIGEST_AGENT_KEYS)[number];

export const AGENT_DIGEST_KINDS: Readonly<Record<AgentDigestAgentKey, readonly string[]>> = Object.freeze({
  "qa-release": Object.freeze(["daily_digest"]),
});

/** The shared contract's serialized payload limit (contract item 7). */
export const AGENT_DIGEST_MAX_PAYLOAD_BYTES = 16_384;

/** Body retention per agent, in days. Must match the CASE in agent_digest_item_before_insert(). */
export const AGENT_DIGEST_BODY_RETENTION_DAYS: Readonly<Record<AgentDigestAgentKey, number>> = Object.freeze({
  "qa-release": 90,
});

/** Meta rows are purged this long after creation, once their body is gone (contract item 7). */
export const AGENT_DIGEST_META_RETENTION_DAYS = 365;
