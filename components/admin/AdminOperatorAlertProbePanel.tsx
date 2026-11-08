"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminOperatorAlertProbeMessages } from "@/lib/adminMessages/operatorAlertProbe";
import { dispatchAppToast } from "@/lib/appToast";
import type {
  OperatorAlertPath,
  OperatorAlertProbeResult,
} from "@/lib/operatorAlertProbeCore";
import { adminFetch } from "@/lib/adminFetch";

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
  recipient: string;
}> = [
  {
    path: "operational",
    recipient: "OPS_ALERT_EMAIL, or ADMIN_ALERT_EMAIL",
  },
  {
    path: "provider",
    recipient: "ADMIN_ALERT_EMAIL",
  },
];

export function AdminOperatorAlertProbePanel() {
  const m = useAdminMessages(adminOperatorAlertProbeMessages);
  const [running, setRunning] = useState<OperatorAlertPath | null>(null);
  const [results, setResults] = useState<
    Partial<Record<OperatorAlertPath, OperatorAlertProbeResult>>
  >({});

  const run = async (path: OperatorAlertPath) => {
    setRunning(path);
    try {
      const response = await adminFetch("/api/admin/email-alert-probe", {
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
      if (!response.ok) throw new Error(data?.error || m.runFailed);
      if (!data) throw new Error(m.runFailed);
      setResults((current) => ({ ...current, [path]: data }));
      dispatchAppToast(
        data.delivered
          ? m.sentFrom(data.from)
          : m.nothingSent(data.failure?.code),
        data.delivered ? "success" : "error"
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.runFailed,
        "error"
      );
    } finally {
      setRunning(null);
    }
  };

  return (
    <AdminTile
      data-testid="operator-alert-probe"
      title={m.title}
      description={m.description}
    >
      {/* Said on screen, because a control that implies more than it checked is
          worse than no control at all. */}
      <p className="rounded-2xl bg-zinc-950/60 px-4 py-3 text-xs leading-5 text-zinc-400">
        {m.caveat}
      </p>

      <div className="grid gap-3">
        {PATHS.map((entry) => {
          const result = results[entry.path];
          return (
            <div
              key={entry.path}
              data-testid={`operator-alert-probe-${entry.path}`}
              className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-zinc-100">{m.paths[entry.path].name}</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-400">
                    {m.paths[entry.path].description}
                  </p>
                  <AdminTechInfo summary={m.to}>{entry.recipient}</AdminTechInfo>
                </div>
                <AdminWriteButton
                  variant="secondary"
                  onClick={() => run(entry.path)}
                  disabled={running !== null}
                >
                  {running === entry.path ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden />
                  )}
                  {running === entry.path ? m.sending : m.sendTest}
                </AdminWriteButton>
              </div>

              {result ? (
                <dl
                  data-testid={`operator-alert-probe-result-${entry.path}`}
                  className="mt-3 grid gap-1 border-t border-zinc-800 pt-3 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <dt className="w-24 shrink-0 text-zinc-500">{m.result}</dt>
                    <dd>
                      <AdminStatusChip tone={result.delivered ? "ok" : "bad"}>
                        {result.delivered ? m.sent : m.notSent}
                      </AdminStatusChip>
                    </dd>
                  </div>
                  {result.delivered ? (
                    <>
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-zinc-500">{m.from}</dt>
                        <dd className="min-w-0 break-all font-mono text-zinc-200">
                          {result.from}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-zinc-500">{m.recipient}</dt>
                        <dd className="min-w-0 break-all font-mono text-zinc-400">
                          {result.recipient}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-zinc-500">{m.provider}</dt>
                        <dd className="min-w-0 break-all font-mono text-zinc-400">
                          {result.providerMessageId ?? m.noIdReturned}
                        </dd>
                      </div>
                    </>
                  ) : (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-zinc-500">{m.reason}</dt>
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
    </AdminTile>
  );
}
