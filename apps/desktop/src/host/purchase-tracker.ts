import { randomUUID } from "node:crypto";
import {
  purchaseItem,
  type BillingUsage, type CheckoutOutcome, type PurchaseIntent, type PurchaseItem, type PurchaseRecord,
} from "../billing-contract";

/**
 * The checkout attempts the connected account started in this app and the account has not shown yet.
 *
 * It lives in the main process, one per account session, so a record outlives the Plan tab, the
 * Settings screen and the renderer: the account check after a checkout window closes runs here
 * whether or not anything is on screen, and a second checkout of the same item is held back here.
 * Whether a payment went through is only ever read from the account the server reports; the
 * window's address sets the wording at most.
 *
 * One record per checkout attempt (one Stripe Checkout Session), so an item (the subscription, or
 * one credit pack) can have several unconfirmed attempts: a repeat the customer chose over the
 * warning adds one and never removes the earlier one. The account does not say which attempt a
 * change belongs to, so `landedPacks` and `landedSubscription` confirm attempts by count, oldest
 * first, and only as many as the change proves; anything ambiguous stays unconfirmed. While an item
 * has any unconfirmed attempt, a new checkout of it is held back with a warning.
 *
 * A record ends when: the account shows it (it is then kept, as "confirmed", only until the next
 * checkout starts), it is older than PURCHASE_RECORD_TTL_MS (each attempt counts from its own
 * start), the account session ends (sign-out or a switch of account abort the session signal and
 * every record is dropped; a checkout window the session closes is not checked for the account that
 * left), or the app quits (the records are memory only, so a restarted app has none and does not
 * warn about a payment left unconfirmed before the restart). Closing the checkout window does not end
 * a record, it starts the account check. There is deliberately no way to dismiss an unconfirmed
 * record, since that would be a shortcut past the warning; the screen shows when each attempt began,
 * and the customer can always choose to pay again from the warning.
 */

/** The account reads after a checkout window ends, however it ended, and after "Check again". */
export const PURCHASE_CHECK_ATTEMPTS = 5;
export const PURCHASE_CHECK_INTERVAL_MS = 2_500;
export const CHECK_AGAIN_ATTEMPTS = 3;
/**
 * How long a record is kept: Stripe's default Checkout Session lifetime of 24 hours (the server sets
 * a shorter one only for promotion checkouts), the longest the Session a record stands for can still
 * be paid. A webhook Stripe redelivers later than that would still land, unwarned.
 */
export const PURCHASE_RECORD_TTL_MS = 24 * 60 * 60_000;
/** How long the customer has to answer the warning before a repeat needs a fresh one. */
export const REPEAT_HOLD_TTL_MS = 10 * 60_000;

type AccountPlan = BillingUsage["plan"];

/** An unconfirmed credit-pack attempt, in start order: where its growth is counted from, and its pack's size. */
export type PendingPack = { id: string; item: PurchaseItem; before: number; credits: number };

/**
 * Which unconfirmed credit-pack attempts one purchased balance proves landed, and the baselines the
 * others keep. Growth is the most any attempt's balance has grown since its baseline; only a pending
 * attempt can have caused it, and spending can only have reduced it. For each pack, the growth beyond
 * what every other pack's pending attempts could add is the part only this pack can explain; the
 * attempts it proves are the fewest of this pack's that cover it (largest sizes first), and that many
 * of its oldest attempts are confirmed. Their credits are then taken out of the remaining attempts'
 * growth. Anything another pack could explain confirms nothing. Infinity, an unknown size, explains any
 * growth, so it never lets another pack be confirmed, and it proves one attempt of its own at most.
 */
export function landedPacks(balance: number, pending: readonly PendingPack[]): { landed: string[]; pending: PendingPack[] } {
  let left = pending.map((attempt) => ({ ...attempt }));
  const landed: string[] = [];
  for (;;) {
    if (!left.length) break;
    const growth = Math.max(...left.map((attempt) => balance - attempt.before));
    const proven: PendingPack[] = [];
    let credited = 0;
    for (const item of new Set(left.map((attempt) => attempt.item))) {
      const own = left.filter((attempt) => attempt.item === item);
      const others = left.reduce((sum, attempt) => attempt.item === item ? sum : sum + attempt.credits, 0);
      const excess = growth - others;
      const sizes = own.map((attempt) => attempt.credits).sort((a, b) => b - a);
      let count = 0;
      let covered = 0;
      while (count < sizes.length && covered < excess) covered += sizes[count++];
      proven.push(...own.slice(0, count));
      credited += sizes.slice(0, count).reduce((sum, size) => sum + size, 0);
    }
    if (!proven.length) break;
    landed.push(...proven.map(({ id }) => id));
    left = left.filter((attempt) => !proven.includes(attempt));
    for (const attempt of left) attempt.before += credited;
  }
  return { landed, pending: left };
}

/** An unconfirmed subscription attempt, in start order: the plan it buys and the plan it counts a change from. */
export type PendingSubscription = { id: string; tier: "Pro" | "Max"; before: AccountPlan };

/**
 * The one subscription attempt a reported plan proves: the oldest whose plan the account now shows,
 * changed from its baseline. The other attempts then count from the plan now shown, so the same
 * change never confirms a second attempt; they stay unconfirmed until their records expire.
 */
export function landedSubscription(plan: AccountPlan, pending: readonly PendingSubscription[]):
  { landed: string | null; pending: PendingSubscription[] } {
  const proven = pending.find((attempt) => attempt.tier === plan && attempt.before !== plan);
  if (!proven) return { landed: null, pending: pending.map((attempt) => ({ ...attempt })) };
  return { landed: proven.id, pending: pending.filter((attempt) => attempt !== proven).map((attempt) => ({ ...attempt, before: plan })) };
}

type Entry = PurchaseRecord & {
  /** The plan this attempt counts a change from. */
  plan: AccountPlan;
  /** The purchased balance this attempt's growth is counted from (raised as other attempts are confirmed). */
  purchased: number;
  /** The pack's credits; Infinity when unknown. */
  credits: number;
  run: number;
};

export type PurchaseAdmission = { kind: "proceed" } | { kind: "settled" } | { kind: "held"; hold: string };

const tierOf = (intent: PurchaseIntent) => intent.kind === "subscription" && intent.planId === "max" ? "Max" as const : "Pro" as const;

export function createPurchaseTracker(deps: {
  /** The account's usage, or null when it could not be read. */
  read: () => Promise<BillingUsage | null>;
  /** The records changed. */
  changed: () => void;
  /** The account session: when it ends, every record is dropped. */
  signal: AbortSignal;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  token?: () => string;
}) {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const token = deps.token ?? randomUUID;
  // In start order: oldest first.
  let entries: Entry[] = [];
  // The warning's one-time answer, per item.
  const holds = new Map<PurchaseItem, { token: string; until: number }>();
  const changed = () => { if (!deps.signal.aborted) deps.changed(); };
  deps.signal.addEventListener("abort", () => { entries = []; holds.clear(); deps.changed(); }, { once: true });

  const unconfirmed = (item: PurchaseItem) => entries.filter((entry) => entry.item === item && entry.stage !== "confirmed");

  function forgetHolds() {
    for (const item of holds.keys()) if (!unconfirmed(item).length) holds.delete(item);
  }

  function prune() {
    const cutoff = now() - PURCHASE_RECORD_TTL_MS;
    const kept = entries.filter((entry) => entry.stage === "open" || entry.stage === "checking" || entry.startedAt > cutoff);
    const removed = kept.length !== entries.length;
    entries = kept;
    forgetHolds();
    return removed;
  }

  function confirm(entry: Entry) {
    entry.stage = "confirmed";
    entry.run += 1;
  }

  /** Applies one account read to every unconfirmed attempt; returns the ones it confirmed. */
  function settle(usage: BillingUsage): Entry[] {
    const confirmed: Entry[] = [];
    const subscriptions = entries.filter((entry) => entry.intent.kind === "subscription" && entry.stage !== "confirmed");
    const subscription = landedSubscription(usage.plan,
      subscriptions.map((entry) => ({ id: entry.id, tier: tierOf(entry.intent), before: entry.plan })));
    for (const entry of subscriptions) {
      if (entry.id === subscription.landed) { confirm(entry); confirmed.push(entry); }
      else entry.plan = subscription.pending.find(({ id }) => id === entry.id)?.before ?? entry.plan;
    }
    const packs = entries.filter((entry) => entry.intent.kind === "credits" && entry.stage !== "confirmed");
    const credits = landedPacks(usage.balances.purchasedRemainingCredits,
      packs.map((entry) => ({ id: entry.id, item: entry.item, before: entry.purchased, credits: entry.credits })));
    for (const entry of packs) {
      if (credits.landed.includes(entry.id)) { confirm(entry); confirmed.push(entry); }
      else entry.purchased = credits.pending.find(({ id }) => id === entry.id)?.before ?? entry.purchased;
    }
    if (confirmed.length) forgetHolds();
    return confirmed;
  }

  /** Reads the account until the targets are confirmed or the attempts run out; the rest end unconfirmed. */
  async function check(targets: Entry[], attempts: number) {
    const runs = new Map(targets.map((entry) => [entry, ++entry.run]));
    for (const entry of targets) entry.stage = "checking";
    changed();
    const mine = () => deps.signal.aborted ? []
      : targets.filter((entry) => entries.includes(entry) && entry.run === runs.get(entry) && entry.stage === "checking");
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await wait(PURCHASE_CHECK_INTERVAL_MS);
      if (!mine().length) return;
      const usage = await deps.read().catch(() => null);
      if (!mine().length) return;
      if (usage && settle(usage).length) changed();
      if (!mine().length) return;
    }
    for (const entry of mine()) entry.stage = "unconfirmed";
    changed();
  }

  return {
    /**
     * Before a new checkout, with the account as it was just read: "proceed", "settled" when that read
     * showed the item's last unconfirmed attempts, or "held" with a one-time token while the item has any
     * unconfirmed attempt. Only a request carrying the token this tracker issued for this item, within
     * REPEAT_HOLD_TTL_MS, goes ahead; a token the renderer made up is answered with a new hold.
     *
     * An attempt that came back through the server's cancel page holds nothing back (owner decision
     * 2026-11-26): the person left Stripe's page without paying. Its record stays and is still checked
     * against the account, so a payment that lands after all is confirmed like any other.
     */
    admit(intent: PurchaseIntent, usage: BillingUsage, hold?: string): PurchaseAdmission {
      let dirty = prune();
      const settled = settle(usage);
      if (settled.length) dirty = true;
      if (dirty) changed();
      const item = purchaseItem(intent);
      if (!unconfirmed(item).some((entry) => !entry.cancelled)) {
        return settled.some((entry) => entry.item === item) ? { kind: "settled" } : { kind: "proceed" };
      }
      const issued = holds.get(item);
      if (hold && issued?.token === hold && issued.until > now()) {
        holds.delete(item);
        return { kind: "proceed" };
      }
      const next = { token: token(), until: now() + REPEAT_HOLD_TTL_MS };
      holds.set(item, next);
      return { kind: "held", hold: next.token };
    },

    /** A checkout window opened for a new attempt; `usage` is the account read just before. */
    begin(intent: PurchaseIntent, usage: BillingUsage, credits: number) {
      if (deps.signal.aborted) return;
      prune();
      // Confirmations already shown give way to the new purchase; every unconfirmed attempt stays.
      entries = entries.filter((entry) => entry.stage !== "confirmed");
      entries.push({
        id: token(), item: purchaseItem(intent), intent, stage: "open", cancelled: false, startedAt: now(),
        plan: usage.plan, purchased: usage.balances.purchasedRemainingCredits, credits, run: 0,
      });
      changed();
    },

    /** The checkout window closed: the account is read the same way whatever page it ended on. */
    windowClosed(outcome: CheckoutOutcome) {
      if (deps.signal.aborted) return;
      const entry = entries.find((candidate) => candidate.stage === "open");
      if (!entry) return;
      entry.cancelled = outcome === "cancelled";
      void check([entry], PURCHASE_CHECK_ATTEMPTS);
    },

    /** "Check again" for an item's unconfirmed attempts; false when there is none to check. */
    checkAgain(item: PurchaseItem): boolean {
      const targets = deps.signal.aborted ? [] : entries.filter((entry) => entry.item === item && entry.stage === "unconfirmed");
      if (!targets.length) return false;
      void check(targets, CHECK_AGAIN_ATTEMPTS);
      return true;
    },

    records(): PurchaseRecord[] {
      if (deps.signal.aborted) return [];
      prune();
      return entries.map(({ id, item, intent, stage, cancelled, startedAt }) => ({ id, item, intent: { ...intent }, stage, cancelled, startedAt }));
    },
  };
}

export type PurchaseTracker = ReturnType<typeof createPurchaseTracker>;
