import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import type { SendingDomainReport } from "@/lib/emailSendingDomains";

/**
 * Sending domain and DNS status.
 *
 * Contract: docs/policy/email-notifications.md §14.1, §17.3.
 * Runbook: docs/ops/email-sending-domains.md.
 *
 * A server component with no client state: everything on it is a fact read
 * once, and the two facts that matter -- what the provider verified, and what
 * it cannot see -- do not change while somebody looks at them.
 *
 * The DMARC row is deliberately never a tick. The provider issues DKIM and SPF
 * records and reports on those; it issues no DMARC record and reports on none,
 * so a domain reads "verified" with no DMARC policy at all. Repeating the
 * provider's verdict would put a green tick beside the one record §14.1 asks
 * us to add first.
 */

const SEVERITY = {
  error: {
    Icon: XCircle,
    className: "border-red-800 bg-red-950/50 text-red-200",
    label: "Blocking",
  },
  warning: {
    Icon: AlertTriangle,
    className: "border-amber-800 bg-amber-950/50 text-amber-200",
    label: "Outstanding",
  },
  info: {
    Icon: Info,
    className: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
    label: "Check by hand",
  },
} as const;

const recordStatus = (status: string | null) =>
  status === "verified"
    ? "text-emerald-300"
    : status
      ? "text-amber-300"
      : "text-zinc-500";

export function AdminEmailDomainsPanel({
  report,
}: {
  report: SendingDomainReport;
}) {
  const blocking = report.findings.filter((finding) => finding.severity === "error");

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Email
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Sending domains</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        Transactional and marketing mail send from separate domains so their
        reputations and DMARC policies are separate. That is the only layer that
        separates: the sending IP, the provider account and its suppression list
        are shared across every domain in the region.
      </p>

      <dl className="mt-5 grid gap-3 md:grid-cols-2">
        {(
          [
            ["Transactional", report.configured.transactional],
            ["Marketing", report.configured.marketing],
          ] as const
        ).map(([label, domain]) => (
          <div
            key={label}
            data-testid={`email-domain-configured-${label.toLowerCase()}`}
            className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3"
          >
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="mt-1 font-mono text-sm text-zinc-200">
              {domain ?? "not configured"}
            </dd>
          </div>
        ))}
      </dl>

      {report.providerError ? (
        <p
          data-testid="email-domain-provider-error"
          className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm leading-6 text-amber-200"
        >
          {report.providerError} Nothing below is a statement about the domains
          themselves — the provider was not reached, so this screen has no
          findings rather than findings derived from an empty list.
        </p>
      ) : null}

      {report.providerDomains && report.providerDomains.length > 0 ? (
        <div className="mt-5 space-y-3">
          {report.providerDomains.map((domain) => (
            <article
              key={domain.id}
              data-testid={`email-domain-${domain.name}`}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-mono text-sm font-bold text-white">
                  {domain.name}
                </h3>
                <span className="text-xs text-zinc-400">
                  {domain.status}
                  {domain.region ? ` · ${domain.region}` : ""}
                </span>
              </div>
              <ul className="mt-3 space-y-1 text-xs">
                {domain.records.map((record, index) => (
                  <li
                    key={`${record.record}-${record.type}-${index}`}
                    className="flex flex-wrap gap-2"
                  >
                    <span className="w-16 shrink-0 text-zinc-500">
                      {record.record ?? "—"}
                    </span>
                    <span className="w-12 shrink-0 text-zinc-500">
                      {record.type ?? "—"}
                    </span>
                    <span className="font-mono text-zinc-300">
                      {record.name ?? "—"}
                    </span>
                    <span className={recordStatus(record.status)}>
                      {record.status ?? "unknown"}
                    </span>
                  </li>
                ))}
                <li className="flex flex-wrap gap-2 border-t border-zinc-800 pt-1">
                  <span className="w-16 shrink-0 text-zinc-500">DMARC</span>
                  <span className="w-12 shrink-0 text-zinc-500">TXT</span>
                  <span className="font-mono text-zinc-300">
                    _dmarc.{domain.name}
                  </span>
                  <span className="text-zinc-500">
                    not issued by the provider — check the zone
                  </span>
                </li>
              </ul>
            </article>
          ))}
        </div>
      ) : null}

      <div className="mt-5 space-y-2" data-testid="email-domain-findings">
        {report.findings.map((finding, index) => {
          const { Icon, className, label } = SEVERITY[finding.severity];
          return (
            <p
              key={`${finding.code}-${finding.stream}-${index}`}
              className={`flex gap-3 rounded-2xl border px-4 py-3 text-sm leading-6 ${className}`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <span className="font-bold">{label}:</span> {finding.message}
              </span>
            </p>
          );
        })}
        {report.findings.length === 0 && !report.providerError ? (
          <p className="flex gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm leading-6 text-zinc-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            Nothing configured to report on.
          </p>
        ) : null}
      </div>

      <p className="mt-5 text-xs leading-5 text-zinc-500">
        {blocking.length > 0
          ? `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}. `
          : ""}
        Read at {report.checkedAt.replace("T", " ").slice(0, 16)} UTC. The DNS
        records themselves are added at the registrar; see
        docs/ops/email-sending-domains.md.
      </p>
    </section>
  );
}
