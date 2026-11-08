import { AlertTriangle, Check, CheckCircle2, Globe, Info, XCircle } from "lucide-react";

import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import type { ProviderDomainRecord } from "@/lib/emailSendingDomainsCore";
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
 * The DMARC chip is deliberately never green. The provider issues DKIM and SPF
 * records and reports on those; it issues no DMARC record and reports on none,
 * so a domain reads "verified" with no DMARC policy at all. Repeating the
 * provider's verdict would put a green tick beside the one record §14.1 asks
 * us to add first. It is drawn as an unread value (dashed), never as healthy.
 */

const SEVERITY = {
  error: { Icon: XCircle, className: "bg-red-500/10 text-red-200" },
  warning: { Icon: AlertTriangle, className: "bg-amber-500/10 text-amber-200" },
  info: { Icon: Info, className: "bg-zinc-800 text-zinc-300" },
} as const;

/** One chip for every provider record of a kind (SPF, DKIM). */
const recordTone = (records: ProviderDomainRecord[], kind: string): AdminTone => {
  const matching = records.filter((record) => record.record?.toUpperCase() === kind);
  if (matching.length === 0) return "unknown";
  if (matching.every((record) => record.status === "verified")) return "ok";
  return matching.some((record) => record.status && record.status !== "verified")
    ? "warn"
    : "unknown";
};

export async function AdminEmailDomainsPanel({
  report,
}: {
  report: SendingDomainReport;
}) {
  const messages = await getAdminMessages(adminEmailPolicyMessages);
  return <AdminEmailDomainsView report={report} m={messages.domains} />;
}

/** The report as a page; split from the loader so it renders without a request. */
export function AdminEmailDomainsView({
  report,
  m,
}: {
  report: SendingDomainReport;
  m: typeof adminEmailPolicyMessages.en.domains;
}) {
  const blocking = report.findings.filter((finding) => finding.severity === "error");
  const streamOf = (name: string) =>
    name === report.configured.transactional
      ? m.transactional
      : name === report.configured.marketing
        ? m.marketing
        : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile title={m.title} description={m.intro}>
        <dl className="grid gap-3 md:grid-cols-2">
          {(
            [
              ["transactional", m.transactional, report.configured.transactional],
              ["marketing", m.marketing, report.configured.marketing],
            ] as const
          ).map(([stream, label, domain]) => (
            <div
              key={stream}
              data-testid={`email-domain-configured-${stream}`}
              className="rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3"
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
            className="rounded-2xl bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-200"
          >
            {report.providerError} {m.providerErrorSuffix}
          </p>
        ) : null}
      </AdminTile>

      {report.providerDomains && report.providerDomains.length > 0 ? (
        <AdminTile title={m.recordsTitle} description={m.recordsDescription}>
          <ul className="flex flex-col">
            {report.providerDomains.map((domain) => {
              const stream = streamOf(domain.name);
              return (
                <li
                  key={domain.id}
                  data-testid={`email-domain-${domain.name}`}
                  className="flex flex-col gap-3 border-t border-zinc-800 py-4 first:border-t-0 first:pt-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-300">
                      <Globe className="h-5 w-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm font-bold text-white">{domain.name}</p>
                      <p className="text-xs text-zinc-500">
                        {[stream, domain.status, domain.region].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(["SPF", "DKIM"] as const).map((kind) => {
                      const tone = recordTone(domain.records, kind);
                      return (
                        <AdminStatusChip key={kind} tone={tone}>
                          {tone === "ok" ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                          {tone === "warn" ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : null}
                          {kind}
                        </AdminStatusChip>
                      );
                    })}
                    {/* Never a tick: the provider does not report DMARC. */}
                    <span title={m.dmarcNotIssued}>
                      <AdminStatusChip tone="unknown">DMARC</AdminStatusChip>
                    </span>
                  </div>
                  <div className="sm:basis-full">
                    <AdminTechInfo summary={m.recordsTitle}>
                      <ul className="space-y-1">
                        {domain.records.map((record, index) => (
                          <li key={`${record.record}-${record.type}-${index}`} className="flex flex-wrap gap-2">
                            <span className="w-16 shrink-0 text-zinc-500">{record.record ?? "—"}</span>
                            <span className="w-12 shrink-0 text-zinc-500">{record.type ?? "—"}</span>
                            <span className="text-zinc-300">{record.name ?? "—"}</span>
                            <span className="text-zinc-400">{record.status ?? m.recordUnknown}</span>
                          </li>
                        ))}
                        <li className="flex flex-wrap gap-2 border-t border-zinc-800 pt-1">
                          <span className="w-16 shrink-0 text-zinc-500">DMARC</span>
                          <span className="w-12 shrink-0 text-zinc-500">TXT</span>
                          <span className="text-zinc-300">_dmarc.{domain.name}</span>
                          <span className="text-zinc-500">{m.dmarcNotIssued}</span>
                        </li>
                      </ul>
                    </AdminTechInfo>
                  </div>
                </li>
              );
            })}
          </ul>
        </AdminTile>
      ) : null}

      <div className="space-y-2" data-testid="email-domain-findings">
        {report.findings.map((finding, index) => {
          const { Icon, className } = SEVERITY[finding.severity];
          const label = m.severity[finding.severity];
          return (
            <p
              key={`${finding.code}-${finding.stream}-${index}`}
              className={`flex gap-3 rounded-2xl px-4 py-3 text-sm leading-6 ${className}`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-bold">{label}:</span> {finding.message}
              </span>
            </p>
          );
        })}
        {report.findings.length === 0 && !report.providerError ? (
          <p className="flex gap-3 rounded-2xl border border-dashed border-zinc-700 px-4 py-3 text-sm leading-6 text-zinc-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            {m.nothingToReport}
          </p>
        ) : null}
      </div>

      <p className="text-xs leading-5 text-zinc-500">
        {blocking.length > 0 ? m.blockingCount(blocking.length) : ""}
        {m.readAt(formatAestDateTime(report.checkedAt) ?? report.checkedAt)}
      </p>
    </div>
  );
}
