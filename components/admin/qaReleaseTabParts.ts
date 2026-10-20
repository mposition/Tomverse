import type { MouseEvent } from "react";

/** Where each attention item sends the operator: a section of the QA and release tab. */
export const QA_RELEASE_SECTION_IDS = {
  main: "qa-release-main",
  lane: "qa-release-lane",
  digest: "qa-release-digest",
  train: "qa-release-train-section",
  settings: "qa-release-settings",
} as const;

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
