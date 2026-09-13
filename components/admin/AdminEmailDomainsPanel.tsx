import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

import type { SendingDomainReport } from "@/lib/emailSendingDomains";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminEmailPolicyMessages } from "@/lib/adminMessages/emailPolicy";

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
  },
  warning: {
    Icon: AlertTriangle,
    className: "border-amber-800 bg-amber-950/50 text-amber-200",
  },
  info: {
    Icon: Info,
    className: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
  },
} as const;

const recordStatus = (status: string | null) =>
  status === "verified"
    ? "text-emerald-300"
    : status
      ? "text-amber-300"
      : "text-zinc-500";

export async function AdminEmailDomainsPanel({
  report,
}: {
  report: SendingDomainReport;
}) {
  const messages = await getAdminMessages(adminEmailPolicyMessages);
  const m = messages.domains;
  const blocking = report.findings.filter((finding) => finding.severity === "error");

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        {messages.eyebrow}
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        {m.intro}
      </p>

      <dl className="mt-5 grid gap-3 md:grid-cols-2">
        {(
          [
            ["transactional", m.transactional, report.configured.transactional],
            ["marketing", m.marketing, report.configured.marketing],
          ] as const
        ).map(([stream, label, domain]) => (
          <div
            key={stream}
            data-testid={`email-domain-configured-${stream}`}
            className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3"
          >
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="mt-1 font-mono text-sm text-zinc-200">
              {domain ?? m.notConfigured}
            </dd>
          </div>
        ))}
      </dl>

      {report.providerError ? (
        <p
          data-testid="email-domain-provider-error"
          className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm leading-6 text-amber-200"
        >
          {report.providerError} {m.providerErrorSuffix}
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
                      {record.status ?? m.recordUnknown}
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
                    {m.dmarcNotIssued}
                  </span>
                </li>
              </ul>
            </article>
          ))}
        </div>
      ) : null}

      <div className="mt-5 space-y-2" data-testid="email-domain-findings">
        {report.findings.map((finding, index) => {
          const { Icon, className } = SEVERITY[finding.severity];
          const label = m.severity[finding.severity];
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
            {m.nothingToReport}
          </p>
        ) : null}
      </div>

      <p className="mt-5 text-xs leading-5 text-zinc-500">
        {blocking.length > 0 ? m.blockingCount(blocking.length) : ""}
        {m.readAt(report.checkedAt.replace("T", " ").slice(0, 16))}
      </p>
    </section>
  );
}
