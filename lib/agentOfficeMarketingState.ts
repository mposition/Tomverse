/**
 * The Marketing room's state, from what the server read.
 *
 * Status only. How many posts wait for a person and since when, the drafts and
 * publish switches, when the generator last ran and how many calls it made this
 * UTC month. A draft's text, a fact's value, a URL or an amount of money is
 * never read here. A part the console could not read is null in the overview,
 * and stays null: it is never turned into zero.
 */

import type { AgentOfficeMarketingState, AgentOfficeMarketingSwitch } from "@/lib/agentOffice/live";

const switchState = (value: string): AgentOfficeMarketingSwitch =>
  value === "on" ? "on" : value === "off" ? "off" : "unreadable";

export function agentOfficeMarketingState(input: {
  overview: {
    pending: { count: number; oldestAt: string | null } | null;
    llm: { calls: number } | null;
    lastRun: { at: string | null } | null;
  };
  /** The console's own switch states (`MarketingSwitchState`). */
  drafts: string;
  publish: string;
}): AgentOfficeMarketingState {
  const { overview } = input;
  // The overview as a whole could not be read: every part is null.
  if (overview.pending === null && overview.llm === null && overview.lastRun === null) return { kind: "unread" };
  return {
    kind: "observed",
    // Any state but on or off (including one this room does not know) is an unread switch, never off.
    drafts: switchState(input.drafts),
    publish: switchState(input.publish),
    pending: overview.pending ? { count: overview.pending.count, oldestAt: overview.pending.oldestAt } : null,
    lastRun: overview.lastRun ? { at: overview.lastRun.at } : null,
    calls: overview.llm ? overview.llm.calls : null,
  };
}
