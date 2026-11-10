/**
 * The Team board (Agents home): one card per AI team and three totals, derived
 * from what the Agent office already reads of each team (`AgentOfficeLiveRooms`)
 * plus the few extras the board adds (open Scout suggestions, the marketing
 * generator's month, the next Scout slot).
 *
 * Pure and read-only. A room that could not be read is an `unknown` card and
 * leaves its count out of every total with the total saying so -- zero is a
 * claim and an unread count is not (docs/ui-contracts/admin-console-ia.md,
 * rule 8). Nothing here names what a team produced.
 */
import type { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import { routingCapReached, routingGateRejected, type AgentOfficeLiveRooms } from "@/lib/agentOffice/live";
import type { AdminPixelTeam } from "@/lib/adminPixelAvatarPalette";
import type { AdminTone } from "@/lib/adminUiCore";

type PageCopy = (typeof adminAgentPageMessages)["en"];
export type TeamBoardCopy = PageCopy["board"];
export type TeamBoardStatusCopy = PageCopy["status"];

export const TEAM_BOARD_KEYS = [
  "marketing",
  "research",
  "engineering",
  "sre",
  "finance",
  "qa",
  "support",
  "routing",
  "amux",
  "trust",
] as const;
export type TeamBoardKey = (typeof TEAM_BOARD_KEYS)[number];

/** Where a card goes. Trust and safety has no menu of its own yet. */
export const TEAM_BOARD_HREFS: Record<TeamBoardKey, string> = {
  marketing: "/admin/marketing",
  research: "/admin/product-research",
  engineering: "/admin/engineering-agent",
  sre: "/admin/sre-ops",
  finance: "/admin/finance-agent",
  qa: "/admin/release",
  support: "/admin/support",
  routing: "/admin/routing?tab=auto",
  amux: "/admin/amux-settings?tab=workers",
  trust: "/admin/agent-digests?tab=trust-safety",
};

const AVATAR: Record<TeamBoardKey, AdminPixelTeam> = {
  marketing: "marketing",
  research: "research",
  engineering: "engineering",
  sre: "sre",
  finance: "finance",
  qa: "qa",
  support: "support",
  routing: "routing",
  amux: "amux",
  trust: "trust",
};

/** What the board needs beyond the office's live rooms. Each is null when it could not be read. */
export type TeamBoardExtras = {
  /** Scout suggestions an owner has not decided. */
  researchOpen: number | null;
  /** The marketing generator's spend this UTC month against its cap. */
  marketingCost: { spentMicroUsd: number; capMicroUsd: number | null } | null;
  /** The next Scout slot (UTC ISO); null when the Scout is off. */
  researchNextAt: string | null;
};

export type TeamBoardRunning = "running" | "idle" | "unknown";

export type TeamBoardCost =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "known"; spentMicroUsd: number; capMicroUsd: number | null };

export type TeamBoardCard = {
  key: TeamBoardKey;
  avatar: AdminPixelTeam;
  href: string;
  name: string;
  tone: AdminTone;
  statusLabel: string;
  /** Whether the team's switch is on, for the "teams working now" total. */
  running: TeamBoardRunning;
  activity: string;
  /** Items waiting for a person; null when this team has no such queue or it could not be read. */
  waiting: number | null;
  waitingUnread: boolean;
  cost: TeamBoardCost;
  /** The newest record the office reads for the team (UTC ISO). */
  lastAt: string | null;
  nextAt: string | null;
  /** Off or not started: drawn dimmed. */
  dim: boolean;
};

type Draft = Omit<TeamBoardCard, "key" | "avatar" | "href" | "name" | "dim">;

const NO_WAITING = { waiting: null, waitingUnread: false } as const;
const NO_COST: TeamBoardCost = { kind: "none" };

const base = (activity: string): Draft => ({
  tone: "unknown",
  statusLabel: "",
  running: "unknown",
  activity,
  ...NO_WAITING,
  cost: NO_COST,
  lastAt: null,
  nextAt: null,
});

const sum = (parts: readonly (number | null)[]) =>
  parts.some((part) => part === null) ? null : parts.reduce<number>((total, part) => total + (part ?? 0), 0);

export function teamBoardCards(
  rooms: AgentOfficeLiveRooms,
  extras: TeamBoardExtras,
  copy: TeamBoardCopy,
  status: TeamBoardStatusCopy
): TeamBoardCard[] {
  const a = copy.activity;
  const unread = (): Draft => ({ ...base(a.unread), tone: "unknown", statusLabel: status.unknown });
  // The two teams that keep a cost record never lose it to an unread room: it is "unavailable", not "no record".
  const costOf = (): TeamBoardCost =>
    extras.marketingCost
      ? { kind: "known", spentMicroUsd: extras.marketingCost.spentMicroUsd, capMicroUsd: extras.marketingCost.capMicroUsd }
      : { kind: "unknown" };
  const make = (tone: AdminTone, label: string, running: TeamBoardRunning, activity: string, rest: Partial<Draft> = {}): Draft => ({
    ...base(activity),
    tone,
    statusLabel: label,
    running,
    ...rest,
  });
  const drafts: Record<TeamBoardKey, Draft> = {
    marketing: (() => {
      const state = rooms.marketing;
      // The operator queue counts the same posts through its own read, so an unread room can still have a number.
      const queued = rooms.queue.marketing;
      if (state.kind !== "observed") {
        // The generator's month is its own read, so it survives an unread room.
        return { ...unread(), waiting: queued, waitingUnread: queued === null, cost: costOf() };
      }
      const pending = state.pending;
      const activity =
        pending === null
          ? a.marketingUnknown
          : pending.count > 0
            ? a.marketingPending(pending.count)
            : state.drafts === "off"
              ? a.marketingDraftsOff
              : a.marketingNone;
      const rest: Partial<Draft> = {
        waiting: pending?.count ?? queued,
        waitingUnread: pending === null && queued === null,
        lastAt: state.lastRun?.at ?? null,
        cost: costOf(),
      };
      if (state.drafts === "unreadable") return make("unknown", status.unknown, "unknown", activity, rest);
      if (state.drafts === "off") return make("idle", status.off, "idle", activity, rest);
      return make("ok", status.working, "running", activity, rest);
    })(),
    research: (() => {
      const state = rooms.research;
      // The card's status is the observation agent's own; the waiting count and the next slot belong to the
      // Scout, a separate switch, so they are shown whatever the observation agent's state is.
      const rest: Partial<Draft> = {
        waiting: extras.researchOpen,
        waitingUnread: extras.researchOpen === null,
        nextAt: extras.researchNextAt,
      };
      if (state.kind === "unread") return { ...unread(), ...rest };
      if (state.kind === "disabled") return make("idle", status.off, "idle", a.researchOff, rest);
      const withTime = { ...rest, lastAt: state.lastSuccessAt };
      if (state.silence === "silent") return make("warn", status.needsLook, "running", a.researchSilent, withTime);
      if (state.slotState === "failed") return make("bad", status.needsLook, "running", a.researchFailed, withTime);
      if (state.slotState === "ok") return make("ok", status.working, "running", a.researchRecorded, withTime);
      return make("ok", status.watching, "running", a.researchMissing, withTime);
    })(),
    engineering: (() => {
      const state = rooms.engineering;
      if (state.kind !== "observed") return { ...unread(), waitingUnread: true };
      const waiting = state.pending.t2Draft + state.pending.decision + state.pending.stateMismatch;
      const rest: Partial<Draft> = { waiting, lastAt: state.lastRun?.endedAt ?? null };
      if (state.mode === "off") return make("idle", status.off, "idle", a.engineeringOff, rest);
      if (state.halt !== "none" || state.frozen || state.killSwitch) {
        return make("warn", status.needsLook, "running", a.engineeringHalt, rest);
      }
      if (state.mode === "shadow") return make("info", status.observing, "running", a.engineeringShadow, rest);
      return state.activeRuns > 0
        ? make("ok", status.working, "running", a.engineeringRunning(state.activeRuns), rest)
        : make("ok", status.watching, "running", a.engineeringIdle, rest);
    })(),
    sre: (() => {
      const state = rooms.sre;
      if (state.kind !== "observed") return unread();
      const rest: Partial<Draft> = { lastAt: state.latestDigestAt };
      if (state.head === null) return make("idle", status.preparing, "idle", a.sreNoGenesis, rest);
      return state.trustReason === "trusted"
        ? make("ok", status.watching, "running", a.sreTrusted, rest)
        : make("warn", status.needsLook, "running", a.sreUntrusted, rest);
    })(),
    finance: (() => {
      const state = rooms.finance;
      if (state.kind !== "observed") return unread();
      const rest: Partial<Draft> = { lastAt: state.latestDigestAt };
      switch (state.verdict) {
        case "control_unreadable":
          return make("unknown", status.unknown, "unknown", a.unread, rest);
        case "off":
        case "not_applicable":
          return make("idle", status.off, "idle", a.financeOff, rest);
        case "silent":
          return make("warn", status.needsLook, "running", a.financeSilent, rest);
        case "recorded":
          return make("ok", status.watching, "running", a.financeRecorded, rest);
        default:
          return make("ok", status.watching, "running", a.financeNotDue, rest);
      }
    })(),
    qa: (() => {
      const state = rooms.qa;
      if (state.kind !== "observed") return unread();
      const rest: Partial<Draft> = { lastAt: state.latestDigestAt };
      if (state.verdict === "operator_disabled") return make("idle", status.off, "idle", a.qaOff, rest);
      if (state.verdict === "dark_not_configured") return make("idle", status.preparing, "idle", a.qaOff, rest);
      if (state.mergeLaneLatched) return make("warn", status.needsLook, "running", a.qaLatched, rest);
      if (state.verdict === "stale" || state.verdict === "control_mismatch") {
        return make("warn", status.needsLook, "running", a.qaStale, rest);
      }
      return make("ok", status.watching, "running", a.qaFresh, rest);
    })(),
    support: (() => {
      const state = rooms.support;
      if (state.kind !== "observed") return unread();
      const rest: Partial<Draft> = { lastAt: state.worker?.at ?? null };
      if (!state.enabled) return make("idle", status.off, "idle", a.supportOff, rest);
      if (state.stale) return make("warn", status.needsLook, "running", a.supportStale, rest);
      return make("ok", status.working, "running", a.supportOn(state.reportsToday), rest);
    })(),
    routing: (() => {
      const state = rooms.routing;
      if (state.kind !== "observed") return { ...unread(), cost: { kind: "unknown" } };
      const cost: TeamBoardCost = {
        kind: "known",
        spentMicroUsd: state.spentMonthMicroUsd,
        capMicroUsd: state.monthCapMicroUsd,
      };
      const rest: Partial<Draft> = { cost, lastAt: state.last?.createdAt ?? null };
      if (state.last === null) return make("idle", status.preparing, "idle", a.routingNone, rest);
      if (state.last.status === "running") return make("info", status.working, "running", a.routingRunning, rest);
      if (routingCapReached(state)) return make("warn", status.needsLook, "running", a.routingCap, rest);
      if (state.last.status === "passed") return make("ok", status.watching, "running", a.routingPassed, rest);
      // The gate turning a proposal down is the cycle working as designed.
      if (routingGateRejected(state.last)) return make("ok", status.watching, "running", a.routingKept, rest);
      return make("warn", status.needsLook, "running", state.last.status === "error" ? a.routingError : a.routingFailed, rest);
    })(),
    amux: (() => {
      const state = rooms.amux;
      const escalations = rooms.queue.amuxEscalations;
      const halts = rooms.queue.amuxHalts;
      const waiting = sum([escalations, halts]);
      const queue: Partial<Draft> = { waiting, waitingUnread: waiting === null };
      if (state.kind === "unread") return { ...unread(), ...queue };
      if (state.kind === "no_catalog") return make("idle", status.off, "idle", a.amuxNoCatalog, queue);
      const live = state.workers.filter((worker) => worker.state === "ready" || worker.state === "idle" || worker.state === "busy").length;
      const trouble = state.workers.some((worker) => worker.state === "error" || worker.state === "lost");
      const newest = state.workers
        .map((worker) => worker.heartbeatAt)
        .filter((at): at is string => at !== null)
        .sort()
        .at(-1) ?? null;
      const rest = { ...queue, lastAt: newest };
      const activity = a.amuxWorkers(live, state.workers.length);
      if (trouble) return make("warn", status.needsLook, "running", activity, rest);
      return live > 0
        ? make("ok", status.working, "running", activity, rest)
        : make("idle", status.stopped, "idle", activity, rest);
    })(),
    trust: (() => {
      const state = rooms.trust;
      if (state.kind === "unread") return unread();
      if (state.kind === "not_permitted") return make("unknown", status.unknown, "unknown", a.notPermitted);
      const rest: Partial<Draft> = { lastAt: state.observedAt };
      if (state.fault !== null) return make("warn", status.needsLook, "running", a.trustFault, rest);
      if (state.mode === "off") return make("idle", status.off, "idle", a.trustOff, rest);
      if (state.mode === null) return make("unknown", status.unknown, "unknown", a.unread, rest);
      if ((state.overdue ?? 0) > 0) return make("warn", status.needsLook, "running", a.trustOverdue(state.overdue ?? 0), rest);
      return make("ok", status.watching, "running", a.trustOn, rest);
    })(),
  };
  return TEAM_BOARD_KEYS.map((key) => ({
    key,
    avatar: AVATAR[key],
    href: TEAM_BOARD_HREFS[key],
    name: copy.teams[key],
    ...drafts[key],
    dim: drafts[key].running === "idle",
  }));
}

export type TeamBoardTotals = {
  /** Items waiting for a person, over the teams that could be read. */
  waiting: number;
  /** Some team's count could not be read: `waiting` is a floor. */
  waitingFloor: boolean;
  /** Teams whose switch is on, over all teams. */
  running: number;
  total: number;
  /** Some team could not be read: `running` is a floor. */
  runningFloor: boolean;
  /** Spend and cap over the teams that keep a cost record. */
  cost: { spentMicroUsd: number; capMicroUsd: number | null; teams: number } | null;
  /** Teams whose cost record could not be read: the cost total is a floor (or unknown when nothing was read). */
  costUnread: number;
};

export function teamBoardTotals(cards: readonly TeamBoardCard[]): TeamBoardTotals {
  const known = cards.flatMap((card) => (card.cost.kind === "known" ? [card.cost] : []));
  const capped = known.filter((cost) => cost.capMicroUsd !== null);
  return {
    waiting: cards.reduce((total, card) => total + (card.waiting ?? 0), 0),
    waitingFloor: cards.some((card) => card.waitingUnread),
    running: cards.filter((card) => card.running === "running").length,
    total: cards.length,
    runningFloor: cards.some((card) => card.running === "unknown"),
    costUnread: cards.filter((card) => card.cost.kind === "unknown").length,
    cost:
      known.length === 0
        ? null
        : {
            spentMicroUsd: known.reduce((total, cost) => total + cost.spentMicroUsd, 0),
            // A total cap only when every costed team has one: a missing cap is not zero.
            capMicroUsd:
              capped.length === known.length ? capped.reduce((total, cost) => total + (cost.capMicroUsd ?? 0), 0) : null,
            teams: known.length,
          },
  };
}

/** "US$ 4.10" for an amount in millionths of a dollar. */
export const teamBoardUsd = (micro: number) => `US$ ${(micro / 1_000_000).toFixed(2)}`;
