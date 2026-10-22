import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who may call the coding agent's internal API (app/api/internal/auto-router/
 * recommendations/**): the bearer of the shared secret the agent's host holds.
 * Pure, so the check runs under test without a request.
 */
export const AUTO_ROUTER_REC_AGENT_SECRET_ENV = "AUTO_ROUTER_REC_AGENT_SECRET";

const MIN_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export const isAutoRouterRecAgentAuthorized = (
    authorization: string | null,
    env: Readonly<Record<string, string | undefined>>
): boolean => {
    const own = env[AUTO_ROUTER_REC_AGENT_SECRET_ENV] ?? "";
    if (own.length < MIN_SECRET_LENGTH) return false;
    if (!authorization?.startsWith("Bearer ")) return false;
    const provided = authorization.slice("Bearer ".length);
    if (provided.length === 0) return false;
    return timingSafeEqual(digest(own), digest(provided));
};

/** The owner's switch for the agent (Admin › Routing). Off unless stored on. */
export const AUTO_ROUTER_REC_AGENT_SETTING_KEY = "auto.llmRouterRecAgent";

export const parseRecAgentSwitch = (raw: string | null | undefined): boolean => {
    if (!raw) return false;
    try {
        return (JSON.parse(raw) as { enabled?: unknown } | null)?.enabled === true;
    } catch {
        return false;
    }
};

/** How many recent cycles a claim looks through for an open code recommendation. */
export const REC_AGENT_CLAIM_WINDOW_CYCLES = 30;
