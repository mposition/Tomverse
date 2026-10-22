"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { QaReleaseMainCandidatesSection } from "@/components/admin/QaReleaseMainCandidatesSection";
import { QaReleaseMergeLaneSection } from "@/components/admin/QaReleaseMergeLaneSection";
import { QaReleaseTrainCargoSection } from "@/components/admin/QaReleaseTrainCargoSection";
import { QaReleaseTrainSection, type QaReleaseTrainView } from "@/components/admin/QaReleaseTrainSection";
import type { AgentDigestConsole, AgentDigestConsoleRow } from "@/lib/agentDigestConsoleRead";
import { aestStamp } from "@/lib/agentOffice/time";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  latestReadableDigest,
  qaReleaseAttentionItems,
  qaReleaseStatusFigures,
  type QaReleaseAttentionItem,
  type QaReleaseStatusFigures,
} from "@/lib/qaReleaseAttentionCore";
import type { QaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesCore";
import { QA_RELEASE_SECRET_ROTATION_FIELDS } from "@/lib/qaReleaseOperatorControlFields";
import { QA_RELEASE_SECTION_IDS, card, openSection } from "@/components/admin/qaReleaseTabParts";

const PAGE_PATH = "/admin/agent-digests";
const CONTROL_ROUTE = "/api/admin/agent-digests/qa-release/control";
const RUN_URL = "https://github.com/mposition/Tomverse/actions/runs/";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

/** Gate verdicts in the order the bar draws them, best first. */
const GATE_ORDER = [
  ["evidence_present", "bg-emerald-400"],
  ["implemented_unmeasured", "bg-blue-400"],
  ["not_implemented", "bg-amber-300"],
  ["unmapped", "bg-zinc-500"],
  ["applicability_unknown", "bg-zinc-600"],
  ["not_applicable", "bg-zinc-700"],
] as const;

const CI_CLASS_TONE: Record<string, string> = {
  infra: "bg-blue-400/15 text-blue-300",
  undetermined: "bg-zinc-700/60 text-zinc-300",
  flaky_suspected: "bg-amber-300/15 text-amber-300",
  consecutive_repro: "bg-red-400/15 text-red-300",
};

/**
 * The QA and release tab of the common Agent digest area
 * (docs/policy/qa-release-agent.md section 4), ordered by what the operator
 * asks first: what needs me, is production current, is the merge lane
 * running, what did the latest digest find. Rarely used parts (the release
 * train and the operator control revision) sit collapsed at the bottom.
 * Nothing here approves, merges or signs; the one write on the tab's main
 * body is the merge lane's release form, owner and ops only.
 */
export function AdminAgentDigestsPanel({
  initial,
  main,
  trains,
  nowMs,
}: {
  initial: AgentDigestConsole;
  main: QaReleaseMainCandidates;
  trains: QaReleaseTrainView[];
  /** The server's clock when the page was read, so both renders agree. */
  nowMs: number;
}) {
  const items = qaReleaseAttentionItems({ console: initial, main, trains, nowMs });
  const figures = qaReleaseStatusFigures({ digests: initial.digests, main });
  return (
    <section className="flex min-w-0 flex-col gap-5" data-testid="qa-release-tab">
      <AttentionStrip items={items} />
      <StatusCards figures={figures} />
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <QaReleaseMainCandidatesSection data={main} id={QA_RELEASE_SECTION_IDS.main} />
        <QaReleaseMergeLaneSection lane={initial.mergeLane} canWrite={initial.canWrite} id={QA_RELEASE_SECTION_IDS.lane} />
      </div>
      <LatestDigest digests={initial.digests} limit={initial.limit} />
      <QaReleaseTrainCargoSection canWrite={initial.canWrite} id={QA_RELEASE_SECTION_IDS.cargo} />
      <QaReleaseTrainSection trains={trains} id={QA_RELEASE_SECTION_IDS.train} />
      <AgentSettings initial={initial} />
    </section>
  );
}

function AttentionStrip({ items }: { items: QaReleaseAttentionItem[] }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  if (items.length === 0) {
    return (
      <p
        className="flex items-center gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-300"
        data-testid="qa-release-attention"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
        {m.attentionNone}
      </p>
    );
  }
  const row = (item: QaReleaseAttentionItem): { title: string; detail: string | null; action: [string, string] | null; urgent: boolean } => {
    switch (item.kind) {
      case "lane_latched":
        return {
          title: m.attentionLaneLatched,
          detail: fill(m.attentionLaneLatchedDetail, { reason: item.reason ?? m.none }),
          action: [m.attentionLaneLatchedAction, QA_RELEASE_SECTION_IDS.lane],
          urgent: true,
        };
      case "control_missing":
        return { title: m.attentionControlMissing, detail: m.controlNone, action: [m.attentionOpenSettings, QA_RELEASE_SECTION_IDS.settings], urgent: true };
      case "production_behind":
        return {
          title: m.attentionProductionBehind,
          detail: fill(m.attentionProductionBehindDetail, { serving: short(item.servingSha), main: short(item.mainHeadSha) }),
          action: [m.attentionSeeMain, QA_RELEASE_SECTION_IDS.main],
          urgent: false,
        };
      case "main_refused":
        return {
          title: m.attentionMainRefused,
          detail: fill(m.attentionMainRefusedDetail, { numbers: item.numbers.map((n) => `#${n}`).join(", ") }),
          action: [m.attentionSeeMain, QA_RELEASE_SECTION_IDS.main],
          urgent: true,
        };
      case "main_unread":
        return { title: m.attentionMainUnread, detail: m.attentionMainUnreadDetail, action: null, urgent: false };
      case "ci_failed":
        return {
          title: fill(m.attentionCiFailed, { count: item.count }),
          detail: m.attentionDigestFailedDetail,
          action: [m.attentionSeeDigest, QA_RELEASE_SECTION_IDS.digest],
          urgent: false,
        };
      case "checks_failed":
        return {
          title: fill(m.attentionChecksFailed, { count: item.count }),
          detail: m.attentionDigestFailedDetail,
          action: [m.attentionSeeDigest, QA_RELEASE_SECTION_IDS.digest],
          urgent: false,
        };
      case "digest_stale":
        return {
          title: m.attentionDigestStale,
          detail: item.lastAt ? fill(m.attentionDigestStaleDetail, { at: aestStamp(item.lastAt) }) : m.attentionDigestNever,
          action: [m.attentionOpenSettings, QA_RELEASE_SECTION_IDS.settings],
          urgent: false,
        };
      case "train_failed":
        return {
          title: m.attentionTrainFailed,
          detail: fill(m.attentionTrainFailedDetail, { slot: item.slot, failure: item.failure ?? m.none }),
          action: [m.attentionSeeTrain, QA_RELEASE_SECTION_IDS.train],
          urgent: false,
        };
    }
  };
  return (
    <section className="flex flex-col rounded-2xl border border-amber-300/30 bg-amber-300/5" data-testid="qa-release-attention">
      <h2 className="flex items-center gap-2 px-4 pb-1 pt-3 text-sm font-semibold text-amber-300">
        {m.attentionTitle}
        <span className="rounded-full bg-amber-300/20 px-2 py-0.5 font-mono text-xs">{items.length}</span>
      </h2>
      <ul className="flex flex-col">
        {items.map((item) => {
          const { title, detail, action, urgent } = row(item);
          return (
            <li
              key={item.kind}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-amber-300/15 px-4 py-3 first:border-t-0"
              data-testid={`qa-release-attention-${item.kind}`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${urgent ? "bg-red-400" : "bg-amber-300"}`} aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-zinc-100">{title}</span>
                {detail ? <span className="break-words text-xs text-zinc-400">{detail}</span> : null}
              </div>
              {action ? (
                <a
                  href={`#${action[1]}`}
                  onClick={(event) => openSection(event, action[1])}
                  className="inline-flex min-h-9 items-center rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
                >
                  {action[0]}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatusCard({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-900 p-4" data-testid={testId}>
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
    </div>
  );
}

function StatusCards({ figures }: { figures: QaReleaseStatusFigures }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const production = {
    serves_main: [m.cardProductionServes, "text-emerald-400"],
    behind: [m.cardProductionBehind, "text-amber-300"],
    unknown: [m.cardProductionUnknown, "text-zinc-400"],
  }[figures.production];
  const value = "text-xl font-semibold text-zinc-100";
  const sub = "truncate text-xs text-zinc-500";
  const label = m as unknown as Record<string, string>;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="qa-release-status">
      <StatusCard label={m.cardProduction} testId="qa-release-status-production">
        <span className={`text-xl font-semibold ${production[1]}`}>{production[0]}</span>
        <span className={`${sub} font-mono`}>
          {fill(m.cardProductionShas, { serving: short(figures.servingSha), main: short(figures.mainHeadSha) })}
        </span>
      </StatusCard>
      <StatusCard label={m.cardMainPulls} testId="qa-release-status-main">
        {figures.mainPulls ? (
          <>
            <span className={value}>{figures.mainPulls.total}</span>
            <span className={sub}>{fill(m.cardMainPullsDrafts, { drafts: figures.mainPulls.drafts })}</span>
          </>
        ) : (
          <span className="text-xl font-semibold text-amber-300">{m.cardNotRead}</span>
        )}
      </StatusCard>
      <StatusCard label={m.cardGates} testId="qa-release-status-gates">
        {figures.gates && figures.gates.total > 0 ? (
          <>
            <span className={value}>
              {figures.gates.evidence}
              <span className="text-sm font-normal text-zinc-500"> / {figures.gates.total}</span>
            </span>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-800" aria-hidden="true">
              {GATE_ORDER.map(([verdict, tone]) => {
                const count = figures.gates?.byVerdict[verdict] ?? 0;
                return count > 0 ? (
                  <span key={verdict} className={tone} style={{ width: `${(count / (figures.gates?.total ?? 1)) * 100}%` }} title={`${label[`gate_${verdict}`]} ${count}`} />
                ) : null;
              })}
            </div>
            <span className={sub}>{m.cardGatesEvidence}</span>
          </>
        ) : (
          <span className="text-xl font-semibold text-zinc-400">{m.cardNoDigest}</span>
        )}
      </StatusCard>
      <StatusCard label={m.cardLatency} testId="qa-release-status-latency">
        {figures.latency ? (
          <>
            <span className={value}>
              {figures.latency.median ?? m.latencyNone}
              <span className="text-sm font-normal text-zinc-500"> {m.cardLatencyMedian}</span>
            </span>
            <span className={sub}>
              {fill(m.cardLatencyWorst, { max: figures.latency.max ?? m.latencyNone, merges: figures.latency.merges })}
            </span>
          </>
        ) : (
          <span className="text-xl font-semibold text-zinc-400">{m.cardLatencyNone}</span>
        )}
      </StatusCard>
    </div>
  );
}

function Tile({ label, value, tone, detail }: { label: string; value: number; tone: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-zinc-950 px-3 py-2.5">
      <span className={`font-mono text-2xl font-semibold ${tone}`}>{value}</span>
      <span className="text-xs text-zinc-400">{label}</span>
      {detail ? <span className="text-xs text-zinc-500">{detail}</span> : null}
    </div>
  );
}

function LatestDigest({ digests, limit }: { digests: AgentDigestConsoleRow[]; limit: number }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const label = m as unknown as Record<string, string>;
  const latest = latestReadableDigest(digests);
  const summary = latest?.summary ?? null;
  const earlier = digests.filter((row) => row.id !== latest?.id);
  return (
    <section className={`${card} flex flex-col gap-4`} id={QA_RELEASE_SECTION_IDS.digest} data-testid="agent-digest-latest">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-zinc-100">{m.latestTitle}</h2>
        {latest ? (
          <span className="text-xs text-zinc-400">
            {fill(m.latestMeta, { date: latest.digestDate ?? m.none, at: aestStamp(latest.createdAt) })}
          </span>
        ) : null}
      </div>
      {!latest || !summary ? (
        <p className="text-sm text-zinc-400">{m.emptyDigests}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label={m.tileCi} value={summary.failedCiJobs} tone={summary.failedCiJobs > 0 ? "text-red-400" : "text-zinc-100"} />
            <Tile label={m.tileChecks} value={summary.failedChecks} tone={summary.failedChecks > 0 ? "text-red-400" : "text-zinc-100"} />
            {summary.issuesAvailable ? (
              <Tile
                label={m.tileIssues}
                value={summary.issueCandidates}
                tone="text-zinc-100"
                detail={fill(m.tileIssuesBlocked, { blocked: summary.issueBlocked })}
              />
            ) : (
              <div className="flex flex-col justify-center rounded-xl bg-zinc-950 px-3 py-2.5 text-xs text-zinc-400">{m.issuesUnavailable}</div>
            )}
            <Tile
              label={m.tileNotChecked}
              value={summary.notChecked.length}
              tone={summary.notChecked.length > 0 ? "text-amber-300" : "text-zinc-100"}
            />
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {summary.failedCi.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-2">
                <h3 className="text-sm font-medium text-zinc-300">{m.failedJobsTitle}</h3>
                <ul className="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-testid="agent-digest-failed-ci">
                  {summary.failedCi.map((job) => (
                    <li key={`${job.runId}-${job.job}-${job.shard ?? 0}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <a
                        className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200 hover:underline"
                        href={`${RUN_URL}${job.runId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {job.workflow} › {job.job}
                        {job.shard !== null ? ` #${job.shard}` : ""}
                      </a>
                      <span className="shrink-0 text-xs text-zinc-500">{job.conclusion}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${CI_CLASS_TONE[job.label] ?? CI_CLASS_TONE.undetermined}`}>
                        {label[`ciClass_${job.label}`] ?? job.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium text-zinc-300">{m.gatesTitle}</h3>
              <ul className="flex flex-col gap-1 text-sm" data-testid="agent-digest-gates">
                {GATE_ORDER.filter(([verdict]) => (summary.gatesByVerdict[verdict] ?? 0) > 0).map(([verdict, tone]) => (
                  <li key={verdict} className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-sm ${tone}`} aria-hidden="true" />
                    <span className="flex-1 text-zinc-300">{label[`gate_${verdict}`]}</span>
                    <span className="font-mono text-zinc-100">{summary.gatesByVerdict[verdict]}</span>
                  </li>
                ))}
              </ul>
              {summary.latency.status === "unavailable" ? (
                <p className="text-xs text-zinc-400" data-testid="agent-digest-latency">{m.latencyUnavailable}</p>
              ) : summary.latency.status === "ok" ? (
                <p className="text-xs text-zinc-500" data-testid="agent-digest-latency">
                  {fill(m.latency, {
                    merges: summary.latency.merges,
                    median: summary.latency.medianDevDeployedMin ?? m.latencyNone,
                    max: summary.latency.maxDevDeployedMin ?? m.latencyNone,
                    checks: summary.latency.medianLastCheckDoneMin ?? m.latencyNone,
                    lastStart: summary.latency.maxLastCheckStartMin ?? m.latencyNone,
                  })}
                </p>
              ) : null}
            </div>
          </div>
          {summary.notChecked.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium text-zinc-300">{m.notCheckedTitle}</h3>
              <ul className="flex flex-wrap gap-1.5" data-testid="agent-digest-not-checked">
                {summary.notChecked.map((code) => (
                  <li key={code} className="rounded-full bg-amber-300/10 px-2.5 py-1 text-xs text-amber-300" title={code}>
                    {label[`notChecked_${code}`] ?? code}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {earlier.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
            {fill(m.earlierTitle, { count: earlier.length })}
            <span className="ml-2 text-xs text-zinc-500">{fill(m.showingNewest, { count: limit })}</span>
          </summary>
          <ul className="mt-2 flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-testid="agent-digest-list">
            {earlier.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                <span className="font-mono text-zinc-100">{row.digestDate ?? m.none}</span>
                <span className="text-xs text-zinc-500">{aestStamp(row.createdAt)}</span>
                <span className="flex-1 text-xs text-zinc-300">
                  {row.summary
                    ? fill(m.earlierRow, { ci: row.summary.failedCiJobs, checks: row.summary.failedChecks })
                    : row.body === "expired"
                      ? m.bodyExpired
                      : row.body === "unreadable"
                        ? m.bodyUnreadable
                        : m.earlierNoSummary}
                </span>
                <span className="font-mono text-xs text-zinc-600" title={row.payloadSha256}>
                  {row.payloadSha256.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function AgentSettings({ initial }: { initial: AgentDigestConsole }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const onOff = (value: boolean) => (value ? m.on : m.off);
  const control = initial.control;
  return (
    <details className={`${card} group`} id={QA_RELEASE_SECTION_IDS.settings} data-testid="qa-release-settings">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-semibold text-zinc-100">{m.settingsTitle}</span>
        <span className="text-xs text-zinc-400">
          {control
            ? fill(m.settingsSummary, {
                revision: control.revision,
                digest: onOff(control.digestEnabled),
                lane: onOff(control.mergeLaneEnabled),
              })
            : m.settingsSummaryNone}
        </span>
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
          {m.readOnlyNote}
        </p>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">{m.controlTitle}</h3>
          {control ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="agent-digest-control">
              <dt className="text-zinc-400">{m.revision}</dt>
              <dd>{control.revision}</dd>
              <dt className="text-zinc-400">{m.digestEnabled}</dt>
              <dd>{onOff(control.digestEnabled)}</dd>
              <dt className="text-zinc-400">{m.mergeLaneEnabled}</dt>
              <dd>{onOff(control.mergeLaneEnabled)}</dd>
              <dt className="text-zinc-400">{m.developLaneOn}</dt>
              <dd>{onOff(control.developLaneOn)}</dd>
              <dt className="text-zinc-400">{m.iacCommit}</dt>
              <dd className="break-all font-mono text-xs">{control.iacCommit ?? m.none}</dd>
              <dt className="text-zinc-400">{m.recordedAt}</dt>
              <dd>{aestStamp(control.createdAt)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-zinc-400">{m.controlNone}</p>
          )}
        </div>
        {/* Keyed by revision: after a save and refresh the form starts from the new record. */}
        {initial.canWrite ? <QaReleaseControlForm key={control?.revision ?? 0} current={control} /> : null}
      </div>
    </details>
  );
}

type Notice = { tone: "ok" | "error"; text: string } | null;

/** An ISO instant as a datetime-local value in the viewer's own zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function QaReleaseControlForm({ current }: { current: AgentDigestConsole["control"] }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const router = useRouter();
  const [digestEnabled, setDigestEnabled] = useState(current?.digestEnabled ?? false);
  const [mergeLaneEnabled, setMergeLaneEnabled] = useState(current?.mergeLaneEnabled ?? false);
  const [developLaneOn, setDevelopLaneOn] = useState(current?.developLaneOn ?? false);
  const [iacCommit, setIacCommit] = useState(current?.iacCommit ?? "");
  const [rotated, setRotated] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => [field, toLocalInput(current?.rotatedAt[field] ?? null)]),
    ),
  );
  // Only the fields a person changed are re-read from the minute-precision
  // input; an untouched one sends its recorded instant unchanged.
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);

  const submit = async () => {
    if (!window.confirm(m.confirmSave)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(CONTROL_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digestEnabled,
          mergeLaneEnabled,
          developLaneOn,
          iacCommit: iacCommit.trim() === "" ? null : iacCommit.trim(),
          ...Object.fromEntries(
            QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => [
              field,
              edited.has(field)
                ? rotated[field]
                  ? new Date(rotated[field]).toISOString()
                  : null
                : (current?.rotatedAt[field] ?? null),
            ]),
          ),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        result?: { revision?: unknown };
      };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthenticationRequired(true);
        return;
      }
      if (response.status === 409 && typeof payload.code === "string") {
        setNotice({ tone: "error", text: fill(m.refused, { code: payload.code }) });
        return;
      }
      if (!response.ok || typeof payload.result?.revision !== "number") {
        setNotice({ tone: "error", text: m.failed });
        return;
      }
      setNotice({ tone: "ok", text: fill(m.saved, { revision: payload.result.revision }) });
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: m.failed });
    } finally {
      setBusy(false);
    }
  };

  const checkbox = (label: string, value: boolean, set: (next: boolean) => void, testId: string) => (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} data-testid={testId} />
      {label}
    </label>
  );

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border p-3 border-zinc-800"
      data-testid="qa-release-control-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-semibold text-zinc-100">{m.formTitle}</h3>
      <p className="text-sm text-zinc-400">{m.formNote}</p>
      {checkbox(m.digestEnabled, digestEnabled, setDigestEnabled, "qa-release-control-digest")}
      {checkbox(m.mergeLaneEnabled, mergeLaneEnabled, setMergeLaneEnabled, "qa-release-control-merge-lane")}
      {checkbox(m.developLaneOn, developLaneOn, setDevelopLaneOn, "qa-release-control-develop-lane")}
      <label className="flex flex-col gap-1 text-sm">
        {m.iacCommit}
        <input
          className="rounded border px-2 py-2 font-mono text-xs border-zinc-700 bg-zinc-900"
          value={iacCommit}
          onChange={(event) => setIacCommit(event.target.value)}
          placeholder={m.iacCommitHint}
          pattern="[0-9a-f]{40}"
          maxLength={40}
          data-testid="qa-release-control-iac"
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{m.rotationTitle}</legend>
        {QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => (
          <label key={field} className="flex flex-col gap-1 text-sm">
            {m[field]}
            <input
              type="datetime-local"
              className="rounded border px-2 py-2 border-zinc-700 bg-zinc-900"
              value={rotated[field]}
              onChange={(event) => {
                const value = event.target.value;
                setRotated((previous) => ({ ...previous, [field]: value }));
                setEdited((previous) => new Set(previous).add(field));
              }}
            />
          </label>
        ))}
      </fieldset>
      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={
            notice.tone === "ok" ? "text-sm text-zinc-300" : "text-sm text-red-300"
          }
        >
          {notice.text}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="min-h-11 self-start rounded-md px-4 text-sm font-medium disabled:opacity-60 bg-zinc-100 text-zinc-900"
        data-testid="qa-release-control-save"
      >
        {m.save}
      </button>
    </form>
  );
}
