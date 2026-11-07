/**
 * "Waiting on me": every queue an agent waits on the operator for, in the
 * order the operator should look at them. Built from the live reading only;
 * each item links the screen where it is acted on, and the office acts on
 * none of them. A count that could not be read is an item of its own, never
 * left out as zero.
 */

import {
  OPERATOR_QUEUE_HREFS,
  type AgentOfficeAmuxState,
  type AgentOfficeAmuxDetail,
  type AgentOfficeInboxCounts,
  type AgentOfficeOperatorQueue,
} from "@/lib/agentOffice/live";
import { agentOfficeChannel, AGENT_OFFICE_CHANNELS, type AgentOfficeChannel } from "@/lib/agentOffice/floor";

export const AGENT_OFFICE_CARDS_HREF = "/admin/amux-execution?tab=cards";
export const AGENT_OFFICE_IDEAS_HREF = "/admin/amux-backlog?tab=ideas";
export const AGENT_OFFICE_WORKERS_HREF = "/admin/amux-settings?tab=workers";

export type InboxSeverity = "bad" | "warn" | "info" | "unread";
export type InboxKind =
  | "halt"
  | "workerDown"
  | "v22Question"
  | "dmAttention"
  | "escalation"
  | "planRefusal"
  | "marketing"
  | "quota";

export type AgentOfficeInboxItem = {
  id: string;
  kind: InboxKind;
  severity: InboxSeverity;
  /** How many wait; null when the count could not be read. */
  count: number | null;
  href: string | null;
  /** The worker a worker item is about. */
  worker?: string;
  channel?: AgentOfficeChannel;
  /** The worker's state word key, for a worker item. */
  state?: "error" | "lost";
};

const SEVERITY_ORDER: Readonly<Record<InboxSeverity, number>> = { bad: 0, warn: 1, info: 2, unread: 3 };

export function quotaExhaustedNow(
  quota: { exhausted: boolean; resetAt: string | null } | null | undefined,
  now: number
): boolean {
  if (!quota?.exhausted) return false;
  const reset = quota.resetAt ? Date.parse(quota.resetAt) : NaN;
  return !Number.isFinite(reset) || reset > now;
}

export function agentOfficeInbox(input: {
  queue: AgentOfficeOperatorQueue;
  inbox: AgentOfficeInboxCounts;
  amux: AgentOfficeAmuxState;
  amuxDetail: AgentOfficeAmuxDetail;
  now: number;
}): AgentOfficeInboxItem[] {
  const items: AgentOfficeInboxItem[] = [];
  const count = (id: string, kind: InboxKind, severity: Exclude<InboxSeverity, "unread">, n: number | null, href: string) => {
    if (n === null) items.push({ id, kind, severity: "unread", count: null, href });
    else if (n > 0) items.push({ id, kind, severity, count: n, href });
  };
  count("halt", "halt", "bad", input.queue.amuxHalts, OPERATOR_QUEUE_HREFS.amuxHalts);
  if (input.amux.kind !== "observed") {
    items.push({ id: "down:unread", kind: "workerDown", severity: "unread", count: null, href: AGENT_OFFICE_WORKERS_HREF });
  } else {
    for (const worker of input.amux.workers) {
      if (worker.state === "error" || worker.state === "lost") {
        items.push({
          id: `down:${worker.name}`,
          kind: "workerDown",
          severity: "bad",
          count: 1,
          href: null,
          worker: worker.name,
          channel: agentOfficeChannel(worker.provider) ?? undefined,
          state: worker.state,
        });
      }
    }
  }
  count("v22", "v22Question", "warn", input.inbox.v22Questions, AGENT_OFFICE_CARDS_HREF);
  count("dm", "dmAttention", "warn", input.inbox.dmAttention, AGENT_OFFICE_CARDS_HREF);
  count("escalation", "escalation", "warn", input.queue.amuxEscalations, OPERATOR_QUEUE_HREFS.amuxEscalations);
  count("refusal", "planRefusal", "info", input.inbox.planRefusals, AGENT_OFFICE_IDEAS_HREF);
  count("marketing", "marketing", "info", input.queue.marketing, OPERATOR_QUEUE_HREFS.marketing);
  if (input.amux.kind === "observed" && input.amuxDetail.kind !== "observed") {
    items.push({ id: "quota:unread", kind: "quota", severity: "unread", count: null, href: AGENT_OFFICE_WORKERS_HREF });
  } else if (input.amux.kind === "observed" && input.amuxDetail.kind === "observed") {
    const detail = input.amuxDetail.workers;
    for (const channel of AGENT_OFFICE_CHANNELS) {
      const resting = input.amux.workers.filter(
        (w) =>
          agentOfficeChannel(w.provider) === channel &&
          (w.state === "ready" || w.state === "idle" || w.state === "starting") &&
          quotaExhaustedNow(detail[w.name]?.quota, input.now)
      );
      if (resting.length > 0) {
        items.push({ id: `quota:${channel}`, kind: "quota", severity: "info", count: resting.length, href: null, channel });
      }
    }
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.index - b.index)
    .map(({ item }) => item);
}

/** What the badge counts: items that were read. An unread item makes it a floor. */
export function inboxTotal(items: readonly AgentOfficeInboxItem[]): { total: number; unknown: boolean; urgent: number } {
  return {
    total: items.filter((i) => i.severity !== "unread").length,
    unknown: items.some((i) => i.severity === "unread"),
    urgent: items.filter((i) => i.severity === "bad").length,
  };
}
