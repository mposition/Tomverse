/**
 * The office's AI briefing, the pure part: the facts the model may read, the
 * prompt, and the one check on what it answers. The model reads counts,
 * states and worker names only (never a card title or anything a user wrote),
 * and its answer is shown to the owner as text. A link it names must be one of
 * BRIEFING_LINKS; anything else is dropped. Its answer grants nothing.
 */
import { agentOfficeChannel } from "./floor";
import { AGENT_OFFICE_CARDS_HREF, AGENT_OFFICE_IDEAS_HREF, agentOfficeInbox } from "./inbox";
import {
  OPERATOR_QUEUE_HREFS,
  engineeringTone,
  financeTone,
  marketingTone,
  qaTone,
  researchTone,
  routingTone,
  sreTone,
  supportTone,
  trustTone,
  type AgentOfficeLiveRooms,
} from "./live";
import { brisbaneIso } from "./time";

/** Paid calls a day (Brisbane day), for every owner together. */
export const AGENT_OFFICE_BRIEFING_PER_DAY = 40;
/** A briefing younger than this is shown again instead of calling the model. */
export const AGENT_OFFICE_BRIEFING_REUSE_MS = 5 * 60_000;
export const AGENT_OFFICE_BRIEFING_MAX_POINTS = 5;
const HEADLINE_MAX = 160;
const POINT_MAX = 240;
const WORKER_FACTS_MAX = 120;

/** The only places a briefing may link: screens the office already links. */
export const BRIEFING_LINKS = {
  cards: AGENT_OFFICE_CARDS_HREF,
  ideas: AGENT_OFFICE_IDEAS_HREF,
  halts: OPERATOR_QUEUE_HREFS.amuxHalts,
  escalations: OPERATOR_QUEUE_HREFS.amuxEscalations,
  marketing: OPERATOR_QUEUE_HREFS.marketing,
  workers: "/admin/amux-settings?tab=workers",
  safety: "/admin/amux-recovery?tab=safety",
} as const;
export type BriefingLink = keyof typeof BRIEFING_LINKS;
const LINK_KEYS = Object.keys(BRIEFING_LINKS) as BriefingLink[];

export const BRIEFING_SEVERITIES = ["bad", "warn", "info"] as const;
export type BriefingSeverity = (typeof BRIEFING_SEVERITIES)[number];

export type AgentOfficeBriefing = {
  headline: string;
  points: { severity: BriefingSeverity; text: string; link: BriefingLink | null }[];
};

export type BriefingLocale = "en" | "ko";

export type StoredAgentOfficeBriefing = {
  at: string;
  locale: BriefingLocale;
  modelId: string;
  briefing: AgentOfficeBriefing;
};

/** What the model reads: counts, states and names. Unread reads are said to be unread. */
export function agentOfficeBriefingFacts(live: AgentOfficeLiveRooms, now: Date) {
  const inbox = agentOfficeInbox({ queue: live.queue, inbox: live.inbox, amux: live.amux, amuxDetail: live.amuxDetail, now: now.getTime() });
  const workers = live.amux.kind === "observed" ? live.amux.workers : null;
  const byState: Record<string, number> = {};
  for (const w of workers ?? []) byState[w.state] = (byState[w.state] ?? 0) + 1;
  const today = (brisbaneIso(now.toISOString()) ?? "").slice(0, 10);
  const spans = live.history.kind === "observed" ? live.history.spans : null;
  return {
    clockAest: (brisbaneIso(now.toISOString()) ?? "").slice(0, 16).replace("T", " "),
    waitingOnOwner: inbox.map((item) => ({
      kind: item.kind,
      severity: item.severity,
      count: item.count,
      ...(item.worker ? { worker: item.worker } : {}),
      ...(item.channel ? { channel: item.channel } : {}),
    })),
    amuxWorkers:
      workers === null
        ? "unread"
        : {
            total: workers.length,
            byState,
            list: workers.slice(0, WORKER_FACTS_MAX).map((w) => ({ name: w.name, channel: agentOfficeChannel(w.provider), state: w.state })),
          },
    attemptsToday:
      spans === null
        ? "unread"
        : {
            running: spans.filter((x) => x.endedAt === null).length,
            succeeded: spans.filter((x) => x.mark === "s").length,
            failed: spans.filter((x) => x.mark === "f").length,
            other: spans.filter((x) => x.mark === "u").length,
          },
    mergesToday:
      live.merges.kind === "observed"
        ? live.merges.items.filter((x) => (brisbaneIso(x.mergedAt) ?? "").slice(0, 10) === today).map((x) => x.pr)
        : "unread",
    teams: {
      research: researchTone(live.research),
      qa: qaTone(live.qa),
      engineering: engineeringTone(live.engineering),
      finance: financeTone(live.finance),
      routing: routingTone(live.routing),
      sre: sreTone(live.sre),
      support: supportTone(live.support),
      marketing: marketingTone(live.marketing),
      trust: trustTone(live.trust),
    },
  };
}
export type AgentOfficeBriefingFacts = ReturnType<typeof agentOfficeBriefingFacts>;

export function agentOfficeBriefingSystem(locale: BriefingLocale): string {
  return [
    "You brief the owner of Tomverse on its agent office: AMUX coding workers, their queues, and eight agent teams.",
    "Read only the JSON facts given. Never invent a number, a worker or an event that is not in them. An \"unread\" value means that record could not be read: say so, never treat it as zero.",
    "Most urgent first: halts, workers in error or lost, then questions and decisions waiting on the owner, then the rest. If nothing waits, say so in the headline.",
    `Answer with a one-sentence headline and at most ${AGENT_OFFICE_BRIEFING_MAX_POINTS} short points. Each point may name one link key from: ${LINK_KEYS.join(", ")}; use null when none fits.`,
    "You approve, send or change nothing; the owner acts on the linked screens.",
    locale === "ko"
      ? "Write in Korean, polite 해요체, short sentences, with no em dash. Times are AEST."
      : "Write in plain English, short sentences, with no em dash. Times are AEST.",
  ].join("\n");
}

export function agentOfficeBriefingPrompt(facts: AgentOfficeBriefingFacts): string {
  return `Office facts (JSON):\n${JSON.stringify(facts)}`;
}

export const AGENT_OFFICE_BRIEFING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "points"],
  properties: {
    headline: { type: "string" },
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "text", "link"],
        properties: {
          severity: { type: "string", enum: [...BRIEFING_SEVERITIES] },
          text: { type: "string" },
          link: { type: ["string", "null"], enum: [...LINK_KEYS, null] },
        },
      },
    },
  },
} as const;

const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** The one check on the model's answer: shape, lengths, and links from the list only. */
export function parseAgentOfficeBriefing(value: unknown): AgentOfficeBriefing | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { headline?: unknown; points?: unknown };
  const headline = clean(raw.headline, HEADLINE_MAX);
  if (!headline || !Array.isArray(raw.points)) return null;
  const points: AgentOfficeBriefing["points"] = [];
  for (const point of raw.points.slice(0, AGENT_OFFICE_BRIEFING_MAX_POINTS)) {
    if (!point || typeof point !== "object") continue;
    const p = point as { severity?: unknown; text?: unknown; link?: unknown };
    const text = clean(p.text, POINT_MAX);
    if (!text) continue;
    const severity = BRIEFING_SEVERITIES.includes(p.severity as BriefingSeverity) ? (p.severity as BriefingSeverity) : "info";
    const link = typeof p.link === "string" && (LINK_KEYS as string[]).includes(p.link) ? (p.link as BriefingLink) : null;
    points.push({ severity, text, link });
  }
  return { headline, points };
}

/** A stored briefing row, or null when it is missing or not one. */
export function parseStoredAgentOfficeBriefing(value: string | null | undefined): StoredAgentOfficeBriefing | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Partial<StoredAgentOfficeBriefing>;
    const briefing = parseAgentOfficeBriefing(raw.briefing);
    if (!briefing || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at)) || typeof raw.modelId !== "string") return null;
    if (raw.locale !== "en" && raw.locale !== "ko") return null;
    return { at: raw.at, locale: raw.locale, modelId: raw.modelId, briefing };
  } catch {
    return null;
  }
}

/** The Brisbane date a call counts against. */
export function agentOfficeBriefingDay(now: Date): string {
  return (brisbaneIso(now.toISOString()) ?? now.toISOString()).slice(0, 10);
}

export type AgentOfficeBriefingClaim = { id: string; until: string };

/**
 * Today's calls and the call in flight, from the usage row. The claim is kept
 * whatever day it was taken on, so a call running across Brisbane midnight
 * still holds it. No row, or another day's, is zero calls; a row that cannot
 * be read counts as the limit reached and as a claim held until it is fixed.
 */
export function parseAgentOfficeBriefingUsage(
  value: string | null | undefined,
  day: string
): { calls: number; claim: AgentOfficeBriefingClaim | null; unreadable: boolean } {
  if (value === null || value === undefined) return { calls: 0, claim: null, unreadable: false };
  try {
    const raw = JSON.parse(value) as { day?: unknown; calls?: unknown; claim?: unknown };
    const c = raw.claim as { id?: unknown; until?: unknown } | null | undefined;
    const claim = c && typeof c.id === "string" && typeof c.until === "string" ? { id: c.id, until: c.until } : null;
    if (raw.day !== day) return { calls: 0, claim, unreadable: false };
    const calls = typeof raw.calls === "number" && Number.isInteger(raw.calls) && raw.calls >= 0 ? raw.calls : AGENT_OFFICE_BRIEFING_PER_DAY;
    return { calls, claim, unreadable: false };
  } catch {
    return { calls: AGENT_OFFICE_BRIEFING_PER_DAY, claim: null, unreadable: true };
  }
}

/** A claim still in force at `now`. An unparseable `until` holds (fails closed). */
export function agentOfficeBriefingClaimHeld(claim: AgentOfficeBriefingClaim | null, now: number): boolean {
  if (!claim) return false;
  const until = Date.parse(claim.until);
  return !Number.isFinite(until) || until > now;
}

/** A stored answer reused instead of a call: same language, at most REUSE_MS old, never from the future. */
export function agentOfficeBriefingReusable(stored: StoredAgentOfficeBriefing | null, locale: BriefingLocale, now: number): boolean {
  if (!stored || stored.locale !== locale) return false;
  const age = now - Date.parse(stored.at);
  return age >= 0 && age < AGENT_OFFICE_BRIEFING_REUSE_MS;
}
