import { randomUUID } from "node:crypto";
import {
  purchaseConfirmed, purchaseItem,
  type BillingUsage, type CheckoutOutcome, type PurchaseIntent, type PurchaseItem, type PurchaseRecord,
} from "../billing-contract";

/**
 * The purchases the connected account started in this app and the account has not shown yet.
 *
 * It lives in the main process, one per account session, so a record outlives the Plan tab, the
 * Settings screen and the renderer: the account check after a checkout window closes runs here
 * whether or not anything is on screen, and a second checkout of the same item is held back here.
 * Whether a payment went through is only ever read from the account the server reports; the
 * window's address sets the wording at most.
 *
 * A record ends when: the account shows the purchase (it is then kept, as "confirmed", only until
 * the next checkout starts), the account session ends (sign-out or a switch of account abort the
 * session signal and every record is dropped; a checkout window the session closes is not checked
 * for the account that left), the app quits (the records are memory only), a newer checkout of the
 * same item replaces it (only after the customer chose that over the warning), or it is older than
 * PURCHASE_RECORD_TTL_MS. Nothing is written to disk, so a restarted app has no records: a payment
 * left unconfirmed before the restart is not warned about afterwards. Closing the checkout window
 * does not end a record, it starts the account check. There is no other way to dismiss an
 * unconfirmed record; the warning can always be passed by the customer's own choice.
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

type Entry = PurchaseRecord & {
  /** The plan when the checkout began (a subscription is confirmed when it changes to the one bought). */
  plan: BillingUsage["plan"];
  /** The purchased balance not yet explained by a confirmed pack: where this pack's growth is counted from. */
  purchased: number;
  /** The pack's credits; Infinity when unknown, so it could explain any growth. */
  credits: number;
  run: number;
  hold?: { token: string; until: number };
};

export type PurchaseAdmission = { kind: "proceed" } | { kind: "settled" } | { kind: "held"; hold: string };

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
  const entries = new Map<PurchaseItem, Entry>();
  const changed = () => { if (!deps.signal.aborted) deps.changed(); };
  deps.signal.addEventListener("abort", () => { entries.clear(); deps.changed(); }, { once: true });

  function prune() {
    const cutoff = now() - PURCHASE_RECORD_TTL_MS;
    let removed = false;
    for (const [item, entry] of entries) {
      if (entry.stage !== "open" && entry.stage !== "checking" && entry.startedAt <= cutoff) {
        entries.delete(item);
        removed = true;
      }
    }
    return removed;
  }

  function confirm(entry: Entry) {
    entry.stage = "confirmed";
    entry.run += 1;
    entry.hold = undefined;
  }

  /** Applies one account read to every record not yet confirmed; returns the ones it confirmed. */
  function settle(usage: BillingUsage): Entry[] {
    const confirmed: Entry[] = [];
    const subscription = entries.get("subscription");
    if (subscription && subscription.stage !== "confirmed" &&
        purchaseConfirmed(subscription.intent, { plan: subscription.plan, balances: usage.balances }, usage)) {
      confirm(subscription);
      confirmed.push(subscription);
    }
    // The purchased balance does not say which pack landed. A pack counts as landed only when the balance
    // grew past what every other unconfirmed pack could explain; its credits are then taken out of the
    // others' growth. Spending in the meantime can only keep a pack unconfirmed, never confirm one.
    const balance = usage.balances.purchasedRemainingCredits;
    for (;;) {
      const packs = [...entries.values()].filter((entry) => entry.intent.kind === "credits" && entry.stage !== "confirmed");
      const landed = packs.find((entry) =>
        balance - entry.purchased > packs.reduce((sum, other) => other === entry ? sum : sum + other.credits, 0));
      if (!landed) break;
      confirm(landed);
      confirmed.push(landed);
      for (const other of packs) if (other !== landed) other.purchased += landed.credits;
    }
    return confirmed;
  }

  async function check(entry: Entry, attempts: number) {
    const run = ++entry.run;
    entry.stage = "checking";
    changed();
    const current = () => !deps.signal.aborted && entries.get(entry.item) === entry && entry.run === run;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await wait(PURCHASE_CHECK_INTERVAL_MS);
      if (!current()) return;
      const usage = await deps.read().catch(() => null);
      if (!current()) return;
      const confirmed = usage ? settle(usage) : [];
      if (confirmed.length) changed();
      if (confirmed.includes(entry)) return;
    }
    entry.stage = "unconfirmed";
    changed();
  }

  return {
    /**
     * Before a new checkout, with the account as it was just read: "proceed", "settled" when that read
     * showed the earlier payment of the same item, or "held" with a one-time token. Only a request
     * carrying the token this tracker issued for this item, within REPEAT_HOLD_TTL_MS, goes ahead past
     * an unconfirmed record; a token the renderer made up is answered with a new hold.
     */
    admit(intent: PurchaseIntent, usage: BillingUsage, hold?: string): PurchaseAdmission {
      let dirty = prune();
      const settled = settle(usage);
      if (settled.length) dirty = true;
      if (dirty) changed();
      const earlier = entries.get(purchaseItem(intent));
      if (!earlier) return { kind: "proceed" };
      if (earlier.stage === "confirmed") return settled.includes(earlier) ? { kind: "settled" } : { kind: "proceed" };
      if (hold && earlier.hold?.token === hold && earlier.hold.until > now()) {
        earlier.hold = undefined;
        return { kind: "proceed" };
      }
      earlier.hold = { token: token(), until: now() + REPEAT_HOLD_TTL_MS };
      return { kind: "held", hold: earlier.hold.token };
    },

    /** A checkout window opened for this purchase; `usage` is the account read just before. */
    begin(intent: PurchaseIntent, usage: BillingUsage, credits: number) {
      if (deps.signal.aborted) return;
      prune();
      // Confirmations already shown give way to the new purchase; unconfirmed records of other items stay.
      for (const [item, entry] of entries) if (entry.stage === "confirmed") entries.delete(item);
      const item = purchaseItem(intent);
      entries.delete(item);
      entries.set(item, {
        id: token(), item, intent, stage: "open", cancelled: false, startedAt: now(),
        plan: usage.plan, purchased: usage.balances.purchasedRemainingCredits, credits, run: 0,
      });
      changed();
    },

    /** The checkout window closed: the account is read the same way whatever page it ended on. */
    windowClosed(outcome: CheckoutOutcome) {
      if (deps.signal.aborted) return;
      const entry = [...entries.values()].find((candidate) => candidate.stage === "open");
      if (!entry) return;
      entry.cancelled = outcome === "cancelled";
      void check(entry, PURCHASE_CHECK_ATTEMPTS);
    },

    /** "Check again" on an unconfirmed record; false when there is none to check. */
    checkAgain(item: PurchaseItem): boolean {
      const entry = entries.get(item);
      if (deps.signal.aborted || !entry || entry.stage !== "unconfirmed") return false;
      void check(entry, CHECK_AGAIN_ATTEMPTS);
      return true;
    },

    records(): PurchaseRecord[] {
      if (deps.signal.aborted) return [];
      prune();
      return [...entries.values()].map(({ id, item, intent, stage, cancelled, startedAt }) =>
        ({ id, item, intent: { ...intent }, stage, cancelled, startedAt }));
    },
  };
}

export type PurchaseTracker = ReturnType<typeof createPurchaseTracker>;
