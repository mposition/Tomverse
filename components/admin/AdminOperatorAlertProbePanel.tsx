"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import type {
  OperatorAlertPath,
  OperatorAlertProbeResult,
} from "@/lib/operatorAlertProbeCore";

/**
 * Test sends through the two operator-alert email paths.
 *
 * Contract: docs/policy/email-notifications.md §14.1.
 * Background: docs/ops/email-sending-domains.md §1.2, §3.5.2.
 *
 * These paths run only when something is genuinely wrong, so until this control
 * existed the only way to learn one had broken was for it to fail to report an
 * outage. That is not a hypothetical: it is how three of four senders stayed on
 * the old sending domain through a cutover with nobody noticing.
 *
 * The result states the address the provider actually accepted, not the address
 * this screen believes is configured. The difference between those two is the
 * whole reason the drift went unseen.
 */

const PATHS: Array<{
  path: OperatorAlertPath;
  name: string;
  description: string;
  recipient: string;
}> = [
  {
    path: "operational",
    name: "Operational alerts",
    description:
      "Readiness failures, budget exhaustion and other incidents raised by the platform itself.",
    recipient: "OPS_ALERT_EMAIL, or ADMIN_ALERT_EMAIL",
  },
  {
    path: "provider",
    name: "Provider alerts",
    description:
      "Model provider outages, spend budgets and account balances. Records its outcome in the delivery log.",
    recipient: "ADMIN_ALERT_EMAIL",
  },
];

export function AdminOperatorAlertProbePanel() {
  const [running, setRunning] = useState<OperatorAlertPath | null>(null);
  const [results, setResults] = useState<
    Partial<Record<OperatorAlertPath, OperatorAlertProbeResult>>
  >({});

  const run = async (path: OperatorAlertPath) => {
    setRunning(path);
    try {
      const response = await fetch("/api/admin/email-alert-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = (await response.json().catch(() => null)) as
        | (OperatorAlertProbeResult & { error?: string })
        | null;
      // The endpoint answers 200 even when the path did not send: "the probe
      // ran and the path is broken" is a successful probe, and only a
      // non-200 means the probe itself could not run.
      if (!response.ok) throw new Error(data?.error || "Could not run the test.");
      if (!data) throw new Error("Could not run the test.");
      setResults((current) => ({ ...current, [path]: data }));
      dispatchAppToast(
        data.delivered
          ? `Sent from ${data.from}.`
          : `Nothing was sent: ${data.failure?.code}.`,
        data.delivered ? "success" : "error"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not run the test.",
        "error"
      );
    } finally {
      setRunning(null);
    }
  };

  return (
    <section
      data-testid="operator-alert-probe"
      className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
    >
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Email
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">
        Operator alert paths
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        These two paths send only when something is wrong, so nothing exercises
        them in ordinary operation. Each button sends one real message through
        that path&apos;s own code and reports the address the provider accepted.
      </p>
      {/* Said on screen, because a control that implies more than it checked is
          worse than no control at all. */}
      <p className="mt-3 max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-xs leading-5 text-zinc-400">
        A passing test shows the path can send. It does not show that the
        condition which should trigger it — a failed readiness check, an
        exhausted budget — still calls it.
      </p>

      <div className="mt-5 grid gap-3">
        {PATHS.map((entry) => {
          const result = results[entry.path];
          return (
            <div
              key={entry.path}
              data-testid={`operator-alert-probe-${entry.path}`}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-zinc-100">{entry.name}</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">
                    {entry.description}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-zinc-500">
                    to: {entry.recipient}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => run(entry.path)}
                  disabled={running !== null}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-bold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {running === entry.path ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden />
                  )}
                  {running === entry.path ? "Sending..." : "Send test"}
                </button>
              </div>

              {result ? (
                <dl
                  data-testid={`operator-alert-probe-result-${entry.path}`}
                  className="mt-3 grid gap-1 border-t border-zinc-800 pt-3 text-xs"
                >
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-zinc-500">Result</dt>
                    <dd
                      className={
                        result.delivered ? "text-emerald-300" : "text-red-300"
                      }
                    >
                      {result.delivered ? "Sent" : "Not sent"}
                    </dd>
                  </div>
                  {result.delivered ? (
                    <>
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-zinc-500">From</dt>
                        <dd className="min-w-0 break-all font-mono text-zinc-200">
                          {result.from}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-zinc-500">To</dt>
                        <dd className="min-w-0 break-all font-mono text-zinc-400">
                          {result.recipient}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-zinc-500">Provider</dt>
                        <dd className="min-w-0 break-all font-mono text-zinc-400">
                          {result.providerMessageId ?? "no id returned"}
                        </dd>
                      </div>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-zinc-500">Reason</dt>
                      <dd className="min-w-0 text-red-200">
                        <span className="font-mono">{result.failure?.code}</span>
                        <span className="mt-1 block text-zinc-400">
                          {result.failure?.message}
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
