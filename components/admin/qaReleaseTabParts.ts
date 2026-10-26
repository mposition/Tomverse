import type { MouseEvent } from "react";

import type { QaReleaseTrainPick } from "@/lib/qaReleaseTrainCore";

/** Where each attention item sends the operator: a section of the QA and release tab. */
export const QA_RELEASE_SECTION_IDS = {
  main: "qa-release-main",
  lane: "qa-release-lane",
  digest: "qa-release-digest",
  cargo: "qa-release-train-cargo",
  settings: "qa-release-settings",
} as const;

/**
 * How long the train tab waits for the next train's candidates. A cold read
 * is many GitHub calls and took 20-28 seconds in production on 2026-10-26;
 * the console's usual 15 seconds cut every such read short (HTTP 499) and
 * the tab said GitHub could not be read, while the server finished it.
 */
export const QA_RELEASE_TRAIN_CARGO_READ_TIMEOUT_MS = 60_000;

/** The release train's own tab, where a failed train's attention item sends the operator. */
export const QA_RELEASE_TRAIN_TAB_HREF = "/admin/qa-release?tab=train";

/** A train report as the overview's attention strip reads it. */
export type QaReleaseTrainView = {
  slot: string;
  at: string;
  outcome: "opened" | "empty" | "failed";
  pullRequestNumber: number | null;
  failure: string | null;
  picks: Pick<QaReleaseTrainPick, "number" | "outcome">[];
};

/**
 * A save on the release train tab (the cargo pick, an emergency request) says
 * so, and the tab's "Read again" asks for GitHub past the shared ten-minute
 * read. QaReleaseTrainRefresher reads the tab again on the server on either,
 * and the client sections read their own data again (useQaReleaseTrainReads),
 * so nothing on the tab is older than what was just saved or asked for.
 */
export const QA_RELEASE_TRAIN_CHANGED_EVENT = "qa-release-train-changed";
export const QA_RELEASE_TRAIN_RELOAD_EVENT = "qa-release-train-reload";
export const announceQaReleaseTrainChanged = () => window.dispatchEvent(new Event(QA_RELEASE_TRAIN_CHANGED_EVENT));
export const announceQaReleaseTrainReload = () => window.dispatchEvent(new Event(QA_RELEASE_TRAIN_RELOAD_EVENT));

/** The tab's card surface, shared by its sections. */
export const card = "rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5";

/**
 * Takes the operator to a section of the tab: a collapsed section is opened
 * first, so the link never lands on a closed summary.
 */
export function openSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  if (target instanceof HTMLDetailsElement) target.open = true;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  window.history.replaceState(null, "", `#${id}`);
}
