/**
 * Words for a decision line, shared by Today's "Decide now" list and the
 * Decisions inbox so both say the same thing about the same item.
 */
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { adminHomeMessages } from "@/lib/adminMessages/home";
import type { DecisionItem } from "@/lib/adminDecisionInbox";
import type { AdminTone } from "@/lib/adminUiCore";

export type AdminHomeCopy = AdminMessageShape<(typeof adminHomeMessages)["en"]>;

type Counted<T> = T | ((count: number) => T);

const resolve = <T,>(value: Counted<T>, count: number): T =>
  typeof value === "function" ? (value as (count: number) => T)(count) : value;

/** The line's title: the kind's own words, with the count for a counted line. */
export const decisionTitle = (item: DecisionItem, m: AdminHomeCopy): string =>
  resolve(m.decisions.kinds[item.kind].title as Counted<string>, item.count);

/** What happened, in plain words. */
export const decisionHappened = (item: DecisionItem, m: AdminHomeCopy): string =>
  resolve(m.decisions.kinds[item.kind].happened as Counted<string>, item.count);

/** The screen that owns the decision. */
export const decisionScreen = (item: DecisionItem, m: AdminHomeCopy): string =>
  m.decisions.kinds[item.kind].screen;

/**
 * The line under the title: the work queue's own subject (an e-mail, a
 * message) when there is one, otherwise where the decision is made.
 */
export const decisionSubtitle = (item: DecisionItem, m: AdminHomeCopy): string =>
  item.subject || m.decisions.kinds[item.kind].where;

/** "3h", "2d", "under 1h", or the no-start-time word. */
export const decisionAge = (hours: number | undefined, m: AdminHomeCopy): string => {
  if (hours === undefined) return m.age.none;
  if (hours < 1) return m.age.underAnHour;
  if (hours < 48) return m.age.hours(hours);
  return m.age.days(Math.floor(hours / 24));
};

/** A wait is amber after a day and red after two; an unknown start has no tone. */
export const decisionWaitTone = (hours: number | undefined): AdminTone =>
  hours === undefined ? "idle" : hours >= 48 ? "bad" : hours >= 24 ? "warn" : "idle";
