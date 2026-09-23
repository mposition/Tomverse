/**
 * Which Marketing console sections hold anything yet, and which stage fills
 * them.
 *
 * Kept free of `prisma` and of React so the route, the panel and the tests all
 * read the same table. The distinction it draws is the one
 * docs/policy/marketing-automation.md §14 makes: a section whose feature
 * belongs to a later stage is *not* an empty list. An empty list says "nothing
 * is waiting"; an unavailable section says "nothing writes this yet", and the
 * two are different answers to "why is this page blank".
 */

export const MARKETING_CONSOLE_SECTIONS = [
  "queue",
  "published",
  "accounts",
  "experiments",
  "reports",
  "comments",
] as const;

export type MarketingConsoleSection = (typeof MARKETING_CONSOLE_SECTIONS)[number];

/** How many rows a section lists. The panel states this number on screen. */
export const MARKETING_READ_PAGE_SIZE = 20;

export type MarketingSectionAvailability =
  | { available: true }
  | { available: false; stage: "S4" | "S5" };

/**
 * Stage ownership, from policy §14's stage table.
 *
 * Comment monitoring is S4 and landing experiments are S5, so their sections
 * render as future-stage affordances rather than as queues that are always
 * empty.
 */
export function marketingSectionAvailability(
  section: MarketingConsoleSection
): MarketingSectionAvailability {
  if (section === "comments") return { available: false, stage: "S4" };
  if (section === "experiments") return { available: false, stage: "S5" };
  return { available: true };
}

/**
 * The three switches the console may change, each paired with the name the
 * settings writer knows it by.
 *
 * Two names for one thing, and they are genuinely two: the payload calls the
 * autonomous switch `autonomous`, and the console's switch strip has always
 * called it `autoPublish` because that is what it reports. Written out once
 * here rather than transcribed in the panel, because the panel is a client
 * component and cannot import `lib/appSettings.ts`, which is server-only --
 * and a closed list copied across that boundary is a list that drifts.
 */
export const MARKETING_CONSOLE_SWITCH_NAMES = [
  "drafts",
  "publish",
  "autonomous",
] as const;

export type MarketingConsoleSwitch =
  (typeof MARKETING_CONSOLE_SWITCH_NAMES)[number];

export const MARKETING_CONSOLE_SWITCH_CONTROLS: readonly {
  readonly state: string;
  readonly name: MarketingConsoleSwitch;
}[] = [
  { state: "drafts", name: "drafts" },
  { state: "publish", name: "publish" },
  { state: "autoPublish", name: "autonomous" },
];
