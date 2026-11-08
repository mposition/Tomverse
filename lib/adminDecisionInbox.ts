/**
 * The decision inbox: everything that waits on a person, grouped by area.
 *
 * Pure on purpose (no database import) so the grouping can be tested directly.
 * `lib/adminDecisionInboxLoad.ts` reads the two existing sources and hands them
 * here:
 *
 * - the work queue (`lib/adminWorkQueue.ts`): rows with a start time, which is
 *   what lets the inbox say how long each one has waited;
 * - the sidebar badge counts (`lib/adminNavigationCounts.ts`): the agent and
 *   AMUX approvals, which are counted but not listed row by row anywhere a
 *   queue can read. Each becomes one line with its count and no start time.
 *
 * The inbox only reads and links. A decision is made on the screen that owns
 * it, so nothing here writes.
 *
 * Unknown is not zero. A count source that failed is named in `unreadSources`
 * and a queue that failed to load at all sets `queueUnread`, so an empty inbox
 * is never drawn when a source behind it did not answer.
 */
import { adminHrefIsVisibleTo } from "@/lib/adminNavigation";
import type { AdminRole } from "@/lib/adminAuthCore";
import type { AdminNavigationCounts } from "@/lib/adminNavigationBadges";
import type { AdminWorkQueue, WorkQueueItem, WorkQueueSeverity } from "@/lib/adminWorkQueue";
import type { AdminPixelTeam } from "@/lib/adminPixelAvatarPalette";

export const DECISION_AREAS = ["customers", "agents", "development", "system"] as const;
export type DecisionArea = (typeof DECISION_AREAS)[number];

export type DecisionKind =
  | "refund"
  | "feedback"
  | "privacy"
  | "incident"
  | "webhook"
  | "model"
  | "alert"
  | "job"
  | "marketing"
  | "scout"
  | "amuxReview"
  | "amuxHalt"
  | "amuxDecisionMaker";

export const DECISION_KIND_AREA: Record<DecisionKind, DecisionArea> = {
  refund: "customers",
  feedback: "customers",
  privacy: "customers",
  marketing: "agents",
  scout: "agents",
  amuxReview: "development",
  amuxHalt: "development",
  amuxDecisionMaker: "development",
  incident: "system",
  webhook: "system",
  model: "system",
  alert: "system",
  job: "system",
};

/** Which pixel figure asks, for the kinds an AI team raises. */
export const DECISION_KIND_TEAM: Partial<Record<DecisionKind, AdminPixelTeam>> = {
  marketing: "marketing",
  scout: "research",
  amuxReview: "amux",
  amuxHalt: "amux",
  amuxDecisionMaker: "amux",
};

/** A wait of this many hours or more is "waiting long". */
export const DECISION_LONG_WAIT_HOURS = 24;

export type DecisionItem = {
  id: string;
  kind: DecisionKind;
  area: DecisionArea;
  severity: WorkQueueSeverity;
  /** The work queue's own line (an email, a message, an event name), or empty for a counted line. */
  subject: string;
  /** The work queue's detail line, as the source wrote it. */
  detail: string;
  href: string;
  /** When it started waiting; null when the source records no time. */
  openedAt: string | null;
  /** How many decisions this line stands for: 1, or the count of a counted line. */
  count: number;
  /** True for a line that is a count with no row behind it. */
  counted: boolean;
  /** The e-mail address a customer line names, for the initials. */
  requesterEmail: string | null;
};

export type DecisionGroupId = "long" | "recent" | "unknown";

export type DecisionInbox = {
  items: DecisionItem[];
  /** Decisions waiting per area (a counted line adds its count). */
  byArea: Record<DecisionArea, number>;
  total: number;
  /** Hours each item has waited, by id; absent when the start is unknown. */
  waitHours: Record<string, number>;
  /** The work queue could not be loaded at all. */
  queueUnread: boolean;
  /** Work queue sources that failed (the queue's own `failedCategories`). */
  failedCategories: string[];
  truncatedCategories: string[];
  /** Counted sources whose read failed. */
  unreadSources: DecisionKind[];
};

const SEVERITY_RANK: Record<WorkQueueSeverity, number> = { critical: 0, high: 1, normal: 2 };

const QUEUE_PREFIX_KIND: Record<string, DecisionKind> = {
  refund: "refund",
  feedback: "feedback",
  privacy: "privacy",
  incident: "incident",
  webhook: "webhook",
  "model-lifecycle": "model",
  alert: "alert",
  job: "job",
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export const emailIn = (...texts: string[]): string | null => {
  for (const text of texts) {
    const found = text.match(EMAIL);
    if (found) return found[0];
  }
  return null;
};

export const decisionWaitHours = (openedAt: string | null, now: Date): number | null => {
  if (!openedAt) return null;
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return null;
  return Math.max(0, Math.floor((now.getTime() - opened) / 3_600_000));
};

export const decisionGroupOf = (hours: number | null): DecisionGroupId =>
  hours === null ? "unknown" : hours >= DECISION_LONG_WAIT_HOURS ? "long" : "recent";

/** The counted lines: one badge source each, with where its decisions are made. */
const COUNTED_SOURCES: ReadonlyArray<{
  kind: DecisionKind;
  count: (counts: AdminNavigationCounts) => number | null;
  href: string;
  severity: WorkQueueSeverity;
}> = [
  { kind: "marketing", count: (c) => c.pendingMarketingApprovals, href: "/admin/marketing?tab=queue", severity: "normal" },
  { kind: "scout", count: (c) => c.openProductResearchSuggestions, href: "/admin/product-research?tab=suggestions", severity: "normal" },
  { kind: "amuxReview", count: (c) => c.openAmuxEscalations, href: "/admin/amux-execution?tab=review", severity: "high" },
  { kind: "amuxHalt", count: (c) => c.openAmuxOrchestratorHalts, href: "/admin/amux-recovery?tab=safety", severity: "high" },
  { kind: "amuxDecisionMaker", count: (c) => c.awaitingAmuxDecisionMaker, href: "/admin/amux-execution?tab=cards", severity: "high" },
];

const fromQueueItem = (item: WorkQueueItem): DecisionItem | null => {
  const kind = QUEUE_PREFIX_KIND[item.id.split(":")[0]];
  if (!kind) return null;
  return {
    id: item.id,
    kind,
    area: DECISION_KIND_AREA[kind],
    severity: item.severity,
    subject: item.title,
    detail: item.detail,
    href: item.href,
    openedAt: item.openedAt,
    count: 1,
    counted: false,
    requesterEmail: DECISION_KIND_AREA[kind] === "customers" ? emailIn(item.title, item.detail) : null,
  };
};

export function buildDecisionInbox({
  queue,
  counts,
  role,
  now,
}: {
  queue: AdminWorkQueue | null;
  counts: AdminNavigationCounts | null;
  role: AdminRole | null | undefined;
  now: Date;
}): DecisionInbox {
  const items: DecisionItem[] = [];
  const unreadSources: DecisionKind[] = [];

  for (const row of queue?.items ?? []) {
    const item = fromQueueItem(row);
    if (item) items.push(item);
  }
  for (const source of COUNTED_SOURCES) {
    const count = counts ? source.count(counts) : null;
    if (count === null) {
      unreadSources.push(source.kind);
      continue;
    }
    if (count <= 0) continue;
    items.push({
      id: `count:${source.kind}`,
      kind: source.kind,
      area: DECISION_KIND_AREA[source.kind],
      severity: source.severity,
      subject: "",
      detail: "",
      href: source.href,
      openedAt: null,
      count,
      counted: true,
      requesterEmail: null,
    });
  }

  // A line whose screen this role cannot open is not offered: the link would
  // answer 404, and the count behind it is not this role's to act on.
  const visible = items.filter((item) => adminHrefIsVisibleTo(role, item.href));

  const time = (item: DecisionItem) =>
    item.openedAt ? new Date(item.openedAt).getTime() : Number.POSITIVE_INFINITY;
  visible.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || time(left) - time(right)
  );

  const byArea: Record<DecisionArea, number> = { customers: 0, agents: 0, development: 0, system: 0 };
  const waitHours: Record<string, number> = {};
  for (const item of visible) {
    byArea[item.area] += item.count;
    const hours = decisionWaitHours(item.openedAt, now);
    if (hours !== null) waitHours[item.id] = hours;
  }

  return {
    items: visible,
    byArea,
    total: DECISION_AREAS.reduce((sum, area) => sum + byArea[area], 0),
    waitHours,
    queueUnread: queue === null,
    failedCategories: queue?.failedCategories ?? [],
    truncatedCategories: queue?.truncatedCategories ?? [],
    unreadSources,
  };
}

/** "MK" from "mkim@example.com"; one letter when the local part is short. */
export const initialsOf = (email: string | null): string => {
  if (!email) return "?";
  const local = email.split("@")[0].replace(/[^A-Za-z0-9]/g, "");
  return (local.slice(0, 2) || "?").toUpperCase();
};
