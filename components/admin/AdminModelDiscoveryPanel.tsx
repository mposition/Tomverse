"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, PackageSearch } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The discovery backlog, and the three things an operator can do to an item.
 *
 * This panel is the answer to ML-02. The monitor has written its findings to
 * ProviderModelCatalogEntry since July and nothing has ever read them back, so
 * a discovered model survived exactly as long as the one daily email that named
 * it -- which cost seven first-party models between 21 July and 22 August.
 *
 * Deliberately small. Triage is "does this deserve a decision", and the three
 * answers are yes, no, and not yet. Everything past that -- owner, due date,
 * implementation evidence -- is edited once an item is moving, and giving all
 * of it a control here would make the screen a form rather than a queue.
 */

export type ModelWorkItemRow = {
  id: string;
  provider: string;
  apiModel: string;
  action: string;
  status: string;
  severity: string;
  ownerEmail: string | null;
  dueAt: string | null;
  firstSeenAt: string;
};

const ageDays = (firstSeenAt: string) => {
  const seen = new Date(firstSeenAt).getTime();
  if (Number.isNaN(seen)) return null;
  return Math.max(0, Math.floor((Date.now() - seen) / 86_400_000));
};

const severityClass = (severity: string) => {
  if (severity === "critical") return "border-red-500/30 bg-red-500/10 text-red-200";
  if (severity === "high") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  return "border-zinc-700 bg-zinc-800 text-zinc-300";
};

/** Only the moves triage itself makes. The rest happen as work progresses. */
const TRIAGE_ACTIONS = [
  { to: "awaiting_decision", label: "Needs a decision", intent: "neutral" },
  { to: "deferred", label: "Not yet", intent: "neutral" },
  { to: "closed_no_action", label: "No action", intent: "quiet" },
] as const;

export function AdminModelDiscoveryPanel() {
  const [rows, setRows] = useState<ModelWorkItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/model-lifecycle", {
        cache: "no-store",
      });
      if (!response.ok) {
        // The body is drained even though nothing reads it: `/api/*` answers
        // `private, no-store`, under which an unconsumed body was measured not
        // to reach `requestfinished` on Chromium. The obligation is on every
        // path, not only the one whose value gets parsed.
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      const data = (await response.json()) as { items: ModelWorkItemRow[] };
      setRows(data.items);
      setFailed(false);
    } catch {
      // An empty table and a failed read look identical, and only one of them
      // means there is nothing to do.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred out of the effect body, and subscribed to the console's own
    // refresh event, the way every other admin panel loads.
    queueMicrotask(() => {
      void load();
    });
    const refresh = () => void load();
    window.addEventListener("admin:refresh", refresh);
    return () => window.removeEventListener("admin:refresh", refresh);
  }, [load]);

  const move = useCallback(
    async (row: ModelWorkItemRow, to: string) => {
      setBusyId(row.id);
      try {
        const response = await fetch("/api/admin/model-lifecycle", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workItemId: row.id, to }),
        });
        const data = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        if (!response.ok) {
          // The refusal says which invariant stopped it; showing the generic
          // failure instead would leave the operator guessing at a rule.
          dispatchAppToast(
            data?.message || "The queue refused that transition.",
            "error"
          );
          return;
        }
        await load();
      } catch {
        dispatchAppToast("The request did not reach the server.", "error");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <header className="mb-3 flex items-center gap-2">
        <PackageSearch className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="text-sm font-semibold text-zinc-100">
          Awaiting review
        </h2>
        <span className="text-xs text-zinc-500">
          {loading ? "loading" : `${rows.length} open`}
        </span>
      </header>

      <p className="mb-4 text-xs leading-relaxed text-zinc-500">
        Models a provider listed that the catalogue does not serve. An item stays
        here until somebody decides about it — it is not re-derived from
        today&apos;s scan, so nothing falls off the list by being a day old.
      </p>

      {failed ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
          The queue could not be read, so this is not a claim that nothing is
          waiting. Reload to try again.
        </p>
      ) : loading ? (
        <p className="flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading the
          backlog…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-zinc-400">
          Nothing is waiting. Discovery runs daily at 10:00 Australia/Brisbane.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Model</th>
                <th className="py-2 pr-3 font-medium">Provider</th>
                <th className="py-2 pr-3 font-medium">Action</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Waiting</th>
                <th className="py-2 pr-3 font-medium">Owner</th>
                <th className="py-2 font-medium">Triage</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {rows.map((row) => {
                const days = ageDays(row.firstSeenAt);
                const triageable =
                  row.status === "discovered" || row.status === "deferred";
                return (
                  <tr key={row.id} className="border-t border-zinc-800/70">
                    <td className="py-2 pr-3">
                      <span className="break-all font-mono text-[11px] text-zinc-100">
                        {row.apiModel}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-zinc-400">{row.provider}</td>
                    <td className="py-2 pr-3 text-zinc-400">{row.action}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${severityClass(
                          row.severity
                        )}`}
                      >
                        {row.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-zinc-400">
                      {days === null ? "—" : `${days}d`}
                    </td>
                    <td className="py-2 pr-3 text-zinc-400">
                      {row.ownerEmail || "—"}
                    </td>
                    <td className="py-2">
                      {triageable ? (
                        <div className="flex flex-wrap gap-1">
                          {TRIAGE_ACTIONS.filter(
                            (action) => action.to !== row.status
                          ).map((action) => (
                            <button
                              key={action.to}
                              type="button"
                              disabled={busyId === row.id}
                              onClick={() => void move(row, action.to)}
                              className={`rounded border px-2 py-1 text-[11px] transition disabled:opacity-50 ${
                                action.intent === "quiet"
                                  ? "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                                  : "border-zinc-600 text-zinc-200 hover:bg-zinc-800"
                              }`}
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-500">in progress</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
