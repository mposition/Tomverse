"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { QA_RELEASE_LANE_TAB_HREF, QA_RELEASE_TRAIN_TAB_HREF, card } from "@/components/admin/qaReleaseTabParts";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import type { QaReleaseFlow } from "@/lib/qaReleaseAttentionCore";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

function Stage({ label, value, detail, attention = false }: { label: string; value: string; detail: string; attention?: boolean }) {
  return (
    <div className={`min-w-0 flex-1 basis-40 rounded-xl border px-4 py-3 ${attention ? "border-amber-300/50 bg-amber-300/5" : "border-zinc-800 bg-zinc-950/40"}`}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 truncate text-lg font-bold text-zinc-100">{value}</div>
      <div className="mt-0.5 break-words text-xs text-zinc-400">{detail}</div>
    </div>
  );
}

function Link({ label, detail, ok, href }: { label: string; detail: string; ok: boolean; href?: string }) {
  const body = (
    <>
      <span>{label}</span>
      <span aria-hidden="true" className={`block h-0.5 w-full min-w-10 ${ok ? "bg-emerald-400" : "bg-amber-300"}`} />
      <span>{detail}</span>
    </>
  );
  const className = `flex shrink-0 flex-col items-center gap-1 self-center text-center text-[11px] ${ok ? "text-emerald-400" : "text-amber-300"}`;
  return href ? (
    <a className={`${className} hover:underline`} href={href}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * Where work stands, from a develop pull request to production, with what
 * carries it across each step. Read only, from what the page already loaded;
 * what is not known says so rather than showing zero.
 */
export function QaReleaseFlowSection({ flow }: { flow: QaReleaseFlow }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const train = flow.lastTrain;
  const trainDetail =
    train === null
      ? m.flowTrainNone
      : fill(train.outcome === "opened" ? m.flowTrainOpened : train.outcome === "empty" ? m.flowTrainEmpty : m.flowTrainFailed, { slot: train.slot });
  const production =
    flow.servesMainHead === null ? m.flowProductionUnknown : flow.servesMainHead ? m.flowProductionCurrent : m.flowProductionBehind;
  return (
    <section className={`${card} flex min-w-0 flex-col gap-3`} data-testid="qa-release-flow">
      <h2 className="text-base font-semibold text-zinc-100">{m.flowTitle}</h2>
      <div className="flex min-w-0 flex-wrap items-stretch gap-2">
        <Stage
          label={m.flowPulls}
          value={flow.pulls === null ? "—" : String(flow.pulls.lane + flow.pulls.human + flow.pulls.fix + flow.pulls.waiting + flow.pulls.draft)}
          detail={flow.pulls === null ? m.flowPullsUnread : fill(m.flowPullsDetail, flow.pulls)}
          attention={(flow.pulls?.human ?? 0) > 0}
        />
        <Link label={m.flowLane} detail={flow.latched ? m.flowLaneLatched : m.flowLaneRunning} ok={!flow.latched} href={QA_RELEASE_LANE_TAB_HREF} />
        <Stage label={m.flowDevelop} value="dev" detail={m.flowDevelopDetail} />
        <Link label={m.flowTrain} detail={trainDetail} ok={train?.outcome !== "failed"} href={QA_RELEASE_TRAIN_TAB_HREF} />
        <Stage
          label={m.flowMain}
          value={short(flow.mainHeadSha)}
          detail={flow.mainPulls === null ? m.flowMainUnread : fill(m.flowMainDetail, { count: flow.mainPulls })}
        />
        <Link label={m.flowDeploy} detail={m.flowDeployDetail} ok={flow.servesMainHead !== false} />
        <Stage label={m.flowProduction} value={short(flow.servingSha)} detail={production} attention={flow.servesMainHead === false} />
      </div>
    </section>
  );
}
