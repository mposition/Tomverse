/**
 * Whether one viewer may act on one starter card, and which cards reach the
 * screen.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md sections 2 and 3.
 *
 * Pure: the same function answers in the browser, in an RSC shell and in a
 * test. It takes facts, not a session and not a database.
 *
 * ## Three states, and why `locked` is not `hidden`
 *
 * `hidden` means the thing does not exist in this deployment. `locked` means
 * it exists and this viewer cannot reach it yet. Collapsing them in either
 * direction is a real defect with a real victim:
 *
 *   * Showing a `locked` card as `hidden` is the failure
 *     `docs/ui-contracts/image-generation-workspace.md` names -- a feature the
 *     account could buy, that it never learns exists.
 *   * Showing a `hidden` card as `locked` tells somebody a feature is waiting
 *     behind a plan when nothing is behind it at all. That is a sales promise
 *     the build cannot keep.
 *
 * A `locked` card states its requirement up front and routes to sign-in or to
 * pricing. It is never a card that looks runnable and refuses on click.
 *
 * ## Fail-closed
 *
 * Anything this module cannot decide is `hidden`. An unknown flag key, a
 * capability id that is not in `STARTER_CAPABILITIES`, a plan string that is
 * not a tier -- none of them produce a best guess. A card is a promise, and a
 * promise made on a guess is the thing the gate script and this default exist
 * together to prevent.
 */

import {
  CHAT_STARTER_CATALOG,
  isStarterCapability,
  type ChatStarterEntry,
  type StarterCapability,
} from "@/lib/chatStarterCatalog";
import type { ModelTier } from "@/lib/models";

/** Ascending. Index comparison is the plan test; there is no other ordering. */
const PLAN_ORDER: readonly ModelTier[] = ["Free", "Pro", "Max"];

export type StarterLockReason = "sign_in_required" | "plan_required";

export type StarterHiddenReason =
  /** A flag the entry names is not in the deployment's enabled set. */
  | "feature_flag_off"
  /** A flag key nothing in the repository recognises. Never a guess. */
  | "unknown_flag"
  /** A capability the entry names did not resolve on this request. */
  | "capability_unavailable"
  /** A capability id `STARTER_CAPABILITIES` does not define. */
  | "unknown_capability"
  /** The viewer's plan is not a tier this module can order. */
  | "unresolved_plan";

export type StarterAvailability =
  | { state: "available" }
  | { state: "locked"; reason: "sign_in_required" }
  /**
   * `minimumPlan` is required on this branch rather than optional on both.
   *
   * The card has to name the tier, and an optional field would have made the
   * component carry a fallback -- which is a guess about somebody's money
   * printed on screen. A branch that cannot be built without the tier cannot
   * be rendered without it either.
   */
  | { state: "locked"; reason: "plan_required"; minimumPlan: ModelTier }
  | { state: "hidden"; reason: StarterHiddenReason };

export type StarterViewer = {
  signedIn: boolean;
  /**
   * The viewer's plan tier, or `null` when it has not resolved.
   *
   * `null` is not "Free". A guest has no plan and is refused by `signedIn`
   * before this is read; a signed-in account whose plan has not loaded is
   * `unresolved_plan` and its plan-gated cards stay hidden for that frame,
   * rather than being shown as locked and then quietly unlocking.
   */
  plan: ModelTier | null;
  /** `AppSetting` keys the deployment has on. Resolved server-side. */
  enabledFlags: ReadonlySet<string>;
  /** Capabilities that resolved on this request. Resolved server-side. */
  modelCapabilities: ReadonlySet<StarterCapability>;
  /**
   * Every flag key this deployment knows how to answer.
   *
   * Separate from `enabledFlags` because "off" and "nobody could tell me" are
   * different answers, and only the first one is a rollout state. A key that
   * is in neither set means the shell was asked about a flag it does not read,
   * which is a wiring defect, so the card is hidden and says `unknown_flag`
   * rather than silently reading as off.
   */
  knownFlags: ReadonlySet<string>;
};

/**
 * How many cards may reach the screen at once.
 *
 * The registry may grow without limit; a first screen may not. Six is the
 * ceiling because the surface has to fit a 320px viewport at 200% text scaling
 * alongside the composer, and because a gallery long enough to need its own
 * scroll has stopped being an entry point.
 *
 * Owned here rather than by the component, so the number is testable and so a
 * second surface cannot pick a different one.
 */
export const CHAT_STARTER_MAX_VISIBLE = 6;

const planAtLeast = (plan: ModelTier, minimum: ModelTier): boolean =>
  PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(minimum);

/**
 * One card, one viewer.
 *
 * Order of the tests is the contract, not an implementation detail. Existence
 * is decided before entitlement, because a feature that is switched off is not
 * a feature somebody could unlock by paying -- asking about the plan first
 * would produce "upgrade to Pro" for a card whose feature nobody can run.
 */
export function chatStarterAvailability(
  entry: ChatStarterEntry,
  viewer: StarterViewer
): StarterAvailability {
  // 1. Does the feature exist here at all?
  for (const flagKey of entry.requires.flagKeys ?? []) {
    if (!viewer.knownFlags.has(flagKey)) {
      return { state: "hidden", reason: "unknown_flag" };
    }
    if (!viewer.enabledFlags.has(flagKey)) {
      return { state: "hidden", reason: "feature_flag_off" };
    }
  }

  // 2. Can it run on this request?
  for (const capability of entry.requires.capabilities ?? []) {
    if (!isStarterCapability(capability)) {
      return { state: "hidden", reason: "unknown_capability" };
    }
    if (!viewer.modelCapabilities.has(capability)) {
      return { state: "hidden", reason: "capability_unavailable" };
    }
  }

  // 3. May this viewer reach it? From here the answers are locks, never
  //    hiding: the feature is real and the requirement is worth stating.
  if (entry.requires.signedIn && !viewer.signedIn) {
    return { state: "locked", reason: "sign_in_required" };
  }

  const minimumPlan = entry.requires.minimumPlan;
  if (minimumPlan) {
    // A guest reaching here has no plan to compare, and sign-in is the
    // requirement to state -- pricing would be the second step, not the first.
    if (!viewer.signedIn) {
      return { state: "locked", reason: "sign_in_required" };
    }
    if (viewer.plan === null) {
      return { state: "hidden", reason: "unresolved_plan" };
    }
    if (!planAtLeast(viewer.plan, minimumPlan)) {
      return { state: "locked", reason: "plan_required", minimumPlan };
    }
  }

  return { state: "available" };
}

export type VisibleStarterCard = {
  entry: ChatStarterEntry;
  availability: Extract<StarterAvailability, { state: "available" | "locked" }>;
};

/**
 * One slot the runnable cards may not take while a locked card exists.
 *
 * ## Why a reservation rather than a plain sort
 *
 * The first version ranked runnable cards ahead of locked ones and cut at the
 * limit, on the reasoning that somebody opening a new chat is looking for
 * something to do rather than a list of things to buy. The e2e spec disproved
 * it on the default configuration: a guest with both feature flags off has six
 * runnable cards and one locked one, so the ceiling removed the lock and **the
 * gallery disclosed nothing at all**.
 *
 * That is not a ranking preference, it is the disclosure rule failing in the
 * ordinary case. `docs/ui-contracts/image-generation-workspace.md` requires a
 * requirement to be stated up front rather than discovered, and a surface that
 * only ever shows what the viewer can already do cannot state one. So the
 * ceiling now costs a runnable card instead of the lock.
 *
 * One slot, not a proportion: the point is that a lock is reachable, not that
 * the screen fills with prices.
 */
const RESERVED_LOCKED_SLOTS = 1;

/**
 * What the screen shows, in the order it shows it.
 *
 * Hidden entries are dropped, runnable cards come before locked ones, and the
 * result is cut to `CHAT_STARTER_MAX_VISIBLE` -- with one slot held back for a
 * locked card whenever one exists and the limit has room for both (see
 * `RESERVED_LOCKED_SLOTS`).
 *
 * Sorting is stable within each group, so the registry's own order is what
 * decides ties and the surface never reshuffles between renders.
 */
export function selectVisibleStarterCards(
  viewer: StarterViewer,
  catalog: readonly ChatStarterEntry[] = CHAT_STARTER_CATALOG,
  limit: number = CHAT_STARTER_MAX_VISIBLE
): VisibleStarterCard[] {
  const ceiling = Math.max(0, limit);
  const resolved: VisibleStarterCard[] = [];
  for (const entry of catalog) {
    const availability = chatStarterAvailability(entry, viewer);
    if (availability.state === "hidden") continue;
    resolved.push({ entry, availability });
  }
  const runnable = resolved.filter(
    (card) => card.availability.state === "available"
  );
  const locked = resolved.filter((card) => card.availability.state === "locked");

  // The reservation only applies where both can fit. At a ceiling of one there
  // is nothing to balance, and holding the single slot for a lock would leave
  // a first screen with nothing on it a person could do.
  const reserved =
    locked.length > 0 && ceiling > RESERVED_LOCKED_SLOTS
      ? Math.min(RESERVED_LOCKED_SLOTS, locked.length)
      : 0;
  const shown = [
    ...runnable.slice(0, ceiling - reserved),
    ...locked,
  ].slice(0, ceiling);
  return shown;
}
