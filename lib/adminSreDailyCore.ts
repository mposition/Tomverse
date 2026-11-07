/**
 * Pure derivations for the SRE agent's page: how its state reads in the page
 * head, and how one kept daily digest reads in the date list. A digest that
 * has no body (past its retention, or no longer the closed shape) is drawn as
 * such, never as a quiet day.
 */

import type { AdminTone } from "@/lib/adminUiCore";
import type { OpsObserverDigestView } from "@/lib/opsObserverDigest";
import type { OpsObserverAdminView } from "@/lib/opsObserverStore";

export type SreDailySummary = {
  id: string;
  createdAt: string;
  /** The owner date the digest closes; null when the body is gone. */
  ownerDate: string | null;
  mode: string | null;
  /** Every message of the date (reserved or held back); null when the body is gone. */
  total: number | null;
  /** Readiness checks that were failing when it was kept; null when not known. */
  failingChecks: string[] | null;
  /** The readiness checks could not be read when it was kept. */
  readinessUnknown: boolean;
  /** False for a report kept before complete counts existed: its counts may miss messages of the day. */
  countsComplete: boolean;
  /** Nothing to look at: no message, every check passing, and the counts known to be whole. */
  quiet: boolean;
  tone: AdminTone;
  bodyGone: boolean;
};

export function summarizeSreDigest(view: OpsObserverDigestView): SreDailySummary {
  const payload = view.payload;
  if (!payload) {
    return {
      id: view.id,
      createdAt: view.createdAt,
      ownerDate: null,
      mode: null,
      total: null,
      failingChecks: null,
      readinessUnknown: false,
      countsComplete: true,
      quiet: false,
      tone: "unknown",
      bodyGone: true,
    };
  }
  const total = payload.counts.reduce((sum, row) => sum + row.count, 0);
  const readinessUnknown = payload.readiness === "unknown";
  const failingChecks =
    payload.readiness === "unknown"
      ? null
      : Object.entries(payload.readiness)
          .filter(([, ok]) => !ok)
          .map(([name]) => name);
  // A count that may be short is never a quiet day: an older report cannot prove nothing was held back.
  const quiet = total === 0 && !readinessUnknown && (failingChecks?.length ?? 0) === 0 && view.countsComplete;
  return {
    id: view.id,
    createdAt: view.createdAt,
    ownerDate: payload.ownerDate,
    mode: payload.mode,
    total,
    failingChecks,
    readinessUnknown,
    countsComplete: view.countsComplete,
    quiet,
    tone: quiet ? "ok" : "warn",
    bodyGone: false,
  };
}

export type SreHeadStatus = "preparing" | "needsLook" | "observing" | "watching" | "unknown";

/** How the page head names the agent, from the chain verdict the agent itself acts on. */
export function sreHeadStatus(view: OpsObserverAdminView | null): {
  status: SreHeadStatus;
  tone: AdminTone;
  autoRun: "on" | "off" | "unknown";
} {
  if (!view) return { status: "unknown", tone: "unknown", autoRun: "unknown" };
  if (!view.head) return { status: "preparing", tone: "idle", autoRun: "off" };
  if (view.trustReason !== "trusted") return { status: "needsLook", tone: "bad", autoRun: "on" };
  if (view.head.mode === "shadow") return { status: "observing", tone: "info", autoRun: "on" };
  return { status: "watching", tone: "ok", autoRun: "on" };
}
