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
 * so; QaReleaseTrainRefresher reads the tab again on the server, so its
 * summary is never older than what was just saved.
 */
export const QA_RELEASE_TRAIN_CHANGED_EVENT = "qa-release-train-changed";
export const announceQaReleaseTrainChanged = () => window.dispatchEvent(new Event(QA_RELEASE_TRAIN_CHANGED_EVENT));

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
