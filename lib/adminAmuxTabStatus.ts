import {
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  autoPromotionApplyPermitted,
} from "@/lib/amux/autoPromotionCore";

/**
 * The status chip on each AMUX section tab.
 *
 * Contract: docs/ui-contracts/admin-console-ia.md, rule 8 -- the console
 * states only what it read. A chip saying "apply off" is a claim about a
 * switch, so it is computed from that switch: the same environment variable
 * and the same shipped code latch the section's own API route passes to the
 * same `*ApplyPermitted` function. Written as a string, it would go on saying
 * "off" the day an operator turned apply on.
 *
 * Each reading is taken from the environment of the process that renders the
 * page, which is the process whose route would answer the section's writes.
 * `tests/adminAmuxTabStatus.test.mjs` pins each tab to its route's variable.
 */

export type AmuxTabStatus =
  /** Auto-promotion while its server switch is closed. */
  | "behind_server_switch"
  /** Auto-promotion while its server switch is open. */
  | "server_switch_on"
  /** A section with no write path for this viewer. */
  | "read_only";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Whether each gated section's writes are open, keyed by tab id. Intake,
 * reconciliation, backlog metadata, recommendation and promotion have no
 * switch since 2026-11-16, and the catalog import (whose code latch never
 * opened) was removed on 2026-11-18, so none of them carries a chip.
 */
export const AMUX_TAB_SWITCHES = {
  "auto-promotion": (env: Environment) =>
    autoPromotionApplyPermitted({
      envValue: env[AUTO_PROMOTION_APPLY_ENV],
      codeLatch: AUTO_PROMOTION_CODE_LATCH,
    }),
} as const;

export type AmuxSwitchedTab = keyof typeof AMUX_TAB_SWITCHES;

/** The chip for a gated section, read from its switch. */
export const amuxSwitchedTabStatus = (
  tab: AmuxSwitchedTab,
  env: Environment = process.env
): AmuxTabStatus => {
  return AMUX_TAB_SWITCHES[tab](env) ? "server_switch_on" : "behind_server_switch";
};

/** Chips for every tab in `tabs` that has a switch. */
export const amuxSwitchedTabStatuses = (
  tabs: readonly AmuxSwitchedTab[],
  env: Environment = process.env
): Partial<Record<AmuxSwitchedTab, AmuxTabStatus>> =>
  Object.fromEntries(tabs.map((tab) => [tab, amuxSwitchedTabStatus(tab, env)]));

/** A status that says writes are open, drawn so it is not read past. */
export const amuxTabStatusIsOpen = (status: AmuxTabStatus) =>
  status === "server_switch_on";

/** Statuses keyed by tab id, turned into the tab strip's chips. */
export const amuxTabChips = (
  statuses: Readonly<Record<string, AmuxTabStatus | undefined>>,
  labels: Readonly<Record<AmuxTabStatus, string>>
): Record<string, { label: string; attention: boolean }> =>
  Object.fromEntries(
    Object.entries(statuses).flatMap(([tab, status]) =>
      status
        ? [[tab, { label: labels[status], attention: amuxTabStatusIsOpen(status) }]]
        : []
    )
  );
