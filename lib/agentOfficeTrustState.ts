/**
 * The Trust and safety room's state, from what the section's own reader returned.
 *
 * Numbers and codes only. The reader (`readTrustSafetyDigest()`) owns the
 * `trust-safety:read` check and every table behind it, and it hands back three
 * counts, a switch and a time -- never a request, an email or a name -- so
 * there is nothing else to copy here. The legal-hold split is left behind on
 * purpose: the room shows totals. The type import below is the only edge from
 * the office to that agent's files, and it is erased at build time.
 */

import type { AgentOfficeTrustState } from "@/lib/agentOffice/live";
import type { TrustSafetyDigestView } from "@/lib/trustSafetyDigestRead";

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function agentOfficeTrustState(view: TrustSafetyDigestView): AgentOfficeTrustState {
  // Not the owner: the reader read nothing, and the room says so rather than showing a zero.
  if (view.permitted === false) return { kind: "not_permitted" };
  if (view.permitted !== true) return { kind: "unread" };

  const { activation, counts, observedAt, version } = view;
  // A switch or a time that is not what the reader promises is not one the room can show.
  if (activation.mode !== null && activation.mode !== "on" && activation.mode !== "off") return { kind: "unread" };
  if (activation.fault !== null && typeof activation.fault !== "string") return { kind: "unread" };
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) return { kind: "unread" };

  const base = {
    kind: "observed" as const,
    mode: activation.mode,
    fault: activation.fault,
    observedAt,
    version: version ?? null,
  };
  // Counts the section does not take (switch off, or a fault that stops counting) are null, never zero.
  if (counts === null) {
    return { ...base, overdue: null, imminent: null, imminentWithinDays: null, closedLate: null };
  }
  const overdue = counts.overdue.total;
  const imminent = counts.imminent.total;
  const closedLate = counts.closedLate.total;
  const days = counts.imminentWithinDays;
  if (!isCount(overdue) || !isCount(imminent) || !isCount(closedLate) || !isCount(days)) return { kind: "unread" };
  return { ...base, overdue, imminent, imminentWithinDays: days, closedLate };
}
