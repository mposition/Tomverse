import {
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  autoPromotionApplyPermitted,
} from "@/lib/amux/autoPromotionCore";
import {
  BACKLOG_METADATA_APPLY_ENV,
  BACKLOG_METADATA_CODE_LATCH,
  backlogMetadataApplyPermitted,
} from "@/lib/amux/backlogMetadataCore";
import {
  BOARD_IMPORT_APPLY_CODE_LATCH,
  BOARD_IMPORT_APPLY_ENV,
  boardImportApplyPermitted,
} from "@/lib/amux/boardImportCore";
import {
  BOARD_PROMOTION_APPLY_CODE_LATCH,
  BOARD_PROMOTION_APPLY_ENV,
  boardPromotionApplyPermitted,
} from "@/lib/amux/boardPromotionCore";
import {
  AMUX_RECONCILIATION_APPLY_ENV,
  amuxReconciliationApplyPermitted,
} from "@/lib/amux/boardReconciliationCore";
import {
  AMUX_INTAKE_APPLY_ENV,
  amuxIntakeApplyPermitted,
} from "@/lib/amux/intakeCore";
import {
  RECOMMENDATION_APPLY_ENV,
  RECOMMENDATION_CODE_LATCH,
  recommendationApplyPermitted,
} from "@/lib/amux/recommendationPoolCore";
import { AMUX_V22_AUTO_PROMOTION_ENV,
  amuxV22AutoPromotionEnabled } from "@/lib/amux/v22AutoPromotionCore";

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
  /** A preview screen whose apply switch is closed. */
  | "preview_apply_off"
  /** A preview screen whose apply switch is open. */
  | "apply_on"
  /** Auto-promotion while its server switch is closed. */
  | "behind_server_switch"
  /** Auto-promotion while its server switch is open. */
  | "server_switch_on"
  /** A section with no write path for this viewer. */
  | "read_only";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Whether each gated section's writes are open, keyed by tab id.
 *
 * `import` stays closed whatever the environment says, because its code
 * latch ships false -- and that is what its route would answer too.
 */
export const AMUX_TAB_SWITCHES = {
  intake: (env: Environment) => amuxIntakeApplyPermitted(env[AMUX_INTAKE_APPLY_ENV]),
  import: (env: Environment) =>
    boardImportApplyPermitted({
      envValue: env[BOARD_IMPORT_APPLY_ENV],
      codeLatch: BOARD_IMPORT_APPLY_CODE_LATCH,
    }),
  reconciliation: (env: Environment) =>
    amuxReconciliationApplyPermitted(env[AMUX_RECONCILIATION_APPLY_ENV]),
  metadata: (env: Environment) =>
    backlogMetadataApplyPermitted({
      envValue: env[BACKLOG_METADATA_APPLY_ENV],
      codeLatch: BACKLOG_METADATA_CODE_LATCH,
    }),
  recommendation: (env: Environment) =>
    recommendationApplyPermitted({
      envValue: env[RECOMMENDATION_APPLY_ENV],
      codeLatch: RECOMMENDATION_CODE_LATCH,
    }),
  promotion: (env: Environment) =>
    boardPromotionApplyPermitted({
      envValue: env[BOARD_PROMOTION_APPLY_ENV],
      codeLatch: BOARD_PROMOTION_APPLY_CODE_LATCH,
    }),
  "auto-promotion": (env: Environment) =>
    amuxV22AutoPromotionEnabled(env[AMUX_V22_AUTO_PROMOTION_ENV]) ||
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
  const open = AMUX_TAB_SWITCHES[tab](env);
  if (tab === "auto-promotion") {
    return open ? "server_switch_on" : "behind_server_switch";
  }
  return open ? "apply_on" : "preview_apply_off";
};

/** Chips for every tab in `tabs` that has a switch. */
export const amuxSwitchedTabStatuses = (
  tabs: readonly AmuxSwitchedTab[],
  env: Environment = process.env
): Partial<Record<AmuxSwitchedTab, AmuxTabStatus>> =>
  Object.fromEntries(tabs.map((tab) => [tab, amuxSwitchedTabStatus(tab, env)]));

/** A status that says writes are open, drawn so it is not read past. */
export const amuxTabStatusIsOpen = (status: AmuxTabStatus) =>
  status === "apply_on" || status === "server_switch_on";

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
